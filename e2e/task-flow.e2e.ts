import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Locator, type Page } from '@playwright/test'
import { expect, it } from 'vitest'
import type {
  AppSnapshot,
  CustomAgent,
  TaskDetail,
  WorkItemStartAnswer,
  WorkProposalSummary,
  WorkThreadAnswer,
  WorkspaceInfo,
} from '@latch/protocol'
import { FAKE_ACP_AGENT, installFakeGh } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow, settleShell } from './helpers/layout.ts'
import { stillMotion } from './helpers/visual.ts'
import { switchView } from './helpers/workbench.ts'

const OUT = 'test-results/task-flow'
const WIDE = { width: 1440, height: 900 }

async function captures(page: Page, state: string, at: Locator) {
  for (const width of [390, 768, 1100, 1440])
    for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : width === 768 ? 1024 : 900 })
      await page.emulateMedia({ colorScheme: theme })
      await settleShell(page)
      await at.scrollIntoViewIfNeeded()
      await noHorizontalOverflow(page)
      await page.screenshot({ path: join(OUT, `${state}--${width}--${theme}.png`), animations: 'disabled', caret: 'hide' })
    }
  await page.setViewportSize(WIDE)
  await page.emulateMedia({ colorScheme: 'light' })
}

it('recovers a private proposal, reads its precise Agent turn and opens evidence for the observed Git SHA', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'latch-task-flow-'))
  const gh = await installFakeGh(join(scratch, 'gh'))
  const home = join(scratch, 'home')
  await mkdir(home)
  const host = await startTestHost({
    demo: false,
    hostName: '工程验收电脑',
    gitDelivery: { home, hostEnv: { HOME: home, USER: 'fixture', PATH: '/usr/bin:/bin', TMPDIR: scratch }, shell: gh.shell },
  })
  let browser: Browser | undefined
  try {
    await mkdir(OUT, { recursive: true })
    const owner = await host.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
      body: {
        id: 'fake',
        name: '测试 Harness',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_MCP: 'dsh', FAKE_ACP_STATE: join(scratch, 'state.json') },
      },
    })
    const project = join(host.root, 'project')
    await mkdir(project)
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        [
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'commit.gpgsign=false',
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          ...args,
        ],
        { cwd: project, env: { HOME: home, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'pipe' },
      )
        .toString('utf8')
        .trim()
    git('init', '-b', 'main')
    await writeFile(join(project, 'release.md'), 'Initial release notes\n')
    git('add', 'release.md')
    git('commit', '-m', 'Initial notes')
    const bare = join(scratch, 'remote.git')
    git('init', '--bare', '-b', 'main', bare)
    git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git')
    git('config', 'remote.origin.pushurl', bare)
    git('push', '-u', 'origin', 'main')
    git('switch', '-c', 'release-notes')
    await writeFile(join(project, 'release.md'), 'Summarize the linked changes\n')
    git('commit', '-am', 'Update release notes')
    git('push', '-u', 'origin', 'release-notes')
    const firstSha = git('rev-parse', 'HEAD')
    const added = await owner.addFolders({ name: '发布项目', paths: [project] })
    const { workspace } = (await added.json()) as { workspace: WorkspaceInfo }
    const agent = await owner.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: { requestId: randomUUID(), name: '发布助手', harnessId: 'fake' },
    })
    const snap = () => owner.json<AppSnapshot>('snapshot')
    const detail = (id: string) => owner.json<TaskDetail>(`tasks/${id}`)
    const settled = (id: string) =>
      expect.poll(async () => (await detail(id)).summary.status, { timeout: 20_000 }).not.toMatch(/^(running|waiting-approval)$/u)
    const title = '核对发布说明'
    const { sessionId: chat } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        customAgentId: agent.id,
        prompt: `board ${JSON.stringify({ tool: 'propose_todo', args: { title, prompt: 'echo 核对发布说明的版本' } })}`,
      },
    })
    await settled(chat)
    let proposal: WorkProposalSummary | undefined
    await expect
      .poll(async () => {
        proposal = (await snap()).workProposals?.find(row => row.from.sessionId === chat)
        return proposal?.entries?.[0]?.title
      })
      .toBe(title)

    browser = await chromium.launch(browserLaunchOptions())
    const context = await browser.newContext({ viewport: WIDE, locale: 'zh-CN', reducedMotion: 'reduce' })
    await stillMotion(context)
    const page = await context.newPage()
    page.setDefaultTimeout(20_000)
    await enrollBrowser(page, host, { name: '工程验收', scopes: ['admin'], dataScope: 'all' })
    await switchView(page, 'board')
    const requestBodies: unknown[] = []
    const accept = `**/link/api/work/proposals/${proposal!.id}/accept`
    await page.route(accept, async route => {
      requestBodies.push(route.request().postDataJSON())
      const result = await route.fetch()
      if (requestBodies.length === 1 && result.ok()) await route.abort('failed')
      else await route.fulfill({ response: result })
    })
    await page.locator(`[data-work-proposal="${proposal!.id}"]`).getByRole('button', { name: '审阅' }).click()
    const review = page.getByRole('dialog', { name: '审阅提议' })
    await review.getByRole('button', { name: '接受', exact: true }).click()
    await review.getByText('结果未知', { exact: true }).waitFor()
    await captures(page, '结果未知', review.getByText('结果未知', { exact: true }))
    await page.reload()
    await connected(page)
    await page.getByRole('region', { name: '待确认的提议' }).getByRole('button', { name: '重试', exact: true }).click()
    const itemPage = page.locator('.item-page')
    await itemPage.getByRole('heading', { name: title }).waitFor()
    const items = (await snap()).items!.filter(item => item.from?.proposalId === proposal!.id)
    expect(items).toHaveLength(1)
    expect(requestBodies).toHaveLength(2)
    expect(requestBodies[0]).toEqual(requestBodies[1])
    const item = items[0]!
    const posts = () => owner.json<WorkThreadAnswer>(`work/items/${item.id}/posts`)

    const { sessionId: code } = await owner.confirmedJson<WorkItemStartAnswer>(`work/items/${item.id}/start`, {
      method: 'POST',
      body: { requestId: randomUUID(), baseRevision: item.revision, workspaceId: workspace.id, harnessId: 'fake' },
    })
    await settled(code)
    await gh.update(state => {
      state.headSha = firstSha
    })
    await owner.json(`tasks/${code}/git/pr`, {
      method: 'POST',
      body: { requestId: randomUUID(), title, body: '验收夹具', base: 'main' },
    })
    await gh.update(state => {
      state.prs[0]!.statusCheckRollup = [{ __typename: 'CheckRun', name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }]
    })
    // Reopen the same task to make an observation after the fake CI completed.
    await page.reload()
    await connected(page)
    await itemPage.getByText('检查通过 1/1', { exact: false }).waitFor()
    const thread = itemPage.getByRole('region', { name: '讨论' })
    const input = thread.getByRole('combobox', { name: '发言' })
    const deliver = async (text: string) => {
      if (!(await thread.getByRole('button', { name: '不发给它' }).isVisible())) {
        await input.fill('@发布')
        await page.getByRole('option', { name: /发布助手/u }).click()
      }
      await input.fill(text)
      await input.press('Enter')
    }
    const prefix = 'echo 详细核对 '
    const opening = `${prefix}先核对版本号、发布日期与变更摘要。\n确认回滚步骤能否独立执行。\n把检查记录和审阅意见连到对应提交。`
    const longPost = `${opening}\n${'发布与回滚要分别确认。\n'.repeat(210)}本轮答复终点`
    await deliver(longPost)
    await settled(chat)
    const exact = thread.locator('.item-thread-post').filter({ hasText: prefix })
    const postText = exact.locator('.item-thread-post-text')
    const openPost = exact.getByRole('button', { name: '展开全文' })
    await openPost.waitFor()
    expect(await postText.textContent()).toBe(`${opening}…`)
    await openPost.press('Enter')
    expect(await postText.textContent()).toBe(longPost)
    const closePost = exact.getByRole('button', { name: '收起发言' })
    expect(await closePost.getAttribute('aria-expanded')).toBe('true')
    await closePost.press('Space')
    expect(await postText.textContent()).toBe(`${opening}…`)

    await page.setViewportSize({ width: 768, height: 1024 })
    await settleShell(page)
    const factsButton = itemPage.getByRole('button', { name: '待办属性' })
    const factsDetails = itemPage.locator('.item-page-facts-details')
    await factsDetails.waitFor({ state: 'hidden' })
    const main = await itemPage.locator('.item-page-main').boundingBox()
    expect(main?.width).toBeGreaterThan(700)
    await factsButton.press('Enter')
    await factsDetails.getByText('优先级', { exact: true }).waitFor()
    await factsButton.press('Space')
    await factsDetails.waitFor({ state: 'hidden' })
    await captures(page, '讨论预览', openPost)

    await exact.getByRole('button', { name: '展开回复' }).press('Enter')
    await exact.locator('.item-thread-reply').getByText('本轮答复终点', { exact: false }).waitFor()
    await captures(page, '任务回复', exact.getByRole('button', { name: '收起', exact: true }))
    const reply = (await posts()).posts.at(-1)!.reply!
    const original = exact.getByRole('button', { name: '查看原回复' })
    await original.focus()
    const readingOffset = () =>
      original.evaluate(control => control.getBoundingClientRect().top - control.closest('.item-page-body')!.getBoundingClientRect().top)
    const before = await readingOffset()
    await original.press('Enter')
    await page.locator(`.transcript [data-message-id="${reply.messageId}"]`).waitFor()
    await page.getByRole('button', { name: '返回待办', exact: true }).press('Enter')
    await exact.getByRole('button', { name: '收起', exact: true }).waitFor()
    await expect.poll(() => original.evaluate(control => document.activeElement === control)).toBe(true)
    expect(Math.abs((await readingOffset()) - before)).toBeLessThanOrEqual(2)

    const reader = await browser.newContext({ viewport: WIDE, locale: 'zh-CN', reducedMotion: 'reduce' })
    await stillMotion(reader)
    const readOnly = await reader.newPage()
    await enrollBrowser(readOnly, host, { name: '只读验收', scopes: ['view'], dataScope: 'all' })
    const deviceId = host.host.security.devices.list().find(device => device.name === '只读验收')!.id
    await owner.json(`devices/${deviceId}`, { method: 'PATCH', body: { scopes: ['view'] } })
    await readOnly.reload()
    await connected(readOnly)

    await deliver('elicit 选择验证方式')
    const waiting = thread.locator('.item-thread-post').filter({ hasText: '选择验证方式' })
    await waiting.getByRole('button', { name: '查看问题' }).waitFor()
    await waiting.getByText('等你回答', { exact: true }).waitFor()
    expect(await waiting.getByRole('button', { name: '展开全文' }).count()).toBe(0)
    const attention = itemPage.getByRole('region', { name: '等你处理', exact: true, includeHidden: true })
    const questionLink = attention.getByRole('button', { name: '查看问题' })
    await attention.getByText('等你回答', { exact: true }).waitFor()
    await page.setViewportSize({ width: 390, height: 844 })
    await settleShell(page)
    await itemPage.locator('.item-page-body').evaluate(body => {
      body.scrollTop = body.scrollHeight
    })
    const linkBounds = await questionLink.boundingBox()
    expect(linkBounds?.y).toBeGreaterThanOrEqual(0)
    expect((linkBounds?.y ?? Infinity) + (linkBounds?.height ?? Infinity)).toBeLessThan(844)
    await captures(page, '等待问题', questionLink)
    const question = (await detail(chat)).questions![0]!
    await switchView(readOnly, 'board')
    await readOnly.locator(`[data-work-item="${item.id}"] .work-board-card-main`).click()
    const readOnlyTask = readOnly.locator('.item-page')
    await readOnlyTask.getByRole('region', { name: '等你处理', exact: true }).getByRole('button', { name: '查看问题' }).press('Enter')
    await readOnly.locator(`.workspace-view [data-question-id="${question.id}"]`).waitFor()
    await readOnly.getByRole('button', { name: '返回待办', exact: true }).press('Enter')
    await readOnlyTask.getByRole('heading', { name: title }).waitFor()
    expect(await readOnlyTask.getByRole('combobox', { name: '发言' }).count()).toBe(0)
    await questionLink.press('Enter')
    const questionCard = page.locator(`.workspace-view [data-question-id="${question.id}"]`)
    await questionCard.waitFor()
    await expect.poll(() => questionCard.evaluate(card => card.contains(document.activeElement))).toBe(true)
    await page.getByRole('button', { name: '返回待办', exact: true }).press('Enter')
    await expect.poll(() => questionLink.evaluate(button => document.activeElement === button)).toBe(true)
    await questionLink.press('Enter')
    await questionCard.waitFor()
    await owner.json(`tasks/${chat}/questions/${question.id}/answer`, {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        answers: question.questions.map(part => ({
          questionId: part.id,
          optionIds: part.options.slice(0, 1).map(option => option.id),
          ...(!part.options.length ? { other: '核对发布说明' } : {}),
        })),
      },
    })
    await settled(chat)
    await expect.poll(() => attention.count()).toBe(0)
    await page.getByRole('button', { name: '返回待办', exact: true }).press('Enter')
    await waiting.getByText('已交给 发布助手', { exact: true }).waitFor()
    expect(await waiting.getByRole('button', { name: '查看问题' }).count()).toBe(0)
    await expect.poll(() => itemPage.locator('.item-page-back').evaluate(button => document.activeElement === button)).toBe(true)

    await writeFile(join(project, 'release.md'), 'Summarize the linked changes and rollback\n')
    git('commit', '-am', 'Document rollback')
    const nextSha = git('rev-parse', 'HEAD')
    await page.reload()
    await connected(page)
    await itemPage.getByText('检查对应旧提交', { exact: false }).waitFor()
    expect(await itemPage.getByText('检查通过 1/1', { exact: false }).count()).toBe(0)
    await itemPage.getByRole('button', { name: `HEAD ${nextSha.slice(0, 7)}` }).click()
    await page.locator('.changes-body').getByText(nextSha.slice(0, 7), { exact: false }).waitFor()
    await page.getByRole('button', { name: '返回待办', exact: true }).click()
    await gh.update(state => {
      const pr = state.prs[0]!
      pr.headRefOid = nextSha
      pr.statusCheckRollup = [
        {
          __typename: 'CheckRun',
          name: 'CI',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          detailsUrl: 'https://github.com/acme/widgets/actions/runs/7/job/42',
        },
      ]
      state.logs['42'] = 'CI\tTest\t2026-11-12T10:01:11.0000000Z Rollback verification failed.\n'
    })
    await page.reload()
    await connected(page)
    await itemPage.getByText('1 项检查失败', { exact: false }).waitFor()
    await captures(page, '检查失败', itemPage.getByText('1 项检查失败', { exact: false }))
    await itemPage.getByRole('button', { name: /PR #1/u }).click()
    const prSection = page.getByRole('region', { name: 'PR', exact: true })
    await prSection.getByRole('button', { name: '查看日志' }).click()
    await prSection.getByText('Rollback verification failed.', { exact: false }).waitFor()

    await readOnlyTask.getByRole('heading', { name: title }).waitFor()
    expect(await readOnlyTask.getByRole('combobox', { name: '发言' }).count()).toBe(0)
    await captures(readOnly, '只读', readOnlyTask.getByRole('heading', { name: title }))

    // Snapshot changes and body refusals clear only the source, even before the thread can be read again.
    await page.getByRole('button', { name: '返回待办', exact: true }).click()
    const sourcePost = (await posts()).posts.find(post => post.reply?.messageId === reply.messageId)!
    const postPath = `/link/api/work/items/${item.id}/posts`
    const replyPath = (url: URL) => url.pathname === `${postPath}/${sourcePost.id}/reply`
    let unavailablePosts = true
    await page.route(
      url => url.pathname === postPath,
      route => (unavailablePosts ? route.abort('failed') : route.continue()),
    )
    type Listing = 'visible' | 'partial' | 'missing'
    let listing: Listing = 'visible'
    await page.route('**/link/api/snapshot', async route => {
      const response = await route.fetch()
      if (listing === 'visible') return route.fulfill({ response })
      const { tasks, tasksComplete: _complete, ...rest } = (await response.json()) as AppSnapshot
      return route.fulfill({
        response,
        json: { ...rest, tasks: tasks.filter(task => task.id !== chat), ...(listing === 'missing' ? { tasksComplete: true } : {}) },
      })
    })
    const showListing = async (value: Listing) => {
      listing = value
      await Promise.all([
        page.waitForResponse(response => response.url().endsWith('/link/api/snapshot') && response.ok()),
        page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))),
      ])
    }
    let releaseReply!: () => void
    const heldReply = new Promise<void>(resolve => {
      releaseReply = resolve
    })
    let captured = false
    let released = false
    await page.route(replyPath, async route => {
      const response = await route.fetch()
      captured = response.ok()
      await heldReply
      await route.fulfill({ response }).catch(() => undefined)
      released = true
    })
    const expand = exact.getByRole('button', { name: '展开回复' })
    const replyBox = exact.locator('.item-thread-reply-box')
    await expand.click()
    await expect.poll(() => captured).toBe(true)
    await showListing('partial')
    await original.waitFor({ state: 'detached' })
    await replyBox.waitFor()
    await showListing('missing')
    await replyBox.waitFor({ state: 'detached' })
    expect(await postText.textContent()).toBe(`${opening}…`)
    await showListing('partial')
    releaseReply()
    await expect.poll(() => released).toBe(true)
    expect(await replyBox.count()).toBe(0)

    unavailablePosts = false
    await page.unroute(replyPath)
    await showListing('visible')
    await expand.waitFor()
    unavailablePosts = true
    await page.route(replyPath, route => route.fulfill({ status: 403, json: { error: 'scope-required', message: '读不到来源回复。' } }))
    await expand.click()
    await replyBox.waitFor({ state: 'detached' })
    expect(await postText.textContent()).toBe(`${opening}…`)
    unavailablePosts = false
    await page.unroute(replyPath)
    await showListing('partial')
    await showListing('visible')
    await expand.waitFor()

    expect(await gh.violations()).toEqual([])
  } finally {
    await browser?.close()
    await host.close()
    await rm(scratch, { recursive: true, force: true })
  }
})
