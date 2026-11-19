import { chromium, type Browser, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HarnessPlugin, ModelMessage } from '@latch/sdk'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const OUT = 'test-results/attachment-tiles'
const PDF_NAME = '报告-2026 年第三季度经营分析（最终版）.pdf'
/** A one-page PDF; only its type matters here, the agent reads it by its path. */
const pdf = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
)
const source = Buffer.from('export function total(values: number[]): number {\n  return values.reduce((sum, value) => sum + value, 0)\n}\n')

/** A picture and a short video drawn by the page itself, so the test needs no media files or encoder. */
async function media(page: Page): Promise<{ png: Buffer; webm: Buffer }> {
  const { png, webm } = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 400
    const ctx = canvas.getContext('2d')!
    const paint = (shift: number) => {
      const gradient = ctx.createLinearGradient(0, 0, 640, 400)
      gradient.addColorStop(0, `hsl(${210 + shift} 70% 62%)`)
      gradient.addColorStop(1, `hsl(${250 + shift} 60% 32%)`)
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, 640, 400)
      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      ctx.beginPath()
      ctx.arc(200 + shift * 4, 210, 80, 0, Math.PI * 2)
      ctx.fill()
    }
    paint(0)
    const png = canvas.toDataURL('image/png').split(',')[1]!
    const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm' })
    const parts: Blob[] = []
    recorder.ondataavailable = event => parts.push(event.data)
    const stopped = new Promise(resolve => (recorder.onstop = resolve))
    recorder.start()
    for (let frame = 0; frame < 45; frame++) {
      paint(frame)
      await new Promise(resolve => setTimeout(resolve, 33))
    }
    recorder.stop()
    await stopped
    const bytes = new Uint8Array(await new Blob(parts, { type: 'video/webm' }).arrayBuffer())
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return { png, webm: btoa(binary) }
  })
  return { png: Buffer.from(png, 'base64'), webm: Buffer.from(webm, 'base64') }
}

describe('attachment tiles', () => {
  let host: TestHost, browser: Browser
  const seen: ModelMessage[][] = []
  beforeAll(async () => {
    const plugin: HarnessPlugin = {
      id: 'tiles',
      name: '附件',
      version: '1.0.0',
      description: '测试',
      activate(context) {
        context.registerProvider({
          id: 'vision',
          name: 'Fixture vision',
          model: 'fixture',
          modelCapabilities: { fixture: { vision: true } },
          async *stream(input) {
            seen.push(structuredClone(input.messages))
            yield { type: 'text', text: '已收到附件。' }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    host = await startTestHost({ demo: false, plugins: [plugin] })
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUT, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
  })

  it('draws an image, a video, a PDF and a source file as tiles in the draft and the message, and hands each to the agent', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    try {
      const contentRequests: string[] = []
      page.on('request', request => {
        if (request.url().includes('/attachments/') && request.url().endsWith('/content'))
          contentRequests.push(`${request.resourceType()} ${request.headers().range ?? 'whole'}`)
      })
      await enrollBrowser(page, host, { name: '附件样式', scopes: ['admin'] })
      const home = page.locator('.workbench-home')
      await home.getByRole('textbox', { name: '新会话消息', exact: true }).waitFor()
      const { png, webm } = await media(page)
      await home.getByLabel('选择附件', { exact: true }).setInputFiles([
        { name: '首页截图.png', mimeType: 'image/png', buffer: png },
        { name: 'screen-recording.webm', mimeType: 'video/webm', buffer: webm },
        { name: PDF_NAME, mimeType: 'application/pdf', buffer: pdf },
        { name: 'total.ts', mimeType: 'video/mp2t', buffer: source },
      ])
      const drafts = home.getByLabel('消息附件', { exact: true })
      await expect
        .poll(async () => {
          const states = await drafts
            .locator('.attachment-draft')
            .evaluateAll(nodes => nodes.map(node => `${node.getAttribute('data-state')} ${node.textContent}`))
          return states.filter(state => state.startsWith('ready')).length === 4 ? 4 : states.join(' | ')
        })
        .toBe(4)
      // The media itself: the picture, and the video's first frame with its play mark and length.
      await expect.poll(() => drafts.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)
      await expect.poll(() => drafts.locator('video').evaluate((video: HTMLVideoElement) => video.readyState >= 2)).toBe(true)
      await drafts.locator('[data-type="video"] .attachment-tile-duration').waitFor()
      await drafts.locator('[data-type="video"] .attachment-tile-play').waitFor()
      expect(await drafts.locator('[data-type="pdf"] .attachment-tile-ext').innerText()).toBe('PDF')
      expect(await drafts.locator('[data-type="code"] .attachment-tile-ext').innerText()).toBe('TS')
      // Nothing is refused and nothing red is said; what goes by its path says so only on hover.
      expect(await page.locator('.attachment-draft[data-state="refused"], .attachment-draft[data-state="failed"]').count()).toBe(0)
      expect(await drafts.locator('.attachment-draft[data-delivery="path"]').count()).toBe(2)
      expect(await drafts.locator('[data-type="pdf"]').getAttribute('title')).toContain('以文件交给 Agent')
      expect(await drafts.locator('[data-type="image"]').getAttribute('title')).not.toContain('以文件交给 Agent')
      // The long CJK name is cut in its middle: its end stays.
      expect(await drafts.locator('[data-type="pdf"] .attachment-tile-tail').innerText()).toBe('版）.pdf')
      for (const width of [390, 820, 1440]) {
        await page.setViewportSize({ width, height: 960 })
        for (const theme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme: theme })
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          await expect
            .poll(() =>
              drafts
                .locator('.attachment-draft')
                .first()
                .evaluate(node => node.getBoundingClientRect().width),
            )
            .toBe(64)
          await page
            .locator('.composer')
            .filter({ visible: true })
            .first()
            .screenshot({ path: `${OUT}/draft-${width}-${theme}.png`, animations: 'disabled' })
        }
      }
      await page.setViewportSize({ width: 1440, height: 960 })
      await page.emulateMedia({ colorScheme: 'light' })
      // The video plays in the composer's own preview.
      await drafts.getByRole('button', { name: 'screen-recording.webm', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'screen-recording.webm', exact: true })
      await expect.poll(() => dialog.locator('video').evaluate((video: HTMLVideoElement) => video.readyState >= 2)).toBe(true)
      await dialog.getByRole('button', { name: '关闭', exact: true }).click()
      await home.getByRole('textbox', { name: '新会话消息', exact: true }).fill('看看这些附件')
      await home.getByRole('button', { name: '发送', exact: true }).click()
      await page.getByText('已收到附件。', { exact: true }).waitFor()
      // What the model got: the picture and the source text natively, the video and the PDF by their paths.
      const user = seen.at(-1)!.find(message => message.role === 'user')!
      expect(user.attachments?.map(item => item.type)).toEqual(['image', 'text'])
      expect(user.content).toMatch(/- screen-recording\.webm（video\/webm，\d+ KB）：\/.+\/screen-recording\.webm/u)
      expect(user.content).toContain(`- ${PDF_NAME}（application/pdf，`)
      const message = page.locator('.message-user')
      await expect
        .poll(() => message.locator('.message-attachments img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
        .toBe(true)
      await expect
        .poll(() => message.locator('.message-attachments video').evaluate((video: HTMLVideoElement) => video.readyState >= 2))
        .toBe(true)
      expect(await message.locator('.message-attachment').count()).toBe(4)
      for (const width of [390, 820, 1440]) {
        await page.setViewportSize({ width, height: 960 })
        for (const theme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme: theme })
          await page.waitForTimeout(300)
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          await page.screenshot({ path: `${OUT}/message-${width}-${theme}.png`, animations: 'disabled' })
        }
      }
      // One request per drawn picture and video: a video tile reads its metadata and first frame in one range request.
      expect(contentRequests.filter(request => request.startsWith('media'))).toHaveLength(1)
      expect(contentRequests.filter(request => request.startsWith('image'))).toHaveLength(1)
      // After a reload the sent message still draws its media.
      await page.setViewportSize({ width: 1440, height: 960 })
      await page.emulateMedia({ colorScheme: 'light' })
      await page.reload()
      await expect
        .poll(() =>
          page.locator('.message-user .message-attachments img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
        )
        .toBe(true)
      // A sent picture is looked at large over the page, not in the file pane.
      await page.locator('.message-user .message-attachment[data-type="image"]').getByRole('button').first().click()
      const large = page.locator('.attachment-preview.is-large')
      await large.locator('img').waitFor()
      const [box, shown] = await Promise.all([large.boundingBox(), large.locator('img').boundingBox()])
      expect(box!.width).toBeGreaterThan(600)
      expect(shown!.width).toBeGreaterThan(104)
      expect(await page.getByRole('region', { name: '文件预览', exact: true }).count()).toBe(0)
      await page.screenshot({ path: `${OUT}/large-image-1440-light.png`, animations: 'disabled' })
      await large.getByRole('button', { name: '关闭', exact: true }).click()
      await expect.poll(() => large.count()).toBe(0)
      // A sent video opens in the file pane.
      await page
        .locator('.message-user')
        .getByRole('button', { name: /^screen-recording\.webm / })
        .click()
      const preview = page.getByRole('region', { name: '文件预览', exact: true })
      await preview.waitFor()
      await page.screenshot({ path: `${OUT}/preview-video-1440-light.png`, animations: 'disabled' })
    } finally {
      await context.close()
    }
  })
  for (const [width, theme] of [
    [390, 'dark'],
    [1440, 'light'],
  ] as const)
    it(`shows progress and a failure on the tile at ${width}/${theme}`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, locale: 'zh-CN' })
      const page = await context.newPage()
      page.setDefaultTimeout(15_000)
      try {
        await enrollBrowser(page, host, { name: `附件状态 ${width}`, scopes: ['admin'] })
        const home = page.locator('.workbench-home')
        if (!(await home.isVisible()))
          await page.getByRole('button', { name: '新建会话', exact: true }).filter({ visible: true }).first().click()
        await home.getByRole('textbox', { name: '新会话消息', exact: true }).waitFor()
        const { png } = await media(page)
        let release!: () => void
        const held = new Promise<void>(resolve => (release = resolve))
        await page.route('**/link/api/attachments', async route => {
          const name = JSON.parse(Buffer.from(route.request().headers()['x-latch-attachment']!, 'base64url').toString()).name as string
          if (name === 'slow.png') {
            await held
            await route.continue()
          } else if (name === 'huge.mov')
            await route.fulfill({ status: 413, json: { error: 'attachment-too-large', message: '每个文件最多 10 MB。' } })
          else await route.continue()
        })
        await home.getByLabel('选择附件', { exact: true }).setInputFiles([
          { name: 'slow.png', mimeType: 'image/png', buffer: png },
          { name: 'huge.mov', mimeType: 'video/quicktime', buffer: Buffer.alloc(2048, 1) },
        ])
        const drafts = home.getByLabel('消息附件', { exact: true })
        await drafts.locator('.attachment-draft[data-state="refused"]').getByText('每个文件最多 10 MB。').waitFor()
        await drafts.locator('.attachment-draft[data-state="uploading"] .attachment-tile-progress').waitFor()
        await page.waitForTimeout(300)
        await page
          .locator('.composer')
          .filter({ visible: true })
          .first()
          .screenshot({ path: `${OUT}/states-${width}-${theme}.png`, animations: 'disabled' })
        release()
        await drafts.locator('.attachment-draft[data-state="ready"]').waitFor()
      } finally {
        await context.close()
      }
    })
})
