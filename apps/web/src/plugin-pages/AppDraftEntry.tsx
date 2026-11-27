import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, Icon, InlineNotice, PluginsGlyph } from '@latch/ui'
import { api, ApiError, inlineError, isUncertain, newRequestId } from '../core/api.ts'
import { defineCopy } from '../core/i18n.ts'
import { useMounted } from '../hooks/useMounted.ts'

export type DraftKind = 'app' | 'plugin'
interface DraftProbe {
  present: boolean
  kind?: DraftKind
  kinds?: DraftKind[]
  pluginId?: string
  pluginIds?: Partial<Record<DraftKind, string>>
}
const COPY = defineCopy(
  {
    updateApp: '更新应用草稿',
    createApp: '作为应用草稿',
    reviewApp: '查看页面草稿',
    updatePlugin: '导入插件修改',
    createPlugin: '查看插件',
    retry: '重新检查',
    retryImport: '重试同一导入',
    repair: '交回 Agent 修改',
    repairPrompt: (message: string) => `Latch 检查创作草稿时遇到问题。请根据这条诊断修改草稿：\n\n${message}`,
  },
  {
    updateApp: 'Update app draft',
    createApp: 'Create app draft',
    reviewApp: 'Review page draft',
    updatePlugin: 'Import plugin changes',
    createPlugin: 'View plugin',
    retry: 'Check again',
    retryImport: 'Retry same import',
    repair: 'Hand back to Agent',
    repairPrompt: (message: string) => `Latch found a problem with the draft. Please fix it using this diagnostic:\n\n${message}`,
  },
)

/** Earlier Hosts only probed the app directory and reported a single package ID. */
export function creatorDrafts(probe: DraftProbe): Array<{ kind: DraftKind; imported: boolean }> {
  if (!probe.present) return []
  const kinds = probe.kinds ?? [probe.kind ?? 'app']
  return kinds.map(kind => ({ kind, imported: Boolean(probe.pluginIds?.[kind] ?? (kind === (probe.kind ?? 'app') && probe.pluginId)) }))
}

export function AppDraftEntry({
  sessionId,
  revision,
  onImported,
  onRepair,
  target,
}: {
  sessionId: string
  revision: string
  onImported: (pluginId: string, kind: DraftKind) => void
  onRepair?: (prompt: string) => void
  /** A creator's entry follows the conversation or its Changes panel without losing an outstanding import receipt. */
  target?: HTMLElement | null
}) {
  const [probe, setProbe] = useState<DraftProbe | null>(null)
  const [error, setError] = useState('')
  const [readError, setReadError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const request = useRef<{ kind: DraftKind; requestId: string } | null>(null)
  const mounted = useMounted()
  useEffect(() => {
    let live = true
    void api<DraftProbe>(`plugin-packages/session-draft?sessionId=${encodeURIComponent(sessionId)}`).then(
      value => {
        if (live) {
          setProbe(value)
          setReadError('')
        }
      },
      cause => {
        if (live) {
          setProbe(null)
          setReadError(cause instanceof ApiError && cause.status === 404 ? '' : inlineError(cause))
        }
      },
    )
    return () => {
      live = false
    }
  }, [sessionId, revision, refresh])

  const send = async (kind: DraftKind) => {
    if (busy || (request.current && request.current.kind !== kind)) return
    setBusy(true)
    setError('')
    request.current ??= { kind, requestId: newRequestId() }
    try {
      const result = await api<{ package: { id: string } }>('plugin-packages/import', {
        method: 'POST',
        body: { requestId: request.current.requestId, sessionId, ...(kind === 'plugin' ? { kind } : {}) },
      })
      request.current = null
      if (mounted.current) onImported(result.package.id, kind)
    } catch (cause) {
      if (!isUncertain(cause)) request.current = null
      if (mounted.current) setError(inlineError(cause))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  const entries = probe ? creatorDrafts(probe) : []
  const inChat = target?.dataset.draftPlace === 'conversation'
  if (target === null || (!entries.length && (!readError || inChat) && !error && !request.current)) return null
  const entry = (
    <>
      {entries.map(({ kind, imported }) => (
        <div key={kind} className={inChat ? undefined : 'changes-app-draft'}>
          {!inChat && (
            <>
              <Icon icon={PluginsGlyph} size={14} />
              <span>{kind === 'app' ? 'latch-app' : 'latch-plugin'}</span>
            </>
          )}
          <Button
            size="sm"
            {...(inChat ? { icon: PluginsGlyph } : {})}
            loading={busy && request.current?.kind === kind}
            disabled={busy || request.current !== null}
            onClick={() => void send(kind)}>
            {kind === 'app'
              ? inChat
                ? COPY.reviewApp
                : imported
                  ? COPY.updateApp
                  : COPY.createApp
              : inChat || !imported
                ? COPY.createPlugin
                : COPY.updatePlugin}
          </Button>
        </div>
      ))}
      {(error || readError) && (
        <InlineNotice
          tone="error"
          action={
            request.current ? (
              <Button
                disabled={busy}
                onClick={() => {
                  if (request.current) void send(request.current.kind)
                }}>
                {COPY.retryImport}
              </Button>
            ) : (
              <>
                {readError && <Button onClick={() => setRefresh(n => n + 1)}>{COPY.retry}</Button>}
                {onRepair && <Button onClick={() => onRepair(COPY.repairPrompt(error || readError))}>{COPY.repair}</Button>}
              </>
            )
          }>
          {error || readError}
        </InlineNotice>
      )}
    </>
  )
  return target ? createPortal(entry, target) : entry
}
