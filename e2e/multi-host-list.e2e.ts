import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { Server, createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, CustomAgent, CustomAgentList, WorkspaceInfo } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { makeTestTls } from '@latch/testkit'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { layersInWindow, openEntry, openSection, openSession, openSessions } from './helpers/layout.ts'
import { promptValue } from './helpers/prompt.ts'

const SHOTS = process.env.LATCH_SHOTS_DIR ?? 'test-results/multi-host-list'
const COMPUTER_SCOPES = ['view', 'run', 'approve:standard', 'approve:elevated'] as const
const FAILURE_PROMPT = '演示后台会话失败'
const FAILURE_PROVIDER = 'workbench-failure-fixture'

const failureModel: HarnessPlugin = {
  id: FAILURE_PROVIDER,
  name: 'Background failure fixture',
  version: '1',
  description: 'A local model that can fail on demand.',
  activate(context) {
    context.registerProvider({
      id: FAILURE_PROVIDER,
      name: 'Background failure fixture',
      model: 'fixture',
      async *stream({ messages }) {
        if (messages.findLast(message => message.role === 'user')?.content === FAILURE_PROMPT) throw new Error('Expected fixture failure')
        yield { type: 'finish', reason: 'stop' }
      },
    })
  },
}

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
  it('switches the main window, preserves each computer’s reading state, and still opens sessions separately', async () => {
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
    const a = await startTestHost({ hostName: 'studio-alpha', plugins: [failureModel] })
    const b = await startTestHost({ tls: listener, hostName: 'build-bravo' })
    let application: ElectronApplication | undefined
    try {
      // Each computer: a project of its own name and a session with a title of its own.
      const project = async (host: TestHost, slug: string, name: string) => {
        const path = join(host.root, slug)
        await mkdir(path)
        const owner = await host.enroll({ listener: 'unix' })
        const { workspace } = (await (await owner.addFolders({ paths: [path] })).json()) as { workspace: WorkspaceInfo }
        return (await owner.json<{ workspace: WorkspaceInfo }>(`workspaces/${workspace.id}`, { method: 'PATCH', body: { name } })).workspace
      }
      const aProject = await project(a, 'alpha-fixture-project', '甲方项目')
      const bProject = await project(b, 'bravo-fixture-project', '乙方项目')
      expect(aProject.id).not.toBe(bProject.id)
      const start = async (host: TestHost, prompt: string, workspaceId: string) => {
        const { sessionId } = await host.host.bridge.createTask({ prompt, requestId: randomUUID(), mode: 'agent', workspaceId })
        await vi.waitFor(async () => expect((await host.host.bridge.detail(sessionId)).summary.status).not.toBe('running'), {
          timeout: 20_000,
        })
        return { sessionId, title: (await host.host.bridge.detail(sessionId)).summary.title }
      }
      const aSession = await start(a, '整理甲方的报表', aProject.id)
      const bSession = await start(b, '检查乙方的部署', bProject.id)
      await a.host.bridge.prompt(aSession.sessionId, '读回同一会话里的流式演示', randomUUID())
      await vi.waitFor(async () => expect((await a.host.bridge.detail(aSession.sessionId)).summary.status).toBe('idle'), {
        timeout: 20_000,
      })

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
          const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().startsWith('latch://app/'))!
          window.setMinimumSize(Math.min(768, size), 560)
          window.setContentSize(size, 900)
        }, width)
      await sizeA(1440)
      const windowId = await app.evaluate(({ app, BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]!
        app.focus({ steal: true })
        window.focus()
        return window.id
      })
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
      async function focusLocalWorkbench() {
        await app.evaluate(({ app, BrowserWindow }, id) => {
          const window = BrowserWindow.fromId(id)!
          app.focus({ steal: true })
          if (window.isMinimized()) window.restore()
          window.show()
          window.focus()
        }, windowId)
        await vi.waitFor(
          async () => expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id)).toBe(windowId),
          { timeout: 10_000 },
        )
      }

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

      // The bottom-left switcher changes the active computer inside the original BrowserWindow.
      const windowState = () =>
        app.evaluate(({ BrowserWindow, WebContentsView }, id) => {
          const window = BrowserWindow.fromId(id)
          const root = window?.webContents
          const active = window?.contentView.children.find(
            child => child instanceof WebContentsView && child.webContents !== root && child.getVisible(),
          )
          const contents = active instanceof WebContentsView ? active.webContents : root
          return {
            windowIds: BrowserWindow.getAllWindows().map(item => item.id),
            site: contents ? new URL(contents.getURL()).host : null,
            localPartition: !!contents && contents.session === root?.session,
          }
        }, windowId)
      const computerDialog = (target: Page) => target.getByRole('dialog', { name: '电脑', exact: true })
      const switcher = (target: Page) => target.locator('.workbench-connection .workbench-computer-button')
      const chooseComputer = async (target: Page, hostId: string) => {
        await switcher(target).click()
        await computerDialog(target).locator(`[data-computer-row="${hostId}"] button.computer-pop-other`).click()
      }
      const snapshot = (target: Page) =>
        target.evaluate(async () => {
          const { host, device } = (await (await fetch('/link/api/snapshot')).json()) as AppSnapshot
          return { hostId: host.hostId, listener: device.listener, dataScope: device.dataScope, scopes: [...device.scopes].sort() }
        })
      const conversationInput = (target: Page) => target.getByRole('textbox', { name: '继续对话', exact: true })
      await openSession(page, aSession.sessionId)
      const localReadingDraft = '甲方会话的未发送草稿'
      await conversationInput(page).fill(localReadingDraft)
      const transcript = page.locator('.transcript').filter({ visible: true })
      const readingTop = () => transcript.evaluate(element => element.scrollTop)
      await expect.poll(readingTop).toBeGreaterThan(160)
      const latestTop = await readingTop()
      await transcript.hover()
      await page.mouse.wheel(0, -360)
      await expect.poll(readingTop).toBeLessThan(latestTop - 100)
      const savedTop = await readingTop()
      const localSnapshot = await snapshot(page)
      expect(localSnapshot).toMatchObject({ hostId: a.host.hostId, listener: 'unix', dataScope: 'all' })
      await switcher(page).getByText('studio-alpha', { exact: true }).waitFor()
      expect(await windowState()).toMatchObject({ windowIds: [windowId], site: 'app', localPartition: true })

      const remoteSite = `h-${b.host.hostId}`
      const switched = app.context().waitForEvent('page')
      await chooseComputer(page, b.host.hostId)
      const inWindowB = await switched
      inWindowB.setDefaultTimeout(20_000)
      await inWindowB.locator('.app-shell[data-connection="connected"]').waitFor()
      await expect.poll(windowState).toMatchObject({ windowIds: [windowId], site: remoteSite, localPartition: false })
      await switcher(inWindowB).getByText(bName, { exact: true }).waitFor()
      expect(await snapshot(inWindowB)).toEqual({
        hostId: b.host.hostId,
        listener: 'lan-tls',
        dataScope: 'files',
        scopes: [...COMPUTER_SCOPES].sort(),
      })
      expect(await inWindowB.locator(`[data-task-id="${aSession.sessionId}"], [data-other-computer]`).count()).toBe(0)
      await openSession(inWindowB, bSession.sessionId)
      const remoteInputInWindow = conversationInput(inWindowB)
      expect(await promptValue(remoteInputInWindow)).toBe('')
      const remoteReadingDraft = 'Draft stays on Build Bravo'
      await remoteInputInWindow.pressSequentially(remoteReadingDraft)

      await chooseComputer(inWindowB, a.host.hostId)
      await expect.poll(windowState).toMatchObject({ windowIds: [windowId], site: 'app', localPartition: true })
      await computerDialog(page).waitFor({ state: 'hidden' })
      await page.locator(`[data-task-id="${aSession.sessionId}"][aria-current="page"]`).waitFor()
      expect(await promptValue(conversationInput(page))).toBe(localReadingDraft)
      await expect.poll(async () => Math.abs((await readingTop()) - savedTop)).toBeLessThanOrEqual(1)
      expect(await snapshot(page)).toEqual(localSnapshot)

      await chooseComputer(page, b.host.hostId)
      await expect.poll(windowState).toMatchObject({ windowIds: [windowId], site: remoteSite, localPartition: false })
      await computerDialog(inWindowB).waitFor({ state: 'hidden' })
      await inWindowB.locator(`[data-task-id="${bSession.sessionId}"][aria-current="page"]`).waitFor()
      expect(await promptValue(remoteInputInWindow)).toBe(remoteReadingDraft)

      // A failed run can settle while its conversation is covered. Only returning to it marks that settlement opened.
      await a.host.bridge.prompt(aSession.sessionId, FAILURE_PROMPT, randomUUID(), {
        model: { providerId: FAILURE_PROVIDER, model: 'fixture' },
      })
      await page.locator(`[data-task-id="${aSession.sessionId}"]`).getByText('失败', { exact: true }).waitFor({ state: 'attached' })
      const attentionGroup = async () => (await a.host.bridge.detail(aSession.sessionId)).summary.board?.group
      const attended = () => recorder.seen.some(entry => entry.text.startsWith(`POST /link/api/tasks/${aSession.sessionId}/attend\n`))
      expect(await attentionGroup()).toBe('attention')
      expect(attended()).toBe(false)
      await chooseComputer(inWindowB, a.host.hostId)
      await expect.poll(windowState).toMatchObject({ windowIds: [windowId], site: 'app', localPartition: true })
      await expect.poll(attended).toBe(true)
      await expect.poll(attentionGroup).not.toBe('attention')

      // A row opens on ITS computer: B's window comes forward on that session.
      const opened = app.waitForEvent('window')
      await bShelf.locator(`[data-other-task="${bSession.sessionId}"]`).click()
      const bPage: Page = await opened
      bPage.setDefaultTimeout(20_000)
      await bPage.locator('.app-shell[data-connection="connected"]').waitFor({ timeout: 30_000 })
      expect(new URL(bPage.url()).host).toBe(`h-${b.host.hostId}`)
      await expect.poll(async () => (await windowState()).windowIds.length).toBe(2)
      await bPage.locator(`[data-task-id="${bSession.sessionId}"][aria-current="page"]`).waitFor()
      // B's own window gets no other computer's sessions.
      expect(await bPage.locator('[data-other-computer]').count()).toBe(0)

      // The start screen: 电脑 beside 项目; this Mac's draft stays here, B's start screen reads B's projects.
      await focusLocalWorkbench()
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
      expect(await promptValue(bInput)).toBe('')
      expect(await promptValue(page.locator('.workbench-home').getByRole('textbox', { name: '新会话消息', exact: true }))).toBe(
        '只在这台 Mac 的草稿',
      )
      await bPage.locator('.home-headline').getByText('乙方项目').or(bPage.locator('.home-headline')).first().waitFor()
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
      expect([...toA, ...toB].some(text => text.includes(localReadingDraft) || text.includes(remoteReadingDraft))).toBe(false)
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

      // Chief on A delegates new manual work to one specific assistant on B. Only the native picker is a fixture.
      const aOwner = await a.enroll({ listener: 'unix' })
      const bOwner = await b.enroll({ listener: 'unix' })
      await bOwner.confirmedJson(`devices/${bDevice}`, { method: 'PATCH', body: { dataScope: 'all' } })
      const makeAgent = (name: string) => ({
        requestId: randomUUID(),
        name,
        description: '',
        instructions: '',
        harnessId: 'standard',
        mode: 'chat',
        skills: [],
      })
      const chief = await aOwner.json<CustomAgent>('custom-agents', { method: 'POST', body: makeAgent('本地负责人') })
      const worker = await bOwner.json<CustomAgent>('custom-agents', { method: 'POST', body: makeAgent('云端执行助手') })
      await app.evaluate(({ Menu }, name) => {
        const original = Menu.prototype.popup
        let attempt = 0
        Menu.prototype.popup = function (options) {
          const row = this.items.find(item => item.label.startsWith(name))
          if (!row) return original.call(this, options)
          options?.callback?.()
          attempt++
          if (attempt === 3) Menu.prototype.popup = original
          if (attempt !== 2) Reflect.apply(row.click, row, [])
        }
      }, worker.name)
      await focusLocalWorkbench()
      const inAgents = page.getByRole('radio', { name: '我的 Agent', exact: true }).filter({ visible: true }).first()
      await inAgents.click()
      const computersMenu = page.getByRole('menu', { name: '工作电脑', exact: true })
      const cloudComputer = computersMenu.getByRole('menuitemradio', { name: bName, exact: true })
      await page.getByRole('button', { name: '新建 Agent', exact: true }).filter({ visible: true }).first().click()
      const creating = page.locator('.agents-page[data-view="new"]')
      const createComputer = creating.getByRole('button', { name: '工作电脑：这台 Mac', exact: true })
      const createNotice = '新委托会使用工作电脑上所选 Agent 的配置。'

      await sizeA(390)
      await page.locator('.app-shell[data-viewport="phone"]').waitFor()
      await createComputer.click()
      const computersSheet = page.getByRole('dialog', { name: '工作电脑', exact: true })
      await computersSheet.getByRole('radio', { name: bName, exact: true }).waitFor()
      await computersSheet.getByText(createNotice, { exact: true }).waitFor()
      await page.screenshot({ path: join(SHOTS, 'assistant-work-computer-picker--phone.png'), animations: 'disabled' })
      await computersSheet.getByRole('button', { name: '关闭', exact: true }).click()
      await computersSheet.waitFor({ state: 'hidden' })

      await sizeA(768)
      await page.locator('.app-shell[data-viewport="tablet"]').waitFor()
      await createComputer.click()
      await cloudComputer.waitFor()
      await layersInWindow(page)
      await page.screenshot({ path: join(SHOTS, 'assistant-work-computer-picker--tablet.png'), animations: 'disabled' })
      await page.keyboard.press('Escape')
      await computersMenu.waitFor({ state: 'hidden' })

      await sizeA(1440)
      await page.locator('.app-shell[data-viewport="desktop"]').waitFor()
      await focusLocalWorkbench()
      await createComputer.click()
      await computersMenu.getByText(createNotice, { exact: true }).waitFor()
      expect(await computersMenu.getByText(/定时/u).count()).toBe(0)
      await cloudComputer.click()
      const form = creating.getByRole('form', { name: '新建 Agent' })
      await form.getByRole('heading', { name: '添加工作电脑上的 Agent' }).waitFor()
      expect(await form.locator('.helper-cards,.helper-chosen').count()).toBe(0)
      await form.getByLabel('名字', { exact: true }).fill('云端助手本地入口')
      await page.screenshot({ path: join(SHOTS, 'assistant-work-computer-create.png'), animations: 'disabled' })
      await form.getByRole('button', { name: '创建', exact: true }).click()
      await expect
        .poll(
          async () =>
            (await aOwner.json<CustomAgentList>('custom-agents')).agents.find(item => item.name === '云端助手本地入口')?.workComputer,
        )
        .toEqual({ hostId: b.host.hostId, agentId: worker.id })
      expect((await bOwner.json<CustomAgentList>('custom-agents')).agents.map(item => item.name)).not.toContain('云端助手本地入口')
      expect(recorder.seen.some(entry => bListeners.has(entry.where) && entry.text.includes('云端助手本地入口'))).toBe(false)
      await page
        .getByRole('navigation', { name: '我的 Agent', exact: true })
        .filter({ visible: true })
        .getByRole('button', { name: /^本地负责人/u })
        .click()
      await page.getByRole('button', { name: '本地负责人 的资料', exact: true }).click()
      const profile = page.getByRole('region', { name: '本地负责人 的资料', exact: true })
      const field = profile.locator('[data-work-computer]')
      await profile.getByRole('tab', { name: '动态', exact: true, selected: true }).waitFor()
      await field.waitFor({ state: 'hidden' })
      await profile.getByRole('tab', { name: '运行设置', exact: true }).click()
      const pick = field.getByRole('button').first()
      await pick.press('ArrowDown')
      const thisMac = computersMenu.getByRole('menuitemradio', { name: '这台 Mac', exact: true, checked: true })
      await expect.poll(() => thisMac.evaluate(row => row === document.activeElement)).toBe(true)
      await computersMenu.getByText(/已启用的定时任务会暂停/u).waitFor()
      await computersMenu.getByRole('menuitem', { name: '添加云电脑…', exact: true }).waitFor()
      await page.screenshot({ path: join(SHOTS, 'assistant-work-computer-picker.png'), animations: 'disabled' })
      const [triggerBox, layerBox] = await Promise.all([pick.boundingBox(), field.locator('[popover]:popover-open').boundingBox()])
      expect(layerBox!.width).toBeLessThanOrEqual(320)
      const gap = Math.max(layerBox!.y - (triggerBox!.y + triggerBox!.height), triggerBox!.y - (layerBox!.y + layerBox!.height))
      expect(gap).toBeGreaterThanOrEqual(4)
      expect(gap).toBeLessThanOrEqual(8)
      expect(layerBox!.x).toBeLessThan(triggerBox!.x + triggerBox!.width)
      expect(layerBox!.x + layerBox!.width).toBeGreaterThan(triggerBox!.x)
      await layersInWindow(page)
      await page.keyboard.press('ArrowDown')
      await expect.poll(() => cloudComputer.evaluate(row => row === document.activeElement)).toBe(true)
      await page.keyboard.press('Escape')
      await computersMenu.waitFor({ state: 'hidden' })
      await expect.poll(() => pick.evaluate(button => button === document.activeElement)).toBe(true)

      await pick.click()
      await cloudComputer.click()
      await expect.poll(() => pick.getAttribute('aria-busy')).not.toBe('true')
      expect((await aOwner.json<CustomAgentList>('custom-agents')).agents.find(item => item.id === chief.id)?.workComputer).toBeUndefined()
      await pick.click()
      await cloudComputer.click()
      await expect
        .poll(async () => (await aOwner.json<CustomAgentList>('custom-agents')).agents.find(item => item.id === chief.id)?.workComputer)
        .toEqual({ hostId: b.host.hostId, agentId: worker.id })
      await profile.getByRole('group', { name: '原电脑', exact: true }).waitFor()
      await profile.getByRole('tab', { name: '资料库', exact: true }).click()
      await field.waitFor({ state: 'hidden' })
      expect(await profile.getByRole('group', { name: '原电脑', exact: true }).count()).toBe(0)
      await profile.getByRole('tab', { name: '运行设置', exact: true }).click()
      await pick.click()
      await computersMenu.getByText(/已暂停的定时任务需手动开启/u).waitFor()
      await page.keyboard.press('Escape')
      await computersMenu.waitFor({ state: 'hidden' })
      const destination = page.locator('.agent-chat-main [data-work-destination]')
      const openWorker = destination.getByRole('button', { name: `在 ${bName} 上打开 Agent`, exact: true })
      await openWorker.waitFor()
      expect(await page.locator('[data-work-destination]').filter({ visible: true }).count()).toBe(1)
      expect(await page.getByRole('button', { name: '去修复', exact: true }).filter({ visible: true }).count()).toBe(0)
      await page.screenshot({ path: join(SHOTS, 'assistant-work-computer-bound.png'), animations: 'disabled' })
      await openWorker.click()
      const remoteInput = bPage.getByRole('textbox', { name: '给云端执行助手发消息', exact: true })
      await remoteInput.fill('只给云端执行助手的委托')
      const localCount = (await a.host.bridge.listTasks()).length
      await bPage.getByRole('button', { name: '发送', exact: true }).filter({ visible: true }).first().click()
      await expect
        .poll(async () => (await bOwner.json<AppSnapshot>('snapshot')).tasks.some(item => item.agent?.customAgentId === worker.id))
        .toBe(true)
      expect((await a.host.bridge.listTasks()).length).toBe(localCount)
      expect(recorder.seen.some(entry => aListeners.has(entry.where) && entry.text.includes('只给云端执行助手的委托'))).toBe(false)
      expect(recorder.seen.some(entry => bListeners.has(entry.where) && entry.text.includes('只给云端执行助手的委托'))).toBe(true)
      await focusLocalWorkbench()
      // Revocation and a remote deletion both leave A's binding in place and no local composer.
      const remoteBlocked = async () => {
        await openWorker.click()
        await destination.getByText(/^无法打开这个 Agent。/u).waitFor()
        await expect.poll(() => openWorker.isEnabled()).toBe(true)
        expect(
          await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.webContents.getURL().startsWith('latch://app/')),
        ).toBe(true)
        expect((await aOwner.json<CustomAgentList>('custom-agents')).agents.find(item => item.id === chief.id)?.workComputer).toEqual({
          hostId: b.host.hostId,
          agentId: worker.id,
        })
        expect(await page.getByRole('textbox', { name: '给本地负责人发消息' }).filter({ visible: true }).count()).toBe(0)
      }
      await bOwner.json(`devices/${bDevice}`, { method: 'PATCH', body: { dataScope: 'work' } })
      await remoteBlocked()
      await bOwner.confirmedJson(`devices/${bDevice}`, { method: 'PATCH', body: { dataScope: 'all' } })
      await bOwner.json(`custom-agents/${worker.id}`, { method: 'DELETE', body: { requestId: randomUUID() } })
      await remoteBlocked()
      await page.getByRole('radio', { name: 'Code', exact: true }).filter({ visible: true }).first().click()

      // B stops: its rows stay, grey, marked 不是实时, with no status word: never shown as live.
      await b.close()
      await lookAtB()
      await focusLocalWorkbench()
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
