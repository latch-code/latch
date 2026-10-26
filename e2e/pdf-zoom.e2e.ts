import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { performanceDocumentFixtures } from '@latch/testkit'
import { strToU8, zipSync } from 'fflate'
import type { HarnessPlugin } from '@latch/sdk'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { noHorizontalOverflow, reachable } from './helpers/layout.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const fixtures = performanceDocumentFixtures(files =>
  zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)]))),
)
describe('PDF canvas zoom and reading anchors', () => {
  let host: TestHost, browser: Browser
  const bytes = fixtures.pdf()
  let calls = 0
  beforeAll(async () => {
    const plugin: HarnessPlugin = {
      id: 'pdf-zoom-model',
      name: 'PDF fixture',
      description: '',
      version: '1',
      activate(context) {
        context.registerProvider({
          id: 'pdf-zoom-model',
          name: 'PDF fixture',
          model: 'fixture',
          async *stream() {
            calls++
            yield { type: 'text', text: '[report.pdf](report.pdf)' }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    host = await startTestHost({ plugins: [plugin] })
    await writeFile(join(host.workspaceRoot, 'report.pdf'), bytes)
    const { sessionId } = await host.host.bridge.createTask({
      requestId: randomUUID(),
      prompt: '预览 PDF 缩放',
      mode: 'chat',
      model: { providerId: 'pdf-zoom-model', model: 'fixture' },
    })
    await vi.waitFor(async () => expect((await host.host.bridge.detail(sessionId)).summary.status).toBe('idle'))
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir('test-results/pdf-zoom', { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
  })
  it.each([
    [390, 'light'],
    [900, 'dark'],
    [1440, 'light'],
  ] as const)('%s %s rerenders bounded pixels, handles zoom gestures and keeps the page on a real file refresh', async (width, theme) => {
    await writeFile(join(host.workspaceRoot, 'report.pdf'), bytes)
    const context = await browser.newContext({
      viewport: { width, height: 960 },
      colorScheme: theme,
      hasTouch: width === 390,
      isMobile: width === 390,
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    try {
      await enrollBrowser(page, host, { name: 'PDF zoom ' + width, scopes: ['view', 'run'] })
      await connected(page)
      await page.keyboard.press('Meta+k')
      const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
      await palette.getByRole('searchbox').fill('预览 PDF 缩放')
      await palette.getByRole('option', { name: '预览 PDF 缩放', exact: true }).click()
      await page.locator('.transcript').getByRole('button', { name: '预览文件：report.pdf', exact: true }).click()
      const preview = page.getByRole('region', { name: '文件预览', exact: true })
      const scroll = preview.getByLabel('PDF 页面', { exact: true }),
        canvas = preview.locator('.pdf-page canvas').first()
      await preview.getByText('Performance PDF page 001', { exact: true }).waitFor()
      const size = () =>
        canvas.evaluate(canvas => ({
          width: canvas.getBoundingClientRect().width,
          pixels: (canvas as HTMLCanvasElement).width * (canvas as HTMLCanvasElement).height,
        }))
      const before = await size()
      await scroll.focus()
      await scroll.press('Meta+=')
      await expect.poll(async () => (await size()).width).toBeGreaterThan(before.width)
      expect((await size()).pixels).toBeLessThanOrEqual(16_000_000)
      expect(await preview.getByRole('button', { name: '适应', exact: true }).getAttribute('aria-pressed')).toBe('false')
      await scroll.press('Control+0')
      await expect.poll(async () => (await size()).width).toBeCloseTo(before.width, 0)
      await expect.poll(() => preview.getByRole('button', { name: '适应', exact: true }).getAttribute('aria-pressed')).toBe('true')
      if (width === 390) {
        const cdp = await context.newCDPSession(page)
        try {
          const box = (await scroll.boundingBox())!,
            x = box.x + box.width / 2,
            y = box.y + Math.min(180, box.height / 2)
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [
              { x: x - 40, y },
              { x: x + 40, y },
            ],
          })
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [
              { x: x - 70, y },
              { x: x + 70, y },
            ],
          })
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
          await expect.poll(async () => (await size()).width).toBeGreaterThan(before.width)
          expect(await page.evaluate(() => visualViewport?.scale)).toBe(1)
        } finally {
          await cdp.detach()
        }
      } else {
        await scroll.focus()
        await scroll.press('Meta+=')
      }
      await preview.getByText('Performance PDF page 001', { exact: true }).waitFor()
      for (let number = 2; number <= 4; number++) {
        const next = preview.getByRole('button', { name: '下一页', exact: true })
        await reachable(next)
        await next.click()
        await preview.getByText(`${number} / 200 页`, { exact: true }).waitFor()
      }
      await preview.getByText('Performance PDF page 004', { exact: true }).waitFor()
      const percent = await preview.getByRole('status', { name: 'PDF 缩放比例', exact: true }).textContent()
      expect(percent).toMatch(/^\d+%$/u)
      await writeFile(
        join(host.workspaceRoot, 'report.pdf'),
        Buffer.from(bytes).toString('latin1').replace('Performance PDF page 001', 'Performance PDF page NEW'),
        'latin1',
      )
      await preview.getByRole('status').filter({ hasText: '已更新' }).first().waitFor()
      await preview.getByText('Performance PDF page 004', { exact: true }).waitFor()
      expect(await preview.getByRole('status', { name: 'PDF 缩放比例', exact: true }).textContent()).toBe(percent)
      await preview.getByText('4 / 200 页', { exact: true }).waitFor()
      expect(
        await preview
          .locator('.pdf-page canvas')
          .evaluateAll(nodes =>
            nodes.every(canvas => (canvas as HTMLCanvasElement).width * (canvas as HTMLCanvasElement).height <= 16_000_000),
          ),
      ).toBe(true)
      expect(await preview.locator('.pdf-page canvas').count()).toBeLessThan(8)
      expect(calls).toBe(1)
      await noHorizontalOverflow(page)
      await page.screenshot({ path: `test-results/pdf-zoom/retained-${width}-${theme}.png`, animations: 'disabled' })
    } catch (error) {
      await page.screenshot({ path: `test-results/pdf-zoom/failure-${width}-${theme}.png`, animations: 'disabled' })
      await writeFile(`test-results/pdf-zoom/failure-${width}-${theme}.json`, JSON.stringify(await previewState(page), null, 2))
      throw error
    } finally {
      await context.close()
    }
  })
})

async function previewState(page: import('@playwright/test').Page) {
  return page.locator('.document-preview').evaluateAll(nodes =>
    nodes.map(node => ({
      text: node.textContent,
      pages: Array.from(node.querySelectorAll<HTMLElement>('.pdf-page-slot')).map(page => ({
        index: page.dataset.index,
        rect: page.getBoundingClientRect().toJSON(),
      })),
      scroll: Array.from(node.querySelectorAll('.pdf-scroll')).map(node => ({
        top: node.scrollTop,
        height: node.clientHeight,
        rect: node.getBoundingClientRect().toJSON(),
      })),
    })),
  )
}
