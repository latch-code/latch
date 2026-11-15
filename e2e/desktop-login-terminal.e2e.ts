import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HARNESS_LOGIN_SESSION, type AppSnapshot, type TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { startTestHost } from './helpers/host.ts'
import { closeSettings, noHorizontalOverflow, openSection, openSettings } from './helpers/layout.ts'

const OUTPUT = 'test-results/desktop-login-terminal'
/** What the fixture's login prints, as a real one prints a device code: it must stay on the terminal's screen. */
const CODE = 'FIXTURE-CODE-7291'

async function capture(page: Page, name: string) {
  await page.screenshot({ path: `${OUTPUT}/${name}.png`, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.screenshot({ path: `${OUTPUT}/${name}-dark.png`, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
}

const electronE2E = latchEnv(process.env, 'ELECTRON_E2E') === '1'

describe.skipIf(!electronE2E || process.platform !== 'darwin')('native desktop shell: a Harness login in Latch’s terminal', () => {
  it('runs the fixture’s login in a dialog outside a session, in the session’s 终端 tab, and from 设置, and asks the Harness after', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-login-terminal-'))
    const bin = join(root, 'bin')
    await mkdir(bin)
    const loginFile = join(root, 'login')
    const agent = [
      `export FAKE_ACP_LOGIN_FILE='${loginFile}' FAKE_ACP_CAPS=resume FAKE_ACP_STATE='${join(root, 'state.json')}'`,
      'export FAKE_ACP_MODES=read-only,workspace-write,agent-full-access FAKE_ACP_INITIAL_MODE=read-only FAKE_ACP_CONFIG=options',
      `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`,
    ]
    await writeFile(join(bin, 'codex-acp'), ['#!/bin/sh', ...agent].join('\n'))
    // The preset's `codex login`, as a harmless script: it prints a code, waits for Enter, and logs in unless told `no`.
    await writeFile(
      join(bin, 'codex'),
      [
        '#!/bin/sh',
        'if [ "$1" = login ] && [ "$#" -eq 1 ]; then',
        `  printf 'Fixture login. Device code: ${CODE}\\nPress Enter to finish: '`,
        '  IFS= read -r answer',
        `  if [ "$answer" = no ]; then echo 'Fixture login refused.'; exit 3; fi`,
        `  printf 'logged in\\n' > '${loginFile}'`,
        `  echo 'Fixture: logged in.'`,
        '  exit 0',
        'fi',
        ...agent,
      ].join('\n'),
    )
    for (const name of ['codex', 'codex-acp']) await chmod(join(bin, name), 0o755)
    const external: string[] = []
    const testHost = await startTestHost({
      demo: false,
      sessionFolders: true,
      uiDir: resolve('dist/web'),
      detectPreset: preset => (preset.id === 'codex' ? { found: true, path: join(bin, 'codex-acp') } : { found: false }),
      loginPrograms: name => (existsSync(join(bin, name)) ? join(bin, name) : undefined),
      commandDirectories: () => [bin],
      // The real latch-pty, with /bin/sh in place of the person's own shell: no profile of this account is read.
      terminal: { shell: { file: '/bin/sh', argv: ['sh'] } },
      // The default terminal app must not be asked for anything here.
      loginTerminal: script => {
        external.push(script)
        return Promise.resolve()
      },
    })
    const { host } = testHost
    let application: ElectronApplication | undefined
    try {
      const owner = await testHost.enroll({ listener: 'unix', name: 'Owner' })
      const saved = await owner.confirmed('agents', {
        body: { id: 'codex', name: 'Codex', presetId: 'codex', command: 'codex-acp', args: [], env: {} },
      })
      expect(saved.status).toBe(201)
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
      const app = application
      const page = await app.firstWindow()
      page.setDefaultTimeout(20_000)
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
      const resize = (width: number, height = 900) =>
        app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setContentSize(w!, h!), [width, height])
      await resize(1440)
      await page.getByRole('button', { name: '继续', exact: true }).click()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      const auditFile = join(testHost.dataDir, 'audit', 'audit.jsonl')
      const audited = async (action: string) =>
        (await readFile(auditFile, 'utf8'))
          .trim()
          .split('\n')
          .map(line => JSON.parse(line) as { action: string; detail: unknown })
          .filter(entry => entry.action === action)

      // ---- A new session's draft: no session yet, so the login runs in a dialog bound to none ----
      const notice = page.getByRole('status', { name: '登录' })
      await notice.getByText('Codex 还没登录', { exact: true }).waitFor()
      expect(await notice.getByText('在这台 Mac 的终端里运行这条命令。').count()).toBe(0)
      await notice.getByRole('button', { name: '在终端里登录', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Codex', exact: true })
      const rows = dialog.locator('.xterm-rows')
      await expect.poll(() => rows.innerText()).toContain('Press Enter to finish:')
      expect(await rows.innerText()).toContain(CODE)
      await dialog.getByText('登录中', { exact: true }).waitFor()
      await dialog.getByText('你的账户，不是沙箱', { exact: true }).waitFor()
      expect(await notice.locator('.harness-login-state').innerText()).toBe('登录中')
      expect(host.security.audit.lastOf('terminal.open')).toMatchObject({ detail: { sessionId: HARNESS_LOGIN_SESSION } })
      await capture(page, 'draft-dialog-running-1440')

      // Closing while the command runs asks first; kept, it goes on.
      await dialog.getByRole('button', { name: '关闭终端', exact: true }).click()
      const confirm = page.getByRole('dialog', { name: '关闭 Codex 的登录？', exact: true })
      await confirm.getByText('登录命令还在运行，关闭会结束它。', { exact: true }).waitFor()
      await confirm.getByRole('button', { name: '取消', exact: true }).click()
      await confirm.waitFor({ state: 'detached' })

      // The command refuses: its code shows, the output stays to be read, and the row says 失败.
      await dialog.locator('.xterm').click()
      await page.keyboard.type('no')
      await page.keyboard.press('Enter')
      await dialog.getByText('已退出 · 代码 3', { exact: true }).waitFor()
      await expect.poll(() => rows.innerText()).toContain('Fixture login refused.')
      await expect.poll(() => notice.locator('.harness-login-state').innerText()).toBe('失败')
      expect(existsSync(loginFile)).toBe(false)
      await capture(page, 'draft-dialog-failed-1440')
      await dialog.getByRole('button', { name: '关闭', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      await notice.getByText('Codex 还没登录', { exact: true }).waitFor()

      // ---- 设置 › Harness: logged in from the 登录 group ----
      const settings = await openSettings(page)
      await openSection(settings, 'Harness')
      await settings.getByRole('button', { name: '编辑 Codex', exact: true }).click()
      const group = settings.locator('.settings-group', { has: page.getByRole('heading', { name: '登录', exact: true }) })
      await group.getByText('还没登录', { exact: true }).waitFor()
      await group.getByRole('button', { name: '在终端里登录', exact: true }).click()
      await expect.poll(() => rows.innerText()).toContain('Press Enter to finish:')
      await capture(page, 'settings-dialog-running-1440')
      await resize(768, 1000)
      await dialog.getByText('登录中', { exact: true }).waitFor()
      await noHorizontalOverflow(page)
      await capture(page, 'settings-dialog-running-768')
      await resize(1440)
      await dialog.locator('.xterm').click()
      await page.keyboard.press('Enter')
      // Code 0: the dialog goes, and the group shows what the Harness now says.
      await dialog.waitFor({ state: 'detached' })
      await group.getByText('已登录', { exact: true }).waitFor()
      expect(existsSync(loginFile)).toBe(true)
      await capture(page, 'settings-logged-in-1440')
      await closeSettings(settings)

      // ---- In a session: logged out again elsewhere, the turn is refused, and the login runs in the session's 终端 tab ----
      await rm(loginFile)
      const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
      await input.fill('echo 第一轮')
      await input.press('Meta+Enter')
      const end = page.locator('.run-end')
      await end.getByText('Codex 还没登录 · 登录后重试', { exact: true }).waitFor()
      const session = (await owner.json<AppSnapshot>('snapshot')).tasks[0]!
      await end.getByRole('button', { name: '在终端里登录', exact: true }).click()
      const panel = page.getByRole('region', { name: '终端', exact: true })
      const tabs = panel.getByRole('tablist', { name: '终端', exact: true })
      await tabs.getByRole('tab', { name: 'Codex', exact: true, selected: true }).waitFor()
      const screen = panel.locator('.terminal-screen:not([hidden])')
      await expect.poll(() => screen.locator('.xterm-rows').innerText()).toContain('Press Enter to finish:')
      expect(host.security.audit.lastOf('terminal.open')).toMatchObject({ detail: { sessionId: session.id } })
      // Only the login's own tab: no plain shell was opened beside it, and its output is not offered to the conversation.
      expect(await tabs.getByRole('tab').count()).toBe(1)
      expect(await panel.getByRole('button', { name: '加入对话', exact: true }).count()).toBe(0)
      await expect.poll(() => end.locator('.harness-login-state').innerText()).toBe('登录中')
      expect(await page.getByRole('dialog').count()).toBe(0)
      await noHorizontalOverflow(page)
      await capture(page, 'session-tab-running-1440')
      await resize(768, 1000)
      await tabs.getByRole('tab', { name: 'Codex', exact: true }).waitFor()
      await capture(page, 'session-tab-running-768')
      await resize(1440)

      // Enter finishes it with code 0. The Harness is asked, the row says 已登录 and still offers 重试; nothing is sent again.
      await screen.locator('.xterm').click()
      await page.keyboard.press('Enter')
      await panel.getByText('已退出 · 代码 0', { exact: true }).waitFor()
      await expect.poll(() => end.locator('.harness-login-state').innerText()).toBe('已登录')
      expect(await panel.getByRole('button', { name: '重新打开', exact: true }).count()).toBe(0)
      await end.getByRole('button', { name: '重试', exact: true }).waitFor()
      const users = async () => (await owner.json<TaskDetail>(`tasks/${session.id}`)).messages.filter(message => message.role === 'user')
      expect((await users()).map(message => message.text)).toEqual(['echo 第一轮'])
      expect((await owner.json<TaskDetail>(`tasks/${session.id}`)).summary.runEnd?.reason).toBe('login-required')
      await capture(page, 'session-tab-done-1440')
      await end.getByRole('button', { name: '重试', exact: true }).click()
      await page.locator('.transcript').getByText('echo: echo 第一轮', { exact: true }).first().waitFor({ timeout: 20_000 })

      // Three logins, each recorded before its shell, none through the default terminal app; no terminal is left.
      expect(external).toEqual([])
      expect((await audited('agent.login.opened')).map(entry => entry.detail)).toEqual(Array(3).fill({ agentId: 'codex' }))
      expect(await audited('terminal.open')).toHaveLength(3)
      const left = await owner.json<{ terminals: unknown[] }>(`tasks/${HARNESS_LOGIN_SESSION}/terminals`)
      expect(left.terminals).toEqual([])
      // What the login printed stayed on the terminal's screen: not in the audit log, the session or its messages.
      expect(await readFile(auditFile, 'utf8')).not.toContain(CODE)
      expect(JSON.stringify(await owner.json<TaskDetail>(`tasks/${session.id}`))).not.toContain(CODE)
      expect(JSON.stringify(await owner.json<AppSnapshot>('snapshot'))).not.toContain(CODE)
    } finally {
      await application?.close()
      await testHost.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
