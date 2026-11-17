import { chromium, type Browser, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { openPanelTab, openSession, settleShell } from './helpers/layout.ts'

const OUTPUT = process.env.LATCH_SHOTS_DIR ?? 'test-results/content-search'

describe('searching file contents in the files panel', () => {
  let host: TestHost, browser: Browser, sessionId: string
  beforeAll(async () => {
    const plugin: HarnessPlugin = {
      id: 'content-search-fixture',
      name: 'Fixture',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerProvider({
          id: 'quiet',
          name: 'Fixture',
          model: 'fixture',
          async *stream() {
            yield { type: 'text', text: '项目已就绪。' }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    host = await startTestHost({ demo: false, plugins: [plugin] })
    browser = await chromium.launch(browserLaunchOptions())
    const root = host.workspaceRoot
    await mkdir(join(root, 'src/server'), { recursive: true })
    await mkdir(join(root, 'node_modules/dep'), { recursive: true })
    await writeFile(
      join(root, 'src/server/routes.ts'),
      [
        "import { handle } from './handle'",
        '',
        'export function startServer(port: number) {',
        '  // startServer binds the port and answers',
        '  return handle(port)',
        '}',
        ...Array.from({ length: 300 }, (_, index) => `const filler${index} = ${index}`),
        'export const restartServer = () => startServer(0)',
      ].join('\n'),
    )
    await writeFile(join(root, 'src/main.ts'), "import { startServer } from './server/routes'\n\nstartServer(4317)\n")
    await writeFile(join(root, 'README.md'), '# Demo\n\nRun `startServer` to begin.\nStartServer is the entry.\n')
    await writeFile(join(root, 'node_modules/dep/index.js'), 'startServer in a dependency\n')
    await writeFile(join(root, '.env'), 'START_SERVER_TOKEN=startServer\n')
    const started = await host.host.bridge.createTask({
      prompt: '看一下这个项目',
      requestId: randomUUID(),
      mode: 'agent',
      model: { providerId: 'quiet', model: 'fixture' },
    })
    sessionId = started.sessionId
    await vi.waitFor(async () => expect((await host.host.bridge.detail(sessionId)).summary.status).toBe('idle'), { timeout: 15_000 })
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
    await enrollBrowser(page, host, { name: `Grep ${width} ${theme} ${randomUUID()}`, scopes: ['admin'] })
    const owner = await host.enroll({ listener: 'unix' })
    const id = await page.evaluate(async () => ((await (await fetch('/link/api/snapshot')).json()) as AppSnapshot).device.id)
    expect((await owner.confirmed(`devices/${id}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
    await page.reload()
    await openSession(page, sessionId)
    await settleShell(page)
    const toggle = page.getByRole('button', { name: '侧边面板', exact: true }).filter({ visible: true })
    if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
    await page.getByRole('tablist', { name: '会话面板', exact: true }).waitFor()
    await openPanelTab(page, '文件')
    await page.getByRole('treeitem', { name: 'README.md', exact: true }).waitFor()
    return page
  }
  const shot = (page: Page, name: string, width: number, theme: string) =>
    page.screenshot({ path: `${OUTPUT}/${name}--${width}-${theme}.png`, animations: 'disabled' })

  for (const [width, theme] of [
    [1440, 'light'],
    [1440, 'dark'],
    [820, 'light'],
    [390, 'light'],
  ] as const)
    it(`finds lines, marks the match and opens the file at the line at ${width} ${theme}`, async () => {
      const page = await open(width, theme)
      try {
        const grepBodies: unknown[] = []
        page.on('request', request => {
          if (request.url().endsWith('/files/grep')) grepBodies.push(request.postDataJSON())
        })
        // ⇧⌘F while the panel has focus opens the search in place of the tree.
        await page.getByRole('treeitem', { name: 'README.md', exact: true }).focus()
        await page.keyboard.press('Shift+Meta+f')
        const search = page.getByRole('search', { name: '搜索内容', exact: true })
        const field = search.getByRole('searchbox', { name: '搜索内容', exact: true })
        await expect.poll(() => field.evaluate(element => element === document.activeElement)).toBe(true)
        await field.fill('startServer')
        const status = search.getByRole('status')
        await status.getByText('7 处 · 3 个文件', { exact: true }).waitFor()
        // Ignored folders and secret files are never searched.
        const files = search.locator('[data-content-file]')
        expect((await files.evaluateAll(items => items.map(item => item.getAttribute('data-content-file')))).sort()).toEqual([
          'default:README.md',
          'default:src/main.ts',
          'default:src/server/routes.ts',
        ])
        const marked = await search.locator('[data-content-file="default:src/server/routes.ts"] mark').allTextContents()
        expect(marked).toEqual(['startServer', 'startServer', 'startServer', 'startServer'])
        await settleShell(page)
        await shot(page, 'results', width, theme)

        // 区分大小写 and 全字匹配 search again; the request carries only the text and the two choices.
        await search.getByRole('button', { name: '区分大小写', exact: true }).click()
        await status.getByText('6 处 · 3 个文件', { exact: true }).waitFor()
        await search.getByRole('button', { name: '全字匹配', exact: true }).click()
        await field.fill('Server')
        await status.getByText('没有找到', { exact: true }).waitFor()
        expect(grepBodies.at(-1)).toEqual({ q: 'Server', caseSensitive: true, wholeWord: true })
        await search.getByRole('button', { name: '全字匹配', exact: true }).click()
        await search.getByRole('button', { name: '区分大小写', exact: true }).click()
        await field.fill('startServer')
        await status.getByText('7 处 · 3 个文件', { exact: true }).waitFor()

        // A line opens its file at that line, through the same preview as the tree.
        await search.getByRole('button', { name: 'routes.ts 第 307 行', exact: true }).click()
        const viewer = page.getByRole('region', { name: '文件预览', exact: true })
        await viewer.locator('.file-text-line').filter({ hasText: 'export const restartServer' }).waitFor()
        if (width < 768 && (await page.locator('.info-page-head').count()))
          await page.locator('.info-page-head').getByRole('button', { name: '返回', exact: true }).click()
        await openPanelTab(page, '文件').catch(() => {})
        // A second line in the same open file moves the view to it.
        const again = page.getByRole('search', { name: '搜索内容', exact: true })
        if (await again.count()) {
          await again.getByRole('button', { name: 'routes.ts 第 3 行', exact: true }).click()
          await viewer.locator('.file-text-line').first().filter({ hasText: 'export function startServer' }).waitFor()
          // Paged away and chosen again, the same line comes back.
          await viewer.getByRole('button', { name: '后 200 行', exact: true }).click()
          await viewer.locator('.file-text-line').first().filter({ hasText: 'export function startServer' }).waitFor({ state: 'detached' })
          await openPanelTab(page, '文件')
          await again.getByRole('button', { name: 'routes.ts 第 3 行', exact: true }).click()
          await viewer.locator('.file-text-line').first().filter({ hasText: 'export function startServer' }).waitFor()
        }
        await settleShell(page)
        await shot(page, 'opened', width, theme)
        // A Markdown file opens as source at the line, not rendered.
        if (width >= 768) {
          await openPanelTab(page, '文件')
          await page
            .getByRole('search', { name: '搜索内容', exact: true })
            .getByRole('button', { name: 'README.md 第 4 行', exact: true })
            .click()
          await viewer.locator('.file-text-line').first().filter({ hasText: 'StartServer is the entry.' }).waitFor()
        }
      } finally {
        await page.context().close()
      }
    })

  it('says when there are more results than shown', async () => {
    const root = host.workspaceRoot
    await mkdir(join(root, 'many'), { recursive: true })
    for (let index = 0; index < 8; index++) await writeFile(join(root, 'many', `part-${index}.txt`), 'repeatedword\n'.repeat(80))
    const page = await open(1440, 'light')
    try {
      await page.getByRole('button', { name: '搜索内容', exact: true }).click()
      const search = page.getByRole('search', { name: '搜索内容', exact: true })
      await search.getByRole('searchbox').fill('repeatedword')
      await search.getByRole('status').getByText('500 处 · 7 个文件', { exact: true }).waitFor()
      await search.getByText('更多结果未显示', { exact: true }).waitFor()
      // Esc in an empty field goes back to the tree.
      await search.getByRole('searchbox').fill('')
      await page.keyboard.press('Escape')
      await page.getByRole('treeitem', { name: 'README.md', exact: true }).waitFor()
    } finally {
      await page.context().close()
    }
  })
})
