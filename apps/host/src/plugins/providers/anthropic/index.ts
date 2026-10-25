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

export interface AnthropicConfig {
  id?: string
  name?: string
  baseURL: string
  apiKey: string
  model: string
  models?: string[]
  /** Every request goes through it. The Host passes its egress-checked fetch; defaults to `globalThis.fetch`. */
  fetch?: FetchLike
}

export const ANTHROPIC_VERSION = '2023-06-01'
const MAX_OUTPUT_TOKENS = 8192
const MAX_CONTENT_BLOCKS = 4096

/** Accepts both `https://api.anthropic.com` and a base that already ends in `/v1`. */
export function anthropicEndpoint(baseURL: string, path: '/messages' | '/models'): string {
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
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content?: string; is_error?: true }
interface WireMessage {
  role: 'user' | 'assistant'
  content: WireBlock[]
}

/** Messages API history: system text is top-level and tool results travel inside one user turn. */
function messagesOnWire(messages: ModelMessage[]): { system?: string; messages: WireMessage[] } {
  const system: string[] = []
  const wire: WireMessage[] = []
  const append = (role: WireMessage['role'], blocks: WireBlock[]) => {
    if (!blocks.length) return
    const last = wire.at(-1)
    if (last?.role === role) last.content.push(...blocks)
    else wire.push({ role, content: blocks })
  }
  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content.trim()) system.push(message.content)
    } else if (message.role === 'user') {
      append('user', message.content.trim() ? [{ type: 'text', text: message.content }] : [])
    } else if (message.role === 'assistant') {
      append('assistant', [
        ...(message.content.trim() ? [{ type: 'text' as const, text: message.content }] : []),
        ...(message.toolCalls ?? []).map(call => ({ type: 'tool_use' as const, id: call.id, name: call.name, input: call.arguments })),
      ])
    } else {
      if (!message.toolCallId) throw new ProviderError('工具结果缺少 toolCallId。', 'invalid-history')
      append('user', [
        {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          ...(message.content ? { content: message.content } : {}),
          ...(message.isError ? { is_error: true as const } : {}),
        },
      ])
    }
  }
  return { ...(system.length ? { system: system.join('\n\n') } : {}), messages: wire }
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
      z.object({ type: z.literal('thinking'), thinking: z.string() }),
      z.object({ type: z.literal('redacted_thinking') }),
      z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown().optional() }),
    ]),
  }),
  content_block_delta: z.object({
    index,
    delta: z.discriminatedUnion('type', [
      z.object({ type: z.literal('text_delta'), text: z.string() }),
      z.object({ type: z.literal('thinking_delta'), thinking: z.string() }),
      z.object({ type: z.literal('signature_delta') }),
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
  call?: { id: string; name: string; json: string; input: unknown }
}

function terminal(reason: string): 'stop' | 'tool-calls' {
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop'
  if (reason === 'tool_use') return 'tool-calls'
  if (reason === 'refusal') throw new ProviderError('模型拒绝了请求。', 'model-refusal')
  if (reason === 'max_tokens') throw new ProviderError('模型输出达到长度上限，回复未完成。', 'model-incomplete')
  throw new ProviderError(`模型未正常完成：${reason.slice(0, 64)}。`, 'model-incomplete')
}

/** Native Messages API adapter with the same strictness as the Chat Completions adapter. */
export function createAnthropicPlugin(config: AnthropicConfig): HarnessPlugin {
  const endpoint = anthropicEndpoint(config.baseURL, '/messages')
  if (/[\r\n]/u.test(config.apiKey)) throw new Error('API Key 包含无效换行。')
  const models = modelList(config.model, config.models)
  const id = config.id ?? 'anthropic'
  const apiKey = config.apiKey
  const redacted = redactor(apiKey)
  const fetcher: FetchLike = config.fetch ?? ((input, init) => globalThis.fetch(input, init))

  const provider: ModelProvider = {
    id,
    name: config.name ?? 'Anthropic',
    model: config.model,
    ...(models ? { models } : {}),
    async *stream({ messages, tools, signal, model: requested }): AsyncIterable<ModelDelta> {
      signal.throwIfAborted()
      const model = selectModel(requested, config.model, models)
      const response = await send(fetcher, endpoint, {
        method: 'POST',
        signal,
        redirect: 'error',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...anthropicHeaders(apiKey) },
        body: JSON.stringify({
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          stream: true,
          ...messagesOnWire(messages),
          ...(tools.length
            ? { tools: tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) }
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

      const blocks = new Map<number, Block>()
      const usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, reported: false, cacheReported: false }
      const recordUsage = (value: z.infer<typeof usageSchema> | null | undefined) => {
        if (!value) return
        // message_delta counts are cumulative, so later values replace earlier ones.
        if (value.input_tokens != null) usage.input = value.input_tokens
        if (value.cache_creation_input_tokens != null) usage.cacheWrite = value.cache_creation_input_tokens
        if (value.cache_read_input_tokens != null) usage.cacheRead = value.cache_read_input_tokens
        if (value.cache_creation_input_tokens != null || value.cache_read_input_tokens != null) usage.cacheReported = true
        if (value.output_tokens != null) usage.output = value.output_tokens
        usage.reported = true
      }
      const openBlock = (at: number) => {
        const block = blocks.get(at)
        if (!block?.open) throw new ProviderError('模型流引用了未开始或已结束的内容块。', 'invalid-chunk')
        return block
      }
      let started = false
      let stopped = false
      let finish: 'stop' | 'tool-calls' | undefined
      let toolBlocks = 0
      for await (const payload of sseData(response.body, signal)) {
        signal.throwIfAborted()
        let parsed: unknown
        try {
          parsed = JSON.parse(payload)
        } catch {
          throw new ProviderError('模型服务返回无效的 SSE JSON。', 'invalid-json')
        }
        const type = typeof parsed === 'object' && parsed !== null && 'type' in parsed ? parsed.type : undefined
        if (typeof type !== 'string') throw new ProviderError('模型流事件缺少类型。', 'invalid-chunk')
        // The Messages API may add event types; unknown ones carry nothing this adapter consumes.
        if (!isEventType(type)) continue
        if (type === 'ping') continue
        if (type === 'error') {
          const event = eventSchemas.error.safeParse(parsed)
          throw new ProviderError(redacted(event.success ? errorMessage(event.data.error) : '供应商返回错误。'), 'upstream-error')
        }
        if (type === 'message_start') {
          if (started) throw new ProviderError('模型流重复开始。', 'invalid-chunk')
          const event = eventSchemas.message_start.safeParse(parsed)
          if (!event.success) throw new ProviderError('模型服务的流事件字段无效。', 'invalid-chunk')
          started = true
          recordUsage(event.data.message.usage)
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
          recordUsage(event.data.usage)
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
            blocks.set(at, { type: 'tool_use', open: true, call: { id: block.id, name: block.name, json: '', input: block.input } })
          } else {
            blocks.set(at, { type: block.type, open: true })
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
      const pending = [...blocks].sort(([left], [right]) => left - right).flatMap(([, block]) => (block.call ? [block.call] : []))
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
      // Input counts the cached tokens too; the parts say how many were read from and written to the cache.
      if (usage.reported)
        yield {
          type: 'usage',
          inputTokens: usage.input + usage.cacheWrite + usage.cacheRead,
          outputTokens: usage.output,
          ...(usage.cacheReported ? { cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite } : {}),
        }
      for (const call of completed) yield { type: 'tool-call', call }
      yield { type: 'finish', reason: finish }
    },
  }
  return {
    id,
    name: config.name ?? 'Anthropic',
    version: '1.0.0',
    description: '通过 Anthropic Messages 接口流式调用模型；支持文字、推理内容与多轮工具调用。',
    activate(context) {
      context.registerProvider(provider)
    },
  }
}
