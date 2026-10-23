import type { AppSnapshot, TaskDetail, TaskStateEvent } from '../shared/types.ts'

export interface ProjectionTicket {
  generation: number
  sessionId: string | null
}

/** Selection generations and Host-scoped revisions protect async replacements. */
export class ProjectionGuard {
  private generation = 0
  private revision = -1
  private sourcePriority = 0
  instanceId: string | null = null
  sessionId: string | null = null

  capture(): ProjectionTicket {
    return { generation: this.generation, sessionId: this.sessionId }
  }
  current(ticket: ProjectionTicket): boolean {
    return ticket.generation === this.generation && ticket.sessionId === this.sessionId
  }
  invalidate(): void {
    this.generation++
    this.revision = -1
    this.sourcePriority = 0
  }
  bind(instanceId: string | null): void {
    if (this.instanceId === instanceId) return
    this.instanceId = instanceId
    this.invalidate()
  }
  select(sessionId: string | null): void {
    if (this.sessionId === sessionId) return
    this.sessionId = sessionId
    this.invalidate()
  }
  accept(ticket: ProjectionTicket, detail: TaskDetail, source: 'http' | 'stream' = 'http'): boolean {
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
    return true
  }
}

/** The selected slice wins ties; a strictly newer snapshot owns its summaries. */
export function mergeTaskSnapshot(snapshot: AppSnapshot, detail: TaskDetail | null): AppSnapshot {
  if (!detail || detail.sync?.instanceId !== snapshot.instanceId || detail.sync.revision < (snapshot.revision ?? -1)) return snapshot
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
    return { ...event, detail: { ...event.detail, sync: { instanceId: event.instanceId, revision: event.revision! } } } as TaskStateEvent
  } catch {
    return
  }
}
