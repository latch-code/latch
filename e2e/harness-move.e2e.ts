import { chromium, type Browser, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppSnapshot, TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'

const OUTPUT = 'test-results/harness-move'

/**
 * A conversation that goes on with another Harness is one conversation: the session it left stands above a line that
 * names both, read only, and the list shows one row for the two.
 */
describe('a conversation that moved to another Harness', () => {
  let host: TestHost
  let owner: TestDevice
  let browser: Browser
  let page: Page
  let first = ''
  let second = ''

  const detail = (id: string) => owner.json<TaskDetail>(`tasks/${id}`)
  const settled = async (id: string) => {
    for (let tries = 0; (await detail(id)).summary.status !== 'idle'; tries++) {
      if (tries > 300) throw new Error('the session did not settle')
      await new Promise(done => setTimeout(done, 50))
    }
  }

  beforeAll(async () => {
    await mkdir(OUTPUT, { recursive: true })
    host = await startTestHost()
    owner = await host.enroll({ listener: 'unix' })
    for (const [id, name] of [
      ['fake-one', 'First Agent'],
      ['fake-two', 'Second Agent'],
    ])
      await owner.confirmedJson('agents', { method: 'POST', body: { id, name, command: process.execPath, args: [FAKE_ACP_AGENT] } })
    first = (
      await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { harnessId: 'fake-one', prompt: 'echo said on the first', requestId: randomUUID() },
      })
    ).sessionId
    await settled(first)
    await owner.json(`tasks/${first}`, { method: 'PATCH', body: { title: '换过 Harness 的会话' } })
    const last = (await detail(first)).messages.at(-1)!.id
    second = (
      await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: {
          harnessId: 'fake-two',
          prompt: 'echo said on the second',
          requestId: randomUUID(),
          forkOf: { taskId: first, upToMessageId: last, moved: true },
        },
      })
    ).sessionId
    await settled(second)
    browser = await chromium.launch(browserLaunchOptions())
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
    await enrollBrowser(page, host)
    await connected(page)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await host?.close()
  })

  it('records which Harness it left, keeps its name, and lists the two as one', async () => {
    const summary = (await detail(second)).summary
    expect(summary.forkOf).toMatchObject({ taskId: first, moved: { from: 'fake-one' } })
    expect(summary.title).toBe('换过 Harness 的会话')
    const tasks = (await owner.json<AppSnapshot>('snapshot')).tasks
    expect(tasks.map(task => task.id).sort()).toEqual([first, second].sort())
    // One row in the list: the session it went on in.
    const rows = page.locator('[data-task-id]').filter({ visible: true })
    await expect.poll(() => rows.count()).toBe(1)
    expect(await rows.first().getAttribute('data-task-id')).toBe(second)
  })

  it('shows what was said before above a line naming both, at three widths', async () => {
    for (const [width, height, theme] of [
      [1440, 900, 'dark'],
      [1440, 900, 'light'],
      [820, 1100, 'light'],
      [390, 844, 'dark'],
    ] as const) {
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: theme })
      await page.reload()
      await connected(page)
      await page.keyboard.press('Meta+k')
      const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
      await palette.getByRole('searchbox').fill('换过 Harness 的会话')
      await palette.getByRole('option', { name: '换过 Harness 的会话', exact: true }).click()
      const line = page.locator('.move-line')
      await line.waitFor()
      expect(await line.innerText()).toMatch(/换了 Harness[\s\S]*First Agent[\s\S]*Second Agent/u)
      const before = page.locator('.move-history')
      await before.getByText('said on the first', { exact: false }).first().waitFor()
      // The earlier record is above the line, the new session's below it.
      const [above, at, below] = await Promise.all([
        before.boundingBox(),
        line.boundingBox(),
        page.locator('.transcript-content > .transcript, .transcript-content .turn').last().boundingBox(),
      ])
      expect(above!.y).toBeLessThan(at!.y)
      expect(below!.y + below!.height).toBeGreaterThan(at!.y)
      // Read only: nothing above the line stops, retries or forks.
      expect(await before.getByRole('button', { name: /停止|重试|从这里分叉/u }).count()).toBe(0)
      await noHorizontalOverflow(page)
      await page.screenshot({ path: `${OUTPUT}/moved--${width}--${theme}.png`, animations: 'disabled' })
    }
  })
})
