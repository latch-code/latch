import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  invalidRequest,
  invalidReply,
  object,
  requiredText,
  type Content,
  type GatewayItem,
  type GatewayTool,
  type GatewayRequest,
  type GatewayLoss,
  type GatewayDelta,
  type GatewayUsage,
} from '../ir.ts'
import { safeToolIdentity, type ToolNames } from '../tools.ts'
import { checkedArguments } from '../json.ts'

const requestSchema = z
  .object({
    model: z.string().min(1).max(200),
    stream: z.boolean().optional(),
    input: z.union([z.string(), z.array(z.unknown()).max(100_000)]).nullish(),
    instructions: z.string().nullish(),
    tools: z.array(z.unknown()).max(1024).optional(),
    tool_choice: z.unknown().optional(),
    parallel_tool_calls: z.boolean().optional(),
    reasoning: z
      .object({ effort: z.string().min(1).max(64).nullish(), summary: z.string().nullish(), context: z.string().nullish() })
      .nullish(),
    max_output_tokens: z.number().int().positive().max(16_777_216).nullish(),
    temperature: z.number().finite().min(0).max(2).nullish(),
    top_p: z.number().finite().min(0).max(1).nullish(),
    text: z.object({ format: z.record(z.string(), z.unknown()).optional(), verbosity: z.string().optional() }).nullish(),
  })
  .passthrough()

function content(value: unknown, dropped: Set<GatewayLoss>): Content[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  if (!Array.isArray(value)) throw invalidRequest('消息内容格式无效')
  return value.map((raw): Content => {
    const part = object(raw)
    if (!part) throw invalidRequest('消息内容格式无效')
    if (Array.isArray(part.annotations) && part.annotations.length) dropped.add('annotations')
    if (part.type === 'input_text' || part.type === 'output_text') return { type: 'text', text: requiredText(part.text, '文字') }
    if (part.type === 'input_image') {
      const url = requiredText(part.image_url, '图片地址', 32 * 1024 * 1024)
      if (part.file_id !== undefined || !/^(?:https?:\/\/|data:image\/(?:png|jpeg|gif|webp);base64,)/iu.test(url))
        throw invalidRequest('这个图片引用不能转换为 Chat 图片')
      if (part.detail !== undefined && !['low', 'high', 'auto', 'original'].includes(String(part.detail)))
        throw invalidRequest('图片精度无效')
      return { type: 'image', url, ...(part.detail ? { detail: String(part.detail) } : {}) }
    }
    throw invalidRequest('这类文件或消息内容尚不能转换为 Chat')
  })
}

const name = (value: unknown): string => {
  const result = requiredText(value, '工具名称', 1024)
  if (!result) throw invalidRequest('工具名称不能为空')
  return result
}

const HOSTED_TOOLS = new Set([
  'web_search',
  'web_search_preview',
  'web_search_preview_2025_03_11',
  'file_search',
  'code_interpreter',
  'computer',
  'computer_use_preview',
  'image_generation',
  'mcp',
  'tool_search',
])

function readTools(values: unknown[], dropped: Set<GatewayLoss>, namespace?: string): GatewayTool[] {
  return values.flatMap(raw => {
    const tool = object(raw)
    if (!tool) throw invalidRequest('工具定义格式无效')
    if (tool.type === 'namespace') {
      if (namespace || !Array.isArray(tool.tools)) throw invalidRequest('工具命名空间格式无效')
      return readTools(tool.tools, dropped, name(tool.name))
    }
    if (tool.type !== 'function' && tool.type !== 'custom') {
      if (typeof tool.type !== 'string' || !HOSTED_TOOLS.has(tool.type)) throw invalidRequest('这类工具尚不能转换为 Chat')
      dropped.add('hosted-tools')
      return []
    }
    const common = {
      name: name(tool.name),
      ...(namespace ? { namespace } : {}),
      ...(tool.description !== undefined ? { description: requiredText(tool.description, '工具说明') } : {}),
    }
    if (tool.type === 'custom') {
      const format = object(tool.format)
      if (format && format.type !== 'text') dropped.add('tool-grammar')
      const grammar = typeof format?.definition === 'string' ? format.definition : undefined
      return [
        {
          ...common,
          kind: 'custom' as const,
          description: [
            common.description,
            'Pass the raw tool input in the content string. The JSON wrapper is removed before the tool runs.',
            ...(grammar ? [`Requested input grammar (not enforced by this API):\n${grammar}`] : []),
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
      ]
    }
    const parameters = tool.parameters === undefined ? { type: 'object', properties: {} } : object(tool.parameters)
    if (!parameters || (tool.strict !== undefined && typeof tool.strict !== 'boolean')) throw invalidRequest('函数工具参数格式无效')
    return [{ ...common, kind: 'function' as const, parameters, ...(typeof tool.strict === 'boolean' ? { strict: tool.strict } : {}) }]
  })
}

export function decodeResponses(value: unknown, openReasoning: (value: string) => string | undefined = () => undefined): GatewayRequest {
  const parsed = requestSchema.safeParse(value)
  if (!parsed.success) throw invalidRequest('Responses 请求字段格式无效')
  const body = parsed.data
  if (
    body.store === true
    || body.previous_response_id != null
    || body.conversation != null
    || body.prompt != null
    || body.context_management != null
  )
    throw invalidRequest('Chat 转换不支持服务端会话、已存回复或压缩状态，请发送完整对话')
  if (body.n !== undefined && body.n !== 1) throw invalidRequest('Chat 转换只接受一个候选')
  const dropped = new Set<GatewayLoss>()
  if (body.prompt_cache_key !== undefined || body.prompt_cache_retention !== undefined) dropped.add('prompt-cache')
  if (body.logprobs || body.top_logprobs) dropped.add('logprobs')
  if (body.audio !== undefined) dropped.add('audio')
  if (body.text?.verbosity || body.service_tier || body.client_metadata || body.access_programs || body.stream_options)
    dropped.add('unsupported-options')
  const input: GatewayItem[] = []
  if (body.instructions != null) input.push({ type: 'message', role: 'system', content: [{ type: 'text', text: body.instructions }] })
  if (typeof body.input === 'string') input.push({ type: 'message', role: 'user', content: [{ type: 'text', text: body.input }] })
  else
    for (const raw of body.input ?? []) {
      const item = object(raw)
      if (!item) throw invalidRequest('Responses 输入条目格式无效')
      if (item.type === 'reasoning') {
        const sealed = typeof item.encrypted_content === 'string' ? openReasoning(item.encrypted_content) : undefined
        if (sealed !== undefined) input.push({ type: 'reasoning', text: sealed })
        else dropped.add('reasoning-state')
      } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        input.push({
          type: 'call',
          kind: item.type === 'custom_tool_call' ? 'custom' : 'function',
          name: name(item.name),
          ...(item.namespace != null ? { namespace: name(item.namespace) } : {}),
          id: name(item.call_id),
          arguments: requiredText(item.type === 'custom_tool_call' ? item.input : item.arguments, '工具输入'),
        })
      } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
        const parts = content(item.output, dropped)
        if (parts.some(part => part.type === 'image')) dropped.add('tool-image-location')
        input.push({ type: 'result', id: name(item.call_id), content: parts })
      } else if (item.type === 'message' || item.type === undefined) {
        if (!['system', 'developer', 'user', 'assistant'].includes(String(item.role))) throw invalidRequest('消息角色无法转换')
        const parts = content(item.content, dropped)
        if ((item.role === 'assistant' || item.role === 'system' || item.role === 'developer') && parts.some(part => part.type === 'image'))
          throw invalidRequest('Chat 转换只接受用户消息或工具结果中的图片')
        input.push({
          type: 'message',
          role: item.role === 'developer' ? 'system' : (item.role as 'system' | 'user' | 'assistant'),
          content: parts,
        })
      } else throw invalidRequest('这类 Responses 输入条目尚不能转换为 Chat')
    }
  if (!input.length) throw invalidRequest('请求没有可转换的消息')
  const tools = readTools(body.tools ?? [], dropped)
  if (tools.length > 1024) throw invalidRequest('工具过多')
  let choice: GatewayRequest['choice']
  if (body.tool_choice !== undefined) {
    if (body.tool_choice === 'auto' || body.tool_choice === 'none' || body.tool_choice === 'required') choice = body.tool_choice
    else {
      const named = object(body.tool_choice)
      if (!named || (named.type !== 'function' && named.type !== 'custom')) throw invalidRequest('这个工具选择不能转换为 Chat')
      choice = { kind: named.type, name: name(named.name), ...(named.namespace != null ? { namespace: name(named.namespace) } : {}) }
    }
    if (choice === 'required' && !tools.length) throw invalidRequest('没有可以强制调用的工具')
  }
  return {
    model: body.model,
    stream: body.stream === true,
    input,
    tools,
    ...(choice !== undefined ? { choice } : {}),
    ...(body.parallel_tool_calls !== undefined ? { parallel: body.parallel_tool_calls } : {}),
    ...(body.reasoning?.effort ? { effort: body.reasoning.effort } : {}),
    ...(body.max_output_tokens != null ? { maxOutput: body.max_output_tokens } : {}),
    ...(body.temperature != null ? { temperature: body.temperature } : {}),
    ...(body.top_p != null ? { topP: body.top_p } : {}),
    ...(body.text?.format ? { format: body.text.format } : {}),
    dropped: [...dropped],
  }
}

type Event = Record<string, unknown> & { type: string; sequence_number: number }
type OutputItem = Record<string, unknown> & { id: string; type: string }
interface PendingCall {
  index: number
  id: string
  name: string
  arguments: string
  output: number
}
const MAX_OUTPUT = 8 * 1024 * 1024

/** One response, retaining complete bounded items because Codex consumes output_item.done, not argument deltas. */
export class ResponsesOutput {
  private readonly id = `resp_${randomUUID()}`
  private readonly created = Math.floor(Date.now() / 1000)
  private sequence = 0
  private readonly items: OutputItem[] = []
  private readonly omitted = new Set<OutputItem>()
  private readonly calls = new Map<number, PendingCall>()
  private textItem?: OutputItem
  private thoughtItem?: OutputItem
  private text = ''
  private thought = ''
  private bytes = 0
  private stop?: Extract<GatewayDelta, { type: 'finish' }>['reason']
  private usage?: GatewayUsage
  private status: 'in_progress' | 'completed' | 'incomplete' | 'failed' = 'in_progress'
  private error?: { code: string; message: string }

  constructor(
    private readonly request: GatewayRequest,
    private readonly tools: ToolNames,
    private readonly seal: (text: string) => string,
    private readonly redact: (text: string) => string = text => text,
  ) {}

  private event(type: string, fields: Record<string, unknown> = {}): Event {
    return { type, sequence_number: this.sequence++, ...fields }
  }
  start(): Event[] {
    return [this.event('response.created', { response: this.result() }), this.event('response.in_progress', { response: this.result() })]
  }

  result(): Record<string, unknown> & { output: OutputItem[] } {
    const usage = this.usage
    return {
      id: this.id,
      object: 'response',
      created_at: this.created,
      status: this.status,
      model: this.request.model,
      output: this.items.filter(item => !this.omitted.has(item)).map(item => ({ ...item })),
      error: this.error ?? null,
      incomplete_details: this.status === 'incomplete' ? { reason: this.stop === 'length' ? 'max_output_tokens' : 'content_filter' } : null,
      usage: usage
        ? {
            input_tokens: usage.input,
            output_tokens: usage.output,
            total_tokens: usage.input + usage.output,
            ...(usage.cacheRead !== undefined || usage.cacheWrite !== undefined
              ? {
                  input_tokens_details: {
                    ...(usage.cacheRead !== undefined ? { cached_tokens: usage.cacheRead } : {}),
                    ...(usage.cacheWrite !== undefined ? { cache_write_tokens: usage.cacheWrite } : {}),
                  },
                }
              : {}),
            ...(usage.reasoning !== undefined ? { output_tokens_details: { reasoning_tokens: usage.reasoning } } : {}),
          }
        : null,
    }
  }

  push(delta: GatewayDelta): Event[] {
    if (delta.type === 'loss') return []
    if (this.status !== 'in_progress') throw invalidReply('模型在回复完成后继续发送内容')
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
    if (this.bytes > MAX_OUTPUT) throw invalidReply('模型回复超出转换大小限制')
    if (delta.type === 'tool') {
      let call = this.calls.get(delta.index)
      if (!call) {
        if (this.calls.size >= 128) throw invalidReply('模型请求的工具过多')
        call = { index: delta.index, id: '', name: '', arguments: '', output: this.items.length }
        this.calls.set(delta.index, call)
        this.items.push({ id: `fc_${randomUUID()}`, type: 'function_call' })
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
    const events: Event[] = []
    const thought = delta.type === 'reasoning'
    let item = thought ? this.thoughtItem : this.textItem
    if (!item) {
      item = thought
        ? { id: `rs_${randomUUID()}`, type: 'reasoning', summary: [] }
        : { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', status: 'in_progress', content: [] }
      this.items.push(item)
      if (thought) this.thoughtItem = item
      else this.textItem = item
      const output_index = this.items.indexOf(item)
      events.push(this.event('response.output_item.added', { output_index, item: { ...item } }))
      events.push(
        this.event(thought ? 'response.reasoning_summary_part.added' : 'response.content_part.added', {
          output_index,
          item_id: item.id,
          ...(thought
            ? { summary_index: 0, part: { type: 'summary_text', text: '' } }
            : { content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }),
        }),
      )
    }
    if (thought) this.thought += delta.text
    else this.text += delta.text
    if (this.thought.length > 1024 * 1024) throw invalidReply('模型思考超出回放大小限制')
    events.push(
      this.event(thought ? 'response.reasoning_summary_text.delta' : 'response.output_text.delta', {
        output_index: this.items.indexOf(item),
        item_id: item.id,
        ...(thought ? { summary_index: 0 } : { content_index: 0 }),
        delta: delta.text,
      }),
    )
    return events
  }

  finish(): Event[] {
    if (!this.stop || this.status !== 'in_progress') throw invalidReply('模型流没有完整结束')
    if ((this.stop === 'tools') !== this.calls.size > 0 && this.stop !== 'length' && this.stop !== 'filter')
      throw invalidReply('工具调用与模型结束状态不一致')
    const incomplete = this.stop === 'length' || this.stop === 'filter'
    if (incomplete) {
      // A syntactically complete prefix is still not authorization to execute a truncated reply's tool calls.
      for (const call of this.calls.values()) this.omitted.add(this.items[call.output]!)
      this.calls.clear()
    }
    const positions = [...this.calls.values()].map(call => call.output).sort((a, b) => a - b)
    for (const [index, call] of [...this.calls.values()].sort((a, b) => a.index - b.index).entries()) call.output = positions[index]!
    // Validate every call before publishing any executable done item.
    const ids = new Set<string>()
    for (const call of this.calls.values()) {
      if (!call.id || ids.has(call.id)) throw invalidReply('工具调用没有唯一 ID')
      ids.add(call.id)
      const tool = this.tools.called(call.name)
      safeToolIdentity(call.id, tool, this.redact)
      const { fields, json } = checkedArguments(call.arguments, this.redact)
      if (tool.kind === 'custom' && (typeof fields.content !== 'string' || Object.keys(fields).length !== 1))
        throw invalidReply('自定义工具必须只返回 content 文字')
      const item = this.items[call.output]!
      Object.assign(item, {
        type: tool.kind === 'custom' ? 'custom_tool_call' : 'function_call',
        call_id: call.id,
        name: tool.name,
        ...(tool.namespace ? { namespace: tool.namespace } : {}),
        ...(tool.kind === 'custom' ? { input: this.redact(fields.content as string) } : { arguments: json }),
        status: 'completed',
      })
    }
    this.status = incomplete ? 'incomplete' : 'completed'
    const events: Event[] = []
    for (const [output_index, item] of this.items.entries()) {
      if (this.omitted.has(item)) continue
      if (item === this.thoughtItem) {
        const part = { type: 'summary_text', text: this.thought }
        item.summary = [part]
        item.encrypted_content = this.seal(this.thought)
        events.push(
          this.event('response.reasoning_summary_text.done', { output_index, item_id: item.id, summary_index: 0, text: this.thought }),
        )
        events.push(this.event('response.reasoning_summary_part.done', { output_index, item_id: item.id, summary_index: 0, part }))
      } else if (item === this.textItem) {
        const part = { type: 'output_text', text: this.text, annotations: [] }
        item.content = [part]
        item.status = this.status === 'incomplete' ? 'incomplete' : 'completed'
        events.push(this.event('response.output_text.done', { output_index, item_id: item.id, content_index: 0, text: this.text }))
        events.push(this.event('response.content_part.done', { output_index, item_id: item.id, content_index: 0, part }))
      } else {
        const custom = item.type === 'custom_tool_call'
        const field = custom ? 'input' : 'arguments'
        const stem = custom ? 'response.custom_tool_call_input' : 'response.function_call_arguments'
        events.push(this.event('response.output_item.added', { output_index, item: { ...item, [field]: '', status: 'in_progress' } }))
        events.push(this.event(`${stem}.delta`, { output_index, item_id: item.id, call_id: item.call_id, delta: item[field] }))
        events.push(this.event(`${stem}.done`, { output_index, item_id: item.id, [field]: item[field] }))
      }
      events.push(this.event('response.output_item.done', { output_index, item: { ...item } }))
    }
    events.push(this.event(`response.${this.status}`, { response: this.result() }))
    return events
  }

  fail(message: string, code = 'gateway-upstream'): Event[] {
    this.status = 'failed'
    this.error = { code, message }
    return [this.event('response.failed', { response: this.result() })]
  }
}
