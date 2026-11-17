import type { AppSnapshot, TaskDetail, TaskStateEvent } from '@latch/protocol'

export interface ProjectionTicket {
  generation: number
  sessionId: string | null
}

type DetailSource = 'http' | 'stream'
const RECENT_DETAILS = 8

/** Selection generations and Host-scoped revisions protect async replacements. */
export class ProjectionGuard {
  private generation = 0
  private revision = -1
  private sourcePriority = 0
  private readonly recent = new Map<string, { detail: TaskDetail; source: DetailSource }>()
  instanceId: string | null = null
  sessionId: string | null = null

  capture(): ProjectionTicket {
    return { generation: this.generation, sessionId: this.sessionId }
  }
  current(ticket: ProjectionTicket): boolean {
    return ticket.generation === this.generation && ticket.sessionId === this.sessionId
  }
  private reset(): void {
    this.generation++
    this.revision = -1
    this.sourcePriority = 0
  }
  /** A change of authority (or sign-out) also invalidates every cached detail. */
  invalidate(): void {
    this.reset()
    this.recent.clear()
  }
  bind(instanceId: string | null): void {
    if (this.instanceId === instanceId) return
    this.instanceId = instanceId
    this.invalidate()
  }
  select(sessionId: string | null, warm = false): TaskDetail | null {
    if (this.sessionId === sessionId) return null
    this.sessionId = sessionId
    this.reset()
    const saved = warm && sessionId !== null ? this.recent.get(sessionId) : undefined
    return saved && this.accept(this.capture(), saved.detail, saved.source) ? saved.detail : null
  }
  forget(sessionId: string): void {
    this.recent.delete(sessionId)
    if (this.sessionId === sessionId) this.reset()
  }
  /** A complete, current listing can end the selected detail's visibility. Return its ID for the view to close. */
  retain(snapshot: Pick<AppSnapshot, 'tasks' | 'tasksComplete' | 'revision'>): string | null {
    if (!snapshot.tasksComplete || snapshot.revision === undefined) return null
    const listed = new Set(snapshot.tasks.map(task => task.id))
    let removed: string | null = null
    for (const [id, { detail }] of this.recent) {
      // The snapshot request may have started before the session's first streamed detail.
      if (listed.has(id) || (detail.sync?.revision ?? -1) > snapshot.revision) continue
      this.recent.delete(id)
      if (id === this.sessionId) removed = id
    }
    if (removed !== null) this.select(null)
    return removed
  }
  accept(ticket: ProjectionTicket, detail: TaskDetail, source: DetailSource = 'http'): boolean {
    if (!this.current(ticket) || detail.summary.id !== this.sessionId) return false
    if (detail.sync) {
      if (detail.sync.instanceId !== this.instanceId || detail.sync.revision < this.revision) return false
      const priority = source === 'stream' ? 2 : 1
      // At the same revision, a streamed slice supersedes HTTP; delayed HTTP
      // and duplicate stream frames cannot undo the already accepted slice.
      if (detail.sync.revision === this.revision && priority <= this.sourcePriority) return false
      this.revision = detail.sync.revision
      this.sourcePriority = priority
    } else if (this.revision >= 0) return false
    this.recent.delete(detail.summary.id)
    this.recent.set(detail.summary.id, { detail, source })
    if (this.recent.size > RECENT_DETAILS) this.recent.delete(this.recent.keys().next().value!)
    return true
  }
}

/** The selected slice wins ties; a strictly newer snapshot owns its summaries. */
export function detailOwnsSummary(snapshot: Pick<AppSnapshot, 'instanceId' | 'revision'>, detail: TaskDetail | null): boolean {
  return detail?.sync?.instanceId === snapshot.instanceId && detail.sync.revision >= (snapshot.revision ?? -1)
}

export function mergeTaskSnapshot(snapshot: AppSnapshot, detail: TaskDetail | null): AppSnapshot {
  if (!detail || !detailOwnsSummary(snapshot, detail)) return snapshot
  const tasks = snapshot.tasks.filter(task => task.id !== detail.summary.id)
  tasks.push(detail.summary)
  tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return {
    ...snapshot,
    tasks,
    approvals: [...snapshot.approvals.filter(approval => approval.sessionId !== detail.summary.id), ...detail.approvals],
  }
}

export function parseTaskState(data: string): TaskStateEvent | undefined {
  try {
    const value: unknown = JSON.parse(data)
    if (!value || typeof value !== 'object') return
    const event = value as Partial<TaskStateEvent>
    if (
      event.type !== 'task-state'
      || typeof event.instanceId !== 'string'
      || !Number.isSafeInteger(event.revision)
      || event.revision! < 0
      || typeof event.sessionId !== 'string'
      || !event.detail
      || event.detail.summary?.id !== event.sessionId
      || !Array.isArray(event.detail.messages)
      || !Array.isArray(event.detail.approvals)
      || typeof event.detail.liveText !== 'string'
    )
      return
    const hostTime = typeof event.hostTime === 'string' ? event.hostTime : undefined
    return {
      ...event,
      detail: { ...event.detail, sync: { instanceId: event.instanceId, revision: event.revision!, ...(hostTime ? { hostTime } : {}) } },
    } as TaskStateEvent
  } catch {
    return
  }
}
