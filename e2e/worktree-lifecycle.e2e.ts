import { chromium, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AGENT_PRESETS, type AppSnapshot, type TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { backToPhoneSessions, closeSettings, noHorizontalOverflow, openSection, openSettings } from './helpers/layout.ts'

const OUT = 'test-results/worktree-lifecycle'

/** A choice in a menu, or in the phone's sheet. */
const choice = (page: Page, name: RegExp): Locator =>
  page.getByRole('menuitemradio', { name }).or(page.getByRole('radio', { name })).first()

it('starts a worktree from another branch, then removes a dirty one after the discard confirmation and a clean one', async () => {
  await mkdir(OUT, { recursive: true })
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'latch-e2e-worktree-lifecycle-')))
  const bin = join(directory, 'bin')
  await mkdir(bin)
  await writeFile(
    join(bin, 'qwen'),
    [
      '#!/bin/sh',
      `export FAKE_ACP_LOG='${join(directory, 'qwen.log')}' FAKE_ACP_CONFIG=options FAKE_ACP_MODES=plan,default,auto-edit,auto,yolo FAKE_ACP_INITIAL_MODE=default`,
      `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`,
    ].join('\n'),
  )
  await chmod(join(bin, 'qwen'), 0o755)
  const host = await startTestHost({
    demo: false,
    sessionFolders: true,
    detectPreset: preset => (preset.id === 'qwen' ? { found: true, path: join(bin, 'qwen') } : { found: false }),
    commandDirectories: () => [bin],
  })
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    const project = join(host.root, 'lifecycle')
    await mkdir(project)
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', ...args], {
        cwd: project,
        stdio: 'pipe',
      }).toString('utf8')
    git('init', '-q')
    await writeFile(join(project, 'README.md'), '# lifecycle\n')
    git('add', '-A')
    git('commit', '-qm', 'first')
    git('checkout', '-q', '-b', 'feature/login')
    await writeFile(join(project, 'login.txt'), 'login\n')
    git('add', '-A')
    git('commit', '-qm', 'login')
    const feature = git('rev-parse', 'HEAD').trim()
    git('checkout', '-q', 'main')

    const owner = await host.enroll({ listener: 'unix' })
    const preset = AGENT_PRESETS.find(item => item.id === 'qwen')!
    await owner.json('agents', {
      method: 'POST',
      body: { id: 'qwen', name: preset.name, presetId: 'qwen', command: preset.command, args: preset.args, env: {}, enabled: true },
    })
    await owner.addFolders({ paths: [project] })

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await enrollBrowser(page, host, { name: '工作树生命周期', scopes: ['admin'] })
    // Removing a worktree discards files: only a device that may read the project's files can.
    const devices = await owner.json<{ devices: Array<{ id: string; name: string }> }>('devices')
    const id = devices.devices.find(item => item.name === '工作树生命周期')!.id
    expect((await owner.confirmed(`devices/${id}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
    await page.reload()
    await connected(page)
    await page
      .getByRole('button', { name: /^Harness：/u })
      .first()
      .click()
    await choice(page, /Qwen Code/u).click()

    // 其他起点…: a new branch from feature/login.
    const folder = page.getByRole('button', { name: /^文件夹：/u }).first()
    await folder.click()
    await page.getByRole('menuitem', { name: '其他起点…' }).click()
    const panel = page.locator('.worktree-start')
    await panel.waitFor()
    await panel.getByRole('button', { name: /feature\/login/u }).waitFor()
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await page.screenshot({ path: `${OUT}/start-panel--1440--${colorScheme}.png` })
    }
    await page.emulateMedia({ colorScheme: 'light' })
    // Checking out main is refused before the Host is asked: it is checked out in the project folder.
    await panel.getByRole('radio', { name: '检出分支' }).click()
    expect(await panel.getByRole('button', { name: /^main/u }).getAttribute('aria-disabled')).toBe('true')
    await panel.getByRole('radio', { name: '新分支' }).click()
    await panel.getByRole('button', { name: /feature\/login/u }).click()
    expect(await folder.getAttribute('aria-label')).toBe('文件夹：新工作树')
    const row = page.locator('.composer-status').first()
    await expect.poll(() => row.innerText()).toContain(`从 feature/login 的 ${feature.slice(0, 7)}`)

    const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
    await input.fill('shell-edit')
    await input.press('Enter')
    await page.locator('.topbar-crumb-worktree').waitFor({ timeout: 30_000 })
    const first = (await owner.json<AppSnapshot>('snapshot')).tasks[0]!
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${first.id}`)).summary.status, { timeout: 30_000 }).toBe('idle')
    expect(first.worktree?.branch).toMatch(/^latch\//u)
    expect(git('-C', first.cwd!, 'rev-parse', 'HEAD').trim()).toBe(feature)
    expect(existsSync(join(first.cwd!, 'agent-edit.txt'))).toBe(true)

    // 移除工作树…: what is there, then the discard box before the button works.
    await page.getByRole('button', { name: '会话操作' }).first().click()
    await page.getByRole('menuitem', { name: '移除工作树…' }).click()
    const dialog = page.getByRole('dialog', { name: /的工作树$/u })
    await dialog.getByText('未跟踪 2').waitFor()
    // Its branch has no commits past feature/login, where it started: deleting it loses nothing, and the dialog says so.
    await dialog.getByText('没有新提交，会删除').waitFor()
    await dialog.getByText('没有新提交', { exact: true }).waitFor()
    const remove = dialog.getByRole('button', { name: '移除工作树' })
    expect(await remove.isDisabled()).toBe(true)
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await page.screenshot({ path: `${OUT}/remove-dirty--1440--${colorScheme}.png` })
    }
    await page.emulateMedia({ colorScheme: 'light' })
    await dialog.getByRole('checkbox', { name: '丢弃 2 个未提交的文件' }).check()
    await remove.click()
    await dialog.waitFor({ state: 'detached' })
    await page.getByText('已移除工作树和分支').first().waitFor()
    expect(existsSync(first.cwd!)).toBe(false)
    await expect.poll(() => page.locator('.topbar-crumb-worktree').innerText()).toContain('工作树已移除')
    await expect.poll(() => row.innerText()).toContain('工作树已移除')
    expect((await owner.json<TaskDetail>(`tasks/${first.id}`)).summary.worktree?.removed).toBe(true)
    await page.screenshot({ path: `${OUT}/removed-session--1440.png` })

    // A clean one, at 390: the dialog fits the phone.
    const second = (
      await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: {
          prompt: 'hello',
          requestId: crypto.randomUUID(),
          mode: 'agent',
          harnessId: 'qwen',
          workspaceId: 'lifecycle',
          worktree: true,
        },
      })
    ).sessionId
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${second}`)).summary.status, { timeout: 30_000 }).toBe('idle')
    const secondCwd = (await owner.json<TaskDetail>(`tasks/${second}`)).summary.cwd!
    await page.locator(`.session-item-main[data-task-id="${second}"]`).click()
    await page.locator('.topbar-crumb-worktree').waitFor()
    await page.setViewportSize({ width: 390, height: 844 })
    // The phone's title opens the same session menu.
    await page.locator('.topbar-title-button').first().click()
    await page.getByRole('menuitem', { name: '移除工作树…' }).click()
    const sheet = page.getByRole('dialog', { name: /的工作树$/u })
    await sheet.getByText('没有新提交', { exact: true }).waitFor()
    await sheet.getByText('已合并，会删除').waitFor()
    await noHorizontalOverflow(page)
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await page.screenshot({ path: `${OUT}/remove-clean--390--${colorScheme}.png` })
    }
    await page.emulateMedia({ colorScheme: 'light' })
    await sheet.getByRole('button', { name: '移除工作树' }).click()
    await sheet.waitFor({ state: 'detached' })
    expect(existsSync(secondCwd)).toBe(false)
    // Both went: the first had no commits past where it started, the second is main's commit.
    expect(git('for-each-ref', '--format=%(refname)', 'refs/heads').trim().split('\n').toSorted()).toEqual(
      ['refs/heads/feature/login', 'refs/heads/main'].toSorted(),
    )

    // At 320 the phone's new-session sheet offers the same start points.
    await page.setViewportSize({ width: 320, height: 640 })
    await backToPhoneSessions(page)
    await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
    await page
      .getByRole('button', { name: /^文件夹：/u })
      .first()
      .click()
    await page.getByText('其他起点…', { exact: true }).click()
    await page
      .locator('.worktree-start')
      .getByRole('button', { name: /feature\/login/u })
      .waitFor()
    await noHorizontalOverflow(page)
    await page.screenshot({ path: `${OUT}/start-panel--320.png` })
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')

    // A leftover (its session deleted) is listed in 设置 › 项目 and removed there, at 768 in the dark theme.
    const third = (
      await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: {
          prompt: 'hello',
          requestId: crypto.randomUUID(),
          mode: 'agent',
          harnessId: 'qwen',
          workspaceId: 'lifecycle',
          worktree: true,
        },
      })
    ).sessionId
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${third}`)).summary.status, { timeout: 30_000 }).toBe('idle')
    const thirdCwd = (await owner.json<TaskDetail>(`tasks/${third}`)).summary.cwd!
    expect((await owner.request(`tasks/${third}`, { method: 'DELETE' })).status).toBe(200)
    await page.setViewportSize({ width: 768, height: 1024 })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.reload()
    await connected(page)
    const settings = await openSettings(page)
    await openSection(settings, '项目')
    await settings
      .getByRole('button', { name: /lifecycle/u })
      .first()
      .click()
    const leftover = settings.locator('.settings-row', { hasText: thirdCwd.split('/').at(-1)! })
    await leftover.waitFor()
    await page.screenshot({ path: `${OUT}/leftovers--768--dark.png` })
    await leftover.getByRole('button', { name: '移除…' }).click()
    const confirm = page.getByRole('dialog', { name: /的工作树$/u })
    await confirm.getByText('没有新提交', { exact: true }).waitFor()
    await confirm.getByRole('button', { name: '移除工作树' }).click()
    await confirm.waitFor({ state: 'detached' })
    await leftover.waitFor({ state: 'detached' })
    expect(existsSync(thirdCwd)).toBe(false)
    await closeSettings(settings)
    await context.close()
  } finally {
    await browser.close()
    await host.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 180_000)
