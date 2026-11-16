// The Chat Completions protocol: address, headers, request body, stream decoding and the model listing. Pure: requests
// go out through the caller's fetch, so the built-in plugin and the Host's service checks share one copy.
import { z } from 'zod'
import type { ModelDelta, ModelMessage, ToolCall, ToolDefinition } from '@latch/sdk'
import {
  MAX_TOOL_ARGUMENT_CHARS,
  MAX_TOOL_CALLS,
  ProviderError,
  errorMessage,
  invalidListing,
  listedModelSchema,
  parseBaseURL,
  sseData,
  toolArguments,
  toolImageLabel,
  type ListedModel,
  type ModelPage,
  type ModelWire,
  type WireRequest,
} from './http.ts'

/** OpenAI style URL, for Chat Completions and Responses; a base without a path keeps the historical `/v1` default. */
export function chatEndpoint(baseURL: string, path: '/chat/completions' | '/responses' | '/models'): string {
  const url = parseBaseURL(baseURL)
  url.pathname = `${url.pathname.replace(/\/+$/u, '') || '/v1'}${path}`
  return url.toString()
}

export function chatHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {}
}

/** Reasoning is display-only: `ModelMessage` has no field for it, so it never returns to the wire. */
function messageOnWire(message: ModelMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    if (!message.toolCallId) throw new ProviderError('工具结果缺少 toolCallId。', 'invalid-history')
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: message.isError ? `Tool failed: ${message.content}` : message.content,
    }
  }
  return {
    role: message.role,
    content:
      message.role === 'user' && message.attachments?.length
        ? [
            ...(message.content ? [{ type: 'text', text: message.content }] : []),
            ...message.attachments.map(part =>
              part.type === 'text'
                ? { type: 'text', text: `[附件：${part.name}]\n${part.text}` }
                : { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } },
            ),
          ]
        : message.content,
    ...(message.role === 'assistant' && message.toolCalls?.length
      ? {
          tool_calls: message.toolCalls.map(call => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        }
      : {}),
  }
}

/**
 * Chat Completions takes text alone in a tool result: a tool's images follow the results of its step in one user message
 * that says which call they came from.
 */
function messagesOnWire(messages: ModelMessage[]): Array<Record<string, unknown>> {
  const wire: Array<Record<string, unknown>> = []
  let images: ModelMessage[] = []
  const flush = () => {
    if (images.length) wire.push(toolImagesOnWire(images))
    images = []
  }
  for (const message of messages) {
    if (message.role !== 'tool') flush()
    wire.push(messageOnWire(message))
    if (message.role === 'tool' && message.attachments?.some(part => part.type === 'image')) images.push(message)
  }
  flush()
  return wire
}

function toolImagesOnWire(results: ModelMessage[]): Record<string, unknown> {
  return {
    role: 'user',
    content: results.flatMap(result => [
      { type: 'text', text: toolImageLabel(result.toolCallId ?? '') },
      ...(result.attachments ?? []).flatMap(part =>
        part.type === 'image' ? [{ type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } }] : [],
      ),
    ]),
  }
}

function encodeChatRequest({ model, messages, tools, effort }: WireRequest): Record<string, unknown> {
  return {
    model,
    stream: true,
    ...(effort ? { reasoning_effort: effort } : {}),
    stream_options: { include_usage: true },
    messages: messagesOnWire(messages),
    ...(tools.length ? { tools: tools.map(chatTool) } : {}),
  }
}

const chatTool = (tool: ToolDefinition) => ({
  type: 'function',
  function: { name: tool.name, description: tool.description, parameters: tool.parameters },
})

const optionalText = z.string().nullable().optional()
const usageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  // Optional parts some services report; a gateway that sends them malformed just loses the part.
  prompt_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative().nullish() }).nullish().catch(undefined),
  completion_tokens_details: z.object({ reasoning_tokens: z.number().int().nonnegative().nullish() }).nullish().catch(undefined),
  // What the request cost, from services that say so themselves (OpenRouter).
  cost: z.number().nonnegative().nullish().catch(undefined),
})
const chunkSchema = z.object({
  choices: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        delta: z
          .object({
            content: optionalText,
            reasoning_content: optionalText,
            reasoning: optionalText,
            refusal: optionalText,
            tool_calls: z
              .array(
                z.object({
                  index: z.number().int().nonnegative(),
                  id: optionalText,
                  type: optionalText,
                  function: z.object({ name: optionalText, arguments: optionalText }).optional(),
                }),
              )
              .optional(),
          })
          .optional(),
        finish_reason: optionalText,
      }),
    )
    .optional(),
  usage: usageSchema.nullable().optional(),
  error: z.unknown().optional(),
})

type ChatUsage = Omit<Extract<ModelDelta, { type: 'usage' }>, 'type'>

/** The tokens a Chat Completions `usage` field reports, or undefined when it is missing or in another shape. */
export function chatUsage(value: unknown): ChatUsage | undefined {
  const usage = usageSchema.safeParse(value)
  return usage.success ? readChatUsage(usage.data) : undefined
}

function readChatUsage(usage: z.infer<typeof usageSchema>): ChatUsage {
  const cached = usage.prompt_tokens_details?.cached_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    ...(cached != null ? { cacheReadTokens: cached } : {}),
    ...(reasoning != null ? { reasoningTokens: reasoning } : {}),
    ...(usage.cost != null && Number.isFinite(usage.cost) ? { cost: usage.cost } : {}),
  }
}

/** Decodes a Chat Completions SSE stream. Protocol failures stay failures; usage and calls come after the text. */
async function* decodeChatStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  safeError: (text: string) => string,
): AsyncIterable<ModelDelta> {
  const calls = new Map<number, { id: string; name: string; arguments: string }>()
  let finish: 'stop' | 'tool-calls' | undefined
  let usage: ChatUsage | undefined
  for await (const payload of sseData(body, signal)) {
    signal.throwIfAborted()
    if (payload.trim() === '[DONE]') break
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      throw new ProviderError('模型服务返回无效的 SSE JSON。', 'invalid-json')
    }
    const checked = chunkSchema.safeParse(parsed)
    if (!checked.success) throw new ProviderError('模型服务的流事件字段无效。', 'invalid-chunk')
    const chunk = checked.data
    if (chunk.error != null) throw new ProviderError(safeError(errorMessage(chunk.error)), 'upstream-error')
    if (chunk.choices === undefined && chunk.usage == null) throw new ProviderError('模型流事件缺少 choices 或 usage。', 'invalid-chunk')
    if (chunk.usage) usage = readChatUsage(chunk.usage)
    for (const choice of chunk.choices ?? []) {
      if (choice.index !== 0) throw new ProviderError('模型服务返回了未请求的多个候选。', 'invalid-choice')
      const delta = choice.delta
      // Some gateways send both reasoning fields with the same text.
      const reasoning = delta?.reasoning_content || delta?.reasoning
      if (finish !== undefined && (delta?.content || reasoning || delta?.tool_calls?.length))
        throw new ProviderError('模型在结束后继续发送内容。', 'invalid-chunk')
      if (delta?.refusal) throw new ProviderError(`模型拒绝了请求：${safeError(delta.refusal)}`, 'model-refusal')
      if (reasoning) yield { type: 'reasoning', text: reasoning }
      if (delta?.content) yield { type: 'text', text: delta.content }
      for (const part of delta?.tool_calls ?? []) {
        if (part.type != null && part.type !== 'function') throw new ProviderError('仅支持 function 工具调用。', 'unsupported-tool')
        const call = calls.get(part.index) ?? { id: '', name: '', arguments: '' }
        if (part.id) {
          if (call.id && call.id !== part.id) throw new ProviderError('流中的工具调用 ID 发生变化。', 'invalid-tool-call')
          call.id = part.id
        }
        if (part.function?.name && part.function.name !== call.name) call.name += part.function.name
        call.arguments += part.function?.arguments ?? ''
        if (call.arguments.length > MAX_TOOL_ARGUMENT_CHARS || call.name.length > 256 || call.id.length > 512) {
          throw new ProviderError('工具调用超出大小限制。', 'stream-limit')
        }
        calls.set(part.index, call)
        if (calls.size > MAX_TOOL_CALLS) throw new ProviderError('模型一次请求了过多工具。', 'stream-limit')
      }
      if (choice.finish_reason != null) {
        const reason = choice.finish_reason
        if (reason !== 'stop' && reason !== 'tool_calls') throw new ProviderError(`模型未正常完成：${reason}。`, 'model-incomplete')
        const terminal = reason === 'tool_calls' ? 'tool-calls' : 'stop'
        if (finish && finish !== terminal) throw new ProviderError('模型返回了矛盾的结束状态。', 'invalid-chunk')
        finish = terminal
      }
    }
  }
  signal.throwIfAborted()
  if (!finish) throw new ProviderError('模型流未给出结束状态，不能确认调用完成。', 'stream-incomplete')
  if ((finish === 'tool-calls') !== calls.size > 0) throw new ProviderError('工具调用与模型结束状态不一致。', 'invalid-tool-call')
  const completed: ToolCall[] = []
  const ids = new Set<string>()
  for (const [, call] of [...calls].sort(([left], [right]) => left - right)) {
    if (!call.id || !call.name || ids.has(call.id)) throw new ProviderError('工具调用缺少唯一 ID 或名称。', 'invalid-tool-call')
    ids.add(call.id)
    completed.push({ id: call.id, name: call.name, arguments: toolArguments(call.name, call.arguments) })
  }
  if (usage) yield { type: 'usage', ...usage }
  for (const call of completed) yield { type: 'tool-call', call }
  yield { type: 'finish', reason: finish }
}

// Some local servers answer with a bare array.
const listingSchema = z.union([z.object({ data: z.array(listedModelSchema) }).transform(page => page.data), z.array(listedModelSchema)])

/** One page: the service's `/models`, which Chat Completions and Responses services share. */
export async function listChatModels(baseURL: string, apiKey: string, page: ModelPage): Promise<ListedModel[]> {
  const listed = listingSchema.safeParse(await page(chatEndpoint(baseURL, '/models'), chatHeaders(apiKey)))
  if (!listed.success) throw invalidListing()
  return listed.data
}

export const chatWire: ModelWire = {
  request: (baseURL, apiKey, request) => ({
    url: chatEndpoint(baseURL, '/chat/completions'),
    headers: chatHeaders(apiKey),
    body: encodeChatRequest(request),
  }),
  decode: (body, signal, safeError) => decodeChatStream(body, signal, safeError),
  listModels: listChatModels,
}
