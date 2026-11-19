import type { TaskDetail, TaskSummary } from '@latch/protocol'
import { AppError } from '@latch/sdk'

export const FORK_CONTEXT_LIMIT = 200_000

/** Keep a bounded suffix without retaining a second, unbounded transcript. */
export function forkSeed(
  detail: TaskDetail,
  upToMessageId: string,
  /** What the record is introduced as; a fork names the session and the turn it forks after. */
  heading: (title: string, turn: number) => string = (title, turn) => `以下是会话「${title}」到第 ${turn} 轮为止的记录`,
  /**
   * Only the reply at `upToMessageId` goes across: a note the Harness being left wrote for whoever takes over, in the
   * place of the whole record. The person asked for it and read it before sending.
   */
  brief = false,
): {
  text: string
  context: NonNullable<TaskSummary['forkOf']>
  /** The record carries what a tool returned (or a subagent, or a fetched prompt): not the person's words. */
  outside: boolean
} {
  const end = detail.messages.findIndex(message => message.id === upToMessageId)
  if (end < 0) throw new AppError(400, 'fork-position', '找不到要分叉的位置，请重新打开原会话')
  const lastUser = detail.messages.findLastIndex(message => message.role === 'user' && !message.steered)
  if (
    (['running', 'waiting-approval'].includes(detail.summary.status) && end >= lastUser)
    || detail.messages.slice(0, end + 1).some(message => ['running', 'queued', 'awaiting-approval'].includes(message.state ?? ''))
  )
    throw new AppError(409, 'fork-running', '请等这一轮结束后再从这里分叉')
  const pieces: string[] = []
  let length = 0
  let truncated = false
  let turn = 0
  let outside = false
  // What the agent knew there: nothing from before the last new context.
  const start = Math.max(
    0,
    detail.messages.slice(0, end + 1).findLastIndex(message => message.role === 'user' && message.freshContext),
  )
  const add = (block: string) => {
    pieces.push(block.length > FORK_CONTEXT_LIMIT ? block.slice(-FORK_CONTEXT_LIMIT) : block)
    if (block.length > FORK_CONTEXT_LIMIT) truncated = true
    length += pieces[pieces.length - 1]!.length
    while (length > FORK_CONTEXT_LIMIT && pieces.length > 1) {
      const excess = length - FORK_CONTEXT_LIMIT
      const first = pieces[0]!
      if (first.length <= excess) {
        pieces.shift()
        length -= first.length
      } else {
        pieces[0] = first.slice(excess)
        length -= excess
      }
      truncated = true
    }
  }
  for (let index = 0; index <= end; index++) {
    const message = detail.messages[index]!
    if (message.role === 'user' && !message.steered) turn++
    if (index < start) continue
    if (brief && index !== end) continue
    if (message.role === 'tool' || message.subagent || message.origin === 'mcp-prompt') outside = true
    // A first message that itself began from a record (a fork, or a conversation that moved Harness) carries that
    // record before the person's words: it is written out once, as the turns it was, not as a record inside a record.
    let said = message.text
    const carried = message.role === 'user' && message.forkContext && !message.nativeFork ? message.forkContext.prefixLength : 0
    if (carried > 0) {
      const earlier = /<会话记录>([\s\S]*)\n<\/会话记录>/u.exec(message.text.slice(0, carried))?.[1]
      if (earlier !== undefined) {
        add(earlier)
        said = message.text.slice(carried)
      }
    }
    // Hidden reasoning and raw tool parameters are not required to continue the conversation.
    add(`\n\n${{ user: '你', assistant: '助手', tool: '工具结果', system: '会话说明' }[message.role]}：\n${said}`)
  }
  let transcript = pieces.join('')
  // A UTF-16 boundary must not leave half of a character at the beginning.
  if (/^[\uDC00-\uDFFF]/u.test(transcript)) transcript = transcript.slice(1)
  // The original prompt is immutable; renaming a source never changes a retried start's payload.
  const opening = detail.messages.find(message => message.role === 'user')
  // The person's own first words, without a record the message carries before them.
  const title = (
    opening ? opening.text.slice(opening.forkContext && !opening.nativeFork ? opening.forkContext.prefixLength : 0) : detail.summary.id
  )
    .replace(/\s+/gu, ' ')
    .slice(0, 80)
  if (brief && detail.messages[end]!.role !== 'assistant') throw new AppError(400, 'fork-position', '交接说明要是一条回复，请重新生成')
  const label = brief ? `以下是会话「${title}」里上一位 Agent 写给接手者的交接说明` : heading(title, turn)
  const text = `${label}\n${truncated ? '（较早的记录已截断，只保留最后 20 万字符。）\n' : ''}<会话记录>${transcript}\n</会话记录>\n\n请将以上内容作为背景，继续处理后面的请求。\n\n`
  return {
    text,
    outside,
    context: {
      taskId: detail.summary.id,
      upToMessageId,
      title,
      turn,
      prefixLength: text.length,
      ...(truncated ? { truncated: true } : {}),
      ...(brief ? { brief: true as const } : {}),
    },
  }
}
