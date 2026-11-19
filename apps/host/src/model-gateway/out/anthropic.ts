import { invalidRequest, object, type Content, type GatewayRequest } from '../ir.ts'
import { checkedArguments, exactJson } from '../json.ts'
import { ToolNames } from '../tools.ts'

function content(parts: Content[], request: GatewayRequest): Array<Record<string, unknown>> {
  return parts.map(part => {
    if (part.type === 'text') return { type: 'text', text: part.text }
    if (part.detail && part.detail !== 'auto' && !request.dropped.includes('unsupported-options'))
      request.dropped.push('unsupported-options')
    if (/^https?:\/\//iu.test(part.url)) return { type: 'image', source: { type: 'url', url: part.url } }
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/u.exec(part.url)
    if (!match) throw invalidRequest('图片不能转换为 Anthropic 内容块')
    return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }
  })
}

/** Blocks Anthropic lets a cache mark sit on; a thinking block may not carry one. */
const MARKABLE = new Set(['text', 'image', 'tool_use', 'tool_result'])
const EPHEMERAL = { type: 'ephemeral' } as const

/**
 * Anthropic caches only up to a marked block, where an OpenAI-style service caches every prefix by itself. A harness that
 * asked for caching gets the marks a long agent conversation needs: the end of the system text, which also covers the
 * tools before it, and the end of the conversation, which the next request reads back. Two of the four marks a request
 * may carry, on blocks the gateway built for this request only.
 */
function markCache(
  system: Array<Record<string, unknown>>,
  messages: Array<{ content: Array<Record<string, unknown>> }>,
  request: GatewayRequest,
): void {
  let marked = false
  const last = system.at(-1)
  if (last && MARKABLE.has(String(last.type))) {
    last.cache_control = EPHEMERAL
    marked = true
  }
  const blocks = messages.at(-1)!.content
  const tail = blocks.findLastIndex(block => MARKABLE.has(String(block.type)))
  if (tail >= 0) {
    blocks[tail] = { ...blocks[tail], cache_control: EPHEMERAL }
    marked = true
  }
  // The key itself has no place in Anthropic's request; what it asked for is done, so it is no loss of this turn. How
  // long to keep the cache has no counterpart that means the same, so that stays one.
  const at = request.dropped.indexOf('prompt-cache')
  if (marked && at >= 0 && !request.cache?.retention) request.dropped.splice(at, 1)
}

/** Native thinking blocks and adjacent assistant blocks retain their exact order; no history is stored upstream. */
export function encodeAnthropic(request: GatewayRequest): { body: Record<string, unknown>; tools: ToolNames } {
  if (request.temperature !== undefined && request.temperature > 1) throw invalidRequest('Anthropic temperature 不能超过 1')
  if (request.format && !['json_schema', 'text'].includes(String(request.format.type)))
    throw invalidRequest('这个结构化输出格式不能转换为 Anthropic')
  if (request.format?.type === 'json_schema' && !object(request.format.schema)) throw invalidRequest('结构化输出缺少有效的 JSON Schema')
  const tools = new ToolNames(
    request.tools,
    request.input.flatMap(item => (item.type === 'call' ? [item] : [])),
  )
  const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: Array<Record<string, unknown>> }> = []
  const system: Array<Record<string, unknown>> = []
  const append = (role: 'user' | 'assistant' | 'system', blocks: Array<Record<string, unknown>>) => {
    const previous = messages.at(-1)
    if (previous?.role === role) previous.content.push(...blocks)
    else messages.push({ role, content: blocks })
  }
  for (const item of request.input) {
    if (item.type === 'reasoning') {
      if (item.state.wire !== 'anthropic-messages') throw invalidRequest('思考状态与上游协议不一致')
      append('assistant', [item.state.block])
    } else if (item.type === 'call') {
      append('assistant', [
        {
          type: 'tool_use',
          id: item.id,
          name: tools.name(item),
          input: item.kind === 'custom' ? { content: item.arguments } : exactJson(checkedArguments(item.arguments, text => text).json),
        },
      ])
    } else if (item.type === 'result') {
      append('user', [{ type: 'tool_result', tool_use_id: item.id, content: content(item.content, request) }])
    } else {
      if (item.role !== 'user' && item.content.some(part => part.type !== 'text')) throw invalidRequest('只有用户或工具结果可以携带图片')
      const blocks = content(item.content, request)
      if (item.role === 'system' && !messages.length) system.push(...blocks)
      else append(item.role, blocks)
    }
  }
  if (!messages.length) throw invalidRequest('Anthropic 请求必须包含对话消息')
  if (request.cache) markCache(system, messages, request)
  const choice = request.choice
  const toolChoice =
    typeof choice === 'object' ? { type: 'tool', name: tools.name(choice) } : { type: choice === 'required' ? 'any' : (choice ?? 'auto') }
  return {
    tools,
    body: {
      model: request.model,
      stream: request.stream,
      max_tokens: request.maxOutput ?? 8192,
      messages,
      ...(system.length ? { system } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.topP !== undefined ? { top_p: request.topP } : {}),
      ...(request.stop?.length ? { stop_sequences: request.stop } : {}),
      ...(request.effort ? { thinking: { type: request.effort === 'none' ? 'disabled' : 'adaptive' } } : {}),
      ...((request.effort && request.effort !== 'none') || request.format?.type === 'json_schema'
        ? {
            output_config: {
              ...(request.effort && request.effort !== 'none' ? { effort: request.effort } : {}),
              ...(request.format?.type === 'json_schema' ? { format: { type: 'json_schema', schema: request.format.schema } } : {}),
            },
          }
        : {}),
      ...(tools.all.length
        ? {
            tools: tools.all.map(tool => ({
              name: tool.wireName,
              ...(tool.description !== undefined ? { description: tool.description } : {}),
              input_schema:
                tool.kind === 'custom'
                  ? { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false }
                  : tool.parameters,
              ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
            })),
            tool_choice: {
              ...toolChoice,
              ...(choice !== 'none' && request.parallel !== undefined ? { disable_parallel_tool_use: !request.parallel } : {}),
            },
          }
        : {}),
    },
  }
}
