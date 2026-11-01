import { chromium, type Browser, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentSettings, TaskDetail } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { type TestDevice, FAKE_ACP_AGENT } from '@latch/testkit'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { expectUnmovedByInjectedStyles } from './helpers/security.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { openSection, openSettings, closeSettings } from './helpers/layout.ts'

const OUTPUT = 'test-results/permissions'

/**
 * A model that always calls a tool from a third-party plugin. The Host classifies
 * tools it does not know as high risk (R2), whatever the plugin declares.
 */
const highRiskFixture: HarnessPlugin = {
  id: 'r2-fixture',
  name: '高风险工具验收插件',
  version: '1.0.0',
  description: '仅测试使用。',
  activate(context) {
    context.registerTool({
      name: 'touch_marker',
      description: '测试用工具，不访问文件。',
      parameters: { type: 'object', properties: {} },
      requiresApproval: false,
      async execute() {
        return { text: 'marker touched' }
      },
    })
    context.registerProvider({
      id: 'r2-model',
      name: 'R2 fixture',
      model: 'fixture',
      async *stream({ messages }) {
        if (messages.at(-1)?.role === 'tool') {
          yield { type: 'text', text: '工具调用已结算。' }
          yield { type: 'finish', reason: 'stop' }
          return
        }
        yield { type: 'tool-call', call: { id: 'call-r2', name: 'touch_marker', arguments: {} } }
        yield { type: 'finish', reason: 'tool-calls' }
      },
    })
  },
}

describe('permission states in a browser', () => {
  let testHost: TestHost
  let browser: Browser
  let page: Page
  let local: TestDevice
  let remote: TestDevice

  beforeAll(async () => {
    testHost = await startTestHost({
      demo: true,
      uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
      plugins: [highRiskFixture],
    })
    browser = await chromium.launch(browserLaunchOptions())
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
    context.setDefaultTimeout(15_000)
    page = await context.newPage()
    await enrollBrowser(page, testHost, { name: '验收浏览器' })
    // The Host's own desktop (unix socket) and another browser device, both driven through the API.
    local = await testHost.enroll({ listener: 'unix', name: '本机桌面端' })
    remote = await testHost.enroll({ name: '另一台浏览器' })
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await testHost?.close()
  })

  /** A Latch 内置 card: 拒绝 asks what to do instead in the composer, and the second 拒绝 rejects without a note. */
  async function rejectWithoutNote(card: Locator): Promise<void> {
    await card.getByRole('button', { name: '拒绝', exact: true }).click()
  }
  async function open(sessionId: string): Promise<void> {
    await page.locator(`[data-task-id="${sessionId}"]`).click()
    await page.locator('.transcript-content').waitFor()
  }
  const detail = (id: string) => local.json<TaskDetail>(`tasks/${encodeURIComponent(id)}`)
  /** A session whose tool the Host classifies as high risk, once its approval waits. */
  async function startHighRisk(prompt: string): Promise<string> {
    const { sessionId } = await remote.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt, requestId: randomUUID(), mode: 'agent', model: { providerId: 'r2-model', model: 'fixture' } },
    })
    await expect.poll(async () => (await detail(sessionId)).approvals.length).toBe(1)
    return sessionId
  }

  it('shows a high-risk approval with the host-desktop hint and no allow button; reject still works', async () => {
    const { sessionId } = await remote.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: '写入标记', requestId: randomUUID(), mode: 'agent', model: { providerId: 'r2-model', model: 'fixture' } },
    })
    await expect.poll(async () => (await detail(sessionId)).approvals.length).toBe(1)
    expect((await detail(sessionId)).approvals[0]?.risk).toBe('R2')
    await open(sessionId)
    const card = page.locator('[data-approval-id]')
    await card.getByText('Latch 不认识的工具', { exact: true }).waitFor()
    await card.getByText('在 Mac 上的 Latch 里允许', { exact: true }).waitFor()
    expect(await card.getByRole('button', { name: /允许/ }).count()).toBe(0)
    await page.screenshot({ path: `${OUTPUT}/r2-browser-desktop.png`, fullPage: true, animations: 'disabled' })
    await rejectWithoutNote(card)
    await expect.poll(async () => (await detail(sessionId)).summary.status).toBe('idle')
    await card.waitFor({ state: 'detached' })
    // The drawer goes and the row says it: the state slot reads the record, 已拒绝 and its time in the hint ink, never 失败, and
    // nothing says it a second time.
    const row = page.locator('.tool-card', { has: page.locator('.tool-decision-words') })
    const record = row.locator('.tool-card-state .tool-decision-words')
    await record.waitFor()
    expect(await row.locator('.tool-card-state').getAttribute('class')).not.toContain('state-failed')
    expect(await record.textContent()).toMatch(/^已拒绝 · \d{2}:\d{2}$/u)
    expect(await record.getAttribute('title')).toContain('在其他设备上决定')
    expect(await row.locator('.tool-decision').count()).toBe(0)
    expect((await row.textContent())?.match(/已拒绝/gu)).toHaveLength(1)
    // A titled tool's row names it by its title; the plugin tool here has none, so its ID is the label itself.
    expect(await row.locator('.tool-card-name').count()).toBe(0)
    expect((await detail(sessionId)).messages.find(message => message.role === 'tool')?.tool?.decision).toMatchObject({
      outcome: 'rejected',
      via: 'other-device',
    })
    expect(await page.locator('.transcript-content').textContent()).not.toMatch(/APPROVAL_REJECTED|。。/u)
    // Captured once the turn has settled on the page: no live line, and the send button back in place of stop.
    await page.locator('.turn-phase').waitFor({ state: 'detached' })
    await page.getByRole('button', { name: '取消任务' }).waitFor({ state: 'detached' })
    await page.screenshot({ path: `${OUTPUT}/r2-rejected-record.png`, fullPage: true, animations: 'disabled' })
  })

  it('turns 拒绝 into 拒绝并发送 while typing, and hands what was written to Latch 内置 with the rejection', async () => {
    const { sessionId } = await remote.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: '生成需要审批的报告', requestId: randomUUID(), mode: 'agent', model: { providerId: 'demo', model: 'demo' } },
    })
    await expect.poll(async () => (await detail(sessionId)).approvals.length).toBe(1)
    await open(sessionId)
    const card = page.locator('[data-approval-id]')
    await card.getByRole('button', { name: '拒绝', exact: true }).waitFor()
    const note = page.getByRole('textbox', { name: '输入内容会拒绝并告诉 Agent 改做什么', exact: true })
    expect(await note.getAttribute('placeholder')).toBe('输入内容会拒绝并告诉 Agent 改做什么')
    // Enter with nothing written decides nothing.
    await note.press('Enter')
    expect((await detail(sessionId)).approvals).toHaveLength(1)
    await note.fill('改写到 docs/ 下')
    await card.getByRole('button', { name: '拒绝并发送', exact: true }).waitFor()
    await page.screenshot({ path: `${OUTPUT}/reject-note-typing.png`, fullPage: true, animations: 'disabled' })
    await note.press('Enter')
    await expect.poll(async () => (await detail(sessionId)).summary.status).toBe('idle')
    const settled = await detail(sessionId)
    expect(settled.messages.find(message => message.role === 'tool')?.tool?.decision).toMatchObject({ outcome: 'rejected' })
    expect(settled.messages.filter(message => message.role === 'assistant').at(-1)?.text).toContain('收到你的说明：「改写到 docs/ 下」')
    await page.getByText(/收到你的说明：「改写到 docs\/ 下」/u).waitFor()
    // What was written went with the rejection, not into the draft.
    const composer = page.getByRole('textbox', { name: '继续对话', exact: true })
    await composer.waitFor()
    expect(await composer.inputValue()).toBe('')
  })

  it('arms the drawer before it takes a press, ignores Enter, and refuses once on Esc', async () => {
    const first = await startHighRisk('第一个请求')
    await open(first)
    const card = page.locator('[data-approval-id]')
    const reject = card.getByRole('button', { name: '拒绝', exact: true })
    await reject.waitFor()
    await expect.poll(() => card.getAttribute('data-arming')).toBeNull()
    await page.locator('.transcript').click({ position: { x: 4, y: 4 } })
    await page.keyboard.press('Enter')
    expect((await detail(first)).approvals).toHaveLength(1)
    // Text in the input keeps Esc from throwing it away along with a refusal.
    const input = page.getByRole('textbox', { name: '继续对话', exact: true })
    if ((await input.count()) > 0) {
      await input.fill('还在写')
      await input.press('Escape')
      expect((await detail(first)).approvals).toHaveLength(1)
      await input.fill('')
      await page.locator('.transcript').click({ position: { x: 4, y: 4 } })
    }
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await detail(first)).summary.status).toBe('idle')
    expect((await detail(first)).messages.find(message => message.role === 'tool')?.tool?.decision).toMatchObject({ outcome: 'rejected' })
  })

  it.each([
    { name: 'phone', width: 390, height: 844 },
    { name: 'tablet', width: 768, height: 1024 },
  ])('keeps approval buttons reachable after switching conversations on $name', async ({ width, height }) => {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, locale: 'zh-CN' })
    const phone = await context.newPage()
    const sessions: string[] = []
    try {
      await enrollBrowser(phone, testHost, { name: '审批手机' })
      sessions.push(await startHighRisk('第一个等待审批的会话'), await startHighRisk('第二个等待审批的会话'))
      for (let round = 0; round < 16; round++) {
        await phone.evaluate(() => sessionStorage.clear())
        await phone.reload()
        await connected(phone)
        const drawer = phone.getByRole('button', { name: '打开会话列表', exact: true })
        if (width >= 768) await drawer.click()
        await phone.locator(`[data-task-id="${sessions[0]}"]`).click()
        await phone.locator('.drawer-backdrop').waitFor({ state: 'detached' })
        const reject = phone.locator('[data-approval-id]').getByRole('button', { name: '拒绝', exact: true })
        // Exercise the actual pointer hit test after the session's entry animation, including a non-scrolling transcript.
        // An opacity animation on the masked scroller used to leave its visible buttons outside Chromium's hit region.
        await reject.click({ trial: true, timeout: 6000 })
      }
    } finally {
      await context.close()
      for (const id of sessions) await remote.request(`tasks/${id}/cancel`, { method: 'POST' })
    }
  })

  it('keeps an approval card as it is under styles added to the page', async () => {
    const { sessionId } = await remote.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: '再写入一次标记', requestId: randomUUID(), mode: 'agent', model: { providerId: 'r2-model', model: 'fixture' } },
    })
    await expect.poll(async () => (await detail(sessionId)).approvals.length).toBe(1)
    await open(sessionId)
    const card = '[data-approval-id]'
    await page.locator(card).getByText('Latch 不认识的工具', { exact: true }).waitFor()
    await expectUnmovedByInjectedStyles(page, [
      card,
      `${card} .approval-title`,
      `${card} .approval-object`,
      `${card} .approval-clause`,
      `${card} .approval-hint`,
      `${card} .ui-button`,
    ])
    await rejectWithoutNote(page.locator(card))
    await expect.poll(async () => (await detail(sessionId)).summary.status).toBe('idle')
  })

  it('keeps the request in view wherever the conversation is scrolled', async () => {
    const sessionId = await startHighRisk(Array.from({ length: 40 }, (_, line) => `第 ${line + 1} 行要求`).join('\n'))
    await page.setViewportSize({ width: 1440, height: 640 })
    try {
      await open(sessionId)
      const card = page.locator('[data-approval-id]')
      await card.getByText('Latch 不认识的工具', { exact: true }).waitFor()
      const transcript = page.locator('.transcript')
      await page.getByRole('button', { name: '显示全部', exact: true }).click()
      await transcript.hover()
      await page.mouse.wheel(0, -4000)
      await expect.poll(() => transcript.evaluate(element => element.scrollTop)).toBe(0)
      await expect.poll(() => card.isVisible()).toBe(true)
      expect(await page.locator('.jump-latest.is-waiting').count()).toBe(0)
      await rejectWithoutNote(card)
      await expect.poll(async () => (await detail(sessionId)).summary.status).toBe('idle')
    } finally {
      await page.setViewportSize({ width: 1440, height: 1000 })
    }
  })

  it('keeps a full-access session read-only in the browser and shows permission drift', async () => {
    const saved = await local.confirmed('agents', {
      method: 'POST',
      body: { name: 'Fake Agent', command: process.execPath, args: [FAKE_ACP_AGENT], env: {} },
    })
    expect(saved.status).toBe(201)
    const { agent } = (await saved.json()) as { agent: AgentSettings }
    const created = await local.confirmed('tasks', {
      method: 'POST',
      body: { prompt: 'permission', requestId: randomUUID(), mode: 'agent', harnessId: agent.id },
    })
    expect(created.status).toBe(201)
    const { sessionId } = (await created.json()) as { sessionId: string }
    await expect.poll(async () => (await detail(sessionId)).approvals.length).toBe(1)
    await open(sessionId)

    await page.getByText('这个会话只能在 Mac 上继续。这台设备可以查看、拒绝和停止。', { exact: true }).waitFor()
    expect(await page.getByRole('textbox', { name: '继续对话' }).count()).toBe(0)
    const card = page.locator('[data-approval-id]')
    await card.getByText('Agent 的询问只是提示：拒绝会转达给它，但不能阻止它执行其他操作。', { exact: true }).waitFor()
    await card.getByText('在 Mac 上的 Latch 里允许', { exact: true }).waitFor()
    expect(await card.getByRole('button', { name: /允许/ }).count()).toBe(0)
    await page.screenshot({ path: `${OUTPUT}/l3-read-only-desktop.png`, fullPage: true, animations: 'disabled' })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: `${OUTPUT}/l3-read-only-phone.png`, fullPage: true, animations: 'disabled' })
    await page.setViewportSize({ width: 1440, height: 1000 })
    // Reject is a class-C action every device may take; the card names the agent's option in the product's words.
    await card.getByRole('button', { name: '拒绝', exact: true }).click()
    await expect.poll(async () => (await detail(sessionId)).summary.status).toBe('idle')

    // The harness switches its own permission mode mid-turn: the Host cancels the turn and stops the session.
    await local.json(`tasks/${encodeURIComponent(sessionId)}/prompt`, {
      method: 'POST',
      body: { prompt: 'drift plan', requestId: randomUUID() },
    })
    await expect.poll(async () => (await detail(sessionId)).summary.permissionDrift, { timeout: 15_000 }).toBe(true)
    await page.getByText('这个 Agent 的设置变了，为了安全换个新会话继续', { exact: true }).waitFor()
    expect(await page.getByRole('textbox', { name: '继续对话' }).count()).toBe(0)
    await page.screenshot({ path: `${OUTPUT}/l3-drift-desktop.png`, fullPage: true, animations: 'disabled' })
    // The banner that stops the session is a security surface too.
    await expectUnmovedByInjectedStyles(page, [
      '.composer-stop[data-secure]',
      '.composer-stop[data-secure] > span',
      '.composer-stop[data-secure] .ui-button',
    ])
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: `${OUTPUT}/l3-drift-dark.png`, fullPage: true, animations: 'disabled' })
    await page.emulateMedia({ colorScheme: 'light' })
  })

  it('offers another device only the built-in engine, and says where the others start', async () => {
    await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
    await page.locator('.composer .model-picker').click()
    await page.getByText('其他引擎只能在 Mac 上开始。', { exact: true }).waitFor()
    expect(await page.getByRole('menuitemradio', { name: /Fake Agent/ }).count()).toBe(0)
    await page.screenshot({ path: `${OUTPUT}/engine-picker-remote.png`, animations: 'disabled' })
    await page.keyboard.press('Escape')
  })

  const policy = () => testHost.host.security.policy.get()

  it('lets an admin browser turn 手机可以开始新会话 off but never back on', async () => {
    expect(policy().remote).toMatchObject({ maxLevel: 'L1', allowRemoteStart: true })
    const settings = await openSettings(page, '手机与设备')
    const remoteStart = settings.getByRole('switch', { name: '手机可以开始新会话', exact: true })
    await remoteStart.click()
    await expect.poll(() => policy().remote.allowRemoteStart).toBe(false)
    // Turning it on takes this Mac's Touch ID, so a browser says where and sends nothing.
    await settings.getByText('在 Mac 上开启', { exact: true }).waitFor()
    await remoteStart.click({ force: true })
    expect(policy().remote.allowRemoteStart).toBe(false)
  })
})
