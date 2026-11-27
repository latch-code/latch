import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PluginInfo, PluginPackageSummary } from '@latch/protocol'
import { Button, InlineNotice, Switch } from '@latch/ui'
import { InlineConfirm } from '../components/InlineConfirm.tsx'
import { api, inlineError, type ApiOptions } from '../core/api.ts'
import { withConfirmation } from '../core/confirmations.ts'
import { defineCopy } from '../core/i18n.ts'
import { pluginInUseReason } from '../settings/pluginAssets.ts'
import { pluginEnabledBody, PluginMutationDialog, type PluginMutationTarget } from '../settings/PluginMutationReview.tsx'
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
    enable: (name: string) => `启用 ${name}`,
    enabled: '已启用',
    disabled: '已停用',
    retry: '重试',
    unknown: '暂时无法确认插件是否已切换。可重试同一请求。',
    retrySame: '重试同一请求',
  },
  {
    enable: (name: string) => `Enable ${name}`,
    enabled: 'Enabled',
    disabled: 'Disabled',
    retry: 'Retry',
    unknown: 'The plugin change has an unknown outcome. You can retry the same request.',
    retrySame: 'Retry same request',
  },
)

type Change = { id: string } & ReturnType<typeof pluginEnabledBody>

function validChange(value: unknown): value is Change {
  if (!dataObject(value) || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(value.id) || !receipt(value.requestId))
    return false
  return value.enabled === false
    ? Object.keys(value).length === 3
    : value.enabled === true
        && Object.keys(value).length === 5
        && digest(value.baseAppliedRevision)
        && typeof value.reviewedInstallId === 'string'
        && /^[A-Za-z0-9_-]{22}$/u.test(value.reviewedInstallId)
}

export function useInstalledPluginSwitch({
  active,
  editable,
  connected,
  storageKey,
  revision,
  onChanged,
}: {
  active: boolean
  editable: boolean
  connected: boolean
  storageKey: string
  revision: number | undefined
  onChanged: () => void
}) {
  const available = active && editable && connected
  const key = 'latch:market-enabled:' + storageKey
  const writeSignal = useMarketWriteScope(key, available)
  const [pending, setPending] = useMarketReceipt(key, editable, validChange)
  const [target, setTarget] = useState<PluginMutationTarget | null>(null)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const [error, setError] = useState('')
  const [runtime, setRuntime] = useState<PluginInfo[] | null>(null)
  const [readError, setReadError] = useState('')
  const [retry, setRetry] = useState(0)

  useLayoutEffect(() => {
    setTarget(null)
    setRuntime(null)
    setReadError('')
    setError('')
  }, [available, key])
  useEffect(() => {
    if (!available) return
    const abort = new AbortController()
    void api<{ plugins: PluginInfo[] }>('plugins', { signal: abort.signal }).then(
      result => {
        if (abort.signal.aborted) return
        setRuntime(result.plugins)
        setReadError('')
      },
      cause => {
        if (abort.signal.aborted) return
        setRuntime(null)
        setReadError(inlineError(cause))
      },
    )
    return () => abort.abort()
  }, [available, key, revision, retry])

  const send = async (change: Change) => {
    const signal = writeSignal()
    if (!signal || running.current || (pending && pending.requestId !== change.requestId)) return
    running.current = true
    setBusy(true)
    setError('')
    rememberPending(key, change)
    setPending(change)
    const { id, ...body } = change
    const request = <T,>(path: string, options?: ApiOptions) => marketRequest<T>(signal, path, options)
    try {
      await withConfirmation(
        confirmation =>
          request('plugin-packages/' + encodeURIComponent(id) + '/enabled', {
            method: 'POST',
            body,
            ...(confirmation ? { confirmation } : {}),
          }),
        { signal, api: request },
      )
      forgetReceipt(key, change.requestId)
      setPending(null)
      setTarget(null)
      onChanged()
    } catch (cause) {
      if (signal.aborted) return
      if (!receiptUnsettled(cause, pending?.requestId === change.requestId)) {
        forgetReceipt(key, change.requestId)
        setPending(null)
        onChanged()
      }
      setError(inlineError(cause))
    } finally {
      running.current = false
      setBusy(false)
    }
  }

  const locked = busy || pending !== null || target !== null
  const control = (record: PluginPackageSummary, name: string) => {
    const reason = record.unavailableReason ?? pluginInUseReason(runtime?.find(plugin => plugin.id === record.id))
    return (
      <div className="plugin-installed-switch">
        <Switch
          label={COPY.enable(name)}
          checked={record.enabled}
          disabled={!available || !record.appliedRevision || !runtime || locked || reason !== undefined}
          title={reason}
          onCheckedChange={enabled => {
            setError('')
            if (enabled && record.appliedRevision) setTarget({ id: record.id, name, revision: record.appliedRevision, operation: 'enable' })
            else if (!enabled) void send({ id: record.id, ...pluginEnabledBody(false) })
          }}
        />
        <span>{record.enabled ? COPY.enabled : COPY.disabled}</span>
      </div>
    )
  }
  const feedback = active && editable && (
    <>
      {readError && (
        <InlineNotice
          tone="error"
          action={
            <Button disabled={!connected} onClick={() => setRetry(current => current + 1)}>
              {COPY.retry}
            </Button>
          }>
          {readError}
        </InlineNotice>
      )}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {pending && !busy && (
        <InlineNotice
          tone="warn"
          action={
            <Button disabled={!connected} onClick={() => void send(pending)}>
              {COPY.retrySame}
            </Button>
          }>
          {COPY.unknown}
        </InlineNotice>
      )}
      {target && available && (
        <PluginMutationDialog
          target={target}
          busy={busy}
          failure={error}
          retryRequest={pending ? () => void send(pending) : undefined}
          onClose={() => setTarget(null)}
          onConfirm={review => {
            void send({ id: target.id, ...pluginEnabledBody(review) })
          }}
        />
      )}
      <InlineConfirm active={busy && available} rank={1} />
    </>
  )
  return { control, feedback, locked, busy: busy || target !== null }
}
