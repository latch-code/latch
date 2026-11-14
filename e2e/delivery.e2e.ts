import { chromium, type Browser, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, installFakeGh, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSession, settleShell } from './helpers/layout.ts'

const OUT = 'test-results/delivery'
const SLOW = { timeout: 30_000 }
/**
 * How long these Hosts wait for a push, in place of the product's two minutes, so a hook that sleeps reads as unknown. A
 * push to the local remote takes about a quarter of a second, and passed four seconds once the Mac was building
 * elsewhere (load average over 200): that ordinary push then read as unknown too.
 */
const PUSH_LIMIT = 12_000
/** The same for creating a pull request, in place of the product's minute: the fake `gh` answers at once unless told to wait. */
const PR_LIMIT = 9_000

async function shot(page: Page, name: string) {
  await mkdir(OUT, { recursive: true })
  await page.waitForTimeout(250)
  await page.screenshot({ path: join(OUT, `${name}.png`) })
}

async function choose(page: Page, sessionId: string) {
  await page.locator('.app-shell').waitFor()
  await settleShell(page)
  if (await page.locator('.workspace.has-task').count()) return
  await openSession(page, sessionId)
}

/** The same state in the dark theme too, and at 768 when asked; the page comes back as it was. */
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

/** The browser device: admin and run; `all` widens its data scope to the session's files. */
async function openBrowser(
  browser: Browser,
  host: TestHost,
  owner: TestDevice,
  sessionId: string,
  options: { width: number; height: number; dataScope: 'all' | 'work'; dark?: boolean },
) {
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.height },
    locale: 'zh-CN',
    colorScheme: options.dark ? 'dark' : 'light',
    ...(options.width < 768 ? { isMobile: true, hasTouch: true } : {}),
  })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  const name = `Deliver ${randomUUID()}`
  await enrollBrowser(page, host, { name, scopes: ['admin'] })
  const devices = await owner.json<{ devices: Array<{ id: string; name: string }> }>('devices')
  const id = devices.devices.find(item => item.name === name)!.id
  if (options.dataScope === 'all')
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

/** The page reads the repository again when its window comes back, as after working in a terminal. */
const comeBack = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('focus')))

it('stages, commits through the repository hooks, pushes to a bare remote, and says every fixed reason', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'latch-delivery-e2e-'))
  const home = join(scratch, 'home')
  const control = join(scratch, 'control')
  await mkdir(home)
  await mkdir(control)
  // The pre-push hook outlives this, once: the Host settles that push as unknown.
  const host = await startTestHost({
    demo: false,
    gitDelivery: {
      home,
      hostEnv: { HOME: home, USER: 'tester', PATH: '/usr/bin:/bin', TMPDIR: scratch },
      shell: async () => ({ file: '/bin/sh', argv: ['-sh'] }),
      timeouts: { push: PUSH_LIMIT },
    },
  })
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' }
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
        .toString('utf8')
        .trim()
    const repo = host.workspaceRoot
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.name', 'Tester')
    git(repo, 'config', 'user.email', 'tester@example.invalid')
    await writeFile(join(repo, 'tracked.txt'), 'committed\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'first')
    const hook = async (dir: string, name: string, body: string) => {
      await writeFile(join(dir, name), `#!/bin/sh\n${body}\n`)
      await chmod(join(dir, name), 0o755)
    }
    await hook(
      join(repo, '.git', 'hooks'),
      'pre-commit',
      `echo "lint: checking staged files"
if [ -f '${control}/fail-commit' ]; then echo "src/app.ts:3:7 error  'unused' is declared but never used" >&2; echo "1 error"; exit 1; fi
touch '${control}/commit-ran'`,
    )
    await hook(join(repo, '.git', 'hooks'), 'pre-push', `if [ -f '${control}/slow-push' ]; then rm '${control}/slow-push'; sleep 40; fi`)
    const remote = join(scratch, 'remote.git')
    git(scratch, 'init', '-q', '--bare', '-b', 'main', remote)
    await hook(
      join(remote, 'hooks'),
      'pre-receive',
      `if [ -f '${control}/reject' ]; then echo "policy: pushes to main need a review"; echo "see the team handbook"; exit 1; fi`,
    )

    const owner = await host.enroll({ listener: 'unix' })
    expect(
      (
        await owner.confirmed('agents', {
          method: 'POST',
          body: { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT] },
        })
      ).status,
    ).toBe(201)
    const created = await owner.confirmed('tasks', {
      method: 'POST',
      body: { prompt: 'shell-edit', requestId: randomUUID(), mode: 'agent', harnessId: 'fake', workspaceId: 'default' },
    })
    const { sessionId } = (await created.json()) as { sessionId: string }
    const detail = () => owner.json<TaskDetail>(`tasks/${sessionId}`)
    await expect.poll(async () => (await detail()).summary.status, SLOW).toBe('idle')

    // Devices connect before a turn waits on an approval: connecting one needs the Mac, which a waiting turn holds back.
    const desk = await openBrowser(browser, host, owner, sessionId, { width: 1440, height: 900, dataScope: 'all' })
    const phone = await openBrowser(browser, host, owner, sessionId, { width: 390, height: 844, dataScope: 'all' })
    const locked = await openBrowser(browser, host, owner, sessionId, { width: 390, height: 844, dataScope: 'work' })
    const page = desk.page
    const pushes: string[] = []
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith('/git/push'))
        pushes.push((request.postDataJSON() as { requestId: string }).requestId)
    })

    const panel = await openDelivery(page)
    const primary = panel.locator('.delivery-foot .ui-button[data-variant="primary"]')
    await panel.getByRole('group', { name: '未跟踪' }).getByText('agent-edit.txt').waitFor()
    expect(await panel.locator('.delivery-steps [aria-current="step"]').innerText()).toBe('暂存')
    expect(await primary.innerText()).toBe('暂存全部')
    await panel.getByText('还没有暂存的文件').waitFor()
    // No remote yet: said in neutral words, not as a failure.
    await panel.getByText('没有远端，提交留在本地').waitFor()
    await shots(page, 'unstaged', true)

    // One file at a time, each its own request; unstaging puts it back.
    await panel.getByRole('checkbox', { name: '暂存 agent-edit.txt', exact: true }).click()
    await panel.getByRole('group', { name: '已暂存' }).getByText('agent-edit.txt').waitFor()
    await expect.poll(() => primary.innerText(), SLOW).toBe('提交 1 个文件')
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('agent-edit.txt')
    await panel.getByRole('checkbox', { name: '取消暂存 agent-edit.txt', exact: true }).click()
    await panel.getByRole('group', { name: '未跟踪' }).getByText('agent-edit.txt').waitFor()
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('')
    await panel.getByRole('checkbox', { name: '暂存 agent-edit.txt', exact: true }).click()
    await panel.getByRole('group', { name: '已暂存' }).getByText('agent-edit.txt').waitFor()

    // The hook marker and its fine print; the commit waits for a message.
    await panel.getByText('运行仓库钩子').waitFor()
    await panel.getByRole('button', { name: '钩子说明' }).click()
    await panel.getByText('仓库的钩子：pre-commit、pre-push。', { exact: false }).waitFor()
    expect(await primary.getAttribute('aria-disabled')).toBe('true')
    await panel.getByLabel('提交信息').fill('add the agent edit')
    await shots(page, 'staged', true)
    // The keyboard reaches each file's name after its box, with the ring.
    await panel.getByRole('checkbox', { name: '取消暂存 agent-edit.txt', exact: true }).focus()
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.className)).toBe('delivery-file-name')
    await shot(page, 'focus--1440--light')

    // A failing hook: nothing committed, staging unchanged, and its output can go into the draft unsent.
    await writeFile(join(control, 'fail-commit'), '')
    const head = git(repo, 'rev-parse', 'HEAD')
    await primary.click()
    const card = panel.getByRole('region', { name: '提交钩子没通过' })
    await card.waitFor()
    expect(await card.locator('.delivery-card-meta').innerText()).toBe('pre-commit · 退出码 1')
    expect(await card.locator('.delivery-output').innerText()).toContain("'unused' is declared but never used")
    await card.getByText('没有生成提交，暂存保持不变').waitFor()
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('agent-edit.txt')
    await shots(page, 'hook-failed', true)
    const messages = (await detail()).messages.length
    await card.getByRole('button', { name: '加入对话', exact: true }).click()
    const draft = page.locator('.composer textarea').first()
    await expect.poll(() => draft.inputValue(), SLOW).toContain('提交钩子 pre-commit 没通过，退出码 1，没有生成提交：')
    expect(await draft.inputValue()).toContain('```text\nlint: checking staged files')
    expect((await detail()).messages.length).toBe(messages)
    await draft.fill('')

    // 跳过钩子 is for that one commit: the hook does not run, and the switch is off again afterwards.
    const skip = panel.getByRole('switch', { name: '跳过钩子' })
    await skip.click()
    await panel.getByText('这次不运行提交钩子').waitFor()
    await primary.click()
    await panel.locator('.delivery-line', { hasText: '已提交' }).waitFor()
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('add the agent edit')
    expect(existsSync(join(control, 'commit-ran'))).toBe(false)
    await rm(join(control, 'fail-commit'))

    // A passing hook runs, as in a terminal.
    await panel.getByRole('checkbox', { name: '暂存 command-edit.txt', exact: true }).click()
    await expect.poll(() => primary.innerText(), SLOW).toBe('提交 1 个文件')
    // The switch goes off once the commit's answer and the state read after it are in.
    await expect.poll(() => skip.getAttribute('aria-checked'), SLOW).toBe('false')
    await panel.getByLabel('提交信息').fill('add the command edit')
    await primary.click()
    await expect.poll(() => git(repo, 'log', '-1', '--format=%s'), SLOW).toBe('add the command edit')
    expect(existsSync(join(control, 'commit-ran'))).toBe(true)
    await panel.getByText('没有未提交的改动').waitFor()
    expect(await primary.count()).toBe(0)
    await panel.getByText('已提交，未推送').waitFor()
    await shots(page, 'no-remote')

    // A remote added in a terminal shows when the window comes back; the branch is new there, and the push sets the upstream.
    git(repo, 'remote', 'add', 'origin', remote)
    await comeBack(page)
    await expect.poll(() => primary.innerText(), SLOW).toBe('推送')
    await panel.getByText('新分支').waitFor()
    await shots(page, 'committed', true)
    await primary.click()
    await panel.getByText('已设为上游', { exact: false }).waitFor()
    expect(git(remote, 'rev-parse', 'main')).toBe(git(repo, 'rev-parse', 'HEAD'))
    await panel.getByText('已是最新').waitFor()
    await shots(page, 'pushed')

    // The remote's own hook refuses: its lines, and nothing else of the output.
    await writeFile(join(repo, 'more.txt'), 'more\n')
    await comeBack(page)
    await panel.getByRole('checkbox', { name: '暂存 more.txt', exact: true }).click()
    await panel.getByLabel('提交信息').fill('more')
    await expect.poll(() => primary.innerText(), SLOW).toBe('提交 1 个文件')
    await primary.click()
    await expect.poll(() => primary.innerText(), SLOW).toBe('推送 1 个提交')
    await writeFile(join(control, 'reject'), '')
    await primary.click()
    const refused = panel.getByRole('region', { name: '远端钩子拒绝了推送' })
    await refused.waitFor()
    expect(await refused.locator('.delivery-output').innerText()).toContain('policy: pushes to main need a review')
    await shots(page, 'remote-rejected')
    await rm(join(control, 'reject'))

    // No answer in time: result unknown, and the retry sends the same request, which the Host settles without a second push.
    await writeFile(join(control, 'slow-push'), '')
    await primary.click()
    await panel.getByText('推送中…', { exact: false }).first().waitFor()
    await panel.getByText('推送结果未知').waitFor(SLOW)
    expect(await panel.locator('.delivery-line', { hasText: '推送结果未知' }).locator('svg').first().getAttribute('class')).toMatch(
      /circle-(?:help|question)/u,
    )
    await shots(page, 'push-unknown', true)
    const before = pushes.length
    const unknownId = pushes.at(-1)

    // The Mac is installing an update: the Host refuses delivery writes before it reads any receipt. A retry of the
    // unknown push stays unknown, keeping its request; a first attempt is refused and changes nothing.
    expect((await owner.request('host/update-window', { method: 'POST', body: { open: true } })).status).toBe(200)
    expect((await owner.request('host/update-window/commit', { method: 'POST', body: {} })).status).toBe(200)
    await panel.getByRole('button', { name: '重试同一请求', exact: true }).click()
    await panel.locator('.delivery-line', { hasText: '这台电脑正在安装更新' }).waitFor()
    await panel.locator('.delivery-line', { hasText: '推送结果未知' }).getByRole('button', { name: '重试同一请求', exact: true }).waitFor()
    expect(pushes.slice(before)).toEqual([unknownId])
    await writeFile(join(repo, 'installing.txt'), 'x\n')
    await comeBack(page)
    await panel.getByRole('checkbox', { name: '暂存 installing.txt', exact: true }).click()
    await panel.locator('.delivery-line', { hasText: '这台电脑正在安装更新' }).waitFor()
    await panel.getByRole('group', { name: '未跟踪' }).getByText('installing.txt').waitFor()
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('')
    await shots(page, 'host-updating')
    // The install failed and the window closed: the same request settles the push, once.
    expect((await owner.request('host/update-window', { method: 'POST', body: { open: false, reason: 'failed' } })).status).toBe(200)
    await panel.getByRole('button', { name: '重试同一请求', exact: true }).click()
    await panel.locator('.delivery-line', { hasText: '已推送到' }).waitFor()
    expect(pushes.slice(before)).toEqual([unknownId, unknownId])
    await rm(join(repo, 'installing.txt'))
    expect(git(remote, 'rev-parse', 'main')).toBe(git(repo, 'rev-parse', 'HEAD'))

    // A turn waiting in this folder: staging and committing wait for it.
    await writeFile(join(repo, 'during.txt'), 'x\n')
    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'permission', requestId: randomUUID() } })
    await expect.poll(async () => (await detail()).approvals.length, SLOW).toBe(1)
    await comeBack(page)
    await panel.getByText('Agent 正在改这个文件夹').waitFor()
    const during = panel.getByRole('checkbox', { name: '暂存 during.txt', exact: true })
    await during.waitFor()
    expect(await during.getAttribute('aria-disabled')).toBe('true')
    expect(await primary.getAttribute('aria-disabled')).toBe('true')
    // The Host refuses it too, whoever asks.
    const refusedStage = await owner.request(`tasks/${sessionId}/git/stage`, {
      method: 'POST',
      body: { requestId: randomUUID(), paths: ['during.txt'] },
    })
    expect(refusedStage.status).toBe(409)
    await shots(page, 'turn-running')

    // Phones, while the turn waits: the same tab at 390, nothing wider than the window.
    const small = await openDelivery(phone.page)
    await small.getByText('during.txt').waitFor()
    await small.getByText('Agent 正在改这个文件夹').waitFor()
    await noHorizontalOverflow(phone.page)
    await shots(phone.page, 'turn-running')
    await owner.json(`tasks/${sessionId}/cancel`, { method: 'POST', body: {} }).catch(() => undefined)
    await expect.poll(async () => (await detail()).summary.status, SLOW).not.toMatch(/running|waiting-approval/u)
    await expect
      .poll(
        async () => (await small.getByRole('checkbox', { name: '暂存 during.txt', exact: true }).getAttribute('aria-disabled')) ?? 'live',
        SLOW,
      )
      .toBe('live')
    await small.getByRole('checkbox', { name: '暂存 during.txt', exact: true }).click()
    await small.getByRole('group', { name: '已暂存' }).getByText('during.txt').waitFor()
    await noHorizontalOverflow(phone.page)
    await shots(phone.page, 'staged')
    await phone.page.setViewportSize({ width: 320, height: 700 })
    await noHorizontalOverflow(phone.page)
    await shots(phone.page, 'staged')

    // A device without the files' data scope: the list is locked, and a commit and a push still work.
    const lockedPanel = await openDelivery(locked.page)
    await lockedPanel.getByText('这台设备看不到会话文件夹里的文件').waitFor()
    await lockedPanel.getByLabel('提交信息').fill('commit from the phone')
    await lockedPanel.getByRole('button', { name: '提交已暂存的', exact: true }).click()
    await lockedPanel.locator('.delivery-line', { hasText: '已提交' }).waitFor()
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('commit from the phone')
    await lockedPanel.getByRole('button', { name: '推送', exact: true }).click()
    await lockedPanel.locator('.delivery-line', { hasText: '已推送到' }).waitFor()
    expect(git(remote, 'rev-parse', 'main')).toBe(git(repo, 'rev-parse', 'HEAD'))
    await noHorizontalOverflow(locked.page)
    await shots(locked.page, 'locked')

    // 改动's 未提交 leads here.
    await writeFile(join(repo, 'later.txt'), 'later\n')
    await page.getByRole('tab', { name: '改动', exact: true }).click()
    await page.locator('.changes-scope-button').click()
    await page.getByRole('menuitemradio', { name: /未提交/u }).click()
    await page.getByRole('button', { name: '去交付', exact: true }).click()
    await panel.getByText('later.txt').waitFor()
    // And a file of 交付 opens its diff in 未提交.
    await panel.getByRole('button', { name: 'later.txt', exact: true }).click()
    await page.locator('.changes-panel').filter({ visible: true }).locator('.diff-add', { hasText: 'later' }).waitFor()

    for (const item of [desk, phone, locked]) await item.context.close()
  } finally {
    await browser.close()
    await host.close()
    await rm(scratch, { recursive: true, force: true })
  }
})

// Acceptance screenshots go where the person running it says, else beside the other test results.
const ACCEPTANCE = resolve(process.env.LATCH_GIT_RETRY_SHOTS ?? 'test-results/git-retry')

/**
 * The page as it is, light and dark, with motion frozen, for acceptance outside the repository (skipped elsewhere). The
 * width is the page's own: a page crossing the phone width remounts its panel, which keeps nothing of this page's state.
 */
async function acceptance(page: Page, name: string) {
  await mkdir(ACCEPTANCE, { recursive: true })
  const { width } = page.viewportSize()!
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }',
  })
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(250)
    await page.screenshot({ path: join(ACCEPTANCE, `${name}--${width}--${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

/**
 * Keeps this device's write budget spent: requests the Host refuses before reading them (no request ID), two always in
 * flight, so the next write is refused as 429 too, the page's own single automatic retry included.
 */
async function spendWrites(page: Page, path: string): Promise<() => Promise<void>> {
  const url = `/link/api/${path}`
  await page.evaluate(target => {
    const state = window as unknown as { spending?: boolean }
    state.spending = true
    const one = async (): Promise<void> => {
      while (state.spending)
        await fetch(target, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    }
    // Two at a time: the page keeps the rest of the browser's six connections to the Host for its own reads.
    for (let i = 0; i < 2; i++) void one()
  }, url)
  // The bucket holds 60: wait until it is empty.
  await expect
    .poll(
      () =>
        page.evaluate(
          async target =>
            (
              await fetch(target, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
              })
            ).status,
          url,
        ),
      SLOW,
    )
    .toBe(429)
  return async () => {
    await page.evaluate(() => {
      ;(window as unknown as { spending?: boolean }).spending = false
    })
    // A token again for the next write.
    await page.waitForTimeout(2_500)
  }
}

it('keeps a retried push and PR unknown on a refusal, shows it, and lets the page abandon the result', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'latch-delivery-retry-e2e-'))
  const home = join(scratch, 'home'),
    control = join(scratch, 'control')
  await mkdir(home)
  await mkdir(control)
  const gh = await installFakeGh(join(scratch, 'gh'))
  const host = await startTestHost({
    demo: false,
    // The real write budget: 60, then one a second.
    rateLimits: 'default',
    gitDelivery: {
      home,
      hostEnv: { HOME: home, USER: 'tester', PATH: '/usr/bin:/bin', TMPDIR: scratch },
      shell: gh.shell,
      timeouts: { push: PUSH_LIMIT, prCreate: PR_LIMIT },
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
    await appendFile(join(host.workspaceRoot, '.git', 'info', 'exclude'), 'agent-edit.txt\ncommand-edit.txt\n')
    git('commit', '-q', '--allow-empty', '-m', 'first')
    // GitHub by name, a local bare repository in fact.
    git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git')
    git('config', 'remote.origin.pushurl', bare)
    git('push', '-q', '-u', 'origin', 'main')
    const branch = (name: string) => {
      git('switch', '-q', '-c', name)
      git('commit', '-q', '--allow-empty', '-m', `Start ${name}`)
      git('push', '-q', '-u', 'origin', name)
    }
    branch('feat/currency-filter')
    const pre = join(host.workspaceRoot, '.git', 'hooks', 'pre-push')
    await writeFile(pre, `#!/bin/sh\nif [ -f '${control}/slow-push' ]; then rm '${control}/slow-push'; sleep 40; fi\n`)
    await chmod(pre, 0o755)

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

    /** On one page: a push and a PR whose answers never came, each retried into a refusal, then abandoned. */
    const run = async (page: Page, sessionId: string, branchName: string, prNumber: number) => {
      const pushes: string[] = []
      page.on('request', request => {
        if (request.method() === 'POST' && request.url().endsWith('/git/push')) {
          const body = request.postDataJSON() as { requestId?: string }
          if (body.requestId) pushes.push(body.requestId)
        }
      })
      const panel = await openDelivery(page)
      const primary = panel.locator('.delivery-foot .ui-button[data-variant="primary"]')

      // A push with no answer in time: unknown.
      git('commit', '-q', '--allow-empty', '-m', `Round amounts on ${branchName}`)
      await comeBack(page)
      await expect.poll(() => primary.innerText(), SLOW).toBe('推送 1 个提交')
      await writeFile(join(control, 'slow-push'), '')
      await primary.click()
      const unknownRow = panel.locator('.delivery-line', { hasText: '推送结果未知' })
      await unknownRow.waitFor(SLOW)
      const unknownId = pushes.at(-1)!

      // The retry is refused before the Host reads anything (the write budget is spent): still unknown, the same
      // request, and the refusal in its short words under the row.
      const stop = await spendWrites(page, `tasks/${sessionId}/git/push`)
      await unknownRow.getByRole('button', { name: '重试同一请求', exact: true }).click()
      const refusal = panel.locator('.delivery-line', { hasText: '请求太频繁，稍后再试' })
      await refusal.waitFor({ timeout: 20_000 })
      await unknownRow.getByRole('button', { name: '重试同一请求', exact: true }).waitFor()
      expect(pushes.filter(id => id === unknownId).length).toBeGreaterThanOrEqual(2)
      expect(new Set(pushes)).toEqual(new Set([unknownId]))
      await stop()
      await acceptance(page, 'push-retry-refused')
      // The fine print says what abandoning does.
      await unknownRow.getByRole('button', { name: '说明', exact: true }).click()
      await unknownRow.getByText('电脑上的记录仍是结果未知', { exact: false }).waitFor()
      await acceptance(page, 'push-retry-refused-hint')

      // Abandoned: the row goes, and a new push is a new request that goes through.
      await unknownRow.getByRole('button', { name: '放弃这次结果', exact: true }).click()
      await unknownRow.waitFor({ state: 'detached' })
      await refusal.waitFor({ state: 'detached' })
      await acceptance(page, 'push-abandoned')
      await expect.poll(() => primary.innerText(), SLOW).toBe('推送 1 个提交')
      await primary.click()
      // When the line is missing, say what the panel showed instead and whether a new request left.
      await panel
        .locator('.delivery-line', { hasText: '已推送到' })
        .waitFor()
        .catch(async (cause: unknown) => {
          const sent = pushes.at(-1) !== unknownId
          throw new Error(`No pushed line (new request sent: ${sent}); the panel shows: ${await panel.innerText()}`, { cause })
        })
      expect(pushes.at(-1)).not.toBe(unknownId)
      expect(execFileSync('git', ['rev-parse', branchName], { cwd: bare, env }).toString('utf8').trim()).toBe(git('rev-parse', 'HEAD'))

      // A PR whose answer never came (gh made it, then took longer than the Host waits): the same, for 创建 PR.
      await gh.update(state => {
        state.createDelayMs = 30_000
      })
      const createPr = panel.getByRole('button', { name: '创建 PR', exact: true })
      await createPr.waitFor()
      await expect.poll(() => createPr.getAttribute('aria-disabled'), SLOW).not.toBe('true')
      await createPr.click()
      const prUnknown = panel.locator('.delivery-line', { hasText: 'PR 结果未知' })
      await prUnknown.waitFor(SLOW)
      await gh.update(state => {
        delete state.createDelayMs
      })
      const stopPr = await spendWrites(page, `tasks/${sessionId}/git/pr`)
      await prUnknown.getByRole('button', { name: '重试同一请求', exact: true }).click()
      await refusal.waitFor({ timeout: 20_000 })
      await prUnknown.getByRole('button', { name: '重试同一请求', exact: true }).waitFor()
      await stopPr()
      await acceptance(page, 'pr-retry-refused')
      await prUnknown.getByRole('button', { name: '放弃这次结果', exact: true }).click()
      await prUnknown.waitFor({ state: 'detached' })
      await acceptance(page, 'pr-abandoned')
      // A new 创建 PR finds the one the first attempt made and binds it: never a second.
      await expect.poll(() => createPr.getAttribute('aria-disabled'), SLOW).not.toBe('true')
      await createPr.click()
      await panel.getByText(`#${prNumber}`, { exact: false }).first().waitFor()
      expect((await gh.state()).prs).toHaveLength(prNumber)
    }

    const desk = await openBrowser(browser, host, owner, first, { width: 1440, height: 900, dataScope: 'all' })
    await run(desk.page, first, 'feat/currency-filter', 1)
    await desk.context.close()
    // At 390, on its own page and branch: a page keeps its unknown result only while it is mounted.
    branch('feat/second-filter')
    const phone = await openBrowser(browser, host, owner, second, { width: 390, height: 844, dataScope: 'all' })
    await run(phone.page, second, 'feat/second-filter', 2)
    await noHorizontalOverflow(phone.page)
    await phone.context.close()
    expect(await gh.violations()).toEqual([])
  } finally {
    await browser.close()
    await host.close()
    await rm(scratch, { recursive: true, force: true })
  }
})
