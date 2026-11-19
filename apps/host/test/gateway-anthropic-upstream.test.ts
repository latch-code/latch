import { describe, expect, it } from 'vitest'
import { ReasoningSeals } from '../src/model-gateway/reasoning.ts'
import { decodeResponses, ResponsesOutput } from '../src/model-gateway/in/responses.ts'
import { encodeChat } from '../src/model-gateway/out/chat.ts'
import { encodeAnthropic } from '../src/model-gateway/out/anthropic.ts'
import { decodeAnthropicReply, decodeAnthropicStream } from '../src/model-gateway/out/anthropic-reply.ts'
import { ModelGatewayServer, type GatewayService } from '../src/model-gateway.ts'
import { exactJson } from '../src/model-gateway/json.ts'
import type { GatewayDelta, GatewayReasoning } from '../src/model-gateway/ir.ts'

const scope = { providerId: 'native-anthropic', model: 'service-model', wire: 'anthropic-messages' as const }
const thought: GatewayReasoning = {
  wire: 'anthropic-messages',
  block: { type: 'thinking', thinking: 'original signed text', signature: 'native-signature' },
}
const hidden: GatewayReasoning = { wire: 'anthropic-messages', block: { type: 'redacted_thinking', data: 'native-hidden-state' } }

describe('native Anthropic reasoning in Responses output', () => {
  it.each([thought, hidden])('authenticates the entire native block without changing it', state => {
    const seals = new ReasoningSeals(),
      sealed = seals.seal(scope, state)
    expect(seals.open(scope, sealed)).toEqual(state)
    expect(seals.open({ ...scope, wire: 'responses' }, sealed)).toBeUndefined()
    expect(seals.open({ ...scope, model: 'other-model' }, sealed)).toBeUndefined()
  })

  it('rejects secret-bearing signed text rather than changing it under the original signature', () => {
    const seals = new ReasoningSeals()
    expect(() => seals.seal(scope, thought, text => text.replace('signed', '[redacted]'))).toThrow('包含敏感内容')
    expect(() => seals.seal(scope, hidden, text => text.replace('native-hidden-state', '[redacted]'))).toThrow('包含敏感内容')
  })

  it('preserves text block boundaries and native thinking positions around tools', () => {
    const request = decodeResponses({
      model: scope.model,
      input: 'inspect',
      tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }],
    })
    const seals = new ReasoningSeals(),
      output = new ResponsesOutput(request, encodeChat(request).tools, state => seals.seal(scope, state))
    output.start()
    output.push({ type: 'text', text: 'before' })
    output.push({ type: 'text-end' })
    output.push({ type: 'reasoning-state', state: thought })
    output.push({ type: 'text', text: 'first block' })
    output.push({ type: 'text-end' })
    output.push({ type: 'text', text: 'second block' })
    output.push({ type: 'text-end' })
    output.push({ type: 'reasoning-state', state: hidden })
    output.push({ type: 'tool', index: 5, id: 'toolu_native', name: 'read', arguments: '{"id":9007199254740993}' })
    output.push({ type: 'usage', usage: { input: 12, output: 5 } })
    output.push({ type: 'finish', reason: 'tools' })
    output.finish()
    const result = output.result()
    expect(result.output.map(item => item.type)).toEqual(['message', 'reasoning', 'message', 'message', 'reasoning', 'function_call'])
    expect(result.output.filter(item => item.type === 'message').map(item => item.content)).toEqual([
      [{ type: 'output_text', text: 'before', annotations: [] }],
      [{ type: 'output_text', text: 'first block', annotations: [] }],
      [{ type: 'output_text', text: 'second block', annotations: [] }],
    ])
    const native = result.output.filter(item => item.type === 'reasoning')
    expect(native.map(item => seals.open(scope, item.encrypted_content as string))).toEqual([thought, hidden])
    expect(native[1]?.summary).toEqual([])
    const replay = decodeResponses(
      { model: scope.model, input: [...result.output, { type: 'function_call_output', call_id: 'toolu_native', output: 'done' }] },
      value => seals.open(scope, value),
    )
    expect(replay.input.filter(item => item.type === 'reasoning').map(item => item.state)).toEqual([thought, hidden])
    expect(replay.input.at(-2)).toMatchObject({ type: 'call', arguments: '{"id":9007199254740993}' })
  })
})

const nativeUsage = { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 }
const nativeText = { type: 'text', text: 'Hello 中文' }
const nativeThinking = { type: 'thinking', thinking: 'native signed thought', signature: 'native.signature' }
const nativeHidden = { type: 'redacted_thinking', data: 'opaque.native.state' }
const nativeCall = {
  type: 'tool_use',
  id: 'toolu_1',
  name: 'inspect',
  input: exactJson('{"n":9007199254740993,"d":0.1234567890123456789,"z":-0}'),
}
const message = (content: unknown[], fields: Record<string, unknown> = {}) => ({
  type: 'message',
  id: 'msg_native',
  model: 'service-model',
  role: 'assistant',
  content,
  stop_reason: content.some(item => (item as { type: string }).type === 'tool_use') ? 'tool_use' : 'end_turn',
  stop_sequence: null,
  usage: nativeUsage,
  ...fields,
})
const events = (
  blocks: Array<Record<string, unknown>>,
  finish: string = blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
): Array<Record<string, unknown>> => {
  const result: Array<Record<string, unknown>> = [
    { type: 'message_start', message: message([], { stop_reason: null, usage: { ...nativeUsage, output_tokens: 0 } }) },
  ]
  blocks.forEach((block, index) => {
    const initial =
      block.type === 'text'
        ? { type: 'text', text: '' }
        : block.type === 'thinking'
          ? { type: 'thinking', thinking: '', signature: '' }
          : block.type === 'tool_use'
            ? { ...block, input: {} }
            : block
    result.push({ type: 'content_block_start', index, content_block: initial })
    const delta = (value: Record<string, unknown>) => result.push({ type: 'content_block_delta', index, delta: value })
    if (block.type === 'text') delta({ type: 'text_delta', text: block.text })
    else if (block.type === 'thinking') {
      delta({ type: 'thinking_delta', thinking: block.thinking })
      const signature = String(block.signature)
      delta({ type: 'signature_delta', signature: signature.slice(0, 4) })
      delta({ type: 'signature_delta', signature: signature.slice(4) })
    } else if (block.type === 'tool_use') {
      const args = JSON.stringify(block.input)
      delta({ type: 'input_json_delta', partial_json: args.slice(0, 8) })
      delta({ type: 'input_json_delta', partial_json: args.slice(8) })
    }
    result.push({ type: 'content_block_stop', index })
  })
  result.push(
    { type: 'message_delta', delta: { stop_reason: finish, stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  )
  return result
}
const stream = (values: unknown[], onCancel = () => {}, close = true) => {
  const bytes = new TextEncoder().encode(values.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''))
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset < bytes.length) {
        controller.enqueue(bytes.slice(offset, offset + 17))
        offset += 17
      } else if (close) controller.close()
    },
    cancel: onCancel,
  })
}
const collect = async (values: unknown[]) => {
  const output: GatewayDelta[] = []
  for await (const delta of decodeAnthropicStream(stream(values), new AbortController().signal)) output.push(delta)
  return output
}
const request = (fields: Record<string, unknown> = {}, openReasoning?: (value: string) => GatewayReasoning | undefined) =>
  decodeResponses(
    {
      model: 'service-model',
      input: 'inspect',
      tools: [{ type: 'function', name: 'inspect', parameters: { type: 'object' } }],
      ...fields,
    },
    openReasoning,
  )
const outputOf = (deltas: GatewayDelta[], fields: Record<string, unknown> = {}) => {
  const input = request(fields),
    seals = new ReasoningSeals()
  const output = new ResponsesOutput(input, encodeAnthropic(input).tools, state => seals.seal(scope, state))
  output.start()
  for (const delta of deltas) output.push(delta)
  output.finish()
  return { output: output.result(), seals }
}

describe('Responses to Anthropic encoding', () => {
  it('preserves native thinking, separate text blocks, parallel calls and images inside tool results', () => {
    const seals = new ReasoningSeals()
    const input = request(
      {
        instructions: 'initial system',
        input: [
          { role: 'user', content: 'inspect' },
          { type: 'reasoning', encrypted_content: seals.seal(scope, thought) },
          {
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'a' },
              { type: 'output_text', text: 'b' },
            ],
          },
          { type: 'function_call', call_id: 'one', name: 'inspect', arguments: '{"n":9007199254740993,"z":-0}' },
          { type: 'function_call', call_id: 'two', name: 'inspect', arguments: '{}' },
          {
            type: 'function_call_output',
            call_id: 'one',
            output: [
              { type: 'input_text', text: 'image' },
              { type: 'input_image', image_url: 'data:image/png;base64,AA==' },
            ],
          },
          { type: 'function_call_output', call_id: 'two', output: 'done' },
          { role: 'system', content: 'later system' },
          { role: 'user', content: 'continue' },
        ],
      },
      value => seals.open(scope, value),
    )
    const body = encodeAnthropic(input).body
    expect(body.system).toEqual([{ type: 'text', text: 'initial system' }])
    const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
    expect(messages.map(item => item.role)).toEqual(['user', 'assistant', 'user', 'system', 'user'])
    expect(messages[1]?.content.map(block => block.type)).toEqual(['thinking', 'text', 'text', 'tool_use', 'tool_use'])
    expect(messages[1]?.content[0]).toEqual(thought.wire === 'anthropic-messages' ? thought.block : undefined)
    expect(JSON.stringify(messages[1]?.content[3])).toContain('"input":{"n":9007199254740993,"z":-0}')
    expect(messages[2]?.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'one',
      content: [
        { type: 'text', text: 'image' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
      ],
    })
    expect(input.dropped).not.toContain('tool-image-location')
  })

  it('maps declared effort, output schema, exact numeric schema tokens and custom/namespaced tool identities', () => {
    const source =
      '{"model":"service-model","input":"edit","max_output_tokens":1234,"temperature":0.4,"top_p":0.7,"reasoning":{"effort":"high"},"parallel_tool_calls":false,"tool_choice":{"type":"custom","name":"patch","namespace":"files"},"tools":[{"type":"namespace","name":"files","tools":[{"type":"custom","name":"patch"}]},{"type":"function","name":"inspect","parameters":{"type":"object","properties":{"n":{"const":9007199254740993}}}}],"text":{"format":{"type":"json_schema","name":"answer","schema":{"type":"object","properties":{"d":{"const":0.1234567890123456789}}}}}}'
    const input = decodeResponses(JSON.parse(source), undefined, source)
    const { body, tools } = encodeAnthropic(input)
    expect(body).toMatchObject({
      max_tokens: 1234,
      temperature: 0.4,
      top_p: 0.7,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema' } },
      tool_choice: { type: 'tool', name: tools.all[0]?.wireName, disable_parallel_tool_use: true },
    })
    expect(JSON.stringify(body)).toContain('"const":9007199254740993')
    expect(JSON.stringify(body)).toContain('"const":0.1234567890123456789')
    expect((body.tools as Array<Record<string, unknown>>)[0]?.input_schema).toEqual({
      type: 'object',
      properties: { content: { type: 'string' } },
      required: ['content'],
      additionalProperties: false,
    })
  })

  it('uses a bounded output default, preserves none and refuses options without a faithful mapping', () => {
    expect(encodeAnthropic(request({ reasoning: { effort: 'none' }, tool_choice: 'none', parallel_tool_calls: false })).body).toMatchObject(
      { max_tokens: 8192, thinking: { type: 'disabled' }, tool_choice: { type: 'none' } },
    )
    expect(encodeAnthropic(request({ tools: [] })).body).not.toHaveProperty('tool_choice')
    expect(() => encodeAnthropic(request({ temperature: 1.1 }))).toThrow('不能超过 1')
    expect(() => encodeAnthropic(request({ text: { format: { type: 'json_object' } } }))).toThrow('不能转换')
    const input = request()
    input.input.push({ type: 'reasoning', state: { wire: 'chat-completions', text: 'not native' } })
    expect(() => encodeAnthropic(input)).toThrow('思考状态与上游协议不一致')
  })

  it('marks the system text and the conversation’s end for Anthropic’s cache when the harness asked for caching', () => {
    const conversation = {
      instructions: 'stable instructions',
      input: [
        { role: 'user', content: 'inspect' },
        { type: 'reasoning', encrypted_content: 'not ours' },
        { type: 'function_call', call_id: 'one', name: 'inspect', arguments: '{}' },
        { type: 'function_call_output', call_id: 'one', output: 'done' },
      ],
    }
    const asked = request({ ...conversation, prompt_cache_key: 'thread-1' })
    const { body } = encodeAnthropic(asked)
    expect(body.system).toEqual([{ type: 'text', text: 'stable instructions', cache_control: { type: 'ephemeral' } }])
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>
    expect(messages.at(-1)!.content.at(-1)).toMatchObject({ type: 'tool_result', cache_control: { type: 'ephemeral' } })
    expect(JSON.stringify(body).match(/cache_control/gu)).toHaveLength(2)
    // What the key asked for is done, so the turn records no loss of it; the replay it could not open still is one.
    expect(asked.dropped).toEqual(['reasoning-state'])
    // The next request moves the conversation's mark forward and leaves the system's where it was.
    const next = encodeAnthropic(
      request({
        ...conversation,
        input: [...conversation.input, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'again' }],
        prompt_cache_key: 'thread-1',
      }),
    ).body.messages as Array<{ content: Array<Record<string, unknown>> }>
    expect(next.at(-1)!.content.at(-1)).toEqual({ type: 'text', text: 'again', cache_control: { type: 'ephemeral' } })
    expect(next[2]!.content.at(-1)).toEqual({ type: 'tool_result', tool_use_id: 'one', content: [{ type: 'text', text: 'done' }] })
    // How long to keep it has no Anthropic counterpart that means the same: that much is still lost.
    const kept = request({ ...conversation, prompt_cache_key: 'thread-1', prompt_cache_retention: '24h' })
    encodeAnthropic(kept)
    expect(kept.dropped).toContain('prompt-cache')
    // Without the key nothing is marked: the harness did not ask the service to keep anything.
    expect(JSON.stringify(encodeAnthropic(request(conversation)).body)).not.toContain('cache_control')
  })
})

describe('native Anthropic reply decoding', () => {
  it('matches streaming and nonstreaming UTF-8, exact tool numbers, native blocks and cache-inclusive usage', async () => {
    const blocks = [nativeThinking, nativeText, { type: 'text', text: '' }, nativeHidden, nativeCall]
    const direct = decodeAnthropicReply(JSON.stringify(message(blocks)))
    const streamed = await collect(events(blocks))
    expect(streamed).toEqual(direct)
    const { output, seals } = outputOf(streamed)
    expect(output.output.map(item => item.type)).toEqual(['reasoning', 'message', 'message', 'reasoning', 'function_call'])
    expect(output.output[2]?.content).toEqual([{ type: 'output_text', text: '', annotations: [] }])
    expect(output.output.at(-1)?.arguments).toBe('{"n":9007199254740993,"d":0.1234567890123456789,"z":-0}')
    expect(seals.open(scope, String(output.output[0]?.encrypted_content))).toEqual({ wire: 'anthropic-messages', block: nativeThinking })
    expect(seals.open(scope, String(output.output[3]?.encrypted_content))).toEqual({ wire: 'anthropic-messages', block: nativeHidden })
    expect(output.usage).toEqual({
      input_tokens: 9,
      output_tokens: 5,
      total_tokens: 14,
      input_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 },
    })
  })

  it.each(['max_tokens', 'model_context_window_exceeded', 'refusal'])('keeps %s incomplete and withholds all tools', async stop => {
    const deltas = await collect(events([nativeCall], stop))
    const { output } = outputOf(deltas, { tool_choice: 'required' })
    expect(output.status).toBe('incomplete')
    expect(output.output).toEqual([])
  })

  it.each(['server_tool_use', 'web_search_tool_result', 'unknown'])('refuses %s instead of pretending it is a local tool', async type => {
    await expect(collect(events([{ ...nativeCall, type }]))).rejects.toThrow('尚不能转换')
    expect(() => decodeAnthropicReply(JSON.stringify(message([{ ...nativeCall, type }])))).toThrow('尚不能转换')
  })

  it.each(['missing-usage', 'decreasing-usage', 'missing-stop', 'wrong-index', 'wrong-delta', 'pause-turn', 'duplicate-start'])(
    'rejects %s before publishing executable tools',
    async failure => {
      const input = events([nativeCall])
      if (failure === 'missing-usage') delete input[input.length - 2]!.usage
      if (failure === 'decreasing-usage') input[input.length - 2]!.usage = { output_tokens: 5, input_tokens: 1 }
      if (failure === 'missing-stop') input.pop()
      if (failure === 'wrong-index') input[2]!.index = 1
      if (failure === 'wrong-delta') input[2]!.delta = { type: 'thinking_delta', thinking: 'wrong' }
      if (failure === 'pause-turn') input[input.length - 2]!.delta = { stop_reason: 'pause_turn' }
      if (failure === 'duplicate-start') input.splice(1, 0, input[0]!)
      await expect(collect(input)).rejects.toThrow()
    },
  )

  it('requires complete signatures for normal completion and rejects signed text changed after its signature', async () => {
    await expect(collect(events([{ ...nativeThinking, signature: '' }, nativeCall]))).rejects.toThrow('缺少原生思考签名')
    const input = events([nativeThinking])
    input.splice(5, 0, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'late' } })
    await expect(collect(input)).rejects.toThrow('签名之后')
    const incomplete = await collect(events([{ ...nativeThinking, signature: '' }], 'max_tokens'))
    expect(incomplete).toContainEqual({ type: 'loss', loss: 'reasoning-state' })
  })

  it.each([
    { ...nativeUsage, output_tokens: -1 },
    { ...nativeUsage, output_tokens: 0.5 },
    { ...nativeUsage, input_tokens: Number.MAX_SAFE_INTEGER },
    { ...nativeUsage, output_tokens: Number.MAX_SAFE_INTEGER },
  ])('rejects invalid or overflowing native usage $input_tokens/$output_tokens', usage => {
    expect(() => decodeAnthropicReply(JSON.stringify(message([nativeCall], { usage })))).toThrow()
  })

  it('cancels a lingering upstream at message_stop and propagates a caller abort', async () => {
    let cancelled = false
    const deltas: GatewayDelta[] = []
    for await (const delta of decodeAnthropicStream(
      stream(
        events([nativeText]),
        () => {
          cancelled = true
        },
        false,
      ),
      new AbortController().signal,
    ))
      deltas.push(delta)
    expect(cancelled).toBe(true)
    expect(deltas.at(-1)).toEqual({ type: 'finish', reason: 'stop' })
    const controller = new AbortController()
    controller.abort()
    await expect(async () => {
      for await (const _ of decodeAnthropicStream(stream(events([nativeText])), controller.signal)) {
        /* Aborted before a frame. */
      }
    }).rejects.toThrow()
  })
})

describe('Responses to Anthropic gateway HTTP', () => {
  async function fixture(replies: Array<{ body: string | unknown[]; stream?: boolean }>) {
    const calls: Array<{ url: string; body: string; headers: Headers }> = []
    const service: GatewayService = {
      kind: 'anthropic',
      baseURL: 'https://anthropic.example.test',
      apiKey: 'sk-test-native-anthropic-key',
      models: ['service-model'],
      fingerprint: 'fixed-fingerprint',
    }
    const gateway = new ModelGatewayServer({
      service: () => service,
      fetchFor: () => async (url, init) => {
        calls.push({ url: String(url), body: Buffer.from(init!.body as Uint8Array).toString('utf8'), headers: new Headers(init!.headers) })
        const next = replies[Math.min(calls.length - 1, replies.length - 1)]!
        return new Response(next.stream ? stream(next.body as unknown[]) : (next.body as string), {
          headers: { 'content-type': next.stream ? 'text/event-stream' : 'application/json' },
        })
      },
      log: () => {},
    })
    await gateway.start()
    try {
      const lease = gateway.open({
        sessionId: 'test',
        route: {
          providerId: 'test',
          model: 'service-model',
          origin: 'https://anthropic.example.test:443',
          wire: 'responses',
          upstream: 'anthropic-messages',
        },
      })
      return {
        calls,
        service,
        post: (fields: Record<string, unknown>) =>
          fetch(`${lease.baseURL}/responses`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${lease.token}` },
            body: JSON.stringify({
              model: 'service-model',
              input: 'inspect',
              tools: [{ type: 'function', name: 'inspect', parameters: { type: 'object' } }],
              ...fields,
            }),
          }),
        close: async () => {
          lease.close()
          await gateway.close()
        },
      }
    } catch (error) {
      await gateway.close()
      throw error
    }
  }

  it('round trips native thinking and full tool history through real HTTP with the service credential and pinned version', async () => {
    const f = await fixture([
      { body: JSON.stringify(message([nativeThinking, nativeText, nativeHidden, nativeCall])) },
      { body: JSON.stringify(message([nativeText])) },
    ])
    try {
      const first = await f.post({})
      expect(first.status).toBe(200)
      const reply = (await first.json()) as { output: unknown[] }
      const next = await f.post({
        input: [
          { role: 'user', content: 'inspect' },
          ...reply.output,
          { type: 'function_call_output', call_id: 'toolu_1', output: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }] },
        ],
      })
      expect(next.status).toBe(200)
      expect(f.calls.every(call => call.url === 'https://anthropic.example.test/v1/messages')).toBe(true)
      expect(f.calls[0]?.headers.get('x-api-key')).toBe(f.service.apiKey)
      expect(f.calls[0]?.headers.get('anthropic-version')).toBe('2023-06-01')
      expect(f.calls[0]?.headers.get('authorization')).toBeNull()
      const replay = JSON.parse(f.calls[1]!.body) as { messages: Array<{ content: unknown[] }> }
      expect(replay.messages[1]?.content).toEqual([nativeThinking, nativeText, nativeHidden, JSON.parse(JSON.stringify(nativeCall))])
      expect(f.calls[1]!.body).toContain('"n":9007199254740993')
      expect(replay.messages[2]?.content).toEqual([
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }],
        },
      ])
    } finally {
      await f.close()
    }
  })

  it('rejects unmappable input before upstream IO and never releases a tool without terminal usage', async () => {
    const values = events([nativeCall])
    delete values[values.length - 2]!.usage
    const f = await fixture([{ body: values, stream: true }])
    try {
      expect((await f.post({ temperature: 1.5 })).status).toBe(400)
      expect(f.calls).toHaveLength(0)
      const reply = await f.post({ stream: true })
      const text = await reply.text()
      expect(text).toContain('event: response.failed')
      expect(text).not.toContain('event: response.completed')
      expect(text).not.toContain('event: response.function_call_arguments.done')
    } finally {
      await f.close()
    }
  })

  it('refuses a structured-output request with no schema before upstream IO', async () => {
    const f = await fixture([{ body: JSON.stringify(message([nativeText])) }])
    try {
      expect((await f.post({ text: { format: { type: 'json_schema', name: 'missing-schema' } } })).status).toBe(400)
      expect(f.calls).toHaveLength(0)
    } finally {
      await f.close()
    }
  })

  it('refuses secret-bearing native signatures and signed plaintext before exposing a seal', async () => {
    for (const field of ['thinking', 'signature', 'data']) {
      const block =
        field === 'data'
          ? { ...nativeHidden, data: 'sk-test-native-anthropic-key' }
          : { ...nativeThinking, [field]: 'sk-test-native-anthropic-key' }
      const f = await fixture([{ body: JSON.stringify(message([block, nativeCall])) }])
      try {
        const reply = await f.post({})
        expect(reply.status).toBe(502)
        const text = await reply.text()
        expect(text).not.toContain(f.service.apiKey)
        expect(text).not.toContain('latch2.')
      } finally {
        await f.close()
      }
    }
  })

  it.each(['none', 'named-without-call', 'parallel', 'unknown-tool', 'duplicate-id', 'nonfinite-argument'])(
    'withholds the entire executable group for %s',
    async failure => {
      const blocks =
        failure === 'named-without-call'
          ? [nativeText]
          : failure === 'unknown-tool'
            ? [nativeCall, { ...nativeCall, id: 'toolu_2', name: 'unoffered' }]
            : failure === 'parallel'
              ? [nativeCall, { ...nativeCall, id: 'toolu_2' }]
              : failure === 'duplicate-id'
                ? [nativeCall, nativeCall]
                : [nativeCall]
      const values = events(blocks)
      if (failure === 'nonfinite-argument') {
        values[2]!.delta = { type: 'input_json_delta', partial_json: '{"n":1e400}' }
        values[3]!.delta = { type: 'input_json_delta', partial_json: '' }
      }
      const f = await fixture([{ body: values, stream: true }])
      try {
        const reply = await f.post({
          stream: true,
          ...(failure === 'none' ? { tool_choice: 'none' } : {}),
          ...(failure === 'named-without-call' ? { tool_choice: { type: 'function', name: 'inspect' } } : {}),
          ...(failure === 'parallel' ? { parallel_tool_calls: false } : {}),
        })
        const text = await reply.text()
        expect(text).toContain('event: response.failed')
        expect(text).not.toContain('event: response.function_call_arguments.done')
        expect(text).not.toContain('event: response.completed')
      } finally {
        await f.close()
      }
    },
  )
})
