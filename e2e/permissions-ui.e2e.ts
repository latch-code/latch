import { chromium, type Browser, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentSettings, AppSnapshot, TaskDetail } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { type TestDevice, FAKE_ACP_AGENT } from '@latch/testkit'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { expectUnmovedByInjectedStyles } from './helpers/security.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { closeSettings, openSection, openSession, openSettings, permissionControl, permissionWords } from './helpers/layout.ts'
import { promptValue } from './helpers/prompt.ts'

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

  it('shows a high-risk approval with its reason and an allow button on any device with the scope; reject still works', async () => {
    const { sessionId } = await remote.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: '写入标记', requestId: randomUUID(), mode: 'agent', model: { providerId: 'r2-model', model: 'fixture' } },
    })
    await expect.poll(async () => (await detail(sessionId)).approvals.length).toBe(1)
    expect((await detail(sessionId)).approvals[0]?.risk).toBe('R2')
    await open(sessionId)
    const card = page.locator('[data-approval-id]')
    await card.getByText('Latch 不认识的工具', { exact: true }).waitFor()
    await card.getByRole('button', { name: '允许', exact: true }).waitFor()
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
    const note = page.getByRole('textbox', { name: '拒绝并说明改做什么…', exact: true })
    expect(await note.getAttribute('aria-placeholder')).toBe('拒绝并说明改做什么…')
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
    expect(await promptValue(composer)).toBe('')
  })

  const activeKeys = async (card: Locator, name: string) =>
    (await card.getByRole('button', { name, exact: true }).getAttribute('aria-keyshortcuts')) ?? ''

  it('keeps approval buttons compact while shortcuts follow focus and input rejection keeps its note', async () => {
    const { sessionId } = await remote.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: '生成需要审批的报告', requestId: randomUUID(), mode: 'agent', model: { providerId: 'demo', model: 'demo' } },
    })
    await expect.poll(async () => (await detail(sessionId)).approvals.length).toBe(1)
    await open(sessionId)
    const card = page.locator('[data-approval-id]')
    await expect.poll(() => card.getAttribute('data-arming')).toBeNull()
    // The title is what it asks to do; 更多 · 拒绝 · 允许, one name for the other choices.
    expect(await card.locator('.approval-title').textContent()).not.toMatch(/等你处理|需要你允许/u)
    expect(
      await card
        .locator('.approval-buttons .ui-button')
        .evaluateAll(buttons => buttons.map(button => button.firstChild?.textContent ?? '')),
    ).toEqual(['更多', '拒绝', '允许'])
    // Focus in the empty input: Esc refuses, ⌘⏎ would send there, so 允许 has no cap.
    const note = page.getByRole('textbox', { name: '拒绝并说明改做什么…', exact: true })
    await note.focus()
    expect(await activeKeys(card, '拒绝')).toBe('Escape')
    expect(await activeKeys(card, '允许')).toBe('')
    expect(await card.locator('.ui-button-keys').count()).toBe(0)
    const allow = card.getByRole('button', { name: '允许', exact: true })
    const before = await allow.boundingBox()
    expect(
      await allow.evaluate(button => {
        const range = document.createRange()
        range.selectNodeContents(button)
        const words = range.getBoundingClientRect(),
          box = button.getBoundingClientRect()
        return Math.abs(words.left + words.width / 2 - box.left - box.width / 2)
      }),
    ).toBeLessThan(1)
    // Focus in the card: ⌘⏎ allows an ordinary request of Latch 内置.
    await card.getByRole('button', { name: '拒绝', exact: true }).focus()
    await expect.poll(() => activeKeys(card, '允许')).toMatch(/^(?:Meta|Control)\+Enter$/u)
    expect(await card.locator('.ui-button-keys').count()).toBe(0)
    expect((await allow.boundingBox())?.width).toBeCloseTo(before!.width, 1)
    await page.screenshot({ path: `${OUTPUT}/approval-caps-focused.png`, animations: 'disabled' })
    await card.screenshot({ path: `${OUTPUT}/approval-clean-light.png`, animations: 'disabled' })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: `${OUTPUT}/approval-caps-focused-dark.png`, animations: 'disabled' })
    await card.screenshot({ path: `${OUTPUT}/approval-clean-dark.png`, animations: 'disabled' })
    await page.emulateMedia({ colorScheme: 'light' })
    // Writing what to do instead: 拒绝 sends it, Esc does not refuse, and ⌘⏎ in the input rejects with the note.
    await note.fill('只列出文件名')
    await card.getByRole('button', { name: '拒绝并发送', exact: true }).waitFor()
    expect(await activeKeys(card, '拒绝并发送')).toBe('')
    expect(await activeKeys(card, '允许')).toBe('')
    await note.press('ControlOrMeta+Enter')
    await expect.poll(async () => (await detail(sessionId)).summary.status).toBe('idle')
    const settled = await detail(sessionId)
    expect(settled.messages.find(message => message.role === 'tool')?.tool?.decision).toMatchObject({ outcome: 'rejected' })
    expect(settled.messages.filter(message => message.role === 'assistant').at(-1)?.text).toContain('只列出文件名')
  })

  it('draws no ⌘⏎ on a high-risk request, and no cap at a phone width', async () => {
    const sessionId = await startHighRisk('高风险的键帽')
    await open(sessionId)
    const card = page.locator('[data-approval-id]')
    await expect.poll(() => card.getAttribute('data-arming')).toBeNull()
    await card.getByRole('button', { name: '拒绝', exact: true }).focus()
    expect(await activeKeys(card, '拒绝')).toBe('Escape')
    expect(await activeKeys(card, '允许')).toBe('')
    expect(await card.locator('.ui-button-keys').count()).toBe(0)
    // ⌘⏎ inside the card does not allow it either.
    await page.keyboard.press('ControlOrMeta+Enter')
    expect((await detail(sessionId)).approvals).toHaveLength(1)
    await page.screenshot({ path: `${OUTPUT}/approval-r2-caps.png`, animations: 'disabled' })
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN' })
    try {
      const phone = await context.newPage()
      await enrollBrowser(phone, testHost, { name: '键帽手机' })
      await openSession(phone, sessionId)
      const narrow = phone.locator('[data-approval-id]')
      await expect.poll(() => narrow.getAttribute('data-arming')).toBeNull()
      await narrow.getByRole('button', { name: '拒绝', exact: true }).focus()
      expect(await narrow.locator('.ui-button-keys').count()).toBe(0)
      await narrow.getByRole('button', { name: '更多', exact: true }).waitFor()
      await phone.screenshot({ path: `${OUTPUT}/approval-r2-phone.png`, animations: 'disabled' })
    } finally {
      await context.close()
    }
    await rejectWithoutNote(card)
    await expect.poll(async () => (await detail(sessionId)).summary.status).toBe('idle')
  })

  it('ignores retained closed sheets while real menus and sheets keep Escape for themselves', async () => {
    const sessionId = await startHighRisk('浮层与拒绝键')
    await open(sessionId)
    const card = page.locator('[data-approval-id]')
    const reject = card.getByRole('button', { name: '拒绝', exact: true })
    await expect.poll(() => card.getAttribute('data-arming')).toBeNull()
    const state = await page.evaluate(() => ({
      sheets: [...document.querySelectorAll<HTMLDialogElement>('dialog.ui-sheet')].map(sheet => ({
        tag: sheet.tagName,
        open: sheet.open,
        visible: sheet.checkVisibility(),
      })),
      openLayers: document.querySelectorAll(':popover-open:not([role="tooltip"]), dialog[open]').length,
    }))
    await writeFile(`${OUTPUT}/retained-sheet-state.json`, JSON.stringify(state, null, 2) + '\n')
    expect(state.sheets.some(sheet => !sheet.open && !sheet.visible)).toBe(true)
    expect(state.openLayers).toBe(0)
    await reject.focus()
    await expect.poll(() => activeKeys(card, '拒绝')).toBe('Escape')
    for (const flags of [
      { isComposing: true },
      { repeat: true },
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
      { shiftKey: true },
    ])
      await reject.dispatchEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...flags })
    expect((await detail(sessionId)).approvals).toHaveLength(1)
    await page.keyboard.press('ControlOrMeta+Enter')
    expect((await detail(sessionId)).approvals).toHaveLength(1)
    try {
      for (const [width, colorScheme] of [
        [1440, 'light'],
        [768, 'dark'],
        [390, 'dark'],
      ] as const) {
        await page.setViewportSize({ width, height: 1000 })
        await page.emulateMedia({ colorScheme })
        await card.getByRole('button', { name: '更多', exact: true }).click()
        const menu = page.getByRole('menu', { name: '更多', exact: true })
        await menu.waitFor()
        if (width === 390) expect(await page.locator('dialog.ui-sheet[open]').count()).toBe(1)
        else expect(await page.locator(':popover-open:not([role="tooltip"])').count()).toBeGreaterThan(0)
        await expect.poll(() => activeKeys(card, '拒绝')).toBe('')
        await page.screenshot({ path: `${OUTPUT}/approval-overlay-${width}-${colorScheme}.png`, animations: 'disabled' })
        await page.keyboard.press('Escape')
        await menu.waitFor({ state: 'hidden' })
        expect((await detail(sessionId)).approvals).toHaveLength(1)
      }
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.emulateMedia({ colorScheme: 'light' })
      await reject.focus()
      await page.keyboard.press('ArrowDown')
      await expect.poll(() => activeKeys(card, '拒绝')).toBe('Escape')
      await page.screenshot({ path: `${OUTPUT}/approval-after-sheet-1440-light.png`, animations: 'disabled' })
      await page.keyboard.press('Escape')
      await expect.poll(async () => (await detail(sessionId)).summary.status).toBe('idle')
      expect((await detail(sessionId)).messages.find(message => message.role === 'tool')?.tool?.decision).toMatchObject({
        outcome: 'rejected',
      })
    } finally {
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.emulateMedia({ colorScheme: 'light' })
    }
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
        await openSession(phone, sessions[0]!)
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

  it('allows a high-risk step from this browser with no prompt, on record', async () => {
    const before = testHost.presence.requests.length
    const sessionId = await startHighRisk('再写入标记')
    await open(sessionId)
    const card = page.locator('[data-approval-id]')
    await card.getByRole('button', { name: '允许', exact: true }).click()
    await expect.poll(async () => (await detail(sessionId)).summary.status).toBe('idle')
    expect(testHost.presence.requests).toHaveLength(before)
  })

  it('runs a Harness session in the browser: it starts here, answers, widens with no prompt, and stops on drift', async () => {
    const saved = await local.confirmed('agents', {
      method: 'POST',
      body: {
        name: 'Fake Agent',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_MODES: 'read-only,auto', FAKE_ACP_CONFIG: 'options' },
      },
    })
    expect(saved.status).toBe(201)
    const { agent } = (await saved.json()) as { agent: AgentSettings }
    const before = testHost.presence.requests.length

    await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
    // 新建会话 is the home's input; the session it covers keeps its own composer mounted under it, hidden and inert.
    const home = page.locator('.workbench-home')
    await home.locator('.composer .harness-picker').click()
    await page.getByRole('menuitemradio', { name: /Fake Agent/ }).click()
    expect(await page.getByText('只能在 Mac 上开始', { exact: false }).count()).toBe(0)
    await home.locator('.composer .composer-input [role="textbox"]').fill('permission')
    await page.keyboard.press('Enter')
    const card = page.locator('[data-approval-id]')
    await card.waitFor()
    // The timeline keeps no row for what it can do: that Latch does not isolate it is its reply's author line tooltip.
    expect(await page.locator('.session-start-note').count()).toBe(0)
    // The fact in view on the card, the sentence behind its ⓘ.
    const advisory = card.locator('.approval-note')
    await advisory.getByText('拒绝只会转达，拦不住它', { exact: true }).waitFor()
    await advisory.getByRole('img', { name: '说明', exact: true }).hover()
    await page.getByText('Harness 的询问只是提示：拒绝会转达给它，但不能阻止它执行其他操作。', { exact: true }).waitFor()
    // An agent's ask: Esc refuses, but ⌘⏎ never allows it, so 允许 has no cap even with focus in the card.
    await expect.poll(() => card.getAttribute('data-arming')).toBeNull()
    await card.getByRole('button', { name: '拒绝', exact: true }).focus()
    expect(await activeKeys(card, '拒绝')).toBe('Escape')
    expect(await activeKeys(card, '允许')).toBe('')
    await page.screenshot({ path: `${OUTPUT}/l3-browser-approval-desktop.png`, fullPage: true, animations: 'disabled' })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: `${OUTPUT}/l3-browser-approval-phone.png`, fullPage: true, animations: 'disabled' })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await card.getByRole('button', { name: '允许', exact: true }).click()
    await card.waitFor({ state: 'detached' })
    const { tasks } = await local.json<AppSnapshot>('snapshot')
    const sessionId = tasks.find(task => task.harnessId === agent.id)!.id
    await expect.poll(async () => (await detail(sessionId)).summary.status).toBe('idle')
    await page.getByRole('textbox', { name: '继续对话' }).waitFor()

    // The permission's popover offers the wider row under the lock and takes it at once, staying open; Escape closes it.
    expect(await permissionWords(page)).toMatch(/^权限：/u)
    await permissionControl(page).click()
    const foot = page.locator('.ui-popover:popover-open .permission-panel[data-lock]')
    await foot.waitFor()
    await foot.getByRole('radio', { name: /auto/iu }).click()
    await expect.poll(async () => (await detail(sessionId)).config?.find(option => option.id === 'mode')?.currentValue).toBe('auto')
    await expect.poll(() => foot.getByRole('radio', { name: /auto/iu }).getAttribute('aria-checked')).toBe('true')
    expect(await foot.isVisible()).toBe(true)
    await expect.poll(() => permissionWords(page)).toBe('权限：auto')
    // The Agent can report its new mode before the Host has finished recording the change.
    await expect.poll(() => permissionControl(page).getAttribute('aria-busy')).toBeNull()
    await page.keyboard.press('Escape')
    await foot.waitFor({ state: 'hidden' })
    expect(testHost.presence.requests).toHaveLength(before)
    const records = (await readFile(join(testHost.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { action: string; stepup?: string })
    expect(records.find(record => record.action === 'task.l3.started')).toMatchObject({ stepup: 'none' })
    expect(records.find(record => record.action === 'task.mode.widened')).toMatchObject({ stepup: 'none' })

    // The harness switches its own permission mode mid-turn: the Host cancels the turn and stops the session.
    await local.json(`tasks/${encodeURIComponent(sessionId)}/prompt`, {
      method: 'POST',
      body: { prompt: 'drift plan', requestId: randomUUID() },
    })
    await expect.poll(async () => (await detail(sessionId)).summary.permissionDrift, { timeout: 15_000 }).toBe(true)
    await page.locator('.composer-stop').getByText('Harness 的设置变了', { exact: true }).waitFor()
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
})
