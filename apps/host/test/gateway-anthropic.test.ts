import { describe, expect, it } from 'vitest'
import { decodeAnthropic, AnthropicOutput } from '../src/model-gateway/in/anthropic.ts'
import { encodeChat } from '../src/model-gateway/out/chat.ts'
import { checkedArguments, exactJson } from '../src/model-gateway/json.ts'
import { ReasoningSeals } from '../src/model-gateway/reasoning.ts'
import { ModelGatewayServer, type GatewayService } from '../src/model-gateway.ts'
import { ResponsesOutput } from '../src/model-gateway/in/responses.ts'

const base = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({ model: 'alias', max_tokens: 1024, stream: true, messages: [{ role: 'user', content: 'hello' }], ...fields })
const tool = { name: 'inspect', input_schema: { type: 'object', properties: {} } }
const usage = { input: 12, output: 5, cacheRead: 3 }
const scope = { providerId: 'service', model: 'alias' }

describe('Anthropic to Chat translation', () => {
  it('maps invalid client numbers and deeply nested tool input to HTTP 400 without contacting the service', async () => {
    const service: GatewayService = {
      kind: 'openai-compatible',
      baseURL: 'https://model.example/v1',
      apiKey: 'private-key-value',
      models: ['alias'],
      fingerprint: 'one',
    }
    let requests = 0
    const server = new ModelGatewayServer({
      service: () => service,
      log: () => {},
      fetchFor: () => async () => {
        requests++
        return Response.json({})
      },
    })
    await server.start()
    try {
      const lease = server.open({
        sessionId: 'task',
        route: {
          providerId: 'service',
          model: 'alias',
          wire: 'anthropic-messages',
          upstream: 'chat-completions',
          origin: 'https://model.example:443',
        },
      })
      const history = base({
        tools: [tool],
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'inspect', input: { value: 'RAW' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'done' }] },
        ],
      })
      for (const value of ['1e400', `${'['.repeat(66)}0${']'.repeat(66)}`]) {
        const response = await fetch(`${lease.baseURL}/v1/messages`, {
          method: 'POST',
          headers: { authorization: `Bearer ${lease.token}` },
          body: history.replace('"RAW"', value),
        })
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } })
      }
      expect(requests).toBe(0)
      expect(lease.takeTurn().models[0]).toMatchObject({ requests: 2, failed: 2 })
    } finally {
      await server.close()
    }
  })

  it('keeps full tool history, grouped images, tool choice, stop sequences and precise input numbers', () => {
    const source = base({
      system: [{ type: 'text', text: 'instructions', cache_control: { type: 'ephemeral' } }],
      tools: [tool],
      tool_choice: { type: 'tool', name: 'inspect', disable_parallel_tool_use: true },
      stop_sequences: ['END'],
      output_config: { effort: 'low' },
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'a', name: 'inspect', input: { value: 'NUMBER' } },
            { type: 'tool_use', id: 'b', name: 'inspect', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'a',
              is_error: true,
              content: [
                { type: 'text', text: 'read failed' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
              ],
            },
            { type: 'tool_result', tool_use_id: 'b', content: 'done' },
          ],
        },
      ],
    }).replace('"NUMBER"', '9007199254740993')
    const decoded = decodeAnthropic(source)
    const encoded = encodeChat(decoded).body
    expect(JSON.stringify(encoded)).toContain('9007199254740993')
    expect(encoded).toMatchObject({
      stop: ['END'],
      reasoning_effort: 'low',
      parallel_tool_calls: false,
      tool_choice: { type: 'function', function: { name: 'inspect' } },
    })
    expect((encoded.messages as Array<{ role: string }>).map(message => message.role)).toEqual([
      'system',
      'assistant',
      'tool',
      'tool',
      'user',
    ])
    expect(JSON.stringify(encoded)).toContain('[工具执行失败]')
    expect(decoded.dropped).toEqual(['prompt-cache', 'tool-image-location'])
  })

  it.each([
    { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'x' }] }] },
    { messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'inspect', input: {} }] }] },
    { messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', data: 'AA==' } }] }] },
    { messages: [{ role: 'assistant', content: [{ type: 'server_tool_use', id: 'server', name: 'shell', input: {} }] }] },
    { tools: [{ type: 'web_search_20250305', name: 'web_search' }] },
    { context_management: { edits: [] } },
    { container: 'container-id' },
    { thinking: { type: 'adaptive', display: 'omitted' } },
  ])('refuses unsupported or incomplete history before forwarding: %j', fields => {
    expect(() => decodeAnthropic(base(fields))).toThrow()
  })

  it('authenticates thinking replay and records foreign signatures as loss', () => {
    const seals = new ReasoningSeals()
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'tampered text', signature: seals.seal(scope, 'original') },
          { type: 'text', text: 'answer' },
        ],
      },
    ]
    expect(decodeAnthropic(base({ messages }), text => seals.open(scope, text)).input[0]).toEqual({ type: 'reasoning', text: 'original' })
    const stale = decodeAnthropic(base({ messages }), text => seals.open({ ...scope, model: 'other' }, text))
    expect(stale.dropped).toContain('reasoning-state')
    expect(stale.input).toHaveLength(1)
  })

  it('retains numeric tokens through object-valued JSON and safely redacts only string tokens', () => {
    const source = '{"big":9007199254740993,"decimal":0.123456789012345678901,"negativeZero":-0,"text":"secret"}'
    const checked = checkedArguments(source, value => value.replaceAll('secret', '[redacted]'))
    expect(JSON.stringify(exactJson(checked.json))).toBe(source.replace('secret', '[redacted]'))
    expect(() => checkedArguments('{"a":1e400}', value => value)).toThrow()
    expect(() => checkedArguments('{"secret":1,"[redacted]":2}', value => value.replaceAll('secret', '[redacted]'))).toThrow()
  })

  it.each([AnthropicOutput, ResponsesOutput])('refuses executable identities that redaction would change', Output => {
    const request = decodeAnthropic(base({ tools: [tool] }))
    const output = new Output(
      request,
      encodeChat(request).tools,
      text => text,
      text => text.replaceAll('secret', '[redacted]'),
    )
    output.push({ type: 'tool', index: 0, id: 'secret', name: 'inspect', arguments: '{}' })
    output.push({ type: 'usage', usage })
    output.push({ type: 'finish', reason: 'tools' })
    expect(() => output.finish()).toThrow('工具调用标识包含敏感内容')
  })

  it('streams text and signed thinking, then emits all verified calls and late usage', () => {
    const request = decodeAnthropic(base({ tools: [tool] }))
    const seals = new ReasoningSeals()
    const output = new AnthropicOutput(request, encodeChat(request).tools, text => seals.seal(scope, text))
    const events = output.start()
    events.push(...output.push({ type: 'reasoning', text: 'thought' }), ...output.push({ type: 'text', text: '你好' }))
    output.push({ type: 'tool', index: 1, id: 'b', name: 'inspect', arguments: '{}' })
    output.push({ type: 'tool', index: 0, id: 'a', name: 'inspect', arguments: '{"big":9007199254740993}' })
    expect(events.some(event => (event.content_block as { type?: string } | undefined)?.type === 'tool_use')).toBe(false)
    output.push({ type: 'finish', reason: 'tools' })
    output.push({ type: 'usage', usage })
    events.push(...output.finish())
    expect((events[0]!.message as { content: unknown[] }).content).toEqual([])
    expect(events.at(-1)?.type).toBe('message_stop')
    const result = output.result() as { content: Array<Record<string, unknown>>; stop_reason: string; usage: unknown }
    expect(result.stop_reason).toBe('tool_use')
    expect(result.usage).toEqual({ input_tokens: 9, output_tokens: 5, cache_read_input_tokens: 3 })
    expect(result.content.filter(item => item.type === 'tool_use').map(item => item.id)).toEqual(['a', 'b'])
    expect(JSON.stringify(result)).toContain('9007199254740993')
    expect(seals.open(scope, result.content[0]!.signature as string)).toBe('thought')
  })

  it.each(['malformed', 'missing-usage', 'duplicate-id', 'changed-id', 'length', 'filter'] as const)(
    'never emits executable tools for an unverified reply (%s)',
    scenario => {
      const request = decodeAnthropic(base({ tools: [tool] }))
      const output = new AnthropicOutput(request, encodeChat(request).tools, text => text)
      output.push({ type: 'tool', index: 0, id: 'a', name: 'inspect', arguments: scenario === 'malformed' ? '{' : '{}' })
      if (scenario === 'changed-id') {
        expect(() => output.push({ type: 'tool', index: 0, id: 'b' })).toThrow()
        return
      }
      if (scenario === 'duplicate-id') output.push({ type: 'tool', index: 1, id: 'a', name: 'inspect', arguments: '{}' })
      output.push({ type: 'finish', reason: scenario === 'length' || scenario === 'filter' ? scenario : 'tools' })
      if (scenario !== 'missing-usage') output.push({ type: 'usage', usage })
      if (scenario === 'length' || scenario === 'filter') expect(JSON.stringify(output.finish())).not.toContain('tool_use')
      else expect(() => output.finish()).toThrow()
      expect(output.result().content as unknown[]).toHaveLength(0)
    },
  )

  it.each([false, true])('converts the HTTP response, scrubs escaped credentials and retains numbers (stream=%s)', async stream => {
    const key = 'private"value\\path'
    const service: GatewayService = {
      kind: 'openai-compatible',
      baseURL: 'https://model.example/v1',
      apiKey: key,
      models: ['alias'],
      fingerprint: 'one',
    }
    const args = `{"big":9007199254740993,"key":${JSON.stringify(key)}}`
    const call = { id: 'call', type: 'function', function: { name: 'inspect', arguments: args } }
    let destination = ''
    let authorization = ''
    const server = new ModelGatewayServer({
      service: () => service,
      log: () => {},
      fetchFor: () => async (input, init) => {
        destination = String(input)
        authorization = new Headers(init?.headers).get('authorization') ?? ''
        const usage = { prompt_tokens: 12, completion_tokens: 5 }
        return stream
          ? new Response(
              [
                { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...call }] }, finish_reason: 'tool_calls' }] },
                { choices: [], usage },
              ]
                .map(item => `data: ${JSON.stringify(item)}\n\n`)
                .join('') + 'data: [DONE]\n\n',
              { headers: { 'content-type': 'text/event-stream' } },
            )
          : Response.json({
              choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }],
              usage,
            })
      },
    })
    await server.start()
    try {
      const lease = server.open({
        sessionId: 'task',
        route: {
          providerId: 'service',
          model: 'alias',
          wire: 'anthropic-messages',
          upstream: 'chat-completions',
          origin: 'https://model.example:443',
        },
      })
      const response = await fetch(`${lease.baseURL}/v1/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${lease.token}` },
        body: base({ stream, tools: [tool] }),
      })
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toContain('9007199254740993')
      expect(text).not.toContain(key)
      expect(text).not.toContain(JSON.stringify(key).slice(1, -1))
      expect(text).toContain('[redacted]')
      expect(destination).toBe('https://model.example/v1/chat/completions')
      expect(authorization).toBe(`Bearer ${key}`)
      expect(lease.takeTurn().models[0]).toMatchObject({ requests: 1, usage: { inputTokens: 12, outputTokens: 5 } })
    } finally {
      await server.close()
    }
  })

  it('returns native Anthropic errors, preserves retry-after, and never completes an interrupted stream', async () => {
    const service: GatewayService = {
      kind: 'openai-compatible',
      baseURL: 'https://model.example/v1',
      apiKey: 'private-key-value',
      models: ['alias'],
      fingerprint: 'one',
    }
    let next = new Response('quota private-key-value', { status: 429, headers: { 'retry-after': '7' } })
    const server = new ModelGatewayServer({ service: () => service, log: () => {}, fetchFor: () => async () => next })
    await server.start()
    try {
      const lease = server.open({
        sessionId: 'task',
        route: {
          providerId: 'service',
          model: 'alias',
          wire: 'anthropic-messages',
          upstream: 'chat-completions',
          origin: 'https://model.example:443',
        },
      })
      const ask = () =>
        fetch(`${lease.baseURL}/v1/messages`, {
          method: 'POST',
          headers: { authorization: `Bearer ${lease.token}` },
          body: base({ tools: [tool] }),
        })
      const limited = await ask()
      expect(limited.status).toBe(429)
      expect(limited.headers.get('retry-after')).toBe('7')
      expect(await limited.json()).toMatchObject({ type: 'error', error: { type: 'rate_limit_error', message: 'quota [redacted]' } })
      next = new Response('data: {"choices":[{"index":0,"delta":{"content":"prefix"},"finish_reason":null}]}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      })
      const text = await (await ask()).text()
      expect(text).toContain('text_delta')
      expect(text).toContain('event: error')
      expect(text).not.toContain('message_stop')
      expect(lease.takeTurn().models[0]).toMatchObject({ requests: 2, failed: 2 })
    } finally {
      await server.close()
    }
  })
})
