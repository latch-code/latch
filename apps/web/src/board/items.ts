import type { AppSnapshot, BoardReason, Message, TaskDetail, TaskSummary, WorkItemPlace, WorkItemSummary } from '@latch/protocol'
import { quotedSummary } from '../handoffs/model.ts'
import { GROUP_LABELS } from './model.ts'

/**
 * 待办 as this device was given them: membership is read from `items[].sessionIds` only (a session's own `itemId` may
 * be withheld), and nothing is shown of an item the snapshot does not list.
 */

/** The 待办 this session belongs to, as the snapshot lists it. */
export function itemOfSession(snapshot: Pick<AppSnapshot, 'items'>, sessionId: string): WorkItemSummary | undefined {
  return snapshot.items?.find(item => item.sessionIds.includes(sessionId))
}

/** A session the Host lets join a 待办: a Code session (not 我的 Agent, 通用, an assistant's or a schedule's). */
export const codeSession = (task: TaskSummary): boolean => !task.agent && !task.generalChat && !task.personal && !task.automationId

/** Sessions this device may add to a 待办: listed, Code, not archived, in no 待办. Newest first. */
export function joinableSessions(snapshot: Pick<AppSnapshot, 'items' | 'tasks'>): TaskSummary[] {
  const taken = new Set((snapshot.items ?? []).flatMap(item => item.sessionIds))
  return snapshot.tasks
    .filter(task => codeSession(task) && !task.archived && !taken.has(task.id))
    .toSorted((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
}

/** 待办 a session may join from its menu: the ones not marked done and not full. */
export function openItems(snapshot: Pick<AppSnapshot, 'items'>, limit: number): WorkItemSummary[] {
  return (snapshot.items ?? [])
    .filter(item => !item.closedAt && item.sessionIds.length < limit)
    .toSorted((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
}

const POST_ATTENTION: Record<BoardReason, string> = {
  approval: '等待审批',
  question: '等待回答',
  unrecognized: '请求不受支持',
  silent: '没有动静',
  unknown: '结果未知',
  failed: '本轮失败',
}

/** The group the Host gave the 待办 and the reason of an addressed post, when it supplied one. */
export function placeWords(place: WorkItemPlace): string {
  if (place.postId && place.reason && place.reason !== 'settled') return POST_ATTENTION[place.reason]
  if (place.group === 'todo') return '未开始'
  return GROUP_LABELS[place.group]
}

/** Longest reply 带过去 carries; the rest is cut at a line. */
const QUOTE_LIMIT = 8000

/** The session's last settled reply: the newest assistant message with text, never the live text of a running turn. */
export function lastReply(messages: readonly Pick<Message, 'role' | 'text'>[]): string | undefined {
  const text = messages.findLast(message => message.role === 'assistant' && message.text.trim())?.text.trim()
  if (!text) return undefined
  if (text.length <= QUOTE_LIMIT) return text
  const cut = text.slice(0, QUOTE_LIMIT)
  const line = cut.lastIndexOf('\n')
  return `${line > QUOTE_LIMIT / 2 ? cut.slice(0, line) : cut}\n…`
}

/**
 * 带过去: reads the source session (one GET) and hands its last settled reply, as a quote, to the target's input; then
 * the target opens. It sends nothing: sending stays the person's act. `empty` when the source has no reply yet.
 */
export async function bringReply(
  sourceId: string,
  targetId: string,
  {
    read,
    hand,
    open,
  }: {
    read: (path: string) => Promise<Pick<TaskDetail, 'messages'>>
    hand: (sessionId: string, text: string) => void
    open: (sessionId: string) => void
  },
): Promise<'brought' | 'empty'> {
  const detail = await read(`tasks/${encodeURIComponent(sourceId)}`)
  const reply = lastReply(detail.messages)
  if (!reply) return 'empty'
  hand(targetId, quotedSummary('', reply).trimEnd())
  open(targetId)
  return 'brought'
}
