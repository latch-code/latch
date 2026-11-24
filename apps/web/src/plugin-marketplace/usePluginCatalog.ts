import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PluginCatalogPreview, PluginCatalogStage, PluginPackageSummary } from '@latch/protocol'
import { api, inlineError, newRequestId } from '../core/api.ts'
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
  active,
  editable,
  connected,
  storageKey,
  onStage,
}: {
  selectedId: string | undefined
  localRevision: string | undefined
  active: boolean
  editable: boolean
  connected: boolean
  storageKey: string
  onStage: (pluginId: string) => void
}) {
  const [previewData, setPreviewData] = useState<{ pluginId: string; value: PluginCatalogPreview } | null>(null)
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
    setPreviewData(null)
    setPreviewError('')
    if (!selectedId || !active || !editable || !connected) return
    const abort = new AbortController()
    void api<PluginCatalogPreview>(ROUTE + '/preview', {
      method: 'POST',
      body: { pluginId: selectedId },
      signal: abort.signal,
    }).then(
      value => {
        if (abort.signal.aborted) return
        if (
          !isPluginPackageReview(value?.review)
          || value.review.source.kind !== 'catalog'
          || !digest(value.review.revision)
          || value.bundle?.manifest?.id !== selectedId
          || value.bundle.manifest.version !== value.review.version
        ) {
          setPreviewError(COPY.reviewUnavailable)
          return
        }
        setPreviewData({ pluginId: selectedId, value })
      },
      cause => {
        if (!abort.signal.aborted) setPreviewError(inlineError(cause))
      },
    )
    return () => abort.abort()
  }, [active, connected, editable, localRevision, read, selectedId])

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
        onStageRef.current(saved.id)
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

  const preview = previewData && previewData.pluginId === selectedId ? previewData.value : null
  return {
    preview,
    previewError,
    retryPreview,
    stagePending,
    stageBusy,
    stageError,
    retryStage: () => {
      if (stagePending) void stage(stagePending)
    },
    stageSelected: () => {
      if (!selectedId || !preview || stagePending || (preview.installed && preview.updateAvailable !== true)) return
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
