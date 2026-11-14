import { chromium } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { TaskDetail, WorkspaceInfo } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { startTestHost } from './helpers/host.ts'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { backToPhoneSessions, settleShell } from './helpers/layout.ts'

it.each([
  [390, 'light'],
  [900, 'dark'],
  [1440, 'light'],
  [1440, 'dark'],
] as const)(
  'browses and quotes the new Home project at %s %s without replacing the retained session draft or file tab',
  async (width, theme) => {
    const provider: HarnessPlugin = {
      id: 'file-targets',
      name: 'Fixture',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerProvider({
          id: 'file-targets',
          name: 'Fixture',
          model: 'fixture',
          async *stream({ messages }) {
            if (messages.findLast(message => message.role === 'user')?.content === '旧项目会话') throw new Error('旧会话的模型响应失败')
            yield { type: 'text', text: '新项目收到了引用。' }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    const host = await startTestHost({ demo: false, providerId: provider.id, plugins: [provider] })
    const browser = await chromium.launch(browserLaunchOptions())
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: 'reduce',
      colorScheme: theme,
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const oldPath = join(host.root, 'retained-project')
      const newPath = join(host.root, 'home-project')
      await Promise.all([mkdir(oldPath), mkdir(newPath)])
      await writeFile(join(oldPath, 'old.txt'), '旧文件页签保留。\n')
      await writeFile(join(newPath, 'new.txt'), '新项目的引用内容。\n')
      const oldProject = ((await (await owner.addFolders({ name: '旧项目', paths: [oldPath] })).json()) as { workspace: WorkspaceInfo })
        .workspace
      const newProject = ((await (await owner.addFolders({ name: '新项目', paths: [newPath] })).json()) as { workspace: WorkspaceInfo })
        .workspace
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { prompt: '旧项目会话', requestId: randomUUID(), workspaceId: oldProject.id, mode: 'agent' },
      })
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('failed')
      await enrollBrowser(page, host, { name: '首页文件目标', scopes: ['admin'] })
      const deviceId = host.host.security.devices.list().find(device => device.name === '首页文件目标')!.id
      expect((await owner.confirmed(`devices/${deviceId}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
      await page.reload()
      await connected(page)
      const openOld = () => page.locator(`.workbench-home [data-work-session="${sessionId}"] .work-decision-session`).click()
      await openOld()
      await page.locator('main.workspace:not([inert]) .transcript-content').waitFor()
      const header = page.locator('.topbar[data-phone]')
      await header.getByRole('button', { name: '侧边面板', exact: true }).click()
      await page.getByRole('tab', { name: '文件', exact: true }).click()
      await page.getByRole('treeitem', { name: 'old.txt', exact: true }).click()
      await page.getByRole('region', { name: '文件预览', exact: true }).getByText('旧文件页签保留。', { exact: true }).waitFor()
      await page.locator('.info-page-head').getByRole('button', { name: '返回', exact: true }).click()
      await page.locator('.info-page').waitFor({ state: 'detached' })
      await page.getByRole('textbox', { name: '继续对话', exact: true }).fill('旧会话草稿')
      await header.getByRole('button', { name: '返回总览', exact: true }).click()
      // The project is the first chip of the row over the home's input.
      await page.locator('.workbench-home .composer-chips .home-composer-location').getByRole('button').first().click()
      await page
        .getByRole('dialog', { name: '项目', exact: true })
        .getByRole('radio', { name: /新项目/u })
        .click()
      await page.getByRole('dialog', { name: '项目', exact: true }).waitFor({ state: 'hidden' })
      const input = page.locator('.workbench-home').getByRole('textbox', { name: '新会话消息', exact: true })
      await input.fill('给新项目的草稿')
      // The same Home draft and retained reading survive a resize before the file action.
      if (width !== 390) {
        await page.setViewportSize({ width, height: 960 })
        await settleShell(page)
        expect(await input.inputValue()).toBe('给新项目的草稿')
      }
      const reads: string[] = []
      const starts: unknown[] = []
      page.on('request', request => {
        const path = new URL(request.url()).pathname
        if (path.includes('/files/')) reads.push(path)
        if (path === '/link/api/tasks' && request.method() === 'POST') starts.push(request.postDataJSON())
      })
      // The draft's files open from the palette on every width. (A phone in the 侧栏 layout has no control that opens
      // it: the key stands in here.)
      const browse = async () => {
        await page.keyboard.press('Meta+k')
        const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
        await palette.getByRole('searchbox').fill('浏览项目文件')
        await palette.getByRole('option', { name: /浏览项目文件/u }).click()
      }
      await browse()
      await expect
        .poll(() => reads.some(path => path.startsWith(`/link/api/workspaces/${newProject.id}/files/`)), { timeout: 5000 })
        .toBe(true)
      if (width === 390) {
        const files = page.getByRole('dialog', { name: '项目文件', exact: true })
        const done = files.getByRole('button', { name: '完成', exact: true })
        const hit = await done.evaluate(button => {
          const box = button.getBoundingClientRect()
          const before = getComputedStyle(button, '::before')
          return {
            x: box.x + box.width / 2,
            y: box.y - 5,
            height: box.height - parseFloat(before.top) - parseFloat(before.bottom),
            reachesTop: button.contains(document.elementFromPoint(box.x + box.width / 2, box.y - 5)),
            reachesBottom: button.contains(document.elementFromPoint(box.x + box.width / 2, box.bottom + 5)),
          }
        })
        expect(hit.height).toBeGreaterThanOrEqual(44)
        expect(hit.reachesTop && hit.reachesBottom).toBe(true)
        await page.mouse.click(hit.x, hit.y)
        await files.waitFor({ state: 'hidden' })
        expect(await input.inputValue()).toBe('给新项目的草稿')
        await browse()
      }
      await page.getByRole('treeitem', { name: 'new.txt', exact: true }).click()
      const preview = page.getByRole('region', { name: '文件预览', exact: true })
      await preview.getByText('新项目的引用内容。', { exact: true }).evaluate(element => {
        const range = document.createRange()
        range.selectNodeContents(element)
        const selection = document.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      })
      if (width !== 390) expect((await preview.boundingBox())!.height).toBeGreaterThanOrEqual(400)
      await mkdir('test-results/file-tree', { recursive: true })
      await page.screenshot({ path: `test-results/file-tree/home-preview-${width}-${theme}.png`, animations: 'disabled' })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await preview.getByRole('button', { name: '引用到对话', exact: true }).click()
      await expect.poll(() => input.inputValue()).toContain(`@${newProject.folders![0]!.id}:new.txt`)
      expect(await input.inputValue()).toContain('给新项目的草稿')
      await page.locator('.workbench-home').getByRole('button', { name: '发送', exact: true }).click()
      await expect.poll(() => starts.length).toBe(1)
      expect(starts[0]).toMatchObject({ workspaceId: newProject.id, fileRefs: [{ root: newProject.folders![0]!.id, path: 'new.txt' }] })
      await page.locator('main.workspace:not([inert]) .turn-reply').getByText('新项目收到了引用。', { exact: true }).waitFor()
      if (width !== 390) {
        await page.setViewportSize({ width: 390, height: 844 })
        await settleShell(page)
      }
      await header.getByRole('button', { name: '返回总览', exact: true }).click()
      await openOld()
      expect(await page.getByRole('textbox', { name: '继续对话', exact: true }).inputValue()).toBe('旧会话草稿')
      await header.getByRole('button', { name: '侧边面板', exact: true }).click()
      await page.getByRole('region', { name: '文件预览', exact: true }).getByText('旧文件页签保留。', { exact: true }).waitFor()
    } finally {
      await context.close()
      await browser.close()
      await host.close()
    }
  },
)

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
        if (width === 390) await backToPhoneSessions(page)
        if (width === 900) await page.getByRole('button', { name: '打开会话列表', exact: true }).click()
        await page
          .getByRole('region', { name: '文件项目', exact: true })
          .getByRole('button', { name: '在 文件项目 中新建会话', exact: true })
          .click()
        const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
        await input.fill('保留我的草稿')
        const taskCount = (await host.host.bridge.listTasks()).length
        await page.keyboard.press('Alt+Shift+e')
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
        await preview.getByText('这个文件在发消息前就可以查看。', { exact: true }).evaluate(element => {
          const range = element.ownerDocument.createRange()
          range.selectNodeContents(element)
          const selection = element.ownerDocument.getSelection()!
          selection.removeAllRanges()
          selection.addRange(range)
          element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        })
        await preview.getByRole('button', { name: '引用到对话', exact: true }).click()
        await expect.poll(() => input.inputValue()).toContain('> 这个文件在发消息前就可以查看。')
        expect(await input.inputValue()).toContain('保留我的草稿')
        expect(await input.inputValue()).toContain('引用时文件：')
        expect(await host.host.bridge.listTasks()).toHaveLength(taskCount)
        expect(submissions).toHaveLength(0)
        await page.screenshot({ path: `test-results/file-tree/quoted-draft-${width}-${theme}.png`, animations: 'disabled' })
        await input.fill('保留我的草稿')
        if (width === 390) {
          // Leaving the home for the list and coming back through 新建会话 keeps the draft.
          await backToPhoneSessions(page)
          expect(await page.locator('.phone-list').getByRole('button', { name: '返回总览', exact: true }).isVisible()).toBe(true)
          await page.locator('.phone-list').getByRole('button', { name: '新建会话', exact: true }).click()
          expect(await input.inputValue()).toBe('保留我的草稿')
        }
        // The home has no title row of its own: the draft's files come back with their key.
        if (!(await page.getByRole('tab', { name: '文件', exact: true }).isVisible())) await page.keyboard.press('Alt+Shift+e')
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
          await page.getByRole('menuitem', { name: /^显示隐藏项/u }).click()
          await tree.getByRole('treeitem', { name: '.note.txt', exact: true }).waitFor()
          await tree.getByRole('treeitem', { name: 'node_modules', exact: true }).waitFor()
          expect(await tree.getByRole('treeitem', { name: 'src', exact: true }).getAttribute('aria-expanded')).toBe('true')
          await tree.getByRole('treeitem', { name: 'start.ts', exact: true }).hover()
          await tree
            .getByRole('treeitem', { name: 'start.ts', exact: true })
            .getByRole('button', { name: 'start.ts 文件操作', exact: true })
            .click()
          await page.getByRole('menuitem', { name: '引用到对话', exact: true }).click()
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
          await search.getByRole('option', { name: /^notes\.txt/u }).click()
          await preview.getByText('second root', { exact: true }).waitFor()
          await settleShell(page)
          expect(await host.host.bridge.listTasks()).toHaveLength(taskCount)
          if (width === 390) {
            // Over the home the draft's files are a sheet with 完成; over a session, the panel's page with 返回.
            await page
              .getByRole('button', { name: /^(?:返回|完成)$/u })
              .filter({ visible: true })
              .first()
              .click()
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
