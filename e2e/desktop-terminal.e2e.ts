import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HarnessPlugin } from '@latch/sdk'
import type { ServerOptions } from '@latch/host'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import type { AppSnapshot, TerminalListResponse, WorkspaceInfo } from '@latch/protocol'
import { startTestHost } from './helpers/host.ts'
import { closeSettings, openPanelTab, openSettings } from './helpers/layout.ts'
import { homeInput, switchView } from './helpers/workbench.ts'
import { promptValue } from './helpers/prompt.ts'

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
    setTimeout(() => this.print(`\u001b[?2004h\u001b[44;37m 本地验收 \u001b[0m\r\n~/${spec.cwd.split('/').at(-1)} $ `), 10)
  }
  get text() {
    return Buffer.concat(this.received).toString()
  }
  print(text: string) {
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
      hostName: '验收电脑',
      uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
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
      const connection = page.getByRole('group', { name: '连接状态', exact: true })
      await connection.getByText('host.sock', { exact: true }).filter({ visible: true }).waitFor()
      await connection.getByText('1 台在线', { exact: true }).filter({ visible: true }).waitFor()
      await connection.getByText('⌘K', { exact: true }).filter({ visible: true }).waitFor()
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
        mode: 'agent',
        model: { providerId: 'e2e-terminal', model: 'e2e' },
      })
      await waitFor(async () => (await host.bridge.detail(sessionId)).summary.status === 'idle')
      const cwd = (await host.bridge.detail(sessionId)).summary.cwd
      await page.locator(`[data-task-id="${sessionId}"]`).click()

      const panes = page.getByRole('group', { name: '工作台面板', exact: true })
      const terminalToggle = panes.getByRole('button', { name: '终端', exact: true })
      await terminalToggle.click()
      const panel = page.getByRole('region', { name: '终端', exact: true })
      const tabs = panel.getByRole('tablist', { name: '终端', exact: true })
      await tabs.getByRole('tab', { name: '终端 1', exact: true }).waitFor()
      await waitFor(() => shells.length === 1)
      expect(shells[0]!.spec.cwd).toBe(await realpath(cwd!))
      expect(shells[0]!.spec.cols).toBeGreaterThan(40)
      const screen = panel.locator('.terminal-screen:not([hidden])')
      const rows = screen.locator('.xterm-rows')
      await expect.poll(() => rows.innerText()).toContain('$')
      // That it is the person's account and not a sandbox is the foot label's tooltip, not a line of its own.
      await panel.locator('.terminal-where').waitFor()
      expect(await panel.getByRole('tooltip', { includeHidden: true }).filter({ hasText: '不是沙箱' }).count()).toBe(1)
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
      await page.emulateMedia({ colorScheme: 'dark' })
      const cursor = rows.locator('.xterm-cursor-block')
      await cursor.waitFor({ state: 'attached' })
      await page.screenshot({ path: 'test-results/desktop-terminal/active-prompt-dark.png' })
      const terminalPaint = await editorFocused.evaluate(editor => {
        const style = getComputedStyle(editor)
        const viewport = editor.closest('.terminal-screens')!
        const cell = viewport.querySelector('.xterm-cursor')!
        return {
          inputOutline: style.outlineStyle,
          inputOpacity: style.opacity,
          screenShadow: getComputedStyle(viewport).boxShadow,
          cursorBackground: getComputedStyle(cell).backgroundColor,
          textColor: getComputedStyle(viewport.querySelector('.xterm-rows')!).color,
        }
      })
      expect(terminalPaint).toEqual({
        inputOutline: 'none',
        inputOpacity: '0',
        screenShadow: 'none',
        cursorBackground: terminalPaint.textColor,
        textColor: terminalPaint.textColor,
      })
      const ansiBackground = rows.locator('.xterm-bg-4').first()
      expect(await ansiBackground.evaluate(cell => getComputedStyle(cell).backgroundColor)).toMatch(/^rgb\(/u)
      const ansiContrast = () =>
        ansiBackground.evaluate(cell => {
          const luminance = (color: string) => {
            const [r, g, b] = color
              .match(/[\d.]+/gu)!
              .slice(0, 3)
              .map(channel => {
                const srgb = Number(channel) / 255
                return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
              })
            return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
          }
          const style = getComputedStyle(cell)
          const ink = luminance(style.color)
          const paper = luminance(style.backgroundColor)
          return (Math.max(ink, paper) + 0.05) / (Math.min(ink, paper) + 0.05)
        })
      await expect.poll(ansiContrast).toBeGreaterThanOrEqual(4.5)
      await tabs.getByRole('tab', { name: '终端 1', exact: true }).focus()
      const inactiveCursor = rows.locator('.xterm-cursor-outline')
      await inactiveCursor.waitFor({ state: 'attached' })
      expect(await inactiveCursor.evaluate(cell => getComputedStyle(cell).outlineColor)).toBe(terminalPaint.textColor)
      await page.screenshot({ path: 'test-results/desktop-terminal/inactive-prompt-dark.png' })

      // The terminal renderer owns its pixels while the surrounding safety text stays covered by the secure layer.
      expect(await panel.getAttribute('data-secure')).toBe('')
      const warning = panel.locator('.terminal-where')
      const measureWarning = () =>
        warning.evaluate(element => [getComputedStyle(element).opacity, getComputedStyle(element).backgroundColor])
      const originalWarning = await measureWarning()
      const injected = await page.addStyleTag({
        content: '.terminal-foot .terminal-where * { opacity: 0 !important; background-color: red !important }',
      })
      expect(await measureWarning()).toEqual(originalWarning)
      await injected.evaluate(element => {
        element.parentNode?.removeChild(element)
      })
      await page.emulateMedia({ colorScheme: 'light' })
      await screen.locator('.xterm').click()
      await editorFocused.waitFor({ state: 'attached' })
      await expect.poll(ansiContrast).toBeGreaterThanOrEqual(4.5)
      await page.screenshot({ path: 'test-results/desktop-terminal/active-prompt-light.png' })

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

      // The three pane controls work independently. Real dragging changes the pty's rows, while the keyboard changes
      // the inspector's width. Neither the file pane nor a layout change remounts the terminal.
      const terminalDock = page.getByRole('complementary', { name: '底部终端', exact: true })
      const rightToggle = panes.getByRole('button', { name: '侧边面板', exact: true })
      const rightPanel = page.getByRole('complementary', { name: '侧边面板', exact: true })
      if ((await rightToggle.getAttribute('aria-pressed')) !== 'true') await rightToggle.click()
      // The panel lists only the tabs opened (382abe25): 文件 comes from its choices or 「+」.
      await openPanelTab(page, '文件')
      await rightPanel.getByRole('region', { name: '项目文件', exact: true }).waitFor()
      const resizer = terminalDock.getByRole('separator', { name: '调整终端高度', exact: true })
      const dockBefore = (await terminalDock.boundingBox())!
      const handle = (await resizer.boundingBox())!
      const beforePty = shells[0]!.sizes.length
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
      await page.mouse.down()
      await page.mouse.move(handle.x + handle.width / 2, handle.y - 61, { steps: 5 })
      await page.mouse.up()
      await expect.poll(async () => Math.round((await terminalDock.boundingBox())!.height - dockBefore.height)).toBeGreaterThan(55)
      await waitFor(() => shells[0]!.sizes.length > beforePty)
      const widthAdjust = page.getByRole('separator', { name: '调整侧边面板宽度', exact: true })
      const width = Number(await widthAdjust.getAttribute('aria-valuenow'))
      await widthAdjust.focus()
      await page.keyboard.press('ArrowLeft')
      await expect.poll(async () => Number(await widthAdjust.getAttribute('aria-valuenow'))).toBe(width + 8)
      const savedWidth = Number(await widthAdjust.getAttribute('aria-valuenow'))
      await resizer.focus()
      const height = Number(await resizer.getAttribute('aria-valuenow'))
      await page.keyboard.press('ArrowUp')
      await expect.poll(async () => Number(await resizer.getAttribute('aria-valuenow'))).toBe(height + 8)
      const savedHeight = Number(await resizer.getAttribute('aria-valuenow'))
      await screen.locator('.xterm').evaluate(element => element.setAttribute('data-test-mounted', 'retained'))
      await panes.getByRole('button', { name: '收起侧栏', exact: true }).click()
      await expect.poll(() => page.locator('.app-shell').getAttribute('data-sidebar')).toBe('collapsed')
      await rightPanel.getByRole('region', { name: '项目文件', exact: true }).waitFor()
      // The dock has no close button of its own: its toggle shuts it.
      expect(await panel.getByRole('button', { name: '收起终端', exact: true }).count()).toBe(0)
      await terminalToggle.click()
      await panel.waitFor({ state: 'hidden' })
      await rightPanel.getByRole('region', { name: '项目文件', exact: true }).waitFor()
      await terminalToggle.click()
      await screen.locator('.xterm[data-test-mounted="retained"]').waitFor()
      await expect.poll(() => rows.innerText()).toContain('ran echo hi')
      // 看板 covers the dock without unmounting it; back in 对话 the same terminal takes the keys again (below).
      await switchView(page, 'board')
      // Hidden under 看板, the dock leaves the accessibility tree, so it is found by its markup.
      await page.locator('.terminal-dock .xterm[data-test-mounted="retained"]').waitFor({ state: 'attached' })
      expect(await page.locator('.terminal-dock').isVisible()).toBe(false)
      await switchView(page, 'chat')
      await screen.locator('.xterm[data-test-mounted="retained"]').waitFor()
      await capture(page, 'independent-panes-1440')
      await panes.getByRole('button', { name: '展开侧栏', exact: true }).click()
      await rightToggle.click()
      await rightPanel.waitFor({ state: 'hidden' })
      await panel.waitFor()
      const settings = await openSettings(page, '设置')
      expect(await page.locator('.terminal-dock .xterm[data-test-mounted="retained"]').count()).toBe(1)
      await settings.getByRole('radiogroup', { name: '界面语言', exact: true }).waitFor()
      await capture(page, 'settings-over-dock-1440')
      await closeSettings(settings)
      await screen.locator('.xterm[data-test-mounted="retained"]').waitFor()
      expect(shells).toHaveLength(1)
      await screen.locator('.xterm').click()

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

      // Feed xterm's paste listener without using the system clipboard or invoking a native paste shortcut.
      const long = 'x'.repeat(150_000)
      const terminal = screen.locator('.xterm')
      await terminal.click()
      const shell = shells[0]!
      const firstPasteInput = shell.received.length
      await terminal.locator('.xterm-helper-textarea').evaluate((element, text) => {
        const data = new DataTransfer()
        data.setData('text/plain', text)
        element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
      }, long)
      const pasteInputs = () => shell.received.slice(firstPasteInput)
      await waitFor(() => Buffer.concat(pasteInputs()).includes('\u001b[201~'))
      const bracketed = Buffer.from(`\u001b[200~${long}\u001b[201~`)
      expect(pasteInputs().map(input => input.length)).toEqual([65_536, 65_536, bracketed.length - 131_072])
      expect(Buffer.concat(pasteInputs()).equals(bracketed)).toBe(true)

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
      const draft = page.locator('.composer .composer-input [role="textbox"]').first()
      await panel.getByRole('button', { name: '加入对话', exact: true }).click()
      await expect.poll(() => promptValue(draft)).toContain('终端 1')
      expect(await promptValue(draft)).toContain('ran echo hi')
      expect(await promptValue(draft)).toMatch(/^终端 1(（较早的输出未包含）)?\n```text\n/u)
      expect((await host.bridge.detail(sessionId)).messages.filter(message => message.role === 'user')).toHaveLength(1)
      await draft.fill('')
      // With a selection, only the selection.
      const word = (await rows.getByText('ran echo hi').first().boundingBox())!
      await page.mouse.dblclick(word.x + 6, word.y + word.height / 2)
      await panel.getByRole('button', { name: '加入对话', exact: true }).click()
      await expect.poll(() => promptValue(draft)).toBe('终端 1\n```text\nran\n```')
      await draft.fill('')

      // A reload shows the same terminal with its output replayed from the Host's scrollback.
      await page.reload()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      await tabs.getByRole('tab', { name: '终端 1', exact: true }).waitFor()
      await expect.poll(() => rows.innerText()).toContain('ran echo hi')
      expect(Number(await resizer.getAttribute('aria-valuenow'))).toBe(savedHeight)
      await rightToggle.click()
      await expect.poll(async () => Number(await widthAdjust.getAttribute('aria-valuenow'))).toBe(savedWidth)
      await rightToggle.click()
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
      await confirm.getByRole('button', { name: '取消', exact: true }).click()
      await tabs.getByRole('tab', { name: '终端 2', exact: true }).waitFor()
      await tabs.getByRole('tab', { name: '终端 2', exact: true }).focus()
      await page.keyboard.press('Delete')
      await confirm.waitFor()
      await confirm.getByRole('button', { name: '关闭终端', exact: true }).click()
      await tabs.getByRole('tab', { name: '终端 2', exact: true }).waitFor({ state: 'detached' })
      await tabs.getByRole('tab', { name: '终端 1', exact: true, selected: true }).waitFor()

      // xterm's overlay keeps a wider pointer target than the part it paints. Drag from that transparent edge.
      shell.print(Array.from({ length: 120 }, (_, i) => `scrollback row ${i}\r\n`).join(''))
      await expect.poll(() => rows.innerText()).toContain('scrollback row 119')
      const slider = screen.locator('.xterm-scrollable-element > .scrollbar.vertical > .slider')
      const scrollBox = await slider.boundingBox()
      if (!scrollBox) throw new Error('Expected a visible terminal scrollback thumb')
      const matchesToken = (token: string) =>
        slider.evaluate((element, name) => {
          const style = getComputedStyle(element)
          const context = document.createElement('canvas').getContext('2d')!
          context.fillStyle = style.getPropertyValue(name).trim()
          const expected = context.fillStyle
          context.fillStyle = style.backgroundColor
          return context.fillStyle === expected
        }, token)
      await page.mouse.move(scrollBox.x - 20, scrollBox.y + scrollBox.height / 2)
      await expect.poll(() => matchesToken('--scroll-thumb')).toBe(true)
      await page.mouse.move(scrollBox.x + 1, scrollBox.y + scrollBox.height / 2)
      await expect.poll(() => matchesToken('--scroll-thumb-hover')).toBe(true)
      await page.emulateMedia({ colorScheme: 'dark' })
      await expect.poll(() => matchesToken('--scroll-thumb-hover')).toBe(true)
      await panel.screenshot({ path: 'test-results/desktop-terminal/scrollback-hover-dark.png', animations: 'disabled' })
      const paint = await slider.evaluate(el => {
        const style = getComputedStyle(el)
        return {
          hit: el.getBoundingClientRect().width,
          thumb: el.getBoundingClientRect().width - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight),
          clip: style.backgroundClip,
        }
      })
      expect(paint).toEqual({ hit: 14, thumb: 4, clip: 'content-box' })
      await page.mouse.down()
      await expect.poll(() => matchesToken('--scroll-thumb-active')).toBe(true)
      await page.mouse.move(scrollBox.x + 1, scrollBox.y - 75, { steps: 5 })
      await page.mouse.up()
      await expect.poll(() => rows.innerText()).not.toContain('scrollback row 119')
      await page.emulateMedia({ forcedColors: 'active' })
      expect(await slider.evaluate(el => [getComputedStyle(el).paddingLeft, getComputedStyle(el).forcedColorAdjust])).toEqual([
        '0px',
        'none',
      ])
      await page.emulateMedia({ forcedColors: 'none', colorScheme: 'light' })

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

      // 768: the dock fits below the conversation and leaves its input reachable.
      await resize(768, 1000)
      await page.getByRole('button', { name: '终端', exact: true }).first().waitFor()
      await capture(page, 'running-768')
      const tabletPanelToggle = page.getByRole('button', { name: '侧边面板', exact: true })
      await tabletPanelToggle.click()
      await page.locator('.app-shell[data-inspector="sheet"]').waitFor()
      await expect
        .poll(async () => {
          const right = (await rightPanel.boundingBox())!
          const dock = (await terminalDock.boundingBox())!
          const strip = (await connection.boundingBox())!
          expect(dock.y + dock.height).toBeLessThanOrEqual(strip.y)
          return right.y + right.height - dock.y
        })
        .toBeLessThanOrEqual(1)
      await capture(page, 'sheet-above-dock-768')
      await tabletPanelToggle.click()
      await expect.poll(() => tabletPanelToggle.getAttribute('aria-pressed')).toBe('false')
      await resize(1440)
      const settledTurn = (await host.bridge.detail(sessionId)).messages.find(message => message.role === 'user')?.turn
      expect(settledTurn?.activeMs).toBeLessThan(1000)
      await page.locator('.topbar-crumb-button').filter({ visible: true }).click()
      const roundCount = page.locator('.crumb-body').locator('.crumb-row').filter({ hasText: '轮数' })
      await roundCount.getByText('1 轮', { exact: true }).waitFor()
      await capture(page, 'short-turn-count-1440')
      await page.keyboard.press('Escape')

      // ⌘J from inside the terminal folds the dock.
      await screen.locator('.xterm').click()
      await page.keyboard.press('Meta+j')
      await panel.waitFor({ state: 'hidden' })

      // Open a plain shell from the new-conversation input, first at the default folder, then at a chosen project.
      await page.keyboard.press('Meta+n')
      const input = homeInput(page)
      await input.waitFor()
      await input.fill('项目草稿仍在')
      const chatIds = (await owner.json<AppSnapshot>('snapshot')).tasks.map(task => task.id)
      await terminalToggle.click()
      await tabs.getByRole('tab', { name: '终端 1', exact: true }).waitFor()
      expect(shells[3]!.spec.cwd).toBe(await realpath(testHost.workspaceRoot))
      const defaultTerminal = (await owner.json<TerminalListResponse>('workspaces/default/terminals')).terminals[0]!
      expect(defaultTerminal).toMatchObject({ workspaceId: 'default' })
      const projectPath = join(testHost.root, 'terminal-project')
      await mkdir(projectPath)
      await writeFile(join(projectPath, 'README.md'), 'Dock fixture\n')
      const selected = await owner.addFolders({ name: '终端验收项目', paths: [projectPath] })
      expect(selected.status).toBe(201)
      const { workspace } = (await selected.json()) as { workspace: WorkspaceInfo }
      const projectPicker = page.locator('.workbench-home .home-headline').getByRole('button').first()
      await projectPicker.click()
      await page.getByRole('menu', { name: '项目', exact: true }).getByText('终端验收项目', { exact: true }).click()
      // The dock stays open on the new target, so its first terminal starts at once; no button in between.
      await tabs.getByRole('tab', { name: '终端 1', exact: true }).waitFor()
      expect(shells).toHaveLength(5)
      expect(shells[4]!.spec.cwd).toBe(await realpath(projectPath))
      await rows.waitFor()
      await screen.locator('.xterm').click()
      await page.keyboard.type('echo dock')
      await page.keyboard.press('Enter')
      await expect.poll(() => rows.innerText()).toContain('ran echo dock')
      await rightToggle.click()
      await rightPanel.getByRole('treeitem', { name: 'README.md', exact: true }).waitFor()
      await capture(page, 'project-dock-1440')
      const {
        terminals: [projectTerminal],
      } = await owner.json<TerminalListResponse>(`workspaces/${workspace.id}/terminals`)
      expect(projectTerminal).toMatchObject({ workspaceId: workspace.id })
      await page.locator(`[data-task-id="${sessionId}"]`).click()
      await tabs.getByRole('tab', { name: '终端 1', exact: true }).waitFor()
      await expect.poll(() => screen.getAttribute('data-terminal-id')).not.toBe(projectTerminal!.id)
      // 新会话 returns to the start screen with its draft; it starts in the just-read session's project, so the project is
      // chosen again, and its terminal is the one already running there.
      await page.locator('#session-navigation [data-space-primary]').click()
      expect(await promptValue(input)).toBe('项目草稿仍在')
      await projectPicker.click()
      await page.getByRole('menu', { name: '项目', exact: true }).getByText('终端验收项目', { exact: true }).click()
      await expect.poll(() => screen.getAttribute('data-terminal-id')).toBe(projectTerminal!.id)
      await expect.poll(() => rows.innerText()).toContain('ran echo dock')
      expect(await promptValue(input)).toBe('项目草稿仍在')
      expect((await owner.json<AppSnapshot>('snapshot')).tasks.map(task => task.id)).toEqual(chatIds)
      expect(shells).toHaveLength(5)
      await resizer.focus()
      await page.keyboard.press('Enter')
      await expect.poll(() => resizer.getAttribute('aria-valuenow')).toBe('220')
      await resize(768)
      if ((await page.locator('.app-shell').getAttribute('data-home-inspector')) === null) await rightToggle.click()
      await rightPanel.getByRole('treeitem', { name: 'README.md', exact: true }).waitFor()
      const panelNode = await rightPanel.elementHandle()
      const inputNode = await input.elementHandle()
      // Typing on the start screen leaves the panel, the dock and the navigation where they are, all usable.
      await input.click({ position: { x: 12, y: 12 } })
      for (const selector of ['.titlebar', '#terminal-dock', '.inspector-column'])
        await expect.poll(() => page.locator(selector).evaluate(element => (element as HTMLElement).inert)).toBe(false)
      await capture(page, 'start-768')
      expect(await panelNode!.evaluate(element => element.isConnected && !(element as HTMLElement).inert)).toBe(true)
      expect(await inputNode!.evaluate(element => element === document.activeElement)).toBe(true)
      expect(await promptValue(input)).toBe('项目草稿仍在')
      await expect.poll(() => rows.innerText()).toContain('ran echo dock')
      await rightToggle.click()
      await rightPanel.waitFor({ state: 'hidden' })
      await input.click()
      await page.keyboard.press('Meta+Shift+e')
      await rightPanel.getByRole('treeitem', { name: 'README.md', exact: true }).waitFor()

      // Split panes, in the session's tab: each pane is its own Host terminal and fits its own rows and columns.
      await resize(1440)
      await page.locator(`[data-task-id="${sessionId}"]`).click()
      await tabs.getByRole('tab', { name: '终端 1', exact: true, selected: true }).waitFor()
      const visiblePanes = panel.locator('.terminal-pane:not([hidden])')
      // Every running pane owned here draws as many rows as the Host gave its shell, and no row is below its box.
      const panesFit = async () => {
        const { terminals } = await owner.json<TerminalListResponse>(`tasks/${sessionId}/terminals`)
        const drawn = await visiblePanes.evaluateAll(panes =>
          panes.map(pane => {
            const box = pane.querySelector('.terminal-screen')!.getBoundingClientRect()
            const screen = pane.querySelector('.xterm-screen')!.getBoundingClientRect()
            const outer = pane.getBoundingClientRect()
            return {
              id: pane.getAttribute('data-pane'),
              rows: pane.querySelectorAll('.xterm-rows > div').length,
              inside:
                screen.height > 0 && screen.bottom <= box.bottom + 0.5 && box.bottom <= outer.bottom && screen.right <= box.right + 0.5,
            }
          }),
        )
        return drawn.every(item => {
          const host = terminals.find(terminal => terminal.id === item.id)
          return item.inside && (host?.status !== 'running' || host.rows === item.rows)
        })
      }
      await panel.locator('.terminal-pane[data-focused] .xterm').click()
      // The session's 终端 1 is whichever stand-in hears what is typed here; each split adds the newest shell.
      await page.keyboard.type('echo mark')
      await page.keyboard.press('Enter')
      await waitFor(() => shells.some(item => item.text.includes('echo mark\r')))
      const leftShell = shells.find(item => item.text.includes('echo mark\r'))!
      const sentBefore = Buffer.concat(leftShell.received).length
      const shellCount = shells.length
      await page.keyboard.press('Meta+Backslash')
      await waitFor(() => shells.length === shellCount + 1)
      await tabs.getByRole('tab', { name: '终端 1 · 2', exact: true, selected: true }).waitFor()
      await expect.poll(() => visiblePanes.count()).toBe(2)
      // The shortcut is the workbench's: not one byte of it reached the shell.
      expect(Buffer.concat(leftShell.received).length).toBe(sentBefore)
      const rightShell = shells.at(-1)!
      expect(rightShell).not.toBe(leftShell)
      // The new pane has the focus: typing goes there, then ⌥⌘[ goes back to the first pane.
      await expect.poll(() => visiblePanes.nth(1).getAttribute('data-focused')).toBe('')
      await page.keyboard.type('echo right')
      await page.keyboard.press('Enter')
      await waitFor(() => rightShell.text.includes('echo right\r'))
      await page.keyboard.press('Meta+Alt+BracketLeft')
      await expect.poll(() => visiblePanes.nth(0).getAttribute('data-focused')).toBe('')
      await page.keyboard.type('echo left')
      await page.keyboard.press('Enter')
      await waitFor(() => leftShell.text.endsWith('echo left\r'))
      expect(rightShell.text).not.toContain('echo left')
      expect(Buffer.concat(leftShell.received).toString()).not.toContain('\\')
      await expect.poll(panesFit).toBe(true)
      // A transparent tab strip, footer or xterm row shows the first painted surface behind it; every one is the work
      // area's canvas, the same as the title row above the conversation.
      const terminalBackgrounds = () =>
        panel.evaluate(element => {
          const parts = element.querySelectorAll(
            '.terminal-tabs, .terminal-screens, .terminal-foot, .terminal-pane:not([hidden]) :is(.xterm, .xterm-viewport, .xterm-scrollable-element, .xterm-rows)',
          )
          const colors = [element, ...parts].map(part => {
            for (let surface: Element | null = part; surface; surface = surface.parentElement) {
              const color = getComputedStyle(surface).backgroundColor
              if (color !== 'rgba(0, 0, 0, 0)') return color
            }
            return 'transparent'
          })
          return [...new Set(colors)]
        })
      const workCanvas = () => page.locator('.app-shell > .titlebar').evaluate(element => getComputedStyle(element).backgroundColor)
      await expect.poll(async () => (await terminalBackgrounds()).join() === (await workCanvas())).toBe(true)
      await page.emulateMedia({ colorScheme: 'dark' })
      await expect.poll(async () => (await terminalBackgrounds()).join() === (await workCanvas())).toBe(true)
      // The terminal is a secure surface: tokens set from outside the lock repaint the work area, never the terminal.
      const pinned = await terminalBackgrounds()
      const pageColors = await page.addStyleTag({ content: ':root, .app-shell { --canvas: red; --work-canvas: red; --mono-layer: red }' })
      await expect.poll(workCanvas).toBe('rgb(255, 0, 0)')
      expect(await terminalBackgrounds()).toEqual(pinned)
      await pageColors.evaluate(element => element.parentNode?.removeChild(element))
      await page.emulateMedia({ colorScheme: 'light' })
      await expect.poll(async () => (await terminalBackgrounds()).join() === (await workCanvas())).toBe(true)
      await capture(page, 'split-two-row-1440')

      // The header's button splits again; the other direction is refused in a tab whose panes run one way.
      await panel.getByRole('button', { name: '左右分屏', exact: true }).click()
      await tabs.getByRole('tab', { name: '终端 1 · 3', exact: true }).waitFor()
      await expect.poll(() => visiblePanes.count()).toBe(3)
      expect(await panel.getByRole('button', { name: '上下分屏', exact: true }).getAttribute('aria-disabled')).toBe('true')
      await expect.poll(panesFit).toBe(true)
      await capture(page, 'split-three-row-1440')

      // Dragging a hairline moves the two panes beside it; a double click evens them; every pane still fits.
      const hairline = panel.getByRole('separator', { name: '调整窗格宽度', exact: true }).first()
      const firstWidth = Number(await hairline.getAttribute('aria-valuenow'))
      const line = (await hairline.boundingBox())!
      await page.mouse.move(line.x + line.width / 2, line.y + line.height / 2)
      await page.mouse.down()
      await page.mouse.move(line.x + line.width / 2 + 90, line.y + line.height / 2, { steps: 5 })
      await page.mouse.up()
      await expect.poll(async () => Number(await hairline.getAttribute('aria-valuenow'))).toBeGreaterThan(firstWidth + 60)
      await expect.poll(panesFit).toBe(true)
      await hairline.dblclick()
      await expect
        .poll(async () => {
          const widths = await visiblePanes.evaluateAll(panes => panes.map(pane => pane.getBoundingClientRect().width))
          return Math.max(...widths) - Math.min(...widths)
        })
        .toBeLessThan(2)
      // The dock's own height and the window's width: each pane refits.
      const dockLine = (await resizer.boundingBox())!
      await page.mouse.move(dockLine.x + dockLine.width / 2, dockLine.y + dockLine.height / 2)
      await page.mouse.down()
      await page.mouse.move(dockLine.x + dockLine.width / 2, dockLine.y - 70, { steps: 5 })
      await page.mouse.up()
      await expect.poll(panesFit).toBe(true)
      await resize(1240)
      await expect.poll(panesFit).toBe(true)
      await resize(1440)
      await expect.poll(panesFit).toBe(true)

      // The pane's own menu closes it; its space goes to its siblings.
      const third = visiblePanes.nth(1)
      const thirdId = await third.getAttribute('data-pane')
      await third.locator('.xterm').click({ button: 'right' })
      const paneMenu = page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: '上下分屏' }) })
      await paneMenu.getByRole('menuitem', { name: '关闭', exact: true }).click()
      await tabs.getByRole('tab', { name: '终端 1 · 2', exact: true }).waitFor()
      await expect.poll(() => panel.locator(`.terminal-pane[data-pane="${thirdId}"]`).count()).toBe(0)
      await expect.poll(panesFit).toBe(true)
      // The × in the pane's head closes the other one: one pane left, a plain tab again.
      await visiblePanes.nth(1).locator('.terminal-pane-close').click()
      await tabs.getByRole('tab', { name: '终端 1', exact: true }).waitFor()
      await expect.poll(() => visiblePanes.count()).toBe(1)

      // Stacked: ⇧⌘\ from the terminal; a shell that ends shows how it ended in its own pane, with 重新打开.
      await panel.locator('.terminal-pane[data-focused] .xterm').click()
      const beforeStack = shells.length
      await page.keyboard.press('Meta+Shift+Backslash')
      await waitFor(() => shells.length === beforeStack + 1)
      await tabs.getByRole('tab', { name: '终端 1 · 2', exact: true }).waitFor()
      expect(await panel.locator('.terminal-screens').getAttribute('data-split')).toBe('column')
      await expect.poll(panesFit).toBe(true)
      await capture(page, 'split-stacked-1440')
      const lower = shells.at(-1)!
      await expect.poll(() => visiblePanes.nth(1).getAttribute('data-focused')).toBe('')
      await page.keyboard.type('exit 4')
      await page.keyboard.press('Enter')
      await panel.getByText('已退出 · 代码 4', { exact: true }).waitFor()
      expect(lower.text).toContain('exit 4')
      await page.keyboard.press('Meta+Alt+BracketRight')
      await expect.poll(() => visiblePanes.nth(0).getAttribute('data-focused')).toBe('')
      const endedPane = visiblePanes.nth(1).locator('.terminal-pane-head')
      await endedPane.getByText('已退出 · 代码 4', { exact: true }).waitFor()
      await capture(page, 'split-ended-1440')
      const beforeReopen = shells.length
      await endedPane.getByRole('button', { name: '重新打开', exact: true }).click()
      await waitFor(() => shells.length === beforeReopen + 1)
      await tabs.getByRole('tab', { name: '终端 1 · 2', exact: true }).waitFor()
      await expect.poll(() => visiblePanes.locator('.terminal-pane-head .terminal-ended').count()).toBe(0)
      await expect.poll(panesFit).toBe(true)

      // Narrow: the dock beside the side panel cannot give two panes 40 columns, so the strip shows them one at a
      // time; with the room back, the split returns as it was.
      await resize(1100)
      if ((await rightToggle.getAttribute('aria-pressed')) !== 'true') await rightToggle.click()
      await rightPanel.waitFor()
      await tabs.getByRole('tab', { name: '终端 1', exact: true }).waitFor()
      await tabs.getByRole('tab', { name: '终端 2', exact: true }).waitFor()
      await expect.poll(() => visiblePanes.count()).toBe(1)
      await expect.poll(panesFit).toBe(true)
      await capture(page, 'split-narrow-1100')
      await rightToggle.click()
      await rightPanel.waitFor({ state: 'hidden' })
      await tabs.getByRole('tab', { name: '终端 1 · 2', exact: true }).waitFor()
      await expect.poll(() => visiblePanes.count()).toBe(2)
      await resize(1440)
    } finally {
      await application?.close()
      await testHost.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
