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
      // Left to right: the Harness it left, the track, the one that took over; under it what went across.
      expect(await line.innerText()).toMatch(/First Agent[\s\S]*Second Agent[\s\S]*带着前 1 轮的记录/u)
      expect(await line.getAttribute('aria-label')).toBe('从 First Agent 换到 Second Agent')
      const [left, track, right] = await Promise.all([
        line.locator('.move-side').first().boundingBox(),
        line.locator('.move-track').boundingBox(),
        line.locator('.move-side.is-next').boundingBox(),
      ])
      expect(left!.x + left!.width).toBeLessThanOrEqual(track!.x + 1)
      expect(track!.x + track!.width).toBeLessThanOrEqual(right!.x + 1)
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

  it('moves on from the session itself: another Harness in its Harness menu, a message, and the three read as one', async () => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: 'light' })
    await page.reload()
    await connected(page)
    await page.locator(`[data-task-id="${second}"]`).filter({ visible: true }).first().click()
    await page.locator('.move-line').waitFor()
    await page.getByRole('button', { name: 'Harness：Second Agent', exact: true }).filter({ visible: true }).first().click()
    await page.getByRole('button', { name: '换到 First Agent 继续', exact: true }).click()
    // The conversation stays in view: everything said so far, then a line that says where the next message goes, with
    // the way back. The input under it already has the Harness; no headline asks a new question.
    const home = page.locator('.workbench-home')
    const pending = home.locator('.move-line[data-pending]')
    await pending.waitFor()
    expect(await pending.innerText()).toMatch(/Second Agent[\s\S]*First Agent[\s\S]*下一条消息起换过去[\s\S]*取消/u)
    await home.locator('.move-history').getByText('said on the second', { exact: false }).first().waitFor()
    await home.locator('.move-history').getByText('said on the first', { exact: false }).first().waitFor()
    expect(await home.locator('.home-headline').count()).toBe(0)
    expect(await home.locator('.fork-notice').count()).toBe(0)
    await home.getByRole('button', { name: 'Harness：First Agent', exact: true }).waitFor()
    const [line, input] = await Promise.all([pending.boundingBox(), home.locator('form.composer').boundingBox()])
    expect(line!.y + line!.height).toBeLessThanOrEqual(input!.y + 1)
    await page.screenshot({ path: `${OUTPUT}/moving--1440--light.png`, animations: 'disabled' })
    // 取消 goes back to the session as it was, on its own Harness.
    await pending.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: 'Harness：Second Agent', exact: true }).filter({ visible: true }).first().waitFor()
    expect(await page.locator('.move-line[data-pending]').count()).toBe(0)
    await page.getByRole('button', { name: 'Harness：Second Agent', exact: true }).filter({ visible: true }).first().click()
    await page.getByRole('button', { name: '换到 First Agent 继续', exact: true }).click()
    await pending.waitFor()
    await home.locator('.composer textarea').fill('echo back on the first')
    await page.keyboard.press('Meta+Enter')
    await expect.poll(async () => (await owner.json<AppSnapshot>('snapshot')).tasks.length, { timeout: 20_000 }).toBe(3)
    const third = (await owner.json<AppSnapshot>('snapshot')).tasks.find(task => task.id !== first && task.id !== second)!
    await settled(third.id)
    const moved = (await detail(third.id)).summary
    expect(moved.forkOf).toMatchObject({ taskId: second, moved: { from: 'fake-two' } })
    expect(moved.title).toBe('换过 Harness 的会话')
    // Both lines, each over what was said before it, and still one row in the list.
    await expect.poll(() => page.locator('.move-line').count()).toBe(2)
    const lines = await page.locator('.move-line').allInnerTexts()
    expect(lines[0]).toMatch(/First Agent[\s\S]*Second Agent/u)
    expect(lines[1]).toMatch(/Second Agent[\s\S]*First Agent/u)
    await page.locator('.move-history').first().getByText('said on the first', { exact: false }).first().waitFor()
    await expect.poll(() => page.locator('[data-task-id]').filter({ visible: true }).count()).toBe(1)
    await page.screenshot({ path: `${OUTPUT}/moved-twice--1440--light.png`, animations: 'disabled' })
  })
})
