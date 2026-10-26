import { chromium } from '@playwright/test'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { WorkspaceInfo } from '@latch/protocol'
import { startTestHost } from './helpers/host.ts'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { settleShell } from './helpers/layout.ts'

it('browses a saved project before creating a session, previews and quotes real roots, and keeps large directories lazy', async () => {
  const host = await startTestHost()
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    const desktop = await host.enroll({ listener: 'unix' })
    const source = join(host.root, 'source'),
      assets = join(host.root, 'assets')
    await Promise.all([mkdir(source), mkdir(assets)])
    await Promise.all(['src', 'many', 'gone', '.cache', 'node_modules'].map(path => mkdir(join(source, path))))
    await writeFile(join(source, 'README.md'), '# 项目说明\n\n这个文件在发消息前就可以查看。\n')
    await writeFile(join(source, 'src/start.ts'), 'export const ready = true;\n')
    await writeFile(join(source, '.note.txt'), 'hidden fixture\n')
    await writeFile(join(assets, 'notes.txt'), 'second root\n')
    await symlink(assets, join(source, 'linked-assets'))
    await Promise.all(
      Array.from({ length: 140 }, (_, index) => writeFile(join(source, 'many', `file-${String(index).padStart(3, '0')}.txt`), 'fixture\n')),
    )
    const added = await desktop.addFolders({ name: '文件项目', paths: [source, assets] })
    expect(added.status).toBe(201)
    const project = ((await added.json()) as { workspace: WorkspaceInfo }).workspace
    await mkdir('test-results/file-tree', { recursive: true })
    for (const [width, theme] of [
      [390, 'light'],
      [900, 'dark'],
      [1440, 'light'],
      [1440, 'dark'],
    ] as const) {
      const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme: theme, locale: 'zh-CN' })
      const page = await context.newPage()
      page.setDefaultTimeout(15_000)
      const paths: string[] = [],
        submissions: unknown[] = []
      page.on('request', request => {
        const path = new URL(request.url()).pathname
        if (/\/files\/(?:list|resolve|search)$/u.test(path)) paths.push(path)
        if (path === '/link/api/tasks' && request.method() === 'POST') submissions.push(request.postDataJSON())
      })
      try {
        await enrollBrowser(page, host, { name: `Files ${width} ${theme}`, scopes: ['admin'] })
        expect(await page.getByRole('button', { name: '浏览项目文件', exact: true }).count()).toBe(0)
        const deviceId = await page.evaluate(async () => (await (await fetch('/link/api/snapshot')).json()).device.id as string)
        expect((await desktop.confirmed(`devices/${deviceId}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
        await page.reload()
        await page.locator('.app-shell[data-connection="connected"]').waitFor()
        if (width === 900) await page.getByRole('button', { name: '打开会话列表', exact: true }).click()
        await page
          .getByRole('region', { name: '文件项目', exact: true })
          .getByRole('button', { name: '在 文件项目 中新建会话', exact: true })
          .click()
        const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
        await input.fill('保留我的草稿')
        const taskCount = (await host.host.bridge.listTasks()).length
        await page.getByRole('button', { name: '浏览项目文件', exact: true }).click()
        const tree = page.getByRole('region', { name: '项目文件', exact: true })
        await tree.getByRole('treeitem', { name: 'README.md', exact: true }).waitFor()
        expect(await host.host.bridge.listTasks()).toHaveLength(taskCount)
        expect(paths.every(path => path.startsWith(`/link/api/workspaces/${project.id}/files/`))).toBe(true)
        expect(await tree.getByRole('treeitem', { name: 'node_modules', exact: true }).count()).toBe(0)
        const linked = tree.getByRole('treeitem', { name: 'linked-assets', exact: true })
        expect(await linked.getAttribute('aria-disabled')).toBe('true')
        await linked.focus()
        await page.keyboard.press('Enter')
        expect(await linked.getAttribute('aria-expanded')).toBeNull()
        await page.screenshot({ path: `test-results/file-tree/tree-${width}-${theme}.png`, animations: 'disabled' })
        await tree.getByRole('treeitem', { name: 'README.md', exact: true }).click()
        const preview = page.getByRole('region', { name: '文件预览', exact: true })
        await preview.getByRole('heading', { name: '项目说明', exact: true }).waitFor()
        await page.screenshot({ path: `test-results/file-tree/preview-${width}-${theme}.png`, animations: 'disabled' })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.getByRole('tab', { name: '文件', exact: true }).click()
        await tree.getByRole('treeitem', { name: 'src', exact: true }).focus()
        await page.keyboard.press('ArrowRight')
        await tree.getByRole('treeitem', { name: 'start.ts', exact: true }).waitFor()
        await page.keyboard.press('ArrowRight')
        await expect
          .poll(() => tree.getByRole('treeitem', { name: 'start.ts', exact: true }).evaluate(element => element === document.activeElement))
          .toBe(true)
        if (width === 1440 && theme === 'dark') {
          await tree.getByRole('treeitem', { name: 'many', exact: true }).click()
          await tree.getByRole('treeitem', { name: 'file-099.txt', exact: true }).waitFor()
          expect(await tree.getByRole('treeitem', { name: 'file-100.txt', exact: true }).count()).toBe(0)
          await tree.getByRole('button', { name: '显示更多 · many', exact: true }).click()
          await tree.getByRole('treeitem', { name: 'file-139.txt', exact: true }).waitFor()
          await tree.getByRole('treeitem', { name: 'many', exact: true }).click()
          await rm(join(source, 'gone'), { recursive: true })
          await tree.getByRole('treeitem', { name: 'gone', exact: true }).click()
          await tree.getByRole('button', { name: '重试', exact: true }).waitFor()
          await mkdir(join(source, 'gone'))
          await writeFile(join(source, 'gone/recovered.txt'), 'recovered\n')
          await tree.getByRole('button', { name: '重试', exact: true }).click()
          await tree.getByRole('treeitem', { name: 'recovered.txt', exact: true }).waitFor()
          await tree.getByRole('button', { name: '文件显示选项', exact: true }).click()
          await page.getByRole('menuitem', { name: '显示隐藏项和生成目录', exact: true }).click()
          await tree.getByRole('treeitem', { name: '.note.txt', exact: true }).waitFor()
          await tree.getByRole('treeitem', { name: 'node_modules', exact: true }).waitFor()
          await tree.getByRole('treeitem', { name: 'src', exact: true }).click()
          await tree.getByRole('treeitem', { name: 'start.ts', exact: true }).hover()
          await tree
            .getByRole('treeitem', { name: 'start.ts', exact: true })
            .getByRole('button', { name: 'start.ts 文件操作', exact: true })
            .click()
          await page.getByRole('menuitem', { name: '引用到输入框', exact: true }).click()
          expect(await input.inputValue()).toContain('保留我的草稿')
          expect(await input.inputValue()).toContain(`@${project.folders![0]!.id}:src/start.ts`)
          await page.getByRole('button', { name: '发送', exact: true }).click()
          await expect.poll(() => submissions.length).toBe(1)
          expect(submissions[0]).toMatchObject({
            workspaceId: project.id,
            fileRefs: [{ root: project.folders![0]!.id, path: 'src/start.ts' }],
          })
          await expect
            .poll(async () => (await host.host.bridge.listTasks()).find(task => task.workspaceId === project.id)?.status)
            .toBe('idle')
        } else {
          await tree.getByRole('button', { name: '搜索文件', exact: true }).click()
          const search = page.getByRole('dialog', { name: '搜索文件', exact: true })
          await search.getByLabel('搜索文件名', { exact: true }).fill('notes.txt')
          await search.getByRole('option', { name: 'notes.txt · notes.txt', exact: true }).click()
          await preview.getByText('second root', { exact: true }).waitFor()
          await settleShell(page)
          expect(await host.host.bridge.listTasks()).toHaveLength(taskCount)
          if (width === 390) {
            await page.getByRole('button', { name: '返回', exact: true }).click()
            await expect.poll(() => input.inputValue()).toBe('保留我的草稿')
          } else expect(await input.inputValue()).toBe('保留我的草稿')
        }
      } finally {
        await context.close()
      }
    }
  } finally {
    await host.close()
    await browser.close()
  }
})
