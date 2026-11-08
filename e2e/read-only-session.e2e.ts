import { chromium, type Browser } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { AppSnapshot } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

/** A session an earlier build's assistant ran opens only to be read: nothing on the page offers what the Host refuses. */

const OUT = 'test-results/read-only-session'
let root: string, host: TestHost, browser: Browser, sessionId: string

const plugin: HarnessPlugin = {
  id: 'read-only-fixture',
  name: '只读测试',
  version: '1.0.0',
  description: '本地假模型',
  activate(context) {
    context.registerProvider({
      id: 'writer',
      name: 'Fixture writer',
      model: 'fixture',
      async *stream() {
        await writeFile(join(host.workspaceRoot, 'made.txt'), 'made by this turn\n')
        yield { type: 'text', text: '改好了。' }
        yield { type: 'finish', reason: 'stop' }
      },
    })
  },
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'latch-read-only-'))
  const dirs = { dataDir: join(root, 'data'), workspaceRoot: join(root, 'workspace') }
  await mkdir(dirs.workspaceRoot, { recursive: true })
  host = await startTestHost({ demo: false, plugins: [plugin], ...dirs })
  ;({ sessionId } = await host.host.bridge.createTask({
    prompt: '改一个文件',
    requestId: randomUUID(),
    mode: 'agent',
    model: { providerId: 'writer', model: 'fixture' },
  }))
  await vi.waitFor(async () => expect((await host.host.bridge.detail(sessionId)).summary.status).toBe('idle'), { timeout: 15_000 })
  await host.close()
  const file = join(
    dirs.dataDir,
    (await readdir(dirs.dataDir, { recursive: true })).find(path => path.endsWith('runtime.json'))!,
  )
  const runtime = JSON.parse(await readFile(file, 'utf8'))
  runtime.tasks[sessionId].summary.personal = { assistantId: `asst_${randomUUID()}` }
  await writeFile(file, JSON.stringify(runtime))
  host = await startTestHost({ demo: false, plugins: [plugin], ...dirs })
  // No preset lookup: nothing on this computer can be offered as a Harness.
  const owner = await host.enroll({ listener: 'unix' })
  expect((await owner.json<AppSnapshot>('snapshot')).catalog?.harnesses.map(harness => harness.id)).toEqual(['standard'])
  browser = await chromium.launch(browserLaunchOptions())
  await mkdir(OUT, { recursive: true })
})
afterAll(async () => {
  await browser?.close()
  await host?.close()
  await rm(root, { recursive: true, force: true })
})

it.each([
  { width: 1440, theme: 'light' as const },
  { width: 390, theme: 'dark' as const },
])('offers no undo and no clear context at $width $theme', async ({ width, theme }) => {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    colorScheme: theme,
    locale: 'zh-CN',
    reducedMotion: 'reduce',
  })
  context.setDefaultTimeout(15_000)
  const page = await context.newPage()
  try {
    await enrollBrowser(page, host, { name: '只读', scopes: ['admin'] })
    const desktop = await host.enroll({ listener: 'unix' })
    const deviceId = await page.evaluate(async () => {
      const response = await fetch('/link/api/snapshot')
      return ((await response.json()) as { device: { id: string } }).device.id
    })
    expect((await desktop.confirmed(`devices/${deviceId}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
    await page.reload()
    await connected(page)
    await page.keyboard.press('Meta+k')
    const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
    await palette.getByRole('searchbox').fill('改一个文件')
    await palette.getByRole('option').first().click()
    await palette.waitFor({ state: 'hidden' })
    await page.getByText('这个会话来自已移除的 Agent，只能查看').first().waitFor()

    const card = page.getByRole('region', { name: '这一轮改动的文件', exact: true })
    await card.getByText('改动了 1 个文件', { exact: true }).waitFor()
    expect(await card.getByRole('button', { name: '撤销本轮', exact: true }).count()).toBe(0)

    await (width === 390 ? page.locator('.topbar-title-button') : page.getByRole('button', { name: '会话操作', exact: true })).click()
    await page.getByRole('menuitem', { name: '重命名' }).waitFor()
    expect(await page.getByRole('menuitem', { name: /清空上下文/ }).count()).toBe(0)
    await page.screenshot({ path: join(OUT, `menu--${width}--${theme}.png`) })
    await page.keyboard.press('Escape')
    await page.screenshot({ path: join(OUT, `session--${width}--${theme}.png`) })

    if (width === 390) return
    await page.getByRole('button', { name: '改动', exact: true }).click()
    const panel = page.locator('.changes-panel')
    await panel.getByText('made.txt', { exact: true }).first().waitFor()
    await panel.getByText('这个会话只能查看', { exact: true }).waitFor()
    expect(await panel.getByRole('button', { name: /撤销|恢复/ }).count()).toBe(0)
    await page.screenshot({ path: join(OUT, `changes--${width}--${theme}.png`) })
  } finally {
    await context.close()
  }
})
