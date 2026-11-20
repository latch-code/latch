import { _electron, type ElectronApplication } from '@playwright/test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, type TestContext } from 'vitest'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import type { HarnessPlugin } from '@latch/sdk'
import { latchEnv } from '@latch/host/env'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { promptSelection, promptValue, setPromptSelection } from './helpers/prompt.ts'

async function openDesktop({ onTestFinished }: TestContext, plugin?: HarnessPlugin) {
  const root = await mkdtemp(join(tmpdir(), 'latch-electron-attachment-'))
  let application: ElectronApplication | undefined
  let fixture: TestHost | undefined
  onTestFinished(async () => {
    await application?.close()
    await fixture?.close()
    await rm(root, { recursive: true, force: true })
  })
  fixture = await startTestHost({
    ...(plugin ? { demo: false, plugins: [plugin] } : {}),
    presenceMode: 'manual',
    uiDir: resolve(process.env.LATCH_E2E_UI_DIR ?? 'dist/web'),
  })
  const host = fixture.host
  await writeHostState(fixture.dataDir, {
    version: 2,
    pid: process.pid,
    hostId: host.hostId,
    instanceId: host.instanceId,
    socketPath: host.socketPath,
    loopbackOrigin: host.loopbackOrigin,
    tlsOrigin: host.tlsOrigin ?? null,
    startedAt: new Date().toISOString(),
    dataDir: fixture.dataDir,
  })
  application = await _electron.launch({
    args: [
      resolve('apps/desktop/src/main.cjs'),
      `--latch-host-state=${join(fixture.dataDir, 'host.json')}`,
      `--latch-user-data=${join(root, 'electron')}`,
      '--use-mock-keychain',
    ],
    cwd: process.cwd(),
    env: Object.fromEntries(
      Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    timeout: 30000,
  })
  const page = await application.firstWindow()
  page.setDefaultTimeout(20000)
  // The first connection on a Host with no enrolled device takes no confirmation.
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await page.locator('.app-shell[data-connection="connected"]').waitFor()
  expect(fixture.presence.requests).toHaveLength(0)
  const composer = page.getByRole('region', { name: '新会话', exact: true }).locator('form')
  return { page, application, composer }
}

describe.skipIf(latchEnv(process.env, 'ELECTRON_E2E') !== '1' || process.platform !== 'darwin')('desktop composer attachments', () => {
  it('pastes long plain text from the Edit menu as one undoable change', async context => {
    const { application, composer } = await openDesktop(context)
    const input = composer.getByRole('textbox', { name: '新会话消息', exact: true })
    await input.fill('before item after')
    await expect.poll(() => promptValue(input)).toBe('before item after')
    await setPromptSelection(input, 7, 11)
    expect(await promptSelection(input)).toEqual({ from: 7, to: 11, head: 11 })
    const log = '测试日志\n'.repeat(500)
    const accelerator = await application.evaluate(({ BrowserWindow, Menu }, text) => {
      const target = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === 'latch://app/link/')!
      target.focus()
      const contents = target.webContents
      // Invoke the actual menu action, with the native paste replaced by a paste event from an isolated clipboard.
      contents.pasteAndMatchStyle = () => {
        void contents.executeJavaScript(`{
          const data = new DataTransfer();
          data.setData('text/plain', ${JSON.stringify(text)});
          document.activeElement?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        }`)
      }
      const item = Menu.getApplicationMenu()!.getMenuItemById('paste-plain-text')!
      item.click()
      return item.accelerator
    }, log)
    expect(accelerator).toBe('Command+Shift+V')
    await expect.poll(async () => (await promptValue(input)).length).toBe(log.length + 'before  after'.length)
    expect(await promptValue(input)).toBe(`before ${log} after`)
    expect(await promptSelection(input)).toEqual({ from: 7 + log.length, to: 7 + log.length, head: 7 + log.length })
    expect(await composer.locator('.attachment-draft').count()).toBe(0)
    await input.press('Meta+z')
    expect(await promptValue(input)).toBe('before item after')
  })

  it('streams a private image above the JSON limit and opens it in the picture viewer', async context => {
    let sentBytes = 0
    const plugin: HarnessPlugin = {
      id: 'electron-attachment',
      name: 'test',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerProvider({
          id: 'visual',
          name: 'Fixture',
          model: 'fixture',
          modelCapabilities: { fixture: { vision: true } },
          async *stream({ messages }) {
            const image = messages.flatMap(message => message.attachments ?? []).find(item => item.type === 'image')
            if (image?.type === 'image') sentBytes = Buffer.from(image.data, 'base64').length
            yield { type: 'text', text: '桌面附件已收到' }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    const { page, composer } = await openDesktop(context, plugin)
    const image = Buffer.concat([await page.screenshot({ animations: 'disabled' }), Buffer.alloc(2 * 1024 * 1024)])
    await composer.getByLabel('选择附件').setInputFiles({ name: 'large.png', mimeType: 'image/png', buffer: image })
    await expect.poll(() => composer.getByRole('button', { name: 'large.png', exact: true }).isEnabled(), { timeout: 15000 }).toBe(true)
    await expect
      .poll(() => composer.locator('.attachment-draft img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
      .toBe(true)
    await composer.getByRole('button', { name: '发送', exact: true }).click()
    await page.getByText('桌面附件已收到', { exact: true }).waitFor()
    expect(sentBytes).toBe(image.length)
    const sent = page.locator('.message-user').getByRole('button', { name: /^large\.png/u })
    await expect.poll(() => sent.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)
    await sent.click()
    const picture = page.getByRole('dialog', { name: 'large.png', exact: true })
    await expect
      .poll(() =>
        picture
          .getByRole('img', { name: 'large.png', exact: true })
          .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
      )
      .toBe(true)
    expect(await picture.evaluate(element => element.matches('.picture-viewer:modal'))).toBe(true)
    await picture.getByRole('button', { name: '在文件中打开', exact: true }).click()
    const preview = page.getByRole('region', { name: '文件预览', exact: true })
    await expect.poll(() => preview.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)
    expect(page.url()).toBe('latch://app/link/')
    await mkdir('test-results/attachments', { recursive: true })
    await page.screenshot({ path: 'test-results/attachments/electron-private-image.png', animations: 'disabled' })
  })
})
