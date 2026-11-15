import { chromium, type Browser, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import type {
  AppSnapshot,
  Automation,
  AutomationDetail,
  AutomationList,
  CustomAgent,
  MemoryProposalList,
  TaskDetail,
  WorkspaceInfo,
} from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'
import { stillMotion } from './helpers/visual.ts'

const OUT = 'test-results/agent-activity'

/** A browser with the full data scope, which Agents need. */
async function fullScopeBrowser(page: Page, host: TestHost, owner: TestDevice, name: string) {
  await enrollBrowser(page, host, { name })
  const id = host.host.security.devices.list().find(device => device.name === name)!.id
  expect((await owner.confirmed(`devices/${id}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
  await page.reload()
  await connected(page)
}
const still = (page: Page) =>
  page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined))))
const resultCard = (page: Page) => page.getByRole('group', { name: '定时结果：早间精选' })
const proposalRow = (page: Page) => page.getByRole('group', { name: '定时提议' })
const profileOf = (page: Page) => page.getByRole('region', { name: '资讯 的资料', exact: true }).last()

/** Opens the conversation with 资讯 at any width: the phone's tab, the tablet's navigation rail, or the sidebar. */
async function openConversation(page: Page, width: number, name = '资讯') {
  const agent = new RegExp(name, 'u')
  if (width < 768) {
    const tab = page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的 Agent', exact: true })
    if (await tab.isVisible().catch(() => false)) await tab.click()
    await page.getByRole('list', { name: '我的 Agent', exact: true }).getByRole('button', { name: agent }).click()
  } else if (width < 1024) {
    // A tablet starts with the sidebar shut: the navigation rail's 我的 Agent opens its list.
    await page.getByRole('button', { name: '我的 Agent', exact: true }).filter({ visible: true }).click()
    await page.getByRole('list', { name: '我的 Agent', exact: true }).getByRole('button', { name: agent }).first().click()
  } else {
    await page.getByRole('radio', { name: '我的 Agent', exact: true }).first().click()
    await page.getByRole('navigation', { name: '我的 Agent', exact: true }).getByRole('button', { name: agent }).first().click()
  }
  await page.locator('.agent-frame').first().waitFor()
}

it('a run comes back to the conversation as a card, the Agent proposes a schedule the person saves, and 动态 and 资料库 show the run', async () => {
  await mkdir(OUT, { recursive: true })
  const host = await startTestHost({ uiDir: resolve(process.env.LATCH_E2E_UI_DIR ?? 'dist/web') })
  let browser: Browser | undefined
  try {
    browser = await chromium.launch(browserLaunchOptions())
    const owner = await host.enroll({ listener: 'unix' })
    // The fake ACP Agent mounts MCP servers as DeepSeek Harness does, so it can call the skills server's propose_schedule.
    await owner.confirmed('agents', {
      method: 'POST',
      body: {
        id: 'fake-agent',
        name: 'Fake Agent',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_MCP: 'dsh', FAKE_ACP_LOG: join(host.root, 'acp.log') },
      },
    })
    const folder = join(host.root, 'news')
    await mkdir(folder)
    expect((await owner.addFolders({ paths: [folder], name: 'news' })).status).toBeLessThan(300)
    const project = (await owner.json<{ workspaces: WorkspaceInfo[] }>('workspaces')).workspaces.find(item => item.name === 'news')!
    const agent = await owner.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: '资讯',
        description: '整理新闻',
        harnessId: 'fake-agent',
        mode: 'agent',
        defaultProjectId: project.id,
      },
    })
    // Its schedule: each run edits a file and runs a command that writes another.
    const schedule = await owner.json<Automation>('automations', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: '早间精选',
        customAgentId: agent.id,
        projectId: project.id,
        prompt: 'shell-edit',
        schedule: { kind: 'daily', time: '08:00' },
        enabled: false,
        notify: false,
      },
    })

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    await stillMotion(context)
    const page = await context.newPage()
    page.setDefaultTimeout(20_000)
    await fullScopeBrowser(page, host, owner, '动态 1440')
    await openConversation(page, 1440)

    // A topic in which the Agent proposes a schedule: a row, nothing created yet.
    const input = page.getByRole('textbox', { name: '给资讯发消息', exact: true })
    await input.fill('schedule 晚间精选 daily 20:00 整理今天的新闻')
    await input.press('Meta+Enter')
    await proposalRow(page).getByText('晚间精选 · 每天 20:00').waitFor()
    expect((await owner.json<AutomationList>('automations')).automations).toHaveLength(1)
    const topic = (await owner.json<AppSnapshot>('snapshot')).tasks.find(
      task => task.agent?.customAgentId === agent.id && !task.automationId,
    )!
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${topic.id}`)).summary.status).toBe('idle')
    // The turn's file watch has settled, so what the run writes next is not observed as this turn's.
    await expect
      .poll(async () => (await owner.json<TaskDetail>(`tasks/${topic.id}`)).messages.some(message => message.outputsPending), {
        timeout: 10_000,
      })
      .toBe(false)

    // A run settles: its card appears in the current topic, with the outcome, the reply and the files.
    await owner.json(`automations/${schedule.id}/run`, { method: 'POST', body: { requestId: randomUUID() } })
    await expect
      .poll(async () => (await owner.json<AutomationDetail>(`automations/${schedule.id}`)).automation.lastRun?.state, { timeout: 20_000 })
      .toBe('completed')
    const card = resultCard(page)
    await card.waitFor()
    await card.getByText('已完成').waitFor()
    await card.getByRole('button', { name: 'agent-edit.txt' }).waitFor()
    await card.getByText('edited', { exact: true }).waitFor()
    // After the turn, the 想定时 row it proposed comes first, then the results of what ran since.
    const order = await page.evaluate(() => {
      const proposal = document.querySelector('.memory-proposals')
      const result = [...document.querySelectorAll('[role="group"]')].find(item => item.getAttribute('aria-label')?.startsWith('定时结果'))
      return proposal && result ? proposal.compareDocumentPosition(result) & Node.DOCUMENT_POSITION_FOLLOWING : -1
    })
    expect(order).toBeGreaterThan(0)
    const detail = await owner.json<TaskDetail>(`tasks/${topic.id}`)
    expect(detail.results).toHaveLength(1)
    // The card is no message: the topic's own history is the two turns of the conversation.
    expect(detail.messages.filter(message => message.role === 'user')).toHaveLength(1)
    await card.scrollIntoViewIfNeeded()
    await still(page)
    await page.screenshot({ path: `${OUT}/card-1440-light.png` })

    // 打开运行 opens the run's session.
    const run = (await owner.json<AutomationDetail>(`automations/${schedule.id}`)).automation.lastRun!.sessionId!
    await card.getByRole('button', { name: '打开运行', exact: true }).click()
    await page.locator(`[data-task-id="${run}"][aria-current="page"]`).waitFor()
    await page.getByText('shell-edit').first().waitFor()

    // Back in the topic, 打开 on the proposal opens the schedule editor filled in from it; saving it creates the schedule.
    await openConversation(page, 1440)
    await proposalRow(page).getByRole('button', { name: '打开', exact: true }).click()
    const profile = profileOf(page)
    const form = profile.getByRole('form', { name: '新建定时任务' })
    await form.waitFor()
    expect(await form.getByLabel('名称').inputValue()).toBe('晚间精选')
    expect(await form.getByLabel('几点').inputValue()).toBe('20:00')
    expect(await form.getByLabel('每次的输入').inputValue()).toBe('整理今天的新闻')
    // New schedules start at home; this run's shared project is an explicit choice by the person.
    await form.getByRole('button', { name: /^项目.*家/u }).waitFor()
    await form.getByRole('button', { name: /^项目/u }).click()
    await page.getByRole('menuitemradio', { name: 'news', exact: true }).click()
    await still(page)
    await page.screenshot({ path: `${OUT}/editor-prefilled-1440-light.png` })
    await form.getByRole('button', { name: '保存为关闭', exact: true }).click()
    await expect.poll(async () => (await owner.json<AutomationList>('automations')).automations.length).toBe(2)
    const created = (await owner.json<AutomationList>('automations')).automations.find(item => item.name === '晚间精选')!
    expect(created).toMatchObject({
      enabled: false,
      customAgentId: agent.id,
      projectId: project.id,
      prompt: '整理今天的新闻',
      schedule: { kind: 'daily', time: '20:00' },
    })
    const proposals = await owner.json<MemoryProposalList>(`custom-agents/${agent.id}/proposals`)
    expect(proposals.proposals[0]).toMatchObject({ kind: 'schedule', state: 'saved', automationId: created.id })
    await proposalRow(page).getByText('已保存').waitFor()

    // 动态: the run's card, the proposal saved and the topic, newest first. 资料库: the run's files, opened in the preview.
    await profile.getByRole('button', { name: '资讯', exact: true }).click()
    await profile.getByRole('radio', { name: '动态', exact: true }).click()
    await profile.getByText(/定时结果 · 早间精选/u).waitFor()
    await profile.getByText('提议定时').waitFor()
    await profile.getByText(/开始聊天 ·/u).waitFor()
    await still(page)
    await page.screenshot({ path: `${OUT}/activity-1440-light.png` })
    await profile.getByRole('radio', { name: '资料库', exact: true }).click()
    const group = profile.getByRole('region', { name: '早间精选' })
    await group.getByRole('button', { name: 'agent-edit.txt' }).waitFor()
    await group.getByRole('button', { name: 'command-edit.txt' }).waitFor()
    // The topic changed nothing itself: what the run wrote into the shared folder is the run's, not the topic's.
    const topicTitle = (await owner.json<TaskDetail>(`tasks/${topic.id}`)).summary.title
    expect(await profile.locator('.agent-library-group').count()).toBe(1)
    expect(await profile.getByRole('region', { name: topicTitle }).count()).toBe(0)
    await still(page)
    await page.screenshot({ path: `${OUT}/library-1440-light.png` })
    await group.getByRole('button', { name: 'agent-edit.txt' }).click()
    await page.locator(`[data-task-id="${run}"][aria-current="page"]`).waitFor()
    await page.locator('.file-preview').filter({ hasText: 'edited by the agent' }).first().waitFor()
    await context.close()

    // An Agent with no topic: its run that broke off waits on its new topic, saying why, with 立即运行.
    const weekly = await owner.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: '周报',
        description: '每周汇总',
        harnessId: 'fake-agent',
        mode: 'agent',
        defaultProjectId: project.id,
      },
    })
    const failing = await owner.json<Automation>('automations', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: '周报汇总',
        customAgentId: weekly.id,
        projectId: project.id,
        prompt: 'crash',
        schedule: { kind: 'weekly', day: 5, time: '17:00' },
        enabled: false,
        notify: false,
      },
    })
    await owner.json(`automations/${failing.id}/run`, { method: 'POST', body: { requestId: randomUUID() } })
    await expect
      .poll(async () => (await owner.json<{ results: unknown[] }>(`custom-agents/${weekly.id}/results`)).results.length, {
        timeout: 20_000,
      })
      .toBe(1)

    // The card, the row and the profile at each width, light and dark.
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
        await fullScopeBrowser(view, host, owner, `动态 ${width} ${scheme}`)
        await openConversation(view, width)
        await resultCard(view).getByText('已完成').waitFor()
        await expect
          .poll(() =>
            resultCard(view)
              .scrollIntoViewIfNeeded()
              .then(
                () => true,
                () => false,
              ),
          )
          .toBe(true)
        await still(view)
        await noHorizontalOverflow(view)
        await view.screenshot({ path: `${OUT}/card-${width}-${scheme}.png` })
        await view.locator('.topbar').getByRole('button', { name: '资讯 的资料', exact: true }).first().click()
        const panel = profileOf(view)
        await panel.getByText(/定时结果 · 早间精选/u).waitFor()
        await still(view)
        await noHorizontalOverflow(view)
        await view.screenshot({ path: `${OUT}/activity-${width}-${scheme}.png` })
        await panel.getByRole('radio', { name: '资料库', exact: true }).click()
        await panel.getByRole('region', { name: '早间精选' }).waitFor()
        await still(view)
        await noHorizontalOverflow(view)
        await view.screenshot({ path: `${OUT}/library-${width}-${scheme}.png` })
        await sized.close()
        // A fresh window opens 周报, which has no topic: its card waits on the new topic.
        const fresh = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, reducedMotion: 'reduce' })
        await stillMotion(fresh)
        const other = await fresh.newPage()
        other.setDefaultTimeout(20_000)
        await fullScopeBrowser(other, host, owner, `周报 ${width} ${scheme}`)
        await openConversation(other, width, '周报')
        const failed = other.getByRole('group', { name: '定时结果：周报汇总' })
        await failed.getByText('已中断').waitFor()
        await failed.getByText(/进程意外退出/u).waitFor()
        await failed.getByRole('button', { name: '立即运行', exact: true }).waitFor()
        await still(other)
        await noHorizontalOverflow(other)
        await other.screenshot({ path: `${OUT}/waiting-failed-${width}-${scheme}.png` })
        await fresh.close()
      }
  } finally {
    await browser?.close()
    await host.close()
  }
})
