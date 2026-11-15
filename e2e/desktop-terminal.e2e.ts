import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HarnessPlugin } from '@latch/sdk'
import type { ServerOptions } from '@latch/host'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { startTestHost } from './helpers/host.ts'

type Launch = NonNullable<NonNullable<ServerOptions['terminal']>['launch']>
type Spec = Parameters<Launch>[0]
type Emit = Parameters<Launch>[1]

/**
 * A stand-in for latch-pty that behaves like a small shell: it turns on bracketed paste, echoes what is typed, and runs
 * a few words. `serve` announces a local service, `busy` puts a program in the foreground, `exit N` ends with code N.
 * Nothing real starts; every byte it was sent is kept.
 */
class FakeShell {
  readonly received: Buffer[] = []
  readonly sizes: Array<[number, number]> = []
  pendingInput = 0
  private line = ''
  private ended = false
  private pasting = false
  constructor(
    readonly spec: Spec,
    private readonly emit: Emit,
  ) {
    setTimeout(() => this.print(`\u001b[?2004h~/${spec.cwd.split('/').at(-1)} $ `), 10)
  }
  get text() {
    return Buffer.concat(this.received).toString()
  }
  private print(text: string) {
    if (!this.ended) this.emit({ type: 'output', data: Buffer.from(text) })
  }
  input(data: Uint8Array) {
    const text = Buffer.from(data).toString()
    this.received.push(Buffer.from(data))
    // A paste comes between its brackets, over as many input calls as it takes; it is not echoed.
    if (text.includes('\u001b[200~')) this.pasting = true
    if (this.pasting) {
      if (text.includes('\u001b[201~')) {
        this.pasting = false
        this.print('[pasted]\r\n$ ')
      }
      return
    }
    for (const character of text) {
      if (character !== '\r') {
        // Control keys (Ctrl-B, Backspace) reach the shell but are not part of the line here.
        if (character >= ' ' && character !== '\u007f') {
          this.line += character
          this.print(character)
        }
        continue
      }
      const command = this.line.trim()
      this.line = ''
      this.print('\r\n')
      const exit = /^exit (\d+)$/u.exec(command)
      if (exit) {
        this.ended = true
        this.emit({ type: 'exit', code: Number(exit[1]) })
        this.emit({ type: 'gone' })
        return
      }
      if (command === 'serve') this.print('  VITE ready\r\n  ➜  Local:   http://localhost:5173/\r\n')
      else if (command === 'busy') {
        this.emit({ type: 'foreground', busy: true, name: 'sleep' })
        this.print('sleeping\r\n')
        continue
      } else if (command) this.print(`ran ${command}\r\n`)
      this.print('$ ')
    }
  }
  resize(cols: number, rows: number) {
    this.sizes.push([cols, rows])
  }
  signal() {}
  pauseOutput() {}
  resumeOutput() {}
  close() {
    if (!this.ended) {
      this.ended = true
      this.emit({ type: 'exit', signal: 1 })
      this.emit({ type: 'gone' })
    }
    return Promise.resolve()
  }
}

function shellEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition')
    await new Promise(done => setTimeout(done, 100))
  }
}

async function capture(page: Page, name: string) {
  await page.screenshot({ path: `test-results/desktop-terminal/${name}.png`, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: `test-results/desktop-terminal/${name}-dark.png`, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'light' })
}

const electronE2E = latchEnv(process.env, 'ELECTRON_E2E') === '1'

describe.skipIf(!electronE2E || process.platform !== 'darwin')('native desktop shell: terminal', () => {
  it('opens, types, resizes, attaches, reconnects, ends, reopens and runs two terminals, with stand-in shells only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-terminal-'))
    const plugin: HarnessPlugin = {
      id: 'e2e-terminal',
      name: '终端测试模型',
      version: '1.0.0',
      description: '只在测试中使用。',
      activate(context) {
        context.registerProvider({
          id: 'e2e-terminal',
          name: '终端测试模型',
          model: 'e2e',
          async *stream() {
            yield { type: 'text', text: '好的。' }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    const shells: FakeShell[] = []
    const launch: Launch = (spec, emit) => {
      const shell = new FakeShell(spec, emit)
      shells.push(shell)
      emit({ type: 'started', pid: 1 })
      return shell
    }
    const testHost = await startTestHost({
      demo: true,
      uiDir: resolve('dist/web'),
      presenceMode: 'manual',
      plugins: [plugin],
      terminal: { launch, shell: { file: '/bin/sh', argv: ['sh'] } },
    })
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
      await mkdir('test-results/desktop-terminal', { recursive: true })
      application = await _electron.launch({
        args: [
          resolve('apps/desktop/src/main.cjs'),
          `--latch-host-state=${join(testHost.dataDir, 'host.json')}`,
          `--latch-user-data=${join(root, 'electron')}`,
          '--use-mock-keychain',
        ],
        cwd: process.cwd(),
        env: shellEnvironment(),
        timeout: 30_000,
      })
      const app = application
      const page = await app.firstWindow()
      page.setDefaultTimeout(20_000)
      const resize = (width: number, height = 900) =>
        app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setContentSize(w!, h!), [width, height])
      await resize(1440)
      await page.getByRole('button', { name: '继续', exact: true }).click()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      // Recorded in main instead of opening the browser.
      await app.evaluate(({ shell }) => {
        const opened: string[] = []
        Object.assign(globalThis, { openedLinks: opened })
        shell.openExternal = async (url: string) => {
          opened.push(url)
        }
      })

      const owner = await testHost.enroll({ listener: 'unix', name: 'Other' })
      const { sessionId } = await host.bridge.createTask({
        prompt: '打开终端',
        requestId: randomUUID(),
        mode: 'chat',
        model: { providerId: 'e2e-terminal', model: 'e2e' },
      })
      await waitFor(async () => (await host.bridge.detail(sessionId)).summary.status === 'idle')
      const cwd = (await host.bridge.detail(sessionId)).summary.cwd
      await page.locator(`[data-task-id="${sessionId}"]`).click()

      // The header's 终端 opens the tab, which opens 终端 1 in the session's folder at the size of the area.
      await page.getByRole('button', { name: '终端', exact: true }).click()
      const panel = page.getByRole('region', { name: '终端', exact: true })
      const tabs = panel.getByRole('tablist', { name: '终端', exact: true })
      await tabs.getByRole('tab', { name: '终端 1', exact: true }).waitFor()
      await waitFor(() => shells.length === 1)
      expect(shells[0]!.spec.cwd).toBe(cwd)
      expect(shells[0]!.spec.cols).toBeGreaterThan(40)
      const screen = panel.locator('.terminal-screen:not([hidden])')
      const rows = screen.locator('.xterm-rows')
      await expect.poll(() => rows.innerText()).toContain('$')
      await panel.getByText('你的账户，不是沙箱', { exact: true }).waitFor()
      expect(host.security.audit.lastOf('terminal.open')).toMatchObject({ detail: { sessionId } })

      // Device motion changes stop only the cursor blink, without taking focus or changing the shell.
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      const blinking = rows.locator('.xterm-cursor-blink')
      const editorFocused = screen.locator('.xterm-helper-textarea:focus')
      await editorFocused.waitFor({ state: 'attached' })
      await blinking.waitFor({ state: 'attached' })
      await page.evaluate(() => {
        document.documentElement.dataset.motion = 'reduce'
      })
      await blinking.waitFor({ state: 'detached' })
      expect(await editorFocused.count()).toBe(1)

      // Typing reaches the shell in order and its output shows; the focus is in the terminal.
      await page.keyboard.type('echo hi')
      await page.keyboard.press('Enter')
      await expect.poll(() => rows.innerText()).toContain('ran echo hi')
      expect(shells[0]!.text).toBe('echo hi\r')
      await page.evaluate(() => {
        delete document.documentElement.dataset.motion
      })
      await blinking.waitFor({ state: 'attached' })
      expect(await editorFocused.count()).toBe(1)

      // Ctrl-B is the shell's (tmux and readline use it), not the workbench's sidebar key; ⌘ keys stay the app's.
      const sidebar = () => page.locator('.app-shell').getAttribute('data-sidebar')
      const before = await sidebar()
      await page.keyboard.press('Control+b')
      await waitFor(() => shells[0]!.text.endsWith('\u0002'))
      expect(await sidebar()).toBe(before)

      // A local service the output announced is a link to its origin, opened in the browser.
      await page.keyboard.type('serve')
      await page.keyboard.press('Enter')
      const service = panel.getByRole('link', { name: 'localhost:5173', exact: true })
      await service.waitFor()
      expect(await service.getAttribute('href')).toBe('http://localhost:5173')
      await capture(page, 'running-1440')
      await service.click()
      await waitFor(async () => (await app.evaluate(() => Reflect.get(globalThis, 'openedLinks') as string[])).length === 1)
      expect(await app.evaluate(() => Reflect.get(globalThis, 'openedLinks') as string[])).toEqual(['http://localhost:5173/'])

      // A long paste arrives whole, bracketed, in input calls the Host accepts.
      const long = 'x'.repeat(150_000)
      await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), long)
      await screen.locator('.xterm').click()
      await page.keyboard.press('Meta+v')
      await waitFor(() => shells[0]!.text.includes('\u001b[201~'))
      expect(shells[0]!.text).toContain(`\u001b[200~${long}\u001b[201~`)

      // The owner sizes it: a narrower window resizes the terminal on the Host.
      const sizes = shells[0]!.sizes.length
      await resize(1100)
      await waitFor(() => shells[0]!.sizes.length > sizes)
      const [cols] = shells[0]!.sizes.at(-1)!
      const { terminals } = await owner.json<{ terminals: Array<{ cols: number; sizeOwner: boolean }> }>(`tasks/${sessionId}/terminals`)
      // Another device on this Mac watches at the Host's size and may not change it.
      expect(terminals[0]).toMatchObject({ cols, sizeOwner: false })
      const refused = await owner.request(`tasks/${sessionId}/terminals/${(terminals[0] as unknown as { id: string }).id}/resize`, {
        body: { cols: 50, rows: 10 },
      })
      expect(refused.status).toBe(409)
      await resize(1440)

      // 加入对话: without a selection the Host's extract of the last lines goes into the draft, not sent.
      const draft = page.locator('.composer textarea').first()
      await panel.getByRole('button', { name: '加入对话', exact: true }).click()
      await expect.poll(() => draft.inputValue()).toContain('终端 1')
      expect(await draft.inputValue()).toContain('ran echo hi')
      expect(await draft.inputValue()).toMatch(/^终端 1(（较早的输出未包含）)?\n```text\n/u)
      expect((await host.bridge.detail(sessionId)).messages.filter(message => message.role === 'user')).toHaveLength(1)
      await draft.fill('')
      // With a selection, only the selection.
      const word = (await rows.getByText('ran echo hi').first().boundingBox())!
      await page.mouse.dblclick(word.x + 6, word.y + word.height / 2)
      await panel.getByRole('button', { name: '加入对话', exact: true }).click()
      await expect.poll(() => draft.inputValue()).toBe('终端 1\n```text\nran\n```')
      await draft.fill('')

      // A reload shows the same terminal with its output replayed from the Host's scrollback.
      await page.reload()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      await page.locator(`[data-task-id="${sessionId}"]`).click()
      await page.keyboard.press('Meta+j')
      await tabs.getByRole('tab', { name: '终端 1', exact: true }).waitFor()
      await expect.poll(() => rows.innerText()).toContain('ran echo hi')
      expect(shells).toHaveLength(1)

      // A second terminal: 终端 2, its own shell, and the tab moves to it.
      await panel.getByRole('button', { name: '新终端', exact: true }).click()
      await tabs.getByRole('tab', { name: '终端 2', exact: true, selected: true }).waitFor()
      await waitFor(() => shells.length === 2)
      await expect.poll(() => rows.innerText()).toContain('$')
      await page.keyboard.type('busy')
      await page.keyboard.press('Enter')
      await panel.getByText('sleep', { exact: true }).waitFor()
      await capture(page, 'two-terminals-1440')

      // Closing a terminal that runs a program asks first, and closes it on confirmation.
      await tabs.getByRole('tab', { name: '终端 2', exact: true }).focus()
      await page.keyboard.press('Delete')
      const confirm = page.getByRole('dialog', { name: '关闭终端 2？', exact: true })
      await confirm.getByText('「sleep」还在运行，关闭会结束它。', { exact: true }).waitFor()
      await confirm.getByRole('button', { name: '关闭终端', exact: true }).click()
      await tabs.getByRole('tab', { name: '终端 2', exact: true }).waitFor({ state: 'detached' })
      await tabs.getByRole('tab', { name: '终端 1', exact: true, selected: true }).waitFor()

      // The shell exits: its code shows, the output stays, and 重新打开 starts a new shell under the same name.
      await screen.locator('.xterm').click()
      await page.keyboard.type('exit 3')
      await page.keyboard.press('Enter')
      await panel.getByText('已退出 · 代码 3', { exact: true }).waitFor()
      await capture(page, 'exited-1440')
      await panel.getByRole('button', { name: '重新打开', exact: true }).click()
      await waitFor(() => shells.length === 3)
      await tabs.getByRole('tab', { name: '终端 1', exact: true, selected: true }).waitFor()
      await expect.poll(() => panel.getByText('已退出 · 代码 3', { exact: true }).count()).toBe(0)
      expect(await tabs.getByRole('tab').count()).toBe(1)

      // 768: the panel goes over the conversation and the terminal still fits it.
      await resize(768, 1000)
      await page.getByRole('button', { name: '终端', exact: true }).first().waitFor()
      await capture(page, 'running-768')
      await resize(1440)

      // ⌘J from inside the terminal is the app's: it closes the tab.
      await screen.locator('.xterm').click()
      await page.keyboard.press('Meta+j')
      await panel.waitFor({ state: 'hidden' })
    } finally {
      await application?.close()
      await testHost.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
