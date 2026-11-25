import { _electron, type ElectronApplication } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
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
      const host = await startTestHost({
        demo: true,
        hostName: '工作电脑',
        presenceMode: 'manual',
        sessionFolders: false,
      })
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
        const chooseFile = async () => {
          const choosing = page.waitForEvent('filechooser')
          await page.locator('.settings-page').getByRole('button', { name: '导入文件…', exact: true }).click()
          return choosing
        }
        const importBundle = async (kind: 'skill' | 'react-ui', id: string) =>
          (await chooseFile()).setFiles({
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
        await settings.getByRole('button', { name: '导入文件…', exact: true }).waitFor()
        await settings.getByRole('button', { name: '添加插件…', exact: true }).waitFor()
        const editor = page.locator('dialog:is(.ui-dialog, .ui-sheet)').filter({ has: page.locator('.plugin-editor') })
        const applyReview = page.getByRole('dialog', { name: '审阅并应用插件', exact: true })
        const enableReview = page.getByRole('dialog', { name: '审阅并启用插件', exact: true })
        await settings.getByRole('button', { name: '新建工具', exact: true }).click()
        await editor.getByRole('textbox', { name: '插件名称' }).waitFor()
        await editor.getByRole('button', { name: '关闭', exact: true }).click()
        await importBundle('skill', 'my-plugin-skill')
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
        await editor.getByRole('button', { name: '保存并审阅', exact: true }).click()
        await applyReview.getByRole('button', { name: '确认安装', exact: true }).click()
        await editor.getByRole('button', { name: '重试同一请求', exact: true }).waitFor()
        await vi.waitFor(() => expect(currentSkillText()).toContain('先列证据'))
        await editor.getByRole('button', { name: '重试同一请求', exact: true }).click()
        await editor.getByText('已开启', { exact: true }).waitFor()
        const attempts = await page.evaluate((): string[] => Reflect.get(window, 'pluginApplyAttempts'))
        expect(attempts).toHaveLength(2)
        expect(attempts[1]).toBe(attempts[0])
        expect(host.presence.requests).toHaveLength(approvals)
        await editor.getByRole('textbox', { name: '工作方法', exact: true }).fill('# 研究方法\n先列证据，再给出可以检查的下一步。')
        await editor.getByRole('button', { name: '保存并审阅', exact: true }).click()
        await applyReview.getByRole('button', { name: '确认应用', exact: true }).click()
        await editor.getByText('已开启', { exact: true }).waitFor()
        expect(host.presence.requests).toHaveLength(approvals)
        await mkdir('test-results/plugin-editor', { recursive: true })
        for (const [width, theme] of [
          [1440, 'light'],
          [900, 'dark'],
        ] as const) {
          await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, 960), width)
          await page.emulateMedia({ colorScheme: theme })
          await reachable(editor.getByRole('button', { name: '保存并审阅', exact: true }))
          await noHorizontalOverflow(page, editor.locator('.plugin-editor'))
          await page.screenshot({ path: 'test-results/plugin-editor/editor-' + width + '-' + theme + '.png', animations: 'disabled' })
        }
        await editor.getByRole('switch', { name: '启用插件', exact: true }).click()
        await editor.getByText('未开启', { exact: true }).waitFor()
        expect(currentSkillText()).not.toContain('先列证据')
        await editor.getByRole('switch', { name: '启用插件', exact: true }).click()
        await enableReview.getByRole('button', { name: '确认启用', exact: true }).click()
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
        await enableReview.getByRole('button', { name: '确认启用', exact: true }).click()
        await expect.poll(() => pageSwitch.isChecked()).toBe(true)
        await backToSection(settings)
        await importBundle('react-ui', 'my-plugin-panel')
        await editor.getByRole('textbox', { name: '插件名称' }).fill('我的工作笔记')
        // The form says where a panel's code runs, which devices receive it and that nothing isolates it, before anything
        // is applied; the full sentence is the label's tooltip.
        await editor.getByRole('heading', { name: '代码在哪里运行', exact: true }).waitFor()
        const reach = editor.locator('.ui-hint', { hasText: '每台能看会话的设备，不隔离' })
        expect(await tooltipText(page, reach.locator('.ui-hint-label'))).toContain('代码会发到每台能查看会话的设备')
        await page.screenshot({ path: 'test-results/plugin-editor/panel-form.png', animations: 'disabled' })
        await editor.getByRole('button', { name: '保存并审阅', exact: true }).click()
        await applyReview.getByText('会话面板代码', { exact: true }).waitFor()
        expect(host.presence.requests).toHaveLength(approvals)
        expect(await applyReview.locator('.ui-dialog-surface').evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(
          'rgba(0, 0, 0, 0)',
        )
        await page.screenshot({ path: 'test-results/plugin-editor/panel-risk-review.png', animations: 'disabled' })
        await applyReview.getByRole('button', { name: '确认安装', exact: true }).click()
        const request = await host.presence.waitForRequest(15000)
        expect(request.preview.action).toBe('plugin.package.apply')
        host.presence.approveNext()
        await editor.getByText('已开启', { exact: true }).waitFor()
        expect(host.host.registry.uiPanels().some(panel => panel.title === '工作笔记' && panel.moduleHash)).toBe(true)
        await editor.getByRole('button', { name: '删除', exact: true }).click()
        await page.getByRole('button', { name: '删除插件', exact: true }).click()
        await editor.waitFor({ state: 'hidden' })
        expect(host.host.registry.uiPanels().some(panel => panel.title === '工作笔记')).toBe(false)

        // A marketplace TSX page gets the same Host build and sample preview as a session draft.
        const beforePage = host.presence.requests.length
        await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 860))
        await page.emulateMedia({ colorScheme: 'light' })
        await settings.getByRole('button', { name: '浏览插件市场', exact: true }).click()
        const market = page.getByRole('region', { name: '插件市场', exact: true })
        const listing = market.getByRole('button', { name: '发布检查记录', exact: true })
        await listing.waitFor()
        await settings.waitFor({ state: 'hidden' })
        await listing.click()
        const pageDialog = page.getByRole('dialog', { name: '发布检查记录', exact: true })
        const install = pageDialog.getByRole('button', { name: '审阅并安装', exact: true })
        await expect.poll(() => install.getAttribute('aria-disabled')).toBe(null)
        await install.click()
        // A page draft is reviewed in the dialog; its build and sample preview run in plugin settings.
        await pageDialog.locator('.creator-plugin-source').waitFor()
        await pageDialog.getByRole('button', { name: '在插件设置中构建', exact: true }).click()
        await pageDialog.waitFor({ state: 'hidden' })
        await settings.getByRole('button', { name: '编辑…', exact: true }).click()
        const files = editor.getByRole('group', { name: '插件文件', exact: true })
        const tsx = files.getByRole('button', { name: 'src/index.tsx', exact: true })
        const css = files.getByRole('button', { name: 'src/style.css', exact: true })
        const source = editor.getByRole('textbox', { name: 'src/index.tsx', exact: true })
        const highlight = editor.locator('.plugin-source-highlight')
        await tsx.click()
        expect(await tsx.getAttribute('aria-pressed')).toBe('true')
        expect(await css.getAttribute('aria-pressed')).toBe('false')
        const keyword = highlight
          .locator('.syn-keyword')
          .filter({ hasText: /^import$/u })
          .first()
        await keyword.waitFor()
        expect(await highlight.getAttribute('aria-hidden')).toBe('true')
        expect(await keyword.evaluate(element => getComputedStyle(element).color)).not.toBe(
          await highlight.evaluate(element => getComputedStyle(element).color),
        )
        const prefix = '//  发布前核对 <标签> & "说明"\n\n'
        const sourceText = prefix + (await source.inputValue())
        await source.focus()
        await source.evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(0, 0))
        await page.keyboard.insertText(prefix)
        await expect.poll(() => source.inputValue()).toBe(sourceText)
        await highlight.locator('.syn-comment').filter({ hasText: '发布前核对' }).waitFor()
        await css.click()
        expect(await css.getAttribute('aria-pressed')).toBe('true')
        expect(await tsx.getAttribute('aria-pressed')).toBe('false')
        expect(await editor.getByRole('textbox', { name: 'src/style.css', exact: true }).inputValue()).toContain('display: flex;')
        await highlight.locator('span:not(.syn-plain)').first().waitFor()
        expect(await highlight.textContent()).toContain('.rc {')
        expect(await keyword.count()).toBe(0)
        await tsx.click()
        expect(await source.inputValue()).toBe(sourceText)

        const desktop = application
        const resize = async (width: number, height: number) => {
          await desktop.evaluate(
            ({ BrowserWindow }, size) => {
              BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height)
            },
            { width, height },
          )
          await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
        }
        await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setMinimumSize(320, 560))
        const highlightScreenshots = 'test-results/plugin-editor'
        for (const [width, height] of [
          [390, 844],
          [768, 1024],
          [1440, 900],
        ] as const) {
          await resize(width, height)
          for (const theme of ['light', 'dark'] as const) {
            await page.emulateMedia({ colorScheme: theme })
            await noHorizontalOverflow(page, editor.locator('.plugin-editor'))
            await reachable(source)
            await page.screenshot({ path: `${highlightScreenshots}/files-${width}-${theme}.png`, animations: 'disabled' })
          }
        }
        await page.emulateMedia({ colorScheme: 'light' })
        await source.hover()
        await page.mouse.wheel(0, 180)
        await expect.poll(() => source.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
        const scrolled = await source.evaluate(element => element.scrollTop)
        await expect.poll(() => highlight.evaluate(element => element.scrollTop)).toBe(scrolled)
        const manifestTab = editor.getByRole('tab', { name: '高级声明', exact: true })
        await manifestTab.click()
        expect(await manifestTab.getAttribute('aria-selected')).toBe('true')
        const manifest = editor.getByRole('textbox', { name: '插件声明', exact: true })
        const priorDescription = '按项目的清单开一个检查会话，逐项记下结果与意见。'
        const description = '按项目核对发布准备工作，逐项记录结果。'
        const manifestText = await manifest.inputValue()
        expect(manifestText).toContain(priorDescription)
        await manifest.fill(manifestText.replace(priorDescription, description))
        await highlight.locator('.syn-string').filter({ hasText: description }).waitFor()
        await reachable(manifest)
        await manifest.evaluate(element => {
          element.scrollTop = 0
        })
        await page.screenshot({ path: `${highlightScreenshots}/manifest-1440-light.png`, animations: 'disabled' })
        await editor.getByRole('button', { name: '构建并预览', exact: true }).click()
        const card = settings.locator('.new-app-card').filter({ hasText: 'release-check' })
        await card.locator('iframe.app-frame').waitFor({ timeout: 90_000 })
        await card.frameLocator('iframe.app-frame').getByText('ledger-web').first().waitFor()
        expect(await card.getAttribute('data-phase')).toBe('preview')
        expect(host.presence.requests).toHaveLength(beforePage)
        await card.getByRole('button', { name: '应用', exact: true }).click()
        await applyReview.getByText('从 1.0.1 版修改的本地草稿', { exact: true }).waitFor()
        await applyReview.getByRole('button', { name: '确认安装', exact: true }).click()
        await expect.poll(() => host.presence.requests.length).toBe(beforePage + 1)
        expect(host.presence.requests.at(-1)?.preview.action).toBe('plugin.package.apply')
        host.presence.approveNext()
        await expect.poll(() => card.getAttribute('data-phase')).toBe('applied')
        const exported = join(directory, 'release-check.latch-plugin.json')
        await application.evaluate(({ BrowserWindow }, output) => {
          const session = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('latch://app/'))!.webContents
            .session
          const done = new Promise<string>(resolve => {
            const missing = setTimeout(() => resolve('no will-download'), 20_000)
            session.once('will-download', (_event, item) => {
              item.setSavePath(output)
              clearTimeout(missing)
              const waiting = setTimeout(() => resolve('no download settlement'), 20_000)
              item.once('done', (_doneEvent, state) => {
                clearTimeout(waiting)
                resolve(state)
              })
            })
          })
          Reflect.set(globalThis, 'releaseCheckDownload', done)
        }, exported)
        const exporting = page.waitForResponse(response =>
          new URL(response.url()).pathname.endsWith('/plugin-packages/release-check/export'),
        )
        await settings.getByRole('button', { name: '导出插件', exact: true }).click()
        expect((await exporting).status()).toBe(200)
        expect(await application.evaluate(() => Reflect.get(globalThis, 'releaseCheckDownload'))).toBe('completed')
        const exportedBundle: unknown = JSON.parse(await readFile(exported, 'utf8'))
        expect(exportedBundle).toEqual({
          manifest: expect.objectContaining({ formatVersion: 2, description }),
          files: expect.arrayContaining([expect.objectContaining({ path: 'src/index.tsx', content: sourceText })]),
        })
        await card.getByRole('button', { name: '打开', exact: true }).click()
        const live = page.frameLocator('.apps-page iframe.app-frame')
        await live.getByRole('heading', { name: '发布检查', exact: true }).waitFor()
        expect(await live.getByText('ledger-web', { exact: true }).count()).toBe(0)
        const reopened = await openSettings(page)
        await openSection(reopened, '插件')
        await (await chooseFile()).setFiles(exported)
        await editor.getByRole('button', { name: '构建并预览', exact: true }).waitFor()
        expect(await editor.getByRole('textbox', { name: '插件名称' }).inputValue()).toBe('发布检查记录')
      } finally {
        await application?.close()
        await host.close()
        await rm(directory, { recursive: true, force: true })
      }
    })
  },
)
