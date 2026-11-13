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

const OUT = 'test-results/workbench-evidence'
const EDIT = '修正设置页的保存行为'
const ASK = '确认这次发布的方式'
const AFTER = 'export const keepKey = value => value === undefined ? "keep" : value\n'

it('finds real evidence on the home, decides there, and continues the original sessions without inventing delivery readiness', async () => {
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
    const home = page.locator('.workbench-home')
    await page.getByRole('button', { name: '布局', exact: true }).locator('visible=true').first().click()
    await page.getByRole('menuitemradio', { name: '分拣台', exact: true }).click()
    const approval = home.locator(`[data-work-session="${sessions[1]}"]`)
    const question = home.locator(`[data-work-session="${sessions[2]}"]`)
    await approval.locator('.approval-panel').waitFor()
    await question.locator('.question-card').waitFor()
    await expect.poll(() => home.locator('[data-group="delivery"]').textContent(), { timeout: 10_000 }).toContain('目录未提交 1 个文件')
    expect(await approval.textContent()).toContain('settings.ts')
    expect(await approval.textContent()).toContain('keep')
    expect(await home.locator('[data-group="delivery"] .work-delivery').count()).toBe(1)
    await expect.poll(() => home.locator('[data-group="delivery"]').textContent(), { timeout: 10_000 }).toContain('检查通过 2/2')
    await mkdir(OUT, { recursive: true })
    for (const theme of ['light', 'dark'] as const)
      for (const layout of ['overview', 'triage'] as const) {
        await page.emulateMedia({ colorScheme: theme })
        await page.getByRole('button', { name: '布局', exact: true }).locator('visible=true').first().click()
        await page.getByRole('menuitemradio', { name: layout === 'overview' ? '总览' : '分拣台', exact: true }).click()
        await settleShell(page)
        await page.evaluate(() => document.fonts.ready)
        await expect.poll(() => approval.getByRole('button', { name: '允许', exact: true }).isDisabled()).toBe(false)
        await noHorizontalOverflow(page)
        await page.screenshot({ path: `${OUT}/${layout}-home--1440--${theme}.png`, animations: 'disabled' })
      }
    await approval.getByRole('button', { name: EDIT, exact: true }).click()
    for (const theme of ['light', 'dark'] as const)
      for (const layout of ['overview', 'triage'] as const) {
        await page.emulateMedia({ colorScheme: theme })
        await page.getByRole('button', { name: '布局', exact: true }).locator('visible=true').first().click()
        await page.getByRole('menuitemradio', { name: layout === 'overview' ? '总览' : '分拣台', exact: true }).click()
        const frame = page.locator('.app-shell')
        if ((layout === 'overview') !== ((await frame.getAttribute('data-inspector')) === 'open')) await page.keyboard.press('Alt+Shift+b')
        await expect.poll(() => page.locator('.workspace .approval-panel[data-arming]').count()).toBe(0)
        await settleShell(page)
        await noHorizontalOverflow(page)
        await page.screenshot({ path: `${OUT}/${layout}-session--1440--${theme}.png`, animations: 'disabled' })
      }
    await page.getByRole('button', { name: '总览', exact: true }).locator('visible=true').first().click()
    // The full list is a page, keeps the same reading session, and retains each existing management menu.
    await page.getByRole('button', { name: '全部会话', exact: true }).click()
    const all = page.getByRole('region', { name: '全部会话', exact: true })
    await all.waitFor()
    expect(
      await page.locator('.workspace .approval-panel').evaluate(element => ({
        visible: element.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
        inert: !!element.closest('[inert]'),
      })),
    ).toEqual({ visible: false, inert: true })
    expect(await all.locator('.workbench-session-row').count()).toBe(3)
    expect(await all.getByRole('button', { name: `更多操作：${EDIT}`, exact: true }).isVisible()).toBe(true)
    for (const theme of ['light', 'dark'] as const)
      for (const width of [1440, 768]) {
        await page.emulateMedia({ colorScheme: theme })
        await page.setViewportSize({ width, height: 1000 })
        await noHorizontalOverflow(page)
        await page.screenshot({ path: `${OUT}/triage-sessions--${width}--${theme}.png`, animations: 'disabled' })
      }
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.getByRole('button', { name: '总览', exact: true }).click()
    await approval.locator('.approval-panel').waitFor()
    // Digits typed in the new task must never answer a visible question in another session.
    await home.getByRole('textbox', { name: '新会话消息', exact: true }).fill('1')
    await page.keyboard.press('1')
    expect((await owner.json<TaskDetail>(`tasks/${sessions[2]}`)).questions).toHaveLength(1)
    await expect.poll(() => question.getByRole('button', { name: /先做预览/u }).isDisabled()).toBe(false)
    await reachable(question.getByRole('button', { name: /先做预览/u }))
    await question.getByRole('button', { name: /先做预览/u }).focus()
    await expect.poll(() => question.locator('.question-option kbd').count()).toBe(2)
    expect(await approval.getByRole('button', { name: '允许', exact: true }).locator('kbd').filter({ visible: true }).count()).toBe(0)
    // A snapshot refresh can reorder document listeners while focus stays in the second card.
    await owner.json(`workspaces/${workspace.id}`, { method: 'PATCH', body: { name: '设置项目 · 已核对' } })
    await expect.poll(() => question.textContent()).toContain('设置项目 · 已核对')
    const focusedDecision = page.waitForRequest(
      request => request.method() === 'POST' && /\/approvals\/|\/questions\/[^/]+\/answer$/u.test(new URL(request.url()).pathname),
    )
    await page.keyboard.press('1')
    expect(new URL((await focusedDecision).url()).pathname).toContain(`/tasks/${sessions[2]}/questions/`)
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessions[2]}`)).summary.status).toBe('idle')
    expect((await owner.json<TaskDetail>(`tasks/${sessions[1]}`)).approvals).toHaveLength(1)
    await expect.poll(() => approval.getByRole('button', { name: '允许', exact: true }).isDisabled()).toBe(false)
    await reachable(approval.getByRole('button', { name: '允许', exact: true }))
    await approval.getByRole('button', { name: '允许', exact: true }).focus()
    await page.keyboard.press('2')
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessions[1]}`)).summary.status).toBe('idle')
    expect(await readFile(join(folder, 'settings.ts'), 'utf8')).toBe(AFTER)
    expect(await host.host.bridge.listTasks()).toHaveLength(3)
    expect(await home.getByRole('textbox', { name: '新会话消息', exact: true }).inputValue()).toBe('11')
    await home.locator('[data-group="delivery"] .work-delivery').getByRole('button').first().click()
    await page.getByRole('button', { name: '布局', exact: true }).locator('visible=true').first().click()
    await page.getByRole('menuitemradio', { name: '总览', exact: true }).click()
    await page.getByRole('tab', { name: '概要', exact: true }).click()
    await expect.poll(() => page.locator('.session-overview').textContent(), { timeout: 10_000 }).toContain('目录未提交 2 个文件')
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
    await page.getByRole('tab', { name: '概要', exact: true }).click()
    await expect
      .poll(
        async () => {
          const current = await owner.json<TaskDetail>(`tasks/${sessions[1]}`)
          return current.messages
            .filter(message => message.outputsPending)
            .map(message => ({
              role: message.role,
              text: message.text,
              pending: message.outputsPending,
              files: message.outputs?.length,
              trackingState: current.fileChanges?.state,
            }))
        },
        { timeout: 10_000 },
      )
      .toEqual([])
    await expect.poll(() => page.locator('.session-overview').textContent()).not.toContain('正在核对文件改动')
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme })
      await page.screenshot({ path: `${OUT}/overview-session-evidence--1440--${theme}.png`, animations: 'disabled' })
    }
    await page.getByRole('button', { name: '总览', exact: true }).locator('visible=true').first().click()
    await expect.poll(() => home.locator('[data-group="delivery"]').textContent(), { timeout: 10_000 }).toContain('检查通过 2/2')
    // A revoked read is authoritative even before the device snapshot has caught up.
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
    await expect.poll(() => home.locator('[data-group="delivery"] .work-delivery').count()).toBe(0)
    expect(await home.locator('[data-group="delivery"] .ui-count').count()).toBe(0)
    expect(await home.locator('[data-group="delivery"]').textContent()).not.toContain('检查通过')
    expect(await gh.violations()).toEqual([])
  } finally {
    for (const id of sessions) await host.host.bridge.cancel(id).catch(() => {})
    await context.close()
    await browser.close()
    await host.close()
    await rm(scratch, { recursive: true, force: true })
  }
})
