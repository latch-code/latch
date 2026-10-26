import { _electron, type ElectronApplication } from '@playwright/test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { writeHostState } from '@latch/host/host-state'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSettings, reachable } from './helpers/layout.ts'

describe.skipIf(process.env.HARNESS_ELECTRON_E2E !== '1' || process.platform !== 'darwin')(
  'custom plugin editor in the native desktop',
  () => {
    it('saves inert skills, applies an exact revision, recovers a lost receipt and confirms new executable code once', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'latch-plugin-editor-'))
      const host = await startTestHost({ demo: true, uiDir: resolve('dist/web'), presenceMode: 'manual' })
      let application: ElectronApplication | undefined
      const currentSkillText = () => {
        const lease = host.host.registry.acquire('demo')
        try {
          return (lease.skills ?? []).map(skill => skill.content).join('\n')
        } finally {
          lease.release()
        }
      }
      try {
        await writeHostState(host.dataDir, {
          version: 2,
          pid: process.pid,
          hostId: host.host.hostId,
          instanceId: host.host.instanceId,
          socketPath: host.host.socketPath,
          loopbackOrigin: host.host.loopbackOrigin,
          tlsOrigin: host.host.tlsOrigin ?? null,
          startedAt: new Date().toISOString(),
          dataDir: host.dataDir,
        })
        application = await _electron.launch({
          args: [
            resolve('apps/desktop/src/main.cjs'),
            '--latch-host-state=' + join(host.dataDir, 'host.json'),
            '--latch-user-data=' + join(directory, 'electron'),
            '--use-mock-keychain',
          ],
          cwd: process.cwd(),
          env: Object.fromEntries(
            Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
          ),
        })
        const page = await application.firstWindow()
        page.setDefaultTimeout(20000)
        await page.getByRole('heading', { name: '连接到 Latch' }).waitFor()
        await page.getByRole('textbox', { name: '设备名称' }).fill('插件编辑验收')
        await page.getByRole('button', { name: '请求本机确认' }).click()
        await host.presence.waitForRequest(15000)
        host.presence.approveNext()
        await page.locator('.app-shell[data-connection="connected"]').waitFor()
        const settings = await openSettings(page)
        await settings.getByRole('tab', { name: '插件', exact: true }).click()
        await page.getByRole('button', { name: '创建插件', exact: true }).click()
        await page.getByRole('button', { name: '继续', exact: true }).click()
        const editor = page.locator('dialog.ui-dialog:has(> .ui-dialog-surface .plugin-editor)')
        await editor.getByRole('textbox', { name: '插件名称' }).fill('我的研究方法')
        await editor.getByRole('textbox', { name: '工作方法', exact: true }).fill('# 研究方法\n先列证据，再写结论。')
        await editor.getByRole('button', { name: '保存草稿', exact: true }).click()
        await editor.getByText('草稿', { exact: true }).waitFor()
        expect(host.host.registry.skills().some(skill => skill.name === '工作方法')).toBe(false)
        const approvals = host.presence.requests.length
        await page.evaluate(() => {
          const original = window.fetch.bind(window)
          const attempts: string[] = []
          Reflect.set(window, 'pluginApplyAttempts', attempts)
          let loseNext = true
          window.fetch = async (input, options) => {
            const response = await original(input, options)
            if (String(input).endsWith('/apply') && options?.method === 'POST') {
              attempts.push(String(options.body))
              if (loseNext) {
                loseNext = false
                throw new TypeError('Simulated lost response after delivery')
              }
            }
            return response
          }
        })
        await editor.getByRole('button', { name: '保存并应用', exact: true }).click()
        await editor.getByRole('button', { name: '重试同一请求', exact: true }).waitFor()
        await vi.waitFor(() => expect(currentSkillText()).toContain('先列证据'))
        await editor.getByRole('button', { name: '重试同一请求', exact: true }).click()
        await editor.getByText('已应用', { exact: true }).waitFor()
        const attempts = await page.evaluate((): string[] => Reflect.get(window, 'pluginApplyAttempts'))
        expect(attempts).toHaveLength(2)
        expect(attempts[1]).toBe(attempts[0])
        expect(host.presence.requests).toHaveLength(approvals)
        await editor.getByRole('textbox', { name: '工作方法', exact: true }).fill('# 研究方法\n先列证据，再给出可以检查的下一步。')
        await editor.getByRole('button', { name: '保存并应用', exact: true }).click()
        await editor.getByText('已应用', { exact: true }).waitFor()
        expect(host.presence.requests).toHaveLength(approvals)
        await mkdir('test-results/plugin-editor', { recursive: true })
        for (const [width, theme] of [
          [1440, 'light'],
          [900, 'dark'],
        ] as const) {
          await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, 960), width)
          await page.emulateMedia({ colorScheme: theme })
          await reachable(editor.getByRole('button', { name: '保存并应用', exact: true }))
          await noHorizontalOverflow(page, editor.locator('.plugin-editor'))
          await page.screenshot({ path: 'test-results/plugin-editor/editor-' + width + '-' + theme + '.png', animations: 'disabled' })
        }
        await editor.getByRole('switch', { name: '启用插件', exact: true }).click()
        await editor.getByText('已停用', { exact: true }).waitFor()
        expect(currentSkillText()).not.toContain('先列证据')
        await editor.getByRole('switch', { name: '启用插件', exact: true }).click()
        await editor.getByText('已应用', { exact: true }).waitFor()
        await editor.getByRole('button', { name: '关闭', exact: true }).click()
        await page.getByRole('button', { name: '创建插件', exact: true }).click()
        await page.getByRole('radio', { name: '界面', exact: true }).click()
        await page.getByRole('button', { name: '继续', exact: true }).click()
        await editor.getByRole('textbox', { name: '插件名称' }).fill('我的工作笔记')
        await editor.getByRole('button', { name: '保存并应用', exact: true }).click()
        const request = await host.presence.waitForRequest(15000)
        expect(request.preview.action).toBe('plugin.package.apply')
        host.presence.approveNext()
        await editor.getByText('已应用', { exact: true }).waitFor()
        expect(host.host.registry.uiPanels().some(panel => panel.title === '工作笔记' && panel.moduleHash)).toBe(true)
        await editor.getByRole('button', { name: '删除', exact: true }).click()
        await page.getByRole('button', { name: '删除插件', exact: true }).click()
        await editor.waitFor({ state: 'hidden' })
        expect(host.host.registry.uiPanels().some(panel => panel.title === '工作笔记')).toBe(false)
      } finally {
        await application?.close()
        await host.close()
        await rm(directory, { recursive: true, force: true })
      }
    })
  },
)
