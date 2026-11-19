/**
 * A local model service for measuring what a harness sends through the gateway: it answers in the three protocols the
 * gateway speaks upstream, streams every reply in pieces with a gap between them, reports usage in each protocol's own
 * shape with cached tokens worked out from what the request shares with the one before, and records every request's
 * body, when it arrived and when each piece of its reply left. Listens on 127.0.0.1 only and accepts any key.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { performance } from 'node:perf_hooks'
import type { ModelWire, TokenUsage } from '@latch/protocol'

export interface UpstreamReply {
  reasoning?: string
  text?: string
  tool?: { name: string; input: Record<string, unknown> }
  error?: { status: number; body: unknown; retryAfter?: string }
  /** Headers and the first piece of the reply, then the connection is dropped. */
  cut?: true
  /** Headers and the first piece, then nothing until the client goes away. */
  hold?: true
  /** The input tokens the usage reports, whatever the request's size, as for a conversation near its window. */
  inflate?: number
}

export interface UpstreamRequest {
  n: number
  wire: ModelWire
  path: string
  /** `performance.now()` when its headers arrived. */
  at: number
  text: string
  body: Record<string, unknown>
  stream: boolean
  reply?: UpstreamReply
  /** The usage object as sent, in the protocol's shape. */
  usage?: Record<string, unknown>
  /** The same usage as Latch counts tokens: input with cached tokens in it, output with reasoning in it. */
  tokens?: TokenUsage
  /** The usage left in the reply: a reply that broke off or was held before its usage never said it. */
  usageSent?: true
  /** `performance.now()` as each piece of the reply was written. */
  pieces: number[]
  /** When the client's connection closed, for a reply that was held open. */
  closedAt?: number
  /** Which connection it came on, numbered as they opened: requests that share one did not pay for a new connection. */
  connection: number
}

export interface RecordingUpstream {
  origin: string
  requests: UpstreamRequest[]
  close(): Promise<void>
}

/** The part of a request a service's prompt cache hashes, in the order it does: tools, then system, then messages. */
export function cacheable(wire: ModelWire, body: Record<string, unknown>): string {
  // Where the cache marks sit is not part of what is cached: a mark that moves forward each request leaves the prefix.
  // Text given as a string is rendered as the one text block it stands for, so the two forms are the same prefix.
  if (wire === 'anthropic-messages') {
    const blocks = (content: unknown) => (typeof content === 'string' ? [{ type: 'text', text: content }] : content)
    const messages = Array.isArray(body.messages)
      ? (body.messages as Array<Record<string, unknown>>).map(message => ({ ...message, content: blocks(message.content) }))
      : null
    return JSON.stringify([body.tools ?? null, body.system === undefined ? null : blocks(body.system), messages], (key, value: unknown) =>
      key === 'cache_control' ? undefined : value,
    )
  }
  if (wire === 'responses') return JSON.stringify([body.tools ?? null, body.instructions ?? null, body.input ?? null])
  return JSON.stringify([body.tools ?? null, body.messages ?? null])
}

export function commonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

const tokensOf = (text: string) => Math.ceil(text.length / 4)

/** Tools a request offers, by name and parameter schema, in any of the three protocols. */
export function offeredTools(body: Record<string, unknown>): Array<{ name: string; parameters: Record<string, unknown> }> {
  const list = Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : []
  return list.flatMap(tool => {
    if (tool.type === 'namespace' && Array.isArray(tool.tools)) return offeredTools({ tools: tool.tools })
    const fn = tool.function as Record<string, unknown> | undefined
    const name = (fn?.name ?? tool.name) as unknown
    const parameters = (fn?.parameters ?? tool.parameters ?? tool.input_schema ?? {}) as Record<string, unknown>
    return typeof name === 'string' ? [{ name, parameters }] : []
  })
}

/** Whether the conversation ends with a tool's result: the model is to answer it. */
export function endsWithToolResult(wire: ModelWire, body: Record<string, unknown>): boolean {
  if (wire === 'responses') {
    const input = Array.isArray(body.input) ? (body.input as Array<Record<string, unknown>>) : []
    return /_call_output$/u.test(String(input.at(-1)?.type ?? ''))
  }
  const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : []
  const last = messages.at(-1)
  if (!last) return false
  if (wire === 'chat-completions') {
    if (last.role === 'tool') return true
    // A tool's images come after its results as a user message.
    return last.role === 'user' && messages.at(-2)?.role === 'tool'
  }
  return last.role === 'user' && Array.isArray(last.content) && last.content.some(block => block?.type === 'tool_result')
}

/** The text of the request's last user message: what the harness is asking right now. */
export function lastUserText(wire: ModelWire, body: Record<string, unknown>): string {
  const list = (wire === 'responses' ? body.input : body.messages) as Array<Record<string, unknown>> | string | undefined
  if (typeof list === 'string') return list
  const last = (list ?? []).findLast(item => item.role === 'user')
  if (!last) return ''
  if (typeof last.content === 'string') return last.content
  // The last text part: what a harness puts before it (reminders, context) is not the question.
  return (
    (Array.isArray(last.content) ? (last.content as Array<Record<string, unknown>>) : [])
      .flatMap(part => (typeof part?.text === 'string' ? [part.text] : []))
      .at(-1) ?? ''
  )
}

/** All user text of a request, joined: enough to find a turn's marker. */
export function userText(wire: ModelWire, body: Record<string, unknown>): string {
  const texts: string[] = []
  const take = (content: unknown) => {
    if (typeof content === 'string') texts.push(content)
    else if (Array.isArray(content))
      for (const part of content as Array<Record<string, unknown>>) if (typeof part?.text === 'string') texts.push(part.text)
  }
  if (wire === 'responses') {
    if (typeof body.input === 'string') texts.push(body.input)
    for (const item of Array.isArray(body.input) ? (body.input as Array<Record<string, unknown>>) : [])
      if (item.role === 'user') take(item.content)
  } else
    for (const message of Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [])
      if (message.role === 'user') take(message.content)
  return texts.join('\n')
}

/** Whether a request marks any part of itself for the prompt cache, the way Anthropic's API asks for it. */
const hinted = (text: string) => text.includes('"cache_control"')

function usageFor(
  wire: ModelWire,
  shape: 'openai' | 'deepseek',
  total: number,
  prefix: number,
  hint: boolean,
  n: number,
  reasoning: boolean,
): { usage: Record<string, unknown>; tokens: TokenUsage } {
  const output = 40 + n
  const thought = reasoning ? 9 : 0
  if (wire === 'anthropic-messages') {
    // Anthropic caches only up to a marked block: without a mark nothing is read or written.
    const read = hint ? Math.min(prefix, total - 3) : 0
    const write = hint ? Math.max(total - read - 3, 0) : 0
    const input = total - read - write
    return {
      usage: { input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output },
      tokens: { inputTokens: total, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write },
    }
  }
  // OpenAI-style services cache automatically, by 128-token blocks of a prefix of at least 1024.
  const cached = prefix >= 1024 ? Math.floor(prefix / 128) * 128 : 0
  if (wire === 'responses')
    return {
      usage: {
        input_tokens: total,
        input_tokens_details: { cached_tokens: cached },
        output_tokens: output,
        output_tokens_details: { reasoning_tokens: thought },
        total_tokens: total + output,
      },
      tokens: { inputTokens: total, outputTokens: output, cacheReadTokens: cached, reasoningTokens: thought },
    }
  return {
    usage:
      shape === 'deepseek'
        ? {
            prompt_tokens: total,
            completion_tokens: output,
            total_tokens: total + output,
            prompt_cache_hit_tokens: cached,
            prompt_cache_miss_tokens: total - cached,
            completion_tokens_details: { reasoning_tokens: thought },
          }
        : {
            prompt_tokens: total,
            completion_tokens: output,
            total_tokens: total + output,
            prompt_tokens_details: { cached_tokens: cached },
            completion_tokens_details: { reasoning_tokens: thought },
          },
    tokens: { inputTokens: total, outputTokens: output, cacheReadTokens: cached, reasoningTokens: thought },
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ''
    request.setEncoding('utf8')
    request.on('data', chunk => (text += chunk))
    request.on('end', () => resolve(text))
    request.on('error', reject)
  })
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function words(text: string, count: number): string[] {
  const all = text.match(/\S+\s*/gu) ?? [text]
  const size = Math.max(1, Math.ceil(all.length / count))
  const pieces: string[] = []
  for (let i = 0; i < all.length; i += size) pieces.push(all.slice(i, i + size).join(''))
  return pieces
}

export async function startRecordingUpstream(options: {
  plan: (request: UpstreamRequest) => UpstreamReply
  usageShape?: 'openai' | 'deepseek'
  gapMs?: number
}): Promise<RecordingUpstream> {
  const requests: UpstreamRequest[] = []
  const gap = options.gapMs ?? 100
  const shape = options.usageShape ?? 'openai'
  // Every prefix a service saw stays cached for the session, as a prompt cache keeps them: each request reads the longest.
  const previous: Record<ModelWire, string[]> = { 'chat-completions': [], responses: [], 'anthropic-messages': [] }
  let connections = 0
  const ids = new WeakMap<object, number>()
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'recording upstream failed' } }))
      } else res.destroy()
    })
  })
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const at = performance.now()
    const path = (req.url ?? '/').split('?')[0]!
    if (req.method === 'GET' && path === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [] }))
      return
    }
    const text = await readBody(req)
    const body = JSON.parse(text) as Record<string, unknown>
    if (path === '/v1/messages/count_tokens') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ input_tokens: tokensOf(cacheable('anthropic-messages', body)) }))
      return
    }
    const wire: ModelWire | undefined =
      path === '/v1/chat/completions'
        ? 'chat-completions'
        : path === '/v1/responses'
          ? 'responses'
          : path === '/v1/messages'
            ? 'anthropic-messages'
            : undefined
    if (!wire) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `no such endpoint ${path}` } }))
      return
    }
    if (!ids.has(req.socket)) ids.set(req.socket, ++connections)
    const record: UpstreamRequest = {
      n: requests.length + 1,
      wire,
      path,
      at,
      text,
      body,
      stream: body.stream === true,
      pieces: [],
      connection: ids.get(req.socket)!,
    }
    requests.push(record)
    res.once('close', () => (record.closedAt = performance.now()))
    const reply = options.plan(record)
    record.reply = reply
    if (reply.error) {
      res.writeHead(reply.error.status, {
        'content-type': 'application/json',
        ...(reply.error.retryAfter ? { 'retry-after': reply.error.retryAfter } : {}),
      })
      res.end(JSON.stringify(reply.error.body))
      return
    }
    const cache = cacheable(wire, body)
    const prefix = tokensOf(cache.slice(0, Math.max(0, ...previous[wire].map(seen => commonPrefix(seen, cache)))))
    previous[wire].push(cache)
    const total = reply.inflate ?? tokensOf(cache) + 12
    const { usage, tokens } = usageFor(wire, shape, total, reply.inflate ? 0 : prefix, hinted(text), record.n, !!reply.reasoning)
    record.usage = usage
    record.tokens = tokens
    const model = typeof body.model === 'string' ? body.model : 'unknown'
    const events = eventsFor(wire, reply, model, usage, record.n, body)
    if (!record.stream) {
      // A reply sent whole breaks or waits as a streamed one would: nothing of it arrives.
      if (reply.cut) {
        res.destroy()
        return
      }
      if (reply.hold) return
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(events.whole))
      record.pieces.push(performance.now())
      record.usageSent = true
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    // A reply that stops early, broken here or given up on by the client, said only what its first events said: for
    // Anthropic the input and one output token, for the others nothing of usage.
    const early = () => {
      if (record.usageSent && record.tokens) record.tokens = { ...record.tokens, outputTokens: 1 }
    }
    for (const [index, group] of events.stream.entries()) {
      if (index > 0 && group.gap) await pause(gap)
      if (res.destroyed) return early()
      res.write(group.frames.join(''))
      record.pieces.push(performance.now())
      if (group.usage) record.usageSent = true
      if ((reply.cut || reply.hold) && group.gap) {
        if (reply.cut) setTimeout(() => res.destroy(), 20)
        return early()
      }
    }
    res.end()
  }
  // As a service behind a load balancer keeps a connection: a client that reuses it never waits for a new one.
  server.keepAliveTimeout = 120_000
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

const sse = (data: unknown, event?: string) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`

/**
 * The reply as groups of frames: each group after the first that has `gap` waits before it goes. The first group carries
 * the reply's start; text goes in four pieces.
 */
function eventsFor(
  wire: ModelWire,
  reply: UpstreamReply,
  model: string,
  usage: Record<string, unknown>,
  n: number,
  request: Record<string, unknown>,
): { stream: Array<{ frames: string[]; gap: boolean; usage?: true }>; whole: unknown } {
  const text = reply.text ?? (reply.tool ? '' : 'ok')
  const pieces = text ? words(text, 4) : []
  const callId = `call_gwm_${n}`
  if (wire === 'chat-completions') {
    const chunk = (delta: unknown, finish: string | null = null, extra: Record<string, unknown> = {}) => ({
      id: `chatcmpl-gwm-${n}`,
      object: 'chat.completion.chunk',
      created: 1_794_700_000,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...extra,
    })
    const finish = reply.tool ? 'tool_calls' : 'stop'
    const call = reply.tool && {
      id: callId,
      type: 'function',
      function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.input) },
    }
    return {
      stream: [
        {
          frames: [
            sse(chunk({ role: 'assistant', content: '' })),
            ...(reply.reasoning ? [sse(chunk({ reasoning_content: reply.reasoning }))] : []),
          ],
          gap: false,
        },
        ...pieces.map(piece => ({ frames: [sse(chunk({ content: piece }))], gap: true })),
        ...(call ? [{ frames: [sse(chunk({ tool_calls: [{ index: 0, ...call }] }))], gap: true }] : []),
        { frames: [sse(chunk({}, finish)), sse({ ...chunk({}, null), choices: [], usage }), 'data: [DONE]\n\n'], gap: false, usage: true },
      ],
      whole: {
        id: `chatcmpl-gwm-${n}`,
        object: 'chat.completion',
        created: 1_794_700_000,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: text || null,
              ...(reply.reasoning ? { reasoning_content: reply.reasoning } : {}),
              ...(call ? { tool_calls: [call] } : {}),
            },
            finish_reason: finish,
          },
        ],
        usage,
      },
    }
  }
  if (wire === 'responses') {
    let sequence = 0
    const event = (type: string, data: Record<string, unknown>) => sse({ type, sequence_number: sequence++, ...data }, type)
    const encrypted = Array.isArray(request.include) && request.include.includes('reasoning.encrypted_content')
    const reasoning = reply.reasoning && {
      type: 'reasoning',
      id: `rs_gwm_${n}`,
      summary: [{ type: 'summary_text', text: reply.reasoning }],
      ...(encrypted ? { encrypted_content: `gwm-encrypted-${n}` } : {}),
    }
    const message = text && {
      type: 'message',
      id: `msg_gwm_${n}`,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    }
    const call = reply.tool && {
      type: 'function_call',
      id: `fc_gwm_${n}`,
      call_id: callId,
      name: reply.tool.name,
      arguments: JSON.stringify(reply.tool.input),
      status: 'completed',
    }
    const output = [reasoning, message, call].filter(Boolean) as Array<Record<string, unknown>>
    const response = (status: string, items: unknown[]) => ({
      id: `resp_gwm_${n}`,
      object: 'response',
      created_at: 1_794_700_000,
      model,
      status,
      output: items,
      usage: status === 'completed' ? usage : null,
    })
    const groups: Array<{ frames: string[]; gap: boolean; usage?: true }> = [
      { frames: [event('response.created', { response: response('in_progress', []) })], gap: false },
    ]
    output.forEach((item, index) => {
      if (item.type === 'reasoning')
        groups.push({
          frames: [
            event('response.output_item.added', { output_index: index, item: { ...item, summary: [] } }),
            event('response.reasoning_summary_text.delta', {
              item_id: item.id,
              output_index: index,
              summary_index: 0,
              delta: reply.reasoning,
            }),
            event('response.output_item.done', { output_index: index, item }),
          ],
          gap: false,
        })
      if (item.type === 'message') {
        groups.push({ frames: [event('response.output_item.added', { output_index: index, item: { ...item, content: [] } })], gap: false })
        for (const piece of pieces)
          groups.push({
            frames: [
              event('response.output_text.delta', { item_id: item.id, output_index: index, content_index: 0, delta: piece, logprobs: [] }),
            ],
            gap: true,
          })
        groups.push({ frames: [event('response.output_item.done', { output_index: index, item })], gap: false })
      }
      if (item.type === 'function_call')
        groups.push({
          frames: [
            event('response.output_item.added', { output_index: index, item: { ...item, arguments: '' } }),
            event('response.function_call_arguments.delta', { item_id: item.id, output_index: index, delta: item.arguments }),
            event('response.output_item.done', { output_index: index, item }),
          ],
          gap: true,
        })
    })
    groups.push({ frames: [event('response.completed', { response: response('completed', output) })], gap: false, usage: true })
    return { stream: groups, whole: response('completed', output) }
  }
  const startUsage = { ...usage, output_tokens: 1 }
  const message = {
    id: `msg_gwm_${n}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: startUsage,
  }
  const groups: Array<{ frames: string[]; gap: boolean; usage?: true }> = [
    { frames: [sse({ type: 'message_start', message }, 'message_start')], gap: false, usage: true },
  ]
  const content: Array<Record<string, unknown>> = []
  let index = 0
  if (reply.reasoning) {
    const signature = `gwm-signature-${n}`
    content.push({ type: 'thinking', thinking: reply.reasoning, signature })
    groups.push({
      frames: [
        sse({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } }, 'content_block_start'),
        sse({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: reply.reasoning } }, 'content_block_delta'),
        sse({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } }, 'content_block_delta'),
        sse({ type: 'content_block_stop', index }, 'content_block_stop'),
      ],
      gap: false,
    })
    index++
  }
  if (pieces.length) {
    content.push({ type: 'text', text })
    groups.push({
      frames: [sse({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }, 'content_block_start')],
      gap: false,
    })
    for (const piece of pieces)
      groups.push({
        frames: [sse({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } }, 'content_block_delta')],
        gap: true,
      })
    groups.push({ frames: [sse({ type: 'content_block_stop', index }, 'content_block_stop')], gap: false })
    index++
  }
  if (reply.tool) {
    content.push({ type: 'tool_use', id: callId.replace('call_', 'toolu_'), name: reply.tool.name, input: reply.tool.input })
    groups.push({
      frames: [
        sse(
          {
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id: callId.replace('call_', 'toolu_'), name: reply.tool.name, input: {} },
          },
          'content_block_start',
        ),
        sse(
          { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply.tool.input) } },
          'content_block_delta',
        ),
        sse({ type: 'content_block_stop', index }, 'content_block_stop'),
      ],
      gap: true,
    })
  }
  const stop = reply.tool ? 'tool_use' : 'end_turn'
  groups.push({
    frames: [
      sse({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage }, 'message_delta'),
      sse({ type: 'message_stop' }, 'message_stop'),
    ],
    gap: false,
  })
  return { stream: groups, whole: { ...message, content, stop_reason: stop, usage } }
}
