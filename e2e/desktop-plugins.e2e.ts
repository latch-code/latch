import { _electron, type ElectronApplication } from '@playwright/test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createPluginPackageTemplate } from '@latch/protocol'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { writeHostState } from '@latch/host/host-state'
import { latchEnv } from '@latch/host/env'
import { startTestHost } from './helpers/host.ts'
import { backToSection, noHorizontalOverflow, openSection, openSettings, reachable, tooltipText } from './helpers/layout.ts'

describe.skipIf(latchEnv(process.env, 'ELECTRON_E2E') !== '1' || process.platform !== 'darwin')(
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
        // The file picker of 导入文件…, filled the way a person choosing a file would.
        const importBundle = (kind: 'skill' | 'react-ui', id: string) =>
          page.locator('input[type="file"][accept=".json,application/json"]').setInputFiles({
            name: `${id}.latch-plugin.json`,
            mimeType: 'application/json',
            buffer: Buffer.from(JSON.stringify(createPluginPackageTemplate(kind, id))),
          })
        // The first connection on a Host with no enrolled device takes no confirmation.
        await page.getByRole('button', { name: '继续', exact: true }).click()
        await page.locator('.app-shell[data-connection="connected"]').waitFor()
        expect(host.presence.requests).toHaveLength(0)
        const settings = await openSettings(page)
        await openSection(settings, '插件')
        // 添加插件 starts in one of two ways: a new tool, or a plugin file. Skills and panels come from files.
        await page.getByRole('button', { name: '添加插件…', exact: true }).click()
        const adding = page.getByRole('dialog', { name: '添加插件', exact: true })
        await adding.getByRole('button', { name: '新建工具', exact: true }).waitFor()
        await adding.getByRole('button', { name: '导入文件…', exact: true }).waitFor()
        expect(await adding.getByRole('radio').count()).toBe(0)
        await importBundle('skill', 'my-plugin-skill')
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
        await editor.getByText('已开启', { exact: true }).waitFor()
        const attempts = await page.evaluate((): string[] => Reflect.get(window, 'pluginApplyAttempts'))
        expect(attempts).toHaveLength(2)
        expect(attempts[1]).toBe(attempts[0])
        expect(host.presence.requests).toHaveLength(approvals)
        await editor.getByRole('textbox', { name: '工作方法', exact: true }).fill('# 研究方法\n先列证据，再给出可以检查的下一步。')
        await editor.getByRole('button', { name: '保存并应用', exact: true }).click()
        await editor.getByText('已开启', { exact: true }).waitFor()
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
        await editor.getByText('未开启', { exact: true }).waitFor()
        expect(currentSkillText()).not.toContain('先列证据')
        await editor.getByRole('switch', { name: '启用插件', exact: true }).click()
        await editor.getByText('已开启', { exact: true }).waitFor()
        await editor.getByRole('button', { name: '关闭', exact: true }).click()
        // The plugin's own page takes it back without opening the editor.
        await page.locator('.plugin-nav-row', { hasText: '我的研究方法' }).click()
        const pageSwitch = page.getByRole('switch', { name: '启用 我的研究方法', exact: true })
        await pageSwitch.click()
        await expect.poll(() => pageSwitch.isChecked()).toBe(false)
        expect(currentSkillText()).not.toContain('先列证据')
        expect(await editor.isVisible()).toBe(false)
        await pageSwitch.click()
        await expect.poll(() => pageSwitch.isChecked()).toBe(true)
        await backToSection(settings)
        await page.getByRole('button', { name: '添加插件…', exact: true }).click()
        await importBundle('react-ui', 'my-plugin-panel')
        await editor.getByRole('textbox', { name: '插件名称' }).fill('我的工作笔记')
        // The form says where a panel's code runs, which devices receive it and that nothing isolates it, before anything
        // is applied; the full sentence is the label's tooltip.
        await editor.getByRole('heading', { name: '代码在哪里运行', exact: true }).waitFor()
        const reach = editor.locator('.ui-hint', { hasText: '每台能看会话的设备，不隔离' })
        expect(await tooltipText(page, reach.locator('.ui-hint-label'))).toContain('代码会发到每台能查看会话的设备')
        await page.screenshot({ path: 'test-results/plugin-editor/panel-form.png', animations: 'disabled' })
        await editor.getByRole('button', { name: '保存并应用', exact: true }).click()
        const request = await host.presence.waitForRequest(15000)
        expect(request.preview.action).toBe('plugin.package.apply')
        host.presence.approveNext()
        await editor.getByText('已开启', { exact: true }).waitFor()
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
