import { documentFixtures } from '@latch/testkit'
import { chromium, type Browser, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { closeActiveFile, openPanelTab, openSession, settleShell } from './helpers/layout.ts'

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
    // By the page's own id: the Host renumbers a name that reads like another device's in the 19 characters its
    // confirmation shows, and these names differ only after that.
    const id = await page.evaluate(async () => ((await (await fetch('/link/api/snapshot')).json()) as AppSnapshot).device.id)
    expect((await owner.confirmed(`devices/${id}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
    await page.reload()
    await openSession(page, sessionId)
    await settleShell(page)
    return page
  }
  const shot = (page: Page, name: string, width: number, theme: string) =>
    page.screenshot({ path: `${OUTPUT}/${name}--${width}-${theme}.png`, animations: 'disabled' })
  const row = (page: Page, name: string): Locator => page.getByRole('treeitem', { name, exact: true })
  const openPanel = async (page: Page) => {
    const toggle = page.getByRole('button', { name: '侧边面板', exact: true }).filter({ visible: true })
    if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
    const tabs = page.getByRole('tablist', { name: '会话面板', exact: true })
    await tabs.waitFor()
    return tabs
  }
  const openFiles = async (page: Page) => {
    await openPanel(page)
    await openPanelTab(page, '文件')
  }

  it('keeps the open slide and notes while changing display language', async () => {
    const page = await open(1440, 'light')
    try {
      await openFiles(page)
      await row(page, 'deck.pptx').click()
      const sandbox = page.locator('.file-sandbox iframe')
      const frame = sandbox.contentFrame()
      await page.getByRole('status').filter({ hasText: '1 / 6 页' }).waitFor()
      await frame.getByText('备注', { exact: true }).first().click()
      await frame.getByText('Speaker note', { exact: true }).first().waitFor()
      await frame.locator('body').evaluate(body => {
        body.tabIndex = -1
        body.focus({ preventScroll: true })
      })
      await page.keyboard.press('ArrowRight')
      await page.getByRole('status').filter({ hasText: '2 / 6 页' }).waitFor()
      const frameElement = await sandbox.elementHandle()
      const source = await sandbox.getAttribute('src')

      await page.getByTestId('open-settings').filter({ visible: true }).first().click()
      await page.locator('#settings-tab-general').click()
      await page.getByRole('radiogroup', { name: '界面语言', exact: true }).getByRole('radio', { name: 'English', exact: true }).click()
      await page.getByTestId('close-settings').click()

      await page.getByRole('status').filter({ hasText: '2 / 6 pages' }).waitFor()
      const notes = frame.locator('details[data-latch-notes][open] summary[aria-label="Notes"]').first()
      await notes.waitFor()
      expect(await notes.evaluate(element => getComputedStyle(element, '::after').content)).toBe('"Notes"')
      expect(await notes.textContent()).toBe('备注')
      expect(await frameElement.evaluate(node => node.isConnected)).toBe(true)
      expect(await sandbox.getAttribute('src')).toBe(source)
      await shot(page, 'pptx-en', 1440, 'light')
      await page.getByRole('button', { name: 'Quote in chat', exact: true }).click()
      // Draft references use the original page marker even when the viewer is English.
      await expect.poll(async () => page.locator('.composer-input textarea:visible').inputValue()).toContain('第 2 页')
    } finally {
      await page.context().close()
    }
  })

  for (const [width, theme] of [
    [1440, 'light'],
    [1440, 'dark'],
    [900, 'light'],
    [900, 'dark'],
    [390, 'light'],
    [390, 'dark'],
  ] as const) {
    it(`opens surfaces from the overview and shows each renderer without chrome at ${width} ${theme}`, async () => {
      const page = await open(width, theme)
      try {
        const panelTabs = await openPanel(page)
        await panelTabs.getByRole('tab', { name: '概要', selected: true }).waitFor()
        await settleShell(page)
        await shot(page, 'overview', width, theme)
        // A session starts on 概要; 「+」 offers only what this Host and device can actually use, each with its key.
        expect(await panelTabs.getByRole('tab').allTextContents()).toEqual(['概要'])
        const add = page.getByRole('button', { name: '打开面板', exact: true }).filter({ visible: true })
        if (width >= 768) {
          await add.focus()
          await page.keyboard.press('Enter')
          const menu = page.getByRole('menu', { name: '打开面板', exact: true })
          // A browser page has neither the desktop's browser nor this Mac's terminal: they are left out, not greyed.
          expect(await menu.getByRole('menuitem').allTextContents()).toEqual(['文件F', '改动D', '交付P', '概要O'])
          await settleShell(page)
          await shot(page, 'add-menu', width, theme)
          await page.keyboard.press('f')
        } else {
          await add.click()
          await page.getByRole('menuitem', { name: '文件', exact: true }).click()
        }
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

        // Past the two tabs the strip has room for, the rest are in its 「其余」 menu (890b9f1e).
        await openPanelTab(page, '文件')
        await row(page, 'book.xlsx').click()
        await page.getByRole('gridcell').first().waitFor()
        await settleShell(page)
        await shot(page, 'xlsx', width, theme)
        expect(await page.getByText('隐藏的工作表未显示。', { exact: true }).count()).toBe(0)

        await openPanelTab(page, '文件')
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

        await openPanelTab(page, '文件')
        await row(page, 'paper.pdf').click()
        await viewer
          .getByRole('status')
          .filter({ hasText: /\/ \d+ 页/u })
          .waitFor()
        await settleShell(page)
        await shot(page, 'pdf', width, theme)

        await openPanelTab(page, '文件')
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
          // The toggle shuts the panel and brings back what was showing, tabs and all.
          await page.getByRole('button', { name: '侧边面板', exact: true }).click()
          await expect.poll(() => page.locator('.session-panels').count()).toBe(0)
          await page.getByRole('button', { name: '侧边面板', exact: true }).click()
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
      await openSession(page, other)
      await page.getByRole('textbox', { name: '继续对话', exact: true }).fill('生成')
      await page.getByRole('button', { name: '发送', exact: true }).click()
      const tabs = page.getByRole('tablist', { name: '会话面板', exact: true })
      await tabs.getByRole('tab', { name: 'numbers.csv', selected: true }).waitFor()
      // The waiting document's tab carries the dot; where the strip has no room for that tab, its 「其余」 button does.
      const waiting = tabs.getByRole('tab', { name: /report\.html/u })
      const more = tabs.locator('xpath=..').getByRole('button', { name: /^其余 \d+ 个标签$/u })
      const dot = waiting.or(more).getByRole('img', { name: '有新内容', exact: true })
      await dot.first().waitFor()
      await settleShell(page)
      await shot(page, 'new-documents', 1440, 'light')
      await openPanelTab(page, 'report.html')
      await page.frameLocator('iframe').getByRole('heading', { name: 'Report', exact: true }).waitFor()
      expect(await dot.count()).toBe(0)
    } finally {
      await page.context().close()
    }
  })

  it('shows its place while a file is being read', async () => {
    const page = await open(1440, 'dark')
    try {
      await openFiles(page)
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
      await openFiles(page)
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
      await openFiles(page)
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
      await openFiles(page)
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
      await openFiles(page)
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
      await openFiles(page)
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
    const panelHasFocus = () => page.locator('.session-panels').evaluate(element => element.contains(document.activeElement))
    try {
      await openPanel(page)
      await page.getByRole('tabpanel', { name: '会话概要', exact: true }).waitFor()
      const composer = page.getByRole('textbox', { name: '继续对话', exact: true })
      await composer.focus()
      const before = await page.locator('.session-panels').evaluateHandle(element => element)
      await page.keyboard.press('Alt+]')
      // The panel is keyed by its session; changing sessions must not steal input focus.
      await expect.poll(() => before.evaluate(element => element.isConnected)).toBe(false)
      await page.getByRole('tabpanel', { name: '会话概要', exact: true }).waitFor()
      await settleShell(page)
      expect(await panelHasFocus()).toBe(false)
      await page.reload()
      await page.getByRole('tabpanel', { name: '会话概要', exact: true }).waitFor()
      await settleShell(page)
      expect(await panelHasFocus()).toBe(false)
    } finally {
      await page.context().close()
    }
  })

  it('brings back the file a page was showing when it was sent back', async () => {
    const page = await open(390, 'light')
    try {
      const toggle = page.getByRole('button', { name: '侧边面板', exact: true }).filter({ visible: true })
      await openFiles(page)
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
