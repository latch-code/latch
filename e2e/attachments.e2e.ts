import { randomUUID } from 'node:crypto'
import { chromium, type Browser, type Page, type Route } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { closeActiveFile, closeSettings, openSection, openSession, openSettings } from './helpers/layout.ts'
/** The new draft is the home's input on every width: already in sight, or where 新建会话 leads. */
async function newDraft(page: Page) {
  const home = page.locator('.workbench-home')
  if (!(await home.isVisible())) await page.getByRole('button', { name: '新建会话', exact: true }).filter({ visible: true }).first().click()
  await home.getByRole('textbox', { name: '新会话消息', exact: true }).waitFor()
}
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
  it('shows mixed attachments as tiles of one size at narrow and wide sizes', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    try {
      await enrollBrowser(page, host, { name: '附件缩略图', scopes: ['admin'] })
      await newDraft(page)
      const screenshot = process.env.LATCH_ATTACHMENT_SAMPLE
        ? await readFile(process.env.LATCH_ATTACHMENT_SAMPLE)
        : await page.screenshot({ animations: 'disabled' })
      await page.getByLabel('选择附件', { exact: true }).setInputFiles([
        { name: 'workbench.png', mimeType: 'image/png', buffer: screenshot },
        { name: 'review-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('先检查图片和文字附件，再继续产品评审。') },
      ])
      const drafts = page.getByLabel('消息附件', { exact: true })
      await expect.poll(() => drafts.locator('[data-state="ready"]').count()).toBe(2)
      await expect.poll(() => drafts.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)
      for (const width of [1440, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 })
        await page.screenshot({ path: `test-results/attachments/mixed-${width}-arrival.png`, animations: 'disabled' })
        for (const theme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme: theme })
          const visible = page.locator('.attachment-drafts').filter({ visible: true })
          await expect.poll(() => visible.count()).toBe(1)
          // Every attachment is the same compact tile: a picture shows itself, a text file its type.
          const [chip, thumbnail] = await Promise.all([
            visible.locator('.attachment-draft[data-kind="file"]').boundingBox(),
            visible.locator('.attachment-draft:has(img)').boundingBox(),
          ])
          expect(chip!.width).toBe(64)
          expect(thumbnail!.width).toBe(64)
          expect(thumbnail!.height).toBe(chip!.height)
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          await page.screenshot({ path: `test-results/attachments/mixed-${width}-${theme}.png`, animations: 'disabled' })
          await page
            .locator('.composer')
            .filter({ visible: true })
            .first()
            .screenshot({ path: `test-results/attachments/mixed-composer-${width}-${theme}.png`, animations: 'disabled' })
        }
      }
      await page.setViewportSize({ width: 1440, height: 1000 })
      await drafts.getByRole('button', { name: 'review-notes.txt', exact: true }).click()
      const preview = page.getByRole('dialog', { name: 'review-notes.txt', exact: true })
      await preview.getByText('先检查图片和文字附件，再继续产品评审。', { exact: true }).waitFor()
      await preview.getByRole('button', { name: '关闭', exact: true }).click()
      await drafts.getByRole('button', { name: '移除附件 workbench.png', exact: true }).click()
      expect(await drafts.locator('img').count()).toBe(0)
      expect(await drafts.getByRole('button', { name: 'review-notes.txt', exact: true }).count()).toBe(1)
      expect(await page.getByRole('textbox').filter({ visible: true }).first().inputValue()).toBe('')
    } finally {
      await context.close()
    }
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
        await newDraft(page)
        await expect.poll(() => page.getByRole('button', { name: '添加文件', exact: true }).isEnabled()).toBe(true)
        const composer = width === 390 ? page.locator('.workbench-home') : page
        await composer.getByLabel('选择附件', { exact: true }).setInputFiles({ name: 'sample.png', mimeType: 'image/png', buffer: image })
        const drafts = composer.getByLabel('消息附件', { exact: true })
        await drafts.getByRole('button', { name: 'sample.png', exact: true }).waitFor({ state: 'visible' })
        await expect.poll(() => drafts.getByRole('button', { name: 'sample.png', exact: true }).isEnabled(), { timeout: 10000 }).toBe(true)
        await expect.poll(() => drafts.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)
        await page.screenshot({ path: `test-results/attachments/${width}-${theme}-ready.png`, animations: 'disabled' })
        await drafts.getByRole('button', { name: 'sample.png', exact: true }).click()
        const dialog = page.getByRole('dialog', { name: 'sample.png', exact: true })
        await expect.poll(() => dialog.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)
        await dialog.getByRole('button', { name: '关闭', exact: true }).click()
        await composer.getByRole('button', { name: '发送', exact: true }).click()
        await page.getByText('已收到 1 个附件。', { exact: true }).waitFor()
        const message = page.locator('.message-user')
        await expect
          .poll(() => message.locator('.message-attachments img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
          .toBe(true)
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
      await newDraft(page)
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
      await page.getByRole('button', { name: '重试上传', exact: true }).waitFor()
      expect(
        await page.locator('.attachment-draft[data-state="failed"] .attachment-state').evaluate(element => {
          let opacity = 1
          for (let node: Element | null = element; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity)
          return opacity
        }),
      ).toBe(1)
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
      await newDraft(page)
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

      const settings = await openSettings(page)
      await openSection(settings, '通用')
      await settings
        .getByRole('radiogroup', { name: '发送消息', exact: true })
        .getByRole('radio', { name: /^(?:⌘⏎|Ctrl ⏎) 发送$/u })
        .click()
      await closeSettings(settings)
      await openSession(page, sessionId)
      const input = page.getByRole('textbox', { name: '继续对话', exact: true })
      const chooser = page.getByRole('listbox', { name: '引用项目文件', exact: true })
      const row = chooser.getByRole('option', { name: /reference\.txt/u })
      const openBareMention = async () => {
        const search = page.waitForResponse(
          response =>
            response.request().method() === 'POST' && new URL(response.url()).pathname === `/link/api/tasks/${sessionId}/files/search`,
        )
        await input.fill('@')
        const response = await search
        expect(response.ok()).toBe(true)
        expect(response.request().postDataJSON()).toMatchObject({ q: '' })
        await row.waitFor()
        expect(await input.getAttribute('aria-controls')).toBe(await chooser.getAttribute('id'))
        expect(await input.getAttribute('aria-activedescendant')).toBeNull()
      }
      const selectWithArrow = async () => {
        await input.press('ArrowDown')
        expect(await input.getAttribute('aria-activedescendant')).toBeTruthy()
      }
      await input.fill('user@example.com')
      expect(await chooser.count()).toBe(0)
      for (const escape of [false, true]) {
        await openBareMention()
        await selectWithArrow()
        if (escape) {
          await input.press('Escape')
          await chooser.waitFor({ state: 'hidden' })
          expect(await input.getAttribute('aria-controls')).toBeNull()
        }
        await input.fill('')
        await chooser.waitFor({ state: 'hidden' })
        expect(await input.getAttribute('aria-controls')).toBeNull()
        await openBareMention()
        await input.press('Enter')
        expect(await input.inputValue()).toBe('@\n')
        await chooser.waitFor({ state: 'hidden' })
        await openBareMention()
        await selectWithArrow()
        await input.fill('')
        await chooser.waitFor({ state: 'hidden' })
      }
      await input.fill('@refer')
      // With a query, the first result is selected once the search returns.
      await row.waitFor()
      expect(await row.getAttribute('aria-selected')).toBe('true')
      await input.press('Tab')
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
      await newDraft(page)
      // The new draft is the home's input, so the home is what a file is dragged onto.
      const surface = page.locator('.workbench-home')
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
  it('shrinks a photo over the image limit before uploading it, and refuses a large animation with its reason', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' }),
      page = await context.newPage()
    page.setDefaultTimeout(30_000)
    // Two frames padded past the limit: re-encoding would keep one, so it is refused before any decoding.
    const block = [255, ...Array.from({ length: 255 }, (_, index) => index)]
    const frame = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, ...Array.from({ length: 12_000 }, () => block).flat(), 0]
    const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, ...frame, ...frame, 0x3b])
    try {
      await enrollBrowser(page, host, { name: '图片缩小', scopes: ['admin'] })
      await newDraft(page)
      const photo = await page.evaluate(async () => {
        const canvas = new OffscreenCanvas(2400, 1800)
        const context = canvas.getContext('2d')!
        const pixels = context.createImageData(2400, 1800)
        for (let index = 0; index < pixels.data.length; index++) pixels.data[index] = index % 4 === 3 ? 255 : (Math.random() * 256) | 0
        context.putImageData(pixels, 0, 0)
        const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
        let text = ''
        for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
        return btoa(text)
      })
      const original = Buffer.from(photo, 'base64')
      expect(original.length).toBeGreaterThan(5 * 1024 * 1024)
      await page.getByLabel('选择附件', { exact: true }).setInputFiles([
        { name: 'noise.png', mimeType: 'image/png', buffer: original },
        { name: 'moving.gif', mimeType: 'image/gif', buffer: gif },
      ])
      const shrunk = page.locator('.attachment-draft').filter({ has: page.getByRole('button', { name: 'noise.jpg', exact: true }) })
      await shrunk.getByText(/^已缩小 · /u).waitFor()
      expect(await shrunk.locator('.attachment-state').getAttribute('title')).toMatch(/^原图 /u)
      await page.getByText('动图超过 5 MB，缩小会丢掉动画', { exact: true }).waitFor()
      await page.screenshot({ path: 'test-results/attachments/1440-light-shrunk.png', animations: 'disabled' })
      await page
        .locator('.attachment-draft[data-state="refused"]')
        .getByRole('button', { name: '移除附件 moving.gif', exact: true })
        .click()
      await page.getByRole('button', { name: '发送', exact: true }).click()
      await page.getByText('已收到 1 个附件。', { exact: true }).waitFor()
    } finally {
      await context.close()
    }
  })
})

describe('the attach button and @ on every Harness', () => {
  let host: TestHost, browser: Browser, owner: TestDevice
  const shots = 'test-results/attachments-base'
  beforeAll(async () => {
    host = await startTestHost({ demo: false })
    owner = await host.enroll({ listener: 'unix' })
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(shots, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
  })
  const define = (id: string, name: string, caps: string) =>
    owner.confirmedJson('agents', { body: { id, name, command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_CAPS: caps } } })
  const start = async (harnessId: string, title: string) => {
    const created = await owner.confirmed('tasks', { body: { prompt: 'echo ' + title, requestId: randomUUID(), harnessId } })
    const { sessionId } = (await created.json()) as { sessionId: string }
    await expect.poll(async () => (await owner.json<TaskDetail>('tasks/' + sessionId)).summary.status, { timeout: 15_000 }).toBe('idle')
    await owner.json('tasks/' + sessionId, { method: 'PATCH', body: { title } })
    return sessionId
  }
  for (const [width, theme] of [
    [390, 'light'],
    [390, 'dark'],
    [1440, 'light'],
    [1440, 'dark'],
  ] as const)
    it(`takes every file before and after the first session, by path where it is not native, at ${width}/${theme}`, async () => {
      const phone = width < 600
      const late = `late-${width}-${theme}`,
        plain = `plain-${width}-${theme}`
      await define(late, `Late ${width} ${theme}`, 'images,embedded')
      await define(plain, `Plain ${width} ${theme}`, 'delete')
      const context = await browser.newContext({
        viewport: { width, height: phone ? 844 : 900 },
        colorScheme: theme,
        locale: 'zh-CN',
        reducedMotion: 'reduce',
        ...(phone ? { isMobile: true, hasTouch: true } : {}),
      })
      const page = await context.newPage()
      page.setDefaultTimeout(15_000)
      try {
        await enrollBrowser(page, host, { name: `附件按钮 ${width} ${theme}`, scopes: ['admin'], dataScope: 'work' })
        // Choosing it would read its lists, which starts it and answers too; held back here to see it unstarted.
        await page.route('**/link/api/agents/*/catalogue', route => route.fulfill({ json: { ran: false, harness: late } }))
        await newDraft(page)
        await page
          .getByRole('button', { name: /^Harness：/u })
          .first()
          .click()
        const lateName = new RegExp(`^Late ${width} ${theme}`, 'u')
        if (phone) {
          const sheet = page.getByRole('dialog', { name: 'Harness', exact: true })
          await sheet.getByText(`Late ${width} ${theme}`, { exact: true }).click()
          // Any choice closes the picker, the Harness already chosen too.
          await sheet.waitFor({ state: 'hidden' })
          await page
            .locator('.workbench-home .composer-chips [data-composer-control="harness"]')
            .getByText(`Late ${width} ${theme}`, { exact: true })
            .first()
            .waitFor()
        } else await page.getByRole('menuitemradio', { name: lateName }).first().click()
        const add = page.getByRole('button', { name: '添加文件', exact: true })
        const composer = phone ? page.locator('.workbench-home') : page
        const drafts = composer.getByLabel('消息附件', { exact: true })
        // Not started yet: it takes files all the same, and nothing is said about it.
        await expect.poll(() => add.getAttribute('data-unavailable'), { timeout: 15_000 }).toBeNull()
        await composer.getByLabel('选择附件', { exact: true }).setInputFiles({
          name: 'tool.bin',
          mimeType: 'application/octet-stream',
          buffer: Buffer.from([0, 1, 2, 3, 0, 255]),
        })
        await drafts.locator('.attachment-draft[data-state="ready"]').waitFor()
        expect(await page.locator('.attachment-draft:is([data-state="refused"], [data-state="failed"])').count()).toBe(0)
        await page.screenshot({ path: `${shots}/${width}-${theme}-not-started.png`, animations: 'disabled' })
        await drafts.getByRole('button', { name: '移除附件 tool.bin', exact: true }).click()
        // Started from another device: what it takes is learned without a reload, and a binary file still goes, by path.
        await start(late, `已启动 ${width} ${theme}`)
        await composer.getByLabel('选择附件', { exact: true }).setInputFiles({
          name: 'tool.bin',
          mimeType: 'application/octet-stream',
          buffer: Buffer.from([0, 1, 2, 3, 0, 255]),
        })
        await drafts.locator('.attachment-draft[data-state="ready"][data-delivery="path"]').waitFor()
        await page.screenshot({ path: `${shots}/${width}-${theme}-by-path.png`, animations: 'disabled' })
        await drafts.getByRole('button', { name: '移除附件 tool.bin', exact: true }).click()
        // A Harness that takes nothing natively takes a picture too: by its path, said only on hover.
        const plainSession = await start(plain, `不收附件 ${width} ${theme}`)
        if (phone) await openSession(page, plainSession)
        else {
          await page.keyboard.press('Meta+k')
          const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
          await palette.getByRole('searchbox').fill(`不收附件 ${width} ${theme}`)
          await palette.getByRole('option', { name: `不收附件 ${width} ${theme}`, exact: true }).click()
        }
        const sessionComposer = page.locator('.composer').filter({ visible: true }).last()
        await sessionComposer
          .getByLabel('选择附件', { exact: true })
          .setInputFiles({ name: 'sample.png', mimeType: 'image/png', buffer: image })
        const sessionDrafts = sessionComposer.getByLabel('消息附件', { exact: true })
        await sessionDrafts.locator('.attachment-draft[data-state="ready"][data-delivery="path"]').waitFor()
        expect(await sessionDrafts.locator('.attachment-tile').getAttribute('title')).toContain('以文件交给 Agent')
        await page.screenshot({ path: `${shots}/${width}-${theme}-takes-none.png`, animations: 'disabled' })
        await sessionDrafts.getByRole('button', { name: '移除附件 sample.png', exact: true }).click()
        if (phone) {
          // The permission sheet closes when the mode already chosen is pressed, as any picker does.
          await page
            .getByRole('button', { name: /^权限：/u })
            .first()
            .click()
          const permission = page.getByRole('dialog', { name: '权限', exact: true })
          await permission.getByRole('radio', { checked: true }).first().click()
          await permission.waitFor({ state: 'hidden' })
        }
        // A browser on the work scope: @ says so instead of staying silent.
        const input = page.getByRole('textbox', { name: '继续对话', exact: true })
        expect(await input.getAttribute('placeholder')).toBe('想让 Agent 做什么？')
        await input.fill('看看 @app')
        await page
          .getByRole('listbox', { name: '引用项目文件', exact: true })
          .getByText('这台设备看不到项目文件', { exact: true })
          .waitFor()
        await page.screenshot({ path: `${shots}/${width}-${theme}-at-hidden.png`, animations: 'disabled' })
        await input.fill('')
        if (!phone) {
          // The Host says an upload was released: not delivered, for certain. The text comes back, the row says so.
          await page.keyboard.press('Meta+k')
          const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
          await palette.getByRole('searchbox').fill(`已启动 ${width} ${theme}`)
          await palette.getByRole('option', { name: `已启动 ${width} ${theme}`, exact: true }).click()
          await page
            .getByLabel('选择附件', { exact: true })
            .setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') })
          await drafts.locator('.attachment-draft[data-state="ready"]').waitFor()
          await page.route('**/link/api/tasks/*/prompt', route =>
            route.fulfill({
              status: 409,
              json: { error: 'attachment-released', message: '附件「notes.txt」已在 设置 › 设备 里释放，请重新添加。' },
            }),
          )
          await input.fill('带着附件的消息')
          await page.getByRole('button', { name: '发送', exact: true }).last().click()
          await drafts.locator('.attachment-draft[data-state="refused"]').getByText('已在 设置 › 设备 里释放，请移除后重新添加').waitFor()
          expect(await input.inputValue()).toBe('带着附件的消息')
          expect(await drafts.getByRole('button', { name: '重试上传', exact: true }).count()).toBe(0)
          await page.screenshot({ path: `${shots}/${width}-${theme}-released.png`, animations: 'disabled' })
          await page.unroute('**/link/api/tasks/*/prompt')
          await drafts.getByRole('button', { name: '移除附件 notes.txt', exact: true }).click()
          await input.fill('')
        }
        // The device page shows the data scope; only the Mac changes it. Reserved uploads go only after a confirmation.
        let released = 0
        let releasedIds: string[] = []
        const item = (letter: string, releasable: boolean) => ({
          id: letter.repeat(22),
          bytes: 2048,
          requestId: `${letter.repeat(8)}-0000-4000-8000-000000000000`,
          releasable,
        })
        await page.route('**/link/api/attachments/reserved', route =>
          route.fulfill({
            json: {
              reserved: released
                ? { count: 1, bytes: 2048, releasable: 0, releasableBytes: 0, items: [item('c', false)] }
                : {
                    count: 3,
                    bytes: 3 * 2048,
                    releasable: 2,
                    releasableBytes: 4096,
                    items: [item('a', true), item('b', true), item('c', false)],
                  },
            },
          }),
        )
        await page.route('**/link/api/attachments/reserved/release', route => {
          released++
          releasedIds = (route.request().postDataJSON() as { ids: string[] }).ids
          return route.fulfill({ json: { released: { count: 2, bytes: 4096 } } })
        })
        const settings = await openSettings(page, '设备')
        const self = host.host.security.devices.list().find(device => device.name === `附件按钮 ${width} ${theme}`)!.id
        await settings.locator(`[data-device-id="${self}"] .settings-row-main`).first().click()
        await settings.locator('.settings-row').filter({ hasText: '可以看项目文件' }).getByText('未开启', { exact: true }).waitFor()
        const reserved = settings.locator('.settings-row').filter({ hasText: '保留的附件' })
        await reserved.getByText('3 个 · 6 KB', { exact: true }).waitFor()
        await page.screenshot({ path: `${shots}/${width}-${theme}-device.png`, animations: 'disabled' })
        await reserved.getByRole('button', { name: '释放…', exact: true }).click()
        const confirm = page.getByRole('dialog', { name: '释放保留的附件', exact: true })
        await confirm.getByText('删除 2 个没有消息用到的附件（4 KB）？此操作无法撤销。', { exact: true }).waitFor()
        expect(released).toBe(0)
        await page.screenshot({ path: `${shots}/${width}-${theme}-release-confirm.png`, animations: 'disabled' })
        await confirm.getByRole('button', { name: '释放', exact: true }).click()
        await reserved.getByText('已释放 2 个', { exact: true }).waitFor()
        // The count and the size follow what is still held: the one still needed.
        await reserved.getByText('1 个 · 2 KB', { exact: true }).waitFor()
        expect(released).toBe(1)
        expect(releasedIds).toEqual(['a'.repeat(22), 'b'.repeat(22)])
      } finally {
        await context.close()
      }
    })
})
