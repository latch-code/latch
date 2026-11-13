import { describe, expect, it } from 'vitest'
import { decodeAnthropic } from '../src/model-gateway/in/anthropic.ts'
import { encodeResponses } from '../src/model-gateway/out/responses.ts'
import { decodeResponsesReply, decodeResponsesStream } from '../src/model-gateway/out/responses-reply.ts'
import { AnthropicOutput } from '../src/model-gateway/in/anthropic.ts'
import { ReasoningSeals } from '../src/model-gateway/reasoning.ts'
import type { GatewayDelta } from '../src/model-gateway/ir.ts'
import { ModelGatewayServer, type GatewayService } from '../src/model-gateway.ts'
import { exactJson } from '../src/model-gateway/json.ts'

const base = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    model: 'service-model',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'hello' }],
    ...fields,
  })

describe('Anthropic to Responses history', () => {
  it('preserves parallel calls, exact arguments and images within their originating tool output', () => {
    const request = decodeAnthropic(
      base({
        system: 'first system',
        messages: [
          { role: 'user', content: 'inspect both' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'a', name: 'inspect', input: { key: 1 } },
              { type: 'tool_use', id: 'b', name: 'inspect', input: { key: 2 } },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'a',
                content: [
                  { type: 'text', text: 'image result' },
                  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
                ],
              },
              { type: 'tool_result', tool_use_id: 'b', is_error: true, content: 'missing' },
            ],
          },
          { role: 'system', content: 'later system' },
          { role: 'assistant', content: 'finished' },
          { role: 'user', content: 'continue' },
        ],
        tools: [{ name: 'inspect', input_schema: { type: 'object', properties: { key: { type: 'number' } } } }],
      }).replace('"key":1', '"key":9007199254740993'),
    )
    const encoded = encodeResponses(request).body
    expect(encoded).toMatchObject({ store: false, max_output_tokens: 1024, tools: [{ strict: false }] })
    const input = encoded.input as Array<Record<string, unknown>>
    expect(input.map(item => item.type ?? item.role)).toEqual([
      'system',
      'user',
      'function_call',
      'function_call',
      'function_call_output',
      'function_call_output',
      'system',
      'assistant',
      'user',
    ])
    expect(input[2]).toEqual({ type: 'function_call', call_id: 'a', name: 'inspect', arguments: '{"key":9007199254740993}' })
    expect(input[4]).toEqual({
      type: 'function_call_output',
      call_id: 'a',
      output: [
        { type: 'input_text', text: 'image result' },
        { type: 'input_image', image_url: 'data:image/png;base64,AA==' },
      ],
    })
    expect(input[5]?.output).toBe('[工具执行失败]\nmissing')
    expect(request.dropped).not.toContain('tool-image-location')
  })

  it('preserves output limits, explicit tool selection and native reasoning state without optional function item IDs', () => {
    const request = decodeAnthropic(
      base({
        tools: [{ name: 'file.read', input_schema: { type: 'object' } }],
        tool_choice: { type: 'tool', name: 'file.read', disable_parallel_tool_use: true },
        output_config: { effort: 'low', format: { type: 'json_schema', schema: { type: 'object' } } },
      }),
    )
    const state = { type: 'reasoning' as const, id: 'rs_1', encrypted_content: 'native-ciphertext', summary: [] }
    request.input.push({ type: 'reasoning', state: { wire: 'responses', item: state } })
    const { body, tools } = encodeResponses(request)
    expect(body).toMatchObject({
      reasoning: { effort: 'low', summary: 'auto' },
      tool_choice: { type: 'function', name: tools.all[0]!.wireName },
      parallel_tool_calls: false,
      text: { format: { type: 'json_schema', name: 'response', schema: { type: 'object' }, strict: true } },
    })
    expect((body.input as unknown[]).at(-1)).toEqual(state)
  })

  it('refuses unavailable stop control and readable Chat state', () => {
    const stopped = decodeAnthropic(base({ stop_sequences: ['stop'] }))
    expect(() => encodeResponses(stopped)).toThrow('不支持停止序列')
    const request = decodeAnthropic(base())
    request.input.push({ type: 'reasoning', state: { wire: 'chat-completions', text: 'thought' } })
    expect(() => encodeResponses(request)).toThrow('思考状态与上游协议不一致')
  })
})

const usage = {
  input_tokens: 12,
  output_tokens: 5,
  total_tokens: 17,
  input_tokens_details: { cached_tokens: 3 },
  output_tokens_details: { reasoning_tokens: 2 },
}
const nativeThought = {
  type: 'reasoning',
  id: 'rs_original',
  summary: [{ type: 'summary_text', text: 'summary' }],
  encrypted_content: 'opaque_ciphertext',
}
const nativeText = {
  type: 'message',
  id: 'msg_original',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: 'Hello 中文', annotations: [] }],
}
const nativeCall = {
  type: 'function_call',
  id: 'fc_original',
  call_id: 'call_original',
  name: 'inspect',
  arguments: '{"n":9007199254740993}',
  status: 'completed',
}
const response = (output: unknown[], fields: Record<string, unknown> = {}) => ({
  id: 'resp_original',
  status: 'completed',
  output,
  usage,
  ...fields,
})
const nativeEvents = (items: Array<Record<string, unknown>>, lateCiphertext = false): Array<Record<string, unknown>> => {
  const events: Array<Record<string, unknown>> = [
    { type: 'response.created', response: response([], { status: 'in_progress', usage: null }) },
  ]
  items.forEach((item, index) => {
    events.push({
      type: 'response.output_item.added',
      output_index: index,
      item: { ...item, ...(item.type === 'function_call' ? { arguments: '' } : {}) },
    })
    if (item.type === 'message')
      events.push({ type: 'response.output_text.delta', output_index: index, item_id: item.id, content_index: 0, delta: 'Hello ' })
    if (item.type === 'function_call')
      events.push({ type: 'response.function_call_arguments.delta', output_index: index, item_id: item.id, delta: '{"n":' })
    events.push({
      type: 'response.output_item.done',
      output_index: index,
      item: lateCiphertext && item.type === 'reasoning' ? { ...item, encrypted_content: null } : item,
    })
  })
  events.push({ type: 'response.completed', response: response(items) })
  return events.map((event, index) => ({ ...event, sequence_number: index }))
}
const stream = (events: unknown[], linger = false, onCancel = () => {}) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
      for (let index = 0; index < bytes.length; index++) controller.enqueue(bytes.slice(index, index + 1))
      if (!linger) controller.close()
    },
    cancel() {
      onCancel()
    },
  })
async function deltas(events: unknown[]): Promise<GatewayDelta[]> {
  const output: GatewayDelta[] = []
  for await (const delta of decodeResponsesStream(stream(events), new AbortController().signal)) output.push(delta)
  return output
}

describe('strict Responses upstream replies', () => {
  it.each([false, true])(
    'reconciles streamed prefixes and native reasoning, including ciphertext delayed until completed=%s',
    async late => {
      const decoded = await deltas(nativeEvents([nativeThought, nativeText, nativeCall], late))
      expect(decoded[0]).toEqual({ type: 'reasoning-state', state: { wire: 'responses', item: nativeThought } })
      expect(decoded.flatMap(delta => (delta.type === 'text' ? [delta.text] : [])).join('')).toBe('Hello 中文')
      expect(decoded.find(delta => delta.type === 'tool')).toEqual({
        type: 'tool',
        index: 2,
        id: 'call_original',
        name: 'inspect',
        arguments: '{"n":9007199254740993}',
      })
      expect(decoded.at(-2)).toEqual({ type: 'usage', usage: { input: 12, output: 5, cacheRead: 3, reasoning: 2 } })
      expect(decoded.at(-1)).toEqual({ type: 'finish', reason: 'tools' })
    },
  )

  it('completes at the terminal event and cancels a service that keeps the SSE connection open', async () => {
    let cancelled = false
    const decoded: GatewayDelta[] = []
    for await (const delta of decodeResponsesStream(
      stream(nativeEvents([nativeText]), true, () => {
        cancelled = true
      }),
      new AbortController().signal,
    ))
      decoded.push(delta)
    expect(decoded.at(-1)).toEqual({ type: 'finish', reason: 'stop' })
    expect(cancelled).toBe(true)
  })

  it.each([
    { usage: null },
    { usage: { ...usage, total_tokens: 20 } },
    { usage: { ...usage, input_tokens_details: { cached_tokens: 13 } } },
    { output: [{ ...nativeThought, encrypted_content: null }] },
    { output: [{ ...nativeThought, unknown_replay_state: 'must not silently drop' }] },
    { output: [{ ...nativeCall, namespace: 'unexpected' }] },
    { output: [{ ...nativeCall, caller: { type: 'program', caller_id: 'hidden' } }] },
    { output: [{ type: 'web_search_call', id: 'hosted' }] },
    { status: 'in_progress' },
  ])('refuses incomplete usage, unsupported state or execution: %j', fields => {
    expect(() => decodeResponsesReply(response([nativeText], fields))).toThrow()
  })

  it('refuses changed final text, reordered identities and a stream without completion', async () => {
    const changed = nativeEvents([nativeText])
    changed[3] = { ...changed[3], item: { ...nativeText, content: [{ type: 'output_text', text: 'different text', annotations: [] }] } }
    await expect(deltas(changed)).rejects.toThrow()
    const wrongId = nativeEvents([nativeCall])
    wrongId[2] = { ...wrongId[2], item_id: 'not-the-same-call' }
    await expect(deltas(wrongId)).rejects.toThrow()
    await expect(deltas(nativeEvents([nativeText]).slice(0, -1))).rejects.toThrow('完成前断开')
  })

  it('refuses message parts arriving out of order instead of rearranging already streamed text', async () => {
    const events = nativeEvents([nativeText])
    events[2] = { ...events[2], content_index: 1 }
    await expect(deltas(events)).rejects.toThrow('内容块顺序无效')
  })

  it.each(['max_output_tokens', 'content_filter'])('keeps %s incomplete without publishing executable Anthropic tools', reason => {
    const request = decodeAnthropic(base({ tools: [{ name: 'inspect', input_schema: { type: 'object' } }], tool_choice: { type: 'any' } }))
    const output = new AnthropicOutput(request, encodeResponses(request).tools, () => 'unused')
    for (const delta of decodeResponsesReply(
      response([{ ...nativeCall, arguments: '{', status: 'incomplete' }], { status: 'incomplete', incomplete_details: { reason } }),
    ))
      output.push(delta)
    const events = output.finish()
    expect(JSON.stringify(events)).not.toContain('"type":"tool_use"')
    expect(output.result().stop_reason).toBe(reason === 'max_output_tokens' ? 'max_tokens' : 'refusal')
  })

  it.each([true, false])('round-trips complete native thinking through Anthropic blocks (visible=%s)', visible => {
    const seals = new ReasoningSeals(),
      scope = { providerId: 'test', model: 'service-model', wire: 'responses' as const }
    const thought = {
      ...nativeThought,
      summary: visible ? nativeThought.summary : [],
      content: visible ? [{ type: 'reasoning_text', text: 'readable thought' }] : [],
    }
    const request = decodeAnthropic(base())
    const output = new AnthropicOutput(request, encodeResponses(request).tools, state => seals.seal(scope, state))
    for (const delta of decodeResponsesReply(response([thought, nativeText]))) output.push(delta)
    output.finish()
    const history = decodeAnthropic(
      base({
        messages: [
          { role: 'assistant', content: output.result().content },
          { role: 'user', content: 'continue' },
        ],
      }),
      value => seals.open(scope, value),
    )
    expect((encodeResponses(history).body.input as unknown[])[0]).toEqual(thought)
  })

  it('displays the available summary when native readable content is an empty list', () => {
    const request = decodeAnthropic(base())
    const output = new AnthropicOutput(request, encodeResponses(request).tools, () => 'test-signature')
    for (const delta of decodeResponsesReply(response([{ ...nativeThought, content: [] }]))) output.push(delta)
    output.finish()
    expect(output.result().content).toEqual([{ type: 'thinking', thinking: 'summary', signature: 'test-signature' }])
  })
})

describe('Anthropic to Responses over the loopback gateway', () => {
  async function fixture(replies: Array<{ body: unknown; stream?: boolean }>) {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const service: GatewayService = {
      kind: 'openai-responses',
      baseURL: 'https://responses.example.test/v1',
      apiKey: 'sk-test-native-response-key',
      models: ['service-model'],
      fingerprint: 'fixed-test-fingerprint',
    }
    const gateway = new ModelGatewayServer({
      service: () => service,
      fetchFor: () => async (url, init) => {
        calls.push({
          url: String(url),
          body: JSON.parse(Buffer.from(init!.body as Uint8Array).toString('utf8')) as Record<string, unknown>,
        })
        const next = replies[Math.min(calls.length - 1, replies.length - 1)]!
        return new Response(next.stream ? stream(next.body as unknown[]) : JSON.stringify(next.body), {
          headers: { 'content-type': next.stream ? 'text/event-stream' : 'application/json' },
        })
      },
      log: () => {},
    })
    await gateway.start()
    const lease = gateway.open({
      sessionId: 'test-session',
      route: {
        providerId: 'test',
        model: 'service-model',
        origin: 'https://responses.example.test:443',
        wire: 'anthropic-messages',
        upstream: 'responses',
      },
    })
    return {
      calls,
      service,
      post: (body: string) =>
        fetch(`${lease.baseURL}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': lease.token },
          body,
        }),
      close: async () => {
        lease.close()
        await gateway.close()
      },
    }
  }

  it('sends full native state and tool results back through a second HTTP request', async () => {
    const f = await fixture([{ body: response([nativeThought, nativeText, nativeCall]) }, { body: response([nativeText]) }])
    try {
      const tools = [{ name: 'inspect', input_schema: { type: 'object' } }]
      const first = await f.post(base({ tools }))
      expect(first.status).toBe(200)
      const message = exactJson(await first.text()) as { content: unknown[] }
      const next = await f.post(
        base({
          tools,
          messages: [
            { role: 'user', content: 'inspect' },
            { role: 'assistant', content: message.content },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_original', content: 'done' }] },
          ],
        }),
      )
      expect(next.status).toBe(200)
      expect(f.calls.every(call => call.url === 'https://responses.example.test/v1/responses')).toBe(true)
      expect(f.calls[1]?.body.input).toContainEqual(nativeThought)
      expect(f.calls[1]?.body.input).toContainEqual({
        type: 'function_call',
        call_id: 'call_original',
        name: 'inspect',
        arguments: '{"n":9007199254740993}',
      })
      expect(f.calls[1]?.body.input).toContainEqual({ type: 'function_call_output', call_id: 'call_original', output: 'done' })
    } finally {
      await f.close()
    }
  })

  it('refuses unavailable stop control before making an upstream request', async () => {
    const f = await fixture([{ body: response([nativeText]) }])
    try {
      const result = await f.post(base({ stop_sequences: ['must stop'] }))
      expect(result.status).toBe(400)
      expect(f.calls).toHaveLength(0)
    } finally {
      await f.close()
    }
  })

  it('never releases streamed tools when the final usage is missing', async () => {
    const events = nativeEvents([nativeCall])
    events[events.length - 1] = { ...events.at(-1), response: response([nativeCall], { usage: null }) }
    const f = await fixture([{ body: events, stream: true }])
    try {
      const result = await f.post(base({ stream: true, tools: [{ name: 'inspect', input_schema: { type: 'object' } }] }))
      const text = await result.text()
      expect(text).toContain('event: error')
      expect(text).not.toContain('"type":"tool_use"')
      expect(text).not.toContain('event: message_stop')
    } finally {
      await f.close()
    }
  })

  it('refuses a credential-bearing opaque state before exposing its envelope', async () => {
    const f = await fixture([{ body: response([{ ...nativeThought, encrypted_content: 'sk-test-native-response-key' }]) }])
    try {
      const result = await f.post(base())
      expect(result.status).toBe(502)
      const text = await result.text()
      expect(text).not.toContain(f.service.apiKey)
      expect(text).not.toContain('latch2.')
    } finally {
      await f.close()
    }
  })
})
