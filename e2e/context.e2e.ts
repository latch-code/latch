import { chromium, type Browser, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, ContextWindowBreakdown, CustomAgent, TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import {
  FOLLOW_UP,
  jumpToLargestResult,
  openContextPanel,
  requestBar,
  REVIEW,
  reviewPlugin,
  reviewSession,
  samples,
  selectFourthRequest,
  visibleReadingTarget,
} from './helpers/context.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSession, settleShell } from './helpers/layout.ts'
import { promptValue } from './helpers/prompt.ts'

const OUTPUT = 'test-results/context'

describe('a new context in a session', () => {
  let host: TestHost
  let owner: TestDevice
  let browser: Browser
  let models: string
  let review: string

  beforeAll(async () => {
    host = await startTestHost({ hostName: '工作电脑', plugins: [reviewPlugin] })
    owner = await host.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: {
        id: 'fake-agent',
        name: 'Fake Agent',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_CONFIG: 'options', FAKE_ACP_CAPS: 'resume,close' },
      },
    })
    models = join(host.root, 'models.txt')
    await writeFile(models, 'small,large')
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: {
        id: 'shrinking-agent',
        name: 'Shrinking Agent',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_CONFIG: 'options', FAKE_ACP_CAPS: 'resume,close', FAKE_ACP_MODELS_FILE: models },
      },
    })
    // Nothing on this computer is looked up: only the built-in harness and the fake agents can run.
    const harnesses = (await owner.json<AppSnapshot>('snapshot')).catalog!.harnesses
    expect(harnesses.filter(item => item.status === 'ready').map(item => item.id)).toEqual(['standard', 'fake-agent', 'shrinking-agent'])
    const session = await reviewSession(host, owner)
    review = session.summary.id
    const toolMessages = session.messages.filter(message => message.role === 'tool')
    expect(toolMessages.map(message => message.toolName)).toEqual(['list_files', 'read_file', 'read_file', 'read_file', 'read_file'])
    expect(toolMessages[2]?.text).toBe(samples)
    expect(toolMessages[3]?.state).toBe('failed')
    const steps = session.contextSteps ?? []
    expect(steps.map(step => step.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(steps.map(step => step.toolCalls)).toEqual([1, 1, 1, 0, 1, 1, 0])
    expect(new Set(steps.map(step => step.turnId)).size).toBe(2)
    expect(steps[0]?.inputTokens).toBeUndefined()
    expect(steps[3].bytes.toolResults - steps[2].bytes.toolResults).toBeGreaterThanOrEqual(Buffer.byteLength(samples))
    expect(steps.at(-1)).toMatchObject({ userMessages: 2, skills: 1, toolResults: 5, inputTokens: 3400, outputTokens: 36 })
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
    // Only observation fields from this synthetic session enter the local interactive preview.
    await writeFile(
      join(OUTPUT, 'inspector-demo.json'),
      JSON.stringify(
        {
          summary: { id: review, harnessId: session.summary.harnessId, title: REVIEW, status: session.summary.status },
          requestContext: session.requestContext,
          contextSteps: steps,
          messages: session.messages.map(({ id, role, state, toolName, tool }) => ({
            id,
            role,
            state,
            toolName,
            text: '',
            ...(tool?.kind ? { tool: { kind: tool.kind } } : {}),
          })),
        },
        null,
        2,
      ),
    )
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
  })

  const detail = (id: string) => owner.json<TaskDetail>(`tasks/${id}`)
  const idle = (id: string) => vi.waitFor(async () => expect((await detail(id)).summary.status).toBe('idle'), { timeout: 15_000 })
  const input = (page: Page) => page.getByRole('textbox', { name: '继续对话', exact: true })
  const send = async (page: Page, text: string) => {
    await input(page).fill(text)
    await input(page).press('Meta+Enter')
  }
  const armed = (page: Page) => page.getByText('下一条消息开始新的上下文', { exact: true })
  const open = async (width: number, theme: 'light' | 'dark', title: string) => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await enrollBrowser(page, host, { name: `上下文 ${width} ${randomUUID().slice(0, 4)}` })
    await connected(page)
    await page.keyboard.press('Meta+k')
    const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
    await palette.getByRole('searchbox').fill(title)
    await palette.getByRole('option').first().click()
    return { context, page }
  }

  it.each([
    { width: 390, height: 844, theme: 'light' as const },
    { width: 390, height: 844, theme: 'dark' as const },
    { width: 768, height: 1024, theme: 'light' as const },
    { width: 768, height: 1024, theme: 'dark' as const },
    { width: 1440, height: 900, theme: 'light' as const },
    { width: 1440, height: 900, theme: 'dark' as const },
  ])('reads real context composition in the built-in session panel at $width $theme', async ({ width, height, theme }) => {
    const context = await browser.newContext({
      viewport: { width, height },
      colorScheme: theme,
      reducedMotion: 'reduce',
      isMobile: width === 390,
      hasTouch: width < 1024,
    })
    try {
      const page = await context.newPage()
      const checksExternal = width === 1440 && theme === 'dark'
      const readerName = '只读上下文验收'
      await enrollBrowser(page, host, checksExternal ? { name: readerName, dataScope: 'work' } : {})
      if (checksExternal) {
        const reader = host.host.security.devices.list().find(device => device.name === readerName)!
        await owner.json(`devices/${reader.id}`, { method: 'PATCH', body: { scopes: ['view'] } })
        const agent = await owner.json<CustomAgent>('custom-agents', {
          body: {
            requestId: randomUUID(),
            name: '私人核对',
            description: '',
            harnessId: 'standard',
            mode: 'chat',
            instructions: '',
            skills: [],
          },
        })
        const { sessionId: hidden } = await owner.json<{ sessionId: string }>('tasks', {
          body: { requestId: randomUUID(), customAgentId: agent.id, prompt: '私人的核对记录' },
        })
        expect(await page.evaluate(async id => (await fetch(`/link/api/tasks/${id}`)).status, hidden)).toBe(403)
        await page.reload()
        await connected(page)
      }
      const panel = page.locator('.session-context:not(.context-insights)')
      const inspect = async (id: string) => {
        await openSession(page, id)
        await openContextPanel(page, panel)
      }
      await inspect(review)
      expect(await panel.getByText('Harness 尚未报告窗口占用。', { exact: true }).count()).toBe(0)
      const timeline = panel.getByRole('group', { name: '上下文演变', exact: true })
      const bar = (n: number) => requestBar(panel, n)
      const composition = panel.getByRole('region', { name: '请求组成', exact: true })
      const selected = async (n: number) => {
        await expect.poll(() => bar(n).getAttribute('aria-pressed')).toBe('true')
        await panel.locator('.context-step-selector').getByText(`第 ${n} 次请求`, { exact: true }).waitFor()
      }
      const count = (label: string) =>
        composition
          .getByRole('row', { name: new RegExp('^' + label + '\\s', 'u') })
          .getByRole('cell')
          .first()
      const inputUsage = () =>
        composition
          .locator('dt')
          .filter({ hasText: /^输入 token$/u })
          .locator('xpath=following-sibling::dd[1]')
      await selected(7)
      expect(await timeline.getByRole('button').count()).toBe(7)
      await panel.getByText('共 5 次 · 1 次失败', { exact: true }).waitFor()
      const calls = panel.locator('.context-tool-activity').getByRole('listitem').filter({ hasText: 'read_file' })
      expect(await calls.getByText('4', { exact: true }).textContent()).toBe('4')
      expect(await calls.getByText('1 次失败', { exact: true }).textContent()).toBe('1 次失败')
      expect(await panel.getByText('checkout,build-21,1,410,560', { exact: false }).count()).toBe(0)
      await noHorizontalOverflow(page, panel)
      await selectFourthRequest(panel)
      await selected(4)
      const heading = panel.getByRole('heading', { name: '上下文演变', exact: true })
      if (width === 390) await heading.tap()
      else await heading.hover()
      await page.screenshot({ path: `${OUTPUT}/context-inspector-${width}-${theme}.png`, animations: 'disabled' })
      if (width === 390 || (width === 1440 && theme === 'light')) {
        await jumpToLargestResult(page, panel, await detail(review))
        if (width === 390) await panel.waitFor({ state: 'hidden' })
        await page.screenshot({ path: `${OUTPUT}/context-result-${width}-${theme}.png`, animations: 'disabled' })
        await openContextPanel(page, panel)
        await selectFourthRequest(panel)
      }
      await composition.getByText('请求明细', { exact: true }).click()
      expect(await count('用户消息').textContent()).toBe('1')
      expect(await count('工具结果').textContent()).toBe('3')
      expect(await count('技能').textContent()).toBe('1')
      expect(await count('图片').textContent()).toBe('0')
      const step = (await detail(review)).contextSteps?.find(item => item.sequence === 4)
      expect(step).toBeDefined()
      const bytes = composition
        .getByRole('row', { name: /^工具结果\s/u })
        .getByRole('cell')
        .last()
      expect(Number((await bytes.textContent())?.replaceAll(',', ''))).toBe(step?.bytes.toolResults)
      if (width === 390) {
        await panel.getByRole('button', { name: '上一次请求', exact: true }).tap()
        await selected(3)
        expect(await count('工具结果').textContent()).toBe('2')
      } else {
        await bar(4).focus()
        await bar(4).press('ArrowLeft')
        await selected(3)
        expect(await count('工具结果').textContent()).toBe('2')
        await page.keyboard.press('Home')
        await selected(1)
        expect(await inputUsage().textContent()).toBe('未报告')
      }
      await panel.getByRole('button', { name: '回到最新请求', exact: true }).click()
      await selected(7)
      expect(await count('用户消息').textContent()).toBe('2')
      expect(await count('工具结果').textContent()).toBe('5')
      await noHorizontalOverflow(page, panel)
      if (checksExternal) {
        const { sessionId: external } = await owner.confirmedJson<{ sessionId: string }>('tasks', {
          body: { requestId: randomUUID(), mode: 'agent', prompt: 'window-report 21000 100000', harnessId: 'fake-agent' },
        })
        const report = async (prompt: string, freshContext?: true) => {
          await owner.json(`tasks/${external}/prompt`, { body: { requestId: randomUUID(), prompt, freshContext } })
          await idle(external)
        }
        const choice = (turn: number) =>
          panel.locator('button.context-window-choice').and(panel.getByRole('button', { name: new RegExp(`^第 ${turn} 轮`, 'u') }))
        const meter = panel.getByRole('meter', { name: '上下文窗口' })
        const history = panel.locator('.context-window-history')
        await idle(external)
        await report('window-report 36000 100000')
        await inspect(external)
        await panel.getByRole('heading', { name: '逐轮窗口占用', exact: true }).waitFor()
        expect(await choice(1).innerText()).toContain('21,000 / 100,000 tokens')
        expect(await choice(2).innerText()).toContain('较上一轮净变化 +15,000 tokens')
        expect(await history.getByRole('img').count()).toBe(0)
        expect(await history.locator('.context-window-plot-unit').count()).toBe(0)
        expect(await meter.getAttribute('aria-valuetext')).toBe('36,000 / 100,000 tokens · 36%')
        await choice(1).click()
        expect(await meter.getAttribute('aria-valuetext')).toBe('21,000 / 100,000 tokens · 21%')
        await page.mouse.move(4, 4)
        await page.screenshot({ path: `${OUTPUT}/context-two-windows-1440-dark.png`, animations: 'disabled' })
        await panel.getByRole('button', { name: '查看第 1 轮对话', exact: true }).click()
        const firstTurn = (await detail(external)).messages.find(message => message.role === 'user')!
        await visibleReadingTarget(page.locator(`.transcript [data-message-id="${firstTurn.id}"] .user-bubble`))
        await openContextPanel(page, panel)
        await choice(2).click()
        expect(await meter.getAttribute('aria-valuetext')).toBe('36,000 / 100,000 tokens · 36%')

        const command = '核对发布前的私有路径'
        await report(`shell-row ${command}`)
        await report('window-report 49000 100000')
        await report('window-report 12000 100000', true)
        await report('window-report 19000 100000')
        const externalDetail = await detail(external)
        expect(externalDetail.usageReport).toMatchObject({ contextUsed: 19000, contextSize: 100000 })
        const measured = externalDetail.messages
          .filter(message => message.role === 'user')
          .map(message => message.turn?.contextWindow?.used)
        expect(measured).toEqual([21000, 36000, undefined, 49000, 12000, 19000])
        const chart = history.getByRole('img', { name: /^已用 tokens/u })
        await chart.waitFor()
        await history.getByText('更早的轮次', { exact: true }).click()
        const missing = history.locator('.context-window-missing')
        expect(await missing.innerText()).toMatch(/第 3 轮\s+未报告/u)
        expect(await choice(4).innerText()).not.toContain('净变化')
        expect(await choice(5).innerText()).not.toContain('净变化')
        expect(await choice(6).innerText()).toContain('较上一轮净变化 +7,000 tokens')
        await history.getByText('重新开始上下文', { exact: true }).waitFor()
        expect(await chart.locator('.ui-chart-line').count()).toBe(2)
        expect(await chart.locator('.ui-chart-dot').count()).toBe(1)
        await panel.getByRole('heading', { name: '会话工具调用', exact: true }).waitFor()
        await panel.getByText('共 1 次', { exact: true }).waitFor()
        await panel.getByRole('listitem').filter({ hasText: 'execute' }).getByText('1', { exact: true }).waitFor()
        expect(await panel.getByText(command, { exact: false }).count()).toBe(0)
        expect(await panel.getByText('read_file', { exact: true }).count()).toBe(0)
        expect(await panel.getByText('用户消息', { exact: true }).count()).toBe(0)
        expect(await panel.getByText('Harness 尚未报告窗口占用。', { exact: true }).count()).toBe(0)
        await page.mouse.move(4, 4)
        await page.screenshot({ path: `${OUTPUT}/context-inspector-external.png`, animations: 'disabled' })
        expect(await timeline.count()).toBe(0)
        await inspect(review)
        await selected(7)
      }
      // On phones the panel covers the transcript. A successful jump must uncover the actual user message.
      const firstTurn = width === 390
      if (firstTurn) {
        await bar(4).tap()
        await selected(4)
      }
      await panel.getByRole('button', { name: `查看第 ${firstTurn ? 1 : 2} 轮对话`, exact: true }).click()
      const user = (await detail(review)).messages.filter(message => message.role === 'user')[firstTurn ? 0 : 1]
      const bubble = page.locator(`.transcript [data-message-id="${user.id}"] .user-bubble`)
      expect(await bubble.textContent()).toBe(firstTurn ? REVIEW : FOLLOW_UP)
      await visibleReadingTarget(bubble)
    } finally {
      await context.close()
    }
  })

  it('shows the breakdown of the selected Claude window and separates explicit compaction from a net change', async () => {
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      body: { requestId: randomUUID(), harnessId: 'fake-agent', prompt: 'echo 发布检查：准备工作' },
    })
    await idle(sessionId)
    for (const prompt of ['echo 发布检查：核对结果', 'echo 发布检查：压缩上下文', 'echo 发布检查：压缩后复核']) {
      await owner.json(`tasks/${sessionId}/prompt`, { body: { requestId: randomUUID(), prompt } })
      await idle(sessionId)
    }
    const breakdown: ContextWindowBreakdown = {
      measurement: 'full',
      categories: [
        { kind: 'used', id: 'system_prompt', tokens: 3200 },
        { kind: 'used', id: 'system_tools', tokens: 7800 },
        { kind: 'used', id: 'messages', tokens: 13000 },
        { kind: 'buffer', id: 'autocompact_buffer', tokens: 12000 },
        { kind: 'free', id: 'free_space', tokens: 164000 },
        { kind: 'deferred', id: 'mcp_tools_deferred', tokens: 14000 },
      ],
      messageBreakdown: { toolResults: 8000, userMessages: 1200 },
      providerUsage: { inputTokens: 5910, outputTokens: 48 },
    }
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1450 },
      colorScheme: 'dark',
      reducedMotion: 'reduce',
    })
    // Stub the report at its source so the fixture has the same readings on the HTTP detail and the event stream.
    const read = host.host.bridge.detail.bind(host.host.bridge)
    const reports = vi.spyOn(host.host.bridge, 'detail').mockImplementation(async id => {
      const payload = await read(id)
      if (id !== sessionId) return payload
      const messages = payload.messages.map(message => ({ ...message }))
      const users = messages.filter(message => message.role === 'user')
      users.forEach((user, index) => {
        const used = [30000, 96000, 30000, 24000][index]!
        const at = new Date(Date.UTC(2026, 10, 24, 6, 12 + index)).toISOString()
        user.turn = {
          ...user.turn,
          contextWindow: {
            at,
            used,
            size: 200000,
            source: 'claude-sdk',
            epoch: index >= 2 ? 1 : 0,
            ...(index === 3 ? { breakdown } : {}),
          },
        }
      })
      const compressed = users[2]!
      const at = users[3]!.turn!.contextWindow!.at
      return {
        ...payload,
        messages,
        usageReport: { at, contextUsed: 24000, contextSize: 200000, contextSource: 'claude-sdk', contextEpoch: 1, breakdown },
        contextEvents: [
          {
            id: 'fixture-compact',
            at: new Date(Date.parse(compressed.turn!.contextWindow!.at) - 250).toISOString(),
            source: 'claude-sdk',
            status: 'completed',
            trigger: 'auto',
            beforeTokens: 96000,
            afterTokens: 30000,
            durationMs: 1200,
            turnId: compressed.id,
          },
        ],
      }
    })
    try {
      const page = await context.newPage()
      page.setDefaultTimeout(10_000)
      await enrollBrowser(page, host)
      await openSession(page, sessionId)
      const panel = page.locator('.session-context:not(.context-insights)')
      await openContextPanel(page, panel)
      const meter = panel.getByRole('meter', { name: '上下文窗口' })
      expect(await meter.getAttribute('aria-valuenow')).toBe('24000')
      expect(await meter.getAttribute('aria-valuetext')).toBe('24,000 / 200,000 tokens · 12%')
      const categories = panel.locator('.context-window-breakdown')
      await categories.getByRole('heading', { name: '窗口组成', exact: true }).waitFor()
      const used = categories.locator('.context-window-used-parts')
      expect(await used.innerText()).toContain('13,000')
      expect(await used.innerText()).not.toContain('压缩预留')
      await used.locator('.context-window-parts-bar').waitFor()
      expect(await used.locator('.ui-share-percent').allTextContents()).toContain('54.2%')
      const capacity = categories.locator('.context-window-capacity-parts')
      expect(await capacity.innerText()).toContain('压缩预留')
      expect(await capacity.innerText()).toContain('12,000')
      expect(await capacity.innerText()).toContain('164,000')
      await capacity.locator('.context-window-parts-bar').waitFor()
      expect(await capacity.locator('.ui-share-percent').allTextContents()).toEqual(['12%', '82%', '6%'])
      await categories.getByRole('heading', { name: '延迟加载', exact: true }).waitFor()
      await categories.getByText('未计入窗口占用', { exact: false }).waitFor()
      await categories.getByText('其中，消息包含', { exact: true }).click()
      const messageParts = categories.locator('.context-window-message-parts')
      expect(await messageParts.innerText()).toContain('8,000')
      expect(await messageParts.innerText()).toContain('3,800')
      await messageParts.locator('.context-window-parts-bar').waitFor()
      expect(await messageParts.locator('.ui-share-percent').allTextContents()).toContain('61.5%')
      const provider = categories.getByRole('heading', { name: '最近一次模型服务用量', exact: true }).locator('..')
      expect(await provider.getByText('5,910', { exact: true }).textContent()).toBe('5,910')
      expect(await provider.getByText('48', { exact: true }).textContent()).toBe('48')

      const rows = panel.locator('.context-window-choices')
      const earlier = rows.getByRole('button', { name: /^第 2 轮/u })
      expect(await earlier.innerText()).toContain('+66,000 tokens')
      const compacted = rows.getByRole('button', { name: /^第 3 轮/u })
      expect(await compacted.locator('.context-window-compaction-badge').textContent()).toBe('已压缩')
      expect(await compacted.innerText()).not.toContain('净变化')
      const ordinaryDecline = rows.getByRole('button', { name: /^第 4 轮/u })
      expect(await ordinaryDecline.innerText()).toContain('-6,000 tokens')
      expect(await ordinaryDecline.locator('.context-window-compaction-badge').count()).toBe(0)
      const chart = panel.getByRole('img', { name: /^已用 tokens/u })
      expect(await panel.locator('.context-window-plot-unit').textContent()).toBe('已用 tokens')
      expect(await chart.locator('.ui-chart-line').count()).toBe(2)
      expect(await chart.locator('.ui-chart-dot').count()).toBe(0)
      const compactions = panel.locator('.context-compactions')
      expect(await compactions.getByText('已完成', { exact: true }).textContent()).toBe('已完成')
      expect(await compactions.getByText('96,000 tokens', { exact: true }).textContent()).toBe('96,000 tokens')
      await categories.scrollIntoViewIfNeeded()
      await noHorizontalOverflow(page, panel)
      await page.mouse.move(4, 4)
      await page.screenshot({ path: `${OUTPUT}/context-claude-breakdown-1440-dark.png`, animations: 'disabled' })
      await categories.screenshot({ path: `${OUTPUT}/context-claude-composition-1440-dark.png`, animations: 'disabled' })
      await compactions.scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${OUTPUT}/context-claude-compaction-1440-dark.png`, animations: 'disabled' })
      await earlier.click()
      expect(await meter.getAttribute('aria-valuenow')).toBe('96000')
      expect(await categories.count()).toBe(0)
      await panel.getByRole('button', { name: '回到最新报告', exact: true }).click()
      await categories.waitFor()

      await page.setViewportSize({ width: 390, height: 844 })
      await settleShell(page)
      await openContextPanel(page, panel)
      await categories.waitFor()
      await noHorizontalOverflow(page, categories)
      const messagesDetail = categories.locator('details.context-window-messages')
      if ((await messagesDetail.getAttribute('open')) === null) await messagesDetail.locator('summary').click()
      await messageParts.locator('.context-window-parts-bar').waitFor()
      await categories
        .getByRole('heading', { name: '窗口组成', exact: true })
        .evaluate(element => element.scrollIntoView({ block: 'start' }))
      await page.screenshot({ path: `${OUTPUT}/context-claude-composition-390-dark.png`, animations: 'disabled' })
    } finally {
      reports.mockRestore()
      await context.close()
    }
  })

  for (const [width, theme] of [
    [1440, 'light'],
    [390, 'dark'],
  ] as const) {
    it(`chooses, takes back and sends a new context, and keeps its line at ${width} ${theme}`, async () => {
      const title = `echo context ${width}`
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { harnessId: 'fake-agent', prompt: title, requestId: randomUUID() },
      })
      await idle(sessionId)
      const { context, page } = await open(width, theme, title)
      const transcript = page.locator('.transcript')
      await send(page, 'recall')
      await transcript.getByText('recall: 1 earlier').waitFor()

      // /clear chooses it and empties the input; 保留上下文 takes it back without a request.
      await input(page).fill('/clear')
      await page
        .getByRole('listbox', { name: '命令与提示模板', exact: true })
        .getByRole('option', { name: /\/clear/ })
        .waitFor()
      await input(page).press('Enter')
      await armed(page).waitFor()
      expect(await promptValue(input(page))).toBe('')
      await page.screenshot({ path: `${OUTPUT}/armed-${width}.png` })
      await page.getByRole('button', { name: '保留上下文', exact: true }).click()
      await armed(page).waitFor({ state: 'detached' })

      const menu = () =>
        width === 390 ? page.locator('.topbar-title-button') : page.getByRole('button', { name: '会话操作', exact: true })
      await menu().click()
      await page.getByRole('menuitem', { name: '清空上下文' }).click()
      await armed(page).waitFor()
      await send(page, 'recall')
      await transcript.getByText('recall: 0 earlier').waitFor()
      await armed(page).waitFor({ state: 'detached' })
      await page.getByRole('note').filter({ hasText: '清空了上下文' }).waitFor()
      // The next turn continues the new context and draws no second line.
      await send(page, 'recall')
      await expect.poll(() => transcript.getByText('recall: 1 earlier').count()).toBe(2)
      expect(await page.locator('.timeline-divider').count()).toBe(1)

      await owner.json(`tasks/${sessionId}/config`, { method: 'POST', body: { configId: 'model', value: 'large' } })
      await send(page, 'echo bigger')
      await transcript.getByText('echo: echo bigger').waitFor()
      await page.getByRole('note').filter({ hasText: '模型 Small → Large' }).waitFor()
      await noHorizontalOverflow(page)
      await page.screenshot({ path: `${OUTPUT}/lines-${width}.png`, fullPage: true })

      const users = (await detail(sessionId)).messages.filter(message => message.role === 'user')
      expect(users.map(message => [message.text, message.freshContext ?? false])).toEqual([
        [title, false],
        ['recall', false],
        ['recall', true],
        ['recall', false],
        ['echo bigger', false],
      ])
      await page.reload()
      await connected(page)
      await page.getByRole('note').filter({ hasText: '清空了上下文' }).waitFor()
      expect(await page.locator('.timeline-divider').count()).toBe(2)

      // Chosen, then a turn starts from another device: the choice goes, and the menu says why it cannot be chosen now.
      await menu().click()
      await page.getByRole('menuitem', { name: '清空上下文' }).click()
      await armed(page).waitFor()
      await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'count 60', requestId: randomUUID() } })
      await armed(page).waitFor({ state: 'detached' })
      await menu().click()
      const item = page.getByRole('menuitem', { name: '清空上下文' })
      await expect.poll(() => item.getAttribute('aria-disabled')).toBe('true')
      await expect.poll(() => item.textContent()).toContain('这一轮结束后才能清空上下文')
      await page.keyboard.press('Escape')
      await idle(sessionId)
      await context.close()
    })
  }

  it('resends the latest turn on the new context that was chosen', async () => {
    const title = 'echo resent context'
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { harnessId: 'fake-agent', prompt: title, requestId: randomUUID() },
    })
    await idle(sessionId)
    const { context, page } = await open(1440, 'light', title)
    const transcript = page.locator('.transcript')
    await send(page, 'recall')
    await transcript.getByText('recall: 1 earlier').waitFor()
    await idle(sessionId)
    await input(page).fill('/clear')
    await page
      .getByRole('listbox', { name: '命令与提示模板', exact: true })
      .getByRole('option', { name: /\/clear/ })
      .waitFor()
    await input(page).press('Enter')
    await armed(page).waitFor()

    await transcript.getByText('recall: 1 earlier').hover()
    await transcript.getByRole('button', { name: '重试', exact: true }).last().click()
    await transcript.getByText('recall: 0 earlier').waitFor()
    await armed(page).waitFor({ state: 'detached' })
    await page.getByRole('note').filter({ hasText: '清空了上下文' }).waitFor()
    const users = (await detail(sessionId)).messages.filter(message => message.role === 'user')
    expect(users.map(message => [message.text, message.freshContext ?? false])).toEqual([
      [title, false],
      ['recall', false],
      ['recall', true],
    ])
    await context.close()
  })

  it('says the context is already cleared after a refused new-context send, and offers no way back', async () => {
    const title = 'echo refused context'
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { harnessId: 'shrinking-agent', prompt: title, requestId: randomUUID() },
    })
    await idle(sessionId)
    await owner.json(`tasks/${sessionId}/config`, { method: 'POST', body: { configId: 'model', value: 'large' } })
    await writeFile(models, 'small')
    const { context, page } = await open(390, 'dark', title)
    const transcript = page.locator('.transcript')
    await transcript.getByText(`echo: ${title}`).waitFor()
    await input(page).fill('/clear')
    await page
      .getByRole('listbox', { name: '命令与提示模板', exact: true })
      .getByRole('option', { name: /\/clear/ })
      .waitFor()
    await input(page).press('Enter')
    await armed(page).waitFor()
    const refused = page.waitForResponse(
      response => response.url().endsWith(`/tasks/${sessionId}/prompt`) && response.request().method() === 'POST',
    )
    await send(page, 'recall')
    expect((await refused).status()).toBe(409)
    await expect.poll(() => input(page).isEditable()).toBe(true)
    await expect.poll(async () => (await detail(sessionId)).contextCleared).toBe(true)
    await expect.poll(async () => (await detail(sessionId)).messages.filter(message => message.role === 'user').length).toBe(1)
    const drawer = page.getByRole('region', { name: '清空上下文' })
    await drawer.getByText('上下文已经清空').waitFor()
    await armed(page).waitFor()
    expect(await page.getByRole('button', { name: '保留上下文', exact: true }).count()).toBe(0)
    await noHorizontalOverflow(page)
    await page.screenshot({ path: `${OUTPUT}/refused-390.png` })

    // After a reload the page reads the same from the Host, and the menu offers no clear either.
    await page.reload()
    await connected(page)
    await drawer.getByText('上下文已经清空').waitFor()
    expect(await page.getByRole('button', { name: '保留上下文', exact: true }).count()).toBe(0)
    await page.locator('.topbar-title-button').click()
    expect(await page.getByRole('menuitem', { name: /清空上下文|保留上下文/ }).count()).toBe(0)
    await page.keyboard.press('Escape')

    await writeFile(models, 'small,large')
    await send(page, 'recall')
    await transcript.getByText('recall: 0 earlier').waitFor()
    await drawer.waitFor({ state: 'detached' })
    await page.getByRole('note').filter({ hasText: '清空了上下文' }).waitFor()
    const users = (await detail(sessionId)).messages.filter(message => message.role === 'user')
    expect(users.map(message => [message.text, message.freshContext ?? false])).toEqual([
      [title, false],
      ['recall', true],
    ])
    await context.close()
  })
})
