import { chromium, type Browser, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HarnessPlugin } from '../src/core/plugins.ts'
import type { AgentSettings, TaskDetail } from '../src/shared/types.ts'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestDevice, type TestHost } from './helpers/host.ts'

const OUTPUT = 'test-results/permissions'
const FAKE_AGENT = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))

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
    testHost = await startTestHost({ demo: true, uiDir: resolve(process.env.HARNESS_E2E_UI_DIR ?? 'dist/web'), plugins: [highRiskFixture] })
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

  async function open(sessionId: string): Promise<void> {
    await page.locator(`[data-task-id="${sessionId}"]`).click()
    await page.locator('.transcript-content').waitFor()
  }
  const detail = (id: string) => local.json<TaskDetail>(`tasks/${encodeURIComponent(id)}`)

  it('shows a high-risk approval with the host-desktop hint and no allow button; reject still works', async () => {
    const { sessionId } = await remote.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: '写入标记', requestId: randomUUID(), mode: 'agent', model: { providerId: 'r2-model', model: 'fixture' } },
    })
    await expect.poll(async () => (await detail(sessionId)).approvals.length).toBe(1)
    expect((await detail(sessionId)).approvals[0]?.risk).toBe('R2')
    await open(sessionId)
    const card = page.locator('[data-approval-id]')
    await card.getByText('高风险', { exact: true }).waitFor()
    await card.getByText('高风险操作只能在执行端电脑上用 Latch 桌面端批准', { exact: true }).waitFor()
    expect(await card.getByRole('button', { name: /允许|在本机确认后允许/ }).count()).toBe(0)
    await page.screenshot({ path: `${OUTPUT}/r2-browser-desktop.png`, fullPage: true, animations: 'disabled' })
    await card.getByRole('button', { name: '拒绝', exact: true }).click()
    await expect.poll(async () => (await detail(sessionId)).summary.status).toBe('idle')
    await card.waitFor({ state: 'detached' })
  })

  it('keeps a full-access session read-only in the browser and shows permission drift', async () => {
    const saved = await local.confirmed('agents', {
      method: 'POST',
      body: { name: 'Fake Agent', command: process.execPath, args: [FAKE_AGENT], env: {} },
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

    await page.locator('.topbar').getByText('完全访问（L3）', { exact: true }).waitFor()
    await page.getByText('完全访问会话只接受执行端电脑上 Latch 桌面端的输入。此设备可以查看、拒绝和取消。', { exact: true }).waitFor()
    expect(await page.getByRole('textbox', { name: '继续对话' }).count()).toBe(0)
    const card = page.locator('[data-approval-id]')
    await card.getByText('提示，不是安全边界', { exact: true }).waitFor()
    await card.getByText('只有执行端电脑上的 Latch 桌面端可以回应完全访问会话的询问', { exact: true }).waitFor()
    expect(await card.getByRole('button', { name: /允许/ }).count()).toBe(0)
    await page.screenshot({ path: `${OUTPUT}/l3-read-only-desktop.png`, fullPage: true, animations: 'disabled' })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: `${OUTPUT}/l3-read-only-phone.png`, fullPage: true, animations: 'disabled' })
    await page.setViewportSize({ width: 1440, height: 1000 })
    // Reject is a class-C action every device may take; the agent names its own options.
    await card.getByRole('button', { name: 'Reject', exact: true }).click()
    await expect.poll(async () => (await detail(sessionId)).summary.status).toBe('idle')

    // The harness switches its own permission mode mid-turn: the Host cancels the turn and stops the session.
    await local.json(`tasks/${encodeURIComponent(sessionId)}/prompt`, {
      method: 'POST',
      body: { prompt: 'drift plan', requestId: randomUUID() },
    })
    await expect.poll(async () => (await detail(sessionId)).summary.permissionDrift, { timeout: 15_000 }).toBe(true)
    await page.getByText('检测到权限模式变化，本轮已取消，挂起的询问已拒绝。该会话不再接受输入，请新建会话。', { exact: true }).waitFor()
    expect(await page.getByRole('textbox', { name: '继续对话' }).count()).toBe(0)
    await page.screenshot({ path: `${OUTPUT}/l3-drift-desktop.png`, fullPage: true, animations: 'disabled' })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: `${OUTPUT}/l3-drift-dark.png`, fullPage: true, animations: 'disabled' })
    await page.emulateMedia({ colorScheme: 'light' })
  })

  it('marks full-access harnesses as desktop-only in the new-session picker', async () => {
    await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
    await page.getByRole('button', { name: /^Harness：/ }).click()
    const item = page.getByRole('menuitemradio', { name: /Fake Agent/ })
    await item.waitFor()
    expect(await item.isDisabled()).toBe(true)
    expect(await item.getAttribute('title')).toBe('仅本机桌面端')
    await page.screenshot({ path: `${OUTPUT}/harness-picker-desktop.png`, animations: 'disabled' })
    await page.keyboard.press('Escape')
  })
})
