import { randomUUID } from 'node:crypto'
import { chromium, type Browser, type Route } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HarnessPlugin } from '@latch/sdk'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { closeActiveFile } from './helpers/layout.ts'
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=', 'base64')
describe('private attachments through the composer', () => {
  let host: TestHost,
    browser: Browser,
    calls = 0
  beforeAll(async () => {
    const plugin: HarnessPlugin = {
      id: 'attachment-ui',
      name: '附件测试',
      version: '1.0.0',
      description: '测试',
      activate(context) {
        context.registerProvider({
          id: 'vision',
          name: 'Fixture vision',
          model: 'fixture',
          modelCapabilities: { fixture: { vision: true } },
          async *stream(input) {
            calls++
            const attachments = input.messages.flatMap(message => message.attachments ?? [])
            yield { type: 'text', text: `已收到 ${attachments.length} 个附件。` }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    host = await startTestHost({ demo: false, plugins: [plugin] })
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir('test-results/attachments', { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
  })
  for (const [width, theme] of [
    [390, 'light'],
    [900, 'dark'],
    [1440, 'light'],
  ] as const)
    it(`uploads, previews and sends an image-only message at ${width}/${theme}`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, locale: 'zh-CN' })
      const page = await context.newPage()
      page.setDefaultTimeout(15_000)
      try {
        await enrollBrowser(page, host, { name: `附件 ${width}`, scopes: ['admin'] })
        if (width === 900 && !(await page.getByRole('button', { name: '新建会话', exact: true }).isVisible()))
          await page.getByRole('button', { name: '打开会话列表', exact: true }).click()
        await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
        await expect.poll(() => page.getByRole('button', { name: '添加文件…', exact: true }).isEnabled()).toBe(true)
        await page.getByLabel('选择附件', { exact: true }).setInputFiles({ name: 'sample.png', mimeType: 'image/png', buffer: image })
        const drafts = page.getByLabel('消息附件', { exact: true })
        await drafts.getByRole('button', { name: 'sample.png', exact: true }).waitFor({ state: 'visible' })
        await expect.poll(() => drafts.getByRole('button', { name: 'sample.png', exact: true }).isEnabled(), { timeout: 10000 }).toBe(true)
        await page.screenshot({ path: `test-results/attachments/${width}-${theme}-ready.png`, animations: 'disabled' })
        await drafts.getByRole('button', { name: 'sample.png', exact: true }).click()
        const dialog = page.getByRole('dialog', { name: 'sample.png', exact: true })
        await expect.poll(() => dialog.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)
        await dialog.getByRole('button', { name: '关闭', exact: true }).click()
        await page.getByRole('button', { name: width === 390 ? '开始' : '发送', exact: true }).click()
        await page.getByText('已收到 1 个附件。', { exact: true }).waitFor()
        const message = page.locator('.message-user')
        await message.getByRole('button', { name: 'sample.png 1 KB', exact: true }).click()
        const preview = page.getByRole('region', { name: '文件预览', exact: true })
        await expect.poll(() => preview.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)
        await page.screenshot({ path: `test-results/attachments/${width}-${theme}-sent.png`, animations: 'disabled' })
        const tasks = await host.host.bridge.listTasks()
        const detail = await host.host.bridge.detail(tasks[0]!.id)
        expect(
          detail.messages.some(
            message => message.role === 'user' && message.text === '' && message.attachments?.[0]?.name === 'sample.png',
          ),
        ).toBe(true)
        expect(JSON.stringify(detail)).not.toContain(image.toString('base64'))
        expect(await readFile(join(host.dataDir, 'sessions', 'runtime.json'), 'utf8')).not.toContain(image.toString('base64'))
      } finally {
        await context.close()
      }
    })
  it('keeps a failed upload and uncertain send retryable, and folds editable long paste', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' }),
      page = await context.newPage()
    page.setDefaultTimeout(15_000)
    try {
      await enrollBrowser(page, host, { name: '附件重试', scopes: ['admin'] })
      await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
      await page.route(
        '**/link/api/attachments',
        async route => {
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ code: 'attachment-unavailable', message: '测试上传失败' }),
          })
        },
        { times: 1 },
      )
      await page
        .getByLabel('选择附件')
        .setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('attachment retry') })
      await page.getByRole('button', { name: '重试上传', exact: true }).click()
      await expect.poll(() => page.getByRole('button', { name: 'notes.txt', exact: true }).isEnabled()).toBe(true)
      const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
      await input.fill('draft remains')
      await page.route(
        '**/link/api/tasks',
        async route => {
          if (route.request().method() !== 'POST') {
            await route.continue()
            return
          }
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ code: 'submission-unknown', message: '测试发送结果未知' }),
          })
        },
        { times: 1 },
      )
      const before = calls
      await page.getByRole('button', { name: '发送', exact: true }).click()
      await page.getByRole('button', { name: '重试这次提交', exact: true }).click()
      await page.getByText('已收到 1 个附件。', { exact: true }).waitFor()
      expect(calls).toBe(before + 1)
      const next = page.getByRole('textbox', { name: '继续对话', exact: true })
      await expect.poll(() => next.isEnabled(), { timeout: 10000 }).toBe(true)
      await next.evaluate(element => {
        const data = new DataTransfer()
        data.setData('text/plain', 'long pasted text '.repeat(160))
        element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
      })
      const folded = page.getByRole('button', { name: /^已粘贴/ })
      await expect
        .poll(() => folded.isEnabled(), { timeout: 10000 })
        .toBe(true)
        .catch(async () => {
          throw new Error(await page.locator('.attachment-drafts').innerText())
        })
      await folded.click()
      const editor = page.getByRole('textbox', { name: '粘贴的文字', exact: true })
      await editor.fill('restored text')
      await page.getByRole('button', { name: '放回输入框', exact: true }).click()
      expect(await next.inputValue()).toBe('restored text')
      expect(await page.locator('.attachment-draft').count()).toBe(0)
    } finally {
      await context.close()
    }
  })
  it('cancels waiting for an upload without sending or losing the draft', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark', locale: 'zh-CN' }),
      page = await context.newPage()
    page.setDefaultTimeout(15000)
    let resume: (() => void) | undefined
    try {
      await enrollBrowser(page, host, { name: '附件取消', scopes: ['admin'] })
      await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
      const held = new Promise<void>(resolve => {
        resume = resolve
      })
      let completeRoute: (() => void) | undefined
      const routeFinished = new Promise<void>(resolve => {
        completeRoute = resolve
      })
      const holdUpload = async (route: Route) => {
        await held
        await route.abort().catch(() => {})
        completeRoute!()
      }
      await page.route('**/link/api/attachments', holdUpload)
      await page.getByLabel('选择附件').setInputFiles({ name: 'waiting.txt', mimeType: 'text/plain', buffer: Buffer.from('wait') })
      const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
      await input.fill('keep my draft')
      const before = calls
      await page.getByRole('button', { name: '发送', exact: true }).click()
      await page.getByRole('button', { name: '取消发送', exact: true }).waitFor()
      await page.screenshot({ path: 'test-results/attachments/1440-dark-waiting.png', animations: 'disabled' })
      await page.getByRole('button', { name: '取消发送', exact: true }).click()
      resume!()
      await routeFinished
      await page.unroute('**/link/api/attachments', holdUpload)
      await page.getByRole('button', { name: '重试上传', exact: true }).waitFor()
      expect(await input.inputValue()).toBe('keep my draft')
      expect(calls).toBe(before)
      await page.screenshot({ path: 'test-results/attachments/1440-dark-cancelled.png', animations: 'disabled' })
      await page.getByRole('button', { name: '重试上传', exact: true }).click()
      await expect.poll(() => page.getByRole('button', { name: 'waiting.txt', exact: true }).isEnabled(), { timeout: 10000 }).toBe(true)
    } finally {
      resume?.()
      await context.close()
    }
  })
  it('chooses a real session file at @, leaves email alone and binds explicit refs to the visible draft', async () => {
    await writeFile(join(host.workspaceRoot, 'reference.txt'), 'file context')
    const { sessionId } = await host.host.bridge.createTask({
      prompt: 'file reference fixture',
      requestId: randomUUID(),
      mode: 'agent',
      model: { providerId: 'vision', model: 'fixture' },
    })
    await expect.poll(async () => (await host.host.bridge.detail(sessionId)).summary.status, { timeout: 10000 }).toBe('idle')
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' }),
      page = await context.newPage()
    page.setDefaultTimeout(15000)
    try {
      await enrollBrowser(page, host, { name: '文件引用', scopes: ['admin'] })
      const deviceId = await page.evaluate(async () => (await (await fetch('/link/api/snapshot')).json()).device.id as string)
      const desktop = await host.enroll({ listener: 'unix' })
      expect((await desktop.confirmed(`devices/${deviceId}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
      await page.reload()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()

      await page.locator(`[data-task-id="${sessionId}"]`).first().click()
      const input = page.getByRole('textbox', { name: '继续对话', exact: true })
      await input.fill('user@example.com')
      expect(await page.getByLabel('引用项目文件').count()).toBe(0)
      await input.fill('@refer')
      const chooser = page.getByLabel('引用项目文件', { exact: true })
      await chooser.getByRole('button', { name: 'reference.txt default', exact: true }).click()
      expect(await input.inputValue()).toBe('@default:reference.txt ')
      await page.screenshot({ path: 'test-results/attachments/1440-light-file-reference.png', animations: 'disabled' })
      await page.getByRole('button', { name: '发送', exact: true }).click()
      await expect
        .poll(async () => (await host.host.bridge.detail(sessionId)).messages.filter(message => message.role === 'user').length)
        .toBe(2)
      const detail = await host.host.bridge.detail(sessionId)
      expect(detail.messages.filter(message => message.role === 'user').at(-1)).toMatchObject({
        text: '@default:reference.txt',
        fileRefs: [{ root: 'default', path: 'reference.txt' }],
      })
      await page.locator('.message-user').getByRole('button', { name: '预览文件：reference.txt', exact: true }).click()
      await page.getByRole('region', { name: '文件预览', exact: true }).getByText('file context', { exact: true }).waitFor()
      await closeActiveFile(page)
      await expect.poll(() => input.isEnabled(), { timeout: 10000 }).toBe(true)
      await input.fill('@default:reference.txt.backup')
      await input.fill('@default:reference.txt ')
      await page.getByRole('button', { name: '发送', exact: true }).click()
      await expect
        .poll(async () => (await host.host.bridge.detail(sessionId)).messages.filter(message => message.role === 'user').length)
        .toBe(3)
      expect(
        (await host.host.bridge.detail(sessionId)).messages.filter(message => message.role === 'user').at(-1)?.fileRefs,
      ).toBeUndefined()
    } finally {
      await context.close()
    }
  })
  it('shows the conversation drop surface, accepts a dropped image once and refuses folders', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' }),
      page = await context.newPage()
    page.setDefaultTimeout(15000)
    try {
      await enrollBrowser(page, host, { name: '文件拖入', scopes: ['admin'] })
      await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
      const surface = page.locator('main.workspace')
      const data = await page.evaluateHandle(base64 => {
        const transfer = new DataTransfer()
        transfer.items.add(new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], 'dropped.png', { type: 'image/png' }))
        return transfer
      }, image.toString('base64'))
      await surface.dispatchEvent('dragenter', { dataTransfer: data })
      await page.getByText('松开以添加到这条消息', { exact: true }).waitFor()
      await page.screenshot({ path: 'test-results/attachments/1440-light-drop-mask.png', animations: 'disabled' })
      await surface.dispatchEvent('drop', { dataTransfer: data })
      await expect.poll(() => page.getByRole('button', { name: 'dropped.png', exact: true }).isEnabled(), { timeout: 10000 }).toBe(true)
      expect(await page.locator('.attachment-draft').count()).toBe(1)
      expect(await page.getByText('松开以添加到这条消息', { exact: true }).count()).toBe(0)
      const folder = await page.evaluateHandle(() => {
        const transfer = new DataTransfer()
        transfer.items.add(new File(['folder'], 'folder'))
        Object.defineProperty(DataTransferItem.prototype, 'webkitGetAsEntry', { value: () => ({ isDirectory: true }) })
        return transfer
      })
      await surface.dispatchEvent('drop', { dataTransfer: folder })
      await page.getByText('文件夹请在 设置 › 项目 中添加。', { exact: true }).waitFor()
      expect(await page.locator('.attachment-draft').count()).toBe(1)
      await page.getByRole('button', { name: '发送', exact: true }).click()
      await page.getByText('已收到 1 个附件。', { exact: true }).waitFor()
    } finally {
      await context.close()
    }
  })
})
