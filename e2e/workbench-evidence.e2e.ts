import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { expect, it } from 'vitest'
import type { Device, TaskDetail, WorkspaceInfo } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { installFakeGh } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow, reachable, settleShell } from './helpers/layout.ts'
import { switchView } from './helpers/workbench.ts'

const OUT = 'test-results/workbench-evidence'
const EDIT = '修正设置页的保存行为'
const ASK = '确认这次发布的方式'
const AFTER = 'export const keepKey = value => value === undefined ? "keep" : value\n'

it('shows real evidence on the board, decides there, and continues the original sessions without inventing delivery readiness', async () => {
  const plugin: HarnessPlugin = {
    id: 'workbench-evidence',
    name: '工作台证据夹具',
    version: '1',
    description: 'Local scripted provider only.',
    activate(context) {
      context.registerProvider({
        id: 'evidence-model',
        name: '本地验收模型',
        model: 'fixture',
        async *stream({ messages }) {
          const prompt = messages.findLast(message => message.role === 'user')?.content
          if (messages.at(-1)?.role !== 'tool' && (prompt === EDIT || prompt === ASK)) {
            yield {
              type: 'text',
              text: prompt === EDIT ? '空值应保留已有配置。需要修改保存条件。' : '发布说明已经准备好，先确认发布方式。',
            }
            yield {
              type: 'tool-call',
              call: {
                id: randomUUID(),
                name: prompt === EDIT ? 'write_file' : 'ask_user',
                arguments:
                  prompt === EDIT
                    ? { path: 'settings.ts', content: AFTER }
                    : {
                        prompt: '这次如何发布？',
                        questions: [
                          {
                            id: 'release',
                            label: '这次如何发布？',
                            options: [
                              { id: 'preview', label: '先做预览' },
                              { id: 'release', label: '直接发布' },
                            ],
                          },
                        ],
                      },
              },
            }
            yield { type: 'finish', reason: 'tool-calls' }
            return
          }
          yield { type: 'text', text: '已按你的选择继续，结果保留在这条会话。' }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  const scratch = await mkdtemp(join(tmpdir(), 'latch-workbench-pr-'))
  const gh = await installFakeGh(join(scratch, 'gh'))
  const homeDir = join(scratch, 'home')
  await mkdir(homeDir)
  const host = await startTestHost({
    demo: false,
    plugins: [plugin],
    providerId: 'evidence-model',
    hostName: '验收电脑',
    gitDelivery: {
      home: homeDir,
      hostEnv: { HOME: homeDir, USER: 'fixture', PATH: '/usr/bin:/bin', TMPDIR: scratch },
      shell: gh.shell,
    },
  })
  const browser = await chromium.launch(browserLaunchOptions())
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  const sessions: string[] = []
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const folder = join(host.root, 'workbench-project')
    await mkdir(folder)
    await writeFile(join(folder, 'settings.ts'), 'export const keepKey = value => value || "clear"\n')
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
        { cwd: folder, env: { ...process.env, HOME: homeDir, GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'pipe' },
      )
    git('init', '--initial-branch=main')
    git('add', 'settings.ts')
    git('commit', '-m', 'Initial fixture')
    const bare = join(scratch, 'remote.git')
    git('init', '--bare', '--initial-branch=main', bare)
    git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git')
    git('config', 'remote.origin.pushurl', bare)
    git('push', '-u', 'origin', 'main')
    git('switch', '-c', 'fix/keep-settings')
    git('commit', '--allow-empty', '-m', 'Preserve settings')
    git('push', '-u', 'origin', 'fix/keep-settings')
    const added = await owner.addFolders({ name: '设置项目', paths: [folder] })
    const { workspace } = (await added.json()) as { workspace: WorkspaceInfo }
    for (const prompt of ['整理发布说明', EDIT, ASK]) {
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { requestId: randomUUID(), prompt, workspaceId: workspace.id, model: { providerId: 'evidence-model', model: 'fixture' } },
      })
      sessions.push(sessionId)
      if (prompt === '整理发布说明') {
        await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
        await gh.update(state => {
          state.headSha = git('rev-parse', 'HEAD').toString('utf8').trim()
        })
        await owner.json(`tasks/${sessionId}/git/pr`, {
          method: 'POST',
          body: { requestId: randomUUID(), title: '保留未填写的配置', body: '本地验收夹具。', base: 'main' },
        })
        await gh.update(state => {
          state.prs[0]!.statusCheckRollup = ['单元测试', '类型检查'].map(name => ({
            __typename: 'CheckRun',
            name,
            status: 'COMPLETED',
            conclusion: 'SUCCESS',
          }))
        })
        await writeFile(join(folder, 'release.md'), '# 发布说明\n\n保留未填写的密钥。\n')
      }
    }
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessions[1]}`)).approvals.length).toBe(1)
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessions[2]}`)).questions?.length).toBe(1)
    await enrollBrowser(page, host, { name: '工作台证据验收', scopes: ['admin'] })
    const { devices } = await owner.json<{ devices: Device[] }>('devices')
    const device = devices.find(device => device.name === '工作台证据验收')!
    await owner.confirmedJson(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
    await page.reload()
    await connected(page)
    await switchView(page, 'board')
    const board = page.locator('.work-board')
    const card = (id: string) => board.locator(`.work-board-card[data-work-session="${id}"]`)
    const column = (name: string) => board.getByRole('region', { name, exact: true })
    const released = card(sessions[0]!)
    const approval = card(sessions[1]!)
    const question = card(sessions[2]!)
    // The first plain request is decided on its card; the question is a card that leads to its session.
    await column('等你处理').locator(`[data-work-session="${sessions[1]}"] .approval-panel`).waitFor()
    await question.getByText('1 个问题', { exact: true }).waitFor()
    expect(await question.locator('.question-card').count()).toBe(0)
    expect(await approval.textContent()).toContain('settings.ts')
    // The decision leads with the glyph of its kind, never a dot; the tool's ID waits behind the title's hover; and 收起
    // is one of 更多's choices, which leaves a small outlined 查看改动 in the folded card.
    expect(await approval.locator('.approval-dot').count()).toBe(0)
    expect(await approval.locator('.approval-title .approval-kind svg').count()).toBe(1)
    expect(await approval.locator('.workbench-tool-name').filter({ visible: true }).count()).toBe(0)
    await approval.locator('.approval-object').hover()
    await page.getByRole('tooltip').filter({ hasText: 'write_file' }).waitFor()
    await page.mouse.move(0, 0)
    await approval.getByRole('button', { name: '更多', exact: true }).click()
    await page.getByRole('menuitem', { name: '收起', exact: true }).click()
    const see = approval.locator('.ui-button.approval-see')
    expect(await see.innerText()).toBe('查看改动')
    await see.click()
    await expect.poll(() => see.count()).toBe(0)
    expect(await approval.locator('.diff-line').count()).toBeGreaterThan(0)
    // The pull request holds its session in 可交付 (a bound PR, from the Host), and its checks come from the read the
    // board makes for its top 可交付 cards.
    await column('可交付').locator(`[data-work-session="${sessions[0]}"]`).waitFor()
    await expect.poll(() => released.locator('.work-board-card-state').textContent(), { timeout: 10_000 }).toBe('PR #1 · 检查通过 2/2')
    await mkdir(OUT, { recursive: true })
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme })
      await settleShell(page)
      await page.evaluate(() => document.fonts.ready)
      await expect.poll(() => approval.getByRole('button', { name: '允许', exact: true }).isDisabled()).toBe(false)
      await noHorizontalOverflow(page)
      await page.screenshot({ path: `${OUT}/board--1440--${theme}.png`, animations: 'disabled' })
    }
    await page.emulateMedia({ colorScheme: 'light' })
    await reachable(approval.getByRole('button', { name: '允许', exact: true }))
    await approval.getByRole('button', { name: '允许', exact: true }).click()
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessions[1]}`)).summary.status).toBe('idle')
    expect(await readFile(join(folder, 'settings.ts'), 'utf8')).toBe(AFTER)
    expect((await owner.json<TaskDetail>(`tasks/${sessions[2]}`)).questions).toHaveLength(1)
    expect(await host.host.bridge.listTasks()).toHaveLength(3)

    // In 对话, the session's 概要 reads the same evidence: the folder's two files and the PR's checks.
    await released.locator('.work-board-card-main').click()
    await expect.poll(() => page.locator('.app-shell').getAttribute('data-view')).toBe('chat')
    await page.locator('main.workspace:not([inert]) .transcript-content').waitFor()
    if ((await page.locator('.app-shell').getAttribute('data-inspector')) !== 'open') await page.keyboard.press('Alt+Shift+b')
    await page.getByRole('tab', { name: '概要', exact: true }).click()
    await expect.poll(() => page.locator('.session-overview').textContent(), { timeout: 10_000 }).toContain('2 个文件未提交')
    expect(await page.locator('.session-overview').textContent()).toContain('检查通过 2/2')
    // The changes link must use the Host's turn identity, not the user message's unrelated identity.
    await page.locator(`[data-task-id="${sessions[1]}"]`).first().click()
    await expect.poll(() => page.locator('.session-overview').textContent()).toContain('settings.ts')
    const detail = await owner.json<TaskDetail>(`tasks/${sessions[1]}`)
    const turnId = detail.messages.findLast(message => message.role === 'user')?.turnId
    expect(turnId).toBeTruthy()
    const changesRequest = page.waitForRequest(request => request.url().includes('/changes') && request.url().includes(turnId!))
    await page.locator('.session-overview').getByRole('button', { name: 'settings.ts', exact: true }).click()
    await changesRequest
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme })
      await settleShell(page)
      await page.screenshot({ path: `${OUT}/session-evidence--1440--${theme}.png`, animations: 'disabled' })
    }
    await page.emulateMedia({ colorScheme: 'light' })

    // A new head without checks: the card says the checks belong to the old commit, from the next read.
    await switchView(page, 'board')
    await expect.poll(() => released.locator('.work-board-card-state').textContent(), { timeout: 10_000 }).toBe('PR #1 · 检查通过 2/2')
    git('commit', '--allow-empty', '-m', 'Prepare a new head without checks')
    await expect
      .poll(
        async () => {
          await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
          return released.locator('.work-board-card-state').textContent()
        },
        { timeout: 10_000 },
      )
      .toBe('PR #1 · 检查对应旧提交')
    // A revoked read is authoritative even before the device snapshot has caught up: the group stays, the facts go.
    let revokedReads = 0
    await page.route('**/link/api/workbench/delivery', route => {
      revokedReads++
      return route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'forbidden', message: '读取权限已撤回' }),
      })
    })
    await expect
      .poll(
        async () => {
          await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
          return revokedReads
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0)
    await expect.poll(() => released.locator('.work-board-card-state').textContent()).toBe('可交付')
    await column('可交付').locator(`[data-work-session="${sessions[0]}"]`).waitFor()
    expect(await gh.violations()).toEqual([])
  } finally {
    for (const id of sessions) await host.host.bridge.cancel(id).catch(() => {})
    await context.close()
    await browser.close()
    await host.close()
    await rm(scratch, { recursive: true, force: true })
  }
})
