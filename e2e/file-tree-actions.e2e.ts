import { randomUUID } from 'node:crypto'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron, chromium, type ElectronApplication, type Page } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import type { TaskDetail, WorkspaceInfo } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { writeHostState } from '@latch/host/host-state'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { noHorizontalOverflow, reachable } from './helpers/layout.ts'
import { startTestHost } from './helpers/host.ts'

async function recordClipboard(page: Page) {
  await page.evaluate(() => {
    const copies: string[] = []
    Reflect.set(window, 'treeCopies', copies)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copies.push(text)
        },
      },
    })
  })
}

it('keeps expanded directories while real run changes arrive and exposes the same file menu to pointer and keyboard', async () => {
  let source = ''
  const plugin: HarnessPlugin = {
    id: 'tree-action-model',
    name: 'Tree fixture',
    description: '',
    version: '1',
    activate(context) {
      context.registerProvider({
        id: 'tree-action-model',
        name: 'Tree fixture',
        model: 'fixture',
        async *stream({ messages }) {
          const prompt = messages.at(-1)?.content
          if (typeof prompt === 'string' && /^新增 \d+-(?:light|dark)$/u.test(prompt))
            await writeFile(join(source, 'src', `generated-${prompt.slice(3)}.txt`), 'Observed real file change\n')
          yield { type: 'text', text: '已完成本地文件检查。' }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  const host = await startTestHost({ plugins: [plugin] }),
    browser = await chromium.launch(browserLaunchOptions())
  try {
    const owner = await host.enroll({ listener: 'unix' })
    source = join(host.root, 'project')
    await mkdir(join(source, 'src'), { recursive: true })
    await writeFile(join(source, 'src/original.ts'), 'export const original = true;\n')
    const added = await owner.addFolders({ name: '文件操作项目', paths: [source] })
    expect(added.status).toBe(201)
    const project = ((await added.json()) as { workspace: WorkspaceInfo }).workspace
    await mkdir('test-results/file-tree-actions', { recursive: true })
    for (const [width, theme] of [
      [390, 'light'],
      [900, 'dark'],
      [1440, 'light'],
    ] as const) {
      const created = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          prompt: `准备 ${width}-${theme}`,
          mode: 'agent',
          workspaceId: project.id,
          model: { providerId: 'tree-action-model', model: 'fixture' },
        },
      })
      await expect.poll(async () => (await owner.json<TaskDetail>('tasks/' + created.sessionId)).summary.status).toBe('idle')
      const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme: theme, locale: 'zh-CN' })
      const page = await context.newPage()
      page.setDefaultTimeout(15_000)
      try {
        const name = '树操作 ' + width
        await enrollBrowser(page, host, { name, scopes: ['view', 'run'] })
        const deviceId = host.host.security.devices.list().find(device => device.name === name)!.id
        expect((await owner.confirmed('devices/' + deviceId, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
        await page.reload()
        await connected(page)
        await page.keyboard.press('Meta+k')
        const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
        await palette.getByRole('searchbox').fill(`准备 ${width}-${theme}`)
        await palette.getByRole('option', { name: `准备 ${width}-${theme}`, exact: true }).click()
        await recordClipboard(page)
        await page.keyboard.press('Alt+Shift+e')
        const tree = page.getByRole('region', { name: '项目文件', exact: true })
        await tree.getByRole('treeitem', { name: 'src', exact: true }).click()
        const original = tree.getByRole('treeitem', { name: 'original.ts', exact: true })
        await original.click({ button: 'right' })
        const menu = page.getByRole('menu', { name: 'original.ts 文件操作', exact: true })
        await reachable(menu.getByRole('menuitem', { name: '复制路径', exact: true }))
        expect(await menu.getByRole('menuitem', { name: '复制相对路径', exact: true }).count()).toBe(0)
        expect(await menu.getByRole('menuitem', { name: /在.*显示/u }).count()).toBe(0)
        await menu.getByRole('menuitem', { name: '复制路径', exact: true }).click()
        expect(await page.evaluate(() => Reflect.get(window, 'treeCopies'))).toEqual(['src/original.ts'])
        await original.focus()
        await original.press('Shift+F10')
        await menu.waitFor()
        await page.keyboard.press('Escape')
        await expect
          .poll(() =>
            original
              .getByRole('button', { name: 'original.ts 文件操作', exact: true })
              .evaluate(element => element === document.activeElement),
          )
          .toBe(true)
        if (width < 768) await page.getByRole('button', { name: '返回', exact: true }).click()
        const input = page.getByRole('textbox', { name: '继续对话', exact: true })
        await input.fill(`新增 ${width}-${theme}`)
        await input.press('Meta+Enter')
        await expect
          .poll(
            async () =>
              (await owner.json<TaskDetail>('tasks/' + created.sessionId)).messages.some(message =>
                message.outputs?.some(file => file.path === `src/generated-${width}-${theme}.txt`),
              ),
            { timeout: 10_000 },
          )
          .toBe(true)
        if (width < 768) await page.keyboard.press('Alt+Shift+e')
        const generated = tree.getByRole('treeitem', { name: `generated-${width}-${theme}.txt`, exact: true })
        await generated.waitFor()
        expect(await tree.getByRole('treeitem', { name: 'src', exact: true }).getAttribute('aria-expanded')).toBe('true')
        await generated.getByLabel('本轮运行期间有变化', { exact: true }).waitFor()
        await reachable(generated.getByRole('button', { name: `generated-${width}-${theme}.txt 文件操作`, exact: true }))
        await noHorizontalOverflow(page, tree)
        await page.screenshot({ path: `test-results/file-tree-actions/changed-${width}-${theme}.png`, animations: 'disabled' })
      } catch (error) {
        await page.screenshot({ path: `test-results/file-tree-actions/failure-${width}-${theme}.png`, animations: 'disabled' })
        await writeFile(
          `test-results/file-tree-actions/failure-${width}-${theme}.json`,
          JSON.stringify(
            await page
              .locator('.session-panels')
              .evaluateAll(nodes => nodes.map(node => ({ text: node.textContent, html: node.innerHTML }))),
            null,
            2,
          ),
        )
        throw error
      } finally {
        await context.close()
      }
    }
  } finally {
    await browser.close()
    await host.close()
  }
})

describe.skipIf(latchEnv(process.env, 'ELECTRON_E2E') !== '1' || process.platform !== 'darwin')('actual desktop tree actions', () => {
  it('copies only the resolved frozen-root path and asks the real main bridge to reveal an authorized handle', async () => {
    const host = await startTestHost()
    let application: ElectronApplication | undefined
    try {
      const owner = await host.enroll({ listener: 'unix' }),
        source = join(host.root, 'desktop-tree-project')
      await mkdir(join(source, 'src'), { recursive: true })
      await writeFile(join(source, 'src/original.ts'), 'export const original = true;\n')
      const projectResponse = await owner.addFolders({ name: '桌面文件操作', paths: [source] })
      expect(projectResponse.status).toBe(201)
      const project = ((await projectResponse.json()) as { workspace: WorkspaceInfo }).workspace
      const canonicalSource = await realpath(source)
      await writeHostState(host.dataDir, {
        version: 2,
        pid: process.pid,
        hostId: host.host.hostId,
        instanceId: host.host.instanceId,
        socketPath: host.host.socketPath,
        loopbackOrigin: host.host.loopbackOrigin,
        tlsOrigin: null,
        startedAt: new Date().toISOString(),
        dataDir: host.dataDir,
      })
      application = await _electron.launch({
        args: [
          resolve('apps/desktop/src/main.cjs'),
          '--latch-host-state=' + join(host.dataDir, 'host.json'),
          '--latch-user-data=' + join(host.root, 'electron'),
          '--use-mock-keychain',
        ],
        cwd: process.cwd(),
        env: Object.fromEntries(
          Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
        timeout: 30_000,
      })
      const page = await application.firstWindow()
      page.setDefaultTimeout(15_000)
      await page.getByRole('button', { name: '继续', exact: true }).click()
      await connected(page)
      await application.evaluate(({ shell }) => {
        const paths: string[] = []
        Reflect.set(globalThis, 'treeReveals', paths)
        shell.showItemInFolder = (path: string) => {
          paths.push(path)
        }
      })
      await recordClipboard(page)
      await page
        .getByRole('region', { name: '桌面文件操作', exact: true })
        .getByRole('button', { name: '在 桌面文件操作 中新建会话', exact: true })
        .click()
      await page.keyboard.press('Meta+Shift+e')
      const tree = page.getByRole('region', { name: '项目文件', exact: true })
      await tree.getByRole('treeitem', { name: 'src', exact: true }).click()
      const original = tree.getByRole('treeitem', { name: 'original.ts', exact: true })
      await original.click({ button: 'right' })
      await page.getByRole('menuitem', { name: '复制路径', exact: true }).click()
      await expect.poll(() => page.evaluate(() => Reflect.get(window, 'treeCopies'))).toEqual([join(canonicalSource, 'src/original.ts')])
      await original.focus()
      await original.press('Shift+F10')
      await page.getByRole('menuitem', { name: '在访达中显示', exact: true }).click()
      await expect
        .poll(() => application!.evaluate(() => Reflect.get(globalThis, 'treeReveals')))
        .toEqual([join(canonicalSource, 'src/original.ts')])
      expect((await owner.json<{ tasks: unknown[] }>('snapshot')).tasks).toEqual([])
      expect(host.host.security.audit.lastOf('file.reveal')).toBeDefined()
      expect(project.folders?.length).toBe(1)
    } finally {
      await application?.close()
      await host.close()
    }
  })
})
