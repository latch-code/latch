// Input to simulators through idb_companion: the hand-written messages against bytes the idb client itself sent to the
// real companion (fixtures/idb-companion.json), the companion's supervision and its private socket, and the shared
// path of the person's and an agent's input, against the test kit's stand-in companion. Nothing here runs idb.
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeIdbCompanion } from '@latch/testkit'
import { SimulatorControl } from '../src/simulator-control.ts'
import { IdbCompanion, locateIdbCompanion, removeStaleIdbDirs } from '../src/simulator-idb.ts'
import { GrpcReader, encodeHidEvent, grpcFrame, screenPoints } from '../src/simulator-idb-wire.ts'

const UDID = '02FFBCE5-9E76-4A5F-935D-69BBC2B2C7E6'
const fixture = JSON.parse(await readFile(new URL('./fixtures/idb-companion.json', import.meta.url), 'utf8')) as {
  tap: { x: number; y: number; messages: string[] }
  key: { code: number; messages: string[] }
  shiftA: { codes: number[]; messages: string[] }
  home: { messages: string[] }
  describe: string
}
const hex = (buffer: Buffer) => buffer.toString('hex')

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lt-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

describe('the hand-written messages', () => {
  it('are byte for byte what the idb client sends for a tap, a key, a shifted key and Home', () => {
    const { x, y } = fixture.tap
    expect([
      hex(grpcFrame(encodeHidEvent({ kind: 'touch', x, y, direction: 'down' }))),
      hex(grpcFrame(encodeHidEvent({ kind: 'touch', x, y, direction: 'up' }))),
    ]).toEqual(fixture.tap.messages)
    expect([
      hex(grpcFrame(encodeHidEvent({ kind: 'key', code: fixture.key.code, direction: 'down' }))),
      hex(grpcFrame(encodeHidEvent({ kind: 'key', code: fixture.key.code, direction: 'up' }))),
    ]).toEqual(fixture.key.messages)
    const [shift, a] = fixture.shiftA.codes as [number, number]
    expect(
      [
        { code: shift, direction: 'down' },
        { code: a, direction: 'down' },
        { code: a, direction: 'up' },
        { code: shift, direction: 'up' },
      ].map(({ code, direction }) => hex(grpcFrame(encodeHidEvent({ kind: 'key', code, direction: direction as 'down' | 'up' })))),
    ).toEqual(fixture.shiftA.messages)
    expect([
      hex(grpcFrame(encodeHidEvent({ kind: 'button', button: 'home', direction: 'down' }))),
      hex(grpcFrame(encodeHidEvent({ kind: 'button', button: 'home', direction: 'up' }))),
    ]).toEqual(fixture.home.messages)
    // A point at zero is left out, as proto3 does; a negative or endless one is refused.
    expect(hex(encodeHidEvent({ kind: 'touch', x: 0, y: 0, direction: 'down' }))).toBe('0a060a040a020a00')
    expect(() => encodeHidEvent({ kind: 'touch', x: Number.NaN, y: 1, direction: 'down' })).toThrow()
    expect(() => encodeHidEvent({ kind: 'key', code: -1, direction: 'down' })).toThrow()
  })

  it('read the screen in points from the companion’s own describe answer, and refuse compressed or oversize messages', () => {
    const [message] = new GrpcReader(256 * 1024).push(Buffer.from(fixture.describe, 'hex'))
    expect(screenPoints(message!)).toEqual({ width: 402, height: 874 })
    expect(screenPoints(Buffer.from([0xff, 0xff]))).toBeUndefined()
    expect(() => new GrpcReader(16).push(Buffer.from([1, 0, 0, 0, 1, 0]))).toThrow('Compressed')
    expect(() => new GrpcReader(16).push(Buffer.from([0, 0, 0, 1, 0]))).toThrow('too large')
    // Split anywhere, the same messages.
    const reader = new GrpcReader(1024)
    const whole = Buffer.from(fixture.tap.messages.join(''), 'hex')
    expect([...reader.push(whole.subarray(0, 7)), ...reader.push(whole.subarray(7))].map(hex)).toEqual(
      fixture.tap.messages.map(text => text.slice(10)),
    )
  })
})

describe('the companion', () => {
  it('runs on a private socket with a fixed argument list, never TCP, and takes nothing of the Host’s environment', async () => {
    const tempDir = await scratch()
    const fake = fakeIdbCompanion()
    process.env.FBSIMULATORCONTROL_LOG_HID_DETAILS = '1'
    cleanups.push(() => void delete process.env.FBSIMULATORCONTROL_LOG_HID_DETAILS)
    const companion = await IdbCompanion.start(UDID, { locate: fake.locate, spawn: fake.spawn, tempDir })
    const [start] = fake.starts
    expect(start!.args).toEqual([
      '--udid',
      UDID,
      '--grpc-domain-sock',
      'c.sock',
      '--only',
      'simulator',
      '--terminate-offline',
      'true',
      '--idle-shutdown-time',
      '120',
      '--log-level',
      'info',
      '--log-hid-details',
      'false',
    ])
    expect(start!.args).not.toContain('--grpc-port')
    expect(Object.keys(start!.env).sort()).toEqual(expect.arrayContaining(['PATH']))
    expect(Object.keys(start!.env).some(key => key.startsWith('FBSIMULATORCONTROL'))).toBe(false)
    expect(((await stat(start!.cwd)).mode & 0o777).toString(8)).toBe('700')
    expect(start!.cwd.startsWith(join(tempDir, 'latch-idb-'))).toBe(true)
    expect(await companion.describe()).toEqual({ width: 402, height: 874 })
    const hid = companion.hid()
    hid.write([
      { kind: 'touch', x: 10, y: 20, direction: 'down' },
      { kind: 'touch', x: 10, y: 20, direction: 'up' },
    ])
    await hid.end()
    expect(fake.events.map(({ kind, direction }) => `${kind}:${direction}`)).toEqual(['touch:down', 'touch:up'])
    await companion.close()
    expect(fake.signals).toEqual(['SIGTERM'])
    expect(fake.running()).toBe(0)
    expect(await readdir(tempDir)).toEqual([])
  })

  it('reports why it is unavailable, and leaves no directory behind', async () => {
    const tempDir = await scratch()
    await expect(IdbCompanion.start(UDID, { ...pick(fakeIdbCompanion({ installed: false })), tempDir })).rejects.toMatchObject({
      reason: 'idb-missing',
    })
    await expect(IdbCompanion.start(UDID, { ...pick(fakeIdbCompanion({ ready: false })), tempDir, readyMs: 100 })).rejects.toMatchObject({
      reason: 'companion-failed',
    })
    await expect(IdbCompanion.start('booted', { ...pick(fakeIdbCompanion()), tempDir })).rejects.toMatchObject({ status: 400 })
    // A directory whose socket path cannot fit a Unix socket's name.
    const deep = join(tempDir, 'x'.repeat(100))
    await mkdir(deep)
    await expect(IdbCompanion.start(UDID, { ...pick(fakeIdbCompanion()), tempDir: deep })).rejects.toMatchObject({ reason: 'socket-path' })
    expect(await readdir(deep)).toEqual([])
    expect((await readdir(tempDir)).filter(name => name.startsWith('latch-idb-'))).toEqual([])
  })

  it('a delivery the companion refuses is an error, never a success', async () => {
    const tempDir = await scratch()
    const companion = await IdbCompanion.start(UDID, { ...pick(fakeIdbCompanion({ status: 3 })), tempDir })
    cleanups.push(() => companion.close())
    const hid = companion.hid()
    hid.write([{ kind: 'key', code: 40, direction: 'down' }])
    await expect(hid.end()).rejects.toThrow('status 3')
  })

  it('is found only in Homebrew’s places, and only when it resolves into Homebrew’s Cellar', async () => {
    const dir = await scratch()
    const cellar = join(dir, 'Cellar')
    await mkdir(join(cellar, 'idb-companion', '1.7.8', 'bin'), { recursive: true })
    await mkdir(join(dir, 'bin'))
    const real = join(cellar, 'idb-companion', '1.7.8', 'bin', 'idb_companion')
    await writeFile(real, '', { mode: 0o755 })
    await symlink(real, join(dir, 'bin', 'idb_companion'))
    expect(await locateIdbCompanion([{ link: join(dir, 'bin', 'idb_companion'), cellar }])).toBe(await realpath(real))
    // Somewhere else, even executable and named the same (a project's node_modules/.bin): never.
    const elsewhere = join(dir, 'node_modules', '.bin')
    await mkdir(elsewhere, { recursive: true })
    await writeFile(join(elsewhere, 'idb_companion'), '', { mode: 0o755 })
    expect(await locateIdbCompanion([{ link: join(elsewhere, 'idb_companion'), cellar }])).toBeUndefined()
    await rm(join(dir, 'bin', 'idb_companion'))
    await symlink(join(elsewhere, 'idb_companion'), join(dir, 'bin', 'idb_companion'))
    expect(await locateIdbCompanion([{ link: join(dir, 'bin', 'idb_companion'), cellar }])).toBeUndefined()
    expect(await locateIdbCompanion([{ link: join(dir, 'missing'), cellar }])).toBeUndefined()
  })

  it('kills a companion that says it listens on a TCP port, at once', async () => {
    const tempDir = await scratch()
    const fake = fakeIdbCompanion({ tcp: true })
    await expect(IdbCompanion.start(UDID, { ...pick(fake), tempDir })).rejects.toMatchObject({ reason: 'companion-failed' })
    expect(fake.signals[0]).toBe('SIGKILL')
    expect(await readdir(tempDir)).toEqual([])
  })

  it('bounds what the companion may answer: a flood ends the stream, a silent describe is no answer', async () => {
    const tempDir = await scratch()
    const flood = await IdbCompanion.start(UDID, { ...pick(fakeIdbCompanion({ flood: true })), tempDir })
    cleanups.push(() => flood.close())
    const hid = flood.hid()
    hid.write([{ kind: 'key', code: 40, direction: 'down' }])
    await waitUntil(() => !hid.open)
    expect(() => hid.write([{ kind: 'key', code: 40, direction: 'up' }])).toThrow()
    await expect(hid.end()).rejects.toThrow()
    const silent = await IdbCompanion.start(UDID, { ...pick(fakeIdbCompanion({ silent: true })), tempDir })
    cleanups.push(() => silent.close())
    await expect(silent.describe(100)).rejects.toMatchObject({ reason: 'no-answer' })
  })

  it('leaves another Host’s live socket, and removes only stale private directories of this user', async () => {
    const dir = await scratch()
    await mkdir(join(dir, 'latch-idb-AAAAAA'))
    await mkdir(join(dir, 'latch-idb-BBBBBB'))
    await mkdir(join(dir, 'latch-idb-toolong1'))
    await mkdir(join(dir, 'other'))
    await symlink(join(dir, 'other'), join(dir, 'latch-idb-CCCCCC'))
    const server = createServer()
    await new Promise<void>(resolve => server.listen(join(dir, 'latch-idb-BBBBBB', 'c.sock'), resolve))
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
    expect(await removeStaleIdbDirs(dir)).toEqual(['latch-idb-AAAAAA'])
    expect((await readdir(dir)).sort()).toEqual(['latch-idb-BBBBBB', 'latch-idb-CCCCCC', 'latch-idb-toolong1', 'other'])
  })
})

function pick(fake: ReturnType<typeof fakeIdbCompanion>) {
  return { locate: fake.locate, spawn: fake.spawn }
}

describe('one input path for the person and agents', () => {
  async function control(options: Parameters<typeof fakeIdbCompanion>[0] = {}) {
    const tempDir = await scratch()
    const fake = fakeIdbCompanion(options)
    let now = 1_000_000
    const service = new SimulatorControl({ idb: { ...pick(fake), tempDir }, now: () => now })
    cleanups.push(() => service.stop())
    return { service, fake, tempDir, advance: (ms: number) => (now += ms) }
  }

  it('starts the companion when the person takes control and probes it, and says text and two fingers are unavailable', async () => {
    const { service, fake } = await control()
    expect(service.holds(UDID, 'desk')).toBe(false)
    expect(await service.take(UDID, 'desk')).toEqual({
      touch: { available: true },
      keys: { available: true },
      buttons: { available: true },
      text: { available: false, reason: 'unsupported' },
      twoFingers: { available: false, reason: 'single-touch' },
    })
    expect(service.holds(UDID, 'desk')).toBe(true)
    await service.input(UDID, 'desk', [
      { type: 'touch', phase: 'down', x: 100, y: 200 },
      { type: 'touch', phase: 'move', x: 110, y: 210 },
      { type: 'touch', phase: 'up', x: 110, y: 210 },
      { type: 'key', key: 'return' },
      { type: 'button', button: 'home' },
    ])
    await waitUntil(() => fake.events.length === 7)
    expect(
      fake.events.map(event => ('x' in event ? `${event.direction}@${event.x},${event.y}` : `${event.kind}:${event.direction}`)),
    ).toEqual(['down@100,200', 'down@110,210', 'up@110,210', 'key:down', 'key:up', 'button:down', 'button:up'])
    expect(fake.starts).toHaveLength(1)
  })

  it('is unavailable, with the reason, when idb is not installed; input then fails instead of succeeding', async () => {
    const { service } = await control({ installed: false })
    expect((await service.take(UDID, 'desk')).touch).toEqual({ available: false, reason: 'idb-missing' })
    await expect(service.input(UDID, 'desk', [{ type: 'key', key: 'return' }])).rejects.toMatchObject({ status: 409 })
    await expect(service.tap(UDID, 10, 10)).rejects.toMatchObject({ code: 'simulator-input-unavailable' })
    expect(new SimulatorControl().viewOf(UDID).touch).toEqual({ available: false, reason: 'unsupported' })
  })

  it('refuses input before control, points off the screen, and more than the rate allows', async () => {
    const { service, fake } = await control()
    await expect(service.input(UDID, 'desk', [{ type: 'key', key: 'return' }])).rejects.toMatchObject({
      code: 'simulator-control-required',
    })
    await service.take(UDID, 'desk')
    await expect(service.input(UDID, 'desk', [{ type: 'touch', phase: 'down', x: 403, y: 875 }])).rejects.toMatchObject({ status: 400 })
    // Turned sideways, the screen is wider than tall.
    await service.input(UDID, 'desk', [
      { type: 'touch', phase: 'down', x: 870, y: 400 },
      { type: 'touch', phase: 'up', x: 870, y: 400 },
    ])
    let refused = 0
    for (let index = 0; index < 20 && refused === 0; index++)
      await service
        .input(
          UDID,
          'desk',
          Array.from({ length: 64 }, () => ({ type: 'touch' as const, phase: 'move' as const, x: 1, y: 1 })),
        )
        .catch(error => {
          refused++
          expect(error).toMatchObject({ status: 429 })
        })
    expect(refused).toBe(1)
    expect(fake.events.some(event => 'x' in event && event.x === 403)).toBe(false)
  })

  it('fails the person’s input once the companion stops reading and 64 KiB wait unread', async () => {
    const { service, advance } = await control({ stall: true })
    await service.take(UDID, 'desk')
    let failure: unknown
    await service.input(UDID, 'desk', [{ type: 'touch', phase: 'down', x: 1, y: 1 }])
    // Past HTTP/2's own 64 KiB window, then 64 KiB more waiting unread.
    for (let round = 0; round < 400 && !failure; round++)
      await service
        .input(
          UDID,
          'desk',
          Array.from({ length: 64 }, (_, index) => ({ type: 'touch' as const, phase: 'move' as const, x: 1 + (index % 50), y: 1 + round })),
        )
        .catch((error: unknown) => (failure = error))
        .finally(() => advance(1000))
    expect(failure).toMatchObject({ code: 'simulator-input-failed' })
  })

  it('types printable ASCII only on the English (US) keyboard, and refuses anything else whole', async () => {
    const tempDir = await scratch()
    const fake = fakeIdbCompanion()
    let keyboard: string | undefined = 'en_US@sw=QWERTY;hw=Automatic'
    const service = new SimulatorControl({ idb: { ...pick(fake), tempDir }, keyboard: async () => keyboard })
    cleanups.push(() => service.stop())
    expect((await service.take(UDID, 'desk')).text).toEqual({ available: true })
    await service.typeText(UDID, 'Hi 1!')
    const codes = () =>
      fake.events
        .filter(event => event.kind === 'key')
        .map(event => `${(event as { code: number }).code}${event.direction === 'down' ? '+' : '-'}`)
    // H is Shift+h; space is 44; ! is Shift+1.
    expect(codes()).toEqual(['225+', '11+', '11-', '225-', '12+', '12-', '44+', '44-', '30+', '30-', '225+', '30+', '30-', '225-'])
    const before = fake.events.length
    await expect(service.typeText(UDID, 'hi 你好')).rejects.toMatchObject({ code: 'simulator-text-unsupported' })
    keyboard = 'zh_Hans-Pinyin@sw=Pinyin-Simplified;hw=Automatic'
    await expect(service.typeText(UDID, 'hello')).rejects.toMatchObject({
      code: 'simulator-text-unavailable',
      message: expect.stringContaining('zh_Hans-Pinyin'),
    })
    keyboard = 'fr_FR@sw=AZERTY;hw=Automatic'
    await expect(service.typeText(UDID, 'a')).rejects.toMatchObject({ code: 'simulator-text-unavailable' })
    keyboard = undefined
    await expect(service.typeText(UDID, 'a')).rejects.toMatchObject({ code: 'simulator-text-unavailable' })
    // The person's text, the same way; nothing at all was typed for the refusals.
    await expect(service.input(UDID, 'desk', [{ type: 'text', text: 'x' }])).rejects.toMatchObject({ code: 'simulator-text-unavailable' })
    expect(fake.events.length).toBe(before)
    keyboard = 'en_US@sw=QWERTY'
    await new Promise(resolve => setTimeout(resolve, 1_100))
    await service.input(UDID, 'desk', [{ type: 'text', text: 'ok' }])
    await waitUntil(() => fake.events.length === before + 4)
    expect(new SimulatorControl({ idb: pick(fake) }).viewOf(UDID).text.available).toBe(false)
  })

  it('lets the person win: their press stops an agent’s long press and goes ahead of every agent waiting', async () => {
    const { service, fake } = await control()
    await service.take(UDID, 'desk')
    const started = Date.now()
    const agents = [1, 2, 3].map(index =>
      service.tap(UDID, index * 10, index * 10, 5000).then(
        () => 'done',
        error => error.code,
      ),
    )
    await waitUntil(() => fake.events.some(event => event.kind === 'touch' && event.direction === 'down'))
    await service.input(UDID, 'desk', [{ type: 'touch', phase: 'down', x: 200, y: 200 }])
    await service.input(UDID, 'desk', [{ type: 'touch', phase: 'up', x: 200, y: 200 }])
    await waitUntil(() => fake.events.some(event => 'x' in event && event.x === 200 && event.direction === 'up'))
    // Within one gesture's time, not after three five-second presses.
    expect(Date.now() - started).toBeLessThan(2000)
    const firstAgentDown = fake.events.findIndex(event => event.kind === 'touch' && event.direction === 'down')
    const personDown = fake.events.findIndex(event => 'x' in event && event.x === 200 && event.direction === 'down')
    expect(personDown).toBeGreaterThan(firstAgentDown)
    // The agent that was pressing answers that its input did not go through.
    const outcomes = await Promise.all(agents)
    expect(outcomes).toContain('simulator-input-failed')
  }, 30_000)

  it('stops an agent’s gesture when its turn is cancelled', async () => {
    const { service } = await control()
    const stop = new AbortController()
    const tap = service.tap(UDID, 10, 10, 5000, stop.signal)
    await new Promise(resolve => setTimeout(resolve, 200))
    const started = Date.now()
    stop.abort()
    await expect(tap).rejects.toMatchObject({ code: 'cancelled' })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('serialises gestures: an agent’s tap waits for the person’s finger to lift, and nobody is locked out', async () => {
    const { service, fake } = await control()
    await service.take(UDID, 'desk')
    await service.input(UDID, 'desk', [{ type: 'touch', phase: 'down', x: 50, y: 50 }])
    let tapped = false
    const tap = service.tap(UDID, 300, 300).then(() => (tapped = true))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(tapped).toBe(false)
    await service.input(UDID, 'desk', [{ type: 'touch', phase: 'up', x: 60, y: 60 }])
    await tap
    expect(fake.events.map(event => ('x' in event ? `${event.direction}@${event.x}` : event.kind))).toEqual([
      'down@50',
      'up@60',
      'down@300',
      'up@300',
    ])
  })

  it('answers an agent only once the companion confirmed delivery, and an error when it did not', async () => {
    const good = await control()
    await good.service.swipe(UDID, { x: 100, y: 600 }, { x: 100, y: 300 }, 100)
    const touches = good.fake.events.filter(event => event.kind === 'touch')
    expect(touches.at(0)).toMatchObject({ direction: 'down', x: 100, y: 600 })
    expect(touches.at(-1)).toMatchObject({ direction: 'up', x: 100, y: 300 })
    expect(touches.length).toBeGreaterThan(4)
    await good.service.key(UDID, 'delete')
    await good.service.button(UDID, 'lock')
    const silent = await control({ hang: true })
    await expect(silent.service.key(UDID, 'return')).rejects.toMatchObject({ code: 'simulator-input-failed' })
    // The device is not left held: the next call is not kept waiting behind it.
    await expect(silent.service.key(UDID, 'return')).rejects.toMatchObject({ code: 'simulator-input-failed' })
    const bad = await control({ status: 13 })
    await expect(bad.service.tap(UDID, 1, 1)).rejects.toMatchObject({ code: 'simulator-input-failed' })
    await expect(bad.service.tap(UDID, 9_999, 1)).rejects.toMatchObject({ status: 400 })
  }, 30_000)

  it('never ends a companion that is still starting for someone', async () => {
    const { service, advance } = await control()
    const taking = service.take(UDID, 'desk')
    advance(61_000)
    await service.sweep()
    expect((await taking).touch).toEqual({ available: true })
  })

  it('lifts a finger left down and ends the companion on release, device shutdown and Host stop', async () => {
    const { service, fake, tempDir } = await control()
    await service.take(UDID, 'desk')
    await service.input(UDID, 'desk', [{ type: 'touch', phase: 'down', x: 5, y: 5 }])
    await service.release(UDID, 'desk')
    await waitUntil(() => fake.running() === 0)
    expect(fake.events.at(-1)).toMatchObject({ kind: 'touch', direction: 'up' })
    expect(service.holds(UDID, 'desk')).toBe(false)

    await service.take(UDID, 'desk')
    expect(fake.running()).toBe(1)
    service.deviceEnded(UDID)
    await waitUntil(() => fake.running() === 0)

    await service.take(UDID, 'desk')
    await service.stop()
    expect(fake.running()).toBe(0)
    expect((await readdir(tempDir)).filter(name => name.startsWith('latch-idb-'))).toEqual([])
    expect((await service.take(UDID, 'desk')).touch).toEqual({ available: false, reason: 'unsupported' })
  })

  it('lifts a finger left without events, and lets a person’s control lapse after two minutes without input', async () => {
    const { service, fake, advance } = await control()
    await service.take(UDID, 'desk')
    await service.input(UDID, 'desk', [{ type: 'touch', phase: 'down', x: 5, y: 5 }])
    advance(11_000)
    await service.sweep()
    await waitUntil(() => fake.events.at(-1)?.direction === 'up')
    // The device is free again: an agent's tap does not wait.
    await service.tap(UDID, 20, 20)
    expect(service.holds(UDID, 'desk')).toBe(true)
    advance(121_000)
    await service.sweep()
    expect(service.holds(UDID, 'desk')).toBe(false)
    await expect(service.input(UDID, 'desk', [{ type: 'key', key: 'return' }])).rejects.toMatchObject({
      code: 'simulator-control-required',
    })
  })

  it('opens a new stream when the companion ended the person’s (as a rotation does), and delivers on it', async () => {
    const { service, fake } = await control({ cut: true })
    await service.take(UDID, 'desk')
    await service.input(UDID, 'desk', [{ type: 'button', button: 'home' }])
    await new Promise(resolve => setTimeout(resolve, 50))
    await service.input(UDID, 'desk', [{ type: 'key', key: 'return' }])
    await waitUntil(() => fake.events.some(event => event.kind === 'key'))
  })

  it('drops the person’s stream when the display changes, and opens a new one with the next input', async () => {
    const { service, fake } = await control()
    await service.take(UDID, 'desk')
    await service.input(UDID, 'desk', [{ type: 'touch', phase: 'down', x: 5, y: 5 }])
    service.displayChanged(UDID)
    // The finger is forgotten with the old stream: an agent is not kept waiting for it.
    await service.tap(UDID, 20, 20)
    await service.input(UDID, 'desk', [{ type: 'key', key: 'return' }])
    await waitUntil(() => fake.events.some(event => event.kind === 'key'))
  })

  it('says so when the companion stops under the person', async () => {
    const { service, fake } = await control()
    await service.take(UDID, 'desk')
    fake.crash()
    await waitUntil(() => fake.running() === 0)
    await new Promise(resolve => setTimeout(resolve, 20))
    await expect(service.input(UDID, 'desk', [{ type: 'key', key: 'return' }])).rejects.toMatchObject({
      code: 'simulator-input-unavailable',
    })
    // Taking control again starts a new one.
    expect((await service.take(UDID, 'desk')).touch.available).toBe(true)
  })
})

async function waitUntil(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !done(); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(done()).toBe(true)
}
