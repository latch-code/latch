import { z } from 'zod'
import type { HarnessPlugin, ModelDelta, ModelMessage, ModelProvider, ToolCall } from '@latch/sdk'
import {
  MAX_TOOL_ARGUMENT_CHARS,
  MAX_TOOL_CALLS,
  ProviderError,
  errorMessage,
  modelList,
  parseBaseURL,
  readErrorBody,
  redactor,
  selectModel,
  send,
  sseData,
  toolArguments,
  type FetchLike,
} from '../http.ts'

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

/** Chat Completions style URL; a base without a path keeps the historical `/v1` default. */
export function openaiEndpoint(baseURL: string, path: '/chat/completions' | '/models'): string {
  const url = parseBaseURL(baseURL)
  url.pathname = `${url.pathname.replace(/\/+$/u, '') || '/v1'}${path}`
  return url.toString()
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
    .object({
      prompt_tokens: z.number().int().nonnegative(),
      completion_tokens: z.number().int().nonnegative(),
      // Optional parts some services report; a gateway that sends them malformed just loses the part.
      prompt_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative().nullish() }).nullish().catch(undefined),
      completion_tokens_details: z.object({ reasoning_tokens: z.number().int().nonnegative().nullish() }).nullish().catch(undefined),
    })
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
      let usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; reasoningTokens?: number } | undefined
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
        if (chunk.usage) {
          const cached = chunk.usage.prompt_tokens_details?.cached_tokens
          const reasoning = chunk.usage.completion_tokens_details?.reasoning_tokens
          usage = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            ...(cached != null ? { cacheReadTokens: cached } : {}),
            ...(reasoning != null ? { reasoningTokens: reasoning } : {}),
          }
        }
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
