import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HarnessPlugin } from '@latch/sdk'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { startTestHost, type TestHost } from './helpers/host.ts'

const MARK_TOOL = 'mark_release'
const R2_PROMPT = '标记发布版本'
const SECRET_MARKERS = ['ldc1.', 'PRIVATE KEY']

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
  await page.screenshot({ path: 'test-results/native-desktop-enrollment.png' })
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
      expect(await page.evaluate(() => (globalThis as unknown as { latchShell?: unknown }).latchShell)).toEqual({
        kind: 'electron',
        devMode: true,
        platform: 'darwin',
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
      await page.screenshot({ path: 'test-results/native-desktop.png' })

      // High-risk approval: allowed only after the local confirmation.
      const { sessionId } = await host.bridge.createTask({
        prompt: R2_PROMPT,
        requestId: randomUUID(),
        mode: 'agent',
        model: { providerId: 'e2e-desktop', model: 'e2e' },
      })
      await waitFor(() => host.bridge.approvals().some(approval => approval.sessionId === sessionId))
      await page.getByText(R2_PROMPT).first().click()
      await page.getByText('高风险').first().waitFor()
      await page.getByRole('button', { name: '在本机确认后允许' }).click()
      const confirmation = await testHost.presence.waitForRequest(15_000)
      expect(confirmation.preview.action).toBe('approval.r2')
      await page.getByRole('dialog', { name: '请在本机确认' }).waitFor()
      await page.screenshot({ path: 'test-results/native-desktop-confirmation.png' })
      expect(marks.ran).toBe(0)
      testHost.presence.approveNext()
      await waitFor(() => marks.ran === 1)
      await waitFor(async () => (await host.bridge.detail(sessionId)).summary.status === 'idle')

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
