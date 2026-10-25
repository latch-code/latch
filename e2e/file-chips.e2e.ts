import { chromium, type Browser, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HarnessPlugin } from '@latch/sdk'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

/** A reply that mentions the files it wrote, the way agents do: relative links, a file:// link, an image, a web link. */
const REPLY = [
  '已完成，生成了这些文件：',
  '',
  '- [report.md](report.md)：复盘文档',
  '- [site/index.html](./site/index.html)：落地页',
  '- ![趋势图](chart.svg)',
  '- [deck.pptx](file:///Users/me/acme/deck.pptx)：演示文稿（1 页）',
  '- [上一版](../archive/old.md)',
  '- [/Users/me/projects/acme-q3-review/out/deck-final.pptx](/Users/me/projects/acme-q3-review/out/deck-final.pptx)',
  '- 参考：[Latch 文档](https://example.com/docs)',
].join('\n')
const LONG_NAME = 'deck-final.pptx'
const ELSEWHERE = '在运行 Latch 的 Mac 上用桌面端可以快速查看和打开。'

describe('file references in a reply', () => {
  let testHost: TestHost
  let browser: Browser
  let sessionId: string

  beforeAll(async () => {
    const plugin: HarnessPlugin = {
      id: 'file-chips-fixture',
      name: '文件引用测试模型',
      version: '1.0.0',
      description: '仅用于浏览器验收的本地模型。',
      activate(context) {
        context.registerProvider({
          id: 'file-chips',
          name: 'File chips fixture',
          model: 'fixture',
          async *stream() {
            yield { type: 'text', text: REPLY }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    testHost = await startTestHost({ uiDir: resolve(process.env.HARNESS_E2E_UI_DIR ?? 'dist/web'), demo: false, plugins: [plugin] })
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir('test-results/file-chips', { recursive: true })
    ;({ sessionId } = await testHost.host.bridge.createTask({
      prompt: '生成复盘文件',
      requestId: randomUUID(),
      mode: 'chat',
      model: { providerId: 'file-chips', model: 'fixture' },
    }))
    const deadline = Date.now() + 15_000
    while ((await testHost.host.bridge.detail(sessionId)).summary.status !== 'idle') {
      if (Date.now() > deadline) throw new Error('The fixture reply did not settle')
      await new Promise(done => setTimeout(done, 50))
    }
  })

  afterAll(async () => {
    await browser?.close()
    await testHost?.close()
  })

  async function openSession(colorScheme: 'light' | 'dark', width = 1280, height = 820): Promise<Page> {
    const touch = width < 768
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      colorScheme,
      isMobile: touch,
      hasTouch: touch,
    })
    context.setDefaultTimeout(15_000)
    const page = await context.newPage()
    await enrollBrowser(page, testHost, { name: `文件引用 ${colorScheme} ${width}` })
    // Tablets use a navigation drawer; phones start on the session list.
    if (width >= 768 && width < 1024) {
      await page.getByRole('button', { name: '打开会话列表', exact: true }).filter({ visible: true }).first().click()
      await page.getByRole('dialog', { name: '会话导航', exact: true }).waitFor()
    }
    await page.locator(`[data-task-id="${sessionId}"]`).click()
    await page.locator('.drawer-backdrop').waitFor({ state: 'detached' })
    await page.locator('[data-file-chip]').first().waitFor()
    await connected(page)
    return page
  }

  it('never navigates: every file is a chip without an href, whose menu copies its path and says where to open it', async () => {
    const page = await openSession('light')
    try {
      const reply = page.locator('.message-content').filter({ hasText: '复盘文档' })
      // Only the web address is a link, and it opens elsewhere.
      expect(await reply.locator('a[href]').evaluateAll(links => links.map(link => link.getAttribute('href')))).toEqual([
        'https://example.com/docs',
      ])
      expect(await reply.locator('a[href]').getAttribute('target')).toBe('_blank')
      const chips = reply.locator('[data-file-chip]')
      expect(await chips.allTextContents()).toEqual([
        'report.md',
        'site/index.html',
        '图片趋势图chart.svg',
        'deck.pptx',
        '上一版',
        `/Users/me/projects/acme-q3-review/out/${LONG_NAME}`,
      ])
      expect(await reply.locator('[aria-haspopup="menu"]').count()).toBe(6)
      await page.screenshot({ path: 'test-results/file-chips/reply.png', animations: 'disabled' })

      await page.evaluate(() => {
        const state = window as Window & { copied?: string[] }
        state.copied = []
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async (value: string) => {
              state.copied!.push(value)
            },
          },
        })
      })
      const report = chips.filter({ hasText: 'report.md' })
      await report.hover()
      await page.getByRole('tooltip').filter({ hasText: 'report.md' }).waitFor()
      await page.screenshot({ path: 'test-results/file-chips/hover.png', animations: 'disabled' })
      const before = page.url()
      // A click opens the file's menu: its name, 复制路径, and where the file can be opened, never a silent copy.
      await report.click()
      const menu = page.getByRole('menu', { name: '文件：report.md' })
      await menu.waitFor()
      expect(page.url()).toBe(before)
      expect(await menu.getByRole('menuitem').allTextContents()).toEqual(['复制路径'])
      await menu.getByText(ELSEWHERE).waitFor()
      expect(await page.evaluate(() => (window as Window & { copied?: string[] }).copied)).toEqual([])
      await page.screenshot({ path: 'test-results/file-chips/menu.png', animations: 'disabled' })
      await menu.getByRole('menuitem', { name: '复制路径' }).click()
      await menu.waitFor({ state: 'hidden' })
      await expect.poll(() => page.evaluate(() => (window as Window & { copied?: string[] }).copied)).toEqual(['report.md'])
      // The glyph turns into a check, and the status says so.
      await report.locator('svg.lucide-check').waitFor()
      await page.getByRole('status').filter({ hasText: '已复制路径' }).waitFor()
      await page.screenshot({ path: 'test-results/file-chips/copied.png', animations: 'disabled' })

      // A file:// reference copies its absolute path; nothing anywhere in the reply navigates.
      for (const [name, menuName] of [
        ['deck.pptx', '文件：deck.pptx'],
        ['上一版', '文件：old.md'],
        ['chart.svg', '文件：chart.svg'],
      ] as const) {
        await chips.filter({ hasText: name }).first().click()
        const opened = page.getByRole('menu', { name: menuName })
        await opened.getByRole('menuitem', { name: '复制路径' }).click()
        await opened.waitFor({ state: 'hidden' })
      }
      await expect
        .poll(() => page.evaluate(() => (window as Window & { copied?: string[] }).copied))
        .toEqual(['report.md', '/Users/me/acme/deck.pptx', '../archive/old.md', 'chart.svg'])
      expect(page.url()).toBe(before)
      await page.keyboard.press('Tab')
      expect(page.url()).toBe(before)
    } finally {
      await page.context().close()
    }
  })

  it.each([
    [390, 844, 'phone'],
    [820, 1180, 'tablet'],
  ])('fits a %ipx-wide %s column, light and dark, without widening the page', async (width, height, label) => {
    for (const scheme of ['light', 'dark'] as const) {
      const page = await openSession(scheme, width, height)
      try {
        const reply = page.locator('.message-content').filter({ hasText: '复盘文档' })
        await reply.scrollIntoViewIfNeeded()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
        for (const box of await reply
          .locator('[data-file-chip]')
          .evaluateAll(chips => chips.map(chip => chip.getBoundingClientRect().right)))
          expect(box).toBeLessThanOrEqual(width)
        // A long path gives way in its folders: the file name is whole and inside the chip.
        const long = reply.locator('[data-file-chip]').filter({ hasText: LONG_NAME })
        const fit = await long.evaluate(chip => {
          const name = chip.querySelector('.file-chip-name')!
          const folders = chip.querySelector('.file-chip-folders')!
          return {
            nameWhole: name.scrollWidth <= name.clientWidth + 1,
            nameInside: name.getBoundingClientRect().right <= chip.getBoundingClientRect().right + 1,
            foldersCut: folders.scrollWidth > folders.clientWidth,
          }
        })
        expect(fit.nameWhole).toBe(true)
        expect(fit.nameInside).toBe(true)
        if (width < 768) expect(fit.foldersCut).toBe(true)
        await page.screenshot({ path: `test-results/file-chips/${label}-${scheme}.png`, animations: 'disabled' })
        if (width < 768) {
          // On a phone the same menu is a bottom sheet: the file name, 复制路径 and where the file can be opened.
          await long.click()
          const sheet = page.getByRole('dialog', { name: '文件' })
          await sheet.waitFor()
          await sheet.getByText(ELSEWHERE).waitFor()
          expect(await sheet.getByRole('menuitem').allTextContents()).toEqual(['复制路径'])
          await page.screenshot({ path: `test-results/file-chips/${label}-${scheme}-sheet.png`, animations: 'disabled' })
        }
      } finally {
        await page.context().close()
      }
    }
  })

  it('reads in dark mode', async () => {
    const page = await openSession('dark')
    try {
      await page.locator('[data-file-chip]').filter({ hasText: 'deck.pptx' }).hover()
      await page.getByRole('tooltip').filter({ hasText: '/Users/me/acme/deck.pptx' }).waitFor()
      await page.screenshot({ path: 'test-results/file-chips/reply-dark.png', animations: 'disabled' })
    } finally {
      await page.context().close()
    }
  })
})
