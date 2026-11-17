import { chromium, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import type { AppSnapshot, Automation, AutomationDetail, CustomAgent, TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'
import { startTestHost } from './helpers/host.ts'

const OUTPUT = join('test-results', 'agent-helper')

async function shoot(page: Page, name: string, sizes: ReadonlyArray<readonly [number, 'light' | 'dark']>) {
  for (const [width, colorScheme] of sizes) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1000 })
    await page.emulateMedia({ colorScheme })
    await noHorizontalOverflow(page)
    await page.screenshot({ path: join(OUTPUT, `${name}--${width}-${colorScheme}.png`), animations: 'disabled' })
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.emulateMedia({ colorScheme: 'light' })
}
const SIZES = [
  [1440, 'light'],
  [1440, 'dark'],
  [820, 'light'],
  [390, 'light'],
] as const

it('an Agent speaks first, knows what you told 通用, and knows what its schedule did', async () => {
  const root = await mkdtemp(join(tmpdir(), 'latch-agent-helper-'))
  const cleanup: Array<() => Promise<unknown>> = []
  try {
    await mkdir(OUTPUT, { recursive: true })
    const host = await startTestHost({
      dataDir: join(root, 'host'),
      workspaceRoot: join(root, 'workspace'),
      uiDir: resolve(process.env.LATCH_E2E_UI_DIR ?? 'dist/web'),
    })
    cleanup.unshift(() => host.close())
    const owner = await host.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: { id: 'fake-helper', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_CAPS: 'resume' } },
    })
    // What the person confirmed in 通用.
    await owner.json('custom-agents/general/memories', { method: 'POST', body: { requestId: randomUUID(), content: '我对花生过敏' } })
    const agent = await owner.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: '小林',
        description: '查资料，写成一页摘要',
        harnessId: 'fake-helper',
        mode: 'agent',
        instructions: '',
        skills: [],
      },
    })
    await owner.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: '核对助手',
        description: '核对数字和出处',
        harnessId: 'standard',
        mode: 'chat',
        instructions: '',
        skills: [],
      },
    })

    const browser = await chromium.launch(browserLaunchOptions())
    cleanup.unshift(() => browser.close())
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
    cleanup.unshift(() => context.close())
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await enrollBrowser(page, host, { name: '助手' })
    const device = host.host.security.devices.list().find(item => item.name === '助手')!
    await owner.confirmedJson(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
    await page.reload()
    await connected(page)
    await page.getByRole('radio', { name: '我的 Agent', exact: true }).filter({ visible: true }).click()

    // The page is a list of helpers: faces, what each does or last did; no lanes of zeros.
    const people = page.getByRole('navigation', { name: '全部 Agent', exact: true })
    await people.getByRole('button', { name: /^小林/u }).waitFor()
    expect(await page.locator('.work-overview-group-heading').filter({ hasText: '在工作' }).count()).toBe(0)
    expect(await page.getByText('等你处理', { exact: true }).filter({ visible: true }).count()).toBe(0)
    await shoot(page, 'agents-page', SIZES)

    // The empty chat: the Agent's opening, with three things to ask.
    await people.getByRole('button', { name: /^小林/u }).click()
    const opening = page.getByRole('region', { name: '小林的开场' })
    await opening.waitFor()
    // The header says who it is; the opening does not repeat it.
    expect(await opening.getByText('查资料，写成一页摘要').count()).toBe(0)
    const actions = opening.getByRole('group', { name: '可以这样开始' }).getByRole('button')
    expect(await actions.count()).toBe(3)
    // A Harness Latch has no card for: what it is for, and what works on any Harness; never a folder or command it may lack.
    expect(await actions.allTextContents()).toEqual(['交给你一件事', '记住一件事', '你能帮我做什么'])
    await shoot(page, 'chat-opening', SIZES)

    // A click fills the input and sends nothing.
    const input = page.getByRole('textbox', { name: '给小林发消息', exact: true })
    await opening.getByRole('button', { name: '记住一件事' }).click()
    expect(await input.inputValue()).toBe('记住：')
    await opening.getByRole('button', { name: '交给你一件事' }).click()
    expect(await input.inputValue()).toBe('记住：\n查资料，写成一页摘要：')
    expect((await owner.json<AppSnapshot>('snapshot')).tasks).toHaveLength(0)

    // Its first turn carries what the person confirmed in 通用 (the fake agent echoes what it received).
    await input.fill('今晚吃什么')
    await page.getByRole('button', { name: '发送', exact: true }).filter({ visible: true }).click()
    const chatOf = async () => (await owner.json<AppSnapshot>('snapshot')).agentChats?.[agent.id]
    await expect.poll(async () => (await chatOf())?.state, { timeout: 15_000 }).toBe('ready')
    const sessionId = ((await chatOf()) as { sessionId: string }).sessionId
    const reply = async () =>
      (await owner.json<TaskDetail>(`tasks/${sessionId}`)).messages.filter(message => message.role === 'assistant').at(-1)?.text ?? ''
    await expect.poll(reply, { timeout: 15_000 }).toContain('我对花生过敏')
    await page
      .getByText(/我对花生过敏/u)
      .filter({ visible: true })
      .first()
      .waitFor()

    // A run of its schedule, then the next chat turn carries the digest of it, not its reply.
    const schedule = await owner.json<Automation>('automations', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        customAgentId: agent.id,
        name: '晨报',
        prompt: 'echo 晨报正文',
        schedule: { kind: 'daily', time: '09:00' },
        notify: false,
        enabled: false,
      },
    })
    await owner.json(`automations/${schedule.id}/run`, { method: 'POST', body: { requestId: randomUUID() } })
    await expect
      .poll(async () => (await owner.json<AutomationDetail>(`automations/${schedule.id}`)).automation.lastRun?.state, { timeout: 15_000 })
      .toBe('completed')
    const chatInput = page.getByRole('textbox', { name: '继续对话', exact: true })
    await chatInput.fill('晨报写了吗')
    await page.getByRole('button', { name: '发送', exact: true }).filter({ visible: true }).click()
    await expect.poll(reply, { timeout: 15_000 }).toContain('定时「晨报」立即运行 · 完成')
    const last = await reply()
    expect(last).toContain('来自外部内容')
    expect(last).not.toContain('晨报正文')
    await page
      .getByText(/定时「晨报」立即运行/u)
      .filter({ visible: true })
      .first()
      .waitFor()
    await page.screenshot({ path: join(OUTPUT, 'chat-digest--1440-light.png'), animations: 'disabled' })
    // Back on the page: the helper that has talked shows what it last worked on, and when.
    await page.getByRole('button', { name: '总览', exact: true }).filter({ visible: true }).click()
    const row = page.getByRole('navigation', { name: '全部 Agent', exact: true }).getByRole('button', { name: /^小林/u })
    await row.locator('time').waitFor()
    expect(await row.locator('.space-agent-line').textContent()).toBe('今晚吃什么')
    // One action per row: its chat, while nothing waits.
    expect(
      await page.locator(`[data-helper-id="${agent.id}"]`).locator('xpath=..').getByRole('button', { name: '聊天', exact: true }).count(),
    ).toBe(1)
    // No detached chip and input above the list.
    expect(await page.locator('.agents-home').getByRole('button', { name: '发给谁', exact: true }).count()).toBe(0)
    await shoot(page, 'agents-page-after', [
      [1440, 'light'],
      [1440, 'dark'],
      [820, 'light'],
      [390, 'light'],
      [390, 'dark'],
    ])
  } finally {
    const failures: unknown[] = []
    for (const close of cleanup) {
      try {
        await close()
      } catch (error) {
        failures.push(error)
      }
    }
    await rm(root, { recursive: true, force: true })
    if (failures.length) throw failures[0]
  }
}, 120_000)
