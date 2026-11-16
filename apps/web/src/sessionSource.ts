import { GENERAL_AGENT_ID, type AppSnapshot, type TaskSummary } from '@latch/protocol'
import { sourceCrumb } from './handoffs/model.ts'

/** Where a session came from, as its one 「来自 …」 line says it. */
export type SessionSource =
  /** Handed off from another session; `title` only while this device lists it. */
  | { kind: 'handoff'; sessionId: string; title?: string; listed: boolean }
  /** Forked from another session; the fork keeps the source's title, a link only while it is listed. */
  | { kind: 'fork'; sessionId: string; title: string; listed: boolean }
  /** A scheduled run of 我的 Agent: the schedule's name and whose it is. */
  | { kind: 'schedule'; automationId: string; title: string; owner: string }

/**
 * The one source of a session, in this order: a handoff, a fork, a schedule. A schedule this device is not given is
 * not named. Shared by the session header and the board's cards.
 */
export function sessionSource(
  snapshot: Pick<AppSnapshot, 'handoffs' | 'tasks' | 'automations' | 'catalog'>,
  task: Pick<TaskSummary, 'id' | 'forkOf' | 'automationId'>,
): SessionSource | undefined {
  const handed = snapshot.catalog?.features?.handoffs ? sourceCrumb(snapshot, task.id) : undefined
  if (handed)
    return { kind: 'handoff', sessionId: handed.sourceId, ...(handed.title ? { title: handed.title } : {}), listed: !!handed.title }
  if (task.forkOf) {
    const listed = snapshot.tasks.find(item => item.id === task.forkOf!.taskId)
    return {
      kind: 'fork',
      sessionId: task.forkOf.taskId,
      title: (listed ? listed.title : task.forkOf.title) || '未命名会话',
      listed: listed !== undefined,
    }
  }
  const schedule = task.automationId ? snapshot.automations?.find(item => item.id === task.automationId) : undefined
  if (schedule)
    return { kind: 'schedule', automationId: schedule.id, title: schedule.name, owner: schedule.customAgentId ?? GENERAL_AGENT_ID }
  return undefined
}
