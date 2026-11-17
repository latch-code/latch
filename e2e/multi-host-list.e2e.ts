import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { Server, createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceInfo } from '@latch/protocol'
import { makeTestTls } from '@latch/testkit'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { openEntry, openSection, openSessions } from './helpers/layout.ts'

const SHOTS = process.env.LATCH_SHOTS_DIR ?? 'test-results/multi-host-list'
const COMPUTER_SCOPES = ['view', 'run', 'approve:standard', 'approve:elevated'] as const

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  await new Promise<void>(done => server.close(() => done()))
  return port
}

/** As in multi-host.e2e.ts: trusts the test certificate of B's HTTPS entry, a fixture clipboard and the registry handle. */
async function trustBootstrap(directory: string, ca: string): Promise<string> {
  const path = join(directory, 'multi-host-list-main.cjs')
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
const Module = require('node:module')
const originalLoad = Module._load, electron = require('electron')
const fixture = globalThis.multiHostFixture = { registry: undefined, clipboardText: '' }
const facade = Object.create(electron)
Object.defineProperties(facade, {
  clipboard: { value: { readText: () => fixture.clipboardText, clear: () => { fixture.clipboardText = '' } } },
})
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

/**
 * Every request either Host receives on any of its listeners, with its URL, headers and body, recorded by the server's
 * own `request` event in this process (the Hosts run here). Bodies are read as the parser pushes them, without changing
 * what the Host reads.
 */
function recordRequests() {
  const seen: Array<{ where: string; text: string }> = []
  const emit = Server.prototype.emit
  Server.prototype.emit = function (this: Server, event: string | symbol, ...args: unknown[]) {
    if (event === 'request') {
      const req = args[0] as IncomingMessage
      const address = this.address()
      const where = typeof address === 'string' ? address : address ? String(address.port) : '?'
      const entry = { where, text: `${req.method} ${req.url}\n${JSON.stringify(req.headers)}\n` }
      seen.push(entry)
      const push = req.push.bind(req)
      req.push = (chunk: unknown, encoding?: BufferEncoding) => {
        if (chunk) entry.text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
        return push(chunk, encoding)
      }
    }
    return Reflect.apply(emit, this, [event, ...args]) as boolean
  } as typeof Server.prototype.emit
  return {
    seen,
    stop: () => {
      Server.prototype.emit = emit
    },
  }
}

describe.skipIf(process.platform !== 'darwin' || latchEnv(process.env, 'ELECTRON_E2E') !== '1')('several computers, one list', () => {
  it('lists both computers’ sessions on this Mac, opens and starts each on its own computer, and keeps the two apart', async () => {
    const recorder = recordRequests()
    const directory = await mkdtemp(join(tmpdir(), 'latch-electron-list-'))
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
    const a = await startTestHost({ hostName: 'studio-alpha' })
    const b = await startTestHost({ tls: listener, hostName: 'build-bravo' })
    let application: ElectronApplication | undefined
    try {
      // Each computer: a project of its own name and a session with a title of its own.
      const project = async (host: TestHost, name: string) => {
        const path = join(host.root, `${name}-folder`)
        await mkdir(path)
        const owner = await host.enroll({ listener: 'unix' })
        return ((await (await owner.addFolders({ name, paths: [path] })).json()) as { workspace: WorkspaceInfo }).workspace
      }
      const aProject = await project(a, '甲方项目')
      const bProject = await project(b, '乙方项目')
      const start = async (host: TestHost, prompt: string, workspaceId: string) => {
        const { sessionId } = await host.host.bridge.createTask({ prompt, requestId: randomUUID(), mode: 'agent', workspaceId })
        await vi.waitFor(async () => expect((await host.host.bridge.detail(sessionId)).summary.status).not.toBe('running'), {
          timeout: 20_000,
        })
        return { sessionId, title: (await host.host.bridge.detail(sessionId)).summary.title }
      }
      const aSession = await start(a, '整理甲方的报表', aProject.id)
      const bSession = await start(b, '检查乙方的部署', bProject.id)

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
          '--latch-user-data=' + join(directory, 'electron'),
          '--use-mock-keychain',
        ],
        cwd: process.cwd(),
        env: environment,
        timeout: 30_000,
      })
      const app = application
      const page = await app.firstWindow()
      page.setDefaultTimeout(20_000)
      const sizeA = (width: number) =>
        app.evaluate(({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()
            .find(item => item.webContents.getURL().startsWith('latch://app/'))!
            .setContentSize(size, 900)
        }, width)
      await sizeA(1440)
      await page.getByRole('button', { name: '继续', exact: true }).click()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      await mkdir(SHOTS, { recursive: true })

      // Add B the way a person does: its link on the clipboard, 添加电脑 in 设置 › 电脑.
      const invitation = await b.invite([...COMPUTER_SCOPES])
      await app.evaluate((_, value) => {
        ;(Reflect.get(globalThis, 'multiHostFixture') as { clipboardText: string }).clipboardText = value
      }, invitation.url)
      const settings = page.locator('.settings-page')
      await openEntry(page, '设置')
      await openSection(settings, '电脑')
      await settings.getByRole('heading', { name: '电脑', exact: true }).first().waitFor()
      await settings.locator(`[data-computer="${a.host.hostId}"]`).waitFor()
      await settings.getByRole('button', { name: '添加电脑', exact: true }).click()
      await settings.locator(`[data-computer="${b.host.hostId}"]`).getByText('在线', { exact: true }).waitFor({ timeout: 30_000 })
      const lookAtB = () =>
        app.evaluate(async (_electron, hostId) => {
          await (Reflect.get(globalThis, 'multiHostFixture') as { registry: { probe(id: string): Promise<void> } }).registry.probe(hostId)
        }, b.host.hostId)
      await lookAtB()

      // This Mac's Code list: its own project, then B under its name, B's session under B's project.
      await openSessions(page)
      const bShelf = page.locator(`[data-other-computer="${b.host.hostId}"]`)
      await bShelf.waitFor()
      const bName = await bShelf.locator('.other-computer-name').innerText()
      await bShelf.locator('.other-computer-project-name').getByText('乙方项目', { exact: true }).waitFor()
      const bRow = bShelf.locator(`[data-other-task="${bSession.sessionId}"]`)
      await bRow.getByText(bSession.title, { exact: true }).waitFor()
      await page.locator(`[data-task-id="${aSession.sessionId}"]`).first().waitFor()
      // A's own session is never listed under B, and B's never among A's own rows.
      expect(await bShelf.locator(`[data-other-task="${aSession.sessionId}"]`).count()).toBe(0)
      expect(await page.locator(`[data-task-id="${bSession.sessionId}"]`).count()).toBe(0)
      const theme = async (look: 'light' | 'dark') => {
        await page.evaluate(value => {
          const key = 'latch.preferences'
          const saved = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>
          localStorage.setItem(key, JSON.stringify({ ...saved, theme: value }))
        }, look)
        await page.reload()
        await page.locator('.app-shell[data-connection="connected"]').waitFor()
      }
      // At 1440 and at the narrowest window the desktop app allows (768, its sidebar a drawer there).
      for (const width of [1440, 768] as const)
        for (const look of ['light', 'dark'] as const) {
          await sizeA(width)
          await theme(look)
          const drawer = page.getByRole('button', { name: '打开会话列表', exact: true })
          if (await drawer.isVisible()) await drawer.click()
          await bShelf.waitFor()
          await page.evaluate(() => document.fonts.ready)
          await page.screenshot({ path: join(SHOTS, `unified-list--${look}--${width}.png`), animations: 'disabled' })
        }
      await sizeA(1440)
      await theme('light')

      // A row opens on ITS computer: B's window comes forward on that session.
      const opened = app.waitForEvent('window')
      await bShelf.locator(`[data-other-task="${bSession.sessionId}"]`).click()
      const bPage: Page = await opened
      bPage.setDefaultTimeout(20_000)
      await bPage.locator('.app-shell[data-connection="connected"]').waitFor({ timeout: 30_000 })
      expect(new URL(bPage.url()).host).toBe(`h-${b.host.hostId}`)
      await bPage.locator(`[data-task-id="${bSession.sessionId}"][aria-current="page"]`).waitFor()
      // B's own window gets no other computer's sessions.
      expect(await bPage.locator('[data-other-computer]').count()).toBe(0)

      // The start screen: 电脑 beside 项目; this Mac's draft stays here, B's start screen reads B's projects.
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().startsWith('latch://app/'))!
        window.show()
        window.focus()
      })
      await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
      const aInput = page.locator('.workbench-home').getByRole('textbox', { name: '新会话消息', exact: true })
      await aInput.fill('只在这台 Mac 的草稿')
      const picker = page.locator('[data-start-computer]').getByRole('button').first()
      await picker.waitFor()
      for (const [width, look] of [
        [1440, 'light'],
        [1440, 'dark'],
        [768, 'light'],
        [768, 'dark'],
      ] as const) {
        await sizeA(width)
        if (look === 'dark' || width === 768) await theme(look)
        await page.locator('[data-start-computer]').getByRole('button').first().click()
        await page
          .getByRole('menuitemradio', { name: new RegExp(bName, 'u') })
          .or(page.getByRole('option', { name: new RegExp(bName, 'u') }))
          .first()
          .waitFor()
        await page.screenshot({ path: join(SHOTS, `start-computer--${look}--${width}.png`), animations: 'disabled' })
        await page.keyboard.press('Escape')
      }
      await sizeA(1440)
      await theme('light')
      await page.locator('[data-start-computer]').getByRole('button').first().click()
      await page
        .getByRole('menuitemradio', { name: new RegExp(bName, 'u') })
        .or(page.getByRole('option', { name: new RegExp(bName, 'u') }))
        .first()
        .click()
      await vi.waitFor(async () =>
        expect(
          await app.evaluate(
            ({ BrowserWindow }, home) => BrowserWindow.getFocusedWindow()?.webContents.getURL().startsWith(home) === true,
            `latch://h-${b.host.hostId}/`,
          ),
        ).toBe(true),
      )
      const bInput = bPage.locator('.workbench-home').getByRole('textbox', { name: '新会话消息', exact: true })
      await bInput.waitFor()
      expect(await bInput.inputValue()).toBe('')
      expect(await page.locator('.workbench-home').getByRole('textbox', { name: '新会话消息', exact: true }).inputValue()).toBe(
        '只在这台 Mac 的草稿',
      )
      await bPage.locator('.home-composer-location').getByText('乙方项目').or(bPage.locator('.home-composer-location')).first().waitFor()
      await bPage.screenshot({ path: join(SHOTS, 'start-on-b--light--1440.png'), animations: 'disabled' })
      const before = { a: (await a.host.bridge.listTasks()).length, b: (await b.host.bridge.listTasks()).length }
      await bInput.fill('在乙方电脑上开始')
      await bPage.getByRole('button', { name: '发送', exact: true }).click()
      await vi.waitFor(async () => expect((await b.host.bridge.listTasks()).length).toBe(before.b + 1), { timeout: 20_000 })
      expect((await a.host.bridge.listTasks()).length).toBe(before.a)

      // Isolation: neither Host received anything carrying the other's identity, names, sessions or projects.
      const aDevice = (await page.evaluate(async () => (await (await fetch('/link/api/snapshot')).json()) as { device: { id: string } }))
        .device.id
      const bDevice = (await bPage.evaluate(async () => (await (await fetch('/link/api/snapshot')).json()) as { device: { id: string } }))
        .device.id
      await lookAtB()
      const listenersOf = (host: TestHost) =>
        new Set([host.host.socketPath, String(host.host.loopbackPort), ...(host === b ? [String(port)] : [])])
      const aListeners = listenersOf(a),
        bListeners = listenersOf(b)
      const toA = recorder.seen.filter(entry => aListeners.has(entry.where)).map(entry => entry.text)
      const toB = recorder.seen.filter(entry => bListeners.has(entry.where)).map(entry => entry.text)
      // The recorder saw what it must: the desktop's own HTTPS traffic to B, a body over it, and a body over A's socket.
      expect(recorder.seen.some(entry => entry.where === String(port) && entry.text.includes('/link/api/snapshot'))).toBe(true)
      expect(toB.some(text => text.includes('在乙方电脑上开始'))).toBe(true)
      expect(toA.some(text => text.includes('甲方项目'))).toBe(true)
      const aMarks = [
        a.host.hostId,
        a.host.hostId8,
        'studio-alpha',
        aSession.sessionId,
        aSession.title,
        aProject.id,
        '甲方项目',
        aDevice,
        '只在这台 Mac 的草稿',
      ]
      const bMarks = [
        b.host.hostId,
        b.host.hostId8,
        'build-bravo',
        bName,
        bSession.sessionId,
        bSession.title,
        bProject.id,
        '乙方项目',
        bDevice,
      ]
      // By index, so a failure names which mark leaked without printing any request.
      expect(aMarks.map((mark, index) => (toB.some(text => text.includes(mark)) ? index : -1)).filter(index => index >= 0)).toEqual([])
      expect(bMarks.map((mark, index) => (toA.some(text => text.includes(mark)) ? index : -1)).filter(index => index >= 0)).toEqual([])

      // B stops: its rows stay, grey, marked 不是实时, with no status word: never shown as live.
      await b.close()
      await lookAtB()
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().startsWith('latch://app/'))!
        window.show()
        window.focus()
      })
      const stale = page.locator(`[data-other-computer="${b.host.hostId}"][data-stale]`)
      await stale.getByText('不是实时', { exact: true }).waitFor({ timeout: 30_000 })
      await stale
        .locator('.other-computer-state')
        .getByText(/^离线/u)
        .waitFor()
      await stale.locator(`[data-other-task="${bSession.sessionId}"]`).waitFor()
      expect(await stale.locator('.other-computer-status').count()).toBe(0)
      await page.screenshot({ path: join(SHOTS, 'unified-list-offline--light--1440.png'), animations: 'disabled' })
    } finally {
      recorder.stop()
      try {
        await application?.close()
      } finally {
        await Promise.allSettled([a.close(), b.close()])
        await rm(directory, { recursive: true, force: true })
      }
    }
  })
})
