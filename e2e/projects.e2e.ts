import { chromium, type Browser, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppSnapshot, Device, TaskDetail, WorkspaceInfo } from '@latch/protocol'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import {
  backToPhoneSessions,
  closeSettings,
  layersInWindow,
  noHorizontalOverflow,
  openSection,
  openSession,
  openSettings,
  reachable,
  showTooltip,
} from './helpers/layout.ts'

async function projectSettings(page: Page, name: string) {
  const settings = await openSettings(page)
  await openSection(settings, '项目')
  await settings.getByRole('button', { name: `管理项目：${name}`, exact: true }).click()
  return settings
}

async function summaryFits(summary: Locator) {
  await noHorizontalOverflow(summary.page(), summary)
  const boxes = await summary
    .locator('.ui-sheet-body, .project-summary-body, .project-summary-folders, li, .project-summary-location, .project-summary-body button')
    .evaluateAll(elements =>
      elements.map(element => {
        const { left, right } = element.getBoundingClientRect()
        return {
          target: element.className || element.tagName,
          width: element.clientWidth,
          content: element.scrollWidth,
          left,
          right,
          viewport: innerWidth,
        }
      }),
    )
  expect(boxes.filter(box => box.left < -1 || box.right > box.viewport + 1 || box.content > box.width + 1)).toEqual([])
}

describe('saved projects', () => {
  let host: TestHost
  let browser: Browser
  beforeAll(async () => {
    host = await startTestHost({ hostName: '验收电脑' })
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
    it(`shows each current project folder and its branch from a draft and an earlier session at ${width}px in ${theme}`, async () => {
      const name = `Studio ${width}`
      const owner = await host.enroll({ listener: 'unix' })
      const sourceFolders = [
        ['studio', 'feat/project-navigation-layout'],
        ['studio-client', 'feat/project-navigation-layout'],
        ['studio-api', 'fix/project-navigation/accessibility/preserve-active-folder-on-refresh'],
        ['notes', null],
      ] as const
      const projectRoot = join(host.root, `summary-${width}`)
      const paths = sourceFolders.map(([folder]) =>
        width === 390 && folder === 'notes' ? join(projectRoot, 'a'.repeat(108), folder) : join(projectRoot, folder),
      )
      await Promise.all(paths.map(path => mkdir(path, { recursive: true })))
      for (const [index, [, branch]] of sourceFolders.entries()) {
        if (!branch) continue
        execFileSync('git', ['init', '-q', '--template=', '-b', branch, paths[index]!], {
          env: { HOME: host.root, GIT_CONFIG_NOSYSTEM: '1', PATH: process.env.PATH },
        })
      }
      const added = await owner.addFolders({ name, paths: [paths[0]!] })
      expect(added.status).toBe(201)
      const { workspace } = (await added.json()) as { workspace: WorkspaceInfo }
      const context = await browser.newContext({
        viewport: { width, height },
        hasTouch: width === 390,
        colorScheme: theme,
        locale: 'zh-CN',
        reducedMotion: 'reduce',
      })
      context.setDefaultTimeout(15_000)
      try {
        const page = await context.newPage()
        await enrollBrowser(page, host, { name: `项目摘要设备 ${width}`, scopes: ['admin'] })
        if (width === 390) await backToPhoneSessions(page)
        if (width === 900) await page.getByRole('button', { name: '打开会话列表', exact: true }).click()
        const summaryButton = { name: `项目摘要：${name}`, exact: true }
        const group = page.getByRole('region', { name, exact: true })
        expect(await group.getByRole('button', summaryButton).count()).toBe(0)
        const actions = group.getByRole('button', { name: `${name} 的项目操作`, exact: true })
        await actions.click()
        const editItem = page.getByRole('menuitem', { name: '编辑项目…', exact: true })
        await editItem.waitFor()
        expect(await page.getByRole('menuitem').allTextContents()).toEqual(['新会话', '编辑项目…'])
        await mkdir('test-results/projects', { recursive: true })
        await page.screenshot({ path: `test-results/projects/project-menu-${width}-${theme}.png`, animations: 'disabled' })
        await page.keyboard.press('Escape')
        await editItem.waitFor({ state: 'hidden' })
        await expect.poll(() => actions.evaluate(button => button === document.activeElement)).toBe(true)
        await actions.click()
        await page.getByRole('menuitem', { name: '新会话', exact: true }).click()
        const trigger = page.locator('.titlebar-views, .workbench-phone-heading').getByRole('button', summaryButton)
        await reachable(trigger)
        await trigger.click()
        const summary = page.getByRole('dialog', { name: width === 390 ? name : summaryButton.name, exact: true })
        const folders = summary.getByRole('listitem')
        const rows = summary.locator('.project-summary-location')
        await folders.first().locator('.project-summary-branch').getByText(sourceFolders[0][1], { exact: true }).waitFor()
        expect(await folders.count()).toBe(1)
        await page.keyboard.press('Escape')
        await summary.waitFor({ state: 'hidden' })
        await expect.poll(() => trigger.evaluate(button => button === document.activeElement)).toBe(true)
        const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
          method: 'POST',
          body: { workspaceId: workspace.id, mode: 'agent', prompt: '项目会话', requestId: randomUUID() },
        })
        await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
        expect((await owner.addFolders({ projectId: workspace.id, paths: paths.slice(1) })).ok).toBe(true)
        await openSession(page, sessionId)
        await page.locator('.topbar').getByRole('button', summaryButton).click()
        for (const [index, [label, branch]] of sourceFolders.entries()) {
          const folder = folders.nth(index)
          const row = rows.nth(index)
          const folderName = row.getByText(label, { exact: true })
          await folderName.waitFor()
          if (branch) {
            const branchName = folder.locator('.project-summary-branch').getByText(branch, { exact: true })
            await branchName.waitFor()
            const heading = (await folderName.boundingBox())!
            expect((await branchName.boundingBox())!.y).toBeGreaterThanOrEqual(heading.y + heading.height - 1)
          } else {
            expect((await row.innerText()).trim()).toBe(label)
            expect(await folder.locator('.project-summary-branch, .latch-glyph-branch').count()).toBe(0)
          }
          expect(await row.innerText()).not.toContain(`summary-${width}`)
        }
        expect(await folders.count()).toBe(sourceFolders.length)
        await rows.first().getByText('主文件夹', { exact: true }).waitFor()
        expect(await folders.locator('details').count()).toBe(0)
        expect(await folders.locator('.latch-glyph-chevron-right').count()).toBe(0)
        expect(await summary.getByRole('button', { name: '添加文件夹…', exact: true }).count()).toBe(0)
        const edit = summary.getByRole('button', { name: '编辑项目', exact: true })
        const editBox = (await edit.boundingBox())!
        const panel = (await summary.boundingBox())!
        expect(editBox.x + editBox.width / 2).toBeGreaterThan(panel.x + panel.width / 2)
        expect(editBox.y + editBox.height).toBeLessThanOrEqual((await folders.first().boundingBox())!.y + 1)
        await summaryFits(summary)
        await layersInWindow(page)
        await page.mouse.move(0, 0)
        for (const colorScheme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme })
          await page.screenshot({ path: `test-results/projects/summary-${width}-${colorScheme}.png`, animations: 'disabled' })
          if ((width === 900 && colorScheme === 'light') || (width === 1440 && colorScheme === 'dark'))
            await summary.screenshot({ path: `test-results/projects/summary-detail-${width}-${colorScheme}.png`, animations: 'disabled' })
        }
        await page.emulateMedia({ colorScheme: theme })
        if (width === 1440) {
          const plain = folders.last()
          const heightBeforeClick = await plain.evaluate(row => row.clientHeight)
          await rows.last().click()
          await page.mouse.move(0, 0)
          expect((await plain.innerText()).trim()).toBe('notes')
          expect(await plain.evaluate(row => row.clientHeight)).toBe(heightBeforeClick)
          await edit.focus()
          for (const [target, value] of [
            [rows.first(), await realpath(paths[0]!)],
            [folders.first().locator('.project-summary-branch'), sourceFolders[0][1]],
          ] as const) {
            await page.keyboard.press('Tab')
            expect(await target.evaluate(row => row === document.activeElement)).toBe(true)
            const tip = page.getByRole('tooltip').filter({ hasText: value })
            await tip.waitFor()
            expect((await target.getAttribute('aria-describedby'))?.split(' ')).toContain(await tip.getAttribute('id'))
          }
          await edit.focus()
        }
        const touch = width === 390
        if (touch) await page.setViewportSize({ width: 320, height: 568 })
        const long = folders.nth(2)
        const branch = long.locator('.project-summary-branch')
        const tail = branch.locator('.middle-ellipsis-tail')
        expect(await tail.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
        const rowHeight = await long.evaluate(row => row.clientHeight)
        for (const [target, value, kind] of [
          [rows.nth(2), await realpath(paths[2]!), 'path'],
          [branch, sourceFolders[2][1], 'branch'],
        ] as const) {
          const hint = await showTooltip(page, target, touch)
          expect(await hint.tip.innerText()).toBe(value)
          expect(await long.evaluate(row => row.clientHeight)).toBe(rowHeight)
          await noHorizontalOverflow(page, hint.tip)
          const hintBox = (await hint.tip.boundingBox())!
          const viewport = page.viewportSize()!
          expect(hintBox.x).toBeGreaterThanOrEqual(0)
          expect(hintBox.y).toBeGreaterThanOrEqual(0)
          expect(hintBox.x + hintBox.width).toBeLessThanOrEqual(viewport.width + 1)
          expect(hintBox.y + hintBox.height).toBeLessThanOrEqual(viewport.height + 1)
          if (touch) await page.screenshot({ path: `test-results/projects/summary-hold-${kind}-320-light.png`, animations: 'disabled' })
          if (width === 900)
            await summary.screenshot({ path: `test-results/projects/summary-hover-${kind}-900-light.png`, animations: 'disabled' })
          await hint.close()
        }
        await reachable(edit)
        await summaryFits(summary)
        await edit.click()
        const editor = page.getByRole('dialog', { name: '编辑项目', exact: true })
        await summary.waitFor({ state: 'hidden' })
        const sources = editor.getByRole('list', { name: '源文件夹', exact: true }).getByRole('listitem')
        for (const [index, [label]] of sourceFolders.entries()) await sources.nth(index).getByText(label, { exact: true }).waitFor()
        expect(await editor.getByRole('button', { name: '添加文件夹…', exact: true }).count()).toBe(0)
        await noHorizontalOverflow(page, editor)
        if (touch) {
          // Opening the editor can leave the simulated mouse over a folder's remove button.
          await page.mouse.move(0, 0)
          await page.locator('.ui-tooltip:popover-open').waitFor({ state: 'hidden' })
          const hint = await showTooltip(page, sources.last().locator('.edit-project-folder-info'), true)
          expect(await hint.tip.innerText()).toBe(await realpath(paths[3]!))
          await noHorizontalOverflow(page, hint.tip)
          await hint.close()
          await page.setViewportSize({ width, height })
        }
        await page.screenshot({ path: `test-results/projects/edit-project-${width}-${theme}.png`, animations: 'disabled' })
        if (width === 1440) {
          await editor.getByRole('button', { name: '移除项目', exact: true }).click()
          const confirmation = page.getByRole('dialog', { name: `移除项目「${name}」？`, exact: true })
          await confirmation.getByRole('button', { name: '取消', exact: true }).click()
          const otherNotes = join(host.root, 'archive', 'notes')
          await mkdir(otherNotes, { recursive: true })
          expect((await owner.addFolders({ projectId: workspace.id, paths: [otherNotes] })).ok).toBe(true)
          await sources.getByText('archive/notes', { exact: true }).waitFor()
          const notesLabel = `summary-${width}/notes`
          const notesRow = sources.filter({ has: page.getByText(notesLabel, { exact: true }) })
          await notesRow.getByRole('button', { name: `移除文件夹：${notesLabel}`, exact: true }).click()
          const remove = page.getByRole('dialog', { name: `从项目中移除「${notesLabel}」？`, exact: true })
          await remove.getByRole('button', { name: '移除', exact: true }).click()
          await sources.getByText('notes', { exact: true }).waitFor()
          const registered = (await owner.json<{ workspaces: WorkspaceInfo[] }>('workspaces')).workspaces.find(p => p.id === workspace.id)
          expect(registered?.folders?.map(folder => folder.path)).toEqual(
            await Promise.all([...paths.slice(0, 3), otherNotes].map(path => realpath(path))),
          )
          expect((await stat(paths[3]!)).isDirectory()).toBe(true)
        }
        const renamed = `目录协作 ${width}`
        await editor.getByRole('textbox', { name: '项目名称', exact: true }).fill(renamed)
        await editor.getByRole('button', { name: '保存', exact: true }).click()
        await editor.waitFor({ state: 'hidden' })
        const renamedTrigger = page.locator('.topbar').getByRole('button', { name: `项目摘要：${renamed}`, exact: true })
        await renamedTrigger.waitFor()
        if (width === 1440) {
          await renamedTrigger.click()
          await page
            .getByRole('dialog', { name: `项目摘要：${renamed}`, exact: true })
            .getByRole('button', { name: '编辑项目' })
            .click()
          await editor.getByRole('textbox', { name: '项目名称', exact: true }).fill('待保存')
          await owner.json(`workspaces/${workspace.id}`, { method: 'DELETE' })
          await editor.waitFor({ state: 'hidden' })
          await renamedTrigger.waitFor({ state: 'hidden' })
        }
      } finally {
        await context.close()
      }
    })

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
        const settings = await projectSettings(page, `最近项目 ${width}`),
          recent = settings.locator('.project-recent-sessions'),
          expected = (await owner.json<AppSnapshot>('snapshot')).tasks
            .filter(task => task.workspaceId === project.id && task.mode !== 'chat')
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
        // The project in the title row opens where the session runs, and does not invent a branch it could not read.
        if (width !== 390) {
          await page.getByRole('button', { name: `项目：最近项目 ${width}`, exact: true }).click()
          await page.locator('.crumb-row').filter({ hasText: '读不到分支' }).waitFor()
          await page.screenshot({ path: `test-results/project-crumb-${width}.png`, animations: 'disabled' })
          await page.keyboard.press('Escape')
        }
        // A later permission loss must remove the entry, including on an already-open settings page.
        if (width !== 390) {
          await projectSettings(page, `最近项目 ${width}`)
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
        if (width === 390) await backToPhoneSessions(page)
        if (width === 900) await page.getByRole('button', { name: '打开会话列表', exact: true }).click()
        const group = page.getByRole('region', { name: `项目 ${width}`, exact: true })
        await group.waitFor()
        await desktop.json(`workspaces/${project.id}`, { method: 'PATCH', body: { glyph: 'pen-tool' } })
        await group.locator('.project-group-heading svg.lucide-pen-tool').waitFor()
        await mkdir('test-results/projects', { recursive: true })
        await page.screenshot({ path: `test-results/projects/glyph-${width}-${theme}.png`, animations: 'disabled' })
        await group.getByRole('button', { name: `项目 ${width} 的项目操作`, exact: true }).click()
        await page.getByRole('menuitem', { name: '编辑项目…', exact: true }).click()
        const editor = page.getByRole('dialog', { name: '编辑项目', exact: true })
        await editor.getByRole('textbox', { name: '项目名称', exact: true }).fill(`服务 ${width}`)
        await editor.getByRole('button', { name: '保存', exact: true }).click()
        await editor.waitFor({ state: 'hidden' })
        const renamed = page.getByRole('region', { name: `服务 ${width}`, exact: true })
        await renamed.waitFor()
        if (await page.getByRole('dialog', { name: '会话导航', exact: true }).isVisible()) await page.keyboard.press('Escape')
        const settings = await projectSettings(page, `服务 ${width}`)
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
        if (width === 390) await backToPhoneSessions(page)
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
