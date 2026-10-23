import type { Approval, Message, TaskDetail, TokenUsage } from '../../shared/types.ts'
import { MessageRow } from './MessageRow.tsx'
import { ToolCard, type ApprovalGateFor, type DecideHandler } from './ToolCard.tsx'

export const liveMessageId = (detail: TaskDetail) => detail.liveMessageId ?? `live:${detail.summary.id}`
export const isLive = (detail: TaskDetail) => detail.liveText.length > 0 || (detail.liveReasoning?.length ?? 0) > 0

/** Committed messages plus the streaming reply under the ID it will keep once committed. */
export function renderedMessages(detail: TaskDetail): Message[] {
  const messages = [...detail.messages]
  const id = liveMessageId(detail)
  if (isLive(detail) && !messages.some(message => message.id === id)) {
    messages.push({ id, role: 'assistant', text: detail.liveText, ...(detail.liveReasoning ? { reasoning: detail.liveReasoning } : {}) })
  }
  return messages
}

export const toolRowId = (approval: Approval) => (approval.toolCallId ? `tool:${approval.toolCallId}` : undefined)

/**
 * The last assistant block of each settled turn carries the turn's footer (copy and
 * summed usage); earlier blocks between tool calls stay compact. The trailing turn
 * of an active session has no footer yet.
 */
export function turnFooters(messages: Message[], active: boolean): Map<string, TokenUsage | undefined> {
  const footers = new Map<string, TokenUsage | undefined>()
  let last: string | undefined
  let usage: TokenUsage | undefined
  const close = () => {
    if (last !== undefined) footers.set(last, usage)
    last = undefined
    usage = undefined
  }
  for (const message of messages) {
    if (message.role === 'user') close()
    else if (message.role === 'assistant') {
      last = message.id
      if (message.usage)
        usage = {
          inputTokens: (usage?.inputTokens ?? 0) + message.usage.inputTokens,
          outputTokens: (usage?.outputTokens ?? 0) + message.usage.outputTokens,
        }
    }
  }
  if (!active) close()
  return footers
}

export function Transcript({
  detail,
  approvals,
  busy,
  onDecide,
  gateFor,
  harnessName,
  active = false,
}: {
  detail: TaskDetail
  approvals: Approval[]
  busy: ReadonlyMap<string, string>
  onDecide: DecideHandler
  /** This device's approval buttons; omitted, every offered option is shown. */
  gateFor?: ApprovalGateFor
  harnessName: string
  /** The session is running; its trailing turn is not finished. */
  active?: boolean
}) {
  const messages = renderedMessages(detail)
  const footers = turnFooters(messages, active)
  const live = isLive(detail)
  const liveId = liveMessageId(detail)
  const byTool = new Map(
    approvals.flatMap(approval => {
      const id = toolRowId(approval)
      return id ? [[id, approval] as const] : []
    }),
  )
  const ids = new Set(messages.map(message => message.id))
  const standalone = approvals.filter(approval => {
    const id = toolRowId(approval)
    return id === undefined || !ids.has(id)
  })
  let turnHasMeta = false
  return (
    <>
      {messages.map(message => {
        if (message.role === 'user') turnHasMeta = false
        if (message.role === 'tool') {
          const approval = byTool.get(message.id)
          return (
            <ToolCard
              key={message.id}
              message={message}
              approval={approval}
              busy={approval ? busy.get(approval.id) : undefined}
              onDecide={onDecide}
              gateFor={gateFor}
            />
          )
        }
        const showMeta = message.role === 'assistant' && !turnHasMeta
        if (showMeta) turnHasMeta = true
        return (
          <MessageRow
            key={message.id}
            message={message}
            streaming={live && message.id === liveId}
            meta={showMeta ? harnessName : undefined}
            footer={footers.has(message.id)}
            usage={footers.get(message.id)}
          />
        )
      })}
      {standalone.map(approval => (
        <ToolCard key={approval.id} message={null} approval={approval} busy={busy.get(approval.id)} onDecide={onDecide} gateFor={gateFor} />
      ))}
    </>
  )
}
