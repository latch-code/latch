import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { checkedArguments, exactJson } from '../json.ts'
import {
  invalidRequest,
  invalidReply,
  object,
  requiredText,
  type Content,
  type GatewayDelta,
  type GatewayItem,
  type GatewayLoss,
  type GatewayRequest,
  type GatewayUsage,
} from '../ir.ts'
import { assertToolSelection, safeToolIdentity, type ToolNames } from '../tools.ts'

const schema = z
  .object({
    model: z.string().min(1).max(200),
    stream: z.boolean().optional(),
    max_tokens: z.number().int().positive().max(16_777_216),
    messages: z
      .array(z.object({ role: z.enum(['user', 'assistant', 'system']), content: z.unknown() }))
      .min(1)
      .max(100_000),
    system: z.unknown().optional(),
    tools: z.array(z.unknown()).max(1024).optional(),
    tool_choice: z
      .object({
        type: z.enum(['auto', 'any', 'none', 'tool']),
        name: z.string().optional(),
        disable_parallel_tool_use: z.boolean().optional(),
      })
      .optional(),
    temperature: z.number().finite().min(0).max(1).optional(),
    top_p: z.number().finite().min(0).max(1).optional(),
    stop_sequences: z.array(z.string().max(8192)).max(4).optional(),
    output_config: z.object({ effort: z.string().max(64).optional(), format: z.record(z.string(), z.unknown()).optional() }).optional(),
    thinking: z
      .object({
        type: z.enum(['enabled', 'disabled', 'adaptive']),
        budget_tokens: z.number().int().positive().optional(),
        display: z.enum(['omitted', 'summarized']).optional(),
      })
      .optional(),
  })
  .passthrough()

const name = (value: unknown) => {
  const text = requiredText(value, '工具标识', 1024)
  if (!text) throw invalidRequest('工具标识不能为空')
  return text
}

function content(value: unknown, dropped: Set<GatewayLoss>): Content[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  if (!Array.isArray(value)) throw invalidRequest('Anthropic 消息内容无效')
  return value.map(raw => {
    const block = object(raw)
    if (!block) throw invalidRequest('Anthropic 内容块无效')
    if (block.cache_control !== undefined) dropped.add('prompt-cache')
    if (block.type === 'text') {
      if (Array.isArray(block.citations) && block.citations.length) dropped.add('annotations')
      return { type: 'text', text: requiredText(block.text, '文字') }
    }
    if (block.type === 'image') {
      const source = object(block.source)
      if (source?.type === 'url') {
        const url = requiredText(source.url, '图片地址', 32 * 1024 * 1024)
        if (!/^https?:\/\//iu.test(url)) throw invalidRequest('图片地址不是 HTTP(S) URL')
        return { type: 'image', url }
      }
      if (source?.type === 'base64' && typeof source.media_type === 'string' && /^image\/(png|jpeg|gif|webp)$/u.test(source.media_type)) {
        const data = requiredText(source.data, '图片数据', 32 * 1024 * 1024)
        if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(data)) throw invalidRequest('图片不是 base64 数据')
        return { type: 'image', url: `data:${source.media_type};base64,${data}` }
      }
      throw invalidRequest('这种图片引用尚不能转换')
    }
    throw invalidRequest('这类 Anthropic 内容块尚不能转换')
  })
}

/** Full Anthropic history only. Execution state that cannot be represented is refused, never removed. */
export function decodeAnthropic(source: string, openReasoning: (value: string) => string | undefined = () => undefined): GatewayRequest {
  const value: unknown = JSON.parse(source)
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw invalidRequest('Anthropic 请求字段格式无效')
  const body = parsed.data
  if (body.thinking?.display === 'omitted') throw invalidRequest('Chat 转换尚不能隐藏思考文字：回放封装不是加密，Latch 没有转发')
  for (const field of ['container', 'mcp_servers', 'context_management', 'conversation'])
    if (body[field] != null) throw invalidRequest('转换不支持服务端执行、会话或压缩状态，请发送完整对话')
  const exact = object(exactJson(source))!
  const rawMessages = exact.messages as Array<{ content: unknown }>
  const dropped = new Set<GatewayLoss>()
  if (body.cache_control !== undefined) dropped.add('prompt-cache')
  if (body.metadata || body.service_tier || body.top_k !== undefined || body.thinking?.budget_tokens !== undefined)
    dropped.add('unsupported-options')
  const input: GatewayItem[] = []
  if (body.system !== undefined) {
    const parts = content(body.system, dropped)
    if (parts.some(part => part.type !== 'text')) throw invalidRequest('系统说明只能包含文字')
    input.push({ type: 'message', role: 'system', content: parts })
  }
  const pending = new Set<string>()
  const seen = new Set<string>()
  for (const [messageIndex, message] of body.messages.entries()) {
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
    if (!Array.isArray(blocks)) throw invalidRequest('Anthropic 消息内容无效')
    const rawBlocks = rawMessages[messageIndex]!.content
    for (const [blockIndex, raw] of blocks.entries()) {
      const block = object(raw)
      if (!block) throw invalidRequest('Anthropic 内容块无效')
      if (block.cache_control !== undefined) dropped.add('prompt-cache')
      if (block.type === 'tool_result') {
        const id = name(block.tool_use_id)
        if (message.role !== 'user' || !pending.delete(id)) throw invalidRequest('工具结果没有对应的未完成调用')
        if (block.is_error !== undefined && typeof block.is_error !== 'boolean') throw invalidRequest('工具结果状态无效')
        const parts = content(block.content ?? '', dropped)
        if (parts.some(part => part.type === 'image')) dropped.add('tool-image-location')
        input.push({ type: 'result', id, content: block.is_error ? [{ type: 'text', text: '[工具执行失败]\n' }, ...parts] : parts })
      } else if (block.type === 'tool_use') {
        if (message.role !== 'assistant') throw invalidRequest('工具调用必须来自助手')
        const id = name(block.id)
        if (seen.has(id)) throw invalidRequest('工具调用 ID 重复')
        seen.add(id)
        pending.add(id)
        const fields = object(block.input)
        if (!fields) throw invalidRequest('工具输入必须是 JSON 对象')
        const exactBlock = Array.isArray(rawBlocks) ? object(rawBlocks[blockIndex]) : undefined
        const args = checkedArguments(JSON.stringify(exactBlock?.input ?? fields), text => text).json
        input.push({ type: 'call', kind: 'function', id, name: name(block.name), arguments: args })
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        if (message.role !== 'assistant') throw invalidRequest('思考必须来自助手')
        const thought = typeof block.signature === 'string' ? openReasoning(block.signature) : undefined
        if (thought !== undefined) input.push({ type: 'reasoning', text: thought })
        else dropped.add('reasoning-state')
      } else {
        if (message.role !== 'assistant' && pending.size) throw invalidRequest('工具结果尚未完整返回')
        const parts = content([block], dropped)
        if (message.role !== 'user' && parts.some(part => part.type === 'image')) throw invalidRequest('只有用户或工具结果可以携带图片')
        input.push({ type: 'message', role: message.role, content: parts })
      }
    }
  }
  if (pending.size) throw invalidRequest('工具结果尚未完整返回')
  if (!input.length) throw invalidRequest('请求没有可转换的消息')
  const tools: GatewayRequest['tools'] = []
  for (const [index, raw] of (body.tools ?? []).entries()) {
    const tool = object(raw)
    if (!tool) throw invalidRequest('工具定义无效')
    if (tool.type !== undefined && tool.type !== 'custom') throw invalidRequest('这类服务端工具尚不能转换')
    const parameters = object(tool.input_schema)
    if (!parameters || (tool.strict !== undefined && typeof tool.strict !== 'boolean')) throw invalidRequest('工具参数 schema 无效')
    if (tool.cache_control !== undefined) dropped.add('prompt-cache')
    if (tool.defer_loading || tool.allowed_callers || tool.input_examples) dropped.add('unsupported-options')
    const exactTool = Array.isArray(exact.tools) ? object(exact.tools[index]) : undefined
    tools.push({
      kind: 'function',
      name: name(tool.name),
      parameters: object(exactTool?.input_schema) ?? parameters,
      ...(tool.description !== undefined ? { description: requiredText(tool.description, '工具说明') } : {}),
      ...(typeof tool.strict === 'boolean' ? { strict: tool.strict } : {}),
    })
  }
  const selection = body.tool_choice
  const choice =
    selection?.type === 'tool'
      ? { kind: 'function' as const, name: name(selection.name) }
      : selection?.type === 'any'
        ? 'required'
        : selection?.type
  if (choice === 'required' && !tools.length) throw invalidRequest('没有可以强制调用的工具')
  const effort = body.thinking?.type === 'disabled' ? 'none' : body.output_config?.effort
  const format = object(object(exact.output_config)?.format)
  return {
    model: body.model,
    stream: body.stream === true,
    input,
    tools,
    dropped: [...dropped],
    maxOutput: body.max_tokens,
    ...(choice ? { choice } : {}),
    ...(selection?.disable_parallel_tool_use !== undefined ? { parallel: !selection.disable_parallel_tool_use } : {}),
    ...(effort ? { effort } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { topP: body.top_p } : {}),
    ...(body.stop_sequences?.length ? { stop: body.stop_sequences } : {}),
    ...(format ? { format: { ...format, name: 'response' } } : {}),
  }
}

type Event = Record<string, unknown> & { type: string }
type Block = Record<string, unknown> & { type: string }
interface Call {
  id: string
  name: string
  arguments: string
}

/** Tool blocks are published only after all calls validate; text and thinking remain incremental. */
export class AnthropicOutput {
  private readonly id = `msg_${randomUUID()}`
  private readonly blocks: Block[] = []
  private readonly calls = new Map<number, Call>()
  private active?: { index: number; type: 'text' | 'thinking'; text: string }
  private bytes = 0
  private stop?: Extract<GatewayDelta, { type: 'finish' }>['reason']
  private usage?: GatewayUsage
  private ended = false
  constructor(
    private readonly request: GatewayRequest,
    private readonly tools: ToolNames,
    private readonly seal: (text: string) => string,
    private readonly redact: (text: string) => string = text => text,
  ) {}
  private usageValue() {
    const usage = this.usage
    const input = usage ? usage.input - (usage.cacheRead ?? 0) - (usage.cacheWrite ?? 0) : 0
    if (input < 0) throw invalidReply('模型用量中的缓存 token 超过输入总数')
    return {
      input_tokens: input,
      output_tokens: usage?.output ?? 0,
      ...(usage?.cacheRead !== undefined ? { cache_read_input_tokens: usage.cacheRead } : {}),
      ...(usage?.cacheWrite !== undefined ? { cache_creation_input_tokens: usage.cacheWrite } : {}),
    }
  }
  result(): Record<string, unknown> {
    return {
      id: this.id,
      type: 'message',
      role: 'assistant',
      model: this.request.model,
      content: this.blocks.map(block => ({ ...block })),
      stop_reason: !this.ended
        ? null
        : this.stop === 'tools'
          ? 'tool_use'
          : this.stop === 'length'
            ? 'max_tokens'
            : this.stop === 'filter'
              ? 'refusal'
              : 'end_turn',
      stop_sequence: null,
      usage: this.usageValue(),
    }
  }
  start(): Event[] {
    return [{ type: 'message_start', message: this.result() }]
  }
  private close(): Event[] {
    const active = this.active
    if (!active) return []
    this.active = undefined
    const block = this.blocks[active.index]!
    const events: Event[] = []
    if (active.type === 'thinking') {
      const signature = this.seal(active.text)
      block.signature = signature
      events.push({ type: 'content_block_delta', index: active.index, delta: { type: 'signature_delta', signature } })
    }
    events.push({ type: 'content_block_stop', index: active.index })
    return events
  }
  push(delta: GatewayDelta): Event[] {
    if (delta.type === 'loss') return []
    if (this.ended) throw invalidReply('模型在回复完成后继续发送内容')
    if (delta.type === 'usage') {
      this.usage = delta.usage
      return []
    }
    if (delta.type === 'finish') {
      if (this.stop && this.stop !== delta.reason) throw invalidReply('模型的结束状态前后不一致')
      this.stop = delta.reason
      return []
    }
    if (this.stop) throw invalidReply('模型在结束标记之后继续发送内容')
    this.bytes += delta.type === 'tool' ? (delta.arguments?.length ?? 0) + (delta.name?.length ?? 0) : delta.text.length
    if (this.bytes > 8 * 1024 * 1024) throw invalidReply('模型回复超出转换大小限制')
    if (delta.type === 'tool') {
      let call = this.calls.get(delta.index)
      if (!call) {
        if (this.calls.size >= 128) throw invalidReply('模型请求的工具过多')
        call = { id: '', name: '', arguments: '' }
        this.calls.set(delta.index, call)
      }
      if (delta.id) {
        if (call.id && call.id !== delta.id) throw invalidReply('工具调用 ID 前后不一致')
        call.id = delta.id
      }
      if (delta.name) {
        if (call.name && call.name !== delta.name) throw invalidReply('工具调用名称前后不一致')
        call.name = delta.name
      }
      call.arguments += delta.arguments ?? ''
      if (call.arguments.length > 1024 * 1024 || call.name.length > 64 || call.id.length > 1024) throw invalidReply('工具调用内容过大')
      return []
    }
    if (delta.type === 'refusal') throw invalidReply('模型拒绝了本次请求')
    const type = delta.type === 'reasoning' ? 'thinking' : 'text'
    const events = this.active?.type === type ? [] : this.close()
    if (!this.active) {
      const index = this.blocks.length
      this.blocks.push(type === 'thinking' ? { type, thinking: '' } : { type, text: '' })
      this.active = { index, type, text: '' }
      events.push({ type: 'content_block_start', index, content_block: { ...this.blocks[index] } })
    }
    const text = this.redact(delta.text)
    this.active.text += text
    if (type === 'thinking' && this.active.text.length > 1024 * 1024) throw invalidReply('模型思考超出回放大小限制')
    this.blocks[this.active.index]![type === 'thinking' ? 'thinking' : 'text'] = this.active.text
    events.push({
      type: 'content_block_delta',
      index: this.active.index,
      delta: type === 'thinking' ? { type: 'thinking_delta', thinking: text } : { type: 'text_delta', text },
    })
    return events
  }
  finish(): Event[] {
    if (!this.stop || this.ended) throw invalidReply('模型流没有完整结束')
    if (!this.usage) throw invalidReply('模型服务未报告用量，不能完成 Anthropic 回复')
    if ((this.stop === 'tools') !== this.calls.size > 0 && this.stop !== 'length' && this.stop !== 'filter')
      throw invalidReply('工具调用与模型结束状态不一致')
    assertToolSelection(
      this.request,
      this.tools,
      [...this.calls.values()].map(call => call.name),
      this.stop === 'length' || this.stop === 'filter',
    )
    const ready: Array<{ block: Block; arguments: string }> = []
    const ids = new Set<string>()
    if (this.stop !== 'length' && this.stop !== 'filter')
      for (const [, call] of [...this.calls].sort(([a], [b]) => a - b)) {
        if (!call.id || ids.has(call.id)) throw invalidReply('工具调用没有唯一 ID')
        ids.add(call.id)
        const tool = this.tools.called(call.name)
        safeToolIdentity(call.id, tool, this.redact)
        if (tool.kind !== 'function' || tool.namespace) throw invalidReply('Anthropic 工具身份无效')
        const checked = checkedArguments(call.arguments, this.redact)
        ready.push({ block: { type: 'tool_use', id: call.id, name: tool.name, input: exactJson(checked.json) }, arguments: checked.json })
      }
    const events = this.close()
    for (const item of ready) {
      const index = this.blocks.length
      this.blocks.push(item.block)
      events.push(
        { type: 'content_block_start', index, content_block: { ...item.block, input: {} } },
        { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: item.arguments } },
        { type: 'content_block_stop', index },
      )
    }
    this.ended = true
    events.push(
      { type: 'message_delta', delta: { stop_reason: this.result().stop_reason, stop_sequence: null }, usage: this.usageValue() },
      { type: 'message_stop' },
    )
    return events
  }
  fail(message: string, _code?: string): Event[] {
    this.ended = true
    return [{ type: 'error', error: { type: 'api_error', message: this.redact(message) } }]
  }
}
