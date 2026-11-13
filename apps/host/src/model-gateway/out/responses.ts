import { invalidRequest, type Content, type GatewayRequest } from '../ir.ts'
import { ToolNames } from '../tools.ts'

const inputContent = (parts: Content[]) =>
  parts.map(part =>
    part.type === 'text'
      ? { type: 'input_text', text: part.text }
      : { type: 'input_image', image_url: part.url, ...(part.detail ? { detail: part.detail } : {}) },
  )

/** Stateless full history, including native reasoning items and tool-result images in their original positions. */
export function encodeResponses(request: GatewayRequest): { body: Record<string, unknown>; tools: ToolNames } {
  if (request.stop?.length) throw invalidRequest('Responses 协议不支持停止序列，Latch 没有转发')
  const tools = new ToolNames(
    request.tools,
    request.input.flatMap(item => (item.type === 'call' ? [item] : [])),
  )
  const input = request.input.map(item => {
    if (item.type === 'reasoning') {
      if (item.state.wire !== 'responses') throw invalidRequest('思考状态与上游协议不一致')
      return item.state.item
    }
    if (item.type === 'call')
      return {
        type: 'function_call',
        call_id: item.id,
        name: tools.name(item),
        arguments: item.kind === 'custom' ? JSON.stringify({ content: item.arguments }) : item.arguments,
      }
    if (item.type === 'result')
      return {
        type: 'function_call_output',
        call_id: item.id,
        output: item.content.every(part => part.type === 'text')
          ? item.content.map(part => part.text).join('')
          : inputContent(item.content),
      }
    return {
      role: item.role,
      content:
        item.role === 'assistant'
          ? item.content.map(part => {
              if (part.type !== 'text') throw invalidRequest('助手图片不能转换为 Responses')
              return { type: 'output_text', text: part.text }
            })
          : inputContent(item.content),
    }
  })
  if (request.format && !['json_schema', 'json_object', 'text'].includes(String(request.format.type)))
    throw invalidRequest('这个结构化输出格式不能转换为 Responses')
  return {
    tools,
    body: {
      model: request.model,
      stream: request.stream,
      store: false,
      input,
      include: ['reasoning.encrypted_content'],
      ...(request.effort ? { reasoning: { effort: request.effort, summary: 'auto' } } : {}),
      ...(request.maxOutput !== undefined ? { max_output_tokens: request.maxOutput } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.topP !== undefined ? { top_p: request.topP } : {}),
      ...(request.format ? { text: { format: request.format } } : {}),
      ...(request.parallel !== undefined ? { parallel_tool_calls: request.parallel } : {}),
      ...(request.choice !== undefined
        ? { tool_choice: typeof request.choice === 'string' ? request.choice : { type: 'function', name: tools.name(request.choice) } }
        : {}),
      ...(tools.all.length
        ? {
            tools: tools.all.map(tool => ({
              type: 'function',
              name: tool.wireName,
              ...(tool.description !== undefined ? { description: tool.description } : {}),
              parameters:
                tool.kind === 'custom'
                  ? { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false }
                  : tool.parameters,
              // Responses may normalize an omitted strict mode by rewriting the caller's tool schema.
              strict: tool.strict ?? false,
            })),
          }
        : {}),
    },
  }
}
