import { describe, expect, it } from 'vitest'
import type { ModelMessage } from '@latch/sdk'
import { anthropicWire } from '../src/plugins/providers/anthropic-wire.ts'
import { chatWire } from '../src/plugins/providers/chat-wire.ts'
import { responsesWire } from '../src/plugins/providers/responses-wire.ts'

const image = { type: 'image' as const, mimeType: 'image/png' as const, data: 'iVBORw0K' }
/** A step with two calls, the first of which returned a picture, then the model's next turn. */
const messages: ModelMessage[] = [
  { role: 'user', content: '看一眼' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [
      { id: 'call-1', name: 'browser_screenshot', arguments: {} },
      { id: 'call-2', name: 'browser_tabs', arguments: {} },
    ],
  },
  { role: 'tool', content: '截图', toolCallId: 'call-1', attachments: [image] },
  { role: 'tool', content: '- brw_x', toolCallId: 'call-2' },
]
const body = (wire: typeof chatWire) =>
  wire.request('https://models.invalid/v1', '', { model: 'm', messages, tools: [], signer: 'test' }).body as Record<string, any>

describe('a tool’s images on each protocol', () => {
  it('rides inside the tool result on the Messages API', () => {
    const wire = body(anthropicWire).messages as Array<{ role: string; content: Array<Record<string, any>> }>
    const results = wire.at(-1)!.content
    expect(results[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'call-1',
      content: [
        { type: 'text', text: '截图' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K' } },
      ],
    })
    expect(results[1]).toEqual({ type: 'tool_result', tool_use_id: 'call-2', content: '- brw_x' })
  })

  it('follows every result of the step in one user message that names the call, where results take text alone', () => {
    const chat = body(chatWire).messages as Array<Record<string, any>>
    expect(chat.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user'])
    expect(chat.at(-1)!.content).toEqual([
      { type: 'text', text: '[工具调用 call-1 返回的图片，不是用户发送的]' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0K' } },
    ])
    const responses = body(responsesWire).input as Array<Record<string, any>>
    expect(responses.map(item => item.type ?? item.role)).toEqual([
      'user',
      'function_call',
      'function_call',
      'function_call_output',
      'function_call_output',
      'user',
    ])
    expect(responses.at(-1)!.content[1]).toMatchObject({ type: 'input_image', image_url: 'data:image/png;base64,iVBORw0K' })
  })
})
