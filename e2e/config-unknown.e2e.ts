import { chromium, type Browser, type Page } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSession } from './helpers/layout.ts'

const OUTPUT = 'test-results/config-unknown'

/**
 * An OpenCode-shaped Harness (the fake agent's `opencode` shape) that never answers a model change: the composer says
 * 结果未知 in place, 核对 settles it from the Agent's own reading, and a new pick then goes through.
 */
describe('a config change the Harness never answers', () => {
  let directory: string
  let answer: string
  let host: TestHost
  let owner: TestDevice
  let browser: Browser
  let sessionId: string

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'latch-e2e-config-unknown-'))
    answer = join(directory, 'config-answer')
    host = await startTestHost({ demo: false })
    owner = await host.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: {
        id: 'opencode-shaped',
        name: 'OpenCode',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        presetId: 'opencode',
        env: {
          FAKE_ACP_CONFIG: 'options',
          FAKE_ACP_SHAPE: 'opencode',
          FAKE_ACP_MODES: 'build,plan',
          FAKE_ACP_INITIAL_MODE: 'build',
          FAKE_ACP_CAPS: 'resume',
          FAKE_ACP_STATE: join(directory, 'state.json'),
          FAKE_ACP_MODELS: 'opencode/big-pickle,opencode/beam-free,opencode/grok-code',
          FAKE_ACP_CONFIG_ANSWER_FILE: answer,
        },
      },
    })
    const created = await owner.confirmed('tasks', {
      method: 'POST',
      body: { harnessId: 'opencode-shaped', prompt: 'echo 换模型', requestId: randomUUID() },
    })
    expect(created.status).toBe(201)
    sessionId = ((await created.json()) as { sessionId: string }).sessionId
    for (let tries = 0; (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status !== 'idle'; tries++) {
      if (tries > 200) throw new Error('the session did not settle')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
    await rm(directory, { recursive: true, force: true })
  })

  const open = async (width: number, theme: 'light' | 'dark'): Promise<Page> => {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      colorScheme: theme,
      locale: 'zh-CN',
      reducedMotion: 'reduce',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await enrollBrowser(page, host, { scopes: ['view', 'run', 'admin'] })
    await connected(page)
    await openSession(page, sessionId)
    await page.getByRole('textbox', { name: '继续对话', exact: true }).waitFor()
    return page
  }
  const model = async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).config?.find(row => row.id === 'model')?.currentValue
  const pick = async (page: Page, name: string, phone: boolean) => {
    await page.locator('button.model-picker').click()
    await page
      .getByRole(phone ? 'radio' : 'menuitemradio', { name: new RegExp(`^${name}`, 'u') })
      .first()
      .click()
  }

  it('says 结果未知 in place with the time, 核对 settles it from the reading, and a new pick goes through', async () => {
    await writeFile(answer, 'silent')
    const page = await open(1440, 'light')
    const bar = page.locator('[data-config-unknown]')
    await pick(page, 'opencode/Beam Free', false)
    // While the Harness has not answered: the chip waits on it by name.
    await page.getByText('等 OpenCode 回应…').first().waitFor()
    await page.screenshot({ path: `${OUTPUT}/waiting--light--1440.png`, animations: 'disabled' })
    await bar.waitFor({ timeout: 60_000 })
    expect((await bar.locator('.run-bar-what').innerText()).replace(/\s+/gu, ' ')).toMatch(
      /^模型 opencode\/Beam Free · \d{2}:\d{2} · 结果未知 · 核对 · 重试同一请求$/u,
    )
    // The chip keeps the value the Host confirmed and marks it; thinking is not the change and is not marked.
    await page.getByRole('button', { name: /^模型：opencode\/Big Pickle · 结果未知$/u }).waitFor()
    expect(await page.getByRole('button', { name: /^思考：Default$/u }).count()).toBe(1)
    // Not an error: no red banner.
    expect(await page.locator('[data-tone="error"], .action-error').filter({ hasText: '结果' }).count()).toBe(0)
    await noHorizontalOverflow(page)
    await page.screenshot({ path: `${OUTPUT}/unknown--light--1440.png`, animations: 'disabled' })
    // What 核对 does is behind the ⓘ: it restarts the Harness's process.
    await bar.getByRole('button', { name: '核对说明', exact: true }).click()
    await page.getByText('核对会先结束这个会话的 OpenCode 进程').waitFor()
    await page.screenshot({ path: `${OUTPUT}/check-hint--light--1440.png`, animations: 'disabled' })
    await bar.getByRole('button', { name: '核对说明', exact: true }).click()
    // 重试同一请求 answers from the Host's receipt: still unknown, nothing sent again.
    await bar.getByRole('button', { name: '重试同一请求', exact: true }).click()
    await bar.waitFor()
    await bar.getByRole('button', { name: '核对', exact: true }).click()
    await bar.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: /^模型：opencode\/Beam Free$/u }).waitFor()
    expect(await model()).toBe('opencode/beam-free')
    await page.screenshot({ path: `${OUTPUT}/settled--light--1440.png`, animations: 'disabled' })
    // Choosing again is a new request, which this time is answered.
    await writeFile(answer, '')
    await pick(page, 'opencode/Big Pickle', false)
    await page.getByRole('button', { name: /^模型：opencode\/Big Pickle$/u }).waitFor()
    expect(await model()).toBe('opencode/big-pickle')
    await page.context().close()
  })

  it.each([
    [1440, 'dark'],
    [390, 'light'],
    [390, 'dark'],
  ] as const)('shows the unknown change in place at %i, %s', async (width, theme) => {
    await writeFile(answer, 'silent-drop')
    const page = await open(width, theme)
    const bar = page.locator('[data-config-unknown]')
    const before = await model()
    const target = before === 'opencode/beam-free' ? 'opencode/Big Pickle' : 'opencode/Beam Free'
    await pick(page, target, width < 768)
    await bar.waitFor({ timeout: 60_000 })
    await noHorizontalOverflow(page)
    await page.screenshot({ path: `${OUTPUT}/unknown--${theme}--${width}.png`, animations: 'disabled' })
    // Never taken: 核对 reads the old value and the change is failed; the chip keeps what the Host confirmed.
    await bar.getByRole('button', { name: '核对', exact: true }).click()
    await bar.waitFor({ state: 'detached' })
    expect(await model()).toBe(before)
    await page.screenshot({ path: `${OUTPUT}/failed--${theme}--${width}.png`, animations: 'disabled' })
    await page.context().close()
  })

  it('sets down a change 核对 cannot settle: the chip shows what the Agent runs on, and a new pick goes through', async () => {
    await writeFile(answer, 'silent-drop')
    const page = await open(1440, 'light')
    const sent: string[] = []
    page.on('request', request => {
      if (request.method() === 'POST' && /\/tasks\/[^/]+\/config$/u.test(request.url()))
        sent.push((JSON.parse(request.postData() ?? '{}') as { requestId?: string }).requestId ?? '')
    })
    const bar = page.locator('[data-config-unknown]')
    const before = await model()
    const target = before === 'opencode/beam-free' ? 'opencode/Big Pickle' : 'opencode/Beam Free'
    await pick(page, target, false)
    await bar.waitFor({ timeout: 60_000 })
    expect(await bar.getByRole('button', { name: '放弃这次结果', exact: true }).count()).toBe(0)
    // Meanwhile the session moved to a third model (as another device would): neither the old value nor the asked one.
    const state = join(directory, 'state.json')
    const sessions = JSON.parse(await readFile(state, 'utf8')) as Record<string, { model: string }>
    for (const session of Object.values(sessions)) session.model = 'opencode/grok-code'
    await writeFile(state, JSON.stringify(sessions))
    await bar.getByRole('button', { name: '核对', exact: true }).click()
    await page.getByText('OpenCode 现在用的既不是原来的值').first().waitFor()
    await page.screenshot({ path: `${OUTPUT}/neither--light--1440.png`, animations: 'disabled' })
    await bar.getByRole('button', { name: '放弃这次结果', exact: true }).click()
    await bar.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: /^模型：opencode\/Grok Code$/u }).waitFor()
    // Choosing again is a new request; the one set down is never sent again.
    await writeFile(answer, '')
    await pick(page, 'opencode/Beam Free', false)
    await page.getByRole('button', { name: /^模型：opencode\/Beam Free$/u }).waitFor()
    expect(await model()).toBe('opencode/beam-free')
    expect(sent).toHaveLength(2)
    expect(new Set(sent).size).toBe(2)
    await page.context().close()
  })
})
