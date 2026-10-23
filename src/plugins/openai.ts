import { z } from 'zod'
import type { HarnessPlugin, ModelDelta, ModelMessage, ModelProvider, ToolCall } from '../core/plugins.ts'

/**
 * The Host's outbound `fetch`. Declared here rather than imported, because plugins never import
 * from `src/host`; it is structurally identical to the Host egress module's type.
 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface OpenAIConfig {
  /** Plugin and provider ID. Defaults to the legacy `openai-compatible`. */
  id?: string
  name?: string
  baseURL: string
  apiKey: string
  /** Default model ID. */
  model: string
  /** Models a request may choose. Empty or absent accepts any requested model. */
  models?: string[]
  /** Every request goes through it. The Host passes its egress-checked fetch; defaults to `globalThis.fetch`. */
  fetch?: FetchLike
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly target?: string,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

function egressCode(value: unknown): value is { code: 'egress-denied'; target?: unknown } {
  return typeof value === 'object' && value !== null && 'code' in value && value.code === 'egress-denied'
}

/**
 * The egress denial carried by a failed request: thrown directly (redirect, protocol) or as the
 * cause of the `fetch failed` TypeError raised from the connector. Undefined for any other failure.
 */
export function egressDenial(error: unknown): ProviderError | undefined {
  const denied = egressCode(error) ? error : error instanceof Error && egressCode(error.cause) ? error.cause : undefined
  if (!denied) return undefined
  const target = typeof denied.target === 'string' ? denied.target.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 300) : ''
  return new ProviderError(`Host 出站策略拒绝访问 ${target || '该地址'}（本机、私网或元数据地址）。`, 'egress-denied', undefined, target)
}

/** Sends one request; an egress denial becomes a ProviderError, every other failure is rethrown unchanged. */
export async function send(fetcher: FetchLike, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetcher(url, init)
  } catch (error) {
    throw egressDenial(error) ?? error
  }
}

const MAX_EVENT_CHARS = 1024 * 1024
export const MAX_TOOL_ARGUMENT_CHARS = 1024 * 1024
export const MAX_TOOL_CALLS = 128

/** Validates a user-supplied API base URL. Credentials belong in the API key, never in the URL. */
export function parseBaseURL(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ProviderError('模型地址不是有效的 URL。', 'invalid-url')
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ProviderError('模型地址必须是无内嵌凭据、查询参数或片段的 HTTP(S) API base URL。', 'invalid-url')
  }
  return url
}

/** Chat Completions style URL; a base without a path keeps the historical `/v1` default. */
export function openaiEndpoint(baseURL: string, path: '/chat/completions' | '/models'): string {
  const url = parseBaseURL(baseURL)
  url.pathname = `${url.pathname.replace(/\/+$/u, '') || '/v1'}${path}`
  return url.toString()
}

const MAX_ERROR_CHARS = 512

/**
 * Redacts the key, then clips to 512 characters. Upstreams may echo the key JSON-escaped or URL-encoded, so those
 * forms are redacted too; a clipped tail that is still the start of the key is dropped as well.
 */
export function redactor(apiKey: string): (text: string) => string {
  if (!apiKey) return text => text.slice(0, MAX_ERROR_CHARS)
  const json = JSON.stringify(apiKey).slice(1, -1)
  const forms = [...new Set([apiKey, json, json.replace(/\//gu, '\\/'), encodeURIComponent(apiKey)])].sort((a, b) => b.length - a.length)
  return text => {
    let output = text
    for (const form of forms) output = output.split(form).join('[redacted]')
    output = output.slice(0, MAX_ERROR_CHARS)
    for (const form of forms) {
      for (let length = Math.min(form.length - 1, output.length); length >= 4; length--) {
        if (output.endsWith(form.slice(0, length))) return `${output.slice(0, -length)}[redacted]`
      }
    }
    return output
  }
}

/** Checks the static model configuration shared by provider adapters. */
export function modelList(model: string, models: readonly string[] | undefined): string[] | undefined {
  if (!model.trim()) throw new Error('必须指定模型 ID。')
  if (!models?.length) return undefined
  if (!models.includes(model)) throw new Error('默认模型必须在模型列表中。')
  return [...new Set(models)]
}

/** A requested model is used as-is or refused; it is never silently replaced by the default. */
export function selectModel(requested: string | undefined, model: string, models: readonly string[] | undefined): string {
  if (requested === undefined) return model
  if (!requested.trim() || requested.length > 200 || (models?.length && !models.includes(requested))) {
    throw new ProviderError(`模型 ${requested.slice(0, 200)} 未在此服务中启用。`, 'model-unavailable')
  }
  return requested
}

const optionalText = z.string().nullable().optional()
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
  usage: z
    .object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative() })
    .nullable()
    .optional(),
  error: z.unknown().optional(),
})

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
    content: message.content,
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

/** SSE `data` payloads. Framing is independent of UTF-8, TCP chunks and CRLF boundaries. */
export async function* sseData(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  let data: string[] = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      while (true) {
        const boundary = buffer.search(/[\r\n]/u)
        if (boundary < 0 || (!done && boundary === buffer.length - 1 && buffer[boundary] === '\r')) break
        const line = buffer.slice(0, boundary)
        const length = buffer[boundary] === '\r' && buffer[boundary + 1] === '\n' ? 2 : 1
        buffer = buffer.slice(boundary + length)
        size += line.length
        if (size > MAX_EVENT_CHARS) throw new ProviderError('模型流事件过大。', 'stream-limit')
        if (line === '') {
          if (data.length) yield data.join('\n')
          data = []
          size = 0
        } else if (line === 'data' || line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /u, ''))
        }
      }
      if (buffer.length + size > MAX_EVENT_CHARS) throw new ProviderError('模型流事件过大。', 'stream-limit')
      if (done) {
        if (buffer.trim() !== '' || data.length) throw new ProviderError('模型流在事件结束前断开。', 'stream-incomplete')
        break
      }
    }
  } finally {
    await reader.cancel().catch(() => {
      /* An aborted fetch may already have closed the reader. */
    })
    reader.releaseLock()
  }
}

/** An error response's text, at most 4 KiB. Callers pass it through `redactor`, which also clips it. */
export async function readErrorBody(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (length < 4096) {
      const next = await reader.read()
      if (next.done) break
      const part = next.value.subarray(0, 4096 - length)
      chunks.push(part)
      length += part.length
    }
  } finally {
    await reader.cancel().catch(() => {
      /* The error response may already have ended. */
    })
    reader.releaseLock()
  }
  // Not clipped here: `redactor` must see the whole key before it clips, or a key cut at the boundary survives.
  return new TextDecoder().decode(Buffer.concat(chunks))
}

export function errorMessage(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'message' in value && typeof value.message === 'string') return value.message
  return typeof value === 'string' ? value : '供应商返回错误。'
}

/** Chat Completions adapter. Protocol failures stay failures; there is no demo fallback. */
export function createOpenAIPlugin(config: OpenAIConfig): HarnessPlugin {
  const endpoint = openaiEndpoint(config.baseURL, '/chat/completions')
  if (/[\r\n]/u.test(config.apiKey)) throw new Error('API Key 包含无效换行。')
  const models = modelList(config.model, config.models)
  const id = config.id ?? 'openai-compatible'
  const apiKey = config.apiKey
  const redacted = redactor(apiKey)
  const fetcher: FetchLike = config.fetch ?? ((input, init) => globalThis.fetch(input, init))

  const provider: ModelProvider = {
    id,
    name: config.name ?? 'OpenAI 兼容接口',
    model: config.model,
    ...(models ? { models } : {}),
    async *stream({ messages, tools, signal, model: requested }): AsyncIterable<ModelDelta> {
      signal.throwIfAborted()
      const model = selectModel(requested, config.model, models)
      const response = await send(fetcher, endpoint, {
        method: 'POST',
        signal,
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          stream: true,
          stream_options: { include_usage: true },
          messages: messages.map(messageOnWire),
          ...(tools.length
            ? {
                tools: tools.map(tool => ({
                  type: 'function',
                  function: { name: tool.name, description: tool.description, parameters: tool.parameters },
                })),
              }
            : {}),
        }),
      })
      if (!response.ok)
        throw new ProviderError(
          `模型服务 HTTP ${response.status}：${redacted(await readErrorBody(response))}`,
          'http-error',
          response.status,
        )
      if (!response.body) throw new ProviderError('模型服务没有返回响应体。', 'empty-response')
      if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
        await response.body.cancel()
        throw new ProviderError('模型服务没有返回 SSE 流。', 'invalid-content-type')
      }

      const calls = new Map<number, { id: string; name: string; arguments: string }>()
      let finish: 'stop' | 'tool-calls' | undefined
      let usage: { inputTokens: number; outputTokens: number } | undefined
      for await (const payload of sseData(response.body, signal)) {
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
        if (chunk.error != null) throw new ProviderError(redacted(errorMessage(chunk.error)), 'upstream-error')
        if (chunk.choices === undefined && chunk.usage == null)
          throw new ProviderError('模型流事件缺少 choices 或 usage。', 'invalid-chunk')
        if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens }
        for (const choice of chunk.choices ?? []) {
          if (choice.index !== 0) throw new ProviderError('模型服务返回了未请求的多个候选。', 'invalid-choice')
          const delta = choice.delta
          // Some gateways send both reasoning fields with the same text.
          const reasoning = delta?.reasoning_content || delta?.reasoning
          if (finish !== undefined && (delta?.content || reasoning || delta?.tool_calls?.length))
            throw new ProviderError('模型在结束后继续发送内容。', 'invalid-chunk')
          if (delta?.refusal) throw new ProviderError(`模型拒绝了请求：${redacted(delta.refusal)}`, 'model-refusal')
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
    },
  }
  return {
    id,
    name: config.name ?? 'OpenAI 兼容模型',
    version: '1.1.0',
    description: '通过 Chat Completions 接口调用用户配置的模型；支持流式文字、推理内容与多轮 function tool calls。',
    activate(context) {
      context.registerProvider(provider)
    },
  }
}

/** Parses streamed tool arguments; models must send a JSON object. */
export function toolArguments(name: string, text: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new ProviderError(`工具 ${name} 的参数不是有效 JSON。`, 'invalid-tool-json')
  }
  const record = z.record(z.string(), z.unknown()).safeParse(value)
  if (!record.success) throw new ProviderError(`工具 ${name} 的参数必须是对象。`, 'invalid-tool-json')
  return record.data
}
