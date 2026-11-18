import {
  GENERAL_AGENT_ID,
  type AppSnapshot,
  type TaskSummary,
  type WorkItemSummary,
  type WorkPost,
  type WorkPostTarget,
} from '@latch/protocol'
import { AGENT_SPACE_COPY } from '../agents/spaceCopy.ts'
import { defineCopy } from '../core/i18n.ts'
import type { WorkItemSessionTarget } from './itemPage.ts'

export const THREAD_COPY = defineCopy(
  {
    untitled: '未命名会话',
    unlisted: '不在列表中',
    sending: '发送中',
    sent: (name: string) => `已交给 ${name}`,
    unknown: '未确认送达',
    failed: '没有送达',
    waiting: {
      approval: { status: '等你审批', action: '查看审批' },
      question: { status: '等你回答', action: '查看问题' },
    },
  },
  {
    untitled: 'Untitled session',
    unlisted: 'Not in the list',
    sending: 'Sending',
    sent: (name: string) => `Sent to ${name}`,
    unknown: 'Delivery unconfirmed',
    failed: 'Not delivered',
    waiting: {
      approval: { status: 'Waiting for your approval', action: 'View approval' },
      question: { status: 'Waiting for your answer', action: 'View question' },
    },
  },
)

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
      ? [
          {
            kind: 'session' as const,
            id,
            label: task.title || THREAD_COPY.untitled,
            ...(task.harnessId ? { harnessId: task.harnessId } : {}),
          },
        ]
      : []
  })
  if (!snapshot.customAgents) return sessions
  const ready = (id: string) => snapshot.agentChats?.[id]?.state === 'ready'
  return [
    ...sessions,
    { kind: 'agent', id: GENERAL_AGENT_ID, label: AGENT_SPACE_COPY.general, ready: ready(GENERAL_AGENT_ID) },
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

const postGraphemes = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' })

/** A short excerpt for long posts, keeping the original line breaks and complete characters. */
export function postPreview(text: string): string | undefined {
  const preview = text.split('\n', 4).slice(0, 3).join('\n')
  if (preview.length > 96) {
    let count = 0
    for (const { index } of postGraphemes.segment(preview)) {
      if (count++ === 96) return `${preview.slice(0, index).trimEnd()}…`
    }
  }
  return preview.length < text.length ? `${preview.trimEnd()}…` : undefined
}

export const targetKey = (target: WorkPostTarget): string => ('sessionId' in target ? `s:${target.sessionId}` : `a:${target.customAgentId}`)

export function postTarget(target: ThreadTarget): WorkPostTarget {
  return target.kind === 'session' ? { sessionId: target.id } : { customAgentId: target.id }
}

/** The name a post's target goes by here; a session this device is not given is 不在列表中. */
export function targetLabel(target: WorkPostTarget, targets: readonly ThreadTarget[]): string {
  const found = targets.find(entry => targetKey(postTarget(entry)) === targetKey(target))
  if (found) return found.label
  return 'customAgentId' in target ? (target.customAgentId === GENERAL_AGENT_ID ? AGENT_SPACE_COPY.general : 'Agent') : THREAD_COPY.unlisted
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
      return { tone: 'running', words: THREAD_COPY.sending }
    case 'sent':
      return { tone: 'neutral', words: THREAD_COPY.sent(name) }
    case 'unknown':
      return { tone: 'warn', words: THREAD_COPY.unknown }
    case 'failed':
      return { tone: 'failed', words: THREAD_COPY.failed }
  }
}

export type PostDecision = NonNullable<WorkItemSessionTarget['decision']>

/** A new view of the source invalidates a decision from a previous read, even within the same run. */
export function postSourceVersion(task: TaskSummary): string {
  return JSON.stringify([
    task.harnessId,
    task.runId,
    task.updatedAt,
    task.board?.reason,
    task.status,
    task.pendingQuestions,
    task.live?.activity,
  ])
}

export function postDecision(
  { attention, delivery, turn }: Pick<WorkPost, 'attention' | 'delivery' | 'turn'>,
  snapshot: Pick<AppSnapshot, 'tasks' | 'approvals'>,
  version: string | undefined,
): PostDecision | undefined {
  if (
    !attention?.decisionId
    || (attention.reason !== 'approval' && attention.reason !== 'question')
    || !turn?.runId
    || !turn.userMessageId
    || delivery?.state !== 'sent'
    || delivery.sessionId !== turn.sessionId
  )
    return undefined

  const task = snapshot.tasks.find(entry => entry.id === turn.sessionId)
  if (
    !task
    || version !== postSourceVersion(task)
    || task.runId !== turn.runId
    || task.board?.group !== 'attention'
    || task.board.reason !== attention.reason
    || (task.status !== 'running' && task.status !== 'waiting-approval')
    || (task.live && (task.live.runId !== turn.runId || task.live.activity === 'cancelling'))
  )
    return undefined

  const pending =
    attention.reason === 'approval'
      ? snapshot.approvals.some(approval => approval.sessionId === task.id && approval.id === attention.decisionId)
      : (task.pendingQuestions ?? 0) > 0
  return pending ? { kind: attention.reason, id: attention.decisionId, runId: turn.runId } : undefined
}

/** Keep the human post and delivery receipt. The source ID is only used to decide when to read it again. */
export function withoutPostSource(post: WorkPost): WorkPost {
  const { target: _target, turn: _turn, reply: _reply, attention: _attention, delivery, ...note } = post
  return {
    ...note,
    ...(delivery ? { delivery: { state: delivery.state, ...(delivery.sessionId ? { sessionId: delivery.sessionId } : {}) } } : {}),
  }
}

/** A partial listing cannot establish that a reply's source has gone. */
export function withoutMissingPostSources(posts: WorkPost[], snapshot: Pick<AppSnapshot, 'tasks' | 'tasksComplete'>): WorkPost[] {
  if (!snapshot.tasksComplete) return posts
  const listed = new Set(snapshot.tasks.map(task => task.id))
  const next = posts.map(post => {
    const source = post.turn?.sessionId ?? post.delivery?.sessionId
    return source
      && !listed.has(source)
      && (post.reply || post.turn || post.target || post.attention || post.delivery?.reason || post.delivery?.code)
      ? withoutPostSource(post)
      : post
  })
  return next.some((post, index) => post !== posts[index]) ? next : posts
}

/** What the thread shows of the sessions it reads replies from: a change there reads the thread again. */
export function replySources(posts: readonly WorkPost[] | null, snapshot: Pick<AppSnapshot, 'tasks'>): string {
  const ids = [...new Set((posts ?? []).flatMap(post => (post.delivery?.sessionId ? [post.delivery.sessionId] : [])))]
  return ids
    .map(id => {
      const task = snapshot.tasks.find(task => task.id === id)
      return `${id}:${task ? postSourceVersion(task) : ''}`
    })
    .join('|')
}
