import type { AppSnapshot, TaskDetail, TaskStateEvent } from '@latch/protocol'

export interface ProjectionTicket {
  generation: number
  sessionId: string | null
}

type DetailSource = 'http' | 'stream'
type ReadDetail = { detail: TaskDetail; source: DetailSource }
const RECENT_DETAILS = 8
const RECENT_DETAIL_BUDGET = 4 * 1024 * 1024
const MAX_DETAIL_SLOTS = 20_000

/** Estimate retained text and structure without serializing the full history or traversing unbounded tool payloads. */
function detailCost(detail: TaskDetail): number {
  const pending: unknown[] = [detail]
  let cost = 0
  let slots = 0
  while (pending.length > 0) {
    const value = pending.pop()
    if (typeof value === 'string') cost += value.length * 2
    if (value && typeof value === 'object') {
      cost += 32
      if (Array.isArray(value)) {
        slots += value.length
        cost += value.length * 16
        if (slots > MAX_DETAIL_SLOTS || cost > RECENT_DETAIL_BUDGET) return Infinity
        for (const item of value) pending.push(item)
      } else {
        for (const key in value) {
          if (!Object.hasOwn(value, key)) continue
          slots++
          cost += key.length * 2 + 16
          if (slots > MAX_DETAIL_SLOTS || cost > RECENT_DETAIL_BUDGET) return Infinity
          const entry: unknown = Reflect.get(value, key)
          pending.push(entry)
        }
      }
    }
    if (cost > RECENT_DETAIL_BUDGET) return Infinity
  }
  return cost
}

/** Selection generations and Host-scoped revisions protect async replacements. */
export class ProjectionGuard {
  private generation = 0
  private revision = -1
  private sourcePriority = 0
  private displayed: ReadDetail | null = null
  private readonly recent = new Map<string, ReadDetail & { cost: number }>()
  private recentCost = 0
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
    this.displayed = null
  }
  /** A change of authority (or sign-out) also invalidates every cached detail. */
  invalidate(): void {
    this.reset()
    this.recent.clear()
    this.recentCost = 0
  }
  bind(instanceId: string | null): void {
    if (this.instanceId === instanceId) return
    this.instanceId = instanceId
    this.invalidate()
  }
  select(sessionId: string | null, warm = false): TaskDetail | null {
    if (this.sessionId === sessionId) return null
    const previous = this.displayed
    const saved = warm && sessionId !== null ? this.recent.get(sessionId) : undefined
    if (saved) this.dropRecent(saved.detail.summary.id)
    this.sessionId = sessionId
    this.reset()
    // Once per switch, never on a text delta: the detail in use can be larger than the warm cache.
    if (previous) {
      const cost = detailCost(previous.detail)
      if (cost <= RECENT_DETAIL_BUDGET) {
        this.recent.set(previous.detail.summary.id, { ...previous, cost })
        this.recentCost += cost
        this.trimRecent(RECENT_DETAILS)
      }
    }
    return saved && this.accept(this.capture(), saved.detail, saved.source) ? saved.detail : null
  }
  private dropRecent(sessionId: string): void {
    const entry = this.recent.get(sessionId)
    if (entry) this.recentCost -= entry.cost
    this.recent.delete(sessionId)
  }
  private trimRecent(count: number): void {
    while (this.recent.size > count || this.recentCost > RECENT_DETAIL_BUDGET) this.dropRecent(this.recent.keys().next().value!)
  }
  forget(sessionId: string): void {
    this.dropRecent(sessionId)
    if (this.sessionId === sessionId) this.reset()
  }
  /** A complete, current listing can end the selected detail's visibility. Return its ID for the view to close. */
  retain(snapshot: Pick<AppSnapshot, 'tasks' | 'tasksComplete' | 'revision'>): string | null {
    if (!snapshot.tasksComplete || snapshot.revision === undefined) return null
    const listed = new Set(snapshot.tasks.map(task => task.id))
    const current = this.sessionId
    const selected = this.displayed ?? (current === null ? undefined : this.recent.get(current))
    for (const [id, { detail }] of this.recent) {
      // The snapshot request may have started before the session's first streamed detail.
      if (listed.has(id) || (detail.sync?.revision ?? -1) > snapshot.revision) continue
      this.dropRecent(id)
    }
    if (current === null || !selected || listed.has(current) || (selected.detail.sync?.revision ?? -1) > snapshot.revision) return null
    this.sessionId = null
    this.reset()
    return current
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
    this.dropRecent(detail.summary.id)
    this.displayed = { detail, source }
    this.trimRecent(RECENT_DETAILS - 1)
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
