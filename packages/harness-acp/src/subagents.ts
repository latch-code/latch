import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Message, Subagent } from '@latch/protocol'
import { append, clip, mergeTool, settleToolMessage, TOOL_TEXT_LIMIT, toolMessage, type ToolState } from './mapping.ts'
import type { ToolFields } from './protocol.ts'

/** Steps a subagent row keeps; what comes after is counted as `truncated`. */
export const MAX_STEPS = 200
/** Subagent rows one agent process shows at a time; ones that said they stopped in an earlier turn no longer count. */
export const MAX_CHILDREN = 64
/** How deep a subagent's own subagents are shown. */
export const MAX_DEPTH = 4
/** Subagents one process follows, shown or not; past this the oldest that stopped is forgotten, else a new one is ignored. */
export const MAX_TRACKED = 1024

/**
 * `subagent_update` on the session that owns the child (ACP subagents RFD). Each field is a patch: absent leaves it,
 * `null` clears it. Only `sessionId` is required.
 */
export const subagentUpdate = z.object({
  sessionId: z.string().min(1).max(512),
  title: z.string().nullish(),
  description: z.string().nullish(),
  state: z
    .object({ state: z.string().max(64), stopReason: z.string().max(64).nullish(), error: z.unknown().optional() })
    .nullish()
    .catch(undefined),
})
export type SubagentUpdate = z.infer<typeof subagentUpdate>

/** A subagent announced on a live process: where its row is, and its tool calls while that process runs. */
export interface Child {
  acpSessionId: string
  taskId: string
  /** The child that started this one; absent when the session's own agent did. */
  parent?: Child
  /** Its row; absent past the limits on rows and depth, where only its requests reach the person. */
  messageId?: string
  /** Its name, for its requests when it has no row. */
  title: string
  /** What it last reported when it has no row; a row keeps its own. */
  status?: Subagent['status']
  /** It said it stopped by the end of a turn, and has reported nothing since: it no longer counts toward the rows. */
  ended?: boolean
  depth: number
  tools: Map<string, ToolState>
  /** The step its text is being appended to, until a tool call comes between. */
  textStep?: string
}

/** What a reported work state means to the row. Unknown states and stop reasons say nothing settled. */
export function reportedStatus(state: NonNullable<SubagentUpdate['state']>): Subagent['status'] {
  switch (state.state) {
    case 'running':
      return 'running'
    case 'requires_action':
      return 'waiting'
    case 'unknown':
      return 'unknown'
    case 'idle':
      // Some agents end failed work with `end_turn` and the error beside it.
      if (state.error != null) return 'failed'
      if (state.stopReason === 'cancelled') return 'cancelled'
      if (
        state.stopReason === 'end_turn'
        || state.stopReason === 'max_tokens'
        || state.stopReason === 'max_turn_requests'
        || !state.stopReason
      )
        return 'done'
      return 'failed'
    default:
      return undefined
  }
}

/** The row's own state, read as a tool row's: a subagent that says nothing settled has no state. */
function rowState(status: Subagent['status']): Message['state'] {
  switch (status) {
    case 'running':
      return 'running'
    case 'waiting':
      return 'awaiting-approval'
    case 'done':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    default:
      return undefined
  }
}

/** A subagent's name as shown. */
export function subagentTitle(title: string | null | undefined, redact: (text: string) => string): string {
  return label(title, redact) ?? '子 Agent'
}

/** The row for a subagent, newly announced or (`known`) followed so far without one. */
export function subagentRow(
  id: string,
  update: SubagentUpdate,
  redact: (text: string) => string,
  at: string,
  known?: Pick<Child, 'title' | 'status'>,
): Message {
  const status = update.state ? (reportedStatus(update.state) ?? known?.status) : update.state === null ? undefined : known?.status
  const subagent: Subagent = {
    title: update.title === undefined && known ? known.title : subagentTitle(update.title, redact),
    steps: [],
  }
  const description = label(update.description, redact, 500)
  if (description) subagent.description = description
  if (status) subagent.status = status
  const state = rowState(status)
  return { id, role: 'tool', text: '', toolName: 'subagent', createdAt: at, ...(state ? { state } : {}), subagent }
}

/** Applies a later `subagent_update` to its row. */
export function patchSubagent(row: Message, update: SubagentUpdate, redact: (text: string) => string): void {
  const subagent = row.subagent!
  if (update.title !== undefined) subagent.title = subagentTitle(update.title, redact)
  if (update.description !== undefined) {
    const description = label(update.description, redact, 500)
    if (description) subagent.description = description
    else delete subagent.description
  }
  if (update.state === null) delete subagent.status
  else if (update.state) {
    const status = reportedStatus(update.state)
    if (status) subagent.status = status
  }
  const state = rowState(subagent.status)
  if (state) row.state = state
  else delete row.state
}

/**
 * A row whose turn ended, or whose process is gone, while it still said it was working: nobody can say it is, so it says
 * so. `restart`: its process is gone too, so its unfinished calls are settled as any tool row of a stopped turn is.
 */
export function settleSubagent(row: Message, at: string, restart = false): boolean {
  const subagent = row.subagent
  if (!subagent) return false
  let changed = false
  if (restart)
    for (const step of subagent.steps) {
      if (step.subagent) changed = settleSubagent(step, at, true) || changed
      else changed = settleToolMessage(step, at) || changed
    }
  if (subagent.status !== 'running' && subagent.status !== 'waiting') return changed
  subagent.status = 'unknown'
  delete row.state
  return true
}

/** Appends the subagent's reply text, continuing its last text step while nothing came between. */
export function childText(child: Child, row: Message, piece: string, at: string): void {
  const steps = row.subagent!.steps
  const last = steps.at(-1)
  if (child.textStep && last?.id === child.textStep) {
    last.text = append(last.text, piece, TOOL_TEXT_LIMIT)
    return
  }
  if (!room(row)) return
  const id = randomUUID()
  steps.push({ id, role: 'assistant', text: append('', piece, TOOL_TEXT_LIMIT), state: 'completed', createdAt: at })
  child.textStep = id
}

/** A call kept only for its request: past the subagent's step limit, or of a subagent with no row. */
export function looseTool(child: Child, fields: ToolFields, at: string): ToolState {
  const state: ToolState = { id: `tool:${child.acpSessionId}:${fields.toolCallId}`, content: [], locations: [], awaiting: 0 }
  mergeTool(state, fields, at)
  return state
}

/** A tool call of the subagent, merged into its step. */
export function childTool(child: Child, row: Message, fields: ToolFields, at: string): ToolState | undefined {
  child.textStep = undefined
  let state = child.tools.get(fields.toolCallId)
  if (!state) {
    if (!room(row)) return undefined
    state = { id: `tool:${child.acpSessionId}:${fields.toolCallId}`, content: [], locations: [], awaiting: 0 }
    child.tools.set(fields.toolCallId, state)
  }
  mergeTool(state, fields, at)
  upsertStep(row, toolMessage(state))
  return state
}

export function upsertStep(row: Message, step: Message): void {
  const steps = row.subagent!.steps
  const index = steps.findIndex(item => item.id === step.id)
  if (index >= 0) steps[index] = step
  else if (room(row)) steps.push(step)
}

function room(row: Message): boolean {
  if (row.subagent!.steps.length < MAX_STEPS) return true
  row.subagent!.truncated = true
  return false
}

function label(value: string | null | undefined, redact: (text: string) => string, limit = 120): string | undefined {
  const text = value?.replace(/\s+/gu, ' ').trim()
  return text ? clip(redact(text), limit) : undefined
}
