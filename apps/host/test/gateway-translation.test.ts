import { describe, expect, it, vi } from 'vitest'
import { ReasoningSeals } from '../src/model-gateway/reasoning.ts'
import { decodeResponses, ResponsesOutput } from '../src/model-gateway/in/responses.ts'
import { encodeChat, decodeChat } from '../src/model-gateway/out/chat.ts'
import { ModelGatewayServer, type GatewayService } from '../src/model-gateway.ts'

const scope = { providerId: 'service', model: 'alias', wire: 'chat-completions' as const }
const input = (overrides: Record<string, unknown> = {}) => ({ model: 'alias', input: 'hello', stream: true, ...overrides })
const textStream = (text: string, size = 1) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      const bytes = new TextEncoder().encode(text)
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size))
      controller.close()
    },
  })
const sse = (values: unknown[]) => values.map(value => `data: ${JSON.stringify(value)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n'
const chunk = (delta: unknown, finish_reason: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason }] })

describe('Responses to Chat gateway translation', () => {
  it('keeps namespace identity, long names, custom grammar diagnostics and named choices reversible', () => {
    const long = 'mcp_'.repeat(30)
    const request = decodeResponses(
      input({
        tools: [
          {
            type: 'namespace',
            name: 'files',
            tools: [
              { type: 'function', name: long, parameters: { type: 'object', properties: {} } },
              { type: 'custom', name: 'apply_patch', format: { type: 'grammar', syntax: 'lark', definition: 'start: PATCH' } },
            ],
          },
          { type: 'function', name: 'files_apply_patch', parameters: { type: 'object' } },
        ],
        tool_choice: { type: 'custom', name: 'apply_patch', namespace: 'files' },
        parallel_tool_calls: true,
      }),
    )
    const encoded = encodeChat(request)
    expect(encoded.tools.all.map(tool => tool.wireName).every(name => /^[A-Za-z0-9_-]{1,64}$/u.test(name))).toBe(true)
    expect(new Set(encoded.tools.all.map(tool => tool.wireName)).size).toBe(3)
    const patch = encoded.tools.all.find(tool => tool.name === 'apply_patch')!
    expect(encoded.body.tool_choice).toEqual({ type: 'function', function: { name: patch.wireName } })
    expect(encoded.body.parallel_tool_calls).toBe(true)
    expect(request.dropped).toContain('tool-grammar')
    expect(encoded.body.tools).toContainEqual({
      type: 'function',
      function: expect.objectContaining({
        name: patch.wireName,
        parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false },
      }),
    })
  })

  it.each([
    { previous_response_id: 'previous' },
    { store: true },
    { conversation: 'conversation' },
    { n: 2 },
    { tools: [{ type: 'unknown-executable-tool', name: 'new-tool' }] },
    { input: [{ type: 'message', role: 'user', content: [{ type: 'input_file', file_data: 'data:application/pdf;base64,AA==' }] }] },
    { input: [{ type: 'local_shell_call', call_id: 'call', action: {} }] },
  ])('refuses unrepresentable state or execution input before forwarding: %j', overrides => {
    expect(() => decodeResponses(input(overrides))).toThrow()
  })

  it('preserves images and function results without downloading media or inventing user input', () => {
    const encoded = encodeChat(
      decodeResponses(
        input({
          input: [
            { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'instructions' }] },
            { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'https://example.test/p.png', detail: 'high' }] },
            { type: 'function_call', name: 'read', call_id: 'call', arguments: '{}' },
            { type: 'function_call_output', call_id: 'call', output: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }] },
          ],
        }),
      ),
    )
    expect(encoded.body.messages).toEqual([
      { role: 'system', content: 'instructions' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/p.png', detail: 'high' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call', content: '' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '[工具调用 call 返回的图片，不是用户发送的]' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
        ],
      },
    ])
  })

  it('authenticates reasoning by service and model, rejects tampering and does not survive a new Host key', () => {
    const seals = new ReasoningSeals()
    const sealed = seals.seal(scope, { wire: 'chat-completions', text: '中文 reasoning' })
    expect(sealed.startsWith('latch2.')).toBe(true)
    expect(seals.open(scope, sealed)).toEqual({ wire: 'chat-completions', text: '中文 reasoning' })
    expect(seals.open({ ...scope, model: 'other' }, sealed)).toBeUndefined()
    expect(seals.open({ ...scope, providerId: 'other' }, sealed)).toBeUndefined()
    expect(seals.open(scope, sealed.slice(0, -3) + 'xyz')).toBeUndefined()
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const noncanonical = sealed.slice(0, -1) + alphabet[alphabet.indexOf(sealed.at(-1)!) | 1]
    expect(seals.open(scope, noncanonical)).toBeUndefined()
    expect(new ReasoningSeals().open(scope, sealed)).toBeUndefined()
    expect(seals.open(scope, 'foreign encrypted text')).toBeUndefined()
    expect(seals.open(scope, 'latch2.' + 'A'.repeat(2 * 1024 * 1024))).toBeUndefined()
  })

  it('keeps parallel tool results contiguous and follows them with labelled image content', () => {
    const request = decodeResponses(
      input({
        input: [
          { role: 'user', content: 'read both' },
          { type: 'function_call', name: 'read', call_id: 'a', arguments: '{}' },
          { type: 'function_call', name: 'read', call_id: 'b', arguments: '{}' },
          {
            type: 'function_call_output',
            call_id: 'a',
            output: [
              { type: 'input_text', text: 'image result' },
              { type: 'input_image', image_url: 'data:image/png;base64,AA==' },
            ],
          },
          { type: 'function_call_output', call_id: 'b', output: 'text result' },
          { role: 'assistant', content: 'both read' },
        ],
      }),
    )
    const { body } = encodeChat(request)
    expect(request.dropped).toContain('tool-image-location')
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages.map(item => item.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user', 'assistant'])
    expect(messages.slice(2, 5)).toEqual([
      { role: 'tool', tool_call_id: 'a', content: 'image result' },
      { role: 'tool', tool_call_id: 'b', content: 'text result' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '[工具调用 a 返回的图片，不是用户发送的]' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
        ],
      },
    ])
  })

  it('replays sealed reasoning for all matching assistant steps and strips a different model seal', () => {
    const seals = new ReasoningSeals()
    const encoded = encodeChat(
      decodeResponses(
        input({
          input: [
            { type: 'reasoning', encrypted_content: seals.seal(scope, { wire: 'chat-completions', text: 'first reasoning' }), summary: [] },
            { role: 'assistant', content: [{ type: 'output_text', text: 'first answer' }] },
            { role: 'user', content: 'continue' },
            {
              type: 'reasoning',
              encrypted_content: seals.seal({ ...scope, model: 'other' }, { wire: 'chat-completions', text: 'do not replay' }),
              summary: [],
            },
            { type: 'function_call', name: 'read', call_id: 'call', arguments: '{}' },
            { type: 'function_call_output', call_id: 'call', output: 'result' },
          ],
        }),
        value => seals.open(scope, value),
      ),
    )
    expect(encoded.body.messages).toEqual([
      { role: 'assistant', content: 'first answer', reasoning_content: 'first reasoning' },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call', content: 'result' },
    ])
  })

  it('restores interleaved function/custom calls, Unicode and late usage into complete Responses items', async () => {
    const request = decodeResponses(
      input({
        tools: [
          { type: 'function', name: 'read', parameters: { type: 'object' } },
          { type: 'namespace', name: 'files', tools: [{ type: 'custom', name: 'apply_patch' }] },
        ],
      }),
    )
    const { tools } = encodeChat(request)
    const patch = tools.all.find(tool => tool.name === 'apply_patch')!
    const seals = new ReasoningSeals()
    const output = new ResponsesOutput(request, tools, text => seals.seal(scope, text))
    const events = output.start()
    for await (const delta of decodeChat(
      textStream(
        sse([
          chunk({ reasoning_content: '先想清楚' }),
          chunk({ tool_calls: [{ index: 1, id: 'patch', function: { name: patch.wireName, arguments: '{"content":"*** Begin' } }] }),
          chunk({ tool_calls: [{ index: 0, id: 'read', function: { name: 'read', arguments: '{}' } }] }),
          chunk({ tool_calls: [{ index: 1, function: { arguments: ' Patch\\n*** End Patch"}' } }] }, 'tool_calls'),
          {
            choices: [],
            usage: {
              prompt_tokens: 12,
              completion_tokens: 9,
              prompt_tokens_details: { cached_tokens: 4 },
              completion_tokens_details: { reasoning_tokens: 6 },
            },
          },
        ]),
      ),
      new AbortController().signal,
    ))
      events.push(...output.push(delta))
    events.push(...output.finish())
    const final = output.result()
    expect(events.map(event => event.sequence_number)).toEqual(events.map((_, i) => i))
    expect(events.filter(event => event.type === 'response.output_item.done')).toHaveLength(3)
    expect(final.output).toContainEqual(
      expect.objectContaining({
        type: 'custom_tool_call',
        name: 'apply_patch',
        namespace: 'files',
        call_id: 'patch',
        input: '*** Begin Patch\n*** End Patch',
      }),
    )
    expect(final.output).toContainEqual(expect.objectContaining({ type: 'function_call', name: 'read', call_id: 'read', arguments: '{}' }))
    expect(final.usage).toEqual({
      input_tokens: 12,
      output_tokens: 9,
      total_tokens: 21,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens_details: { reasoning_tokens: 6 },
    })
    expect(events.at(-1)?.type).toBe('response.completed')
  })

  it('does not finish tools from a truncated stream or a malformed custom call', async () => {
    const request = decodeResponses(input({ tools: [{ type: 'custom', name: 'patch' }] }))
    const { tools } = encodeChat(request)
    const output = new ResponsesOutput(request, tools, () => 'unused-test-signature')
    output.start()
    output.push({ type: 'tool', index: 0, id: 'call', name: 'patch', arguments: '{"content":3}' })
    output.push({ type: 'finish', reason: 'tools' })
    expect(() => output.finish()).toThrow()
    const partial = textStream(`data: ${JSON.stringify(chunk({ content: 'partial' }))}\n\n`)
    await expect(async () => {
      for await (const _delta of decodeChat(partial, new AbortController().signal)) {
        /* consume */
      }
    }).rejects.toThrow()
  })

  it('never publishes an executable tool done when the service stops for output length', () => {
    const request = decodeResponses(input({ tools: [{ type: 'function', name: 'write', parameters: { type: 'object' } }] }))
    const output = new ResponsesOutput(request, encodeChat(request).tools, () => 'unused-test-signature')
    output.start()
    output.push({ type: 'tool', index: 0, id: 'call', name: 'write', arguments: '{"path":"file"' })
    output.push({ type: 'finish', reason: 'length' })
    const events = output.finish()
    expect(events.filter(event => event.type === 'response.output_item.done')).toEqual([])
    expect(events.at(-1)).toMatchObject({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } })
    expect(output.result().output).toEqual([])
  })

  it('binds a streamed tool identity once instead of concatenating different names into a third tool', () => {
    const request = decodeResponses(
      input({ tools: ['read', 'delete', 'readdelete'].map(name => ({ type: 'function', name, parameters: { type: 'object' } })) }),
    )
    const output = new ResponsesOutput(request, encodeChat(request).tools, () => 'unused-test-signature')
    output.start()
    output.push({ type: 'tool', index: 0, id: 'call', name: 'read', arguments: '{' })
    expect(() => output.push({ type: 'tool', index: 0, name: 'delete', arguments: '}' })).toThrow()
    const repeated = new ResponsesOutput(request, encodeChat(request).tools, () => 'unused-test-signature')
    repeated.push({ type: 'tool', index: 0, id: 'call', name: 'read', arguments: '{' })
    repeated.push({ type: 'tool', index: 0, id: 'call', name: 'read', arguments: '}' })
    repeated.push({ type: 'finish', reason: 'tools' })
    expect(repeated.finish().filter(event => event.type === 'response.output_item.done')[0]).toMatchObject({
      item: { name: 'read', arguments: '{}' },
    })
  })

  it('preserves numeric argument tokens exactly and refuses non-finite numbers instead of changing their values', () => {
    const request = decodeResponses(input({ tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }] }))
    const tools = encodeChat(request).tools
    const raw = '{ "id": 9007199254740993, "zero": -0, "fraction": 0.10000000000000000001 }'
    const output = new ResponsesOutput(request, tools, () => 'unused-test-signature')
    output.push({ type: 'tool', index: 0, id: 'call', name: 'read', arguments: raw })
    output.push({ type: 'finish', reason: 'tools' })
    output.finish()
    expect(output.result().output[0]?.arguments).toBe(raw)
    const overflow = new ResponsesOutput(request, tools, () => 'unused-test-signature')
    overflow.push({ type: 'tool', index: 0, id: 'call', name: 'read', arguments: '{"id":1e400}' })
    overflow.push({ type: 'finish', reason: 'tools' })
    expect(() => overflow.finish()).toThrow()
  })

  it('serves only the entry protocol, forwards Chat with the service key and returns translated usage/loss evidence', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = []
    const service: GatewayService = {
      kind: 'openai-compatible',
      baseURL: 'https://model.example/v1',
      apiKey: 'fake-private-value',
      models: ['alias'],
      fingerprint: 'one',
      modelCapabilities: { alias: { thinking: ['low'] } },
    }
    const server = new ModelGatewayServer({
      service: () => service,
      log: () => {},
      fetchFor: () => async (url, init) => {
        calls.push({ url, body: JSON.parse(new TextDecoder().decode(init.body as Uint8Array)), headers: new Headers(init.headers) })
        return new Response(
          textStream(
            sse([chunk({ content: 'converted 中文' }, 'stop'), { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }]),
          ),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      },
    })
    await server.start()
    try {
      const lease = server.open({
        sessionId: 'task',
        route: {
          providerId: 'service',
          model: 'alias',
          wire: 'responses',
          upstream: 'chat-completions',
          origin: 'https://model.example:443',
        },
      })
      const headers = { authorization: `Bearer ${lease.token}`, 'content-type': 'application/json' }
      expect((await fetch(`${lease.baseURL}/chat/completions`, { method: 'POST', headers, body: '{}' })).status).toBe(404)
      const response = await fetch(`${lease.baseURL}/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify(input({ reasoning: { effort: 'low' }, prompt_cache_key: 'cache' })),
      })
      expect(response.status).toBe(200)
      const answer = await response.text()
      expect(answer).toContain('response.completed')
      expect(answer).toContain('converted 中文')
      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toBe('https://model.example/v1/chat/completions')
      expect(calls[0]?.headers.get('authorization')).toBe('Bearer fake-private-value')
      expect(calls[0]?.body).toMatchObject({ reasoning_effort: 'low', stream_options: { include_usage: true } })
      expect(calls[0]?.body).not.toHaveProperty('prompt_cache_key')
      expect(lease.takeTurn()).toMatchObject({
        requests: 2,
        dropped: ['prompt-cache'],
        models: [{ usage: { inputTokens: 3, outputTokens: 2 }, measured: 1 }],
      })
      lease.close()
    } finally {
      await server.close()
    }
  })

  it('redacts a service key split across logical reasoning deltas before sealing or sending any event', async () => {
    const key = 'private-unprefixed-value'
    const service: GatewayService = {
      kind: 'openai-compatible',
      baseURL: 'https://model.example/v1',
      apiKey: key,
      models: ['alias'],
      fingerprint: 'one',
    }
    const forwarded: unknown[] = []
    const server = new ModelGatewayServer({
      service: () => service,
      log: () => {},
      fetchFor: () => async (_url, init) => {
        forwarded.push(JSON.parse(new TextDecoder().decode(init.body as Uint8Array)))
        return new Response(
          textStream(
            sse([
              chunk({ reasoning_content: 'private-unpre' }),
              chunk({ reasoning_content: 'fixed-value' }),
              chunk({ content: 'done' }, 'stop'),
            ]),
          ),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      },
    })
    await server.start()
    try {
      const lease = server.open({
        sessionId: 'task',
        route: {
          providerId: 'service',
          model: 'alias',
          wire: 'responses',
          upstream: 'chat-completions',
          origin: 'https://model.example:443',
        },
      })
      const ask = (body: unknown) =>
        fetch(`${lease.baseURL}/responses`, {
          method: 'POST',
          headers: { authorization: `Bearer ${lease.token}` },
          body: JSON.stringify(body),
        })
      const text = await (await ask(input())).text()
      expect(text).not.toContain('private-unpre')
      const events = text
        .split('\n')
        .filter(line => line.startsWith('data: '))
        .map(line => JSON.parse(line.slice(6)))
      const done = events.at(-1).response
      const reasoning = done.output.find((item: { type: string }) => item.type === 'reasoning')
      const payload = JSON.parse(Buffer.from(reasoning.encrypted_content.split('.')[1], 'base64url').toString())
      expect(payload.text).toBe('[redacted]')
      await (await ask(input({ input: [...done.output, { role: 'user', content: 'again' }] }))).text()
      expect(JSON.stringify(forwarded)).not.toContain(key)
      expect(JSON.stringify(forwarded)).toContain('[redacted]')
    } finally {
      await server.close()
    }
  })

  it('returns a failed stream on upstream disconnect and keeps non-2xx status/retry meaning', async () => {
    const service: GatewayService = {
      kind: 'openai-compatible',
      baseURL: 'https://model.example/v1',
      apiKey: '',
      models: ['alias'],
      fingerprint: 'one',
    }
    let next = new Response(textStream(`data: ${JSON.stringify(chunk({ content: 'partial' }))}\n\n`), {
      headers: { 'content-type': 'text/event-stream' },
    })
    const server = new ModelGatewayServer({ service: () => service, log: () => {}, fetchFor: () => async () => next })
    await server.start()
    try {
      const lease = server.open({
        sessionId: 'task',
        route: {
          providerId: 'service',
          model: 'alias',
          wire: 'responses',
          upstream: 'chat-completions',
          origin: 'https://model.example:443',
        },
      })
      const ask = () =>
        fetch(`${lease.baseURL}/responses`, {
          method: 'POST',
          headers: { authorization: `Bearer ${lease.token}` },
          body: JSON.stringify(input()),
        })
      const text = await (await ask()).text()
      expect(text).toContain('response.failed')
      expect(text).not.toContain('response.completed')
      expect(lease.takeTurn().models[0]?.failed).toBe(1)
      next = new Response('{"error":{"message":"too many requests"}}', { status: 429, headers: { 'retry-after': '30' } })
      const limited = await ask()
      expect(limited.status).toBe(429)
      expect(limited.headers.get('retry-after')).toBe('30')
      expect(await limited.json()).toMatchObject({ error: { code: 'rate_limit_exceeded' } })
    } finally {
      await server.close()
    }
  })

  it.each([
    { stream: true, unicode: false },
    { stream: false, unicode: false },
    { stream: true, unicode: true },
    { stream: false, unicode: true },
  ])(
    'redacts escaped keys before the additional function-arguments JSON layer (stream=$stream, unicode=$unicode)',
    async ({ stream, unicode }) => {
      const key = unicode ? 'private-ascii-value' : 'private"值\\path'
      const service: GatewayService = {
        kind: 'openai-compatible',
        baseURL: 'https://model.example/v1',
        apiKey: key,
        models: ['alias'],
        fingerprint: 'one',
      }
      const escaped = [...key].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')
      const call = {
        id: 'call',
        type: 'function',
        function: { name: 'inspect', arguments: unicode ? `{"value":"${escaped}"}` : JSON.stringify({ value: key }) },
      }
      const server = new ModelGatewayServer({
        service: () => service,
        log: () => {},
        fetchFor: () => async () =>
          stream
            ? new Response(textStream(sse([chunk({ tool_calls: [{ index: 0, ...call }] }, 'tool_calls')])), {
                headers: { 'content-type': 'text/event-stream' },
              })
            : Response.json({
                choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }],
              }),
      })
      await server.start()
      try {
        const lease = server.open({
          sessionId: 'task',
          route: {
            providerId: 'service',
            model: 'alias',
            wire: 'responses',
            upstream: 'chat-completions',
            origin: 'https://model.example:443',
          },
        })
        const response = await fetch(`${lease.baseURL}/responses`, {
          method: 'POST',
          headers: { authorization: `Bearer ${lease.token}` },
          body: JSON.stringify(input({ stream, tools: [{ type: 'function', name: 'inspect', parameters: { type: 'object' } }] })),
        })
        const text = await response.text()
        const result = stream
          ? text
              .split('\n')
              .filter(line => line.startsWith('data: '))
              .map(line => JSON.parse(line.slice(6)))
              .at(-1).response
          : JSON.parse(text)
        expect(result.status).toBe('completed')
        expect(JSON.parse(result.output[0].arguments)).toEqual({ value: '[redacted]' })
      } finally {
        await server.close()
      }
    },
  )

  it('aborts the Chat request when the Responses client cancels and counts no successful reply', async () => {
    const service: GatewayService = {
      kind: 'openai-compatible',
      baseURL: 'https://model.example/v1',
      apiKey: '',
      models: ['alias'],
      fingerprint: 'one',
    }
    let aborted = false
    const server = new ModelGatewayServer({
      service: () => service,
      log: () => {},
      fetchFor: () => async (_url, init) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk({ content: 'pending' }))}\n\n`))
            init.signal?.addEventListener(
              'abort',
              () => {
                aborted = true
                controller.error(new Error('aborted'))
              },
              { once: true },
            )
          },
        })
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
      },
    })
    await server.start()
    try {
      const lease = server.open({
        sessionId: 'task',
        route: {
          providerId: 'service',
          model: 'alias',
          wire: 'responses',
          upstream: 'chat-completions',
          origin: 'https://model.example:443',
        },
      })
      const controller = new AbortController()
      const response = await fetch(`${lease.baseURL}/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${lease.token}` },
        body: JSON.stringify(input()),
        signal: controller.signal,
      })
      const reader = response.body!.getReader()
      await reader.read()
      controller.abort()
      await reader.cancel().catch(() => {})
      await vi.waitFor(() => expect(aborted).toBe(true))
      expect(lease.takeTurn()).toMatchObject({ requests: 1, models: [{ failed: 1 }] })
    } finally {
      await server.close()
    }
  })
})
