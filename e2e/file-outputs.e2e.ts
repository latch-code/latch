import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { HarnessPlugin } from '@latch/sdk'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=', 'base64')
describe('files observed during real Harness runs', () => {
  let host: TestHost, browser: Browser, sessionId: string
  beforeAll(async () => {
    const plugin: HarnessPlugin = {
      id: 'output-fixture',
      name: '产物测试',
      version: '1.0.0',
      description: '本地假模型',
      activate(context) {
        context.registerProvider({
          id: 'writer',
          name: 'Fixture writer',
          model: 'fixture',
          async *stream() {
            await writeFile(join(host.workspaceRoot, 'report.txt'), 'Observed result\nsecond line')
            await writeFile(join(host.workspaceRoot, 'pixel.png'), image)
            await writeFile(join(host.workspaceRoot, 'sensitive.png'), image)
            await writeFile(join(host.workspaceRoot, 'unknown.png'), image.subarray(0, 8))
            await rm(join(host.workspaceRoot, 'gone.txt'))
            await writeFile(join(host.workspaceRoot, 'unrelated.tmp'), 'ignored')
            yield { type: 'text', text: '工作已完成。' }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    host = await startTestHost({ demo: false, plugins: [plugin] })
    await writeFile(join(host.workspaceRoot, 'gone.txt'), 'previous')
    ;({ sessionId } = await host.host.bridge.createTask({
      prompt: '完成工作',
      requestId: randomUUID(),
      mode: 'agent',
      model: { providerId: 'writer', model: 'fixture' },
    }))
    await vi.waitFor(
      async () => {
        const detail = await host.host.bridge.detail(sessionId)
        expect(detail.summary.status).toBe('idle')
        expect(detail.messages).toContainEqual(
          expect.objectContaining({ outputs: expect.arrayContaining([expect.objectContaining({ path: 'report.txt' })]) }),
        )
        expect(detail.messages.some(message => message.outputsPending)).toBe(false)
      },
      { timeout: 10_000 },
    )
    await writeFile(join(host.workspaceRoot, 'sensitive.png'), Buffer.from(['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ')))
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir('test-results/file-outputs', { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
  })
  for (const [width, height, theme] of [
    [390, 844, 'light'],
    [900, 1000, 'dark'],
    [1440, 1000, 'light'],
  ] as const) {
    it(`opens an observed file at ${width}/${theme} and keeps removed files informational`, async () => {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, locale: 'zh-CN' })
      context.setDefaultTimeout(15_000)
      const page = await context.newPage()
      const contentRequests: string[] = [],
        resolved = new Set<string>()
      page.on('request', request => {
        if (new URL(request.url()).pathname.startsWith('/link/api/files/')) contentRequests.push(request.url())
      })
      page.on('response', response => {
        if (!new URL(response.url()).pathname.endsWith('/files/resolve')) return
        void response
          .json()
          .then((data: { files?: Array<{ file?: { path?: string } }> }) => {
            for (const answer of data.files ?? []) if (answer.file?.path) resolved.add(answer.file.path)
          })
          .catch(() => {})
      })
      try {
        await enrollBrowser(page, host, { name: `产物 ${width}`, scopes: ['admin'] })
        if (width === 900) await page.getByRole('button', { name: '打开会话列表', exact: true }).click()
        await page.locator(`[data-task-id="${sessionId}"]`).first().click()
        const outputs = page.getByRole('region', { name: '这一轮生成的文件', exact: true })
        const changed = page.getByRole('region', { name: '这一轮改动的文件', exact: true })
        await changed.getByRole('button', { name: '显示文件', exact: true }).click()
        // A removed file is listed for the record, with nothing to open.
        const removed = changed.locator('.summary-file', { hasText: 'gone.txt' })
        await removed.getByText('已删除', { exact: true }).waitFor()
        expect(await removed.evaluate(element => element.tagName)).toBe('DIV')
        expect(await changed.getByText('unrelated.tmp').count()).toBe(0)
        await outputs.getByRole('button', { name: '预览产物图片：pixel.png', exact: true }).waitFor()
        await expect
          .poll(() =>
            outputs
              .getByRole('button', { name: '预览产物图片：pixel.png', exact: true })
              .locator('img')
              .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
          )
          .toBe(true)
        expect(await outputs.getByRole('button', { name: '预览产物图片：sensitive.png', exact: true }).count()).toBe(0)
        expect(await outputs.getByRole('button', { name: '预览产物图片：unknown.png', exact: true }).count()).toBe(0)
        await expect.poll(() => resolved.has('sensitive.png') && resolved.has('unknown.png')).toBe(true)
        expect(contentRequests).toHaveLength(1)
        expect(await outputs.locator('.file-output-size').count()).toBe(3)
        await page.screenshot({ path: `test-results/file-outputs/${width}-${theme}-list.png`, animations: 'disabled' })
        if (width === 1440) {
          await outputs.getByRole('button', { name: '预览产物图片：pixel.png', exact: true }).click()
          await page.getByRole('region', { name: '文件预览', exact: true }).getByRole('img', { name: 'pixel.png', exact: true }).waitFor()
        }
        await changed.locator('button.summary-file', { hasText: 'report.txt' }).click()
        const preview = page.getByRole('region', { name: '文件预览', exact: true })
        await preview.getByText('Observed result', { exact: true }).waitFor()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
        await page.screenshot({ path: `test-results/file-outputs/${width}-${theme}-preview.png`, animations: 'disabled' })
      } finally {
        await context.close()
      }
    })
  }
  it('lets a work-scoped device open recorded outputs without granting project search', async () => {
    const desktop = await host.enroll({ listener: 'unix' }),
      work = await host.enroll()
    expect((await desktop.request(`devices/${work.id}`, { method: 'PATCH', body: { dataScope: 'work' } })).status).toBe(200)
    const resolve = await work.request(`tasks/${sessionId}/files/resolve`, {
      method: 'POST',
      body: { paths: ['report.txt'], rootId: 'default' },
    })
    expect(resolve.status).toBe(200)
    const result = await resolve.json()
    expect(result).toMatchObject({ files: [{ status: 'ok' }] })
    expect((await work.request(`tasks/${sessionId}/files/search`, { method: 'POST', body: { q: 'report' } })).status).toBe(403)
  })
})
