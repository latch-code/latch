import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { webkit } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import type { WorkspaceInfo } from '@latch/protocol'
import { connected, enrollBrowser } from './helpers/browser.ts'
import { backToPhoneSessions, noHorizontalOverflow } from './helpers/layout.ts'
import { startTestHost } from './helpers/host.ts'
import { promptValue } from './helpers/prompt.ts'

describe('WebKit workbench and authorized file rendering', () => {
  it.each([
    [390, 'light'],
    [900, 'dark'],
    [1440, 'light'],
  ] as const)('%s %s opens a project before sending, quotes a document and preserves its draft', async (width, theme) => {
    const host = await startTestHost(),
      browser = await webkit.launch({ headless: true })
    const context = await browser.newContext({
      viewport: { width, height: 960 },
      colorScheme: theme,
      locale: 'zh-CN',
      reducedMotion: 'reduce',
    })
    try {
      const desktop = await host.enroll({ listener: 'unix' }),
        source = join(host.root, 'webkit-project')
      await mkdir(source)
      await writeFile(join(source, 'README.md'), '# 浏览器兼容检查\n\n这段内容来自授权的项目文件。\n\n```ts\nconst answer = 42\n```\n')
      const added = await desktop.addFolders({ name: '兼容项目', paths: [source] })
      expect(added.status).toBe(201)
      const project = ((await added.json()) as { workspace: WorkspaceInfo }).workspace,
        page = await context.newPage()
      page.setDefaultTimeout(15_000)
      const submissions: unknown[] = []
      page.on('request', request => {
        if (request.url().endsWith('/link/api/tasks') && request.method() === 'POST') submissions.push(request.postDataJSON())
      })
      await enrollBrowser(page, host, { name: 'WebKit ' + width, scopes: ['view', 'run'] })
      const deviceId = await page.evaluate(async () => (await (await fetch('/link/api/snapshot')).json()).device.id as string)
      expect((await desktop.confirmed('devices/' + deviceId, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
      await page.reload()
      await connected(page)
      if (width === 390) await backToPhoneSessions(page)
      const navigation = page.getByRole('button', { name: '打开会话列表', exact: true })
      if (await navigation.isVisible()) await navigation.click()
      await page
        .getByRole('region', { name: '兼容项目', exact: true })
        .getByRole('button', { name: '在 兼容项目 中新建会话', exact: true })
        .click()
      const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
      await input.fill('请阅读这些内容，再给我建议。')
      await page.keyboard.press('Alt+Shift+e')
      const tree = page.getByRole('region', { name: '项目文件', exact: true })
      await tree.getByRole('treeitem', { name: 'README.md', exact: true }).click()
      const preview = page.getByRole('region', { name: '文件预览', exact: true })
      await preview.getByRole('heading', { name: '浏览器兼容检查', exact: true }).waitFor()
      await preview.getByText('这段内容来自授权的项目文件。', { exact: true }).evaluate(element => {
        const range = element.ownerDocument.createRange()
        range.selectNodeContents(element)
        const selection = element.ownerDocument.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      })
      await preview.getByRole('button', { name: '引用到对话', exact: true }).click()
      await expect.poll(() => promptValue(input)).toContain('> 这段内容来自授权的项目文件。')
      expect(await promptValue(input)).toContain('请阅读这些内容，再给我建议。')
      expect(await promptValue(input)).toContain('@' + project.folders![0]!.id + ':README.md')
      expect(submissions).toHaveLength(0)
      expect(await host.host.bridge.listTasks()).toHaveLength(0)
      await noHorizontalOverflow(page)
      await mkdir('test-results/webkit', { recursive: true })
      await page.screenshot({ path: 'test-results/webkit/quoted-' + width + '-' + theme + '.png', animations: 'disabled' })
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await input.press('Meta+Enter')
      await expect.poll(() => submissions.length).toBe(1)
      await expect.poll(async () => (await host.host.bridge.listTasks())[0]?.status).toBe('idle')
      await page
        .locator('.transcript')
        .getByText(/请阅读这些内容，再给我建议/u)
        .first()
        .waitFor()
      expect(errors).toEqual([])
    } finally {
      await context.close()
      await browser.close()
      await host.close()
    }
  })
})
