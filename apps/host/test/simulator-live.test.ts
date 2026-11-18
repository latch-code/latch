// The 设备 panel's live picture and input through the Host: the stream's framing and back-pressure against a stand-in
// helper, the new routes' guards and records, and the agent input tools' gates. Stand-ins only (the test kit's helper
// and idb_companion); the real check on a `latch-` simulator is manual, see docs/DEVICE-PREVIEW.md.
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { get, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SIMULATOR_INPUT_OWNERS,
  SIMULATOR_STREAM,
  type Automation,
  type AutomationDetail,
  type CustomAgent,
  type ReviewNote,
  type ReviewNoteSendResult,
  type TaskDetail,
  type WorkItemAnswer,
} from '@latch/protocol'
import type { HarnessPlugin, ModelMessage, ToolDefinition } from '@latch/sdk'
import { FAKE_ACP_AGENT, fakeIdbCompanion, fakeSimulatorLive, type TestDevice } from '@latch/testkit'
import type { SimulatorStreamEvent, StreamSettings } from '../src/simulator-helper.ts'
import { SimulatorLive, liveMessage, type LiveSource } from '../src/simulator-live.ts'
import type { SimctlResult, SimctlRunner } from '../src/simulators.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const UDID = '22222222-2222-4222-8222-222222222222'
const OFF = '11111111-1111-4111-8111-111111111111'
const RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-27-2'
const DESCRIPTION = {
  codec: 'h264' as const,
  codecString: 'avc1.4d001f',
  config: 'AU0AH/8=',
  width: 588,
  height: 1280,
  sourceWidth: 1206,
  sourceHeight: 2622,
  scale: 3,
  orientation: 3,
}
const H264: StreamSettings = { codec: 'h264', maxFps: 30, maxDimension: 1280 }
const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))

/** A helper the test drives event by event. */
function manualSource(frames: { available: true } | { available: false; reason: string } = { available: true }) {
  const queue: SimulatorStreamEvent[] = []
  let wake: (() => void) | undefined
  const state = { closed: false, returned: false, keyframes: 0, starts: 0 }
  const source: LiveSource = {
    capabilities: { frames },
    async *frames() {
      state.starts++
      try {
        while (!state.closed) {
          const next = queue.shift()
          if (next) yield next
          else await new Promise<void>(resolve => (wake = resolve))
        }
      } finally {
        state.returned = true
      }
    },
    async keyframe() {
      state.keyframes++
    },
    async close() {
      state.closed = true
      wake?.()
    },
  }
  const push = (event: SimulatorStreamEvent) => {
    queue.push(event)
    const resume = wake
    wake = undefined
    resume?.()
  }
  const frame = (keyframe: boolean, timestamp = 1) => push({ type: 'frame', keyframe, timestamp, data: Buffer.from(keyframe ? 'K' : 'd') })
  return { source, state, push, frame, describe: () => push({ type: 'description', description: DESCRIPTION }) }
}

const typeOf = (message: Buffer | undefined) => message?.readUInt8(0)

describe('the live stream', () => {
  it('frames each message as type, microseconds and length, with the description first and turned content said', async () => {
    expect(liveMessage(SIMULATOR_STREAM.key, 1_500_000, Buffer.from('abc')).toString('hex')).toBe('03000000000016e36000000003616263')
    const fake = manualSource()
    const live = new SimulatorLive({ attach: async () => fake.source })
    const watch = await live.watch(UDID, H264)
    fake.describe()
    fake.frame(true, 33_000)
    fake.frame(false, 66_000)
    const description = await watch.next()
    expect(typeOf(description)).toBe(SIMULATOR_STREAM.description)
    expect(JSON.parse(description!.subarray(13).toString())).toEqual({
      codec: 'h264',
      codecString: 'avc1.4d001f',
      config: 'AU0AH/8=',
      width: 588,
      height: 1280,
      points: { width: 402, height: 874 },
      source: { width: 1206, height: 2622 },
      orientation: 3,
    })
    const key = await watch.next()
    expect([typeOf(key), Number(key!.readBigUInt64BE(1)), key!.readUInt32BE(9), key!.subarray(13).toString()]).toEqual([3, 33_000, 1, 'K'])
    expect(typeOf(await watch.next())).toBe(SIMULATOR_STREAM.delta)
    watch.close()
    await expect.poll(() => fake.state.returned && fake.state.closed).toBe(true)
  })

  it('holds at most a few frames for a reader that stops, skips to the next keyframe and asks for it once', async () => {
    const fake = manualSource()
    const live = new SimulatorLive({ attach: async () => fake.source })
    const watch = await live.watch(UDID, H264)
    fake.describe()
    fake.frame(true)
    for (let index = 0; index < 200; index++) fake.frame(false)
    await tick(30)
    expect(fake.state.keyframes).toBe(1)
    // The description, then nothing: the deltas after the drop refer to frames that were dropped.
    expect(typeOf(await watch.next())).toBe(SIMULATOR_STREAM.description)
    fake.frame(true)
    fake.frame(false)
    expect([typeOf(await watch.next()), typeOf(await watch.next())]).toEqual([SIMULATOR_STREAM.key, SIMULATOR_STREAM.delta])
    expect(fake.state.keyframes).toBe(1)
    watch.close()
  })

  it('shares one helper per device, refuses other settings, and ends with the device or the Host', async () => {
    const fake = manualSource()
    let attached = 0
    const live = new SimulatorLive({
      attach: async () => {
        attached++
        return fake.source
      },
    })
    const first = await live.watch(UDID, H264)
    const second = await live.watch(UDID, H264)
    await expect(live.watch(UDID, { ...H264, maxFps: 10 })).rejects.toMatchObject({ status: 409 })
    await expect(live.watch(UDID, H264)).rejects.toMatchObject({ status: 429 })
    expect(attached).toBe(1)
    first.close()
    expect(fake.state.closed).toBe(false)
    live.deviceEnded(UDID)
    const end = await second.next()
    expect([typeOf(end), JSON.parse(end!.subarray(13).toString())]).toEqual([SIMULATOR_STREAM.end, { reason: 'device' }])
    expect(await second.next()).toBeUndefined()
    await expect.poll(() => fake.state.returned && fake.state.closed).toBe(true)
    const again = manualSource()
    const other = new SimulatorLive({ attach: async () => again.source })
    await other.watch(UDID, H264)
    await other.stop()
    expect(again.state.closed).toBe(true)
    await expect(other.watch(UDID, H264)).rejects.toMatchObject({ status: 503 })
  })

  it('says a helper without frames is unsupported, and one that does not start unavailable', async () => {
    const fake = manualSource({ available: false, reason: 'changed-method:SimScreen' })
    await expect(new SimulatorLive({ attach: async () => fake.source }).watch(UDID, H264)).rejects.toMatchObject({
      status: 409,
      code: 'simulator-live-unsupported',
    })
    expect(fake.state.closed).toBe(true)
    await expect(
      new SimulatorLive({
        attach: async () => {
          throw new Error('ENOENT')
        },
      }).watch(UDID, H264),
    ).rejects.toMatchObject({ status: 503 })
    await expect(new SimulatorLive().watch(UDID, H264)).rejects.toMatchObject({ status: 503 })
  })
})

const ok = (stdout = ''): SimctlResult => ({ code: 0, stdout: Buffer.from(stdout), stderr: '' })
const run: SimctlRunner = async args => {
  if (args[0] === 'list')
    return ok(
      JSON.stringify({
        devices: {
          [RUNTIME]: [
            { udid: UDID, name: 'latch-live', state: 'Booted', isAvailable: true },
            { udid: OFF, name: 'latch-off', state: 'Shutdown', isAvailable: true },
          ],
        },
      }),
    )
  return ok()
}

async function host(idb = fakeIdbCompanion(), live = fakeSimulatorLive(), options: Parameters<typeof startTestHost>[0] = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), 'li-'))
  cleanups.push(() => rm(tempDir, { recursive: true, force: true }))
  const t = await startTestHost({
    simulators: { run, idleMs: 0, live: live.attach, idb: { locate: idb.locate, spawn: idb.spawn, tempDir } },
    ...options,
  })
  cleanups.push(() => t.close())
  return { t, idb, live }
}

async function audit(t: TestHost): Promise<Array<{ action: string; detail: Record<string, unknown> }>> {
  return (await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
}

async function readMessages(response: Response, count: number): Promise<number[]> {
  const reader = response.body!.getReader()
  let buffer = Buffer.alloc(0)
  const types: number[] = []
  while (types.length < count) {
    const { value, done } = await reader.read()
    if (done) break
    buffer = Buffer.concat([buffer, Buffer.from(value)])
    while (buffer.length >= 13 && buffer.length >= 13 + buffer.readUInt32BE(9)) {
      types.push(buffer.readUInt8(0))
      buffer = buffer.subarray(13 + buffer.readUInt32BE(9))
    }
  }
  await reader.cancel()
  return types
}

describe('the live and input routes', () => {
  it('are this Mac’s alone, for a device allowed what the terminal is allowed, and start nothing otherwise', async () => {
    const { t, idb, live } = await host(fakeIdbCompanion(), fakeSimulatorLive(), { tls: true })
    const browser = await t.enroll({ name: 'Browser', scopes: ['view', 'run', 'admin'] })
    const phone = await t.enroll({ listener: 'tls', name: 'Phone', scopes: ['view', 'run', 'admin'] })
    const viewer = await t.enroll({ listener: 'unix', name: 'Viewer', scopes: ['view'] })
    const desktop = await t.enroll({ listener: 'unix', name: 'Desktop' })
    const work = await t.enroll({ listener: 'unix', name: 'Work window' })
    expect((await desktop.request(`devices/${work.id}`, { method: 'PATCH', body: { dataScope: 'work' } })).status).toBe(200)
    for (const elsewhere of [browser, phone, viewer, work]) {
      expect((await elsewhere.request('simulators')).status).toBe(403)
      expect((await elsewhere.request(`simulators/${UDID}/stream?codec=h264&fps=30&size=1280`)).status).toBe(403)
      expect((await elsewhere.request(`simulators/${UDID}/control`, { body: { action: 'take' } })).status).toBe(403)
      expect((await elsewhere.request(`simulators/${UDID}/keyframe`, { body: {} })).status).toBe(403)
      expect((await elsewhere.request(`simulators/${UDID}/input`, { body: { events: [{ type: 'key', key: 'return' }] } })).status).toBe(403)
    }
    expect(idb.starts).toEqual([])
    expect(live.attached).toEqual([])
    expect((await audit(t)).some(record => record.action === 'simulator.action')).toBe(false)
  })

  it('streams the picture to the panel as framed binary, never to the audit, and checks what it asks for', async () => {
    const { t, live } = await host()
    const desktop = await t.enroll({ listener: 'unix', name: 'Desktop' })
    for (const query of [
      'codec=vp9&fps=30&size=1280',
      'codec=h264&fps=61&size=1280',
      'codec=h264&fps=30&size=99',
      'codec=h264&fps=30',
      'codec=h264&fps=30&size=1280&x=1',
      'codec=h264&codec=h264&fps=30&size=1280',
    ])
      expect((await desktop.request(`simulators/${UDID}/stream?${query}`)).status).toBe(400)
    expect((await desktop.request(`simulators/${OFF}/stream?codec=h264&fps=30&size=1280`)).status).toBe(409)
    expect((await desktop.request(`simulators/booted/stream?codec=h264&fps=30&size=1280`)).status).toBe(400)
    const stop = new AbortController()
    const response = await desktop.request(`simulators/${UDID}/stream?codec=h264&fps=30&size=1280`, { signal: stop.signal })
    expect([response.status, response.headers.get('content-type'), response.headers.get('cache-control')]).toEqual([
      200,
      'application/octet-stream',
      'no-store, no-transform',
    ])
    const types = await readMessages(response, 4)
    expect(types).toContain(SIMULATOR_STREAM.control)
    expect(types.filter(type => type !== SIMULATOR_STREAM.control)).toEqual([
      SIMULATOR_STREAM.description,
      SIMULATOR_STREAM.key,
      SIMULATOR_STREAM.delta,
    ])
    // A panel whose decoder flushed on a still screen asks for a keyframe; nothing is recorded.
    expect(await desktop.json(`simulators/${UDID}/keyframe`, { body: {} })).toEqual({ asked: true })
    expect(live.keyframes).toBeGreaterThan(0)
    stop.abort()
    await expect.poll(() => live.closed).toBe(1)
    expect(live.returned).toBe(1)
    // Watching marks the device as the one the panel shows.
    expect(
      (await desktop.json<{ devices: Array<{ udid: string; shown?: boolean }> }>('simulators')).devices.find(item => item.udid === UDID)
        ?.shown,
    ).toBe(true)
    expect(JSON.stringify(await audit(t))).not.toContain('stream')
    const unsupported = await host(fakeIdbCompanion(), fakeSimulatorLive({ unsupported: 'no-xcode' }))
    const other = await unsupported.t.enroll({ listener: 'unix', name: 'Desktop' })
    const refused = await other.request(`simulators/${UDID}/stream?codec=jpeg&fps=20&size=960`)
    expect([refused.status, ((await refused.json()) as { error: string }).error]).toEqual([409, 'simulator-live-unsupported'])
  })

  it('updates a still panel with ownership for each viewer and releases a narrowed lease', async () => {
    const fake = manualSource()
    const idb = fakeIdbCompanion()
    const tempDir = await mkdtemp(join(tmpdir(), 'li-'))
    cleanups.push(() => rm(tempDir, { recursive: true, force: true }))
    const t = await startTestHost({
      simulators: { run, idleMs: 0, live: async () => fake.source, idb: { locate: idb.locate, spawn: idb.spawn, tempDir } },
    })
    cleanups.push(() => t.close())
    const desktop = await t.enroll({ listener: 'unix' })
    const observer = await t.enroll({ listener: 'unix', scopes: ['view', 'run', 'admin'] })
    const stop = new AbortController()
    cleanups.push(() => stop.abort())
    async function watch(device: TestDevice) {
      const response = await device.request(`simulators/${UDID}/stream?codec=h264&fps=30&size=1280`, { signal: stop.signal })
      expect(response.status).toBe(200)
      const reader = response.body!.getReader()
      let buffer = Buffer.alloc(0)
      return async () => {
        const size = SIMULATOR_STREAM.headerBytes + 1
        while (buffer.length < size) {
          const { value, done } = await reader.read()
          if (done) throw new Error('ended while waiting for input ownership')
          buffer = Buffer.concat([buffer, value!])
        }
        expect(buffer.readUInt8(0)).toBe(SIMULATOR_STREAM.control)
        expect(buffer.readUInt32BE(9)).toBe(1)
        const owner = SIMULATOR_INPUT_OWNERS[buffer.readUInt8(SIMULATOR_STREAM.headerBytes)]
        buffer = buffer.subarray(size)
        return owner
      }
    }
    const [own, other] = await Promise.all([watch(desktop), watch(observer)])
    expect(await Promise.all([own(), other()])).toEqual(['none', 'none'])
    await desktop.json(`simulators/${UDID}/control`, { body: { action: 'take' } })
    expect(await Promise.all([own(), other()])).toEqual(['you', 'other'])
    expect((await observer.json<{ devices: unknown[] }>('simulators')).devices).toContainEqual(
      expect.objectContaining({ udid: UDID, inputOwner: 'other' }),
    )
    expect((await observer.request(`devices/${desktop.id}`, { method: 'PATCH', body: { dataScope: 'work' } })).status).toBe(200)
    expect(await other()).toBe('none')
    await expect.poll(idb.running).toBe(0)
    expect(fake.state.closed).toBe(false)
  })

  it.each(['scope reduction', 'revocation'])('closes the response and releases a stalled picture on %s', async change => {
    const fake = manualSource()
    const t = await startTestHost({ simulators: { run, idleMs: 0, live: async () => fake.source } })
    cleanups.push(() => t.close())
    const admin = await t.enroll({ listener: 'unix', name: 'Admin' })
    const viewer = await t.enroll({ listener: 'unix', name: 'Watching window' })
    const write = vi.spyOn(ServerResponse.prototype, 'write')
    cleanups.push(() => write.mockRestore())
    const client = get({
      socketPath: t.host.socketPath,
      path: `/link/api/simulators/${UDID}/stream?codec=h264&fps=30&size=1280`,
      headers: { authorization: `Latch-Device ${viewer.credential}` },
    })
    client.on('error', () => undefined)
    client.on('response', response => {
      response.on('error', () => undefined)
      response.pause()
    })
    cleanups.push(() => {
      client.destroy()
    })

    await expect.poll(() => fake.state.starts).toBe(1)
    fake.describe()
    fake.push({ type: 'frame', keyframe: true, timestamp: 1, data: Buffer.alloc(4 * 1024 * 1024) })
    const stalledResponse = () =>
      write.mock.contexts.find(
        (res): res is ServerResponse =>
          res instanceof ServerResponse && res.writableNeedDrain && res.getHeader('content-type') === 'application/octet-stream',
      )
    await expect.poll(() => stalledResponse()?.listenerCount('drain') ?? 0).toBeGreaterThan(0)
    const response = stalledResponse()!
    expect(response.destroyed).toBe(false)

    const changed = await admin.request(
      `devices/${viewer.id}`,
      change === 'revocation' ? { method: 'DELETE' } : { method: 'PATCH', body: { dataScope: 'work' } },
    )
    expect(changed.status).toBe(200)
    expect(response.destroyed).toBe(true)
    expect(response.listenerCount('drain')).toBe(0)
    await expect.poll(() => fake.state.returned && fake.state.closed).toBe(true)
  })

  it('cleans a companion when a local window loses scope during its pending take', async () => {
    const { t, idb } = await host(fakeIdbCompanion({ ready: false }))
    const desktop = await t.enroll({ listener: 'unix' })
    const admin = await t.enroll({ listener: 'unix' })
    const taking = desktop.request(`simulators/${UDID}/control`, { body: { action: 'take' } })
    await expect.poll(idb.running).toBe(1)
    await admin.json(`devices/${desktop.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
    expect((await taking).status).toBe(403)
    expect(idb.running()).toBe(0)
    await expect(stat(idb.starts[0]!.cwd)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('lifts a revoked window’s finger while another local window retains control', async () => {
    const { t, idb } = await host()
    const desktop = await t.enroll({ listener: 'unix' })
    const other = await t.enroll({ listener: 'unix' })
    const route = `simulators/${UDID}`
    for (const local of [desktop, other]) await local.json(`${route}/control`, { body: { action: 'take' } })
    const down = { type: 'touch', phase: 'down', x: 100, y: 123 }
    await desktop.json(`${route}/input`, { body: { events: [down] } })
    await expect.poll(() => idb.events.length).toBe(1)
    expect((await other.request(`devices/${desktop.id}`, { method: 'PATCH', body: { dataScope: 'work' } })).status).toBe(200)
    await expect.poll(() => idb.events.at(1), { timeout: 1500 }).toMatchObject({ kind: 'touch', direction: 'up', x: 100, y: 123 })
    expect((await desktop.request(`${route}/input`, { body: { events: [down] } })).status).toBe(403)
    expect(await other.json(`${route}/input`, { body: { events: [{ type: 'key', key: 'return' }] } })).toEqual({ written: 1 })
    expect(idb.starts).toHaveLength(1)
  })

  it('keeps the finger down when the window that last moved it still has authority', async () => {
    const { t, idb } = await host()
    const desktop = await t.enroll({ listener: 'unix' })
    const other = await t.enroll({ listener: 'unix' })
    const route = `simulators/${UDID}`
    for (const local of [desktop, other]) await local.json(`${route}/control`, { body: { action: 'take' } })
    await desktop.json(`${route}/input`, { body: { events: [{ type: 'touch', phase: 'down', x: 100, y: 123 }] } })
    expect((await other.json<{ devices: unknown[] }>('simulators')).devices).toContainEqual(
      expect.objectContaining({ udid: UDID, inputOwner: 'other' }),
    )
    await other.json(`${route}/input`, { body: { events: [{ type: 'touch', phase: 'move', x: 110, y: 130 }] } })
    expect((await other.json<{ devices: unknown[] }>('simulators')).devices).toContainEqual(
      expect.objectContaining({ udid: UDID, inputOwner: 'you' }),
    )
    expect((await other.request(`devices/${desktop.id}`, { method: 'PATCH', body: { dataScope: 'work' } })).status).toBe(200)
    expect(await other.json(`${route}/input`, { body: { events: [{ type: 'touch', phase: 'up', x: 120, y: 135 }] } })).toEqual({
      written: 1,
      touchIndex: 0,
    })
    await expect
      .poll(() => idb.events.filter(event => event.kind === 'touch' && event.direction === 'up'))
      .toEqual([expect.objectContaining({ x: 120, y: 135 })])
  })

  it('answers an input batch with an error when a later event fails after a touch was written', async () => {
    const { t, idb } = await host()
    const desktop = await t.enroll({ listener: 'unix' })
    const route = `simulators/${UDID}`
    await desktop.json(`${route}/control`, { body: { action: 'take' } })
    const response = await desktop.request(`${route}/input`, {
      body: {
        events: [
          { type: 'touch', phase: 'down', x: 100, y: 123 },
          { type: 'text', text: '你好' },
        ],
      },
    })
    expect(response.status).toBe(400)
    const rejected = await response.json()
    expect(rejected).toMatchObject({ error: 'simulator-text-unsupported' })
    expect(rejected).not.toHaveProperty('written')
    await expect.poll(() => idb.events).toEqual([expect.objectContaining({ kind: 'touch', direction: 'down' })])
  })

  it('record control once, before the companion starts, and take input only from the device that took it', async () => {
    const { t, idb } = await host()
    const desktop = await t.enroll({ listener: 'unix', name: 'Desktop' })
    const other = await t.enroll({ listener: 'unix', name: 'Other window' })
    const events = [
      { type: 'touch', phase: 'down', x: 100, y: 200 },
      { type: 'touch', phase: 'up', x: 100, y: 200 },
    ]
    expect((await desktop.request(`simulators/${UDID}/input`, { body: { events } })).status).toBe(409)
    expect(idb.starts).toEqual([])
    const taken = await desktop.json<{ control: { touch: { available: boolean }; text: unknown } }>(`simulators/${UDID}/control`, {
      body: { action: 'take' },
    })
    expect(taken.control.touch.available).toBe(true)
    expect(taken.control.text).toEqual({ available: true })
    await desktop.json(`simulators/${UDID}/control`, { body: { action: 'take' } })
    expect(await desktop.json(`simulators/${UDID}/input`, { body: { events } })).toEqual({ written: 2, touchIndex: 1 })
    expect(await desktop.json(`simulators/${UDID}/input`, { body: { events: [events[1]] } })).toEqual({ written: 0 })
    expect((await other.request(`simulators/${UDID}/input`, { body: { events } })).status).toBe(409)
    for (const body of [
      { events: [] },
      { events: Array.from({ length: 65 }, () => ({ type: 'key', key: 'return' })) },
      { events: [{ type: 'key', key: 'a' }] },
      { events: [{ type: 'button', button: 'apple_pay' }] },
      { events: [{ type: 'touch', phase: 'down', x: -1, y: 0 }] },
      { events: [{ type: 'touch', phase: 'down', x: 1, y: 1, finger: 2 }] },
      { events: [{ type: 'text', text: 'x'.repeat(65) }] },
      { events: [{ type: 'text', text: '' }] },
      { events, more: true },
    ])
      expect((await desktop.request(`simulators/${UDID}/input`, { body })).status).toBe(400)
    expect(
      (await desktop.request(`simulators/${UDID}/input`, { body: { events: [{ type: 'touch', phase: 'down', x: 500, y: 900 }] } })).status,
    ).toBe(400)
    await expect.poll(() => idb.events.length).toBe(2)
    expect(idb.events.map(event => event.udid)).toEqual([UDID, UDID])
    const records = (await audit(t)).filter(record => record.action === 'simulator.action')
    expect(records.map(record => record.detail)).toEqual([{ action: 'control', udid: UDID }])
    expect(JSON.stringify(await audit(t))).not.toMatch(/"x":|"y":|"events"/u)
    expect(await desktop.json(`simulators/${UDID}/control`, { body: { action: 'release' } })).toEqual({ released: true })
    await expect.poll(() => idb.running()).toBe(0)
    expect((await desktop.request(`simulators/${UDID}/input`, { body: { events } })).status).toBe(409)
  })

  it('say why input is unavailable where idb is not installed, and never answer success for it', async () => {
    const { t } = await host(fakeIdbCompanion({ installed: false }))
    const desktop = await t.enroll({ listener: 'unix', name: 'Desktop' })
    const taken = await desktop.json<{ control: { touch: unknown; keys: unknown; buttons: unknown } }>(`simulators/${UDID}/control`, {
      body: { action: 'take' },
    })
    expect(taken.control).toMatchObject({
      touch: { available: false, reason: 'idb-missing' },
      keys: { available: false, reason: 'idb-missing' },
      buttons: { available: false, reason: 'idb-missing' },
    })
    expect((await desktop.request(`simulators/${UDID}/input`, { body: { events: [{ type: 'key', key: 'return' }] } })).status).toBe(409)
  })
})

describe('agent input tools', () => {
  const tapWithApproval = `browser ${JSON.stringify([{ tool: 'device_tap', args: { udid: UDID, x: 10, y: 10 }, ask: true }])}`

  async function waitingApproval(desktop: TestDevice, sessionId: string, previous?: string): Promise<string> {
    const pending = async () => (await desktop.json<TaskDetail>(`tasks/${sessionId}`)).approvals.find(item => item.id !== previous)?.id
    await expect.poll(pending, { timeout: 10_000 }).toBeTypeOf('string')
    return (await pending())!
  }

  async function agentHost(idb = fakeIdbCompanion(), steering = false) {
    const { t } = await host(idb, fakeSimulatorLive(), { demo: false })
    const desktop = await t.enroll({ listener: 'unix' })
    await desktop.confirmedJson('agents', {
      body: {
        id: 'device-agent',
        name: 'Device Agent',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_MCP: 'dsh', ...(steering ? { FAKE_ACP_CAPS: 'steer' } : {}) },
      },
    })
    await provide(desktop)
    return { t, desktop, idb }
  }

  it('run for a full-access session a person started, recorded with counts and never coordinates or text', async () => {
    const { t, desktop, idb } = await agentHost()
    const created = await desktop.confirmed('tasks', { body: { prompt: 'echo hi', requestId: randomUUID(), harnessId: 'device-agent' } })
    const { sessionId } = (await created.json()) as { sessionId: string }
    await settled(desktop, sessionId)
    const steps = [
      { tool: 'device_tap', args: { udid: UDID, x: 120.5, y: 300, holdMs: 800 }, ask: true, omitKind: true },
      { tool: 'device_swipe', args: { udid: UDID, fromX: 200, fromY: 600, toX: 200, toY: 300, durationMs: 100 } },
      { tool: 'device_type_text', name: 'device_type_text', args: { udid: UDID, text: '你好 zebra words' }, resultTitle: 'Typing ended' },
      { tool: 'device_press_key', args: { udid: UDID, key: 'return' } },
      { tool: 'device_press_button', args: { udid: UDID, button: 'home' } },
      { tool: 'device_tap', args: { udid: UDID, x: 5000, y: 5000 } },
      { tool: 'device_tap', args: { udid: OFF, x: 1, y: 1 } },
    ]
    await desktop.json(`tasks/${sessionId}/prompt`, {
      method: 'POST',
      body: { requestId: randomUUID(), prompt: `browser ${JSON.stringify(steps)}` },
    })
    const approvalId = await waitingApproval(desktop, sessionId)
    const [approval] = (await desktop.json<TaskDetail>(`tasks/${sessionId}`)).approvals
    expect(approval).toMatchObject({ id: approvalId, arguments: '1 个触点', risk: 'R2', advisory: true })
    expect(JSON.stringify(approval)).not.toContain('120.5')
    await desktop.json(`approvals/${approvalId}`, { body: { decision: 'allow' } })
    const done = await settled(desktop, sessionId)
    const toolRows = done.messages.filter(message => message.role === 'tool' && message.toolName?.startsWith('latch-browser.device_'))
    expect(toolRows.slice(0, 5).map(message => message.tool?.input)).toEqual([
      '1 个触点',
      '2 个触点',
      `${'你好 zebra words'.length} 个字符`,
      '1 次',
      '1 次',
    ])
    expect(JSON.stringify(toolRows)).not.toContain('120.5')
    expect(JSON.stringify(toolRows)).not.toContain('zebra words')
    expect(done.messages.some(message => message.role === 'user' && message.text.includes('zebra words'))).toBe(true)
    const said = done.messages.filter(message => message.role === 'assistant').at(-1)!.text
    expect(said).toContain('device_tap: ok: Long-pressed.')
    expect(said).toContain('device_swipe: ok: Swiped.')
    expect(said).toContain('device_type_text: error: 只能输入可打印的 ASCII 字符')
    expect(said).toContain('device_press_key: ok: Pressed return.')
    expect(said).toContain('device_press_button: ok: Pressed home.')
    expect(said).toMatch(/device_tap: error: .*坐标/u)
    expect(said).toMatch(/device_tap: error: 设备未启动/u)
    expect(idb.events.filter(event => event.kind === 'touch').at(0)).toMatchObject({ x: 120.5, y: 300, direction: 'down' })
    expect(idb.events.some(event => event.kind === 'key' && event.code === 40)).toBe(true)
    const calls = (await audit(t)).filter(record => record.action === 'simulator.call').map(record => record.detail)
    expect(calls.map(call => [call.tool, call.risk, call.via])).toEqual(steps.map(step => [step.tool, 'R1', 'mcp']))
    expect(calls[0]).toMatchObject({ points: 1, udid: UDID, approvalId, toolCallId: approval?.toolCallId })
    expect(calls[1]).toMatchObject({ points: 2 })
    expect(calls[2]).toMatchObject({ textLength: '你好 zebra words'.length })
    expect(calls.some(call => 'held' in call || 'key' in call || 'button' in call)).toBe(false)
    const text = JSON.stringify(await audit(t))
    expect(text).not.toContain('zebra')
    expect(text).not.toContain('120.5')
    const storedRows = async () => {
      const stored = await readFile(join(t.dataDir, 'harnesses', 'device-agent', 'acp.json'), 'utf8')
      const { tasks } = JSON.parse(stored) as { tasks: Record<string, Pick<TaskDetail, 'messages'>> }
      return Object.values(tasks).flatMap(task => task.messages.filter(message => message.role === 'tool'))
    }
    await expect.poll(async () => (await storedRows()).map(message => message.state)).toEqual(toolRows.map(message => message.state))
    const stored = await storedRows()
    expect(stored.map(message => [message.toolName, message.tool?.input])).toEqual(
      toolRows.map(message => [message.toolName, message.tool?.input]),
    )
    expect(JSON.stringify(stored)).not.toContain('120.5')
    expect(JSON.stringify(stored)).not.toContain('zebra words')
  })

  it('does not give a board start full scope when a narrower device supplied its inputs', async () => {
    const { t, desktop, idb } = await agentHost()
    const work = await t.enroll({ listener: 'unix', dataScope: 'work', scopes: ['view', 'run'] })
    const { item } = await work.json<WorkItemAnswer>('work/items', {
      body: { requestId: randomUUID(), title: '测试设备', prompt: tapWithApproval, harnessId: 'device-agent' },
    })
    const { sessionId } = await desktop.confirmedJson<{ sessionId: string }>(`work/items/${item.id}/start`, {
      body: { requestId: randomUUID(), baseRevision: item.revision },
    })
    const approval = await waitingApproval(desktop, sessionId)
    await desktop.json(`approvals/${approval}`, { body: { decision: 'allow' } })
    const done = await settled(desktop, sessionId)
    expect(idb.events.length).toBe(0)
    expect(done.messages.some(message => /device_tap: error: .*(全部数据|device-scope|sees all data)/u.test(message.text))).toBe(true)
    expect(idb.starts.length).toBe(0)
    expect((await audit(t)).filter(record => record.action === 'simulator.call')).toEqual([])
  })

  it('lets an all-data device use the input tools in the very first turn it starts', async () => {
    const { t, desktop, idb } = await agentHost()
    const steps = [{ tool: 'device_tap', args: { udid: UDID, x: 10, y: 10 } }]
    const { sessionId } = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
      body: { requestId: randomUUID(), harnessId: 'device-agent', prompt: `browser ${JSON.stringify(steps)}` },
    })
    const done = await settled(desktop, sessionId)
    expect(done.messages.some(message => message.text.includes('device_tap: ok: Tapped.'))).toBe(true)
    expect(idb.events.filter(event => event.kind === 'touch')).toHaveLength(2)
    expect((await audit(t)).filter(record => record.action === 'simulator.call')).toHaveLength(1)
  })

  it('refuses input from a person’s Agent chat on L3', async () => {
    const { t, desktop, idb } = await agentHost()
    const agent = await desktop.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: '个人验收 Agent',
        description: '',
        harnessId: 'device-agent',
        mode: 'agent',
        instructions: '',
        skills: [],
      },
    })
    const { sessionId } = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
      body: { requestId: randomUUID(), customAgentId: agent.id, prompt: 'mcp-list latch-browser' },
    })
    const initial = await settled(desktop, sessionId)
    expect(initial.summary.agent?.customAgentId).toBe(agent.id)
    const listing = initial.messages.find(message => message.role === 'assistant' && message.text.startsWith('latch-browser tools: '))
    expect(listing?.text).toContain('device_list')
    expect(listing?.text).not.toContain('device_tap')
    const calls = [{ tool: 'device_tap', args: { udid: UDID, x: 10, y: 10 } }, { tool: 'device_list' }]
    await desktop.json(`tasks/${sessionId}/prompt`, {
      body: { requestId: randomUUID(), prompt: `browser ${JSON.stringify(calls)}` },
    })
    const done = await settled(desktop, sessionId)
    expect(idb.events.length).toBe(0)
    expect(
      done.messages.some(
        message => message.role === 'assistant' && message.text.includes('device_tap: error: 我的 Agent 的会话不能向模拟器输入'),
      ),
    ).toBe(true)
    expect(done.messages.some(message => message.role === 'assistant' && message.text.includes(`device_list: ok: ${UDID}`))).toBe(true)
    expect(idb.starts.length).toBe(0)
    expect((await audit(t)).filter(record => record.action === 'simulator.call').map(record => record.detail.tool)).toEqual(['device_list'])
  })

  it.each(['replay', 'queued', 'reduced source', 'revoked source', 'narrow steer'])(
    'keeps the active turn bound to its effective scope after %s',
    async change => {
      const { t, desktop, idb } = await agentHost(fakeIdbCompanion(), change === 'narrow steer')
      const initiallyAll = change === 'reduced source' || change === 'revoked source'
      const source = await t.enroll({ listener: 'unix', dataScope: initiallyAll ? 'all' : 'work', scopes: ['view', 'run'] })
      const { sessionId } = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
        body: { requestId: randomUUID(), harnessId: 'device-agent', prompt: 'echo init' },
      })
      await settled(desktop, sessionId)
      const prior = { requestId: randomUUID(), prompt: 'echo prior' }
      await desktop.json(`tasks/${sessionId}/prompt`, { body: prior })
      await settled(desktop, sessionId)
      const sender = change === 'narrow steer' ? desktop : source
      await sender.json(`tasks/${sessionId}/prompt`, { body: { requestId: randomUUID(), prompt: tapWithApproval } })
      const approval = await waitingApproval(desktop, sessionId)
      if (change === 'replay') await desktop.json(`tasks/${sessionId}/prompt`, { body: prior })
      else if (change === 'queued')
        await desktop.json(`tasks/${sessionId}/prompt`, {
          body: { requestId: randomUUID(), prompt: 'echo queued', queue: true },
        })
      else if (change === 'reduced source')
        expect((await desktop.request(`devices/${source.id}`, { method: 'PATCH', body: { dataScope: 'work' } })).status).toBe(200)
      else if (change === 'revoked source') expect((await desktop.request(`devices/${source.id}`, { method: 'DELETE' })).status).toBe(200)
      else
        expect(
          await source.json(`tasks/${sessionId}/prompt`, { body: { requestId: randomUUID(), prompt: '继续', steer: true } }),
        ).toMatchObject({
          steered: true,
        })
      await desktop.json(`approvals/${approval}`, { body: { decision: 'allow' } })
      const done = await settled(desktop, sessionId)
      expect(idb.events.length).toBe(0)
      expect(done.messages.some(message => /device_tap: error: .*(全部数据|device-scope|sees all data)/u.test(message.text))).toBe(true)
      expect(idb.starts.length).toBe(0)
      expect((await audit(t)).filter(record => record.action === 'simulator.call')).toEqual([])
    },
  )

  it.each(['narrow editor', 'scope lost after dispatch'])('checks an edited queue turn with %s', async change => {
    const { t, desktop, idb } = await agentHost()
    const editor = await t.enroll({ listener: 'unix', dataScope: change === 'narrow editor' ? 'work' : 'all', scopes: ['view', 'run'] })
    const { sessionId } = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
      body: { requestId: randomUUID(), harnessId: 'device-agent', prompt: tapWithApproval },
    })
    const route = `tasks/${sessionId}`
    const firstApproval = await waitingApproval(desktop, sessionId)
    const { queued } = await desktop.json<{ queued: { id: string } }>(`${route}/prompt`, {
      body: { requestId: randomUUID(), prompt: 'echo before edit', queue: true },
    })
    await editor.json(`${route}/queue/${queued.id}`, { method: 'PATCH', body: { text: tapWithApproval } })
    await desktop.json(`approvals/${firstApproval}`, { body: { decision: 'reject' } })
    const secondApproval = await waitingApproval(desktop, sessionId, firstApproval)
    if (change === 'scope lost after dispatch')
      expect((await desktop.request(`devices/${editor.id}`, { method: 'PATCH', body: { dataScope: 'work' } })).status).toBe(200)
    await desktop.json(`approvals/${secondApproval}`, { body: { decision: 'allow' } })
    const done = await settled(desktop, sessionId)
    expect(idb.events).toEqual([])
    expect(done.messages.some(message => /device_tap: error: .*(全部数据|device-scope|sees all data)/u.test(message.text))).toBe(true)
    expect((await audit(t)).filter(record => record.action === 'simulator.call')).toEqual([])
  })

  const tapped = /device_tap: ok: Tapped\./u
  const refusedTap = /device_tap: error: .*(全部数据|device-scope|sees all data)/u

  it.each(['narrow choice', 'narrow words', 'full words'])('decides the turn’s grant by who answers its question: %s', async change => {
    const { t, desktop, idb } = await agentHost()
    const answerer = change === 'full words' ? desktop : await t.enroll({ listener: 'unix', dataScope: 'work', scopes: ['view', 'run'] })
    const { sessionId } = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
      body: { requestId: randomUUID(), harnessId: 'device-agent', prompt: 'echo init' },
    })
    await settled(desktop, sessionId)
    const question = change === 'narrow choice' ? 'choice' : 'words'
    const steps = [{ question }, { tool: 'device_tap', args: { udid: UDID, x: 10, y: 10 } }]
    await desktop.json(`tasks/${sessionId}/prompt`, { body: { requestId: randomUUID(), prompt: `browser ${JSON.stringify(steps)}` } })
    const asked = async () => (await desktop.json<TaskDetail>(`tasks/${sessionId}`)).questions?.[0]?.id
    await expect.poll(asked, { timeout: 10_000 }).toBeTypeOf('string')
    const answer =
      question === 'choice' ? { questionId: 'q0', optionIds: ['o0'] } : { questionId: 'q0', optionIds: [], other: 'tap the delete button' }
    await answerer.json(`tasks/${sessionId}/questions/${(await asked())!}/answer`, {
      method: 'POST',
      body: { requestId: randomUUID(), answers: [answer] },
    })
    const said = (await settled(desktop, sessionId)).messages.filter(message => message.role === 'assistant').at(-1)!.text
    expect(said).toContain('question: accept')
    const calls = (await audit(t)).filter(record => record.action === 'simulator.call')
    if (change === 'full words') {
      expect(said).toMatch(tapped)
      expect(calls).toHaveLength(1)
      return
    }
    expect(said).toMatch(refusedTap)
    expect(idb.events).toEqual([])
    expect(calls).toEqual([])
  })

  it.each(['narrow author', 'revoked author', 'narrow 待办', 'full authors'])(
    'decides a thread delivery’s grant by every quoted post: %s',
    async change => {
      const { t, desktop, idb } = await agentHost()
      const narrow = await t.enroll({ listener: 'unix', dataScope: 'work', scopes: ['view', 'run'] })
      const other = await t.enroll({ listener: 'unix', scopes: ['view', 'run'] })
      const { item } = await (change === 'narrow 待办' ? narrow : desktop).json<WorkItemAnswer>('work/items', {
        body: { requestId: randomUUID(), title: '设备验收', prompt: 'echo init', harnessId: 'device-agent' },
      })
      const { sessionId } = await desktop.confirmedJson<{ sessionId: string }>(`work/items/${item.id}/start`, {
        body: { requestId: randomUUID(), baseRevision: item.revision },
      })
      await settled(desktop, sessionId)
      const author = change === 'narrow author' ? narrow : other
      await author.json(`work/items/${item.id}/posts`, { body: { requestId: randomUUID(), text: '先点删除按钮' } })
      // A device no longer on record counts as one without the full data scope.
      if (change === 'revoked author') expect((await desktop.request(`devices/${other.id}`, { method: 'DELETE' })).status).toBe(200)
      await desktop.json(`work/items/${item.id}/posts`, { body: { requestId: randomUUID(), text: 'echo also mine' } })
      const steps = [{ tool: 'device_tap', args: { udid: UDID, x: 10, y: 10 } }]
      await desktop.json(`work/items/${item.id}/posts`, {
        body: { requestId: randomUUID(), text: `browser ${JSON.stringify(steps)}`, target: { sessionId } },
      })
      const done = await settled(desktop, sessionId)
      const delivered = done.messages.filter(message => message.role === 'user').at(-1)!.text
      expect(delivered).toContain('先点删除按钮')
      const said = done.messages.filter(message => message.role === 'assistant').at(-1)!.text
      const calls = (await audit(t)).filter(record => record.action === 'simulator.call')
      if (change === 'full authors') {
        expect(said).toMatch(tapped)
        expect(calls).toHaveLength(1)
        return
      }
      expect(said).toMatch(refusedTap)
      expect(idb.events).toEqual([])
      expect(calls).toEqual([])
    },
  )

  it.each(['narrow writer', 'narrow editor', 'full writers'])(
    'decides a queued review note turn’s grant by its notes’ writers: %s',
    async change => {
      const { t, desktop, idb } = await agentHost()
      await writeFile(join(t.workspaceRoot, 'a.ts'), 'one\ntwo\nthree\n')
      const files = await t.enroll({ listener: 'unix', dataScope: change === 'full writers' ? 'all' : 'files', scopes: ['view', 'run'] })
      const { sessionId } = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
        body: { requestId: randomUUID(), harnessId: 'device-agent', prompt: 'echo init' },
      })
      await settled(desktop, sessionId)
      const path = `tasks/${sessionId}/review-notes`
      const note = await (change === 'narrow editor' ? desktop : files).json<ReviewNote>(path, {
        body: {
          requestId: randomUUID(),
          ...{ root: 'default', path: 'a.ts', range: { start: 2, end: 3 }, side: 'new', scope: 'turn', lines: ['two', 'three'] },
          text: '这里不对',
        },
      })
      if (change === 'narrow editor')
        await files.json(`${path}/${note.id}/edit`, { body: { requestId: randomUUID(), text: '先点删除按钮' } })
      await desktop.json(`tasks/${sessionId}/prompt`, { body: { requestId: randomUUID(), prompt: 'count 400' } })
      await expect.poll(async () => (await desktop.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('running')
      const { queueId } = await desktop.json<ReviewNoteSendResult>(`${path}/send`, {
        body: { requestId: randomUUID(), noteIds: [note.id], queue: true },
      })
      // The person rewrites the queued message as a tap: whose words it held before still counts.
      const steps = [{ tool: 'device_tap', args: { udid: UDID, x: 10, y: 10 } }]
      await desktop.json(`tasks/${sessionId}/queue/${queueId!}`, { method: 'PATCH', body: { text: `browser ${JSON.stringify(steps)}` } })
      await expect
        .poll(async () => (await desktop.json<TaskDetail>(`tasks/${sessionId}`)).messages.at(-1)?.text ?? '', { timeout: 20_000 })
        .toMatch(/device_tap: /u)
      const said = (await settled(desktop, sessionId)).messages.filter(message => message.role === 'assistant').at(-1)!.text
      const calls = (await audit(t)).filter(record => record.action === 'simulator.call')
      if (change === 'full writers') {
        expect(said).toMatch(tapped)
        expect(calls).toHaveLength(1)
        return
      }
      expect(said).toMatch(refusedTap)
      expect(idb.events).toEqual([])
      expect(calls).toEqual([])
    },
  )

  /** One `device_tap` from the fake agent in a new session of `device-agent`, sent by `sender`; what the agent said. */
  async function tapFrom(desktop: TestDevice, sender: TestDevice = desktop, before?: () => void): Promise<string> {
    const created = await desktop.confirmed('tasks', { body: { prompt: 'echo hi', requestId: randomUUID(), harnessId: 'device-agent' } })
    const { sessionId } = (await created.json()) as { sessionId: string }
    await settled(desktop, sessionId)
    before?.()
    const steps = [{ tool: 'device_tap', args: { udid: UDID, x: 10, y: 10 } }]
    await sender.json(`tasks/${sessionId}/prompt`, {
      method: 'POST',
      body: { requestId: randomUUID(), prompt: `browser ${JSON.stringify(steps)}` },
    })
    const done = await settled(desktop, sessionId)
    return done.messages.filter(message => message.role === 'assistant').at(-1)!.text
  }

  it('are refused for an unattended run, a Harness below full access and a turn from a device that does not see all data', async () => {
    const { t, desktop, idb } = await agentHost()
    // The gate itself: a run the Host counts as unattended, in a full-access session a person opened.
    // Only where the device tools ask: elsewhere an unattended session would not even get latch-browser.
    const unattended = vi.spyOn(t.host.bridge, 'unattended')
    const asked = () => unattended.mockImplementation(() => new Error('probe').stack?.includes('runDeviceCall') === true)
    expect(await tapFrom(desktop, desktop, asked)).toContain('device_tap: error: 没有人值守的运行不能向设备输入')
    unattended.mockRestore()
    // A Harness the Host does not count as full access.
    const level = vi.spyOn(t.host.bridge, 'levelOf')
    expect(await tapFrom(desktop, desktop, () => level.mockReturnValue('L1'))).toContain(
      'device_tap: error: 设备输入工具只给完全访问的外部 Harness 会话',
    )
    level.mockRestore()
    // A turn sent from a device whose data scope is narrower: the picture would reach devices that may not see it.
    const narrower = await t.enroll({ listener: 'unix', name: 'Files window' })
    expect((await desktop.request(`devices/${narrower.id}`, { method: 'PATCH', body: { dataScope: 'files' } })).status).toBe(200)
    expect(await tapFrom(desktop, narrower)).toMatch(/device_tap: error: .*(全部数据|device-scope|sees all data)/u)
    // An automation's run: it never gets as far as the device.
    const agent = await desktop.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: '定时',
        description: '',
        harnessId: 'device-agent',
        mode: 'agent',
        instructions: '',
        skills: [],
      },
    })
    const automation = await desktop.json<Automation>('automations', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: '每天点一下',
        customAgentId: agent.id,
        prompt: `browser ${JSON.stringify([{ tool: 'device_tap', args: { udid: UDID, x: 10, y: 10 } }])}`,
        schedule: { kind: 'daily', time: '09:00' },
        notify: false,
        enabled: false,
      },
    })
    await desktop.json(`automations/${automation.id}/run`, { method: 'POST', body: { requestId: randomUUID() } })
    const detail = () => desktop.json<AutomationDetail>(`automations/${automation.id}`)
    await expect.poll(async () => (await detail()).automation.lastRun?.state, { timeout: 15_000 }).toBe('completed')
    const automated = (await detail()).automation.lastRun
    expect(automated?.sessionId).toBeTruthy()
    const done = await settled(desktop, automated!.sessionId!)
    expect(done.messages.some(message => message.role === 'assistant' && /no latch-browser|device_tap: error:/u.test(message.text))).toBe(
      true,
    )
    expect(idb.starts).toEqual([])
    expect(idb.events).toEqual([])
    expect((await audit(t)).filter(record => record.action === 'simulator.call')).toEqual([])
  }, 60_000)

  it('are not given to the built-in harness, and a call it makes anyway acts on nothing', async () => {
    const seen: string[][] = []
    const steps = [{ name: 'device_tap', arguments: { udid: UDID, x: 1, y: 1 } }]
    const plugin: HarnessPlugin = {
      id: 'scripted',
      name: 'Scripted',
      version: '1',
      description: 'fixture',
      activate(context) {
        context.registerProvider({
          id: 'scripted',
          name: 'Scripted',
          model: 'scripted',
          async *stream({ messages, tools }: { messages: ModelMessage[]; tools: ToolDefinition[] }) {
            seen.push(tools.map(tool => tool.name))
            const step = steps[messages.filter(message => message.role === 'tool').length]
            if (!step) {
              yield { type: 'text', text: 'done' }
              yield { type: 'finish', reason: 'stop' }
              return
            }
            yield { type: 'tool-call', call: { id: `call-${randomUUID()}`, ...step } }
            yield { type: 'finish', reason: 'tool-calls' }
          },
        })
      },
    }
    const idb = fakeIdbCompanion()
    const { t } = await host(idb, fakeSimulatorLive(), { demo: false, providerId: 'scripted', plugins: [plugin] })
    const desktop = await t.enroll({ listener: 'unix' })
    await provide(desktop)
    const { sessionId } = await desktop.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { requestId: randomUUID(), prompt: '点一下', mode: 'agent', model: { providerId: 'scripted', model: 'scripted' } },
    })
    await settled(desktop, sessionId)
    expect(seen[0]).toEqual(expect.arrayContaining(['device_list', 'device_rotate']))
    for (const name of ['device_tap', 'device_swipe', 'device_type_text', 'device_press_key', 'device_press_button'])
      expect(seen[0]).not.toContain(name)
    expect(idb.starts).toEqual([])
    expect((await audit(t)).some(record => record.action === 'simulator.call')).toBe(false)
  })
})

describe('a rejection’s note', () => {
  it.each(['narrow', 'full'])('decides the built-in harness turn’s grant by who wrote it: %s', async change => {
    const steps = [
      { name: 'write_file', arguments: { path: 'notes.txt', content: 'x' } },
      { name: 'device_list', arguments: {} },
    ]
    const plugin: HarnessPlugin = {
      id: 'scripted',
      name: 'Scripted',
      version: '1',
      description: 'fixture',
      activate(context) {
        context.registerProvider({
          id: 'scripted',
          name: 'Scripted',
          model: 'scripted',
          async *stream({ messages }: { messages: ModelMessage[] }) {
            const step = steps[messages.filter(message => message.role === 'tool').length]
            if (!step) {
              yield { type: 'text', text: 'done' }
              yield { type: 'finish', reason: 'stop' }
              return
            }
            yield { type: 'tool-call', call: { id: `call-${randomUUID()}`, ...step } }
            yield { type: 'finish', reason: 'tool-calls' }
          },
        })
      },
    }
    const { t } = await host(fakeIdbCompanion(), fakeSimulatorLive(), { demo: false, providerId: 'scripted', plugins: [plugin] })
    const desktop = await t.enroll({ listener: 'unix' })
    await provide(desktop)
    const writer = change === 'full' ? desktop : await t.enroll({ listener: 'unix', dataScope: 'work', scopes: ['view', 'run'] })
    const { sessionId } = await desktop.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { requestId: randomUUID(), prompt: '写一下', mode: 'agent', model: { providerId: 'scripted', model: 'scripted' } },
    })
    const pending = async () => (await desktop.json<TaskDetail>(`tasks/${sessionId}`)).approvals[0]?.id
    await expect.poll(pending, { timeout: 10_000 }).toBeTypeOf('string')
    await writer.json(`approvals/${(await pending())!}`, { body: { decision: 'reject', note: '改用模拟器看看' } })
    const done = await settled(desktop, sessionId)
    const listed = done.messages.find(message => message.role === 'tool' && message.toolName === 'device_list')
    const calls = (await audit(t)).filter(record => record.action === 'simulator.call')
    if (change === 'full') {
      expect(listed?.tool?.output).toContain(UDID)
      expect(calls).toHaveLength(1)
      return
    }
    expect(listed?.tool?.output).not.toContain(UDID)
    expect(calls).toEqual([])
  })
})

async function provide(desktop: TestDevice) {
  const registered = await desktop.registerBrowserProvider()
  const { providerId } = (await registered.json()) as { providerId: string }
  const stop = new AbortController()
  const response = await desktop.request('browser-provider/stream', { method: 'POST', body: { providerId }, signal: stop.signal })
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  const reading = (async () => {
    while (!(await reader.read()).done) {
      // Keep reading the provider stream for as long as the test's desktop app is present.
    }
  })().catch(() => undefined)
  cleanups.push(async () => {
    stop.abort()
    await reading
    reader.releaseLock()
  })
}

async function settled(device: TestDevice, sessionId: string): Promise<TaskDetail> {
  for (let attempt = 0; attempt < 600; attempt++) {
    const detail = await device.json<TaskDetail>(`tasks/${sessionId}`)
    if (!['running', 'waiting-approval'].includes(detail.summary.status)) return detail
    await tick(25)
  }
  throw new Error('timed out')
}
