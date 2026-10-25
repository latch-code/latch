import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSettings, WorkspaceInfo } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { expectUnmovedByInjectedStyles } from './helpers/security.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { closeSettings, openSettings } from './helpers/layout.ts'

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
      // The shell's facts and its folder actions (functions, so only their names cross back here); nothing else.
      expect(
        await page.evaluate(() => {
          const shell: PageShell = Reflect.get(globalThis, 'latchShell')
          return {
            keys: Object.keys(shell).toSorted(),
            kind: shell.kind,
            devMode: shell.devMode,
            platform: shell.platform,
            folders: Object.keys(shell.folders).toSorted(),
            callable: Object.entries(shell.folders)
              .filter(([key]) => key !== 'protocolVersion')
              .every(([, value]) => typeof value === 'function'),
          }
        }),
      ).toEqual({
        keys: ['devMode', 'folders', 'kind', 'platform'],
        kind: 'electron',
        devMode: true,
        platform: 'darwin',
        folders: ['drop', 'pick', 'protocolVersion', 'reveal', 'saveSessionFolder'],
        callable: true,
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
      await application.evaluate(({ dialog, shell }) => {
        const links: ExternalLinks = { asked: [], opened: [], answer: 1 }
        Object.assign(globalThis, { externalLinks: links })
        dialog.showMessageBox = (async (...args: unknown[]) => {
          links.asked.push(args.at(-1) as Record<string, unknown>)
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
      const confirmation = await testHost.presence.waitForRequest(15_000)
      expect(confirmation.preview.action).toBe('approval.r2')
      // No dock: the button keeps its words and width while it waits, and the line under the preview says what to do.
      await card.locator('.ui-button[aria-busy="true"]', { hasText: '在本机允许' }).waitFor()
      await card.getByText('等待本机确认：在弹出的确认窗口中核对内容，再用 Touch ID 或登录密码确认。', { exact: true }).waitFor()
      expect(await page.locator('.presence-dock').count()).toBe(0)
      expect(Math.abs((await allow.boundingBox())!.width - resting)).toBeLessThanOrEqual(1)
      await captureThemes(page, 'native-desktop-confirmation')
      // The card keeps its look under styles added to the page while it waits.
      await expectUnmovedByInjectedStyles(page, [
        '[data-approval-id] .tool-card-header .ui-status-pill',
        '[data-approval-id] .approval-footnote',
        '[data-approval-id] .ui-button',
      ])
      // A denial returns the buttons at once with the reason in the card; nothing ran.
      expect(marks.ran).toBe(0)
      testHost.presence.denyNext()
      await card.locator('.approval-failure', { hasText: '操作没有执行。本机确认没有通过。' }).waitFor()
      await card.locator('.ui-button[aria-busy="true"]').waitFor({ state: 'detached' })
      expect(await card.locator('.ui-button[aria-disabled="true"]').count()).toBe(0)
      await captureThemes(page, 'native-desktop-confirmation-denied')
      await expectUnmovedByInjectedStyles(page, [
        '[data-approval-id] .approval-failure',
        '[data-approval-id] .approval-failure .ui-notice-text',
      ])
      // Allowing again from the card asks for a new confirmation of the same request.
      expect(marks.ran).toBe(0)
      await allow.click()
      const again = await testHost.presence.waitForRequest(15_000)
      expect(again.preview.action).toBe('approval.r2')
      await card.locator('.approval-failure').waitFor({ state: 'detached' })
      testHost.presence.approveNext()
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
      await qr.evaluate(async (image: HTMLImageElement) => {
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
      await showPairing()
      await captureThemes(page, 'native-desktop-pairing-ready')
      // Ten minutes later on this computer's clock: the code has lapsed and the panel offers a new one.
      await page.evaluate('globalThis.latchRealNow = Date.now; Date.now = () => globalThis.latchRealNow() + 11 * 60 * 1000')
      await pairing.getByText('上一个二维码已过期。', { exact: true }).waitFor()
      await showPairing()
      await captureThemes(page, 'native-desktop-pairing-expired')
      await page.evaluate('Date.now = globalThis.latchRealNow')
      expect(phone.device.scopes).toEqual(['view'])
      // A device's actions are in its row's ⋯ menu.
      const row = settings.locator(`[data-device-id="${phone.device.id}"]`)
      await row.getByRole('button', { name: '测试手机 的操作', exact: true }).click()
      await page.getByRole('menuitem', { name: '调整权限…', exact: true }).click()
      const grant = page.getByRole('dialog', { name: '调整权限', exact: true })
      await grant.getByRole('checkbox', { name: '发起和继续会话', exact: true }).check()
      await grant.getByRole('button', { name: '授予权限（需要本机确认）', exact: true }).click()
      expect((await testHost.presence.waitForRequest(15_000)).preview.action).toBe('device.grant')
      const dock = page.locator('.presence-dock[open]')
      await dock.locator('[data-confirmation-phase="waiting"]').waitFor()
      await expect.poll(() => dock.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
      // No countdown: the confirmation window times out on its own.
      expect(await dock.getByRole('timer').count()).toBe(0)
      await captureThemes(page, 'native-desktop-confirmation-dock')
      await expectUnmovedByInjectedStyles(page, [
        '.presence-dock[open]',
        '.presence-dock .ui-dialog-surface',
        '.presence-dock .ui-dialog-title',
        '.presence-dock .presence-line',
        '.presence-dock .ui-button',
      ])
      testHost.presence.denyNext()
      await dock.locator('[data-confirmation-phase="failed"]').waitFor()
      // Only 关闭: the grant is asked for again from its own button.
      expect(await dock.getByRole('button').allInnerTexts()).toEqual(['关闭'])
      await captureThemes(page, 'native-desktop-confirmation-dock-failed')
      await dock.getByRole('button', { name: '关闭', exact: true }).click()
      await dock.waitFor({ state: 'detached' })
      await grant.getByRole('button', { name: '取消', exact: true }).click()
      expect(host.security.devices.get(phone.device.id)?.scopes).toEqual(['view'])
      await closeSettings(settings)

      // A full-access agent's question: advisory, and on the Host's own desktop it may be answered with 允许一次.
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
      await advisory.getByRole('button', { name: '拒绝', exact: true }).click()
      await waitFor(async () => (await host.bridge.detail(advisoryId)).summary.status === 'idle')

      // 设置 › 电脑 in the desktop app: lowering applies at once, raising takes the local confirmation.
      const policy = () => host.security.policy.get()
      await page.locator('#session-navigation').getByRole('button', { name: '设置', exact: true }).click()
      const computer = page.getByRole('dialog', { name: '设置', exact: true })
      await computer.getByRole('tab', { name: '电脑', exact: true }).click()
      await computer.getByRole('button', { name: '在这台电脑上发起：完全访问', exact: true }).click()
      await page.getByRole('menuitemradio', { name: /^逐项询问/ }).click()
      await waitFor(() => !policy().local.allowL3)
      expect(policy().local).toEqual({ maxLevel: 'L1', allowL3: false })
      await computer.getByRole('button', { name: '在这台电脑上发起：逐项询问', exact: true }).click()
      await page.getByRole('menuitemradio', { name: /^完全访问/ }).click()
      const raise = await testHost.presence.waitForRequest(15_000)
      expect(raise.preview.action).toBe('policy.change')
      expect(raise.preview.requester.listener).toBe('unix')
      // The confirmation waits in the dock at the foot of the page.
      await page.locator('.presence-dock[open] [data-confirmation-phase="waiting"]').waitFor()
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
      await projectCard.getByRole('button', { name: '在访达中显示', exact: true }).click()
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
      await computer.getByRole('button', { name: /^返回会话/ }).click()

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

      await application.close()
      application = undefined
      expect((await testHost.raw('unix', 'api/health')).status).toBe(200)
      expect((await host.bridge.detail(longTask.id)).summary.status).toBe('running')
      await host.bridge.cancel(longTask.id)
      expect((await host.bridge.detail(longTask.id)).summary.status).toBe('cancelled')
    } finally {
      await application?.close()
      await counter.close()
      await testHost.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
