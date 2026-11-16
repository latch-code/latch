import { _electron, type ElectronApplication } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { createOfflineTicket } from '@latch/host/auth'
import {
  desktopLaunchOptions,
  desktopShellEnvironment,
  ensureDesktopHost,
  probeDesktopHost,
  REBUILT_NOTICE,
} from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { defaultPolicy } from '@latch/host/policy'

const run = promisify(execFile)

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Neither the developer's Host settings nor runner switches (LATCH_ELECTRON_E2E, LATCH_BROWSER_PATH) reach the Host. */
function hostEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of Object.keys(env)) if (/^(?:LATCH|HARNESS)_/u.test(name)) delete env[name]
  return env
}

describe.skipIf(latchEnv(process.env, 'ELECTRON_E2E') !== '1' || process.platform !== 'darwin')('desktop launch after a rebuild', () => {
  it('restarts the idle Host started from the older build before the window opens, with no forwarding error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-rebuild-'))
    const dataDir = join(root, 'data')
    await mkdir(dataDir, { mode: 0o700 })
    await mkdir(join(root, 'home'), { mode: 0o700 })
    // No local confirmation: the shell connects with an offline code, and nothing opens a confirmation window.
    await writeFile(
      join(dataDir, 'policy.json'),
      JSON.stringify({ ...defaultPolicy(process.platform), presence: { backend: 'none', helperCdhash: null } }),
      { mode: 0o600 },
    )
    const options = desktopLaunchOptions(
      ['--data-dir', dataDir, '--demo', '--port', '0', '--workspace', join(root, 'workspace')],
      process.cwd(),
      // A home and PATH of its own: the Host finds none of this Mac's Agent CLIs or their settings.
      { ...hostEnvironment(), HOME: join(root, 'home'), PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    )
    const started: number[] = []
    let application: ElectronApplication | undefined
    try {
      // `pnpm desktop` earlier: a Host from dist/start.js, left running.
      const first = await ensureDesktopHost(options)
      started.push(first.pid)
      expect(first.reused).toBe(false)

      // The owner rebuilds while it runs.
      await run('pnpm', ['build:web'], { cwd: process.cwd(), env: hostEnvironment(), maxBuffer: 16 * 1024 * 1024 })
      expect(alive(first.pid)).toBe(true)

      // `pnpm desktop` again: the launcher restarts it before the shell opens, and says so in one line.
      const host = await ensureDesktopHost(options)
      started.push(host.pid)
      expect(host.reused).toBe(false)
      expect(host.notice).toBe(REBUILT_NOTICE)
      expect(host.pid).not.toBe(first.pid)
      expect(alive(first.pid)).toBe(false)
      // Launching again without a rebuild reuses it: the Host's build and the launcher's agree for a real dist/start.js.
      const again = await ensureDesktopHost(options)
      expect(again).toMatchObject({ pid: host.pid, reused: true })
      expect(again.notice).not.toContain('检测到新的构建')

      const output: string[] = []
      application = await _electron.launch({
        args: [
          resolve('apps/desktop/src/main.cjs'),
          `--latch-host-state=${host.hostStatePath}`,
          `--latch-user-data=${join(root, 'electron')}`,
          '--use-mock-keychain',
        ],
        cwd: process.cwd(),
        env: Object.fromEntries(
          Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
        timeout: 30_000,
      })
      application.process().stdout?.on('data', chunk => output.push(String(chunk)))
      application.process().stderr?.on('data', chunk => output.push(String(chunk)))
      const page = await application.firstWindow()
      page.setDefaultTimeout(20_000)
      await page.getByRole('textbox', { name: '设备名称', exact: true }).fill('重建后的桌面端')
      const { code } = await createOfflineTicket(join(dataDir, 'auth'))
      await page.getByLabel('离线连接码', { exact: true }).fill(code)
      await page.getByRole('button', { name: '使用离线连接码', exact: true }).click()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      // The window works against the new Host: it reports the page's own build, so no 「还是旧版本」.
      await page.getByRole('button', { name: '新会话' }).first().waitFor()
      expect(await page.getByText('还是旧版本').count()).toBe(0)
      expect(await probeDesktopHost(dataDir, 2_000, host.pid)).toBeDefined()
      expect(output.join('')).not.toContain('转发请求失败')
    } finally {
      await application?.close()
      // Only the Hosts this test started, after host.sock shows it is one of them.
      const live = await probeDesktopHost(dataDir)
      if (live && started.includes(live.pid)) {
        process.kill(live.pid, 'SIGTERM')
        await vi.waitFor(() => expect(alive(live.pid)).toBe(false), { timeout: 15_000 })
      }
      await rm(root, { recursive: true, force: true })
    }
  })
})
