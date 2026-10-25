import { chromium, type Browser } from '@playwright/test'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { WorkspaceInfo } from '@latch/protocol'
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
        const settings = page.getByRole('dialog', { name: '设置', exact: true })
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
