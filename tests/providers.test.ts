import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { HarnessPlugin, ModelDelta, ModelMessage, ModelProvider, ToolDefinition } from '../src/core/plugins.ts'
import { createDemoPlugin, createToolsPlugin } from '../src/plugins/demo.ts'
import { createAnthropicPlugin } from '../src/plugins/anthropic.ts'
import { createOpenAIPlugin, redactor, type FetchLike } from '../src/plugins/openai.ts'
import {
  checkProvider, listProviderModels, originOf, providerPlugin, providerSettings, summarizeProvider, usableKey,
} from '../src/host/providers.ts'
import type { ProviderRecord } from '../src/host/config.ts'
import { PROVIDER_PRESETS } from '../src/shared/presets.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function mount(...plugins: HarnessPlugin[]) {
  const providers: ModelProvider[] = []
  const tools: ToolDefinition[] = []
  for (const plugin of plugins) await plugin.activate({
    registerProvider(provider) { providers.push(provider) },
    registerTool(tool) { tools.push(tool) },
    registerHarness() {},
    onDispose(dispose) { cleanups.push(async () => { await dispose() }) },
  })
  return { providers, tools }
}

async function collect(stream: AsyncIterable<ModelDelta>): Promise<ModelDelta[]> {
  const result: ModelDelta[] = []
  for await (const delta of stream) result.push(delta)
  return result
}

const message: ModelMessage = { role: 'user', content: '你好' }
const freshSignal = () => new AbortController().signal
/** Loopback test servers only; production passes the Host's egress-checked fetch. */
const direct = { fetch: globalThis.fetch as FetchLike }
const unusedFetch: FetchLike = async () => { throw new Error('unexpected request') }
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`
const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] })

async function listen(handler: (request: IncomingMessage, response: ServerResponse, body: string) => Promise<void> | void) {
  const server = createServer((request, response) => {
    void (async () => {
      const parts: Buffer[] = []
      for await (const data of request) parts.push(Buffer.from(data))
      await handler(request, response, Buffer.concat(parts).toString('utf8'))
    })().catch(error => {
      response.writeHead(500, { 'content-type': 'text/plain' })
      response.end(String(error))
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP listener')
  return `http://127.0.0.1:${address.port}/v1`
}

async function openaiAt(baseURL: string, apiKey = 'local-test-key') {
  const { providers } = await mount(createOpenAIPlugin({ baseURL, apiKey, model: 'test-model' }))
  return providers[0]!
}

describe('OpenAI-compatible streaming provider', () => {
  it('reassembles fragmented UTF-8, CRLF and parallel tool arguments and preserves multi-turn history', async () => {
    const requests: Array<{ url: string | undefined; authorization: string | undefined; body: unknown }> = []
    const endpoint = await listen(async (request, response, body) => {
      requests.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(body) })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (requests.length === 2) {
        response.end(frame(chunk({ content: '完成' }, 'stop')) + 'data: [DONE]\n\n')
        return
      }
      const stream = ': heartbeat\r\n\r\n' + frame(chunk({ content: '开始' }))
        + frame(chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'write_', arguments: '{"content":' } }] }))
        + frame(chunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'long_task', arguments: '{' } }] }))
        + frame(chunk({ tool_calls: [{ index: 0, function: { name: 'report', arguments: '"你好"}' } }, { index: 1, function: { arguments: '}' } }] }, 'tool_calls'))
        + frame({ choices: [], usage: { prompt_tokens: 23, completion_tokens: 9 } }) + 'data: [DONE]\r\n\r\n'
      const bytes = Buffer.from(stream)
      for (let offset = 0; offset < bytes.length; offset += 7) {
        response.write(bytes.subarray(offset, offset + 7))
        await delay(1)
      }
      response.end()
    })
    const provider = await openaiAt(endpoint)
    const { tools } = await mount(createToolsPlugin())
    const deltas = await collect(provider.stream({ messages: [message], tools, signal: freshSignal() }))
    expect(deltas).toEqual([
      { type: 'text', text: '开始' },
      { type: 'usage', inputTokens: 23, outputTokens: 9 },
      { type: 'tool-call', call: { id: 'call_a', name: 'write_report', arguments: { content: '你好' } } },
      { type: 'tool-call', call: { id: 'call_b', name: 'long_task', arguments: {} } },
      { type: 'finish', reason: 'tool-calls' },
    ])
    const calls = deltas.flatMap(delta => delta.type === 'tool-call' ? [delta.call] : [])
    await collect(provider.stream({
      messages: [message, { role: 'assistant', content: '开始', toolCalls: calls },
        { role: 'tool', content: '产物已写入', toolCallId: 'call_a' },
        { role: 'tool', content: '用户取消', toolCallId: 'call_b', isError: true }], tools, signal: freshSignal(),
    }))
    expect(requests[0]).toMatchObject({ url: '/v1/chat/completions', authorization: 'Bearer local-test-key', body: {
      model: 'test-model', stream: true, stream_options: { include_usage: true },
      tools: [{ type: 'function', function: { name: 'write_report' } }, { type: 'function', function: { name: 'long_task' } }],
    } })
    expect(requests[1]?.body).toMatchObject({ messages: [message, {
      role: 'assistant', content: '开始', tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'write_report', arguments: '{"content":"你好"}' } },
        { id: 'call_b', type: 'function', function: { name: 'long_task', arguments: '{}' } },
      ],
    }, { role: 'tool', content: '产物已写入', tool_call_id: 'call_a' },
    { role: 'tool', content: 'Tool failed: 用户取消', tool_call_id: 'call_b' }] })
  })

  it('aborts a stalled upstream stream and closes its connection', async () => {
    let closed = false
    let receivedResolve: () => void = () => { throw new Error('Listener not initialized') }
    const received = new Promise<void>(resolve => { receivedResolve = resolve })
    const endpoint = await listen((_request, response) => {
      response.on('close', () => { closed = true })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(': connected\n\n')
      receivedResolve()
    })
    const provider = await openaiAt(endpoint)
    const controller = new AbortController()
    const result = collect(provider.stream({ messages: [message], tools: [], signal: controller.signal }))
    const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await received
    controller.abort()
    await rejection
    await expect.poll(() => closed).toBe(true)
  })

  it('returns non-2xx errors without leaking the supplied key or falling back', async () => {
    const endpoint = await listen((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'invalid local-test-key' } }))
    })
    const provider = await openaiAt(endpoint)
    await expect(collect(provider.stream({ messages: [message], tools: [], signal: freshSignal() })))
      .rejects.toMatchObject({ code: 'http-error', status: 401, message: expect.stringContaining('[redacted]') })
  })

  it.each([
    ['invalid SSE JSON', 'data: {broken}\n\n', 'invalid-json'],
    ['invalid tool JSON', frame(chunk({ tool_calls: [{ index: 0, id: 'bad', function: { name: 'write_report', arguments: '{' } }] }, 'tool_calls')), 'invalid-tool-json'],
    ['array tool JSON', frame(chunk({ tool_calls: [{ index: 0, id: 'bad', function: { name: 'write_report', arguments: '[]' } }] }, 'tool_calls')), 'invalid-tool-json'],
    ['missing finish', frame(chunk({ content: 'partial' })), 'stream-incomplete'],
    ['length finish', frame(chunk({ content: 'partial' }, 'length')), 'model-incomplete'],
    ['streamed error', frame({ error: { message: 'rate limited' } }), 'upstream-error'],
  ])('rejects %s before publishing a tool call', async (_label, stream, code) => {
    const endpoint = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(stream + 'data: [DONE]\n\n')
    })
    const provider = await openaiAt(endpoint)
    const deltas: ModelDelta[] = []
    await expect((async () => {
      for await (const delta of provider.stream({ messages: [message], tools: [], signal: freshSignal() })) deltas.push(delta)
    })()).rejects.toMatchObject({ code })
    expect(deltas.some(delta => delta.type === 'tool-call' || delta.type === 'finish')).toBe(false)
  })
})

describe('OpenAI-compatible model selection and reasoning', () => {
  it('honours a requested model, refuses unlisted ones and never echoes reasoning', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const endpoint = await listen((_request, response, body) => {
      bodies.push(JSON.parse(body))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(frame(chunk({ reasoning_content: '先想' })) + frame(chunk({ reasoning: '再想' }))
        + frame(chunk({ reasoning_content: '一次', reasoning: '一次' })) + frame(chunk({ content: '答' }, 'stop')) + 'data: [DONE]\n\n')
    })
    const { providers } = await mount(createOpenAIPlugin({ id: 'deepseek', name: 'DeepSeek', baseURL: endpoint, apiKey: 'k', model: 'model-a', models: ['model-a', 'model-b'] }))
    const provider = providers[0]!
    expect(provider).toMatchObject({ id: 'deepseek', name: 'DeepSeek', model: 'model-a', models: ['model-a', 'model-b'] })
    expect(await collect(provider.stream({ messages: [message], tools: [], signal: freshSignal(), model: 'model-b' }))).toEqual([
      { type: 'reasoning', text: '先想' }, { type: 'reasoning', text: '再想' }, { type: 'reasoning', text: '一次' },
      { type: 'text', text: '答' }, { type: 'finish', reason: 'stop' },
    ])
    await collect(provider.stream({ messages: [message, { role: 'assistant', content: '答' }, { role: 'user', content: '继续' }], tools: [], signal: freshSignal() }))
    expect(bodies.map(body => body.model)).toEqual(['model-b', 'model-a'])
    expect(JSON.stringify(bodies[1])).not.toContain('reasoning')
    await expect(collect(provider.stream({ messages: [message], tools: [], signal: freshSignal(), model: 'model-c' })))
      .rejects.toMatchObject({ name: 'ProviderError', code: 'model-unavailable' })
    expect(bodies).toHaveLength(2)
  })

  it('keeps the single-model configuration open to explicit models and validates the default', async () => {
    const models: unknown[] = []
    const endpoint = await listen((_request, response, body) => {
      models.push(JSON.parse(body).model)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(frame(chunk({ content: 'ok' }, 'stop')))
    })
    const provider = await openaiAt(endpoint)
    expect(provider).toMatchObject({ id: 'openai-compatible', name: 'OpenAI 兼容接口', model: 'test-model' })
    expect(provider.models).toBeUndefined()
    await collect(provider.stream({ messages: [message], tools: [], signal: freshSignal(), model: 'other-model' }))
    expect(models).toEqual(['other-model'])
    expect(() => createOpenAIPlugin({ baseURL: endpoint, apiKey: '', model: 'a', models: ['b'] })).toThrow('默认模型')
    expect(() => createOpenAIPlugin({ baseURL: `${endpoint}?key=1`, apiKey: '', model: 'a' })).toThrow('HTTP(S)')
  })

  it('rejects reasoning that arrives after the finish reason', async () => {
    const endpoint = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(frame(chunk({ content: 'a' }, 'stop')) + frame(chunk({ reasoning_content: 'late' })))
    })
    await expect(collect((await openaiAt(endpoint)).stream({ messages: [message], tools: [], signal: freshSignal() })))
      .rejects.toMatchObject({ code: 'invalid-chunk' })
  })
})

const anthropicEvent = (type: string, data: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
const messageStart = (usage: Record<string, number> = { input_tokens: 12, output_tokens: 1 }) =>
  anthropicEvent('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test', content: [], usage } })
const messageEnd = (reason: string, output = 7) =>
  anthropicEvent('message_delta', { delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: output } }) + anthropicEvent('message_stop')
const textBlock = (index: number, ...parts: string[]) => anthropicEvent('content_block_start', { index, content_block: { type: 'text', text: '' } })
  + parts.map(text => anthropicEvent('content_block_delta', { index, delta: { type: 'text_delta', text } })).join('')
  + anthropicEvent('content_block_stop', { index })
const toolBlock = (index: number, id: string, name: string, ...json: string[]) =>
  anthropicEvent('content_block_start', { index, content_block: { type: 'tool_use', id, name, input: {} } })
  + json.map(partial_json => anthropicEvent('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json } })).join('')
  + anthropicEvent('content_block_stop', { index })

async function anthropicAt(baseURL: string, apiKey = 'local-test-key') {
  const { providers } = await mount(createAnthropicPlugin({ id: 'claude', name: 'Anthropic', baseURL, apiKey, model: 'claude-test', models: ['claude-test', 'claude-other'] }))
  return providers[0]!
}

describe('Anthropic Messages streaming provider', () => {
  it('streams text, thinking and tool use, then maps tool results back into one user turn', async () => {
    const requests: Array<{ url: string | undefined; headers: IncomingMessage['headers']; body: Record<string, unknown> }> = []
    const endpoint = await listen(async (request, response, body) => {
      requests.push({ url: request.url, headers: request.headers, body: JSON.parse(body) })
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      if (requests.length === 2) {
        response.end(messageStart() + textBlock(0, '完成') + messageEnd('end_turn'))
        return
      }
      const stream = messageStart({ input_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 3, output_tokens: 1 })
        + anthropicEvent('ping')
        + anthropicEvent('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } })
        + anthropicEvent('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: '先读文件' } })
        + anthropicEvent('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig' } })
        + anthropicEvent('content_block_stop', { index: 0 })
        + textBlock(1, '开', '始')
        + anthropicEvent('future_event', { anything: true })
        + toolBlock(2, 'toolu_a', 'write_report', '{"content":', '"你好"}')
        + toolBlock(3, 'toolu_b', 'long_task')
        + messageEnd('tool_use', 42)
      const bytes = Buffer.from(stream)
      for (let offset = 0; offset < bytes.length; offset += 11) {
        response.write(bytes.subarray(offset, offset + 11))
        await delay(1)
      }
      response.end()
    })
    const provider = await anthropicAt(endpoint)
    expect(provider).toMatchObject({ id: 'claude', model: 'claude-test', models: ['claude-test', 'claude-other'] })
    const { tools } = await mount(createToolsPlugin())
    const deltas = await collect(provider.stream({
      messages: [{ role: 'system', content: '你是助手' }, message], tools, signal: freshSignal(), model: 'claude-other',
    }))
    expect(deltas).toEqual([
      { type: 'reasoning', text: '先读文件' },
      { type: 'text', text: '开' }, { type: 'text', text: '始' },
      { type: 'usage', inputTokens: 28, outputTokens: 42 },
      { type: 'tool-call', call: { id: 'toolu_a', name: 'write_report', arguments: { content: '你好' } } },
      { type: 'tool-call', call: { id: 'toolu_b', name: 'long_task', arguments: {} } },
      { type: 'finish', reason: 'tool-calls' },
    ])
    const calls = deltas.flatMap(delta => delta.type === 'tool-call' ? [delta.call] : [])
    expect(await collect(provider.stream({
      messages: [{ role: 'system', content: '你是助手' }, message, { role: 'assistant', content: '开始', toolCalls: calls },
        { role: 'tool', content: '产物已写入', toolCallId: 'toolu_a' },
        { role: 'tool', content: '用户取消', toolCallId: 'toolu_b', isError: true }],
      tools, signal: freshSignal(),
    }))).toEqual([{ type: 'text', text: '完成' }, { type: 'usage', inputTokens: 12, outputTokens: 7 }, { type: 'finish', reason: 'stop' }])

    expect(requests[0]).toMatchObject({
      url: '/v1/messages',
      headers: { 'x-api-key': 'local-test-key', 'anthropic-version': '2023-06-01' },
      body: {
        model: 'claude-other', max_tokens: 8192, stream: true, system: '你是助手',
        messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
        tools: [{ name: 'write_report', input_schema: { type: 'object' } }, { name: 'long_task', input_schema: { type: 'object' } }],
      },
    })
    expect(requests[0]?.headers.authorization).toBeUndefined()
    expect(requests[1]?.body).toMatchObject({ model: 'claude-test', system: '你是助手' })
    expect(requests[1]?.body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: '你好' }] },
      { role: 'assistant', content: [
        { type: 'text', text: '开始' },
        { type: 'tool_use', id: 'toolu_a', name: 'write_report', input: { content: '你好' } },
        { type: 'tool_use', id: 'toolu_b', name: 'long_task', input: {} },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_a', content: '产物已写入' },
        { type: 'tool_result', tool_use_id: 'toolu_b', content: '用户取消', is_error: true },
      ] },
    ])
    expect(JSON.stringify(requests[1]?.body)).not.toContain('先读文件')
  })

  it.each([['end_turn'], ['stop_sequence']])('maps stop reason %s to stop', async reason => {
    const endpoint = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(messageStart() + textBlock(0, 'ok') + messageEnd(reason))
    })
    const deltas = await collect((await anthropicAt(endpoint)).stream({ messages: [message], tools: [], signal: freshSignal() }))
    expect(deltas.at(-1)).toEqual({ type: 'finish', reason: 'stop' })
  })

  it('accepts a base URL with or without /v1 and refuses unlisted models before sending', async () => {
    const urls: Array<string | undefined> = []
    const endpoint = await listen((request, response) => {
      urls.push(request.url)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(messageStart() + textBlock(0, 'ok') + messageEnd('end_turn'))
    })
    await collect((await anthropicAt(endpoint.replace(/\/v1$/u, ''))).stream({ messages: [message], tools: [], signal: freshSignal() }))
    await collect((await anthropicAt(`${endpoint}/`)).stream({ messages: [message], tools: [], signal: freshSignal() }))
    expect(urls).toEqual(['/v1/messages', '/v1/messages'])
    await expect(collect((await anthropicAt(endpoint)).stream({ messages: [message], tools: [], signal: freshSignal(), model: 'unlisted' })))
      .rejects.toMatchObject({ code: 'model-unavailable' })
    expect(urls).toHaveLength(2)
  })

  it.each([
    ['max_tokens', messageStart() + textBlock(0, 'partial') + messageEnd('max_tokens'), 'model-incomplete'],
    ['refusal', messageStart() + messageEnd('refusal'), 'model-refusal'],
    ['an error event', messageStart() + textBlock(0, 'partial') + anthropicEvent('error', { error: { type: 'overloaded_error', message: 'Overloaded local-test-key' } }), 'upstream-error'],
    ['a missing message_stop', messageStart() + toolBlock(0, 'toolu_a', 'write_report', '{}') + anthropicEvent('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }), 'stream-incomplete'],
    ['a missing stop reason', messageStart() + textBlock(0, 'partial') + anthropicEvent('message_stop'), 'stream-incomplete'],
    ['events before message_start', textBlock(0, 'x') + messageEnd('end_turn'), 'invalid-chunk'],
    ['a tool_use stop without tool blocks', messageStart() + textBlock(0, 'x') + messageEnd('tool_use'), 'invalid-tool-call'],
    ['tool blocks with an end_turn stop', messageStart() + toolBlock(0, 'toolu_a', 'write_report', '{}') + messageEnd('end_turn'), 'invalid-tool-call'],
    ['invalid tool JSON', messageStart() + toolBlock(0, 'toolu_a', 'write_report', '{"content":') + messageEnd('tool_use'), 'invalid-tool-json'],
    ['array tool JSON', messageStart() + toolBlock(0, 'toolu_a', 'write_report', '[]') + messageEnd('tool_use'), 'invalid-tool-json'],
    ['duplicate tool IDs', messageStart() + toolBlock(0, 'toolu_a', 'write_report', '{}') + toolBlock(1, 'toolu_a', 'long_task', '{}') + messageEnd('tool_use'), 'invalid-tool-call'],
    ['a delta for an unknown block', messageStart() + anthropicEvent('content_block_delta', { index: 4, delta: { type: 'text_delta', text: 'x' } }) + messageEnd('end_turn'), 'invalid-chunk'],
    ['a delta of the wrong kind', messageStart() + anthropicEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      + anthropicEvent('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }), 'invalid-chunk'],
    ['an unsupported block', messageStart() + anthropicEvent('content_block_start', { index: 0, content_block: { type: 'server_tool_use', id: 'x', name: 'web_search' } }), 'unsupported-block'],
    ['an unclosed block', messageStart() + anthropicEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) + messageEnd('end_turn'), 'stream-incomplete'],
    ['content after the stop reason', messageStart() + anthropicEvent('message_delta', { delta: { stop_reason: 'end_turn' } }) + textBlock(0, 'late') + anthropicEvent('message_stop'), 'invalid-chunk'],
    ['invalid SSE JSON', messageStart() + 'data: {broken}\n\n', 'invalid-json'],
  ])('rejects %s before publishing a tool call or finish', async (_label, stream, code) => {
    const endpoint = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(stream)
    })
    const provider = await anthropicAt(endpoint)
    const deltas: ModelDelta[] = []
    const failure = await (async () => {
      for await (const delta of provider.stream({ messages: [message], tools: [], signal: freshSignal() })) deltas.push(delta)
    })().then(() => undefined, (error: unknown) => error)
    expect(failure).toMatchObject({ name: 'ProviderError', code })
    expect(String((failure as Error).message)).not.toContain('local-test-key')
    expect(deltas.some(delta => delta.type === 'tool-call' || delta.type === 'finish')).toBe(false)
  })

  it('returns non-2xx errors with the key redacted', async () => {
    const endpoint = await listen((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key local-test-key' } }))
    })
    await expect(collect((await anthropicAt(endpoint)).stream({ messages: [message], tools: [], signal: freshSignal() })))
      .rejects.toMatchObject({ code: 'http-error', status: 401, message: expect.stringContaining('[redacted]') })
  })

  it('aborts a stalled stream and closes its connection', async () => {
    let closed = false
    let receivedResolve: () => void = () => { throw new Error('Listener not initialized') }
    const received = new Promise<void>(resolve => { receivedResolve = resolve })
    const endpoint = await listen((_request, response) => {
      response.on('close', () => { closed = true })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(messageStart() + anthropicEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }))
      receivedResolve()
    })
    const controller = new AbortController()
    const result = collect((await anthropicAt(endpoint)).stream({ messages: [message], tools: [], signal: controller.signal }))
    const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await received
    controller.abort()
    await rejection
    await expect.poll(() => closed).toBe(true)
  })
})

describe('Host provider helpers', () => {
  const record = (kind: ProviderRecord['kind'], baseURL: string): ProviderRecord => ({
    id: 'svc', name: '服务', kind, baseURL, apiKey: 'list-secret', keyOrigin: originOf(baseURL), enabled: true, models: ['m1', 'm2'], defaultModel: 'm2',
  })

  it('builds one plugin per provider record and summarizes it without credentials', async () => {
    for (const kind of ['openai-compatible', 'anthropic'] as const) {
      const plugin = providerPlugin(record(kind, 'https://example.test/v1'), { fetch: unusedFetch })
      expect(plugin.id).toBe('svc')
      const { providers } = await mount(plugin)
      expect(providers[0]).toMatchObject({ id: 'svc', name: '服务', model: 'm2', models: ['m1', 'm2'] })
      expect(summarizeProvider(providers[0]!, kind)).toEqual({ id: 'svc', name: '服务', kind, models: ['m1', 'm2'], defaultModel: 'm2' })
    }
    const legacy: ModelProvider = { id: 'plugin', name: 'P', model: 'only', async *stream() { yield { type: 'finish', reason: 'stop' } } }
    expect(summarizeProvider(legacy, 'plugin')).toEqual({ id: 'plugin', name: 'P', kind: 'plugin', models: ['only'], defaultModel: 'only' })
    const settings = providerSettings({ ...record('anthropic', 'https://api.anthropic.com'), presetId: 'anthropic' })
    expect(settings).toEqual({
      id: 'svc', name: '服务', kind: 'anthropic', presetId: 'anthropic', baseURL: 'https://api.anthropic.com',
      hasKey: true, keyOrigin: 'https://api.anthropic.com:443', enabled: true, models: ['m1', 'm2'], defaultModel: 'm2',
    })
    expect(JSON.stringify(settings)).not.toContain('list-secret')
  })

  it('lists OpenAI-compatible models with the stored key and normalizes the result', async () => {
    const seen: Array<{ url: string | undefined; authorization: string | undefined }> = []
    const endpoint = await listen((request, response) => {
      seen.push({ url: request.url, authorization: request.headers.authorization })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-b', object: 'model' }, { id: 'gpt-a' }, { id: 'gpt-b' }, { id: ' ' }, { id: 'x'.repeat(300) }] }))
    })
    expect(await listProviderModels({ kind: 'openai-compatible', baseURL: endpoint, apiKey: 'list-secret' }, freshSignal(), direct)).toEqual(['gpt-a', 'gpt-b'])
    const check = await checkProvider({ kind: 'openai-compatible', baseURL: `${endpoint}/`, apiKey: '' }, freshSignal(), direct)
    expect(check).toMatchObject({ ok: true, models: ['gpt-a', 'gpt-b'] })
    expect(check.latencyMs).toBeGreaterThanOrEqual(0)
    expect(seen).toEqual([{ url: '/v1/models', authorization: 'Bearer list-secret' }, { url: '/v1/models', authorization: undefined }])
  })

  it('pages through Anthropic models with native headers', async () => {
    const seen: Array<{ url: string | undefined; key: unknown; version: unknown }> = []
    const endpoint = await listen((request, response) => {
      seen.push({ url: request.url, key: request.headers['x-api-key'], version: request.headers['anthropic-version'] })
      response.writeHead(200, { 'content-type': 'application/json' })
      const first = !request.url?.includes('after_id')
      response.end(JSON.stringify(first
        ? { data: [{ id: 'claude-b', type: 'model' }], has_more: true, first_id: 'claude-b', last_id: 'claude-b' }
        : { data: [{ id: 'claude-a', type: 'model' }], has_more: false, first_id: 'claude-a', last_id: 'claude-a' }))
    })
    expect(await listProviderModels({ kind: 'anthropic', baseURL: endpoint.replace(/\/v1$/u, ''), apiKey: 'list-secret' }, freshSignal(), direct)).toEqual(['claude-a', 'claude-b'])
    expect(seen).toEqual([
      { url: '/v1/models?limit=1000', key: 'list-secret', version: '2023-06-01' },
      { url: '/v1/models?limit=1000&after_id=claude-b', key: 'list-secret', version: '2023-06-01' },
    ])
  })

  it('reports listing failures with stable codes and without the key', async () => {
    let redirectTargetHit = false
    const endpoint = await listen((request, response) => {
      if (request.url === '/v1/elsewhere/models') { redirectTargetHit = true; response.end('{}'); return }
      if (request.url?.startsWith('/v1/auth')) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'bad key list-secret' } }))
      } else if (request.url?.startsWith('/v1/redirect')) {
        response.writeHead(302, { location: '/v1/elsewhere/models' }); response.end()
      } else if (request.url?.startsWith('/v1/declared')) {
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(9 * 1024 * 1024) })
        response.write('{"data":[')
      } else if (request.url?.startsWith('/v1/huge')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(`{"data":[],"pad":"${'x'.repeat(8 * 1024 * 1024)}"}`)
      } else if (request.url?.startsWith('/v1/html')) {
        response.writeHead(200, { 'content-type': 'text/html' }); response.end('<html>')
      } else if (request.url?.startsWith('/v1/shape')) {
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ name: 'no id' }] }))
      }
      // `/v1/stall` never answers.
    })
    const list = (path: string, options?: { timeoutMs?: number }) =>
      listProviderModels({ kind: 'openai-compatible', baseURL: `${endpoint}/${path}`, apiKey: 'list-secret' }, freshSignal(), { ...direct, ...options })
        .then(() => undefined, (error: unknown) => error)
    const failures = {
      auth: await list('auth'), redirect: await list('redirect'), declared: await list('declared'), huge: await list('huge'),
      html: await list('html'), shape: await list('shape'), stall: await list('stall', { timeoutMs: 50 }),
    }
    expect(failures).toMatchObject({
      auth: { name: 'ProviderError', code: 'http-error', status: 401, message: expect.stringContaining('API Key 无效') },
      redirect: { code: 'redirect' }, declared: { code: 'response-too-large' }, huge: { code: 'response-too-large' },
      html: { code: 'invalid-response' }, shape: { code: 'invalid-response' }, stall: { code: 'timeout' },
    })
    for (const failure of Object.values(failures)) expect(String((failure as Error).message)).not.toContain('list-secret')
    expect(String((failures.auth as Error).message)).toContain('[redacted]')
    expect(redirectTargetHit).toBe(false)
    await expect(listProviderModels({ kind: 'openai-compatible', baseURL: 'ftp://example.test', apiKey: '' }, freshSignal(), { fetch: unusedFetch }))
      .rejects.toMatchObject({ code: 'invalid-url' })
  })

  it('propagates the caller abort instead of a timeout', async () => {
    const endpoint = await listen(() => { /* never answers */ })
    const controller = new AbortController()
    const pending = listProviderModels({ kind: 'openai-compatible', baseURL: endpoint, apiKey: '' }, controller.signal, direct)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('offers browser-safe presets with exact base URLs', () => {
    const byId = Object.fromEntries(PROVIDER_PRESETS.map(preset => [preset.id, preset]))
    expect(new Set(PROVIDER_PRESETS.map(preset => preset.id)).size).toBe(PROVIDER_PRESETS.length)
    expect(byId.anthropic).toMatchObject({ kind: 'anthropic', baseURL: 'https://api.anthropic.com', requiresKey: true })
    expect(byId.ollama).toMatchObject({ kind: 'openai-compatible', baseURL: 'http://127.0.0.1:11434/v1', requiresKey: false })
    expect(byId.custom).toMatchObject({ baseURL: '', requiresKey: false })
    for (const preset of PROVIDER_PRESETS) if (preset.baseURL) expect(() => providerPlugin({ ...record(preset.kind, preset.baseURL), apiKey: '' }, { fetch: unusedFetch })).not.toThrow()
  })
})

describe('Host egress and key origin binding', () => {
  const offline = 'http://127.0.0.1:9/v1' // Nothing listens there; a request that bypasses the injected fetch fails.
  const record = (kind: ProviderRecord['kind'], extra: Partial<ProviderRecord> = {}): ProviderRecord => ({
    id: 'svc', name: '服务', kind, baseURL: offline, apiKey: 'origin-secret', keyOrigin: 'http://127.0.0.1:9',
    enabled: true, models: ['m1'], defaultModel: 'm1', ...extra,
  })
  const denial = (target: string) => Object.assign(new Error('denied by policy'), { code: 'egress-denied', target, reason: 'metadata' })

  function scripted(calls: Array<{ url: string; init: RequestInit }>): FetchLike {
    return async (url, init) => {
      calls.push({ url, init })
      if (url.includes('/models')) return Response.json({ data: [{ id: 'listed' }] })
      const body = url.endsWith('/chat/completions')
        ? frame(chunk({ content: '经由注入' }, 'stop'))
        : messageStart() + textBlock(0, '经由注入') + messageEnd('end_turn')
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    }
  }

  it('sends streams, listings and checks only through the injected fetch, never following redirects', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetch = scripted(calls)
    for (const kind of ['openai-compatible', 'anthropic'] as const) {
      const { providers } = await mount(providerPlugin(record(kind), { fetch }))
      const deltas = await collect(providers[0]!.stream({ messages: [message], tools: [], signal: freshSignal() }))
      expect(deltas.filter(delta => delta.type === 'text')).toEqual([{ type: 'text', text: '经由注入' }])
      expect(await listProviderModels({ kind, baseURL: offline, apiKey: 'origin-secret' }, freshSignal(), { fetch })).toEqual(['listed'])
      expect(await checkProvider({ kind, baseURL: offline, apiKey: '' }, freshSignal(), { fetch })).toMatchObject({ ok: true, models: ['listed'] })
    }
    expect(calls.map(call => new URL(call.url).pathname)).toEqual([
      '/v1/chat/completions', '/v1/models', '/v1/models', '/v1/messages', '/v1/models', '/v1/models',
    ])
    expect(calls.every(call => call.init.redirect === 'error')).toBe(true)
    const headers = calls.map(call => new Headers(call.init.headers))
    expect(headers[0]!.get('authorization')).toBe('Bearer origin-secret')
    expect(headers[3]!.get('x-api-key')).toBe('origin-secret')
  })

  it('maps egress denials to egress-denied with the target, whether thrown directly or as the cause', async () => {
    const viaCause: FetchLike = async () => { throw new TypeError('fetch failed', { cause: denial('169.254.169.254:80') }) }
    const thrown: FetchLike = async () => { throw denial('[fd00::1]:443') }
    const expected = (target: string) => ({
      name: 'ProviderError', code: 'egress-denied', target, message: `Host 出站策略拒绝访问 ${target}（本机、私网或元数据地址）。`,
    })
    await expect(listProviderModels({ kind: 'openai-compatible', baseURL: 'http://169.254.169.254/v1', apiKey: 'origin-secret' }, freshSignal(), { fetch: viaCause }))
      .rejects.toMatchObject(expected('169.254.169.254:80'))
    await expect(checkProvider({ kind: 'anthropic', baseURL: offline, apiKey: '' }, freshSignal(), { fetch: thrown }))
      .rejects.toMatchObject(expected('[fd00::1]:443'))
    for (const kind of ['openai-compatible', 'anthropic'] as const) {
      for (const [fetch, target] of [[viaCause, '169.254.169.254:80'], [thrown, '[fd00::1]:443']] as const) {
        const { providers } = await mount(providerPlugin(record(kind), { fetch }))
        await expect(collect(providers[0]!.stream({ messages: [message], tools: [], signal: freshSignal() }))).rejects.toMatchObject(expected(target))
      }
    }
    const refused: FetchLike = async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }) }
    await expect(listProviderModels({ kind: 'openai-compatible', baseURL: offline, apiKey: '' }, freshSignal(), { fetch: refused }))
      .rejects.toMatchObject({ code: 'network-error', message: expect.stringContaining('ECONNREFUSED') })
  })

  it('uses a saved key only at the origin it was saved for', async () => {
    const saved = record('openai-compatible')
    expect(usableKey(saved)).toBe('origin-secret')
    expect(usableKey({ ...saved, baseURL: 'HTTP://127.0.0.1:9/elsewhere' })).toBe('origin-secret')
    for (const moved of [
      { ...saved, baseURL: 'http://127.0.0.1:10/v1' }, { ...saved, baseURL: 'https://127.0.0.1:9/v1' },
      { ...saved, baseURL: 'http://localhost:9/v1' }, { ...saved, keyOrigin: undefined }, { ...saved, baseURL: 'not a url' },
    ]) expect(usableKey(moved)).toBe('')
    const moved = { ...saved, baseURL: 'http://127.0.0.1:10/v1' }
    expect(providerSettings(saved)).toMatchObject({ hasKey: true, keyOrigin: 'http://127.0.0.1:9' })
    expect(providerSettings(moved).hasKey).toBe(false)
    expect(providerSettings(moved)).not.toHaveProperty('keyOrigin')

    const calls: Array<{ url: string; init: RequestInit }> = []
    for (const kind of ['openai-compatible', 'anthropic'] as const) {
      const { providers } = await mount(providerPlugin({ ...moved, kind }, { fetch: scripted(calls) }))
      await collect(providers[0]!.stream({ messages: [message], tools: [], signal: freshSignal() }))
    }
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      const headers = new Headers(call.init.headers)
      expect(headers.get('authorization')).toBeNull()
      expect(headers.get('x-api-key')).toBeNull()
    }
  })

  it('normalizes origins with an explicit port', () => {
    expect(originOf('https://API.Example.test/v1')).toBe('https://api.example.test:443')
    expect(originOf('http://example.test')).toBe('http://example.test:80')
    expect(originOf('https://example.test:8443/')).toBe('https://example.test:8443')
    expect(originOf('http://[::1]:8080/v1')).toBe('http://[::1]:8080')
    for (const invalid of ['ftp://example.test', 'not a url']) expect(() => originOf(invalid)).toThrow(expect.objectContaining({ code: 'invalid-url' }))
  })

  it('refuses the metadata address, unlisted loopback and redirects through the Host egress fetch', async () => {
    const { createEgressFetch } = await import('../src/host/egress.ts')
    let redirectTargetHit = false
    const endpoint = await listen((request, response) => {
      if (request.url === '/v1/elsewhere/models') { redirectTargetHit = true; response.end('{}'); return }
      if (request.url?.startsWith('/v1/redirect')) { response.writeHead(302, { location: '/v1/elsewhere/models' }); response.end(); return }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'local-model' }] }))
    })
    const local = new URL(endpoint).host
    const allow: string[] = []
    const fetch = createEgressFetch({ allow: () => allow }) as FetchLike
    const list = (baseURL: string) => listProviderModels({ kind: 'openai-compatible', baseURL, apiKey: 'origin-secret' }, freshSignal(), { fetch })
    await expect(list('http://169.254.169.254/v1')).rejects.toMatchObject({ code: 'egress-denied', target: '169.254.169.254:80' })
    await expect(list(endpoint)).rejects.toMatchObject({ code: 'egress-denied', target: local })
    allow.push(local)
    expect(await list(endpoint)).toEqual(['local-model'])
    await expect(list(`${endpoint}/redirect`)).rejects.toMatchObject({ code: 'redirect' })
    expect(redirectTargetHit).toBe(false)
  })
})

describe('API key redaction in upstream errors', () => {
  const key = 'sk-THIS-IS-THE-SECRET-KEY/0123456789+abcdef'
  /** Every 6-character piece of the key; none may reach a caller. */
  const pieces = (secret: string) => Array.from({ length: secret.length - 5 }, (_, index) => secret.slice(index, index + 6))
  const leaks = (text: string) => pieces(key).filter(piece => text.includes(piece))

  it('redacts before clipping, so a key echoed across the 512-character boundary does not leak its start', async () => {
    const endpoint = await listen((_request, response) => {
      response.writeHead(401, { 'content-type': 'text/plain' })
      response.end(`${'x'.repeat(472)}Incorrect API key provided: ${key}`)
    })
    const failure = await collect((await openaiAt(endpoint, key)).stream({ messages: [message], tools: [], signal: freshSignal() })).then(() => undefined, (error: unknown) => error)
    expect(failure).toMatchObject({ code: 'http-error', status: 401 })
    const text = String((failure as Error).message)
    expect(leaks(text)).toEqual([])
    expect(text).toContain('[redacted]')

    const anthropic = await collect((await anthropicAt(endpoint, key)).stream({ messages: [message], tools: [], signal: freshSignal() })).then(() => undefined, (error: unknown) => error)
    expect(leaks(String((anthropic as Error).message))).toEqual([])
    const listing = await listProviderModels({ kind: 'openai-compatible', baseURL: endpoint, apiKey: key }, freshSignal(), direct).then(() => undefined, (error: unknown) => error)
    expect(leaks(String((listing as Error).message))).toEqual([])
  })

  it('redacts JSON-escaped and URL-encoded echoes of the key', async () => {
    const endpoint = await listen((request, response) => {
      response.writeHead(400, { 'content-type': 'application/json' })
      if (request.url?.includes('chat')) response.end(`{"error":{"message":"bad key ${JSON.stringify(key).slice(1, -1).replace(/\//gu, '\\/')}"}}`)
      else response.end(`{"error":"bad key ${encodeURIComponent(key)}"}`)
    })
    const chat = await collect((await openaiAt(endpoint, key)).stream({ messages: [message], tools: [], signal: freshSignal() })).then(() => undefined, (error: unknown) => error)
    expect(leaks(String((chat as Error).message).replace(/\\\//gu, '/'))).toEqual([])
    const listing = await listProviderModels({ kind: 'openai-compatible', baseURL: endpoint, apiKey: key }, freshSignal(), direct).then(() => undefined, (error: unknown) => error)
    expect(leaks(decodeURIComponent(String((listing as Error).message)))).toEqual([])
  })

  it('clips to 512 characters and drops a clipped tail that starts the key', () => {
    const redact = redactor(key)
    expect(redact(`a ${key} b`)).toBe('a [redacted] b')
    expect(redact('y'.repeat(600))).toBe('y'.repeat(512))
    const cut = `${'y'.repeat(500)}${key.slice(0, 12)}`
    expect(redact(cut)).toBe(`${'y'.repeat(500)}[redacted]`)
    expect(redactor('')('z'.repeat(600))).toBe('z'.repeat(512))
  })
})

describe('demo provider and bounded tools', () => {
  async function fixture() {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'harness-link-tools-'))
    cleanups.push(() => rm(workspaceRoot, { recursive: true, force: true }))
    const { providers, tools } = await mount(createDemoPlugin(), createToolsPlugin())
    return { provider: providers[0]!, tools, workspaceRoot }
  }

  it('requests real approval-gated writing and only reports success after a real tool result', async () => {
    const { provider, tools, workspaceRoot } = await fixture()
    const prompt: ModelMessage = { role: 'user', content: '生成需要审批的报告' }
    const output = await collect(provider.stream({ messages: [prompt], tools, signal: freshSignal() }))
    const call = output.find(delta => delta.type === 'tool-call')
    expect(call?.type).toBe('tool-call')
    if (call?.type !== 'tool-call') throw new Error('Missing tool call')
    const report = tools.find(tool => tool.name === call.call.name)!
    expect(report.requiresApproval).toBe(true)
    await expect(readFile(join(workspaceRoot, 'artifacts/report-session1.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    const result = await report.execute({ content: '真实报告内容' }, { workspaceRoot, sessionId: 'session1', callId: call.call.id, signal: freshSignal() })
    expect(await readFile(join(workspaceRoot, 'artifacts/report-session1.txt'), 'utf8')).toBe('真实报告内容')
    const history: ModelMessage[] = [prompt, { role: 'assistant', content: '', toolCalls: [call.call] },
      { role: 'tool', content: result.text, toolCallId: call.call.id }]
    const completed = await collect(provider.stream({ messages: history, tools, signal: freshSignal() }))
    expect(completed.flatMap(delta => delta.type === 'text' ? [delta.text] : []).join('')).toContain('报告已写入')
    const rejected = await collect(provider.stream({ messages: [...history.slice(0, -1),
      { role: 'tool', content: '用户拒绝审批', toolCallId: call.call.id, isError: true }], tools, signal: freshSignal() }))
    expect(rejected.flatMap(delta => delta.type === 'text' ? [delta.text] : []).join('')).toContain('操作未完成')
    expect(rejected.some(delta => delta.type === 'tool-call')).toBe(false)
  })

  it('does not trigger tools when unavailable and starts a distinct call for a new user turn', async () => {
    const { provider, tools } = await fixture()
    const prompt: ModelMessage = { role: 'user', content: '审批报告' }
    expect((await collect(provider.stream({ messages: [prompt], tools: [], signal: freshSignal() })))
      .some(delta => delta.type === 'tool-call')).toBe(false)
    const first = (await collect(provider.stream({ messages: [prompt], tools, signal: freshSignal() })))
      .find(delta => delta.type === 'tool-call')
    if (first?.type !== 'tool-call') throw new Error('Missing call')
    const second = await collect(provider.stream({ messages: [prompt, { role: 'assistant', content: '', toolCalls: [first.call] },
      { role: 'tool', content: '用户拒绝', toolCallId: first.call.id, isError: true }, { role: 'user', content: '重新生成报告' }], tools, signal: freshSignal() }))
    const next = second.find(delta => delta.type === 'tool-call')
    expect(next?.type).toBe('tool-call')
    if (next?.type !== 'tool-call') throw new Error('Missing new-turn tool call')
    expect(next.call.id).not.toBe(first.call.id)
  })

  it('cancels the fixed long task without writing a completion artifact', async () => {
    const { tools, workspaceRoot } = await fixture()
    const controller = new AbortController()
    const pending = tools.find(tool => tool.name === 'long_task')!.execute({}, {
      workspaceRoot, sessionId: 'cancelled', callId: 'call-wait', signal: controller.signal,
    })
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await delay(20)
    controller.abort()
    await rejection
    expect(await readdir(workspaceRoot)).toEqual([])
  })

  it('rejects path/duration overrides, oversized content, unsafe session IDs and symlink directories', async () => {
    const { tools, workspaceRoot } = await fixture()
    const report = tools.find(tool => tool.name === 'write_report')!
    const longTask = tools.find(tool => tool.name === 'long_task')!
    const context = { workspaceRoot, sessionId: 'session1', callId: 'call', signal: freshSignal() }
    await expect(report.execute({ path: '/tmp/outside' }, context)).rejects.toThrow('路径')
    await expect(report.execute({ content: '中'.repeat(30_000) }, context)).rejects.toThrow('64 KiB')
    await expect(longTask.execute({ duration: 1 }, context)).rejects.toThrow('时长')
    await expect(report.execute({}, { ...context, sessionId: '../escape' })).rejects.toThrow('标识')
    const outside = join(workspaceRoot, 'outside')
    await mkdir(outside)
    await symlink(outside, join(workspaceRoot, 'artifacts'))
    await expect(report.execute({}, context)).rejects.toThrow('符号链接')
    expect(await readdir(outside)).toEqual([])
  })

  it('atomically replaces a symlink filename without writing its target', async () => {
    const { tools, workspaceRoot } = await fixture()
    await mkdir(join(workspaceRoot, 'artifacts'))
    const target = join(workspaceRoot, 'outside.txt')
    await writeFile(target, 'keep')
    await symlink(target, join(workspaceRoot, 'artifacts/report-session1.txt'))
    await tools.find(tool => tool.name === 'write_report')!.execute({ content: 'new report' }, {
      workspaceRoot, sessionId: 'session1', callId: 'call', signal: freshSignal(),
    })
    expect(await readFile(target, 'utf8')).toBe('keep')
    expect(await readFile(join(workspaceRoot, 'artifacts/report-session1.txt'), 'utf8')).toBe('new report')
    expect(await readdir(join(workspaceRoot, 'artifacts'))).toEqual(['report-session1.txt'])
  })
})
