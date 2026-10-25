import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { startTestHost } from './helpers/host.ts'
import { openSettings } from './helpers/layout.ts'
import { expectUnmovedByInjectedStyles } from './helpers/security.ts'

async function size(application: ElectronApplication, page: Page, width: number) {
  await application.evaluate(({ BrowserWindow }, next) => {
    const window = BrowserWindow.getAllWindows()[0]!
    window.setMinimumSize(320, 400)
    window.setSize(next, 900)
  }, width)
  await page.waitForFunction(next => innerWidth === next, width)
}
async function capture(page: Page, name: string) {
  // This helper is used only before an invitation exists. A generated pairing QR is a secret.
  expect(await page.getByAltText('原生客户端配对二维码').count()).toBe(0)
  await page.screenshot({ path: `test-results/native-phone/${name}.png`, animations: 'disabled' })
}

describe.skipIf(process.env.HARNESS_ELECTRON_E2E !== '1' || process.platform !== 'darwin')('native desktop phone settings', () => {
  it('configures through OS presence, displays bounded layouts, creates a native QR, and pauses inputs without confirmation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-native-phone-'))
    const host = await startTestHost({
      native: { host: '127.0.0.1', port: 0 },
      presenceMode: 'manual',
      hostName: '测试执行电脑',
      egressLookup: (_hostname, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]),
    })
    let application: ElectronApplication | undefined
    try {
      await mkdir('test-results/native-phone', { recursive: true })
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
          `--latch-host-state=${join(host.dataDir, 'host.json')}`,
          `--latch-user-data=${join(root, 'electron')}`,
          '--use-mock-keychain',
        ],
        cwd: process.cwd(),
        env: Object.fromEntries(
          Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
        timeout: 30000,
      })
      const page = await application.firstWindow()
      page.setDefaultTimeout(20000)
      await page.getByRole('heading', { name: '连接到 Latch' }).waitFor()
      await page.getByRole('textbox', { name: '设备名称' }).fill('手机连接测试桌面端')
      await page.getByRole('button', { name: '请求本机确认' }).click()
      expect((await host.presence.waitForRequest()).preview.action).toBe('device.enroll')
      host.presence.approveNext()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      await openSettings(page, '设备')
      await page.getByText('原生 App（开发预览）', { exact: true }).waitFor()
      await capture(page, 'ready-desktop')
      await page.getByRole('button', { name: '设置连接', exact: true }).click()
      await page.getByRole('button', { name: '添加自建中继', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '设置连接', exact: true })
      await dialog.getByRole('textbox', { name: '中继地址', exact: true }).fill('https://relay.example/')
      await dialog.getByRole('textbox', { name: '节点身份', exact: true }).fill('1'.repeat(32))
      await dialog.getByRole('textbox', { name: 'TLS 公钥指纹', exact: true }).fill('2'.repeat(64))
      for (const width of [1280, 820, 390]) {
        await size(application, page, width)
        for (const theme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme: theme })
          await page.waitForTimeout(300)
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          const geometry = await dialog.evaluate(element => {
            const box = element.getBoundingClientRect()
            return { left: box.left, right: box.right, width: innerWidth }
          })
          expect(geometry.left).toBeGreaterThanOrEqual(-1)
          expect(geometry.right).toBeLessThanOrEqual(geometry.width + 1)
          await capture(page, `config-${width}-${theme}`)
        }
      }
      await size(application, page, 1280)
      await page.emulateMedia({ colorScheme: 'light' })
      await dialog.getByRole('heading', { name: '设置连接', exact: true }).click()
      await expectUnmovedByInjectedStyles(page, [
        '.native-connect-dialog[open]',
        '.native-connect-dialog > .ui-modal-surface',
        '.native-connect-dialog form',
        '.native-config-group',
        '.native-config-heading',
        '.native-config-heading strong',
        '.native-connect-dialog .ui-field-label',
        '.native-connect-dialog .ui-input',
        '.native-config-body .settings-hint',
        '.native-connect-dialog .ui-modal-footer',
        '.native-connect-dialog .ui-button',
      ])
      await dialog.getByRole('textbox', { name: '节点身份', exact: true }).fill('invalid')
      await dialog.getByRole('button', { name: '保存连接', exact: true }).click()
      await dialog.getByRole('alert').waitFor()
      await capture(page, 'config-failed')
      await dialog.getByRole('textbox', { name: '节点身份', exact: true }).fill('1'.repeat(32))
      await dialog.getByRole('button', { name: '保存连接', exact: true }).click()
      const confirmation = await host.presence.waitForRequest()
      expect(confirmation.preview.subject?.form).toBe('policy.native-link')
      await page.getByText('等待 Touch ID…', { exact: true }).first().waitFor()
      await capture(page, 'config-waiting')
      host.presence.approveNext()
      await dialog.waitFor({ state: 'hidden' })
      await page.getByText('relay.example', { exact: true }).waitFor()
      const response = page.waitForResponse(
        value => value.url().endsWith('/link/api/native/pairings') && value.request().method() === 'POST',
      )
      await page.getByRole('button', { name: '生成配对二维码', exact: true }).click()
      const value = (await (await response).json()) as { invitation: { payload: string } }
      expect(value.invitation.payload.startsWith('LATCHPAIR1.')).toBe(true)
      await page.getByAltText('原生客户端配对二维码').waitFor()
      expect((await page.locator('body').innerText()).includes(value.invitation.payload)).toBe(false)
      const before = host.presence.requests.length
      await page.getByRole('button', { name: '暂停所有手机输入', exact: true }).click()
      await page.getByRole('button', { name: '恢复手机输入', exact: true }).waitFor()
      expect(host.host.security.devices.nativeInputsPaused()).toBe(true)
      expect(host.presence.requests.length).toBe(before)
      await page.getByRole('button', { name: '恢复手机输入', exact: true }).click()
      expect((await host.presence.waitForRequest()).preview.subject?.form).toBe('policy.native-input')
      host.presence.approveNext()
      await page.getByRole('button', { name: '暂停所有手机输入', exact: true }).waitFor()
      expect(host.host.security.devices.nativeInputsPaused()).toBe(false)
    } finally {
      await application?.close()
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
