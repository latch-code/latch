import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser } from '@playwright/test'
import type { TaskDetail } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { documentFixtures } from '@latch/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSession } from './helpers/layout.ts'
import { promptValue } from './helpers/prompt.ts'

describe('workbench loading recovery', () => {
  let host: TestHost
  let browser: Browser
  let assets: { entry: string; dependency: string }
  let retiredAsset: { status: number; contentType: string; body: string }

  beforeAll(async () => {
    const plugin: HarnessPlugin = {
      id: 'page-recovery',
      name: 'Page recovery fixture',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerProvider({
          id: 'page-recovery',
          name: 'Page recovery fixture',
          model: 'fixture',
          async *stream() {
            yield { type: 'text', text: '[report.pdf](report.pdf)' }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    host = await startTestHost({ demo: false, providerId: plugin.id, plugins: [plugin] })
    const document = await host.raw('loopback-tcp', '')
    expect(document.status).toBe(200)
    const html = await document.text()
    const entry = html.match(/<script\b[^>]*\btype="module"[^>]*\bsrc="(\/link\/assets\/[^"]+\.js)"/u)?.[1]
    const dependency = html.match(/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="(\/link\/assets\/[^"]+\.js)"/u)?.[1]
    if (!entry || !dependency) throw new Error('No production module entry or static dependency')
    assets = { entry, dependency }
    // Serve the Host's actual missing-asset response without making a second HTTP request inside the intercepted navigation.
    const missing = await host.raw('loopback-tcp', 'assets/retired-page-recovery.js')
    expect(missing.status).toBe(404)
    retiredAsset = { status: missing.status, contentType: missing.headers.get('content-type') ?? 'text/plain', body: await missing.text() }
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir('test-results/page-recovery', { recursive: true })
  })

  afterAll(async () => {
    await browser?.close()
    await host?.close()
  })

  it.each([
    { width: 390, colorScheme: 'light', locale: 'zh-CN', button: '重新加载', asset: 'entry' },
    { width: 768, colorScheme: 'dark', locale: 'en-US', button: 'Reload', asset: 'dependency' },
    { width: 1440, colorScheme: 'dark', locale: 'zh-CN', button: '重新加载', asset: 'entry' },
  ] as const)('recovers a retired $asset asset at $width $colorScheme', async ({ width, colorScheme, locale, button, asset }) => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme, locale })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    let enrollments = 0
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/link/api/enrollments') enrollments++
    })
    try {
      const invitation = await host.invite(['view', 'run'], 'loopback-tcp')
      const failedModule = (url: URL) => url.pathname === assets[asset]
      await page.route(failedModule, route => route.fulfill(retiredAsset))
      const stylesheet = /\/link\/assets\/index-[^/]+\.css$/u
      if (width === 1440) {
        await page.route(stylesheet, route => route.abort('failed'), { times: 1 })
      }
      const [missing] = await Promise.all([
        page.waitForResponse(response => failedModule(new URL(response.url()))),
        width === 1440 ? page.waitForEvent('requestfailed', request => stylesheet.test(new URL(request.url()).pathname)) : undefined,
        page.goto(invitation.url, { waitUntil: 'commit' }).catch((error: Error) => {
          throw new Error(error.message.replaceAll(new URL(invitation.url).hash, '#pair=<redacted>'))
        }),
      ])
      expect(missing.status()).toBe(404)
      const recovery = page.getByRole('main').filter({ has: page.getByRole('heading', { name: 'Latch', exact: true }) })
      const reload = recovery.getByRole('button', { name: button, exact: true })
      await recovery.getByText(locale === 'zh-CN' ? 'Latch 无法打开此页面。' : 'Latch could not open this page.', { exact: true }).waitFor()
      await reload.waitFor()
      await noHorizontalOverflow(page)
      await page.screenshot({ path: `test-results/page-recovery/${width}-${colorScheme}.png`, animations: 'disabled' })
      expect(enrollments).toBe(0)
      await page.unrouteAll({ behavior: 'wait' })
      await Promise.all([page.waitForEvent('framenavigated', frame => frame === page.mainFrame()), reload.click()])
      await page.getByTestId('enroll-submit').click()
      await connected(page)
      expect(enrollments).toBe(1)
      expect(new URL(page.url()).hash === '').toBe(true)
      expect(await recovery.count()).toBe(0)
    } finally {
      await page.unrouteAll({ behavior: 'wait' })
      await context.close()
    }
  })

  it('offers a reload when an effect above the workbench fails', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    try {
      await enrollBrowser(page, host)
      const draftText = '保留根界面恢复前的草稿'
      const draft = page.getByRole('textbox', { name: '新会话消息', exact: true })
      await draft.fill(draftText)
      await page.addInitScript(() => {
        if (sessionStorage.getItem('fixture-root-failed')) return
        const media = window.matchMedia.bind(window)
        window.matchMedia = query => {
          const result = media(query)
          if (query === '(prefers-color-scheme: dark)') {
            result.addEventListener = () => {
              sessionStorage.setItem('fixture-root-failed', 'yes')
              throw new Error('fixture-root-failure-detail')
            }
          }
          return result
        }
      })
      await page.reload({ waitUntil: 'commit' })
      const recovery = page.locator('#latch-recovery')
      await recovery.getByText('Latch 无法打开此页面。', { exact: true }).waitFor()
      const reload = recovery.getByRole('button', { name: '重新加载', exact: true })
      await reload.waitFor()
      expect(await page.evaluate(() => sessionStorage.getItem('fixture-root-failed'))).toBe('yes')
      expect(await page.getByText('fixture-root-failure-detail').count()).toBe(0)
      await Promise.all([page.waitForEvent('framenavigated', frame => frame === page.mainFrame()), reload.click()])
      await connected(page)
      await recovery.waitFor({ state: 'hidden' })
      await expect.poll(() => promptValue(draft), { timeout: 15_000 }).toBe(draftText)
    } finally {
      await context.close()
    }
  })

  it('keeps the workbench and draft mounted through a PDF module failure', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    try {
      const owner = await host.enroll({ listener: 'unix' })
      await writeFile(join(host.workspaceRoot, 'report.pdf'), Uint8Array.from(documentFixtures(() => []).pdf()))
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { prompt: '读取报告', requestId: randomUUID(), mode: 'chat' },
      })
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, { timeout: 15_000 }).toBe('idle')
      await enrollBrowser(page, host, { name: 'PDF 模块恢复', scopes: ['view', 'run'] })
      await openSession(page, sessionId)
      const draftText = '预览失败后继续编辑'
      const draft = page.getByRole('textbox', { name: '继续对话', exact: true })
      await draft.fill(draftText)
      const originalDraft = await draft.elementHandle()
      let requests = 0
      await page.route('**/assets/PdfPreview-*.js', route => (++requests === 1 ? route.abort('failed') : route.continue()))
      await page.locator('.transcript').getByRole('button', { name: '预览文件：report.pdf', exact: true }).click()
      const preview = page.getByRole('region', { name: '文件预览', exact: true })
      const retry = preview.getByRole('button', { name: '重试加载', exact: true })
      await retry.waitFor()
      expect(requests).toBe(1)
      await connected(page)
      expect(await promptValue(draft)).toBe(draftText)
      expect(await originalDraft.evaluate(element => element.isConnected)).toBe(true)
      await retry.click()
      await preview.locator('.pdf-text-layer').getByText('Hello PDF', { exact: true }).waitFor()
      expect(requests).toBeGreaterThan(1)
      expect(await promptValue(draft)).toBe(draftText)
      expect(await originalDraft.evaluate(element => element.isConnected)).toBe(true)
    } finally {
      await page.unrouteAll({ behavior: 'wait' })
      await context.close()
    }
  })
})
