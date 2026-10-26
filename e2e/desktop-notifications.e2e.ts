import { _electron, type ElectronApplication } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { HarnessPlugin } from '@latch/sdk'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { startTestHost, type TestHost } from './helpers/host.ts'

interface Gate {
  entered: Promise<void>
  started(): void
  released: Promise<void>
  release(): void
}
interface NotificationRow {
  title: string
  body: string
}
interface MainFixture {
  controller: { poll(): Promise<void> }
  pending: Set<Promise<void>>
  shown: NotificationRow[]
  items: Array<{ emit(event: 'click'): void }>
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}
function modelFixture() {
  const gates = new Map<string, Gate>()
  const plugin: HarnessPlugin = {
    id: 'notification-fixture',
    name: 'Notification fixture',
    version: '1',
    description: 'Only an isolated test provider.',
    activate(context) {
      context.registerTool({
        name: 'notification_fixture_tool',
        description: 'A real high-risk fixture approval.',
        requiresApproval: false,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        async execute() {
          throw new Error('Notification fixture must never approve this tool')
        },
      })
      context.registerProvider({
        id: 'notification-fixture',
        name: 'Notification fixture',
        model: 'fixture',
        async *stream({ messages, signal }) {
          const prompt = messages.findLast(message => message.role === 'user')?.content ?? '',
            gate = gates.get(prompt)
          if (!gate) throw new Error('Unexpected notification fixture prompt')
          gate.started()
          const abort = deferred(),
            cancel = () => abort.resolve()
          signal.addEventListener('abort', cancel, { once: true })
          try {
            if (signal.aborted) return
            await Promise.race([gate.released, abort.promise])
            if (signal.aborted) return
            if (prompt.endsWith('failure')) throw new Error('Notification fixture model failure')
            if (prompt.endsWith('approval')) {
              yield {
                type: 'tool-call',
                call: { id: 'notification-call-' + randomUUID(), name: 'notification_fixture_tool', arguments: {} },
              }
              yield { type: 'finish', reason: 'tool-calls' }
              return
            }
            yield { type: 'text', text: 'Private fixture answer; never notification text.' }
            yield { type: 'finish', reason: 'stop' }
          } finally {
            signal.removeEventListener('abort', cancel)
          }
        },
      })
    },
  }
  return {
    plugin,
    async begin(host: TestHost['host'], name: string) {
      const entered = deferred(),
        released = deferred(),
        prompt = 'Private notification fixture ' + name
      const gate: Gate = { entered: entered.promise, started: entered.resolve, released: released.promise, release: released.resolve }
      gates.set(prompt, gate)
      const task = await host.bridge.createTask({
        prompt,
        requestId: randomUUID(),
        mode: name === 'approval' ? 'agent' : 'chat',
        model: { providerId: 'notification-fixture', model: 'fixture' },
      })
      await gate.entered
      expect((await host.bridge.detail(task.sessionId)).summary.status).toBe('running')
      return { ...task, release: gate.release }
    },
  }
}
async function settled(host: TestHost['host'], sessionId: string, status: string) {
  await vi.waitFor(async () => expect((await host.bridge.detail(sessionId)).summary.status).toBe(status), { timeout: 15_000 })
}

// The bootstrap replaces only Electron's Notification class before product main imports it. Main's authenticated
// snapshot reader, preferences, focus checks, timer, click handler and actual preload stay unchanged.
async function notificationBootstrap(directory: string): Promise<string> {
  const path = join(directory, 'notification-main.cjs')
  await writeFile(
    path,
    `
'use strict'
const Module = require('node:module'), { EventEmitter } = require('node:events')
const originalLoad = Module._load, electron = require('electron')
const fixture = globalThis.notificationFixture = { shown: [], items: [], pending: new Set(), controller: undefined }
class FixtureNotification extends EventEmitter {
  constructor(options) { super(); this.options = { title: options.title, body: options.body }; fixture.items.push(this) }
  static isSupported() { return true }
  show() { fixture.shown.push(this.options) }
}
const facade = Object.create(electron)
Object.defineProperty(facade, 'Notification', { value: FixtureNotification })
const notifications = require(${JSON.stringify(resolve('apps/desktop/src/notifications.cjs'))})
const create = notifications.createNotifications
notifications.createNotifications = options => {
  const controller = create(options), poll = controller.poll.bind(controller)
  controller.poll = () => {
    const operation = poll(); fixture.pending.add(operation)
    operation.then(() => fixture.pending.delete(operation), () => fixture.pending.delete(operation))
    return operation
  }
  fixture.controller = controller
  return controller
}
Module._load = function(request, parent, main) {
  return request === 'electron' ? facade : Reflect.apply(originalLoad, this, [request, parent, main])
}
try { require(${JSON.stringify(resolve('apps/desktop/src/main.cjs'))}) }
finally { Module._load = originalLoad; notifications.createNotifications = create }
`,
    { mode: 0o600 },
  )
  return path
}
async function poll(application: ElectronApplication) {
  await application.evaluate(async () => {
    const fixture = Reflect.get(globalThis, 'notificationFixture') as MainFixture
    await Promise.allSettled(fixture.pending)
    await fixture.controller.poll()
    await Promise.allSettled(fixture.pending)
  })
}
async function rows(application: ElectronApplication) {
  return application.evaluate(() => (Reflect.get(globalThis, 'notificationFixture') as MainFixture).shown)
}
async function focus(application: ElectronApplication, focused: boolean) {
  await application.evaluate(({ BrowserWindow }, selected) => {
    const window = BrowserWindow.getAllWindows()[0]!
    if (selected) {
      window.show()
      window.focus()
    } else window.hide()
  }, focused)
  await vi.waitFor(async () =>
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isFocused()))).toBe(
      focused,
    ),
  )
}

// This Node-only check keeps the provider's real Host states independently verifiable without launching Electron.
describe('desktop notification Host fixture', () => {
  it('produces actual completion, model failure, approval and settled cancellation', async () => {
    const fixture = modelFixture(),
      host = await startTestHost({ plugins: [fixture.plugin] })
    try {
      for (const name of ['completion', 'failure', 'approval', 'cancelled']) {
        const task = await fixture.begin(host.host, name)
        if (name === 'cancelled') {
          await host.host.bridge.cancel(task.sessionId)
          await settled(host.host, task.sessionId, 'cancelled')
          expect((await host.host.bridge.detail(task.sessionId)).summary.runOutcome).toBe('cancelled')
        } else {
          task.release()
          await settled(host.host, task.sessionId, name === 'approval' ? 'waiting-approval' : name === 'failure' ? 'failed' : 'idle')
          if (name === 'approval') {
            expect(host.host.bridge.approvals().some(item => item.sessionId === task.sessionId)).toBe(true)
            await host.host.bridge.cancel(task.sessionId)
          } else
            expect((await host.host.bridge.detail(task.sessionId)).summary.runOutcome).toBe(name === 'failure' ? 'failed' : 'completed')
        }
      }
    } finally {
      await host.close()
    }
  })
})

describe.skipIf(process.platform !== 'darwin' || latchEnv(process.env, 'ELECTRON_E2E') !== '1')('Electron main notifications', () => {
  it('uses authenticated Host states, suppresses foreground events and opens the clicked session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'latch-electron-notifications-')),
      fixture = modelFixture()
    const testHost = await startTestHost({ plugins: [fixture.plugin], presenceMode: 'manual' })
    let application: ElectronApplication | undefined
    try {
      const host = testHost.host
      await writeHostState(testHost.dataDir, {
        version: 2,
        pid: process.pid,
        hostId: host.hostId,
        instanceId: host.instanceId,
        socketPath: host.socketPath,
        loopbackOrigin: host.loopbackOrigin,
        tlsOrigin: host.tlsOrigin ?? null,
        startedAt: new Date().toISOString(),
        dataDir: testHost.dataDir,
      })
      const environment = Object.fromEntries(
        Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
      )
      application = await _electron.launch({
        args: [
          await notificationBootstrap(directory),
          '--latch-host-state=' + join(testHost.dataDir, 'host.json'),
          '--latch-user-data=' + join(directory, 'electron'),
          '--use-mock-keychain',
        ],
        cwd: process.cwd(),
        env: environment,
        timeout: 30_000,
      })
      const app = application,
        page = await app.firstWindow()
      page.setDefaultTimeout(20_000)
      await page.getByRole('heading', { name: '连接到 Latch' }).waitFor()
      await page.getByRole('textbox', { name: '设备名称' }).fill('Notification fixture desktop')
      await page.getByRole('button', { name: '请求本机确认' }).click()
      await testHost.presence.waitForRequest(15_000)
      testHost.presence.approveNext()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      expect(
        await page.evaluate(async () => {
          const shell = Reflect.get(globalThis, 'latchShell') as {
            notifications: { set(input: { completion: boolean; approval: boolean; title: boolean }): Promise<unknown> }
          }
          return shell.notifications.set({ completion: true, approval: true, title: false })
        }),
      ).toMatchObject({ supported: true, completion: true, approval: true, title: false })
      await focus(app, true)
      await poll(app)
      const foreground = await fixture.begin(host, 'foreground')
      await poll(app)
      foreground.release()
      await settled(host, foreground.sessionId, 'idle')
      await poll(app)
      expect(await rows(app)).toEqual([])
      await page.locator(`[data-task-id="${foreground.sessionId}"]`).click()
      await page.locator(`[data-task-id="${foreground.sessionId}"][aria-current="page"]`).waitFor()

      await focus(app, false)
      const background = await fixture.begin(host, 'background')
      await poll(app)
      const list = vi.spyOn(host.bridge, 'listTasks').mockRejectedValue(new Error('Fixture snapshot read unavailable'))
      try {
        await poll(app)
        expect(await rows(app)).toEqual([])
      } finally {
        list.mockRestore()
      }
      expect((await host.bridge.detail(background.sessionId)).summary.status).toBe('running')
      background.release()
      await settled(host, background.sessionId, 'idle')
      await poll(app)
      await vi.waitFor(async () => expect(await rows(app)).toEqual([{ title: 'Latch', body: '一个会话已完成。' }]))
      await app.evaluate(() => (Reflect.get(globalThis, 'notificationFixture') as MainFixture).items[0]!.emit('click'))
      await page.locator(`[data-task-id="${background.sessionId}"][aria-current="page"]`).waitFor()
      await focus(app, true)
      await poll(app)
      expect(await rows(app)).toHaveLength(1)

      await focus(app, false)
      const failure = await fixture.begin(host, 'failure')
      await poll(app)
      failure.release()
      await settled(host, failure.sessionId, 'failed')
      await poll(app)
      await vi.waitFor(async () => expect(await rows(app)).toHaveLength(2))
      expect((await rows(app))[1]).toEqual({ title: 'Latch', body: '一个会话失败了。' })

      const approval = await fixture.begin(host, 'approval')
      await poll(app)
      approval.release()
      await settled(host, approval.sessionId, 'waiting-approval')
      await poll(app)
      await vi.waitFor(async () => expect(await rows(app)).toHaveLength(3))
      expect((await rows(app))[2]).toEqual({ title: 'Latch', body: '有一个请求等你处理。' })
      await app.evaluate(() => (Reflect.get(globalThis, 'notificationFixture') as MainFixture).items[2]!.emit('click'))
      await page.locator(`[data-task-id="${approval.sessionId}"][aria-current="page"]`).waitFor()
      await host.bridge.cancel(approval.sessionId)
      await settled(host, approval.sessionId, 'cancelled')
      await poll(app)

      await focus(app, false)
      const cancelled = await fixture.begin(host, 'cancelled')
      await poll(app)
      await host.bridge.cancel(cancelled.sessionId)
      await settled(host, cancelled.sessionId, 'cancelled')
      await poll(app)
      expect(await rows(app)).toHaveLength(3)
      expect((await rows(app)).filter(row => row.body === '一个会话已完成。')).toHaveLength(1)
      expect(JSON.stringify(await rows(app))).not.toContain('Private')
    } finally {
      vi.restoreAllMocks()
      try {
        await application?.close()
      } finally {
        try {
          await testHost.close()
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      }
    }
  })
})
