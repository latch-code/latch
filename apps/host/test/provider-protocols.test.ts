import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { startFakeModels } from '@latch/testkit'
import type { HarnessPlugin, ModelDelta, ModelMessage, ModelProvider, ToolCall, ToolDefinition } from '@latch/sdk'
import { createGeminiPlugin } from '../src/plugins/providers/gemini/index.ts'
import { createResponsesPlugin } from '../src/plugins/providers/openai-responses/index.ts'
import type { FetchLike } from '../src/plugins/providers/http.ts'
import type { ServiceConfig } from '../src/plugins/providers/service.ts'
import { listProviderModels } from '../src/providers.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function mount(plugin: HarnessPlugin): Promise<ModelProvider> {
  const providers: ModelProvider[] = []
  await plugin.activate({
    registerProvider(provider) {
      providers.push(provider)
    },
    registerTool() {},
    registerHarness() {},
    registerClientPanel: () => {},
    registerSkill: () => {},
    registerTransport: () => {},
    registerUiPanel() {},
    onDispose() {},
  })
  return providers[0]!
}

async function collect(stream: AsyncIterable<ModelDelta>): Promise<ModelDelta[]> {
  const result: ModelDelta[] = []
  for await (const delta of stream) result.push(delta)
  return result
}

interface Seen {
  method: string | undefined
  url: string | undefined
  headers: IncomingMessage['headers']
  body: Record<string, unknown> | undefined
}

/** A loopback service answering every request with `reply`, keeping what it was sent. */
async function serve(reply: (seen: Seen, index: number, response: ServerResponse) => void): Promise<{ origin: string; seen: Seen[] }> {
  const seen: Seen[] = []
  const server = createServer((request, response) => {
    void (async () => {
      const parts: Buffer[] = []
      for await (const data of request) parts.push(Buffer.from(data))
      const text = Buffer.concat(parts).toString('utf8')
      const item = { method: request.method, url: request.url, headers: request.headers, body: text ? JSON.parse(text) : undefined }
      seen.push(item)
      reply(item, seen.length - 1, response)
    })()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP listener')
  return { origin: `http://127.0.0.1:${address.port}`, seen }
}

const sse = (response: ServerResponse, events: unknown[]) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
}
const signal = () => new AbortController().signal
const user: ModelMessage = { role: 'user', content: '你好' }
const direct = { fetch: globalThis.fetch as FetchLike }
const tool: ToolDefinition = {
  name: 'read_file',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  requiresApproval: false,
  execute: async () => ({ text: '' }),
}
const config = (baseURL: string, extra: Partial<ServiceConfig> = {}): ServiceConfig => ({
  id: 'svc',
  baseURL,
  apiKey: 'protocol-secret',
  model: 'model-a',
  ...extra,
})

describe('OpenAI Responses provider', () => {
  const completed = (usage?: unknown) => ({ type: 'response.completed', response: { status: 'completed', ...(usage ? { usage } : {}) } })

  it('streams text, reasoning and calls, and sends the history back as items without the calls’ item IDs', async () => {
    const service = await serve((_seen, index, response) =>
      sse(
        response,
        index === 0
          ? [
              { type: 'response.created', response: { status: 'in_progress' } },
              { type: 'response.reasoning_summary_text.delta', delta: '先看', item_id: 'rs_1', output_index: 0, summary_index: 0 },
              { type: 'response.output_text.delta', delta: '读一下', item_id: 'msg_1', output_index: 1, content_index: 0 },
              { type: 'response.function_call_arguments.delta', delta: '{"path"', item_id: 'fc_1', output_index: 2 },
              {
                type: 'response.output_item.done',
                output_index: 2,
                item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
              },
              {
                type: 'response.output_item.done',
                output_index: 3,
                item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'read_file', arguments: '{"path":"b.ts"}' },
              },
              completed({
                input_tokens: 30,
                input_tokens_details: { cached_tokens: 12 },
                output_tokens: 9,
                output_tokens_details: { reasoning_tokens: 4 },
                total_tokens: 39,
              }),
            ]
          : [{ type: 'response.output_text.delta', delta: '好了' }, completed()],
      ),
    )
    const provider = await mount(createResponsesPlugin(config(`${service.origin}/v1`)))
    const deltas = await collect(provider.stream({ messages: [user], tools: [tool], signal: signal() }))
    expect(deltas).toEqual([
      { type: 'reasoning', text: '先看' },
      { type: 'text', text: '读一下' },
      { type: 'usage', inputTokens: 30, outputTokens: 9, cacheReadTokens: 12, reasoningTokens: 4 },
      { type: 'tool-call', call: { id: 'call_1', name: 'read_file', arguments: { path: 'a.ts' } } },
      { type: 'tool-call', call: { id: 'call_2', name: 'read_file', arguments: { path: 'b.ts' } } },
      { type: 'finish', reason: 'tool-calls' },
    ])
    const calls = deltas.flatMap(delta => (delta.type === 'tool-call' ? [delta.call] : []))
    expect(
      await collect(
        provider.stream({
          messages: [
            { role: 'system', content: '规则一' },
            { role: 'system', content: '规则二' },
            user,
            { role: 'assistant', content: '读一下', toolCalls: calls },
            { role: 'tool', content: 'A', toolCallId: 'call_1' },
            { role: 'tool', content: '没有这个文件', toolCallId: 'call_2', isError: true },
          ],
          tools: [tool],
          signal: signal(),
        }),
      ),
    ).toEqual([
      { type: 'text', text: '好了' },
      { type: 'finish', reason: 'stop' },
    ])
    expect(service.seen[0]).toMatchObject({ method: 'POST', url: '/v1/responses', headers: { authorization: 'Bearer protocol-secret' } })
    expect(service.seen[0]?.body).toEqual({
      model: 'model-a',
      stream: true,
      store: false,
      input: [{ role: 'user', content: '你好' }],
      tools: [{ type: 'function', name: 'read_file', description: 'Read a file', parameters: tool.parameters, strict: false }],
    })
    expect(service.seen[1]?.body).toMatchObject({
      instructions: '规则一\n\n规则二',
      input: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '读一下' },
        { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
        { type: 'function_call', call_id: 'call_2', name: 'read_file', arguments: '{"path":"b.ts"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'A' },
        { type: 'function_call_output', call_id: 'call_2', output: 'Tool failed: 没有这个文件' },
      ],
    })
    expect(JSON.stringify(service.seen[1]?.body)).not.toContain('fc_1')
  })

  it('asks for encrypted reasoning and sends the reasoning items back within the tool loop, next to the items they came with', async () => {
    const reasoning = {
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: '先看' }],
      encrypted_content: 'enc-1',
      status: 'completed',
    }
    const said = {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      phase: 'commentary',
      content: [{ type: 'output_text', text: '读一下', annotations: [], logprobs: [] }],
    }
    const step = (items: { reasoning: Record<string, unknown>; completedOutput?: unknown[] }) => [
      { type: 'response.reasoning_summary_text.delta', delta: '先看', item_id: 'rs_1', output_index: 0, summary_index: 0 },
      { type: 'response.output_item.done', output_index: 0, item: items.reasoning },
      { type: 'response.output_text.delta', delta: '读一下', item_id: 'msg_1', output_index: 1, content_index: 0 },
      { type: 'response.output_item.done', output_index: 1, item: said },
      {
        type: 'response.output_item.done',
        output_index: 2,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{"path":"a.ts"}',
          status: 'completed',
        },
      },
      {
        type: 'response.completed',
        response: { status: 'completed', ...(items.completedOutput ? { output: items.completedOutput } : {}) },
      },
    ]
    const { encrypted_content: _left, ...unencrypted } = reasoning
    const scripts = [
      step({ reasoning }),
      [{ type: 'response.output_text.delta', delta: '好了' }, completed()],
      [{ type: 'response.output_text.delta', delta: '好了' }, completed()],
      [{ type: 'response.output_text.delta', delta: '好了' }, completed()],
      step({ reasoning: unencrypted, completedOutput: [reasoning] }),
      step({ reasoning: unencrypted }),
    ]
    const service = await serve((_seen, index, response) => sse(response, scripts[index]!))
    const provider = await mount(
      createResponsesPlugin(config(`${service.origin}/v1`, { modelCapabilities: { 'model-a': { thinking: ['low', 'high'] } } })),
    )
    const first = await collect(provider.stream({ messages: [user], tools: [tool], signal: signal(), effort: 'high' }))
    expect(service.seen[0]?.body).toMatchObject({ store: false, reasoning: { effort: 'high' }, include: ['reasoning.encrypted_content'] })
    const calls = first.flatMap(delta => (delta.type === 'tool-call' ? [delta.call] : []))
    expect(calls).toEqual([
      {
        id: 'call_1',
        name: 'read_file',
        arguments: { path: 'a.ts' },
        signature: {
          by: 'openai-responses\nsvc\nmodel-a',
          value: JSON.stringify([reasoning, said, { type: 'function_call', id: 'fc_1', call_id: 'call_1' }]),
          scope: 'turn',
        },
      },
    ])
    expect(first.find(delta => delta.type === 'usage')).toBeUndefined()
    const loop: ModelMessage[] = [
      user,
      { role: 'assistant', content: '读一下', toolCalls: calls },
      { role: 'tool', content: 'A', toolCallId: 'call_1' },
    ]
    await collect(provider.stream({ messages: loop, tools: [tool], signal: signal(), effort: 'high' }))
    expect(service.seen[1]?.body?.input).toEqual([
      { role: 'user', content: '你好' },
      reasoning,
      said,
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'A' },
    ])
    const plain = [
      { role: 'assistant', content: '读一下' },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
    ]
    // The next turn sends the earlier one without its reasoning, and so does a model that did not make it.
    await collect(provider.stream({ messages: [...loop, { role: 'user', content: '再来' }], tools: [tool], signal: signal() }))
    expect(service.seen[2]?.body?.input).toEqual([
      { role: 'user', content: '你好' },
      ...plain,
      expect.anything(),
      { role: 'user', content: '再来' },
    ])
    await collect(provider.stream({ messages: loop, tools: [tool], signal: signal(), model: 'model-b' }))
    expect(service.seen[3]!.body!.input).toEqual([{ role: 'user', content: '你好' }, ...plain, expect.anything()])
    // Encrypted reasoning that only the finished response carried is kept; without any, nothing goes back.
    const backfilled = (await collect(provider.stream({ messages: [user], tools: [tool], signal: signal() }))).find(
      delta => delta.type === 'tool-call',
    )
    expect(JSON.parse(backfilled?.call.signature?.value ?? 'null')).toEqual(JSON.parse(calls[0]!.signature!.value))
    const unsigned = await collect(provider.stream({ messages: [user], tools: [tool], signal: signal() }))
    expect(unsigned.find(delta => delta.type === 'tool-call')).toEqual({
      type: 'tool-call',
      call: { id: 'call_1', name: 'read_file', arguments: { path: 'a.ts' } },
    })
    expect(service.seen[4]?.body).not.toHaveProperty('include')
  })

  it('sends a declared thinking level as reasoning.effort, nothing without one, and refuses an undeclared one before sending', async () => {
    const service = await serve((_seen, _index, response) => sse(response, [completed()]))
    const provider = await mount(
      createResponsesPlugin(config(`${service.origin}/v1`, { modelCapabilities: { 'model-a': { thinking: ['low', 'medium', 'high'] } } })),
    )
    await collect(provider.stream({ messages: [user], tools: [], signal: signal(), effort: 'high' }))
    await collect(provider.stream({ messages: [user], tools: [], signal: signal() }))
    expect(service.seen[0]?.body).toMatchObject({ reasoning: { effort: 'high' } })
    expect(service.seen[1]?.body).not.toHaveProperty('reasoning')
    await expect(collect(provider.stream({ messages: [user], tools: [], signal: signal(), effort: 'xhigh' }))).rejects.toMatchObject({
      code: 'effort-unavailable',
    })
    expect(service.seen).toHaveLength(2)
  })

  it('keeps the turn when a compatible server reports usage in another shape', async () => {
    const service = await serve((_seen, _index, response) =>
      sse(response, [{ type: 'response.output_text.delta', delta: 'ok' }, completed({ prompt_tokens: 3, completion_tokens: 1 })]),
    )
    const provider = await mount(createResponsesPlugin(config(`${service.origin}/v1`)))
    expect(await collect(provider.stream({ messages: [user], tools: [], signal: signal() }))).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'finish', reason: 'stop' },
    ])
  })

  it('sends images as data URLs with a detail', async () => {
    const service = await serve((_seen, _index, response) => sse(response, [completed()]))
    const provider = await mount(
      createResponsesPlugin(config(`${service.origin}/v1`, { modelCapabilities: { 'model-a': { vision: true } } })),
    )
    await collect(
      provider.stream({
        messages: [{ role: 'user', content: '看图', attachments: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] }],
        tools: [],
        signal: signal(),
      }),
    )
    expect(service.seen[0]?.body).toMatchObject({
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: '看图' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' },
          ],
        },
      ],
    })
  })

  it.each([
    [
      'a failed response',
      [{ type: 'response.failed', response: { error: { code: 'server_error', message: 'boom protocol-secret' } } }],
      'upstream-error',
    ],
    ['an error event', [{ type: 'error', code: 'rate_limit_exceeded', message: 'slow down protocol-secret' }], 'upstream-error'],
    [
      'an output limit',
      [{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }],
      'model-incomplete',
    ],
    [
      'an incomplete reason echoing the key',
      [{ type: 'response.incomplete', response: { incomplete_details: { reason: 'protocol-secret' } } }],
      'model-incomplete',
    ],
    [
      'a content filter',
      [{ type: 'response.incomplete', response: { incomplete_details: { reason: 'content_filter' } } }],
      'model-refusal',
    ],
    ['a refusal', [{ type: 'response.refusal.done', refusal: '不行', item_id: 'm', output_index: 0, content_index: 0 }], 'model-refusal'],
    ['no completion', [{ type: 'response.output_text.delta', delta: 'partial' }], 'stream-incomplete'],
    [
      'a call with bad arguments',
      [
        { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c', name: 'read_file', arguments: '[]' } },
        completed(),
      ],
      'invalid-tool-json',
    ],
  ])('fails on %s without publishing a call, and redacts the key', async (_label, events, code) => {
    const service = await serve((_seen, _index, response) => sse(response, events))
    const provider = await mount(createResponsesPlugin(config(`${service.origin}/v1`)))
    const deltas: ModelDelta[] = []
    const failure = await (async () => {
      for await (const delta of provider.stream({ messages: [user], tools: [], signal: signal() })) deltas.push(delta)
    })().catch((error: unknown) => error)
    expect(failure).toMatchObject({ code })
    expect(String((failure as Error).message)).not.toContain('protocol-secret')
    expect(deltas.some(delta => delta.type === 'tool-call' || delta.type === 'finish')).toBe(false)
  })
})

describe('Gemini provider', () => {
  const chunk = (parts: unknown[], extra: Record<string, unknown> = {}) => ({
    candidates: [{ index: 0, content: { role: 'model', parts }, ...extra }],
  })

  it('streams thoughts, text and calls over SSE, with the key in a header and never in the URL', async () => {
    const service = await serve((_seen, _index, response) =>
      sse(response, [
        chunk([{ text: '想一想', thought: true }]),
        chunk([{ text: '我来读' }]),
        chunk(
          [
            { functionCall: { id: 'g1', name: 'read_file', args: { path: 'a.ts' } }, thoughtSignature: 'sig-a' },
            { functionCall: { name: 'read_file', args: { path: 'b.ts' } } },
          ],
          { finishReason: 'STOP' },
        ),
        { usageMetadata: { promptTokenCount: 40, cachedContentTokenCount: 8, candidatesTokenCount: 6, thoughtsTokenCount: 5 } },
      ]),
    )
    for (const baseURL of [service.origin, `${service.origin}/v1beta/`]) {
      const provider = await mount(createGeminiPlugin(config(baseURL, { model: 'gemini-3-flash' })))
      const deltas = await collect(provider.stream({ messages: [user], tools: [tool], signal: signal() }))
      const calls = deltas.flatMap(delta => (delta.type === 'tool-call' ? [delta.call] : []))
      expect(deltas.filter(delta => delta.type !== 'tool-call')).toEqual([
        { type: 'reasoning', text: '想一想' },
        { type: 'text', text: '我来读' },
        { type: 'usage', inputTokens: 40, outputTokens: 11, cacheReadTokens: 8, reasoningTokens: 5 },
        { type: 'finish', reason: 'tool-calls' },
      ])
      expect(calls[0]).toEqual({
        id: 'g1',
        name: 'read_file',
        arguments: { path: 'a.ts' },
        signature: { by: 'gemini\nsvc\ngemini-3-flash', value: 'sig-a' },
      })
      // The service left the second call's ID out; one is made so its result can name it.
      expect(calls[1]).toMatchObject({ id: expect.stringMatching(/^call_/u), name: 'read_file', arguments: { path: 'b.ts' } })
      expect(calls[1]).not.toHaveProperty('signature')
    }
    for (const seen of service.seen) {
      expect(seen).toMatchObject({ method: 'POST', url: '/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse' })
      expect(seen.headers['x-goog-api-key']).toBe('protocol-secret')
      expect(seen.url).not.toContain('protocol-secret')
    }
    expect(service.seen[0]?.body).toEqual({
      contents: [{ role: 'user', parts: [{ text: '你好' }] }],
      tools: [{ functionDeclarations: [{ name: 'read_file', description: 'Read a file', parametersJsonSchema: tool.parameters }] }],
    })
  })

  it('sends history with results named after their calls, its own signatures back, and the skip value for another model’s', async () => {
    const service = await serve((_seen, _index, response) => sse(response, [chunk([{ text: 'ok' }], { finishReason: 'STOP' })]))
    const provider = await mount(createGeminiPlugin(config(service.origin, { model: 'gemini-3-flash' })))
    const own: ToolCall[] = [
      { id: 'g1', name: 'read_file', arguments: { path: 'a.ts' }, signature: { by: 'gemini\nsvc\ngemini-3-flash', value: 'sig-a' } },
      { id: 'g2', name: 'read_file', arguments: { path: 'b.ts' } },
    ]
    const foreign: ToolCall[] = [
      { id: 'c3', name: 'read_file', arguments: { path: 'c.ts' }, signature: { by: 'gemini\nsvc\ngemini-2', value: 'old' } },
    ]
    await collect(
      provider.stream({
        messages: [
          { role: 'system', content: '规则' },
          user,
          { role: 'assistant', content: '读两个', toolCalls: own },
          { role: 'tool', content: 'A', toolCallId: 'g1' },
          { role: 'tool', content: '没有', toolCallId: 'g2', isError: true },
          { role: 'assistant', content: '', toolCalls: foreign },
          { role: 'tool', content: 'C', toolCallId: 'c3' },
        ],
        tools: [tool],
        signal: signal(),
      }),
    )
    expect(service.seen[0]?.body).toMatchObject({
      systemInstruction: { parts: [{ text: '规则' }] },
      contents: [
        { role: 'user', parts: [{ text: '你好' }] },
        {
          role: 'model',
          parts: [
            { text: '读两个' },
            { functionCall: { id: 'g1', name: 'read_file', args: { path: 'a.ts' } }, thoughtSignature: 'sig-a' },
            { functionCall: { id: 'g2', name: 'read_file', args: { path: 'b.ts' } } },
          ],
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { id: 'g1', name: 'read_file', response: { output: 'A' } } },
            { functionResponse: { id: 'g2', name: 'read_file', response: { error: '没有' } } },
          ],
        },
        {
          role: 'model',
          parts: [
            { functionCall: { id: 'c3', name: 'read_file', args: { path: 'c.ts' } }, thoughtSignature: 'skip_thought_signature_validator' },
          ],
        },
        { role: 'user', parts: [{ functionResponse: { id: 'c3', name: 'read_file', response: { output: 'C' } } }] },
      ],
    })
    const contents = (service.seen[0]?.body as { contents: Array<{ parts: unknown[] }> }).contents
    expect(contents[1]?.parts[2]).not.toHaveProperty('thoughtSignature')
    await expect(
      collect(provider.stream({ messages: [user, { role: 'tool', content: 'x', toolCallId: 'nowhere' }], tools: [], signal: signal() })),
    ).rejects.toMatchObject({ code: 'invalid-history' })
  })

  it('sends a declared thinking level as thinkingLevel with thoughts included, and nothing without one', async () => {
    const service = await serve((_seen, _index, response) => sse(response, [chunk([{ text: 'ok' }], { finishReason: 'STOP' })]))
    const provider = await mount(
      createGeminiPlugin(config(service.origin, { modelCapabilities: { 'model-a': { thinking: ['minimal', 'low', 'medium', 'high'] } } })),
    )
    await collect(provider.stream({ messages: [user], tools: [], signal: signal(), effort: 'minimal' }))
    await collect(provider.stream({ messages: [user], tools: [], signal: signal() }))
    expect(service.seen[0]?.body).toMatchObject({
      generationConfig: { thinkingConfig: { thinkingLevel: 'MINIMAL', includeThoughts: true } },
    })
    expect(service.seen[1]?.body).not.toHaveProperty('generationConfig')
  })

  it.each([
    ['an output limit', [chunk([{ text: 'partial' }], { finishReason: 'MAX_TOKENS' })], 'model-incomplete'],
    ['a safety stop', [chunk([], { finishReason: 'SAFETY' })], 'model-refusal'],
    ['a blocked prompt', [{ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }], 'model-refusal'],
    ['a streamed error', [{ error: { code: 429, message: 'quota protocol-secret', status: 'RESOURCE_EXHAUSTED' } }], 'upstream-error'],
    ['no finish', [chunk([{ text: 'partial' }])], 'stream-incomplete'],
    ['a stop reason echoing the key', [chunk([], { finishReason: 'protocol-secret' })], 'model-incomplete'],
    ['a block reason echoing the key', [{ promptFeedback: { blockReason: 'protocol-secret' } }], 'model-refusal'],
    ['two candidates', [{ candidates: [{ index: 0 }, { index: 1 }] }], 'invalid-choice'],
    ['text after the finish', [chunk([], { finishReason: 'STOP' }), chunk([{ text: 'more' }])], 'invalid-chunk'],
  ])('fails on %s without publishing a call, and redacts the key', async (_label, events, code) => {
    const service = await serve((_seen, _index, response) => sse(response, events))
    const provider = await mount(createGeminiPlugin(config(service.origin)))
    const failure = await collect(provider.stream({ messages: [user], tools: [], signal: signal() })).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code })
    expect(String((failure as Error).message)).not.toContain('protocol-secret')
  })
})

describe('cancelling either protocol', () => {
  it.each([
    ['Responses', (origin: string) => createResponsesPlugin(config(`${origin}/v1`))],
    ['Gemini', (origin: string) => createGeminiPlugin(config(origin))],
  ])('aborts a stalled %s stream and closes its connection', async (_label, plugin) => {
    let closed = false
    let opened: () => void = () => {}
    const open = new Promise<void>(resolve => {
      opened = resolve
    })
    const service = await serve((_seen, _index, response) => {
      response.on('close', () => {
        closed = true
      })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(': connected\n\n')
      opened()
    })
    const provider = await mount(plugin(service.origin))
    const controller = new AbortController()
    const rejection = expect(collect(provider.stream({ messages: [user], tools: [], signal: controller.signal }))).rejects.toMatchObject({
      name: 'AbortError',
    })
    await open
    controller.abort()
    await rejection
    await expect.poll(() => closed).toBe(true)
  })
})

describe('model listings of the two protocols', () => {
  it('lists a Responses service at /models with a bearer key', async () => {
    const service = await serve((_seen, _index, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-b' }, { id: 'gpt-a' }] }))
    })
    expect(
      await listProviderModels({ kind: 'openai-responses', baseURL: `${service.origin}/v1`, apiKey: 'protocol-secret' }, signal(), direct),
    ).toEqual(['gpt-a', 'gpt-b'])
    expect(service.seen[0]).toMatchObject({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer protocol-secret' } })
  })

  it('pages through Gemini models, keeps the ones that generate content and drops the models/ prefix', async () => {
    const service = await serve((seen, _index, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify(
          seen.url?.includes('pageToken')
            ? { models: [{ name: 'models/gemini-b', supportedGenerationMethods: ['generateContent'] }] }
            : {
                models: [
                  { name: 'models/gemini-a', supportedGenerationMethods: ['generateContent', 'countTokens'] },
                  { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] },
                ],
                nextPageToken: 'next',
              },
        ),
      )
    })
    expect(await listProviderModels({ kind: 'gemini', baseURL: service.origin, apiKey: 'protocol-secret' }, signal(), direct)).toEqual([
      'gemini-a',
      'gemini-b',
    ])
    expect(service.seen.map(seen => seen.url)).toEqual(['/v1beta/models?pageSize=1000', '/v1beta/models?pageSize=1000&pageToken=next'])
    expect(service.seen.every(seen => seen.headers['x-goog-api-key'] === 'protocol-secret')).toBe(true)
    await expect(listProviderModels({ kind: 'anthropic', baseURL: service.origin, apiKey: '' }, signal(), direct)).rejects.toMatchObject({
      code: 'invalid-response',
    })
  })
})

describe("the test kit's fake Responses and Gemini services", () => {
  it("answer the way the Host's own clients read them, streaming thinking, text and a tool call", async () => {
    const models = await startFakeModels({
      replies: [
        { reasoning: 'Think first.', text: 'Running it now.', tool: { name: /read/u, input: { path: 'a.ts' } } },
        { reasoning: 'Again.', text: 'Reading.', tool: { name: /read/u, input: { path: 'b.ts' } } },
        { error: { status: 400, message: 'unsupported thinking level' } },
      ],
    })
    cleanups.push(() => models.close())
    const responses = await mount(createResponsesPlugin(config(`${models.origin}/v1`, { model: 'fake-model' })))
    const gemini = await mount(createGeminiPlugin(config(models.origin, { model: 'fake-model' })))
    const text = (deltas: ModelDelta[], type: 'text' | 'reasoning') =>
      deltas
        .filter(delta => delta.type === type)
        .map(delta => (delta as { text: string }).text)
        .join('')
    const first = await collect(responses.stream({ messages: [user], tools: [tool], signal: signal() }))
    expect([text(first, 'reasoning'), text(first, 'text')]).toEqual(['Think first.', 'Running it now.'])
    expect(first.find(delta => delta.type === 'tool-call')).toMatchObject({ call: { name: 'read_file', arguments: { path: 'a.ts' } } })
    const second = await collect(gemini.stream({ messages: [user], tools: [tool], signal: signal() }))
    expect([text(second, 'reasoning'), text(second, 'text')]).toEqual(['Again.', 'Reading.'])
    expect(second.find(delta => delta.type === 'tool-call')).toMatchObject({
      call: { name: 'read_file', arguments: { path: 'b.ts' }, signature: { value: 'fake-signature' } },
    })
    await expect(collect(gemini.stream({ messages: [user], tools: [], signal: signal() }))).rejects.toMatchObject({
      code: 'http-error',
      status: 400,
      message: expect.stringContaining('unsupported thinking level'),
    })
    expect(models.requests.map(request => [request.wire, request.model, request.stream])).toEqual([
      ['responses', 'fake-model', true],
      ['gemini', 'fake-model', true],
      ['gemini', 'fake-model', true],
    ])
    expect(await listProviderModels({ kind: 'gemini', baseURL: models.origin, apiKey: '' }, signal(), direct)).toEqual([
      'fake-model',
      'fake-model-large',
    ])
  })
})
