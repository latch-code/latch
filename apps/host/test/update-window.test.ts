import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HarnessPlugin, ModelProvider } from '@latch/sdk'
import type { TestDevice } from '@latch/testkit'
import {
  HeldPlugins,
  HOST_PROTOCOL,
  RequestRecords,
  UPDATE_COMMIT_TTL_MS,
  UPDATE_WINDOW_TTL_MS,
  UpdateWindow,
} from '../src/update-window.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A model whose runs for prompts starting with `Hold` wait until the test lets them finish; others finish at once. */
function heldModel() {
  const gates = new Map<string, () => void>()
  const provider: ModelProvider = {
    id: 'update-window-model',
    name: 'Update window fixture',
    model: 'fake',
    async *stream({ messages, signal }) {
      const prompt = messages.findLast(message => message.role === 'user')?.content ?? ''
      if (prompt.startsWith('Hold')) {
        yield { type: 'text', text: 'Working' }
        await new Promise<void>(done => {
          gates.set(prompt, done)
          signal.addEventListener('abort', () => done(), { once: true })
        })
      }
      yield { type: 'text', text: 'Done' }
      yield { type: 'finish', reason: 'stop' }
    },
  }
  const plugin: HarnessPlugin = {
    id: 'update-window-fixture',
    name: 'Update window fixture',
    version: '1',
    description: '',
    activate(context) {
      context.registerProvider(provider)
    },
  }
  return {
    plugin,
    providerId: provider.id,
    started: (prompt: string) => gates.has(prompt),
    release: (prompt: string) => gates.get(prompt)?.(),
  }
}

async function testHost(plugin: HarnessPlugin, providerId: string): Promise<TestHost> {
  const host = await startTestHost({ plugins: [plugin], providerId })
  cleanups.push(() => host.close())
  return host
}

interface WindowStatus {
  window: { open: boolean; until?: string }
  version: string
  protocol: number
  pluginFormats: number[]
  busy: { running: number; waiting: number; unknown: number }
  plugins: unknown[]
  held: unknown[]
}

async function windowStatus(device: TestDevice, body?: unknown): Promise<{ status: number; body: WindowStatus & { error?: string } }> {
  const response = await device.request('host/update-window', body === undefined ? {} : { method: 'POST', body })
  return { status: response.status, body: (await response.json()) as WindowStatus & { error?: string } }
}

const start = (device: TestDevice, prompt: string, requestId = randomUUID()) =>
  device.request('tasks', { method: 'POST', body: { prompt, requestId, mode: 'chat' } })

async function auditActions(t: TestHost) {
  return (await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { action: string; actor: Record<string, unknown>; detail: Record<string, unknown> })
    .filter(record => record.action === 'host.update-window')
}

const prompt = (device: TestDevice, sessionId: string, body: Record<string, unknown>) =>
  device.request(`tasks/${sessionId}/prompt`, { method: 'POST', body: { requestId: randomUUID(), ...body } })
const idleOf = (t: TestHost, sessionId: string) =>
  expect.poll(async () => (await t.host.bridge.summary(sessionId)).status, { timeout: 10_000 }).toBe('idle')
const errorOf = async (response: Response) => ((await response.json()) as { error?: string }).error

describe('install window', () => {
  it('refuses new starts while existing work settles, and only the desktop app over host.sock holds it', async () => {
    const model = heldModel()
    const t = await testHost(model.plugin, model.providerId)
    const desktop = await t.enroll({ listener: 'unix' })
    const browser = await t.enroll({ listener: 'loopback-tcp' })

    const idle = await windowStatus(desktop)
    expect(idle.status).toBe(200)
    expect(idle.body).toMatchObject({
      window: { open: false },
      protocol: HOST_PROTOCOL,
      busy: { running: 0, waiting: 0, unknown: 0, queued: 0, terminals: 0, services: 0 },
    })
    const info = (await (await t.raw('unix', 'api/host-info')).json()) as { protocol?: number }
    expect(info.protocol).toBe(HOST_PROTOCOL)

    // Anything but the desktop app on this Mac is refused, before the body is read.
    expect((await browser.request('host/update-window')).status).toBe(403)
    expect((await browser.request('host/update-window', { method: 'POST', body: { open: true } })).status).toBe(403)
    expect((await browser.request('host/update-window/commit', { method: 'POST', body: {} })).status).toBe(403)
    expect((await t.raw('unix', 'api/host/update-window')).status).toBe(401)

    const runningRequest = randomUUID()
    const running = await start(desktop, 'Hold on', runningRequest)
    expect(running.status).toBe(201)
    const { sessionId } = (await running.json()) as { sessionId: string }
    await expect.poll(() => model.started('Hold on')).toBe(true)

    const entered = await windowStatus(desktop, { open: true, pluginFormats: [1], version: '0.2.0' })
    expect(entered.status).toBe(200)
    expect(entered.body.window.open).toBe(true)
    expect(entered.body.busy.running).toBe(1)
    // A renewal is not a second entry.
    expect((await windowStatus(desktop, { open: true })).body.window.open).toBe(true)

    // A retry of a start the Host already took gets its original answer: the same session, not a refusal.
    const retried = await start(desktop, 'Hold on', runningRequest)
    expect(retried.status).toBe(201)
    expect(await retried.json()).toEqual({ sessionId })
    const refused = await start(desktop, 'Something new')
    expect(refused.status).toBe(409)
    expect(await errorOf(refused)).toBe('host-updating')
    expect(await errorOf(await prompt(desktop, sessionId, { prompt: 'More' }))).toBe('host-updating')

    // The session under way is not touched: it finishes as usual and the count goes down.
    model.release('Hold on')
    await idleOf(t, sessionId)
    expect((await windowStatus(desktop)).body.busy).toMatchObject({ running: 0, waiting: 0, unknown: 0, queued: 0 })

    const left = await windowStatus(desktop, { open: false, reason: 'cancelled' })
    expect(left.body.window.open).toBe(false)
    expect((await start(desktop, 'After the window')).status).toBe(201)

    const records = await auditActions(t)
    expect(records.map(record => record.detail)).toEqual([
      { state: 'entered', busy: 1, planned: true },
      { state: 'left', reason: 'cancelled', busy: 0 },
    ])
    expect(records.every(record => record.actor.deviceId === desktop.id && record.actor.listener === 'unix')).toBe(true)
  })

  it('answers retried turns as before, refuses turns that would start, and treats a failed start as new', async () => {
    const model = heldModel()
    const t = await testHost(model.plugin, model.providerId)
    const desktop = await t.enroll({ listener: 'unix' })
    const { sessionId } = (await (await start(desktop, 'First')).json()) as { sessionId: string }
    await idleOf(t, sessionId)
    const turnRequest = randomUUID()
    expect((await prompt(desktop, sessionId, { prompt: 'Second', requestId: turnRequest })).status).toBe(200)
    await idleOf(t, sessionId)
    const failedStart = randomUUID()
    expect((await start(desktop, '', failedStart)).status).toBe(400)

    await windowStatus(desktop, { open: true })
    // The turn accepted before the window: its retry is not refused.
    const retriedTurn = await prompt(desktop, sessionId, { prompt: 'Second', requestId: turnRequest })
    expect(await errorOf(retriedTurn)).not.toBe('host-updating')
    // On a session that is not running, queueing, steering or a plain message would start a turn now.
    for (const body of [{ prompt: 'Queued', queue: true }, { prompt: 'Steered', steer: true }, { prompt: 'Plain' }])
      expect(await errorOf(await prompt(desktop, sessionId, body))).toBe('host-updating')
    // The start that failed before is no receipt: its retry is a new start.
    expect(await errorOf(await start(desktop, 'Now with words', failedStart))).toBe('host-updating')
  })

  it('counts queued messages as busy, refuses 立即发送, and commits only when nothing is busy', async () => {
    const model = heldModel()
    const t = await testHost(model.plugin, model.providerId)
    const desktop = await t.enroll({ listener: 'unix' })
    const { sessionId } = (await (await start(desktop, 'Hold this')).json()) as { sessionId: string }
    await expect.poll(() => model.started('Hold this')).toBe(true)
    const queued = await prompt(desktop, sessionId, { prompt: 'Afterwards', queue: true })
    expect(queued.status).toBe(202)
    const itemId = ((await queued.json()) as { queued: { id: string } }).queued.id

    const entered = await windowStatus(desktop, { open: true })
    expect(entered.body.busy).toMatchObject({ running: 1, queued: 1 })
    // Joining the running turn is still fine; sending the queued item now is not.
    expect((await prompt(desktop, sessionId, { prompt: 'Also afterwards', queue: true })).status).toBe(202)
    const sendNow = await desktop.request(`tasks/${sessionId}/queue/${itemId}/send`, { method: 'POST', body: {} })
    expect(sendNow.status).toBe(409)
    expect(await errorOf(sendNow)).toBe('host-updating')
    const busyCommit = await desktop.request('host/update-window/commit', { method: 'POST', body: {} })
    expect(busyCommit.status).toBe(409)
    expect(await errorOf(busyCommit)).toBe('host-busy')

    model.release('Hold this')
    await expect
      .poll(async () => (await windowStatus(desktop, { open: true })).body.busy, { timeout: 10_000 })
      .toMatchObject({
        running: 0,
        waiting: 0,
        unknown: 0,
        queued: 0,
      })
    const committed = await desktop.request('host/update-window/commit', { method: 'POST', body: {} })
    expect(committed.status).toBe(200)
    expect((await windowStatus(desktop)).body.window).toEqual({ open: true, committed: true })
    expect(await errorOf(await start(desktop, 'Too late'))).toBe('host-updating')
    // An install that failed before the Host stopped leaves the window, and starts work again.
    await windowStatus(desktop, { open: false, reason: 'failed' })
    expect((await start(desktop, 'Again')).status).toBe(201)
    expect((await auditActions(t)).map(record => record.detail.state)).toEqual(['entered', 'committed', 'left'])
    const closed = await desktop.request('host/update-window/commit', { method: 'POST', body: {} })
    expect(await errorOf(closed)).toBe('update-window-closed')
  })

  it('keeps a start in flight busy while its handler runs, even after the client went away, and forgets one that failed', async () => {
    const model = heldModel()
    const t = await testHost(model.plugin, model.providerId)
    const desktop = await t.enroll({ listener: 'unix' })
    const create = t.host.bridge.createTask.bind(t.host.bridge)
    let release!: (fail: boolean) => void
    const spy = vi.spyOn(t.host.bridge, 'createTask').mockImplementation(
      input =>
        new Promise((done, reject) => {
          release = fail => (fail ? reject(new Error('fixture failure')) : done(create(input)))
        }),
    )
    const requestId = randomUUID()
    const abort = new AbortController()
    const dropped = desktop
      .request('tasks', { method: 'POST', body: { prompt: 'Slow start', requestId, mode: 'chat' }, signal: abort.signal })
      .catch(() => undefined)
    await expect.poll(() => spy.mock.calls.length).toBe(1)
    abort.abort()
    await dropped
    await new Promise(done => setTimeout(done, 50))
    const entered = await windowStatus(desktop, { open: true })
    expect(entered.body.busy.unknown).toBe(1)
    const busyCommit = await desktop.request('host/update-window/commit', { method: 'POST', body: {} })
    expect(await errorOf(busyCommit)).toBe('host-busy')
    // The handler fails after all: nothing is accepted, and the retry is a new start, refused in the window.
    release(true)
    await expect.poll(async () => (await windowStatus(desktop)).body.busy.unknown).toBe(0)
    expect(await errorOf(await start(desktop, 'Slow start', requestId))).toBe('host-updating')
    spy.mockRestore()
  })

  it('keeps a scheduled run that is starting busy until it settles', async () => {
    const model = heldModel()
    const t = await testHost(model.plugin, model.providerId)
    const desktop = await t.enroll({ listener: 'unix' })
    const { id } = await desktop.json<{ id: string }>('automations', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: 'Nightly',
        model: { providerId: model.providerId, model: 'fake' },
        prompt: 'Now',
        schedule: { kind: 'daily', time: '09:00' },
        notify: false,
      },
    })
    const create = t.host.bridge.createTask.bind(t.host.bridge)
    let release!: () => void
    const spy = vi.spyOn(t.host.bridge, 'createTask').mockImplementation(
      input =>
        new Promise(done => {
          release = () => done(create(input))
        }),
    )
    const running = desktop.request(`automations/${id}/run`, { method: 'POST', body: { requestId: randomUUID() } })
    await expect.poll(() => spy.mock.calls.length, { timeout: 10_000 }).toBe(1)
    expect((await windowStatus(desktop, { open: true })).body.busy.unknown).toBe(1)
    expect(await errorOf(await desktop.request('host/update-window/commit', { method: 'POST', body: {} }))).toBe('host-busy')
    release()
    expect((await running).status).toBe(202)
    await expect.poll(async () => (await windowStatus(desktop)).body.busy.unknown).toBe(0)
    spy.mockRestore()
  })

  it('ends a committed window that no stop followed after two minutes, on record', async () => {
    let offset = 0
    const model = heldModel()
    const host = await startTestHost({ plugins: [model.plugin], providerId: model.providerId, now: () => Date.now() + offset })
    cleanups.push(() => host.close())
    const desktop = await host.enroll({ listener: 'unix' })
    await windowStatus(desktop, { open: true, pluginFormats: [2], version: '0.2.0' })
    expect((await desktop.request('host/update-window/commit', { method: 'POST', body: {} })).status).toBe(200)
    expect(await errorOf(await start(desktop, 'Held'))).toBe('host-updating')
    offset = UPDATE_COMMIT_TTL_MS + 1_000
    expect((await windowStatus(desktop)).body.window).toEqual({ open: false })
    expect((await start(desktop, 'Open again')).status).toBe(201)
    expect((await auditActions(host)).map(record => record.detail)).toEqual([
      { state: 'entered', busy: 0, planned: true },
      { state: 'committed', busy: 0 },
      { state: 'left', reason: 'expired', busy: 0 },
    ])
    expect((await HeldPlugins.open(join(host.dataDir, 'plugin-packages'))).planned).toBe(false)
  })

  it('lets only the device holding the window renew, commit or leave it', async () => {
    const model = heldModel()
    const t = await testHost(model.plugin, model.providerId)
    const desktop = await t.enroll({ listener: 'unix' })
    const other = await t.enroll({ listener: 'unix', name: 'Second desktop' })
    await windowStatus(desktop, { open: true, pluginFormats: [2], version: '0.2.0' })
    for (const [path, body] of [
      ['host/update-window', { open: true }],
      ['host/update-window', { open: false, reason: 'cancelled' }],
      ['host/update-window/commit', {}],
    ] as const) {
      const refused = await other.request(path, { method: 'POST', body })
      expect(refused.status).toBe(409)
      expect(await errorOf(refused)).toBe('update-window-held')
    }
    expect((await windowStatus(desktop)).body.window.open).toBe(true)
    expect((await HeldPlugins.open(join(t.dataDir, 'plugin-packages'))).planned).toBe(true)
    expect((await windowStatus(desktop, { open: false, reason: 'cancelled' })).body.window.open).toBe(false)
    // Once it is closed, the other device may hold one of its own.
    expect((await windowStatus(other, { open: true })).body.window.open).toBe(true)
  })

  it('refuses a handoff start while committed, and answers a handoff retry inside the window as before', async () => {
    const model = heldModel()
    const t = await testHost(model.plugin, model.providerId)
    const desktop = await t.enroll({ listener: 'unix' })
    const { sessionId: source } = (await (await start(desktop, 'Plan it')).json()) as { sessionId: string }
    await idleOf(t, source)
    const detail = await desktop.json<{ messages: Array<{ id: string; role: string; text: string }> }>(`tasks/${source}`)
    const answer = detail.messages.find(message => message.role === 'assistant')!
    const handoff = (requestId = randomUUID()) => ({
      requestId,
      sourceSessionId: source,
      target: { kind: 'new-session', mode: 'chat' },
      materials: [{ kind: 'message', messageId: answer.id, hash: createHash('sha256').update(answer.text).digest('hex') }],
      requirements: 'Build it',
      decisions: [],
      returnScope: 'summary',
    })
    const accepted = handoff()
    const first = await desktop.request('handoffs', { method: 'POST', body: accepted })
    expect(first.status).toBe(201)
    const started = (await first.json()) as { status: string; targetSessionId: string }
    expect(started.status).toBe('started')

    await windowStatus(desktop, { open: true })
    const retried = await desktop.request('handoffs', { method: 'POST', body: accepted })
    expect(retried.status).toBe(200)
    expect(await retried.json()).toMatchObject({ status: 'started', targetSessionId: started.targetSessionId })
    // A new handoff's first start is refused: nothing started, so it is settled as start-failed.
    const refused = await desktop.request('handoffs', { method: 'POST', body: handoff() })
    expect(await refused.json()).toMatchObject({ status: 'start-failed', failure: { code: 'host-updating' } })

    expect((await desktop.request('host/update-window/commit', { method: 'POST', body: {} })).status).toBe(200)
    const committed = await desktop.request('handoffs', { method: 'POST', body: handoff() })
    expect(await committed.json()).toMatchObject({ status: 'start-failed', failure: { code: 'host-updating' } })
  })

  it('waits for a running Git delivery write and refuses new ones while committed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-git-gate-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const release = join(root, 'release')
    const realGit = ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git'].find(path => existsSync(path))!
    // Your git, as the delivery runs it, held at `add` until the test lets it go.
    const slowGit = join(root, 'git')
    await writeFile(
      slowGit,
      `#!/bin/sh\ncase " $* " in *" add "*) while [ ! -f '${release}' ]; do sleep 0.05; done;; esac\nexec '${realGit}' "$@"\n`,
      { mode: 0o755 },
    )
    const model = heldModel()
    const t = await startTestHost({ plugins: [model.plugin], providerId: model.providerId, gitDelivery: { git: slowGit } })
    cleanups.push(() => t.close())
    execFileSync(realGit, ['init', '-q'], { cwd: t.workspaceRoot })
    await writeFile(join(t.workspaceRoot, 'a.txt'), 'a\n')
    const desktop = await t.enroll({ listener: 'unix' })
    const { sessionId } = (await (await start(desktop, 'Repo')).json()) as { sessionId: string }
    await idleOf(t, sessionId)

    const staging = desktop.request(`tasks/${sessionId}/git/stage`, { method: 'POST', body: { requestId: randomUUID(), paths: ['a.txt'] } })
    await expect.poll(async () => (await windowStatus(desktop, { open: true })).body.busy.unknown, { timeout: 10_000 }).toBe(1)
    expect(await errorOf(await desktop.request('host/update-window/commit', { method: 'POST', body: {} }))).toBe('host-busy')
    await writeFile(release, '')
    expect((await staging).status).toBe(200)
    await expect.poll(async () => (await windowStatus(desktop)).body.busy.unknown).toBe(0)
    expect((await desktop.request('host/update-window/commit', { method: 'POST', body: {} })).status).toBe(200)
    const refused = await desktop.request(`tasks/${sessionId}/git/unstage`, {
      method: 'POST',
      body: { requestId: randomUUID(), paths: ['a.txt'] },
    })
    expect(refused.status).toBe(409)
    expect(await errorOf(refused)).toBe('host-updating')
  })

  it('rejects malformed input', async () => {
    const model = heldModel()
    const t = await testHost(model.plugin, model.providerId)
    const desktop = await t.enroll({ listener: 'unix' })
    for (const body of [
      { open: 'yes' },
      { open: true, extra: 1 },
      { open: false },
      { open: true, pluginFormats: [] },
      { open: true, pluginFormats: [1] },
      { open: true, pluginFormats: [1], version: '1.0' },
    ])
      expect((await desktop.request('host/update-window', { method: 'POST', body })).status).toBe(400)
  })
})

describe('UpdateWindow', () => {
  it('lapses unless renewed', () => {
    let now = 1_000
    const window = new UpdateWindow(() => now)
    expect(window.open('desktop')).toBe('entered')
    now += UPDATE_WINDOW_TTL_MS - 1
    expect(window.isOpen()).toBe(true)
    expect(window.open('desktop')).toBe('renewed')
    now += UPDATE_WINDOW_TTL_MS
    expect(window.isOpen()).toBe(false)
    expect(window.view()).toEqual({ open: false })
    expect(window.open('desktop')).toBe('entered')
    expect(window.close()).toBe(true)
    expect(window.close()).toBe(false)
  })

  it('belongs to the device that entered it until it ends', () => {
    let now = 1_000
    const window = new UpdateWindow(() => now)
    window.open('desktop')
    expect(() => window.open('other')).toThrow(expect.objectContaining({ code: 'update-window-held' }))
    expect(() => window.assertHolder('other')).toThrow(expect.objectContaining({ code: 'update-window-held' }))
    window.assertHolder('desktop')
    now += UPDATE_WINDOW_TTL_MS
    expect(window.open('other')).toBe('entered')
  })

  it('holds a commit for two minutes at most, and a renewal does not undo it', () => {
    let now = 1_000
    const window = new UpdateWindow(() => now)
    window.open('desktop')
    window.commit()
    expect(window.isCommitted).toBe(true)
    now += UPDATE_COMMIT_TTL_MS - 1
    expect(window.open('desktop')).toBe('renewed')
    expect(window.isCommitted).toBe(true)
    now += 2
    expect(window.isOpen()).toBe(false)
    expect(window.lapsed()).toBe(true)
  })
})

describe('HeldPlugins', () => {
  async function directory() {
    const path = await mkdtemp(join(tmpdir(), 'latch-held-'))
    cleanups.push(() => rm(path, { recursive: true, force: true }))
    return path
  }
  const applied = [
    { id: 'old', formatVersion: 1 },
    { id: 'new', formatVersion: 2 },
  ]
  const at = { version: '0.2.0', now: 1_000 }

  it('holds the plugins the planned version cannot load on that version’s first start, once', async () => {
    const dir = await directory()
    await (await HeldPlugins.open(dir)).plan([2], '0.2.0', 5_000)
    expect((await stat(join(dir, 'update-held.json'))).mode & 0o777).toBe(0o600)
    const next = await HeldPlugins.open(dir)
    expect(await next.settle(applied, at)).toEqual(['old'])
    expect(next.list()).toEqual(['old'])
    // The plan is used up: a later start holds nothing more.
    const later = await HeldPlugins.open(dir)
    expect(await later.settle(applied, at)).toEqual([])
    expect(later.isHeld('old')).toBe(true)
    await later.release('old')
    expect((await HeldPlugins.open(dir)).list()).toEqual([])
  })

  it('holds nothing when the old version starts again, after the window, or when the install did not happen', async () => {
    for (const [plan, current] of [
      [['0.2.0', 5_000], { version: '0.1.0', now: 1_000 }],
      [['0.2.0', 5_000], { version: '0.2.0', now: 6_000 }],
    ] as const) {
      const dir = await directory()
      await (await HeldPlugins.open(dir)).plan([2], plan[0], plan[1])
      const next = await HeldPlugins.open(dir)
      expect(await next.settle(applied, current)).toEqual([])
      expect(next.planned).toBe(false)
      expect(await (await HeldPlugins.open(dir)).settle(applied, at)).toEqual([])
    }
    const dir = await directory()
    const store = await HeldPlugins.open(dir)
    await store.plan([2], '0.2.0', 5_000)
    await store.unplan()
    expect(await (await HeldPlugins.open(dir)).settle(applied, at)).toEqual([])
  })

  it('drops held IDs that no longer name a package', async () => {
    const dir = await directory()
    await (await HeldPlugins.open(dir)).plan([2], '0.2.0', 5_000)
    await (await HeldPlugins.open(dir)).settle([{ id: 'gone', formatVersion: 1 }], at)
    const next = await HeldPlugins.open(dir)
    await next.settle([], at)
    expect(next.list()).toEqual([])
  })
})

describe('RequestRecords', () => {
  it('keeps in-flight and accepted requests, forgets failed ones, and counts what is in flight', () => {
    const records = new RequestRecords(2)
    records.begin('a')
    records.begin('b')
    expect(records.inFlight()).toBe(2)
    records.settle('a', true)
    records.settle('b', false)
    expect(records.has('a')).toBe(true)
    expect(records.has('b')).toBe(false)
    expect(records.inFlight()).toBe(0)
    records.begin('c')
    records.begin('d')
    expect(records.has('a')).toBe(false)
  })
})
