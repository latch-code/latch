import { z } from 'zod'
import { sseData } from '../../plugins/providers/http.ts'
import { responseError } from '../errors.ts'
import { exactJson } from '../json.ts'
import { invalidReply, object, type GatewayDelta, type GatewayUsage } from '../ir.ts'

const MAX_TEXT = 1024 * 1024
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const usageSchema = z.object({
  input_tokens: count,
  output_tokens: count,
  cache_read_input_tokens: count.optional(),
  cache_creation_input_tokens: count.optional(),
})
type Usage = z.infer<typeof usageSchema>
type Finish = Extract<GatewayDelta, { type: 'finish' }>['reason']
type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; arguments: string; streamed: boolean; index: number }

function text(value: unknown, maximum = MAX_TEXT, nonempty = false): string {
  if (typeof value !== 'string' || value.length > maximum || (nonempty && !value.length)) throw invalidReply('Anthropic 内容字段无效或过大')
  return value
}

function finishOf(value: unknown): Finish {
  if (value === 'end_turn' || value === 'stop_sequence') return 'stop'
  if (value === 'tool_use') return 'tools'
  if (value === 'max_tokens' || value === 'model_context_window_exceeded') return 'length'
  if (value === 'refusal') return 'filter'
  throw invalidReply('Anthropic 报告了尚不能转换的结束状态')
}

/** Signed thinking waits for its complete signature. Executable calls stay pending in the shared output until message_stop. */
class AnthropicDecoder {
  private started = false
  private index = -1
  private active?: Block
  private calls = 0
  private bytes = 0
  private usage?: Usage
  private finalUsage = false
  private stop?: Finish
  private missingThought = false
  ended = false

  private account(size: number) {
    this.bytes += size
    if (this.bytes > 8 * MAX_TEXT) throw invalidReply('Anthropic 回复超出转换大小限制')
  }

  private begin(input: unknown, exact: unknown): GatewayDelta[] {
    const raw = object(input)
    if (!raw || raw.namespace != null || (raw.caller != null && object(raw.caller)?.type !== 'direct'))
      throw invalidReply('Anthropic 返回了未请求的工具执行方式')
    if (raw.type === 'text') {
      const value = text(raw.text)
      this.active = { type: 'text', text: value }
      this.account(value.length)
      return [
        ...(value ? [{ type: 'text' as const, text: value }] : []),
        ...(Array.isArray(raw.citations) && raw.citations.length ? [{ type: 'loss' as const, loss: 'annotations' as const }] : []),
      ]
    }
    if (raw.type === 'thinking') {
      if (Object.keys(raw).some(key => !['type', 'thinking', 'signature'].includes(key)))
        throw invalidReply('Anthropic 思考块包含尚不能完整回放的字段')
      this.active = { type: 'thinking', thinking: text(raw.thinking), signature: text(raw.signature ?? '', 4 * MAX_TEXT) }
      this.account(this.active.thinking.length + this.active.signature.length)
    } else if (raw.type === 'redacted_thinking') {
      if (Object.keys(raw).some(key => !['type', 'data'].includes(key))) throw invalidReply('Anthropic 思考块包含尚不能完整回放的字段')
      this.active = { type: 'redacted_thinking', data: text(raw.data, 4 * MAX_TEXT, true) }
      this.account(this.active.data.length)
    } else if (raw.type === 'tool_use') {
      if (!object(raw.input) || this.calls >= 128) throw invalidReply('Anthropic 工具参数无效或工具过多')
      const args = JSON.stringify(object(exact)?.input ?? raw.input)
      this.active = {
        type: 'tool_use',
        id: text(raw.id, 1024, true),
        name: text(raw.name, 64, true),
        arguments: args,
        streamed: false,
        index: this.calls++,
      }
      this.account(args.length + this.active.id.length + this.active.name.length)
    } else throw invalidReply('Anthropic 返回了尚不能转换的内容块')
    return []
  }

  private delta(input: unknown): GatewayDelta[] {
    const delta = object(input),
      block = this.active
    if (!delta || !block) throw invalidReply('Anthropic 内容增量没有对应的内容块')
    if (block.type === 'text' && delta.type === 'text_delta') {
      const value = text(delta.text)
      block.text += value
      this.account(value.length)
      if (block.text.length > MAX_TEXT) throw invalidReply('Anthropic 文字内容过大')
      return value ? [{ type: 'text', text: value }] : []
    }
    if (block.type === 'text' && delta.type === 'citations_delta') return [{ type: 'loss', loss: 'annotations' }]
    if (block.type === 'thinking' && delta.type === 'thinking_delta') {
      if (block.signature) throw invalidReply('Anthropic 在签名之后继续修改思考')
      const value = text(delta.thinking)
      block.thinking += value
      this.account(value.length)
      if (block.thinking.length > MAX_TEXT) throw invalidReply('Anthropic 思考内容过大')
    } else if (block.type === 'thinking' && delta.type === 'signature_delta') {
      const value = text(delta.signature, 4 * MAX_TEXT)
      block.signature += value
      this.account(value.length)
      if (block.signature.length > 4 * MAX_TEXT) throw invalidReply('Anthropic 思考签名过大')
    } else if (block.type === 'tool_use' && delta.type === 'input_json_delta') {
      if (!block.streamed) {
        if (block.arguments !== '{}') throw invalidReply('Anthropic 同时返回了完整参数和参数增量')
        block.arguments = ''
        block.streamed = true
      }
      const value = text(delta.partial_json)
      block.arguments += value
      this.account(value.length)
      if (block.arguments.length > MAX_TEXT) throw invalidReply('Anthropic 工具参数过大')
    } else throw invalidReply('Anthropic 增量与内容块类型不一致')
    return []
  }

  private endBlock(): GatewayDelta[] {
    const block = this.active
    if (!block) throw invalidReply('Anthropic 内容块没有开始或已经结束')
    this.active = undefined
    if (block.type === 'text') return [{ type: 'text-end' }]
    if (block.type === 'tool_use') return [{ type: 'tool', index: block.index, id: block.id, name: block.name, arguments: block.arguments }]
    if (block.type === 'thinking' && !block.signature) {
      this.missingThought = true
      return [{ type: 'loss', loss: 'reasoning-state' }]
    }
    return [{ type: 'reasoning-state', state: { wire: 'anthropic-messages', block } }]
  }

  private complete(): GatewayDelta[] {
    if (this.active || !this.stop || !this.usage || !this.finalUsage) throw invalidReply('Anthropic 没有完整结束或未报告最终用量')
    if (this.missingThought && this.stop !== 'length' && this.stop !== 'filter') throw invalidReply('Anthropic 缺少原生思考签名')
    const input = this.usage.input_tokens + (this.usage.cache_read_input_tokens ?? 0) + (this.usage.cache_creation_input_tokens ?? 0)
    if (!Number.isSafeInteger(input) || !Number.isSafeInteger(input + this.usage.output_tokens))
      throw invalidReply('Anthropic 用量超出整数范围')
    const usage: GatewayUsage = {
      input,
      output: this.usage.output_tokens,
      ...(this.usage.cache_read_input_tokens !== undefined ? { cacheRead: this.usage.cache_read_input_tokens } : {}),
      ...(this.usage.cache_creation_input_tokens !== undefined ? { cacheWrite: this.usage.cache_creation_input_tokens } : {}),
    }
    this.ended = true
    return [
      { type: 'usage', usage },
      { type: 'finish', reason: this.stop },
    ]
  }

  event(value: unknown, exact?: unknown): GatewayDelta[] {
    const event = object(value)
    if (!event || typeof event.type !== 'string' || this.ended) throw invalidReply('Anthropic 流事件格式或顺序无效')
    if (event.type === 'error') throw responseError(event.error)
    if (event.type === 'ping') return []
    if (event.type === 'message_start') {
      const message = object(event.message)
      if (
        this.started
        || !message
        || message.type !== 'message'
        || message.role !== 'assistant'
        || !Array.isArray(message.content)
        || message.content.length
        || message.stop_reason != null
        || message.container != null
        || message.context_management != null
      )
        throw invalidReply('Anthropic 消息开始状态无效')
      text(message.id, 1024, true)
      const usage = usageSchema.safeParse(message.usage)
      if (!usage.success) throw invalidReply('Anthropic 缺少有效的初始用量')
      this.usage = usage.data
      this.started = true
      return []
    }
    if (!this.started) throw invalidReply('Anthropic 内容出现在消息开始之前')
    if (event.type === 'message_stop') return this.complete()
    if (event.type === 'message_delta') {
      if (this.active) throw invalidReply('Anthropic 消息结束时内容块仍未完成')
      const delta = object(event.delta)
      if (!delta || delta.container != null || delta.context_management != null) throw invalidReply('Anthropic 消息增量无效')
      if (delta.stop_reason != null) {
        const stop = finishOf(delta.stop_reason)
        if (this.stop && this.stop !== stop) throw invalidReply('Anthropic 结束状态前后不一致')
        this.stop = stop
      }
      const next = usageSchema.partial().extend({ output_tokens: count }).safeParse(event.usage)
      if (!next.success) throw invalidReply('Anthropic 缺少有效的最终用量')
      for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const)
        if (next.data[key] !== undefined && this.usage?.[key] !== undefined && next.data[key] < this.usage[key])
          throw invalidReply('Anthropic 累计用量发生倒退')
      this.usage = { ...this.usage!, ...next.data }
      this.finalUsage = true
      return []
    }
    if (this.stop || !Number.isSafeInteger(event.index) || typeof event.index !== 'number' || event.index < 0 || event.index >= 1024)
      throw invalidReply('Anthropic 内容索引或顺序无效')
    if (event.type === 'content_block_start') {
      if (this.active || event.index !== this.index + 1) throw invalidReply('Anthropic 内容块顺序无效')
      this.index = event.index
      return this.begin(event.content_block, object(exact)?.content_block)
    }
    if (event.index !== this.index) throw invalidReply('Anthropic 增量引用了其他内容块')
    if (event.type === 'content_block_delta') return this.delta(event.delta)
    if (event.type === 'content_block_stop') return this.endBlock()
    throw invalidReply('Anthropic 返回了尚不能转换的事件')
  }
}

export function decodeAnthropicReply(source: string): GatewayDelta[] {
  const body = object(JSON.parse(source)),
    exact = object(exactJson(source))
  if (body?.type === 'error' || body?.error != null) throw responseError(body.error)
  if (!body || !Array.isArray(body.content) || body.content.length > 1024) throw invalidReply('Anthropic 回复内容无效')
  const decoder = new AnthropicDecoder()
  const output = decoder.event({ type: 'message_start', message: { ...body, content: [], stop_reason: null } })
  for (const [index, block] of body.content.entries()) {
    output.push(
      ...decoder.event(
        { type: 'content_block_start', index, content_block: block },
        { content_block: Array.isArray(exact?.content) ? exact.content[index] : undefined },
      ),
    )
    output.push(...decoder.event({ type: 'content_block_stop', index }))
  }
  output.push(...decoder.event({ type: 'message_delta', delta: { stop_reason: body.stop_reason }, usage: body.usage }))
  output.push(...decoder.event({ type: 'message_stop' }))
  return output
}

export async function* decodeAnthropicStream(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<GatewayDelta> {
  const decoder = new AnthropicDecoder()
  let bytes = 0
  for await (const payload of sseData(body, signal)) {
    signal.throwIfAborted()
    bytes += payload.length
    if (bytes > 64 * MAX_TEXT) throw invalidReply('Anthropic 事件流过大')
    let value: unknown, exact: unknown
    try {
      value = JSON.parse(payload)
      exact = exactJson(payload)
    } catch {
      throw invalidReply('Anthropic 事件不是有效 JSON')
    }
    for (const delta of decoder.event(value, exact)) yield delta
    if (decoder.ended) return
  }
  signal.throwIfAborted()
  if (!decoder.ended) throw invalidReply('Anthropic 流在完成前断开')
}
