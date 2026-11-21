// latch-simulator's framing and the Host's wrapper, against an in-process stand-in; the real helper runs only its
// self-tests, which touch no device. The real picture check (a `latch-` simulator) is manual.
import { execFile, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, statSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { PassThrough } from 'node:stream'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONTROL_LIMIT,
  FRAME_LIMIT,
  FROM_SIMULATOR,
  SimulatorFrameReader,
  SimulatorHelper,
  TO_SIMULATOR,
  encodeSimulatorRequest,
  parseSelfTest,
  type SimulatorHelperProcess,
  type SimulatorStreamEvent,
} from '../src/simulator-helper.ts'

const UDID = '6D0189B5-3108-4267-8BB6-2487D653864E'
const unavailable = { available: false, reason: 'not-built' }
const CAPABILITIES = {
  protocol: 1,
  version: '1.0.0',
  frames: { available: true },
  codecs: { h264: true, jpeg: true },
  input: { touch: unavailable, keyboard: unavailable, buttons: unavailable, orientation: unavailable },
}
const DESCRIPTION = {
  codec: 'h264',
  codecString: 'avc1.4d001f',
  config: 'AU0AH/8=',
  width: 588,
  height: 1280,
  sourceWidth: 1206,
  sourceHeight: 2622,
  scale: 3,
  orientation: 1,
}

function message(type: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(5)
  head.writeUInt8(type, 0)
  head.writeUInt32BE(payload.length, 1)
  return Buffer.concat([head, payload])
}
function header(type: number, length: number): Buffer {
  const bytes = Buffer.alloc(5)
  bytes.writeUInt8(type, 0)
  bytes.writeUInt32BE(length, 1)
  return bytes
}
const control = (type: number, value: unknown) => message(type, Buffer.from(JSON.stringify(value)))
function frame(keyframe: boolean, timestamp: number, data: Buffer = Buffer.from('picture')): Buffer {
  const fields = Buffer.alloc(9)
  fields.writeUInt8(keyframe ? 1 : 0, 0)
  fields.writeBigUInt64BE(BigInt(timestamp), 1)
  return message(FROM_SIMULATOR.frame, Buffer.concat([fields, data]))
}

/** Stands in for the binary: records requests, answers through `reply`, and exits when told or when stdin ends. */
class FakeHelper extends EventEmitter implements SimulatorHelperProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly requests: Array<{ type: number; body: Record<string, unknown> }> = []
  readonly signals: string[] = []
  args: readonly string[] = []
  /** What makes the stand-in exit: the end of stdin and either signal, unless a test narrows it. */
  exitsOn = new Set(['end', 'SIGTERM', 'SIGKILL'])
  onRequest: (type: number, body: Record<string, unknown>) => void = (_type, body) => this.result(body.id as number)

  constructor() {
    super()
    let pending = Buffer.alloc(0)
    this.stdin.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 5 && pending.length >= 5 + pending.readUInt32BE(1)) {
        const length = pending.readUInt32BE(1)
        const type = pending.readUInt8(0)
        const body = JSON.parse(pending.subarray(5, 5 + length).toString()) as Record<string, unknown>
        pending = pending.subarray(5 + length)
        this.requests.push({ type, body })
        this.onRequest(type, body)
      }
    })
    this.stdin.on('end', () => {
      if (this.exitsOn.has('end')) this.exit(0)
    })
  }

  send(bytes: Buffer): void {
    this.stdout.write(bytes)
  }

  result(id: number, error?: string): void {
    this.send(control(FROM_SIMULATOR.result, error ? { id, ok: false, error } : { id, ok: true }))
  }

  private exited = false

  exit(code: number | null, signal: string | null = null): void {
    if (this.exited) return
    this.exited = true
    this.stdout.end()
    setImmediate(() => this.emit('close', code, signal))
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal)
    if (this.exitsOn.has(signal)) this.exit(null, signal)
    return true
  }
}

const helpers: SimulatorHelper[] = []
afterEach(async () => {
  await Promise.all(helpers.splice(0).map(helper => helper.close()))
})

async function attached(fake = new FakeHelper(), options: { timeoutMs?: number; queueLimit?: number } = {}) {
  const started = SimulatorHelper.attach(UDID, {
    spawn: (_binary, args) => {
      fake.args = args
      return fake
    },
    ...options,
  })
  fake.send(control(FROM_SIMULATOR.capabilities, CAPABILITIES))
  const helper = await started
  helpers.push(helper)
  return { helper, fake }
}

const requestBytes = (type: number, body: unknown) => message(type, Buffer.from(JSON.stringify(body)))
const accepted = (id: number) => ({ id, ok: true })
const refusal = (id: number, error: string) => ({ id, ok: false, error })
const settle = () => new Promise(resolve => setImmediate(resolve))

async function next(iterator: AsyncIterator<SimulatorStreamEvent>): Promise<SimulatorStreamEvent> {
  const step = await iterator.next()
  if (step.done) throw new Error('stream ended')
  return step.value
}

describe('the frame reader', () => {
  it('splits messages across any chunk boundary', () => {
    const bytes = Buffer.concat([control(FROM_SIMULATOR.result, { id: 1, ok: true }), frame(true, 42, Buffer.from('abc'))])
    for (let cut = 0; cut <= bytes.length; cut++) {
      const reader = new SimulatorFrameReader()
      const messages = [...reader.push(bytes.subarray(0, cut)), ...reader.push(bytes.subarray(cut))]
      expect(messages.map(item => item.type)).toEqual([FROM_SIMULATOR.result, FROM_SIMULATOR.frame])
      expect(messages[1]!.payload.subarray(9).toString()).toBe('abc')
      expect(reader.buffered).toBe(0)
    }
  })

  it('refuses an unknown type, an oversized control message, an oversized or truncated frame header', () => {
    // Refused from the header alone, before any of the claimed bytes are buffered.
    expect(() => new SimulatorFrameReader().push(header(0x42, 2))).toThrow(RangeError)
    expect(() => new SimulatorFrameReader().push(header(TO_SIMULATOR.start, 2))).toThrow(RangeError)
    expect(() => new SimulatorFrameReader().push(header(FROM_SIMULATOR.result, CONTROL_LIMIT + 1))).toThrow(RangeError)
    expect(() => new SimulatorFrameReader().push(header(FROM_SIMULATOR.frame, FRAME_LIMIT + 1))).toThrow(RangeError)
    expect(() => new SimulatorFrameReader().push(header(FROM_SIMULATOR.frame, 8))).toThrow(RangeError)
    expect(() => new SimulatorFrameReader().push(header(FROM_SIMULATOR.frame, 0xffffffff))).toThrow(RangeError)
    expect(new SimulatorFrameReader().push(header(FROM_SIMULATOR.result, CONTROL_LIMIT))).toEqual([])
  })

  it('encodes requests within the bound and only request types', () => {
    expect([...encodeSimulatorRequest(TO_SIMULATOR.ping, { id: 3 })]).toEqual([4, 0, 0, 0, 8, ...Buffer.from('{"id":3}')])
    expect(() => encodeSimulatorRequest(0x81, { id: 1 })).toThrow(RangeError)
    expect(() => encodeSimulatorRequest(TO_SIMULATOR.ping, { id: 1, pad: 'x'.repeat(CONTROL_LIMIT) })).toThrow(RangeError)
  })
})

describe('the wrapper', () => {
  it('starts the helper with a fixed argv for a validated UDID only', async () => {
    let spawned = 0
    const launch = () => {
      spawned++
      return new FakeHelper()
    }
    for (const udid of ['booted', '6d0189b5-3108-4267-8bb6-2487d653864e', `${UDID} `, '--self-test', `${UDID}\n`])
      await expect(SimulatorHelper.attach(udid, { spawn: launch })).rejects.toMatchObject({ code: 'INVALID_SIMULATOR' })
    expect(spawned).toBe(0)
    const { fake, helper } = await attached()
    expect(fake.args).toEqual(['--udid', UDID])
    expect(helper.capabilities?.frames).toEqual({ available: true })
  })

  it('streams descriptions and frames, sends stop when the reader leaves, and asks for keyframes', async () => {
    const { helper, fake } = await attached()
    fake.onRequest = (type, body) => {
      fake.result(body.id as number)
      if (type === TO_SIMULATOR.start)
        fake.send(Buffer.concat([control(FROM_SIMULATOR.description, DESCRIPTION), frame(true, 0), frame(false, 33_000)]))
    }
    const stream = helper.frames({ codec: 'h264', maxFps: 30, maxDimension: 1280 })
    expect(await next(stream)).toEqual({ type: 'description', description: DESCRIPTION })
    expect(await next(stream)).toMatchObject({ type: 'frame', keyframe: true, timestamp: 0 })
    expect(await next(stream)).toMatchObject({ type: 'frame', keyframe: false, timestamp: 33_000 })
    await helper.keyframe()
    await stream.return(undefined)
    expect(fake.requests.map(request => request.type)).toEqual([TO_SIMULATOR.start, TO_SIMULATOR.keyframe, TO_SIMULATOR.stop])
    expect(fake.requests[0]!.body).toEqual({ id: 1, codec: 'h264', maxFps: 30, maxDimension: 1280 })
  })

  it('a slow reader loses frames, not memory, and resumes at a keyframe it asks for', async () => {
    const { helper, fake } = await attached(undefined, { queueLimit: 3 })
    fake.onRequest = (type, body) => {
      fake.result(body.id as number)
      if (type === TO_SIMULATOR.start)
        fake.send(Buffer.concat([frame(true, 0), ...Array.from({ length: 9 }, (_, index) => frame(false, index + 1))]))
      if (type === TO_SIMULATOR.keyframe) fake.send(Buffer.concat([frame(false, 98), frame(true, 99), frame(false, 100)]))
    }
    const stream = helper.frames({ codec: 'h264', maxFps: 30, maxDimension: 1280 })
    // The whole burst arrives before the reader takes anything: the fourth frame overflows the queue of three, every
    // queued frame goes, the rest of the chain is skipped, and the stream restarts at the keyframe it asked for.
    const events: Array<{ keyframe: boolean; timestamp: number }> = []
    for (let index = 0; index < 2; index++) {
      const event = await next(stream)
      if (event.type === 'frame') events.push({ keyframe: event.keyframe, timestamp: event.timestamp })
    }
    expect(events).toEqual([
      { keyframe: true, timestamp: 99 },
      { keyframe: false, timestamp: 100 },
    ])
    expect(fake.requests.filter(request => request.type === TO_SIMULATOR.keyframe)).toHaveLength(1)
    await stream.return(undefined)
  })

  it('a stalled reader keeps one description and a bounded queue, however many the helper sends', async () => {
    const { helper, fake } = await attached()
    fake.onRequest = (type, body) => {
      fake.result(body.id as number)
      // An honest helper: a description before every keyframe, and a keyframe whenever one is asked for.
      if (type === TO_SIMULATOR.start || type === TO_SIMULATOR.keyframe)
        fake.send(Buffer.concat([control(FROM_SIMULATOR.description, DESCRIPTION), frame(true, 0)]))
    }
    const stream = helper.frames({ codec: 'h264', maxFps: 30, maxDimension: 1280 })
    expect(await next(stream)).toMatchObject({ type: 'description' })
    const rounds = Array.from({ length: 500 }, (_, round) => [
      control(FROM_SIMULATOR.description, { ...DESCRIPTION, orientation: round % 4 }),
      frame(true, round * 100),
      frame(false, round * 100 + 1),
      frame(false, round * 100 + 2),
    ])
    fake.send(Buffer.concat(rounds.flat()))
    await settle()
    expect(helper.backlog.descriptions).toBeLessThanOrEqual(1)
    expect(helper.backlog.frames).toBeLessThanOrEqual(8)
    expect(helper.backlog.bytes).toBeLessThan(64 * 1024)
    expect(helper.backlog.pending).toBeLessThanOrEqual(1)
    // The reader picks up at the newest description and the keyframe after it.
    expect(await next(stream)).toMatchObject({ type: 'description', description: { orientation: 499 % 4 } })
    expect(await next(stream)).toMatchObject({ type: 'frame', keyframe: true, timestamp: 49_900 })
    await stream.return(undefined)
  })

  it('a lying helper cannot grow the queue or start a keyframe storm', async () => {
    const { helper, fake } = await attached()
    // Never answers a keyframe request. Keyframes every third frame, so overflows land on frames that need one.
    fake.onRequest = (type, body) => {
      if (type !== TO_SIMULATOR.keyframe) fake.result(body.id as number)
    }
    const stream = helper.frames({ codec: 'h264', maxFps: 30, maxDimension: 1280 })
    const first = next(stream)
    await settle()
    const tiny = Buffer.from('x')
    fake.send(Buffer.concat(Array.from({ length: 10_000 }, (_, index) => frame(index % 3 === 0, index, tiny))))
    fake.send(Buffer.concat(Array.from({ length: 2000 }, () => control(FROM_SIMULATOR.description, DESCRIPTION))))
    await settle()
    await first
    expect(helper.backlog.frames).toBeLessThanOrEqual(8)
    expect(helper.backlog.descriptions).toBeLessThanOrEqual(1)
    expect(helper.backlog.pending).toBeLessThanOrEqual(1)
    expect(fake.requests.filter(request => request.type === TO_SIMULATOR.keyframe)).toHaveLength(1)
    await stream.return(undefined)
  })

  it('stops a helper that leaves too many requests unanswered', async () => {
    const { helper, fake } = await attached()
    fake.onRequest = () => {}
    const pings = Array.from({ length: 40 }, () => helper.ping())
    for (const ping of pings) await expect(ping).rejects.toMatchObject({ code: 'SIMULATOR_HELPER_FAILED' })
    expect(fake.requests.length).toBeLessThanOrEqual(33)
    expect(fake.signals).toContain('SIGKILL')
  })

  it('takes a long unsupported reason and an orientation it does not know as data, not as a broken helper', async () => {
    const fake = new FakeHelper()
    const attaching = SimulatorHelper.attach(UDID, { spawn: () => fake })
    const reason = `changed-method:SimScreen.${'registerScreenCallbacks'.repeat(5)}`.slice(0, 128)
    fake.send(control(FROM_SIMULATOR.capabilities, { ...CAPABILITIES, frames: { available: false, reason } }))
    const unsupported = await attaching
    helpers.push(unsupported)
    expect(unsupported.capabilities?.frames).toEqual({ available: false, reason })

    const { helper, fake: device } = await attached()
    device.onRequest = (type, body) => {
      device.result(body.id as number)
      if (type === TO_SIMULATOR.start) device.send(control(FROM_SIMULATOR.description, { ...DESCRIPTION, orientation: 99 }))
    }
    const stream = helper.frames({ codec: 'h264', maxFps: 30, maxDimension: 1280 })
    expect(await next(stream)).toMatchObject({ type: 'description', description: { orientation: 99 } })
    await stream.return(undefined)
  })

  it('a crash rejects pending requests and ends the stream with an error, without throwing elsewhere', async () => {
    const { helper, fake } = await attached()
    fake.onRequest = (type, body) => {
      if (type === TO_SIMULATOR.start) fake.result(body.id as number)
    }
    const stream = helper.frames({ codec: 'jpeg', maxFps: 5, maxDimension: 640 })
    const reading = stream.next()
    await new Promise(resolve => setImmediate(resolve))
    const ping = helper.ping()
    fake.exit(null, 'SIGSEGV')
    await expect(ping).rejects.toMatchObject({ code: 'SIMULATOR_HELPER_FAILED' })
    await expect(reading).rejects.toMatchObject({ code: 'SIMULATOR_HELPER_FAILED' })
    await expect(helper.keyframe()).rejects.toMatchObject({ code: 'SIMULATOR_HELPER_FAILED' })
  })

  it('stops a helper that sends malformed, unexpected or oversized data', async () => {
    const cases: Buffer[] = [
      Buffer.from([0x99, 0, 0, 0, 0]),
      control(FROM_SIMULATOR.result, { id: 1, ok: true, extra: 1 }),
      control(FROM_SIMULATOR.capabilities, CAPABILITIES),
      message(FROM_SIMULATOR.result, Buffer.from('not json')),
      control(FROM_SIMULATOR.description, { ...DESCRIPTION, width: 0 }),
      control(FROM_SIMULATOR.gone, { reason: 'elsewhere' }),
      Buffer.from([FROM_SIMULATOR.frame, 0x01, 0, 0, 0]),
    ]
    for (const bytes of cases) {
      const { helper, fake } = await attached()
      fake.onRequest = () => {}
      const ping = helper.ping()
      fake.send(bytes)
      await expect(ping).rejects.toMatchObject({ code: 'SIMULATOR_HELPER_FAILED' })
      expect(fake.signals).toContain('SIGKILL')
    }
  })

  it('refuses capabilities that claim input, and times out a helper that never answers', async () => {
    const claiming = new FakeHelper()
    const attaching = SimulatorHelper.attach(UDID, { spawn: () => claiming, timeoutMs: 1000 })
    claiming.send(control(FROM_SIMULATOR.capabilities, { ...CAPABILITIES, input: { ...CAPABILITIES.input, touch: { available: true } } }))
    await expect(attaching).rejects.toMatchObject({ code: 'SIMULATOR_HELPER_FAILED' })
    const silent = new FakeHelper()
    await expect(SimulatorHelper.attach(UDID, { spawn: () => silent, timeoutMs: 50 })).rejects.toMatchObject({
      code: 'SIMULATOR_HELPER_FAILED',
    })
    expect(silent.signals.length + (silent.stdin.writableEnded ? 1 : 0)).toBeGreaterThan(0)
  })

  it('reports unavailable frames without streaming, and ends the stream quietly when the device shuts down', async () => {
    const fake = new FakeHelper()
    const attaching = SimulatorHelper.attach(UDID, { spawn: () => fake })
    fake.send(control(FROM_SIMULATOR.capabilities, { ...CAPABILITIES, frames: { available: false, reason: 'no-xcode' } }))
    const unsupported = await attaching
    helpers.push(unsupported)
    expect(unsupported.capabilities?.frames).toEqual({ available: false, reason: 'no-xcode' })
    await expect(unsupported.frames({ codec: 'h264', maxFps: 30, maxDimension: 1280 }).next()).rejects.toMatchObject({
      code: 'SIMULATOR_FRAMES_UNAVAILABLE',
    })

    const { helper, fake: device } = await attached()
    const stream = helper.frames({ codec: 'h264', maxFps: 30, maxDimension: 1280 })
    const reading = stream.next()
    await new Promise(resolve => setImmediate(resolve))
    device.send(control(FROM_SIMULATOR.gone, { reason: 'shutdown' }))
    await expect(reading).resolves.toEqual({ done: true, value: undefined })
  })

  it('escalates close from stdin to SIGTERM to SIGKILL for a helper that does not exit', async () => {
    const { helper: polite, fake: termed } = await attached()
    termed.exitsOn = new Set(['SIGTERM', 'SIGKILL'])
    const { helper: stubborn, fake: killed } = await attached()
    killed.exitsOn = new Set(['SIGKILL'])
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const closing = [polite.close(), stubborn.close()]
      await vi.advanceTimersByTimeAsync(999)
      expect([termed.signals, killed.signals]).toEqual([[], []])
      await vi.advanceTimersByTimeAsync(1)
      await settle()
      expect(termed.signals).toEqual(['SIGTERM'])
      expect(killed.signals).toEqual(['SIGTERM'])
      await vi.advanceTimersByTimeAsync(2000)
      await Promise.all(closing)
      expect(termed.signals).toEqual(['SIGTERM'])
      expect(killed.signals).toEqual(['SIGTERM', 'SIGKILL'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps stderr bounded and closes by ending stdin', async () => {
    const { helper, fake } = await attached()
    fake.stderr.write('x'.repeat(100_000))
    await new Promise(resolve => setImmediate(resolve))
    expect(helper.diagnostics.length).toBe(4096)
    await helper.close()
    expect(fake.stdin.writableEnded).toBe(true)
  })
})

describe('the real helper', () => {
  const helper = resolvePath('dist/native/latch-simulator')
  const run = promisify(execFile)
  // The only automated runs of the real helper: self-tests that attach to no device.
  const real = it.skipIf(process.platform !== 'darwin' || !existsSync(helper))

  /** `--self-test protocol` on the given request bytes; collects its results and exit status. */
  async function probe(bytes: Buffer, options: { readOutput?: boolean } = {}) {
    const child = spawn(helper, ['--self-test', 'protocol'], { env: {}, cwd: '/', stdio: ['pipe', 'pipe', 'ignore'] })
    const reader = new SimulatorFrameReader()
    const results: unknown[] = []
    if (options.readOutput !== false)
      child.stdout.on('data', (chunk: Buffer) => {
        for (const item of reader.push(chunk)) results.push(JSON.parse(item.payload.toString()))
      })
    child.stdin.on('error', () => {})
    const closed = new Promise<number | null>(resolve => child.once('close', code => resolve(code)))
    child.stdin.end(bytes)
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    const code = await closed
    clearTimeout(timer)
    return { results, code }
  }
  const start = { codec: 'h264', maxFps: 30, maxDimension: 1280 }

  real('describes itself without touching any device', async () => {
    expect(
      statSync('native/macos/LatchSimulator.swift').mtimeMs < statSync(helper).mtimeMs,
      'dist/native/latch-simulator is older than native/macos/LatchSimulator.swift: run pnpm build first',
    ).toBe(true)
    const { stdout } = await run(helper, ['--self-test'], { env: {}, cwd: '/', timeout: 20_000 })
    const table = parseSelfTest(stdout)
    expect(table.protocol).toBe(1)
    expect(Object.values(table.input).every(entry => !entry.available)).toBe(true)
    expect((await run(helper, ['--version'], { env: {}, cwd: '/', timeout: 10_000 })).stdout).toMatch(
      /^latch-simulator \S+ \(protocol 1\)\n$/u,
    )
    const refused = [
      [],
      ['--udid'],
      ['--udid', 'booted'],
      ['--udid', UDID.toLowerCase()],
      ['--udid', UDID, 'extra'],
      ['--self-test', 'other'],
    ]
    for (const args of refused) await expect(run(helper, args, { env: {}, cwd: '/', timeout: 10_000 })).rejects.toMatchObject({ code: 64 })
  })

  real('reports a changed method as unsupported, within the reason the Host accepts', async () => {
    const usual = parseSelfTest((await run(helper, ['--self-test'], { env: {}, cwd: '/', timeout: 20_000 })).stdout)
    const changed = parseSelfTest((await run(helper, ['--self-test', 'changed-interface'], { env: {}, cwd: '/', timeout: 20_000 })).stdout)
    expect(changed.frames.available).toBe(false)
    if (!changed.frames.available) {
      expect(changed.frames.reason.length).toBeLessThanOrEqual(128)
      // Without Xcode the helper stops earlier, at the frameworks; with it, at the reshaped method.
      if (usual.frames.available) expect(changed.frames.reason).toMatch(/^changed-method:SimScreen\.registerScreenCallbacksWithUUID:/u)
    }
  })

  real('answers every request as the protocol says, and refuses input types', async () => {
    const { results, code } = await probe(
      Buffer.concat([
        requestBytes(TO_SIMULATOR.ping, { id: 1 }),
        requestBytes(TO_SIMULATOR.start, { id: 2, ...start }),
        requestBytes(TO_SIMULATOR.start, { id: 3, ...start, maxFps: 0 }),
        requestBytes(TO_SIMULATOR.start, { id: 4, ...start, maxFps: 61 }),
        requestBytes(TO_SIMULATOR.start, { id: 5, ...start, maxDimension: 159 }),
        requestBytes(TO_SIMULATOR.start, { id: 6, ...start, maxDimension: 4097 }),
        requestBytes(TO_SIMULATOR.start, { id: 7, ...start, codec: 'vp9' }),
        requestBytes(TO_SIMULATOR.start, { id: 8, ...start, extra: 1 }),
        requestBytes(TO_SIMULATOR.start, { id: 9, codec: 'jpeg', maxFps: 30 }),
        requestBytes(TO_SIMULATOR.start, { id: 10, ...start, maxFps: 30.5 }),
        requestBytes(TO_SIMULATOR.start, { id: 11, ...start, maxFps: true }),
        requestBytes(TO_SIMULATOR.stop, { id: 12, extra: 1 }),
        requestBytes(TO_SIMULATOR.keyframe, { id: 13 }),
        requestBytes(0x10, { id: 14, x: 1, y: 2 }),
        requestBytes(0x3f, { id: 15 }),
        requestBytes(0x40, { id: 16 }),
        requestBytes(0x05, { id: 17 }),
        requestBytes(0x81, { id: 18 }),
        requestBytes(TO_SIMULATOR.ping, { id: 0 }),
        requestBytes(TO_SIMULATOR.ping, { id: 2_147_483_648 }),
        requestBytes(TO_SIMULATOR.ping, { id: '19' }),
        message(TO_SIMULATOR.ping, Buffer.from('not json')),
        message(TO_SIMULATOR.ping, Buffer.alloc(0)),
      ]),
    )
    expect(results).toEqual([
      accepted(1),
      accepted(2),
      ...[3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(id => refusal(id, 'invalid-input')),
      accepted(13),
      refusal(14, 'unsupported'),
      refusal(15, 'unsupported'),
      refusal(16, 'unknown-type'),
      refusal(17, 'unknown-type'),
      refusal(18, 'unknown-type'),
      ...Array.from({ length: 5 }, () => refusal(0, 'invalid-input')),
    ])
    expect(code).toBe(0)
  })

  real('exits on an oversized request, after answering it with id 0', async () => {
    const { results, code } = await probe(
      Buffer.concat([requestBytes(TO_SIMULATOR.ping, { id: 1 }), header(TO_SIMULATOR.ping, CONTROL_LIMIT + 1)]),
    )
    expect(results).toEqual([
      { id: 1, ok: true },
      { id: 0, ok: false, error: 'protocol' },
    ])
    expect(code).toBe(2)
  })

  real('exits when the Host keeps writing requests without reading the results', async () => {
    const pings = Buffer.concat(Array.from({ length: 40_000 }, (_, index) => requestBytes(TO_SIMULATOR.ping, { id: index + 1 })))
    const { code } = await probe(pings, { readOutput: false })
    expect(code).toBe(3)
  })
})
