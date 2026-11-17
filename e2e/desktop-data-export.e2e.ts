import { _electron, type ElectronApplication } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { writeHostState } from '@latch/host/host-state'
import { startTestHost } from './helpers/host.ts'
import { openSection, openSettings } from './helpers/layout.ts'

const OUT = 'test-results/desktop-data-export'

describe.skipIf(latchEnv(process.env, 'ELECTRON_E2E') !== '1' || process.platform !== 'darwin')('导出全部 in the desktop app', () => {
  it('page → main → the open panel → the Host → progress → files; Finder shows the data directory main read', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-electron-export-')))
    const parent = join(root, 'exports')
    await mkdir(parent)
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
      await page.reload()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      // Something of the person's own to export.
      await page.evaluate(
        async requestId =>
          fetch('/link/api/custom-agents/general/memories', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ requestId, content: '导出里要有这条记忆' }),
          }).then(response => response.status),
        randomUUID(),
      )
      // The open panel answers with the folder chosen and Finder is recorded instead of shown.
      await application.evaluate(({ BrowserWindow, dialog, shell }, chosen) => {
        const panels: unknown[] = []
        const shown: string[] = []
        Object.assign(globalThis, { exportPanels: panels, finderShown: shown })
        dialog.showOpenDialog = async (...args: unknown[]) => {
          panels.push(args.at(-1))
          return { canceled: false, filePaths: [chosen] }
        }
        shell.showItemInFolder = (path: string) => {
          shown.push(path)
        }
        BrowserWindow.prototype.isFocused = () => true
      }, parent)

      const settings = await openSettings(page)
      await openSection(settings, '数据')
      await settings.getByRole('button', { name: '在访达中显示', exact: true }).click()
      await expect
        .poll(() => application!.evaluate(() => Reflect.get(globalThis, 'finderShown') as string[]))
        .toEqual([await realpath(testHost.dataDir)])

      await settings.getByRole('button', { name: '导出…', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '导出全部' })
      await dialog.getByText('模型密钥、MCP 服务器与它们的秘密值、Harness 的环境变量：里面可以有密钥').waitFor()
      await page.screenshot({ path: join(OUT, 'export-dialog.png'), animations: 'disabled' })
      await dialog.getByRole('button', { name: '选择位置…', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      await settings.locator('.data-export').getByText('已导出').waitFor({ timeout: 30_000 })
      await page.screenshot({ path: join(OUT, 'exported.png'), animations: 'disabled' })
      const panels = await application.evaluate(() => Reflect.get(globalThis, 'exportPanels') as Array<{ title?: string }>)
      expect(panels).toEqual([expect.objectContaining({ title: '导出到' })])
      const [made] = await readdir(parent)
      expect(made).toMatch(/^Latch 导出 /u)
      const memory = await readFile(join(parent, made!, 'memory', 'general.json'), 'utf8')
      expect(memory).toContain('导出里要有这条记忆')
      expect(existsSync(join(parent, made!, 'manifest.json'))).toBe(true)
      expect(existsSync(join(parent, made!, 'settings.json'))).toBe(true)
      expect(host.security.audit.lastOf('data.export.result')).toMatchObject({ detail: { outcome: 'done' } })
    } finally {
      await application?.close()
      await testHost.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 180_000)
})
