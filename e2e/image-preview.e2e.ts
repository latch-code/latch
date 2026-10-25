import { chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { HarnessPlugin } from '@latch/sdk'
import { startTestHost } from './helpers/host.ts'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'

it('uses true image pixels, retains zoom on refresh, refuses unknown or excessive dimensions and finds across syntax spans', async () => {
  const browser = await chromium.launch(browserLaunchOptions())
  const maker = await browser.newPage()
  const png = async (width: number, height: number) =>
    Buffer.from(
      await maker.evaluate(
        async ([width, height]) => {
          const canvas = document.createElement('canvas')
          canvas.width = width
          canvas.height = height
          const ctx = canvas.getContext('2d')!
          ctx.fillStyle = 'gray'
          ctx.fillRect(50, 50, width - 100, height - 100)
          ctx.clearRect(100, 100, width / 2, height / 2)
          const blob = await new Promise<Blob>(done => canvas.toBlob(value => done(value!), 'image/png'))
          return [...new Uint8Array(await blob.arrayBuffer())]
        },
        [width, height] as const,
      ),
    )
  const initial = await png(1600, 1000),
    updated = await png(800, 500)
  await maker.close()
  const plugin: HarnessPlugin = {
    id: 'image-fixture',
    name: 'Fixture',
    version: '1',
    description: '',
    activate(ctx) {
      ctx.registerProvider({
        id: 'images',
        name: 'Fixture',
        model: 'fixture',
        async *stream() {
          yield {
            type: 'text',
            text: '[large.png](large.png) [unknown.jpg](unknown.jpg) [oversize.png](oversize.png) [picture.svg](picture.svg) [code.ts](code.ts)',
          }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  const host = await startTestHost({ demo: false, plugins: [plugin] })
  try {
    await writeFile(join(host.workspaceRoot, 'large.png'), initial)
    const huge = Buffer.alloc(24)
    huge.set([137, 80, 78, 71, 13, 10, 26, 10])
    huge.writeUInt32BE(20000, 16)
    huge.writeUInt32BE(20000, 20)
    await writeFile(join(host.workspaceRoot, 'oversize.png'), huge)
    await writeFile(join(host.workspaceRoot, 'unknown.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 4, 0, 0]))
    await writeFile(
      join(host.workspaceRoot, 'picture.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><script>parent.PREVIEW_SCRIPT_RAN=true</script><rect width="200" height="100" fill="gray"/></svg>',
    )
    await writeFile(join(host.workspaceRoot, 'code.ts'), 'const answer = 42\nconst next = answer + 1\n')
    const { sessionId } = await host.host.bridge.createTask({
      prompt: 'Image preview fixture',
      requestId: randomUUID(),
      mode: 'chat',
      model: { providerId: 'images', model: 'fixture' },
    })
    await expect.poll(async () => (await host.host.bridge.detail(sessionId)).summary.status).toBe('idle')
    for (const [width, theme] of [
      [390, 'light'],
      [900, 'dark'],
      [1440, 'light'],
    ] as const) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, hasTouch: true })
      const page = await context.newPage()
      page.setDefaultTimeout(15_000)
      try {
        await enrollBrowser(page, host, { name: `Image ${width}`, scopes: ['admin'] })
        if (width === 900) await page.getByRole('button', { name: '打开会话列表', exact: true }).click()
        await page.locator(`[data-task-id="${sessionId}"]`).first().click()
        const open = (name: string) => page.getByRole('button', { name: `预览文件：${name}`, exact: true }).click()
        await open('large.png')
        const preview = page.getByRole('region', { name: '文件预览', exact: true }),
          image = preview.getByRole('img', { name: 'large.png', exact: true })
        const viewport = preview.getByRole('region', { name: '图片预览，支持缩放和平移', exact: true })
        await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1600)
        expect(await image.evaluate(img => img.getBoundingClientRect().width)).toBeLessThan(1600)
        await preview.getByRole('button', { name: '适应', exact: true }).click()
        await expect.poll(() => image.evaluate(img => img.getBoundingClientRect().width)).toBe(1600)
        await viewport.press('+')
        await expect.poll(() => image.evaluate(img => img.getBoundingClientRect().width)).toBe(2000)
        await viewport.press('0')
        await preview.getByRole('button', { name: '切换图片棋盘底色', exact: true }).click()
        expect(await viewport.getAttribute('data-checker')).toBe('dark')
        if (width === 1440) {
          const rect = (await viewport.boundingBox())!
          await page.mouse.move(rect.x + 180, rect.y + 100)
          await page.mouse.down()
          await page.mouse.move(rect.x + 40, rect.y + 100)
          await page.mouse.up()
          expect(await viewport.evaluate(node => node.scrollLeft)).toBeGreaterThan(0)
          const cdp = await context.newCDPSession(page)
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [
              { x: rect.x + 60, y: rect.y + 100, id: 1 },
              { x: rect.x + 160, y: rect.y + 100, id: 2 },
            ],
          })
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [
              { x: rect.x + 30, y: rect.y + 100, id: 1 },
              { x: rect.x + 190, y: rect.y + 100, id: 2 },
            ],
          })
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
          await expect.poll(() => image.evaluate(img => img.getBoundingClientRect().width)).toBeGreaterThan(1600)
          await cdp.detach()
          await viewport.press('0')
          await writeFile(join(host.workspaceRoot, 'large.png'), updated)
          const notice = preview.locator('.ui-notice', { hasText: '文件已更新。' })
          await notice.getByRole('button', { name: '更新预览', exact: true }).click()
          await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(800)
          await expect.poll(() => image.evaluate(img => img.getBoundingClientRect().width)).toBe(800)
        }
        await mkdir('test-results/images', { recursive: true })
        await page.screenshot({ path: `test-results/images/pixels-${width}-${theme}.png`, animations: 'disabled' })
        const close = () => preview.getByRole('button', { name: '关闭文件', exact: true }).click()
        await close()
        await open('unknown.jpg')
        await preview.getByText('无法确认图片尺寸，已停止解码。可以下载文件后查看。', { exact: true }).waitFor()
        expect(await preview.locator('img').count()).toBe(0)
        await close()
        await open('oversize.png')
        await preview.getByText('文件或图片超过这台设备的预览上限，请在执行端电脑上查看。', { exact: true }).waitFor()
        expect(await preview.locator('img').count()).toBe(0)
        await close()
        await open('picture.svg')
        await expect.poll(() => preview.getByRole('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(200)
        expect(await page.evaluate(() => Reflect.get(globalThis, 'PREVIEW_SCRIPT_RAN'))).toBeUndefined()
        await preview.getByRole('button', { name: '源码', exact: true }).click()
        await preview.getByRole('searchbox', { name: '查找文件内容' }).waitFor()
        await close()
        await open('code.ts')
        await preview.getByRole('searchbox', { name: '查找文件内容' }).fill('answer =')
        await expect.poll(() => page.evaluate(() => CSS.highlights.get('latch-file-find')?.size)).toBe(1)
        expect(await preview.locator('mark').count()).toBe(0)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      } finally {
        await context.close()
      }
    }
  } finally {
    await host.close()
    await browser.close()
  }
})
