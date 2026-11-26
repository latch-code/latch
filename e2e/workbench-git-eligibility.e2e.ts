import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from '@playwright/test'
import { expect, it } from 'vitest'
import type { AppSnapshot, Device, TaskDetail, WorkbenchDelivery, WorkspaceInfo } from '@latch/protocol'
import { startTestHost } from './helpers/host.ts'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { noHorizontalOverflow, settleShell } from './helpers/layout.ts'
import { switchView } from './helpers/workbench.ts'

const OUT = 'test-results/workbench-git-eligibility'

/** The board at three widths, light and dark. */
async function capture(page: Page, name: string) {
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme })
      await settleShell(page)
      await noHorizontalOverflow(page)
      await page.screenshot({ path: `${OUT}/${name}-${width}-${theme}.png`, animations: 'disabled' })
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.emulateMedia({ colorScheme: 'light' })
}

it('keeps an ordinary folder, refused Git metadata and a change the session did not make out of 可交付', async () => {
  const host = await startTestHost({ demo: true, hostName: '交付验收电脑' })
  let browser: Browser | undefined
  let inspected: Page | undefined
  try {
    await mkdir(OUT, { recursive: true })
    const folder = join(host.root, 'ordinary-project')
    await mkdir(folder)
    const owner = await host.enroll({ listener: 'unix' })
    const added = await owner.addFolders({ name: '普通项目', paths: [folder] })
    expect(added.status).toBe(201)
    const { workspace } = (await added.json()) as { workspace: WorkspaceInfo }
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { requestId: randomUUID(), prompt: '记录普通项目目录', harnessId: 'standard', mode: 'agent', workspaceId: workspace.id },
    })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
    await expect
      .poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).messages.some(message => message.outputsPending), {
        timeout: 10_000,
      })
      .toBe(false)
    const read = () => owner.json<WorkbenchDelivery>('workbench/delivery', { method: 'POST', body: { ids: [sessionId] } })
    const groupOf = async () => (await owner.json<AppSnapshot>('snapshot')).tasks.find(task => task.id === sessionId)?.board?.group
    const ordinary = await read()
    await mkdir(join(folder, '.git'))
    await writeFile(join(folder, '.git', 'HEAD'), 'invalid-head\n')
    const refused = await read()
    // Only this fixture-created metadata is removed; no user repository is involved.
    await rm(join(folder, '.git'), { recursive: true })
    await writeFile(`${OUT}/api-classification.json`, JSON.stringify({ ordinary, refused }, null, 2))
    expect(ordinary.entries).toHaveLength(1)
    expect(ordinary.entries[0]).toMatchObject({ sessionId, notApplicable: 'not-repository' })
    expect(ordinary.entries[0]?.state).toBeUndefined()
    expect(ordinary.entries[0]?.error).toBeUndefined()
    expect(refused.entries[0]).toMatchObject({ sessionId, error: { code: 'git-not-repository' } })
    expect(refused.entries[0]).not.toHaveProperty('notApplicable')
    // Neither is a delivery: the Host keeps the session in 已结束.
    expect(await groupOf()).toBe('done')

    browser = await chromium.launch(browserLaunchOptions())
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
    inspected = page
    await enrollBrowser(page, host, { name: '目录交付验收', scopes: ['admin'] })
    const { devices } = await owner.json<{ devices: Device[] }>('devices')
    const device = devices.find(item => item.name === '目录交付验收')!
    await owner.confirmedJson(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
    await page.reload()
    await connected(page)
    await switchView(page, 'board')
    const board = page.locator('.work-board')
    const column = (name: string) => board.getByRole('region', { name, exact: true })
    const card = board.locator(`.work-board-card[data-work-session="${sessionId}"]`)
    await column('已结束').locator(`[data-work-session="${sessionId}"]`).waitFor()
    expect(await column('可交付').locator('.work-board-card').count()).toBe(0)
    // The board says nothing of Git for a folder that has none, and offers no retry: there is nothing to retry.
    expect(await board.getByText(/Git|无法读取/u).count()).toBe(0)
    expect(await board.getByRole('button', { name: /^(?:重试|刷新)$/u }).count()).toBe(0)
    await capture(page, 'ordinary-folder')

    // In 对话 the session's 概要 shows its project and session facts, with no 交付 section or Git warning.
    await card.locator('.work-board-card-main').click()
    await page.locator('main.workspace:not([inert]) .transcript-content').waitFor()
    if ((await page.locator('.app-shell').getAttribute('data-inspector')) !== 'open') await page.keyboard.press('Alt+Shift+b')
    await expect.poll(() => page.locator('.app-shell').getAttribute('data-inspector')).toBe('open')
    const overview = page.locator('.session-overview')
    await overview.getByRole('region', { name: '项目', exact: true }).getByText('普通项目', { exact: true }).waitFor()
    expect(await overview.getByRole('region', { name: '交付', exact: true }).count()).toBe(0)
    expect(await overview.getByText(/不支持 Git 交付|尚未观察到文件改动|本轮没有命令记录/u).count()).toBe(0)
    expect(await overview.getByRole('button', { name: '刷新', exact: true }).count()).toBe(0)
    expect(await overview.locator('.ui-notice[data-tone="warn"]').count()).toBe(0)
    expect(await overview.getByRole('button', { name: '查看交付', exact: true }).count()).toBe(0)

    // Refused metadata read again: still no delivery, nothing invented on the card.
    await mkdir(join(folder, '.git'))
    await writeFile(join(folder, '.git', 'HEAD'), 'invalid-head\n')
    expect((await read()).entries[0]).toMatchObject({ error: { code: 'git-not-repository' } })
    await switchView(page, 'board')
    await column('已结束').locator(`[data-work-session="${sessionId}"]`).waitFor()
    expect(await board.getByText(/Git|无法读取/u).count()).toBe(0)
    await capture(page, 'refused-metadata')

    // A real repository with a file the session never wrote: the read finds it, but only a session that changed files
    // there itself holds a folder's work, so the card stays in 已结束 while 概要 still reads the folder.
    await rm(join(folder, '.git'), { recursive: true })
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '--template=', '--initial-branch=main', folder], {
      env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      stdio: 'pipe',
    })
    await writeFile(join(folder, 'release.md'), '# 本次发布\n')
    const repository = (await read()).entries[0]
    expect(repository.state).toMatchObject({ branch: 'main', files: 1, untracked: 1 })
    expect(repository.error).toBeUndefined()
    expect(repository).not.toHaveProperty('notApplicable')
    expect(await groupOf()).toBe('done')
    await page.reload()
    await connected(page)
    await column('已结束').locator(`[data-work-session="${sessionId}"]`).waitFor()
    expect(await column('可交付').locator('.work-board-card').count()).toBe(0)
    await capture(page, 'unattributed-git-change')
    await card.locator('.work-board-card-main').click()
    await page.getByRole('tab', { name: '概要', exact: true }).click()
    await expect.poll(() => overview.textContent(), { timeout: 10_000 }).toContain('1 个文件未提交')
  } catch (error) {
    if (inspected && (await inspected.locator('.app-shell').count()) > 0)
      await inspected.screenshot({ path: `${OUT}/failure.png`, animations: 'disabled' }).catch(() => {})
    throw error
  } finally {
    await browser?.close()
    await host.close()
  }
})
