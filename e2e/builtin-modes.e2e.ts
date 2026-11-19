import { chromium, type Browser, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import type { TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSession, permissionControl, permissionModes, permissionWords } from './helpers/layout.ts'

const OUTPUT = 'test-results/builtin-modes'

/** What the fixture model writes next, and what it answers when asked to judge a call. */
const script: { path?: string; verdict: string } = { verdict: '{"decision":"allow","reason":"用户要求写这个文件"}' }

/**
 * A model that writes the next note (or `script.path`) through Latch 内置's own file tool, then says it is done; asked
 * with the reviewer prompt, it answers `script.verdict`. No real model runs.
 */
function writer(): HarnessPlugin {
  let notes = 0
  return {
    id: 'writer-fixture',
    name: '写入验收',
    version: '1.0.0',
    description: '仅测试使用。',
    activate(context) {
      context.registerProvider({
        id: 'writer',
        name: 'Writer fixture',
        model: 'fixture',
        async *stream({ messages }) {
          if (messages[0]?.role === 'system' && messages[0].content.startsWith('你是 Latch 的权限审阅者')) {
            yield { type: 'text', text: script.verdict }
            yield { type: 'usage', inputTokens: 30, outputTokens: 5 }
            yield { type: 'finish', reason: 'stop' }
            return
          }
          if (messages.at(-1)?.role === 'tool') {
            yield { type: 'text', text: '写好了。' }
            yield { type: 'finish', reason: 'stop' }
            return
          }
          notes++
          yield {
            type: 'tool-call',
            call: {
              id: `call-${randomUUID()}`,
              name: 'write_file',
              arguments: { path: script.path ?? `note-${notes}.md`, content: `第 ${notes} 条\n` },
            },
          }
          yield { type: 'finish', reason: 'tool-calls' }
        },
      })
    },
  }
}

describe('Latch 内置’s permission levels in a browser', () => {
  let host: TestHost
  let owner: TestDevice
  let browser: Browser
  let draftAfter = ''

  const detail = (id: string) => owner.json<TaskDetail>(`tasks/${id}`)
  const open = async (width: number, theme: 'light' | 'dark'): Promise<Page> => {
    const context = await browser.newContext({
      viewport: { width, height: width < 768 ? 844 : 900 },
      colorScheme: theme,
      locale: 'zh-CN',
      reducedMotion: 'reduce',
      ...(width < 768 ? { isMobile: true, hasTouch: true } : {}),
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await enrollBrowser(page, host, { scopes: ['view', 'run', 'approve:standard', 'approve:elevated'] })
    await connected(page)
    return page
  }
  const shot = (page: Page, name: string) => page.screenshot({ path: `${OUTPUT}/${name}.png`, animations: 'disabled' })

  beforeAll(async () => {
    host = await startTestHost({ demo: false, providerId: 'writer', plugins: [writer()] })
    owner = await host.enroll({ listener: 'unix' })
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    // What a later draft shows after a pick, for the report.
    if (draftAfter) console.info(`next draft: ${draftAfter}`)
    await browser?.close()
    await host?.close()
  })

  it('offers every level, asks for a write at 先问你 and writes unasked at 按规则放行', async () => {
    const { sessionId } = await owner.confirmedJson<{ sessionId: string }>('tasks', {
      body: { prompt: '写第一条笔记', requestId: randomUUID(), mode: 'agent', model: { providerId: 'writer', model: 'fixture' } },
    })
    // 先问你: the write waits for the person.
    await expect.poll(async () => (await detail(sessionId)).approvals.length, { timeout: 15_000 }).toBe(1)
    const page = await open(1440, 'light')
    try {
      await openSession(page, sessionId)
      const card = page.locator('[data-approval-id]')
      await card.getByRole('button', { name: '允许', exact: true }).waitFor()
      expect(await permissionWords(page)).toBe('权限：先问你')
      await shot(page, 'ask-approval-1440-light')
      await card.getByRole('button', { name: '允许', exact: true }).click()
      await expect.poll(async () => (await detail(sessionId)).summary.status, { timeout: 15_000 }).toBe('idle')

      await permissionControl(page).click()
      const modes = permissionModes(page)
      await modes.waitFor()
      expect(
        await modes
          .getByRole('radio')
          .allInnerTexts()
          .then(texts => texts.length),
      ).toBe(5)
      for (const name of ['只看不改', '先问你', '按规则放行', '由模型判断', '不再询问'])
        await modes.getByRole('radio', { name, exact: true }).waitFor()
      await expect.poll(() => modes.locator('.ui-mode-strip-name').innerText()).toBe('先问你')
      await modes.getByRole('radio', { name: '按规则放行', exact: true }).click()
      await expect.poll(async () => (await detail(sessionId)).permission?.expectedMode).toBe('rule')
      await expect.poll(() => modes.locator('.ui-mode-strip-name').innerText()).toBe('按规则放行')
      await expect.poll(() => permissionWords(page)).toBe('权限：按规则放行')
      await noHorizontalOverflow(page)
      await shot(page, 'strip-rule-1440-light')
      await page.keyboard.press('Escape')
      await modes.waitFor({ state: 'hidden' })

      // 按规则放行: the next write in the project runs with no one asked.
      const input = page.getByRole('textbox', { name: '继续对话', exact: true })
      await input.fill('再写一条')
      await input.press('Meta+Enter')
      await expect
        .poll(
          async () => (await detail(sessionId)).messages.filter(message => message.role === 'tool' && message.state === 'completed').length,
          {
            timeout: 15_000,
          },
        )
        .toBe(2)
      await expect.poll(async () => (await detail(sessionId)).summary.status, { timeout: 15_000 }).toBe('idle')
      const settled = await detail(sessionId)
      const writes = settled.messages.filter(message => message.role === 'tool')
      expect(writes).toHaveLength(2)
      expect(writes[0]!.tool?.decision?.outcome).toBe('allowed')
      expect(writes[1]!.state).toBe('completed')
      expect(writes[1]!.tool?.decision).toBeUndefined()
      expect(settled.approvals).toHaveLength(0)
      expect(await readFile(join(settled.summary.cwd!, 'note-2.md'), 'utf8')).toBe('第 2 条\n')
      await page.locator('[data-approval-id]').waitFor({ state: 'detached' })
      await expect.poll(() => page.getByText(/思考中/u).count(), { timeout: 15_000 }).toBe(0)
      await shot(page, 'rule-ran-1440-light')

      // The widening is on record, by this browser.
      const records = (await readFile(join(host.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as { action: string; target?: string })
      expect(records.some(record => record.action === 'task.mode.widened' && record.target === sessionId)).toBe(true)
    } finally {
      await page.context().close()
    }

    // The strip in every width and scheme, at the level the session is now.
    for (const [width, theme] of [
      [1440, 'dark'],
      [390, 'light'],
      [390, 'dark'],
    ] as const) {
      const view = await open(width, theme)
      try {
        await openSession(view, sessionId)
        await permissionControl(view).click()
        const modes = permissionModes(view)
        await modes.waitFor()
        await expect.poll(() => modes.locator('.ui-mode-strip-name').innerText()).toBe('按规则放行')
        await noHorizontalOverflow(view)
        await shot(view, `strip-rule-${width}-${theme}`)
      } finally {
        await view.context().close()
      }
    }
  })

  const audit = async () =>
    (await readFile(join(host.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { action: string; target?: string; detail: Record<string, unknown> })
  const send = async (sessionId: string, prompt: string) => {
    const before = (await detail(sessionId)).messages.filter(message => message.role === 'user').length
    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt, requestId: randomUUID() } })
    await expect.poll(async () => (await detail(sessionId)).messages.filter(message => message.role === 'user').length).toBe(before + 1)
  }
  const idle = (sessionId: string) => expect.poll(async () => (await detail(sessionId)).summary.status, { timeout: 15_000 }).toBe('idle')

  it('shows the model’s verdict on the call’s own row, and a refusal at 只看不改', async () => {
    script.path = undefined
    const { sessionId } = await owner.confirmedJson<{ sessionId: string }>('tasks', {
      body: { prompt: '准备', requestId: randomUUID(), mode: 'agent', config: [{ configId: 'mode', value: 'model' }] },
    })
    await idle(sessionId)
    // A protected file is R2: the model judges it first.
    script.path = '.env'
    await send(sessionId, '写 .env')
    await idle(sessionId)
    const allowed = (await detail(sessionId)).messages.filter(message => message.role === 'tool').at(-1)!
    expect(allowed.state).toBe('completed')
    expect(allowed.tool?.judged).toEqual({ by: 'Latch 内置', outcome: 'approved', own: true, reason: '用户要求写这个文件' })
    script.verdict = '{"decision":"ask","reason":"会改动环境变量文件"}'
    await send(sessionId, '再写 .env')
    await expect.poll(async () => (await detail(sessionId)).approvals.length, { timeout: 15_000 }).toBe(1)
    const referred = (await detail(sessionId)).messages.filter(message => message.role === 'tool').at(-1)!
    expect(referred.tool?.judged).toMatchObject({ outcome: 'referred', own: true, reason: '会改动环境变量文件' })
    await owner.json(`approvals/${(await detail(sessionId)).approvals[0]!.id}`, { method: 'POST', body: { decision: 'allow' } })
    await idle(sessionId)
    expect(
      (await audit())
        .filter(record => record.action === 'task.tool.judged' && record.target === sessionId)
        .map(record => record.detail.outcome),
    ).toEqual(['approved', 'referred'])

    expect(await owner.json(`tasks/${sessionId}/config`, { method: 'POST', body: { configId: 'mode', value: 'plan' } })).toEqual({
      accepted: true,
    })
    script.path = 'plan.md'
    await send(sessionId, '只看不改时写')
    await idle(sessionId)
    const refused = (await detail(sessionId)).messages.filter(message => message.role === 'tool').at(-1)!
    expect(refused.state).toBe('failed')
    expect(refused.tool?.blocked).toMatchObject({ by: 'Latch 内置', source: 'rule' })

    for (const [width, theme] of [
      [1440, 'light'],
      [390, 'dark'],
    ] as const) {
      const page = await open(width, theme)
      try {
        await openSession(page, sessionId)
        const rows = page.locator('.tool-card')
        // Each turn folds its work; open them all, then the rows.
        for (const fold of await page.getByRole('button', { name: /已工作/u }).all()) await fold.click()
        await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(3)
        // The verdict in the row's state slot; who decided and why in its hint, since an edit's row opens in Changes.
        const judged = rows.filter({ has: page.locator('.tool-card-state', { hasText: '放行' }) }).first()
        await judged.scrollIntoViewIfNeeded()
        expect(await judged.locator('.tool-card-header').getAttribute('title')).toContain('模型放行，不是你的批准：用户要求写这个文件')
        expect(await rows.filter({ has: page.locator('.tool-card-header[title*="模型交给你决定：会改动环境变量文件"]') }).count()).toBe(1)
        await shot(page, `judged-row-${width}-${theme}`)
        await page
          .getByText(/被 Latch 内置 自己的规则或当前模式拦下/u)
          .first()
          .waitFor()
        await noHorizontalOverflow(page)
        await shot(page, `judged-rows-${width}-${theme}`)
      } finally {
        await page.context().close()
      }
    }
  })

  it('starts a new session at the level picked in its draft, with the widening on record', async () => {
    script.path = undefined
    const page = await open(1440, 'light')
    try {
      await page
        .getByRole('button', { name: /^新会话/u })
        .first()
        .click()
      const input = page.getByRole('textbox', { name: '新会话消息', exact: true }).filter({ visible: true }).first()
      await input.waitFor()
      expect(await permissionWords(page)).toBe('权限：先问你')
      await permissionControl(page).click()
      const modes = permissionModes(page)
      await modes.waitFor()
      await modes.getByRole('radio', { name: '按规则放行', exact: true }).click()
      await expect.poll(() => permissionWords(page)).toBe('权限：按规则放行')
      await shot(page, 'draft-rule-1440-light')
      await page.keyboard.press('Escape')
      const known = new Set((await owner.json<{ tasks: Array<{ id: string }> }>('snapshot')).tasks.map(task => task.id))
      await input.fill('从草稿开始写')
      await input.press('Meta+Enter')
      let sessionId = ''
      await expect
        .poll(async () => {
          sessionId = (await owner.json<{ tasks: Array<{ id: string }> }>('snapshot')).tasks.find(task => !known.has(task.id))?.id ?? ''
          return sessionId
        })
        .not.toBe('')
      await idle(sessionId)
      const started = await detail(sessionId)
      expect(started.permission?.expectedMode).toBe('rule')
      expect(started.approvals).toHaveLength(0)
      expect(started.messages.filter(message => message.role === 'tool').at(-1)?.state).toBe('completed')
      expect((await audit()).some(record => record.action === 'task.mode.widened' && record.target === sessionId)).toBe(true)
      // A new draft on this device keeps the person's pick for this Harness, as every Harness's draft does.
      await page
        .getByRole('button', { name: /^新会话/u })
        .first()
        .click()
      await input.waitFor()
      draftAfter = await permissionWords(page)
    } finally {
      await page.context().close()
    }
  })
})
