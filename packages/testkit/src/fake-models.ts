/**
 * Local model services that answer like OpenAI's Chat Completions (`/v1/chat/completions`) and Anthropic's Messages
 * (`/v1/messages`), streamed or not, from a script of replies. No model and no network: they listen on 127.0.0.1, accept
 * any key, and keep every request they get, which is how a test proves an agent reached them and not a real service.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeReply {
  /** Thinking, sent before the text where the protocol has a place for it. */
  reasoning?: string
  text?: string
  /** One tool call; the reply ends asking for it. A pattern names the first tool the request offers that matches it. */
  tool?: { name: string | RegExp; input: Record<string, unknown> }
}

export interface FakeModelRequest {
  wire: 'chat-completions' | 'anthropic-messages'
  path: string
  model?: string
  stream: boolean
  body: unknown
}

export interface FakeModels {
  /** `http://127.0.0.1:<port>`; the services live below `/v1`. */
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

function sse(response: ServerResponse, events: Array<{ event?: string; data: unknown }>): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const item of events)
    response.write(
      `${item.event ? `event: ${item.event}\n` : ''}data: ${typeof item.data === 'string' ? item.data : JSON.stringify(item.data)}\n\n`,
    )
  response.end()
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
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
    const tool = item as { name?: unknown; function?: { name?: unknown } }
    const name = tool.function?.name ?? tool.name
    return typeof name === 'string' ? [name] : []
  })
  const found = offered.find(name => pattern.test(name))
  return found
    ? { ...reply, tool: { ...reply.tool, name: found } }
    : { ...reply, tool: undefined, text: reply.text ?? `no offered tool matches ${pattern}` }
}

function chat(reply: FakeReply, model: string, stream: boolean): { events?: Array<{ data: unknown }>; body?: unknown } {
  const id = 'chatcmpl-fake'
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  const call = reply.tool && {
    id: 'call_fake_1',
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

function anthropic(reply: FakeReply, model: string, stream: boolean): { events?: Array<{ event: string; data: unknown }>; body?: unknown } {
  const content: Array<Record<string, unknown>> = [
    ...(reply.reasoning ? [{ type: 'thinking', thinking: reply.reasoning, signature: 'fake-signature' }] : []),
    ...(reply.text ? [{ type: 'text', text: reply.text }] : []),
    ...(reply.tool ? [{ type: 'tool_use', id: 'toolu_fake_1', name: String(reply.tool.name), input: reply.tool.input }] : []),
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
        data: { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'fake-signature' } },
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

/**
 * Starts both services on one port. Each request takes the next reply of `replies`; once they run out, the last one
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
      const wire = path === '/v1/chat/completions' ? 'chat-completions' : path === '/v1/messages' ? 'anthropic-messages' : undefined
      if (request.method !== 'POST' || !wire)
        return json(response, 404, { error: { message: `no such endpoint: ${request.method} ${path}` } })
      let body: Record<string, unknown>
      try {
        body = JSON.parse(await readBody(request)) as Record<string, unknown>
      } catch {
        return json(response, 400, { error: { message: 'the body is not JSON' } })
      }
      const model = typeof body.model === 'string' ? body.model : 'fake-model'
      const stream = body.stream === true
      requests.push({ wire, path, model, stream, body })
      const reply = named(next(), body)
      const made = wire === 'chat-completions' ? chat(reply, model, stream) : anthropic(reply, model, stream)
      if (made.events) sse(response, made.events)
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
