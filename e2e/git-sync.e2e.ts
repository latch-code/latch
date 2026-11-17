import { chromium, type Browser, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openPanelTab, openSection, openSession, openSettings, settleShell, tooltipText } from './helpers/layout.ts'

const OUT = 'test-results/git-sync'
const SLOW = { timeout: 30_000 }

async function shot(page: Page, name: string) {
  await mkdir(OUT, { recursive: true })
  await page.waitForTimeout(250)
  await page.screenshot({ path: join(OUT, `${name}.png`) })
}

/** Light and dark at the page's own width. */
async function shots(page: Page, name: string) {
  const { width } = page.viewportSize()!
  await shot(page, `${name}--${width}--light`)
  await page.emulateMedia({ colorScheme: 'dark' })
  await shot(page, `${name}--${width}--dark`)
  await page.emulateMedia({ colorScheme: 'light' })
}

async function openBrowser(browser: Browser, host: TestHost, owner: TestDevice, sessionId: string, width: number, height: number) {
  const context = await browser.newContext({
    viewport: { width, height },
    locale: 'zh-CN',
    ...(width < 768 ? { isMobile: true, hasTouch: true } : {}),
  })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  const name = `Sync ${randomUUID()}`
  await enrollBrowser(page, host, { name, scopes: ['admin'] })
  const devices = await owner.json<{ devices: Array<{ id: string; name: string }> }>('devices')
  const id = devices.devices.find(item => item.name === name)!.id
  expect((await owner.confirmed(`devices/${id}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
  await page.reload()
  await page.locator('.app-shell').waitFor()
  await settleShell(page)
  if (!(await page.locator('.workspace.has-task').count())) await openSession(page, sessionId)
  return { context, page }
}

async function openDelivery(page: Page): Promise<Locator> {
  const tab = page.getByRole('tab', { name: '交付', exact: true })
  if (!(await tab.isVisible())) {
    const toggle = page.getByRole('button', { name: '侧边面板', exact: true }).first()
    if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
    await openPanelTab(page, '交付')
  } else await tab.click()
  const panel = page.locator('.delivery-panel').filter({ visible: true })
  await panel.waitFor()
  return panel
}

const comeBack = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('focus')))

it('fetches to learn it is behind, pulls by fast-forward, hands a divergence and a conflict to the Agent, and aborts', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'latch-git-sync-e2e-'))
  const home = join(scratch, 'home')
  await mkdir(home)
  const host = await startTestHost({
    demo: false,
    gitDelivery: {
      home,
      hostEnv: { HOME: home, USER: 'tester', PATH: '/usr/bin:/bin', TMPDIR: scratch },
      shell: async () => ({ file: '/bin/sh', argv: ['sh'] }),
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
    await writeFile(join(repo, 'tracked.txt'), 'one\n')
    await writeFile(join(repo, '.gitignore'), 'agent-edit.txt\ncommand-edit.txt\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'first')
    const remote = join(scratch, 'remote.git'),
      other = join(scratch, 'other')
    git(scratch, 'init', '-q', '--bare', '-b', 'main', remote)
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-q', '-u', 'origin', 'main')
    git(scratch, 'clone', '-q', remote, other)
    git(other, 'config', 'user.name', 'Other')
    git(other, 'config', 'user.email', 'other@example.invalid')
    const upstream = async (file: string, text: string) => {
      await writeFile(join(other, file), text)
      git(other, 'add', '.')
      git(other, 'commit', '-q', '-m', `edit ${file}`)
      git(other, 'push', '-q', 'origin', 'main')
      return git(other, 'rev-parse', 'HEAD')
    }

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

    const desk = await openBrowser(browser, host, owner, sessionId, 1440, 900)
    const phone = await openBrowser(browser, host, owner, sessionId, 390, 844)
    const page = desk.page
    const panel = await openDelivery(page)
    const sync = panel.getByRole('group', { name: '同步' })
    const fetch = sync.getByRole('button', { name: '获取', exact: true })
    const pull = sync.getByRole('button', { name: /^拉取/u })
    await fetch.waitFor()

    // Behind is not known before a fetch: 拉取 says so in its hover.
    const tip = await upstream('tracked.txt', 'one\ntwo\n')
    await comeBack(page)
    expect(await pull.getAttribute('aria-disabled')).toBe('true')
    expect(await tooltipText(page, pull)).toBe('还没有获取过，先获取')
    await shots(page, 'not-fetched')

    await fetch.click()
    await panel.locator('.delivery-line', { hasText: '已获取' }).waitFor()
    await panel.getByText(/落后 1 · 刚刚获取/u).waitFor()
    await expect.poll(() => pull.innerText(), SLOW).toBe('拉取 1 个提交')
    await shots(page, 'behind')
    await pull.click()
    await panel.locator('.delivery-line', { hasText: '已拉取 1 个提交' }).waitFor()
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(tip)
    await noHorizontalOverflow(page)

    // Diverged: a card, the Agent asked in the draft (unsent), or it is left alone.
    await upstream('upstream.txt', 'theirs\n')
    await writeFile(join(repo, 'mine.txt'), 'mine\n')
    git(repo, 'add', 'mine.txt')
    git(repo, 'commit', '-q', '-m', 'mine')
    await fetch.click()
    const diverged = panel.getByRole('region', { name: '与上游已分叉' })
    await diverged.waitFor()
    expect(await diverged.locator('.delivery-card-meta').innerText()).toBe('领先 1 · 落后 1')
    expect(await tooltipText(page, pull)).toBe('与上游已分叉')
    await shots(page, 'diverged')
    const messages = (await detail()).messages.length
    await diverged.getByRole('button', { name: '交给 Agent', exact: true }).click()
    const draft = page.locator('.composer textarea').first()
    await expect.poll(() => draft.inputValue(), SLOW).toContain('分支 main 与上游 origin/main 已分叉')
    expect((await detail()).messages.length).toBe(messages)
    await draft.fill('')
    await diverged.getByRole('button', { name: '保持原样', exact: true }).click()
    await diverged.waitFor({ state: 'detached' })
    git(repo, 'reset', '-q', '--hard', 'origin/main')

    // A merge stopped on a conflict: the files, the Agent asked, and 中止 after a confirmation.
    git(repo, 'checkout', '-q', '-b', 'theirs')
    await writeFile(join(repo, 'tracked.txt'), 'theirs\n')
    git(repo, 'commit', '-q', '-am', 'theirs')
    git(repo, 'checkout', '-q', 'main')
    await writeFile(join(repo, 'tracked.txt'), 'mine\n')
    git(repo, 'commit', '-q', '-am', 'mine')
    const head = git(repo, 'rev-parse', 'HEAD')
    expect(() => git(repo, 'merge', 'theirs')).toThrow()
    await comeBack(page)
    const conflict = panel.getByRole('region', { name: '合并有冲突' })
    await conflict.waitFor()
    await panel.getByRole('group', { name: '冲突' }).getByText('tracked.txt').waitFor()
    // A pull waits for the merge; a fetch does not.
    expect(await tooltipText(page, pull)).toBe('合并进行中')
    expect(await fetch.getAttribute('aria-disabled')).not.toBe('true')
    await shots(page, 'conflict')
    await conflict.getByRole('button', { name: '交给 Agent 解决', exact: true }).click()
    await expect.poll(() => draft.inputValue(), SLOW).toContain('仓库正在合并，这些文件有冲突')
    expect(await draft.inputValue()).toContain('tracked.txt')
    expect(await draft.inputValue()).toContain('git merge --continue')
    expect((await detail()).messages.length).toBe(messages)
    await draft.fill('')

    const phonePanel = await openDelivery(phone.page)
    await phonePanel.getByRole('region', { name: '合并有冲突' }).waitFor()
    await shots(phone.page, 'conflict')
    await noHorizontalOverflow(phone.page)

    await conflict.getByRole('button', { name: '中止合并', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '中止合并？' })
    await dialog.waitFor()
    await dialog.getByText('不能撤销', { exact: false }).waitFor()
    await shots(page, 'abort-confirm')
    // Cancel first: nothing is sent.
    await dialog.getByRole('button', { name: '取消', exact: true }).first().click()
    await dialog.waitFor({ state: 'detached' })
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(true)
    await conflict.getByRole('button', { name: '中止合并', exact: true }).click()
    await page.getByRole('dialog', { name: '中止合并？' }).getByRole('button', { name: '中止合并', exact: true }).click()
    await panel.locator('.delivery-line', { hasText: '已中止合并' }).waitFor()
    await conflict.waitFor({ state: 'detached' })
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
    await shots(page, 'aborted')

    const actions = (await readFile(join(host.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => (JSON.parse(line) as { action: string }).action)
      .filter(action => /^git\.(fetch|pull|abort)$/u.test(action))
    expect(actions).toEqual(['git.fetch', 'git.pull', 'git.fetch', 'git.abort'])
    await desk.context.close()
    await phone.context.close()
  } finally {
    await browser.close()
    await host.close()
    await rm(scratch, { recursive: true, force: true })
  }
}, 180_000)

it('克隆仓库 in 设置 › 项目: the address, the clone under way with 取消, and a refusal in short words', async () => {
  const host = await startTestHost({ demo: false })
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    await host.enroll({ listener: 'unix' })
    for (const width of [1440, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: width < 768 ? 844 : 900 },
        locale: 'zh-CN',
        ...(width < 768 ? { isMobile: true, hasTouch: true } : {}),
      })
      const page = await context.newPage()
      page.setDefaultTimeout(15_000)
      const name = `Clone ${randomUUID()}`
      await enrollBrowser(page, host, { name, scopes: ['admin'] })
      // After connecting as a browser: the desktop shell's folder actions as main answers them; the Host's clone routes
      // are main's and this Mac's alone, so the clone itself is not run here.
      await page.addInitScript(() => {
        const folders = {
          protocolVersion: 1,
          pick: async () => ({ status: 'canceled' }),
          drop: async () => ({ status: 'canceled' }),
          reveal: async () => ({ status: 'shown' }),
          clone: async (url: string) =>
            url.includes('@github.com/')
              ? { status: 'failed', code: 'clone-url-credentials' }
              : { status: 'cloning', id: '00000000-0000-4000-8000-000000000001', name: 'widgets' },
        }
        Object.defineProperty(window, 'latchShell', { value: Object.freeze({ kind: 'electron', platform: 'darwin', folders }) })
      })
      await page.reload()
      await page.locator('.app-shell').waitFor()
      const settings = await openSettings(page)
      await openSection(settings, '项目')
      const button = settings.getByRole('button', { name: '克隆仓库', exact: true })
      await button.waitFor()
      await shots(page, 'clone-button')
      await button.click()
      const dialog = page.getByRole('dialog', { name: '克隆仓库' })
      await dialog.getByLabel('仓库地址').fill('https://token@github.com/acme/widgets.git')
      await dialog.getByRole('button', { name: '选择位置…', exact: true }).click()
      await dialog.getByText('地址里带有凭据').waitFor()
      await shots(page, 'clone-refused')
      await dialog.getByLabel('仓库地址').fill('git@example.test:acme/widgets.git')
      await dialog.getByRole('button', { name: '选择位置…', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      const status = settings.locator('.clone-status')
      await status.getByText('widgets').waitFor()
      await status.getByRole('button', { name: '取消', exact: true }).waitFor()
      expect(await button.getAttribute('aria-disabled')).toBe('true')
      await shots(page, 'clone-running')
      await noHorizontalOverflow(page)
      await context.close()
    }
  } finally {
    await browser.close()
    await host.close()
  }
}, 120_000)
