import { _electron, type ElectronApplication } from '@playwright/test'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { writeHostState } from '@latch/host/host-state'
import { startTestHost } from './helpers/host.ts'
import { closeSettings, openSection, openSettings } from './helpers/layout.ts'

const OUT = 'test-results/desktop-shortcuts'

describe.skipIf(latchEnv(process.env, 'ELECTRON_E2E') !== '1' || process.platform !== 'darwin')(
  'rebinding a shortcut in the desktop app',
  () => {
    it('records new keys, answers them, gives the menu bar the new keys for Code, and resets', async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-electron-shortcuts-')))
      const testHost = await startTestHost({ demo: true, uiDir: resolve('dist/web') })
      const { host } = testHost
      let application: ElectronApplication | undefined
      try {
        await writeHostState(testHost.dataDir, {
          version: 2,
          pid: process.pid,
          hostId: host.hostId,
          instanceId: host.instanceId,
          socketPath: host.socketPath,
          loopbackOrigin: host.loopbackOrigin,
          tlsOrigin: host.tlsOrigin ?? null,
          startedAt: new Date().toISOString(),
          dataDir: testHost.dataDir,
        })
        await mkdir(OUT, { recursive: true })
        application = await _electron.launch({
          args: [
            resolve('apps/desktop/src/main.cjs'),
            `--latch-host-state=${join(testHost.dataDir, 'host.json')}`,
            `--latch-user-data=${join(root, 'electron')}`,
            '--use-mock-keychain',
          ],
          cwd: process.cwd(),
          env: Object.fromEntries(
            Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
          ),
          timeout: 30_000,
        })
        const page = await application.firstWindow()
        page.setDefaultTimeout(20_000)
        await page.getByRole('button', { name: '继续', exact: true }).click()
        await page.locator('.app-shell[data-connection="connected"]').waitFor()
        const menuKeys = (id: string) =>
          application!.evaluate(({ Menu }, item) => Menu.getApplicationMenu()?.getMenuItemById(item)?.accelerator ?? null, id)
        expect(await menuKeys('space-code')).toBe('Shift+CmdOrCtrl+1')

        const settings = await openSettings(page)
        await openSection(settings, '快捷键')
        const record = async (label: string, keys: string, shown: string) => {
          const row = settings.locator('.shortcut-row', { hasText: label }).first()
          await row.getByRole('button', { name: `改「${label}」的快捷键`, exact: true }).click()
          await row.getByRole('status').getByText('按下新的组合键').waitFor()
          await page.keyboard.press(keys)
          await row.locator(`[data-keys="${shown}"]`).waitFor()
          return row
        }
        // The menu's own keys are refused by name; the row keeps recording until a key it may take.
        const row = settings.locator('.shortcut-row', { hasText: '快捷键' }).first()
        await row.getByRole('button', { name: '改「快捷键」的快捷键', exact: true }).click()
        await page.keyboard.press('Meta+KeyC')
        await row.getByText('菜单占用').waitFor()
        await page.screenshot({ path: join(OUT, 'recording-refused.png'), animations: 'disabled' })
        await page.keyboard.press('Meta+Alt+KeyY')
        await row.locator('[data-keys="⌥⌘Y"]').waitFor()
        // Code is a menu item: the page hands main its keys and main rebuilds the menu with them.
        await record('Code', 'Meta+Alt+KeyU', '⌥⌘U')
        await expect.poll(() => menuKeys('space-code')).toBe('Alt+CmdOrCtrl+U')
        await closeSettings(settings)

        // The new keys open 快捷键; ⌘/ no longer does.
        const overlay = page.getByRole('dialog', { name: '快捷键', exact: true })
        await page.keyboard.press('Meta+Alt+KeyY')
        await overlay.waitFor()
        await overlay.locator('[data-keys="⌥⌘Y"]').first().waitFor()
        await page.keyboard.press('Escape')
        await overlay.waitFor({ state: 'detached' })
        await page.keyboard.press('Meta+Slash')
        await page.waitForTimeout(300)
        expect(await overlay.count()).toBe(0)

        const again = await openSettings(page)
        await openSection(again, '快捷键')
        await again.getByRole('button', { name: '全部恢复默认', exact: true }).click()
        await again.locator('.shortcut-row', { hasText: '快捷键' }).first().locator('[data-keys="⌘/"]').waitFor()
        await expect.poll(() => menuKeys('space-code')).toBe('Shift+CmdOrCtrl+1')
      } finally {
        await application?.close()
        await testHost.close()
        await rm(root, { recursive: true, force: true })
      }
    }, 180_000)
  },
)
