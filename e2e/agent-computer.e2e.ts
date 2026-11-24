import { chromium, type Browser, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { expect, it } from 'vitest'
import type { AgentComputer, AppSnapshot, Automation, AutomationDetail, CustomAgent, DeviceScope } from '@latch/protocol'
import type { TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, reachable } from './helpers/layout.ts'
import { stillMotion } from './helpers/visual.ts'

const OUT = 'test-results/agent-computer'
const pad = (value: number) => String(value).padStart(2, '0')
const profileTabs = ['动态', '资料库', '记忆', '运行设置'] as const
const profileTab = (profile: Locator, name: (typeof profileTabs)[number]) => profile.getByRole('tab', { name, exact: true })

/** A browser with the full data scope, which an Agent's 「电脑」 needs. */
async function fullScopeBrowser(page: Page, host: TestHost, owner: TestDevice, name: string, scopes?: DeviceScope[]) {
  await enrollBrowser(page, host, { name })
  const id = host.host.security.devices.list().find(device => device.name === name)!.id
  const body = { dataScope: 'all', ...(scopes ? { scopes } : {}) }
  expect((await owner.confirmed(`devices/${id}`, { method: 'PATCH', body })).status).toBe(200)
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
      .getByRole('button', { name: /^晨报助手/u })
      .click()
  } else if (width < 1024) {
    await page.getByRole('button', { name: '我的 Agent', exact: true }).filter({ visible: true }).first().click()
    await page
      .getByRole('list', { name: '我的 Agent', exact: true })
      .getByRole('button', { name: /^晨报助手/u })
      .first()
      .click()
  } else {
    await page.getByRole('radio', { name: '我的 Agent', exact: true }).first().click()
    await page
      .getByRole('navigation', { name: '我的 Agent', exact: true })
      .getByRole('button', { name: /^晨报助手/u })
      .first()
      .click()
  }
  await page.locator('.agent-frame').first().waitFor()
  await page.getByRole('button', { name: '晨报助手 的资料', exact: true }).first().click()
  const profile = page.getByRole('region', { name: '晨报助手 的资料', exact: true }).last()
  await profileTab(profile, '动态').waitFor()
  return profile
}

it('「运行设置」 contains the computer and per-Agent switches, reads back changes, and preserves the missed-run action and permissions', async () => {
  await mkdir(OUT, { recursive: true })
  // The Host's clock, moved forward while the Mac "sleeps" past a scheduled time.
  let shift = 0
  const host = await startTestHost({ hostName: '晨报测试电脑', now: () => Date.now() + shift })
  let browser: Browser | undefined
  const report = (body: unknown) => host.raw('unix', 'api/host/state', { method: 'POST', body })
  try {
    browser = await chromium.launch(browserLaunchOptions())
    const owner = await host.enroll({ listener: 'unix' })
    // A missed background run requires a Harness within the Host's unattended ceiling.
    const agent = await owner.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: { requestId: randomUUID(), name: '晨报助手', description: '每天早上写一页晨报', harnessId: 'standard', mode: 'agent' },
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
    const profile = await openProfile(page, 1440)
    const computer = profile.getByRole('group', { name: '电脑' })
    const notifications = profile.getByRole('group', { name: '通知' })
    const mcp = profile.getByRole('group', { name: 'MCP', exact: true })
    expect(await profileTab(profile, '动态').getAttribute('aria-selected')).toBe('true')
    expect(await computer.or(notifications).count()).toBe(0)
    await profileTab(profile, '动态').press('End')
    await expect.poll(() => profileTab(profile, '运行设置').getAttribute('aria-selected')).toBe('true')
    await mcp.getByText('没有 MCP 服务器', { exact: true }).waitFor()
    for (const name of ['动态', '资料库', '记忆'] as const) {
      const tab = profileTab(profile, name)
      await tab.click()
      await expect.poll(() => tab.getAttribute('aria-selected')).toBe('true')
      await expect.poll(() => computer.or(notifications).or(mcp).count()).toBe(0)
    }
    await profileTab(profile, '运行设置').click()
    await computer.getByText('在线', { exact: true }).waitFor()
    await expect.poll(() => computer.textContent()).not.toMatch(/永远在线|always on/iu)

    // 到点前后保持唤醒: stored on the Host for this Agent; without the desktop app it says it has no effect.
    const keepAwake = computer.getByRole('switch', { name: '到点前后保持唤醒' })
    expect(await keepAwake.getAttribute('aria-checked')).toBe('false')
    await keepAwake.click()
    await expect.poll(async () => (await agentNow()).keepAwakeForSchedules).toBe(true)
    await computer.getByText('Latch 应用没有运行，现在不起作用').waitFor()
    // The desktop app reports what it keeps awake: the section says so, and the note goes.
    expect((await report({ state: 'desktop', keepAwake: 'schedule' })).status).toBe(200)
    await computer.getByText('保持唤醒中', { exact: true }).waitFor()
    await computer.getByText('Latch 应用运行时有效').waitFor()
    await page.screenshot({ path: `${OUT}/kept-awake-1440.png` })

    // 通知 › 完成 off: stored on the Host, which the desktop app reads before it notifies.
    const completion = notifications.getByRole('switch', { name: '完成', exact: true })
    expect(await completion.getAttribute('aria-checked')).toBe('true')
    await completion.click()
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
    await openProfile(page, 1440)
    await profileTab(profile, '运行设置').click()
    const section = profile.getByRole('group', { name: '电脑' })
    await section.getByText('错过 1 次').waitFor()
    await section.getByText(/上次唤醒 /u).waitFor()
    await expect.poll(() => keepAwake.getAttribute('aria-checked')).toBe('true')
    await expect.poll(() => completion.getAttribute('aria-checked')).toBe('false')
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
        const sized = await browser.newContext({
          viewport: { width, height },
          colorScheme: scheme,
          reducedMotion: 'reduce',
          isMobile: width < 1024,
          hasTouch: width < 1024,
        })
        await stillMotion(sized)
        const view = await sized.newPage()
        view.setDefaultTimeout(20_000)
        await fullScopeBrowser(view, host, owner, `电脑 ${width} ${scheme}`)
        const panel = await openProfile(view, width)
        const tablist = panel.getByRole('tablist')
        expect(await tablist.getByRole('tab').allTextContents()).toEqual(profileTabs)
        for (const name of profileTabs) {
          const tab = profileTab(panel, name)
          await reachable(tab)
          await noHorizontalOverflow(view, tab)
        }
        await noHorizontalOverflow(view, tablist)
        await panel.getByRole('group', { name: '即将进行' }).getByText('晨报', { exact: true }).waitFor()
        await view.mouse.move(0, 0)
        await view.screenshot({ path: `${OUT}/activity-${width}-${scheme}.png`, animations: 'disabled', caret: 'hide' })
        await profileTab(panel, '运行设置').click()
        const group = panel.getByRole('group', { name: '电脑' })
        await group.getByText('错过 1 次').waitFor()
        await still(view)
        await noHorizontalOverflow(view)
        await view.mouse.move(0, 0)
        await view.screenshot({ path: `${OUT}/run-settings-${width}-${scheme}.png`, animations: 'disabled', caret: 'hide' })
        if (width === 320) {
          await panel.getByRole('group', { name: '通知' }).scrollIntoViewIfNeeded()
          await view.screenshot({ path: `${OUT}/notifications-${width}-${scheme}.png`, animations: 'disabled', caret: 'hide' })
        }
        await sized.close()
      }

    const viewing = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const viewer = await viewing.newPage()
    viewer.setDefaultTimeout(20_000)
    await fullScopeBrowser(viewer, host, owner, '只读电脑设置', ['view'])
    const viewingProfile = await openProfile(viewer, 1440)
    await profileTab(viewingProfile, '运行设置').click()
    await viewingProfile.getByText('错过 1 次').waitFor()
    expect(await viewingProfile.getByRole('switch', { name: '到点前后保持唤醒', exact: true }).isDisabled()).toBe(true)
    const viewingNotifications = viewingProfile.getByRole('group', { name: '通知' })
    expect(await viewingNotifications.getByRole('switch', { disabled: true }).count()).toBe(3)
    expect(await viewingProfile.getByRole('button', { name: '立即运行', exact: true }).count()).toBe(0)
    await viewing.close()

    // 立即运行 is a real run: once it is recorded, the missed time is no longer counted.
    await runNow.click()
    await expect
      .poll(async () => (await owner.json<AutomationDetail>(`automations/${automation.id}`)).runs[0]?.trigger, { timeout: 20_000 })
      .toBe('manual')
    await section.getByText('错过 1 次').waitFor({ state: 'detached' })
    expect((await owner.json<AgentComputer>(`custom-agents/${agent.id}/computer`)).missed).toEqual([])

    // The new Agent's role and instructions are written here; nothing is created until 创建.
    await page.locator('button:not([inert] *):visible', { hasText: '新建 Agent' }).first().click()
    await page.getByRole('list', { name: '候选' }).getByRole('button').first().click()
    const form = page.getByRole('form', { name: '新建 Agent' })
    expect(await form.getByRole('group', { name: '从模板开始', exact: true }).count()).toBe(0)
    await form.getByRole('textbox', { name: '名字', exact: true }).fill('会议纪要')
    await form.getByRole('textbox', { name: '职责', exact: true }).fill('把会后的决定整理成一页记录')
    await form.getByRole('button', { name: '多说几句' }).click()
    await form.getByRole('textbox', { name: '指令', exact: true }).fill('列出每项决定的负责人。')
    await still(page)
    await page.screenshot({ path: `${OUT}/creation-fields-1440.png` })
    expect((await owner.json<AppSnapshot>('snapshot')).customAgents).toHaveLength(1)
    await context.close()
  } finally {
    await browser?.close()
    await host.close()
  }
})
