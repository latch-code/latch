import { _electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import type { HarnessPlugin } from '@latch/sdk'
import type { TaskDetail, WorkspaceInfo } from '@latch/protocol'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { startTestHost } from './helpers/host.ts'
import { measureWorkbenchSwitch } from './helpers/workbenchSwitch.ts'

const OUT = 'test-results/desktop-workbench'
it.skipIf(latchEnv(process.env, 'ELECTRON_E2E') !== '1' || process.platform !== 'darwin')(
  'uses the normal Electron socket entry for populated layout and space changes while keeping the long conversation and its inputs',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-workbench-'))
    const plugin: HarnessPlugin = {
      id: 'desktop-workbench',
      name: '桌面工作台验收',
      version: '1',
      description: 'Local fixture only.',
      activate(context) {
        context.registerProvider({
          id: 'desktop-workbench-model',
          name: '本地验收模型',
          model: 'fixture',
          async *stream({ messages, signal }) {
            const prompt = messages.findLast(message => message.role === 'user')?.content
            if (prompt === '等待批准配置' && messages.at(-1)?.role !== 'tool') {
              yield {
                type: 'tool-call',
                call: { id: randomUUID(), name: 'write_file', arguments: { path: 'settings.ts', content: 'export const keep = true\n' } },
              }
              yield { type: 'finish', reason: 'tool-calls' }
              return
            }
            if (prompt === '准备发布记录') {
              yield { type: 'reasoning', text: '正在整理发布记录。' }
              await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
              return
            }
            yield { type: 'text', text: '这份长记录在布局和空间之间保持阅读位置。\n\n'.repeat(60) }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    const host = await startTestHost({ demo: false, providerId: 'desktop-workbench-model', plugins: [plugin], hostName: '验收电脑' })
    let app: ElectronApplication | undefined
    try {
      await mkdir(OUT, { recursive: true })
      const owner = await host.enroll({ listener: 'unix' })
      const folder = join(host.root, 'desktop-project')
      await mkdir(folder)
      await writeFile(join(folder, 'settings.ts'), 'export const keep = false\n')
      const added = await owner.addFolders({ name: '桌面项目', paths: [folder] })
      const { workspace } = (await added.json()) as { workspace: WorkspaceInfo }
      await owner.confirmedJson('agents', {
        method: 'POST',
        body: { id: 'desktop-switch-agent', name: '本地Agent夹具', command: process.execPath, args: [FAKE_ACP_AGENT] },
      })
      for (const name of ['审阅搭档', '发布搭档'])
        await owner.json('custom-agents', {
          method: 'POST',
          body: {
            requestId: randomUUID(),
            name,
            description: '协作完成项目任务',
            harnessId: 'desktop-switch-agent',
            mode: 'agent',
            defaultProjectId: workspace.id,
          },
        })
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
      app = await _electron.launch({
        args: [
          resolve('apps/desktop/src/main.cjs'),
          `--latch-host-state=${join(host.dataDir, 'host.json')}`,
          `--latch-user-data=${join(root, 'electron')}`,
          '--use-mock-keychain',
        ],
        cwd: process.cwd(),
        env: Object.fromEntries(
          Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
        recordVideo: { dir: `${OUT}/recording`, size: { width: 1440, height: 1000 } },
        timeout: 30_000,
      })
      const page = await app.firstWindow()
      expect(page.url()).toBe('latch://app/link/')
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]!
        window.setMinimumSize(320, 400)
        window.setSize(1440, 1000)
      })
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference' })
      await page.getByRole('button', { name: '继续', exact: true }).click()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      const home = page.locator('.workbench-home')
      await home.getByRole('button', { name: /^Harness：/u }).click()
      await page.getByRole('menuitemradio', { name: /Latch.*内置/u }).click()
      await home.getByRole('button', { name: /^项目：/u }).click()
      await page.getByRole('menuitemradio', { name: '桌面项目', exact: true }).click()
      await home.getByRole('textbox', { name: '新会话消息', exact: true }).fill('准备桌面阅读记录')
      await home.getByRole('button', { name: '发送', exact: true }).click()
      await expect.poll(async () => (await host.host.bridge.listTasks())[0]?.status).toBe('idle')
      const input = page.locator('.workspace textarea').first()
      await input.fill('原会话草稿')
      const sender = await input.elementHandle(),
        transcript = page.locator('.transcript').first()
      const bottom = await transcript.evaluate(element => element.scrollTop)
      await transcript.hover()
      await page.mouse.wheel(0, -1000)
      await expect.poll(() => transcript.evaluate(element => element.scrollTop)).toBeLessThan(bottom)
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      const reading = await transcript.evaluate(element => element.scrollTop)
      for (const prompt of ['等待批准配置', '准备发布记录']) {
        const started = await owner.json<{ sessionId: string }>('tasks', {
          method: 'POST',
          body: {
            requestId: randomUUID(),
            prompt,
            workspaceId: workspace.id,
            model: { providerId: 'desktop-workbench-model', model: 'fixture' },
          },
        })
        await expect
          .poll(async () => (await owner.json<TaskDetail>(`tasks/${started.sessionId}`)).summary.status)
          .toBe(prompt === '等待批准配置' ? 'waiting-approval' : 'running')
      }
      await page.getByRole('button', { name: '总览', exact: true }).locator('visible=true').first().click()
      await home.locator('.approval-panel').waitFor()
      const draft = home.getByRole('textbox', { name: '新会话消息', exact: true })
      await draft.fill('首页独立草稿')
      await home
        .getByLabel('选择附件', { exact: true })
        .setInputFiles({ name: 'desktop.txt', mimeType: 'text/plain', buffer: Buffer.from('desktop draft attachment') })
      await expect.poll(() => home.getByRole('button', { name: 'desktop.txt', exact: true }).isEnabled()).toBe(true)
      const metrics = []
      for (const [name, target] of [
        ['a-to-b', '分拣台'],
        ['b-to-a', '总览'],
      ] as const) {
        await page.getByRole('button', { name: '布局', exact: true }).locator('visible=true').first().click()
        metrics.push(
          await measureWorkbenchSwitch(page, OUT, name, () => page.getByRole('menuitemradio', { name: target, exact: true }).click()),
        )
        expect(await sender!.evaluate(element => element.isConnected)).toBe(true)
        expect(await input.inputValue()).toBe('原会话草稿')
        expect(await transcript.evaluate(element => element.scrollTop)).toBe(reading)
      }
      metrics.push(
        await measureWorkbenchSwitch(page, OUT, 'code-to-agent', () =>
          page.getByRole('radio', { name: '我的 Agent', exact: true }).locator('visible=true').first().click(),
        ),
      )
      expect(await page.locator('.agents-page').textContent()).toContain('审阅搭档')
      metrics.push(
        await measureWorkbenchSwitch(page, OUT, 'agent-to-code', () =>
          page.getByRole('radio', { name: 'Code', exact: true }).locator('visible=true').first().click(),
        ),
      )
      expect(await draft.inputValue()).toBe('首页独立草稿')
      expect(await home.getByRole('button', { name: 'desktop.txt', exact: true }).isEnabled()).toBe(true)
      expect(await sender!.evaluate(element => element.isConnected)).toBe(true)
      expect(await transcript.evaluate(element => element.scrollTop)).toBe(reading)
      expect(await host.host.bridge.listTasks()).toHaveLength(3)
      await writeFile(`${OUT}/frames.json`, JSON.stringify({ entry: 'latch://app/link/', metrics }, null, 2))
      const video = page.video()
      await app.close()
      app = undefined
      await video?.saveAs(`${OUT}/switches.webm`)
    } finally {
      for (const task of await host.host.bridge.listTasks())
        if (task.status === 'running' || task.status === 'waiting-approval') await host.host.bridge.cancel(task.id).catch(() => {})
      await app?.close()
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)
