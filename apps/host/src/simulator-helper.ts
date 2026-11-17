// Runs latch-simulator (native/macos/LatchSimulator.swift) for one booted simulator and turns its frames into typed
// calls: the live picture only, no input. The helper uses Apple's private CoreSimulator inside its own process; the Host
// talks to it only through the framing documented at the top of that file. Not used by any route yet.
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { AppError } from '@latch/sdk'
import { z } from 'zod'
import { latchCodeRoot } from './paths.ts'

/** Host to helper. 0x10–0x3f are reserved for input, which this build does not send. */
export const TO_SIMULATOR = { start: 0x01, stop: 0x02, keyframe: 0x03, ping: 0x04 } as const
export const FROM_SIMULATOR = { capabilities: 0x81, description: 0x82, frame: 0x83, result: 0x84, gone: 0x85 } as const
const HEADER_BYTES = 5
const CONTROL_TYPES: ReadonlySet<number> = new Set([
  FROM_SIMULATOR.capabilities,
  FROM_SIMULATOR.description,
  FROM_SIMULATOR.result,
  FROM_SIMULATOR.gone,
])
/** JSON messages either way. */
export const CONTROL_LIMIT = 65_536
/** One frame: flags, timestamp and at most 8 MiB of picture. */
export const FRAME_LIMIT = 9 + 8 * 1_048_576
const FRAME_FIELDS = 9
const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/u

export interface SimulatorMessage {
  type: number
  payload: Buffer
}

/** Splits the helper's stdout into messages whatever the chunk boundaries; throws on an unknown type or a length over its bound. */
export class SimulatorFrameReader {
  private chunks: Buffer[] = []
  private length = 0

  push(chunk: Buffer): SimulatorMessage[] {
    this.chunks.push(chunk)
    this.length += chunk.length
    const messages: SimulatorMessage[] = []
    while (this.length >= HEADER_BYTES) {
      const head = this.peek(HEADER_BYTES)
      const type = head.readUInt8(0)
      const size = head.readUInt32BE(1)
      if (type === FROM_SIMULATOR.frame) {
        if (size < FRAME_FIELDS || size > FRAME_LIMIT) throw new RangeError('Invalid simulator frame length')
      } else if (CONTROL_TYPES.has(type)) {
        if (size > CONTROL_LIMIT) throw new RangeError('Simulator message too large')
      } else throw new RangeError('Unknown simulator message type')
      if (this.length < HEADER_BYTES + size) break
      const whole = this.take(HEADER_BYTES + size)
      messages.push({ type, payload: whole.subarray(HEADER_BYTES) })
    }
    return messages
  }

  /** Bytes of a message that has not arrived in full. */
  get buffered(): number {
    return this.length
  }

  private peek(count: number): Buffer {
    if (this.chunks[0].length < count) this.chunks = [Buffer.concat(this.chunks)]
    return this.chunks[0].subarray(0, count)
  }

  private take(count: number): Buffer {
    if (this.chunks[0].length < count) this.chunks = [Buffer.concat(this.chunks)]
    const first = this.chunks[0]
    const taken = first.subarray(0, count)
    if (first.length === count) this.chunks.shift()
    else this.chunks[0] = first.subarray(count)
    this.length -= count
    return taken
  }
}

export function encodeSimulatorRequest(type: number, request: Record<string, unknown>): Buffer {
  if (!Number.isInteger(type) || type < 0 || type > 0x7f) throw new RangeError('Invalid simulator request type')
  const payload = Buffer.from(JSON.stringify(request))
  if (payload.length > CONTROL_LIMIT) throw new RangeError('Simulator request too large')
  const head = Buffer.allocUnsafe(HEADER_BYTES)
  head.writeUInt8(type, 0)
  head.writeUInt32BE(payload.length, 1)
  return Buffer.concat([head, payload])
}

const unavailable = z.strictObject({ available: z.literal(false), reason: z.string().max(64) })
const capabilitiesSchema = z.strictObject({
  protocol: z.literal(1),
  version: z.string().max(32),
  frames: z.union([
    z.strictObject({ available: z.literal(true) }),
    // The helper truncates its reason to 128 characters; the margin keeps a changed Xcode reading as unsupported.
    z.strictObject({ available: z.literal(false), reason: z.string().max(256) }),
  ]),
  codecs: z.strictObject({ h264: z.boolean(), jpeg: z.boolean() }),
  // This build sends no input: anything else from a helper is a helper this Host does not understand.
  input: z.strictObject({ touch: unavailable, keyboard: unavailable, buttons: unavailable, orientation: unavailable }),
})
export type SimulatorCapabilities = z.infer<typeof capabilitiesSchema>

const dimension = z.number().int().min(1).max(16_384)
const descriptionSchema = z.strictObject({
  codec: z.enum(['h264', 'jpeg']),
  codecString: z
    .string()
    .regex(/^avc1\.[0-9a-f]{6}$/u)
    .optional(),
  config: z.base64().max(8192).optional(),
  width: dimension,
  height: dimension,
  sourceWidth: dimension,
  sourceHeight: dimension,
  scale: z.number().min(1).max(4),
  // SimScreen's own value, passed through: a value this Host does not know is not a broken helper.
  orientation: z.number().int().min(0).max(4_294_967_295),
})
export type SimulatorStreamDescription = z.infer<typeof descriptionSchema>
const resultSchema = z.strictObject({
  id: z.number().int().min(0).max(2_147_483_647),
  ok: z.boolean(),
  error: z.string().max(128).optional(),
})
const goneSchema = z.strictObject({ reason: z.enum(['shutdown', 'not-found']) })

/** What `--self-test` prints: the capability table, checked without attaching to any device. */
export function parseSelfTest(stdout: string): SimulatorCapabilities {
  return capabilitiesSchema.parse(JSON.parse(stdout.trim()))
}

export type SimulatorStreamEvent =
  | { type: 'description'; description: SimulatorStreamDescription }
  /** `data` is one H.264 access unit in AVCC form, or one JPEG. `timestamp` is microseconds since the stream started. */
  | { type: 'frame'; keyframe: boolean; timestamp: number; data: Buffer }

export interface StreamSettings {
  codec: 'h264' | 'jpeg'
  /** 1–60. */
  maxFps: number
  /** The longer side in pixels, 160–4096. */
  maxDimension: number
}

/** The process the wrapper talks to: a real helper in production, a stand-in in tests. */
export interface SimulatorHelperProcess {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable | null
  kill(signal?: NodeJS.Signals): boolean
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
}

export type SpawnSimulatorHelper = (binary: string, args: readonly string[]) => SimulatorHelperProcess

export interface SimulatorHelperOptions {
  /** Tests only: a stand-in for the binary. */
  spawn?: SpawnSimulatorHelper
  /** The repository root, where `dist/native/` holds the native components. */
  codeRoot?: string
  /** How long a request or the first capabilities message may take. */
  timeoutMs?: number
  /** Frames waiting for the reader beyond this are dropped, and the stream resumes at the next keyframe. */
  queueLimit?: number
}

/** What is held for a reader that has not caught up, and requests still waiting for a result. */
export interface SimulatorBacklog {
  frames: number
  descriptions: number
  bytes: number
  pending: number
}

const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_QUEUE_LIMIT = 8
const QUEUE_BYTE_LIMIT = 16 * 1_048_576
const CLOSE_DEADLINE_MS = 3000
/** A helper that leaves this many requests unanswered, or this much of stdin unread, is not read any further. */
const PENDING_LIMIT = 32
const STDIN_BACKLOG_LIMIT = 1_048_576
const STDERR_LIMIT = 4096

const realSpawn: SpawnSimulatorHelper = (binary, args) => spawn(binary, [...args], { env: {}, cwd: '/', stdio: ['pipe', 'pipe', 'pipe'] })

/** Where `pnpm build` puts the helper; never taken from a request. */
export function simulatorHelperPath(codeRoot = latchCodeRoot()): string {
  return join(codeRoot, 'dist', 'native', 'latch-simulator')
}

interface Queued {
  event: SimulatorStreamEvent
  bytes: number
}

interface Pending {
  resolve(): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

function helperFailed(message: string): AppError {
  return new AppError(502, 'SIMULATOR_HELPER_FAILED', message)
}

/** One helper process for one device. A crash rejects what is pending and ends the stream; it never throws past here. */
export class SimulatorHelper {
  private readonly reader = new SimulatorFrameReader()
  private readonly pending = new Map<number, Pending>()
  /** At most `queueLimit` frames and one description, at most 16 MiB of frames plus that description. */
  private readonly queue: Queued[] = []
  private queuedFrames = 0
  private queuedBytes = 0
  private keyframeInFlight = false
  private waiter: (() => void) | undefined
  private nextId = 1
  private streaming = false
  private consuming = false
  /** Frames are being dropped until the helper sends a keyframe. */
  private skipping = false
  private failure: AppError | undefined
  private exited = false
  private readonly exit: Promise<void>
  private stderr = ''
  private ready: { resolve(capabilities: SimulatorCapabilities): void; reject(error: Error): void } | undefined
  capabilities: SimulatorCapabilities | undefined
  description: SimulatorStreamDescription | undefined

  private readonly child: SimulatorHelperProcess
  private readonly timeoutMs: number
  private readonly queueLimit: number

  private constructor(child: SimulatorHelperProcess, timeoutMs: number, queueLimit: number) {
    this.child = child
    this.timeoutMs = timeoutMs
    this.queueLimit = queueLimit
    let exited!: () => void
    this.exit = new Promise(resolve => (exited = resolve))
    child.stdin.on('error', () => {})
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk))
    child.stderr?.on('data', (chunk: Buffer) => {
      if (this.stderr.length < STDERR_LIMIT) this.stderr += chunk.toString('utf8').slice(0, STDERR_LIMIT - this.stderr.length)
    })
    child.once('error', () => this.fail(helperFailed('模拟器组件无法启动')))
    // 'close', not 'exit': it comes after stdout has been read to the end, so a last message is never lost.
    child.once('close', () => {
      this.exited = true
      this.fail(helperFailed('模拟器组件已退出'))
      exited()
    })
  }

  /**
   * Starts the helper for a device and waits for its capabilities. Resolves even when frames are unavailable (the
   * capabilities say why, and the helper has exited); rejects only when the helper itself fails.
   */
  static async attach(udid: string, options: SimulatorHelperOptions = {}): Promise<SimulatorHelper> {
    if (!UDID.test(udid)) throw new AppError(400, 'INVALID_SIMULATOR', '设备标识无效')
    const launch = options.spawn ?? realSpawn
    const helper = new SimulatorHelper(
      launch(simulatorHelperPath(options.codeRoot), ['--udid', udid]),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      Math.max(2, options.queueLimit ?? DEFAULT_QUEUE_LIMIT),
    )
    try {
      await new Promise<SimulatorCapabilities>((resolve, reject) => {
        const timer = setTimeout(() => reject(helperFailed('模拟器组件没有响应')), helper.timeoutMs)
        helper.ready = {
          resolve: value => (clearTimeout(timer), resolve(value)),
          reject: error => (clearTimeout(timer), reject(error)),
        }
        if (helper.failure) helper.ready.reject(helper.failure)
      })
    } catch (error) {
      await helper.close()
      throw error
    }
    return helper
  }

  get backlog(): SimulatorBacklog {
    return {
      frames: this.queuedFrames,
      descriptions: this.queue.length - this.queuedFrames,
      bytes: this.queuedBytes,
      pending: this.pending.size,
    }
  }

  /** Short diagnostics the helper wrote to stderr; never picture content. */
  get diagnostics(): string {
    return this.stderr
  }

  /** Starts (or restarts) the stream and yields its events until `close`, `stop`, the device going away or a crash. */
  async *frames(settings: StreamSettings): AsyncGenerator<SimulatorStreamEvent, void, undefined> {
    if (this.consuming) throw new AppError(409, 'SIMULATOR_STREAM_BUSY', '这台设备的画面已在读取')
    if (this.capabilities?.frames.available !== true) throw new AppError(409, 'SIMULATOR_FRAMES_UNAVAILABLE', '这台设备没有实时画面')
    this.consuming = true
    try {
      this.clearQueue()
      this.skipping = false
      this.streaming = true
      await this.request(TO_SIMULATOR.start, { codec: settings.codec, maxFps: settings.maxFps, maxDimension: settings.maxDimension })
      while (true) {
        const queued = this.queue.shift()
        if (queued) {
          this.queuedBytes -= queued.bytes
          if (queued.event.type === 'frame') this.queuedFrames--
          yield queued.event
          continue
        }
        // The device shutting down or close() end the stream; a helper that fails or crashes is an error.
        if (this.failure) {
          if (this.failure.code === 'SIMULATOR_GONE' || this.failure.code === 'SIMULATOR_HELPER_CLOSED') return
          throw this.failure
        }
        if (!this.streaming) return
        await new Promise<void>(resolve => (this.waiter = resolve))
      }
    } finally {
      this.consuming = false
      if (this.streaming && !this.failure) {
        this.streaming = false
        await this.request(TO_SIMULATOR.stop, {}).catch(() => {})
      }
      this.streaming = false
    }
  }

  keyframe(): Promise<void> {
    return this.request(TO_SIMULATOR.keyframe, {})
  }

  ping(): Promise<void> {
    return this.request(TO_SIMULATOR.ping, {})
  }

  /** Closes stdin, then SIGTERM, then SIGKILL; settles once the helper has exited. */
  async close(): Promise<void> {
    this.fail(new AppError(410, 'SIMULATOR_HELPER_CLOSED', '模拟器画面已关闭'))
    if (this.exited) return
    this.child.stdin.end()
    const term = setTimeout(() => this.child.kill('SIGTERM'), CLOSE_DEADLINE_MS / 3)
    const kill = setTimeout(() => this.child.kill('SIGKILL'), CLOSE_DEADLINE_MS)
    await this.exit
    clearTimeout(term)
    clearTimeout(kill)
  }

  private request(type: number, fields: Record<string, unknown>): Promise<void> {
    if (this.failure) return Promise.reject(this.failure)
    const id = this.nextId++
    if (this.nextId > 2_147_483_647) this.nextId = 1
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(helperFailed('模拟器组件没有响应'))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(encodeSimulatorRequest(type, { id, ...fields }))
      if (this.pending.size > PENDING_LIMIT || this.child.stdin.writableLength > STDIN_BACKLOG_LIMIT) {
        this.broken('模拟器组件没有读取请求')
      }
    })
  }

  private receive(chunk: Buffer): void {
    if (this.failure) return
    let messages: SimulatorMessage[]
    try {
      messages = this.reader.push(chunk)
    } catch {
      return this.broken()
    }
    for (const message of messages) {
      if (this.failure) return
      if (!this.handle(message)) return this.broken()
    }
  }

  /** False for a message this Host does not accept: the helper is then stopped. */
  private handle({ type, payload }: SimulatorMessage): boolean {
    if (type === FROM_SIMULATOR.frame) {
      if (!this.capabilities) return false
      // Frames written before a stop was read are still in the pipe.
      if (!this.streaming) return true
      const keyframe = (payload.readUInt8(0) & 1) === 1
      const timestamp = Number(payload.readBigUInt64BE(1))
      if (!Number.isSafeInteger(timestamp)) return false
      this.enqueueFrame({ type: 'frame', keyframe, timestamp, data: Buffer.from(payload.subarray(FRAME_FIELDS)) })
      return true
    }
    let value: unknown
    try {
      value = JSON.parse(payload.toString('utf8'))
    } catch {
      return false
    }
    if (type === FROM_SIMULATOR.capabilities) {
      const parsed = capabilitiesSchema.safeParse(value)
      if (!parsed.success || this.capabilities) return false
      this.capabilities = parsed.data
      this.ready?.resolve(parsed.data)
      return true
    }
    if (!this.capabilities) return false
    if (type === FROM_SIMULATOR.result) {
      const parsed = resultSchema.safeParse(value)
      if (!parsed.success) return false
      const waiting = this.pending.get(parsed.data.id)
      // Results for a request that already timed out are ignored; id 0 means the helper could not read a request.
      if (!waiting) return parsed.data.id !== 0
      this.pending.delete(parsed.data.id)
      clearTimeout(waiting.timer)
      if (parsed.data.ok) waiting.resolve()
      else waiting.reject(new AppError(409, 'SIMULATOR_REQUEST_FAILED', `模拟器组件拒绝了请求：${parsed.data.error ?? '未知'}`))
      return true
    }
    if (type === FROM_SIMULATOR.description) {
      const parsed = descriptionSchema.safeParse(value)
      if (!parsed.success) return false
      this.description = parsed.data
      if (this.streaming) this.enqueueDescription(parsed.data, payload.length)
      return true
    }
    if (type === FROM_SIMULATOR.gone) {
      if (!goneSchema.safeParse(value).success) return false
      this.fail(new AppError(410, 'SIMULATOR_GONE', '设备已关机'))
      return true
    }
    return false
  }

  /** Bounded: a reader that falls behind loses frames, never memory; the stream resumes at a keyframe. */
  private enqueueFrame(event: Extract<SimulatorStreamEvent, { type: 'frame' }>): void {
    if (this.skipping && !event.keyframe) return
    this.skipping = false
    if (this.queuedFrames >= this.queueLimit || this.queuedBytes + event.data.length > QUEUE_BYTE_LIMIT) {
      // Everything after a dropped frame refers to it until the next keyframe. The description stays: it still applies.
      this.dropFrames()
      if (!event.keyframe) {
        this.skipping = true
        this.requestKeyframe()
        return
      }
    }
    this.queuedFrames++
    this.push({ event, bytes: event.data.length })
  }

  /**
   * At most one unread description. A newer one makes everything queued before it stale, and the helper sends one only
   * before a keyframe, so what follows does not refer to what is dropped; anything else is skipped until a keyframe.
   */
  private enqueueDescription(description: SimulatorStreamDescription, bytes: number): void {
    if (this.queuedFrames < this.queue.length) {
      this.clearQueue()
      this.skipping = true
    }
    this.push({ event: { type: 'description', description }, bytes })
  }

  /** One keyframe request at a time, however often the queue overflows. */
  private requestKeyframe(): void {
    if (this.keyframeInFlight) return
    this.keyframeInFlight = true
    void this.keyframe()
      .catch(() => {})
      .finally(() => (this.keyframeInFlight = false))
  }

  private dropFrames(): void {
    for (let index = this.queue.length - 1; index >= 0; index--) {
      const queued = this.queue[index]
      if (queued.event.type !== 'frame') continue
      this.queuedBytes -= queued.bytes
      this.queuedFrames--
      this.queue.splice(index, 1)
    }
  }

  private clearQueue(): void {
    this.queue.length = 0
    this.queuedFrames = 0
    this.queuedBytes = 0
  }

  private push(queued: Queued): void {
    this.queue.push(queued)
    this.queuedBytes += queued.bytes
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.()
  }

  private broken(message = '模拟器组件发来了无法识别的数据'): void {
    this.fail(helperFailed(message))
    this.child.kill('SIGKILL')
  }

  private fail(error: AppError): void {
    if (this.failure) return
    this.failure = error
    this.streaming = false
    this.ready?.reject(error)
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer)
      waiting.reject(error)
      this.pending.delete(id)
    }
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.()
  }
}
