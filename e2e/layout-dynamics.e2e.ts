import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, type Page } from '@playwright/test'
import { expect, test } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { clippedOnTheRight, settleShell } from './helpers/layout.ts'

const OUT = 'test-results/layout-dynamics'

/** A user message quoting a line of code far wider than any window, and a long reply with a table and a long path. */
const WIDE = [
  'echo 宽内容',
  '',
  '```ts',
  `const line = '${'x'.repeat(400)}'`,
  '```',
  '',
  '| 列一 | 列二 | 列三 |',
  '| --- | --- | --- |',
  `| ${'很长的单元格内容'.repeat(6)} | \`${'inline'.repeat(20)}\` | b |`,
  '',
  `一个很长的路径 \`/Users/someone/projects/${'deep/'.repeat(40)}file.ts\` 和 https://example.com/${'a'.repeat(300)}`,
].join('\n')
/** An unconfirmed submission keeps the draft on one line in its card, so a long one is as wide as its text. */
const DRAFT = `断线的消息 ${'很长的草稿'.repeat(40)}`

/** Nothing reaches past the window or is cut off by the box that holds it, and the composer stays inside the conversation. */
async function fits(page: Page, step: string): Promise<void> {
  await settleShell(page)
  const geometry = await page.evaluate(() => {
    const visible = (selector: string) =>
      [...document.querySelectorAll<HTMLElement>(selector)].find(item => item.getClientRects().length > 0)
    const conversation = visible('main.workspace')!.getBoundingClientRect()
    const composer = visible('.composer')!.getBoundingClientRect()
    const card = visible('.pending-submission')?.getBoundingClientRect()
    return {
      page: document.documentElement.scrollWidth <= innerWidth,
      conversation: conversation.right <= innerWidth + 1,
      composer: composer.right <= Math.min(conversation.right, innerWidth) + 1,
      card: card === undefined || card.right <= Math.min(conversation.right, innerWidth) + 1,
    }
  })
  expect({ step, ...geometry }).toEqual({ step, page: true, conversation: true, composer: true, card: true })
  const clipped = (await clippedOnTheRight(page)).filter(line => !line.includes('middle-ellipsis'))
  expect({ step, clipped }).toEqual({ step, clipped: [] })
}

async function drag(page: Page, selector: string, dx: number): Promise<void> {
  const box = (await page.locator(selector).boundingBox())!
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let step = 1; step <= 10; step++) await page.mouse.move(x + (dx * step) / 10, y)
  await page.mouse.up()
}

test('dragging both panes to their extremes and resizing the window never pushes the conversation past the window', async () => {
  await mkdir(OUT, { recursive: true })
  const host = await startTestHost({ uiDir: resolve('dist/web') }),
    browser = await chromium.launch(browserLaunchOptions())
  try {
    const owner = await host.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: { id: 'fake-agent', name: 'Fake Agent', command: process.execPath, args: [FAKE_ACP_AGENT] },
    })
    const project = join(host.root, 'studio')
    await mkdir(project)
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', ...args], {
        cwd: project,
        stdio: 'pipe',
      })
    git('init', '-q')
    await writeFile(join(project, 'README.md'), '# studio\n')
    git('add', '-A')
    git('commit', '-qm', 'first')
    expect((await owner.addFolders({ paths: [project] })).ok).toBe(true)
    const workspaces = await owner.json<{ workspaces: Array<{ id: string; path: string }> }>('workspaces')
    const workspaceId = workspaces.workspaces.find(item => item.path.endsWith('/studio'))!.id
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { harnessId: 'fake-agent', prompt: WIDE, requestId: randomUUID(), workspaceId },
    })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, { timeout: 20_000 }).toBe('idle')

    for (const colorScheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme, reducedMotion: 'reduce' }),
        page = await context.newPage()
      await enrollBrowser(page, host, { name: `布局 ${colorScheme}` })
      // The submission never arrives, so it stays unconfirmed with its draft in the card above the composer.
      await page.route(`**/link/api/tasks/${sessionId}/prompt`, route => route.abort('failed'))
      await page.locator(`[data-task-id="${sessionId}"]`).first().click()
      const input = page.getByRole('textbox', { name: '继续对话', exact: true })
      await input.fill(DRAFT)
      await input.press('Enter')
      await page
        .locator('.pending-submission')
        .filter({ visible: true })
        .getByRole('button', { name: '重试这次提交', exact: true })
        .waitFor()
      const toggle = page.getByRole('button', { name: '侧边面板', exact: true })
      if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
      await page.locator('.inspector-resize').waitFor()
      await fits(page, 'panel open')

      // Both edges to their extremes and back, in both orders.
      await drag(page, '.sidebar-resize', 400)
      await fits(page, 'sidebar widest')
      await drag(page, '.inspector-resize', -900)
      await fits(page, 'panel widest')
      await drag(page, '.inspector-resize', 900)
      await fits(page, 'panel narrowest')
      await drag(page, '.sidebar-resize', 400)
      await drag(page, '.inspector-resize', -900)
      await fits(page, 'both widest')
      await drag(page, '.sidebar-resize', -400)
      await expect.poll(() => page.locator('.app-shell').getAttribute('data-sidebar')).toBe('collapsed')
      await fits(page, 'sidebar snapped shut')
      await page.getByRole('button', { name: '展开侧栏', exact: true }).filter({ visible: true }).first().click()
      await fits(page, 'sidebar open again')

      // The owner's case: the panel shut after the drags.
      await toggle.click()
      await expect.poll(() => page.locator('.app-shell').getAttribute('data-inspector')).toBeNull()
      await fits(page, 'panel closed')
      await page.screenshot({ path: `${OUT}/closed-1440-${colorScheme}.png` })

      for (const width of [1920, 1280, 1024, 900, 768, 600, 390, 600, 768, 900, 1024, 1280, 1440]) {
        await page.setViewportSize({ width, height: 900 })
        await fits(page, `closed at ${width}`)
        if (width === 1024) await page.screenshot({ path: `${OUT}/closed-1024-${colorScheme}.png` })
      }
      await toggle.click()
      await fits(page, 'panel reopened')
      for (const width of [1280, 1024, 900, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 })
        await fits(page, `open at ${width}`)
      }

      // A drag still held while the window crosses a breakpoint that removes its handle ends there instead of staying held.
      for (const selector of ['.inspector-resize', '.sidebar-resize']) {
        const box = (await page.locator(selector).boundingBox())!
        await page.mouse.move(box.x + 3, box.y + 100)
        await page.mouse.down()
        await page.mouse.move(box.x + (selector === '.sidebar-resize' ? 80 : -80), box.y + 100)
        await page.setViewportSize({ width: 900, height: 900 })
        await page.mouse.up()
        await expect.poll(() => page.locator('.app-shell').getAttribute('data-resizing')).toBeNull()
        await fits(page, `${selector} cut short at 900`)
        await page.setViewportSize({ width: 1440, height: 900 })
        await expect.poll(() => page.locator('.app-shell').getAttribute('data-resizing')).toBeNull()
        await fits(page, `${selector} cut short, back at 1440`)
      }
      await context.close()
    }
  } finally {
    await browser.close()
    await host.close()
  }
}, 240_000)
