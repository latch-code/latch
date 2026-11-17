import { _electron, type ElectronApplication } from '@playwright/test'
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { startTestHost } from './helpers/host.ts'
import { openSection, openSettings } from './helpers/layout.ts'
import { stillMotion } from './helpers/visual.ts'

describe.skipIf(process.env.LATCH_ELECTRON_E2E !== '1' || process.platform !== 'darwin')('desktop command link', () => {
  it('shows occupied, unlinked and linked states and creates only the requested temporary link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-desktop-cli-'))
    const home = join(root, 'home')
    const bin = join(home, '.local/bin')
    const target = join(root, 'latch')
    const output = process.env.LATCH_PACKAGE_SHOTS ?? resolve('test-results/desktop-cli')
    const appRoot = process.env.LATCH_PACKAGE_APP ? join(process.env.LATCH_PACKAGE_APP, 'Contents/Resources/app') : process.cwd()
    const host = await startTestHost({ hostName: '这台 Mac' })
    let application: ElectronApplication | undefined
    try {
      await mkdir(bin, { recursive: true })
      await mkdir(output, { recursive: true })
      await writeFile(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      await writeFile(join(bin, 'latch'), 'another command')
      await writeFile(join(home, '.zprofile'), 'unchanged')
      const bootstrap = join(root, 'bootstrap.cjs')
      await writeFile(
        bootstrap,
        `const links = require(${JSON.stringify(join(appRoot, 'apps/desktop/src/cli-link.cjs'))});
const create = links.createCliLink;
links.createCliLink = options => create({ ...options, available: true, home: ${JSON.stringify(home)}, path: '/usr/bin:/bin', target: ${JSON.stringify(target)} });
require(${JSON.stringify(join(appRoot, 'apps/desktop/src/main.cjs'))});\n`,
      )
      await writeHostState(host.dataDir, {
        version: 2,
        pid: process.pid,
        hostId: host.host.hostId,
        instanceId: host.host.instanceId,
        socketPath: host.host.socketPath,
        loopbackOrigin: host.host.loopbackOrigin,
        tlsOrigin: null,
        startedAt: host.host.startedAt,
        dataDir: host.dataDir,
      })
      application = await _electron.launch({
        args: [
          bootstrap,
          `--latch-host-state=${join(host.dataDir, 'host.json')}`,
          `--latch-user-data=${join(root, 'electron')}`,
          '--use-mock-keychain',
        ],
        cwd: root,
        env: Object.fromEntries(
          Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
        timeout: 30_000,
      })
      const page = await application.firstWindow()
      page.setDefaultTimeout(20_000)
      await stillMotion(page.context())
      await page.getByRole('button', { name: '继续', exact: true }).click()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      const capture = async (name: string) => {
        for (const width of [390, 768, 1440])
          for (const theme of ['light', 'dark'] as const) {
            await application!.evaluate(({ BrowserWindow }, width) => {
              const window = BrowserWindow.getAllWindows()[0]!
              window.setMinimumSize(320, 400)
              window.setSize(width, 900)
            }, width)
            await page.waitForFunction(width => innerWidth === width, width)
            await page.emulateMedia({ colorScheme: theme })
            await page.getByText('命令行', { exact: true }).scrollIntoViewIfNeeded()
            await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
            await page.screenshot({ path: join(output, `${name}-${width}-${theme}.png`), animations: 'disabled' })
          }
      }
      await openSection(await openSettings(page), '通用')
      await page.getByText('被其他命令占用', { exact: true }).waitFor()
      await capture('occupied')
      expect(await readFile(join(bin, 'latch'), 'utf8')).toBe('another command')
      await rm(join(bin, 'latch'))
      await page.reload()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      await openSection(await openSettings(page), '通用')
      await page.getByText('未链接', { exact: true }).waitFor()
      await capture('unlinked')
      // An IPC call with no fresh gesture cannot mutate the user's command directory.
      await page.reload()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      expect(await page.evaluate(() => window.latchShell!.cli!.install())).toBeUndefined()
      await openSection(await openSettings(page), '通用')
      await page.getByRole('button', { name: '链接 latch', exact: true }).click()
      await page.getByText('已链接', { exact: true }).waitFor()
      await capture('linked')
      expect(await readlink(join(bin, 'latch'))).toBe(target)
      expect(await readFile(join(home, '.zprofile'), 'utf8')).toBe('unchanged')
    } finally {
      await application?.close()
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
