import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PluginCatalogCheckResult, PluginCatalogPreview, PluginCatalogStage, PluginPackageSummary } from '@latch/protocol'
import { api, ApiError, ApiTimeoutError, inlineError, newRequestId, NoAnswerError } from '../core/api.ts'
import { defineCopy } from '../core/i18n.ts'
import { isPluginPackageReview } from '../settings/PluginMutationReview.tsx'
import {
  dataObject,
  digest,
  forgetReceipt,
  marketRequest,
  receipt,
  receiptUnsettled,
  rememberPending,
  useMarketReceipt,
  useMarketWriteScope,
} from './marketReceipts.ts'

const ROUTE = 'plugin-packages/catalog'
const COPY = defineCopy(
  { reviewUnavailable: '工作台未提供完整的插件审阅信息。更新运行工作台的 Latch 后重试。' },
  { reviewUnavailable: 'The workbench did not provide a complete plugin review. Update Latch on the computer running it and try again.' },
)

type OfficialCheck = {
  scope: string
  status: 'checking' | 'checked' | 'failed'
  result?: PluginCatalogCheckResult
  failure?: 'connection' | { status: number; code: string }
}
const updateStatuses = ['available', 'current', 'older', 'different-source', 'local-changes', 'same-version-changed']
const catalogErrors = new Set([
  'plugin-external-github-rate-limit',
  'plugin-external-github-unreachable',
  'plugin-external-github-unavailable',
  'plugin-external-github-invalid',
  'plugin-external-content-invalid',
  'plugin-catalog-same-version-changed',
  'plugin-catalog-older',
  'egress-denied',
  'scope-required',
  'local-only',
  'plugin-package-scope',
  'rate-limited',
])

function completeCatalog(value: unknown, ids: readonly string[]): value is PluginCatalogCheckResult {
  if (!dataObject(value) || !Array.isArray(value.plugins) || value.plugins.length !== ids.length) return false
  const unseen = new Set(ids)
  return value.plugins.every(
    entry =>
      dataObject(entry)
      && typeof entry.id === 'string'
      && unseen.delete(entry.id)
      && typeof entry.version === 'string'
      && entry.version.length > 0
      && digest(entry.revision)
      && (entry.commit === undefined || (typeof entry.commit === 'string' && /^[a-f0-9]{40}$/u.test(entry.commit)))
      && (entry.updateStatus === undefined || (typeof entry.updateStatus === 'string' && updateStatuses.includes(entry.updateStatus))),
  )
}

/** The automatic check uses the Host's cache. Only a person's explicit refresh asks it to bypass the cache. */
export function useOfficialPluginCheck(active: boolean, scope: string, ids: readonly string[]) {
  const [check, setCheck] = useState<OfficialCheck | null>(null)
  const manual = useRef<(() => void) | null>(null)
  useEffect(() => {
    if (!active) return
    let request: AbortController | undefined
    const run = async (force: boolean) => {
      request?.abort()
      request = new AbortController()
      const { signal } = request
      setCheck(previous => ({ ...(previous?.scope === scope ? previous : undefined), scope, status: 'checking' }))
      let failure: OfficialCheck['failure']
      try {
        const result = await api<unknown>(ROUTE + '/check', {
          method: 'POST',
          body: force ? { force: true } : {},
          signal,
          timeoutMs: 60_000,
        })
        if (signal.aborted) return
        if (completeCatalog(result, ids)) {
          setCheck({ scope, status: 'checked', result })
          return
        }
      } catch (cause) {
        if (signal.aborted) return
        if (cause instanceof ApiError && catalogErrors.has(cause.code)) failure = { status: cause.status, code: cause.code }
        if (cause instanceof NoAnswerError || cause instanceof ApiTimeoutError) failure = 'connection'
      }
      setCheck(previous => ({
        ...(previous?.scope === scope && previous.result ? { result: previous.result } : undefined),
        scope,
        status: 'failed',
        ...(failure ? { failure } : {}),
      }))
    }
    manual.current = () => void run(true)
    void run(false)
    return () => {
      manual.current = null
      request?.abort()
    }
  }, [active, ids, scope])
  return { check: check?.scope === scope ? check : null, refresh: () => manual.current?.() }
}

function validStage(value: unknown): value is PluginCatalogStage {
  if (
    !dataObject(value)
    || typeof value.pluginId !== 'string'
    || !/^[A-Za-z0-9_-]{1,64}$/u.test(value.pluginId)
    || !receipt(value.requestId)
    || !digest(value.revision)
  )
    return false
  const { update } = value
  return update === undefined
    ? Object.keys(value).length === 3
    : Object.keys(value).length === 4
        && dataObject(update)
        && Object.keys(update).length === 2
        && typeof update.installId === 'string'
        && /^[A-Za-z0-9_-]{22}$/u.test(update.installId)
        && digest(update.baseRevision)
}

export function usePluginCatalog({
  selectedId,
  localRevision,
  checkedCatalog,
  active,
  editable,
  connected,
  storageKey,
  onStage,
}: {
  selectedId: string | undefined
  localRevision: string | undefined
  checkedCatalog?: PluginCatalogCheckResult | undefined
  active: boolean
  editable: boolean
  connected: boolean
  storageKey: string
  onStage: (pluginId: string, revision: string) => void
}) {
  const [previewData, setPreviewData] = useState<{
    scope: string
    pluginId: string
    catalog: PluginCatalogCheckResult | undefined
    localRevision: string | undefined
    value: PluginCatalogPreview
  } | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [read, setRead] = useState(0)
  const [stagePending, setStagePending] = useMarketReceipt(storageKey, editable, validStage)
  const writeSignal = useMarketWriteScope(storageKey, editable && connected)
  const [stageBusy, setStageBusy] = useState(false)
  const [stageError, setStageError] = useState('')
  const stageRunning = useRef(false)
  const mounted = useRef(false)
  const onStageRef = useRef(onStage)
  useLayoutEffect(() => {
    onStageRef.current = onStage
  }, [onStage])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    setPreviewError('')
    if (!selectedId || !active || !editable || !connected) {
      setPreviewData(null)
      setPreviewBusy(false)
      return
    }
    // Keep the open plugin's last verified preview on screen while a catalog check or stage refreshes it in place.
    setPreviewData(previous => (previous?.scope === storageKey && previous.pluginId === selectedId ? previous : null))
    setPreviewBusy(true)
    const abort = new AbortController()
    void api<PluginCatalogPreview>(ROUTE + '/preview', {
      method: 'POST',
      body: { pluginId: selectedId },
      signal: abort.signal,
    }).then(
      value => {
        if (abort.signal.aborted) return
        setPreviewBusy(false)
        if (
          !isPluginPackageReview(value?.review)
          || value.review.source.kind !== 'catalog'
          || !digest(value.review.revision)
          || value.bundle?.manifest?.id !== selectedId
          || value.bundle.manifest.version !== value.review.version
        ) {
          setPreviewData(null)
          setPreviewError(COPY.reviewUnavailable)
          return
        }
        setPreviewData({ scope: storageKey, pluginId: selectedId, catalog: checkedCatalog, localRevision, value })
      },
      cause => {
        if (!abort.signal.aborted) {
          setPreviewBusy(false)
          setPreviewData(null)
          setPreviewError(inlineError(cause))
        }
      },
    )
    return () => abort.abort()
  }, [active, connected, editable, localRevision, read, selectedId, storageKey, checkedCatalog])

  const retryPreview = () => setRead(current => current + 1)
  const stage = async (input: PluginCatalogStage) => {
    const signal = writeSignal()
    if (!active || !signal || stageRunning.current) return
    stageRunning.current = true
    setStageBusy(true)
    setStageError('')
    rememberPending(storageKey, input)
    try {
      const { package: saved } = await marketRequest<{ package: PluginPackageSummary }>(signal, ROUTE + '/stage', {
        method: 'POST',
        body: input,
      })
      forgetReceipt(storageKey, input.requestId)
      if (mounted.current) {
        setStagePending(null)
        retryPreview()
        onStageRef.current(saved.id, saved.revision)
      }
    } catch (cause) {
      const uncertain = signal.aborted || receiptUnsettled(cause, stagePending?.requestId === input.requestId)
      if (!uncertain) forgetReceipt(storageKey, input.requestId)
      if (mounted.current) {
        setStagePending(uncertain ? input : null)
        if (!signal.aborted) setStageError(inlineError(cause))
        if (!uncertain) retryPreview()
      }
    } finally {
      stageRunning.current = false
      if (mounted.current) setStageBusy(false)
    }
  }

  const preview =
    active && editable && connected && previewData?.scope === storageKey && previewData.pluginId === selectedId ? previewData.value : null
  const previewReady =
    preview !== null
    && previewData !== null
    && !previewBusy
    && previewData.catalog === checkedCatalog
    && previewData.localRevision === localRevision
  return {
    preview,
    previewReady,
    previewError,
    retryPreview,
    stagePending,
    stageBusy,
    stageError,
    retryStage: () => {
      if (stagePending) void stage(stagePending)
    },
    stageSelected: () => {
      if (!selectedId || !preview || !previewReady || stagePending || (preview.installed && preview.updateAvailable !== true)) return
      const installed = preview.installed
      void stage({
        requestId: newRequestId(),
        pluginId: selectedId,
        revision: preview.review.revision,
        ...(installed ? { update: { installId: installed.installId, baseRevision: installed.revision } } : {}),
      })
    },
  }
}
