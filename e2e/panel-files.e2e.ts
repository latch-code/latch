import { documentFixtures } from '@latch/testkit'
import { chromium, type Browser, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { HarnessPlugin } from '@latch/sdk'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { closeActiveFile, settleShell } from './helpers/layout.ts'

const OUTPUT = 'test-results/panel-files'
const { word, workbook, presentation, pdf } = documentFixtures(files =>
  Array.from(zipSync(Object.fromEntries(Object.entries(files).map(([key, value]) => [key, strToU8(value)])))),
)

describe('the right panel', () => {
  let host: TestHost, browser: Browser, sessionId: string
  beforeAll(async () => {
    const plugin: HarnessPlugin = {
      id: 'panel-files-fixture',
      name: 'Fixture',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerProvider({
          id: 'writer',
          name: 'Fixture',
          model: 'fixture',
          async *stream({ messages }) {
            // The second turn makes two documents, the way a report and its data come together.
            if (messages.filter(message => message.role === 'user').length > 1) {
              await writeFile(join(host.workspaceRoot, 'report.html'), '<h1>Report</h1>')
              await writeFile(join(host.workspaceRoot, 'numbers.csv'), 'a,b\n1,2\n')
              // Long enough for the page to see the turn running: only a watched turn opens anything.
              await new Promise(done => setTimeout(done, 1000))
              yield { type: 'text', text: '生成了 2 个文件。' }
            } else yield { type: 'text', text: '资料都在这个文件夹里。' }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    host = await startTestHost({ demo: false, plugins: [plugin] })
    browser = await chromium.launch(browserLaunchOptions())
    const root = host.workspaceRoot
    await mkdir(join(root, 'data'), { recursive: true })
    await mkdir(join(root, 'packages/web/src'), { recursive: true })
    await writeFile(join(root, 'data/sales.csv'), 'month,amount\n1,10\n2,20\n')
    await writeFile(join(root, 'data/notes.txt'), 'first\nsecond\n')
    await writeFile(join(root, 'packages/web/src/start.ts'), 'export const ready = true\n')
    await writeFile(join(root, 'guide.md'), '# Guide\n\nRead this first.\n')
    await writeFile(join(root, 'page.html'), '<h1>Static page</h1>')
    await writeFile(join(root, 'deck.pptx'), Buffer.from(presentation(6)))
    await writeFile(join(root, 'letter.docx'), Buffer.from(word()))
    await writeFile(join(root, 'book.xlsx'), Buffer.from(workbook()))
    await writeFile(join(root, 'paper.pdf'), Buffer.from(pdf()))
    const started = await host.host.bridge.createTask({
      prompt: '整理这个文件夹',
      requestId: randomUUID(),
      mode: 'agent',
      model: { providerId: 'writer', model: 'fixture' },
    })
    sessionId = started.sessionId
    await vi.waitFor(
      async () => {
        expect((await host.host.bridge.detail(sessionId)).summary.status).toBe('idle')
      },
      { timeout: 15_000 },
    )
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
  })

  const open = async (width: number, theme: 'light' | 'dark'): Promise<Page> => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, locale: 'zh-CN' })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    const name = `Panel ${width} ${theme} ${randomUUID()}`
    await enrollBrowser(page, host, { name, scopes: ['admin'] })
    const owner = await host.enroll({ listener: 'unix' })
    const { devices } = await owner.json<{ devices: Array<{ id: string; name: string }> }>('devices')
    const device = devices.find(item => item.name === name)!
    expect((await owner.confirmed(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
    await page.reload()
    if (width === 900) await page.getByRole('button', { name: '打开会话列表', exact: true }).click()
    await page.locator(`[data-task-id="${sessionId}"]`).first().click()
    await settleShell(page)
    return page
  }
  const shot = (page: Page, name: string, width: number, theme: string) =>
    page.screenshot({ path: `${OUTPUT}/${name}--${width}-${theme}.png`, animations: 'disabled' })
  const row = (page: Page, name: string): Locator => page.getByRole('treeitem', { name, exact: true })

  for (const [width, theme] of [
    [1440, 'light'],
    [1440, 'dark'],
    [900, 'light'],
    [900, 'dark'],
    [390, 'light'],
    [390, 'dark'],
  ] as const) {
    it(`opens surfaces from the launcher and shows each renderer without chrome at ${width} ${theme}`, async () => {
      const page = await open(width, theme)
      try {
        await page.locator('.topbar').getByRole('button', { name: '侧边面板', exact: true }).filter({ visible: true }).click()
        const launcher = page.locator('.panel-launcher')
        await launcher.waitFor()
        await settleShell(page)
        await shot(page, 'launcher', width, theme)
        // Only what is real: neither a browser nor a terminal row until those exist.
        expect(await launcher.locator('.panel-launcher-row').allTextContents()).toEqual(['改动D', '文件F'])
        if (width >= 768) {
          await expect.poll(() => page.evaluate(() => document.activeElement?.className)).toBe('panel-launcher')
          await page.keyboard.press('f')
        } else await launcher.getByRole('button', { name: /^文件/u }).click()
        await row(page, 'guide.md').waitFor()
        await settleShell(page)

        // A run of single folders reads as one row once it is open, and closes as one.
        await row(page, 'packages').click()
        const run = row(page, 'packages/web/src')
        await run.waitFor()
        await row(page, 'start.ts').waitFor()
        await shot(page, 'tree', width, theme)
        await run.click()
        await row(page, 'packages').waitFor()
        expect(await row(page, 'start.ts').count()).toBe(0)

        await row(page, 'deck.pptx').click()
        const frame = page.frameLocator('iframe[title="文档预览"]')
        await frame.getByText('1 / 6', { exact: true }).waitFor()
        await frame.getByText('备注', { exact: true }).first().click()
        await frame.getByText('Speaker note', { exact: true }).first().waitFor()
        await settleShell(page)
        await shot(page, 'pptx', width, theme)
        const viewer = page.getByRole('region', { name: '文件预览', exact: true })
        expect(await viewer.getByText(/bytes|只读预览/u).count()).toBe(0)
        await viewer.getByRole('navigation', { name: '文件位置', exact: true }).getByRole('button').first().click()
        const siblings = page.getByRole('menu', { name: /里的文件$/u })
        await siblings.getByRole('menuitem', { name: 'letter.docx', exact: true }).waitFor()
        await settleShell(page)
        await shot(page, 'crumb-menu', width, theme)
        await siblings.getByRole('menuitem', { name: 'letter.docx', exact: true }).click()
        await frame.getByText('Hello DOCX', { exact: true }).waitFor()
        await settleShell(page)
        await shot(page, 'docx', width, theme)

        const tabs = page.getByRole('tablist', { name: '会话面板', exact: true })
        await tabs.getByRole('tab', { name: '文件', exact: true }).click()
        await row(page, 'book.xlsx').click()
        await page.getByRole('gridcell').first().waitFor()
        await settleShell(page)
        await shot(page, 'xlsx', width, theme)
        expect(await page.getByText('隐藏的工作表未显示。', { exact: true }).count()).toBe(0)

        await tabs.getByRole('tab', { name: '文件', exact: true }).click()
        await row(page, 'guide.md').click()
        await viewer.getByRole('heading', { name: 'Guide', exact: true }).waitFor()
        await viewer.getByRole('button', { name: '源码', exact: true }).click()
        await viewer.getByText('# Guide', { exact: false }).waitFor()
        await viewer.getByRole('button', { name: '文件操作', exact: true }).click()
        await settleShell(page)
        await shot(page, 'text-menu', width, theme)
        await page.getByRole('menuitem', { name: '查找', exact: true }).click()
        await viewer.getByRole('searchbox', { name: '查找文件内容' }).waitFor()
        await shot(page, 'text-find', width, theme)

        await tabs.getByRole('tab', { name: '文件', exact: true }).click()
        await row(page, 'paper.pdf').click()
        await viewer
          .getByRole('status')
          .filter({ hasText: /\/ \d+ 页/u })
          .waitFor()
        await settleShell(page)
        await shot(page, 'pdf', width, theme)

        await tabs.getByRole('tab', { name: '文件', exact: true }).click()
        await row(page, 'page.html').click()
        await frame.getByRole('heading', { name: 'Static page', exact: true }).waitFor()
        await settleShell(page)
        await shot(page, 'html', width, theme)
        await closeActiveFile(page)

        if (width >= 768) {
          await page.locator('.topbar-crumb-button').click()
          await page.locator('.crumb-body').waitFor()
          await settleShell(page)
          // The folder's own name stays on the line however long the path before it is.
          expect(await page.locator('.crumb-folder code [aria-hidden]').first().textContent()).toContain(basename(host.workspaceRoot))
          await shot(page, 'crumb', width, theme)
          await page.keyboard.press('Escape')
          // × shuts the panel and the toggle brings back what was showing, tabs and all.
          await tabs.locator('..').getByRole('button', { name: '关闭', exact: true }).click()
          await expect.poll(() => page.locator('.session-panels').count()).toBe(0)
          await page.locator('.topbar').getByRole('button', { name: '侧边面板', exact: true }).click()
          await viewer.getByRole('button', { name: '文件操作', exact: true }).waitFor()
        }
      } finally {
        await page.context().close()
      }
    })
  }

  it('opens the first new document of a turn and leaves the next waiting with a dot', async () => {
    const page = await open(1440, 'light')
    try {
      const { sessionId: other } = await host.host.bridge.createTask({
        prompt: '先开始',
        requestId: randomUUID(),
        mode: 'agent',
        model: { providerId: 'writer', model: 'fixture' },
      })
      await vi.waitFor(
        async () => {
          expect((await host.host.bridge.detail(other)).summary.status).toBe('idle')
        },
        { timeout: 15_000 },
      )
      await page.locator(`[data-task-id="${other}"]`).first().click()
      await page.getByRole('textbox', { name: '继续对话', exact: true }).fill('生成')
      await page.getByRole('button', { name: '发送', exact: true }).click()
      const tabs = page.getByRole('tablist', { name: '会话面板', exact: true })
      await tabs.getByRole('tab', { name: 'numbers.csv', selected: true }).waitFor()
      const waiting = tabs.getByRole('tab', { name: /report\.html/u })
      await waiting.getByRole('img', { name: '有新内容', exact: true }).waitFor()
      await settleShell(page)
      await shot(page, 'new-documents', 1440, 'light')
      await waiting.click()
      await page.frameLocator('iframe').getByRole('heading', { name: 'Report', exact: true }).waitFor()
      expect(await waiting.getByRole('img', { name: '有新内容', exact: true }).count()).toBe(0)
    } finally {
      await page.context().close()
    }
  })

  it('shows its place while a file is being read', async () => {
    const page = await open(1440, 'dark')
    try {
      await page.locator('.topbar').getByRole('button', { name: '侧边面板', exact: true }).click()
      await page.keyboard.press('f')
      let release = () => {}
      await page.route('**/link/api/tasks/*/files/resolve', async route => {
        await new Promise<void>(done => {
          release = done
        })
        await route.continue()
      })
      await row(page, 'guide.md').click()
      await page.getByRole('region', { name: '文件预览', exact: true }).getByText('正在读取文件信息…').waitFor()
      await settleShell(page)
      await shot(page, 'reading', 1440, 'dark')
      release()
      await page.getByRole('region', { name: '文件预览', exact: true }).getByRole('heading', { name: 'Guide', exact: true }).waitFor()
    } finally {
      await page.context().close()
    }
  })

  it('says when a file can no longer be read', async () => {
    const page = await open(1440, 'light')
    try {
      await page.locator('.topbar').getByRole('button', { name: '侧边面板', exact: true }).click()
      await page.keyboard.press('f')
      await page.route('**/link/api/tasks/*/files/resolve', route => route.fulfill({ status: 403, json: { error: 'nope' } }))
      await row(page, 'guide.md').click()
      await page.getByRole('region', { name: '文件预览', exact: true }).locator('.ui-notice').waitFor()
      await settleShell(page)
      await shot(page, 'failed', 1440, 'light')
    } finally {
      await page.context().close()
    }
  })

  it('offers another try when a known file fails to read, without a spinner beside the error', async () => {
    const page = await open(1440, 'light')
    try {
      await page.locator('.topbar').getByRole('button', { name: '侧边面板', exact: true }).click()
      await page.keyboard.press('f')
      let fail = true
      await page.route('**/link/api/files/*', route => (fail ? route.fulfill({ status: 500, json: { error: 'nope' } }) : route.continue()))
      await row(page, 'guide.md').click()
      const viewer = page.getByRole('region', { name: '文件预览', exact: true })
      const retry = viewer.getByRole('button', { name: '重试', exact: true })
      await retry.waitFor()
      expect(await viewer.getByText('正在读取内容…').count()).toBe(0)
      fail = false
      await retry.click()
      await viewer.getByRole('heading', { name: 'Guide', exact: true }).waitFor()
      expect(await retry.count()).toBe(0)
    } finally {
      await page.context().close()
    }
  })

  it('says when a document page has nothing to quote', async () => {
    const page = await open(1440, 'light')
    try {
      await page.locator('.topbar').getByRole('button', { name: '侧边面板', exact: true }).click()
      await page.keyboard.press('f')
      await row(page, 'deck.pptx').click()
      const frame = page.frameLocator('iframe[title="文档预览"]')
      await frame.getByText('1 / 6', { exact: true }).waitFor()
      await frame.locator('[data-slide-index="0"]').evaluate(slide => {
        slide.replaceChildren()
      })
      const viewer = page.getByRole('region', { name: '文件预览', exact: true })
      await viewer.getByRole('button', { name: '引用到对话', exact: true }).click()
      await viewer.getByRole('status').filter({ hasText: '这一页没有可引用的文字。' }).waitFor()
    } finally {
      await page.context().close()
    }
  })

  it('reads a folder from the crumb when the keyboard opens it', async () => {
    const page = await open(1440, 'light')
    try {
      await page.locator('.topbar').getByRole('button', { name: '侧边面板', exact: true }).click()
      await page.keyboard.press('f')
      await row(page, 'guide.md').click()
      const viewer = page.getByRole('region', { name: '文件预览', exact: true })
      await viewer.getByRole('heading', { name: 'Guide', exact: true }).waitFor()
      await viewer.getByRole('navigation', { name: '文件位置', exact: true }).getByRole('button').first().focus()
      await page.keyboard.press('ArrowDown')
      await page
        .getByRole('menu', { name: /里的文件$/u })
        .getByRole('menuitem', { name: 'letter.docx', exact: true })
        .waitFor()
    } finally {
      await page.context().close()
    }
  })

  it('keeps keyboard focus on a run of folders as it opens and closes', async () => {
    const page = await open(1440, 'light')
    try {
      await page.locator('.topbar').getByRole('button', { name: '侧边面板', exact: true }).click()
      await page.keyboard.press('f')
      await row(page, 'packages').focus()
      await page.keyboard.press('ArrowRight')
      const run = row(page, 'packages/web/src')
      await run.waitFor()
      await expect.poll(() => run.evaluate(element => element === document.activeElement)).toBe(true)
      expect(await run.getAttribute('tabindex')).toBe('0')
      await page.keyboard.press('ArrowLeft')
      const folder = row(page, 'packages')
      await folder.waitFor()
      await expect.poll(() => folder.evaluate(element => element === document.activeElement)).toBe(true)
      expect(await folder.getAttribute('tabindex')).toBe('0')
    } finally {
      await page.context().close()
    }
  })

  it('leaves focus in the composer when a session comes up with the panel already open', async () => {
    const { sessionId: other } = await host.host.bridge.createTask({
      prompt: '另一个',
      requestId: randomUUID(),
      mode: 'agent',
      model: { providerId: 'writer', model: 'fixture' },
    })
    await vi.waitFor(
      async () => {
        expect((await host.host.bridge.detail(other)).summary.status).toBe('idle')
      },
      { timeout: 15_000 },
    )
    const page = await open(1440, 'light')
    const launcherHasFocus = () => page.evaluate(() => document.activeElement?.className === 'panel-launcher')
    try {
      await page.locator('.topbar').getByRole('button', { name: '侧边面板', exact: true }).click()
      await page.locator('.panel-launcher').waitFor()
      await expect.poll(launcherHasFocus).toBe(true)
      const composer = page.getByRole('textbox', { name: '继续对话', exact: true })
      await composer.focus()
      const before = await page.locator('.session-panels').evaluateHandle(element => element)
      await page.keyboard.press('Alt+]')
      // The panel is keyed by its session, so a new element means the launcher mounted again.
      await expect.poll(() => before.evaluate(element => element.isConnected)).toBe(false)
      await page.locator('.panel-launcher').waitFor()
      await settleShell(page)
      expect(await launcherHasFocus()).toBe(false)
      await page.reload()
      await page.locator('.panel-launcher').waitFor()
      await settleShell(page)
      expect(await launcherHasFocus()).toBe(false)
    } finally {
      await page.context().close()
    }
  })

  it('brings back the file a page was showing when it was sent back', async () => {
    const page = await open(390, 'light')
    try {
      const toggle = page.locator('.topbar').getByRole('button', { name: '侧边面板', exact: true }).filter({ visible: true })
      await toggle.click()
      await page
        .locator('.panel-launcher')
        .getByRole('button', { name: /^文件/u })
        .click()
      await row(page, 'guide.md').click()
      const viewer = page.getByRole('region', { name: '文件预览', exact: true })
      await viewer.getByRole('heading', { name: 'Guide', exact: true }).waitFor()
      await page.goBack()
      await expect.poll(() => toggle.isVisible()).toBe(true)
      await settleShell(page)
      await toggle.click()
      await viewer.getByRole('heading', { name: 'Guide', exact: true }).waitFor()
    } finally {
      await page.context().close()
    }
  })
})
