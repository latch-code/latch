// What the gateway reads of a service's reply while it passes the reply on: the model the service says answered and the
// tokens it reports. Only those fields are kept; the reply's text never is. A streamed reply is read one line at a time
// and only the events that carry them are held, so a long reply is never held whole.
import type { ModelWire, TokenUsage } from '@latch/protocol'
import { AnthropicUsage } from './plugins/providers/anthropic-wire.ts'
import { chatUsage } from './plugins/providers/chat-wire.ts'
import { responsesUsage } from './plugins/providers/responses-wire.ts'

export interface ReplyFacts {
  /** The model the reply says answered. */
  model?: string
  usage?: TokenUsage
  /** What the reply's own `usage.cost` says the request cost, as OpenRouter and gateways like it report; never worked out here. */
  cost?: number
  /** The reply said the request failed: an `error` event or object, a Responses `response.failed`. */
  failed?: true
  /**
   * The reply said it is over, whether or not the stream has closed yet: a Responses `response.completed`,
   * `response.incomplete`, `response.failed` or `error` event, a Chat Completions `[DONE]`, an Anthropic `message_stop`,
   * any protocol's error, or a reply that was not streamed.
   */
  ended?: true
}

export interface ReplyReader {
  feed(chunk: Uint8Array): void
  /** What the reply has said so far; a harness may act on it before the stream ends. */
  facts(): ReplyFacts
  end(): ReplyFacts
}

/** A held event or a whole JSON reply larger than this is passed on without being read. */
const MAX_HELD_BYTES = 4 * 1024 * 1024
/** The Responses events that carry the response object, its model and usage with it, or a failure. */
const RESPONSE_EVENTS = new Set([
  'response.created',
  'response.in_progress',
  'response.completed',
  'response.incomplete',
  'response.failed',
])
/** Named events whose data is read: Responses' and Anthropic's that carry the model, usage, the end or a failure. */
const HELD_EVENTS = new Set([...RESPONSE_EVENTS, 'error', 'message_start', 'message_delta', 'message_stop'])
const FINAL_EVENTS = new Set(['response.completed', 'response.incomplete', 'response.failed', 'error'])
const NEWLINE = 0x0a

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)
/** `usage.cost` when the service reports one as a plain amount. */
function reportedCost(usage: unknown): number | undefined {
  const cost = record(usage)?.cost
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined
}

function parse(data: string): unknown {
  try {
    return JSON.parse(data)
  } catch {
    return undefined
  }
}

/** Facts from one Responses event, or a whole non-streamed response. */
function responsesFacts(facts: ReplyFacts, value: unknown, event?: string): void {
  const parsed = record(value)
  if (!parsed) return
  const type = text(parsed.type) ?? event
  if (type === 'error' || type === 'response.failed') facts.failed = true
  if (type === undefined || FINAL_EVENTS.has(type)) facts.ended = true
  // A streamed event wraps the response; a reply that was not streamed is the response.
  const response = type && RESPONSE_EVENTS.has(type) ? record(parsed.response) : type === undefined ? parsed : undefined
  if (!response) return
  const model = text(response.model)
  if (model) facts.model = model
  const usage = responsesUsage(response.usage)
  if (usage) facts.usage = usage
  const cost = reportedCost(response.usage)
  if (cost !== undefined) facts.cost = cost
  if (response.status === 'failed') facts.failed = true
}

/** Facts from one Chat Completions chunk, or a whole reply: usage comes in the last chunk when the request asked for it. */
function chatFacts(facts: ReplyFacts, value: unknown): void {
  const chunk = record(value)
  if (!chunk) return
  if (chunk.error !== undefined) {
    facts.failed = true
    facts.ended = true
  }
  const model = text(chunk.model)
  if (model) facts.model = model
  const usage = chatUsage(chunk.usage)
  if (usage) facts.usage = usage
  const cost = reportedCost(chunk.usage)
  if (cost !== undefined) facts.cost = cost
}

/** Facts from one Anthropic event, or a whole message; `usage` sums what its `message_start` and `message_delta` said. */
function anthropicFacts(facts: ReplyFacts, usage: AnthropicUsage, value: unknown, event?: string): void {
  const parsed = record(value)
  if (!parsed) return
  const type = text(parsed.type) ?? event
  if (type === 'error') {
    facts.failed = true
    facts.ended = true
    return
  }
  if (type === 'message_stop') facts.ended = true
  // A streamed reply starts with the message; a reply that was not streamed is the message.
  const message = type === 'message_start' ? record(parsed.message) : type === 'message' ? parsed : undefined
  if (type === 'message') facts.ended = true
  const model = text(message?.model)
  if (model) facts.model = model
  if (message) usage.record(message.usage)
  if (type === 'message_delta') usage.record(parsed.usage)
  const total = usage.delta()
  if (total) {
    const { type: _, ...tokens } = total
    facts.usage = tokens
  }
}

/** Server-sent events, line by line: a line is held only while it may belong to an event worth reading. */
class StreamReader implements ReplyReader {
  private readonly read: ReplyFacts = {}
  /** The current line: its length so far, its first byte, and what of it is held. */
  private length = 0
  private first: number | undefined
  private held: Buffer[] = []
  /** The current line is passed over: it belongs to an event not read, or the event outgrew the limit. */
  private skipping = false
  /** The current event outgrew the limit: the rest of it is passed over too. */
  private dropped = false
  private event: string | undefined
  private data: string[] = []
  private heldBytes = 0
  private readonly anthropic = new AnthropicUsage()

  constructor(private readonly wire: ModelWire) {}

  feed(chunk: Uint8Array): void {
    let start = 0
    while (start < chunk.length) {
      const newline = chunk.indexOf(NEWLINE, start)
      const stop = newline < 0 ? chunk.length : newline
      if (stop > start) {
        if (this.length === 0) {
          this.first = chunk[start]
          // Responses and Anthropic name their events; the data of one Latch does not read is never held.
          this.skipping = this.dropped || (this.event !== undefined && !HELD_EVENTS.has(this.event))
        }
        this.length += stop - start
        if (!this.skipping) {
          this.heldBytes += stop - start
          if (this.heldBytes > MAX_HELD_BYTES) this.drop()
          else this.held.push(Buffer.from(chunk.subarray(start, stop)))
        }
      }
      if (newline < 0) return
      this.endLine()
      start = newline + 1
    }
  }

  facts(): ReplyFacts {
    return this.read
  }

  end(): ReplyFacts {
    if (this.length > 0) this.endLine()
    this.dispatch()
    return this.read
  }

  /** Gives up on the current event: its fields go unread, the reply is still passed on. */
  private drop(): void {
    this.skipping = true
    this.dropped = true
    this.held = []
    this.data = []
    this.heldBytes = 0
  }

  private endLine(): void {
    const blank = this.length === 0 || (this.length === 1 && this.first === 0x0d)
    const line = this.skipping || blank ? undefined : Buffer.concat(this.held).toString('utf8').replace(/\r$/u, '')
    this.length = 0
    this.first = undefined
    this.held = []
    this.skipping = false
    // A blank line ends the event; a line passed over leaves it open until then.
    if (blank) {
      this.dispatch()
      return
    }
    if (line === undefined) return
    if (line.startsWith('event:')) this.event = line.slice(6).trim()
    else if (line === 'data' || line.startsWith('data:')) this.data.push(line.slice(5).replace(/^ /u, ''))
  }

  private dispatch(): void {
    const data = this.data.join('\n')
    const event = this.event
    this.data = []
    this.heldBytes = 0
    this.dropped = false
    this.event = undefined
    if (!data) return
    if (this.wire === 'chat-completions') {
      if (data === '[DONE]') this.read.ended = true
      // Every chunk names the model: only the first is parsed for it, then only one that may report usage or fail.
      else if (['"usage"', '"error"'].some(key => data.includes(key)) || (!this.read.model && data.includes('"model"')))
        chatFacts(this.read, parse(data))
    } else if (this.wire === 'anthropic-messages') {
      if (event !== undefined || data.includes('"error"')) anthropicFacts(this.read, this.anthropic, parse(data), event)
    } else if (event !== undefined || data.includes('"response"') || data.includes('"error"')) {
      responsesFacts(this.read, parse(data), event)
    }
  }
}

/** A reply that is one JSON document, read once it has all arrived, when it is not too large to hold. */
class DocumentReader implements ReplyReader {
  private chunks: Buffer[] = []
  private bytes = 0

  constructor(private readonly wire: ModelWire) {}

  /** Nothing until it has all arrived: a document is read whole. */
  facts(): ReplyFacts {
    return {}
  }

  feed(chunk: Uint8Array): void {
    if (this.bytes > MAX_HELD_BYTES) return
    this.bytes += chunk.length
    if (this.bytes > MAX_HELD_BYTES) this.chunks = []
    else this.chunks.push(Buffer.from(chunk))
  }

  end(): ReplyFacts {
    const facts: ReplyFacts = {}
    if (this.bytes > MAX_HELD_BYTES) return facts
    const value = parse(Buffer.concat(this.chunks).toString('utf8'))
    this.chunks = []
    if (this.wire === 'chat-completions') {
      chatFacts(facts, value)
      facts.ended = true
    } else if (this.wire === 'anthropic-messages') {
      anthropicFacts(facts, new AnthropicUsage(), value)
      facts.ended = true
    } else responsesFacts(facts, value)
    return facts
  }
}

/** A reader for a successful reply of `wire`, by how the service sent it. */
export function replyReader(wire: ModelWire, contentType: string | null): ReplyReader {
  return /text\/event-stream/iu.test(contentType ?? '') ? new StreamReader(wire) : new DocumentReader(wire)
}
