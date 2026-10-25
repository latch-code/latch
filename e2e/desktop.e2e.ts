import { _electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSettings, WorkspaceInfo } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { FAKE_ACP_AGENT, testDeviceKey } from '@latch/testkit'
import { createOfflineTicket } from '@latch/host/auth'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { expectUnmovedByInjectedStyles } from './helpers/security.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { closeSettings, layersInWindow, openSection, openSettings } from './helpers/layout.ts'

const MARK_TOOL = 'mark_release'
const R2_PROMPT = '标记发布版本'
const SECRET_MARKERS = ['ldc1.', 'PRIVATE KEY']

/** What the test records in main instead of showing the open panel or Finder, and anything handed to openPath. */
interface FolderRecord {
  panels: unknown[]
  shown: string[]
  opened: string[]
}

/** What the preload exposes, as the page sees it. */
interface PageShell {
  kind: string
  devMode: boolean
  platform: string
  folders: {
    pick(projectId?: string | null, replaceFolderId?: string | null): Promise<unknown>
    drop(projectOrFiles: unknown, files?: unknown): Promise<unknown>
    reveal(projectId: unknown, folderId?: string | null): Promise<unknown>
    saveSessionFolder(sessionId: unknown): Promise<unknown>
  }
}

/** What the test records in main instead of showing the link dialog or opening the system browser. */
interface NativeSheets {
  asked: Array<Record<string, unknown>>
  finish?: (response: number) => void
}

interface ExternalLinks {
  asked: Array<Record<string, unknown>>
  opened: string[]
  answer: number
}

/** A local model that asks for one unlisted tool; the Host classifies unlisted tools as high risk. */
function markPlugin(marks: { ran: number }): HarnessPlugin {
  return {
    id: 'e2e-desktop',
    name: '桌面端测试工具',
    version: '1.0.0',
    description: '只在测试中使用。',
    activate(context) {
      context.registerTool({
        name: MARK_TOOL,
        description: '记录一次发布标记。',
        requiresApproval: false,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        async execute() {
          marks.ran++
          return { text: '已标记' }
        },
      })
      context.registerProvider({
        id: 'e2e-desktop',
        name: '桌面端测试模型',
        model: 'e2e',
        async *stream({ messages, tools }) {
          const lastUser = messages.findLastIndex(message => message.role === 'user')
          if (messages.slice(lastUser + 1).some(message => message.role === 'tool')) {
            yield { type: 'text', text: '已完成标记。' }
          } else if (tools.some(tool => tool.name === MARK_TOOL)) {
            yield { type: 'tool-call', call: { id: `call-${randomUUID()}`, name: MARK_TOOL, arguments: {} } }
            yield { type: 'finish', reason: 'tool-calls' }
            return
          } else yield { type: 'text', text: '没有可用的工具。' }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
}

/** A local OpenAI-compatible model service that lists one model; nothing else is asked of it here. */
async function localModels() {
  const listings: string[] = []
  const server = createHttpServer((request, response) => {
    listings.push(request.url ?? '')
    response.writeHead(request.url === '/v1/models' ? 200 : 404, { 'content-type': 'application/json' })
    response.end(request.url === '/v1/models' ? JSON.stringify({ data: [{ id: 'llama3' }] }) : '{}')
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address')
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    origin: `http://127.0.0.1:${address.port}`,
    allow: `127.0.0.1:${address.port}`,
    listings,
    close: () =>
      new Promise<void>(done => {
        server.closeAllConnections()
        server.close(() => done())
      }),
  }
}

/** Counts every TCP connection, so any request the renderer manages to send to loopback is visible. */
async function connectionCounter() {
  const sockets = new Set<Socket>()
  let connections = 0
  const server = createServer(socket => {
    connections++
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.destroy()
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address')
  return {
    port: address.port,
    connections: () => connections,
    close: () =>
      new Promise<void>(done => {
        for (const socket of sockets) socket.destroy()
        server.close(() => done())
      }),
  }
}

function shellEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition')
    await new Promise(done => setTimeout(done, 100))
  }
}

/** A capture of the window in light and then dark, as `test-results/<name>.png` and `<name>-dark.png`. */
async function captureThemes(page: Page, name: string) {
  await page.screenshot({ path: `test-results/${name}.png`, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: `test-results/${name}-dark.png`, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'light' })
}

/**
 * Captures the window at tablet width as well (the desktop window cannot be narrower than 760, so a confirmation never
 * shows at phone width), checks that nothing scrolls sideways there, then gives the window its size back.
 */
async function captureTablet(application: ElectronApplication, page: Page, name: string) {
  const size = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!
    const [width, height] = window.getSize()
    window.setSize(820, 780)
    return { width: width!, height: height! }
  })
  await waitFor(async () => (await page.evaluate(() => window.innerWidth)) <= 820)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await captureThemes(page, name)
  await application.evaluate(({ BrowserWindow }, { width, height }) => {
    BrowserWindow.getAllWindows()[0]!.setSize(width, height)
  }, size)
  await waitFor(async () => (await page.evaluate(() => window.innerWidth)) > 820)
}

/** An inline confirmation card's fold and the fade of its content. */
const CARD_FOLD =
  '.ui-collapse:has(> .ui-collapse-inner > .inline-confirm), .ui-collapse:has(> .ui-collapse-inner > .inline-confirm) > .ui-collapse-inner'

/** From now on, pauses the inline card's transitions within a frame of their start, so its arrival can be stepped through. */
async function holdCardFold(page: Page) {
  await page.evaluate(selector => {
    Reflect.set(globalThis, 'holdingCardFold', true)
    const tick = () => {
      if (Reflect.get(globalThis, 'holdingCardFold') !== true) return
      for (const animation of document.getAnimations()) {
        const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null
        if (target?.matches(selector) && animation.playState === 'running') animation.pause()
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, CARD_FOLD)
}

/**
 * The held arrival: the fold opens by its height on the entry curve while the card fades in; captures `target` with
 * them at 0, 60, 120 and 180 ms, then lets every transition finish.
 */
async function cardArrivalFrames(page: Page, target: Locator, name: string) {
  await page.waitForTimeout(400)
  const held = await page.evaluate(
    selector =>
      document
        .getAnimations()
        .filter(animation => animation.effect instanceof KeyframeEffect && animation.effect.target?.matches(selector))
        .map(animation => ({
          property: animation instanceof CSSTransition ? animation.transitionProperty : '',
          duration: Number(animation.effect!.getTiming().duration),
        }))
        .toSorted((a, b) => a.property.localeCompare(b.property)),
    CARD_FOLD,
  )
  expect(held).toEqual([
    { property: 'grid-template-rows', duration: 180 },
    { property: 'opacity', duration: 120 },
  ])
  for (const ms of [0, 60, 120, 180]) {
    await page.evaluate(
      ([selector, at]) => {
        for (const animation of document.getAnimations()) {
          const element = animation.effect instanceof KeyframeEffect ? animation.effect.target : null
          if (element?.matches(selector)) {
            animation.pause()
            animation.currentTime = at
          } else if (Number.isFinite(Number(animation.effect?.getComputedTiming().endTime))) animation.finish()
        }
      },
      [CARD_FOLD, ms] as const,
    )
    await target.screenshot({ path: `test-results/${name}-${ms}ms.png`, animations: 'allow' })
  }
  await page.evaluate(() => {
    Reflect.set(globalThis, 'holdingCardFold', false)
    for (const animation of document.getAnimations())
      if (Number.isFinite(Number(animation.effect?.getComputedTiming().endTime))) animation.finish()
  })
}

async function enrollShell(page: Page, testHost: TestHost, name: string) {
  await page.getByRole('heading', { name: '连接到 Latch' }).waitFor()
  const field = page.getByRole('textbox', { name: '设备名称' })
  await field.fill(name)
  await waitFor(async () => (await field.inputValue()) === name)
  await page.getByRole('button', { name: '请求本机确认' }).click()
  const request = await testHost.presence.waitForRequest(15_000)
  expect(request.preview.action).toBe('device.enroll')
  expect(request.preview.requester.listener).toBe('unix')
  const fingerprint = request.preview.lines.find(line => line.label === '设备指纹')?.value
  expect(fingerprint).toMatch(/^[A-Z2-7]{4}( [A-Z2-7]{4}){4}$/)
  await page.getByText(fingerprint!).first().waitFor()
  await page.screenshot({ path: 'test-results/native-desktop-enrollment.png', animations: 'disabled' })
  testHost.presence.approveNext()
  await page.locator('.app-shell[data-connection="connected"]').waitFor()
  return fingerprint!
}

describe.skipIf(process.env.HARNESS_ELECTRON_E2E !== '1' || process.platform !== 'darwin')('native desktop shell', () => {
  it('enrolls over host.sock, keeps credentials in main, confines the renderer and leaves the Host running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-'))
    const marks = { ran: 0 }
    // Moved forward later to make the Host ask for credential renewal; the shell keeps its own clock.
    let hostClockOffset = 0
    const testHost = await startTestHost({
      demo: true,
      uiDir: resolve('dist/web'),
      presenceMode: 'manual',
      plugins: [markPlugin(marks)],
      now: () => Date.now() + hostClockOffset,
      // An HTTPS entry, so the desktop app can pair a phone.
      tls: true,
      // No name resolves: a check of a preset provider's address never leaves this computer.
      egressLookup: (_hostname, _options, done) => done(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), []),
    })
    const { host } = testHost
    const counter = await connectionCounter()
    let application: ElectronApplication | undefined
    try {
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
      const userData = join(root, 'electron')
      await mkdir('test-results', { recursive: true })
      application = await _electron.launch({
        // The mock keychain keeps safeStorage away from the login keychain during tests.
        args: [
          resolve('apps/desktop/src/main.cjs'),
          `--latch-host-state=${join(testHost.dataDir, 'host.json')}`,
          `--latch-user-data=${userData}`,
          '--use-mock-keychain',
        ],
        cwd: process.cwd(),
        env: shellEnvironment(),
        timeout: 30_000,
      })
      const page = await application.firstWindow()
      page.setDefaultTimeout(20_000)
      expect(page.url()).toBe('latch://app/link/')
      // The shell's facts and its actions (functions, so only their names or types cross back here); nothing else.
      expect(
        await page.evaluate(() => {
          const shell = (globalThis as unknown as { latchShell: Record<string, unknown> }).latchShell
          const lifecycle = shell.lifecycle as Record<string, unknown>
          return {
            ...shell,
            folders: Object.keys(shell.folders as object),
            confirmations: Object.keys(shell.confirmations as object),
            files: Object.keys(shell.files as object),
            notifications: Object.keys(shell.notifications as object),
            openInBrowser: typeof shell.openInBrowser,
            lifecycle: Object.fromEntries(Object.entries(lifecycle).map(([name, value]) => [name, typeof value])),
          }
        }),
      ).toEqual({
        kind: 'electron',
        devMode: true,
        platform: 'darwin',
        folders: ['protocolVersion', 'pick', 'drop', 'reveal', 'saveSessionFolder'],
        confirmations: ['protocolVersion', 'confirm'],
        openInBrowser: 'function',
        lifecycle: { get: 'function', setLoginItem: 'function', setKeepAwake: 'function', restartHost: 'function', subscribe: 'function' },
        files: ['inspect', 'known', 'reveal', 'quickLook', 'open'],
        notifications: ['get', 'set', 'subscribe'],
      })

      const fingerprint = await enrollShell(page, testHost, '桌面端测试')
      const devices = host.security.devices.list()
      expect(devices).toHaveLength(1)
      const device = devices[0]!
      expect(device).toMatchObject({ name: '桌面端测试', status: 'active', listener: 'unix', fingerprint })
      expect([...device.scopes].sort()).toEqual(['admin', 'approve:elevated', 'approve:standard', 'run', 'secrets', 'view'])

      // The credential lives only in main, encrypted on disk; the renderer cannot see or renew it.
      const stored = join(userData, 'latch-devices', `${host.hostId}.json`)
      expect((await stat(stored)).mode & 0o777).toBe(0o600)
      const storedText = await readFile(stored, 'utf8')
      for (const marker of SECRET_MARKERS) expect(storedText).not.toContain(marker)
      const rendererState = await page.evaluate(async () => ({
        cookie: document.cookie,
        storage: JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
        databases: (await indexedDB.databases()).map(database => database.name),
        renew: (await fetch('/link/api/credentials/renew', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))
          .status,
      }))
      expect(rendererState.cookie).toBe('')
      expect(rendererState.storage).not.toContain('ldc1.')
      expect(rendererState.databases).not.toContain('latch-device')
      expect(rendererState.renew).toBe(403)

      // No network of its own: fetch, WebSocket and images outside latch: never leave the renderer.
      const blocked = await page.evaluate(async port => {
        const settle = (promise: Promise<unknown>) =>
          promise.then(
            () => 'loaded',
            () => 'blocked',
          )
        const image = (src: string) =>
          new Promise<string>(done => {
            const element = new Image()
            element.onload = () => done('loaded')
            element.onerror = () => done('blocked')
            element.src = src
          })
        const socket = (url: string) =>
          new Promise<string>(done => {
            try {
              const ws = new WebSocket(url)
              ws.onopen = () => {
                ws.close()
                done('loaded')
              }
              ws.onerror = () => done('blocked')
            } catch {
              done('blocked')
            }
          })
        return {
          https: await settle(fetch('https://example.com/')),
          loopback: await settle(fetch(`http://127.0.0.1:${port}/`)),
          loopbackTls: await settle(fetch(`https://127.0.0.1:${port}/`)),
          webSocket: await socket(`ws://127.0.0.1:${port}/`),
          image: await image(`https://127.0.0.1:${port}/pixel.png`),
          opened: window.open(`http://127.0.0.1:${port}/`) === null,
        }
      }, counter.port)
      expect(blocked).toEqual({
        https: 'blocked',
        loopback: 'blocked',
        loopbackTls: 'blocked',
        webSocket: 'blocked',
        image: 'blocked',
        opened: true,
      })
      expect(application.windows()).toHaveLength(1)
      expect(counter.connections()).toBe(0)

      // window.open from script reaches the system browser only after the owner confirms the full URL.
      // Main's native dialog and shell are recorded here instead of being shown or opened.
      await application.evaluate(({ dialog, shell, BrowserWindow }) => {
        // Headless automation does not own macOS focus; production focus checks are covered by unit tests.
        BrowserWindow.prototype.isFocused = () => true
        const links: ExternalLinks = { asked: [], opened: [], answer: 1 }
        const nativeSheets: NativeSheets = { asked: [] }
        Object.assign(globalThis, { externalLinks: links, nativeSheets })
        dialog.showMessageBox = (async (...args: unknown[]) => {
          const options = args.at(-1) as Record<string, unknown>
          if (options.title === 'Latch · 本机确认') {
            nativeSheets.asked.push(options)
            return new Promise<{ response: number; checkboxChecked: boolean }>(resolve => {
              nativeSheets.finish = response => resolve({ response, checkboxChecked: false })
            })
          }
          links.asked.push(options)
          return { response: links.answer, checkboxChecked: false }
        }) as typeof dialog.showMessageBox
        shell.openExternal = async (url: string) => {
          links.opened.push(url)
        }
      })
      const externalLinks = () => application!.evaluate(() => (globalThis as unknown as { externalLinks: ExternalLinks }).externalLinks)
      const link = 'https://example.invalid/docs?from=latch#intro'
      const openLink = (url: string) => page.evaluate(target => window.open(target) === null, url)
      expect(await openLink(link)).toBe(true)
      await waitFor(async () => (await externalLinks()).asked.length === 1)
      expect((await externalLinks()).asked[0]).toMatchObject({
        message: '在浏览器中打开以下链接？',
        detail: link,
        buttons: ['打开', '取消'],
        defaultId: 1,
        cancelId: 1,
      })
      expect((await externalLinks()).opened).toEqual([])
      await application.evaluate(() => {
        ;(globalThis as unknown as { externalLinks: ExternalLinks }).externalLinks.answer = 0
      })
      expect(await openLink(link)).toBe(true)
      await waitFor(async () => (await externalLinks()).opened.length === 1)
      expect((await externalLinks()).opened).toEqual([link])
      expect(await openLink(`http://127.0.0.1:${counter.port}/`)).toBe(true)
      await new Promise(done => setTimeout(done, 300))
      expect((await externalLinks()).asked).toHaveLength(2)
      expect(application.windows()).toHaveLength(1)
      expect(counter.connections()).toBe(0)

      // 「在这台电脑的浏览器中打开」: main gets a one-time loopback invitation with the shell's credential and gives the
      // link to the default browser (recorded instead of opened) without a dialog; the page never sees the invitation.
      const browserHere = await openSettings(page, '设备')
      await browserHere.getByRole('heading', { name: '这台电脑的浏览器', exact: true }).waitFor()
      await browserHere.getByRole('button', { name: '在这台电脑的浏览器中打开', exact: true }).click()
      await waitFor(async () => (await externalLinks()).opened.length === 2)
      const browserLink = (await externalLinks()).opened[1]
      expect(browserLink).toMatch(new RegExp(`^${host.loopbackOrigin}/link/#pair=lpi1-[A-Z2-7]{26}$`))
      expect((await externalLinks()).asked).toHaveLength(2)
      await browserHere.getByText('已在浏览器中打开。在浏览器中提交登记后，这台电脑会显示确认窗口。', { exact: true }).waitFor()
      expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain('lpi1-')
      await page.screenshot({ path: 'test-results/native-desktop-browser-here.png', animations: 'disabled' })
      // It hands out an invitation like 手机配对 beside it, so the words of both groups keep their look under styles added
      // to the page.
      await page.mouse.move(0, 0)
      await expectUnmovedByInjectedStyles(page, [
        '.settings-group[data-secure] .settings-group-head h3',
        '.settings-group[data-secure] .settings-row-title',
        '.settings-group[data-secure] .settings-row-description',
        '.settings-group[data-secure] .ui-button',
        '.settings-group[data-secure] .settings-caption',
        '.settings-group[data-secure] .settings-caption [role="status"]',
      ])
      // That link enrolls a browser over loopback only, and the confirmation names this desktop as the inviter.
      const pair = new URL(browserLink).hash.slice('#pair='.length)
      const enrollBrowser = () =>
        testHost.raw('loopback-tcp', 'api/enrollments', {
          method: 'POST',
          body: { publicKey: testDeviceKey().spki, name: '这台电脑的浏览器', invitation: pair },
        })
      expect((await enrollBrowser()).status).toBe(202)
      const invited = await testHost.presence.waitForRequest(15_000)
      expect(invited.preview.requester.listener).toBe('loopback-tcp')
      expect(invited.preview.lines.at(-1)).toEqual({ label: '邀请来源', value: '桌面端测试' })
      testHost.presence.denyNext()
      // Single use: the same link does not work twice.
      expect((await enrollBrowser()).status).toBe(403)
      await closeSettings(browserHere)

      await page.getByTestId('dev-mode').waitFor()

      // A Standard session with the demo tool runs through the proxied API and event stream.
      await page.getByRole('textbox', { name: '新会话消息' }).fill('运行可取消长任务')
      await page.getByRole('button', { name: '发送', exact: true }).click()
      await waitFor(async () => (await host.bridge.listTasks()).length === 1)
      const longTask = (await host.bridge.listTasks())[0]!
      await waitFor(async () =>
        (await host.bridge.detail(longTask.id)).messages.some(message => message.role === 'tool' && message.state === 'running'),
      )
      await page.screenshot({ path: 'test-results/native-desktop.png', animations: 'disabled' })

      // Settings › 通用: main keeps the Mac awake while the session runs (it reads host-info over host.sock every few
      // seconds). The login item needs a packaged app, so a development run shows why it is off. The test Host was not
      // started by the desktop app, so main says it will not start it again after a crash.
      const general = await openSettings(page, '设置')
      await openSection(general, '通用')
      const background = general.getByRole('region', { name: '后台运行', exact: true })
      const loginItem = background.getByRole('switch', { name: '让 Latch 在后台运行，手机随时能连上这台 Mac', exact: true })
      await loginItem.waitFor()
      expect(await loginItem.getAttribute('aria-checked')).toBe('false')
      expect(await loginItem.getAttribute('aria-disabled')).toBe('true')
      await background
        .getByText('只有打包后的 Latch 应用能登记为登录项。当前是开发运行（pnpm desktop），打包版本尚未提供。', { exact: true })
        .waitFor()
      const keepAwake = background.getByRole('switch', { name: '有任务时保持唤醒', exact: true })
      expect(await keepAwake.getAttribute('aria-checked')).toBe('true')
      await background.getByText('保持唤醒中：有会话正在运行。显示器仍按系统设置熄灭。', { exact: true }).waitFor({ timeout: 20_000 })
      await background.getByText('Latch Host 运行中。它不是由 Latch 桌面端启动的，意外退出后不会自动重新启动。', { exact: true }).waitFor()
      expect(await background.getByRole('button', { name: '重新启动 Host', exact: true }).count()).toBe(0)
      await page.screenshot({ path: 'test-results/native-desktop-background.png', animations: 'disabled' })
      // What stays out of Time Machine, at the end of the section, in light and dark.
      const backupHint = background.getByText(/^模型密钥、Agent 定义（含环境变量）与项目列表、设备登记和 Host 身份不进入时间机器备份/u)
      await backupHint.scrollIntoViewIfNeeded()
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme })
        await page.screenshot({ path: `test-results/native-desktop-background-end-${scheme}.png`, animations: 'disabled' })
      }
      await page.emulateMedia({ colorScheme: 'light' })
      // Turning it off releases the Mac at once and is remembered in the shell's own data directory.
      await keepAwake.click()
      await background.getByText('已关闭：有任务时电脑也会按系统设置休眠。', { exact: true }).waitFor()
      expect(JSON.parse(await readFile(join(userData, 'lifecycle.json'), 'utf8'))).toEqual({ version: 1, keepAwake: false })
      await keepAwake.click()
      await background.getByText('保持唤醒中：有会话正在运行。显示器仍按系统设置熄灭。', { exact: true }).waitFor()
      await closeSettings(general)
      // The footer says so in a few quiet words, whole at the window's default width (a 248px sidebar with 开发版), with
      // the reason in the title and the target still reaching past the 16px line.
      const awake = page.locator('.sidebar-footer').getByRole('button', { name: '保持唤醒中', exact: true })
      await awake.waitFor()
      expect(await awake.getAttribute('title')).toBe('保持唤醒中：有会话正在运行。显示器仍按系统设置熄灭。 · 同步最新状态')
      expect(
        await awake.evaluate(element => {
          // The words against the button's own box: scrollWidth would also count the ::before that reaches past it.
          const words = document.createRange()
          words.selectNodeContents(element)
          return {
            whole: words.getBoundingClientRect().width <= element.getBoundingClientRect().width + 0.5,
            overflow: getComputedStyle(element).overflow,
            target: element.getBoundingClientRect().height - 2 * Number.parseFloat(getComputedStyle(element, '::before').bottom),
          }
        }),
      ).toEqual({ whole: true, overflow: 'visible', target: 24 })
      await page.locator('.sidebar-footer').screenshot({ path: 'test-results/native-desktop-keep-awake.png', animations: 'disabled' })
      // The page cannot report sleep or a stop for main.
      expect(
        await page.evaluate(
          async () =>
            (
              await fetch('/link/api/host/state', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{"state":"sleeping"}',
              })
            ).status,
        ),
      ).toBe(403)
      // Main itself reports the Mac going to sleep over host.sock (powerMonitor 'suspend'): the Host announces it on the
      // page's stream and the page names it. This Host never slept, so after 'resume' the page's next attempt connects.
      const banner = page.locator('.banner-region')
      await application.evaluate(({ powerMonitor }) => {
        powerMonitor.emit('suspend')
      })
      await banner.getByText(/^电脑已休眠（\d{2}:\d{2} 起）$/u).waitFor()
      await application.evaluate(({ powerMonitor }) => {
        powerMonitor.emit('resume')
      })
      await page.locator('.app-shell[data-connection="connected"]').waitFor({ timeout: 30_000 })
      await banner.getByText(/^电脑已休眠/u).waitFor({ state: 'detached' })

      // High-risk approval: allowed only after the local confirmation, which the card itself shows.
      const { sessionId } = await host.bridge.createTask({
        prompt: R2_PROMPT,
        requestId: randomUUID(),
        mode: 'agent',
        model: { providerId: 'e2e-desktop', model: 'e2e' },
      })
      await waitFor(() => host.bridge.approvals().some(approval => approval.sessionId === sessionId))
      await page.getByText(R2_PROMPT).first().click()
      await page.getByText('高风险').first().waitFor()
      const card = page.locator('[data-approval-id]')
      const allow = card.getByRole('button', { name: '在本机允许', exact: true })
      const resting = (await allow.boundingBox())!.width
      await allow.click()
      const nativeSheets = () => application!.evaluate(() => (globalThis as unknown as { nativeSheets: NativeSheets }).nativeSheets.asked)
      await waitFor(async () => (await nativeSheets()).length === 1)
      const confirmation = { preview: { reason: (await nativeSheets())[0]!.message as string } }
      expect((await nativeSheets())[0]).toMatchObject({ defaultId: 0, cancelId: 0, buttons: ['取消', '允许'] })
      expect((await nativeSheets())[0]!.detail).toContain(MARK_TOOL)
      // No dock: the button keeps its words and width while it waits; the card says Touch ID waits and shows the very
      // sentence the system sheet shows, with the Host's details behind it.
      await card.locator('.ui-button[aria-busy="true"]', { hasText: '在本机允许' }).waitFor()
      await card.getByText('等待本机确认…', { exact: true }).waitFor()
      await card.locator('.confirm-sheet-text', { hasText: confirmation.preview.reason }).waitFor()
      expect(confirmation.preview.reason).toMatch(/^批准/u)
      await card.getByRole('button', { name: '确认详情', exact: true }).waitFor()
      expect(await page.locator('.presence-dock').count()).toBe(0)
      expect(Math.abs((await allow.boundingBox())!.width - resting)).toBeLessThanOrEqual(1)
      await captureThemes(page, 'native-desktop-confirmation')
      await captureTablet(application, page, 'native-tablet-confirmation')
      await card.locator('.confirm-sheet-text', { hasText: confirmation.preview.reason }).waitFor()
      // The card keeps its look under styles added to the page while it waits.
      await expectUnmovedByInjectedStyles(page, [
        '[data-approval-id] .tool-card-header .ui-status-pill',
        '[data-approval-id] .approval-footnote',
        '[data-approval-id] .confirm-sheet-text',
        '[data-approval-id] .ui-button',
      ])
      // A denial returns the buttons at once with the reason in the card; nothing ran.
      expect(marks.ran).toBe(0)
      await application.evaluate(() => (globalThis as unknown as { nativeSheets: NativeSheets }).nativeSheets.finish?.(0))
      await card.locator('.ui-button[aria-busy="true"]').waitFor({ state: 'detached' })
      expect(await card.locator('.ui-button[aria-disabled="true"]').count()).toBe(0)
      await captureThemes(page, 'native-desktop-confirmation-denied')
      expect(marks.ran).toBe(0)
      // Allowing again from the card asks for a new confirmation of the same request.
      expect(marks.ran).toBe(0)
      await allow.click()
      await waitFor(async () => (await nativeSheets()).length === 2)
      await card.locator('.approval-failure').waitFor({ state: 'detached' })
      await application.evaluate(() => (globalThis as unknown as { nativeSheets: NativeSheets }).nativeSheets.finish?.(1))
      await waitFor(() => marks.ran === 1)
      await waitFor(async () => (await host.bridge.detail(sessionId)).summary.status === 'idle')

      // 设置 › 设备: pairing a phone over the HTTPS entry, and the confirmation of an action that does not show it in
      // place yet (the dock).
      const phone = await testHost.enroll({ name: '测试手机', scopes: ['view'] })
      const settings = await openSettings(page, '设备')
      const pairing = settings.locator('.pair-section')
      // The panel's end in view, so each capture shows all of it.
      const showPairing = () => pairing.evaluate(element => element.scrollIntoView({ block: 'end' }))
      await pairing.getByRole('button', { name: '生成配对二维码', exact: true }).waitFor()
      await showPairing()
      await captureThemes(page, 'native-desktop-pairing')
      await pairing.getByRole('button', { name: '生成配对二维码', exact: true }).click()
      const qr = pairing.getByRole('img', { name: '手机配对二维码', exact: true })
      await qr.waitFor()
      await pairing.getByRole('timer').waitFor()
      // The QR code carries the invitation, which never enters a screenshot, even a test Host's: the capture shows a
      // fixed pattern of the same size and colours in its place.
      const maskQr = () =>
        qr.evaluate(async (image: HTMLImageElement) => {
          const modules = 29
          const canvas = document.createElement('canvas')
          canvas.width = canvas.height = 400
          const context = canvas.getContext('2d')!
          context.fillStyle = '#ffffff'
          context.fillRect(0, 0, 400, 400)
          context.fillStyle = '#1d1c1a'
          const cell = 400 / (modules + 2)
          let seed = 7
          for (let y = 0; y < modules; y++)
            for (let x = 0; x < modules; x++) {
              seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
              const finder = (x < 8 && y < 8) || (x >= modules - 8 && y < 8) || (x < 8 && y >= modules - 8)
              // A high bit of the generator: its low bits only alternate.
              if (!finder && (seed >> 16) % 2 === 0) context.fillRect((x + 1) * cell, (y + 1) * cell, cell, cell)
            }
          for (const [x, y] of [
            [0, 0],
            [modules - 7, 0],
            [0, modules - 7],
          ] as const) {
            context.fillRect((x + 1) * cell, (y + 1) * cell, 7 * cell, 7 * cell)
            context.fillStyle = '#ffffff'
            context.fillRect((x + 2) * cell, (y + 2) * cell, 5 * cell, 5 * cell)
            context.fillStyle = '#1d1c1a'
            context.fillRect((x + 3) * cell, (y + 3) * cell, 3 * cell, 3 * cell)
          }
          image.src = canvas.toDataURL('image/png')
          await image.decode()
        })
      await maskQr()
      await showPairing()
      await captureThemes(page, 'native-desktop-pairing-ready')
      // Ten minutes later on this computer's clock: the code has lapsed and the panel offers a new one.
      await page.evaluate('globalThis.latchRealNow = Date.now; Date.now = () => globalThis.latchRealNow() + 11 * 60 * 1000')
      await pairing.getByText('上一个二维码已过期。', { exact: true }).waitFor()
      await showPairing()
      await captureThemes(page, 'native-desktop-pairing-expired')
      await page.evaluate('Date.now = globalThis.latchRealNow')
      // A device that used an invitation waits in the panel with its fingerprint, to compare with its own screen while
      // the system sheet names the same one; a denial takes it away.
      const invitation = await testHost.invite(['view'])
      const asked = await testHost.raw('tls', 'api/enrollments', {
        method: 'POST',
        body: { publicKey: testDeviceKey().spki, name: '新手机', invitation: invitation.code },
      })
      const { enrollment } = (await asked.json()) as { enrollment: { fingerprint: string; reason: string } }
      const enrolling = await testHost.presence.waitForRequest(15_000)
      expect(enrolling.preview.reason).toBe(enrollment.reason)
      const waitingDevice = pairing.locator('.pair-waiting')
      await waitingDevice.getByLabel(`设备指纹 ${enrollment.fingerprint}`, { exact: true }).waitFor()
      await waitingDevice.getByText('正在请求连接', { exact: false }).waitFor()
      // The panel came back from its expired state with the real code: masked again before the capture.
      await maskQr()
      await showPairing()
      await captureThemes(page, 'native-desktop-pairing-waiting')
      testHost.presence.denyNext()
      await waitingDevice.waitFor({ state: 'detached' })
      expect(phone.device.scopes).toEqual(['view'])
      // A device's actions are in its row's ⋯ menu.
      const row = settings.locator(`[data-device-id="${phone.device.id}"]`)
      await row.getByRole('button', { name: '测试手机 的操作', exact: true }).click()
      await page.getByRole('menuitem', { name: '调整权限…', exact: true }).click()
      const grant = page.getByRole('dialog', { name: '调整权限', exact: true })
      await grant.getByRole('checkbox', { name: '发起和继续会话', exact: true }).check()
      await holdCardFold(page)
      await grant.getByRole('button', { name: '用 Touch ID 授予', exact: true }).click()
      const granting = await testHost.presence.waitForRequest(15_000)
      expect(granting.preview.action).toBe('device.grant')
      // The card arrives by opening its fold under the field while it fades in; nothing above it moves.
      await grant.locator('.inline-confirm').waitFor({ state: 'attached' })
      await cardArrivalFrames(page, grant, 'native-desktop-confirmation-arrival')
      // The grant is confirmed inside its own dialog: no dock over it, no countdown (the system sheet times out on its own).
      const inline = grant.locator('.inline-confirm[data-confirmation-phase="waiting"]')
      await inline.waitFor()
      await inline.locator('.confirm-sheet-text', { hasText: granting.preview.reason }).waitFor()
      await expect.poll(() => inline.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
      expect(await page.locator('.presence-dock').count()).toBe(0)
      expect(await inline.getByRole('timer').count()).toBe(0)
      await captureThemes(page, 'native-desktop-confirmation-grant')
      await expectUnmovedByInjectedStyles(page, [
        '.inline-confirm[data-secure]',
        '.inline-confirm .confirm-title',
        '.inline-confirm .confirm-sheet-text',
        '.inline-confirm .ui-button',
      ])
      testHost.presence.denyNext()
      const failed = grant.locator('.inline-confirm[data-confirmation-phase="failed"]', { hasText: '操作没有执行。本机确认没有通过。' })
      await failed.waitFor()
      // One line with 关闭: the grant is asked for again from its own button.
      expect(await failed.getByRole('button').count()).toBe(1)
      await captureThemes(page, 'native-desktop-confirmation-grant-failed')
      await failed.getByRole('button', { name: '关闭', exact: true }).click()
      await failed.waitFor({ state: 'detached' })
      await grant.getByRole('button', { name: '取消', exact: true }).click()
      expect(host.security.devices.get(phone.device.id)?.scopes).toEqual(['view'])
      await closeSettings(settings)

      // A full-access agent's question: advisory, and on the Host's own desktop it may be answered with 允许一次.
      const policy = () => host.security.policy.get()
      const helper = await testHost.enroll({ listener: 'unix', name: '本机测试设备' })
      const saved = await helper.confirmed('agents', {
        method: 'POST',
        body: { name: 'Fake Agent', command: process.execPath, args: [FAKE_ACP_AGENT], env: {} },
      })
      expect(saved.status).toBe(201)
      const { agent }: { agent: AgentSettings } = await saved.json()
      const started = await helper.confirmed('tasks', {
        method: 'POST',
        body: { prompt: 'permission', requestId: randomUUID(), mode: 'agent', harnessId: agent.id },
      })
      expect(started.status).toBe(201)
      const { sessionId: advisoryId }: { sessionId: string } = await started.json()
      await waitFor(() => host.bridge.approvals().some(approval => approval.sessionId === advisoryId))
      await page.locator(`[data-task-id="${advisoryId}"]`).click()
      const advisory = page.locator('[data-approval-id]')
      await advisory.getByText('仅提示', { exact: true }).waitFor()
      await advisory.locator('.ui-button[data-variant="primary"]', { hasText: '允许一次' }).waitFor()
      expect(
        await advisory
          .getByRole('button')
          .filter({ hasText: /^(拒绝|允许一次)$/ })
          .allInnerTexts(),
      ).toEqual(['拒绝', '允许一次'])
      expect(await advisory.locator('.approval-more').count()).toBe(0)
      await captureThemes(page, 'native-desktop-advisory')

      // While it waits for an answer, a confirmation that would outlive the session is held back, and the dock where it
      // was asked for names the session: 查看会话 leaves settings for it.
      const advisoryTitle = (await host.bridge.detail(advisoryId)).summary.title
      const confirmationsBefore = testHost.presence.requests.length
      await page.locator('#session-navigation').getByRole('button', { name: '设置', exact: true }).click()
      const heldBack = page.getByRole('dialog', { name: '设置', exact: true })
      await heldBack.getByRole('tab', { name: '电脑', exact: true }).click()
      await heldBack.getByRole('button', { name: '添加…', exact: true }).click()
      const allowAddress = page.getByRole('dialog', { name: '加入出站白名单', exact: true })
      await allowAddress.getByRole('textbox', { name: '地址' }).fill('127.0.0.1:9')
      await allowAddress.getByRole('button', { name: '加入', exact: true }).click()
      const blockedDock = page.locator('.inline-confirm[data-confirmation-phase="paused"]')
      await blockedDock.waitFor()
      expect(await blockedDock.getAttribute('data-paused-reason')).toBe('blocked')
      expect(await blockedDock.locator('.ui-notice-text').innerText()).toBe(
        `要等「${advisoryTitle}」（Fake Agent）结束，才能放宽安全策略。`,
      )
      expect(await blockedDock.getByRole('button').count()).toBe(3)
      for (const name of ['查看会话', '停止会话', '关闭']) await blockedDock.getByRole('button', { name, exact: true }).waitFor()
      expect(testHost.presence.requests.length).toBe(confirmationsBefore)
      await captureThemes(page, 'native-desktop-confirmation-blocked')
      await expectUnmovedByInjectedStyles(page, ['.inline-confirm', '.inline-confirm .ui-notice', '.inline-confirm .ui-button'])
      await blockedDock.getByRole('button', { name: '查看会话', exact: true }).click()
      await blockedDock.waitFor({ state: 'detached' })
      await heldBack.waitFor({ state: 'detached' })
      await advisory.getByText('仅提示', { exact: true }).waitFor()
      expect(policy().hostEgressAllow).not.toContain('127.0.0.1:9')

      await advisory.getByRole('button', { name: '拒绝', exact: true }).click()
      await waitFor(async () => (await host.bridge.detail(advisoryId)).summary.status === 'idle')

      // A full-access start from the composer, of an agent saved without any confirmation: before Touch ID the card
      // above the input shows the sentence the system sheet shows, the Host's two warnings, and, as the first start of
      // this command, the details open with the command and the folder; no dock.
      const second = await helper.request('agents', {
        method: 'POST',
        body: { name: 'Second Agent', command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_MARK: 'second' } },
      })
      expect(second.status).toBe(201)
      const { agent: secondAgent }: { agent: AgentSettings } = await second.json()
      await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
      await page.getByRole('radio', { name: /Second Agent/ }).click()
      await page.getByRole('textbox', { name: '新会话消息' }).fill('echo 开始')
      await page.getByRole('button', { name: '开始会话', exact: true }).click()
      const start = await testHost.presence.waitForRequest(15_000)
      expect(start.preview.action).toBe('task.start-l3')
      expect(start.preview.subject.form).toBe('start.first-custom')
      expect(start.preview.reason).toMatch(/^首次以完全访问启动 Second Agent（在启动目录）：自定义命令 \S*node /u)
      const startCard = page.locator('.composer-confirm .inline-confirm[data-confirmation-phase="waiting"]')
      await startCard.waitFor()
      await startCard.locator('.confirm-sheet-text', { hasText: start.preview.reason }).waitFor()
      expect(start.preview.warnings).toHaveLength(2)
      for (const warning of start.preview.warnings) await startCard.getByText(warning, { exact: true }).waitFor()
      const command = start.preview.lines.find(line => line.label === '命令')!.value
      const folder = start.preview.lines.find(line => line.label === '工作目录')!.value
      await startCard.locator('.confirm-details-row', { hasText: '命令' }).getByText(command, { exact: true }).waitFor()
      await startCard.locator('.confirm-details-row', { hasText: '工作目录' }).getByText(folder, { exact: true }).waitFor()
      for (const note of start.preview.lines.filter(line => line.label === '说明'))
        await startCard.getByText(note.value, { exact: true }).waitFor()
      expect(await page.locator('.presence-dock').count()).toBe(0)
      await captureThemes(page, 'native-desktop-start-confirmation')
      await captureTablet(application, page, 'native-tablet-start-confirmation')
      await startCard.locator('.confirm-sheet-text', { hasText: start.preview.reason }).waitFor()
      testHost.presence.approveNext()
      await startCard.waitFor({ state: 'detached' })
      await waitFor(async () => (await host.bridge.listTasks()).some(task => task.harnessId === secondAgent.id))
      // A running agent holds a raise back too; 停止会话 in the dock ends it (this one stops at once when asked), and the
      // raise then asks for confirmation.
      const hanging = await helper.confirmed('tasks', {
        method: 'POST',
        body: { prompt: 'endturn', requestId: randomUUID(), mode: 'agent', harnessId: agent.id },
      })
      expect(hanging.status).toBe(201)
      const { sessionId: hangId }: { sessionId: string } = await hanging.json()
      await waitFor(async () => (await host.bridge.detail(hangId)).summary.status === 'running')
      const hangTitle = (await host.bridge.detail(hangId)).summary.title

      // 设置 › 电脑 in the desktop app: lowering applies at once, raising takes the local confirmation.
      await page.locator('#session-navigation').getByRole('button', { name: '设置', exact: true }).click()
      const computer = page.getByRole('dialog', { name: '设置', exact: true })
      // Pairing starts here, so this is where the running agent that would hold a phone back is named.
      await computer.getByRole('tab', { name: '设备', exact: true }).click()
      await computer
        .getByText(`要等「${hangTitle}」（Fake Agent）结束，才能配对新设备。`, {
          exact: true,
        })
        .waitFor()
      // One sentence, and both ways out: open the session, or stop it.
      const pairingBlocked = computer.locator('.ui-notice', { hasText: `要等「${hangTitle}」` })
      expect(await pairingBlocked.getByRole('button').allInnerTexts()).toEqual(['查看会话', '停止会话'])
      await computer.getByRole('button', { name: '生成配对二维码', exact: true }).scrollIntoViewIfNeeded()
      await captureThemes(page, 'native-desktop-pairing-blocked')
      await computer.getByRole('tab', { name: '电脑', exact: true }).click()
      await computer.getByRole('button', { name: '在这台电脑上发起：完全访问', exact: true }).click()
      await page.getByRole('menuitemradio', { name: /^逐项询问/ }).click()
      await waitFor(() => !policy().local.allowL3)
      expect(policy().local).toEqual({ maxLevel: 'L1', allowL3: false })
      await computer.getByRole('button', { name: '在这台电脑上发起：逐项询问', exact: true }).click()
      await page.getByRole('menuitemradio', { name: /^完全访问/ }).click()
      await blockedDock.waitFor()
      expect(await blockedDock.getAttribute('data-paused-reason')).toBe('blocked')
      expect(await blockedDock.locator('.ui-notice-text').innerText()).toBe(`要等「${hangTitle}」（Fake Agent）结束，才能放宽安全策略。`)
      await blockedDock.getByRole('button', { name: '停止会话', exact: true }).click()
      await expect
        .poll(async () => ({ status: (await host.bridge.detail(hangId)).summary.status, text: await blockedDock.innerText() }), {
          timeout: 15_000,
        })
        .toMatchObject({ status: 'cancelled', text: expect.stringContaining(`「${hangTitle}」已经结束。`) })
      await blockedDock.getByText('可以再试一次了', { exact: true }).waitFor()
      expect(await blockedDock.getByRole('button').allInnerTexts()).toEqual(['好'])
      await captureThemes(page, 'native-desktop-confirmation-blocked-ended')
      await blockedDock.getByRole('button', { name: '好', exact: true }).click()
      await blockedDock.waitFor({ state: 'detached' })
      expect(policy().local.allowL3).toBe(false)
      await computer.getByRole('button', { name: '在这台电脑上发起：逐项询问', exact: true }).click()
      await page.getByRole('menuitemradio', { name: /^完全访问/ }).click()
      const raise = await testHost.presence.waitForRequest(15_000)
      expect(raise.preview.action).toBe('policy.change')
      expect(raise.preview.requester.listener).toBe('unix')
      // The confirmation waits in the card right under the ceilings, never in a dock.
      await page.locator('.inline-confirm[data-confirmation-phase="waiting"]').waitFor()
      expect(await page.locator('.presence-dock').count()).toBe(0)
      await computer.getByRole('button', { name: '在这台电脑上发起：等待验证…', exact: true }).waitFor()
      expect(policy().local.allowL3).toBe(false)
      testHost.presence.approveNext()
      await waitFor(() => policy().local.allowL3)
      expect(policy().local).toEqual({ maxLevel: 'L1', allowL3: true })
      await computer.getByRole('button', { name: '在这台电脑上发起：完全访问', exact: true }).waitFor()
      await page.screenshot({ path: 'test-results/native-desktop-computer.png', animations: 'disabled' })

      // The egress allow list takes an address only here; the dialog opens from the group's 添加….
      await computer.getByRole('button', { name: '添加…', exact: true }).click()
      await page.getByRole('dialog', { name: '加入出站白名单', exact: true }).waitFor()
      await page.screenshot({ path: 'test-results/native-desktop-egress.png', animations: 'disabled' })
      await page.keyboard.press('Escape')
      await page.getByRole('dialog', { name: '加入出站白名单', exact: true }).waitFor({ state: 'hidden' })

      // 设置 › 模型服务: a preset provider's key saves without a confirmation; a local address is confirmed once,
      // before its models are listed, and saving the service there then asks nothing more.
      const models = await localModels()
      try {
        const asked = testHost.presence.requests.length
        await computer.getByRole('tab', { name: '模型服务', exact: true }).click()
        await computer.getByRole('button', { name: '添加服务…', exact: true }).click()
        await computer.getByRole('button', { name: /^DeepSeek/ }).click()
        await computer.getByLabel('API Key', { exact: true }).fill('sk-e2e-preset-key')
        const manual = computer.getByLabel('手动添加模型 ID', { exact: true })
        await manual.fill('deepseek-chat')
        await manual.press('Enter')
        await computer.getByRole('button', { name: '保存服务', exact: true }).click()
        await computer.getByRole('heading', { name: 'DeepSeek', exact: true }).waitFor()
        expect(testHost.presence.requests.length).toBe(asked)
        expect(host.config.provider('deepseek')).toMatchObject({ apiKey: 'sk-e2e-preset-key', keyOrigin: 'https://api.deepseek.com:443' })
        expect(host.security.audit.lastOf('provider.secret.set')).toMatchObject({ stepup: 'none', actor: { listener: 'unix' } })
        // The key's scope is shown without the port https implies.
        await computer.getByText('只发往 https://api.deepseek.com/v1', { exact: true }).waitFor()
        // Checked at once after saving; here the name does not resolve, and the reason is one sentence.
        await computer.getByText('Host 找不到这个域名。检查地址的拼写和网络。', { exact: true }).waitFor()
        await captureThemes(page, 'native-desktop-provider-preset')

        await computer.getByRole('button', { name: '模型服务', exact: true }).click()
        await computer.getByRole('button', { name: '添加服务…', exact: true }).click()
        await computer.getByRole('button', { name: /^Ollama/ }).click()
        await computer.getByLabel('API 地址', { exact: true }).fill(models.baseURL)
        await computer.getByRole('button', { name: '用 Touch ID 保存', exact: true }).waitFor()
        await computer.getByText('第一次使用这个地址：保存时在这台电脑上用 Touch ID 确认一次，之后不再询问。', { exact: true }).waitFor()
        // Listing a local address waits for its confirmation; the save button is the one lock on screen.
        await computer.getByRole('button', { name: '获取模型', exact: true }).click()
        await computer.getByText(`这个地址在本机或局域网。保存时会一并确认，允许 Host 访问 ${models.allow}。`, { exact: true }).waitFor()
        expect(await computer.getByRole('button', { name: /Touch ID/u }).allInnerTexts()).toEqual(['用 Touch ID 保存'])
        await captureThemes(page, 'native-desktop-provider-local-address')
        // One press: the confirmation, then the listing, and a single model saves at once.
        await computer.getByRole('button', { name: '用 Touch ID 保存', exact: true }).click()
        const confirmation = await testHost.presence.waitForRequest(15_000)
        await computer.getByRole('button', { name: '等待 Touch ID…', exact: true }).waitFor()
        await page.screenshot({ path: 'test-results/native-desktop-provider-waiting.png', animations: 'disabled' })
        expect(confirmation.preview).toMatchObject({ action: 'provider.confirm-origin', title: `确认模型服务地址 ${models.allow}` })
        expect(confirmation.preview.lines).toContainEqual({
          label: '出站许可',
          value: `允许 Host 访问 ${models.allow}（这台电脑上的地址）`,
        })
        expect(models.listings).toEqual([])
        testHost.presence.approveNext()
        await computer.getByRole('heading', { name: 'Ollama', exact: true }).waitFor()
        expect(host.config.provider('ollama')).toMatchObject({ baseURL: models.baseURL, models: ['llama3'], defaultModel: 'llama3' })
        await computer.getByText('连接正常', { exact: false }).waitFor()
        expect(testHost.presence.requests.length).toBe(asked + 1)
        expect(policy()).toMatchObject({ confirmedAddresses: [models.baseURL], hostEgressAllow: [models.allow] })
        await captureThemes(page, 'native-desktop-provider-local')

        // The composer uses the same form for a custom service, including manual model IDs. Saving stays in this
        // picker, confirms the new address once, and selects the saved model without opening settings.
        await closeSettings(computer)
        await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
        await page.getByRole('radio', { name: /^Latch 内置\s*只对话$/ }).click()
        await page.getByRole('button', { name: /^模型：/ }).click()
        await page.getByRole('menuitem', { name: '添加模型服务…', exact: true }).click()
        await page
          .getByRole('region', { name: '添加模型服务', exact: true })
          .getByRole('button', { name: '其他服务…', exact: true })
          .click()
        const custom = page.getByRole('region', { name: '自定义 OpenAI 兼容', exact: true })
        const customURL = `${models.origin}/custom/v1`
        await custom.getByLabel('名称', { exact: true }).fill('本机自定义模型')
        await custom.getByLabel('API 地址', { exact: true }).fill(customURL)
        const customModel = custom.getByLabel('手动添加模型 ID', { exact: true })
        await customModel.fill('local-custom')
        await customModel.press('Enter')
        await layersInWindow(page)
        await captureThemes(page, 'native-desktop-composer-provider-custom')
        await custom.getByRole('button', { name: '用 Touch ID 保存并使用', exact: true }).click()
        const customConfirmation = await testHost.presence.waitForRequest(15_000)
        expect(customConfirmation.preview).toMatchObject({ action: 'provider.confirm-origin', subject: { form: 'origin.confirm' } })
        expect(customConfirmation.preview.reason).toContain(customURL)
        await custom.locator('.inline-confirm[data-confirmation-phase="waiting"]').waitFor()
        await expect
          .poll(() =>
            custom.locator('.confirm-sheet').evaluate(element => {
              const bounds = element.getBoundingClientRect()
              const layer = element.closest('.ui-popover')!.getBoundingClientRect()
              return bounds.top >= layer.top && bounds.bottom <= layer.bottom
            }),
          )
          .toBe(true)
        await captureThemes(page, 'native-desktop-composer-provider-waiting')
        testHost.presence.approveNext()
        await custom.waitFor({ state: 'detached' })
        expect(await page.getByRole('dialog', { name: '设置', exact: true }).count()).toBe(0)
        await page.getByRole('button', { name: '模型：local-custom', exact: true }).waitFor()
        expect(host.config.providers().find(provider => provider.name === '本机自定义模型')).toMatchObject({
          baseURL: customURL,
          models: ['local-custom'],
          defaultModel: 'local-custom',
        })
        expect(testHost.presence.requests.length).toBe(asked + 2)
        await openSettings(page, '设置')
      } finally {
        await models.close()
      }

      // 设置 › 项目: 新建项目… opens the system's open panel for several folders. Main takes a nonce, signs the body with
      // the device key and adds the project over host.sock itself; the page never sends a path. 在访达中显示 shows only
      // folders the Host has registered and never opens anything. The panel, Finder and openPath are recorded in main
      // instead, and the window counts as focused (folder dialogs open only for the focused window; the test runner
      // keeps it in the background).
      const picked = join(root, 'projects', 'picked-project')
      const pickedDocs = join(root, 'projects', 'picked-docs')
      await mkdir(picked, { recursive: true })
      await mkdir(pickedDocs)
      await application.evaluate(
        ({ BrowserWindow, dialog, shell }, chosen) => {
          const record: FolderRecord = { panels: [], shown: [], opened: [] }
          Object.assign(globalThis, { folderRecord: record })
          dialog.showOpenDialog = async (...args: unknown[]) => {
            record.panels.push(args.at(-1))
            return { canceled: false, filePaths: chosen }
          }
          shell.showItemInFolder = (path: string) => {
            record.shown.push(path)
          }
          shell.openPath = async (path: string) => {
            record.opened.push(path)
            return ''
          }
          BrowserWindow.prototype.isFocused = () => true
        },
        [picked, pickedDocs],
      )
      const folderRecord = () =>
        application!.evaluate(() => {
          const record: FolderRecord = Reflect.get(globalThis, 'folderRecord')
          return record
        })
      await computer.getByRole('tab', { name: '项目', exact: true }).click()
      await computer.getByRole('button', { name: '新建项目…', exact: true }).click()
      await computer.locator('.project-editor').waitFor()
      await computer.getByRole('button', { name: '项目', exact: true }).click()
      const projectCard = computer.locator('.project-card', { hasText: 'picked-project' })
      await projectCard.waitFor()
      expect(host.security.audit.lastOf('workspace.added')).toMatchObject({
        target: 'picked-project',
        actor: { listener: 'unix', deviceId: device.id },
        detail: { via: 'picker', folderCount: 2 },
      })
      expect((await folderRecord()).panels).toEqual([
        expect.objectContaining({
          title: '新建项目',
          buttonLabel: '创建项目',
          properties: ['openDirectory', 'createDirectory', 'multiSelections'],
          defaultPath: expect.any(String),
        }),
      ])
      const { workspaces } = await helper.json<{ workspaces: WorkspaceInfo[] }>('workspaces')
      const project = workspaces.find(item => item.id === 'picked-project')!
      expect(project.folders?.map(folder => folder.path)).toEqual([await realpath(picked), await realpath(pickedDocs)])
      await projectCard.getByRole('button', { name: '在访达中显示', exact: true }).first().click()
      await waitFor(async () => (await folderRecord()).shown.length === 1)
      expect((await folderRecord()).shown).toEqual([await realpath(picked)])
      // Any folder of a project by its ID, at most twice a second; an ID the Host does not know shows nothing, and the
      // bridge refuses anything but IDs before main is asked.
      const reveal = async (projectId: unknown, folderId?: string) => {
        await new Promise(done => setTimeout(done, 600))
        return page.evaluate(
          ([target, folder]) => {
            const shell: PageShell = Reflect.get(globalThis, 'latchShell')
            return shell.folders.reveal(target, folder)
          },
          [projectId, folderId] as const,
        )
      }
      expect(await reveal('picked-project', project.folders![1]!.id)).toEqual({ status: 'shown' })
      expect(await reveal('no-such-project')).toEqual({ status: 'failed', code: 'not-found' })
      expect(await reveal('../etc')).toEqual({ status: 'failed', code: 'invalid' })
      expect(await reveal(42)).toEqual({ status: 'failed', code: 'invalid' })
      expect((await folderRecord()).shown).toEqual([await realpath(picked), await realpath(pickedDocs)])

      // The page cannot reach the add routes itself, however it spells them.
      const direct = await page.evaluate(
        async folder => {
          const post = async (path: string, body: unknown) => {
            const response = await fetch(path, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            })
            return { status: response.status, body: (await response.json()) as unknown }
          }
          return [
            await post('/link/api/workspaces', { path: folder }),
            await post('/link/api/Workspaces/', { nonce: 'x', via: 'picker', paths: [folder] }),
            await post('/link/api/folder-grants', {}),
            await post('/link/api/workspaces/picked-project%2Ffolders', { nonce: 'x', via: 'drop', paths: [folder] }),
            await post('/link/api/workspaces', { nonce: 'x', via: 'session', sessionId: 'task-x' }),
          ]
        },
        join(root, 'projects'),
      )
      for (const answer of direct)
        expect(answer).toEqual({ status: 403, body: { error: 'shell-managed', message: '添加文件夹由 Latch 桌面端处理' } })

      // Dropping only takes File objects backed by files on disk; anything else asks nothing.
      const dialogsBefore = (await externalLinks()).asked.length
      expect(
        await page.evaluate(async () => {
          const shell: PageShell = Reflect.get(globalThis, 'latchShell')
          return [
            await shell.folders.drop(['/etc']),
            await shell.folders.drop(null, [{ name: 'x', path: '/etc' }]),
            await shell.folders.drop('picked-project', [new File(['x'], 'made-by-the-page')]),
            await shell.folders.drop('../x', []),
          ]
        }),
      ).toEqual([{ status: 'canceled' }, { status: 'canceled' }, { status: 'canceled' }, { status: 'failed', code: 'invalid' }])
      // 存为项目 takes a session ID only; main asks the Host for the session's folder before any dialog.
      expect(
        await page.evaluate(async () => {
          const shell: PageShell = Reflect.get(globalThis, 'latchShell')
          return [await shell.folders.saveSessionFolder('../x'), await shell.folders.saveSessionFolder('task-no-such-session')]
        }),
      ).toEqual([
        { status: 'failed', code: 'invalid' },
        { status: 'failed', code: 'task-not-found' },
      ])
      expect((await externalLinks()).asked).toHaveLength(dialogsBefore)
      // A File that is on disk (as a real drop gives) is listed in the native confirmation first, which defaults to
      // 取消; confirmed, the Host still decides (a file is not a folder).
      const notes = join(root, 'notes.txt')
      await writeFile(notes, 'x')
      await page.evaluate(() => {
        const input = document.createElement('input')
        input.type = 'file'
        input.id = 'e2e-dropped'
        input.hidden = true
        document.body.append(input)
      })
      await page.setInputFiles('#e2e-dropped', notes)
      const dropNotes = () =>
        page.evaluate(() => {
          const shell: PageShell = Reflect.get(globalThis, 'latchShell')
          const input = document.querySelector<HTMLInputElement>('#e2e-dropped')!
          return shell.folders.drop('picked-project', Array.from(input.files ?? []))
        })
      const answerDialogs = (answer: number) =>
        application!.evaluate((_electron, value) => {
          ;(globalThis as unknown as { externalLinks: ExternalLinks }).externalLinks.answer = value
        }, answer)
      await answerDialogs(1)
      expect(await dropNotes()).toEqual({ status: 'canceled' })
      expect((await externalLinks()).asked.at(-1)).toMatchObject({
        message: '把这些文件夹加入「picked-project」？',
        detail: expect.stringMatching(/notes\.txt\n\nLatch 内置可以读取其中的所有文件。/),
        buttons: ['添加', '取消'],
        defaultId: 1,
        cancelId: 1,
      })
      await answerDialogs(0)
      expect(await dropNotes()).toMatchObject({
        status: 'added',
        workspaceId: 'picked-project',
        added: [],
        refused: [{ code: 'workspace-invalid' }],
      })
      await answerDialogs(1)
      await page.evaluate(() => document.querySelector('#e2e-dropped')?.remove())
      expect((await folderRecord()).opened).toEqual([])
      await page.screenshot({ path: 'test-results/native-desktop-projects.png', animations: 'disabled' })

      // While a full-access session runs, a raise is refused where it was asked for, without reaching the system sheet:
      // the card names the session and offers to stop it or open it.
      const running = await helper.confirmed('tasks', {
        method: 'POST',
        body: { prompt: 'endturn', requestId: randomUUID(), mode: 'agent', harnessId: agent.id },
      })
      expect(running.status).toBe(201)
      const { sessionId: runningId }: { sessionId: string } = await running.json()
      await waitFor(async () => (await host.bridge.detail(runningId)).summary.status === 'running')
      const runningTitle = (await host.bridge.detail(runningId)).summary.title
      const beforeRunningConfirmation = testHost.presence.requests.length
      await computer.getByRole('tab', { name: '电脑', exact: true }).click()
      await computer.getByRole('button', { name: /^从手机和其他电脑发起：/ }).click()
      await page.getByRole('menuitemradio', { name: /^自动编辑/ }).click()
      const refused = page.locator('.inline-confirm[data-confirmation-phase="paused"]')
      await refused.waitFor()
      await refused.getByText(`要等「${runningTitle}」（Fake Agent）结束，才能放宽安全策略。`, { exact: true }).waitFor()
      expect(testHost.presence.requests.length).toBe(beforeRunningConfirmation)
      expect(await page.locator('.presence-dock').count()).toBe(0)
      await captureThemes(page, 'native-desktop-confirmation-blocked')
      await refused.getByRole('button', { name: '停止会话', exact: true }).click()
      await expect
        .poll(async () => ({ status: (await host.bridge.detail(runningId)).summary.status, text: await refused.innerText() }), {
          timeout: 15_000,
        })
        .toMatchObject({ status: 'cancelled', text: expect.stringContaining(`「${runningTitle}」已经结束。`) })
      await refused.getByRole('button', { name: '好', exact: true }).click()
      await refused.waitFor({ state: 'detached' })
      await closeSettings(computer)
      await page.locator(`[data-task-id="${runningId}"]`).click()
      await page.locator(`[data-task-id="${runningId}"][aria-current="page"]`).waitFor()

      // A day later the Host asks for renewal. Main renews over host.sock and uses the new credential at once, so it
      // takes over on the Host; the renderer's request simply succeeds.
      const storedBeforeRenewal = await readFile(stored, 'utf8')
      hostClockOffset = 25 * 60 * 60 * 1000
      expect(await page.evaluate(async () => (await fetch('/link/api/snapshot')).status)).toBe(200)
      expect(host.security.audit.lastOf('device.credential.issued')?.target).toBe(device.id)
      expect(host.security.audit.lastOf('device.credential.rotated')?.target).toBe(device.id)
      expect(await readFile(stored, 'utf8')).not.toBe(storedBeforeRenewal)
      expect(host.security.devices.get(device.id)?.status).toBe('active')
      expect(host.security.audit.lastOf('device.revoked')).toBeUndefined()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()

      // Revoking the device from elsewhere sends the shell back to enrollment and deletes its credential.
      const revoked = await testHost.raw('unix', `api/devices/${device.id}`, { method: 'DELETE' })
      expect(revoked.status).toBe(200)
      await page.getByRole('heading', { name: '连接到 Latch' }).waitFor({ timeout: 30_000 })
      await expect(stat(stored)).rejects.toMatchObject({ code: 'ENOENT' })

      // Renderer-initiated navigation away from latch://app is refused in main. Playwright keeps treating a refused
      // navigation as pending, so this runs last and is triggered and observed from main.
      const navigation = await application.evaluate(async ({ BrowserWindow }, port) => {
        const contents = BrowserWindow.getAllWindows()[0]!.webContents
        const attempts: string[] = []
        // Main's guard refuses these at will-frame-navigate, so will-navigate is never emitted for them.
        const record = (event: { url: string }) => {
          attempts.push(event.url)
        }
        contents.on('will-frame-navigate', record)
        await contents.executeJavaScript(
          `setTimeout(() => { location.href = 'http://127.0.0.1:${port}/' }, 0); setTimeout(() => { location.href = 'https://example.com/' }, 200); true`,
        )
        await new Promise(done => setTimeout(done, 1_000))
        contents.off('will-frame-navigate', record)
        return { attempts, url: contents.getURL() }
      }, counter.port)
      expect(navigation.attempts).toEqual([`http://127.0.0.1:${counter.port}/`, 'https://example.com/'])
      expect(navigation.url).toMatch(/^latch:\/\/app\/link\//)
      expect(page.url()).toMatch(/^latch:\/\/app\/link\//)
      expect(application.windows()).toHaveLength(1)
      expect(counter.connections()).toBe(0)

      // The demo's long task takes 30 s, which the steps above may outlast, so a second one runs through the end.
      const { sessionId: lateTask } = await host.bridge.createTask({
        prompt: '运行可取消长任务',
        requestId: randomUUID(),
        mode: 'agent',
      })
      await waitFor(async () =>
        (await host.bridge.detail(lateTask)).messages.some(message => message.role === 'tool' && message.state === 'running'),
      )

      // Closing the last window leaves the app running, as Mac apps do: main still keeps the Mac awake for the running
      // session through its next checks of the Host, and the Dock icon (`activate`) opens the window again.
      const blockers = () =>
        application!.evaluate(({ powerSaveBlocker }) =>
          Array.from({ length: 1024 }, (_, id) => id).filter(id => powerSaveBlocker.isStarted(id)),
        )
      await waitFor(async () => (await blockers()).length === 1)
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
      await waitFor(() => application!.windows().length === 0)
      await new Promise(done => setTimeout(done, 6_000))
      expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0)
      expect(await blockers()).toHaveLength(1)
      const reopened = application.waitForEvent('window')
      await application.evaluate(({ app }) => {
        app.emit('activate')
      })
      const reopenedWindow = await reopened
      await reopenedWindow.getByRole('heading', { name: '连接到 Latch' }).waitFor()
      expect(reopenedWindow.url()).toBe('latch://app/link/')

      await application.close()
      application = undefined
      expect((await testHost.raw('unix', 'api/health')).status).toBe(200)
      expect((await host.bridge.detail(lateTask)).summary.status).toBe('running')
      await host.bridge.cancel(lateTask)
      expect((await host.bridge.detail(lateTask)).summary.status).toBe('cancelled')
    } finally {
      await application?.close()
      await counter.close()
      await testHost.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('tests an Agent handshake from its settings, keeps login claims precise and displays redacted diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-probe-'))
    const testHost = await startTestHost({ demo: true, uiDir: resolve('dist/web'), presenceMode: 'manual' })
    const { host } = testHost
    let application: ElectronApplication | undefined
    try {
      await writeHostState(testHost.dataDir, {
        version: 2,
        pid: process.pid,
        hostId: host.hostId,
        instanceId: host.instanceId,
        socketPath: host.socketPath,
        loopbackOrigin: host.loopbackOrigin,
        tlsOrigin: null,
        startedAt: new Date().toISOString(),
        dataDir: testHost.dataDir,
      })
      await mkdir('test-results', { recursive: true })
      application = await _electron.launch({
        args: [
          resolve('apps/desktop/src/main.cjs'),
          `--latch-host-state=${join(testHost.dataDir, 'host.json')}`,
          `--latch-user-data=${join(root, 'electron')}`,
          '--use-mock-keychain',
        ],
        cwd: process.cwd(),
        env: shellEnvironment(),
        timeout: 30_000,
      })
      const page = await application.firstWindow()
      page.setDefaultTimeout(20_000)
      await enrollShell(page, testHost, 'Agent 诊断桌面端')
      const created = await page.evaluate(
        async definition =>
          (
            await fetch('latch://app/link/api/agents', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(definition),
            })
          ).status,
        {
          id: 'probe-fixture',
          name: 'Probe fixture',
          command: process.execPath,
          args: [FAKE_ACP_AGENT],
          env: { FAKE_ACP_CAPS: 'images,resume,dirs', FAKE_ACP_AUTH: 'new' },
        },
      )
      expect(created).toBe(201)
      const settings = await openSettings(page)
      await settings.getByRole('tab', { name: 'Agent 成员', exact: true }).click()
      await settings.getByRole('button', { name: '编辑 Probe fixture', exact: true }).click()
      const probe = settings.locator('.settings-group', { has: page.getByRole('heading', { name: '测试启动', exact: true }) })
      for (const [width, height] of [
        [1440, 1000],
        [768, 1024],
        [390, 844],
      ]) {
        await application.evaluate(
          ({ BrowserWindow }, size) => {
            const window = BrowserWindow.getAllWindows()[0]!
            window.setMinimumSize(320, 480)
            window.setContentSize(size.width, size.height)
          },
          { width: width!, height: height! },
        )
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
        await probe.getByRole('button', { name: '测试启动', exact: true }).click()
        const request = await testHost.presence.waitForRequest(15_000)
        expect(request.preview.action).toBe('agent.probe')
        await probe.locator('.inline-confirm[data-confirmation-phase="waiting"]').waitFor()
        await probe.getByText(request.preview.reason, { exact: true }).waitFor()
        await probe.scrollIntoViewIfNeeded()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
        await captureThemes(page, `agent-probe-waiting-${width}`)
        testHost.presence.approveNext()
        await probe.getByText('启动握手成功', { exact: true }).waitFor()
        await probe.getByText('登录状态与模型访问尚未验证。', { exact: true }).waitFor()
        await probe.getByText('声明支持：图片、恢复会话、附加文件夹', { exact: true }).waitFor()
        expect(await probe.getByText('需要先登录', { exact: true }).count()).toBe(0)
        await probe.locator('.inline-confirm').waitFor({ state: 'detached' })
      }
      await captureThemes(page, 'agent-probe-ready-phone')
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000)
      })
      const secret = 'test-only-probe-diagnostic-value'
      const changed = await page.evaluate(
        async body =>
          (
            await fetch('latch://app/link/api/agents/probe-fixture', {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            })
          ).status,
        { env: { FAKE_ACP_INIT_ERROR: '1', FAKE_SECRET: secret } },
      )
      expect(changed).toBe(200)
      await settings.getByRole('button', { name: '重新检测', exact: true }).click()
      await probe.getByText('尚未测试启动', { exact: true }).waitFor()
      await probe.getByRole('button', { name: '测试启动', exact: true }).click()
      const failure = await testHost.presence.waitForRequest(15_000)
      expect(failure.preview.action).toBe('agent.probe')
      testHost.presence.approveNext()
      await probe.getByText('测试启动失败', { exact: true }).waitFor()
      await probe.getByRole('button', { name: '复制诊断', exact: true }).waitFor()
      expect(await probe.innerText()).not.toContain(secret)
      expect(await probe.locator('pre').innerText()).toContain('[redacted]')
      await probe.locator('.inline-confirm').waitFor({ state: 'detached' })
      await probe.scrollIntoViewIfNeeded()
      await captureThemes(page, 'agent-probe-failed-desktop')
      expect(await host.bridge.listTasks()).toHaveLength(0)
    } finally {
      await application?.close()
      await testHost.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('enrolls over host.sock with an offline code while local confirmation is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-'))
    const testHost = await startTestHost({ demo: true, uiDir: resolve('dist/web'), presenceMode: 'unavailable' })
    const { host } = testHost
    let application: ElectronApplication | undefined
    try {
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
      await mkdir('test-results', { recursive: true })
      application = await _electron.launch({
        args: [
          resolve('apps/desktop/src/main.cjs'),
          `--latch-host-state=${join(testHost.dataDir, 'host.json')}`,
          `--latch-user-data=${join(root, 'electron')}`,
          '--use-mock-keychain',
        ],
        cwd: process.cwd(),
        env: shellEnvironment(),
        timeout: 30_000,
      })
      const page = await application.firstWindow()
      page.setDefaultTimeout(20_000)
      // host.sock is the one listener that takes offline codes, so with no local confirmation the page offers only that
      // way in: its intro points to the code, and nothing on it promises Touch ID.
      await page.getByRole('heading', { name: '连接到 Latch', exact: true }).waitFor()
      await page.getByText('这台设备会生成自己的密钥，再用离线登记码完成登记。', { exact: true }).waitFor()
      await page.getByText(/^本机确认不可用：.*pnpm latch device enroll --offline/u).waitFor()
      expect(await page.getByText(/Touch ID/u).count()).toBe(0)
      expect(await page.getByRole('button', { name: '请求本机确认', exact: true }).count()).toBe(0)
      const submit = page.getByRole('button', { name: '使用离线登记码', exact: true })
      expect(await submit.isDisabled()).toBe(true)
      await page.getByRole('textbox', { name: '设备名称', exact: true }).fill('离线登记的桌面端')
      await captureThemes(page, 'native-desktop-enrollment-offline')
      const { code } = await createOfflineTicket(join(testHost.dataDir, 'auth'))
      await page.getByLabel('离线登记码', { exact: true }).fill(code)
      await submit.click()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      expect(testHost.presence.requests).toHaveLength(0)
      expect(host.security.devices.list()).toMatchObject([{ name: '离线登记的桌面端', status: 'active', listener: 'unix' }])
    } finally {
      await application?.close()
      await testHost.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
