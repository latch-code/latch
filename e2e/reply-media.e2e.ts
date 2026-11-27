import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Locator, type Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { FAKE_ACP_AGENT, FAKE_CODEX_APP_SERVER } from '@latch/testkit'
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
async function shots(page: Page, name: string, parts: Record<string, Locator>, widths = [390, 820, 1440]): Promise<void> {
  for (const width of widths) {
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

/**
 * The viewer is open on a loaded picture, fitted inside the window, never past its natural size, with the whole window
 * dimmed behind it (not blurred); focus is inside it.
 */
async function viewerShows(page: Page, viewer: Locator, width: number, height: number): Promise<void> {
  await viewer.waitFor()
  // Measured once the picture has come in (it grows from 98.5%).
  await viewer.evaluate(node => Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished)))
  const picture = viewer.locator('img.picture-viewer-image')
  await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), SLOW).toBe(true)
  expect(await picture.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight])).toEqual([width, height])
  const box = (await picture.boundingBox())!
  const view = page.viewportSize()!
  expect(box.width).toBeLessThanOrEqual(width + 0.5)
  expect(box.x).toBeGreaterThanOrEqual(-0.5)
  expect(box.y).toBeGreaterThanOrEqual(-0.5)
  expect(box.x + box.width).toBeLessThanOrEqual(view.width + 0.5)
  expect(box.y + box.height).toBeLessThanOrEqual(view.height + 0.5)
  // Contain: the picture keeps its own shape.
  expect(Math.abs(box.width / box.height - width / height)).toBeLessThan(0.02)
  expect(await viewer.evaluate(node => node.matches(':modal') && node.contains(document.activeElement))).toBe(true)
  const scrim = await viewer.evaluate(node => [
    getComputedStyle(node, '::backdrop').backgroundColor,
    getComputedStyle(node, '::backdrop').backdropFilter,
  ])
  const [r, g, b, a] = (scrim[0]!.match(/[\d.]+/gu) ?? []).map(Number)
  expect(Math.max(r!, g!, b!)).toBeLessThan(24)
  expect(a).toBeGreaterThan(0.6)
  expect(scrim[1]).toBe('none')
  // No frame round it: the picture is the only thing on the dim besides the icons.
  expect(await viewer.locator('.picture-viewer-window, .picture-viewer-bar, .picture-viewer-title').count()).toBe(0)
}

/** The open viewer at a phone and a desktop width, in both themes. */
async function viewerShots(page: Page, name: string): Promise<void> {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme })
      await page.waitForTimeout(300)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: `${OUT}/${name}-${width}-${theme}.png`, animations: 'disabled' })
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
      // Pressing the picture shows it large over the page, not in the file pane; Esc closes it and focus comes back.
      const press = reply.getByRole('button', { name: '预览图片：销量图', exact: true })
      // A handle that lapsed since the picture was drawn: the viewer asks for it once more, as the message does.
      const drawnSource = (await image.getAttribute('src'))!.split('?')[0]!
      let refused = 0
      await page.route(`**${drawnSource}*`, async route => {
        if (refused++ === 0)
          await route.fulfill({ status: 410, json: { error: 'file-handle-expired', message: '文件已不可用，请重新打开' } })
        else await route.continue()
      })
      await press.click()
      const viewer = page.getByRole('dialog', { name: '销量图', exact: true })
      await viewerShows(page, viewer, 960, 600)
      expect(await page.getByRole('region', { name: '文件预览', exact: true }).count()).toBe(0)
      // One picture: no count and no steps.
      expect(await viewer.locator('.picture-viewer-count').count()).toBe(0)
      expect(await viewer.getByRole('button', { name: '下一张', exact: true }).count()).toBe(0)
      expect(refused).toBeGreaterThan(1)
      await page.unrouteAll()
      await viewerShots(page, 'viewer-reply')
      // 下载 reads the same authorized handle and saves under the file's own name.
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        viewer.getByRole('button', { name: '下载', exact: true }).click(),
      ])
      expect(download.suggestedFilename()).toBe('chart.png')
      // A right click on the picture offers 复制图片 and 保存图片, inside the viewer too.
      await viewer.locator('img.picture-viewer-image').click({ button: 'right' })
      const saveItem = page.getByRole('menuitem', { name: '保存图片', exact: true })
      await saveItem.waitFor()
      expect(await page.getByRole('menuitem', { name: '复制图片', exact: true }).count()).toBe(1)
      await page.screenshot({ path: `${OUT}/viewer-menu-1440-light.png`, animations: 'disabled' })
      const [saved] = await Promise.all([page.waitForEvent('download'), saveItem.click()])
      expect(saved.suggestedFilename()).toBe('chart.png')
      await page.keyboard.press('Escape')
      await viewer.waitFor({ state: 'detached' })
      await expect.poll(() => press.evaluate(node => node === document.activeElement)).toBe(true)
      // And on the picture in the reply: 复制图片 puts a PNG on the clipboard.
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
      await press.click({ button: 'right' })
      await page.getByRole('menuitem', { name: '复制图片', exact: true }).waitFor()
      await page.screenshot({ path: `${OUT}/reply-menu-1440-light.png`, animations: 'disabled' })
      await page.getByRole('menuitem', { name: '复制图片', exact: true }).click()
      await expect
        .poll(() => page.evaluate(async () => (await navigator.clipboard.read()).flatMap(item => item.types)), SLOW)
        .toContain('image/png')
      expect(await viewer.count()).toBe(0)
      // A press beside the picture closes it too.
      await press.click()
      await viewer.waitFor()
      await page.mouse.click(8, 480)
      await viewer.waitFor({ state: 'detached' })
      // 在文件中打开 is the way to the file pane.
      await press.click()
      await viewer.getByRole('button', { name: '在文件中打开', exact: true }).click()
      await page.getByRole('region', { name: '文件预览', exact: true }).waitFor()
      expect(await viewer.count()).toBe(0)
    } finally {
      await context.close()
    }
  })

  it('hides punctuation separators stranded beside resolved block images while keeping them for inline chips', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    try {
      await enrollBrowser(page, host, { name: '媒体标点', scopes: ['admin'] })
      const home = page.locator('.workbench-home')
      await home.getByRole('textbox', { name: '新会话消息', exact: true }).waitFor()
      const { png } = await media(page)
      await mkdir(join(host.workspaceRoot, 'out'), { recursive: true })
      await writeFile(join(host.workspaceRoot, 'out', 'shot-a.png'), png)
      await writeFile(join(host.workspaceRoot, 'out', 'shot-b.png'), png)
      reply = [
        '- 更新 [shot-a.png](out/shot-a.png)、[shot-b.png](out/shot-b.png)：展示最新左上角切换器与多目录分支计数。',
        '- 无法展示的路径：[missing-a.png](/nonexistent/a.png)、[missing-b.png](/nonexistent/b.png)：保留行内文件标签与冒号。',
      ].join('\n')
      await home.getByRole('textbox', { name: '新会话消息', exact: true }).fill('看多张截图')
      await home.getByRole('button', { name: '发送', exact: true }).click()
      const answer = page.locator('.message-assistant').last()
      await expect.poll(() => answer.locator('img.inline-media-image').count(), SLOW).toBe(2)
      const items = answer.locator('li')
      // Resolved block images hide the stranded 、 and leading ： between/after them.
      await expect
        .poll(() =>
          items
            .nth(0)
            .locator('.media-sep')
            .evaluateAll(nodes => nodes.map(node => getComputedStyle(node).display)),
        )
        .toEqual(['none', 'none'])
      // Unresolved links stay inline chips, so their 、 and ： stay visible.
      await expect
        .poll(() =>
          items
            .nth(1)
            .locator('.media-sep')
            .evaluateAll(nodes => nodes.map(node => getComputedStyle(node).display)),
        )
        .toEqual(['inline', 'inline'])
      await page.screenshot({ path: `${OUT}/separators-1440-light.png`, animations: 'disabled' })
    } finally {
      reply = REPLY
      await context.close()
    }
  })

  it('steps between a reply’s pictures in the viewer with ← → and a swipe, and fits a tall one', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN', hasTouch: true })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    try {
      await enrollBrowser(page, host, { name: '多张图片', scopes: ['admin'] })
      const home = page.locator('.workbench-home')
      await home.getByRole('textbox', { name: '新会话消息', exact: true }).waitFor()
      const { png } = await media(page)
      // A tall picture, larger than the window, drawn by the page.
      const tall = await page.evaluate(() => {
        const canvas = document.createElement('canvas')
        canvas.width = 1200
        canvas.height = 2400
        const ctx = canvas.getContext('2d')!
        ctx.fillStyle = 'hsl(160 50% 45%)'
        ctx.fillRect(0, 0, 1200, 2400)
        ctx.fillStyle = 'hsl(40 80% 70%)'
        ctx.fillRect(200, 400, 800, 1600)
        return canvas.toDataURL('image/png').split(',')[1]!
      })
      await mkdir(join(host.workspaceRoot, 'out'), { recursive: true })
      await writeFile(join(host.workspaceRoot, 'out', 'first.png'), png)
      await writeFile(join(host.workspaceRoot, 'out', 'tall.png'), Buffer.from(tall, 'base64'))
      reply = ['两张图：', '', '![第一张](out/first.png)', '', '![高的一张](out/tall.png)'].join('\n')
      await home.getByRole('textbox', { name: '新会话消息', exact: true }).fill('两张图')
      await home.getByRole('button', { name: '发送', exact: true }).click()
      const answer = page.locator('.message-assistant').last()
      const first = answer.getByRole('button', { name: '预览图片：第一张', exact: true })
      const second = answer.getByRole('button', { name: '预览图片：高的一张', exact: true })
      for (const button of [first, second])
        await expect
          .poll(() => button.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), SLOW)
          .toBe(true)

      await first.click()
      const viewer = page.locator('dialog.picture-viewer')
      await viewerShows(page, page.getByRole('dialog', { name: '第一张', exact: true }), 960, 600)
      expect(await viewer.locator('.picture-viewer-count').textContent()).toBe('1 / 2')
      await page.keyboard.press('ArrowRight')
      await viewerShows(page, page.getByRole('dialog', { name: '高的一张', exact: true }), 1200, 2400)
      expect(await viewer.locator('.picture-viewer-count').textContent()).toBe('2 / 2')
      // Fitted: smaller than its own size, whole in the window.
      const picture = viewer.locator('img.picture-viewer-image')
      const fitted = (await picture.boundingBox())!
      expect(fitted.height).toBeLessThan(960)
      await viewerShots(page, 'viewer-steps')
      // A press shows it at 100%, where the stage scrolls; another fits it again.
      await picture.click()
      await expect.poll(async () => (await picture.boundingBox())!.width).toBe(1200)
      const stage = viewer.locator('.picture-viewer-stage')
      expect(await stage.getAttribute('data-zoom')).toBe('actual')
      expect(await stage.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true)
      await page.mouse.wheel(0, 400)
      await expect.poll(() => stage.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
      // At 100% the arrows pan, they do not step.
      await page.keyboard.press('ArrowLeft')
      expect(await viewer.locator('.picture-viewer-count').textContent()).toBe('2 / 2')
      await picture.click()
      await expect
        .poll(async () => [await stage.getAttribute('data-zoom'), Math.round((await picture.boundingBox())!.width)])
        .toEqual(['fit', Math.round(fitted.width)])
      // Two fingers zoom on past 100% and back, around the point between them; nothing zooms the page behind.
      const pinch = (from: number, to: number) =>
        stage.evaluate(
          (node, [a, b]) => {
            const box = node.getBoundingClientRect(),
              cx = box.left + box.width / 2,
              cy = box.top + box.height / 2
            const at = (type: string, id: number, x: number) =>
              node.dispatchEvent(
                new PointerEvent(type, {
                  pointerId: id,
                  pointerType: 'touch',
                  isPrimary: id === 11,
                  bubbles: true,
                  clientX: x,
                  clientY: cy,
                  button: 0,
                }),
              )
            at('pointerdown', 11, cx - a!)
            at('pointerdown', 12, cx + a!)
            for (let step = 1; step <= 8; step++) {
              const d = a! + ((b! - a!) * step) / 8
              at('pointermove', 11, cx - d)
              at('pointermove', 12, cx + d)
            }
            at('pointerup', 12, cx + b!)
            at('pointerup', 11, cx - b!)
          },
          [from, to],
        )
      expect(await stage.evaluate(node => getComputedStyle(node).touchAction)).toBe('none')
      await pinch(40, 400)
      await expect.poll(() => stage.getAttribute('data-zoom')).toBe('actual')
      expect((await picture.boundingBox())!.width).toBeGreaterThan(1200)
      await pinch(400, 20)
      await expect
        .poll(async () => [await stage.getAttribute('data-zoom'), Math.round((await picture.boundingBox())!.width)])
        .toEqual(['fit', Math.round(fitted.width)])
      // A trackpad pinch is a wheel with ctrl: it zooms up to four times the picture's own size.
      await picture.hover()
      await page.keyboard.down('Control')
      await page.mouse.wheel(0, -600)
      await page.keyboard.up('Control')
      await expect.poll(async () => Math.round((await picture.boundingBox())!.width)).toBe(4800)
      // 0 fits it again; + and − zoom around the middle.
      await page.keyboard.press('0')
      await expect.poll(() => stage.getAttribute('data-zoom')).toBe('fit')
      await page.keyboard.press('+')
      await expect.poll(() => stage.getAttribute('data-zoom')).toBe('actual')
      await page.keyboard.press('0')
      await expect.poll(() => stage.getAttribute('data-zoom')).toBe('fit')
      await page.keyboard.press('ArrowLeft')
      await page.getByRole('dialog', { name: '第一张', exact: true }).waitFor()
      // At either end it stays.
      await page.keyboard.press('ArrowLeft')
      expect(await viewer.locator('.picture-viewer-count').textContent()).toBe('1 / 2')
      await page.keyboard.press('Escape')
      await viewer.waitFor({ state: 'detached' })
      await expect.poll(() => first.evaluate(node => node === document.activeElement)).toBe(true)

      // On a phone: full screen, a swipe steps and a drag down closes.
      await page.setViewportSize({ width: 390, height: 844 })
      await first.scrollIntoViewIfNeeded()
      await first.tap()
      await viewer.waitFor()
      const full = (await viewer.boundingBox())!
      expect([Math.round(full.width), Math.round(full.height)]).toEqual([390, 844])
      const swipe = async (dx: number, dy: number) => {
        await stage.evaluate(
          (node, [x, y]) => {
            const at = (type: string, cx: number, cy: number) =>
              node.dispatchEvent(
                new PointerEvent(type, {
                  pointerId: 7,
                  pointerType: 'touch',
                  isPrimary: true,
                  bubbles: true,
                  clientX: cx,
                  clientY: cy,
                  button: 0,
                }),
              )
            at('pointerdown', 195, 400)
            for (let step = 1; step <= 6; step++) at('pointermove', 195 + (x! * step) / 6, 400 + (y! * step) / 6)
            at('pointerup', 195 + x!, 400 + y!)
          },
          [dx, dy],
        )
      }
      await swipe(-160, 0)
      await page.getByRole('dialog', { name: '高的一张', exact: true }).waitFor()
      await swipe(160, 0)
      await page.getByRole('dialog', { name: '第一张', exact: true }).waitFor()
      await swipe(0, 200)
      await viewer.waitFor({ state: 'detached' })
    } finally {
      reply = REPLY
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
      // The link draws the same picture, with no chip left under it; the unnamed sibling is never asked for or shown.
      await expect.poll(() => answer.locator('img.inline-media-image').count(), SLOW).toBe(2)
      expect(await answer.locator('.file-chip', { hasText: '下载 ig_e2e 原图' }).count()).toBe(0)
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
      // The same file drawn twice is one picture in the viewer: no count, no steps.
      await drawn.click()
      const viewer = page.getByRole('dialog', { name: '紫粉色粒子在深色背景中形成涡环', exact: true })
      await viewerShows(page, viewer, 960, 600)
      expect(await viewer.locator('.picture-viewer-count').count()).toBe(0)
      await viewerShots(page, 'viewer-outside')
      await viewer.getByRole('button', { name: '关闭', exact: true }).click()
      await viewer.waitFor({ state: 'detached' })
      await expect.poll(() => drawn.evaluate(node => node === document.activeElement)).toBe(true)
      // The viewer's 在文件中打开 shows the picture in the file pane, whose breadcrumb names the real folder.
      await drawn.click()
      await viewer.getByRole('button', { name: '在文件中打开', exact: true }).click()
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
      // Pressed, it is shown large, with its way to the file pane and its download.
      await page.locator('.message-assistant .message-attachment-media button.inline-media-open').click()
      const viewer = page.locator('dialog.picture-viewer')
      await viewerShows(page, viewer, 768, await picture.evaluate((img: HTMLImageElement) => img.naturalHeight))
      expect(await page.getByRole('region', { name: '文件预览', exact: true }).count()).toBe(0)
      await viewer.getByRole('button', { name: '下载', exact: true }).waitFor()
      await viewerShots(page, 'viewer-agent')
      await viewer.getByRole('button', { name: '在文件中打开', exact: true }).click()
      await page.getByRole('region', { name: '文件预览', exact: true }).waitFor()
    } finally {
      await context.close()
    }
  })
})

describe('a picture Codex makes', () => {
  let root: string, host: TestHost, browser: Browser
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'latch-image-canvas-'))
    const bin = join(root, 'bin'),
      command = join(bin, 'codex')
    await mkdir(bin)
    await writeFile(command, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_CODEX_APP_SERVER}' "$@"\n`)
    await chmod(command, 0o755)
    host = await startTestHost({
      demo: false,
      commandDirectories: () => [bin],
      loginPrograms: name => (name === 'codex' ? command : undefined),
      detectPreset: preset => (preset.id === 'codex' ? { found: true, path: command } : { found: false }),
    })
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUT, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
    await rm(root, { recursive: true, force: true })
  })

  it('is made on a canvas in its place, which the picture replaces; one that fails is one line', async () => {
    // The fake holds the image item in progress until this file exists, so the canvas is seen for as long as the test needs.
    const gate = join(root, 'release')
    const owner = await host.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
      body: {
        id: 'codex',
        presetId: 'codex',
        name: 'Codex',
        command: 'codex',
        args: [],
        env: { FAKE_CODEX_STATE: join(root, 'threads.json'), FAKE_CODEX_IMAGE_DIR: join(root, 'images'), FAKE_CODEX_IMAGE_GATE: gate },
      },
    })
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    try {
      // Enrolled first: a new device waits while a full-access session runs.
      await enrollBrowser(page, host, { name: '生成图片', scopes: ['admin'] })
      const created = await owner.confirmed('tasks', {
        method: 'POST',
        body: { prompt: 'image result 1536x1024', requestId: randomUUID(), mode: 'agent', harnessId: 'codex', workspaceId: 'default' },
      })
      expect(created.status).toBe(201)
      const { sessionId } = (await created.json()) as { sessionId: string }
      const detail = () => owner.json<TaskDetail>(`tasks/${sessionId}`)
      await expect
        .poll(async () => (await detail()).messages.some(message => message.tool?.imageGeneration && message.state === 'running'), SLOW)
        .toBe(true)
      await settleShell(page)
      await openSession(page, sessionId)
      const place = page.locator('.generated-image')
      const canvas = place.locator('.generated-image-canvas')
      await canvas.waitFor()
      // A square canvas on the picture's own surface, the page's particles in it, and no tool row besides it.
      expect(await place.getAttribute('data-state')).toBe('making')
      const square = (await canvas.boundingBox())!
      expect(Math.abs(square.width - square.height)).toBeLessThan(1)
      expect(square.width).toBeLessThanOrEqual(480)
      expect(await canvas.locator('canvas.ui-backdrop[data-kind="field"]').count()).toBe(1)
      await canvas.getByText('生成图片', { exact: true }).waitFor()
      expect(await page.locator('.tool-card', { hasText: '生成图片' }).count()).toBe(0)
      // The particles move while the picture is made, and hold a still frame under reduced motion and out of view.
      const particles = canvas.locator('canvas.ui-backdrop')
      const moving = async () => {
        const before = await particles.evaluate((node: HTMLCanvasElement) => node.toDataURL())
        await page.waitForTimeout(500)
        return before !== (await particles.evaluate((node: HTMLCanvasElement) => node.toDataURL()))
      }
      expect(await page.evaluate(() => document.hasFocus())).toBe(true)
      expect(await moving()).toBe(true)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.waitForTimeout(200)
      expect(await moving()).toBe(false)
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      expect(await moving()).toBe(true)
      await canvas.evaluate((node: HTMLElement) => (node.style.transform = 'translateY(-10000px)'))
      await page.waitForTimeout(200)
      expect(await moving()).toBe(false)
      await canvas.evaluate((node: HTMLElement) => (node.style.transform = ''))
      expect(await moving()).toBe(true)
      // A still frame of the particles for the captures.
      await page.evaluate(() => (document.documentElement.dataset.capture = 'still'))
      await shots(page, 'image-making', { canvas }, [390, 1440])
      await page.setViewportSize({ width: 1440, height: 960 })
      await page.evaluate(() => delete document.documentElement.dataset.capture)

      // The picture comes: it takes the canvas's place, at its own shape, and is the only picture of the turn.
      // Where the place stands in its turn, which the picture keeps.
      const offset = () =>
        place.evaluate(element => element.getBoundingClientRect().top - element.closest('.turn')!.getBoundingClientRect().top)
      const top = await offset()
      await writeFile(gate, '')
      const picture = place.locator('img.inline-media-image')
      await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth === 1536), SLOW).toBe(true)
      await canvas.waitFor({ state: 'detached' })
      expect(await place.getAttribute('data-state')).toBe('drawn')
      expect(await picture.getAttribute('src')).toMatch(/^\/link\/api\/attachments\/[A-Za-z0-9_-]{22}\/content$/u)
      const drawn = (await picture.boundingBox())!
      expect(Math.abs(drawn.width / drawn.height - 1.5)).toBeLessThan(0.02)
      expect(Math.abs((await offset()) - top)).toBeLessThan(2)
      expect(await page.locator('.turn img.inline-media-image').count()).toBe(1)
      expect(await page.locator('.tool-card', { hasText: '生成图片' }).count()).toBe(0)
      await expect.poll(async () => (await detail()).summary.status, SLOW).toBe('idle')
      // The reply's 「下载 PNG 原图」 names the same file: it is not shown a second time, as a picture or as a chip.
      await expect
        .poll(
          async () => [
            await page.locator('.turn img.inline-media-image').count(),
            await page.locator('.file-chip', { hasText: '下载 PNG 原图' }).count(),
          ],
          SLOW,
        )
        .toEqual([1, 0])
      await shots(page, 'image-drawn', { picture }, [390, 1440])
      // Pressed, the made picture is shown large over the page, not in the file pane.
      await place.locator('button.inline-media-open').click()
      const viewer = page.locator('dialog.picture-viewer')
      await viewerShows(page, viewer, 1536, 1024)
      expect(await page.getByRole('region', { name: '文件预览', exact: true }).count()).toBe(0)
      await viewerShots(page, 'viewer-generated')
      await page.keyboard.press('Escape')
      await viewer.waitFor({ state: 'detached' })

      // Read again, the picture is simply where the canvas was.
      await page.reload()
      await settleShell(page)
      await openSession(page, sessionId)
      await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth === 1536), SLOW).toBe(true)
      expect(await page.locator('.generated-image-canvas').count()).toBe(0)

      // A generation that fails is one short line in its place, with no empty canvas.
      const sent = await owner.request(`tasks/${sessionId}/prompt`, {
        method: 'POST',
        body: { requestId: randomUUID(), prompt: 'image failed' },
      })
      expect(sent.status).toBe(200)
      const failed = page.locator('.generated-image-line.is-failed')
      await failed.getByText('图片生成失败：已达用量上限', { exact: true }).waitFor()
      await expect.poll(async () => (await detail()).summary.status, SLOW).toBe('idle')
      expect(await page.locator('.generated-image-canvas').count()).toBe(0)
      await shots(page, 'image-failed', { failed }, [390, 1440])
    } finally {
      await context.close()
    }
  })
})
