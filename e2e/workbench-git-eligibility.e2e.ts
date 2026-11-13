import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from '@playwright/test'
import { expect, it } from 'vitest'
import type { Device, TaskDetail, WorkbenchDelivery, WorkspaceInfo } from '@latch/protocol'
import { startTestHost } from './helpers/host.ts'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { noHorizontalOverflow, openSession, reachable, settleShell } from './helpers/layout.ts'

const OUT = 'test-results/workbench-git-eligibility'

async function capture(page: Page, name: string, words: string) {
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const layout of ['总览', '分拣台']) {
      await page.getByRole('button', { name: '布局', exact: true }).filter({ visible: true }).first().click()
      await page.getByRole('menuitemradio', { name: layout, exact: true }).click()
      const home = page.locator('.workbench-home')
      if (width === 390 && layout === '分拣台') await home.getByRole('button', { name: /^可交付/u }).click()
      const delivery = home.locator('[data-group="delivery"]')
      await reachable(delivery.getByText(words, { exact: true }))
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme })
        await settleShell(page)
        await noHorizontalOverflow(page)
        await page.screenshot({ path: `${OUT}/${name}-${layout}-${width}-${theme}.png`, animations: 'disabled' })
      }
    }
  }
}

it('distinguishes an ordinary folder from refused Git metadata and later reads a real repository through the home', async () => {
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

    browser = await chromium.launch(browserLaunchOptions())
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
    inspected = page
    await enrollBrowser(page, host, { name: '目录交付验收', scopes: ['admin'] })
    const { devices } = await owner.json<{ devices: Device[] }>('devices')
    const device = devices.find(item => item.name === '目录交付验收')!
    await owner.confirmedJson(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
    await page.reload()
    await connected(page)
    const delivery = page.locator('.workbench-home [data-group="delivery"]')
    await expect.poll(() => delivery.textContent()).toContain('已查看的目录不支持 Git 交付')
    expect(await delivery.getByRole('button', { name: '重试', exact: true }).count()).toBe(0)
    await capture(page, 'ordinary-folder', '已查看的目录不支持 Git 交付')
    await openSession(page, sessionId)
    await page.keyboard.press('Alt+Shift+b')
    const overview = page.locator('.session-overview')
    await overview.getByText('这个目录不支持 Git 交付', { exact: true }).waitFor()
    expect(await overview.locator('.ui-notice[data-tone="warn"]').count()).toBe(0)
    expect(await overview.getByRole('button', { name: '查看交付', exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: '总览', exact: true }).filter({ visible: true }).first().click()

    await mkdir(join(folder, '.git'))
    await writeFile(join(folder, '.git', 'HEAD'), 'invalid-head\n')
    await delivery.getByRole('button', { name: '刷新', exact: true }).click()
    await expect.poll(() => delivery.textContent()).toContain('部分目录暂时无法读取')
    expect(await delivery.locator('.ui-count').count()).toBe(0)
    await reachable(delivery.getByRole('button', { name: '重试', exact: true }))
    await capture(page, 'refused-metadata', '部分目录暂时无法读取')

    await rm(join(folder, '.git'), { recursive: true })
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '--template=', '--initial-branch=main', folder], {
      env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      stdio: 'pipe',
    })
    await writeFile(join(folder, 'release.md'), '# 本次发布\n')
    await delivery.getByRole('button', { name: '重试', exact: true }).click()
    await expect.poll(() => delivery.textContent(), { timeout: 10_000 }).toContain('目录未提交 1 个文件')
    const repository = (await read()).entries[0]
    expect(repository.state).toMatchObject({ branch: 'main', files: 1, untracked: 1 })
    expect(repository.error).toBeUndefined()
    expect(repository).not.toHaveProperty('notApplicable')
    expect(await delivery.locator('.work-delivery').count()).toBe(1)
    expect(await delivery.getByRole('button', { name: '重试', exact: true }).count()).toBe(0)
    await capture(page, 'real-git-change', '目录未提交 1 个文件')
    await delivery.getByRole('button', { name: '查看改动', exact: true }).click()
    await page.locator('.delivery-panel').getByText('release.md', { exact: true }).waitFor()
  } catch (error) {
    if (inspected && (await inspected.locator('.app-shell').count()) > 0)
      await inspected.screenshot({ path: `${OUT}/failure.png`, animations: 'disabled' }).catch(() => {})
    throw error
  } finally {
    await browser?.close()
    await host.close()
  }
})
