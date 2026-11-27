import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { writeHostState } from '@latch/host/host-state'
import { openEntry, openSection, openSessions } from './helpers/layout.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const URL = 'latch://app/link/'
interface RecoveryFixture {
  failures: number
  blockedPrompts: number
  blockPrompt: boolean
  clipboardText: string
  prompt?: { message: string; buttons: string[] }
  respond?: (response: number) => void
}

async function withWorkbench(run: (application: ElectronApplication, page: Page, host: TestHost) => Promise<void>, tlsCa?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'latch-workbench-recovery-'))
  const host = await startTestHost()
  let application: ElectronApplication | undefined
  try {
    await writeHostState(host.dataDir, {
      version: 2,
      pid: process.pid,
      hostId: host.host.hostId,
      instanceId: host.host.instanceId,
      socketPath: host.host.socketPath,
      loopbackOrigin: host.host.loopbackOrigin,
      tlsOrigin: null,
      startedAt: new Date().toISOString(),
      dataDir: host.dataDir,
    })
    const bootstrap = join(directory, 'recovery-bootstrap.cjs')
    await writeFile(
      bootstrap,
      `
const { clipboard, dialog } = require('electron')
const proxy = require(${JSON.stringify(resolve('apps/desktop/src/proxy.cjs'))})
const fixture = globalThis.workbenchRecoveryFixture = {
  failures: 0, blockedPrompts: 0, blockPrompt: false, clipboardText: '', prompt: undefined, respond: undefined,
}
const ca = ${JSON.stringify(tlsCa ?? null)}
if (ca) {
  const remotes = require(${JSON.stringify(resolve('apps/desktop/src/remote-proxy.cjs'))})
  remotes.tlsOptions = () => ({ ca: [ca], lookup: (_host, options, done) => done(null, options.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4) })
  clipboard.readText = () => fixture.clipboardText
  clipboard.clear = () => { fixture.clipboardText = '' }
}
const create = proxy.createShellProxy
proxy.createShellProxy = options => {
  const original = create(options)
  return { ...original, handle(request, init) {
    if (fixture.failures > 0 && request.method === 'GET' && request.url === ${JSON.stringify(URL)}) {
      fixture.failures--
      return Response.error()
    }
    if (fixture.blockPrompt && request.method === 'POST' && request.url.endsWith('/prompt')) {
      fixture.blockedPrompts++
      return Response.error()
    }
    return original.handle(request, init)
  } }
}
dialog.showMessageBox = (_window, options) => {
  fixture.prompt = { message: options.message, buttons: options.buttons }
  return new Promise(done => {
    fixture.respond = response => done({ response, checkboxChecked: false })
    options.signal?.addEventListener('abort', () => fixture.respond(options.cancelId), { once: true })
  })
}
require(${JSON.stringify(resolve('apps/desktop/src/main.cjs'))})
`,
      { mode: 0o600 },
    )
    application = await _electron.launch({
      args: [
        bootstrap,
        `--latch-host-state=${join(host.dataDir, 'host.json')}`,
        `--latch-user-data=${join(directory, 'electron')}`,
        '--use-mock-keychain',
        '-AppleLanguages',
        '(zh-CN)',
      ],
      cwd: process.cwd(),
      env: Object.fromEntries(
        Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      timeout: 30_000,
    })
    const page = await application.firstWindow()
    await page
      .locator('button')
      .filter({ hasText: /^(继续|Continue)$/u })
      .click()
    await page.locator('.app-shell[data-connection="connected"]').waitFor()
    await run(application, page, host)
  } finally {
    await application?.close()
    await host.close()
    await rm(directory, { recursive: true, force: true })
  }
}

async function activeWorkbench(application: ElectronApplication) {
  return application.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    const contents = window?.webContents
    if (!window || !contents || contents.isCrashed() || contents.isLoadingMainFrame()) return null
    const state: { connected: boolean; draft?: string; selected?: string; pending?: string } | null = await contents
      .executeJavaScript(`({
        connected: Boolean(document.querySelector('.app-shell[data-connection="connected"]')),
        draft: document.querySelector('[aria-label="新会话消息"], [aria-label="New session message"]')?.textContent,
        selected: document.querySelector('[data-task-id][aria-current="page"]')?.dataset.taskId ?? null,
        pending: Object.entries(localStorage).find(([key]) => key.startsWith('latch.pending.') && !key.endsWith('.reason') && !key.endsWith('.flight'))?.[1],
      })`)
      .catch(() => null)
    return state?.connected ? { ...state, windowId: window.id, url: contents.getURL(), processId: contents.getOSProcessId() } : null
  })
}

async function crashLocal(application: ElectronApplication) {
  await application.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]!.webContents
    return new Promise<void>(done => {
      contents.once('render-process-gone', () => done())
      contents.forcefullyCrashRenderer()
    })
  })
}

describe.skipIf(latchEnv(process.env, 'ELECTRON_E2E') !== '1' || process.platform !== 'darwin')('Electron workbench recovery', () => {
  it('recovers in the same window and on the same Host after the real renderer exits', async () => {
    await withWorkbench(async (application, page, host) => {
      const before = await activeWorkbench(application)
      expect(before?.url).toBe(URL)
      const draft = 'Keep this draft unsent'
      await page.getByRole('textbox', { name: /^(新会话消息|New session message)$/u }).fill(draft)
      await expect
        .poll(() =>
          page.evaluate(
            text => Object.entries(localStorage).some(([key, value]) => key.startsWith('latch.drafts.') && value.includes(text)),
            draft,
          ),
        )
        .toBe(true)
      await crashLocal(application)
      await expect
        .poll(() => activeWorkbench(application), { timeout: 10_000 })
        .toMatchObject({ windowId: before!.windowId, url: URL, draft })
      expect((await activeWorkbench(application))?.processId).not.toBe(before!.processId)
      expect(await host.host.bridge.listTasks()).toEqual([])
    })
  })

  it('offers a native retry when Chromium cannot load the document during automatic recovery', async () => {
    await withWorkbench(async application => {
      const before = await activeWorkbench(application)
      expect(before?.url).toBe(URL)
      await application.evaluate(({ BrowserWindow }) => {
        const fixture = Reflect.get(globalThis, 'workbenchRecoveryFixture') as RecoveryFixture
        fixture.failures = 1
        BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer()
      })
      await expect
        .poll(() => application.evaluate(() => (Reflect.get(globalThis, 'workbenchRecoveryFixture') as RecoveryFixture).prompt))
        .toMatchObject({
          message: expect.stringMatching(/^(工作台未能打开|The workbench could not open)$/u),
          buttons: [
            expect.stringMatching(/^(重新载入|Reload)$/u),
            expect.stringMatching(/^(回到起始页|Open Start Page)$/u),
            expect.stringMatching(/^(稍后|Later)$/u),
          ],
        })
      await application.evaluate(() => (Reflect.get(globalThis, 'workbenchRecoveryFixture') as RecoveryFixture).respond?.(0))
      await expect.poll(() => activeWorkbench(application), { timeout: 10_000 }).toMatchObject({ windowId: before!.windowId, url: URL })
    })
  })

  it('keeps the selected session on automatic reload and can escape it without resending an unconfirmed prompt', async () => {
    await withWorkbench(async (application, page, host) => {
      await page.getByRole('textbox', { name: '新会话消息', exact: true }).fill('A session with history')
      await page.getByRole('button', { name: '发送', exact: true }).click()
      await expect.poll(() => host.host.bridge.listTasks()).toHaveLength(1)
      const id = (await host.host.bridge.listTasks())[0]!.id
      await expect.poll(async () => (await host.host.bridge.detail(id)).summary.status).toBe('idle')
      await application.evaluate(() => {
        const fixture = Reflect.get(globalThis, 'workbenchRecoveryFixture') as RecoveryFixture
        fixture.blockPrompt = true
      })
      await page.getByRole('textbox', { name: '继续对话', exact: true }).filter({ visible: true }).fill('A reply awaiting confirmation')
      await page.getByRole('button', { name: '发送', exact: true }).filter({ visible: true }).click()
      await expect
        .poll(() => application.evaluate(() => (Reflect.get(globalThis, 'workbenchRecoveryFixture') as RecoveryFixture).blockedPrompts))
        .toBe(1)
      const before = await activeWorkbench(application)
      expect(before?.selected).toBe(id)
      expect(before?.pending).toContain('A reply awaiting confirmation')
      await crashLocal(application)
      await expect.poll(() => activeWorkbench(application), { timeout: 10_000 }).toMatchObject({ selected: id, pending: before?.pending })
      await crashLocal(application)
      await expect
        .poll(() => application.evaluate(() => (Reflect.get(globalThis, 'workbenchRecoveryFixture') as RecoveryFixture).prompt?.buttons))
        .toContain('回到起始页')
      await application.evaluate(() => (Reflect.get(globalThis, 'workbenchRecoveryFixture') as RecoveryFixture).respond?.(1))
      await expect
        .poll(() => activeWorkbench(application), { timeout: 10_000 })
        .toMatchObject({
          selected: null,
          url: URL,
          pending: before?.pending,
        })
      expect(
        await application.evaluate(() => (Reflect.get(globalThis, 'workbenchRecoveryFixture') as RecoveryFixture).blockedPrompts),
      ).toBe(1)
      expect((await host.host.bridge.detail(id)).messages.filter(message => message.role === 'user').map(message => message.text)).toEqual([
        'A session with history',
      ])
    })
  })

  it('restores both remote views on their own partition and still withdraws a revoked workbench', async () => {
    const remote = await startTestHost({ tls: true })
    try {
      await withWorkbench(async (application, page, localHost) => {
        const localId = (await activeWorkbench(application))!.windowId
        const remoteId = remote.host.hostId
        await page.getByRole('textbox', { name: '新会话消息', exact: true }).fill('Local work stays selected')
        await page.getByRole('button', { name: '发送', exact: true }).click()
        await expect.poll(() => localHost.host.bridge.listTasks()).toHaveLength(1)
        const localTask = (await localHost.host.bridge.listTasks())[0]!.id
        const localSelection = page.locator(`[data-task-id="${localTask}"][aria-current="page"]`)
        await localSelection.waitFor()
        await openEntry(page, '设置')
        const settings = page.locator('.settings-page')
        await openSection(settings, '电脑')
        const invitation = await remote.invite(['view', 'run', 'approve:standard', 'approve:elevated'])
        await application.evaluate((_, value) => {
          const fixture = Reflect.get(globalThis, 'workbenchRecoveryFixture') as RecoveryFixture
          fixture.clipboardText = value
        }, invitation.url)
        await settings.getByRole('button', { name: '添加电脑', exact: true }).click()
        const row = settings.locator(`[data-computer="${remoteId}"]`)
        await row.getByText('在线', { exact: true }).waitFor()
        const separate = application.waitForEvent('window')
        await row.getByRole('button', { name: '打开', exact: true }).click()
        await (await separate).locator('.app-shell[data-connection="connected"]').waitFor()
        await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.focus(), localId)
        await openSessions(page)
        await page.getByRole('group', { name: '连接状态', exact: true }).locator('.workbench-computer-button').click()
        await page.getByRole('dialog', { name: '电脑' }).locator(`[data-computer-row="${remoteId}"] .computer-pop-other`).click()
        const remoteViews = (previousProcesses: number[] = []) =>
          application.evaluate(
            async ({ BrowserWindow, session }, { localId, remoteId, previousProcesses }) => {
              const partition = session.fromPartition(`persist:latch-host-${remoteId}`)
              const main = BrowserWindow.fromId(localId)!
              const separate = BrowserWindow.getAllWindows().find(window => window.webContents.session === partition)
              const view = main.contentView.children.find(
                (child): child is Electron.WebContentsView =>
                  'webContents' in child && (child as Electron.WebContentsView).webContents.session === partition,
              )
              return Promise.all(
                [view?.webContents, separate?.webContents].map(async (contents, index) => {
                  if (!contents || contents.isCrashed() || contents.isLoadingMainFrame()) return null
                  const processId = contents.getOSProcessId()
                  if (!processId || processId === previousProcesses[index]) return null
                  const connected = await Promise.race<boolean>([
                    contents
                      .executeJavaScript(`Boolean(document.querySelector('.app-shell[data-connection="connected"]'))`)
                      .catch(() => false),
                    new Promise(resolve => setTimeout(resolve, 500, false)),
                  ])
                  return connected ? { id: contents.id, processId, url: contents.getURL() } : null
                }),
              )
            },
            { localId, remoteId, previousProcesses },
          )
        const url = `latch://h-${remoteId}/link/`
        await expect.poll(() => remoteViews()).toMatchObject([{ url }, { url }])
        const before = await remoteViews()
        await application.evaluate(
          ({ webContents }, ids) => {
            const contents = ids.map(id => webContents.fromId(id)!)
            const processes = new Map(contents.map(contents => [contents.getOSProcessId(), contents]))
            for (const contents of processes.values()) contents.forcefullyCrashRenderer()
          },
          before.map(view => view!.id),
        )
        await expect
          .poll(() => remoteViews(before.map(view => view!.processId)), { timeout: 10_000 })
          .toMatchObject(before.map(view => ({ id: view!.id, url })))

        const { devices } = (await (await remote.raw('unix', 'api/devices')).json()) as { devices: Array<{ id: string; status: string }> }
        const device = devices.find(item => item.status === 'active')!
        expect((await remote.raw('unix', `api/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' })).status).toBe(200)
        const revokedStatus = await application.evaluate(
          ({ webContents }, id) =>
            webContents.fromId(id)!.executeJavaScript(`fetch('/link/api/snapshot').then(response => response.status)`),
          before[1]!.id,
        )
        expect(revokedStatus).toBe(401)
        await expect.poll(() => application.evaluate(({ webContents }, id) => Boolean(webContents.fromId(id)), before[0]!.id)).toBe(false)
        await localSelection.waitFor({ state: 'visible' })
      }, remote.tlsCa)
    } finally {
      await remote.close()
    }
  })
})
