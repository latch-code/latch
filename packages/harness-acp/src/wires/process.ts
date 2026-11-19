import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'

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

export interface SpawnSpec {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  maxLineBytes: number
  redact(text: string): string
}

/**
 * What a wire reads from its process: one JSON object per line, then the end of the process. Without `record` or `text`
 * the process's stdin and stdout are the caller's own (`streams`), for a library that speaks to the process itself.
 */
export interface ProcessEvents {
  record?(message: Record<string, unknown>): void
  /** A line on stdout that is not a JSON object, for a program that speaks elsewhere and only says where on stdout. */
  text?(line: string): void
  /** Called once, before `exited` resolves. */
  closed(info: ExitInfo): void
}

const STDERR_LIMIT = 64 * 1024
const STDERR_TAIL = 600
const WRITE_QUEUE_LIMIT = 64 * 1024 * 1024
/** After the leader exits, a grandchild could hold the pipes open; stop waiting for them. */
const CLOSE_FALLBACK_MS = 2_000

/** `pid ppid pgid` lines of every process, or undefined when they cannot be read. Replaced in tests. */
type Lister = () => Promise<string | undefined>
const psListing: Lister = () =>
  new Promise(resolve => {
    if (process.platform === 'win32') return resolve(undefined)
    // A fixed program with no inherited environment, as other system reads here run.
    execFile('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid='], { env: {}, timeout: 2_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? undefined : stdout),
    )
  })
let lister: Lister = psListing

/** Tests only: how the process list is read (`undefined` restores `ps`). */
export function setProcessLister(next: Lister | undefined): void {
  lister = next ?? psListing
}

/**
 * The processes below `root`, each with its process group, from one listing. Undefined when the listing could not be
 * read (no `ps`, Windows, a failure or timeout): a caller then cannot tell what is the agent's, and kills nothing by pid.
 */
export async function descendants(root: number): Promise<Map<number, number> | undefined> {
  const listing = await lister()
  if (listing === undefined) return undefined
  const found = new Map<number, number>()
  const children = new Map<number, Array<{ pid: number; pgid: number }>>()
  for (const line of listing.split('\n')) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/u).map(Number)
    if (!pid || !ppid || !pgid) continue
    children.set(ppid, [...(children.get(ppid) ?? []), { pid, pgid }])
  }
  const queue = [root]
  while (queue.length) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (found.has(child.pid) || child.pid === root) continue
      found.set(child.pid, child.pgid)
      queue.push(child.pid)
    }
  }
  return found
}

/** SIGKILL for a process and, when it leads its own group, the whole group. */
export function killProcess(pid: number, pgid: number | undefined): void {
  try {
    if (pgid === pid) process.kill(-pid, 'SIGKILL')
    else process.kill(pid, 'SIGKILL')
  } catch {
    /* Already gone. */
  }
}

/** Whether any process of the group is left: `kill(-pgid, 0)` fails with ESRCH only once none is. */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One agent process exchanging newline-delimited JSON objects over stdio, whatever protocol they carry. */
export class AgentProcess {
  readonly exited: Promise<ExitInfo>
  /** Lines on stdout that were not messages of the protocol. */
  noise = 0
  private resolveExited!: (info: ExitInfo) => void
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
    private readonly events: ProcessEvents,
    /** Whether the program ends when its stdin does; one that does not is signalled at once on `stop`. */
    private readonly endsWithStdin: boolean,
  ) {
    this.exited = new Promise(resolve => {
      this.resolveExited = resolve
    })
    if (events.record || events.text) child.stdout.on('data', (chunk: Buffer) => this.onData(chunk))
    child.stderr.on('data', (chunk: Buffer) => this.onStderr(chunk))
    child.stdin.on('drain', () => this.onDrain())
    // EPIPE after the agent exits is expected; the exit path reports it.
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', () => {})
    child.on('error', error => this.onError(error))
    child.on('exit', (code, signal) => this.onExit(code, signal))
    child.on('close', () => this.finish())
  }

  /** Throws only for invalid arguments; launch failures such as ENOENT arrive as an exit with `reason: 'spawn'`. */
  static spawn(spec: SpawnSpec, events: ProcessEvents, options: { endsWithStdin?: boolean } = {}): AgentProcess {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // A separate process group lets one signal reach every helper process the agent starts.
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    return new AgentProcess(child, spec, events, options.endsWithStdin ?? true)
  }

  get closed(): boolean {
    return this.info !== undefined
  }
  /** The exit, once the process is gone. */
  get exit(): ExitInfo | undefined {
    return this.info
  }
  /** Exited, being stopped, or no longer accepting input: hand no new work to it. */
  get stopping(): boolean {
    return this.info !== undefined || this.reason !== undefined || this.child.stdin.destroyed || this.child.stdin.writableEnded
  }
  get pid(): number | undefined {
    return this.child.pid
  }
  /** The process's own stdin and stdout, for a caller that reads and writes them itself (no `record`). */
  get streams(): { stdin: Writable; stdout: Readable } {
    return { stdin: this.child.stdin, stdout: this.child.stdout }
  }
  /** A signal to every process of the group, as `stop` sends them; for a library that ends the process its own way. */
  signal(signal: NodeJS.Signals): void {
    if (!this.info) this.signalGroup(signal)
  }

  write(message: unknown): void {
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

  /** `stop`: end stdin, then SIGTERM, then SIGKILL the group. `kill` skips stdin. Resolves once the process is gone. */
  async stop(reason: 'stop' | 'kill', graceMs: number, cause?: string): Promise<ExitInfo> {
    if (this.info) return this.info
    if (!this.reason) {
      this.reason = reason
      this.cause = cause
    }
    if (reason === 'stop' && !this.leaderExited) {
      this.child.stdin.end()
      if (this.endsWithStdin && (await this.waitFor(graceMs))) return this.exited
    }
    // A forced end takes along what the agent started in groups of their own (Codex runs each command in one), which the
    // group's signal misses and which would outlive it: found while the leader is alive, before they are reparented.
    if (reason === 'kill' && !this.info && !this.leaderExited) await this.killStrays()
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

  private async killStrays(): Promise<void> {
    const pid = this.child.pid
    if (pid === undefined) return
    const below = await descendants(pid)
    // Once the owned leader exits, an in-flight listing can name reparented or re-used PIDs. Its ancestry is no authority.
    if (this.info || this.leaderExited) return
    for (const [stray, pgid] of below ?? []) if (pgid !== pid) killProcess(stray, pgid)
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
      message = undefined
    }
    if (!isRecord(message)) {
      if (this.events.text) this.events.text(text)
      else this.noise++
      return
    }
    this.events.record?.(message)
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
    this.queue = []
    this.queued = 0
    this.stderr = []
    this.stderrLength = 0
    try {
      this.events.closed(this.info)
    } finally {
      this.resolveExited(this.info)
    }
  }
}
