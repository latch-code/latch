/**
 * An in-process MCP server over Streamable HTTP, on 127.0.0.1 only: `initialize` with a session ID, `tools/list` and
 * `tools/call`, answered as JSON or as an event stream. Its tools are `echo` (the arguments back, and the value of a
 * header named by `echoHeader`, for a test of masking), `slow` (until cancelled or `slowMs`) and `big` (a result larger
 * than the Host reads). It can ask for a login (401 with `resource_metadata`), redirect, forget its session (404) and
 * send a request of its own before an answer. It keeps every request with its header names; a header's value only when
 * a test names it (`keepHeaders`), so a test can prove where a secret went and where it did not.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeMcpHttpOptions {
  /** How answers come: JSON (default) or an event stream. */
  answer?: 'json' | 'sse'
  /** Answer every request with 401 and a `WWW-Authenticate` naming `resource_metadata`. */
  login?: boolean
  /**
   * A protected resource (the MCP authorization spec): a request without a bearer token that `valid` accepts gets 401
   * with `resource_metadata`, and the server serves that metadata, naming `issuer` as its authorization server.
   */
  protect?: {
    issuer: string
    valid: (token: string) => boolean
    scopes?: string[]
    /** Where the 401 says the metadata is, instead of this server's own well-known address. */
    metadataUrl?: string
    /** The `resource` the metadata names, instead of this server's `/mcp`. */
    resource?: string
    /** No `resource_metadata` in the 401: the client finds the well-known address itself. */
    bareChallenge?: boolean
    /** Answer 403 `insufficient_scope` to `tools/call`, token or not. */
    insufficient?: boolean
  }
  /** Answer every POST with a 307 to this URL. */
  redirect?: string
  /** Header names whose values are kept with each request. */
  keepHeaders?: string[]
  /** How long `slow` waits before it answers; default until the request ends. */
  slowMs?: number
  /** The server's own request (a sampling ask) is sent in the stream before the answer; needs `answer: 'sse'`. */
  askFirst?: boolean
  /** How many such requests go before each answer (default 1 with `askFirst`). */
  asks?: number
}

export interface FakeMcpHttpRequest {
  method: string
  /** The request's path, without its query. */
  path: string
  /** The JSON-RPC method, for a POST. */
  rpc?: string
  id?: number | string
  body?: unknown
  /** Header names, lower case and sorted. */
  headerNames: string[]
  /** The values of `keepHeaders` that came. */
  headers: Record<string, string>
  sessionId?: string
  protocolVersion?: string
}

export interface FakeMcpHttp {
  /** `http://127.0.0.1:<port>/mcp`. */
  url: string
  origin: string
  requests: FakeMcpHttpRequest[]
  /** Cancels the server heard (`notifications/cancelled`), by request ID. */
  cancelled: Array<number | string>
  /** Sessions ended with DELETE. */
  deleted: string[]
  /** The most requests it was answering at once. */
  peak(): number
  /** Forgets every session: the next request with one gets 404. */
  forget(): void
  close(): Promise<void>
}

const TOOLS = [
  { name: 'echo', description: 'Returns its arguments.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'slow', description: 'Waits.', inputSchema: { type: 'object', properties: {} } },
  { name: 'big', description: 'Answers with a lot.', inputSchema: { type: 'object', properties: {} } },
]

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ''
    request.setEncoding('utf8')
    request.on('data', chunk => {
      text += chunk
      if (text.length > 4 * 1024 * 1024) request.destroy(new Error('request too large'))
    })
    request.on('end', () => resolve(text))
    request.on('error', reject)
  })
}

export async function startFakeMcpHttp(options: FakeMcpHttpOptions = {}): Promise<FakeMcpHttp> {
  const requests: FakeMcpHttpRequest[] = []
  const cancelled: Array<number | string> = []
  const deleted: string[] = []
  const sessions = new Set<string>()
  let next = 1
  const keep = new Set((options.keepHeaders ?? []).map(name => name.toLowerCase()))

  const send = (res: ServerResponse, messages: unknown[]) => {
    if (options.answer === 'sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      for (const message of messages) res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(messages.at(-1)))
  }

  let active = 0
  let peak = 0
  const server = createServer((req, res) => {
    active++
    peak = Math.max(peak, active)
    res.once('close', () => {
      active--
    })
    void (async () => {
      const text = req.method === 'POST' ? await readBody(req) : ''
      let body: Record<string, unknown> | undefined
      try {
        body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined
      } catch {
        body = undefined
      }
      const sessionId = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined
      const protocolVersion = typeof req.headers['mcp-protocol-version'] === 'string' ? req.headers['mcp-protocol-version'] : undefined
      const headers: Record<string, string> = {}
      for (const [name, value] of Object.entries(req.headers)) if (keep.has(name) && typeof value === 'string') headers[name] = value
      requests.push({
        method: req.method ?? '',
        path: new URL(req.url ?? '/', 'http://fake.invalid').pathname,
        ...(typeof body?.method === 'string' ? { rpc: body.method } : {}),
        ...(typeof body?.id === 'number' || typeof body?.id === 'string' ? { id: body.id } : {}),
        ...(body !== undefined ? { body } : {}),
        headerNames: Object.keys(req.headers).toSorted(),
        headers,
        ...(sessionId ? { sessionId } : {}),
        ...(protocolVersion ? { protocolVersion } : {}),
      })
      const protect = options.protect
      if (protect) {
        const self = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        const path = new URL(req.url ?? '/', self).pathname
        if (
          req.method === 'GET'
          && (path === '/.well-known/oauth-protected-resource/mcp' || path === '/.well-known/oauth-protected-resource')
        ) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              resource: protect.resource ?? `${self}/mcp`,
              authorization_servers: [protect.issuer],
              ...(protect.scopes ? { scopes_supported: protect.scopes } : {}),
            }),
          )
          return
        }
        const bearer = /^Bearer (.+)$/u.exec(typeof req.headers.authorization === 'string' ? req.headers.authorization : '')?.[1]
        if (bearer === undefined || !protect.valid(bearer)) {
          const metadata = protect.metadataUrl ?? `${self}/.well-known/oauth-protected-resource/mcp`
          res.writeHead(401, {
            'www-authenticate': protect.bareChallenge ? 'Bearer' : `Bearer resource_metadata="${metadata}"`,
          })
          res.end()
          return
        }
        if (protect.insufficient && body?.method === 'tools/call') {
          res.writeHead(403, { 'www-authenticate': 'Bearer error="insufficient_scope", scope="admin"' })
          res.end()
          return
        }
      }
      if (options.login) {
        res.writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="http://127.0.0.1:${(server.address() as AddressInfo).port}/.well-known/oauth-protected-resource"`,
        })
        res.end()
        return
      }
      if (options.redirect && req.method === 'POST') {
        res.writeHead(307, { location: options.redirect })
        res.end()
        return
      }
      if (req.method === 'DELETE') {
        if (sessionId) {
          sessions.delete(sessionId)
          deleted.push(sessionId)
        }
        res.writeHead(200)
        res.end()
        return
      }
      if (req.method !== 'POST' || !body) {
        res.writeHead(405)
        res.end()
        return
      }
      const method = body.method
      if (method === 'initialize') {
        const id = `fake-session-${next++}`
        sessions.add(id)
        res.setHeader('mcp-session-id', id)
        send(res, [
          {
            jsonrpc: '2.0',
            id: body.id,
            result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp-http', version: '1' } },
          },
        ])
        return
      }
      if (!sessionId || !sessions.has(sessionId)) {
        res.writeHead(sessionId ? 404 : 400)
        res.end()
        return
      }
      if (body.id === undefined) {
        if (method === 'notifications/cancelled') {
          const params = body.params as { requestId?: number | string } | undefined
          if (params?.requestId !== undefined) cancelled.push(params.requestId)
        }
        res.writeHead(202)
        res.end()
        return
      }
      const ask = options.askFirst
        ? Array.from({ length: options.asks ?? 1 }, (_, index) => ({
            jsonrpc: '2.0',
            id: index === 0 ? 'server-ask' : `server-ask-${index}`,
            method: 'sampling/createMessage',
            params: {},
          }))
        : []
      if (method === 'tools/list') {
        send(res, [...ask, { jsonrpc: '2.0', id: body.id, result: { tools: TOOLS } }])
        return
      }
      if (method === 'tools/call') {
        const params = (body.params ?? {}) as { name?: string; arguments?: Record<string, unknown> }
        if (params.name === 'echo') {
          const said = JSON.stringify(params.arguments ?? {})
          const echoed =
            typeof params.arguments?.echoHeader === 'string' ? req.headers[params.arguments.echoHeader.toLowerCase()] : undefined
          send(res, [
            ...ask,
            {
              jsonrpc: '2.0',
              id: body.id,
              result: { content: [{ type: 'text', text: echoed ? `${said} ${String(echoed)}` : said }] },
            },
          ])
          return
        }
        if (params.name === 'slow') {
          const timer = options.slowMs
            ? setTimeout(
                () => send(res, [{ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'done' }] } }]),
                options.slowMs,
              )
            : undefined
          req.on('close', () => clearTimeout(timer))
          res.on('close', () => clearTimeout(timer))
          return
        }
        if (params.name === 'big') {
          send(res, [{ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'x'.repeat(3 * 1024 * 1024) }] } }])
          return
        }
        send(res, [{ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: `Unknown tool ${String(params.name)}` } }])
        return
      }
      send(res, [{ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } }])
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url: `${origin}/mcp`,
    origin,
    requests,
    cancelled,
    deleted,
    peak: () => peak,
    forget: () => sessions.clear(),
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
