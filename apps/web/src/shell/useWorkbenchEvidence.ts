import { useEffect, useRef, useState } from 'react'
import type { AppSnapshot, TaskDetail, TaskSummary, WorkbenchDelivery, WorkbenchDeliveryEntry } from '@latch/protocol'
import { api, errorMessage } from '../core/api.ts'
import { spaceOf } from '../sessions.ts'
import type { ConnectionStatus } from '../core/useHarness.ts'

export type { WorkbenchDeliveryEntry } from '@latch/protocol'
const EMPTY_ENTRIES: ReadonlyMap<string, WorkbenchDeliveryEntry> = new Map()

export interface DeliveryRead {
  entries: ReadonlyMap<string, WorkbenchDeliveryEntry>
  loading: boolean
  ready: boolean
  error?: string
  refresh: () => void
}

/** At most twelve authorized Code sessions; the Host deduplicates shared repositories and checks every read. */
export function useWorkbenchDelivery(
  snapshot: AppSnapshot,
  connection: ConnectionStatus,
  active: boolean,
  ids?: readonly string[],
): DeliveryRead {
  const [readState, setReadState] = useState<{ scope: string; entries: ReadonlyMap<string, WorkbenchDeliveryEntry>; error?: string }>()
  const [loading, setLoading] = useState(false)
  const [showLoading, setShowLoading] = useState(false)
  useEffect(() => {
    if (!loading) {
      setShowLoading(false)
      return
    }
    const timer = setTimeout(() => setShowLoading(true), 300)
    return () => clearTimeout(timer)
  }, [loading])
  const [revision, setRevision] = useState(0)
  const scope = `${snapshot.device.id}:${snapshot.device.dataScope}:${snapshot.device.scopes.join(',')}`
  const candidates = snapshot.tasks
    .filter(task => !task.archived && spaceOf(task) === 'code' && (!ids || ids.includes(task.id)))
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 12)
  const signature = candidates
    .toSorted((a, b) => a.id.localeCompare(b.id))
    .map(
      task => `${task.id}:${task.status}:${task.status === 'running' || task.status === 'waiting-approval' ? task.runId : task.updatedAt}`,
    )
    .join('|')
  const enabled =
    active
    && connection === 'connected'
    && snapshot.catalog?.features?.gitDelivery === true
    && snapshot.device.dataScope === 'all'
    && snapshot.device.scopes.includes('view')
  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let busy = false
    const read = async () => {
      clearTimeout(timer)
      if (busy || controller.signal.aborted || document.visibilityState === 'hidden') return
      if (!candidates.length) {
        setReadState({ scope, entries: EMPTY_ENTRIES })
        return
      }
      busy = true
      setLoading(true)
      try {
        const response = await api<WorkbenchDelivery>('workbench/delivery', {
          method: 'POST',
          body: { ids: candidates.map(task => task.id) },
          signal: controller.signal,
        })
        if (controller.signal.aborted) return
        setReadState({ scope, entries: new Map(response.entries.map(entry => [entry.sessionId, entry])) })
        const live =
          candidates.some(task => task.status === 'running' || task.status === 'waiting-approval')
          || response.entries.some(entry => entry.state?.running)
        const prs = response.entries.some(entry => entry.pr?.pr?.state === 'open')
        if (live || prs)
          timer = setTimeout(
            () => {
              void read()
            },
            live ? 1500 : 30_000,
          )
      } catch (cause) {
        if (!controller.signal.aborted)
          setReadState(previous => ({
            scope,
            entries: previous?.scope === scope ? previous.entries : EMPTY_ENTRIES,
            error: errorMessage(cause),
          }))
      } finally {
        busy = false
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    const foreground = () => {
      if (document.visibilityState !== 'hidden') void read()
      else clearTimeout(timer)
    }
    document.addEventListener('visibilitychange', foreground)
    void read()
    return () => {
      controller.abort()
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', foreground)
    }
  }, [enabled, scope, signature, revision])
  // A narrower device scope must not expose the previous read for even one render.
  const authorized =
    readState?.scope === scope
    && snapshot.catalog?.features?.gitDelivery === true
    && snapshot.device.dataScope === 'all'
    && snapshot.device.scopes.includes('view')
  const allowed = new Set(candidates.map(task => task.id))
  const entries = authorized ? new Map([...readState.entries].filter(([id]) => allowed.has(id))) : EMPTY_ENTRIES
  return {
    entries,
    loading: loading && showLoading,
    ready: authorized && !readState.error,
    ...(authorized && readState.error ? { error: readState.error } : {}),
    refresh: () => setRevision(value => value + 1),
  }
}

/** Detail stays behind the same endpoint as a conversation, and is read only once its card is visible. */
export function useWorkbenchSession(task: TaskSummary, scope: string, enabled: boolean, refreshMs?: number) {
  const element = useRef<HTMLElement>(null)
  const [visible, setVisible] = useState(false)
  const [read, setRead] = useState<{ key: string; detail?: TaskDetail; error?: string }>()
  const [revision, setRevision] = useState(0)
  const key = `${scope}:${task.id}:${refreshMs ? task.runId : task.updatedAt}:${task.status}`
  const [loadingKey, setLoadingKey] = useState<string>()
  useEffect(() => {
    if (!enabled || !visible || read?.key === key) return
    const timer = setTimeout(() => setLoadingKey(key), 300)
    return () => clearTimeout(timer)
  }, [key, visible, enabled, read?.key])
  useEffect(() => {
    if (!element.current || !enabled) {
      setVisible(false)
      return
    }
    const observer = new IntersectionObserver(items => setVisible(items.some(item => item.isIntersecting)), { rootMargin: '80px' })
    observer.observe(element.current)
    return () => observer.disconnect()
  }, [enabled])
  useEffect(() => {
    if (!enabled || !visible) return
    const controller = new AbortController()
    let busy = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () => {
      clearTimeout(timer)
      if (document.visibilityState === 'hidden' || busy) return
      busy = true
      void api<TaskDetail>(`tasks/${encodeURIComponent(task.id)}`, { signal: controller.signal })
        .then(detail => {
          if (!controller.signal.aborted && detail.summary.id === task.id) setRead({ key, detail })
        })
        .catch(cause => {
          if (!controller.signal.aborted) setRead({ key, error: errorMessage(cause) })
        })
        .finally(() => {
          busy = false
          if (refreshMs && !controller.signal.aborted && document.visibilityState !== 'hidden') timer = setTimeout(load, refreshMs)
        })
    }
    load()
    document.addEventListener('visibilitychange', load)
    return () => {
      controller.abort()
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', load)
    }
  }, [key, visible, enabled, revision, refreshMs])
  return {
    element,
    loading: enabled && visible && read?.key !== key && loadingKey === key,
    ...(read?.key === key ? read : {}),
    retry: () => setRevision(value => value + 1),
  }
}

export function hasDelivery(entry: WorkbenchDeliveryEntry | undefined): boolean {
  return !!entry && (entry.pr?.pr?.state === 'open' || (!!entry.state && (entry.state.files > 0 || entry.state.ahead > 0)))
}

/** Repository facts may belong to several sessions. Only an authorized, identical cwd proves one working tree. */
export function deliverySessions(tasks: readonly TaskSummary[], entries: ReadonlyMap<string, WorkbenchDeliveryEntry>): ReadonlySet<string> {
  const trees = new Set<string>()
  const result = new Set<string>()
  for (const task of tasks
    .filter(task => !task.archived && spaceOf(task) === 'code' && task.status !== 'running' && task.status !== 'waiting-approval')
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    if (!hasDelivery(entries.get(task.id))) continue
    const identity = task.cwd && !task.worktree?.removed ? task.cwd : undefined
    if (identity && trees.has(identity)) continue
    if (identity) trees.add(identity)
    result.add(task.id)
  }
  return result
}

/** Zero checks, a stale head and skipped checks are never described as a successful check run. */
export function deliveryChecks(entry: WorkbenchDeliveryEntry): string | undefined {
  if (entry.prError) return entry.prError.message
  const pr = entry.pr?.pr
  if (!pr) return undefined
  if (pr.state === 'merged') return '已合并'
  if (pr.draft) return '草稿 PR'
  const checks = entry.pr?.checks ?? []
  if (!checks.length) return '没有检查结果'
  if (pr.headSha && entry.state?.head && pr.headSha !== entry.state.head) return '检查对应旧提交'
  const failed = checks.filter(check => check.state === 'fail').length
  if (failed) return `${failed} 项检查失败`
  const pending = checks.filter(check => check.state === 'pending').length
  if (pending) return `${pending} 项检查中`
  const passed = checks.filter(check => check.state === 'pass').length
  const skipped = checks.filter(check => check.state === 'skipped').length
  return passed === checks.length ? `检查通过 ${passed}/${checks.length}` : `${passed} 项通过${skipped ? ` · ${skipped} 项跳过` : ''}`
}
