import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HarnessPlugin } from '@latch/sdk'
import type { TaskDetail, WorkspaceInfo } from '@latch/protocol'
import { queryHostInfo, writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import type { ServerOptions } from '@latch/host'
import { startTestHost } from './helpers/host.ts'

type Launch = NonNullable<NonNullable<ServerOptions['terminal']>['launch']>

/** A stand-in for latch-pty that only announces a local service, as a dev server's first lines do. */
function serviceShell(port: () => number): Launch {
  return (_spec, emit) => {
    emit({ type: 'started', pid: 1 })
    setTimeout(() => emit({ type: 'output', data: Buffer.from(`  VITE ready\r\n  ➜  Local:   http://127.0.0.1:${port()}/\r\n$ `) }), 10)
    let ended = false
    const end = () => {
      if (ended) return
      ended = true
      emit({ type: 'exit', signal: 1 })
      emit({ type: 'gone' })
    }
    return {
      pendingInput: 0,
      input() {},
      resize() {},
      signal() {},
      pauseOutput() {},
      resumeOutput() {},
      close: () => (end(), Promise.resolve()),
    }
  }
}

const electronE2E = latchEnv(process.env, 'ELECTRON_E2E') === '1'
const CAPTURES = 'test-results/desktop-browser'

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

async function listen(server: Server, port = 0) {
  await new Promise<void>(done => server.listen(port, '127.0.0.1', done))
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

/** The page under test: a button to pick, a console error and warning, a request that fails, and what the page sees. */
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>浏览器夹具</title>
<meta name="viewport" content="width=device-width">
<style>body{font:16px system-ui;margin:0;padding:24px}button{position:absolute;left:24px;top:80px;width:160px;height:40px}
@media (prefers-color-scheme: dark){body{background:#111;color:#eee}}</style></head>
<body><h1>本地开发页</h1><button id="save">保存设置</button><p id="facts" style="margin-top:96px"></p>
<script>
console.error('fixture error')
console.warn('fixture warning')
fetch('/api/missing?ref=never-shown')
const facts = () => { document.getElementById('facts').textContent = innerWidth + ' · ' + (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') }
facts(); addEventListener('resize', facts); matchMedia('(prefers-color-scheme: dark)').addEventListener('change', facts)
</script></body></html>`

function fixtureSite() {
  return createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://x').pathname
    if (path === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(FIXTURE)
    } else if (path === '/slow') {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end('<title>慢页面</title><p>到了</p>')
      }, 4_000)
    } else {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('missing')
    }
  })
}

/**
 * A capture of the window as a person sees it: the page, with each visible preview view painted where main placed it
 * (a page screenshot alone cannot show the native views).
 */
async function capture(app: ElectronApplication, page: Page, name: string) {
  await mkdir(CAPTURES, { recursive: true })
  const base = (await page.screenshot({ animations: 'disabled' })).toString('base64')
  const views = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!
    const shown = window.contentView.children.filter((view): view is Electron.WebContentsView => 'webContents' in view && view.getVisible())
    return Promise.all(
      shown.map(async view => ({ bounds: view.getBounds(), png: (await view.webContents.capturePage()).toPNG().toString('base64') })),
    )
  })
  const data = await page.evaluate(
    async ([shot, layers]) => {
      const load = (png: string) =>
        new Promise<HTMLImageElement>(done => {
          const image = new Image()
          image.onload = () => done(image)
          image.src = `data:image/png;base64,${png}`
        })
      const background = await load(shot)
      const canvas = document.createElement('canvas')
      canvas.width = background.naturalWidth
      canvas.height = background.naturalHeight
      const context = canvas.getContext('2d')!
      context.drawImage(background, 0, 0)
      const ratio = background.naturalWidth / innerWidth
      for (const layer of layers) {
        const image = await load(layer.png)
        const { x, y, width, height } = layer.bounds
        context.drawImage(image, x * ratio, y * ratio, width * ratio, height * ratio)
      }
      return canvas.toDataURL('image/png').split(',')[1]!
    },
    [base, views] as const,
  )
  await writeFile(join(CAPTURES, `${name}.png`), Buffer.from(data, 'base64'))
}

/** Light and dark captures of the page as it stands. */
async function captureThemes(app: ElectronApplication, page: Page, name: string) {
  await capture(app, page, `${name}--light`)
  await page.emulateMedia({ colorScheme: 'dark' })
  await new Promise(done => setTimeout(done, 150))
  await capture(app, page, `${name}--dark`)
  await page.emulateMedia({ colorScheme: 'light' })
}

describe.skipIf(!electronE2E || process.platform !== 'darwin')('native desktop shell: the 浏览器 tab', () => {
  it('opens a local site, sets viewport and appearance, puts a screenshot and a picked element into the draft, shows logs, keeps tabs across a reload and refuses the gateway', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-browser-ui-'))
    const plugin: HarnessPlugin = {
      id: 'e2e-browser',
      name: '浏览器测试模型',
      version: '1.0.0',
      description: '只在测试中使用。',
      activate(context) {
        context.registerProvider({
          id: 'e2e-browser',
          name: '浏览器测试模型',
          model: 'fixture',
          modelCapabilities: { fixture: { vision: true } },
          async *stream() {
            yield { type: 'text', text: '好的。' }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    let sitePort = 0
    const testHost = await startTestHost({
      demo: false,
      uiDir: resolve('dist/web'),
      presenceMode: 'manual',
      plugins: [plugin],
      terminal: { launch: serviceShell(() => sitePort), shell: { file: '/bin/sh', argv: ['sh'] } },
    })
    const { host } = testHost
    const site = await listen(fixtureSite())
    sitePort = site.port
    // A port with nothing on it yet: the dev server that is still starting.
    const later = await listen(createServer())
    const laterPort = later.port
    await later.close()
    let starting: { close(): Promise<void> } | undefined
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
      const info = await queryHostInfo(host.socketPath)
      expect(info.modelGatewayPort).toEqual(expect.any(Number))
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
      const app = application
      const page = await app.firstWindow()
      page.setDefaultTimeout(20_000)
      const resize = (width: number, height = 900) =>
        app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setContentSize(w!, h!), [width, height])
      await resize(1440)
      await page.getByRole('button', { name: '继续', exact: true }).click()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      const owner = await testHost.enroll({ listener: 'unix', name: 'Other' })
      const folder = join(root, 'project')
      await mkdir(folder, { recursive: true })
      const added = await owner.addFolders({ name: '浏览器项目', paths: [folder] })
      expect(added.status).toBe(201)
      const project = ((await added.json()) as { workspace: WorkspaceInfo }).workspace
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          prompt: '看看页面',
          mode: 'agent',
          workspaceId: project.id,
          model: { providerId: 'e2e-browser', model: 'fixture' },
        },
      })
      await waitFor(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status === 'idle')

      await page.locator(`[data-task-id="${sessionId}"]`).click()

      const guests = () =>
        app.evaluate(({ webContents, session }) =>
          webContents
            .getAllWebContents()
            .filter(contents => contents.session !== session.defaultSession && !contents.getURL().startsWith('devtools:'))
            .map(contents => ({ id: contents.id, url: contents.getURL() })),
        )
      const inGuest = <T = unknown>(id: number, code: string) =>
        app.evaluate(({ webContents }, [target, source]) => webContents.fromId(target)!.executeJavaScript(source), [
          id,
          code,
        ] as const) as Promise<T>
      const viewOf = (id: number) =>
        app.evaluate(
          ({ BrowserWindow }, target) =>
            BrowserWindow.getAllWindows()[0]!
              .contentView.children.filter(view => 'webContents' in view && (view as Electron.WebContentsView).webContents.id === target)
              .map(view => ({ bounds: view.getBounds(), visible: view.getVisible() }))[0],
          id,
        )

      // The terminal's local service, clicked before the 浏览器 tab was ever shown, opens there on the first click.
      await page.keyboard.press('Meta+j')
      const service = page.getByRole('link', { name: `127.0.0.1:${site.port}`, exact: true })
      await service.click()
      const panel = page.getByRole('region', { name: '浏览器', exact: true })
      await panel.getByRole('tab', { name: '浏览器夹具', exact: true }).waitFor()
      await waitFor(async () => (await guests()).length === 1)
      await panel.getByRole('tab', { name: '浏览器夹具', exact: true }).focus()
      await page.keyboard.press('Delete')
      await waitFor(async () => (await guests()).length === 0)

      // No tab now: the blank page lists the terminal's service.
      await panel.getByRole('button', { name: `127.0.0.1:${site.port}`, exact: true }).waitFor()
      expect(await guests()).toEqual([])
      await captureThemes(app, page, 'blank--1440')

      // The address field opens a tab of this session on the local site, laid over the canvas.
      const local = `http://127.0.0.1:${site.port}/`
      const address = panel.getByRole('textbox', { name: '地址', exact: true })
      await address.fill(`127.0.0.1:${site.port}`)
      await address.press('Enter')
      await panel.getByRole('tab', { name: '浏览器夹具', exact: true }).waitFor()
      await waitFor(async () => (await guests()).some(guest => guest.url === local))
      const guestId = (await guests()).find(guest => guest.url === local)!.id
      const canvas = (await panel.locator('.browser-canvas').boundingBox())!
      await waitFor(async () => (await viewOf(guestId))?.visible === true)
      const placed = (await viewOf(guestId))!.bounds
      expect(placed.x).toBeCloseTo(canvas.x, -1)
      expect(placed.width).toBeCloseTo(canvas.width, -1)
      // The page's console error and warning and its failed request, in their tones; the query never shows.
      const foot = panel.locator('.browser-foot-logs')
      // Exactly what the page logged: Latch's own sandbox warning and Electron's CSP warning are left out.
      await expect.poll(() => foot.innerText(), { timeout: 10_000 }).toMatch(/^控制台\s*1 个错误\s*1 个警告\s*·\s*网络\s*1 个失败$/u)
      expect(await foot.locator('[data-tone="error"]').count()).toBe(2)
      expect(await foot.locator('[data-tone="warn"]').count()).toBe(1)
      await captureThemes(app, page, 'loaded--1440')

      // Viewport presets: the page lays out at the preset's width, scaled into the panel; rotated; and back.
      const width = () => inGuest<number>(guestId, 'innerWidth')
      await panel.getByRole('button', { name: '视口：适应面板', exact: true }).click()
      await page.getByRole('menuitemradio', { name: /^手机/u }).click()
      await waitFor(async () => (await width()) === 390)
      await panel.getByText(/^390 × 844 @3x · \d+%$/u).waitFor()
      // A phone has Latch's frame around it, outside the page.
      await panel.locator('.browser-phone-frame').waitFor()
      const phone = (await viewOf(guestId))!.bounds
      expect(phone.width).toBeLessThan(placed.width)
      expect(phone.height / phone.width).toBeCloseTo(844 / 390, 1)
      await captureThemes(app, page, 'phone--1440')
      await panel.getByRole('button', { name: '旋转', exact: true }).click()
      await waitFor(async () => (await width()) === 844)
      await panel.getByRole('button', { name: '视口：手机', exact: true }).click()
      await page.getByRole('menuitemradio', { name: /^Android 手机/u }).click()
      // A fractional pixel ratio may round the layout width by one pixel.
      await waitFor(async () => Math.abs((await width()) - 915) <= 1)
      // The panel has the new preset before it turns it.
      await panel.getByRole('button', { name: '视口：Android 手机', exact: true }).waitFor()
      await panel.getByRole('button', { name: '旋转', exact: true }).click()
      await waitFor(async () => Math.abs((await width()) - 412) <= 1)
      expect(await inGuest<number>(guestId, 'devicePixelRatio')).toBeCloseTo(2.625, 2)
      await captureThemes(app, page, 'android--1440')
      for (const [label, size] of [
        ['小屏手机', 375],
        ['大屏手机', 440],
      ] as const) {
        await panel.locator('.browser-toolbar button[aria-label^="视口："]').click()
        await page.getByRole('menuitemradio', { name: new RegExp(`^${label}`, 'u') }).click()
        await waitFor(async () => (await width()) === size)
        await panel.getByRole('button', { name: `视口：${label}`, exact: true }).waitFor()
        await captureThemes(app, page, `${size === 375 ? 'phone-small' : 'phone-large'}--1440`)
      }
      await panel.getByRole('button', { name: '视口：大屏手机', exact: true }).click()
      await page.getByRole('menuitemradio', { name: '适应面板', exact: true }).click()
      await waitFor(async () => (await width()) === placed.width)

      // Appearance: the page's prefers-color-scheme follows the choice.
      const dark = () => inGuest<boolean>(guestId, `matchMedia('(prefers-color-scheme: dark)').matches`)
      // Playwright emulates light on every page it attaches to, the views too: the starting value is that.
      const systemDark = await dark()
      await panel.getByRole('button', { name: '外观：跟随系统', exact: true }).click()
      await page.getByRole('menuitemradio', { name: systemDark ? '浅色' : '深色', exact: true }).click()
      await waitFor(async () => (await dark()) === !systemDark)
      await panel.getByRole('button', { name: /^外观：(浅色|深色)$/u }).click()
      await page.getByRole('menuitemradio', { name: '跟随系统', exact: true }).click()
      // Back to the system's own scheme (Playwright's own emulation of the page goes with the override).
      const nativeDark = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)
      await waitFor(async () => (await dark()) === nativeDark)

      // 截图 puts the visible page into the draft's attachments; nothing is sent.
      const draft = page.locator('.composer textarea').first()
      await panel.getByRole('button', { name: '截图', exact: true }).click()
      const shotName = `截图-127.0.0.1-${site.port}.png`
      await page.getByRole('button', { name: shotName, exact: true }).waitFor()

      // 选取元素 freezes the frame (the view hides, the page shows the frame), and a click on Latch's own page picks.
      await panel.getByRole('button', { name: '选取元素', exact: true }).click()
      const frame = panel.locator('img.browser-frame')
      await frame.waitFor()
      await waitFor(async () => (await viewOf(guestId))?.visible === false)
      const pick = panel.getByRole('application', { name: /^选取元素/u })
      await pick.hover({ position: { x: 100, y: 100 } })
      await panel.locator('.browser-pick-box').first().waitFor()
      await captureThemes(app, page, 'picking--1440')
      await pick.click({ position: { x: 100, y: 100 } })
      await expect.poll(() => draft.inputValue()).toContain('选择器：#save')
      expect(await draft.inputValue()).toContain('元素 · button「保存设置」（页面提供的内容）')
      await page.getByRole('button', { name: `元素-127.0.0.1-${site.port}.png`, exact: true }).waitFor()
      await frame.waitFor({ state: 'detached' })
      await waitFor(async () => (await viewOf(guestId))?.visible === true)
      expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).messages.filter(message => message.role === 'user')).toHaveLength(1)
      await draft.fill('')

      // The console and network drawer: the error goes into the draft; requests show without their query.
      await panel.getByRole('button', { name: /^控制台/u }).click()
      const list = panel.getByRole('listbox', { name: '控制台', exact: true })
      await list.getByText(/fixture error/u).waitFor()
      expect(await list.locator('.browser-log').allInnerTexts()).toEqual([
        expect.stringContaining('fixture error'),
        expect.stringContaining('fixture warning'),
      ])
      await captureThemes(app, page, 'drawer--1440')
      await panel.getByRole('button', { name: '加入对话', exact: true }).click()
      await expect.poll(() => draft.inputValue()).toContain(`浏览器控制台 · 127.0.0.1:${site.port}（页面提供的内容）`)
      expect(await draft.inputValue()).toContain('[error] fixture error')
      expect(await draft.inputValue()).not.toContain('fixture warning')
      await draft.fill('')
      // A chosen entry stays chosen while the page logs more.
      await list.getByText(/fixture warning/u).click()
      await inGuest(guestId, `for (let i = 0; i < 5; i++) console.log('later ' + i); true`)
      await list.getByText('[info] later 4', { exact: true }).waitFor()
      await panel.getByRole('button', { name: '加入对话', exact: true }).click()
      await expect.poll(() => draft.inputValue()).toContain('[warn] fixture warning')
      expect(await draft.inputValue()).not.toContain('later')
      expect(await draft.inputValue()).not.toContain('fixture error')
      await draft.fill('')
      await panel.getByRole('radio', { name: '网络', exact: true }).click()
      const requests = panel.getByRole('listbox', { name: '网络', exact: true })
      await requests.getByText(`http://127.0.0.1:${site.port}/api/missing`, { exact: true }).waitFor()
      expect(await requests.innerText()).not.toContain('never-shown')

      // The model gateway's loopback port is refused to the page like the Host's own.
      const gateway = await inGuest<string>(
        guestId,
        `fetch('http://127.0.0.1:${info.modelGatewayPort}/v1/models', { mode: 'no-cors' }).then(() => 'reached', () => 'blocked')`,
      )
      expect(gateway).toBe('blocked')
      await requests.getByText(`http://127.0.0.1:${info.modelGatewayPort}/v1/models`, { exact: true }).waitFor()
      await panel.getByRole('button', { name: /^控制台/u }).click()

      // An overlay of the page over the canvas: the view hides and its last frame stands in.
      await panel.getByRole('button', { name: '更多', exact: true }).click()
      await frame.waitFor()
      await waitFor(async () => (await viewOf(guestId))?.visible === false)
      await captureThemes(app, page, 'occluded--1440')
      await page.keyboard.press('Escape')
      await frame.waitFor({ state: 'detached' })
      await waitFor(async () => (await viewOf(guestId))?.visible === true)

      // Loading: the tab turns, and reload becomes stop.
      await address.fill(`127.0.0.1:${site.port}/slow`)
      await address.press('Enter')
      await panel.getByRole('button', { name: '停止', exact: true }).waitFor()
      await captureThemes(app, page, 'loading--1440')
      await panel.getByRole('tab', { name: '慢页面', exact: true }).waitFor({ timeout: 10_000 })

      // A local address with nothing on it yet: 等待…, tried again every two seconds until the server answers.
      await address.fill(`127.0.0.1:${laterPort}`)
      await address.press('Enter')
      await panel.getByText(`等待 127.0.0.1:${laterPort}…`, { exact: true }).waitFor()
      await waitFor(async () => (await viewOf(guestId))?.visible === false)
      await captureThemes(app, page, 'waiting--1440')
      starting = await listen(fixtureSite(), laterPort)
      await panel.getByRole('tab', { name: '浏览器夹具', exact: true }).waitFor({ timeout: 10_000 })
      await waitFor(async () => (await viewOf(guestId))?.visible === true)

      // A failure that waiting cannot fix says why, with 重新载入.
      await address.fill(`https://127.0.0.1:${site.port}/`)
      await address.press('Enter')
      await panel.getByText(new RegExp(`^连不上 127\\.0\\.0\\.1:${site.port}（ERR_`, 'u')).waitFor()
      await captureThemes(app, page, 'failed--1440')
      await address.fill(`127.0.0.1:${site.port}`)
      await address.press('Enter')
      await waitFor(async () => (await viewOf(guestId))?.visible === true)

      // 1024: the same states fit a narrower panel.
      await resize(1024)
      await new Promise(done => setTimeout(done, 400))
      await captureThemes(app, page, 'loaded--1024')
      await panel.getByRole('button', { name: /^控制台/u }).click()
      await captureThemes(app, page, 'drawer--1024')
      await panel.getByRole('button', { name: /^控制台/u }).click()
      await resize(1440)

      // A reload of the page keeps the tab: listed again and placed when the tab shows. The open session and its
      // panel's tabs come back with the page (remembered on this device since 382abe25), so the tab may show at once.
      await page.reload()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      expect((await guests()).map(guest => guest.id)).toContain(guestId)
      const fixtureTab = panel.getByRole('tab', { name: '浏览器夹具', exact: true })
      if (!(await fixtureTab.isVisible())) {
        expect((await viewOf(guestId))?.visible).toBe(false)
        await page.locator(`[data-task-id="${sessionId}"]`).click()
        await page.keyboard.press('Meta+Shift+b')
      }
      await fixtureTab.waitFor()
      await waitFor(async () => (await viewOf(guestId))?.visible === true)

      await panel.getByRole('button', { name: '新标签', exact: true }).click()
      await panel.getByRole('tab', { name: '新标签', exact: true }).waitFor()
      await captureThemes(app, page, 'blank-tab--1440')

      // Archiving the session, on any device, closes its tabs.
      expect((await guests()).length).toBe(2)
      const archived = await owner.request('tasks/batch', { body: { action: 'archive', ids: [sessionId] } })
      expect(archived.status).toBe(200)
      await waitFor(async () => (await guests()).length === 0)
    } finally {
      await application?.close()
      await starting?.close()
      await site.close()
      await testHost.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
