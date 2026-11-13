import { chromium, type Browser, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { AgentComputer, AppSnapshot, Automation, AutomationDetail, CustomAgent } from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'
import { stillMotion } from './helpers/visual.ts'

const OUT = 'test-results/agent-computer'
const pad = (value: number) => String(value).padStart(2, '0')

/** A browser with the full data scope, which an Agent's 「电脑」 needs. */
async function fullScopeBrowser(page: Page, host: TestHost, owner: TestDevice, name: string) {
  await enrollBrowser(page, host, { name })
  const id = host.host.security.devices.list().find(device => device.name === name)!.id
  expect((await owner.confirmed(`devices/${id}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
  await page.reload()
  await connected(page)
}
const still = (page: Page) =>
  page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined))))

/** The conversation with 晨报助手 at any width, then its profile. */
async function openProfile(page: Page, width: number) {
  if (width < 768) {
    const tab = page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的 Agent', exact: true })
    if (await tab.isVisible().catch(() => false)) await tab.click()
    await page
      .getByRole('list', { name: '我的 Agent', exact: true })
      .getByRole('button', { name: /晨报助手/u })
      .click()
  } else if (width < 1024) {
    await page.getByRole('button', { name: '我的 Agent', exact: true }).filter({ visible: true }).first().click()
    await page
      .getByRole('list', { name: '我的 Agent', exact: true })
      .getByRole('button', { name: /晨报助手/u })
      .first()
      .click()
  } else {
    await page.getByRole('radio', { name: '我的 Agent', exact: true }).first().click()
    await page
      .getByRole('navigation', { name: '我的 Agent', exact: true })
      .getByRole('button', { name: /晨报助手/u })
      .first()
      .click()
  }
  await page.locator('.agent-frame').first().waitFor()
  await page.getByRole('button', { name: '晨报助手 的资料', exact: true }).first().click()
  const profile = page.getByRole('region', { name: '晨报助手 的资料', exact: true }).last()
  await profile.getByRole('group', { name: '电脑' }).waitFor()
  return profile
}

it('「电脑」 shows the computer as the Host recorded it, a missed time with 立即运行, and the per-Agent switches', async () => {
  await mkdir(OUT, { recursive: true })
  // The Host's clock, moved forward while the Mac "sleeps" past a scheduled time.
  let shift = 0
  const host = await startTestHost({ now: () => Date.now() + shift })
  let browser: Browser | undefined
  const report = (body: unknown) => host.raw('unix', 'api/host/state', { method: 'POST', body })
  try {
    browser = await chromium.launch(browserLaunchOptions())
    const owner = await host.enroll({ listener: 'unix' })
    await owner.confirmed('agents', {
      method: 'POST',
      body: {
        id: 'fake-agent',
        name: 'Fake Agent',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_LOG: join(host.root, 'acp.log') },
      },
    })
    const agent = await owner.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: { requestId: randomUUID(), name: '晨报助手', description: '每天早上写一页晨报', harnessId: 'fake-agent' },
    })
    const at = new Date(Date.now() + 10 * 60_000)
    const automation = await owner.json<Automation>('automations', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: '晨报',
        customAgentId: agent.id,
        prompt: '写今天的晨报',
        schedule: { kind: 'daily', time: `${pad(at.getHours())}:${pad(at.getMinutes())}` },
        notify: true,
      },
    })
    const agentNow = async () => (await owner.json<AppSnapshot>('snapshot')).customAgents!.find(item => item.id === agent.id)!

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    await stillMotion(context)
    const page = await context.newPage()
    page.setDefaultTimeout(20_000)
    await fullScopeBrowser(page, host, owner, '电脑 1440')
    let profile = await openProfile(page, 1440)
    const computer = profile.getByRole('group', { name: '电脑' })
    await computer.getByText('在线', { exact: true }).waitFor()
    await expect.poll(() => computer.textContent()).not.toMatch(/永远在线|always on/iu)

    // 到点前后保持唤醒: stored on the Host for this Agent; without the desktop app it says it has no effect.
    await computer.getByRole('switch', { name: '到点前后保持唤醒' }).click()
    await expect.poll(async () => (await agentNow()).keepAwakeForSchedules).toBe(true)
    await computer.getByText('Latch 应用没有运行，现在不起作用').waitFor()
    // The desktop app reports what it keeps awake: the section says so, and the note goes.
    expect((await report({ state: 'desktop', keepAwake: 'schedule' })).status).toBe(200)
    await computer.getByText('保持唤醒中', { exact: true }).waitFor()
    await computer.getByText('Latch 应用运行时有效').waitFor()
    await page.screenshot({ path: `${OUT}/kept-awake-1440.png` })

    // 通知 › 完成 off: stored on the Host, which the desktop app reads before it notifies.
    const notifications = profile.getByRole('group', { name: '通知' })
    await notifications.getByRole('switch', { name: '完成' }).click()
    await expect.poll(async () => (await agentNow()).notifications).toEqual({ completed: false, failed: true, waiting: true })

    // The Mac sleeps past the time: the scheduler records the missed time, the wake report gives its cause.
    expect((await report({ state: 'sleeping' })).status).toBe(200)
    shift = Date.parse(automation.nextRunAt!) - Date.now() + 5 * 60_000
    await expect
      .poll(async () => (await owner.json<AgentComputer>(`custom-agents/${agent.id}/computer`)).missed.length, { timeout: 15_000 })
      .toBe(1)
    expect((await report({ state: 'awake' })).status).toBe(200)
    expect((await report({ state: 'desktop', keepAwake: null })).status).toBe(200)
    await page.reload()
    await connected(page)
    profile = await openProfile(page, 1440)
    const section = profile.getByRole('group', { name: '电脑' })
    await section.getByText('错过 1 次').waitFor()
    await section.getByText(/上次唤醒 /u).waitFor()
    const missed = section.getByRole('list', { name: '错过的定时' })
    await missed.getByText(/Mac 在睡眠/u).waitFor()
    const runNow = missed.getByRole('button', { name: '立即运行', exact: true })
    await runNow.waitFor()
    await still(page)
    await noHorizontalOverflow(page)
    await page.screenshot({ path: `${OUT}/missed-1440.png` })

    // The section at each width, light and dark.
    for (const scheme of ['light', 'dark'] as const)
      for (const [width, height] of [
        [320, 640],
        [390, 844],
        [768, 1024],
        [1440, 900],
      ] as const) {
        const sized = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, reducedMotion: 'reduce' })
        await stillMotion(sized)
        const view = await sized.newPage()
        view.setDefaultTimeout(20_000)
        await fullScopeBrowser(view, host, owner, `电脑 ${width} ${scheme}`)
        const panel = await openProfile(view, width)
        const group = panel.getByRole('group', { name: '电脑' })
        await group.getByText('错过 1 次').waitFor()
        await group.scrollIntoViewIfNeeded()
        await still(view)
        await noHorizontalOverflow(view)
        await view.screenshot({ path: `${OUT}/computer-${width}-${scheme}.png` })
        await panel.getByRole('group', { name: '通知' }).scrollIntoViewIfNeeded()
        await still(view)
        await view.screenshot({ path: `${OUT}/notifications-${width}-${scheme}.png` })
        await sized.close()
      }

    // 立即运行 is a real run: once it is recorded, the missed time is no longer counted.
    await runNow.click()
    await expect
      .poll(async () => (await owner.json<AutomationDetail>(`automations/${automation.id}`)).runs[0]?.trigger, { timeout: 20_000 })
      .toBe('manual')
    await section.getByText('错过 1 次').waitFor({ state: 'detached' })
    expect((await owner.json<AgentComputer>(`custom-agents/${agent.id}/computer`)).missed).toEqual([])

    // 职责模板 only fill the text of a new Agent; nothing is created until 创建.
    await page.getByRole('navigation', { name: '我的 Agent', exact: true }).getByRole('button', { name: '新建 Agent' }).first().click()
    await page.getByRole('list', { name: '候选' }).getByRole('button').first().click()
    const form = page.getByRole('form', { name: '新建 Agent' })
    await form.getByRole('group', { name: '从模板开始' }).getByRole('button', { name: '周报', exact: true }).click()
    await expect.poll(() => form.getByRole('textbox', { name: '名字' }).inputValue()).toBe('周报')
    await expect.poll(() => form.getByRole('textbox', { name: '职责' }).inputValue()).toBe('把这周做过的事写成一页周报')
    await form.getByRole('button', { name: '多说几句' }).click()
    await expect.poll(() => form.getByRole('textbox', { name: '指令' }).inputValue()).toMatch(/^根据我给你的记录/u)
    await still(page)
    await page.screenshot({ path: `${OUT}/templates-1440.png` })
    expect((await owner.json<AppSnapshot>('snapshot')).customAgents).toHaveLength(1)
    await context.close()
  } finally {
    await browser?.close()
    await host.close()
  }
})
