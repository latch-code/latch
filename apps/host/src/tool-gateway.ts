// The Host's tool gateway: a Unix socket in a 0700 directory of the Host's runtime directory, through which an external
// harness's `latch-browser` MCP server reaches the browser tools. It forwards only listing and calling tools, each
// request carrying an `lbt1.` token that one agent process holds, handed over in a 0600 file next to the socket that the
// server deletes once read; a page cannot reach a Unix socket, and the token is no device credential. See docs/ARCHITECTURE.md (工具网关) and docs/PREVIEW-BROWSER.md.
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, openSync, rmSync, writeSync } from 'node:fs'
import { chmod, lstat, mkdir, rm, unlink } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import type { TaskSummary } from '@latch/protocol'
import { AppError, type ToolGateway, type ToolGatewayCallContext, type ToolGatewayLease } from '@latch/sdk'

const TOKEN_PREFIX = 'lbt1.'
/** A request line: a tool's arguments are small; anything longer ends the connection. */
const MAX_REQUEST_BYTES = 256 * 1024
const MAX_CONNECTIONS = 64
/** Calls one connection may have in flight. */
const MAX_INFLIGHT = 8
/** The longest path a Unix socket may have on macOS, without its terminating byte. */
export const MAX_SOCKET_PATH = 103

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex')
/** Revoked tokens remembered for their reason, so the agent hears why; the oldest go first. */
const MAX_REVOKED = 256
const REFUSED = 'The Latch tool token is not valid; the browser tools are unavailable in this process.'
const ARCHIVED =
  '这个会话归档过，这个 Agent 进程的浏览器工具已停用；会话恢复（Agent 进程重新启动）后再试。This session was archived: the browser tools come back when the session resumes on a new agent process.'

/**
 * Why a gateway call of `summary`'s session is refused before anything else, or undefined: only a session of a project
 * (not archived, not of 我的 Agent, not personal, not a conversation with 通用), on an ACP harness at full access (L3),
 * during a turn that is running and not being stopped.
 */
export function gatewayRefusal(
  summary: Pick<TaskSummary, 'personal' | 'agent' | 'generalChat' | 'archived' | 'mode' | 'status'> | undefined,
  trust: { kind: string; level: string } | undefined,
  turn: ToolGatewayCallContext['turn'],
): 'no-project' | 'not-full-access' | 'no-turn' | 'stopping' | undefined {
  if (!summary || summary.personal || summary.agent || summary.generalChat || summary.mode === 'chat' || summary.archived)
    return 'no-project'
  if (trust?.kind !== 'acp' || trust.level !== 'L3') return 'not-full-access'
  if (turn === 'stopping') return 'stopping'
  if (turn !== 'running' || (summary.status !== 'running' && summary.status !== 'waiting-approval')) return 'no-turn'
  return undefined
}

/** A tool as MCP lists it. */
export interface GatewayTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** A tool call's answer in MCP's shape. */
export interface GatewayResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' }>
  isError?: boolean
  /** The call may have acted and nobody knows: never sent to the server, it makes `settled()` say so. */
  unknown?: true
}

export interface GatewayCall {
  sessionId: string
  tool: string
  args: Record<string, unknown>
  signal: AbortSignal
  context: ToolGatewayCallContext
}

export interface ToolGatewayOptions {
  socketPath: string
  /** Whether a session gets the tools when it opens now; false: no token, and its agent gets no server this time. */
  admits?(sessionId: string): boolean
  tools(): GatewayTool[]
  /** One call; the Host classifies, audits and runs it. Never rejects with the token or the arguments in its words. */
  call(input: GatewayCall): Promise<GatewayResult>
  log?(text: string): void
}

interface Binding {
  sessionId: string
  describe?: (tool: string, args: Record<string, unknown>) => ToolGatewayCallContext
  /** Calls in flight with this token. */
  calls: Set<AbortController>
  closed: boolean
  /** A call ended with its result unknown since `settled()` last answered. */
  unknown: boolean
  /** Who waits for the calls to end. */
  idle: Set<() => void>
  tokenFile: string
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

export class ToolGatewayServer implements ToolGateway {
  private server: Server | undefined
  /** SHA-256 of each live token → what it is bound to. The token itself is never kept. */
  private readonly bindings = new Map<string, Binding>()
  /** SHA-256 of tokens revoked because their session was archived. */
  private readonly archived = new Set<string>()
  private readonly sockets = new Set<Socket>()

  constructor(private readonly options: ToolGatewayOptions) {}

  get listening(): boolean {
    return this.server !== undefined
  }

  /** Listens on the socket: its directory made 0700, a stale socket replaced, the socket 0600. */
  async start(): Promise<void> {
    const { socketPath } = this.options
    if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) throw new AppError(500, 'tool-gateway-path-too-long', '工具网关的套接字路径过长')
    const directory = dirname(socketPath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AppError(500, 'tool-gateway-insecure', '工具网关的目录不安全')
    await chmod(directory, 0o700)
    try {
      if ((await lstat(socketPath)).isSocket()) await unlink(socketPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const server = createServer(socket => this.accept(socket))
    server.maxConnections = MAX_CONNECTIONS
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen({ path: socketPath, exclusive: true }, () => {
        server.off('error', reject)
        resolve()
      })
    })
    await chmod(socketPath, 0o600)
    this.server = server
  }

  /** Stops listening, revokes every token and stops their calls, and removes the socket's directory. */
  async close(): Promise<void> {
    for (const binding of this.bindings.values()) this.end(binding)
    this.bindings.clear()
    const server = this.server
    this.server = undefined
    for (const socket of this.sockets) socket.destroy()
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(dirname(this.options.socketPath), { recursive: true, force: true })
  }

  open(input: { sessionId: string; describe?: Binding['describe'] }): ToolGatewayLease | undefined {
    if (!this.server) throw new AppError(503, 'tool-gateway-unavailable', 'Latch 的工具网关没有运行')
    if (this.options.admits && !this.options.admits(input.sessionId)) return undefined
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
    const hash = hashOf(token)
    // The token goes to the server in a file only this user reads, created here and nowhere else; the server deletes it
    // once read. Never in an argument or the environment, which `ps` shows.
    const tokenFile = join(dirname(this.options.socketPath), `${randomBytes(16).toString('hex')}.lbt`)
    const fd = openSync(tokenFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      writeSync(fd, token)
    } finally {
      closeSync(fd)
    }
    const binding: Binding = {
      sessionId: input.sessionId,
      ...(input.describe ? { describe: input.describe } : {}),
      calls: new Set(),
      closed: false,
      unknown: false,
      idle: new Set(),
      tokenFile,
    }
    this.bindings.set(hash, binding)
    return {
      socketPath: this.options.socketPath,
      tokenFile,
      token,
      active: () => this.bindings.get(hash) === binding && !binding.closed,
      cancel: () => {
        for (const call of binding.calls) call.abort()
      },
      settled: () =>
        new Promise(resolve => {
          const done = () => {
            binding.idle.delete(done)
            const resultUnknown = binding.unknown
            binding.unknown = false
            resolve({ resultUnknown })
          }
          if (!binding.calls.size) done()
          else binding.idle.add(done)
        }),
      close: () => {
        if (this.bindings.get(hash) === binding) this.bindings.delete(hash)
        this.end(binding)
      },
    }
  }

  /**
   * Revokes every token of the session: it was archived or deleted. An archived session's agent process, should it run
   * on, is told the tools come back when the session resumes on a new process.
   */
  revokeSession(sessionId: string, why: 'archived' | 'deleted'): void {
    for (const [hash, binding] of this.bindings)
      if (binding.sessionId === sessionId) {
        this.bindings.delete(hash)
        this.end(binding)
        if (why === 'archived') {
          this.archived.add(hash)
          if (this.archived.size > MAX_REVOKED) this.archived.delete(this.archived.values().next().value!)
        }
      }
  }

  private end(binding: Binding): void {
    binding.closed = true
    for (const call of binding.calls) call.abort()
    rmSync(binding.tokenFile, { force: true })
  }

  private settle(binding: Binding): void {
    if (binding.calls.size) return
    for (const done of [...binding.idle]) done()
  }

  private binding(token: unknown): Binding | undefined {
    if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX) || token.length !== TOKEN_PREFIX.length + 43) return undefined
    const binding = this.bindings.get(hashOf(token))
    return binding && !binding.closed ? binding : undefined
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    /** This connection's calls by request ID. */
    const inflight = new Map<unknown, AbortController>()
    let buffer = ''
    const reply = (message: Record<string, unknown>) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`)
    }
    const refuse = (id: unknown, code: number, message: string) => reply({ id: id ?? null, error: { code, message } })
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES && !buffer.includes('\n')) {
        socket.destroy()
        return
      }
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) {
          socket.destroy()
          return
        }
        let request: unknown
        try {
          request = JSON.parse(line)
        } catch {
          // Not this protocol (an HTTP request, say): nothing is answered and the connection ends.
          socket.destroy()
          return
        }
        if (!isPlainObject(request)) {
          socket.destroy()
          return
        }
        const { id, token, method, params } = request
        if (typeof id !== 'number' && typeof id !== 'string') {
          socket.destroy()
          return
        }
        // The token is checked on every request: one that was revoked meanwhile is refused, and the connection ends.
        const binding = this.binding(token)
        if (!binding) {
          refuse(id, -32001, typeof token === 'string' && this.archived.has(hashOf(token)) ? ARCHIVED : REFUSED)
          socket.end()
          return
        }
        if (method === 'cancel') {
          inflight.get(id)?.abort()
          continue
        }
        if (method === 'tools/list') {
          reply({ id, result: { tools: this.options.tools() } })
          continue
        }
        if (method !== 'tools/call') {
          refuse(id, -32601, 'Method not found')
          continue
        }
        if (inflight.size >= MAX_INFLIGHT || inflight.has(id)) {
          refuse(id, -32000, 'Too many calls at once.')
          continue
        }
        const name = isPlainObject(params) ? params.name : undefined
        const args = isPlainObject(params) ? (params.arguments ?? {}) : undefined
        if (typeof name !== 'string' || !this.options.tools().some(tool => tool.name === name) || !isPlainObject(args)) {
          refuse(id, -32602, 'Unknown tool or invalid arguments.')
          continue
        }
        const controller = new AbortController()
        inflight.set(id, controller)
        binding.calls.add(controller)
        void (async () => {
          let result: GatewayResult
          try {
            const context = binding.describe?.(name, args) ?? {}
            result = await this.options.call({ sessionId: binding.sessionId, tool: name, args, signal: controller.signal, context })
          } catch (error) {
            this.options.log?.(`工具网关的调用失败：${error instanceof AppError ? error.code : 'error'}`)
            result = { content: [{ type: 'text', text: '浏览器调用失败。' }], isError: true }
          } finally {
            inflight.delete(id)
            binding.calls.delete(controller)
          }
          const { unknown, ...answer } = result
          if (unknown) binding.unknown = true
          this.settle(binding)
          reply({ id, result: answer })
        })()
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      this.sockets.delete(socket)
      // The server went away: its calls stop.
      for (const controller of inflight.values()) controller.abort()
      inflight.clear()
    })
  }
}
