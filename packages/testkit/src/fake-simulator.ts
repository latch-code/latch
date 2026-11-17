// Stand-ins for the 设备 panel's live picture and input: a latch-simulator source that plays a recorded stream, and an
// idb_companion that listens on its private Unix socket (HTTP/2, gRPC framing), answers `describe` and records each
// `hid` event it decodes. For tests only; nothing here touches a simulator.
import { EventEmitter } from 'node:events'
import { readFileSync, rmSync } from 'node:fs'
import http2 from 'node:http2'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'

interface FakeDescription {
  codec: 'h264' | 'jpeg'
  codecString?: string
  config?: string
  width: number
  height: number
  sourceWidth: number
  sourceHeight: number
  scale: number
  orientation: number
}

const H264 = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/simulator-h264.json', import.meta.url)), 'utf8')) as {
  description: FakeDescription
  frames: Array<{ key: boolean; timestamp: number; data: string }>
}
const JPEG = readFileSync(fileURLToPath(new URL('../fixtures/simulator-frame.jpg', import.meta.url)))

type FakeEvent =
  | { type: 'description'; description: FakeDescription }
  | { type: 'frame'; keyframe: boolean; timestamp: number; data: Buffer }

export interface FakeLive {
  /** `SimulatorOptions.live`: one source per attach. */
  attach: (udid: string) => Promise<FakeLiveSource>
  attached: string[]
  /** Sources closed, and streams whose generator was returned. */
  closed: number
  returned: number
  keyframes: number
}

export interface FakeLiveSource {
  readonly capabilities: { frames: { available: true } | { available: false; reason: string } }
  frames(settings: { codec: 'h264' | 'jpeg'; maxFps: number; maxDimension: number }): AsyncGenerator<FakeEvent, void, undefined>
  keyframe(): Promise<void>
  close(): Promise<void>
}

/**
 * Plays a recorded H.264 stream of a `latch-` simulator (220×480, keyframe first) in a loop, or a recorded JPEG frame,
 * at the asked rate. `unsupported` answers like a helper on a changed Xcode.
 */
export function fakeSimulatorLive(options: { unsupported?: string; orientation?: number } = {}): FakeLive {
  const live: FakeLive = { attached: [], closed: 0, returned: 0, keyframes: 0, attach: async () => source() }
  const source = (): FakeLiveSource => {
    const state = { closed: false }
    let wake: (() => void) | undefined
    const capabilities = options.unsupported
      ? { frames: { available: false as const, reason: options.unsupported } }
      : { frames: { available: true as const } }
    return {
      capabilities,
      async *frames(settings) {
        let timestamp = 0
        try {
          const jpeg = settings.codec === 'jpeg'
          const description = (): FakeEvent => ({
            type: 'description',
            description: jpeg
              ? {
                  codec: 'jpeg' as const,
                  width: 366,
                  height: 800,
                  sourceWidth: 1206,
                  sourceHeight: 2622,
                  scale: 3,
                  orientation: options.orientation ?? 1,
                }
              : { ...H264.description, orientation: options.orientation ?? 1 },
          })
          for (let index = 0; !state.closed; index++) {
            const frame = jpeg ? undefined : H264.frames[index % H264.frames.length]!
            // As the real helper: the description again before each H.264 keyframe, unchanged.
            if (frame?.key || index === 0) yield description()
            timestamp += Math.round(1_000_000 / settings.maxFps)
            yield frame
              ? { type: 'frame', keyframe: frame.key, timestamp, data: Buffer.from(frame.data, 'base64') }
              : { type: 'frame', keyframe: true, timestamp, data: JPEG }
            await new Promise<void>(resolve => {
              wake = resolve
              setTimeout(resolve, 1000 / settings.maxFps)
            })
          }
        } finally {
          live.returned++
        }
      },
      async keyframe() {
        live.keyframes++
      },
      async close() {
        if (state.closed) return
        state.closed = true
        live.closed++
        wake?.()
      },
    }
  }
  const attach = live.attach
  live.attach = async udid => {
    live.attached.push(udid)
    return attach(udid)
  }
  return live
}

export type FakeHidEvent =
  | { kind: 'touch'; x: number; y: number; direction: 'down' | 'up' }
  | { kind: 'button'; button: number; direction: 'down' | 'up' }
  | { kind: 'key'; code: number; direction: 'down' | 'up' }

export interface FakeIdb {
  /** `IdbOptions.locate` and `.spawn`. */
  locate: () => Promise<string | undefined>
  spawn: (
    binary: string,
    args: readonly string[],
    options: { cwd: string; env: Record<string, string> },
  ) => EventEmitter & {
    stdout: PassThrough
    kill(signal?: string): boolean
  }
  /** Each start's argument list, working directory and environment. */
  starts: Array<{ binary: string; args: readonly string[]; cwd: string; env: Record<string, string> }>
  /** Every hid event delivered, in order, with the device of the companion that took it. */
  events: Array<FakeHidEvent & { udid: string }>
  signals: string[]
  /** Companions running now. */
  running(): number
  /** HID streams that the receiving socket has not closed yet. */
  openHid(): number
  /** Ends every running companion as if it crashed. */
  crash(): void
}

/** Reads one protobuf message's fields: enough for idb's HIDEvent. */
function fields(data: Buffer): Map<number, Array<Buffer | number>> {
  const out = new Map<number, Array<Buffer | number>>()
  let at = 0
  const read = () => {
    let value = 0
    let scale = 1
    for (;;) {
      const byte = data[at++]!
      value += (byte & 0x7f) * scale
      if ((byte & 0x80) === 0) return value
      scale *= 128
    }
  }
  while (at < data.length) {
    const key = read()
    const field = Math.floor(key / 8)
    const type = key & 7
    let value: Buffer | number
    if (type === 0) value = read()
    else if (type === 1) {
      value = data.subarray(at, at + 8)
      at += 8
    } else if (type === 2) {
      const size = read()
      value = data.subarray(at, at + size)
      at += size
    } else throw new Error(`wire type ${type}`)
    out.set(field, [...(out.get(field) ?? []), value])
  }
  return out
}

function decodeHid(message: Buffer): FakeHidEvent {
  const press = fields(fields(message).get(1)![0] as Buffer)
  const action = fields(press.get(1)![0] as Buffer)
  const direction = press.get(2)?.[0] === 1 ? 'up' : 'down'
  if (action.has(1)) {
    const point = fields(fields(action.get(1)![0] as Buffer).get(1)![0] as Buffer)
    const double = (field: number) => (point.get(field)?.[0] as Buffer | undefined)?.readDoubleLE(0) ?? 0
    return { kind: 'touch', x: double(1), y: double(2), direction }
  }
  if (action.has(2)) return { kind: 'button', button: (fields(action.get(2)![0] as Buffer).get(1)?.[0] as number) ?? 0, direction }
  return { kind: 'key', code: (fields(action.get(3)![0] as Buffer).get(1)?.[0] as number) ?? 0, direction }
}

function grpc(payload: Buffer): Buffer {
  const head = Buffer.alloc(5)
  head.writeUInt32BE(payload.length, 1)
  return Buffer.concat([head, payload])
}

function varintField(field: number, value: number): Buffer {
  const bytes = [field << 3]
  let rest = value
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80)
    rest >>>= 7
  }
  bytes.push(rest)
  return Buffer.from(bytes)
}

function messageField(field: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([(field << 3) | 2, body.length]), body])
}

/**
 * An idb_companion stand-in. `installed: false` is a Mac without it; `ready: false` one that never listens; `status` the
 * gRPC status every hid stream ends with (0 delivered); `hang` one that never answers the end of a hid stream; the
 * rest as their notes say.
 */
export function fakeIdbCompanion(
  options: {
    installed?: boolean
    ready?: boolean
    status?: number
    hang?: boolean
    /** Ends the first hid stream itself after its first event, as rotating the device does. */
    cut?: boolean
    /** Which TCP readiness field it reports instead of the socket. */
    tcp?: 'grpc_port' | 'grpc_swift_port'
    /** Chunks written to stdout before the socket readiness line. */
    startupOutput?: string[]
    /** Sends message after message down every hid stream, never ending. */
    flood?: boolean
    /** Never answers describe. */
    silent?: boolean
    /** Stops reading hid streams. */
    stall?: boolean
    screen?: { width: number; height: number }
  } = {},
): FakeIdb {
  const screen = options.screen ?? { width: 402, height: 874 }
  const children = new Set<() => void>()
  const openHid = new Set<http2.ServerHttp2Stream>()
  const fake: FakeIdb = {
    starts: [],
    events: [],
    signals: [],
    locate: async () => (options.installed === false ? undefined : '/opt/homebrew/bin/idb_companion'),
    running: () => children.size,
    openHid: () => openHid.size,
    crash: () => {
      for (const end of children) end()
    },
    spawn(binary, args, { cwd, env }) {
      fake.starts.push({ binary, args: [...args], cwd, env })
      const udid = args[args.indexOf('--udid') + 1] ?? ''
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        kill(signal = 'SIGTERM') {
          fake.signals.push(signal)
          end()
          return true
        },
      })
      const socket = join(cwd, args[args.indexOf('--grpc-domain-sock') + 1] ?? 'c.sock')
      const server = http2.createServer()
      const sessions = new Set<http2.ServerHttp2Session>()
      server.on('session', session => {
        sessions.add(session)
        session.on('close', () => sessions.delete(session))
      })
      server.on('stream', (stream, headers) => {
        const path = headers[':path']
        const chunks: Buffer[] = []
        if (path === '/idb.CompanionService/hid') {
          openHid.add(stream)
          stream.once('close', () => openHid.delete(stream))
        }
        if (path === '/idb.CompanionService/hid' && options.stall) {
          stream.pause()
          return
        }
        if (path === '/idb.CompanionService/describe' && options.silent) return
        if (path === '/idb.CompanionService/hid' && options.flood) {
          stream.respond({ ':status': 200, 'content-type': 'application/grpc' })
          const flood = setInterval(() => {
            if (stream.closed || stream.destroyed) clearInterval(flood)
            else stream.write(grpc(Buffer.alloc(1000, 1)))
          }, 1)
        }
        stream.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
          if (path !== '/idb.CompanionService/hid') return
          let buffer = Buffer.concat(chunks)
          while (buffer.length >= 5 && buffer.length >= 5 + buffer.readUInt32BE(1)) {
            fake.events.push({ ...decodeHid(buffer.subarray(5, 5 + buffer.readUInt32BE(1))), udid })
            buffer = buffer.subarray(5 + buffer.readUInt32BE(1))
            if (options.cut && !cutDone) {
              cutDone = true
              stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '13' }, { endStream: true })
              return
            }
          }
          chunks.length = 0
          if (buffer.length) chunks.push(buffer)
        })
        stream.on('end', () => {
          if (stream.closed || stream.headersSent || (options.hang && path === '/idb.CompanionService/hid')) return
          stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true })
          stream.on('wantTrailers', () =>
            stream.sendTrailers({ 'grpc-status': String(path === '/idb.CompanionService/hid' ? (options.status ?? 0) : 0) }),
          )
          if (path === '/idb.CompanionService/describe') {
            const dimensions = Buffer.concat([varintField(4, screen.width), varintField(5, screen.height)])
            stream.end(grpc(messageField(1, messageField(3, dimensions))))
          } else stream.end(grpc(Buffer.alloc(0)))
        })
        stream.on('error', () => undefined)
      })
      let ended = false
      let cutDone = false
      function end() {
        if (ended) return
        ended = true
        children.delete(end)
        for (const session of sessions) session.destroy()
        server.close()
        rmSync(socket, { force: true })
        setImmediate(() => child.emit('close', 0))
      }
      children.add(end)
      if (options.tcp) setImmediate(() => child.stdout.write(`{"${options.tcp}":10882}\n`))
      else if (options.ready !== false)
        server.listen(socket, () => {
          for (const chunk of options.startupOutput ?? []) child.stdout.write(chunk)
          child.stdout.write(`{"grpc_path":"${args[args.indexOf('--grpc-domain-sock') + 1]}"}\n`)
        })
      return child
    },
  }
  return fake
}
