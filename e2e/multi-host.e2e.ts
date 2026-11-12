import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { makeTestTls } from '@latch/testkit'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { openEntry, openSection, openSessions } from './helpers/layout.ts'

const SHOTS = 'test-results/multi-host'
/** What another computer's 「复制链接」 asks for (COMPUTER_INVITATION in apps/desktop/src/proxy.cjs). */
const COMPUTER_SCOPES = ['view', 'run', 'approve:standard', 'approve:elevated'] as const

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  await new Promise<void>(done => server.close(() => done()))
  return port
}

/**
 * The bootstrap trusts the test certificate of the other computer's HTTPS entry (and resolves its test name to
 * 127.0.0.1) through remote-proxy.cjs's module object, replaces only Electron's Notification class (it records what
 * would be shown, as desktop-notifications.e2e.ts does) and keeps the computers registry, so the test can ask main to
 * look at a computer now instead of waiting for its next look; main, the preload, the proxies and both Hosts stay real.
 */
async function trustBootstrap(directory: string, ca: string): Promise<string> {
  const path = join(directory, 'multi-host-main.cjs')
  await writeFile(
    path,
    `
'use strict'
const remotes = require(${JSON.stringify(resolve('apps/desktop/src/remote-proxy.cjs'))})
const ca = ${JSON.stringify(ca)}
const lookup = (_hostname, options, callback) => {
  const done = typeof options === 'function' ? options : callback
  if (options && options.all) done(null, [{ address: '127.0.0.1', family: 4 }])
  else done(null, '127.0.0.1', 4)
}
remotes.tlsOptions = () => ({ ca: [ca], lookup })
const Module = require('node:module'), { EventEmitter } = require('node:events')
const originalLoad = Module._load, electron = require('electron')
const fixture = globalThis.multiHostFixture = { shown: [], items: [], registry: undefined }
class FixtureNotification extends EventEmitter {
  constructor(options) { super(); this.options = { title: options.title, body: options.body }; fixture.items.push(this) }
  static isSupported() { return true }
  show() { fixture.shown.push(this.options) }
}
const facade = Object.create(electron)
Object.defineProperty(facade, 'Notification', { value: FixtureNotification })
const computers = require(${JSON.stringify(resolve('apps/desktop/src/computers.cjs'))})
const create = computers.createComputers
computers.createComputers = options => (fixture.registry = create(options))
Module._load = function(request, parent, isMain) {
  return request === 'electron' ? facade : Reflect.apply(originalLoad, this, [request, parent, isMain])
}
try { require(${JSON.stringify(resolve('apps/desktop/src/main.cjs'))}) }
finally { Module._load = originalLoad; computers.createComputers = create }
`,
    { mode: 0o600 },
  )
  return path
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  )
}

describe.skipIf(process.platform !== 'darwin' || latchEnv(process.env, 'ELECTRON_E2E') !== '1')(
  'several computers in the desktop app',
  () => {
    it('adds another computer by its link, uses a session in its own window, keeps each computer apart and removes it', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'latch-electron-hosts-'))
      const tls = await makeTestTls(join(directory, 'tls'))
      const port = await freePort()
      const listener = {
        host: '127.0.0.1',
        port,
        certPath: tls.certPath,
        keyPath: tls.keyPath,
        publicOrigin: `https://${tls.hostname}:${port}`,
        allowLocalPeers: true,
      }
      const bData = join(directory, 'b-data')
      const bWorkspace = join(directory, 'b-workspace')
      await mkdir(bWorkspace, { recursive: true })
      const a = await startTestHost()
      let b: TestHost | undefined = await startTestHost({ tls: listener, dataDir: bData, workspaceRoot: bWorkspace })
      let other: TestHost | undefined
      const userData = join(directory, 'electron')
      let application: ElectronApplication | undefined
      try {
        const hostB = b.host
        const bId = hostB.hostId
        await writeHostState(a.dataDir, {
          version: 2,
          pid: process.pid,
          hostId: a.host.hostId,
          instanceId: a.host.instanceId,
          socketPath: a.host.socketPath,
          loopbackOrigin: a.host.loopbackOrigin,
          tlsOrigin: null,
          startedAt: new Date().toISOString(),
          dataDir: a.dataDir,
        })
        const environment = Object.fromEntries(
          Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
        )
        application = await _electron.launch({
          args: [
            await trustBootstrap(directory, tls.ca),
            '--latch-host-state=' + join(a.dataDir, 'host.json'),
            '--latch-user-data=' + userData,
            '--use-mock-keychain',
          ],
          cwd: process.cwd(),
          env: environment,
          timeout: 30_000,
        })
        const app = application
        app.process().stderr?.on('data', chunk => {
          if (String(chunk).includes('[Latch]')) console.log(String(chunk))
        })
        const page = await app.firstWindow()
        page.setDefaultTimeout(20_000)
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900))
        await page.getByRole('button', { name: '继续', exact: true }).click()
        await page.locator('.app-shell[data-connection="connected"]').waitFor()
        await mkdir(SHOTS, { recursive: true })

        const settings = page.locator('.settings-page')
        const row = page.locator(`[data-computer="${bId}"]`)
        async function showComputers(theme: 'light' | 'dark' = 'light') {
          await page.evaluate(look => {
            const key = 'latch.preferences'
            const saved = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>
            localStorage.setItem(key, JSON.stringify({ ...saved, theme: look }))
          }, theme)
          await page.reload()
          await page.locator('.app-shell[data-connection="connected"]').waitFor()
          await openEntry(page, '设置')
          await openSection(settings, '电脑')
          await settings.getByRole('heading', { name: '电脑', exact: true }).first().waitFor()
          await settings.locator(`[data-computer="${a.host.hostId}"]`).waitFor()
        }
        async function shots(name: string) {
          for (const width of [1440, 768] as const)
            for (const theme of ['light', 'dark'] as const) {
              await sizeA(width)
              await showComputers(theme)
              await page.evaluate(() => document.fonts.ready)
              await page.screenshot({ path: join(SHOTS, `computers-${name}--${theme}--${width}.png`), animations: 'disabled' })
            }
          await sizeA(1440)
          await showComputers('light')
        }

        /** This Mac's window at a width: by its own origin, whatever other windows are open. */
        const sizeA = (width: number) =>
          app.evaluate(({ BrowserWindow }, size) => {
            BrowserWindow.getAllWindows()
              .find(item => item.webContents.getURL().startsWith('latch://app/'))!
              .setContentSize(size, 900)
          }, width)
        /** The sidebar at 1440 and 768 (its drawer), light and dark; with `menu`, the computer menu open. */
        async function sidebarShots(name: string, menu = false) {
          for (const width of [1440, 768] as const)
            for (const theme of ['light', 'dark'] as const) {
              await sizeA(width)
              await page.evaluate(look => {
                const key = 'latch.preferences'
                const saved = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>
                localStorage.setItem(key, JSON.stringify({ ...saved, theme: look }))
              }, theme)
              await page.reload()
              await page.locator('.app-shell[data-connection="connected"]').waitFor()
              const drawer = page.getByRole('button', { name: '打开会话列表', exact: true })
              if (await drawer.isVisible()) await drawer.click()
              await page.locator('[data-other-computers]').waitFor()
              if (menu) {
                await page.locator('.sidebar-host-menu').click()
                await page.getByRole('menu', { name: '电脑' }).waitFor()
              }
              await page.evaluate(() => document.fonts.ready)
              await page.screenshot({ path: join(SHOTS, `sidebar-${name}--${theme}--${width}.png`), animations: 'disabled' })
            }
          await sizeA(1440)
          await page.evaluate(() => {
            const key = 'latch.preferences'
            const saved = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>
            localStorage.setItem(key, JSON.stringify({ ...saved, theme: 'light' }))
          })
          await page.reload()
          await page.locator('.app-shell[data-connection="connected"]').waitFor()
        }

        // 设置 › 电脑 lists this Mac alone, and says how to add another.
        await showComputers()
        await settings.locator(`[data-computer="${a.host.hostId}"]`).getByText('这台 Mac', { exact: true }).waitFor()
        await settings.getByText('还没有添加其他电脑。', { exact: true }).waitFor()
        await shots('empty')

        // Nothing on the clipboard: 添加电脑 says so and adds nothing.
        await app.evaluate(({ clipboard }) => clipboard.writeText('just some text'))
        await settings.getByRole('button', { name: '添加电脑', exact: true }).click()
        await settings.getByText(/没有找到电脑链接/u).waitFor()
        // Main refuses an add that no click on the page started.
        expect(
          await page.evaluate(() =>
            (Reflect.get(globalThis, 'latchShell') as { computers: { add(source: string): Promise<{ error: string }> } }).computers.add(
              'clipboard',
            ),
          ),
        ).toMatchObject({
          error: 'gesture-required',
        })

        // The other computer's 「复制链接」: its one-time link, on this Mac's clipboard. Main reads it; the page never does.
        const invitation = await b.invite([...COMPUTER_SCOPES])
        await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), invitation.url)
        await settings.getByRole('button', { name: '添加电脑', exact: true }).click()
        await row.getByText('在线', { exact: true }).waitFor({ timeout: 30_000 })
        expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('')
        const pageText = await page.evaluate(() => document.documentElement.outerHTML)
        expect(pageText).not.toContain(invitation.code)
        await shots('online')

        // What main keeps: the record without a credential, and the credential in its own file, 0600.
        const saved = JSON.parse(await readFile(join(userData, 'computers.json'), 'utf8')) as { computers: Array<Record<string, unknown>> }
        expect(saved).toMatchObject({ version: 1, computers: [{ hostId: bId, kind: 'https', origin: listener.publicOrigin }] })
        expect(JSON.stringify(saved)).not.toContain('ldc1.')
        const credentialFile = join(userData, 'latch-devices', `${bId}.json`)
        expect((await stat(credentialFile)).mode & 0o777).toBe(0o600)
        expect((await stat(join(userData, 'computers.json'))).mode & 0o777).toBe(0o600)
        // That computer lists this Mac as a device of its own, connected over its HTTPS entry.
        const devicesOnB = (await (await b.raw('unix', 'api/devices')).json()) as {
          devices: Array<{ id: string; name: string; listener: string; status: string }>
        }
        const mine = devicesOnB.devices.find(device => device.status === 'active')!
        expect(mine.listener).not.toBe('unix')
        expect(mine.name).toMatch(/上的 Latch$/u)

        // 打开: B's own window, on B's own origin, from B's own page.
        const opened = app.waitForEvent('window')
        await row.getByRole('button', { name: '打开', exact: true }).click()
        const bPage: Page = await opened
        bPage.setDefaultTimeout(20_000)
        await bPage.locator('.app-shell[data-connection="connected"]').waitFor({ timeout: 30_000 })
        expect(new URL(bPage.url()).host).toBe(`h-${bId}`)
        // Neither page opens or brings forward a window without a click or key on it.
        const openWithoutGesture = (target: Page, hostId: string) =>
          target.evaluate(
            id =>
              (
                Reflect.get(globalThis, 'latchShell') as { computers: { open(hostId: string): Promise<{ error?: string }> } }
              ).computers.open(id),
            hostId,
          )
        expect(await openWithoutGesture(page, bId)).toMatchObject({ error: 'gesture-required' })
        expect(await openWithoutGesture(bPage, a.host.hostId)).toMatchObject({ error: 'gesture-required' })
        expect(app.windows()).toHaveLength(2)

        // A remote page's shell: the computers list and nothing that acts on this Mac.
        const remoteShell = await bPage.evaluate(() => {
          const shell = Reflect.get(globalThis, 'latchShell') as Record<string, unknown> & { computers: Record<string, unknown> }
          return { keys: Object.keys(shell).sort(), computers: Object.keys(shell.computers).sort(), remote: shell.remote }
        })
        expect(remoteShell).toEqual({
          keys: ['computers', 'devMode', 'kind', 'platform', 'remote'],
          computers: ['list', 'open', 'subscribe', 'subscribeSession'],
          remote: true,
        })
        const remoteView = await bPage.evaluate(() =>
          (
            Reflect.get(globalThis, 'latchShell') as { computers: { list(): Promise<{ computers: Array<Record<string, unknown>> }> } }
          ).computers.list(),
        )
        expect(remoteView.computers.map(item => item.hostId)).toEqual([a.host.hostId, bId])
        expect(remoteView.computers.every(item => item.origin === undefined)).toBe(true)

        // The device B's page sees is the one B enrolled over HTTPS, not this Mac's own; it is not 「这台 Mac」 there.
        const bSnapshot = await bPage.evaluate(
          async () => (await (await fetch('/link/api/snapshot')).json()) as { device: { id: string; listener: string } },
        )
        expect(bSnapshot.device.id).toBe(mine.id)
        expect(bSnapshot.device.listener).not.toBe('unix')
        const aSnapshot = await page.evaluate(
          async () => (await (await fetch('/link/api/snapshot')).json()) as { device: { id: string; listener: string } },
        )
        expect(aSnapshot.device.listener).toBe('unix')
        expect(devicesOnB.devices.some(device => device.id === aSnapshot.device.id)).toBe(false)

        // Each page reaches only its own computer: no cookie to read, no way into the other one's origin.
        const reach = (target: Page, url: string) =>
          target.evaluate(async address => {
            try {
              return (await fetch(address)).status
            } catch {
              return 'blocked'
            }
          }, url)
        expect(await bPage.evaluate(() => document.cookie)).toBe('')
        expect(await page.evaluate(() => document.cookie)).toBe('')
        expect(await reach(bPage, 'latch://app/link/api/snapshot')).toBe('blocked')
        expect(await reach(page, `latch://h-${bId}/link/api/snapshot`)).toBe('blocked')
        // A page cannot set a cookie that reaches its Host either.
        await bPage.evaluate(() => {
          document.cookie = '__Host-latch_forged=x; Secure; Path=/'
        })
        expect(await bPage.evaluate(async () => (await fetch('/link/api/snapshot')).status)).toBe(200)

        // One session, all of it in B's window: start, approve, finish.
        await bPage.getByRole('textbox', { name: '新会话消息' }).fill('生成需要审批的报告')
        await bPage.getByRole('button', { name: '发送', exact: true }).click()
        await vi.waitFor(async () => expect((await hostB.bridge.listTasks()).length).toBe(1), { timeout: 20_000 })
        const sessionId = (await hostB.bridge.listTasks())[0]!.id
        const card = bPage.locator('[data-approval-id]')
        await card.getByRole('button', { name: '允许', exact: true }).click()
        await bPage.getByText('审批已通过，报告已写入。').first().waitFor({ timeout: 30_000 })
        await vi.waitFor(async () => expect((await hostB.bridge.detail(sessionId)).summary.status).toBe('idle'), { timeout: 20_000 })
        expect((await a.host.bridge.listTasks()).length).toBe(0)
        await bPage.screenshot({ path: join(SHOTS, 'remote-session--light--1440.png'), animations: 'disabled' })

        // What waits on B reaches this Mac's window, its notification and the Dock; B's own page never gets it.
        type Fixture = { shown: Array<{ title: string; body: string }>; registry: { probe(hostId: string): Promise<void> } }
        const lookAtB = () =>
          app.evaluate(async (_electron, hostId) => {
            await (Reflect.get(globalThis, 'multiHostFixture') as Fixture).registry.probe(hostId)
          }, bId)
        const shown = () => app.evaluate(() => (Reflect.get(globalThis, 'multiHostFixture') as Fixture).shown)
        const listed = await page.evaluate(() =>
          (
            Reflect.get(globalThis, 'latchShell') as { computers: { list(): Promise<{ computers: Array<Record<string, unknown>> }> } }
          ).computers.list(),
        )
        const bName = String(listed.computers.find(item => item.hostId === bId)!.name)
        const bVersion = String(listed.computers.find(item => item.hostId === bId)!.version)
        await page.evaluate(() =>
          (
            Reflect.get(globalThis, 'latchShell') as { notifications: { set(value: Record<string, boolean>): Promise<unknown> } }
          ).notifications.set({ completion: false, approval: true, title: true }),
        )
        // No Latch window in front, as when the person is elsewhere.
        await app.evaluate(({ BrowserWindow }) => {
          for (const window of BrowserWindow.getAllWindows()) window.hide()
        })
        await vi.waitFor(
          async () =>
            expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isFocused()))).toBe(false),
          { timeout: 10_000 },
        )
        await lookAtB()
        const { sessionId: waitingId } = await hostB.bridge.createTask({
          prompt: '生成需要审批的报告',
          requestId: randomUUID(),
          mode: 'agent',
        })
        await vi.waitFor(() => expect(hostB.bridge.approvals().some(approval => approval.sessionId === waitingId)).toBe(true), {
          timeout: 20_000,
        })
        await lookAtB()
        const waitingTitle = (await hostB.bridge.detail(waitingId)).summary.title
        expect(await shown()).toEqual([{ title: `${bName} · ${waitingTitle}`, body: '有一个请求等你处理。' }])
        await lookAtB()
        expect(await shown()).toHaveLength(1)
        expect(await app.evaluate(({ app: electronApp }) => electronApp.dock?.getBadge())).toBe('1')
        // B's own page lists the computers without what waits on any of them.
        const bLists = await bPage.evaluate(() =>
          (
            Reflect.get(globalThis, 'latchShell') as { computers: { list(): Promise<{ computers: Array<Record<string, unknown>> }> } }
          ).computers.list(),
        )
        expect(bLists.computers.every(item => item.waiting === undefined && item.running === undefined)).toBe(true)

        // This Mac's window: B's session under 等你处理 › 其他电脑, with B's name; the computer menu lists both.
        await app.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().startsWith('latch://app/'))!
          window.show()
          window.focus()
        })
        await openSessions(page)
        const elsewhere = page.locator(`[data-computer-item="${bId}"]`)
        await elsewhere.locator(`[data-attention-task="${waitingId}"]`).waitFor()
        await elsewhere.getByText(bName, { exact: true }).waitFor()
        await page.locator('.other-computers-label').getByText('其他电脑', { exact: true }).waitFor()
        await page.locator('.sidebar-host-menu').click()
        const menu = page.getByRole('menu', { name: '电脑' })
        await menu.getByRole('menuitemradio', { name: /这台 Mac/u }).waitFor()
        await menu.getByRole('menuitemradio', { name: new RegExp(bName, 'u') }).waitFor()
        await sidebarShots('menu', true)
        await page.keyboard.press('Escape')
        await sidebarShots('waiting')

        // 关于: B's Host version on its own row, nothing to install from here.
        await openEntry(page, '设置')
        await openSection(settings, '关于')
        await settings.locator(`[data-remote-host="${bId}"]`).getByText(bVersion, { exact: true }).waitFor()
        await settings
          .locator('.settings-row')
          .filter({ has: page.locator(`[data-remote-host="${bId}"]`) })
          .getByText(bName, { exact: true })
          .waitFor()
        await page.screenshot({ path: join(SHOTS, 'about-remote--light--1440.png'), animations: 'disabled' })
        await openSessions(page)

        // Clicking it brings B's window forward on that session, where the request waits.
        await elsewhere.locator(`[data-attention-task="${waitingId}"]`).click()
        await vi.waitFor(async () =>
          expect(
            await app.evaluate(
              ({ BrowserWindow }, home) => BrowserWindow.getFocusedWindow()?.webContents.getURL().startsWith(home) === true,
              `latch://h-${bId}/`,
            ),
          ).toBe(true),
        )
        await bPage.locator(`[data-task-id="${waitingId}"][aria-current="page"]`).waitFor()
        await bPage.locator('[data-approval-id]').first().waitFor()
        expect(app.windows()).toHaveLength(2)

        // B stops: its window's connection drops and 设置 › 电脑 shows it offline with when it was last seen.
        await b.close()
        b = undefined
        await showComputers()
        await row.getByText(/^离线 · 上次在线 \d{2}:\d{2}$/u).waitFor({ timeout: 30_000 })
        await shots('offline')
        // Offline, what waited there is one grey row, not live; the Dock no longer counts it.
        await openSessions(page)
        const stale = page.locator(`[data-computer-item="${bId}"][data-stale]`)
        await stale.getByText('离线前 1 项', { exact: true }).waitFor()
        await stale.getByText(/^离线 · 上次在线 \d{2}:\d{2}$/u).waitFor()
        expect(await page.locator(`[data-attention-task="${waitingId}"]`).count()).toBe(0)
        expect(await app.evaluate(({ app: electronApp }) => electronApp.dock?.getBadge())).toBe('')
        await sidebarShots('offline')
        expect(await shown()).toHaveLength(1)
        await showComputers()

        // Another Latch answers at B's address: nothing is sent to it, and it is not B.
        other = await startTestHost({ tls: listener })
        await row.getByText('不是这台电脑', { exact: true }).waitFor({ timeout: 60_000 })
        const strangers = (await (await other.raw('unix', 'api/devices')).json()) as { devices: unknown[] }
        expect(strangers.devices).toEqual([])
        await shots('wrong-host')
        await other.close()
        other = undefined

        // B is back: the same computer, online again.
        b = await startTestHost({ tls: listener, dataDir: bData, workspaceRoot: bWorkspace })
        expect(b.host.hostId).toBe(bId)
        await row.getByText('在线', { exact: true }).waitFor({ timeout: 60_000 })

        // B removes this device: 已被移除, with only 移除 left to do here.
        expect((await b.raw('unix', `api/devices/${encodeURIComponent(mine.id)}`, { method: 'DELETE' })).status).toBe(200)
        await row.getByText('已被移除', { exact: true }).waitFor({ timeout: 60_000 })
        expect(await exists(credentialFile)).toBe(false)
        await shots('revoked')

        // 移除: the record, the credential and B's page storage go, and B's window closes.
        await row.getByRole('button', { name: '移除', exact: true }).click()
        await page.getByRole('dialog').getByRole('button', { name: '移除', exact: true }).click()
        await row.waitFor({ state: 'detached' })
        expect(JSON.parse(await readFile(join(userData, 'computers.json'), 'utf8'))).toEqual({ version: 1, computers: [] })
        expect(await exists(credentialFile)).toBe(false)
        await vi.waitFor(async () => expect(await exists(join(userData, 'Partitions', `latch-host-${bId}`))).toBe(false), {
          timeout: 5_000,
        })
        await vi.waitFor(() => expect(bPage.isClosed()).toBe(true))
        expect(app.windows()).toHaveLength(1)
      } finally {
        try {
          await application?.close()
        } finally {
          await Promise.allSettled([a.close(), b?.close(), other?.close()])
          await rm(directory, { recursive: true, force: true })
        }
      }
    })
  },
)
