import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { RPC, RpcError, type RpcId } from './protocol.ts'

export interface ExitInfo {
  code: number | null
  signal: NodeJS.Signals | null
  /** Why Latch ended the process. Absent when the agent exited by itself. */
  reason?: 'stop' | 'kill' | 'overflow' | 'spawn'
  /** Task whose unsettled cancel forced the kill. */
  cause?: string
  /** Spawn failure, when the process never started. */
  error?: string
  /** Redacted end of the agent's stderr. */
  stderr: string
}

export class ConnectionClosed extends Error {
  constructor(readonly info: ExitInfo) {
    super('Agent process exited')
    this.name = 'ConnectionClosed'
  }
}

/** The process is being stopped, so a new request would never be read. Nothing was sent. */
export class ConnectionStopping extends Error {
  constructor() {
    super('Agent process is stopping')
    this.name = 'ConnectionStopping'
  }
}

export class RequestTimeout extends Error {
  constructor(readonly method: string) {
    super(`${method} timed out`)
    this.name = 'RequestTimeout'
  }
}

export interface ConnectionHandlers {
  /** Agent-to-client request. The returned value or error is always sent back. */
  request(method: string, params: unknown, id: RpcId): Promise<unknown>
  notification(method: string, params: unknown): void
  /** Called once, after pending requests were rejected. */
  exit(info: ExitInfo): void
}

export interface SpawnSpec {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  maxLineBytes: number
  redact(text: string): string
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  cleanup(): void
}

const STDERR_LIMIT = 64 * 1024
const STDERR_TAIL = 600
const WRITE_QUEUE_LIMIT = 64 * 1024 * 1024
/** After the leader exits, a grandchild could hold the pipes open; stop waiting for them. */
const CLOSE_FALLBACK_MS = 2_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rpcError(error: unknown): { code: number; message: string; data?: unknown } {
  if (error instanceof RpcError)
    return { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) }
  return { code: RPC.internal, message: 'Internal error' }
}

/** One agent process speaking newline-delimited JSON-RPC 2.0 over stdio. */
export class AgentConnection {
  readonly exited: Promise<ExitInfo>
  /** Lines on stdout that were not JSON-RPC messages. */
  noise = 0
  private resolveExited!: (info: ExitInfo) => void
  private nextId = 0
  private readonly pending = new Map<RpcId, Pending>()
  private parts: Buffer[] = []
  private partLength = 0
  private stderr: Buffer[] = []
  private stderrLength = 0
  private stderrDiagnostic?: string
  private queue: string[] = []
  private queued = 0
  private blocked = false
  private exitCode: number | null = null
  private exitSignal: NodeJS.Signals | null = null
  private leaderExited = false
  private reason?: ExitInfo['reason']
  private cause?: string
  private spawnError?: string
  private info?: ExitInfo
  private fallback?: NodeJS.Timeout

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly spec: SpawnSpec,
    private readonly handlers: ConnectionHandlers,
  ) {
    this.exited = new Promise(resolve => {
      this.resolveExited = resolve
    })
    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk))
    child.stderr.on('data', (chunk: Buffer) => this.onStderr(chunk))
    child.stdin.on('drain', () => this.onDrain())
    // EPIPE after the agent exits is expected; the exit path reports it.
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', () => {})
    child.on('error', error => this.onError(error))
    child.on('exit', (code, signal) => this.onExit(code, signal))
    child.on('close', () => this.finish())
  }

  /** Throws only for invalid arguments; launch failures such as ENOENT arrive as an exit with `reason: 'spawn'`. */
  static spawn(spec: SpawnSpec, handlers: ConnectionHandlers): AgentConnection {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // A separate process group lets one signal reach every helper process the agent starts.
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    return new AgentConnection(child, spec, handlers)
  }

  get closed(): boolean {
    return this.info !== undefined
  }
  /** Exited, being stopped, or no longer accepting input: hand no new work to it. */
  get stopping(): boolean {
    return this.info !== undefined || this.reason !== undefined || this.child.stdin.destroyed || this.child.stdin.writableEnded
  }
  get pid(): number | undefined {
    return this.child.pid
  }

  /** A timeout or an aborted `signal` withdraws the request with `$/cancel_request`; a late reply is dropped. */
  request(method: string, params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    if (this.info) return Promise.reject(new ConnectionClosed(this.info))
    // Once stdin ends the line would be dropped silently and the caller would wait for the exit instead.
    if (this.stopping) return Promise.reject(new ConnectionStopping())
    if (signal?.aborted) return Promise.reject(new RpcError(RPC.cancelled, 'Request cancelled'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined
      const withdraw = (error: Error): void => {
        if (!this.pending.delete(id)) return
        cleanup()
        this.notify('$/cancel_request', { requestId: id })
        reject(error)
      }
      const onAbort = (): void => withdraw(new RpcError(RPC.cancelled, 'Request cancelled'))
      const cleanup = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      if (timeoutMs) {
        timer = setTimeout(() => withdraw(new RequestTimeout(method)), timeoutMs)
        timer.unref()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, { resolve, reject, cleanup })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  /** `stop`: end stdin, then SIGTERM, then SIGKILL the group. `kill` skips stdin. Resolves once the process is gone. */
  async stop(reason: 'stop' | 'kill', graceMs: number, cause?: string): Promise<ExitInfo> {
    if (this.info) return this.info
    if (!this.reason) {
      this.reason = reason
      this.cause = cause
    }
    if (reason === 'stop' && !this.leaderExited) {
      this.child.stdin.end()
      if (await this.waitFor(graceMs)) return this.exited
    }
    if (!this.info && !this.leaderExited) {
      this.signalGroup('SIGTERM')
      if (await this.waitFor(graceMs)) return this.exited
    }
    if (!this.info) this.signalGroup('SIGKILL')
    return this.exited
  }

  stderrTail(limit = STDERR_TAIL): string {
    const text = this.info
      ? (this.stderrDiagnostic ?? this.info.stderr)
      : this.spec.redact(Buffer.concat(this.stderr).toString('utf8')).trim()
    if (text.length <= limit) return text
    const tail = text.slice(-limit)
    const newline = tail.indexOf('\n')
    return `…${newline >= 0 && newline < tail.length - 1 ? tail.slice(newline + 1) : tail}`
  }

  private async waitFor(ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), ms)
    })
    try {
      return await Promise.race([this.exited.then(() => true), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  private signalGroup(signal: NodeJS.Signals): void {
    const pid = this.child.pid
    if (pid === undefined) return
    try {
      if (process.platform === 'win32') this.child.kill(signal)
      else process.kill(-pid, signal)
    } catch {
      /* The group has already exited. */
    }
  }

  private write(message: unknown): void {
    if (this.info || this.child.stdin.destroyed || this.child.stdin.writableEnded) return
    // Agents that read with line splitters treating U+2028/U+2029 as breaks would otherwise see a torn message.
    const line = `${JSON.stringify(message)
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029')}\n`
    if (this.blocked) {
      this.queue.push(line)
      this.queued += line.length
      if (this.queued > WRITE_QUEUE_LIMIT) void this.stop('kill', 0)
      return
    }
    this.blocked = !this.child.stdin.write(line)
  }

  private onDrain(): void {
    this.blocked = false
    while (!this.blocked && this.queue.length) {
      const line = this.queue.shift()!
      this.queued -= line.length
      this.blocked = !this.child.stdin.write(line)
    }
  }

  private onData(chunk: Buffer): void {
    if (this.info || this.reason === 'overflow') return
    let start = 0
    for (let newline = chunk.indexOf(0x0a); newline !== -1; newline = chunk.indexOf(0x0a, start)) {
      const piece = chunk.subarray(start, newline)
      start = newline + 1
      if (this.partLength + piece.length > this.spec.maxLineBytes) return this.overflow()
      const line = this.partLength ? Buffer.concat([...this.parts, piece]) : piece
      this.parts = []
      this.partLength = 0
      this.onLine(line)
      if (this.info) return
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start)
      if (this.partLength + rest.length > this.spec.maxLineBytes) return this.overflow()
      this.parts.push(rest)
      this.partLength += rest.length
    }
  }

  private overflow(): void {
    this.parts = []
    this.partLength = 0
    this.reason ??= 'overflow'
    void this.stop('kill', 0)
  }

  private onLine(raw: Buffer): void {
    let text = raw.toString('utf8')
    if (text.endsWith('\r')) text = text.slice(0, -1)
    if (!text.trim()) return
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      this.noise++
      return
    }
    if (!isRecord(message)) {
      this.noise++
      return
    }
    const id = message.id
    // Request IDs from the two directions overlap, so the presence of `method` decides the direction.
    if (typeof message.method === 'string') {
      const method = message.method
      if (id === undefined || id === null) {
        try {
          this.handlers.notification(method, message.params)
        } catch {
          this.noise++
        }
        return
      }
      if (typeof id !== 'string' && typeof id !== 'number') {
        this.noise++
        return
      }
      let reply: Promise<unknown>
      try {
        reply = this.handlers.request(method, message.params, id)
      } catch (error) {
        reply = Promise.reject(error)
      }
      reply.then(
        result => this.write({ jsonrpc: '2.0', id, result: result ?? {} }),
        error => this.write({ jsonrpc: '2.0', id, error: rpcError(error) }),
      )
      return
    }
    if (typeof id !== 'string' && typeof id !== 'number') {
      this.noise++
      return
    }
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    entry.cleanup()
    if (isRecord(message.error)) {
      const code = typeof message.error.code === 'number' ? message.error.code : RPC.internal
      const text = typeof message.error.message === 'string' ? message.error.message : 'Agent error'
      entry.reject(new RpcError(code, text.slice(0, 4000), message.error.data))
    } else entry.resolve(message.result)
  }

  private onStderr(chunk: Buffer): void {
    this.stderr.push(chunk)
    this.stderrLength += chunk.length
    while (this.stderr.length > 1 && this.stderrLength - this.stderr[0].length >= STDERR_LIMIT) {
      this.stderrLength -= this.stderr.shift()!.length
    }
  }

  private onError(error: Error): void {
    if (this.child.pid !== undefined) return
    this.spawnError = error.message
    this.reason ??= 'spawn'
    this.finish()
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.leaderExited = true
    this.exitCode = code
    this.exitSignal = signal
    // Helpers left in the group are orphans of a dead agent.
    this.signalGroup('SIGKILL')
    this.fallback = setTimeout(() => {
      this.child.stdout.destroy()
      this.child.stderr.destroy()
      this.finish()
    }, CLOSE_FALLBACK_MS)
    this.fallback.unref()
  }

  private finish(): void {
    if (this.info) return
    clearTimeout(this.fallback)
    if (this.partLength && this.reason !== 'overflow') {
      const line = Buffer.concat(this.parts)
      this.parts = []
      this.partLength = 0
      this.onLine(line)
    }
    this.stderrDiagnostic = this.stderrTail(4096)
    this.info = {
      code: this.exitCode,
      signal: this.exitSignal,
      stderr: this.stderrTail(),
      ...(this.reason ? { reason: this.reason } : {}),
      ...(this.cause ? { cause: this.cause } : {}),
      ...(this.spawnError ? { error: this.spawnError } : {}),
    }
    const closed = new ConnectionClosed(this.info)
    for (const entry of this.pending.values()) {
      entry.cleanup()
      entry.reject(closed)
    }
    this.pending.clear()
    this.queue = []
    this.queued = 0
    this.stderr = []
    this.stderrLength = 0
    try {
      this.handlers.exit(this.info)
    } finally {
      this.resolveExited(this.info)
    }
  }
}
