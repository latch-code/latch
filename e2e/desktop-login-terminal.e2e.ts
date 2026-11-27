import { _electron, chromium, type Browser, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HARNESS_LOGIN_SESSION, type AgentSettings, type AppSnapshot, type TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { backToSection, closeSettings, noHorizontalOverflow, openSection, openSettings, reachable } from './helpers/layout.ts'
import { VISUAL_VIEWPORTS, visualContext } from './helpers/visual.ts'

const OUTPUT = 'test-results/desktop-login-terminal'
/** What the fixture's login prints, as a real one prints a device code: it must stay on the terminal's screen. */
const CODE = 'FIXTURE-CODE-7291'

async function capture(page: Page, name: string) {
  await page.screenshot({ path: `${OUTPUT}/${name}.png`, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.screenshot({ path: `${OUTPUT}/${name}-dark.png`, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
}

async function dropAccountSaveResponse(page: Page, dropReadback = false) {
  await page.evaluate(dropReadback => {
    const fetchAnswer = window.fetch.bind(window)
    let lostSave = false
    let lostRead = false
    window.fetch = async (input, init) => {
      const response = await fetchAnswer(input, init)
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href
      if (!lostSave && url.endsWith('/link/api/agents') && init?.method === 'POST' && response.status === 201) {
        lostSave = true
        throw new TypeError('Fixture dropped the saved account response')
      }
      if (dropReadback && lostSave && !lostRead && url.endsWith('/link/api/agents?recheck=0')) {
        lostRead = true
        throw new TypeError('Fixture dropped the account readback')
      }
      return response
    }
  }, dropReadback)
}

async function titleStart(row: Locator): Promise<number> {
  return row.locator('.settings-row-title').evaluate(title => {
    const text = document.createTreeWalker(title, NodeFilter.SHOW_TEXT).nextNode()
    if (!text?.textContent) throw new Error('Expected a row title')
    const firstCharacter = document.createRange()
    firstCharacter.setStart(text, 0)
    firstCharacter.setEnd(text, 1)
    return firstCharacter.getBoundingClientRect().left
  })
}

/** Compare pixels with and without focus so a hard clip by the card cannot pass as a rounded corner. */
async function captureAccountFocus(page: Page, group: Locator, singleton: Locator, surface: string) {
  const row = singleton.locator('..')
  const box = await row.boundingBox()
  const groupBox = await group.boundingBox()
  if (!box || !groupBox) throw new Error('Expected the account list and its last row in view')
  const captureLeft = Math.floor(box.x) - 6
  const captureTop = Math.floor(groupBox.y) - 4
  const clip = {
    x: captureLeft,
    y: captureTop,
    width: Math.ceil(box.x + box.width) + 6 - captureLeft,
    height: Math.ceil(box.y + box.height) + 8 - captureTop,
  }
  const rowBounds = {
    left: Math.floor(box.x) - captureLeft,
    right: Math.ceil(box.x + box.width) - captureLeft - 1,
    bottom: Math.ceil(box.y + box.height) - captureTop - 1,
  }
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    expect(await group.evaluate(button => button === document.activeElement)).toBe(true)
    const options = { clip, scale: 'css', animations: 'disabled' } as const
    const before = await page.screenshot(options)
    await page.keyboard.press('Tab')
    expect(await singleton.evaluate(button => button === document.activeElement && button.matches(':focus-visible'))).toBe(true)
    const focused = await page.screenshot({ ...options, path: `${OUTPUT}/codex-account-settings-${surface}-keyboard-focus-${theme}.png` })
    const corners = await page.evaluate(
      async ({ images, rowBounds: { left, right, bottom } }) => {
        const pixels = await Promise.all(
          images.map(async image => {
            const bytes = Uint8Array.from(atob(image), character => character.charCodeAt(0))
            const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
            const context = canvas.getContext('2d')!
            context.drawImage(bitmap, 0, 0)
            return context.getImageData(0, 0, bitmap.width, bitmap.height)
          }),
        )
        const [unfocusedPixels, focusedPixels] = pixels
        const changed = (x: number, y: number) => {
          const pixel = 4 * (y * focusedPixels.width + x)
          return [0, 1, 2].some(channel => Math.abs(focusedPixels.data[pixel + channel] - unfocusedPixels.data[pixel + channel]) >= 48)
        }
        const offsets = Array.from({ length: 14 }, (_, index) => index)
        const center = Math.floor((left + right) / 2)
        const lower = offsets.map(offset => bottom - offset).find(y => changed(center, y))
        const roundCorner = (edge: number, direction: 1 | -1) => {
          if (lower === undefined) return false
          const side = offsets.map(offset => edge + direction * offset).find(x => changed(x, bottom - 18))
          if (side === undefined || changed(side, lower)) return false
          // A clip can remove a corner, but cannot draw a diagonal between the side and bottom strokes.
          return [2, 3, 4, 5, 6].filter(dy => [2, 3, 4, 5, 6, 7].some(dx => changed(side + direction * dx, lower - dy))).length >= 3
        }
        return { bottomStroke: lower !== undefined, leftArc: roundCorner(left, 1), rightArc: roundCorner(right, -1) }
      },
      { images: [before.toString('base64'), focused.toString('base64')], rowBounds },
    )
    expect.soft(corners, `${surface} ${theme} focus ring`).toEqual({ bottomStroke: true, leftArc: true, rightArc: true })
    await page.keyboard.press('Shift+Tab')
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

async function launch(testHost: TestHost, root: string) {
  const { host, dataDir } = testHost
  await writeHostState(dataDir, {
    version: 2,
    pid: process.pid,
    hostId: host.hostId,
    instanceId: host.instanceId,
    socketPath: host.socketPath,
    loopbackOrigin: host.loopbackOrigin,
    tlsOrigin: null,
    startedAt: new Date().toISOString(),
    dataDir,
  })
  await mkdir(OUTPUT, { recursive: true })
  return _electron.launch({
    args: [
      resolve('apps/desktop/src/main.cjs'),
      `--latch-host-state=${join(dataDir, 'host.json')}`,
      `--latch-user-data=${join(root, 'electron')}`,
      '--use-mock-keychain',
    ],
    cwd: process.cwd(),
    env: Object.fromEntries(
      Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    timeout: 30_000,
  })
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
      application = await launch(testHost, root)
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
      // Whose account the shell runs as is the title's tooltip; no line of its own.
      expect(await dialog.getByRole('tooltip', { includeHidden: true }).filter({ hasText: '不是沙箱' }).count()).toBe(1)
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

      const accountDirectory = join(root, 'work-account')
      await mkdir(accountDirectory)
      await settings.getByRole('button', { name: '添加账号…', exact: true }).filter({ visible: true }).click()
      const add = page.getByRole('dialog', { name: '添加 Codex 账号', exact: true })
      await add.getByLabel('账号名称', { exact: true }).fill('工作')
      expect(await add.locator('.ui-dialog-surface').evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
      await capture(page, 'add-account')
      await add.getByLabel('已登录的配置目录', { exact: true }).fill(accountDirectory)
      await add.getByRole('button', { name: '添加账号', exact: true }).click()
      await settings.getByRole('heading', { name: 'Codex · 工作', exact: true }).waitFor()
      const added = (await owner.json<AppSnapshot>('snapshot')).catalog?.harnesses.find(item => item.account && item.presetId === 'codex')
      expect(added?.capabilities.display.label).toBe('Codex · 工作')
      expect(added?.id).not.toBe('codex')
      await settings.getByRole('button', { name: '重命名…', exact: true }).click()
      const rename = page.getByRole('dialog', { name: '重命名 Harness', exact: true })
      await rename.getByLabel('名称', { exact: true }).fill('Codex · 项目')
      await rename.getByRole('button', { name: '保存', exact: true }).click()
      await settings.getByRole('heading', { name: 'Codex · 项目', exact: true }).waitFor()
      await settings.getByRole('button', { name: '移除', exact: true }).click()
      await page.getByRole('dialog', { name: '移除账号', exact: true }).getByRole('button', { name: '移除', exact: true }).click()
      await expect
        .poll(async () => (await owner.json<AppSnapshot>('snapshot')).catalog?.harnesses.some(item => item.id === added!.id))
        .toBe(false)
      expect(existsSync(accountDirectory)).toBe(true)
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

      // Enter finishes it with code 0. The Harness is asked, and the row reads as resolved: 已登录 with 重试 as the one
      // thing left to press, the refusal and the login command gone; nothing is sent again.
      await screen.locator('.xterm').click()
      await page.keyboard.press('Enter')
      await panel.getByText('已退出 · 代码 0', { exact: true }).waitFor()
      await end.getByText('已登录', { exact: true }).waitFor()
      expect(await end.getByText(/还没登录/u).count()).toBe(0)
      expect(await end.getByText('codex login', { exact: true }).count()).toBe(0)
      expect(await end.getByRole('button').evaluateAll(buttons => buttons.map(button => button.textContent))).toEqual(['重试'])
      expect(await panel.getByRole('button', { name: '重新打开', exact: true }).count()).toBe(0)
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

  it('adds Cursor keys with a stable account ID and binds an unreadable Gemini Enterprise ADC file by directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-harness-accounts-'))
    const bin = join(root, 'bin')
    await mkdir(bin)
    for (const [name, version] of [
      ['cursor-agent', '2026.11.1'],
      ['agy', '1.5.8'],
    ] as const) {
      await writeFile(join(bin, name), `#!/bin/sh\n[ "$1" = --version ] || exit 2\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 })
    }
    const directory = join(root, 'enterprise')
    await mkdir(directory)
    const adc = join(directory, 'application_default_credentials.json')
    await writeFile(adc, 'unreadable fixture with no credentials', { mode: 0o000 })
    const testHost = await startTestHost({
      demo: false,
      hostName: '测试执行电脑',
      uiDir: resolve('dist/web'),
      detectPreset: preset =>
        ['antigravity', 'cursor'].includes(preset.id) ? { found: true, path: join(bin, preset.command) } : { found: false },
      loginPrograms: name => (existsSync(join(bin, name)) ? join(bin, name) : undefined),
      commandDirectories: () => [bin],
    })
    let application: ElectronApplication | undefined
    try {
      const owner = await testHost.enroll({ listener: 'unix', name: 'Owner' })
      application = await launch(testHost, root)
      const app = application
      const page = await app.firstWindow()
      page.setDefaultTimeout(20_000)
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
      const resize = async (width: number) => {
        await app.evaluate(({ BrowserWindow }, next) => {
          const window = BrowserWindow.getAllWindows()[0]!
          window.setMinimumSize(320, 400)
          window.setContentSize(next, 900)
        }, width)
        await page.waitForFunction(next => innerWidth === next, width)
      }
      await resize(1440)
      await page.getByRole('button', { name: '继续', exact: true }).click()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      const settings = await openSettings(page)
      await openSection(settings, 'Harness')
      const add = async (name: string) => {
        await settings.getByRole('button', { name: '添加账号…', exact: true }).filter({ visible: true }).click()
        await page.getByRole('menuitem', { name, exact: true }).click()
      }
      await add('Cursor')
      const cursor = page.getByRole('dialog', { name: '添加 Cursor 账号', exact: true })
      await cursor.getByLabel('账号名称', { exact: true }).fill('工作')
      const key = cursor.getByLabel('此账号的 Cursor API 密钥', { exact: true })
      expect(await key.getAttribute('type')).toBe('password')
      await capture(page, 'cursor-account-1440')
      const pretendKey = 'fixture-credential-for-cursor-account'
      await key.fill(pretendKey)
      const submissions: Array<{ id: string | undefined; confirmed: boolean }> = []
      page.on('request', request => {
        if (request.method() !== 'POST' || !request.url().endsWith('/link/api/agents')) return
        const body = request.postDataJSON() as { presetId: string; id?: string }
        if (body.presetId === 'cursor') submissions.push({ id: body.id, confirmed: Boolean(request.headers()['x-latch-confirmation']) })
      })
      testHost.presence.mode = 'manual'
      const prior = testHost.presence.requests.length
      const save = cursor.getByRole('button', { name: '添加账号', exact: true })
      await save.click()
      await expect.poll(() => testHost.presence.requests.length).toBe(prior + 1)
      testHost.presence.denyNext()
      await cursor.getByText('没有执行：确认没有通过。', { exact: true }).waitFor()
      await dropAccountSaveResponse(page, true)
      await save.click()
      await expect.poll(() => testHost.presence.requests.length).toBe(prior + 2)
      testHost.presence.approveNext()
      await cursor.getByText('添加结果未知。重试会检查此账号是否已保存。', { exact: true }).waitFor()
      expect(await key.isEditable()).toBe(false)
      await cursor.getByRole('button', { name: '重试添加', exact: true }).click()
      await settings.getByRole('heading', { name: 'Cursor · 工作', exact: true }).waitFor()
      const id = submissions[0]?.id
      expect(id).toMatch(/^cursor-key-[a-f0-9-]{36}$/u)
      expect(id).toHaveLength(47)
      expect(submissions).toEqual([
        { id, confirmed: false },
        { id, confirmed: false },
        { id, confirmed: true },
      ])
      const snapshot = () => owner.json<AppSnapshot>('snapshot')
      expect((await snapshot()).catalog?.harnesses).toContainEqual(expect.objectContaining({ id, account: true }))
      expect(JSON.stringify(await owner.json('agents'))).not.toContain(pretendKey)
      expect(JSON.stringify(testHost.presence.requests.slice(prior))).not.toContain(pretendKey)
      expect(await readFile(join(testHost.dataDir, 'audit', 'audit.jsonl'), 'utf8')).not.toContain(pretendKey)
      expect(await settings.getByRole('button', { name: '移除 CURSOR_API_KEY', exact: true }).count()).toBe(0)
      await settings.getByRole('button', { name: '移除', exact: true }).click()
      const remove = page.getByRole('dialog', { name: '移除账号', exact: true })
      await remove.getByText('从 Latch 移除「Cursor · 工作」？此账号在这台 Mac 上保存的 API 密钥也会删除。', { exact: true }).waitFor()
      await remove.getByRole('button', { name: '移除', exact: true }).click()
      await expect.poll(async () => (await snapshot()).catalog?.harnesses.some(item => item.id === id)).toBe(false)
      testHost.presence.mode = 'approve'

      await add('Antigravity')
      const enterprise = page.getByRole('dialog', { name: 'Gemini Enterprise 账号', exact: true })
      await enterprise.getByLabel('账号名称', { exact: true }).fill('工作')
      await enterprise.getByText(/Gemini Enterprise 应用默认凭据/u).waitFor()
      for (const width of [390, 820, 1440]) {
        await resize(width)
        await noHorizontalOverflow(page)
        await capture(page, `antigravity-account-${width}`)
      }
      const directoryField = enterprise.getByLabel('ADC 凭据目录', { exact: true })
      await directoryField.fill(directory)
      const beforeDirectory = testHost.presence.requests.length
      await dropAccountSaveResponse(page)
      await enterprise.getByRole('button', { name: '添加账号', exact: true }).click()
      await enterprise.getByText('添加结果未知。重试会检查此账号是否已保存。', { exact: true }).waitFor()
      expect(await directoryField.isEditable()).toBe(false)
      expect(await enterprise.getByLabel('账号名称', { exact: true }).isEditable()).toBe(false)
      await enterprise.getByRole('button', { name: '重试添加', exact: true }).click()
      const saved = settings.getByRole('heading', { name: 'Antigravity · 工作', exact: true })
      await saved.waitFor()
      expect(testHost.presence.requests).toHaveLength(beforeDirectory + 1)
      expect((await snapshot()).catalog?.harnesses.filter(item => item.presetId === 'antigravity' && item.account)).toHaveLength(1)
      expect(await settings.getByRole('button', { name: '退出登录', exact: true }).count()).toBe(0)
      expect(existsSync(adc)).toBe(true)
    } finally {
      await application?.close()
      await testHost.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('folds named accounts under one brand without changing their independent settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-account-disclosure-'))
    const bin = join(root, 'bin')
    await mkdir(bin)
    for (const [command, version] of [
      ['codex', '0.156.0'],
      ['agy', '1.5.8'],
    ] as const) {
      await writeFile(
        join(bin, command),
        `#!/bin/sh\nexport FAKE_ACP_CLI_VERSION='${version}'\nexec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"\n`,
        { mode: 0o755 },
      )
    }
    const testHost = await startTestHost({
      demo: false,
      hostName: '测试执行电脑',
      detectPreset: preset =>
        ['antigravity', 'codex'].includes(preset.id) ? { found: true, path: join(bin, preset.command) } : { found: false },
      commandDirectories: () => [bin],
    })
    let application: ElectronApplication | undefined
    let browser: Browser | undefined
    const names = ['个人', '工作']
    try {
      const owner = await testHost.enroll({ listener: 'unix', name: 'Owner' })
      const accounts: AgentSettings[] = []
      for (const [index, name] of names.entries()) {
        const accountDirectory = join(root, `account-${index + 1}`)
        await mkdir(accountDirectory)
        const { agent } = await owner.confirmedJson<{ agent: AgentSettings }>('agents', {
          body: { name: `Codex · ${name}`, presetId: 'codex', command: 'codex', args: [], accountDirectory },
        })
        accounts.push(agent)
      }
      expect(
        (await owner.confirmed('agents', { body: { name: 'Antigravity', presetId: 'antigravity', command: 'agy', args: [], env: {} } }))
          .status,
      ).toBe(201)
      const enabled = async () => {
        const { agents } = await owner.json<{ agents: AgentSettings[] }>('agents?recheck=0')
        return accounts.map(account => agents.find(agent => agent.id === account.id)?.enabled)
      }
      const openAccounts = async (page: Page) => {
        await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
        const settings = await openSettings(page)
        await openSection(settings, 'Harness')
        const group = settings.getByRole('button', { name: 'Codex，2 个账号', exact: true })
        await group.waitFor()
        expect(await group.count()).toBe(1)
        expect(await group.getAttribute('aria-expanded')).toBe('true')
        const children = settings.locator(`[id=${JSON.stringify(await group.getAttribute('aria-controls'))}]`)
        const editors = names.map(name => children.getByRole('button', { name: `编辑 Codex · ${name}`, exact: true }))
        for (const [index, editor] of editors.entries()) {
          await editor.getByText(names[index], { exact: true }).waitFor()
        }
        const defaultLaunch = children.getByRole('button', { name: /^Codex · 默认启动方式，已找到/u })
        await defaultLaunch.waitFor()
        const brandStart = await titleStart(group)
        const accountStarts = await Promise.all([...editors, defaultLaunch].map(titleStart))
        expect(accountStarts).toEqual([brandStart, brandStart, brandStart])
        const ruleStarts = await children.locator('.agent-row + .agent-row').evaluateAll(rows =>
          rows.map(row => {
            const rule = getComputedStyle(row, '::before')
            return rule.content === 'none' ? null : row.getBoundingClientRect().left + Number.parseFloat(rule.left)
          }),
        )
        expect(ruleStarts).toEqual([brandStart, brandStart])
        const singleton = settings.getByRole('button', { name: '编辑 Antigravity', exact: true })
        await singleton.waitFor()
        expect(await singleton.getAttribute('aria-expanded')).toBeNull()
        return { settings, group, children, editors, singleton }
      }
      const shot = async (page: Page, surface: string, state: 'expanded' | 'collapsed') => {
        await page.evaluate(() => document.fonts.ready.then(() => undefined))
        await page.mouse.move(0, 0)
        await noHorizontalOverflow(page)
        await capture(page, `codex-account-settings-${surface}-${state}`)
      }

      application = await launch(testHost, root)
      const page = await application.firstWindow()
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
      page.setDefaultTimeout(20_000)
      await page.waitForFunction(() => innerWidth === 1440)
      await page.getByRole('button', { name: '继续', exact: true }).click()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      await page.evaluate(() => {
        document.documentElement.dataset.capture = 'still'
      })
      const { settings, group, children, editors, singleton } = await openAccounts(page)
      await shot(page, 'desktop', 'expanded')
      await settings.locator('.settings-card', { has: page.getByRole('button', { name: 'Codex，2 个账号', exact: true }) }).screenshot({
        path: `${OUTPUT}/codex-account-settings-text-aligned.png`,
        animations: 'disabled',
        scale: 'css',
      })
      await group.click()
      for (const editor of editors) await editor.waitFor({ state: 'hidden' })
      await shot(page, 'desktop', 'collapsed')
      await group.press('Space')
      expect(await group.getAttribute('aria-expanded')).toBe('true')
      await group.press('Space')
      expect(await group.getAttribute('aria-expanded')).toBe('false')
      for (const editor of editors) await editor.waitFor({ state: 'hidden' })
      for (const name of names) {
        await children.getByRole('switch', { name: `启用 Codex · ${name}`, exact: true }).waitFor({ state: 'hidden' })
      }
      expect(await enabled()).toEqual([true, true])
      expect(await group.evaluate(button => button === document.activeElement)).toBe(true)
      await captureAccountFocus(page, group, singleton, 'desktop')
      await group.press('Space')
      expect(await group.getAttribute('aria-expanded')).toBe('true')
      for (const [index, name] of names.entries()) {
        const toggle = settings.getByRole('switch', { name: `启用 Codex · ${name}`, exact: true })
        const editor = settings.getByRole('button', { name: `编辑 Codex · ${name}`, exact: true })
        await reachable(toggle)
        await toggle.click()
        await expect.poll(enabled).toEqual(accounts.map((_, position) => position !== index))
        await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false')
        await reachable(editor)
        await editor.click()
        await settings.getByRole('heading', { name: `Codex · ${name}`, exact: true }).waitFor()
        const detailSwitch = settings.getByRole('switch', { name: '启用', exact: true })
        expect(await detailSwitch.getAttribute('aria-checked')).toBe('false')
        await detailSwitch.click()
        await expect.poll(enabled).toEqual([true, true])
        await backToSection(settings)
        await group.waitFor()
        expect(await group.getAttribute('aria-expanded')).toBe('true')
      }
      await application.close()
      application = undefined

      browser = await chromium.launch(browserLaunchOptions())
      for (const viewport of VISUAL_VIEWPORTS.filter(item => item.touch)) {
        const context = await visualContext(browser, viewport)
        try {
          const screen = await context.newPage()
          await enrollBrowser(screen, testHost, { scopes: ['view', 'run', 'admin'] })
          const { group: touchGroup, editors: touchEditors, singleton: touchSingleton } = await openAccounts(screen)
          await shot(screen, viewport.name, 'expanded')
          await reachable(touchGroup)
          await touchGroup.click()
          expect(await touchGroup.getAttribute('aria-expanded')).toBe('false')
          for (const editor of touchEditors) await editor.waitFor({ state: 'hidden' })
          await shot(screen, viewport.name, 'collapsed')
          if (viewport.name === 'phone') {
            await touchGroup.press('Space')
            await touchGroup.press('Space')
            for (const editor of touchEditors) await editor.waitFor({ state: 'hidden' })
            await captureAccountFocus(screen, touchGroup, touchSingleton, viewport.name)
          }
          await touchGroup.click()
          for (const editor of touchEditors) await reachable(editor)
          expect(await enabled()).toEqual([true, true])
        } finally {
          await context.close()
        }
      }
    } finally {
      await browser?.close()
      await application?.close()
      await testHost.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
