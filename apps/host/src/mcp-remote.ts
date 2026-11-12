// The Host's MCP client for remote servers (Streamable HTTP, MCP 2025-06-18). It speaks only to the address a local
// confirmation bound, through the Host's outbound fetch (its egress rules), and refuses any redirect, so a server's
// request headers reach no other origin. Every answer is bounded in size and time; the server's own requests are
// declined, as the `latch-mcp` bridge declines a local server's. See docs/MCP.md.
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { FetchLike } from './egress.ts'
import { sseData } from './plugins/providers/http.ts'

export const MCP_PROTOCOL_VERSION = '2025-06-18'
/** Versions this client speaks; the server's answer to `initialize` must name one. */
const VERSIONS = new Set(['2025-03-26', '2025-06-18', '2025-11-25'])
/** One request's longest wait, answer included. */
export const REMOTE_TIMEOUT_MS = 60_000
/** One answer's largest size, JSON or a whole event stream. */
export const REMOTE_MAX_BYTES = 2 * 1024 * 1024
/** Pages of `tools/list` followed before the rest is left out. */
const MAX_PAGES = 8
const SESSION_ID = /^[\x21-\x7E]{1,256}$/u
/** The server's own requests declined with a reply, per answer; any more are dropped without one. */
export const MAX_DECLINES = 16
/** Requests in flight to one origin from this Host, every session together; more wait their turn. */
export const MAX_PER_ORIGIN = 8

const origins = new Map<string, { active: number; waiting: Array<() => void> }>()

/** A turn to send to `origin`: resolves with its release once fewer than `MAX_PER_ORIGIN` are in flight. */
async function turn(origin: string, signal?: AbortSignal): Promise<() => void> {
  let slot = origins.get(origin)
  if (!slot) origins.set(origin, (slot = { active: 0, waiting: [] }))
  const held = slot
  while (held.active >= MAX_PER_ORIGIN) {
    signal?.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener('abort', stop)
        resolve()
      }
      const stop = () => {
        held.waiting.splice(held.waiting.indexOf(wake), 1)
        reject(signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'))
      }
      held.waiting.push(wake)
      signal?.addEventListener('abort', stop, { once: true })
    })
  }
  held.active++
  let released = false
  return () => {
    if (released) return
    released = true
    held.active--
    held.waiting.shift()?.()
    if (held.active === 0 && held.waiting.length === 0) origins.delete(origin)
  }
}

/** How many requests are in flight to `origin` now, for tests. */
export function inFlight(origin: string): number {
  return origins.get(origin)?.active ?? 0
}

/** Why a remote call failed, in the words of `McpFailure`; never the server's text, a header or its value. */
export type RemoteFailure = 'auth-required' | 'unreachable' | 'refused' | 'timeout' | 'protocol' | 'output-too-large'

export class McpRemoteError extends Error {
  readonly code = 'mcp-remote'
  constructor(
    readonly reason: RemoteFailure,
    message: string,
  ) {
    super(message)
    this.name = 'McpRemoteError'
  }
}

const MESSAGES: Readonly<Record<RemoteFailure, string>> = {
  'auth-required': 'The MCP server asks for a login, which Latch does not do yet.',
  unreachable: 'The MCP server could not be reached or answered with an HTTP error.',
  refused: 'Latch did not connect: the address is not allowed, or the server redirected elsewhere.',
  timeout: 'The MCP server did not answer in time.',
  protocol: 'The MCP server did not answer as MCP.',
  'output-too-large': 'The MCP server answered with more than Latch reads.',
}
const failed = (reason: RemoteFailure) => new McpRemoteError(reason, MESSAGES[reason])

/** A JSON-RPC answer: its result, or the server's error (a tool that does not exist, say). */
export type RemoteAnswer = { result: unknown } | { error: { code: number; message: string } }

const answerSchema = z.union([
  z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number()]), result: z.unknown() }).passthrough(),
  z
    .object({
      jsonrpc: z.literal('2.0'),
      id: z.union([z.string(), z.number(), z.null()]),
      error: z.object({ code: z.number(), message: z.string() }).passthrough(),
    })
    .passthrough(),
])
const errorSchema = z.object({ code: z.number(), message: z.string() }).passthrough()
const toolSchema = z
  .object({
    name: z.string().min(1).max(128),
    description: z.string().optional(),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
export type RemoteTool = z.infer<typeof toolSchema>

/** A stream that errors once more than `limit` bytes passed. */
function bounded(body: ReadableStream<Uint8Array>, limit: number): ReadableStream<Uint8Array> {
  let size = 0
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength
        if (size > limit) controller.error(failed('output-too-large'))
        else controller.enqueue(chunk)
      },
    }),
  )
}

async function readAll(body: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = bounded(body, limit).getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    chunks.push(next.value)
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
}

export interface McpRemoteOptions {
  /** The confirmed address, origin and path: every request goes here and nowhere else. */
  url: string
  /** The server's request headers. Never logged, never in an error. */
  headers: Readonly<Record<string, string>>
  /** The Host's outbound fetch. */
  fetch: FetchLike
  timeoutMs?: number
  maxBytes?: number
}

/**
 * One MCP session with a remote server: `initialize` once (again when the server forgets the session, answering 404),
 * then requests, each a POST to the bound address with the session ID and protocol version the spec asks for. `close`
 * ends the session on the server (DELETE).
 */
export class McpRemoteSession {
  private sessionId: string | undefined
  private version: string | undefined
  private nextId = 1
  private starting: Promise<Record<string, unknown>> | undefined
  private closed = false
  private readonly timeoutMs: number
  private readonly maxBytes: number

  constructor(private readonly options: McpRemoteOptions) {
    this.timeoutMs = options.timeoutMs ?? REMOTE_TIMEOUT_MS
    this.maxBytes = options.maxBytes ?? REMOTE_MAX_BYTES
  }

  /** The server's answer to `initialize`: its version, capabilities and name. */
  initialize(signal?: AbortSignal): Promise<Record<string, unknown>> {
    this.starting ??= this.start(signal).catch((error: unknown) => {
      this.starting = undefined
      throw error
    })
    return this.starting
  }

  private async start(signal?: AbortSignal): Promise<Record<string, unknown>> {
    this.sessionId = undefined
    this.version = undefined
    const id = this.nextId++
    const { answer, response } = await this.post(
      {
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        // The client offers no capability: no roots, sampling or elicitation for the server to ask for.
        params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'latch', version: '1' } },
      },
      id,
      signal,
    )
    if (!answer || 'error' in answer || !answer.result || typeof answer.result !== 'object') throw failed('protocol')
    const result = answer.result as Record<string, unknown>
    if (typeof result.protocolVersion !== 'string' || !VERSIONS.has(result.protocolVersion)) throw failed('protocol')
    const session = response.headers.get('mcp-session-id')
    if (session !== null && !SESSION_ID.test(session)) throw failed('protocol')
    this.sessionId = session ?? undefined
    this.version = result.protocolVersion
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, undefined, signal)
    return result
  }

  /** One request, after `initialize`; a session the server forgot (404) starts again once. */
  async request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<RemoteAnswer> {
    await this.initialize(signal)
    try {
      return await this.once(method, params, signal)
    } catch (error) {
      if (!(error instanceof SessionGone)) throw error
      this.starting = undefined
      await this.initialize(signal)
      return this.once(method, params, signal)
    }
  }

  private async once(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<RemoteAnswer> {
    const id = this.nextId++
    try {
      const { answer } = await this.post({ jsonrpc: '2.0', id, method, params }, id, signal)
      if (!answer) throw failed('protocol')
      return answer
    } catch (error) {
      // Stopped by whoever asked: the server hears it too, without waiting for its answer.
      if (signal?.aborted && !this.closed)
        void this.post(
          { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'cancelled' } },
          undefined,
        ).catch(() => {})
      throw error
    }
  }

  /** The server's tools, every page up to a bound. */
  async listTools(signal?: AbortSignal): Promise<RemoteTool[]> {
    const tools: RemoteTool[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const answer = await this.request('tools/list', cursor ? { cursor } : {}, signal)
      if ('error' in answer) throw failed('protocol')
      const parsed = z
        .object({ tools: z.array(z.unknown()).max(1024), nextCursor: z.string().max(1024).optional() })
        .passthrough()
        .safeParse(answer.result)
      if (!parsed.success) throw failed('protocol')
      for (const item of parsed.data.tools) {
        const tool = toolSchema.safeParse(item)
        if (tool.success) tools.push(tool.data)
      }
      cursor = parsed.data.nextCursor
      if (!cursor) break
    }
    return tools
  }

  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<RemoteAnswer> {
    return this.request('tools/call', { name, arguments: args }, signal)
  }

  /** Ends the session on the server, when it gave one; nothing waits on the answer for long. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const session = this.sessionId
    if (!session) return
    const timeout = AbortSignal.timeout(5000)
    let release: (() => void) | undefined
    try {
      release = await turn(new URL(this.options.url).origin, timeout)
      const response = await this.options.fetch(this.options.url, {
        method: 'DELETE',
        headers: this.headers(),
        redirect: 'manual',
        signal: timeout,
      })
      await response.body?.cancel().catch(() => {})
    } catch {
      /* The server may be gone already. */
    } finally {
      release?.()
    }
  }

  private headers(): Headers {
    const headers = new Headers()
    for (const [name, value] of Object.entries(this.options.headers)) headers.set(name, value)
    headers.set('content-type', 'application/json')
    headers.set('accept', 'application/json, text/event-stream')
    if (this.version) headers.set('mcp-protocol-version', this.version)
    if (this.sessionId) headers.set('mcp-session-id', this.sessionId)
    return headers
  }

  /**
   * POSTs one message to the bound address and reads the answer to `id`, from JSON or an event stream; a notification
   * expects 202. A redirect, a refused address, a login, an HTTP error, a stop and a timeout each fail in their own
   * words, none of which carries a header.
   */
  private async post(
    message: Record<string, unknown>,
    id: number | undefined,
    signal?: AbortSignal,
  ): Promise<{ answer?: RemoteAnswer; response: Response }> {
    if (this.closed && message.method !== 'notifications/cancelled') throw failed('unreachable')
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    let release: () => void
    try {
      release = await turn(new URL(this.options.url).origin, combined)
    } catch (error) {
      throw this.failure(error, signal, timeout)
    }
    try {
      return await this.send(message, id, signal, timeout, combined)
    } finally {
      release()
    }
  }

  private async send(
    message: Record<string, unknown>,
    id: number | undefined,
    signal: AbortSignal | undefined,
    timeout: AbortSignal,
    combined: AbortSignal,
  ): Promise<{ answer?: RemoteAnswer; response: Response }> {
    let response: Response
    try {
      response = await this.options.fetch(this.options.url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(message),
        // Never followed: a server's headers go to the confirmed origin and path alone.
        redirect: 'manual',
        signal: combined,
      })
    } catch (error) {
      throw this.failure(error, signal, timeout)
    }
    try {
      if (response.status >= 300 && response.status < 400) throw failed('refused')
      if (response.status === 401) throw failed('auth-required')
      if (response.status === 404 && this.sessionId && message.method !== 'initialize') throw new SessionGone()
      if (!response.ok) throw failed('unreachable')
      if (id === undefined) {
        // Nothing is read from a notification's answer; its body is let go so the connection is free.
        await response.body?.cancel().catch(() => {})
        return { response }
      }
      const declines = { left: MAX_DECLINES }
      const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
      if (!response.body) throw failed('protocol')
      if (type === 'application/json') {
        const text = await readAll(response.body, this.maxBytes)
        return { answer: this.pick(JSON.parse(text) as unknown, id, declines), response }
      }
      if (type === 'text/event-stream') {
        for await (const data of sseData(bounded(response.body, this.maxBytes), combined)) {
          let parsed: unknown
          try {
            parsed = JSON.parse(data) as unknown
          } catch {
            continue
          }
          const answer = this.pick(parsed, id, declines)
          if (answer) return { answer, response }
        }
        throw failed('protocol')
      }
      throw failed('protocol')
    } catch (error) {
      await response.body?.cancel().catch(() => {})
      if (error instanceof McpRemoteError || error instanceof SessionGone) throw error
      throw this.failure(error, signal, timeout)
    }
  }

  /**
   * The answer to `id` among what came (one message or a batch); the server's own requests are declined, with a reply
   * for at most `MAX_DECLINES` of them per answer and silently after that.
   */
  private pick(value: unknown, id: number, declines: { left: number }): RemoteAnswer | undefined {
    const messages = Array.isArray(value) ? value : [value]
    let found: RemoteAnswer | undefined
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue
      const item = message as Record<string, unknown>
      if (typeof item.method === 'string') {
        if (item.id !== undefined && item.id !== null && declines.left-- > 0)
          void this.post({ jsonrpc: '2.0', id: item.id, error: { code: -32601, message: 'Method not found' } }, undefined).catch(() => {})
        continue
      }
      const parsed = answerSchema.safeParse(item)
      if (!parsed.success || parsed.data.id !== id) continue
      const error = errorSchema.safeParse(item.error)
      found = error.success
        ? { error: { code: error.data.code, message: error.data.message.slice(0, 2000) } }
        : { result: parsed.data.result }
    }
    return found
  }

  private failure(error: unknown, signal: AbortSignal | undefined, timeout: AbortSignal): Error {
    if (error instanceof McpRemoteError) return error
    if (signal?.aborted) return signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')
    if (timeout.aborted) return failed('timeout')
    const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined
    if (code === 'egress-denied') return failed('refused')
    // The event stream's own framing broke (an event too large, a stream cut mid-event).
    if (error instanceof Error && error.name === 'ProviderError') return failed('protocol')
    if (error instanceof SyntaxError || error instanceof TypeError || error instanceof z.ZodError) {
      // A broken JSON or stream body is the server's; a failed connection is a TypeError whose cause names it.
      const cause = (error as { cause?: { code?: unknown } }).cause
      if (error instanceof TypeError && cause && typeof cause === 'object' && cause.code === 'egress-denied') return failed('refused')
      return error instanceof TypeError && /fetch failed/u.test(error.message) ? failed('unreachable') : failed('protocol')
    }
    return failed('unreachable')
  }
}

/** The server forgot the session (404): start again. */
class SessionGone extends Error {}

/** The reason for any error a remote call ended with, for its report. */
export function remoteFailure(error: unknown): RemoteFailure {
  if (error instanceof McpRemoteError) return error.reason
  return 'unreachable'
}

/**
 * The Host's sessions with remote servers, one per key (a bridge's binding, or a built-in session and a server). A key
 * is opened with the options of the definition as it stands; `revoke` ends every session of a server and stops their
 * calls: it was removed, switched off, changed, or no longer used where it was.
 */
export class McpRemotePool {
  private readonly sessions = new Map<string, { serverId: string; version: string; session: McpRemoteSession; stop: AbortController }>()

  /**
   * The session for `key`, opened with `options` when there is none, or when the one there was opened for another
   * version of the definition (`version`, its `specHash`). `options` throws when the definition changed meanwhile.
   */
  session(
    key: string,
    serverId: string,
    version: string,
    options: () => McpRemoteOptions,
  ): { session: McpRemoteSession; signal: AbortSignal } {
    let entry = this.sessions.get(key)
    if (entry && (entry.serverId !== serverId || entry.version !== version)) {
      this.close(key)
      entry = undefined
    }
    if (!entry) {
      entry = { serverId, version, session: new McpRemoteSession(options()), stop: new AbortController() }
      this.sessions.set(key, entry)
    }
    return { session: entry.session, signal: entry.stop.signal }
  }

  close(key: string): void {
    const entry = this.sessions.get(key)
    if (!entry) return
    this.sessions.delete(key)
    entry.stop.abort(failed('refused'))
    void entry.session.close()
  }

  /** Every key that starts with `prefix` (a session's built-in keys). */
  closeWhere(prefix: string): void {
    for (const key of [...this.sessions.keys()]) if (key.startsWith(prefix)) this.close(key)
  }

  revoke(serverId: string): void {
    for (const [key, entry] of [...this.sessions]) if (entry.serverId === serverId) this.close(key)
  }

  closeAll(): void {
    for (const key of [...this.sessions.keys()]) this.close(key)
  }
}

/** Every string of a JSON-shaped answer, object keys included, passed through `mask`; the same shape back. */
export function maskStrings(value: unknown, mask: (text: string) => string): unknown {
  if (typeof value === 'string') return mask(value)
  if (Array.isArray(value)) return value.map(item => maskStrings(item, mask))
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [mask(key), maskStrings(item, mask)]))
  return value
}

/**
 * A built-in harness tool's name for a remote server's tool: `mcp__<server>__<tool>_<hash>`, as model APIs accept names
 * (64 characters of `[A-Za-z0-9_-]`). The hash, of the server's ID and the tool's own name, is always there, so two
 * servers or two tools whose names read the same once cut or rewritten never share one.
 */
export function builtinToolName(serverId: string, server: string, tool: string): string {
  const hash = createHash('sha256').update(`${serverId}\0${tool}`).digest('hex').slice(0, 8)
  const name = `mcp__${server}__${tool.replace(/[^A-Za-z0-9_-]/gu, '_')}`
  return `${name.slice(0, 64 - hash.length - 1)}_${hash}`
}
