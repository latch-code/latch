import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HarnessPlugin } from '@latch/sdk'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import type { TerminalListResponse } from '@latch/protocol'
import { startTestHost } from './helpers/host.ts'
import { closeSettings, openSection, openSettings } from './helpers/layout.ts'

const OUTPUT = 'test-results/desktop-terminal-fill'

async function capture(page: Page, name: string) {
  await page.screenshot({ path: `${OUTPUT}/${name}.png`, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.screenshot({ path: `${OUTPUT}/${name}-dark.png`, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
}

/** A screen's text with its wrapped rows joined, so a long command reads as one line. */
const screenText = async (rows: ReturnType<Page['locator']>) => (await rows.innerText()).replace(/\n/gu, '')
const pause = (ms: number) => new Promise(done => setTimeout(done, ms))

/**
 * A Host with the real latch-pty running `shell` (never the person's own shell or profile), a session whose reply holds
 * two shell blocks (one that would create `marker`, one with a hidden character), and the desktop app on it.
 */
async function setUp(shell: { file: string; argv: string[] }) {
  const root = await mkdtemp(join(tmpdir(), 'latch-electron-terminal-fill-'))
  const marker = join(root, 'ran')
  const reply = [
    '先确认一下：',
    '',
    '```sh',
    `touch '${marker}'`,
    '```',
    '',
    '这一条含不可见字符：',
    '',
    '```sh',
    'echo hi\u200b',
    '```',
  ].join('\n')
  const plugin: HarnessPlugin = {
    id: 'e2e-fill',
    name: '填入测试模型',
    version: '1.0.0',
    description: '只在测试中使用。',
    activate(context) {
      context.registerProvider({
        id: 'e2e-fill',
        name: '填入测试模型',
        model: 'e2e',
        async *stream() {
          yield { type: 'text', text: reply }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  const testHost = await startTestHost({
    demo: true,
    uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
    plugins: [plugin],
    terminal: { shell },
  })
  const { host } = testHost
  let application: ElectronApplication | undefined
  const close = async () => {
    await application?.close()
    await testHost.close()
    await rm(root, { recursive: true, force: true })
  }
  try {
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
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900))
    await page.getByRole('button', { name: '继续', exact: true }).click()
    await page.locator('.app-shell[data-connection="connected"]').waitFor()
    const owner = await testHost.enroll({ listener: 'unix', name: 'Owner' })
    const { sessionId } = await host.bridge.createTask({
      prompt: '给我一条命令',
      requestId: randomUUID(),
      mode: 'chat',
      model: { providerId: 'e2e-fill', model: 'e2e' },
    })
    await expect.poll(async () => (await host.bridge.detail(sessionId)).summary.status).toBe('idle')
    await page.locator(`[data-task-id="${sessionId}"]`).click()
    const blocks = page.locator('.transcript .message-code')
    await expect.poll(() => blocks.count()).toBe(2)
    const terminals = async () => (await owner.json<TerminalListResponse>(`tasks/${sessionId}/terminals`)).terminals
    return { page, testHost, marker, blocks, terminals, close }
  } catch (error) {
    await close()
    throw error
  }
}

const electronE2E = latchEnv(process.env, 'ELECTRON_E2E') === '1'

describe.skipIf(!electronE2E || process.platform !== 'darwin')(
  'native desktop shell: a reply’s command typed into Latch’s terminal',
  () => {
    it('types a shell block in at the prompt without running it, once per prompt, never into a running program, and refuses hidden characters', async () => {
      // zsh without startup files: bracketed paste is its own default, and no profile is read.
      const { page, testHost, marker, blocks, terminals, close } = await setUp({ file: '/bin/zsh', argv: ['zsh', '-f'] })
      try {
        const fill = blocks.nth(0).getByRole('button', { name: '在终端里打开', exact: true })
        const refused = blocks.nth(1).getByRole('button', { name: '在终端里打开', exact: true })
        expect(await fill.getAttribute('aria-disabled')).toBeNull()
        // A block with a hidden character keeps copy; its action is turned down, with the reason on hover.
        expect(await refused.getAttribute('aria-disabled')).toBe('true')
        expect(await refused.getAttribute('aria-description')).toBe('含控制、不可见或改变方向的字符')
        await refused.hover()
        await page.getByRole('tooltip').getByText('含控制、不可见或改变方向的字符', { exact: true }).waitFor()
        await fill.hover()
        await capture(page, 'reply-action-1440')

        // ---- Filled at the prompt of a new terminal in the session's folder, focused, and not run ----
        await fill.click()
        const panel = page.getByRole('region', { name: '终端', exact: true })
        const tabs = panel.getByRole('tablist', { name: '终端', exact: true })
        await tabs.getByRole('tab', { name: '终端 1', exact: true, selected: true }).waitFor()
        const shown = () => panel.locator('.terminal-screen:not([hidden]) .xterm-rows')
        const screen = panel.locator('.terminal-screen:not([hidden])')
        await expect.poll(() => screenText(shown())).toContain(`touch '${marker}'`)
        await blocks.nth(0).getByText('已填入', { exact: true }).waitFor()
        await screen.locator('.xterm-helper-textarea:focus').waitFor({ state: 'attached' })
        await pause(1500)
        expect(existsSync(marker)).toBe(false)
        await capture(page, 'filled-terminal-1440')

        // ---- A second command never joins the line the first is on: it goes to a new terminal ----
        await fill.click()
        await tabs.getByRole('tab', { name: '终端 2', exact: true, selected: true }).waitFor()
        await expect.poll(() => screenText(shown())).toContain(`touch '${marker}'`)
        await tabs.getByRole('tab', { name: '终端 1', exact: true }).click()
        expect((await screenText(shown())).split('touch').length).toBe(2)
        // The person presses Enter: only now does it run.
        await screen.locator('.xterm').click()
        const usedRows = () => shown().locator(':scope > div').filter({ hasText: /\S/u }).count()
        const rowsBeforeEnter = await usedRows()
        await page.keyboard.press('Enter')
        await expect.poll(() => existsSync(marker)).toBe(true)
        // The marker can be written before xterm receives the next shell prompt.
        await expect.poll(usedRows).toBeGreaterThan(rowsBeforeEnter)

        // ---- The refused block types nothing ----
        const before = await shown().innerText()
        await refused.click({ force: true })
        await pause(500)
        expect(await shown().innerText()).toBe(before)
        expect(await blocks.nth(1).getByText('已填入', { exact: true }).count()).toBe(0)
        await refused.hover({ force: true })
        await capture(page, 'refused-block-1440')

        // ---- A program runs in the active tab: the command goes to a new terminal, never into the program ----
        await rm(marker)
        await screen.locator('.xterm').click()
        await page.keyboard.type('sleep 4')
        await page.keyboard.press('Enter')
        await expect.poll(async () => (await terminals())[0]?.prompt).toBeUndefined()
        await fill.click()
        await tabs.getByRole('tab', { name: '终端 3', exact: true, selected: true }).waitFor()
        await expect.poll(() => screenText(shown())).toContain(`touch '${marker}'`)
        await pause(4500)
        // `sleep` ended without reading the command, and the new tab still waits for Enter.
        expect(existsSync(marker)).toBe(false)
        const listed = await terminals()
        expect(listed).toHaveLength(3)
        expect(listed.every(terminal => terminal.status === 'running')).toBe(true)

        // ---- 设置 › Harness: an install command goes to the terminal dialog, typed in and not run ----
        const settings = await openSettings(page)
        await openSection(settings, 'Harness')
        await settings
          .getByRole('button', { name: /^怎么装 /u })
          .first()
          .click()
        const command = settings.locator('.agent-how-command code').first()
        await command.waitFor()
        const install = (await command.innerText()).trim()
        await capture(page, 'settings-install-1440')
        await settings.locator('.agent-how-command').first().getByRole('button', { name: '在终端里打开', exact: true }).click()
        const dialog = page.getByRole('dialog', { name: '终端', exact: true })
        await expect.poll(() => screenText(dialog.locator('.terminal-screen:not([hidden]) .xterm-rows'))).toContain(install)
        expect(await dialog.getByRole('tooltip', { includeHidden: true }).filter({ hasText: '不是沙箱' }).count()).toBe(1)
        await capture(page, 'settings-install-filled-1440')
        await dialog.getByRole('button', { name: '关闭', exact: true }).click()
        await dialog.waitFor({ state: 'detached' })
        await closeSettings(settings)

        // Typed text is terminal input like any other: the Host's audit never holds it.
        const audit = await readFile(join(testHost.dataDir, 'audit', 'audit.jsonl'), 'utf8')
        expect(audit).not.toContain(marker)
        expect(audit).not.toContain(install)
      } finally {
        await close()
      }
    })

    it('types nothing into a shell without bracketed paste, and closes the terminal it opened for the command', async () => {
      // /bin/sh on macOS is bash 3.2, whose line editor has no bracketed paste.
      const { page, marker, blocks, terminals, close } = await setUp({ file: '/bin/sh', argv: ['sh'] })
      try {
        await blocks.nth(0).getByRole('button', { name: '在终端里打开', exact: true }).click()
        await blocks.nth(0).getByText('没有填入', { exact: true }).waitFor({ timeout: 25_000 })
        await expect.poll(async () => (await terminals()).length).toBe(0)
        expect(existsSync(marker)).toBe(false)
        expect(await page.locator('.xterm-rows').evaluateAll(rows => rows.map(row => row.textContent).join(''))).not.toContain('touch')
      } finally {
        await close()
      }
    })
  },
)
