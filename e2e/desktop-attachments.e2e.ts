import { _electron, type ElectronApplication } from '@playwright/test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import type { HarnessPlugin } from '@latch/sdk'
import { latchEnv } from '@latch/host/env'
import { startTestHost } from './helpers/host.ts'

describe.skipIf(latchEnv(process.env, 'ELECTRON_E2E') !== '1' || process.platform !== 'darwin')('native desktop attachment stream', () => {
  it('uploads an image larger than JSON limit through the actual renderer and displays the private attachment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-attachment-'))
    let application: ElectronApplication | undefined,
      sentBytes = 0
    const plugin: HarnessPlugin = {
      id: 'electron-attachment',
      name: 'test',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerProvider({
          id: 'visual',
          name: 'Fixture',
          model: 'fixture',
          modelCapabilities: { fixture: { vision: true } },
          async *stream({ messages }) {
            const image = messages.flatMap(message => message.attachments ?? []).find(item => item.type === 'image')
            if (image?.type === 'image') sentBytes = Buffer.from(image.data, 'base64').length
            yield { type: 'text', text: '桌面附件已收到' }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    const fixture = await startTestHost({
      demo: false,
      plugins: [plugin],
      presenceMode: 'manual',
      uiDir: resolve(process.env.LATCH_E2E_UI_DIR ?? 'dist/web'),
    })
    try {
      const host = fixture.host
      await writeHostState(fixture.dataDir, {
        version: 2,
        pid: process.pid,
        hostId: host.hostId,
        instanceId: host.instanceId,
        socketPath: host.socketPath,
        loopbackOrigin: host.loopbackOrigin,
        tlsOrigin: host.tlsOrigin ?? null,
        startedAt: new Date().toISOString(),
        dataDir: fixture.dataDir,
      })
      application = await _electron.launch({
        args: [
          resolve('apps/desktop/src/main.cjs'),
          `--latch-host-state=${join(fixture.dataDir, 'host.json')}`,
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
      // The first connection on a Host with no enrolled device takes no confirmation.
      await page.getByRole('button', { name: '继续', exact: true }).click()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      expect(fixture.presence.requests).toHaveLength(0)
      const image = Buffer.concat([await page.screenshot({ animations: 'disabled' }), Buffer.alloc(2 * 1024 * 1024)])
      const composer = page.getByRole('region', { name: '总览', exact: true }).locator('form')
      await composer.getByLabel('选择附件').setInputFiles({ name: 'large.png', mimeType: 'image/png', buffer: image })
      await expect.poll(() => composer.getByRole('button', { name: 'large.png', exact: true }).isEnabled(), { timeout: 15000 }).toBe(true)
      await expect
        .poll(() => composer.locator('.attachment-draft img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
        .toBe(true)
      await composer.getByRole('button', { name: '发送', exact: true }).click()
      await page.getByText('桌面附件已收到', { exact: true }).waitFor()
      expect(sentBytes).toBe(image.length)
      await page
        .locator('.message-user')
        .getByRole('button', { name: /^large.png/ })
        .click()
      const preview = page.getByRole('region', { name: '文件预览', exact: true })
      await expect.poll(() => preview.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)
      expect(page.url()).toBe('latch://app/link/')
      await mkdir('test-results/attachments', { recursive: true })
      await page.screenshot({ path: 'test-results/attachments/electron-private-image.png', animations: 'disabled' })
    } finally {
      await application?.close()
      await fixture.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
