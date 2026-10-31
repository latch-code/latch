import { chromium, type Browser } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppSnapshot, Device, TaskDetail, WorkspaceInfo } from '@latch/protocol'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { closeSettings } from './helpers/layout.ts'

describe('saved projects', () => {
  let host: TestHost
  let browser: Browser
  beforeAll(async () => {
    host = await startTestHost()
    browser = await chromium.launch(browserLaunchOptions())
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
  })

  for (const [width, height, theme] of [
    [390, 844, 'light'],
    [900, 1000, 'light'],
    [1440, 1000, 'dark'],
  ] as const) {
    it(`opens only the recent visible project sessions without turning the count into navigation at ${width}px in ${theme}`, async () => {
      const owner = await host.enroll({ listener: 'unix' }),
        path = join(host.root, `recent-${width}`)
      await mkdir(path)
      const added = await owner.addFolders({ name: `最近项目 ${width}`, paths: [path] })
      expect(added.status).toBe(201)
      const project = ((await added.json()) as { workspace: WorkspaceInfo }).workspace,
        messages = new Map<string, string>()
      for (let index = 0; index < 5; index++) {
        const prompt = `项目消息 ${width} ${index}`,
          created = await owner.json<{ sessionId: string }>('tasks', {
            method: 'POST',
            body: { prompt, requestId: randomUUID(), workspaceId: project.id, mode: 'agent' },
          })
        messages.set(created.sessionId, prompt)
        await expect.poll(async () => (await owner.json<TaskDetail>('tasks/' + created.sessionId)).summary.status).toBe('idle')
        await owner.json('tasks/' + created.sessionId, { method: 'PATCH', body: { title: `项目记录 ${width} ${index}` } })
      }
      await owner.json('tasks', { method: 'POST', body: { prompt: '其他会话不能混入最近项目', mode: 'chat', requestId: randomUUID() } })
      const context = await browser.newContext({
        viewport: { width, height },
        colorScheme: theme,
        locale: 'zh-CN',
        reducedMotion: 'reduce',
      })
      context.setDefaultTimeout(15_000)
      try {
        const page = await context.newPage(),
          deviceName = `最近项目设备 ${width}`
        await enrollBrowser(page, host, { name: deviceName, scopes: ['admin'] })
        if (width === 900) await page.getByRole('button', { name: '打开会话列表', exact: true }).click()
        await page
          .getByRole('region', { name: `最近项目 ${width}`, exact: true })
          .getByRole('button', { name: `最近项目 ${width} 的项目操作`, exact: true })
          .click()
        await page.getByRole('menuitem', { name: '管理文件夹…', exact: true }).click()
        const settings = page.locator('.settings-page'),
          recent = settings.locator('.project-recent-sessions'),
          expected = (await owner.json<AppSnapshot>('snapshot')).tasks
            .filter(task => task.workspaceId === project.id && task.mode !== 'chat' && !task.personal)
            .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
            .slice(0, 3)
        await settings.getByText('5 个会话', { exact: true }).last().waitFor()
        expect(await settings.getByRole('button', { name: '5 个会话', exact: true }).count()).toBe(0)
        await expect.poll(() => recent.getByRole('button').count()).toBe(3)
        expect(
          await recent.getByRole('button').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label'))),
        ).toEqual(expected.map(task => '打开会话：' + task.title))
        await mkdir('test-results/projects', { recursive: true })
        await page.screenshot({ path: `test-results/projects/recent-${width}-${theme}.png`, animations: 'disabled' })
        const selected = expected[0]!
        await recent.getByRole('button', { name: '打开会话：' + selected.title, exact: true }).click()
        await settings.waitFor({ state: 'detached' })
        await page.locator('.transcript').getByText(messages.get(selected.id)!, { exact: true }).waitFor()
        // A later permission loss must remove the entry, including on an already-open settings page.
        if (width !== 390) {
          if (width === 900) await page.getByRole('button', { name: '打开会话列表', exact: true }).click()
          await page
            .getByRole('region', { name: `最近项目 ${width}`, exact: true })
            .getByRole('button', { name: `最近项目 ${width} 的项目操作`, exact: true })
            .click()
          await page.getByRole('menuitem', { name: '管理文件夹…', exact: true }).click()
          await recent.waitFor()
          const device = (await owner.json<{ devices: Device[] }>('devices')).devices.find(device => device.name === deviceName)!
          expect((await host.raw('unix', 'api/devices/' + device.id, { method: 'DELETE' })).status).toBe(200)
          await recent.waitFor({ state: 'detached' })
        }
      } finally {
        await context.close()
      }
    })

    it(`keeps empty projects visible and edits their ordered folders at ${width}px in ${theme}`, async () => {
      const desktop = await host.enroll({ listener: 'unix' })
      const paths = [join(host.root, `api-${width}`), join(host.root, `web-${width}`)]
      await Promise.all(paths.map(path => mkdir(path)))
      const added = await desktop.addFolders({ name: `项目 ${width}`, paths })
      expect(added.status).toBe(201)
      const project = ((await added.json()) as { workspace: WorkspaceInfo }).workspace
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, locale: 'zh-CN' })
      context.setDefaultTimeout(15_000)
      try {
        const page = await context.newPage()
        await enrollBrowser(page, host, { name: `项目验收 ${width}`, scopes: ['admin'] })
        if (width === 900) await page.getByRole('button', { name: '打开会话列表', exact: true }).click()
        const group = page.getByRole('region', { name: `项目 ${width}`, exact: true })
        await group.waitFor()
        await group.getByRole('button', { name: `项目 ${width} 的项目操作`, exact: true }).click()
        await page.getByRole('menuitem', { name: '重命名', exact: true }).click()
        await group.getByLabel('项目名称', { exact: true }).fill(`服务 ${width}`)
        await group.getByRole('button', { name: '保存', exact: true }).click()
        const renamed = page.getByRole('region', { name: `服务 ${width}`, exact: true })
        await renamed.waitFor()
        await renamed.getByRole('button', { name: `服务 ${width} 的项目操作`, exact: true }).click()
        await page.getByRole('menuitem', { name: '管理文件夹…', exact: true }).click()
        const settings = page.locator('.settings-page')
        await settings.getByText('0 个会话', { exact: true }).last().waitFor()
        expect(await settings.getByRole('button', { name: '0 个会话' }).count()).toBe(0)
        const folders = settings.locator('.project-editor .project-folder')
        expect(await folders.count()).toBe(2)
        await folders
          .nth(1)
          .getByRole('button', { name: `web-${width} 的更多操作`, exact: true })
          .click()
        await page.getByRole('menuitem', { name: '设为主文件夹', exact: true }).click()
        await folders
          .nth(0)
          .filter({ hasText: `web-${width}` })
          .waitFor()
        expect(
          (await desktop.json<{ workspaces: WorkspaceInfo[] }>('workspaces')).workspaces.find(item => item.id === project.id)?.path,
        ).toBe(await realpath(paths[1]!))
        await mkdir('test-results/projects', { recursive: true })
        await page.screenshot({ path: `test-results/projects/editor-${width}-${theme}.png`, animations: 'disabled' })
        await closeSettings(settings)
        // A missing directory remains a project with its reason after a fresh snapshot.
        await rm(paths[0]!, { recursive: true })
        await expect
          .poll(
            async () =>
              (await desktop.json<{ workspaces: WorkspaceInfo[] }>('workspaces')).workspaces.find(item => item.id === project.id)
                ?.unavailable,
            { timeout: 10_000 },
          )
          .toContain('找不到这个文件夹')
        await page.reload()
        await page.locator('.app-shell[data-connection="connected"]').waitFor()
        if (width === 900) await page.getByRole('button', { name: '打开会话列表', exact: true }).click()
        await page
          .getByRole('region', { name: `服务 ${width}`, exact: true })
          .getByText('找不到这个文件夹', { exact: false })
          .waitFor()
        await page.screenshot({ path: `test-results/projects/missing-${width}-${theme}.png`, animations: 'disabled' })
      } finally {
        await context.close()
      }
    })
  }
})
