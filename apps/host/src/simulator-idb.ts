// The person's own idb_companion (facebook/idb, MIT), which delivers touches, keys and buttons to a simulator. Latch
// never installs, updates or bundles it: it finds the binary where Homebrew or PATH put it and runs it with a fixed
// argument list for one validated UDID, listening on a Unix socket only, never TCP (`--grpc-port` listens on every
// interface without authentication). The socket lives in a private 0700 directory; the companion ends with the
// person's control, the device, the Host, or by itself once idle (so a crashed Host leaves none behind for long). The
// Host speaks HTTP/2 to it with `node:http2` and hand-encodes the few messages it needs (simulator-idb-wire.ts).
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import http2 from 'node:http2'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Readable } from 'node:stream'
import type { SimulatorInputReason } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { GrpcReader, encodeHidEvent, grpcFrame, screenPoints, type HidEvent } from './simulator-idb-wire.ts'

const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/u
/** Where Homebrew puts it on Apple silicon and on Intel; then the Host's own PATH, absolute entries only. */
const KNOWN_PLACES = ['/opt/homebrew/bin/idb_companion', '/usr/local/bin/idb_companion']
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

/** The installed companion: Homebrew's places first, then each absolute directory on the Host's PATH. */
export async function locateIdbCompanion(path = process.env.PATH ?? '', places = KNOWN_PLACES): Promise<string | undefined> {
  const candidates = [
    ...places,
    ...path
      .split(delimiter)
      .filter(isAbsolute)
      .map(dir => join(dir, 'idb_companion')),
  ]
  for (const candidate of candidates) if (await executable(candidate)) return candidate
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

/** One gRPC call's answer: its messages, and its status from the trailers (or the headers, for a trailers-only answer). */
function settle(request: http2.ClientHttp2Stream, limit: number): Promise<CallResult> {
  const reader = new GrpcReader(limit)
  const messages: Buffer[] = []
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
        messages.push(...reader.push(chunk))
      } catch (error) {
        request.close(http2.constants.NGHTTP2_CANCEL)
        reject(error)
      }
    })
    request.on('error', reject)
    request.on('close', () => {
      if (status === undefined) reject(new Error('idb_companion closed the call without a status'))
      else resolve({ status, messages })
    })
  })
}

/** A `hid` client stream: events take effect as each message arrives; the status comes only when the stream ends. */
export class HidStream {
  private readonly request: http2.ClientHttp2Stream
  private readonly result: Promise<CallResult>
  private failure: Error | undefined

  constructor(request: http2.ClientHttp2Stream) {
    this.request = request
    this.result = settle(request, 1024)
    this.result.then(
      ({ status }) => {
        if (status !== 0) this.failure ??= new Error(`idb_companion answered status ${status}`)
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

  /** Ends the stream; resolves only once the companion answered status 0 for every event sent. */
  async end(): Promise<void> {
    if (!this.request.closed) this.request.end()
    const { status } = await this.result
    if (status !== 0) throw new Error(`idb_companion answered status ${status}`)
  }

  /** Abandons it: the companion lifts a finger left down when a stream is cancelled. */
  cancel(): void {
    this.failure ??= new Error('cancelled')
    if (!this.request.closed) this.request.close(http2.constants.NGHTTP2_CANCEL)
    this.result.catch(() => undefined)
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
  static async start(udid: string, options: IdbOptions = {}): Promise<IdbCompanion> {
    if (!UDID.test(udid)) throw new AppError(400, 'invalid-input', '设备标识无效')
    const binary = await (options.locate ?? locateIdbCompanion)()
    if (!binary) throw new IdbUnavailable('idb-missing', '没有找到 idb_companion')
    const dir = await mkdtemp(join(options.tempDir ?? tmpdir(), 'latch-idb-'))
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
    // It prints `{"grpc_path":"c.sock"}` once it listens; nothing else of its output is read or kept.
    const ready = await new Promise<boolean>(resolve => {
      let text = ''
      const timer = setTimeout(() => resolve(false), options.readyMs ?? READY_MS)
      timer.unref()
      child.stdout?.on('data', (chunk: Buffer) => {
        if (text.length >= STDOUT_LIMIT) return
        text += chunk.toString('utf8').slice(0, STDOUT_LIMIT - text.length)
        if (text.includes(`"grpc_path":"${SOCKET_NAME}"`)) {
          clearTimeout(timer)
          resolve(true)
        }
      })
      void exit.then(() => {
        clearTimeout(timer)
        resolve(false)
      })
    })
    if (!ready) {
      await ended()
      throw new IdbUnavailable('companion-failed', 'idb_companion 没有启动')
    }
    const session = http2.connect('http://localhost', { createConnection: () => net.connect(socket) })
    const companion = new IdbCompanion(udid, child, dir, session, exit)
    void exit.then(() => rm(dir, { recursive: true, force: true }).catch(() => undefined))
    return companion
  }

  /** The screen in points, from `describe`: also the harmless call that proves the companion answers. */
  async describe(): Promise<{ width: number; height: number }> {
    const request = this.call('/idb.CompanionService/describe')
    request.end(grpcFrame(Buffer.alloc(0)))
    const timer = setTimeout(() => request.close(http2.constants.NGHTTP2_CANCEL), CALL_MS)
    try {
      const { status, messages } = await settle(request, 256 * 1024)
      const size = status === 0 && messages[0] ? screenPoints(messages[0]) : undefined
      if (!size) throw new IdbUnavailable('no-answer', 'idb_companion 没有回答')
      return size
    } catch (error) {
      if (error instanceof IdbUnavailable) throw error
      throw new IdbUnavailable('no-answer', 'idb_companion 没有回答')
    } finally {
      clearTimeout(timer)
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
