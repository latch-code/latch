import { chromium, type Browser, type Locator, type Page, type Request } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { GitCommitDiff, GitHistory, GitStageLinesResult, TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSession, reachable, settleShell } from './helpers/layout.ts'

const OUT = 'test-results/git-hunks'
const SLOW = { timeout: 30_000 }

async function shot(page: Page, name: string) {
  await mkdir(OUT, { recursive: true })
  await page.mouse.move(0, 0)
  await page.evaluate(() => document.fonts.ready)
  await settleShell(page)
  await noHorizontalOverflow(page)
  await page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled', caret: 'hide' })
}

/** The same state at this width in both themes; the page comes back light. */
async function shots(page: Page, name: string) {
  const { width } = page.viewportSize()!
  await shot(page, `${name}--${width}--light`)
  await page.emulateMedia({ colorScheme: 'dark' })
  await shot(page, `${name}--${width}--dark`)
  await page.emulateMedia({ colorScheme: 'light' })
}

async function choose(page: Page, sessionId: string) {
  await page.locator('.app-shell').waitFor()
  await settleShell(page)
  if (await page.locator('.workspace.has-task').count()) return
  await openSession(page, sessionId)
}

/** A browser device with `admin`; `all` widens its data scope to the session's files. */
async function openBrowser(
  browser: Browser,
  host: TestHost,
  owner: TestDevice,
  sessionId: string,
  options: { width: number; height: number; dataScope: 'all' | 'work' },
) {
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.height },
    locale: 'zh-CN',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    timezoneId: 'Asia/Shanghai',
    ...(options.width < 768 ? { isMobile: true, hasTouch: true } : {}),
  })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  const name = `Stage ${randomUUID()}`
  await enrollBrowser(page, host, { name, scopes: ['admin'] })
  const devices = await owner.json<{ devices: Array<{ id: string; name: string }> }>('devices')
  const id = devices.devices.find(item => item.name === name)!.id
  if (options.dataScope === 'all')
    expect((await owner.confirmed(`devices/${id}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
  await page.reload()
  await choose(page, sessionId)
  return { context, page, deviceId: id }
}

/** The 改动 tab, from the header's toggle or, where the panel is tucked away, from the side panel's launcher. */
async function openChanges(page: Page): Promise<Locator> {
  const panel = page.locator('.changes-panel').filter({ visible: true })
  if (await panel.count()) return panel
  const toggle = page.getByRole('button', { name: '改动', exact: true }).first()
  if (await toggle.isVisible()) await toggle.click()
  else {
    await page.getByRole('button', { name: '侧边面板', exact: true }).first().click()
    const row = page.locator('.panel-launcher-row', { hasText: '改动' })
    if (await row.isVisible()) await row.click()
    else await page.getByRole('tab', { name: '改动', exact: true }).click()
  }
  await panel.waitFor()
  return panel
}

async function closeChanges(page: Page, panel: Locator) {
  const close = page.locator('.session-panel-strip').getByRole('button', { name: '关闭', exact: true }).filter({ visible: true })
  if (await close.count()) await close.click()
  else
    await page
      .locator('.info-page-head')
      .getByRole('button', { name: /^返回(?:对话)?$/u })
      .click()
  await panel.waitFor({ state: 'hidden' })
}

/** One of the range menu's Git views. `提交` is matched from its start: 「未提交」 ends with the same word. */
async function pickView(page: Page, panel: Locator, name: RegExp) {
  await panel.locator('.changes-scope-button').click()
  await page.getByRole('menuitemradio', { name }).click()
}

const fileRow = (panel: Locator, path: string) =>
  panel.locator('.changes-file').filter({ has: panel.page().getByText(path, { exact: true }) })
const box = (row: Locator, key: string) => row.locator(`[data-stage-key="${key}"]`)

async function openFile(panel: Locator, path: string): Promise<Locator> {
  const row = fileRow(panel, path)
  await row.waitFor()
  const toggle = row.locator('.changes-file-toggle')
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  return row
}

/** The page reads the repository again when its window comes back, as after working in a terminal. */
const comeBack = (page: Page) =>
  page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
  })

it('stages and unstages by hunk and by line, settles a lost answer from its receipt, and reads history', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'latch-git-hunks-e2e-'))
  const home = join(scratch, 'home')
  await mkdir(home)
  const host = await startTestHost({
    demo: false,
    hostName: '验收电脑',
    gitDelivery: {
      home,
      hostEnv: { HOME: home, USER: 'tester', PATH: '/usr/bin:/bin', TMPDIR: scratch },
      shell: async () => ({ file: '/bin/sh', argv: ['-sh'] }),
    },
  })
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    const env = {
      PATH: '/usr/bin:/bin',
      HOME: home,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_DATE: '2026-11-15T09:00:00+08:00',
      GIT_COMMITTER_DATE: '2026-11-15T09:00:00+08:00',
    }
    const repo = host.workspaceRoot
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
        .toString('utf8')
        .trim()
    const lines = (change: (line: number) => string | undefined, count = 12) =>
      Array.from({ length: count }, (_, index) => change(index + 1) ?? `line ${index + 1}`).join('\n') + '\n'
    git('init', '-q', '--template=', '-b', 'main')
    git('config', 'user.name', 'Tester')
    git('config', 'user.email', 'tester@example.invalid')
    await writeFile(
      join(repo, 'notes.txt'),
      lines(() => undefined),
    )
    await writeFile(join(repo, 'logo.bin'), Buffer.from([0, 1, 2, 3]))
    git('add', '.')
    git('commit', '-q', '-m', 'first')
    // The session's branch: one commit past main, then uncommitted edits in two places and one line at the end.
    git('switch', '-q', '-c', 'feature')
    await writeFile(
      join(repo, 'notes.txt'),
      lines(line => (line === 6 ? 'line six' : undefined)),
    )
    git('commit', '-q', '-am', 'spell the sixth line')
    const featureHead = git('rev-parse', 'HEAD')

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
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, SLOW).toBe('idle')
    const edited = lines(
      line => (line === 2 ? 'line two' : line === 6 ? 'line six' : line === 11 ? 'line eleven' : line === 13 ? 'line 13' : undefined),
      13,
    )
    await writeFile(join(repo, 'notes.txt'), edited)
    await writeFile(join(repo, 'logo.bin'), Buffer.from([0, 9, 9, 9]))
    const staged = () => git('show', ':notes.txt').split('\n')
    const audited = async () =>
      (await readFile(join(host.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map(line => (JSON.parse(line) as { action: string }).action)
        .filter(action => action === 'git.stage' || action === 'git.unstage')

    const desk = await openBrowser(browser, host, owner, sessionId, { width: 1440, height: 900, dataScope: 'all' })
    const page = desk.page
    const panel = await openChanges(page)

    // ---- 未暂存: the files from the Host's status, each changed line with a box ---------------------------------------
    await pickView(page, panel, /未暂存/u)
    await expect.poll(() => panel.locator('.changes-scope-button').innerText()).toBe('未暂存')
    expect(await panel.getByRole('radiogroup', { name: '排列', exact: true }).count()).toBe(0)
    expect(await panel.getByRole('button', { name: '文件树', exact: true }).count()).toBe(0)
    expect(await panel.locator('.changes-scope-row').getByRole('button', { name: '更多', exact: true }).count()).toBe(0)
    await panel.getByRole('radio', { name: /^未暂存 4$/u }).waitFor()
    await panel.getByRole('radio', { name: /^已暂存 0$/u }).waitFor()
    let notes = await openFile(panel, 'notes.txt')
    await expect.poll(() => notes.getByRole('checkbox').count()).toBe(5)
    expect(await notes.locator('.staging-count').innerText()).toBe('5 行改动')
    // Nothing picked: the one blue action cannot be pressed.
    const stage = notes.getByRole('button', { name: '暂存所选', exact: true })
    expect(await stage.getAttribute('aria-disabled')).toBe('true')
    await shots(page, 'unstaged')

    // A hunk: one line of it, then the whole block.
    await box(notes, 'old:2').click()
    await notes.getByRole('button', { name: '选这一块', exact: true }).click()
    await expect.poll(() => notes.locator('.staging-count').innerText()).toBe('已选 2 行')
    expect(await box(notes, 'new:2').getAttribute('aria-checked')).toBe('true')
    await shots(page, 'hunk-picked')
    await stage.click()
    await expect.poll(() => staged()[1], SLOW).toBe('line two')
    // Only that hunk went in: the file in the work tree is untouched, the other lines are still unstaged.
    expect(staged()[10]).toBe('line 11')
    expect(staged()).not.toContain('line 13')
    expect(await readFile(join(repo, 'notes.txt'), 'utf8')).toBe(edited)
    await panel.getByRole('radio', { name: /^已暂存 1$/u }).waitFor()
    await expect.poll(() => notes.getByRole('checkbox').count()).toBe(3)

    // A line, from the keyboard: Space picks it.
    await box(notes, 'new:13').focus()
    await page.keyboard.press('Space')
    await expect.poll(() => notes.locator('.staging-count').innerText()).toBe('已选 1 行')
    await stage.click()
    await expect.poll(() => staged()[12], SLOW).toBe('line 13')
    expect(staged()[10]).toBe('line 11')

    // Shift with a press takes the stretch; staging it leaves the file with nothing unstaged.
    await expect.poll(() => notes.getByRole('checkbox').count()).toBe(2)
    await box(notes, 'old:11').click()
    await box(notes, 'new:11').click({ modifiers: ['Shift'] })
    await expect.poll(() => notes.locator('.staging-count').innerText()).toBe('已选 2 行')
    await stage.click()
    await expect.poll(() => staged()[10], SLOW).toBe('line eleven')
    await expect.poll(() => fileRow(panel, 'notes.txt').count()).toBe(0)
    expect(await audited()).toEqual(['git.stage', 'git.stage', 'git.stage'])

    // A file whose lines cannot be picked says so in a few words and goes whole.
    const logo = await openFile(panel, 'logo.bin')
    await logo.getByText('二进制 · 只能整个暂存', { exact: true }).waitFor()
    expect(await logo.getByRole('checkbox').count()).toBe(0)
    await shots(page, 'whole-file')
    await logo.locator('.changes-file-head').hover()
    await logo.getByRole('button', { name: '暂存文件', exact: true }).click()
    await expect.poll(() => git('diff', '--cached', '--name-only'), SLOW).toBe('logo.bin\nnotes.txt')

    // ---- 已暂存: kept apart, and a line comes back out ----------------------------------------------------------------
    await panel.getByRole('radio', { name: /^已暂存/u }).click()
    await expect.poll(() => panel.locator('.changes-scope-button').innerText()).toBe('已暂存')
    notes = await openFile(panel, 'notes.txt')
    await expect.poll(() => notes.getByRole('checkbox').count()).toBe(5)
    await box(notes, 'new:13').click()
    await shots(page, 'staged-picked')
    await notes.getByRole('button', { name: '取消暂存所选', exact: true }).click()
    await expect.poll(() => staged().includes('line 13'), SLOW).toBe(false)
    expect(staged()[10]).toBe('line eleven')
    expect((await audited()).at(-1)).toBe('git.unstage')

    async function settleLostStage(target: Page, changes: Locator, row: Locator, verifyScopes?: string) {
      await box(row, 'new:13').click()
      const routePattern = /\/git\/stage-lines$/u
      const stageCount = async () => (await audited()).filter(action => action === 'git.stage').length
      const before = await stageCount()
      const attempts: Array<{ requestId: string } & Record<string, unknown>> = []
      const record = (request: Request) => {
        if (request.method() === 'POST' && routePattern.test(request.url()))
          attempts.push(request.postDataJSON() as { requestId: string } & Record<string, unknown>)
      }
      target.on('request', record)
      try {
        await target.route(
          routePattern,
          async route => {
            // Let the real Host commit the index change and persist its receipt before dropping the answer.
            await route.fetch()
            await route.abort('failed')
          },
          { times: 1 },
        )
        await row.getByRole('button', { name: '暂存所选', exact: true }).click()
        const unknown = changes.locator('.changes-line', { hasText: '暂存结果未知' })
        await unknown.waitFor()
        expect(staged()[12]).toBe('line 13')
        expect(await stageCount()).toBe(before + 1)
        const retry = unknown.getByRole('button', { name: '重试同一请求', exact: true })
        await reachable(retry)
        await shots(target, 'result-unknown')
        if (verifyScopes) {
          await pickView(target, changes, /^提交/u)
          await changes.getByText('离开 main 之后的提交', { exact: true }).waitFor()
          await retry.waitFor()
          await pickView(target, changes, /^未暂存/u)
          await retry.waitFor()
        }
        await closeChanges(target, changes)
        await openChanges(target)
        await retry.waitFor()
        if (verifyScopes) {
          await owner.json(`devices/${verifyScopes}`, { method: 'PATCH', body: { dataScope: 'work' } })
          await changes.getByText('这台设备看不到会话文件夹里的文件').waitFor()
          expect(await unknown.count()).toBe(0)
          expect((await owner.confirmed(`devices/${verifyScopes}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
          await comeBack(target)
          await retry.waitFor()
        }
        expect(await stageCount()).toBe(before + 1)
        const answer = target.waitForResponse(response => response.request().method() === 'POST' && routePattern.test(response.url()))
        await retry.click()
        expect((await (await answer).json()) as GitStageLinesResult).toEqual({ lines: 1, replay: true })
        await expect.poll(() => unknown.count()).toBe(0)
        expect(attempts).toHaveLength(2)
        expect(attempts[0]?.requestId).toEqual(expect.any(String))
        expect(attempts[0]).toEqual(attempts[1])
        expect(await stageCount()).toBe(before + 1)
        expect(staged()[12]).toBe('line 13')
      } finally {
        target.off('request', record)
      }
    }

    // A lost answer does not release the write, even after reading the branch history.
    await panel.getByRole('radio', { name: /^未暂存/u }).click()
    notes = await openFile(panel, 'notes.txt')
    await expect.poll(() => notes.getByRole('checkbox').count()).toBe(1)
    await settleLostStage(page, panel, notes, desk.deviceId)
    await pickView(page, panel, /^未暂存/u)

    // A change made in a terminal meanwhile: a stale pick is refused and the page reads again.
    git('reset', '-q')
    await comeBack(page)
    notes = await openFile(panel, 'notes.txt')
    await expect.poll(() => notes.getByRole('checkbox').count()).toBe(5)
    await box(notes, 'new:13').click()
    await writeFile(join(repo, 'notes.txt'), `${edited}line 14\n`)
    await notes.getByRole('button', { name: '暂存所选', exact: true }).click()
    await notes.getByText('文件已变 · 已重新读取', { exact: true }).waitFor()
    await expect.poll(() => notes.getByRole('checkbox').count()).toBe(6)
    expect(git('diff', '--cached', '--name-only')).toBe('')
    await shots(page, 'file-changed')
    await writeFile(join(repo, 'notes.txt'), edited)

    async function openCommitDiff(target: Page, changes: Locator): Promise<Locator> {
      await pickView(target, changes, /^提交/u)
      await changes.getByText('离开 main 之后的提交', { exact: true }).waitFor()
      const commit = changes.locator('.history-commit', { hasText: 'spell the sixth line' })
      await commit.waitFor()
      expect(await changes.locator('.history-commit').count()).toBe(1)
      const commitToggle = commit.locator('.history-commit-head')
      await reachable(commitToggle)
      await commitToggle.click()
      const changed = commit.locator('.changes-file', { hasText: 'notes.txt' })
      await changed.locator('.changes-file-toggle').click()
      await changed.locator('.diff-add', { hasText: 'line six' }).waitFor()
      await changed.locator('.diff-remove', { hasText: 'line 6' }).waitFor()
      expect(await commit.getByRole('checkbox').count()).toBe(0)
      await shots(target, 'commit')
      return changed
    }

    // History is read-only, and each layer is reachable from the ordinary changes panel.
    const changed = await openCommitDiff(page, panel)
    await changed.locator('.changes-file-head').hover()
    await changed.getByRole('button', { name: '文件历史', exact: true }).click()
    await panel.getByText('改过这个文件的提交').waitFor()
    await expect.poll(() => panel.locator('.history-commit').count()).toBe(2)
    await panel.locator('.history-commit', { hasText: 'first' }).waitFor()
    await shots(page, 'file-history')
    await panel.getByRole('button', { name: '返回', exact: true }).click()
    await panel.getByText('离开 main 之后的提交', { exact: true }).waitFor()

    await pickView(page, panel, /分支与/u)
    await panel.getByText('已提交的改动 · 不含未提交', { exact: true }).waitFor()
    const compared = fileRow(panel, 'notes.txt')
    await compared.waitFor()
    // Committed changes only: the uncommitted binary file is not part of the comparison.
    expect(await fileRow(panel, 'logo.bin').count()).toBe(0)
    await compared.locator('.changes-file-toggle').click()
    await compared.locator('.diff-add', { hasText: 'line six' }).waitFor()
    expect(await compared.locator('.diff-add', { hasText: 'line two' }).count()).toBe(0)
    await shots(page, 'compare')
    await noHorizontalOverflow(page)

    const sizes = [
      { width: 1440, height: 900 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
    ] as const
    // Use new browser contexts so the phone actually uses touch controls.
    git('add', 'logo.bin')
    for (const size of sizes.slice(1)) {
      git('reset', '-q', '--', 'notes.txt')
      const narrow = await openBrowser(browser, host, owner, sessionId, { ...size, dataScope: 'all' })
      try {
        const panel = await openChanges(narrow.page)
        await pickView(narrow.page, panel, /^未暂存/u)
        const row = await openFile(panel, 'notes.txt')
        await expect.poll(() => row.getByRole('checkbox').count()).toBe(5)
        const first = box(row, 'old:2')
        await reachable(first)
        if (size.width === 390) {
          expect(await narrow.page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
          const hit = await first.boundingBox()
          expect(hit?.width).toBeGreaterThanOrEqual(44)
          expect(hit?.height).toBeGreaterThanOrEqual(44)
          await first.tap()
        } else {
          await first.click()
        }
        await row.getByRole('button', { name: '选这一块', exact: true }).click()
        await expect.poll(() => row.locator('.staging-count').innerText()).toBe('已选 2 行')
        await shots(narrow.page, 'hunk-picked')
        await row.getByRole('button', { name: '选这一块', exact: true }).click()
        await expect.poll(() => row.locator('.staging-count').innerText()).toBe('5 行改动')
        await settleLostStage(narrow.page, panel, row)

        await pickView(narrow.page, panel, /^已暂存/u)
        await fileRow(panel, 'logo.bin').waitFor()
        await shots(narrow.page, 'staged')
        await openCommitDiff(narrow.page, panel)
      } finally {
        await narrow.context.close()
      }
    }

    // ---- a device whose data scope does not cover the files: no history, no lines, no line writes ----------------------
    const work = await host.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run'] })
    const api = `tasks/${sessionId}/git`
    expect((await owner.json<GitHistory>(`${api}/history`)).commits.map(entry => entry.sha)).toEqual([featureHead])
    expect((await owner.json<GitCommitDiff>(`${api}/history/${featureHead}`)).files.map(file => file.path)).toEqual(['notes.txt'])
    for (const path of [
      `${api}/history`,
      `${api}/history/${featureHead}`,
      `${api}/history/${featureHead}?path=notes.txt`,
      `${api}/history?path=notes.txt`,
      `${api}/compare`,
      `${api}/diff?view=unstaged&path=notes.txt`,
    ]) {
      const response = await work.request(path)
      const text = await response.text()
      expect({ status: response.status, error: (JSON.parse(text) as { error: string }).error }, path).toEqual({
        status: 403,
        error: 'file-scope',
      })
      expect(text).not.toContain('spell the sixth line')
    }
    const refused = await work.request(`${api}/stage-lines`, {
      method: 'POST',
      body: { requestId: randomUUID(), path: 'notes.txt', base: {}, new: [[13, 13]] },
    })
    expect(refused.status).toBe(403)
    // Its 改动 tab says why it shows nothing, as before.
    for (const size of sizes) {
      const locked = await openBrowser(browser, host, owner, sessionId, { ...size, dataScope: 'work' })
      try {
        const lockedPanel = await openChanges(locked.page)
        await lockedPanel.getByText('这台设备看不到会话文件夹里的文件').waitFor()
        expect(await lockedPanel.locator('.changes-scope-button').count()).toBe(0)
        expect(await lockedPanel.getByText('spell the sixth line').count()).toBe(0)
        await shots(locked.page, 'restricted')
      } finally {
        await locked.context.close()
      }
    }
    await desk.context.close()
  } finally {
    await browser.close()
    await host.close()
    await rm(scratch, { recursive: true, force: true })
  }
})
