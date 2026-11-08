import { chromium, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AGENT_PRESETS, type AppSnapshot, type TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'

const OUT = 'test-results/worktrees'

/** A choice in a menu, or in the phone's sheet. */
const choice = (page: Page, name: RegExp): Locator =>
  page.getByRole('menuitemradio', { name }).or(page.getByRole('radio', { name })).first()

it('starts a session in a new worktree from the draft, keeps showing it, and says why when none can be made', async () => {
  await mkdir(OUT, { recursive: true })
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'latch-e2e-worktrees-')))
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
  const found: string[] = []
  const host = await startTestHost({
    demo: false,
    sessionFolders: true,
    // Only the fake in this test's folder is ever found.
    detectPreset: preset => {
      if (preset.id !== 'qwen') return { found: false }
      found.push(preset.id)
      return { found: true, path: join(bin, 'qwen') }
    },
    commandDirectories: () => [bin],
  })
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    const project = join(host.root, 'rust-learn')
    await mkdir(project)
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', ...args], {
        cwd: project,
        stdio: 'pipe',
      }).toString('utf8')
    git('init', '-q')
    await writeFile(join(project, 'README.md'), '# rust-learn\n')
    await writeFile(join(project, '.gitattributes'), '*.bin filter=lfs\n')
    await writeFile(join(project, 'model.bin'), 'version https://git-lfs.github.com/spec/v1\n')
    git('add', '-A')
    git('commit', '-qm', 'first')
    const head = git('rev-parse', '--short=7', 'HEAD').trim()
    // Configured the way Git LFS configures it: making the worktree must never run it.
    git('config', 'filter.lfs.smudge', `touch '${join(directory, 'filter-ran')}'; cat`)
    git('config', 'filter.lfs.required', 'true')

    const owner = await host.enroll({ listener: 'unix' })
    const preset = AGENT_PRESETS.find(item => item.id === 'qwen')!
    await owner.json('agents', {
      method: 'POST',
      body: { id: 'qwen', name: preset.name, presetId: 'qwen', command: preset.command, args: preset.args, env: {}, enabled: true },
    })
    await owner.addFolders({ paths: [project] })

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await enrollBrowser(page, host, { name: '工作树' })
    await connected(page)
    await page
      .getByRole('button', { name: /^Harness：/u })
      .first()
      .click()
    await choice(page, /Qwen Code/u).click()

    // The draft offers both places, the second with where it starts and what stays behind.
    const folder = page.getByRole('button', { name: /^文件夹：/u }).first()
    expect(await folder.getAttribute('aria-label')).toBe('文件夹：当前文件夹')
    await folder.click()
    const worktree = choice(page, /新工作树/u)
    await expect.poll(() => worktree.innerText()).toContain(`从 main 的 ${head}。未提交的改动不会带过去。`)
    await worktree.click()
    const row = page.locator('.composer-context').first()
    await expect.poll(() => row.innerText()).toContain(`从 main 的 ${head}`)
    await page.screenshot({ path: `${OUT}/draft-1280.png` })

    const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
    await input.fill('shell-edit')
    await input.press('Enter')
    await page.locator('.topbar-crumb-worktree').waitFor({ timeout: 30_000 })
    const task = (await owner.json<AppSnapshot>('snapshot')).tasks[0]!
    expect(task.workspaceId).toBe('rust-learn')
    expect(task.worktree?.branch).toMatch(/^latch\/\d{8}-[0-9a-f]{4}$/u)
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${task.id}`)).summary.status, { timeout: 30_000 }).toBe('idle')
    const label = `工作树 · ${task.worktree!.branch}`
    expect(await page.locator('.topbar-crumb-worktree').innerText()).toBe(label)
    expect(await page.locator('.session-worktree').first().getAttribute('aria-label')).toBe(label)
    await expect.poll(() => row.innerText()).toBe(label)
    await page.getByText('新工作树里有 1 个文件的 filter（例如 Git LFS）没有运行', { exact: false }).waitFor()
    expect(existsSync(join(directory, 'filter-ran'))).toBe(false)
    // The project folder is untouched: the agent's files are in the worktree.
    expect(existsSync(join(project, 'agent-edit.txt'))).toBe(false)
    expect(existsSync(join(task.cwd!, 'agent-edit.txt'))).toBe(true)
    await noHorizontalOverflow(page)
    await page.screenshot({ path: `${OUT}/session-1280.png` })

    // After a reload it still reads the same, and the next draft starts on the current folder again.
    await page.reload()
    await page.locator('.topbar-crumb-worktree').waitFor()
    await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
    await expect.poll(() => folder.getAttribute('aria-label')).toBe('文件夹：当前文件夹')

    // A project the Host cannot make one in: picked while it could, refused when sent, nothing started.
    await folder.click()
    await worktree.click()
    git('config', 'includeIf.gitdir:/nowhere/.path', '/nowhere')
    await input.fill('hello')
    await input.press('Enter')
    await page.getByText('仓库配置（.git/config）里有 includeIf', { exact: false }).first().waitFor()
    expect(await input.inputValue()).toBe('hello')
    expect((await owner.json<AppSnapshot>('snapshot')).tasks).toHaveLength(1)
    // The menu says so too.
    await folder.click()
    await expect.poll(() => worktree.getAttribute('aria-disabled')).toBe('true')
    expect(await worktree.innerText()).toContain('请把 includeIf 移到全局配置')
    await page.keyboard.press('Escape')
    expect((await readdir(join(host.root, 'worktrees'))).filter(name => name !== '.metadata_never_index')).toHaveLength(1)
    expect(found).toEqual(found.map(() => 'qwen'))
    await context.close()
  } finally {
    await browser.close()
    await host.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 180_000)
