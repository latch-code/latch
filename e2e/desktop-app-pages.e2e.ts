import { _electron, type ElectronApplication, type Frame } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PluginPackageDetail } from '@latch/protocol'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { startTestHost } from './helpers/host.ts'

/** A prebuilt page that asks for what the frame must never get, and writes what happened. */
const PAGE = String.raw`
const { createElement: h, useEffect, useState } = globalThis.__latchModules.react
const { defineApp } = globalThis.__latchModules['@latch/app-sdk']
const attempt = async (name, run) => {
  try {
    const value = await run()
    return name + ':' + String(value)
  } catch {
    return name + ':blocked'
  }
}
function Page() {
  const [probes, setProbes] = useState('')
  useEffect(() => {
    void (async () => {
      const lines = [
        'shell:' + typeof globalThis.latchShell,
        await attempt('camera', () => navigator.mediaDevices.getUserMedia({ video: true }).then(() => 'granted')),
        await attempt('notification', () => Notification.requestPermission()),
        await attempt('geolocation', () => new Promise((done, fail) => navigator.geolocation.getCurrentPosition(() => done('granted'), fail))),
        await attempt('fetch', () => fetch('latch://app/link/api/snapshot').then(response => response.status)),
        'rtc:' + Object.getOwnPropertyNames(globalThis).filter(name => /RTC|WebTransport|MediaStream/.test(name)).join(','),
        await attempt('peer', async () => {
          const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:__UDP__' }, { urls: 'turn:127.0.0.1:__UDP__?transport=udp', username: 'SECRET-DATA', credential: 'x' }] })
          pc.createDataChannel('x')
          await pc.setLocalDescription(await pc.createOffer())
          return 'made'
        }),
      ]
      setProbes(lines.join('\n'))
    })()
  }, [])
  return h('div', null, h('pre', { id: 'probes' }, probes), h('p', { id: 'origin' }, String(self.origin)))
}
export default defineApp({ page: Page })
`

const electronE2E = latchEnv(process.env, 'ELECTRON_E2E') === '1'

describe.skipIf(!electronE2E || process.platform !== 'darwin')('native desktop shell: plugin page frames', () => {
  it('serves latch-frame://app/ with the fixed policy, refuses permissions and navigation, and keeps latchShell out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-apps-'))
    const testHost = await startTestHost({ uiDir: resolve('dist/web') })
    const { host } = testHost
    let application: ElectronApplication | undefined
    // A local UDP listener a page's STUN/TURN would reach: it must hear nothing.
    const udp = createSocket('udp4')
    const packets: number[] = []
    udp.on('message', message => packets.push(message.length))
    await new Promise<void>(done => udp.bind(0, '127.0.0.1', done))
    try {
      const owner = await testHost.enroll({ listener: 'unix' })
      const bundle = {
        manifest: {
          formatVersion: 2,
          id: 'desktop-frame',
          name: '桌面框检查',
          version: '1.0.0',
          description: '',
          requires: { appSdk: '^1' },
          apps: [{ id: 'main', title: '桌面框', entry: 'page.js', dataVersion: 1, capabilities: { 'tasks.read': true } }],
        },
        files: [{ path: 'page.js', content: PAGE.replaceAll('__UDP__', String(udp.address().port)) }],
      }
      const draft = (await owner.json<{ package: PluginPackageDetail }>('plugin-packages', { body: { requestId: randomUUID(), bundle } }))
        .package
      expect(
        (await owner.confirmed('plugin-packages/desktop-frame/apply', { body: { requestId: randomUUID(), revision: draft.revision } }))
          .status,
      ).toBe(200)
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
      await mkdir('test-results', { recursive: true })
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
      const connect = page.getByRole('button', { name: '继续', exact: true })
      const connected = page.locator('.app-shell[data-connection="connected"]')
      await connect.or(connected).first().waitFor()
      if (await connect.isVisible()) await connect.click()
      await connected.waitFor()
      await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '应用', exact: true }).click()
      await page.locator('.sidebar-apps').getByRole('button', { name: '桌面框' }).click()
      const iframe = page.locator('iframe.app-frame')
      await iframe.waitFor()
      expect(await iframe.getAttribute('src')).toMatch(/^latch-frame:\/\/app\/runtime\.html#nonce=[a-f0-9]{32}$/u)
      let frame: Frame | null = null
      await expect
        .poll(
          async () => {
            frame = (await (await iframe.elementHandle())?.contentFrame()) ?? null
            return frame ? frame.locator('#probes').textContent() : ''
          },
          { timeout: 20_000 },
        )
        .toMatch(/fetch:/u)
      const probes = (await frame!.locator('#probes').textContent())!.split('\n')
      expect(probes[0]).toBe('shell:undefined')
      expect(probes.slice(1)).toEqual([
        'camera:blocked',
        'notification:denied',
        'geolocation:blocked',
        'fetch:blocked',
        'rtc:',
        'peer:blocked',
      ])
      await new Promise(done => setTimeout(done, 1_500))
      expect(packets).toEqual([])
      // The shell's own web contents keep WebRTC off non-proxied UDP as well.
      expect(
        await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getWebRTCIPHandlingPolicy()),
      ).toBe('disable_non_proxied_udp')
      expect(await frame!.locator('#origin').textContent()).toBe('null')
      await page.screenshot({ path: 'test-results/desktop-app-page.png', animations: 'disabled' })

      // The runtime's own address carries the fixed policy and nothing of the shell (seen as the page reloads it).
      const served = page.waitForResponse(response => response.url().startsWith('latch-frame://app/runtime.html'))
      await page.getByRole('button', { name: '页面操作' }).click()
      await page.getByRole('menuitem', { name: '重新加载' }).click()
      const headers = (await served).headers()
      const csp = headers['content-security-policy'] ?? ''
      expect(csp).toMatch(/^sandbox allow-scripts; default-src 'none'; script-src 'sha256-[A-Za-z0-9+/]{43}=' blob:;/u)
      expect(csp).toContain("connect-src 'none'")
      expect(csp).toContain('frame-ancestors latch://app')
      expect(headers['set-cookie']).toBeUndefined()
      await expect
        .poll(
          async () => {
            frame = (await (await iframe.elementHandle())?.contentFrame()) ?? null
            return frame ? frame.locator('#probes').textContent() : ''
          },
          { timeout: 20_000 },
        )
        .toMatch(/fetch:/u)

      // The frame cannot navigate itself, not even back to the runtime or to another fixed bootstrap; the shell's page and
      // the frame's address stay where they were, and nothing of the shell ever loads inside the frame.
      const shellUrl = page.url()
      for (const target of ['latch-frame://app/runtime.html', 'latch-frame://preview/office.html', 'latch://app/link/']) {
        const current = (await (await iframe.elementHandle())?.contentFrame())!
        await current
          .evaluate(url => {
            location.href = url
          }, target)
          .catch(() => {})
        await new Promise(done => setTimeout(done, 700))
        const now = (await (await iframe.elementHandle())?.contentFrame())!
        expect(now.url()).toMatch(/^latch-frame:\/\/app\/runtime\.html#nonce=[a-f0-9]{32}$/u)
        expect(await now.locator('.app-shell, .preview-document, main#document').count()).toBe(0)
      }
      expect(page.url()).toBe(shellUrl)
    } finally {
      await application?.close()
      udp.close()
      await testHost.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
