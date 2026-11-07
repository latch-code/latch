// The OpenAI Responses protocol: address, request body, stream decoding and the model listing. Pure: requests go out
// through the caller's fetch, so the built-in plugin and the Host's service checks share one copy.
import { z } from 'zod'
import type { TokenUsage } from '@latch/protocol'
import type { ModelDelta, ModelMessage, ToolCall, ToolDefinition } from '@latch/sdk'
import { chatEndpoint, chatHeaders, listChatModels } from './chat-wire.ts'
import {
  MAX_SIGNATURE_CHARS,
  MAX_TOOL_ARGUMENT_CHARS,
  MAX_TOOL_CALLS,
  ProviderError,
  errorMessage,
  replayLayout,
  sameIds,
  sseData,
  toolArguments,
  turnStart,
  type ModelWire,
  type WireRequest,
} from './http.ts'

type InputItem = Record<string, unknown>

/**
 * The output items of a response that reasoned and asked for tools: reasoning and messages whole, calls by item and call
 * ID. It rides on the first call's signature. Without stored responses, the encrypted reasoning goes back as input
 * within the tool loop, next to the items it came with.
 */
const layoutSchema = z.array(
  z.union([
    z.object({ type: z.literal('reasoning'), id: z.string(), encrypted_content: z.string().min(1) }).passthrough(),
    z
      .object({
        type: z.literal('message'),
        role: z.literal('assistant'),
        content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
      })
      .passthrough(),
    z.object({ type: z.literal('function_call'), id: z.string(), call_id: z.string() }).strict(),
  ]),
)
type Layout = z.infer<typeof layoutSchema>
// The items as they came, keys in their order: the schema checks them, never rewrites them.
const asLayout = (value: unknown): Layout | undefined => (layoutSchema.safeParse(value).success ? (value as Layout) : undefined)

const messageText = (item: Layout[number]) =>
  item.type === 'message' ? item.content.map(part => (part.type === 'output_text' ? (part.text ?? '') : '')).join('') : ''

/** The items exactly as the service sent them, or undefined when the history no longer matches the layout. */
function replayed(message: ModelMessage, layout: Layout): InputItem[] | undefined {
  const calls = message.toolCalls ?? []
  const ids = layout.flatMap(item => (item.type === 'function_call' ? [item.call_id] : []))
  if (
    layout.map(messageText).join('') !== message.content
    || !sameIds(
      ids,
      calls.map(call => call.id),
    )
  )
    return undefined
  return layout.map(item => {
    if (item.type !== 'function_call') return item
    const call = calls.find(entry => entry.id === item.call_id)!
    return { type: 'function_call', id: item.id, call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) }
  })
}

/**
 * Responses input: system text becomes `instructions`, and calls and their results are items of their own. Outside the
 * reasoning replayed in the tool loop, a call is sent without its item ID, which the service would otherwise pair with a
 * reasoning item that is not sent.
 */
function inputOnWire(messages: ModelMessage[], signer: string): { instructions?: string; input: InputItem[] } {
  const system: string[] = []
  const input: InputItem[] = []
  const start = turnStart(messages)
  for (const [index, message] of messages.entries()) {
    if (message.role === 'system') {
      if (message.content.trim()) system.push(message.content)
    } else if (message.role === 'tool') {
      if (!message.toolCallId) throw new ProviderError('工具结果缺少 toolCallId。', 'invalid-history')
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId,
        output: message.isError ? `Tool failed: ${message.content}` : message.content,
      })
    } else if (message.role === 'user') {
      input.push({
        role: 'user',
        content: message.attachments?.length
          ? [
              ...(message.content ? [{ type: 'input_text', text: message.content }] : []),
              ...message.attachments.map(part =>
                part.type === 'text'
                  ? { type: 'input_text', text: `[附件：${part.name}]\n${part.text}` }
                  : { type: 'input_image', image_url: `data:${part.mimeType};base64,${part.data}`, detail: 'auto' },
              ),
            ]
          : message.content,
      })
    } else {
      const layout = replayLayout(message, index, start, signer, asLayout)
      const items = layout && replayed(message, layout)
      if (items) {
        input.push(...items)
        continue
      }
      if (message.content) input.push({ role: 'assistant', content: message.content })
      for (const call of message.toolCalls ?? [])
        input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) })
    }
  }
  return { ...(system.length ? { instructions: system.join('\n\n') } : {}), input }
}

const responsesTool = (tool: ToolDefinition) => ({
  type: 'function',
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters,
  // Strict mode needs every property required and no extra ones; tool schemas are not written that way.
  strict: false,
})

function encodeResponsesRequest({ model, messages, tools, effort, signer }: WireRequest): Record<string, unknown> {
  return {
    model,
    stream: true,
    // Latch keeps the conversation and never refers to a stored response, so the service need not keep one.
    store: false,
    // Asked for only with a thinking level, since a model that does not reason refuses it.
    ...(effort ? { reasoning: { effort }, include: ['reasoning.encrypted_content'] } : {}),
    ...inputOnWire(messages, signer),
    ...(tools.length ? { tools: tools.map(responsesTool) } : {}),
  }
}

const count = z.number().int().nonnegative()
const usageSchema = z.object({
  input_tokens: count,
  output_tokens: count,
  // Optional parts some services report; a gateway that sends them malformed just loses the part.
  input_tokens_details: z.object({ cached_tokens: count.nullish() }).nullish().catch(undefined),
  output_tokens_details: z.object({ reasoning_tokens: count.nullish() }).nullish().catch(undefined),
})

/** A Responses usage object as Latch counts tokens: cached input inside the input, reasoning inside the output. */
function tokensOf(usage: z.infer<typeof usageSchema>): TokenUsage {
  const cached = usage.input_tokens_details?.cached_tokens
  const reasoning = usage.output_tokens_details?.reasoning_tokens
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(cached != null ? { cacheReadTokens: cached } : {}),
    ...(reasoning != null ? { reasoningTokens: reasoning } : {}),
  }
}

/** The tokens a Responses `usage` field reports, or undefined when it is missing or in another shape. */
export function responsesUsage(value: unknown): TokenUsage | undefined {
  const usage = usageSchema.safeParse(value)
  return usage.success ? tokensOf(usage.data) : undefined
}
const delta = z.object({ delta: z.string() })
const eventSchemas = {
  'response.output_text.delta': delta,
  'response.reasoning_summary_text.delta': delta,
  'response.reasoning_text.delta': delta,
  'response.refusal.done': z.object({ refusal: z.string() }),
  'response.output_item.done': z.object({ item: z.object({ type: z.string() }).passthrough() }),
  // A compatible server that reports usage, or the output, in another shape loses that part, not the turn.
  'response.completed': z.object({
    response: z.object({
      usage: usageSchema.nullish().catch(undefined),
      output: z
        .array(z.object({ type: z.string(), id: z.string().optional(), encrypted_content: z.unknown() }).passthrough())
        .nullish()
        .catch(undefined),
    }),
  }),
  'response.incomplete': z.object({
    response: z.object({ incomplete_details: z.object({ reason: z.string().nullish() }).nullish() }),
  }),
  'response.failed': z.object({ response: z.object({ error: z.unknown().optional() }) }),
  error: z.object({ message: z.string() }),
}
type EventType = keyof typeof eventSchemas
const isEventType = (type: unknown): type is EventType => typeof type === 'string' && Object.hasOwn(eventSchemas, type)
function fields<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const event = schema.safeParse(value)
  if (!event.success) throw new ProviderError('模型服务的流事件字段无效。', 'invalid-chunk')
  return event.data
}
const functionCallSchema = z.object({ type: z.literal('function_call'), call_id: z.string(), name: z.string(), arguments: z.string() })

function incomplete(reason: string | null | undefined, safeError: (text: string) => string): ProviderError {
  if (reason === 'max_output_tokens') return new ProviderError('模型输出达到长度上限，回复未完成。', 'model-incomplete')
  if (reason === 'content_filter') return new ProviderError('模型服务的内容过滤中止了回复。', 'model-refusal')
  return new ProviderError(`模型未正常完成：${safeError(reason ?? 'incomplete').slice(0, 64)}。`, 'model-incomplete')
}

/**
 * The layout of a response that reasoned and asked for tools, or undefined when nothing needs to go back with it or it
 * cannot: a reasoning item without its encrypted content refers to a stored item that does not exist.
 */
function layoutOf(items: Array<Record<string, unknown>> | undefined): string | undefined {
  const layout = asLayout(items)
  if (!layout?.some(item => item.type === 'reasoning')) return undefined
  const value = JSON.stringify(layout)
  return value.length <= MAX_SIGNATURE_CHARS ? value : undefined
}

/** Decodes a Responses SSE stream. A turn needs `response.completed`; calls come from their finished output items. */
async function* decodeResponsesStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  safeError: (text: string) => string,
  signer: string,
): AsyncIterable<ModelDelta> {
  const calls: Array<{ id: string; name: string; arguments: string }> = []
  // Undefined once an item arrives that the layout cannot carry back, or the items outgrow what a signature may hold.
  let items: Array<Record<string, unknown>> | undefined = []
  let keptChars = 0
  const keep = (item: Record<string, unknown>) => {
    keptChars += JSON.stringify(item).length
    if (keptChars > MAX_SIGNATURE_CHARS) items = undefined
    else items?.push(item)
  }
  let usage: z.infer<typeof usageSchema> | null | undefined
  let completed = false
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
    // The protocol has many more events (annotations, part boundaries, hosted tools); none carries what Latch reads.
    if (!isEventType(type)) continue
    if (type === 'error') throw new ProviderError(safeError(fields(eventSchemas.error, parsed).message), 'upstream-error')
    if (type === 'response.failed') {
      const failure = fields(eventSchemas[type], parsed).response.error
      throw new ProviderError(safeError(failure == null ? '供应商返回错误。' : errorMessage(failure)), 'upstream-error')
    }
    if (type === 'response.incomplete') throw incomplete(fields(eventSchemas[type], parsed).response.incomplete_details?.reason, safeError)
    if (type === 'response.refusal.done')
      throw new ProviderError(`模型拒绝了请求：${safeError(fields(eventSchemas[type], parsed).refusal)}`, 'model-refusal')
    if (type === 'response.completed') {
      const { response } = fields(eventSchemas[type], parsed)
      usage = response.usage
      // Some services leave the encrypted reasoning out of the finished item and send it only here.
      for (const item of items ?? []) {
        if (item.type !== 'reasoning' || item.encrypted_content) continue
        const done = response.output?.find(entry => entry.type === 'reasoning' && entry.id === item.id)
        if (typeof done?.encrypted_content === 'string') item.encrypted_content = done.encrypted_content
      }
      completed = true
      break
    }
    if (type === 'response.output_item.done') {
      const { item } = fields(eventSchemas[type], parsed)
      if (item.type !== 'function_call') {
        if (item.type === 'reasoning' || item.type === 'message') keep(item)
        else items = undefined
        continue
      }
      const call = functionCallSchema.safeParse(item)
      if (!call.success) throw new ProviderError('工具调用缺少 call_id、名称或参数。', 'invalid-tool-call')
      const { call_id: id, name, arguments: args } = call.data
      if (args.length > MAX_TOOL_ARGUMENT_CHARS || name.length > 256 || id.length > 512)
        throw new ProviderError('工具调用超出大小限制。', 'stream-limit')
      calls.push({ id, name, arguments: args })
      if (typeof item.id === 'string') keep({ type: 'function_call', id: item.id, call_id: id })
      else items = undefined
      if (calls.length > MAX_TOOL_CALLS) throw new ProviderError('模型一次请求了过多工具。', 'stream-limit')
      continue
    }
    const text = fields(eventSchemas[type], parsed).delta
    if (text) yield type === 'response.output_text.delta' ? { type: 'text', text } : { type: 'reasoning', text }
  }
  signal.throwIfAborted()
  if (!completed) throw new ProviderError('模型流未给出结束状态，不能确认调用完成。', 'stream-incomplete')
  const finished: ToolCall[] = []
  const ids = new Set<string>()
  for (const call of calls) {
    if (!call.id || !call.name || ids.has(call.id)) throw new ProviderError('工具调用缺少唯一 ID 或名称。', 'invalid-tool-call')
    ids.add(call.id)
    finished.push({ id: call.id, name: call.name, arguments: toolArguments(call.name, call.arguments || '{}') })
  }
  const layout = finished.length ? layoutOf(items) : undefined
  if (layout) finished[0]!.signature = { by: signer, value: layout, scope: 'turn' }
  if (usage) yield { type: 'usage', ...tokensOf(usage) }
  for (const call of finished) yield { type: 'tool-call', call }
  yield { type: 'finish', reason: finished.length ? 'tool-calls' : 'stop' }
}

export const responsesWire: ModelWire = {
  request: (baseURL, apiKey, request) => ({
    url: chatEndpoint(baseURL, '/responses'),
    headers: chatHeaders(apiKey),
    body: encodeResponsesRequest(request),
  }),
  decode: decodeResponsesStream,
  listModels: listChatModels,
}
