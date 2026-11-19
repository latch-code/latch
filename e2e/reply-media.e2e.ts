import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Locator, type Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { openSession, settleShell } from './helpers/layout.ts'

const OUT = 'test-results/reply-media'
const SLOW = { timeout: 20_000 }
const REPLY = [
  '图表如下：',
  '',
  '![销量图](out/chart.png)',
  '',
  '录屏：[clip.webm](out/clip.webm)',
  '',
  '[下载 PNG 原图](/nonexistent/.codex/generated_images/ig_1.png)',
].join('\n')
/** What the fixture model answers; a test may replace it before it sends. */
let reply = REPLY

/** A picture and a short video drawn by the page itself, so the test needs no media files or encoder. */
async function media(page: Page): Promise<{ png: Buffer; webm: Buffer }> {
  const { png, webm } = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 960
    canvas.height = 600
    const ctx = canvas.getContext('2d')!
    const paint = (shift: number) => {
      const gradient = ctx.createLinearGradient(0, 0, 960, 600)
      gradient.addColorStop(0, `hsl(${200 + shift} 70% 62%)`)
      gradient.addColorStop(1, `hsl(${240 + shift} 60% 32%)`)
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, 960, 600)
      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      ctx.beginPath()
      ctx.arc(300 + shift * 6, 300, 120, 0, Math.PI * 2)
      ctx.fill()
    }
    paint(0)
    const png = canvas.toDataURL('image/png').split(',')[1]!
    const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm' })
    const parts: Blob[] = []
    recorder.ondataavailable = event => parts.push(event.data)
    const stopped = new Promise(resolve => (recorder.onstop = resolve))
    recorder.start()
    for (let frame = 0; frame < 60; frame++) {
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

/** Each width and theme, once with each of `parts` scrolled to the top of the view. */
async function shots(page: Page, name: string, parts: Record<string, Locator>): Promise<void> {
  for (const width of [390, 820, 1440]) {
    await page.setViewportSize({ width, height: 960 })
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme })
      for (const [part, target] of Object.entries(parts)) {
        await target.evaluate(node => node.scrollIntoView({ block: 'start' }))
        await page.waitForTimeout(300)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ path: `${OUT}/${name}-${part}-${width}-${theme}.png`, animations: 'disabled' })
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.emulateMedia({ colorScheme: 'light' })
}

describe('media in replies', () => {
  let host: TestHost, browser: Browser
  beforeAll(async () => {
    const plugin: HarnessPlugin = {
      id: 'media',
      name: '媒体',
      version: '1.0.0',
      description: '测试',
      activate(context) {
        context.registerProvider({
          id: 'media',
          name: 'Fixture media',
          model: 'fixture',
          async *stream() {
            yield { type: 'text', text: reply }
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

  it('draws a picture and a video a reply links to, plays and seeks the video, and keeps a chip for what it cannot show', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    try {
      const ranges: Array<{ status: number; type: string; range: string }> = []
      page.on('response', response => {
        if (!response.url().includes('/link/api/files/') || response.request().method() !== 'GET') return
        ranges.push({
          status: response.status(),
          type: response.headers()['content-type'] ?? '',
          range: response.request().headers().range ?? '',
        })
      })
      await enrollBrowser(page, host, { name: '回复媒体', scopes: ['admin'] })
      const home = page.locator('.workbench-home')
      await home.getByRole('textbox', { name: '新会话消息', exact: true }).waitFor()
      const { png, webm } = await media(page)
      await mkdir(join(host.workspaceRoot, 'out'), { recursive: true })
      await writeFile(join(host.workspaceRoot, 'out', 'chart.png'), png)
      await writeFile(join(host.workspaceRoot, 'out', 'clip.webm'), webm)
      await home.getByRole('textbox', { name: '新会话消息', exact: true }).fill('画个图')
      await home.getByRole('button', { name: '发送', exact: true }).click()
      const reply = page.locator('.message-assistant').last()
      await reply.getByText('图表如下：').waitFor()

      // The picture, at its own shape, from a handle the Host authorized; its size was reserved before its bytes.
      const image = reply.locator('img.inline-media-image')
      await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth === 960), SLOW).toBe(true)
      expect(await image.getAttribute('width')).toBe('960')
      expect(await image.getAttribute('height')).toBe('600')
      expect(await image.getAttribute('src')).toMatch(/^\/link\/api\/files\/[A-Za-z0-9_-]{22}\?v=[a-f0-9]{32}$/u)
      const box = (await image.boundingBox())!
      expect(Math.abs(box.width / box.height - 1.6)).toBeLessThan(0.02)

      // The video plays with its own controls, served as video, and seeks by byte ranges.
      const video = reply.locator('video.inline-media-video')
      await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.readyState >= 1), SLOW).toBe(true)
      expect(await video.evaluate((node: HTMLVideoElement) => node.controls)).toBe(true)
      // The link keeps its chip under the video: the way to the file.
      await reply
        .locator('.message-media[data-kind="video"] .message-media-caption')
        .getByRole('button', { name: '预览文件：out/clip.webm', exact: true })
        .waitFor()
      await video.evaluate(async (node: HTMLVideoElement) => {
        node.muted = true
        await node.play()
        node.pause()
        const seeked = new Promise(resolve => node.addEventListener('seeked', resolve, { once: true }))
        node.currentTime = Math.min(1, (Number.isFinite(node.duration) ? node.duration : 2) / 2)
        await seeked
      })
      expect(ranges.some(item => item.status === 206 && item.type === 'video/webm' && item.range.startsWith('bytes='))).toBe(true)

      // A handle that lapsed while the video sat paused: the page asks the Host once more and keeps the player, rather
      // than falling back to the chip. (The Host keeps one live handle per file, so the renewed source may be the same.)
      const source = (await video.getAttribute('src'))!.split('?')[0]!
      let lapsed = 0
      await page.route(`**${source}*`, async route => {
        if (lapsed++ === 0)
          await route.fulfill({ status: 410, json: { error: 'file-handle-expired', message: '文件已不可用，请重新打开' } })
        else await route.continue()
      })
      await video.evaluate((node: HTMLVideoElement) => node.load())
      await expect.poll(() => lapsed, SLOW).toBeGreaterThan(1)
      await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.readyState >= 1), SLOW).toBe(true)
      await page.unrouteAll()

      // A path the Host does not authorize (Codex's own folder, outside the session) stays the chip it was.
      const outside = reply.locator('.file-chip', { hasText: '下载 PNG 原图' })
      await outside.waitFor()
      expect(await reply.locator('img, video, audio').count()).toBe(2)

      await shots(page, 'reply', { image, video })
      // Pressing the picture opens it in the file pane.
      await reply.getByRole('button', { name: '预览图片：销量图', exact: true }).click()
      await page.getByRole('region', { name: '文件预览', exact: true }).waitFor()
    } finally {
      await context.close()
    }
  })

  it('draws a picture the reply names outside the session folders and opens it in the file pane', async () => {
    // A stand-in for Codex's own folder: a temporary one, never the person's real ~/.codex.
    const outsideRoot = await mkdtemp(join(tmpdir(), 'latch-outside-e2e-'))
    const folder = join(outsideRoot, '.codex', 'generated_images', 'ig_e2e')
    const picture = join(folder, 'ig_e2e.png')
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    try {
      let resolveRoute = ''
      page.on('request', request => {
        if (/\/link\/api\/tasks\/[^/]+\/files\/resolve$/u.test(new URL(request.url()).pathname))
          resolveRoute = new URL(request.url()).pathname
      })
      await enrollBrowser(page, host, { name: '外部图片', scopes: ['admin'] })
      const home = page.locator('.workbench-home')
      await home.getByRole('textbox', { name: '新会话消息', exact: true }).waitFor()
      const { png } = await media(page)
      await mkdir(folder, { recursive: true })
      await writeFile(picture, png)
      await writeFile(join(folder, 'sibling.png'), png)
      reply = [
        `[下载 ig_e2e 原图（PNG，960 × 600）](${picture})`,
        '',
        `![紫粉色粒子在深色背景中形成涡环](${picture})`,
        '',
        `没提到的：\`${join(folder, 'other.png')}\``,
      ].join('\n')
      await home.getByRole('textbox', { name: '新会话消息', exact: true }).fill('把图给我看看')
      await home.getByRole('button', { name: '发送', exact: true }).click()
      const answer = page.locator('.message-assistant').last()
      await answer.getByText('没提到的：').waitFor()

      // The markdown picture draws from a handle the Host issued for that one named file.
      const drawn = answer.getByRole('button', { name: '预览图片：紫粉色粒子在深色背景中形成涡环', exact: true })
      await drawn.waitFor()
      const img = drawn.locator('img.inline-media-image')
      await expect.poll(() => img.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth === 960), SLOW).toBe(true)
      expect(await img.getAttribute('src')).toMatch(/^\/link\/api\/files\/[A-Za-z0-9_-]{22}\?v=[a-f0-9]{32}$/u)
      // The link draws the same picture above its chip; the unnamed sibling is never asked for or shown.
      const chip = answer.locator('.message-media-caption .file-chip', { hasText: '下载 ig_e2e 原图' })
      await chip.waitFor()
      expect(await answer.locator('img.inline-media-image').count()).toBe(2)
      const sibling = await page.evaluate(
        async ([route, path]) => {
          const response = await fetch(route!, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ paths: [path] }),
          })
          return response.ok ? ((await response.json()) as { files: Array<{ status: string }> }).files[0]?.status : String(response.status)
        },
        [resolveRoute, join(folder, 'sibling.png')],
      )
      expect(['outside', 'not-referenced']).toContain(sibling)

      await shots(page, 'outside', { image: img })
      // The chip opens the picture in the file pane, whose breadcrumb names the real folder, not a session folder.
      await chip.click()
      const pane = page.getByRole('region', { name: '文件预览', exact: true })
      await pane.waitFor()
      const crumb = pane.locator('.file-crumb-folder')
      await expect.poll(() => crumb.getAttribute('title'), SLOW).toBe(folder)
      expect(await pane.locator('.file-crumbs').textContent()).not.toContain('会话文件夹')
      await expect
        .poll(
          () =>
            pane
              .locator('img')
              .first()
              .evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth === 960),
          SLOW,
        )
        .toBe(true)
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 960 })
        for (const theme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme: theme })
          await page.waitForTimeout(300)
          // A narrower layout opens the pane again from its tab: the same named file, still authorized.
          await expect.poll(() => page.locator('.file-crumb-folder').first().getAttribute('title'), SLOW).toBe(folder)
          expect(await page.getByText('无法读取这个文件').count()).toBe(0)
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          await page.screenshot({ path: `${OUT}/outside-pane-${width}-${theme}.png`, animations: 'disabled' })
        }
      }
    } finally {
      reply = REPLY
      await context.close()
      await rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it('draws a picture an agent made in its reply at its own size', async () => {
    const owner = await host.enroll({ listener: 'unix' })
    expect(
      (
        await owner.confirmed('agents', {
          method: 'POST',
          body: { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT] },
        })
      ).status,
    ).toBe(201)
    const created = await owner.confirmed('tasks', {
      method: 'POST',
      body: { prompt: 'image-picture', requestId: randomUUID(), mode: 'agent', harnessId: 'fake', workspaceId: 'default' },
    })
    const { sessionId } = (await created.json()) as { sessionId: string }
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, SLOW).toBe('idle')
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    try {
      await enrollBrowser(page, host, { name: '回复图片', scopes: ['admin'] })
      await settleShell(page)
      await openSession(page, sessionId)
      const picture = page.locator('.message-assistant .message-attachment-media img.inline-media-image')
      await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth === 768), SLOW).toBe(true)
      expect(await picture.getAttribute('src')).toMatch(/^\/link\/api\/attachments\/[A-Za-z0-9_-]{22}\/content$/u)
      expect((await picture.boundingBox())!.width).toBeGreaterThan(400)
      await shots(page, 'agent', { image: picture })
    } finally {
      await context.close()
    }
  })
})
