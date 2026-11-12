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
import {
  AppError,
  type McpServerLease,
  type McpStartFailure,
  type ToolGateway,
  type ToolGatewayCallContext,
  type ToolGatewayLease,
} from '@latch/sdk'

const TOKEN_PREFIX = 'lbt1.'
/** A request line: a tool's arguments are small; anything longer ends the connection. */
const MAX_REQUEST_BYTES = 256 * 1024
// Each `latch-mcp` bridge holds one connection for its process's life; `latch-browser` connects per call.
const MAX_CONNECTIONS = 512
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

/** One `latch-mcp` bridge's binding, as the Host's MCP handlers see it. */
export interface McpBinding {
  /** Random, for this binding alone. */
  id: string
  sessionId: string
  serverId: string
  /** The definition the session was given; a call is refused once it changed. */
  specHash: string
  /** The session's main folder. */
  cwd: string
  /** The session's Agent and project, for the server's 「用在」 at each call. */
  agentId?: string
  projectId?: string
}

/** What a bridge's server runs as, and the tools switched off. */
export interface McpLaunchReply {
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  disabledTools: string[]
}

const MCP_FAILURES = new Set<McpStartFailure>(['spawn-failed', 'exited', 'timeout', 'protocol', 'list-failed', 'output-too-large'])
const MCP_RESULTS = new Set(['ok', 'error', 'cancelled', 'failed'])

/** The Host's side of Latch's MCP servers; see docs/MCP.md. */
export interface McpGatewayHandlers {
  /** The servers a session gets now. */
  select(input: {
    sessionId: string
    agentId?: string
    projectId?: string
  }): Promise<Array<{ serverId: string; name: string; specHash: string }>>
  /** The launch, with the server's secrets in `env`; rejects when the server is gone, off or changed. */
  launch(binding: McpBinding): Promise<McpLaunchReply>
  /** What the bridge saw when it started the server. */
  report(binding: McpBinding, report: { ok: true; tools: string[] } | { ok: false; reason: McpStartFailure }): void
  /** Before a call is sent to the server: its audit record. Rejects, with words for the agent, when it must not go. */
  callStarted(binding: McpBinding, tool: string): Promise<string>
  /** After it: the outcome and how long it took. */
  callEnded(binding: McpBinding, callId: string, result: 'ok' | 'error' | 'cancelled' | 'failed', ms: number): void
  /** The binding ended: its process went, or the server was removed, switched off or changed. */
  closed(binding: McpBinding): void
}

export interface ToolGatewayOptions {
  socketPath: string
  /** Whether a session gets the tools when it opens now; false: no token, and its agent gets no server this time. */
  admits?(sessionId: string): boolean
  tools(): GatewayTool[]
  /** One call; the Host classifies, audits and runs it. Never rejects with the token or the arguments in its words. */
  call(input: GatewayCall): Promise<GatewayResult>
  /** Latch's MCP servers, through `latch-mcp` bridges; without it a session gets none. */
  mcp?: McpGatewayHandlers
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
  /** A `latch-mcp` bridge's binding; absent for `latch-browser`. */
  mcp?: McpBinding & { onFailed?: (name: string, reason: McpStartFailure) => void; name: string; launched: boolean }
  /** A bridge's connections that used this token: ended with it, so the bridge stops its server. */
  sockets: Set<Socket>
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
    const { token, hash, binding } = this.bind({
      sessionId: input.sessionId,
      ...(input.describe ? { describe: input.describe } : {}),
    })
    return {
      socketPath: this.options.socketPath,
      tokenFile: binding.tokenFile,
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
      close: () => this.release(hash, binding),
    }
  }

  async openMcp(input: Parameters<NonNullable<ToolGateway['openMcp']>>[0]): Promise<McpServerLease[]> {
    const handlers = this.options.mcp
    if (!this.server || !handlers) return []
    const chosen = await handlers.select({
      sessionId: input.sessionId,
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    })
    return chosen.map(server => {
      const { token, hash, binding } = this.bind({
        sessionId: input.sessionId,
        mcp: {
          id: randomBytes(12).toString('hex'),
          sessionId: input.sessionId,
          serverId: server.serverId,
          specHash: server.specHash,
          cwd: input.cwd,
          ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
          ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
          name: server.name,
          launched: false,
          ...(input.onFailed ? { onFailed: input.onFailed } : {}),
        },
      })
      return {
        name: server.name,
        socketPath: this.options.socketPath,
        tokenFile: binding.tokenFile,
        token,
        close: () => this.release(hash, binding),
      }
    })
  }

  /** Ends every bridge of a server: it was removed, switched off or changed. Their agents keep running without it. */
  revokeMcp(serverId: string): void {
    for (const [hash, binding] of this.bindings) if (binding.mcp?.serverId === serverId) this.release(hash, binding)
  }

  private release(hash: string, binding: Binding): void {
    if (this.bindings.get(hash) === binding) this.bindings.delete(hash)
    this.end(binding)
  }

  private bind(input: Pick<Binding, 'sessionId' | 'describe' | 'mcp'>): { token: string; hash: string; binding: Binding } {
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
      ...(input.mcp ? { mcp: input.mcp } : {}),
      calls: new Set(),
      closed: false,
      unknown: false,
      idle: new Set(),
      tokenFile,
      sockets: new Set(),
    }
    this.bindings.set(hash, binding)
    return { token, hash, binding }
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
    const first = !binding.closed
    binding.closed = true
    for (const call of binding.calls) call.abort()
    rmSync(binding.tokenFile, { force: true })
    // A bridge whose connection ends stops its server's whole process group. (`latch-browser` keeps its connection and
    // hears why at its next request.)
    for (const socket of binding.sockets) socket.destroy()
    binding.sockets.clear()
    if (first && binding.mcp) this.options.mcp?.closed(binding.mcp)
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

  /**
   * A `latch-mcp` bridge's request: its launch (once per token), its report, and the record before and after each tool
   * call. The bridge forwards the call itself, to the server it started; the gateway never sees arguments or results.
   */
  private mcpRequest(
    binding: Binding,
    mcp: NonNullable<Binding['mcp']>,
    id: string | number,
    method: unknown,
    params: unknown,
    reply: (message: Record<string, unknown>) => void,
    refuse: (id: unknown, code: number, message: string) => void,
  ): void {
    const handlers = this.options.mcp
    const args = isPlainObject(params) ? params : {}
    if (!handlers) return refuse(id, -32601, 'Method not found')
    if (method === 'mcp/launch') {
      if (mcp.launched) return refuse(id, -32000, 'This server was started already.')
      mcp.launched = true
      void handlers.launch(mcp).then(
        launch => (binding.closed ? refuse(id, -32001, REFUSED) : reply({ id, result: launch })),
        error => refuse(id, -32000, error instanceof AppError ? error.message : 'The server cannot start now.'),
      )
      return
    }
    if (method === 'mcp/report') {
      if (args.ok === true && Array.isArray(args.tools)) {
        const tools = args.tools.filter((tool): tool is string => typeof tool === 'string' && tool.length <= 128).slice(0, 256)
        handlers.report(mcp, { ok: true, tools })
      } else if (args.ok === false && MCP_FAILURES.has(args.reason as McpStartFailure)) {
        const reason = args.reason as McpStartFailure
        handlers.report(mcp, { ok: false, reason })
        mcp.onFailed?.(mcp.name, reason)
      }
      return reply({ id, result: {} })
    }
    if (method === 'mcp/call') {
      if (typeof args.tool !== 'string' || !args.tool || args.tool.length > 128) return refuse(id, -32602, 'Invalid tool.')
      if (binding.calls.size >= MAX_INFLIGHT * 4) return refuse(id, -32000, 'Too many calls at once.')
      void handlers.callStarted(mcp, args.tool).then(
        callId => (binding.closed ? refuse(id, -32001, REFUSED) : reply({ id, result: { callId } })),
        error => refuse(id, -32000, error instanceof AppError ? error.message : 'The call cannot be made now.'),
      )
      return
    }
    if (method === 'mcp/called') {
      const ms = typeof args.ms === 'number' && Number.isFinite(args.ms) ? Math.max(0, Math.min(Math.round(args.ms), 86_400_000)) : 0
      if (typeof args.callId === 'string' && MCP_RESULTS.has(args.result as string))
        handlers.callEnded(mcp, args.callId, args.result as 'ok' | 'error' | 'cancelled' | 'failed', ms)
      return reply({ id, result: {} })
    }
    refuse(id, -32601, 'Method not found')
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
        if (binding.mcp) {
          binding.sockets.add(socket)
          this.mcpRequest(binding, binding.mcp, id, method, params, reply, refuse)
          continue
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
      for (const binding of this.bindings.values()) binding.sockets.delete(socket)
      // The server went away: its calls stop.
      for (const controller of inflight.values()) controller.abort()
      inflight.clear()
    })
  }
}
