import { _electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CUSTOMIZATION, type AgentSettings, type AppSnapshot, type CustomizationReceipt, type WorkspaceInfo } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { FAKE_ACP_AGENT, makeTestTls, testDeviceKey } from '@latch/testkit'
import { createOfflineTicket } from '@latch/host/auth'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { expectUnmovedByInjectedStyles } from './helpers/security.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { closeSettings, layersInWindow, openSection, openSettings, reachable, settleShell, tooltipText } from './helpers/layout.ts'

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
    revealAgentHome(agentId: unknown): Promise<unknown>
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

async function listen(server: Server) {
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address')
  return {
    port: address.port,
    close: () =>
      new Promise<void>(done => {
        server.closeAllConnections()
        server.close(() => done())
      }),
  }
}

/** A long run of words, for a text that 标注 must cut. */
const LONG_TEXT = '很长的说明文字 '.repeat(600)

/**
 * Elements whose names can shadow DOM members: `document.<name>` for images, `form.<name>` for controls, which does so
 * in the isolated world too. The form has a labelled empty span at its left and is otherwise empty.
 */
const NAMED_ELEMENTS = [
  ...['elementFromPoint', 'querySelectorAll', 'createTreeWalker', 'Document', 'CSS'].map(name => `<img name="${name}" hidden>`),
  '<form class="labelled" aria-label="表单标签" style="position:absolute;left:300px;top:20px;width:200px;height:60px;margin:0">',
  ...['id', 'localName', 'classList', 'children', 'parentElement', 'getAttribute', 'getBoundingClientRect'].map(
    name => `<input type="hidden" name="${name}">`,
  ),
  '<span class="deep" title="里面的标签" style="position:absolute;left:0;top:0;width:50px;height:60px"></span></form>',
].join('')

/**
 * A local web app for the preview browser, at known positions: a button and two links on its first page, a second
 * page, a page that tries to get in the way of 标注, a download, and a redirect to another private address. The site
 * answers under any name (the tests also reach it as `site.test`); the paths it was asked for are recorded.
 */
async function previewSite() {
  const paths: string[] = []
  let port = 0
  const server = createHttpServer((request, response) => {
    const { pathname } = new URL(request.url ?? '/', 'http://site.invalid')
    paths.push(pathname)
    const page = (title: string, body: string) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{margin:0;font:14px sans-serif}a,button{position:absolute;left:20px;width:160px;height:40px;display:block}</style></head><body>${body}</body></html>`,
      )
    }
    if (pathname === '/')
      page(
        '预览夹具',
        `<button id="save" class="primary wide" style="top:20px">保存设置</button><a id="popup" target="_blank" href="/second" style="top:100px">新窗口打开</a><a id="local" href="http://127.0.0.1:${port}/second" style="top:160px">本地服务</a>`,
      )
    else if (pathname === '/second') page('第二页', '<p>第二页</p>')
    else if (pathname === '/hostile')
      page(
        '标注夹具',
        `<button id="target" class="primary wide" style="top:20px">保存设置</button><p id="long" style="position:absolute;left:20px;top:100px;width:400px;margin:0">${LONG_TEXT}</p>${NAMED_ELEMENTS}<script>
document.elementFromPoint = () => document.body
Element.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
CSS.escape = () => 'evil'
window.mutations = 0
new MutationObserver(list => { window.mutations += list.length }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
</script>`,
      )
    else if (pathname === '/download') {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="report.bin"' })
      response.end('not for the disk')
    } else if (pathname === '/sw/worker.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' })
      response.end(
        `self.addEventListener('message', event => event.waitUntil(fetch(event.data, { mode: 'no-cors' }).then(() => 'reached', () => 'blocked').then(answer => event.source.postMessage(answer))))`,
      )
    } else if (pathname === '/to-private') {
      response.writeHead(302, { location: `http://127.0.0.1:${port}/redirected` })
      response.end()
    } else page('第二页', '<p>其他</p>')
  })
  const listening = await listen(server)
  port = listening.port
  return { ...listening, paths }
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
 * Captures the window at tablet width as well (the desktop window cannot be narrower than 768, so a confirmation never
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

async function enrollShell(page: Page, testHost: TestHost) {
  // One sentence and one button: no name to type, and the first connection on this computer takes no confirmation.
  await page.getByText('第一次在这台 Mac 上打开 Latch。', { exact: true }).waitFor()
  expect(await page.getByRole('textbox').count()).toBe(0)
  await page.screenshot({ path: 'test-results/native-desktop-enrollment.png', animations: 'disabled' })
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await page.locator('.app-shell[data-connection="connected"]').waitFor()
  expect(testHost.presence.requests).toHaveLength(0)
  // The click still holds its one-shot gesture, which would open a link unasked; a navigation clears it.
  await page.reload()
  await page.locator('.app-shell[data-connection="connected"]').waitFor()
}

describe.skipIf(latchEnv(process.env, 'ELECTRON_E2E') !== '1' || process.platform !== 'darwin')('native desktop shell', () => {
  it('opens default appearance from the native View menu without leaving the Host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-appearance-'))
    const testHost = await startTestHost({ demo: true, hostName: '桌面外观验收', uiDir: resolve('dist/web') })
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
        startedAt: host.startedAt,
        dataDir: testHost.dataDir,
      })
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
      await enrollShell(page, testHost)
      const owner = await testHost.enroll({ listener: 'unix' })
      const state = async () => (await owner.json<AppSnapshot>('snapshot')).customization!
      const radius = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--r-8').trim())
      const before = await state()
      const applied = await owner.json<CustomizationReceipt>('customization', {
        method: 'POST',
        body: { requestId: randomUUID(), baseRevision: before.revision, doc: { schema: 1, appearance: { radius: 'round' } } },
      })
      await expect.poll(radius).toBe('12px')
      const beforeMenu = page.url()
      expect(beforeMenu).toBe('latch://app/link/')
      await application.evaluate(({ Menu }) => {
        Menu.getApplicationMenu()!.getMenuItemById('safe-mode')!.click()
      })
      const banner = page.locator('.safe-banner[data-lock]')
      await banner.waitFor()
      expect(page.url()).toBe(beforeMenu)
      expect(await radius()).toBe('8px')
      expect((await state()).revision).toBe(applied.revision)
      await mkdir('test-results/desktop-customization', { recursive: true })
      await page.screenshot({ path: 'test-results/desktop-customization/default-appearance.png', animations: 'disabled' })
      await banner.getByRole('button', { name: '恢复默认', exact: true }).click()
      await expect.poll(state).toEqual({ revision: applied.revision + 1, doc: DEFAULT_CUSTOMIZATION })
      await banner.waitFor({ state: 'detached' })
      expect(page.url()).toBe(beforeMenu)
    } finally {
      await application?.close()
      await testHost.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('enrolls over host.sock, keeps credentials in main, confines the renderer and leaves the Host running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-'))
    const marks = { ran: 0 }
    // Moved forward later to make the Host ask for credential renewal; the shell keeps its own clock.
    let hostClockOffset = 0
    const testHost = await startTestHost({
      demo: true,
      hostName: '桌面端测试.local',
      uiDir: resolve('dist/web'),
      presenceMode: 'manual',
      plugins: [markPlugin(marks)],
      now: () => Date.now() + hostClockOffset,
      // An HTTPS entry, for the invitation a CLI hands out; and the LAN entry, so the desktop app can show a pairing QR.
      tls: true,
      native: { host: '127.0.0.1', port: 0 },
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
      // The traffic lights' centre is the top row's line, 27px down (14px lights here); desktop-titlebar measures the rest.
      const lights = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getWindowButtonPosition())
      expect(lights).toEqual({ x: 16, y: 20 })
      // The shell's facts and its actions (functions, so only their names or types cross back here); nothing else.
      expect(
        await page.evaluate(() => {
          const shell = (globalThis as unknown as { latchShell: Record<string, unknown> }).latchShell
          const lifecycle = shell.lifecycle as Record<string, unknown>
          return {
            ...shell,
            folders: Object.keys(shell.folders as object),
            files: Object.keys(shell.files as object),
            notifications: Object.keys(shell.notifications as object),
            browser: Object.keys(shell.browser as object),
            openInBrowser: typeof shell.openInBrowser,
            copyComputerLink: typeof shell.copyComputerLink,
            updates: Object.keys(shell.updates as object),
            computers: Object.keys(shell.computers as object),
            spaces: Object.keys(shell.spaces as object),
            lights: Object.fromEntries(Object.entries(shell.lights as object).map(([name, value]) => [name, typeof value])),
            diagnostics: Object.keys(shell.diagnostics as object),
            editors: Object.keys(shell.editors as object),
            lifecycle: Object.fromEntries(Object.entries(lifecycle).map(([name, value]) => [name, typeof value])),
          }
        }),
      ).toEqual({
        kind: 'electron',
        devMode: true,
        platform: 'darwin',
        previews: { protocolVersion: 1, htmlScripts: true },
        folders: ['protocolVersion', 'pick', 'drop', 'reveal', 'revealAgentHome', 'saveSessionFolder'],
        openInBrowser: 'function',
        copyComputerLink: 'function',
        lifecycle: { get: 'function', setLoginItem: 'function', setKeepAwake: 'function', restartHost: 'function', subscribe: 'function' },
        files: ['protocolVersion', 'inspect', 'known', 'reveal', 'quickLook', 'open', 'editor'],
        diagnostics: ['export'],
        editors: ['protocolVersion', 'list', 'choose'],
        notifications: ['get', 'set', 'subscribeState', 'subscribe'],
        updates: ['get', 'check', 'download', 'install', 'cancelWaiting', 'setAutoDownload', 'onChange', 'onShow'],
        computers: ['list', 'subscribe', 'open', 'add', 'cancelAdd', 'trustCertificate', 'remove'],
        spaces: ['onShow'],
        // Where the traffic lights end (a number) and whether the window is in full screen (a boolean out, nothing in).
        lights: { end: 'number', fullScreen: 'function', onFullScreen: 'function' },
        browser: [
          'protocolVersion',
          'open',
          'list',
          'close',
          'navigate',
          'back',
          'forward',
          'reload',
          'stop',
          'setBounds',
          'occlude',
          'focus',
          'capture',
          'annotate',
          'hitTest',
          'setViewport',
          'setColorScheme',
          'logs',
          'zoom',
          'devTools',
          'clearData',
          'state',
          'takeOver',
          'handBack',
          'showing',
          'subscribe',
        ],
      })

      await enrollShell(page, testHost)
      const titleRow = await page.locator('.titlebar').evaluate(bar => {
        const region = (element: Element) => getComputedStyle(element).getPropertyValue('-webkit-app-region')
        const controls = [...bar.querySelectorAll('button')].filter(control => control.getBoundingClientRect().width > 0)
        return {
          height: bar.getBoundingClientRect().height,
          region: region(bar),
          controls: [...new Set(controls.map(region))],
          firstControl: Math.min(...controls.map(control => control.getBoundingClientRect().left)),
        }
      })
      expect(titleRow).toMatchObject({ height: 52, region: 'drag', controls: ['no-drag'] })
      expect(titleRow.firstControl).toBeGreaterThanOrEqual(78)
      const devices = host.security.devices.list()
      expect(devices).toHaveLength(1)
      const device = devices[0]!
      expect(device).toMatchObject({ name: '桌面端测试', status: 'active', listener: 'unix' })
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

      // 「复制链接」 for another computer: main gets a one-time invitation on the HTTPS entry and writes the link as one
      // concealed clipboard entry (recorded here instead of the real clipboard); the page learns only the outcome.
      await application.evaluate(({ clipboard }) => {
        const copied: { types: string[]; text: string }[] = []
        Object.assign(globalThis, { copied })
        clipboard.write = async items => {
          for (const item of items) copied.push({ types: [...item.types], text: await ((await item.getType('text/plain')) as Blob).text() })
        }
        clipboard.readText = async () => ''
        clipboard.clear = () => {}
      })
      const copyResult = await page.evaluate(() =>
        (globalThis as unknown as { latchShell: { copyComputerLink(): Promise<unknown> } }).latchShell.copyComputerLink(),
      )
      expect(copyResult).toEqual({ ok: true })
      const copied = await application.evaluate(() => (globalThis as unknown as { copied: { types: string[]; text: string }[] }).copied)
      expect(copied).toHaveLength(1)
      expect(copied[0]!.types).toEqual(['text/plain', 'electron application/osclipboard;format="org.nspasteboard.ConcealedType"'])
      expect(copied[0]!.text).toMatch(new RegExp(`^${host.tlsOrigin}/link/#pair=lpi1-[A-Z2-7]{26}$`))
      expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain('lpi1-')
      // The page cannot ask the Host for a link of its own, for any target.
      const ownLink = await page.evaluate(async () => {
        const response = await fetch('/link/api/pairings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"target":"tls"}',
        })
        return { status: response.status, body: await response.text() }
      })
      expect(ownLink.status).toBe(403)
      expect(ownLink.body).not.toContain('lpi1-')

      // 「在浏览器中打开」: main gets a one-time loopback invitation with the shell's credential and gives the
      // link to the default browser (recorded instead of opened) without a dialog; the page never sees the invitation.
      const browserHere = await openSettings(page, '设备')
      await page.getByRole('button', { name: '在浏览器中打开', exact: true }).click()
      await waitFor(async () => (await externalLinks()).opened.length === 2)
      const browserLink = (await externalLinks()).opened[1]
      expect(browserLink).toMatch(new RegExp(`^${host.loopbackOrigin}/link/#pair=lpi1-[A-Z2-7]{26}$`))
      expect((await externalLinks()).asked).toHaveLength(2)
      await page.getByText('已在浏览器中打开。在那里点「连接这个浏览器」后，这台 Mac 会请你确认。', { exact: true }).waitFor()
      expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain('lpi1-')
      await page.screenshot({ path: 'test-results/native-desktop-browser-here.png', animations: 'disabled' })
      // It hands out an invitation like the pairing sheet, so its words keep their look under styles added to the page.
      await page.mouse.move(0, 0)
      await expectUnmovedByInjectedStyles(page, ['.settings-group[data-secure] .ui-button', '.device-connect-said'])
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
      // The panel names who is asking, and folds the code to compare with that browser's page.
      const asking = page.locator('.device-waiting').filter({ hasText: '「这台电脑的浏览器」想连接这台 Mac' })
      await asking.waitFor()
      expect(await asking.getByText('它还可以管理这台 Mac').count()).toBe(0)
      const askingCode = asking.locator('.connection-code')
      expect(await askingCode.isVisible()).toBe(false)
      expect(await askingCode.getAttribute('aria-label')).toBe(
        `校验码 ${invited.preview.lines.find(line => line.label === '设备指纹')?.value}`,
      )
      testHost.presence.denyNext()
      await asking.waitFor({ state: 'detached' })
      // Single use: the same link does not work twice.
      expect((await enrollBrowser()).status).toBe(403)
      await closeSettings(browserHere)

      // A Standard session with the demo tool runs through the proxied API and event stream.
      await page.getByRole('textbox', { name: '新会话消息' }).fill('运行可取消长任务')
      await page.getByRole('button', { name: '发送', exact: true }).click()
      await waitFor(async () => (await host.bridge.listTasks()).length === 1)
      const longTask = (await host.bridge.listTasks())[0]!
      await waitFor(async () =>
        (await host.bridge.detail(longTask.id)).messages.some(message => message.role === 'tool' && message.state === 'running'),
      )
      await page.screenshot({ path: 'test-results/native-desktop.png', animations: 'disabled' })

      // The desktop app's own keys, never a browser's: ⌘/ lays them over the running session with ⌘ caps and takes
      // itself away again; ⌥⌘1 opens the Harness menu, Alt Shift 1 does nothing here; ⌘1 is the app's (the first row,
      // already open) and types nothing; 新会话 and 搜索 wear ⌘N and ⌘K.
      const keysOverlay = page.getByRole('dialog', { name: '快捷键', exact: true })
      await page.keyboard.press('Meta+/')
      await keysOverlay.waitFor()
      expect(await keysOverlay.locator('[data-keys="⌘1 … ⌘9"] kbd').allTextContents()).toEqual(['⌘1', '⌘9'])
      expect(await keysOverlay.locator('[data-keys="⌥⌘1 … ⌥⌘4"]').count()).toBe(1)
      expect(await keysOverlay.locator('[data-keys*="Alt"]').count()).toBe(0)
      expect(await page.locator('.settings-page').count()).toBe(0)
      await page.screenshot({ path: 'test-results/native-desktop-shortcuts.png', animations: 'disabled' })
      await page.keyboard.press('Meta+/')
      await keysOverlay.waitFor({ state: 'hidden' })
      const harnessTrigger = page.locator('.composer-stack [data-composer-control="harness"] button').first()
      await page.keyboard.press('Alt+Shift+Digit1')
      await new Promise(done => setTimeout(done, 200))
      expect(await harnessTrigger.getAttribute('aria-expanded')).not.toBe('true')
      await page.keyboard.press('Meta+Alt+Digit1')
      await waitFor(async () => (await harnessTrigger.getAttribute('aria-expanded')) === 'true')
      await page.keyboard.press('Escape')
      await waitFor(async () => (await harnessTrigger.getAttribute('aria-expanded')) !== 'true')
      const jumped = page.evaluate(
        () =>
          new Promise<boolean>(done => {
            const heard = (event: KeyboardEvent) => {
              if (event.code !== 'Digit1') return
              removeEventListener('keydown', heard)
              setTimeout(() => done(event.defaultPrevented))
            }
            addEventListener('keydown', heard)
          }),
      )
      await page.keyboard.press('Meta+Digit1')
      expect(await jumped).toBe(true)
      expect(await page.locator('.sidebar-top [aria-keyshortcuts="Meta+N"] .ui-kbd').allTextContents()).toEqual(['⌘N'])
      expect(await page.locator('.sidebar-top [aria-keyshortcuts="Meta+K"] .ui-kbd').allTextContents()).toEqual(['⌘K'])
      await page.locator('.sidebar-top').screenshot({ path: 'test-results/native-desktop-sidebar-keys.png', animations: 'disabled' })

      // Settings › 通用: main keeps the Mac awake while the session runs (it reads host-info over host.sock every few
      // seconds). The login item needs a packaged app, so a development run, which main reports as unavailable, has no row.
      const general = await openSettings(page, '设置')
      await openSection(general, '通用')
      const background = general.getByRole('region', { name: '这台 Mac', exact: true })
      const keepAwake = background.getByRole('switch', { name: '有任务时保持 Mac 唤醒', exact: true })
      expect(await keepAwake.getAttribute('aria-checked')).toBe('true')
      await background.getByText('保持唤醒中：有会话在运行', { exact: true }).waitFor({ timeout: 20_000 })
      expect(await background.getByRole('switch', { name: '登录时打开 Latch', exact: true }).count()).toBe(0)
      expect(await general.getByRole('button', { name: '重新启动 Host', exact: true }).count()).toBe(0)
      await page.screenshot({ path: 'test-results/native-desktop-background.png', animations: 'disabled' })
      // The end of the section, in light and dark.
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme })
        await page.screenshot({ path: `test-results/native-desktop-background-end-${scheme}.png`, animations: 'disabled' })
      }
      await page.emulateMedia({ colorScheme: 'light' })
      // Turning it off releases the Mac at once and is remembered in the shell's own data directory.
      await keepAwake.click()
      // Off, the switch says it all: the row has no line under it.
      await expect.poll(() => background.getByText('保持唤醒中：有会话在运行', { exact: true }).count()).toBe(0)
      expect(JSON.parse(await readFile(join(userData, 'lifecycle.json'), 'utf8'))).toEqual({ version: 1, keepAwake: false })
      await keepAwake.click()
      await background.getByText('保持唤醒中：有会话在运行', { exact: true }).waitFor()
      await closeSettings(general)
      // 显示 › 我的 Agent and Code move the window between the two places, as ⇧⌘2 and ⇧⌘1 do.
      const place = (name: string) => page.getByRole('radio', { name, exact: true }).first()
      const shell = application!
      // The page has said it has the two places, so the items are on.
      await expect.poll(() => shell.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('space-agents')?.enabled)).toBe(true)
      await shell.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('space-agents')?.click())
      await expect.poll(() => place('我的 Agent').getAttribute('aria-checked')).toBe('true')
      await page.locator('.agents-page').waitFor()
      await shell.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('space-code')?.click())
      await expect.poll(() => place('Code').getAttribute('aria-checked')).toBe('true')
      await page.locator('.agents-page').waitFor({ state: 'detached' })
      // The foot's row says so with a small glyph after its icons, the reason behind its hover; the footer keeps no
      // line or button of its own for it.
      const awake = page.locator('.sidebar-foot .sidebar-awake[role="img"][aria-label="保持唤醒中"]')
      await awake.waitFor()
      expect(await page.locator('.sidebar-footer').getByRole('button', { name: '保持唤醒中', exact: true }).count()).toBe(0)
      expect(await page.locator('.sidebar').getByText('保持唤醒中', { exact: true }).count()).toBe(0)
      await awake.hover()
      await page.getByRole('tooltip').filter({ hasText: '保持唤醒中：有会话在运行' }).waitFor()
      await page.locator('.sidebar-foot').screenshot({ path: 'test-results/native-desktop-keep-awake.png', animations: 'disabled' })
      await page.mouse.move(0, 0)
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
      await banner.getByText(/^这台 Mac 已休眠（\d{2}:\d{2} 起）$/u).waitFor()
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
      await page.locator('[data-approval-id] .approval-clause').waitFor()
      const card = page.locator('[data-approval-id]')
      // The card keeps its look under styles added to the page.
      await expectUnmovedByInjectedStyles(page, [
        '[data-approval-id] .approval-title',
        '[data-approval-id] .approval-clause',
        '[data-approval-id] .ui-button',
      ])
      await captureThemes(page, 'native-desktop-approval')
      await captureTablet(application, page, 'native-tablet-approval')
      // Allowing takes no prompt here either: the person chose this level of oversight.
      expect(marks.ran).toBe(0)
      const nativeSheets = () => application!.evaluate(() => (globalThis as unknown as { nativeSheets: NativeSheets }).nativeSheets.asked)
      const sheetsBefore = (await nativeSheets()).length
      await card.getByRole('button', { name: '允许', exact: true }).click()
      expect((await nativeSheets()).length).toBe(sheetsBefore)
      await waitFor(() => marks.ran === 1)
      await waitFor(async () => (await host.bridge.detail(sessionId)).summary.status === 'idle')

      // 手机: the pairing sheet, and the confirmation of an action that does not show it in place yet (the dock).
      const phone = await testHost.enroll({ name: '测试手机', scopes: ['view'] })
      const settings = await openSettings(page, '设备')
      const connectPhone = page.locator('.device-connect')
      await connectPhone.waitFor()
      await captureThemes(page, 'native-desktop-pairing')
      await connectPhone.click()
      const pairing = page.getByRole('dialog', { name: '连接手机', exact: true })
      const qr = pairing.getByRole('img', { name: '原生客户端配对二维码', exact: true })
      await qr.waitFor()
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
          context.fillStyle = '#18181b'
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
            context.fillStyle = '#18181b'
            context.fillRect((x + 3) * cell, (y + 3) * cell, 3 * cell, 3 * cell)
          }
          image.src = canvas.toDataURL('image/png')
          await image.decode()
        })
      await maskQr()
      await captureThemes(page, 'native-desktop-pairing-ready')
      // A device that used an invitation is named by the system sheet; a denial changes nothing on this device.
      const invitation = await testHost.invite(['view'])
      const asked = await testHost.raw('tls', 'api/enrollments', {
        method: 'POST',
        body: { publicKey: testDeviceKey().spki, name: '新手机', invitation: invitation.code },
      })
      const { enrollment } = (await asked.json()) as { enrollment: { reason: string } }
      const enrolling = await testHost.presence.waitForRequest(15_000)
      expect(enrolling.preview.reason).toBe(enrollment.reason)
      testHost.presence.denyNext()
      expect(phone.device.scopes).toEqual(['view'])
      // Closing the panel revokes its QRs at the Host.
      await pairing.getByRole('button', { name: '关闭', exact: true }).click()
      await qr.waitFor({ state: 'detached' })
      await waitFor(() => !host.security.enrollments.nativePairingOpen())
      // A device's actions are in its row's ⋯ menu; 重命名 goes to the name on its page.
      const row = settings.locator(`[data-device-id="${phone.device.id}"]`)
      await row.hover()
      const deviceActions = row.getByRole('button', { name: '测试手机 的操作', exact: true })
      await settleShell(page)
      await deviceActions.click()
      await page.getByRole('menuitem', { name: '重命名', exact: true }).click()
      const renamed = page.getByLabel('设备名称', { exact: true })
      await renamed.fill('改名的手机')
      await renamed.press('Enter')
      await waitFor(() => host.security.devices.get(phone.device.id)?.name === '改名的手机')
      await captureThemes(page, 'native-desktop-device')
      expect(host.security.devices.get(phone.device.id)?.scopes).toEqual(['view'])
      await closeSettings(settings)

      const policy = () => host.security.policy.get()
      // A full-access agent's question: advisory, and on the Host's own desktop it may be answered with 允许.
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
      await advisory.locator('.ui-button[data-variant="primary"]', { hasText: '允许' }).waitFor()
      // An agent's ask: 拒绝 and 允许 by their words (a key cap may follow), and ⌘⏎ never on 允许.
      expect(
        await advisory
          .locator('.approval-buttons > .ui-button:not(.approval-more)')
          .evaluateAll(buttons => buttons.map(button => button.firstChild?.textContent ?? '')),
      ).toEqual(['拒绝', '允许'])
      expect(await advisory.getByRole('button', { name: '允许', exact: true }).locator('.ui-button-keys').count()).toBe(0)
      await captureThemes(page, 'native-desktop-advisory')

      // While it waits for an answer, a confirmation that would outlive the session is held back, and the dock where it
      // was asked for names the session: 查看 leaves settings for it.
      const advisoryTitle = (await host.bridge.detail(advisoryId)).summary.title
      const confirmationsBefore = testHost.presence.requests.length
      await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '设置', exact: true }).click()
      const heldBack = page.locator('.settings-page')
      await openSection(heldBack, '设备')
      await page.locator(`[data-device-id="${phone.device.id}"] .settings-row-main`).click()
      const manage = heldBack.getByRole('switch', { name: '可以管理这台 Mac', exact: true })
      await manage.click()
      const blockedDock = page.locator('.inline-confirm[data-confirmation-phase="paused"]')
      await blockedDock.waitFor()
      expect(await blockedDock.getAttribute('data-paused-reason')).toBe('blocked')
      // Every session holding it back gets its own row: the Harness, the title, whether it runs or waits for you.
      expect(await blockedDock.locator('.ui-notice-title').innerText()).toBe(
        '有外部 Harness 的会话正在运行或等你处理，结束后才能为设备增加权限。',
      )
      const advisoryRow = blockedDock.locator(`.blocked-row[data-session-id="${advisoryId}"]`)
      expect(await advisoryRow.locator('.blocked-row-title').innerText()).toBe(advisoryTitle)
      expect(await advisoryRow.locator('.blocked-row-agent').innerText()).toBe('Fake Agent')
      await advisoryRow.getByText('等你处理', { exact: true }).waitFor()
      expect(await blockedDock.getByRole('button').count()).toBe(3)
      for (const name of ['查看', '停止', '关闭']) await blockedDock.getByRole('button', { name, exact: true }).waitFor()
      expect(testHost.presence.requests.length).toBe(confirmationsBefore)
      await captureThemes(page, 'native-desktop-confirmation-blocked')
      await expectUnmovedByInjectedStyles(page, [
        '.inline-confirm',
        '.inline-confirm .ui-notice',
        '.inline-confirm .ui-button',
        '.blocked-rows',
        '.blocked-row',
        '.blocked-row-text',
        '.blocked-row-title',
        '.blocked-row-agent',
        '.blocked-row .ui-status-word',
        '.blocked-row-actions',
      ])
      await blockedDock.getByRole('button', { name: '查看', exact: true }).click()
      await blockedDock.waitFor({ state: 'detached' })
      await heldBack.waitFor({ state: 'detached' })
      await advisory.locator('.approval-note').waitFor()

      await advisory.getByRole('button', { name: '拒绝', exact: true }).click()
      await waitFor(async () => (await host.bridge.detail(advisoryId)).summary.status === 'idle')

      // A full-access start from the composer, of an agent saved with its one confirmation: it just starts.
      const second = await helper.confirmed('agents', {
        method: 'POST',
        body: { name: 'Second Agent', command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_MARK: 'second' } },
      })
      expect(second.status).toBe(201)
      const { agent: secondAgent }: { agent: AgentSettings } = await second.json()
      await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
      await page.getByRole('button', { name: /^Harness：/ }).click()
      await page.getByRole('menuitemradio', { name: /Second Agent/ }).click()
      await page.getByRole('textbox', { name: '新会话消息' }).fill('echo 开始')
      await page.getByRole('button', { name: '发送', exact: true }).click()
      expect(await page.locator('.composer-confirm .inline-confirm').count()).toBe(0)
      await waitFor(async () => (await host.bridge.listTasks()).some(task => task.harnessId === secondAgent.id))
      // A running agent holds a raise back too; 停止 ends it (this one stops at once when asked), and the
      // raise then asks for confirmation.
      const hanging = await helper.confirmed('tasks', {
        method: 'POST',
        body: { prompt: 'endturn', requestId: randomUUID(), mode: 'agent', harnessId: agent.id },
      })
      expect(hanging.status).toBe(201)
      const { sessionId: hangId }: { sessionId: string } = await hanging.json()
      await waitFor(async () => (await host.bridge.detail(hangId)).summary.status === 'running')
      const hangTitle = (await host.bridge.detail(hangId)).summary.title

      await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '设置', exact: true }).click()
      const computer = page.locator('.settings-page')
      // Pairing starts here, so the sheet names the running agent that would hold a phone back.
      await openSection(computer, '设备')
      await page.locator('.device-connect').click()
      await page
        .locator('.pair-sheet')
        .getByText(`Fake Agent 正在运行「${hangTitle}」，结束后才能配对新设备。`, {
          exact: true,
        })
        .waitFor()
      // One sentence, and both ways out: open the session, or stop it.
      const pairingBlocked = page.locator('.pair-sheet .ui-notice', { hasText: `正在运行「${hangTitle}」` })
      expect(await pairingBlocked.getByRole('button').allInnerTexts()).toEqual(['查看', '停止'])
      await captureThemes(page, 'native-desktop-pairing-blocked')
      await page.locator('.pair-sheet').getByRole('button', { name: '关闭', exact: true }).click()
      await page.locator(`[data-device-id="${phone.device.id}"] .settings-row-main`).click()
      const manageRaise = computer.getByRole('switch', { name: '可以管理这台 Mac', exact: true })
      await manageRaise.click()
      await blockedDock.waitFor()
      expect(await blockedDock.getAttribute('data-paused-reason')).toBe('blocked')
      const hangRow = blockedDock.locator(`.blocked-row[data-session-id="${hangId}"]`)
      expect(await hangRow.locator('.blocked-row-title').innerText()).toBe(hangTitle)
      await hangRow.getByText('正在运行', { exact: true }).waitFor()
      await hangRow.getByRole('button', { name: '停止', exact: true }).click()
      await expect
        .poll(async () => ({ status: (await host.bridge.detail(hangId)).summary.status, text: await blockedDock.innerText() }), {
          timeout: 15_000,
        })
        .toMatchObject({ status: 'cancelled', text: expect.stringContaining(`「${hangTitle}」已经结束，可以再试一次了。`) })
      await blockedDock.getByText(/可以再试一次了。$/u).waitFor()
      expect(await blockedDock.getByRole('button').allInnerTexts()).toEqual(['好'])
      await captureThemes(page, 'native-desktop-confirmation-blocked-ended')
      await blockedDock.getByRole('button', { name: '好', exact: true }).click()
      await blockedDock.waitFor({ state: 'detached' })
      await manageRaise.click()
      const raise = await testHost.presence.waitForRequest(15_000)
      expect(raise.preview.action).toBe('device.grant')
      expect(raise.preview.requester.listener).toBe('unix')
      // The control that asked shows it waits; there is no card and no dock.
      await page.locator('.inline-confirm[data-confirmation-phase="waiting"]').waitFor({ state: 'attached' })
      expect(await page.locator('.presence-dock').count()).toBe(0)
      testHost.presence.denyNext()
      await page.locator('.inline-confirm[data-confirmation-phase="waiting"]').waitFor({ state: 'detached' })
      // A browser connected here reads project files from the start; 也能看私有内容 takes the same one confirmation,
      // whose fixed sentence says 查看全部数据, and turning either off asks nothing.
      const files = computer.getByRole('switch', { name: '可以看项目文件', exact: true })
      const all = computer.getByRole('switch', { name: '也能看私有内容', exact: true })
      expect(host.security.devices.get(phone.device.id)?.dataScope).toBe('files')
      await expect.poll(() => files.getAttribute('aria-checked')).toBe('true')
      await all.click()
      const widen = await testHost.presence.waitForRequest(15_000)
      expect(widen.preview.action).toBe('device.grant')
      expect(widen.preview.reason).toContain('查看全部数据')
      await captureThemes(page, 'native-desktop-device-files-waiting')
      testHost.presence.approveNext()
      await waitFor(() => host.security.devices.get(phone.device.id)?.dataScope === 'all')
      await expect.poll(() => all.getAttribute('aria-checked')).toBe('true')
      const beforeLower = testHost.presence.requests.length
      await all.click()
      await waitFor(() => host.security.devices.get(phone.device.id)?.dataScope === 'files')
      await files.click()
      await waitFor(() => host.security.devices.get(phone.device.id)?.dataScope === 'work')
      expect(testHost.presence.requests.length).toBe(beforeLower)

      // 设置 › 模型服务: a preset provider's key saves without a confirmation; a local address is confirmed once,
      // before its models are listed, and saving the service there then asks nothing more.
      const models = await localModels()
      try {
        const asked = testHost.presence.requests.length
        await openSection(computer, '模型')
        const addService = computer.getByRole('button', { name: '添加模型服务', exact: true })
        const sheet = page.getByRole('dialog', { name: '添加模型服务', exact: true })
        await addService.click()
        await sheet.getByRole('button', { name: 'DeepSeek', exact: true }).click()
        await sheet.getByLabel('密钥', { exact: true }).fill('sk-e2e-preset-key')
        const manual = sheet.getByLabel('手动添加模型 ID', { exact: true })
        await manual.fill('deepseek-chat')
        await manual.press('Enter')
        await sheet.getByRole('button', { name: '保存', exact: true }).click()
        await sheet.waitFor({ state: 'hidden' })
        expect(testHost.presence.requests.length).toBe(asked)
        expect(host.config.provider('deepseek')).toMatchObject({ apiKey: 'sk-e2e-preset-key', keyOrigin: 'https://api.deepseek.com:443' })
        expect(host.security.audit.lastOf('provider.secret.set')).toMatchObject({ stepup: 'none', actor: { listener: 'unix' } })
        // Checked as soon as it is listed; here the name does not resolve, and the row says so in one word.
        await computer.locator('.provider-row', { hasText: 'DeepSeek' }).getByText('连不上', { exact: true }).waitFor()
        await computer.getByRole('button', { name: '编辑 DeepSeek', exact: true }).click()
        // The key's scope is shown without the port https implies.
        await computer.getByText('只发往 https://api.deepseek.com/v1', { exact: true }).waitFor()
        await captureThemes(page, 'native-desktop-provider-preset')

        await computer.getByRole('button', { name: '模型', exact: true }).click()
        await addService.click()
        await sheet.getByRole('button', { name: 'Ollama', exact: true }).click()
        await sheet.getByLabel('地址', { exact: true }).fill(models.baseURL)
        await sheet.getByRole('button', { name: '用 Touch ID 保存', exact: true }).waitFor()
        // Listing a local address waits for its confirmation; the save button is the one lock on screen.
        await sheet.getByRole('button', { name: '检测连接', exact: true }).click()
        const localAddress = sheet.locator('.ui-hint', { hasText: '这台 Mac 或局域网地址，保存时确认' })
        expect(await tooltipText(page, localAddress.locator('.ui-hint-label'))).toBe(`确认后 Latch 才会访问 ${models.allow}。`)
        expect(await sheet.getByRole('button', { name: /Touch ID/u }).allInnerTexts()).toEqual(['用 Touch ID 保存'])
        await captureThemes(page, 'native-desktop-provider-local-address')
        // One press: the confirmation, then the listing, and a single model saves at once.
        await sheet.getByRole('button', { name: '用 Touch ID 保存', exact: true }).click()
        const confirmation = await testHost.presence.waitForRequest(15_000)
        await sheet.getByRole('button', { name: '等待 Touch ID…', exact: true }).waitFor()
        await page.screenshot({ path: 'test-results/native-desktop-provider-waiting.png', animations: 'disabled' })
        expect(confirmation.preview).toMatchObject({ action: 'provider.confirm-origin', title: `确认模型服务地址 ${models.allow}` })
        expect(confirmation.preview.lines).toContainEqual({
          label: '出站许可',
          value: `允许 Host 访问 ${models.allow}（这台电脑上的地址）`,
        })
        expect(models.listings).toEqual([])
        testHost.presence.approveNext()
        await sheet.waitFor({ state: 'hidden' })
        expect(host.config.provider('ollama')).toMatchObject({ baseURL: models.baseURL, models: ['llama3'], defaultModel: 'llama3' })
        await computer.locator('.provider-row', { hasText: 'Ollama' }).getByText('已连接', { exact: true }).waitFor()
        expect(testHost.presence.requests.length).toBe(asked + 1)
        expect(policy()).toMatchObject({ confirmedAddresses: [models.baseURL], hostEgressAllow: [models.allow] })
        await captureThemes(page, 'native-desktop-provider-local')

        // The composer uses the same form for a custom service, including manual model IDs. Saving stays in this
        // picker, confirms the new address once, and selects the saved model without opening settings.
        await closeSettings(computer)
        await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
        await page.getByRole('button', { name: /^Harness：/ }).click()
        await page.getByRole('menuitemradio', { name: /Latch 内置/ }).click()
        await page.getByRole('button', { name: /^模型：/ }).click()
        await page.getByRole('menuitem', { name: '添加模型服务…', exact: true }).click()
        await page
          .getByRole('region', { name: '添加模型服务', exact: true })
          .getByRole('button', { name: '自定义地址…', exact: true })
          .click()
        const custom = page.getByRole('region', { name: '自定义地址', exact: true })
        const customURL = `${models.origin}/custom/v1`
        await custom.getByLabel('名称', { exact: true }).fill('本机自定义模型')
        await custom.getByLabel('地址', { exact: true }).fill(customURL)
        const customModel = custom.getByLabel('手动添加模型 ID', { exact: true })
        await customModel.fill('local-custom')
        await customModel.press('Enter')
        await layersInWindow(page)
        await captureThemes(page, 'native-desktop-composer-provider-custom')
        await custom.getByRole('button', { name: '用 Touch ID 保存', exact: true }).click()
        const customConfirmation = await testHost.presence.waitForRequest(15_000)
        expect(customConfirmation.preview).toMatchObject({ action: 'provider.confirm-origin', subject: { form: 'origin.confirm' } })
        expect(customConfirmation.preview.reason).toContain(customURL)
        await custom.locator('.inline-confirm[data-confirmation-phase="waiting"]').waitFor({ state: 'attached' })
        await captureThemes(page, 'native-desktop-composer-provider-waiting')
        testHost.presence.approveNext()
        await custom.waitFor({ state: 'detached' })
        expect(await page.locator('.settings-page').count()).toBe(0)
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

      // 设置 › 项目: 添加项目 opens the system's open panel for several folders. Main takes a nonce, signs the body with
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
      await openSection(computer, '项目')
      await computer.getByRole('button', { name: '添加项目', exact: true }).click()
      await computer.locator('.project-editor').waitFor()
      await computer.getByRole('button', { name: '项目', exact: true }).click()
      const projectRow = computer.locator('.project-row', { hasText: 'picked-project' })
      await projectRow.waitFor()
      expect(host.security.audit.lastOf('workspace.added')).toMatchObject({
        target: 'picked-project',
        actor: { listener: 'unix', deviceId: device.id },
        detail: { via: 'picker', folderCount: 2 },
      })
      expect((await folderRecord()).panels).toEqual([
        expect.objectContaining({
          title: '添加项目',
          buttonLabel: '创建项目',
          properties: ['openDirectory', 'createDirectory', 'multiSelections'],
          defaultPath: expect.any(String),
        }),
      ])
      const { workspaces } = await helper.json<{ workspaces: WorkspaceInfo[] }>('workspaces')
      const project = workspaces.find(item => item.id === 'picked-project')!
      expect(project.folders?.map(folder => folder.path)).toEqual([await realpath(picked), await realpath(pickedDocs)])
      await projectRow.getByRole('button', { name: /的操作$/ }).click()
      await page.getByRole('menuitem', { name: '在访达中显示', exact: true }).click()
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

      // A helper home is revealed by its owner ID only; it never becomes a public project through this bridge.
      const homeAgent = await helper.json<{ id: string }>('custom-agents', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          name: '家的桌面入口',
          harnessId: 'standard',
          mode: 'agent',
          model: { providerId: 'demo', model: 'demo' },
          instructions: '',
          skills: [],
        },
      })
      const homeTask = await helper.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          customAgentId: homeAgent.id,
          prompt: '你好',
        },
      })
      await waitFor(async () => (await host.bridge.detail(homeTask.sessionId)).summary.status === 'idle')
      const homeInfo = await helper.json<{ path: string; available: boolean }>(`custom-agents/${homeAgent.id}/home`)
      expect(homeInfo.available).toBe(true)
      await new Promise(done => setTimeout(done, 600))
      await closeSettings(computer)
      await page.keyboard.press('Meta+Shift+Digit2')
      await page
        .getByRole('navigation', { name: '我的 Agent', exact: true })
        .getByRole('button', { name: /家的桌面入口/u })
        .first()
        .click()
      await page.getByRole('button', { name: '家的桌面入口 的资料', exact: true }).filter({ visible: true }).click()
      const homeProfile = page.getByRole('region', { name: '家的桌面入口 的资料', exact: true })
      await homeProfile.getByRole('button', { name: '设置', exact: true }).click()
      await homeProfile.getByRole('button', { name: '在访达中显示', exact: true }).click()
      await waitFor(async () => (await folderRecord()).shown.length === 3)
      expect((await folderRecord()).shown.at(-1)).toBe(await realpath(homeInfo.path))
      await page.screenshot({ path: 'test-results/native-desktop-agent-home.png', animations: 'disabled' })
      await homeProfile.getByRole('button', { name: '关闭资料', exact: true }).click()
      await page.keyboard.press('Meta+Shift+Digit1')
      await openSettings(page)
      await openSection(computer, '项目')
      await new Promise(done => setTimeout(done, 600))
      expect(
        await page.evaluate(async id => {
          const shell: PageShell = Reflect.get(globalThis, 'latchShell')
          return [await shell.folders.revealAgentHome('../home'), await shell.folders.saveSessionFolder(id)]
        }, homeTask.sessionId),
      ).toEqual([
        { status: 'failed', code: 'invalid' },
        { status: 'failed', code: 'session-folder-none' },
      ])

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
      await openSection(computer, '设备')
      await page.locator(`[data-device-id="${phone.device.id}"] .settings-row-main`).click()
      await computer.getByRole('switch', { name: '可以管理这台 Mac', exact: true }).click()
      const refused = page.locator('.inline-confirm[data-confirmation-phase="paused"]')
      await refused.waitFor()
      await refused.getByText('有外部 Harness 的会话正在运行或等你处理，结束后才能为设备增加权限。', { exact: true }).waitFor()
      await refused.locator(`.blocked-row[data-session-id="${runningId}"]`).getByText('正在运行', { exact: true }).waitFor()
      expect(testHost.presence.requests.length).toBe(beforeRunningConfirmation)
      expect(await page.locator('.presence-dock').count()).toBe(0)
      await captureThemes(page, 'native-desktop-confirmation-blocked')
      await refused.getByRole('button', { name: '停止', exact: true }).click()
      await expect
        .poll(async () => ({ status: (await host.bridge.detail(runningId)).summary.status, text: await refused.innerText() }), {
          timeout: 15_000,
        })
        .toMatchObject({ status: 'cancelled', text: expect.stringContaining(`「${runningTitle}」已经结束，可以再试一次了。`) })
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
      await page.getByRole('heading', { name: 'Latch', exact: true }).waitFor({ timeout: 30_000 })
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
      await reopenedWindow.getByRole('heading', { name: 'Latch', exact: true }).waitFor()
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

  it('copies a reply from the message footer through the page’s own clipboard write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-copy-'))
    // The page as just built beside a Host that started with an earlier build: the app offers to restart it.
    const ui = join(root, 'web')
    await cp(resolve('dist/web'), ui, { recursive: true })
    await writeFile(join(ui, 'build.json'), JSON.stringify({ build: '20261107T080000Z-0a1b2c' }))
    const testHost = await startTestHost({ demo: true, uiDir: ui, presenceMode: 'manual' })
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
      await enrollShell(page, testHost)
      const oldHost = page.locator('.banner-region .ui-notice', { hasText: '这台 Mac 上的 Latch 还是旧版本' })
      await oldHost.getByRole('button', { name: '重启 Latch', exact: true }).waitFor()
      await captureThemes(page, 'desktop-old-host')
      // The permission as Chromium asks main's handlers for it; nothing here touches the system clipboard.
      const state = (frame: string, name: string) =>
        page.evaluate(
          async ([where, permission]) => {
            if (where === 'top') return (await navigator.permissions.query({ name: permission as PermissionName })).state
            const iframe = document.createElement('iframe')
            // An initial about:blank frame: the page's own origin, with no request to block.
            document.body.append(iframe)
            try {
              return (await iframe.contentWindow!.navigator.permissions.query({ name: permission as PermissionName })).state
            } finally {
              iframe.remove()
            }
          },
          [frame, name] as const,
        )
      expect(await state('top', 'clipboard-write')).toBe('granted')
      expect(await state('top', 'clipboard-read')).toBe('denied')
      expect(await state('subframe', 'clipboard-write')).toBe('denied')
      // A tab laid over the window (as a preview tab is), even on this computer's own origin, is not the window's page.
      const tabState = await application.evaluate(async ({ BrowserWindow, WebContentsView }) => {
        const window = BrowserWindow.getAllWindows()[0]!
        const view = new WebContentsView()
        window.contentView.addChildView(view)
        try {
          await view.webContents.loadURL('latch://app/link/no-such-page.html').catch(() => {})
          return (await view.webContents.executeJavaScript(
            "navigator.permissions.query({ name: 'clipboard-write' }).then(result => result.state)",
          )) as string
        } finally {
          window.contentView.removeChildView(view)
          view.webContents.close()
        }
      })
      expect(tabState).toBe('denied')
      // What Electron hands the handlers for this permission, seen from a probe window in a partition of its own whose
      // handlers record and refuse (so nothing reaches the clipboard): the check carries isMainFrame and requestingUrl,
      // which main's rule needs to grant anything, so the grant above is the async API's and not the fallback's.
      const probe = createHttpServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('<!doctype html><title>probe</title>')
      })
      await new Promise<void>(done => probe.listen(0, '127.0.0.1', done))
      try {
        const origin = `http://127.0.0.1:${(probe.address() as { port: number }).port}/`
        const seen = await application.evaluate(async ({ BrowserWindow, session }, url) => {
          const records: { handler: string; permission: string; isMainFrame?: boolean; requestingUrl?: string }[] = []
          const probeSession = session.fromPartition('latch-e2e-permission-probe')
          probeSession.setPermissionCheckHandler((_contents, permission, _origin, details) => {
            records.push({ handler: 'check', permission, isMainFrame: details.isMainFrame, requestingUrl: details.requestingUrl })
            return false
          })
          probeSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
            records.push({ handler: 'request', permission, isMainFrame: details.isMainFrame, requestingUrl: details.requestingUrl })
            callback(false)
          })
          const window = new BrowserWindow({ show: false, webPreferences: { partition: 'latch-e2e-permission-probe' } })
          try {
            await window.loadURL(url)
            await window.webContents.executeJavaScript(
              `(async () => {
                await navigator.permissions.query({ name: 'clipboard-write' })
                const frame = document.createElement('iframe')
                document.body.append(frame)
                await frame.contentWindow.navigator.permissions.query({ name: 'clipboard-write' })
              })()`,
            )
          } finally {
            window.destroy()
          }
          return records
        }, origin)
        const checks = seen.filter(record => record.handler === 'check' && record.permission === 'clipboard-sanitized-write')
        expect(checks).toContainEqual({
          handler: 'check',
          permission: 'clipboard-sanitized-write',
          isMainFrame: true,
          requestingUrl: origin,
        })
        expect(checks).toContainEqual({
          handler: 'check',
          permission: 'clipboard-sanitized-write',
          isMainFrame: false,
          requestingUrl: 'about:blank',
        })
      } finally {
        probe.close()
      }
      // Check the actual permission before recording a write in the renderer. Neither clipboard API nor selection fallback reaches the OS.
      await page.evaluate(() => {
        const clipboardCopyFixture = { written: [] as string[], fallbackCopies: 0 }
        Object.assign(globalThis, { clipboardCopyFixture })
        Object.defineProperty(navigator, 'clipboard', {
          value: {
            async writeText(text: string) {
              const permission = await navigator.permissions.query({ name: 'clipboard-write' as PermissionName })
              if (permission.state !== 'granted') throw new DOMException('Clipboard write permission was not granted', 'NotAllowedError')
              clipboardCopyFixture.written.push(text)
            },
          },
        })
        document.execCommand = command => {
          if (command === 'copy') clipboardCopyFixture.fallbackCopies++
          return false
        }
      })
      await page.getByRole('textbox', { name: '新会话消息' }).fill('你好')
      await page.getByRole('button', { name: '发送', exact: true }).click()
      await waitFor(async () => (await host.bridge.listTasks()).length === 1)
      const task = (await host.bridge.listTasks())[0]!
      await waitFor(async () =>
        (await host.bridge.detail(task.id)).messages.some(message => message.role === 'assistant' && message.state === 'completed'),
      )
      const reply = (await host.bridge.detail(task.id)).messages.filter(message => message.role === 'assistant').at(-1)!
      const turn = page
        .locator('[data-message-id]')
        .filter({ hasText: reply.text.slice(0, 8) })
        .last()
      await turn.hover()
      // The user's message and the reply each have one; the reply's comes last once its turn has settled.
      await expect.poll(() => page.getByRole('button', { name: '复制', exact: true }).count()).toBeGreaterThanOrEqual(2)
      const copy = page.getByRole('button', { name: '复制', exact: true }).last()
      await copy.click()
      await page.getByRole('status').filter({ hasText: '已复制' }).first().waitFor()
      expect(await page.getByText('复制不可用，请手动选择', { exact: true }).count()).toBe(0)
      expect(await page.evaluate(() => Reflect.get(globalThis, 'clipboardCopyFixture'))).toEqual({
        written: [reply.text],
        fallbackCopies: 0,
      })
      await captureThemes(page, 'desktop-copy-reply')
    } finally {
      await application?.close()
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
      await enrollShell(page, testHost)
      // A definition's program is confirmed on this Mac: the test backend stands in for Touch ID.
      const local = await testHost.enroll({ listener: 'unix', name: '定义 Harness' })
      const created = await local.confirmed('agents', {
        method: 'POST',
        body: {
          id: 'probe-fixture',
          name: 'Probe fixture',
          command: process.execPath,
          args: [FAKE_ACP_AGENT],
          env: { FAKE_ACP_CAPS: 'images,resume,dirs', FAKE_ACP_AUTH: 'new' },
        },
      })
      expect(created.status).toBe(201)
      const settings = await openSettings(page)
      await openSection(settings, 'Harness')
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
        await probe.getByText('启动握手成功', { exact: true }).waitFor()
        await probe.getByText('登录状态与模型访问尚未验证。', { exact: true }).waitFor()
        await probe.getByText('声明支持：图片、恢复会话、附加文件夹', { exact: true }).waitFor()
        expect(await probe.getByText('需要先登录', { exact: true }).count()).toBe(0)
      }
      await captureThemes(page, 'agent-probe-ready-phone')
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000)
      })
      const secret = 'test-only-probe-diagnostic-value'
      const changed = await local.confirmed('agents/probe-fixture', {
        method: 'PUT',
        body: { env: { FAKE_ACP_INIT_ERROR: '1', FAKE_SECRET: secret } },
      })
      expect(changed.status).toBe(200)
      await settings.getByRole('button', { name: '重新检测', exact: true }).click()
      await probe.getByText('尚未测试启动', { exact: true }).waitFor()
      await probe.getByRole('button', { name: '测试启动', exact: true }).click()
      await probe.getByText('测试启动失败', { exact: true }).waitFor()
      await probe.getByRole('button', { name: '复制诊断', exact: true }).waitFor()
      expect(await probe.innerText()).not.toContain(secret)
      expect(await probe.locator('pre').innerText()).toContain('[redacted]')
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
      await page.getByRole('heading', { name: 'Latch', exact: true }).waitFor()
      await page.getByText('用离线连接码连接', { exact: true }).waitFor()
      await page.getByText(/^Mac 现在不能确认：.*pnpm latch device enroll --offline/u).waitFor()
      expect(await page.getByText(/Touch ID/u).count()).toBe(0)
      expect(await page.getByRole('button', { name: '继续', exact: true }).count()).toBe(0)
      const submit = page.getByRole('button', { name: '使用离线连接码', exact: true })
      expect(await submit.isDisabled()).toBe(true)
      await page.getByRole('textbox', { name: '设备名称', exact: true }).fill('离线连接的桌面端')
      await captureThemes(page, 'native-desktop-enrollment-offline')
      const { code } = await createOfflineTicket(join(testHost.dataDir, 'auth'))
      await page.getByLabel('离线连接码', { exact: true }).fill(code)
      await submit.click()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      expect(testHost.presence.requests).toHaveLength(0)
      expect(host.security.devices.list()).toMatchObject([{ name: '离线连接的桌面端', status: 'active', listener: 'unix' }])
    } finally {
      await application?.close()
      await testHost.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('drives preview tabs from the page while their pages stay away from the shell, the Host and this Mac', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-browser-'))
    const testHost = await startTestHost({ demo: true, uiDir: resolve('dist/web'), presenceMode: 'manual' })
    const { host } = testHost
    // Stand-ins that count connections: the Host's TLS listener (as host.json names it) and a `pnpm dev:web` proxy.
    const hostTls = await connectionCounter()
    const devProxy = await connectionCounter()
    const site = await previewSite()
    const tls = await makeTestTls(join(root, 'tls'))
    const secureRequests: string[] = []
    const secure = await listen(
      createHttpsServer({ key: await readFile(tls.keyPath), cert: await readFile(tls.certPath) }, (request, response) => {
        secureRequests.push(request.url ?? '')
        response.end('ok')
      }),
    )
    let application: ElectronApplication | undefined
    try {
      await writeHostState(testHost.dataDir, {
        version: 2,
        pid: process.pid,
        hostId: host.hostId,
        instanceId: host.instanceId,
        socketPath: host.socketPath,
        loopbackOrigin: host.loopbackOrigin,
        tlsOrigin: `https://127.0.0.1:${hostTls.port}`,
        startedAt: new Date().toISOString(),
        dataDir: testHost.dataDir,
      })
      application = await _electron.launch({
        args: [
          resolve('apps/desktop/src/main.cjs'),
          `--latch-host-state=${join(testHost.dataDir, 'host.json')}`,
          `--latch-user-data=${join(root, 'electron')}`,
          '--use-mock-keychain',
          // An internet name for the local site, so a page "on the internet" can try to reach this Mac.
          '--host-resolver-rules=MAP site.test 127.0.0.1',
        ],
        cwd: process.cwd(),
        env: shellEnvironment(),
        timeout: 30_000,
      })
      const app = application
      const page = await app.firstWindow()
      page.setDefaultTimeout(20_000)
      expect(page.url()).toBe('latch://app/link/')
      const local = `http://127.0.0.1:${site.port}`
      const internet = `http://site.test:${site.port}`
      const hostOrigin = new URL(host.loopbackOrigin)
      const sleep = (ms: number) => new Promise(done => setTimeout(done, ms))

      // Before the first paint, the window shows the sidebar ground.
      const ground = await app.evaluate(({ BrowserWindow, nativeTheme }) => ({
        color: BrowserWindow.getAllWindows()[0]!.getBackgroundColor(),
        dark: nativeTheme.shouldUseDarkColors,
      }))
      expect(ground.color.toUpperCase()).toBe(ground.dark ? '#09090B' : '#EBEBEF')

      /** One `latchShell.browser` call from the page; image bytes come back described (size, PNG header), not copied. */
      const call = (method: string, ...args: unknown[]) =>
        page.evaluate(
          async ([name, values]) => {
            const shell = Reflect.get(globalThis, 'latchShell') as { browser: Record<string, (...input: unknown[]) => Promise<unknown>> }
            const plain = (value: unknown): unknown => {
              if (value instanceof Uint8Array) {
                const view = new DataView(value.buffer, value.byteOffset, value.byteLength)
                const png = value.length >= 24 && view.getUint32(0) === 0x89504e47
                return { bytes: value.length, png, size: png ? [view.getUint32(16), view.getUint32(20)] : null }
              }
              if (Array.isArray(value)) return value.map(plain)
              if (value && typeof value === 'object')
                return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]))
              return value
            }
            return plain(await shell.browser[name]!(...values)) as Record<string, any>
          },
          [method, args] as const,
        )
      await page.evaluate(() => {
        const events: unknown[] = []
        Reflect.set(globalThis, 'previewEvents', events)
        const shell = Reflect.get(globalThis, 'latchShell') as { browser: { subscribe(callback: (event: unknown) => void): () => void } }
        shell.browser.subscribe(event => events.push(event))
      })
      const notices = async (tabId: string) =>
        (await page.evaluate(() => Reflect.get(globalThis, 'previewEvents') as Array<Record<string, unknown>>)).filter(
          event => event.tabId === tabId && event.type === 'notice',
        )
      /** The tabs' pages, as main sees them: every WebContents outside the app's own session but the developer tools. */
      const guests = () =>
        app.evaluate(({ webContents, session }) =>
          webContents
            .getAllWebContents()
            .filter(contents => contents.session !== session.defaultSession && !contents.getURL().startsWith('devtools:'))
            .map(contents => ({ id: contents.id, url: contents.getURL() })),
        )
      const inGuest = <T = unknown>(id: number, code: string, gesture = false) =>
        app.evaluate(({ webContents }, [target, source, activated]) => webContents.fromId(target)!.executeJavaScript(source, activated), [
          id,
          code,
          gesture,
        ] as const) as Promise<T>
      const urlOf = (id: number) => app.evaluate(({ webContents }, target) => webContents.fromId(target)?.getURL() ?? '', id)
      const settled = (id: number, url: string) =>
        waitFor(() =>
          app.evaluate(
            ({ webContents }, [target, expected]) => {
              const contents = webContents.fromId(target)
              return contents !== undefined && contents.getURL() === expected && !contents.isLoading()
            },
            [id, url] as const,
          ),
        )
      /** A real click of the person's in the tab, at view coordinates, as main sees native input. */
      const click = (id: number, x: number, y: number) =>
        app.evaluate(
          ({ webContents }, [target, px, py]) => {
            const contents = webContents.fromId(target)!
            contents.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 })
            contents.sendInputEvent({ type: 'mouseUp', x: px, y: py, button: 'left', clickCount: 1 })
          },
          [id, x, y] as const,
        )
      const viewOf = (id: number) =>
        app.evaluate(
          ({ BrowserWindow }, target) =>
            BrowserWindow.getAllWindows()[0]!
              .contentView.children.filter(view => 'webContents' in view && (view as Electron.WebContentsView).webContents.id === target)
              .map(view => ({ bounds: view.getBounds(), visible: view.getVisible() })),
          id,
        )

      // The page's calls are checked twice: arguments in the preload, tabs and addresses in main.
      expect(await call('open', '../x', 'ses_e2e', `${local}/`)).toEqual({ ok: false, error: 'invalid' })
      expect(await call('state', `brw_${'z'.repeat(22)}`)).toEqual({ ok: false, error: 'not-found' })
      expect(await call('open', 'alpha', 'ses_e2e', 'file:///etc/hosts')).toEqual({ ok: false, error: 'invalid-url' })
      expect(await call('open', 'alpha', 'ses_e2e', `${hostOrigin.hostname}:${hostOrigin.port}`)).toEqual({
        ok: false,
        error: 'blocked',
        reason: 'host',
      })
      expect(await guests()).toEqual([])

      const opened = await call('open', 'alpha', 'ses_e2e', `${local}/`)
      expect(opened).toMatchObject({ ok: true, tabId: expect.stringMatching(/^brw_[A-Za-z0-9_-]{22}$/u) })
      const tabId = opened.tabId as string
      await waitFor(async () => (await guests()).some(guest => guest.url === `${local}/`))
      const guestId = (await guests()).find(guest => guest.url === `${local}/`)!.id
      await settled(guestId, `${local}/`)
      // Hidden until the page places it over its panel, then exactly there.
      expect(await viewOf(guestId)).toEqual([{ bounds: expect.any(Object), visible: false }])
      expect(await call('setBounds', tabId, { x: 640, y: 60, width: 560, height: 700 })).toEqual({ ok: true })
      expect(await viewOf(guestId)).toEqual([{ bounds: { x: 640, y: 60, width: 560, height: 700 }, visible: true }])
      await waitFor(async () => {
        const answer = await call('state', tabId)
        return answer.ok && answer.state.title === '预览夹具'
      })

      // The guest: its own in-memory partition, no preload, no Node, WebRTC only through a proxy.
      expect(
        await app.evaluate(({ webContents, session }, id) => {
          const contents = webContents.fromId(id)!
          return {
            persistent: contents.session.isPersistent(),
            storage: contents.session.getStoragePath(),
            appSession: contents.session === session.defaultSession,
            preloads: contents.session.getPreloadScripts().length,
            webrtc: contents.getWebRTCIPHandlingPolicy(),
          }
        }, guestId),
      ).toEqual({ persistent: false, storage: null, appSession: false, preloads: 0, webrtc: 'disable_non_proxied_udp' })
      expect(await inGuest(guestId, '[typeof latchShell, typeof require, typeof process, typeof module, typeof Buffer]')).toEqual([
        'undefined',
        'undefined',
        'undefined',
        'undefined',
        'undefined',
      ])

      // Nothing the page sends reaches a Latch Host: not the shell's scheme, not the Host's listeners on any name, not a
      // Host name, and not an API path behind a development proxy, however it is spelled.
      const reach = await inGuest<Record<string, string>>(
        guestId,
        `(async () => {
          const attempt = url => fetch(url, { mode: 'no-cors' }).then(() => 'reached', () => 'blocked')
          const socket = url => new Promise(done => {
            try {
              const ws = new WebSocket(url)
              ws.onopen = () => { ws.close(); done('reached') }
              ws.onerror = () => done('blocked')
            } catch { done('blocked') }
          })
          return {
            shell: await attempt('latch://app/link/api/health'),
            hostName: await attempt(${JSON.stringify(`${host.loopbackOrigin}/link/api/health`)}),
            hostPort: await attempt('http://127.0.0.1:${hostOrigin.port}/link/'),
            hostTls: await attempt('https://127.0.0.1:${hostTls.port}/'),
            hostTlsSocket: await socket('ws://127.0.0.1:${hostTls.port}/'),
            hostTlsRebound: await attempt('http://site.test:${hostTls.port}/'),
            devProxyName: await attempt('http://${hostOrigin.hostname}:${devProxy.port}/link/'),
            devProxyApi: await attempt('http://127.0.0.1:${devProxy.port}/link/api/health'),
            devProxyApiSpelled: await attempt('http://127.0.0.1:${devProxy.port}/LINK/%61pi/health'),
            devProxyApiRouted: await attempt('http://127.0.0.1:${devProxy.port}//x/link/api/health'),
          }
        })()`,
      )
      expect(Object.values(reach)).toEqual(Array(Object.keys(reach).length).fill('blocked'))
      expect(hostTls.connections()).toBe(0)
      expect(devProxy.connections()).toBe(0)
      // The same port answers anything else (the counter drops it): the refusal is for the Host, not the port.
      expect(
        await inGuest(
          guestId,
          `fetch('http://127.0.0.1:${devProxy.port}/other', { mode: 'no-cors' }).then(() => 'reached', () => 'dropped')`,
        ),
      ).toBe('dropped')
      expect(devProxy.connections()).toBeGreaterThan(0)
      // Workers send through the same filter, and service workers keep working in a preview.
      const proxied = devProxy.connections()
      const fromWorkers = await inGuest<Record<string, string[]>>(
        guestId,
        `(async () => {
          const urls = ['http://127.0.0.1:${hostTls.port}/', 'http://127.0.0.1:${devProxy.port}/link/api/health', 'http://127.0.0.1:${devProxy.port}/worker-other']
          const source = "onmessage = event => fetch(event.data, { mode: 'no-cors' }).then(() => 'reached', () => 'blocked').then(postMessage)"
          const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })))
          const ask = (send, listen) => url => new Promise(done => {
            listen(event => done(event.data))
            send(url)
          })
          const askWorker = ask(url => worker.postMessage(url), handler => { worker.onmessage = handler })
          const registration = await navigator.serviceWorker.register('/sw/worker.js', { scope: '/sw/' })
          const active = await new Promise(done => {
            const check = () => (registration.active ? done(registration.active) : setTimeout(check, 50))
            check()
          })
          const askService = ask(url => active.postMessage(url), handler => { navigator.serviceWorker.onmessage = handler })
          const answers = { worker: [], service: [] }
          for (const url of urls) {
            answers.worker.push(await askWorker(url))
            answers.service.push(await askService(url))
          }
          await registration.unregister()
          worker.terminate()
          return answers
        })()`,
      )
      // Every answer is a failure, but only the third address, an ordinary path the counter drops, was ever sent: once
      // by each kind of worker (a retry may add more).
      expect(fromWorkers).toEqual({ worker: ['blocked', 'blocked', 'blocked'], service: ['blocked', 'blocked', 'blocked'] })
      expect(hostTls.connections()).toBe(0)
      expect(devProxy.connections()).toBeGreaterThanOrEqual(proxied + 2)
      expect(site.paths).toContain('/sw/worker.js')

      // Every permission is refused, and the page hears of each in a quiet notice.
      // A camera request and a fullscreen request may never be answered at all, so each attempt gets two seconds.
      const asked = await inGuest<Record<string, string>>(
        guestId,
        `(async () => {
          const settle = promise =>
            Promise.race([promise.then(() => 'granted', error => error.name), new Promise(done => setTimeout(() => done('unanswered'), 2000))])
          return {
            notification: await Notification.requestPermission(),
            geolocation: (await navigator.permissions.query({ name: 'geolocation' })).state,
            microphone: await settle(navigator.mediaDevices.getUserMedia({ audio: true })),
            clipboard: await settle(navigator.clipboard.readText()),
            screen: await settle(navigator.mediaDevices.getDisplayMedia({ video: true })),
            fullscreen: await settle(document.documentElement.requestFullscreen()),
          }
        })()`,
        true,
      )
      expect(asked).toMatchObject({
        notification: 'denied',
        geolocation: 'denied',
        microphone: 'NotAllowedError',
        clipboard: 'NotAllowedError',
      })
      for (const kind of ['screen', 'fullscreen']) expect(asked[kind], kind).not.toBe('granted')
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFullScreen())).toBe(false)
      expect(await inGuest(guestId, 'document.fullscreenElement === null')).toBe(true)
      await waitFor(async () => {
        const asks = (await notices(tabId)).filter(notice => notice.notice === 'permission').map(notice => notice.detail)
        return ['notifications', 'media', 'clipboard-read'].every(name => asks.includes(name))
      })

      // Nothing native over or beside the Latch window: dialogs return at once instead of showing a sheet, the file
      // pickers that could write past the download block and document picture-in-picture do not exist, video
      // picture-in-picture is off by policy, and a page's badge never reaches the Dock.
      const badge = () => app.evaluate(({ app: shellApp }) => [shellApp.getBadgeCount(), shellApp.dock?.getBadge() ?? ''])
      const badgeBefore = await badge()
      const native = await inGuest<Record<string, unknown>>(
        guestId,
        `(async () => {
          const started = Date.now()
          alert('来自页面的提示')
          const confirmed = confirm('来自页面的确认')
          let prompted = 'answered'
          try {
            prompt('来自页面的输入')
          } catch {
            prompted = 'threw'
          }
          const dialogsMs = Date.now() - started
          const video = document.createElement('video')
          video.muted = true
          document.body.append(video)
          const canvas = document.createElement('canvas')
          const context = canvas.getContext('2d')
          const paint = setInterval(() => context.fillRect(0, 0, 8, 8), 30)
          video.srcObject = canvas.captureStream(30)
          await Promise.race([video.play(), new Promise(done => setTimeout(done, 1000))])
          const pip = await Promise.race([
            video.requestPictureInPicture().then(() => 'opened', error => error.name),
            new Promise(done => setTimeout(() => done('unanswered'), 2000)),
          ])
          clearInterval(paint)
          video.remove()
          return {
            dialogsMs,
            confirmed,
            prompted,
            pictureInPictureEnabled: document.pictureInPictureEnabled,
            pip,
            pipShown: document.pictureInPictureElement !== null,
            pickers: [typeof showOpenFilePicker, typeof showSaveFilePicker, typeof showDirectoryPicker],
            documentPictureInPicture: typeof documentPictureInPicture,
            badge: await navigator.setAppBadge(42).then(() => 'set', error => error.name),
          }
        })()`,
        true,
      )
      expect(native).toMatchObject({
        confirmed: false,
        prompted: 'threw',
        pictureInPictureEnabled: false,
        pipShown: false,
        pickers: ['undefined', 'undefined', 'undefined'],
        documentPictureInPicture: 'undefined',
      })
      expect(native.dialogsMs).toBeLessThan(1000)
      expect(native.pip).not.toBe('opened')
      // Blink ignores print() in a document whose sandbox lacks allow-modals, and says so in the console.
      await app.evaluate(({ webContents }, id) => {
        const messages: string[] = []
        Reflect.set(globalThis, 'guestConsole', messages)
        webContents.fromId(id)!.on('console-message', event => messages.push(event.message))
      }, guestId)
      expect(await inGuest(guestId, 'window.print(); true', true)).toBe(true)
      await waitFor(async () =>
        (await app.evaluate(() => Reflect.get(globalThis, 'guestConsole') as string[])).some(
          line => /print\(\)/u.test(line) && /allow-modals/u.test(line),
        ),
      )
      await sleep(300)
      expect(await badge()).toEqual(badgeBefore)

      // A page never opens a window: without a click of the person's, window.open is dropped.
      const counts = () =>
        app.evaluate(({ BrowserWindow, webContents }) => [BrowserWindow.getAllWindows().length, webContents.getAllWebContents().length])
      const before = await counts()
      expect(await inGuest(guestId, `window.open('${local}/second') === null`, true)).toBe(true)
      expect(
        await inGuest(guestId, `document.body.append(Object.assign(document.createElement('webview'), { src: '${local}/second' })); true`),
      ).toBe(true)
      await sleep(500)
      expect(await counts()).toEqual(before)
      expect(await urlOf(guestId)).toBe(`${local}/`)
      await waitFor(async () => (await notices(tabId)).some(notice => notice.notice === 'popup'))
      // With one, a local address in a new window opens in this tab instead.
      await click(guestId, 40, 120)
      await settled(guestId, `${local}/second`)
      expect(await counts()).toEqual(before)

      // Downloads are cancelled, and certificate errors fail closed before the page sends anything.
      expect(await call('navigate', tabId, `${local}/download`)).toEqual({ ok: true, url: `${local}/download` })
      await waitFor(async () => (await notices(tabId)).some(notice => notice.notice === 'download'))
      expect(await call('navigate', tabId, `https://latch-test.localhost:${secure.port}/`)).toMatchObject({ ok: true })
      await waitFor(async () => (await notices(tabId)).some(notice => notice.notice === 'certificate'))
      await waitFor(async () => {
        const answer = await call('state', tabId)
        return answer.ok && typeof answer.state.error === 'number' && answer.state.error < 0
      })
      expect(secureRequests).toEqual([])

      // Only http(s), never the Host; from the internet, no private address without a click, not even by redirect.
      expect(await call('navigate', tabId, `${internet}/`)).toEqual({ ok: true, url: `${internet}/` })
      await settled(guestId, `${internet}/`)
      // A cross-site navigation starts a new renderer process: what the tab was refused stays refused there.
      expect(
        await inGuest(
          guestId,
          `[typeof showOpenFilePicker, typeof showSaveFilePicker, typeof showDirectoryPicker, typeof documentPictureInPicture, confirm('x')]`,
        ),
      ).toEqual(['undefined', 'undefined', 'undefined', 'undefined', false])
      await inGuest(guestId, `location.href = 'file:///etc/hosts'`)
      await inGuest(guestId, `location.href = 'latch://app/link/'`)
      await inGuest(guestId, `location.href = ${JSON.stringify(`${host.loopbackOrigin}/link/`)}`)
      await inGuest(guestId, `location.href = '${local}/second'`)
      await sleep(800)
      expect(await urlOf(guestId)).toBe(`${internet}/`)
      expect((await notices(tabId)).filter(notice => notice.notice === 'navigation').map(notice => notice.detail)).toEqual(
        expect.arrayContaining(['host', 'private']),
      )
      expect(await call('navigate', tabId, `${internet}/to-private`)).toMatchObject({ ok: true })
      await sleep(800)
      expect(site.paths).toContain('/to-private')
      expect(site.paths).not.toContain('/redirected')
      expect(await urlOf(guestId)).not.toContain('/redirected')
      // The person's own click on a link to this Mac goes through.
      await settled(guestId, `${internet}/`)
      await click(guestId, 40, 180)
      await settled(guestId, `${local}/second`)
      // And a page on this Mac may move between its own addresses.
      await inGuest(guestId, `location.href = 'http://localhost:${site.port}/'`)
      await settled(guestId, `http://localhost:${site.port}/`)

      // 「截图发给 Agent」: a PNG within the attachment limits, and the frozen frame that stands in while the page shows
      // an overlay over the panel.
      const shot = await call('capture', tabId)
      expect(shot).toMatchObject({ ok: true, image: { type: 'image/png', data: { png: true } } })
      expect(shot.image.data.size).toEqual([shot.image.width, shot.image.height])
      expect(shot.image.data.bytes).toBeLessThanOrEqual(5 * 1024 * 1024)
      expect(Math.max(shot.image.width, shot.image.height)).toBeLessThanOrEqual(4096)
      const frozen = await call('occlude', tabId, true)
      expect(frozen).toMatchObject({ ok: true, image: { type: 'image/png', data: { png: true } } })
      expect(await viewOf(guestId)).toMatchObject([{ visible: false }])
      expect(await call('focus', tabId)).toEqual({ ok: false, error: 'hidden' })
      expect(await call('occlude', tabId, false)).toEqual({ ok: true, image: null })
      expect(await viewOf(guestId)).toMatchObject([{ visible: true }])

      // 标注 reads the page from its own world: the page's replaced functions change nothing, it sees nothing, and long
      // text comes back cut.
      expect(await call('navigate', tabId, `${local}/hostile`)).toMatchObject({ ok: true })
      await settled(guestId, `${local}/hostile`)
      const marked = await call('annotate', tabId, { x: 60, y: 40 })
      expect(marked).toMatchObject({
        ok: true,
        target: {
          url: `${local}/hostile`,
          tag: 'button',
          selector: '#target',
          text: '保存设置',
          rect: { x: 20, y: 20, width: 160, height: 40 },
          image: { type: 'image/png', data: { png: true } },
        },
      })
      expect(await inGuest(guestId, `[document.querySelector('#target') === document.getElementById('target'), window.mutations]`)).toEqual(
        [true, 0],
      )
      // Named controls shadow their form's members in the isolated world too; the script reads through its own prototypes.
      const labelled = await call('annotate', tabId, { x: 420, y: 50 })
      expect(labelled).toMatchObject({
        ok: true,
        target: { tag: 'form', text: '表单标签', rect: { x: 300, y: 20, width: 200, height: 60 } },
      })
      const deep = await call('annotate', tabId, { x: 320, y: 50 })
      expect(deep).toMatchObject({ ok: true, target: { tag: 'span', text: '里面的标签', rect: { x: 300, y: 20, width: 50, height: 60 } } })
      expect(
        await inGuest(
          guestId,
          `[document.querySelector(${JSON.stringify(labelled.target.selector)}) === document.querySelector('form.labelled'),
            document.querySelector(${JSON.stringify(deep.target.selector)}) === document.querySelector('span.deep'), window.mutations]`,
        ),
      ).toEqual([true, true, 0])
      const long = await call('annotate', tabId, { x: 60, y: 130 })
      expect(long).toMatchObject({ ok: true, target: { tag: 'p', selector: '#long' } })
      expect(long.target.text.length).toBeLessThanOrEqual(200)
      expect(LONG_TEXT.replace(/\s+/gu, ' ')).toContain(long.target.text)

      // The app's shortcuts reach the page from a focused tab, and the tab's page never sees them; other keys stay there.
      await page.evaluate(() => {
        const keys: unknown[] = []
        Reflect.set(globalThis, 'pageKeys', keys)
        addEventListener('keydown', event => keys.push([event.code, event.metaKey, event.altKey]), true)
      })
      await inGuest(guestId, `window.guestKeys = []; addEventListener('keydown', event => guestKeys.push(event.code), true); true`)
      expect(await call('focus', tabId)).toEqual({ ok: true })
      await app.evaluate(({ webContents }, id) => {
        const contents = webContents.fromId(id)!
        for (const [keyCode, modifiers] of [
          ['K', ['meta']],
          ['B', ['meta', 'alt']],
        ] as const) {
          contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: [...modifiers] })
          contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: [...modifiers] })
        }
      }, guestId)
      await waitFor(async () => (await page.evaluate(() => (Reflect.get(globalThis, 'pageKeys') as unknown[]).length)) >= 2)
      expect(await page.evaluate(() => Reflect.get(globalThis, 'pageKeys'))).toEqual([
        ['KeyK', true, false],
        ['KeyB', true, true],
      ])
      await sleep(200)
      expect(await inGuest(guestId, 'guestKeys')).toEqual([])
      await app.evaluate(({ webContents }, id) => {
        const contents = webContents.fromId(id)!
        contents.focus()
        contents.sendInputEvent({ type: 'keyDown', keyCode: 'A' })
        contents.sendInputEvent({ type: 'keyUp', keyCode: 'A' })
      }, guestId)
      await waitFor(async () => (await inGuest<string[]>(guestId, 'guestKeys')).includes('KeyA'))

      // Zoom steps, and the developer tools open in their own window, in the tab's partition, loading only themselves.
      expect(await call('zoom', tabId, 'in')).toEqual({ ok: true, zoom: 1.1 })
      expect(await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.getZoomFactor(), guestId)).toBeCloseTo(1.1)
      expect(await call('zoom', tabId, 'reset')).toEqual({ ok: true, zoom: 1 })
      expect(await call('devTools', tabId)).toEqual({ ok: true })
      await waitFor(() =>
        app.evaluate(({ webContents }, id) => {
          const tools = webContents.fromId(id)!.devToolsWebContents
          return Boolean(tools && tools.getURL().startsWith('devtools://') && !tools.isLoading())
        }, guestId),
      )
      expect(
        await app.evaluate(({ webContents }, id) => {
          const contents = webContents.fromId(id)!
          return contents.devToolsWebContents!.session === contents.session
        }, guestId),
      ).toBe(true)
      await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.closeDevTools(), guestId)

      // Each project keeps its own storage, and 清除数据 empties it.
      expect(await call('navigate', tabId, `${local}/`)).toMatchObject({ ok: true })
      await settled(guestId, `${local}/`)
      await inGuest(guestId, `localStorage.setItem('latch-e2e', 'alpha'); document.cookie = 'latch-e2e=alpha'; true`)
      const second = await call('open', 'beta', 'ses_e2e', `${local}/`)
      expect(second).toMatchObject({ ok: true })
      await waitFor(async () => (await guests()).filter(guest => guest.url === `${local}/`).length === 2)
      const otherId = (await guests()).find(guest => guest.url === `${local}/` && guest.id !== guestId)!.id
      await settled(otherId, `${local}/`)
      expect(await inGuest(otherId, `[localStorage.getItem('latch-e2e'), document.cookie]`)).toEqual([null, ''])
      expect(await inGuest(guestId, `[localStorage.getItem('latch-e2e'), document.cookie]`)).toEqual(['alpha', 'latch-e2e=alpha'])
      expect(await call('clearData', 'alpha')).toEqual({ ok: true })
      expect(await call('reload', tabId)).toEqual({ ok: true })
      await sleep(300)
      await settled(guestId, `${local}/`)
      expect(await inGuest(guestId, `[localStorage.getItem('latch-e2e'), document.cookie]`)).toEqual([null, ''])
      expect(await call('close', second.tabId)).toEqual({ ok: true })
      expect(await call('close', second.tabId)).toEqual({ ok: false, error: 'not-found' })
      await waitFor(async () => !(await guests()).some(guest => guest.id === otherId))

      // A tab lives with the window: reloading the page hides it and the page lists it again; closing the window ends it.
      await page.reload()
      await page.waitForLoadState('domcontentloaded')
      expect((await guests()).map(guest => guest.id)).toEqual([guestId])
      expect(await viewOf(guestId)).toMatchObject([{ visible: false }])
      expect(await call('list')).toMatchObject({ ok: true, tabs: [{ tabId, projectId: 'alpha', sessionId: 'ses_e2e' }] })
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
      await waitFor(async () => (await guests()).length === 0)
      expect(hostTls.connections()).toBe(0)
    } finally {
      await application?.close()
      await secure.close()
      await site.close()
      await devProxy.close()
      await hostTls.close()
      await testHost.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
