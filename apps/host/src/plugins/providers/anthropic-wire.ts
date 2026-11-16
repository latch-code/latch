// The Anthropic Messages protocol: address, headers, request body, stream decoding and the model listing. Pure: requests
// go out through the caller's fetch, so the built-in plugin and the Host's service checks share one copy.
import { z } from 'zod'
import type { ModelDelta, ModelMessage, ToolCall } from '@latch/sdk'
import {
  MAX_SIGNATURE_CHARS,
  MAX_TOOL_ARGUMENT_CHARS,
  MAX_TOOL_CALLS,
  ProviderError,
  errorMessage,
  invalidListing,
  parseBaseURL,
  replayLayout,
  sameIds,
  sseData,
  toolArguments,
  turnStart,
  type ListedModel,
  type ModelPage,
  type ModelWire,
  type WireRequest,
} from './http.ts'

const ANTHROPIC_VERSION = '2023-06-01'
const MAX_OUTPUT_TOKENS = 8192
const MAX_CONTENT_BLOCKS = 4096
const MAX_LIST_PAGES = 10

/** Accepts both `https://api.anthropic.com` and a base that already ends in `/v1`. */
export function anthropicEndpoint(baseURL: string, path: '/messages' | '/messages/count_tokens' | '/models'): string {
  const url = parseBaseURL(baseURL)
  const prefix = url.pathname.replace(/\/+$/u, '')
  url.pathname = `${/\/v1$/u.test(prefix) ? prefix : `${prefix}/v1`}${path}`
  return url.toString()
}

export function anthropicHeaders(apiKey: string): Record<string, string> {
  return { 'anthropic-version': ANTHROPIC_VERSION, ...(apiKey ? { 'x-api-key': apiKey } : {}) }
}

type WireBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'tool_result'
      tool_use_id: string
      content?: string | Array<Extract<WireBlock, { type: 'text' } | { type: 'image' }>>
      is_error?: true
    }
interface WireMessage {
  role: 'user' | 'assistant'
  content: WireBlock[]
}

/**
 * A response that asked for tools, block by block as it arrived: thinking blocks whole, text whole, calls by ID. It
 * rides on the first call's signature, because thinking must go back unchanged and in its place within the tool loop,
 * and a thinking block can sit between text and calls.
 */
const layoutSchema = z.array(
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('thinking'), thinking: z.string(), signature: z.string().min(1) }).strict(),
    z.object({ type: z.literal('redacted_thinking'), data: z.string().min(1) }).strict(),
    z.object({ type: z.literal('text'), text: z.string() }).strict(),
    z.object({ type: z.literal('tool_use'), id: z.string() }).strict(),
  ]),
)
type Layout = z.infer<typeof layoutSchema>

/** The assistant blocks exactly as the model sent them, or undefined when the history no longer matches the layout. */
function replayed(message: ModelMessage, layout: Layout): WireBlock[] | undefined {
  const calls = message.toolCalls ?? []
  const text = layout.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('')
  const ids = layout.flatMap(block => (block.type === 'tool_use' ? [block.id] : []))
  if (
    text !== message.content
    || !sameIds(
      ids,
      calls.map(call => call.id),
    )
  )
    return undefined
  return layout.flatMap((block): WireBlock[] => {
    if (block.type === 'tool_use') {
      const call = calls.find(item => item.id === block.id)!
      return [{ type: 'tool_use', id: call.id, name: call.name, input: call.arguments }]
    }
    // The service refuses a text block with nothing to read, as the plain history below never sends one.
    if (block.type === 'text' && !block.text.trim()) return []
    return [block]
  })
}

/** Messages API history: system text is top-level and tool results travel inside one user turn. */
function messagesOnWire(messages: ModelMessage[], signer: string): { system?: string; messages: WireMessage[] } {
  const system: string[] = []
  const wire: WireMessage[] = []
  const start = turnStart(messages)
  const append = (role: WireMessage['role'], blocks: WireBlock[]) => {
    if (!blocks.length) return
    const last = wire.at(-1)
    if (last?.role === role) last.content.push(...blocks)
    else wire.push({ role, content: blocks })
  }
  for (const [index, message] of messages.entries()) {
    if (message.role === 'system') {
      if (message.content.trim()) system.push(message.content)
    } else if (message.role === 'user') {
      append('user', [
        ...(message.content.trim() ? [{ type: 'text' as const, text: message.content }] : []),
        ...(message.attachments ?? []).map(part =>
          part.type === 'text'
            ? { type: 'text' as const, text: `[附件：${part.name}]\n${part.text}` }
            : { type: 'image' as const, source: { type: 'base64' as const, media_type: part.mimeType, data: part.data } },
        ),
      ])
    } else if (message.role === 'assistant') {
      const layout = replayLayout(message, index, start, signer, value => layoutSchema.safeParse(value).data)
      append(
        'assistant',
        (layout && replayed(message, layout)) ?? [
          ...(message.content.trim() ? [{ type: 'text' as const, text: message.content }] : []),
          ...(message.toolCalls ?? []).map(call => ({ type: 'tool_use' as const, id: call.id, name: call.name, input: call.arguments })),
        ],
      )
    } else {
      if (!message.toolCallId) throw new ProviderError('工具结果缺少 toolCallId。', 'invalid-history')
      // The Messages API takes a tool's images inside its result.
      const images = (message.attachments ?? []).flatMap(part =>
        part.type === 'image'
          ? [{ type: 'image' as const, source: { type: 'base64' as const, media_type: part.mimeType, data: part.data } }]
          : [],
      )
      append('user', [
        {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          ...(images.length
            ? { content: [...(message.content ? [{ type: 'text' as const, text: message.content }] : []), ...images] }
            : message.content
              ? { content: message.content }
              : {}),
          ...(message.isError ? { is_error: true as const } : {}),
        },
      ])
    }
  }
  return { ...(system.length ? { system: system.join('\n\n') } : {}), messages: wire }
}

function encodeAnthropicRequest({ model, messages, tools, effort, signer }: WireRequest): Record<string, unknown> {
  return {
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    stream: true,
    // A thinking level is adaptive thinking at that effort. It is named: Opus 4.6 to 4.8 and Sonnet 4.6 run without
    // thinking when `thinking` is left out, the Claude 5 models take it as their default, and none takes a token budget.
    ...(effort ? { thinking: { type: 'adaptive' }, output_config: { effort } } : {}),
    ...messagesOnWire(messages, signer),
    ...(tools.length
      ? { tools: tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) }
      : {}),
  }
}

const count = z.number().int().nonnegative().nullable().optional()
const usageSchema = z.object({
  input_tokens: count,
  output_tokens: count,
  cache_creation_input_tokens: count,
  cache_read_input_tokens: count,
})
const index = z.number().int().nonnegative()
const eventSchemas = {
  message_start: z.object({ message: z.object({ usage: usageSchema.nullable().optional() }) }),
  content_block_start: z.object({
    index,
    content_block: z.discriminatedUnion('type', [
      z.object({ type: z.literal('text'), text: z.string() }),
      z.object({ type: z.literal('thinking'), thinking: z.string(), signature: z.string().optional() }),
      z.object({ type: z.literal('redacted_thinking'), data: z.string() }),
      z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown().optional() }),
    ]),
  }),
  content_block_delta: z.object({
    index,
    delta: z.discriminatedUnion('type', [
      z.object({ type: z.literal('text_delta'), text: z.string() }),
      z.object({ type: z.literal('thinking_delta'), thinking: z.string() }),
      z.object({ type: z.literal('signature_delta'), signature: z.string() }),
      z.object({ type: z.literal('input_json_delta'), partial_json: z.string() }),
    ]),
  }),
  content_block_stop: z.object({ index }),
  message_delta: z.object({ delta: z.object({ stop_reason: z.string().nullable().optional() }), usage: usageSchema.nullable().optional() }),
  message_stop: z.object({}),
  ping: z.object({}),
  error: z.object({ error: z.unknown() }),
}
type EventType = keyof typeof eventSchemas
const isEventType = (type: unknown): type is EventType => typeof type === 'string' && Object.hasOwn(eventSchemas, type)
const BLOCK_DELTA = { text: 'text_delta', thinking: 'thinking_delta', redacted_thinking: undefined, tool_use: 'input_json_delta' } as const

interface Block {
  type: keyof typeof BLOCK_DELTA
  open: boolean
  /** Text, thinking or redacted data as it arrived, kept for the tool loop's next request. */
  text: string
  signature: string
  call?: { id: string; name: string; json: string; input: unknown }
}

/** The layout of a response that asked for tools and thought, or undefined when nothing needs to go back with it. */
function layoutOf(blocks: Block[], kept: boolean): string | undefined {
  if (!kept || !blocks.some(block => block.type === 'thinking' || block.type === 'redacted_thinking')) return undefined
  // Without its signature a thinking block is refused, and dropping one would change the order the service checks.
  if (blocks.some(block => block.type === 'thinking' && !block.signature)) return undefined
  const layout: Layout = blocks.map(block =>
    block.type === 'thinking'
      ? { type: 'thinking', thinking: block.text, signature: block.signature }
      : block.type === 'redacted_thinking'
        ? { type: 'redacted_thinking', data: block.text }
        : block.type === 'text'
          ? { type: 'text', text: block.text }
          : { type: 'tool_use', id: block.call!.id },
  )
  const value = JSON.stringify(layout)
  return value.length <= MAX_SIGNATURE_CHARS ? value : undefined
}

function terminal(reason: string): 'stop' | 'tool-calls' {
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop'
  if (reason === 'tool_use') return 'tool-calls'
  if (reason === 'refusal') throw new ProviderError('模型拒绝了请求。', 'model-refusal')
  if (reason === 'max_tokens') throw new ProviderError('模型输出达到长度上限，回复未完成。', 'model-incomplete')
  throw new ProviderError(`模型未正常完成：${reason.slice(0, 64)}。`, 'model-incomplete')
}

/**
 * Usage as the stream reports it. `message_delta` counts are cumulative, so later values replace earlier ones; input counts
 * the cached tokens too, and the parts say how many were read from and written to the cache.
 */
/** A Messages reply's usage as it accumulates over `message_start` and `message_delta`; the gateway reads it too. */
export class AnthropicUsage {
  private input = 0
  private cacheWrite = 0
  private cacheRead = 0
  private output = 0
  private reported = false
  private cacheReported = false

  /** One `usage` object of the reply; anything not in its shape is ignored. */
  record(input: unknown): void {
    const parsed = usageSchema.nullable().optional().safeParse(input)
    const value = parsed.success ? parsed.data : undefined
    if (!value) return
    if (value.input_tokens != null) this.input = value.input_tokens
    if (value.cache_creation_input_tokens != null) this.cacheWrite = value.cache_creation_input_tokens
    if (value.cache_read_input_tokens != null) this.cacheRead = value.cache_read_input_tokens
    if (value.cache_creation_input_tokens != null || value.cache_read_input_tokens != null) this.cacheReported = true
    if (value.output_tokens != null) this.output = value.output_tokens
    this.reported = true
  }

  delta(): Extract<ModelDelta, { type: 'usage' }> | undefined {
    if (!this.reported) return undefined
    return {
      type: 'usage',
      inputTokens: this.input + this.cacheWrite + this.cacheRead,
      outputTokens: this.output,
      ...(this.cacheReported ? { cacheReadTokens: this.cacheRead, cacheWriteTokens: this.cacheWrite } : {}),
    }
  }
}

/** Decodes a Messages API SSE stream with the same strictness as the Chat Completions decoder. */
async function* decodeAnthropicStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  safeError: (text: string) => string,
  signer: string,
): AsyncIterable<ModelDelta> {
  const blocks = new Map<number, Block>()
  // What is kept for the layout stays within what a signature may hold; past that, nothing goes back.
  let keptChars = 0
  const keep = (text: string) => {
    keptChars += text.length
    return keptChars <= MAX_SIGNATURE_CHARS ? text : ''
  }
  const usage = new AnthropicUsage()
  const openBlock = (at: number) => {
    const block = blocks.get(at)
    if (!block?.open) throw new ProviderError('模型流引用了未开始或已结束的内容块。', 'invalid-chunk')
    return block
  }
  let started = false
  let stopped = false
  let finish: 'stop' | 'tool-calls' | undefined
  let toolBlocks = 0
  for await (const payload of sseData(body, signal)) {
    signal.throwIfAborted()
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      throw new ProviderError('模型服务返回无效的 SSE JSON。', 'invalid-json')
    }
    const type = typeof parsed === 'object' && parsed !== null && 'type' in parsed ? parsed.type : undefined
    if (typeof type !== 'string') throw new ProviderError('模型流事件缺少类型。', 'invalid-chunk')
    // The Messages API may add event types; unknown ones carry nothing this decoder consumes.
    if (!isEventType(type)) continue
    if (type === 'ping') continue
    if (type === 'error') {
      const event = eventSchemas.error.safeParse(parsed)
      throw new ProviderError(safeError(event.success ? errorMessage(event.data.error) : '供应商返回错误。'), 'upstream-error')
    }
    if (type === 'message_start') {
      if (started) throw new ProviderError('模型流重复开始。', 'invalid-chunk')
      const event = eventSchemas.message_start.safeParse(parsed)
      if (!event.success) throw new ProviderError('模型服务的流事件字段无效。', 'invalid-chunk')
      started = true
      usage.record(event.data.message.usage)
      continue
    }
    if (!started) throw new ProviderError('模型流缺少 message_start。', 'invalid-chunk')
    if (type === 'message_stop') {
      stopped = true
      break
    }
    if (type === 'message_delta') {
      const event = eventSchemas.message_delta.safeParse(parsed)
      if (!event.success) throw new ProviderError('模型服务的流事件字段无效。', 'invalid-chunk')
      usage.record(event.data.usage)
      const reason = event.data.delta.stop_reason
      if (reason != null) {
        const next = terminal(reason)
        if (finish && finish !== next) throw new ProviderError('模型返回了矛盾的结束状态。', 'invalid-chunk')
        finish = next
      }
      continue
    }
    if (finish !== undefined) throw new ProviderError('模型在结束后继续发送内容。', 'invalid-chunk')
    if (type === 'content_block_start') {
      const event = eventSchemas.content_block_start.safeParse(parsed)
      if (!event.success) throw new ProviderError('模型返回了不支持的内容块。', 'unsupported-block')
      const { index: at, content_block: block } = event.data
      if (blocks.has(at)) throw new ProviderError('模型流重复使用内容块序号。', 'invalid-chunk')
      if (blocks.size >= MAX_CONTENT_BLOCKS) throw new ProviderError('模型返回了过多内容块。', 'stream-limit')
      if (block.type === 'tool_use') {
        if (++toolBlocks > MAX_TOOL_CALLS) throw new ProviderError('模型一次请求了过多工具。', 'stream-limit')
        if (block.name.length > 256 || block.id.length > 512) throw new ProviderError('工具调用超出大小限制。', 'stream-limit')
        blocks.set(at, {
          type: 'tool_use',
          open: true,
          text: '',
          signature: '',
          call: { id: block.id, name: block.name, json: '', input: block.input },
        })
      } else {
        blocks.set(at, {
          type: block.type,
          open: true,
          text: keep(block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : block.data),
          signature: block.type === 'thinking' ? (block.signature ?? '') : '',
        })
        if (block.type === 'text' && block.text) yield { type: 'text', text: block.text }
        if (block.type === 'thinking' && block.thinking) yield { type: 'reasoning', text: block.thinking }
      }
      continue
    }
    if (type === 'content_block_stop') {
      const event = eventSchemas.content_block_stop.safeParse(parsed)
      if (!event.success) throw new ProviderError('模型服务的流事件字段无效。', 'invalid-chunk')
      openBlock(event.data.index).open = false
      continue
    }
    const event = eventSchemas.content_block_delta.safeParse(parsed)
    if (!event.success) throw new ProviderError('模型服务的流事件字段无效。', 'invalid-chunk')
    const block = openBlock(event.data.index)
    const delta = event.data.delta
    if (delta.type === 'signature_delta' ? block.type !== 'thinking' : BLOCK_DELTA[block.type] !== delta.type) {
      throw new ProviderError('内容块与增量类型不一致。', 'invalid-chunk')
    }
    if (delta.type === 'signature_delta') block.signature += delta.signature
    else if (delta.type === 'text_delta') block.text += keep(delta.text)
    else if (delta.type === 'thinking_delta') block.text += keep(delta.thinking)
    if (block.signature.length > MAX_SIGNATURE_CHARS) throw new ProviderError('模型返回的思考签名超出大小限制。', 'stream-limit')
    if (delta.type === 'text_delta' && delta.text) yield { type: 'text', text: delta.text }
    else if (delta.type === 'thinking_delta' && delta.thinking) yield { type: 'reasoning', text: delta.thinking }
    else if (delta.type === 'input_json_delta' && block.call) {
      block.call.json += delta.partial_json
      if (block.call.json.length > MAX_TOOL_ARGUMENT_CHARS) throw new ProviderError('工具调用超出大小限制。', 'stream-limit')
    }
  }
  signal.throwIfAborted()
  if (!stopped || !finish) throw new ProviderError('模型流未给出结束状态，不能确认调用完成。', 'stream-incomplete')
  if ([...blocks.values()].some(block => block.open)) throw new ProviderError('模型流在内容块结束前停止。', 'stream-incomplete')
  const ordered = [...blocks].sort(([left], [right]) => left - right).map(([, block]) => block)
  const pending = ordered.flatMap(block => (block.call ? [block.call] : []))
  if ((finish === 'tool-calls') !== pending.length > 0) throw new ProviderError('工具调用与模型结束状态不一致。', 'invalid-tool-call')
  const completed: ToolCall[] = []
  const ids = new Set<string>()
  for (const call of pending) {
    if (!call.id || !call.name || ids.has(call.id)) throw new ProviderError('工具调用缺少唯一 ID 或名称。', 'invalid-tool-call')
    ids.add(call.id)
    let args: Record<string, unknown>
    if (call.json !== '') args = toolArguments(call.name, call.json)
    else {
      // Calls without arguments may stream no input_json_delta at all.
      const input = z.record(z.string(), z.unknown()).safeParse(call.input ?? {})
      if (!input.success) throw new ProviderError(`工具 ${call.name} 的参数必须是对象。`, 'invalid-tool-json')
      args = input.data
    }
    completed.push({ id: call.id, name: call.name, arguments: args })
  }
  const layout = completed.length ? layoutOf(ordered, keptChars <= MAX_SIGNATURE_CHARS) : undefined
  if (layout) completed[0]!.signature = { by: signer, value: layout, scope: 'turn' }
  const reported = usage.delta()
  if (reported) yield reported
  for (const call of completed) yield { type: 'tool-call', call }
  yield { type: 'finish', reason: finish }
}

const listingSchema = z.object({
  data: z.array(z.object({ id: z.string() })),
  has_more: z.boolean().optional(),
  last_id: z.string().nullable().optional(),
})

/** Every page of `/v1/models`, up to ten. */
async function listAnthropicModels(baseURL: string, apiKey: string, page: ModelPage): Promise<ListedModel[]> {
  const endpoint = new URL(anthropicEndpoint(baseURL, '/models'))
  endpoint.searchParams.set('limit', '1000')
  const models: ListedModel[] = []
  for (let index = 0; index < MAX_LIST_PAGES; index++) {
    const result = listingSchema.safeParse(await page(endpoint.toString(), anthropicHeaders(apiKey)))
    if (!result.success) throw invalidListing()
    models.push(...result.data.data)
    if (!result.data.has_more || !result.data.last_id) break
    endpoint.searchParams.set('after_id', result.data.last_id)
  }
  return models
}

export const anthropicWire: ModelWire = {
  request: (baseURL, apiKey, request) => ({
    url: anthropicEndpoint(baseURL, '/messages'),
    headers: anthropicHeaders(apiKey),
    body: encodeAnthropicRequest(request),
  }),
  decode: decodeAnthropicStream,
  listModels: listAnthropicModels,
}
