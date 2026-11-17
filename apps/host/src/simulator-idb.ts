// The person's own idb_companion (facebook/idb, MIT), which delivers touches, keys and buttons to a simulator. Latch
// never installs, updates or bundles it: it finds the binary in Homebrew's Cellar and runs it with a fixed
// argument list for one validated UDID, listening on a Unix socket only, never TCP (`--grpc-port` listens on every
// interface without authentication). The socket lives in a private 0700 directory; the companion ends with the
// person's control, the device, the Host, or by itself once idle (so a crashed Host leaves none behind for long). The
// Host speaks HTTP/2 to it with `node:http2` and hand-encodes the few messages it needs (simulator-idb-wire.ts).
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises'
import http2 from 'node:http2'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import type { SimulatorInputReason } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { GrpcReader, encodeHidEvent, grpcFrame, screenPoints, type HidEvent } from './simulator-idb-wire.ts'

const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/u
/** Where Homebrew links it on Apple silicon and Intel, paired with each installation's Cellar. */
const KNOWN_PLACES = [
  { link: '/opt/homebrew/bin/idb_companion', cellar: '/opt/homebrew/Cellar' },
  { link: '/usr/local/bin/idb_companion', cellar: '/usr/local/Cellar' },
]
/** A Unix socket's name is at most 104 bytes on macOS, with its terminating zero. */
const SOCKET_PATH_LIMIT = 103
const SOCKET_NAME = 'c.sock'
const DIR_NAME = /^latch-idb-[A-Za-z0-9]{6}$/u
const READY_MS = 30_000
const CALL_MS = 10_000
const CLOSE_MS = 2_000
/** The companion exits by itself after this long with no request: what bounds one left by a Host that crashed. */
const IDLE_SECONDS = 120
const STDOUT_LIMIT = 4096
/** How long the end of a hid stream may wait for the companion's status. */
const END_MS = 5_000
/** A hid stream whose writes are not taken past this is broken. */
const WRITE_BACKLOG = 64 * 1024

export class IdbUnavailable extends AppError {
  readonly reason: SimulatorInputReason
  constructor(reason: SimulatorInputReason, message: string) {
    super(409, 'simulator-input-unavailable', message)
    this.reason = reason
  }
}

/** The process the Host talks to: the real companion in production, a stand-in in tests. */
export interface IdbChild {
  readonly stdout: Readable | null
  kill(signal?: NodeJS.Signals): boolean
  once(event: 'close', listener: (code: number | null) => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
}
export type IdbSpawner = (binary: string, args: readonly string[], options: { cwd: string; env: Record<string, string> }) => IdbChild

export interface IdbOptions {
  /** Finds the binary; undefined when it is not installed. */
  locate?: () => Promise<string | undefined>
  /** Tests only: a stand-in for the binary. */
  spawn?: IdbSpawner
  /** Where the private directories go; the system's temporary directory unless a test names one. */
  tempDir?: string
  readyMs?: number
}

/** Cancels an individual wait without cancelling work a different caller may still need. */
export function waitForIdb<T>(result: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return result
  return new Promise((resolve, reject) => {
    const cancelled = () => reject(signal.reason)
    if (signal.aborted) cancelled()
    else signal.addEventListener('abort', cancelled, { once: true })
    void result.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancelled))
  })
}

/** The companion's environment: the same few variables as simctl's, so nothing such as HID logging is passed in. */
function companionEnvironment(): Record<string, string> {
  const env: Record<string, string> = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
  for (const key of ['HOME', 'DEVELOPER_DIR', 'USER', 'LOGNAME'] as const) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  return env
}

const realSpawn: IdbSpawner = (binary, args, { cwd, env }) =>
  spawn(binary, [...args], { cwd, env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })

async function executable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The installed companion: only Homebrew's two places, and only when the program there resolves into Homebrew's own
 * Cellar. Never PATH: a same-named program in a project's `node_modules/.bin` would otherwise run on first control.
 */
export async function locateIdbCompanion(
  places: ReadonlyArray<{ link: string; cellar: string }> = KNOWN_PLACES,
): Promise<string | undefined> {
  for (const { link, cellar } of places) {
    try {
      const target = await realpath(link)
      const root = await realpath(cellar)
      if (target.startsWith(`${root}/`) && (await executable(target))) return target
    } catch {
      // Not there.
    }
  }
  return undefined
}

/**
 * Removes the private directories a Host that crashed left behind: only this user's, by their exact name, never a link,
 * and only when nothing answers on the socket inside (a live companion of another Host keeps its own).
 */
export async function removeStaleIdbDirs(dir = tmpdir()): Promise<string[]> {
  const removed: string[] = []
  const uid = process.getuid?.()
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return removed
  }
  for (const name of names) {
    if (!DIR_NAME.test(name)) continue
    const path = join(dir, name)
    try {
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid)) continue
      if (await answers(join(path, SOCKET_NAME))) continue
      await rm(path, { recursive: true, force: true })
      removed.push(name)
    } catch {
      // Gone already, or not this user's.
    }
  }
  return removed
}

function answers(socket: string): Promise<boolean> {
  return new Promise(resolve => {
    if (Buffer.byteLength(socket) > SOCKET_PATH_LIMIT) {
      resolve(false)
      return
    }
    const connection = net.connect(socket)
    const done = (alive: boolean) => {
      connection.destroy()
      resolve(alive)
    }
    connection.once('connect', () => done(true))
    connection.once('error', () => done(false))
    setTimeout(() => done(false), 1000).unref()
  })
}

interface CallResult {
  status: number
  messages: Buffer[]
}

/** What one call's answer may hold, whoever is at the socket: so many messages, so many bytes in all. */
const ANSWER_BYTES = 256 * 1024

/**
 * One gRPC call's answer: its messages, and its status from the trailers (or the headers, for a trailers-only answer).
 * An answer past `count` messages or 256 KiB in all is cancelled and fails: a broken or impostor program at the socket
 * costs this call, never the Host's memory.
 */
function settle(request: http2.ClientHttp2Stream, count: number): Promise<CallResult> {
  const reader = new GrpcReader(ANSWER_BYTES)
  const messages: Buffer[] = []
  let bytes = 0
  return new Promise((resolve, reject) => {
    let status: number | undefined
    const read = (headers: http2.IncomingHttpHeaders) => {
      const value = headers['grpc-status']
      if (typeof value === 'string' && /^\d{1,2}$/u.test(value)) status = Number(value)
    }
    request.on('response', read)
    request.on('trailers', read)
    request.on('data', (chunk: Buffer) => {
      try {
        bytes += chunk.length
        if (bytes > ANSWER_BYTES) throw new RangeError('idb_companion answered too much')
        messages.push(...reader.push(chunk))
        if (messages.length > count) throw new RangeError('idb_companion answered too many messages')
      } catch (error) {
        request.close(http2.constants.NGHTTP2_CANCEL)
        reject(error)
      }
    })
    request.on('error', reject)
    // The answer is complete once the companion ended its side, even while ours is still open: a hid stream it ended
    // (checked: rotating the device ends one with「Simulator display changed」) must not take more events silently.
    const done = () => {
      if (status === undefined) reject(new Error('idb_companion closed the call without a status'))
      else resolve({ status, messages })
    }
    request.on('end', done)
    request.on('close', done)
  })
}

/** A `hid` client stream: events take effect as each message arrives; the status comes only when the stream ends. */
export class HidStream {
  private readonly request: http2.ClientHttp2Stream
  private readonly result: Promise<CallResult>
  private readonly closed: Promise<void>
  private failure: Error | undefined

  constructor(request: http2.ClientHttp2Stream) {
    this.request = request
    this.closed = new Promise(resolve => request.once('close', resolve))
    // HIDResponse is one empty message, sent as the stream ends.
    this.result = settle(request, 1)
    this.result.then(
      ({ status }) => {
        // Ended by the companion, whatever the status: nothing more can be delivered on it.
        this.failure ??= new Error(`idb_companion ended the hid stream (status ${status})`)
        if (!this.request.closed) this.request.close(http2.constants.NGHTTP2_CANCEL)
      },
      error => {
        this.failure ??= error instanceof Error ? error : new Error(String(error))
      },
    )
  }

  /** Whether events can still be written. */
  get open(): boolean {
    return !this.failure && !this.request.closed && !this.request.destroyed && this.request.writable
  }

  /** Writes events in order; throws when the stream already failed or the companion stopped reading. */
  write(events: readonly HidEvent[]): void {
    if (!this.open) throw this.failure ?? new Error('idb_companion closed the hid stream')
    this.request.write(Buffer.concat(events.map(event => grpcFrame(encodeHidEvent(event)))))
    if (this.request.writableLength > WRITE_BACKLOG) {
      this.failure = new Error('idb_companion is not reading input')
      this.request.close(http2.constants.NGHTTP2_CANCEL)
      throw this.failure
    }
  }

  /**
   * Ends the stream; resolves only once the companion answered status 0 for every event sent. One that has not answered
   * within five seconds is cancelled and counts as not delivered.
   */
  async end(timeoutMs = END_MS, signal?: AbortSignal): Promise<void> {
    const cancel = () => {
      this.cancel()
      this.request.destroy()
    }
    if (signal?.aborted) cancel()
    else signal?.addEventListener('abort', cancel, { once: true })
    if (!this.request.closed) this.request.end()
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        this.cancel()
        reject(new Error('idb_companion did not answer'))
      }, timeoutMs)
    })
    try {
      const answer = this.result.then(async result => {
        await this.closed
        return result
      })
      const { status } = await Promise.race([answer, late])
      signal?.throwIfAborted()
      if (status !== 0) throw new Error(`idb_companion answered status ${status}`)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
    }
  }

  /** Abandons it: the companion lifts a finger left down when a stream is cancelled. */
  cancel(): void {
    this.failure ??= new Error('cancelled')
    if (!this.request.closed) this.request.close(http2.constants.NGHTTP2_CANCEL)
    this.result.catch(() => undefined)
  }

  /** A cancelled gesture keeps the device until its local HTTP/2 stream has closed. */
  async cancelAndWait(): Promise<void> {
    this.cancel()
    this.request.destroy()
    await this.closed
  }
}

/** One running companion for one device, on its private socket. */
export class IdbCompanion {
  readonly udid: string
  private readonly child: IdbChild
  private readonly dir: string
  private readonly session: http2.ClientHttp2Session
  private exited = false
  private readonly exit: Promise<void>
  private readonly exitListeners = new Set<() => void>()

  private constructor(udid: string, child: IdbChild, dir: string, session: http2.ClientHttp2Session, exit: Promise<void>) {
    this.udid = udid
    this.child = child
    this.dir = dir
    this.session = session
    this.exit = exit
    session.on('error', () => undefined)
    void exit.then(() => {
      this.exited = true
      session.destroy()
      for (const listener of this.exitListeners) listener()
    })
  }

  get alive(): boolean {
    return !this.exited && !this.session.closed && !this.session.destroyed
  }

  onExit(listener: () => void): () => void {
    if (this.exited) listener()
    else this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  /**
   * Starts a companion for a listed device and waits until its socket answers. Throws `IdbUnavailable` with the reason
   * when it is not installed, will not start or does not answer; whatever it started is ended first.
   */
  static async start(udid: string, options: IdbOptions = {}, signal?: AbortSignal): Promise<IdbCompanion> {
    if (!UDID.test(udid)) throw new AppError(400, 'invalid-input', '设备标识无效')
    signal?.throwIfAborted()
    const binary = await waitForIdb((options.locate ?? locateIdbCompanion)(), signal)
    signal?.throwIfAborted()
    if (!binary) throw new IdbUnavailable('idb-missing', '没有找到 idb_companion')
    const dir = await mkdtemp(join(options.tempDir ?? tmpdir(), 'latch-idb-'))
    if (signal?.aborted) {
      await rm(dir, { recursive: true, force: true })
      signal.throwIfAborted()
    }
    const socket = join(dir, SOCKET_NAME)
    if (Buffer.byteLength(socket) > SOCKET_PATH_LIMIT) {
      await rm(dir, { recursive: true, force: true })
      throw new IdbUnavailable('socket-path', '临时目录的路径太长，放不下 idb 的套接字')
    }
    // The socket's name is relative to the companion's own working directory, the private one.
    const args = [
      '--udid',
      udid,
      '--grpc-domain-sock',
      SOCKET_NAME,
      '--only',
      'simulator',
      '--terminate-offline',
      'true',
      '--idle-shutdown-time',
      String(IDLE_SECONDS),
      '--log-level',
      'info',
      '--log-hid-details',
      'false',
    ]
    let child: IdbChild
    try {
      child = (options.spawn ?? realSpawn)(binary, args, { cwd: dir, env: companionEnvironment() })
    } catch {
      await rm(dir, { recursive: true, force: true })
      throw new IdbUnavailable('companion-failed', 'idb_companion 没有启动')
    }
    let exited!: () => void
    const exit = new Promise<void>(resolve => (exited = resolve))
    child.once('close', () => exited())
    child.once('error', () => exited())
    const ended = () => stop(child, exit).finally(() => rm(dir, { recursive: true, force: true }))
    // Read only the bounded startup reports on stdout. A TCP report means an unauthenticated listener: stop it at once.
    let tcp = false
    const ready = await new Promise<boolean>(resolve => {
      let pending = ''
      let remaining = STDOUT_LIMIT
      const finish = (ready: boolean) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
        resolve(ready)
      }
      const cancel = () => finish(false)
      const timer = setTimeout(cancel, options.readyMs ?? READY_MS)
      timer.unref()
      if (signal?.aborted) cancel()
      else signal?.addEventListener('abort', cancel, { once: true })
      child.stdout?.on('data', (chunk: Buffer) => {
        if (remaining === 0) return
        const bytes = chunk.subarray(0, remaining)
        remaining -= bytes.length
        const lines = (pending + bytes.toString('utf8')).split('\n')
        pending = lines.pop()!
        let socketReady = false
        for (const line of lines) {
          let report: unknown
          try {
            report = JSON.parse(line)
          } catch {
            continue
          }
          if (!report || typeof report !== 'object') continue
          if (Object.hasOwn(report, 'grpc_port') || Object.hasOwn(report, 'grpc_swift_port')) {
            tcp = true
            child.kill('SIGKILL')
            finish(false)
            return
          }
          if ('grpc_path' in report && report.grpc_path === SOCKET_NAME) socketReady = true
        }
        if (socketReady) finish(true)
      })
      void exit.then(cancel)
    })
    if (!ready || signal?.aborted) {
      await ended()
      signal?.throwIfAborted()
      throw new IdbUnavailable('companion-failed', tcp ? 'idb_companion 要监听网络端口，已停止' : 'idb_companion 没有启动')
    }
    const session = http2.connect('http://localhost', { createConnection: () => net.connect(socket) })
    const companion = new IdbCompanion(udid, child, dir, session, exit)
    void exit.then(() => rm(dir, { recursive: true, force: true }).catch(() => undefined))
    return companion
  }

  /** The screen in points, from `describe`: also the harmless call that proves the companion answers. */
  async describe(timeoutMs = CALL_MS, signal?: AbortSignal): Promise<{ width: number; height: number }> {
    signal?.throwIfAborted()
    const request = this.call('/idb.CompanionService/describe')
    request.end(grpcFrame(Buffer.alloc(0)))
    const cancel = () => request.close(http2.constants.NGHTTP2_CANCEL)
    const timer = setTimeout(cancel, timeoutMs)
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      const { status, messages } = await settle(request, 1)
      const size = status === 0 && messages[0] ? screenPoints(messages[0]) : undefined
      if (!size) throw new IdbUnavailable('no-answer', 'idb_companion 没有回答')
      return size
    } catch (error) {
      if (error instanceof IdbUnavailable) throw error
      throw new IdbUnavailable('no-answer', 'idb_companion 没有回答')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
    }
  }

  /** A new `hid` stream. */
  hid(): HidStream {
    if (!this.alive) throw new IdbUnavailable('companion-failed', 'idb_companion 已退出')
    return new HidStream(this.call('/idb.CompanionService/hid'))
  }

  /** SIGTERM (it removes its socket and temporary folder), SIGKILL if it has not exited in two seconds. */
  async close(): Promise<void> {
    this.session.destroy()
    await stop(this.child, this.exit)
    await rm(this.dir, { recursive: true, force: true }).catch(() => undefined)
  }

  private call(path: string): http2.ClientHttp2Stream {
    return this.session.request({ ':method': 'POST', ':path': path, 'content-type': 'application/grpc', te: 'trailers' })
  }
}

async function stop(child: IdbChild, exit: Promise<void>): Promise<void> {
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), CLOSE_MS)
  timer.unref()
  await Promise.race([exit, new Promise(resolve => setTimeout(resolve, CLOSE_MS + 500).unref())])
  clearTimeout(timer)
}
