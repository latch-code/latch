/**
 * Local model services that answer like OpenAI's Chat Completions (`/v1/chat/completions`) and Responses
 * (`/v1/responses`), Anthropic's Messages (`/v1/messages`, and `/v1/messages/count_tokens`) and Gemini's generateContent
 * (`/v1beta/models/<model>:streamGenerateContent`, `:generateContent`, also under `/v1`), streamed or not, from a script of replies. No
 * model and no network: they listen on 127.0.0.1, accept any key, and keep every request they get, which is how a test
 * proves an agent reached them and not a real service.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeReply {
  /**
   * Thinking, sent before the text where the protocol has a place for it. Anthropic signs it, and Responses encrypts it
   * when the request includes `reasoning.encrypted_content`, with `fake-signature-<n>` and `fake-encrypted-<n>` for the
   * n-th request, so a test can see which response's reasoning a later request carried back.
   */
  reasoning?: string
  text?: string
  /** One tool call; the reply ends asking for it. A pattern names the first tool the request offers that matches it. */
  tool?: { name: string | RegExp; input: Record<string, unknown> }
  /**
   * Refuse the request with this HTTP status and message, in the protocol's error shape (Anthropic's type follows the
   * status: 401, 402, 429, 529…), with a `retry-after` header when given.
   */
  error?: { status: number; message: string; retryAfter?: number }
  /** Waits this long before the first byte of the answer, as a slow service does. */
  delayMs?: number
  /** A streamed reply stops after its first event and the connection is dropped, as a service that fails mid-reply. */
  cut?: true
  /** The model the reply says answered, where the protocol names one; otherwise the model the request named. */
  answeredBy?: string
  /** A streamed reply's stream stays open this long after its last event, as behind a proxy or with keep-alive. */
  lingerMs?: number
}

export interface FakeModelRequest {
  wire: 'chat-completions' | 'responses' | 'anthropic-messages' | 'gemini'
  path: string
  model?: string
  stream: boolean
  body: unknown
  /** The key it carried, in whichever header its protocol puts one, so a test can tell which credential arrived. */
  key?: string
  /** Header names it carried, lower case and sorted, without their values. */
  headerNames: string[]
}

export interface FakeModels {
  /** `http://127.0.0.1:<port>`; the services live below `/v1`, and Gemini's below `/v1beta`. */
  origin: string
  /** Every request, in order, without its headers. */
  requests: FakeModelRequest[]
  close(): Promise<void>
}

const MODELS = ['fake-model', 'fake-model-large']

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ''
    request.setEncoding('utf8')
    request.on('data', chunk => {
      text += chunk
      if (text.length > 8 * 1024 * 1024) request.destroy(new Error('request too large'))
    })
    request.on('end', () => resolve(text))
    request.on('error', reject)
  })
}

function sse(response: ServerResponse, events: Array<{ event?: string; data: unknown }>, lingerMs = 0, cut = false): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-request-id': 'req_fake' })
  for (const item of cut ? events.slice(0, 1) : events)
    response.write(
      `${item.event ? `event: ${item.event}\n` : ''}data: ${typeof item.data === 'string' ? item.data : JSON.stringify(item.data)}\n\n`,
    )
  if (cut) setTimeout(() => response.destroy(), 10).unref()
  else if (lingerMs > 0) setTimeout(() => response.end(), lingerMs).unref()
  else response.end()
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers })
  response.end(JSON.stringify(body))
}

/** Splits text the way a model streams it, a few words at a time, so a client's joining is exercised. */
function pieces(text: string): string[] {
  return text.match(/\S+\s*|\s+/gu) ?? []
}

/** The tool a reply calls: its name, or the first tool the request offers whose name matches the pattern. */
function named(reply: FakeReply, body: Record<string, unknown>): FakeReply {
  if (!reply.tool || typeof reply.tool.name === 'string') return reply
  const pattern = reply.tool.name
  const offered = (Array.isArray(body.tools) ? body.tools : []).flatMap(item => {
    const tool = item as { name?: unknown; function?: { name?: unknown }; functionDeclarations?: Array<{ name?: unknown }> }
    const names = tool.functionDeclarations?.map(declaration => declaration.name) ?? [tool.function?.name ?? tool.name]
    return names.filter((name): name is string => typeof name === 'string')
  })
  const found = offered.find(name => pattern.test(name))
  return found
    ? { ...reply, tool: { ...reply.tool, name: found } }
    : { ...reply, tool: undefined, text: reply.text ?? `no offered tool matches ${pattern}` }
}

function chat(reply: FakeReply, model: string, stream: boolean, served: number): { events?: Array<{ data: unknown }>; body?: unknown } {
  const id = 'chatcmpl-fake'
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  const call = reply.tool && {
    id: `call_fake_${served}`,
    type: 'function',
    function: { name: String(reply.tool.name), arguments: JSON.stringify(reply.tool.input) },
  }
  const finish = call ? 'tool_calls' : 'stop'
  if (!stream)
    return {
      body: {
        id,
        object: 'chat.completion',
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: reply.text ?? null,
              ...(reply.reasoning ? { reasoning_content: reply.reasoning } : {}),
              ...(call ? { tool_calls: [call] } : {}),
            },
            finish_reason: finish,
          },
        ],
        usage,
      },
    }
  const chunk = (delta: unknown, finishReason: string | null = null) => ({
    id,
    object: 'chat.completion.chunk',
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })
  return {
    events: [
      { data: chunk({ role: 'assistant', content: '' }) },
      ...pieces(reply.reasoning ?? '').map(piece => ({ data: chunk({ reasoning_content: piece }) })),
      ...pieces(reply.text ?? '').map(piece => ({ data: chunk({ content: piece }) })),
      ...(call ? [{ data: chunk({ tool_calls: [{ index: 0, ...call }] }) }] : []),
      { data: { ...chunk({}, finish), usage } },
      { data: '[DONE]' },
    ],
  }
}

function anthropic(
  reply: FakeReply,
  model: string,
  stream: boolean,
  served: number,
): { events?: Array<{ event: string; data: unknown }>; body?: unknown } {
  const signature = `fake-signature-${served}`
  const content: Array<Record<string, unknown>> = [
    ...(reply.reasoning ? [{ type: 'thinking', thinking: reply.reasoning, signature }] : []),
    ...(reply.text ? [{ type: 'text', text: reply.text }] : []),
    ...(reply.tool ? [{ type: 'tool_use', id: `toolu_fake_${served}`, name: String(reply.tool.name), input: reply.tool.input }] : []),
  ]
  const stop = reply.tool ? 'tool_use' : 'end_turn'
  const message = {
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    model,
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 1 },
  }
  if (!stream) return { body: { ...message, content, stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 } } }
  const events: Array<{ event: string; data: unknown }> = [
    { event: 'message_start', data: { type: 'message_start', message: { ...message, content: [] } } },
  ]
  content.forEach((block, index) => {
    const start =
      block.type === 'thinking'
        ? { type: 'thinking', thinking: '' }
        : block.type === 'text'
          ? { type: 'text', text: '' }
          : { type: 'tool_use', id: block.id, name: block.name, input: {} }
    events.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: start } })
    if (block.type === 'thinking') {
      for (const piece of pieces(block.thinking as string))
        events.push({
          event: 'content_block_delta',
          data: { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: piece } },
        })
      events.push({
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } },
      })
    } else if (block.type === 'text') {
      for (const piece of pieces(block.text as string))
        events.push({
          event: 'content_block_delta',
          data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } },
        })
    } else
      events.push({
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } },
      })
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } })
  })
  events.push(
    {
      event: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  )
  return { events }
}

function responses(
  reply: FakeReply,
  model: string,
  stream: boolean,
  served: number,
  encrypted: boolean,
): { events?: Array<{ event: string; data: unknown }>; body?: unknown } {
  const usage = {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 5,
    output_tokens_details: { reasoning_tokens: reply.reasoning ? 2 : 0 },
    total_tokens: 15,
  }
  const reasoning = reply.reasoning && {
    type: 'reasoning',
    id: `rs_fake_${served}`,
    summary: [{ type: 'summary_text', text: reply.reasoning }],
    ...(encrypted ? { encrypted_content: `fake-encrypted-${served}` } : {}),
  }
  const message = reply.text && {
    type: 'message',
    id: `msg_fake_${served}`,
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: reply.text, annotations: [] }],
  }
  const call = reply.tool && {
    type: 'function_call',
    id: `fc_fake_${served}`,
    call_id: `call_fake_${served}`,
    name: String(reply.tool.name),
    arguments: JSON.stringify(reply.tool.input),
    status: 'completed',
  }
  const output = [reasoning, message, call].filter(item => !!item) as Array<Record<string, unknown>>
  const response = (status: string, items: unknown[]) => ({
    id: 'resp_fake',
    object: 'response',
    model,
    status,
    output: items,
    usage: status === 'completed' ? usage : null,
  })
  if (!stream) return { body: response('completed', output) }
  const events: Array<{ event: string; data: unknown }> = []
  const push = (type: string, data: Record<string, unknown>) => {
    events.push({ event: type, data: { type, sequence_number: events.length, ...data } })
  }
  push('response.created', { response: response('in_progress', []) })
  output.forEach((item, index) => {
    push('response.output_item.added', {
      output_index: index,
      item: item.type === 'message' ? { ...item, content: [] } : item.type === 'function_call' ? { ...item, arguments: '' } : item,
    })
    if (item.type === 'reasoning')
      for (const piece of pieces(reply.reasoning ?? ''))
        push('response.reasoning_summary_text.delta', { item_id: item.id, output_index: index, summary_index: 0, delta: piece })
    if (item.type === 'message')
      for (const piece of pieces(reply.text ?? ''))
        push('response.output_text.delta', { item_id: item.id, output_index: index, content_index: 0, delta: piece, logprobs: [] })
    if (item.type === 'function_call')
      push('response.function_call_arguments.delta', { item_id: item.id, output_index: index, delta: item.arguments })
    push('response.output_item.done', { output_index: index, item })
  })
  push('response.completed', { response: response('completed', output) })
  return { events }
}

function gemini(reply: FakeReply, model: string, stream: boolean, served: number): { events?: Array<{ data: unknown }>; body?: unknown } {
  const usageMetadata = { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: reply.reasoning ? 2 : 0, totalTokenCount: 17 }
  const call = reply.tool && {
    functionCall: { id: `call_fake_${served}`, name: String(reply.tool.name), args: reply.tool.input },
    thoughtSignature: 'fake-signature',
  }
  const chunk = (parts: unknown[], last = false) => ({
    candidates: [{ index: 0, content: { role: 'model', parts }, ...(last ? { finishReason: 'STOP' } : {}) }],
    ...(last ? { usageMetadata } : {}),
    modelVersion: model,
  })
  if (!stream)
    return {
      body: chunk(
        [
          ...(reply.reasoning ? [{ text: reply.reasoning, thought: true }] : []),
          ...(reply.text ? [{ text: reply.text }] : []),
          ...(call ? [call] : []),
        ],
        true,
      ),
    }
  return {
    events: [
      ...pieces(reply.reasoning ?? '').map(piece => ({ data: chunk([{ text: piece, thought: true }]) })),
      ...pieces(reply.text ?? '').map(piece => ({ data: chunk([{ text: piece }]) })),
      { data: chunk(call ? [call] : [{ text: '' }], true) },
    ],
  }
}

/** Anthropic's error types by status. */
const ANTHROPIC_TYPES: Record<number, string> = {
  401: 'authentication_error',
  402: 'billing_error',
  403: 'permission_error',
  404: 'not_found_error',
  429: 'rate_limit_error',
  500: 'api_error',
  529: 'overloaded_error',
}

/** The error a protocol answers with: OpenAI's and Anthropic's `error.message`, Gemini's `error.status` as well. */
function failure(wire: FakeModelRequest['wire'], error: NonNullable<FakeReply['error']>): unknown {
  if (wire === 'gemini') return { error: { code: error.status, message: error.message, status: 'INVALID_ARGUMENT' } }
  if (wire === 'anthropic-messages')
    return { type: 'error', error: { type: ANTHROPIC_TYPES[error.status] ?? 'invalid_request_error', message: error.message } }
  return { error: { message: error.message, type: 'invalid_request_error', code: null } }
}

// Gemini answers under `v1` as well as `v1beta`.
const GEMINI_CALL = /^\/v1(?:beta)?\/models\/([^/:]+):(streamGenerateContent|generateContent)$/u

/**
 * Starts every service on one port. Each request takes the next reply of `replies`; once they run out, the last one
 * repeats, and without any the reply is the text `ok`.
 */
export async function startFakeModels(options: { replies?: FakeReply[] } = {}): Promise<FakeModels> {
  const replies = [...(options.replies ?? [])]
  const requests: FakeModelRequest[] = []
  let served = 0
  const next = (): FakeReply => (replies.length ? replies[Math.min(served++, replies.length - 1)]! : { text: 'ok' })
  const server = createServer((request, response) => {
    void (async () => {
      const path = (request.url ?? '/').split('?')[0]!
      if (request.method === 'GET' && path === '/v1/models')
        return json(response, 200, { object: 'list', data: MODELS.map(id => ({ id, object: 'model', type: 'model', display_name: id })) })
      if (request.method === 'GET' && path === '/v1beta/models')
        return json(response, 200, {
          models: [
            ...MODELS.map(id => ({ name: `models/${id}`, supportedGenerationMethods: ['generateContent', 'countTokens'] })),
            { name: 'models/fake-embedding', supportedGenerationMethods: ['embedContent'] },
          ],
        })
      if (request.method === 'POST' && path === '/v1/messages/count_tokens') {
        const body = JSON.parse(await readBody(request)) as Record<string, unknown>
        requests.push({
          wire: 'anthropic-messages',
          path,
          ...(typeof body.model === 'string' ? { model: body.model } : {}),
          stream: false,
          body,
          ...(typeof request.headers['x-api-key'] === 'string' ? { key: request.headers['x-api-key'] } : {}),
          headerNames: Object.keys(request.headers).sort(),
        })
        return json(response, 200, { input_tokens: 10 })
      }
      const geminiCall = GEMINI_CALL.exec(path)
      const wire: FakeModelRequest['wire'] | undefined = geminiCall
        ? 'gemini'
        : path === '/v1/chat/completions'
          ? 'chat-completions'
          : path === '/v1/responses'
            ? 'responses'
            : path === '/v1/messages'
              ? 'anthropic-messages'
              : undefined
      if (request.method !== 'POST' || !wire)
        return json(response, 404, { error: { message: `no such endpoint: ${request.method} ${path}` } })
      let body: Record<string, unknown>
      try {
        body = JSON.parse(await readBody(request)) as Record<string, unknown>
      } catch {
        return json(response, 400, { error: { message: 'the body is not JSON' } })
      }
      const model = geminiCall ? decodeURIComponent(geminiCall[1]!) : typeof body.model === 'string' ? body.model : 'fake-model'
      const stream = geminiCall ? geminiCall[2] === 'streamGenerateContent' : body.stream === true
      const bearer = request.headers.authorization?.replace(/^Bearer\s+/iu, '')
      const key = bearer ?? [request.headers['x-goog-api-key'], request.headers['x-api-key']].find(value => typeof value === 'string')
      requests.push({
        wire,
        path,
        model,
        stream,
        body,
        ...(typeof key === 'string' ? { key } : {}),
        headerNames: Object.keys(request.headers).sort(),
      })
      const reply = named(next(), body)
      if (reply.delayMs) await new Promise(resolve => setTimeout(resolve, reply.delayMs))
      if (reply.error)
        return json(
          response,
          reply.error.status,
          failure(wire, reply.error),
          reply.error.retryAfter !== undefined ? { 'retry-after': String(reply.error.retryAfter) } : {},
        )
      const made =
        wire === 'chat-completions'
          ? chat(reply, model, stream, requests.length)
          : wire === 'responses'
            ? responses(
                reply,
                reply.answeredBy ?? model,
                stream,
                requests.length,
                Array.isArray(body.include) && body.include.includes('reasoning.encrypted_content'),
              )
            : wire === 'gemini'
              ? gemini(reply, reply.answeredBy ?? model, stream, requests.length)
              : anthropic(reply, model, stream, requests.length)
      if (made.events) sse(response, made.events, reply.lingerMs, reply.cut === true)
      else json(response, 200, made.body)
    })().catch(() => {
      if (!response.headersSent) json(response, 500, { error: { message: 'fake model failed' } })
      else response.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
