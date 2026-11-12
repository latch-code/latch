import { chromium, type Browser, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, installFakeGh, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, settleShell } from './helpers/layout.ts'

const OUT = 'test-results/pr-checks'
const SLOW = { timeout: 30_000 }

async function shot(page: Page, name: string) {
  await mkdir(OUT, { recursive: true })
  await page.waitForTimeout(250)
  await page.screenshot({ path: join(OUT, `${name}.png`) })
}

/** The state in light and dark, and at 768 when asked; the page comes back as it was. */
async function shots(page: Page, name: string, tablet = false) {
  const { width, height } = page.viewportSize()!
  await shot(page, `${name}--${width}--light`)
  await page.emulateMedia({ colorScheme: 'dark' })
  await shot(page, `${name}--${width}--dark`)
  if (tablet) {
    await page.setViewportSize({ width: 768, height: 1024 })
    await shot(page, `${name}--768--dark`)
    await page.emulateMedia({ colorScheme: 'light' })
    await shot(page, `${name}--768--light`)
    await page.setViewportSize({ width, height })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

async function choose(page: Page, sessionId: string) {
  await page.locator('.app-shell').waitFor()
  await settleShell(page)
  const row = page.locator(`[data-task-id="${sessionId}"]`).first()
  if (!(await row.isVisible())) await page.getByRole('button', { name: '打开会话列表', exact: true }).click()
  await row.click()
  await settleShell(page)
}

async function openBrowser(browser: Browser, host: TestHost, owner: TestDevice, sessionId: string, width: number, height: number) {
  const context = await browser.newContext({
    viewport: { width, height },
    locale: 'zh-CN',
    ...(width < 768 ? { isMobile: true, hasTouch: true } : {}),
  })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  const name = `PR ${randomUUID()}`
  await enrollBrowser(page, host, { name, scopes: ['admin'] })
  const devices = await owner.json<{ devices: Array<{ id: string; name: string }> }>('devices')
  const id = devices.devices.find(item => item.name === name)!.id
  expect((await owner.confirmed(`devices/${id}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
  await page.reload()
  await choose(page, sessionId)
  return { context, page }
}

async function openDelivery(page: Page): Promise<Locator> {
  const tab = page.getByRole('tab', { name: '交付', exact: true })
  if (!(await tab.isVisible())) {
    await page.getByRole('button', { name: '侧边面板', exact: true }).first().click()
    const row = page.locator('.panel-launcher-row', { hasText: '交付' })
    if (await row.isVisible()) await row.click()
    else await page.getByRole('tab', { name: '交付', exact: true }).click()
  } else await tab.click()
  const panel = page.locator('.delivery-panel').filter({ visible: true })
  await panel.waitFor()
  return panel
}

const comeBack = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('focus')))

it('creates a PR through a fake gh, binds an open one instead of a second, and brings checks and reviews back into the draft', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'latch-pr-e2e-'))
  const home = join(scratch, 'home')
  await mkdir(home)
  const gh = await installFakeGh(join(scratch, 'gh'))
  const host = await startTestHost({
    demo: false,
    gitDelivery: {
      home,
      // Tokens the Host holds never reach gh: the fake records a violation if they do.
      hostEnv: { HOME: home, USER: 'tester', PATH: '/usr/bin:/bin', TMPDIR: scratch, GH_TOKEN: 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      shell: gh.shell,
    },
  })
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' }
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: host.workspaceRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
        .toString('utf8')
        .trim()
    const bare = join(scratch, 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env })
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Tester')
    git('config', 'user.email', 'tester@example.invalid')
    // The fake agent's edits stay out of the way of the PR step.
    await appendFile(join(host.workspaceRoot, '.git', 'info', 'exclude'), 'agent-edit.txt\ncommand-edit.txt\n')
    git('commit', '-q', '--allow-empty', '-m', 'first')
    // GitHub by name, a local bare repository in fact: nothing leaves this computer.
    git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git')
    git('config', 'remote.origin.pushurl', bare)
    git('push', '-q', '-u', 'origin', 'main')
    git('switch', '-q', '-c', 'feat/currency-filter')
    git('commit', '-q', '--allow-empty', '-m', 'Add a currency filter to transactions')
    git('push', '-q', '-u', 'origin', 'feat/currency-filter')

    const owner = await host.enroll({ listener: 'unix' })
    expect(
      (
        await owner.confirmed('agents', {
          method: 'POST',
          body: { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT] },
        })
      ).status,
    ).toBe(201)
    const start = async () => {
      const created = await owner.confirmed('tasks', {
        method: 'POST',
        body: { prompt: 'shell-edit', requestId: randomUUID(), mode: 'agent', harnessId: 'fake', workspaceId: 'default' },
      })
      const { sessionId } = (await created.json()) as { sessionId: string }
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, SLOW).toBe('idle')
      return sessionId
    }
    const first = await start()
    const second = await start()

    const desk = await openBrowser(browser, host, owner, first, 1440, 900)
    const page = desk.page
    const panel = await openDelivery(page)
    const primary = panel.locator('.delivery-foot .ui-button[data-variant="primary"]')
    const section = panel.getByRole('region', { name: 'PR', exact: true })
    await expect.poll(() => primary.innerText(), SLOW).toBe('创建 PR')
    expect(await panel.locator('.delivery-steps [aria-current="step"]').innerText()).toBe('PR')
    expect(await panel.locator('.delivery-steps li').allInnerTexts()).toEqual(['暂存', '提交', '推送', 'PR'])
    // The title defaults to the last commit's subject, the base to the repository's default branch.
    expect(await section.getByLabel('标题').getAttribute('placeholder')).toBe('Add a currency filter to transactions')
    expect(await section.getByLabel('合入').getAttribute('placeholder')).toBe('main')
    await section.getByLabel('正文').fill('Closes #4')
    await shots(page, 'create', true)

    await primary.click()
    const row = section.locator('.delivery-pr')
    await row.getByText('#1').waitFor()
    await row.getByText('开启', { exact: true }).waitFor()
    expect(await row.getByRole('link', { name: '打开' }).getAttribute('href')).toBe('https://github.com/acme/widgets/pull/1')
    expect(await row.getByRole('link', { name: '打开' }).getAttribute('target')).toBe('_blank')
    await section.getByText('没有检查').waitFor()
    expect(await primary.count()).toBe(0)
    expect(await gh.bodies()).toEqual(['Closes #4'])
    const creates = async () => (await gh.calls()).filter(args => args[0] === 'pr' && args[1] === 'create').length
    expect(await creates()).toBe(1)
    await shots(page, 'bound')

    // Another session on the same branch: 创建 PR finds the open one and binds it, nothing is created twice.
    await choose(page, second)
    const other = await openDelivery(page)
    await expect.poll(() => other.locator('.delivery-foot .ui-button[data-variant="primary"]').innerText(), SLOW).toBe('创建 PR')
    await other.locator('.delivery-foot .ui-button[data-variant="primary"]').click()
    await other.locator('.delivery-pr').getByText('#1').waitFor()
    expect(await creates()).toBe(1)
    await choose(page, first)
    await openDelivery(page)

    // A failing check: its log, read on request, and into the draft fenced with the check's name; nothing is sent.
    const head = git('rev-parse', 'HEAD')
    await gh.update(state => {
      const pr = state.prs[0]!
      pr.headRefOid = head
      pr.reviewDecision = 'CHANGES_REQUESTED'
      pr.statusCheckRollup = [
        {
          __typename: 'CheckRun',
          name: 'lint',
          workflowName: 'CI',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          startedAt: '2026-11-12T10:00:00Z',
          completedAt: '2026-11-12T10:00:41Z',
        },
        {
          __typename: 'CheckRun',
          name: 'test (node 24)',
          workflowName: 'CI',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          startedAt: '2026-11-12T10:00:00Z',
          completedAt: '2026-11-12T10:01:12Z',
          detailsUrl: 'https://github.com/acme/widgets/actions/runs/7/job/42',
        },
        { __typename: 'CheckRun', name: 'docs', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SKIPPED' },
      ]
      state.logs['42'] = [
        'test (node 24)\tRun tests\t2026-11-12T10:01:10.0000000Z FAIL src/api/transactions.test.ts > rounds JPY to 0 decimals',
        'test (node 24)\tRun tests\t2026-11-12T10:01:10.0000000Z   expected "¥1,235", received "¥1,234.50"',
        'test (node 24)\tRun tests\t2026-11-12T10:01:11.0000000Z ##[error]Process completed with exit code 1.',
      ].join('\n')
      pr.reviews = [
        { author: { login: 'reviewer' }, state: 'CHANGES_REQUESTED', body: 'Round JPY to whole yen.', submittedAt: '2026-11-12T10:05:00Z' },
      ]
      pr.lineComments = [
        {
          user: { login: 'reviewer' },
          path: 'src/filters/CurrencyFilter.tsx',
          line: 18,
          body: "'formatCode' is declared but never used",
          created_at: '2026-11-12T10:06:00Z',
        },
      ]
    })
    await section.getByRole('button', { name: '刷新' }).click()
    const failing = section.locator('.delivery-check[data-state="fail"]')
    await failing.getByText('test (node 24)').waitFor()
    await section.locator('.delivery-check[data-state="pass"]').getByText('0:41').waitFor()
    await section.locator('.delivery-check[data-state="skipped"]').getByText('跳过').waitFor()
    await panel.locator('.delivery-bar').getByText('检查失败').waitFor()
    await row.getByText('要求修改').waitFor()
    await failing.getByRole('button', { name: '查看日志' }).click()
    const log = section.getByLabel('test (node 24) 的日志')
    await expect.poll(() => log.innerText(), SLOW).toContain('rounds JPY to 0 decimals')
    expect(await log.innerText()).toContain('error: Process completed with exit code 1.')
    expect(await log.innerText()).not.toContain('2026-11-12T')
    await shots(page, 'check-failed', true)
    const messages = (await owner.json<TaskDetail>(`tasks/${first}`)).messages.length
    await section.locator('.delivery-log').getByRole('button', { name: '加入对话' }).click()
    const draft = page.locator('.composer textarea').first()
    await expect.poll(() => draft.inputValue(), SLOW).toContain(`PR #1 的检查 test (node 24) 失败（${head.slice(0, 7)}）：`)
    expect(await draft.inputValue()).toContain('```text\n[Run tests]\nFAIL src/api/transactions.test.ts')
    expect((await owner.json<TaskDetail>(`tasks/${first}`)).messages.length).toBe(messages)
    await draft.fill('')

    // Reviews and comments, read-only, each into the draft with its author and place.
    const comment = section.getByRole('article', { name: 'reviewer · src/filters/CurrencyFilter.tsx:18' })
    await comment.getByText("'formatCode' is declared but never used").waitFor()
    await section.getByRole('article', { name: 'reviewer · 要求修改' }).getByText('Round JPY to whole yen.').waitFor()
    await comment.getByRole('button', { name: '加入对话' }).click()
    await expect
      .poll(() => draft.inputValue(), SLOW)
      .toBe("PR #1 · reviewer · src/filters/CurrencyFilter.tsx:18：\n\n```text\n'formatCode' is declared but never used\n```")
    await draft.fill('')
    await shots(page, 'reviews')

    // The Agent commits again here: the checks are of the older commit until GitHub reports the new one.
    git('commit', '-q', '--allow-empty', '-m', 'Round JPY')
    await comeBack(page)
    await section.getByText('旧提交', { exact: true }).waitFor()
    await shots(page, 'stale')

    // gh logged out, then gone: short words, the command behind the Hint.
    await gh.update(state => {
      state.loggedIn = false
    })
    await section.getByRole('button', { name: '刷新' }).click()
    await section.getByText('gh 未登录').waitFor()
    await section.locator('.delivery-line', { hasText: 'gh 未登录' }).getByRole('button', { name: '说明' }).click()
    await section.getByText('在终端里运行 gh auth login。').waitFor()
    await shots(page, 'logged-out')
    await gh.setMissing(true)
    await section.getByRole('button', { name: '重试' }).click()
    await section.getByText('没有 gh', { exact: true }).waitFor()
    await gh.setMissing(false)
    await gh.update(state => {
      state.loggedIn = true
    })

    // A phone at 390 and 320: the same step, nothing wider than the window.
    const phone = await openBrowser(browser, host, owner, first, 390, 844)
    const small = await openDelivery(phone.page)
    const smallSection = small.getByRole('region', { name: 'PR', exact: true })
    await smallSection.locator('.delivery-check[data-state="fail"]').getByText('test (node 24)').waitFor()
    await noHorizontalOverflow(phone.page)
    await shots(phone.page, 'check-failed')
    await smallSection.locator('.delivery-check[data-state="fail"]').getByRole('button', { name: '查看日志' }).click()
    await smallSection.getByLabel('test (node 24) 的日志').waitFor()
    await noHorizontalOverflow(phone.page)
    await shots(phone.page, 'log')
    await phone.page.setViewportSize({ width: 320, height: 700 })
    await noHorizontalOverflow(phone.page)
    await shots(phone.page, 'log')

    expect(await gh.violations()).toEqual([])
    expect((await gh.calls()).some(args => args.includes('auth'))).toBe(false)
    for (const item of [desk, phone]) await item.context.close()
  } finally {
    await browser.close()
    await host.close()
    await rm(scratch, { recursive: true, force: true })
  }
})
