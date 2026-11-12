/**
 * Bringing in an agent's own earlier session (docs/HARNESSES.md#接入已有会话): the replay of one `session/load`, kept as
 * messages within a bound, and what of it a Latch session takes as its history. Nothing here reads an agent's files.
 */
import { randomUUID } from 'node:crypto'
import type { Message } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { append, blockText, mergeTool, settleTool, toolMessage, type ToolState } from './mapping.ts'
import { chunkUpdate, toolFields } from './protocol.ts'

/** The replay kept in memory while it is previewed: the newest messages within these, the older ones only counted. */
export const CAPTURE_BYTES = 8 * 1024 * 1024
export const CAPTURE_MESSAGES = 5_000
/** What an adopted session keeps as its history. */
export const ADOPT_BYTES = 4 * 1024 * 1024
export const ADOPT_MESSAGES = 500
/** One listing: at most this many sessions, within this time. */
export const LIST_MAX = 500
export const LIST_MS = 20_000
/** One load and its replay. */
export const LOAD_MS = 60_000

/**
 * The agent's words when it will not open a session another process holds (Codex's writer lock). Inferred from the
 * adapters' sources; nothing in ACP names this case.
 */
const BUSY = /\b(?:lock(?:ed)?|in use|busy|already (?:open|opened|loaded|running|active|attached))\b/iu

interface Entry {
  message: Message
  size: number
  /** The agent's message ID, so that chunks of one message stay one message. */
  acpMessageId?: string
  tool?: ToolState
}

/** The replay of one `session/load` as it arrives. */
export interface Capture {
  acpSessionId: string
  entries: Entry[]
  tools: Map<string, Entry>
  bytes: number
  dropped: number
  turns: number
}

export function newCapture(acpSessionId: string): Capture {
  return { acpSessionId, entries: [], tools: new Map(), bytes: 0, dropped: 0, turns: 0 }
}

function sizeOf(message: Message): number {
  const diffs = (message.tool?.diffs ?? []).reduce((total, diff) => total + diff.newText.length + (diff.oldText?.length ?? 0), 0)
  return (
    message.text.length
    + (message.tool?.output?.length ?? 0)
    + (message.tool?.input?.length ?? 0)
    + (message.reasoning?.length ?? 0)
    + diffs
  )
}

function measure(capture: Capture, entry: Entry): void {
  const size = sizeOf(entry.message)
  capture.bytes += size - entry.size
  entry.size = size
  while (capture.entries.length > 1 && (capture.bytes > CAPTURE_BYTES || capture.entries.length > CAPTURE_MESSAGES)) {
    const oldest = capture.entries.shift()!
    capture.bytes -= oldest.size
    capture.dropped++
    for (const [id, tool] of capture.tools) if (tool === oldest) capture.tools.delete(id)
  }
}

/**
 * One update of the replay. User and agent text, and tool calls with their output passed through `redact`; thinking is
 * not kept, since neither a preview nor a text rebuild shows it and the agent keeps its own. The text stays in memory
 * as it came until `captured` redacts each whole message.
 */
export function captureUpdate(capture: Capture, update: { sessionUpdate: string }, at: string, redact: (text: string) => string): void {
  switch (update.sessionUpdate) {
    case 'user_message_chunk':
    case 'agent_message_chunk': {
      const parsed = chunkUpdate.safeParse(update)
      if (!parsed.success) return
      const role = update.sessionUpdate === 'user_message_chunk' ? 'user' : 'assistant'
      // Redacted once joined (`captured`): a key may arrive split across chunks.
      const piece = blockText(parsed.data.content)
      const acpMessageId = parsed.data.messageId ?? undefined
      const last = capture.entries.at(-1)
      if (last && last.message.role === role && !last.tool && (acpMessageId === undefined || last.acpMessageId === acpMessageId)) {
        last.message.text = append(last.message.text, piece)
        measure(capture, last)
        return
      }
      if (role === 'user') capture.turns++
      const entry: Entry = {
        message: {
          id: randomUUID(),
          role,
          text: piece,
          imported: true,
          ...(role === 'assistant' ? { state: 'completed' } : {}),
          createdAt: at,
        },
        size: 0,
        ...(acpMessageId !== undefined ? { acpMessageId } : {}),
      }
      capture.entries.push(entry)
      measure(capture, entry)
      return
    }
    case 'tool_call':
    case 'tool_call_update': {
      const parsed = toolFields.safeParse(update)
      if (!parsed.success) return
      const id = parsed.data.toolCallId
      let entry = capture.tools.get(id)
      if (!entry) {
        const state: ToolState = { id: `tool:0:${id}`, content: [], locations: [], awaiting: 0 }
        entry = { message: toolMessage(state), size: 0, tool: state }
        capture.tools.set(id, entry)
        capture.entries.push(entry)
      }
      mergeTool(entry.tool!, parsed.data, at)
      entry.message = { ...redactedTool(toolMessage(entry.tool!), redact), imported: true }
      measure(capture, entry)
      return
    }
    default:
      return
  }
}

function redactedTool(message: Message, redact: (text: string) => string): Message {
  const tool = message.tool && {
    ...message.tool,
    ...(message.tool.title !== undefined ? { title: redact(message.tool.title) } : {}),
    ...(message.tool.input !== undefined ? { input: redact(message.tool.input) } : {}),
    ...(message.tool.output !== undefined ? { output: redact(message.tool.output) } : {}),
    ...(message.tool.diffs
      ? {
          diffs: message.tool.diffs.map(diff => ({
            ...diff,
            newText: redact(diff.newText),
            ...(diff.oldText !== undefined ? { oldText: redact(diff.oldText) } : {}),
          })),
        }
      : {}),
  }
  return {
    ...message,
    text: redact(message.text),
    ...(message.toolName ? { toolName: redact(message.toolName) } : {}),
    ...(tool ? { tool } : {}),
  }
}

/** The replay once the load answered: a call it never reported finished is not running in Latch. */
export function captured(
  capture: Capture,
  at: string,
  redact: (text: string) => string,
): { messages: Message[]; droppedBefore: number; turns: number } {
  for (const entry of capture.entries) {
    if (entry.tool && settleTool(entry.tool, at)) entry.message = { ...redactedTool(toolMessage(entry.tool), redact), imported: true }
    else if (!entry.tool) entry.message.text = redact(entry.message.text)
  }
  return { messages: capture.entries.map(entry => structuredClone(entry.message)), droppedBefore: capture.dropped, turns: capture.turns }
}

/** The newest messages a session keeps as its history, and how many before them it leaves to the agent's own record. */
export function adoptedMessages(messages: readonly Message[], droppedBefore: number): { messages: Message[]; droppedBefore: number } {
  const kept: Message[] = []
  let bytes = 0
  for (let index = messages.length - 1; index >= 0 && kept.length < ADOPT_MESSAGES; index--) {
    const size = sizeOf(messages[index]!)
    if (kept.length && bytes + size > ADOPT_BYTES) break
    bytes += size
    kept.unshift(structuredClone(messages[index]!))
  }
  return { messages: kept, droppedBefore: droppedBefore + messages.length - kept.length }
}

export function historyNotSupported(name: string): AppError {
  return new AppError(409, 'history-not-supported', `${name} 不能列出已有会话。`)
}

export function isBusy(message: string): boolean {
  return BUSY.test(message)
}

export function sessionBusy(name: string): AppError {
  return new AppError(409, 'history-session-busy', `这个会话正在别处打开（例如终端里的 ${name}）。先在那里退出再接入。`)
}
