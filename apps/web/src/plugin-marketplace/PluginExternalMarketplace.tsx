import { useId, useLayoutEffect, useRef, useState } from 'react'
import type {
  PluginExternalEntry,
  PluginExternalFind,
  PluginExternalPreview,
  PluginExternalStage,
  PluginPackageDetail,
} from '@latch/protocol'
import { Button, InlineNotice } from '@latch/ui'
import { ArrowLeft } from 'lucide-react'
import { VisibleText } from '../components/VisibleText.tsx'
import { api, inlineError, MessageError, newRequestId } from '../core/api.ts'
import { defineCopy } from '../core/i18n.ts'
import { Loading, SettingsGroup, SettingsRow } from '../settings/common.tsx'
import { isPluginPackageReview, PluginExternalSourceText, PluginRiskFacts } from '../settings/PluginMutationReview.tsx'
import { PluginMarketIcon } from './PluginArtwork.tsx'
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

const COPY = defineCopy(
  {
    found: '这个来源提供的插件',
    preview: '预览版本',
    listedVersion: (version: string) => `v${version}`,
    identity: '插件标识',
    savedVersion: '已保存草稿版本',
    back: '返回查找',
    backToList: '返回插件列表',
    install: '保存为草稿',
    stageUpdate: '保存更新草稿',
    stageHint: '草稿需要在插件设置中审阅并应用后才会使用。',
    review: '审阅草稿',
    manage: '查看已有插件',
    retry: '重试',
    loading: '正在读取插件…',
    invalid: '无法读取完整的插件审阅信息，请刷新后重试。',
    unknown: '暂时不知道这次操作是否完成。可重试同一请求。',
    retrySame: '重试同一请求',
    update: {
      current: '已经保存这个版本。',
      older: '已保存的版本比这个版本更新。',
      'local-changes': '已有草稿包含本地改动。请先查看已有插件。',
      'different-source': '这台 Mac 上已有插件使用此标识。',
      'same-version-changed': '这个版本的内容有改动。请先查看已有插件。',
    },
  },
  {
    found: 'Plugins from this source',
    preview: 'Preview release',
    listedVersion: (version: string) => `v${version}`,
    identity: 'Plugin ID',
    savedVersion: 'Saved draft version',
    back: 'Back to search',
    backToList: 'Back to plugin list',
    install: 'Save as draft',
    stageUpdate: 'Save update draft',
    stageHint: 'Review and apply the draft in plugin settings to start using it.',
    review: 'Review draft',
    manage: 'View local plugin',
    retry: 'Retry',
    loading: 'Reading plugins…',
    invalid: 'Couldn’t read the complete plugin review. Refresh and try again.',
    unknown: 'The outcome is unknown. You can retry the same request.',
    retrySame: 'Retry same request',
    update: {
      current: 'This version is already saved.',
      older: 'The saved version is newer than this release.',
      'local-changes': 'The existing draft has local edits. Review the existing plugin first.',
      'different-source': 'Another plugin on this Mac already uses this ID.',
      'same-version-changed': 'The contents changed within this version. Review the existing plugin first.',
    },
  },
)

const ROUTE = 'plugin-packages/external'
type Lookup = { input: string } | { pluginId: string }

const token = (value: unknown): boolean => typeof value === 'string' && /^[A-Za-z0-9_-]{32}$/u.test(value)

function validStage(value: unknown): value is PluginExternalStage {
  if (!dataObject(value) || !receipt(value.requestId) || !token(value.token) || !digest(value.revision)) return false
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

export function usePluginExternalMarketplace({
  active,
  connected,
  editable,
  storageKey,
  onStage,
}: {
  active: boolean
  connected: boolean
  editable: boolean
  storageKey: string
  onStage: () => void
}) {
  const writeSignal = useMarketWriteScope(storageKey, editable && connected)
  const [pending, setPending] = useMarketReceipt(storageKey, editable, validStage)
  const [busy, setBusy] = useState(false)
  const [readSignal, setReadSignal] = useState<AbortSignal | null>(null)
  const loading = active && editable && connected && readSignal !== null && !readSignal.aborted
  const [error, setError] = useState('')
  const [found, setFound] = useState<PluginExternalFind | null>(null)
  const [preview, setPreview] = useState<PluginExternalPreview | null>(null)
  const [lastLookup, setLastLookup] = useState<Lookup | null>(null)
  const [stagedId, setStagedId] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  const retry = useRef<(() => void) | null>(null)
  const mounted = useRef(false)
  const stageRunning = useRef(false)

  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useLayoutEffect(() => {
    if (!active || !editable || !connected) return
    return () => request.current?.abort()
  }, [active, connected, editable])

  const read = async (operation: (signal: AbortSignal) => Promise<void>) => {
    if (!active || !editable || !connected || stageRunning.current || pending) return
    request.current?.abort()
    const abort = new AbortController()
    request.current = abort
    setReadSignal(abort.signal)
    setError('')
    setStagedId(null)
    retry.current = () => void read(operation)
    try {
      await operation(abort.signal)
    } catch (cause) {
      if (!abort.signal.aborted) setError(inlineError(cause))
    } finally {
      if (!abort.signal.aborted) setReadSignal(null)
    }
  }

  const readEntry = async (source: PluginExternalFind, entry: PluginExternalEntry, signal: AbortSignal) => {
    const value = await api<PluginExternalPreview>(ROUTE + '/preview', {
      method: 'POST',
      body: { token: source.token, path: entry.path },
      signal,
      timeoutMs: 45_000,
    })
    signal.throwIfAborted()
    if (
      !token(value?.token)
      || !digest(value.revision)
      || !isPluginPackageReview(value.review, value.revision)
      || value.review.source.kind !== 'external'
      || value.review.source.pluginId !== entry.id
      || value.review.source.path !== entry.path
      || value.review.source.version !== entry.version
      || value.entry?.path !== entry.path
      || value.bundle?.manifest?.id !== entry.id
      || value.bundle.manifest.version !== entry.version
      || value.review.version !== entry.version
    )
      throw new MessageError(COPY.invalid)
    setPreview(value)
  }

  const lookup = (input: Lookup) => {
    setLastLookup(input)
    setFound(null)
    setPreview(null)
    void read(async signal => {
      const value = await api<PluginExternalFind>(ROUTE + '/find', { method: 'POST', body: input, signal, timeoutMs: 45_000 })
      signal.throwIfAborted()
      const entries = value?.packages
      if (!token(value?.token) || !Array.isArray(entries) || entries.length === 0) throw new MessageError(COPY.invalid)
      if (entries.length === 1) await readEntry(value, entries[0], signal)
      else setFound(value)
    })
  }
  const select = (entry: PluginExternalEntry) => {
    if (found) void read(signal => readEntry(found, entry, signal))
  }
  const back = () => {
    setPreview(null)
    setError('')
  }
  const clear = () => {
    request.current?.abort()
    setReadSignal(null)
    setFound(null)
    setStagedId(null)
    back()
  }

  const stage = async (input: PluginExternalStage) => {
    const signal = writeSignal()
    if (!active || !signal || stageRunning.current) return
    stageRunning.current = true
    setBusy(true)
    setError('')
    rememberPending(storageKey, input)
    try {
      const { package: saved } = await marketRequest<{ package: PluginPackageDetail }>(signal, ROUTE + '/stage', {
        method: 'POST',
        body: input,
        timeoutMs: 45_000,
      })
      forgetReceipt(storageKey, input.requestId)
      if (mounted.current) {
        setPending(null)
        setPreview(null)
        setStagedId(saved.id)
        onStage()
      }
    } catch (cause) {
      const uncertain = signal.aborted || receiptUnsettled(cause, pending?.requestId === input.requestId)
      if (!uncertain) forgetReceipt(storageKey, input.requestId)
      if (mounted.current) {
        setPending(uncertain ? input : null)
        if (!uncertain) {
          setError(inlineError(cause))
          setPreview(null)
          if (lastLookup) retry.current = () => lookup(lastLookup)
        }
      }
    } finally {
      stageRunning.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const save = () => {
    if (!preview || pending || (preview.installed && preview.updateAvailable !== true)) return
    const installed = preview.installed
    void stage({
      token: preview.token,
      requestId: newRequestId(),
      revision: preview.revision,
      ...(installed ? { update: { installId: installed.installId, baseRevision: installed.revision } } : {}),
    })
  }
  return {
    loading,
    busy,
    pending,
    error,
    found,
    preview,
    lastLookup,
    stagedId,
    lookup,
    select,
    back,
    clear,
    save,
    retry: () => (pending ? void stage(pending) : retry.current?.()),
  }
}

export function PluginExternalMarketplace({
  external,
  disabled,
  onManage,
  browseFocus,
}: {
  external: ReturnType<typeof usePluginExternalMarketplace>
  disabled: boolean
  onManage: (id: string) => void
  browseFocus: () => void
}) {
  const { found, preview, loading, busy, error, pending, stagedId } = external
  const heading = useRef<HTMLHeadingElement>(null)
  const listId = useId()
  const selected = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!found && !preview) return
    const target = !preview && selected.current ? document.getElementById(selected.current) : null
    if (target) target.focus({ preventScroll: true })
    else heading.current?.focus({ preventScroll: true })
    if (!preview) selected.current = null
  }, [found, preview])
  const installed = preview?.installed
  const status = preview?.updateStatus
  const canStage = preview && (!installed || preview.updateAvailable === true)
  return (
    <>
      {stagedId && <InlineNotice action={<Button onClick={() => onManage(stagedId)}>{COPY.review}</Button>}>{COPY.stageHint}</InlineNotice>}
      {loading && <Loading label={COPY.loading} />}
      {error && (
        <InlineNotice
          tone="error"
          action={
            !pending && (
              <Button disabled={disabled || loading || busy} onClick={external.retry}>
                {COPY.retry}
              </Button>
            )
          }>
          {error}
        </InlineNotice>
      )}
      {pending && (
        <InlineNotice
          tone="warn"
          action={
            <Button disabled={disabled} loading={busy} onClick={external.retry}>
              {COPY.retrySame}
            </Button>
          }>
          {COPY.unknown}
        </InlineNotice>
      )}
      {preview ? (
        <>
          <header className="plugin-market-npm-preview">
            <div className="plugin-market-detail-identity">
              <PluginMarketIcon id={preview.entry.id} size={24} framed />
              <div>
                <h2 className="plugin-market-section-title" ref={heading} tabIndex={-1}>
                  <VisibleText text={preview.bundle.manifest.name} />
                </h2>
                {preview.bundle.manifest.description && (
                  <p className="plugin-market-note">
                    <VisibleText text={preview.bundle.manifest.description} />
                  </p>
                )}
              </div>
            </div>
            <Button
              variant="ghost"
              icon={ArrowLeft}
              disabled={busy}
              onClick={() => {
                external.back()
                if (!found) browseFocus()
              }}>
              {found ? COPY.backToList : COPY.back}
            </Button>
          </header>
          <PluginRiskFacts
            review={preview.review}
            extra={
              <>
                <SettingsRow title={COPY.identity} description={<VisibleText text={preview.entry.id} />} />
                {installed?.version && installed.version !== preview.entry.version && !preview.review.comparison && (
                  <SettingsRow title={COPY.savedVersion} description={<VisibleText text={installed.version} />} />
                )}
              </>
            }
          />
          {status && status !== 'available' && <InlineNotice>{COPY.update[status]}</InlineNotice>}
          {canStage && <p className="plugin-market-note">{COPY.stageHint}</p>}
          <div className="plugin-asset-actions">
            {canStage && (
              <Button variant="primary" disabled={disabled || !!pending} loading={busy} onClick={external.save}>
                {installed ? COPY.stageUpdate : COPY.install}
              </Button>
            )}
            {installed && (
              <Button disabled={disabled || busy} onClick={() => onManage(installed.id)}>
                {COPY.manage}
              </Button>
            )}
          </div>
        </>
      ) : (
        found && (
          <>
            <header className="plugin-market-npm-preview">
              <div>
                <h2 className="plugin-market-section-title" ref={heading} tabIndex={-1}>
                  {COPY.found}
                </h2>
                <PluginExternalSourceText source={found.source} />
              </div>
              <Button
                variant="ghost"
                icon={ArrowLeft}
                disabled={busy}
                onClick={() => {
                  external.clear()
                  browseFocus()
                }}>
                {COPY.back}
              </Button>
            </header>
            <SettingsGroup>
              {found.packages.map((entry, index) => (
                <SettingsRow
                  key={entry.path}
                  className="marketplace-fact"
                  leading={<PluginMarketIcon id={entry.id} size={16} framed />}
                  title={<VisibleText text={entry.name} />}
                  description={
                    <>
                      <span>
                        {COPY.listedVersion(entry.version)} · <VisibleText text={entry.path || entry.id} />
                      </span>
                      {entry.description && <VisibleText text={entry.description} />}
                    </>
                  }
                  trailing={
                    <Button
                      id={listId + '-' + index}
                      disabled={disabled || loading || busy || !!pending}
                      onClick={event => {
                        selected.current = event.currentTarget.id
                        external.select(entry)
                      }}>
                      {COPY.preview}
                      <span className="sr-only">
                        {' '}
                        <VisibleText text={entry.name} />
                      </span>
                    </Button>
                  }
                />
              ))}
            </SettingsGroup>
          </>
        )
      )}
    </>
  )
}
