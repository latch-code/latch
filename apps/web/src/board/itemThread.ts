import { GENERAL_AGENT_ID, type AppSnapshot, type WorkItemSummary, type WorkPost, type WorkPostTarget } from '@latch/protocol'

/** One name the thread's @ offers: a session of this 待办, or one of 我的 Agent. */
export type ThreadTarget =
  | { kind: 'session'; id: string; label: string; harnessId?: string }
  | { kind: 'agent'; id: string; label: string; ready: boolean }

/**
 * Who a post may name, as this device was given them: the 待办's sessions it lists (Code sessions), then 通用 and 我的
 * Agent when it may read them. An Agent takes a post only in a chat it already has.
 */
export function threadTargets(
  snapshot: Pick<AppSnapshot, 'tasks' | 'customAgents' | 'agentChats'>,
  item: Pick<WorkItemSummary, 'sessionIds'>,
): ThreadTarget[] {
  const sessions = item.sessionIds.flatMap(id => {
    const task = snapshot.tasks.find(entry => entry.id === id)
    return task
      ? [{ kind: 'session' as const, id, label: task.title || '未命名会话', ...(task.harnessId ? { harnessId: task.harnessId } : {}) }]
      : []
  })
  if (!snapshot.customAgents) return sessions
  const ready = (id: string) => snapshot.agentChats?.[id]?.state === 'ready'
  return [
    ...sessions,
    { kind: 'agent', id: GENERAL_AGENT_ID, label: '通用', ready: ready(GENERAL_AGENT_ID) },
    ...snapshot.customAgents.map(agent => ({ kind: 'agent' as const, id: agent.id, label: agent.name, ready: ready(agent.id) })),
  ]
}

/** The `@word` being typed at the caret: where it starts and what follows the @. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | undefined {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0) return undefined
  if (at > 0 && !/\s/u.test(before[at - 1]!)) return undefined
  const query = before.slice(at + 1)
  if (/\s/u.test(query) || query.length > 40) return undefined
  return { start: at, query }
}

/** Targets whose name holds the query, ignoring case; sessions first, as listed. */
export function matchTargets(targets: readonly ThreadTarget[], query: string): ThreadTarget[] {
  const needle = query.toLocaleLowerCase()
  return targets.filter(target => target.label.toLocaleLowerCase().includes(needle))
}

/** The text with the `@word` at `start` taken out: the target is the chip, not part of what is sent. */
export function withoutMention(text: string, start: number, caret: number): string {
  return (text.slice(0, start) + text.slice(caret)).replace(/^\s+/u, '')
}

export const targetKey = (target: WorkPostTarget): string => ('sessionId' in target ? `s:${target.sessionId}` : `a:${target.customAgentId}`)

export function postTarget(target: ThreadTarget): WorkPostTarget {
  return target.kind === 'session' ? { sessionId: target.id } : { customAgentId: target.id }
}

/** The name a post's target goes by here; a session this device is not given is 不在列表中. */
export function targetLabel(target: WorkPostTarget, targets: readonly ThreadTarget[]): string {
  const found = targets.find(entry => targetKey(postTarget(entry)) === targetKey(target))
  if (found) return found.label
  return 'customAgentId' in target ? (target.customAgentId === GENERAL_AGENT_ID ? '通用' : 'Agent') : '不在列表中'
}

/** A delivered post's state in words: the same words as a message sent from the input. */
export function deliveryWords(
  post: Pick<WorkPost, 'delivery'>,
  name: string,
): { tone: 'neutral' | 'running' | 'warn' | 'failed'; words: string } | undefined {
  const delivery = post.delivery
  if (!delivery) return undefined
  switch (delivery.state) {
    case 'sending':
      return { tone: 'running', words: '发送中' }
    case 'sent':
      return { tone: 'neutral', words: `已交给 ${name}` }
    case 'unknown':
      return { tone: 'warn', words: '未确认送达' }
    case 'failed':
      return { tone: 'failed', words: '没有送达' }
  }
}

/** What the thread shows of the sessions it reads replies from: a change there reads the thread again. */
export function replySources(posts: readonly WorkPost[] | null, snapshot: Pick<AppSnapshot, 'tasks'>): string {
  const ids = [...new Set((posts ?? []).flatMap(post => (post.delivery ? [post.delivery.sessionId] : [])))]
  return ids.map(id => `${id}:${snapshot.tasks.find(task => task.id === id)?.updatedAt ?? ''}`).join('|')
}
