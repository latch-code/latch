import { z } from 'zod'
import { responseError } from '../errors.ts'
import { sseData } from '../../plugins/providers/http.ts'
import { invalidReply, object, type GatewayDelta, type GatewayUsage } from '../ir.ts'

const MAX_TEXT = 1024 * 1024
const text = z.string().max(MAX_TEXT)
const id = z.string().min(1).max(1024)
const status = z.enum(['in_progress', 'completed', 'incomplete']).optional()
const part = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('output_text'),
    text,
    annotations: z.array(z.unknown()).optional(),
    logprobs: z.array(z.unknown()).optional(),
  }),
  z.object({ type: z.literal('refusal'), refusal: text }),
])
const itemSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), id, role: z.literal('assistant'), status, content: z.array(part).max(128) }),
  z.object({ type: z.literal('function_call'), id, call_id: id, name: z.string().min(1).max(64), arguments: text, status }),
  z
    .object({
      type: z.literal('reasoning'),
      id,
      status,
      summary: z.array(z.object({ type: z.literal('summary_text'), text }).strict()).max(128),
      content: z
        .array(z.object({ type: z.literal('reasoning_text'), text }).strict())
        .max(128)
        .optional(),
      encrypted_content: z
        .string()
        .max(4 * MAX_TEXT)
        .nullish(),
    })
    .strict(),
])
type Item = z.infer<typeof itemSchema>
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const usageSchema = z.object({
  input_tokens: count,
  output_tokens: count,
  total_tokens: count.optional(),
  input_tokens_details: z.object({ cached_tokens: count.optional() }).nullish(),
  output_tokens_details: z.object({ reasoning_tokens: count.optional() }).nullish(),
})

function itemOf(value: unknown): Item {
  const raw = object(value)
  // We offered only direct local function tools; never reinterpret a hosted or namespaced execution as one.
  if (raw?.namespace != null || raw?.async === true || (raw?.caller != null && object(raw.caller)?.type !== 'direct'))
    throw invalidReply('Responses 返回了未请求的工具执行方式')
  const parsed = itemSchema.safeParse(value)
  if (!parsed.success) throw invalidReply('Responses 输出项不能完整转换')
  return parsed.data
}

function usageOf(value: unknown): GatewayUsage {
  const parsed = usageSchema.safeParse(value)
  if (!parsed.success) throw invalidReply('Responses 未报告完整有效的用量')
  const usage = parsed.data,
    cacheRead = usage.input_tokens_details?.cached_tokens,
    reasoning = usage.output_tokens_details?.reasoning_tokens
  const total = usage.input_tokens + usage.output_tokens
  if (
    !Number.isSafeInteger(total)
    || (usage.total_tokens !== undefined && usage.total_tokens !== total)
    || (cacheRead !== undefined && cacheRead > usage.input_tokens)
    || (reasoning !== undefined && reasoning > usage.output_tokens)
  )
    throw invalidReply('Responses 用量字段前后不一致')
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
  }
}

type PartKind = 'text' | 'refusal' | 'summary' | 'reasoning'
type Seen = {
  id: string
  type: Item['type']
  name?: string
  callId?: string
  parts: Map<string, { kind: PartKind; text: string; closed: boolean }>
  arguments: string
  argumentsDone: boolean
  done?: Item
  released: boolean
  queue: GatewayDelta[]
}
const indexOf = (value: unknown, max = 1024): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= max) throw invalidReply('Responses 流索引无效')
  return value
}
const stringOf = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > MAX_TEXT) throw invalidReply('Responses 流文字字段无效')
  return value
}
const partKey = (kind: PartKind, index: number) => `${kind === 'summary' ? 's' : kind === 'reasoning' ? 'r' : 'm'}:${index}`

/** Text can stream; native reasoning waits for its opaque state, and calls wait for the final response and usage. */
class ResponsesDecoder {
  private readonly items: Seen[] = []
  private readonly ids = new Set<string>()
  private next = 0
  private bytes = 0
  private responseId?: string
  private sequence = -1
  ended = false

  private added(value: unknown, index: number): Seen {
    const raw = object(value)
    if (
      index !== this.items.length
      || !raw
      || !id.safeParse(raw.id).success
      || this.ids.has(String(raw.id))
      || !['message', 'reasoning', 'function_call'].includes(String(raw.type))
    )
      throw invalidReply('Responses 输出项身份或顺序无效')
    if (raw.type === 'function_call' && (!id.safeParse(raw.call_id).success || !z.string().min(1).max(64).safeParse(raw.name).success))
      throw invalidReply('Responses 工具调用没有完整身份')
    const item: Seen = {
      id: raw.id as string,
      type: raw.type as Item['type'],
      ...(raw.type === 'function_call' ? { name: raw.name as string, callId: raw.call_id as string } : {}),
      parts: new Map(),
      arguments: '',
      argumentsDone: false,
      released: false,
      queue: [],
    }
    this.items.push(item)
    this.ids.add(item.id)
    return item
  }

  private seen(event: Record<string, unknown>): Seen {
    const item = this.items[indexOf(event.output_index)]
    if (!item || event.item_id !== item.id || item.done) throw invalidReply('Responses 流引用了未知或已结束的输出项')
    return item
  }

  private account(size: number) {
    this.bytes += size
    if (this.bytes > 8 * MAX_TEXT) throw invalidReply('Responses 回复超出转换大小限制')
  }

  private updatePart(item: Seen, kind: PartKind, index: number, value: string, complete: boolean) {
    if ((kind === 'summary' || kind === 'reasoning') !== (item.type === 'reasoning') || item.type === 'function_call')
      throw invalidReply('Responses 内容块与输出项类型不一致')
    const key = partKey(kind, index)
    const current = item.parts.get(key) ?? { kind, text: '', closed: false }
    if (current.kind !== kind || (!complete && current.closed) || (complete && !value.startsWith(current.text)))
      throw invalidReply('Responses 流文字与最终内容不一致')
    const extra = complete ? value.slice(current.text.length) : value
    if (kind === 'text' || kind === 'refusal') {
      const prior = [...item.parts].filter(([key]) => key.startsWith('m:'))
      if (
        (!item.parts.has(key) && (index !== prior.length || (index > 0 && !item.parts.get(`m:${index - 1}`)?.closed)))
        || (extra.length && index < prior.length - 1)
      )
        throw invalidReply('Responses 消息内容块顺序无效')
    }
    this.account(extra.length)
    current.text += extra
    if (current.text.length > MAX_TEXT) throw invalidReply('Responses 内容块过大')
    current.closed ||= complete
    item.parts.set(key, current)
    if (extra && (kind === 'text' || kind === 'refusal')) item.queue.push({ type: kind, text: extra })
  }

  private finishItem(value: unknown, index: number, final: boolean, incomplete: boolean) {
    const output = itemOf(value)
    const item = this.items[index] ?? (final ? this.added(value, index) : undefined)
    if (!item || item.id !== output.id || item.type !== output.type) throw invalidReply('Responses 输出项身份发生变化')
    if (output.status === 'in_progress' || (!incomplete && output.status === 'incomplete'))
      throw invalidReply('Responses 输出项尚未完整结束')
    if (item.done) {
      const prior = { ...item.done },
        next = { ...output }
      // Some services attach native ciphertext only to the final response, after output_item.done.
      if (prior.type === 'reasoning' && next.type === 'reasoning' && !prior.encrypted_content) {
        delete prior.encrypted_content
        delete next.encrypted_content
      }
      if (prior.status === undefined) delete next.status
      if (JSON.stringify(prior) !== JSON.stringify(next)) throw invalidReply('Responses 最终输出与已结束的输出项不一致')
    }
    if (output.type === 'function_call') {
      if (
        output.call_id !== item.callId
        || output.name !== item.name
        || !output.arguments.startsWith(item.arguments)
        || (item.argumentsDone && output.arguments !== item.arguments)
      )
        throw invalidReply('Responses 工具调用内容前后不一致')
      this.account(output.arguments.length - item.arguments.length)
      item.arguments = output.arguments
      item.argumentsDone = true
      if (!item.released) item.queue.push({ type: 'tool', index, id: output.call_id, name: output.name, arguments: output.arguments })
      item.released = true
    } else {
      const expected = new Set<string>()
      const parts =
        output.type === 'message'
          ? output.content.map((part, index) => ({
              kind: part.type === 'refusal' ? ('refusal' as const) : ('text' as const),
              index,
              text: part.type === 'refusal' ? part.refusal : part.text,
            }))
          : [
              ...output.summary.map((part, index) => ({ kind: 'summary' as const, index, text: part.text })),
              ...(output.content ?? []).map((part, index) => ({ kind: 'reasoning' as const, index, text: part.text })),
            ]
      for (const part of parts) {
        expected.add(partKey(part.kind, part.index))
        this.updatePart(item, part.kind, part.index, part.text, true)
      }
      if ([...item.parts.keys()].some(key => !expected.has(key))) throw invalidReply('Responses 最终输出缺少已经报告的内容块')
      if (output.type === 'message') {
        if (output.content.some(part => part.type === 'output_text' && part.annotations?.length))
          item.queue.push({ type: 'loss', loss: 'annotations' })
        if (output.content.some(part => part.type === 'output_text' && part.logprobs?.length))
          item.queue.push({ type: 'loss', loss: 'logprobs' })
        item.released = true
      } else if (!item.released && output.encrypted_content) {
        this.account(output.encrypted_content.length)
        item.queue.push({
          type: 'reasoning-state',
          state: {
            wire: 'responses',
            item: {
              type: 'reasoning',
              id: output.id,
              summary: output.summary,
              encrypted_content: output.encrypted_content,
              ...(output.content ? { content: output.content } : {}),
              ...(output.status === 'completed' || output.status === 'incomplete' ? { status: output.status } : {}),
            },
          },
        })
        item.released = true
      } else if (final && !item.released) {
        if (!incomplete) throw invalidReply('Responses 缺少原生思考回放状态')
        item.queue.push({ type: 'loss', loss: 'reasoning-state' })
        item.released = true
      }
    }
    item.done = output
  }

  private drain(): GatewayDelta[] {
    const output: GatewayDelta[] = []
    while (this.next < this.items.length) {
      const item = this.items[this.next]!
      output.push(...item.queue.splice(0))
      if (!item.done || !item.released) break
      this.next++
    }
    return output
  }

  complete(value: unknown): GatewayDelta[] {
    const body = object(value)
    if (!body || !id.safeParse(body.id).success || (this.responseId && body.id !== this.responseId))
      throw invalidReply('Responses 回复身份无效')
    if (body.error != null || body.status === 'failed') throw responseError(body.error)
    const incomplete = body.status === 'incomplete'
    if (body.status !== 'completed' && !incomplete) throw invalidReply('Responses 回复未正常结束')
    const reason = object(body.incomplete_details)?.reason
    if (incomplete && reason !== 'max_output_tokens' && reason !== 'content_filter')
      throw invalidReply('Responses 未说明可转换的不完整状态')
    if (!Array.isArray(body.output) || body.output.length > 1024 || body.output.length < this.items.length)
      throw invalidReply('Responses 最终输出列表无效')
    const usage = usageOf(body.usage)
    for (const [index, item] of body.output.entries()) this.finishItem(item, index, true, incomplete)
    this.ended = true
    return [
      ...this.drain(),
      { type: 'usage', usage },
      {
        type: 'finish',
        reason: incomplete
          ? reason === 'max_output_tokens'
            ? 'length'
            : 'filter'
          : this.items.some(item => item.type === 'function_call')
            ? 'tools'
            : 'stop',
      },
    ]
  }

  event(value: unknown): GatewayDelta[] {
    const event = object(value)
    if (!event || typeof event.type !== 'string' || this.ended) throw invalidReply('Responses 流事件无效或在完成后继续发送')
    if (event.sequence_number !== undefined) {
      const sequence = indexOf(event.sequence_number, Number.MAX_SAFE_INTEGER)
      if (sequence <= this.sequence) throw invalidReply('Responses 流事件顺序倒退')
      this.sequence = sequence
    }
    const type = event.type
    if (type === 'error' || type === 'response.failed') throw responseError(event.error ?? object(event.response)?.error ?? event)
    if (type === 'response.created' || type === 'response.in_progress' || type === 'response.queued') {
      const body = object(event.response)
      if (!body || !id.safeParse(body.id).success || (this.responseId && this.responseId !== body.id))
        throw invalidReply('Responses 流回复身份发生变化')
      this.responseId = body.id as string
      return []
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      if (object(event.response)?.status !== type.slice('response.'.length)) throw invalidReply('Responses 最终事件与状态不一致')
      return this.complete(event.response)
    }
    if (type === 'response.output_item.added') this.added(event.item, indexOf(event.output_index))
    else if (type === 'response.output_item.done') this.finishItem(event.item, indexOf(event.output_index), false, true)
    else {
      const item = this.seen(event)
      if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
        if (item.type !== 'function_call' || item.argumentsDone) throw invalidReply('Responses 工具参数流顺序无效')
        const complete = type.endsWith('.done'),
          value = stringOf(complete ? event.arguments : event.delta)
        if (complete && !value.startsWith(item.arguments)) throw invalidReply('Responses 工具参数与流不一致')
        const extra = complete ? value.slice(item.arguments.length) : value
        this.account(extra.length)
        item.arguments += extra
        item.argumentsDone = complete
        if (item.arguments.length > MAX_TEXT) throw invalidReply('Responses 工具参数过大')
      } else if (/^response\.(output_text|refusal|reasoning_summary_text|reasoning_text)\.(delta|done)$/u.test(type)) {
        const kind: PartKind = type.includes('reasoning_summary')
          ? 'summary'
          : type.includes('reasoning_text')
            ? 'reasoning'
            : type.includes('refusal')
              ? 'refusal'
              : 'text'
        this.updatePart(
          item,
          kind,
          indexOf(kind === 'summary' ? event.summary_index : event.content_index, 128),
          stringOf(type.endsWith('.delta') ? event.delta : kind === 'refusal' ? event.refusal : event.text),
          type.endsWith('.done'),
        )
      } else if (/^response\.(content_part|reasoning_summary_part)\.(added|done)$/u.test(type)) {
        const part = object(event.part)
        const kind: PartKind | undefined =
          part?.type === 'output_text'
            ? 'text'
            : part?.type === 'refusal'
              ? 'refusal'
              : part?.type === 'summary_text'
                ? 'summary'
                : part?.type === 'reasoning_text'
                  ? 'reasoning'
                  : undefined
        if (!kind) throw invalidReply('Responses 内容块类型不能转换')
        this.updatePart(
          item,
          kind,
          indexOf(kind === 'summary' ? event.summary_index : event.content_index, 128),
          stringOf(kind === 'refusal' ? part?.refusal : part?.text),
          type.endsWith('.done'),
        )
      } else if (type === 'response.output_text.annotation.added') item.queue.push({ type: 'loss', loss: 'annotations' })
      else throw invalidReply('Responses 返回了尚不能转换的事件')
    }
    return this.drain()
  }
}

export function decodeResponsesReply(value: unknown): GatewayDelta[] {
  return new ResponsesDecoder().complete(value)
}

export async function* decodeResponsesStream(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<GatewayDelta> {
  const decoder = new ResponsesDecoder()
  let bytes = 0
  for await (const payload of sseData(body, signal)) {
    signal.throwIfAborted()
    bytes += payload.length
    if (bytes > 64 * MAX_TEXT) throw invalidReply('Responses 事件流过大')
    let value: unknown
    try {
      value = JSON.parse(payload)
    } catch {
      throw invalidReply('Responses 事件不是有效 JSON')
    }
    for (const delta of decoder.event(value)) yield delta
    if (decoder.ended) return
  }
  signal.throwIfAborted()
  if (!decoder.ended) throw invalidReply('Responses 流在完成前断开')
}
