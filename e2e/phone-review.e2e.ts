import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { ReviewNoteList, TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, reachable, settleShell } from './helpers/layout.ts'

const OUT = 'test-results/phone-review'
const SLOW = { timeout: 30_000 }

const base = Array.from({ length: 50 }, (_, index) => `export const v${index + 1} = ${index + 1}`)
/** The agent's first turn: lines 42–45 and line 18 change. */
const first = base.map((line, index) =>
  index >= 41 && index <= 44 ? `${line} * rate` : index === 17 ? "export const label = 'all'" : line,
)
/** Its revision after the two notes. */
const revised = first.map((line, index) =>
  index >= 41 && index <= 44 ? line.replace('* rate', '* account.rate') : index === 17 ? "export const label = '全部'" : line,
)
const text = (lines: string[]) => `${lines.join('\n')}\n`

async function shot(page: Page, name: string, dark = true) {
  await mkdir(OUT, { recursive: true })
  await settleShell(page)
  // The review slides in over the list, and its levels over each other: every animation under the shell ends first.
  await page
    .locator('.app-shell')
    .evaluate(element => Promise.allSettled(element.getAnimations({ subtree: true }).map(animation => animation.finished)))
  const { width } = page.viewportSize()!
  await page.screenshot({ path: join(OUT, `${name}--${width}--light.png`) })
  if (!dark) return
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: join(OUT, `${name}--${width}--dark.png`) })
  await page.emulateMedia({ colorScheme: 'light' })
}

/** A phone browser with admin and run; `all` widens its data scope to the session's files. */
async function phone(
  browser: Browser,
  host: TestHost,
  owner: TestDevice,
  scope: 'all' | 'work',
  width = 390,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width, height: 844 }, locale: 'zh-CN', isMobile: true, hasTouch: true })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  const name = `Phone ${randomUUID()}`
  await enrollBrowser(page, host, { name, scopes: ['admin'] })
  const id = (await owner.json<{ devices: Array<{ id: string; name: string }> }>('devices')).devices.find(item => item.name === name)!.id
  if (scope === 'all') expect((await owner.confirmed(`devices/${id}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
  await page.reload()
  await page.locator('.phone-list').waitFor()
  return { context, page }
}

it('goes on a phone from a waiting card to the diff, two notes, the revision, one commit and a push, and back', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'latch-phone-review-e2e-'))
  const home = join(scratch, 'home')
  await mkdir(home)
  const host = await startTestHost({
    demo: false,
    gitDelivery: {
      home,
      hostEnv: { HOME: home, USER: 'tester', PATH: '/usr/bin:/bin', TMPDIR: scratch },
      shell: async () => ({ file: '/bin/sh', argv: ['-sh'] }),
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
    await writeFile(join(repo, 'rates.ts'), text(base))
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'first')
    // The person's own scratch file: in 未提交, and left out of the commit.
    await writeFile(join(repo, 'scratch.txt'), 'not for the commit\n')
    const remote = join(scratch, 'remote.git')
    git(scratch, 'init', '-q', '--bare', '-b', 'main', remote)
    git(repo, 'remote', 'add', 'origin', remote)

    const queue = join(host.root, 'edits.json')
    await writeFile(
      queue,
      JSON.stringify([
        { path: 'rates.ts', content: text(first) },
        { path: 'rates.ts', content: text(revised) },
      ]),
    )
    const owner = await host.enroll({ listener: 'unix' })
    expect(
      (
        await owner.request('agents', {
          method: 'POST',
          body: { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_EDIT_QUEUE: queue } },
        })
      ).status,
    ).toBe(201)

    // The phone is connected before the turn, so the finished session is new to it.
    const { context, page } = await phone(browser, host, owner, 'all')
    const created = await owner.confirmed('tasks', {
      method: 'POST',
      body: { prompt: 'hello', requestId: randomUUID(), mode: 'agent', harnessId: 'fake', workspaceId: 'default' },
    })
    const { sessionId } = (await created.json()) as { sessionId: string }
    const status = async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status
    await expect.poll(status, SLOW).toBe('idle')

    // The waiting card: its row offers the turn's changes directly.
    const shortcut = page.locator(`[data-review-task="${sessionId}"]`)
    await shortcut.waitFor(SLOW)
    await expect.poll(() => shortcut.innerText()).toContain('复核 1 处改动')
    await reachable(shortcut)
    const box = (await shortcut.boundingBox())!
    expect(box.height).toBeGreaterThanOrEqual(28)
    const listTop = await page.locator('.phone-list-scroll').evaluate(element => element.scrollTop)
    await shot(page, 'list')
    await shortcut.tap()

    // The diff page: one file, this turn, nothing sideways but the code.
    const review = page.locator('.phone-review')
    await review.waitFor()
    await page.locator('.phone-list[data-covered]').waitFor({ state: 'attached' })
    await expect.poll(() => review.locator('.phone-review-file-name').innerText()).toBe('rates.ts')
    await review.locator('.diff-add', { hasText: 'v42 = 42 * rate' }).waitFor()
    expect(await review.getByRole('radio', { name: '本轮', exact: true }).getAttribute('aria-checked')).toBe('true')
    await noHorizontalOverflow(page, review.locator('.phone-review-body'))
    await expect
      .poll(() => review.locator('.phone-review-foot').getByRole('button', { name: '去提交', exact: true }).isVisible())
      .toBe(true)
    await shot(page, 'diff')

    // Two notes by touch: a tap starts, a second tap stretches, the sheet takes the words.
    const line = (number: number) => review.getByRole('button', { name: `反馈第 ${number} 行`, exact: true })
    await line(42).tap()
    await line(45).tap()
    await expect.poll(() => review.locator('[data-mark="selected"]').count()).toBe(4)
    await review.locator('.phone-review-foot').getByText('第 42–45 行', { exact: true }).waitFor()
    await shot(page, 'select')
    await review.getByRole('button', { name: '写反馈', exact: true }).tap()
    const sheet = page.locator('dialog.ui-sheet[open]')
    await sheet.getByRole('textbox', { name: '反馈' }).fill('税率应来自账户设置，不要写死。')
    await shot(page, 'comment')
    await sheet.getByRole('button', { name: '加入待发', exact: true }).tap()
    await sheet.waitFor({ state: 'detached' })
    await review.getByText('税率应来自账户设置，不要写死。').waitFor()
    await line(18).tap()
    await review.getByRole('button', { name: '写反馈', exact: true }).tap()
    await sheet.getByRole('textbox', { name: '反馈' }).fill('列表为空时显示「全部」。')
    await sheet.getByRole('button', { name: '加入待发', exact: true }).tap()
    await sheet.waitFor({ state: 'detached' })
    const send = review.getByRole('button', { name: '发给 Agent (2)', exact: true })
    await send.waitFor()
    await reachable(send)
    await shot(page, 'pending')

    // The 320 pass: the same page, nothing sideways, the bar's action in reach.
    await page.setViewportSize({ width: 320, height: 640 })
    await noHorizontalOverflow(page, review.locator('.phone-review-body'))
    await noHorizontalOverflow(page, review.locator('.phone-review-pager'))
    await reachable(send)
    await reachable(review.getByRole('button', { name: '返回会话列表', exact: true }))
    await shot(page, 'pending')
    await page.setViewportSize({ width: 390, height: 844 })

    // One message; the agent revises in that turn, and the page follows it to the revised result.
    await send.tap()
    const notes = async () => (await owner.json<ReviewNoteList>(`tasks/${sessionId}/review-notes`)).notes
    await expect.poll(async () => (await notes()).map(note => note.status), SLOW).toEqual(['sent', 'sent'])
    await expect.poll(status, SLOW).toBe('idle')
    await review.locator('.diff-add', { hasText: 'v42 = 42 * account.rate' }).waitFor(SLOW)
    await review.getByText('2 条待你复核').waitFor()
    await shot(page, 'revised')

    // Back on the list, where it was: the card still waits, because the notes do.
    await review.getByRole('button', { name: '返回会话列表', exact: true }).tap()
    await review.waitFor({ state: 'detached' })
    await page.locator('.phone-list:not([data-covered])').waitFor({ state: 'attached' })
    expect(await page.locator('.phone-list-scroll').evaluate(element => element.scrollTop)).toBe(listTop)
    await shortcut.waitFor(SLOW)
    await expect.poll(() => shortcut.innerText()).toContain('复核 1 处改动')
    await shortcut.tap()
    await review.locator('.diff-add', { hasText: 'v42 = 42 * account.rate' }).waitFor()
    // Both notes looked at: the moved one under its lines, the one whose lines changed at the top as 位置可能过期.
    await review.getByText('位置可能过期').first().waitFor()
    for (let left = 2; left > 0; left--) {
      await review.getByRole('button', { name: '标为已复核', exact: true }).first().tap()
      await expect.poll(() => review.getByRole('button', { name: '标为已复核', exact: true }).count()).toBe(left - 1)
    }
    await expect.poll(async () => (await notes()).map(note => note.status)).toEqual(['reviewed', 'reviewed'])

    // 未提交 holds the person's scratch file too: the pager steps through both.
    await review.getByRole('radio', { name: '未提交', exact: true }).tap()
    await expect.poll(() => review.locator('.phone-review-count').innerText()).toBe('1 / 2')
    await review.getByRole('button', { name: '下一个文件', exact: true }).tap()
    await expect.poll(() => review.locator('.phone-review-file-name').innerText()).toBe('scratch.txt')
    await review.getByRole('button', { name: '上一个文件', exact: true }).tap()

    // 提交: stage only rates.ts, one commit, then a push to the remote.
    await review.getByRole('button', { name: '去提交', exact: true }).tap()
    const delivery = review.locator('.delivery-panel')
    await delivery.waitFor()
    await delivery.getByRole('checkbox', { name: '暂存 rates.ts', exact: true }).waitFor()
    await shot(page, 'stage')
    await delivery.getByRole('checkbox', { name: '暂存 rates.ts', exact: true }).tap()
    await delivery.getByRole('checkbox', { name: '取消暂存 rates.ts', exact: true }).waitFor()
    await delivery.getByRole('textbox', { name: '提交信息' }).fill('feat(rates): take the rate from the account')
    await noHorizontalOverflow(page, delivery.locator('.delivery-body'))
    const commit = delivery.getByRole('button', { name: '提交 1 个文件', exact: true })
    await reachable(commit)
    await shot(page, 'commit')
    await commit.tap()
    await delivery.getByText(/^已提交/u).waitFor(SLOW)
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('feat(rates): take the rate from the account')
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('rates.ts')
    expect(git(repo, 'status', '--porcelain')).toBe('?? scratch.txt')
    const push = delivery.getByRole('button', { name: '推送', exact: true })
    await push.waitFor()
    await shot(page, 'committed')
    await push.tap()
    await delivery.getByText(/^已推送到/u).waitFor(SLOW)
    expect(git(remote, 'rev-parse', 'main')).toBe(git(repo, 'rev-parse', 'HEAD'))

    // Back from 提交 after the commit goes straight to the list; the row has nothing new to offer.
    await review.getByRole('button', { name: '返回会话列表', exact: true }).last().tap()
    await review.waitFor({ state: 'detached' })
    await page.locator('.phone-list:not([data-covered])').waitFor({ state: 'attached' })
    expect(await shortcut.count()).toBe(0)
    await page.locator(`.phone-list [data-task-id="${sessionId}"]`).waitFor()
    await shot(page, 'returned', false)

    // A device whose data scope leaves out the session's files: honest locks, and a commit of what is staged still works.
    await owner.json(`tasks/${sessionId}/review-notes`, {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        root: 'default',
        path: 'rates.ts',
        range: { start: 3, end: 3 },
        side: 'new',
        scope: 'turn',
        lines: [revised[2]!],
        text: '再看一下这行。',
      },
    })
    await writeFile(join(repo, 'rates.ts'), text([...revised, 'export const done = true']))
    git(repo, 'add', 'rates.ts')
    const work = await phone(browser, host, owner, 'work')
    const lockedShortcut = work.page.locator(`[data-review-task="${sessionId}"]`)
    await lockedShortcut.waitFor(SLOW)
    expect(await lockedShortcut.innerText()).toContain('复核改动')
    await lockedShortcut.tap()
    const locked = work.page.locator('.phone-review')
    await locked.getByText('这台设备看不到会话文件夹里的文件').waitFor()
    expect(await locked.getByRole('radio', { name: '本轮', exact: true }).count()).toBe(0)
    await shot(work.page, 'locked')
    await locked.getByRole('button', { name: '去提交', exact: true }).tap()
    const lockedDelivery = locked.locator('.delivery-panel')
    await lockedDelivery.getByText('这台设备看不到会话文件夹里的文件').waitFor()
    await lockedDelivery.getByRole('textbox', { name: '提交信息' }).fill('chore(rates): mark done')
    await lockedDelivery.getByRole('button', { name: '推送', exact: true }).waitFor()
    await shot(work.page, 'locked-delivery')
    await lockedDelivery.getByRole('button', { name: '提交已暂存的', exact: true }).tap()
    await lockedDelivery.getByText(/^已提交/u).waitFor(SLOW)
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('chore(rates): mark done')
    await noHorizontalOverflow(work.page)
    await work.context.close()
    await context.close()
  } finally {
    await browser.close()
    await host.close()
    await rm(scratch, { recursive: true, force: true })
  }
})
