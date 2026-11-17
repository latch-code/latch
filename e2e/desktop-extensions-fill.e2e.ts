import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { TaskDetail, TerminalListResponse } from '@latch/protocol'
import { FAKE_CODEX_APP_SERVER } from '@latch/testkit'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { startTestHost } from './helpers/host.ts'
import { openSection, openSettings } from './helpers/layout.ts'

const OUTPUT = 'test-results/desktop-extensions-fill'
const pause = (ms: number) => new Promise(done => setTimeout(done, ms))
/** A screen's text with its wrapped rows joined, so a long command reads as one line. */
const screenText = async (rows: ReturnType<Page['locator']>) => (await rows.innerText()).replace(/\n/gu, '')

const electronE2E = latchEnv(process.env, 'ELECTRON_E2E') === '1'

describe.skipIf(!electronE2E || process.platform !== 'darwin')('native desktop shell: 设置 › 扩展', () => {
  it('types a Harness’s own command into the terminal dialog and runs nothing until the person presses Enter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-extensions-'))
    const bin = join(root, 'bin')
    const program = join(bin, 'codex')
    await mkdir(bin)
    await writeFile(program, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_CODEX_APP_SERVER}' "$@"\n`)
    await chmod(program, 0o755)
    const log = join(root, 'codex.jsonl')
    const testHost = await startTestHost({
      demo: true,
      uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
      // zsh without startup files: bracketed paste is its own default, and no profile is read.
      terminal: { shell: { file: '/bin/zsh', argv: ['zsh', '-f'] } },
      commandDirectories: () => [bin],
      loginPrograms: name => (name === 'codex' ? program : undefined),
      detectPreset: preset => (preset.id === 'codex' ? { found: true, path: program } : { found: false }),
    })
    const { host } = testHost
    let application: ElectronApplication | undefined
    try {
      const owner = await testHost.enroll({ listener: 'unix', name: 'Owner' })
      await owner.confirmedJson('agents', {
        body: {
          id: 'codex',
          name: 'Codex',
          presetId: 'codex',
          command: 'codex',
          args: [],
          env: {
            FAKE_ACP_LOG: log,
            FAKE_CODEX_STATE: join(root, 'threads.json'),
            FAKE_CODEX_MCP: JSON.stringify([{ name: 'files', runtimeStatus: 'connected', tools: {}, authStatus: 'unsupported' }]),
          },
        },
      })
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { harnessId: 'codex', prompt: 'plan', requestId: randomUUID() },
      })
      await vi.waitFor(async () => expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle'), {
        timeout: 20_000,
      })
      await writeHostState(testHost.dataDir, {
        version: 2,
        pid: process.pid,
        hostId: host.hostId,
        instanceId: host.instanceId,
        socketPath: host.socketPath,
        loopbackOrigin: host.loopbackOrigin,
        tlsOrigin: null,
        startedAt: new Date().toISOString(),
        dataDir: testHost.dataDir,
      })
      await mkdir(OUTPUT, { recursive: true })
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
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900))
      await page.getByRole('button', { name: '继续', exact: true }).click()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()

      const settings = await openSettings(page)
      await openSection(settings, '扩展')
      await settings.getByRole('button', { name: /^Codex/u }).click()
      const mcp = settings.locator('[data-extensions-harness="codex"]').getByRole('region', { name: 'MCP', exact: true })
      const row = mcp.locator('[data-harness-mcp="files"]')
      await row.getByText('Harness 自带', { exact: true }).waitFor()
      await page.screenshot({ path: `${OUTPUT}/codex-1440.png`, animations: 'disabled' })

      // ---- 卸载 a listed server: exactly the vendor's command, typed in and not run ----
      const terminals = async () => (await owner.json<TerminalListResponse>('workspaces/default/terminals')).terminals
      await row.getByRole('button', { name: '在终端里打开', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '终端', exact: true })
      const rows = dialog.locator('.terminal-screen:not([hidden]) .xterm-rows')
      await expect.poll(() => screenText(rows)).toContain('codex mcp remove files')
      const opened = await terminals()
      expect(opened).toHaveLength(1)
      const prompt = opened[0]!.prompt
      expect(prompt).toBeTypeOf('number')
      await pause(1500)
      // The shell is still at the same prompt with the line unsent: nothing ran.
      expect((await terminals())[0]?.prompt).toBe(prompt)
      expect((await terminals())[0]?.busy).not.toBe(true)
      expect((await screenText(rows)).split('codex mcp remove files').at(-1)?.trim()).toBe('')
      await page.screenshot({ path: `${OUTPUT}/remove-filled-1440.png`, animations: 'disabled' })
      await dialog.getByRole('button', { name: '关闭', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })

      // ---- 安装: the vendor's command with room for the name, typed in and not run ----
      const install = mcp.locator('.extension-command').filter({ hasText: 'codex mcp add' })
      await install.getByRole('button', { name: '在终端里打开', exact: true }).click()
      await expect.poll(() => screenText(dialog.locator('.terminal-screen:not([hidden]) .xterm-rows'))).toContain('codex mcp add')
      await install.getByText('已填入', { exact: true }).waitFor()
      await page.screenshot({ path: `${OUTPUT}/install-filled-1440.png`, animations: 'disabled' })

      // The fake Codex received no MCP command; typed text never reaches the audit.
      expect(await readFile(log, 'utf8')).not.toContain('"remove"')
      const audit = await readFile(join(testHost.dataDir, 'audit', 'audit.jsonl'), 'utf8')
      expect(audit).not.toContain('codex mcp remove')
    } finally {
      await application?.close()
      await testHost.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
