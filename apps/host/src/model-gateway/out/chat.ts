import { z } from 'zod'
import { AppError } from '@latch/sdk'
import { sseData, toolImageLabel } from '../../plugins/providers/http.ts'
import { invalidRequest, invalidReply, object, type Content, type GatewayRequest, type GatewayDelta, type GatewayUsage } from '../ir.ts'
import { ToolNames } from '../tools.ts'

function chatContent(parts: Content[]): string | unknown[] {
  if (parts.every(part => part.type === 'text')) return parts.map(part => part.text).join('')
  return parts.map(part =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image_url', image_url: { url: part.url, ...(part.detail ? { detail: part.detail } : {}) } },
  )
}

export function encodeChat(request: GatewayRequest): { body: Record<string, unknown>; tools: ToolNames } {
  const tools = new ToolNames(
    request.tools,
    request.input.flatMap(item => (item.type === 'call' ? [item] : [])),
  )
  const messages: Record<string, unknown>[] = []
  let images: Array<{ id: string; content: Content[] }> = []
  const flushImages = () => {
    if (images.length)
      messages.push({
        role: 'user',
        content: images.flatMap(item => [
          { type: 'text', text: toolImageLabel(item.id) },
          ...item.content.flatMap(part =>
            part.type === 'image'
              ? [{ type: 'image_url', image_url: { url: part.url, ...(part.detail ? { detail: part.detail } : {}) } }]
              : [],
          ),
        ]),
      })
    images = []
  }
  let assistant: Record<string, unknown> | undefined
  const getAssistant = () => {
    if (!assistant) {
      assistant = { role: 'assistant', content: null }
      messages.push(assistant)
    }
    return assistant
  }
  for (const item of request.input) {
    if (item.type !== 'result') flushImages()
    if (item.type === 'reasoning') {
      if (item.state.wire !== 'chat-completions') throw invalidRequest('思考状态与上游协议不一致')
      if (assistant?.content != null || assistant?.tool_calls) assistant = undefined
      const current = getAssistant()
      current.reasoning_content = String(current.reasoning_content ?? '') + item.state.text
    } else if (item.type === 'call') {
      const current = getAssistant()
      const calls = current.tool_calls as unknown[] | undefined
      current.tool_calls = [
        ...(calls ?? []),
        {
          id: item.id,
          type: 'function',
          function: {
            name: tools.name(item),
            arguments: item.kind === 'custom' ? JSON.stringify({ content: item.arguments }) : item.arguments,
          },
        },
      ]
    } else if (item.type === 'result') {
      assistant = undefined
      messages.push({ role: 'tool', tool_call_id: item.id, content: chatContent(item.content.filter(part => part.type === 'text')) })
      if (item.content.some(part => part.type === 'image')) images.push(item)
    } else if (item.role === 'assistant') {
      const current = getAssistant()
      const next = chatContent(item.content)
      if (typeof next !== 'string') throw invalidRequest('助手图片不能转换为 Chat')
      current.content = String(current.content ?? '') + next
    } else {
      assistant = undefined
      messages.push({ role: item.role, content: chatContent(item.content) })
    }
  }
  flushImages()
  let format: Record<string, unknown> | undefined
  if (request.format) {
    const { type, ...fields } = request.format
    if (type === 'json_schema') format = { type, json_schema: fields }
    else if (type === 'json_object') format = { type }
    else if (type !== 'text') throw invalidRequest('这个结构化输出格式不能转换为 Chat')
  }
  return {
    tools,
    body: {
      model: request.model,
      stream: request.stream,
      messages,
      ...(request.stream ? { stream_options: { include_usage: true } } : {}),
      ...(request.effort ? { reasoning_effort: request.effort } : {}),
      ...(request.maxOutput !== undefined ? { max_tokens: request.maxOutput } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.topP !== undefined ? { top_p: request.topP } : {}),
      ...(request.stop?.length ? { stop: request.stop } : {}),
      ...(format ? { response_format: format } : {}),
      ...(request.parallel !== undefined ? { parallel_tool_calls: request.parallel } : {}),
      ...(request.choice !== undefined
        ? {
            tool_choice:
              typeof request.choice === 'string' ? request.choice : { type: 'function', function: { name: tools.name(request.choice) } },
          }
        : {}),
      ...(tools.all.length
        ? {
            tools: tools.all.map(tool => ({
              type: 'function',
              function: {
                name: tool.wireName,
                ...(tool.description ? { description: tool.description } : {}),
                parameters:
                  tool.kind === 'custom'
                    ? { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false }
                    : tool.parameters,
                ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
              },
            })),
          }
        : {}),
    },
  }
}

const optionalText = z.string().nullish()
const partSchema = z.object({
  index: z.number().int().min(0).max(127),
  id: optionalText,
  type: z.literal('function').nullish(),
  function: z.object({ name: optionalText, arguments: optionalText }).nullish(),
})
const deltaSchema = z.object({
  content: optionalText,
  reasoning_content: optionalText,
  reasoning: optionalText,
  refusal: optionalText,
  tool_calls: z.array(partSchema).max(128).nullish(),
  annotations: z.array(z.unknown()).optional(),
  audio: z.unknown().optional(),
})
const chunkSchema = z.object({
  choices: z
    .array(z.object({ index: z.literal(0), delta: deltaSchema.nullish(), finish_reason: optionalText, logprobs: z.unknown().optional() }))
    .max(1)
    .optional(),
  usage: z.unknown().optional(),
  error: z.unknown().optional(),
})
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const usageSchema = z.object({
  prompt_tokens: count,
  completion_tokens: count,
  prompt_tokens_details: z.object({ cached_tokens: count.nullish(), cache_write_tokens: count.nullish() }).nullish(),
  completion_tokens_details: z.object({ reasoning_tokens: count.nullish() }).nullish(),
  prompt_cache_hit_tokens: count.nullish(),
  prompt_cache_miss_tokens: count.nullish(),
})

function usageOf(value: unknown): GatewayUsage | undefined {
  const parsed = usageSchema.safeParse(value)
  if (!parsed.success) return undefined
  const data = parsed.data
  const cacheRead = data.prompt_tokens_details?.cached_tokens ?? data.prompt_cache_hit_tokens
  const cacheWrite = data.prompt_tokens_details?.cache_write_tokens
  const reasoning = data.completion_tokens_details?.reasoning_tokens
  return {
    input: data.prompt_tokens,
    output: data.completion_tokens,
    ...(cacheRead != null ? { cacheRead } : {}),
    ...(cacheWrite != null ? { cacheWrite } : {}),
    ...(reasoning != null ? { reasoning } : {}),
  }
}

function finishOf(value: string): Extract<GatewayDelta, { type: 'finish' }> {
  if (value === 'stop') return { type: 'finish', reason: 'stop' }
  if (value === 'tool_calls') return { type: 'finish', reason: 'tools' }
  if (value === 'length') return { type: 'finish', reason: 'length' }
  if (value === 'content_filter') return { type: 'finish', reason: 'filter' }
  throw invalidReply('模型报告了不能确认完成的结束状态')
}

function responseError(value: unknown): AppError {
  const error = object(value)
  const description = `${typeof error?.code === 'string' ? error.code : ''} ${typeof error?.message === 'string' ? error.message : ''}`
  if (/context_length_exceeded|maximum context|context window|prompt is too long/iu.test(description))
    return new AppError(400, 'context_length_exceeded', '输入超过模型服务的上下文上限')
  if (/rate_limit_exceeded|slow_down/iu.test(description)) return new AppError(429, 'rate_limit_exceeded', '模型服务暂时限流')
  if (/server_is_overloaded|overloaded_error/iu.test(description)) return new AppError(503, 'server_is_overloaded', '模型服务暂时繁忙')
  return invalidReply('模型服务在回复中报告错误')
}

/** Shared by the streamed and non-streamed paths; invalid upstream errors never become a successful empty reply. */
function chunkDeltas(value: unknown): GatewayDelta[] {
  const parsed = chunkSchema.safeParse(value)
  if (!parsed.success) throw invalidReply('模型流事件字段无效')
  const body = parsed.data
  if (body.error != null) throw responseError(body.error)
  if (!body.choices && body.usage == null) throw invalidReply('模型流缺少 choices 或 usage')
  const output: GatewayDelta[] = []
  for (const choice of body.choices ?? []) {
    const delta = choice.delta
    if (delta?.annotations?.length) output.push({ type: 'loss', loss: 'annotations' })
    if (delta?.audio != null) output.push({ type: 'loss', loss: 'audio' })
    if (choice.logprobs != null) output.push({ type: 'loss', loss: 'logprobs' })
    const reasoning = delta?.reasoning_content ?? delta?.reasoning
    if (reasoning) output.push({ type: 'reasoning', text: reasoning })
    if (delta?.content) output.push({ type: 'text', text: delta.content })
    if (delta?.refusal) output.push({ type: 'refusal', text: delta.refusal })
    for (const part of delta?.tool_calls ?? [])
      output.push({
        type: 'tool',
        index: part.index,
        ...(part.id != null ? { id: part.id } : {}),
        ...(part.function?.name != null ? { name: part.function.name } : {}),
        ...(part.function?.arguments != null ? { arguments: part.function.arguments } : {}),
      })
    if (choice.finish_reason != null) output.push(finishOf(choice.finish_reason))
  }
  const usage = usageOf(body.usage)
  if (usage) output.push({ type: 'usage', usage })
  return output
}

export async function* decodeChat(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<GatewayDelta> {
  let finished = false
  for await (const payload of sseData(body, signal)) {
    signal.throwIfAborted()
    if (payload.trim() === '[DONE]') break
    let value: unknown
    try {
      value = JSON.parse(payload)
    } catch {
      throw invalidReply('模型流不是有效 JSON')
    }
    for (const delta of chunkDeltas(value)) {
      if (finished && delta.type !== 'usage' && delta.type !== 'loss') throw invalidReply('模型在结束标记后继续发送内容')
      if (delta.type === 'finish') finished = true
      yield delta
    }
  }
  signal.throwIfAborted()
  if (!finished) throw invalidReply('模型流在完成前断开')
}

export function decodeChatReply(value: unknown): GatewayDelta[] {
  const body = object(value)
  if (body?.error != null) throw responseError(body.error)
  if (!body || !Array.isArray(body.choices) || body.choices.length !== 1) throw invalidReply('模型回复格式无效')
  const choice = object(body.choices[0])
  const message = object(choice?.message)
  if (!message || typeof choice?.finish_reason !== 'string') throw invalidReply('模型回复未给出完成状态')
  return chunkDeltas({
    choices: [
      {
        index: choice.index,
        logprobs: choice.logprobs,
        finish_reason: choice.finish_reason,
        delta: {
          ...message,
          ...(Array.isArray(message.tool_calls)
            ? { tool_calls: message.tool_calls.map((tool, index) => ({ ...object(tool), index })) }
            : {}),
        },
      },
    ],
    usage: body.usage,
  })
}
