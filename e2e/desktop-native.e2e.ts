import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto'
import { connect } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { createTransportCertificate, openNativeHttp } from '@latch/link-client'
import { invitationCode, parsePairingPayload } from '@latch/link-wire'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
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
  // This helper is used only while no QR is on screen. A generated pairing QR is a secret.
  expect(await page.getByAltText('原生客户端配对二维码').count()).toBe(0)
  await page.screenshot({ path: `test-results/native-phone/${name}.png`, animations: 'disabled' })
}

describe.skipIf(latchEnv(process.env, 'ELECTRON_E2E') !== '1' || process.platform !== 'darwin')('native desktop phone settings', () => {
  it('shows phone access in bounded layouts, issues a QR that dies with its panel, and leaves nothing to configure', async () => {
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
      // The first connection on a Mac with no enrolled device takes no confirmation.
      await page.getByRole('button', { name: '继续', exact: true }).click()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      expect(host.presence.requests).toHaveLength(0)
      await openSettings(page, '设备')
      await capture(page, 'ready-desktop')
      await page.locator('.device-connect').waitFor()
      for (const text of ['设置连接', '暂停所有手机输入', '使用个人助手和项目文件', '浏览器配对', '发送到其他设备', '防火墙'])
        expect(await page.getByText(text, { exact: false }).count()).toBe(0)
      for (const width of [1280, 820, 390])
        for (const theme of ['light', 'dark'] as const) {
          await size(application, page, width)
          await page.emulateMedia({ colorScheme: theme })
          await page.waitForTimeout(300)
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          await capture(page, `ready-${width}-${theme}`)
        }
      await size(application, page, 1280)
      await page.emulateMedia({ colorScheme: 'light' })
      const response = page.waitForResponse(
        value => value.url().endsWith('/link/api/native/pairings') && value.request().method() === 'POST',
      )
      await page.locator('.device-connect').click()
      const issued = await response
      expect(issued.request().postDataJSON()).toEqual({})
      const value = (await issued.json()) as { invitation: { id: string; payload: string } }
      expect(value.invitation.payload.startsWith('LATCHPAIR2.')).toBe(true)
      expect(Object.keys(value.invitation)).not.toContain('dataScope')
      await page.getByAltText('原生客户端配对二维码').waitFor()
      const body = await page.locator('body').innerText()
      expect(body.includes(value.invitation.payload)).toBe(false)
      for (const text of ['六位', '核对码', '剩余', '复制配对信息', '重新生成']) expect(body.includes(text)).toBe(false)
      const before = host.presence.requests.length
      expect(host.host.security.enrollments.nativePairingStatus(value.invitation.id).state).toBe('ready')
      await expectUnmovedByInjectedStyles(page, ['.pair-sheet .ui-modal-header h2', '.pair-foot-title', '.pair-foot-note'])
      await page.getByRole('button', { name: '关闭', exact: true }).click()
      await page.getByAltText('原生客户端配对二维码').waitFor({ state: 'hidden' })
      await expect.poll(() => host.host.security.enrollments.nativePairingOpen()).toBe(false)
      expect(host.presence.requests.length).toBe(before)
      // After Touch ID the panel asks about the phone in hand, with no way to close but an answer.
      const again = page.waitForResponse(value => value.url().endsWith('/link/api/native/pairings') && value.request().method() === 'POST')
      await page.locator('.device-connect').click()
      const { invitation } = (await (await again).json()) as { invitation: { payload: string } }
      const qr = parsePairingPayload(invitation.payload),
        code = invitationCode(qr.secret),
        socket = connect(host.host.nativePort!, '127.0.0.1')
      socket.on('error', () => {})
      const phone = await openNativeHttp(
        socket,
        { path: 'direct' },
        { rootSpki: qr.rootSpki, knockKey: createHash('sha256').update(code).digest(), pairing: true },
      )
      const device = createTransportCertificate(),
        verification = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      const created = await phone.request('POST', '/link/api/enrollments', {
        name: '陌生的手机',
        publicKey: device.spki.toString('base64url'),
        invitation: code,
        gatewayHash: '0'.repeat(64),
        native: {
          certificate: device.cert,
          verificationKey: verification.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
        },
      })
      expect(created.status).toBe(202)
      const { enrollment } = created.body as { enrollment: { id: string; nonce: string } }
      await host.presence.waitForRequest()
      host.presence.approveNext()
      await vi.waitFor(async () =>
        expect(
          ((await phone.request('GET', `/link/api/enrollments/${enrollment.id}`)).body as { enrollment: { status: string } }).enrollment
            .status,
        ).toBe('approved'),
      )
      const signature = sign('sha256', Buffer.from(`latch-enroll-v1\n${host.host.hostId}\n${enrollment.id}\n${enrollment.nonce}`), {
        key: createPrivateKey(device.key),
        dsaEncoding: 'ieee-p1363',
      }).toString('base64url')
      const completed = await phone.request('POST', `/link/api/enrollments/${enrollment.id}/complete`, { signature })
      expect(completed.status).toBe(200)
      phone.close()
      await page.getByText('手机上显示已连接了吗？', { exact: true }).waitFor()
      await page.getByAltText('原生客户端配对二维码').waitFor({ state: 'hidden' })
      expect(await page.getByRole('button', { name: '关闭', exact: true }).count()).toBe(0)
      await capture(page, 'pairing-ask')
      // Only an answer ends the question: Esc does nothing, however often it is pressed.
      for (let press = 0; press < 4; press++) {
        await page.keyboard.press('Escape')
        await page.waitForTimeout(100)
      }
      await page.getByText('手机上显示已连接了吗？', { exact: true }).waitFor()
      await page.waitForTimeout(300)
      expect(await page.getByText('手机上显示已连接了吗？', { exact: true }).isVisible()).toBe(true)
      const shownBefore = host.presence.requests.length
      await page.getByRole('button', { name: '没有，移除', exact: true }).click()
      await page.getByText('它已断开，之后要重新扫码才能连接。', { exact: true }).waitFor()
      await page.getByRole('button', { name: '好', exact: true }).click()
      await page.getByText('它已断开，之后要重新扫码才能连接。', { exact: true }).waitFor({ state: 'hidden' })
      expect(host.presence.requests.length).toBe(shownBefore)
      const id = (completed.body as { device: { id: string } }).device.id
      expect(host.host.security.devices.get(id)?.status).toBe('revoked')
    } finally {
      await application?.close()
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
