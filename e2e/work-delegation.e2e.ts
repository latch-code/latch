import { _electron, type ElectronApplication } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { writeHostState } from '@latch/host/host-state'
import type { AppSnapshot, CustomAgent, WorkItemAnswer, WorkThreadAnswer } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { makeTestTls } from '@latch/testkit'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openEntry, openSection, openSessions, settleShell } from './helpers/layout.ts'
import { freePort, trustBootstrap } from './helpers/paired-computers.ts'
import { switchView } from './helpers/workbench.ts'

type Fixture = {
  clipboardText: string
  registry: {
    proxyFor(hostId: string): {
      probe(): Promise<{ snapshot: AppSnapshot }>
      handle(request: Request, signal?: AbortSignal): Promise<Response>
    }
  }
  dropReceipt: boolean
  sends: number
  confirmations: number
  consent?: string
  holdSessionId?: string
  readGate?: Promise<void>
  releaseRead?: () => void
  waitingForRead?: boolean
}

it.skipIf(process.platform !== 'darwin' || latchEnv(process.env, 'ELECTRON_E2E') !== '1')(
  'recovers a paired assistant’s lost receipt in the original work item and opens its answer on the destination',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'latch-delegation-'))
    const tls = await makeTestTls(join(directory, 'tls'))
    const port = await freePort()
    const received: string[] = []
    const answer = '目标电脑核对完毕，结果只保存在这里。'
    const followupAnswer = '目标电脑核对了第二条记录。'
    const provider: HarnessPlugin = {
      id: 'remote-fixture',
      name: 'Remote fixture',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerProvider({
          id: 'remote-fixture',
          name: 'Remote fixture',
          model: 'remote-only',
          async *stream({ messages }) {
            received.push(JSON.stringify(messages))
            yield { type: 'text', text: received.length === 1 ? answer : followupAnswer }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    const source = await startTestHost({ hostName: '来源电脑' })
    const target = await startTestHost({
      hostName: '执行电脑',
      plugins: [provider],
      tls: {
        host: '127.0.0.1',
        port,
        publicOrigin: `https://${tls.hostname}:${port}`,
        certPath: tls.certPath,
        keyPath: tls.keyPath,
        allowLocalPeers: true,
      },
    })
    let app: ElectronApplication | undefined
    try {
      const owner = await source.enroll({ listener: 'unix' })
      const operator = await target.enroll({ listener: 'unix' })
      const worker = await operator.json<CustomAgent>('custom-agents', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          name: '审阅助手',
          harnessId: 'standard',
          model: { providerId: 'remote-fixture', model: 'remote-only' },
        },
      })
      const shortcut = await owner.json<CustomAgent>('custom-agents', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          name: '远程审阅',
          harnessId: 'standard',
          workComputer: { hostId: target.host.hostId, agentId: worker.id },
        },
      })
      const title = '仅来源电脑可见的待办'
      const { item } = await owner.json<WorkItemAnswer>('work/items', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          title,
          prompt: '不要传给工作电脑的背景',
        },
      })
      const message = '请核对这次发布。'
      await writeHostState(source.dataDir, {
        version: 2,
        pid: process.pid,
        hostId: source.host.hostId,
        instanceId: source.host.instanceId,
        socketPath: source.host.socketPath,
        loopbackOrigin: source.host.loopbackOrigin,
        tlsOrigin: null,
        startedAt: new Date().toISOString(),
        dataDir: source.dataDir,
      })
      app = await _electron.launch({
        args: [
          await trustBootstrap(directory, tls.ca),
          '--latch-host-state=' + join(source.dataDir, 'host.json'),
          '--latch-user-data=' + join(directory, 'electron'),
          '--use-mock-keychain',
        ],
        cwd: process.cwd(),
        env: Object.fromEntries(
          Object.entries(desktopShellEnvironment(process.env)).filter((e): e is [string, string] => e[1] !== undefined),
        ),
      })
      const page = await app.firstWindow()
      const focusSource = async () => {
        await app!.evaluate(({ app, BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('latch://app/'))!
          app.focus({ steal: true })
          window.show()
          window.focus()
          window.webContents.focus()
        })
        await expect
          .poll(() =>
            app!.evaluate(({ BrowserWindow }) => {
              const contents = BrowserWindow.getFocusedWindow()?.webContents
              return contents?.getURL().startsWith('latch://app/') && contents.isFocused()
            }),
          )
          .toBe(true)
      }

      page.setDefaultTimeout(15_000)
      await page.getByRole('button', { name: '继续', exact: true }).click()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      const invite = await target.invite(['view', 'run', 'approve:standard'])
      await app.evaluate((_, url) => {
        ;(Reflect.get(globalThis, 'multiHostFixture') as Fixture).clipboardText = url
      }, invite.url)
      await openEntry(page, '设置')
      const settings = page.locator('.settings-page')
      await openSection(settings, '电脑')
      await settings.getByRole('button', { name: '添加电脑', exact: true }).click()
      await settings.locator(`[data-computer="${target.host.hostId}"]`).getByText('在线', { exact: true }).waitFor()
      const deviceId = await app.evaluate(async ({ dialog }, hostId) => {
        const fixture = Reflect.get(globalThis, 'multiHostFixture') as Fixture
        const proxy = fixture.registry.proxyFor(hostId)
        const deviceId = (await proxy.probe()).snapshot.device.id
        const original = proxy.handle.bind(proxy)
        fixture.sends = 0
        fixture.confirmations = 0
        proxy.handle = async (request, signal) => {
          const path = new URL(request.url).pathname
          // The destination view stays on its warm transcript until the explicit detail read is let through.
          if (path === '/link/api/events') {
            const stream = new ReadableStream({ start: controller => controller.enqueue(new TextEncoder().encode(': paused\n\n')) })
            return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
          }
          if (path === `/link/api/tasks/${fixture.holdSessionId}` && fixture.readGate) {
            fixture.waitingForRead = true
            await fixture.readGate
          }
          if (path.includes('/mentions/by-request/') && fixture.dropReceipt) return new Response(null, { status: 503 })
          const send = request.method === 'POST' && path.endsWith('/mentions') ? ++fixture.sends : 0
          const result = await original(request, signal)
          if (result.ok && send === 1) {
            fixture.dropReceipt = true
            return new Response(null, { status: 504 })
          }
          return result
        }
        const show = dialog.showMessageBox.bind(dialog)
        dialog.showMessageBox = (...args: [Electron.MessageBoxOptions] | [Electron.BaseWindow, Electron.MessageBoxOptions]) => {
          const options = args.at(-1) as Electron.MessageBoxOptions
          if (!options.detail?.includes('请核对这次发布。')) return Reflect.apply(show, dialog, args)
          fixture.confirmations++
          fixture.consent = options.detail
          const response = options.buttons?.findIndex((_, index) => index !== options.cancelId) ?? -1
          return Promise.resolve({ response, checkboxChecked: false })
        }
        return deviceId
      }, target.host.hostId)
      await operator.confirmedJson(`devices/${deviceId}`, { method: 'PATCH', body: { dataScope: 'all' } })
      await openSessions(page)
      await switchView(page, 'board')
      await page.locator(`[data-work-item="${item.id}"] .work-board-card-main`).click()
      const thread = page.locator('.item-thread')
      const field = thread.getByRole('combobox', { name: '发言' })
      const chooseRecipient = async () => {
        await field.fill('@' + shortcut.name)
        await page.getByRole('option', { name: new RegExp(shortcut.name, 'u') }).click()
        await thread.locator('.item-thread-input-target').getByText(`@${shortcut.name} · 执行电脑`, { exact: true }).waitFor()
      }
      const send = async (text: string) => {
        await field.fill(text)
        await focusSource()
        await thread.getByRole('button', { name: '发送', exact: true }).click()
      }
      await chooseRecipient()
      const secret = `${message} sk-ant-api03-${'a'.repeat(40)}`
      await send(secret)
      await thread.getByText('发言像含有密钥，没有发出。', { exact: true }).waitFor()
      expect(await field.inputValue()).toBe(secret)
      expect(await field.isEditable()).toBe(true)
      expect((await owner.json<WorkThreadAnswer>(`work/items/${item.id}/posts`)).posts).toHaveLength(0)
      expect(received).toHaveLength(0)
      await send(message)
      const row = thread.locator('[data-remote-status]').filter({ hasText: message })
      await expect
        .poll(async () => row.isVisible().then(async visible => (visible ? 'saved' : await thread.innerText())), { timeout: 12_000 })
        .toBe('saved')
      await expect.poll(() => received.length, { timeout: 15_000 }).toBe(1)
      expect(received[0]).toContain(message)
      expect(received[0]).not.toContain(title)
      expect(received[0]).not.toContain('不要传给工作电脑的背景')
      await expect.poll(() => row.getAttribute('data-remote-status')).toBe('unknown')
      const postId = await row.getAttribute('data-post-id')
      await page.locator('.item-page').getByRole('button', { name: '看板', exact: true }).click()
      await page.locator(`[data-work-item="${item.id}"] .work-board-card-main`).click()
      expect(await row.getAttribute('data-post-id')).toBe(postId)
      await app.evaluate(() => {
        ;(Reflect.get(globalThis, 'multiHostFixture') as Fixture).dropReceipt = false
      })
      await row.getByRole('button', { name: '刷新状态' }).click()
      await expect.poll(() => row.getAttribute('data-remote-status'), { timeout: 10_000 }).toBe('completed')
      expect(await app.evaluate(() => (Reflect.get(globalThis, 'multiHostFixture') as Fixture).sends)).toBe(1)
      expect(await app.evaluate(() => (Reflect.get(globalThis, 'multiHostFixture') as Fixture).consent)).toContain(worker.name)
      const { posts } = await owner.json<WorkThreadAnswer>(`work/items/${item.id}/posts`)
      expect(posts).toHaveLength(1)
      expect(JSON.stringify(posts)).not.toContain(answer)
      expect((await source.host.bridge.listTasks()).length).toBe(0)
      expect(await page.getByText('未确认送达。请刷新状态，或重试这条发言。', { exact: true }).count()).toBe(0)
      const shots = 'test-results/work-delegation'
      await mkdir(shots, { recursive: true })
      for (const width of [390, 768, 1440]) {
        await app.evaluate(({ BrowserWindow }, width) => {
          const win = BrowserWindow.getAllWindows()[0]!
          win.setMinimumSize(Math.min(width, 768), 560)
          win.setContentSize(width, 900)
        }, width)
        for (const theme of ['light', 'dark'] as const) {
          await app.evaluate(({ nativeTheme }, theme) => {
            nativeTheme.themeSource = theme
          }, theme)
          await page.emulateMedia({ colorScheme: theme })
          await row.scrollIntoViewIfNeeded()
          await settleShell(page)
          await noHorizontalOverflow(page, thread)
          await page.screenshot({ path: join(shots, `receipt--${width}--${theme}.png`), animations: 'disabled' })
        }
      }
      await focusSource()
      const opened = app.waitForEvent('window')
      await row.getByRole('button', { name: /查看结果/u }).click()
      const resultPage = await opened
      const original = resultPage.locator(`[data-message-id="${posts[0]!.remote!.messageId}"]`).getByText(answer, { exact: true }).first()
      await original.waitFor({ timeout: 15_000 })
      await resultPage.locator('.app-shell[data-connection="connected"]').waitFor()
      expect(await row.isVisible()).toBe(true)

      await app.evaluate((_, sessionId) => {
        const fixture = Reflect.get(globalThis, 'multiHostFixture') as Fixture
        fixture.holdSessionId = sessionId
        fixture.readGate = new Promise<void>(resolve => {
          fixture.releaseRead = resolve
        })
      }, posts[0]!.remote!.sessionId)
      try {
        const followup = message + ' 再核对一遍。'
        await focusSource()
        await chooseRecipient()
        await send(followup)
        await expect
          .poll(
            async () => {
              const { posts } = await owner.json<WorkThreadAnswer>(`work/items/${item.id}/posts`)
              const post = posts.find(post => post.text === followup)
              const confirmations = await app!.evaluate(() => (Reflect.get(globalThis, 'multiHostFixture') as Fixture).confirmations)
              return { confirmations, savedForRecipient: post?.remote?.agentId === worker.id }
            },
            { timeout: 15_000, message: 'Confirm and save the follow-up for the paired assistant' },
          )
          .toMatchObject({ confirmations: 3, savedForRecipient: true })
        await expect
          .poll(() => ({ arrived: received.at(-1)?.includes(followup), count: received.length }), {
            timeout: 15_000,
            message: 'Run the paired assistant on the follow-up once',
          })
          .toEqual({ arrived: true, count: 2 })
        const next = thread.locator('[data-remote-status]').filter({ hasText: followup })
        await expect
          .poll(async () => ((await next.count()) === 1 ? next.getAttribute('data-remote-status') : 'not shown'), {
            timeout: 15_000,
            message: 'Reflect the destination completion in the source work item',
          })
          .toBe('completed')
        expect(await original.isVisible()).toBe(true)
        await focusSource()
        await next.getByRole('button', { name: /查看结果/u }).click()
        const remoteOrigin = `latch://h-${target.host.hostId}/`
        await expect
          .poll(() =>
            app!.evaluate(
              ({ BrowserWindow }, origin) => BrowserWindow.getFocusedWindow()?.webContents.getURL().startsWith(origin),
              remoteOrigin,
            ),
          )
          .toBe(true)
        await expect.poll(() => app!.evaluate(() => (Reflect.get(globalThis, 'multiHostFixture') as Fixture).waitingForRead)).toBe(true)
        await settleShell(resultPage)
        expect(await resultPage.getByText(followupAnswer, { exact: true }).count()).toBe(0)
        expect(await resultPage.getByText('原回合已不可用', { exact: true }).count()).toBe(0)
      } finally {
        await app.evaluate(() => {
          const fixture = Reflect.get(globalThis, 'multiHostFixture') as Fixture
          fixture.readGate = undefined
          fixture.releaseRead?.()
        })
      }
      await resultPage.getByText(followupAnswer, { exact: true }).first().waitFor({ timeout: 15_000 })
    } finally {
      try {
        if (app) {
          // The disposable Electron process can remain alive after its last renderer exits on macOS.
          const child = app.process()
          const stop = setTimeout(() => child.kill('SIGKILL'), 8000)
          try {
            await app.close()
          } finally {
            clearTimeout(stop)
          }
        }
      } finally {
        await Promise.all([source.close(), target.close()])
        await rm(directory, { recursive: true, force: true })
      }
    }
  },
)
