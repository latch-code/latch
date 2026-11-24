import { _electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { AGENT_PRESETS, type AppSnapshot, type AgentSettings, type TaskDetail } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { backToPhoneSessions, closeSettings, noHorizontalOverflow, openSection, openSettings, reachable } from './helpers/layout.ts'
import { promptValue } from './helpers/prompt.ts'

function localProvider(calls = { count: 0 }): HarnessPlugin {
  return {
    id: 'first-use-provider',
    name: '本地验收模型',
    version: '1',
    description: 'A local fake provider only for this test.',
    activate(context) {
      context.registerProvider({
        id: 'first-use-provider',
        name: '本地验收模型',
        model: 'fixture',
        async *stream() {
          calls.count++
          yield { type: 'text', text: '本地假 Provider 已处理第一个实际会话。' }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
}

async function launch(host: TestHost, directory: string): Promise<ElectronApplication> {
  await writeHostState(host.dataDir, {
    version: 2,
    pid: process.pid,
    hostId: host.host.hostId,
    instanceId: host.host.instanceId,
    socketPath: host.host.socketPath,
    loopbackOrigin: host.host.loopbackOrigin,
    tlsOrigin: null,
    startedAt: new Date().toISOString(),
    dataDir: host.dataDir,
  })
  return _electron.launch({
    args: [
      resolve('apps/desktop/src/main.cjs'),
      '--latch-host-state=' + join(host.dataDir, 'host.json'),
      '--latch-user-data=' + directory,
      '--use-mock-keychain',
    ],
    cwd: process.cwd(),
    env: Object.fromEntries(
      Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    timeout: 30_000,
  })
}
async function resize(application: ElectronApplication, page: Page, width: number, height?: number) {
  await application.evaluate(
    ({ BrowserWindow }, { width, height }) => {
      const window = BrowserWindow.getAllWindows()[0]!
      window.setMinimumSize(320, 400)
      if (height === undefined) window.setSize(width, 1000)
      else window.setContentSize(width, height)
    },
    { width, height },
  )
  await page.waitForFunction(({ width, height }) => innerWidth === width && (height === undefined || innerHeight === height), {
    width,
    height,
  })
  await page.emulateMedia({ colorScheme: width === 900 ? 'dark' : 'light', reducedMotion: 'reduce' })
}
function visibleRatio(locator: Locator) {
  return locator.evaluate(
    element =>
      new Promise<number>(done => {
        const observer = new IntersectionObserver(([entry]) => {
          observer.disconnect()
          done(entry!.intersectionRatio)
        })
        observer.observe(element)
      }),
  )
}

async function disclosureFrames(toggle: Locator, key: 'Enter' | 'Space', growAgain?: { closed: number; open: number }) {
  const recorder = await toggle.evaluateHandle((button: HTMLButtonElement, reverseAt) => {
    const card = button.closest('section')!
    const chevron = button.querySelector('.harness-found-chevron')!
    const list = card.querySelector<HTMLElement>('.harness-found-list')
    return {
      result: new Promise<{ heights: number[]; turns: string[]; reversalHeight: number | null; closingListAcceptedFocus: boolean }>(
        done => {
          button.addEventListener(
            'click',
            () => {
              const heights: number[] = []
              const turns: string[] = []
              let reversalHeight: number | null = null
              let closingListAcceptedFocus = false
              const until = performance.now() + 400
              const sample = (now: number) => {
                const height = card.getBoundingClientRect().height
                const { transform, rotate } = getComputedStyle(chevron)
                if (heights.length === 0 && button.getAttribute('aria-expanded') === 'false') {
                  list?.focus({ preventScroll: true })
                  closingListAcceptedFocus = document.activeElement === list
                }
                heights.push(height)
                turns.push(transform + rotate)
                if (reverseAt && reversalHeight === null && height > reverseAt.closed + 5 && height < reverseAt.open - 5) {
                  reversalHeight = height
                  button.click()
                }
                if (now < until) requestAnimationFrame(sample)
                else done({ heights, turns, reversalHeight, closingListAcceptedFocus })
              }
              requestAnimationFrame(sample)
            },
            { once: true },
          )
        },
      ),
    }
  }, growAgain)
  try {
    await toggle.press(key)
    return await recorder.evaluate(state => state.result)
  } finally {
    await recorder.dispose()
  }
}

async function expectImmediateDisclosure(toggle: Locator, list: Locator) {
  const before = await toggle.evaluate(button => {
    const { transform, rotate } = getComputedStyle(button.querySelector('.harness-found-chevron')!)
    return { height: button.closest('section')!.getBoundingClientRect().height, turn: transform + rotate }
  })
  expect(before.height).toBeGreaterThan(0)
  const opening = await disclosureFrames(toggle, 'Enter')
  expect(await toggle.getAttribute('aria-expanded')).toBe('true')
  expect(await list.isVisible()).toBe(true)
  const closing = await disclosureFrames(toggle, 'Space')
  expect(await toggle.getAttribute('aria-expanded')).toBe('false')
  expect(await list.isVisible()).toBe(false)
  expect(opening.heights.at(-1)).toBeGreaterThan(before.height)
  expect(closing.heights.at(-1)).toBe(before.height)
  expect(new Set([...opening.heights, ...closing.heights])).toEqual(new Set([before.height, opening.heights.at(-1)]))
  expect(new Set([...opening.turns, ...closing.turns])).toEqual(new Set([before.turn, opening.turns.at(-1)]))
}
async function enroll(page: Page) {
  page.setDefaultTimeout(15_000)
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await page.locator('.app-shell[data-connection="connected"]').waitFor()
}
async function startNew(page: Page, width: number) {
  if (width === 390) {
    await backToPhoneSessions(page)
  }
  const buttons = page.getByRole('button', { name: '新建会话', exact: true })
  let opened = false
  for (const button of await buttons.all()) {
    if (await button.isVisible()) {
      await button.click()
      opened = true
      break
    }
  }
  expect(opened).toBe(true)
  await page.getByRole('textbox', { name: '新会话消息', exact: true }).waitFor()
}
describe.skipIf(latchEnv(process.env, 'ELECTRON_E2E') !== '1' || process.platform !== 'darwin')(
  'actual desktop first use and slash commands',
  () => {
    it.each([1440, 900, 390])('%s keeps first-use actions in place and completes a real non-demo first session', async width => {
      const directory = await mkdtemp(join(tmpdir(), 'latch-electron-first-use-')),
        calls = { count: 0 },
        provider = localProvider(calls),
        host = await startTestHost({ demo: false, providerId: provider.id, plugins: [provider], detectPreset: () => ({ found: false }) })
      let application: ElectronApplication | undefined
      try {
        const owner = await host.enroll({ listener: 'unix' })
        expect((await owner.json<AppSnapshot>('snapshot')).demo).toBe(false)
        application = await launch(host, join(directory, 'electron'))
        const page = await application.firstWindow()
        await resize(application, page, width)
        await enroll(page)
        if (width === 390) await startNew(page, width)
        const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
        const prompt = '这是通过本地假 Provider 执行的第一个实际任务。'
        await input.fill(prompt)
        await input.press('Meta+Enter')
        await expect.poll(async () => (await owner.json<AppSnapshot>('snapshot')).tasks.length).toBe(1)
        const task = (await owner.json<AppSnapshot>('snapshot')).tasks[0]!
        await expect.poll(async () => (await owner.json<TaskDetail>('tasks/' + task.id)).summary.status).toBe('idle')
        await page.locator('.transcript').getByText('本地假 Provider 已处理第一个实际会话。', { exact: true }).waitFor()
        expect(calls.count).toBe(1)
        expect(
          (await owner.json<TaskDetail>('tasks/' + task.id)).messages
            .filter(message => message.role === 'user')
            .map(message => message.text),
        ).toEqual([prompt])
        await startNew(page, width)
        const missingDraft = '缺少模型时也不能丢掉这份草稿。'
        await input.fill(missingDraft)
        expect((await owner.request('plugins/' + provider.id, { method: 'POST', body: { enabled: false } })).status).toBe(200)
        // Nothing else can run here, so the page says what to install; the built-in Harness is one quiet line.
        const setup = page.getByRole('region', { name: '安装 Harness', exact: true })
        await setup.getByText('没有找到可用的 Harness', { exact: true }).waitFor()
        await setup.getByRole('button', { name: /^改用 Latch 内置/ }).click()
        await setup.getByRole('region', { name: '添加模型服务', exact: true }).waitFor()
        await setup.getByRole('group', { name: '选择服务', exact: true }).waitFor()
        expect(await page.locator('.settings-page').count()).toBe(0)
        expect(await promptValue(input)).toBe(missingDraft)
        expect((await owner.json<AppSnapshot>('snapshot')).tasks).toHaveLength(1)
        expect(calls.count).toBe(1)
        await noHorizontalOverflow(page)
        await mkdir('test-results/desktop-first-use', { recursive: true })
        await page.screenshot({ path: `test-results/desktop-first-use/model-required-${width}.png`, animations: 'disabled' })
      } finally {
        await application?.close()
        await host.close()
        await rm(directory, { recursive: true, force: true })
      }
    })

    it('opens the login command in a terminal on this computer, then goes on with the same words gone', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'latch-electron-login-'))
      const bin = join(directory, 'bin')
      await mkdir(bin)
      const loginFile = join(directory, 'login')
      for (const name of ['codex', 'codex-acp']) {
        await writeFile(
          join(bin, name),
          [
            '#!/bin/sh',
            `export FAKE_ACP_LOGIN_FILE='${loginFile}' FAKE_ACP_MODES=read-only,workspace-write,agent-full-access FAKE_ACP_INITIAL_MODE=read-only FAKE_ACP_CONFIG=options`,
            `exec "${process.execPath}" "${FAKE_ACP_AGENT}" "$@"`,
          ].join('\n'),
        )
        await chmod(join(bin, name), 0o755)
      }
      const project = join(directory, 'rust-learn')
      await mkdir(project)
      const scripts: string[] = []
      const terminal = { fails: false }
      const host = await startTestHost({
        demo: false,
        sessionFolders: true,
        presenceMode: 'manual',
        detectPreset: preset => (preset.id === 'codex' ? { found: true, path: join(bin, 'codex-acp') } : { found: false }),
        loginPrograms: name => (existsSync(join(bin, name)) ? join(bin, name) : undefined),
        commandDirectories: () => [bin],
        // No Latch terminal on this Host (its component is missing), so the login goes to the default terminal app:
        // the path a window without one keeps. The login in Latch's own terminal is `desktop-login-terminal.e2e.ts`.
        terminal: { binary: join(directory, 'no-latch-pty') },
        // Runs the script the terminal would, so what it logs in is what the page then finds.
        loginTerminal: async script => {
          if (terminal.fails) throw new Error('no terminal here')
          scripts.push(script)
          const file = join(directory, `login-${scripts.length}.command`)
          await writeFile(file, script, { mode: 0o700 })
          await promisify(execFile)(file)
        },
      })
      let application: ElectronApplication | undefined
      try {
        application = await launch(host, join(directory, 'electron'))
        const page = await application.firstWindow()
        await resize(application, page, 1440)
        await enroll(page)
        const notice = page.getByRole('status', { name: '登录' })
        await notice.getByText('Codex 还没登录', { exact: true }).waitFor()
        await notice.getByText('codex login', { exact: true }).waitFor()
        expect(await notice.getByText('在这台 Mac 的终端里运行这条命令。').count()).toBe(0)
        await mkdir('test-results/desktop-first-use', { recursive: true })
        await page.screenshot({ path: 'test-results/desktop-first-use/login-draft-1440.png', animations: 'disabled' })

        // A terminal that does not open says what to do instead, and pressing again works.
        terminal.fails = true
        await notice.getByRole('button', { name: '在终端里登录' }).click()
        await notice.getByText('没有打开终端。请自己在终端里运行这条命令。').waitFor()
        terminal.fails = false
        // The stand-in completes the login before the Host replies, so that reply also signals the login cache was cleared.
        const [answered] = await Promise.all([
          page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/login-terminal')),
          notice.getByRole('button', { name: '在终端里登录' }).click(),
        ])
        expect(answered.ok()).toBe(true)
        expect(scripts).toHaveLength(1)
        expect(existsSync(loginFile)).toBe(true)
        expect(scripts[0]).toContain(`'${join(bin, 'codex')}' 'login'`)

        // Coming back to the window is enough.
        await page.evaluate(() => window.dispatchEvent(new Event('focus')))
        await notice.waitFor({ state: 'detached' })
        await noHorizontalOverflow(page)
      } finally {
        await application?.close()
        await host.close()
        await rm(directory, { recursive: true, force: true })
      }
    })

    it('folds what was found to one line, and never lets the list push the input out of a short window', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'latch-electron-found-many-'))
      const bin = join(directory, 'bin')
      await mkdir(bin)
      const adapter = join(bin, 'codex-acp')
      await writeFile(adapter, ['#!/bin/sh', `exec "${process.execPath}" "${FAKE_ACP_AGENT}" "$@"`].join('\n'))
      await chmod(adapter, 0o755)
      const lastPreset = AGENT_PRESETS.at(-1)!
      const upgrade = { need: '夹具需要升级', upgrade: 'latch-test-upgrade' }
      let needsUpgrade = false
      // Every preset found, as on a Mac with many installed: only Codex can run.
      const host = await startTestHost({
        demo: false,
        detectPreset: preset => ({
          found: true,
          path: preset.id === 'codex' ? adapter : join(bin, preset.id),
          ...(needsUpgrade && preset.id === lastPreset.id ? { outdated: upgrade } : {}),
        }),
        commandDirectories: () => [bin],
      })
      let application: ElectronApplication | undefined
      try {
        application = await launch(host, join(directory, 'electron'))
        const page = await application.firstWindow()
        await resize(application, page, 1280, 640)
        await page.emulateMedia({ reducedMotion: 'no-preference' })
        await enroll(page)
        const found = page.getByRole('region', { name: '找到的 Harness', exact: true })
        const summary = `在这台 Mac 上找到 ${AGENT_PRESETS.length} 个 Harness`
        const toggle = found.getByRole('button', { name: summary, exact: true })
        const composer = page.locator('.workbench-home form.composer')
        const list = found.getByRole('list')
        const recheck = found.getByRole('button', { name: '重新检测', exact: true })
        // One line: how many, their marks, and the way to open the list.
        expect(await toggle.getAttribute('aria-expanded')).toBe('false')
        expect(await list.isVisible()).toBe(false)
        const marks = found.locator('.harness-found-marks > :visible')
        expect(await marks.count()).toBeGreaterThan(1)
        expect(await marks.count()).toBeLessThanOrEqual(3)
        expect(await visibleRatio(composer)).toBe(1)
        await mkdir('test-results/desktop-first-use', { recursive: true })
        await page.screenshot({ path: 'test-results/desktop-first-use/found-many-1280x640.png', animations: 'disabled' })
        const closed = (await found.boundingBox())!.height
        const opening = await disclosureFrames(toggle, 'Enter')
        const open = opening.heights.at(-1)!
        expect(opening.heights.some(height => height > closed + 5 && height < open - 5)).toBe(true)
        expect(await toggle.getAttribute('aria-expanded')).toBe('true')
        await recheck.press('Tab')
        expect(await list.evaluate(element => element === document.activeElement)).toBe(true)
        expect(await visibleRatio(composer)).toBe(1)
        await noHorizontalOverflow(page)
        await page.screenshot({ path: 'test-results/desktop-first-use/found-many-open-1280x640.png', animations: 'disabled' })

        const closing = await disclosureFrames(toggle, 'Space')
        expect(closing.heights.some(height => height > closed + 5 && height < open - 5)).toBe(true)
        expect(closing.closingListAcceptedFocus).toBe(false)
        expect(await toggle.getAttribute('aria-expanded')).toBe('false')
        expect(await list.isVisible()).toBe(false)
        await toggle.click()
        await expect.poll(async () => (await found.boundingBox())!.height).toBe(open)
        const reversed = await disclosureFrames(toggle, 'Space', { closed, open })
        expect(reversed.reversalHeight).not.toBeNull()
        expect(Math.min(...reversed.heights)).toBeGreaterThan(closed)
        expect(reversed.heights.at(-1)).toBe(open)
        expect(await toggle.getAttribute('aria-expanded')).toBe('true')
        expect(await list.isVisible()).toBe(true)

        // At a shorter height the rows scroll, but the card, its header and the composer stay whole.
        await resize(application, page, 1280, 480)
        expect(await visibleRatio(found), 'the card fits inside its scrolling ancestors').toBe(1)
        expect(await visibleRatio(composer)).toBe(1)
        const titlebar = (await page.locator('.app-shell > .titlebar').boundingBox())!
        expect((await found.boundingBox())!.y, 'the card starts below the title bar').toBeGreaterThanOrEqual(titlebar.y + titlebar.height)
        expect(await toggle.getAttribute('aria-expanded')).toBe('true')
        expect(await marks.count()).toBe(0)
        const rows = list.getByRole('listitem')
        expect(await rows.count()).toBe(AGENT_PRESETS.length)
        const lastRow = rows.last()
        await lastRow.getByText(lastPreset.name, { exact: true }).waitFor()
        expect(await list.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0)
        expect(await visibleRatio(lastRow)).toBeLessThan(1)
        const header = found.locator('.harness-found-head')
        const headerBeforeScroll = await header.boundingBox()
        await list.hover()
        await page.mouse.wheel(0, 1000)
        await expect.poll(() => visibleRatio(lastRow)).toBe(1)
        expect(await list.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
        expect(await header.boundingBox()).toEqual(headerBeforeScroll)
        expect(await visibleRatio(found)).toBe(1)
        expect(await visibleRatio(composer)).toBe(1)

        // A fresh check can show an upgrade action in a row, and the card still folds from its header.
        needsUpgrade = true
        await recheck.click()
        await lastRow.getByText('需要升级', { exact: true }).waitFor()
        await lastRow.getByRole('button', { name: `怎么升级 ${lastPreset.name}`, exact: true }).click()
        await lastRow.getByText(upgrade.upgrade, { exact: true }).waitFor()
        await toggle.click()
        expect(await toggle.getAttribute('aria-expanded')).toBe('false')
        await list.waitFor({ state: 'hidden' })
        expect(await marks.count()).toBeGreaterThan(1)
        expect(await visibleRatio(composer)).toBe(1)

        // The system and the device setting each remove both the height animation and the arrow's turn.
        await expectImmediateDisclosure(toggle, list)
        await page.emulateMedia({ reducedMotion: 'no-preference' })
        const settings = await openSettings(page)
        await openSection(settings, '外观')
        await settings.getByRole('radiogroup', { name: '动效', exact: true }).getByRole('radio', { name: '减弱', exact: true }).click()
        await page.locator('html[data-motion="reduce"]').waitFor({ state: 'attached' })
        await closeSettings(settings)
        await reachable(toggle)
        await expectImmediateDisclosure(toggle, list)
      } finally {
        await application?.close()
        await host.close()
        await rm(directory, { recursive: true, force: true })
      }
    })

    it('saves a detected DeepSeek Harness and reads its models and thinking on the first opening of the model panel', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'latch-electron-dsh-list-'))
      const bin = join(directory, 'bin'),
        program = join(bin, 'dsh'),
        log = join(directory, 'dsh.log')
      await mkdir(bin)
      await writeFile(
        program,
        [
          '#!/bin/sh',
          'if [ "$1" = "--version" ]; then echo "0.2.2-rc.1"; exit 0; fi',
          'export FAKE_ACP_CONFIG=options FAKE_ACP_PROCESS_MODE=1 FAKE_ACP_MODES=read-only,workspace-write,danger-full-access FAKE_ACP_INITIAL_MODE=read-only',
          `export FAKE_ACP_LOG='${log}' FAKE_ACP_STATE='${join(directory, 'state.json')}' DSH_HOME='${join(directory, 'dsh-home')}'`,
          `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`,
        ].join('\n'),
        { mode: 0o755 },
      )
      const host = await startTestHost({
        demo: false,
        hostName: '验收电脑',
        detectPreset: preset => (preset.id === 'dsh' ? { found: true, path: program } : { found: false }),
        commandDirectories: () => [bin],
      })
      let application: ElectronApplication | undefined
      try {
        const owner = await host.enroll({ listener: 'unix' })
        application = await launch(host, join(directory, 'electron'))
        const page = await application.firstWindow()
        await resize(application, page, 1440)
        await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
        page.setDefaultTimeout(15_000)
        await page.getByRole('button', { name: '继续', exact: true }).click()
        await page.getByRole('button', { name: /^Harness：DeepSeek Harness/u }).waitFor()
        const agents = () => owner.json<{ agents: AgentSettings[] }>('agents').then(result => result.agents)
        expect(await agents()).toEqual([])
        const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
        await input.fill('先选模型')
        const picker = page
          .getByRole('button', { name: /^模型：/u })
          .filter({ visible: true })
          .first()
        await picker.click()
        const menu = page.locator('.ui-board').filter({ visible: true })
        await menu.getByRole('menuitemradio', { name: /^Large/u }).waitFor()
        await menu.getByRole('menuitemradio', { name: /^High/u }).waitFor()
        expect(await agents()).toMatchObject([{ id: 'dsh', presetId: 'dsh' }])
        const events = async () =>
          (await readFile(log, 'utf8'))
            .split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line) as { event: string; method?: string })
        expect((await events()).filter(entry => entry.method === 'session/new')).toHaveLength(1)
        expect((await events()).some(entry => entry.method === 'session/prompt')).toBe(false)
        expect((await owner.json<AppSnapshot>('snapshot')).tasks).toEqual([])
        expect(await promptValue(input)).toBe('先选模型')
        await mkdir('test-results/desktop-first-use', { recursive: true })
        await page.screenshot({
          path: 'test-results/desktop-first-use/deepseek-first-model-open-dark.png',
          animations: 'disabled',
          scale: 'css',
        })
        await page.keyboard.press('Escape')
        await picker.click()
        await menu.getByText('刷新模型列表', { exact: true }).waitFor()
        expect((await events()).filter(entry => entry.method === 'session/new')).toHaveLength(1)
      } finally {
        await application?.close()
        await host.close()
        await rm(directory, { recursive: true, force: true })
      }
    })

    it('runs a Harness found on this computer with nothing to add, asking only for the folder', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'latch-electron-found-'))
      const bin = join(directory, 'installed-harness-adapters-on-this-computer')
      await mkdir(bin)
      const adapter = join(bin, 'codex-acp')
      await writeFile(
        adapter,
        [
          '#!/bin/sh',
          'export FAKE_ACP_MODES=read-only,workspace-write,agent-full-access FAKE_ACP_INITIAL_MODE=read-only FAKE_ACP_CONFIG=options',
          `exec "${process.execPath}" "${FAKE_ACP_AGENT}" "$@"`,
        ].join('\n'),
      )
      await chmod(adapter, 0o755)
      const project = join(directory, 'rust-learn')
      await mkdir(project)
      const codeRoot = join(directory, 'latch-program')
      await mkdir(codeRoot)
      const host = await startTestHost({
        demo: false,
        codeRoot,
        sessionFolders: true,
        presenceMode: 'manual',
        // Only this adapter is found, whatever is installed on the machine running the test.
        detectPreset: preset => (preset.id === 'codex' ? { found: true, path: adapter } : { found: false }),
        commandDirectories: () => [bin],
      })
      let application: ElectronApplication | undefined
      try {
        application = await launch(host, join(directory, 'electron'))
        const page = await application.firstWindow()
        await resize(application, page, 1440)
        page.setDefaultTimeout(15_000)
        await page.getByRole('button', { name: '继续', exact: true }).click()
        await page.locator('.app-shell[data-connection="connected"]').waitFor()
        await page.getByRole('button', { name: /^Harness：Codex/ }).waitFor()
        expect(await page.locator('.setup-card').count()).toBe(0)
        // The first open lists only what was found, with the file the Host found; what is not installed is in settings.
        const found = page.getByRole('region', { name: '找到的 Harness', exact: true })
        const toggle = found.getByRole('button', { name: '在这台 Mac 上找到 1 个 Harness', exact: true })
        await toggle.click()
        expect(await toggle.getAttribute('aria-expanded')).toBe('true')
        const list = found.getByRole('list')
        const codexRow = list.getByRole('listitem').filter({ hasText: 'Codex' })
        const path = codexRow.locator('code')
        await path.waitFor()
        expect(await codexRow.getByText('已找到', { exact: true }).count()).toBe(0)
        // A long path is shortened in the middle; the whole of it is the row's tooltip.
        expect(await path.textContent()).toMatch(/….*\/codex-acp$/u)
        expect(await path.getAttribute('title')).toBe(adapter)
        expect(await list.getByRole('listitem').count()).toBe(1)
        expect(await list.evaluate(element => element.scrollHeight - element.clientHeight)).toBe(0)
        await noHorizontalOverflow(page)
        await mkdir('test-results/desktop-first-use', { recursive: true })
        await page.screenshot({ path: 'test-results/desktop-first-use/found-1440.png', animations: 'disabled' })
        const owner = await host.enroll({ listener: 'unix' })
        expect((await owner.json<{ agents: AgentSettings[] }>('agents')).agents).toEqual([])

        // Nothing asks for a folder before sending: the headline asks 想做什么？, and 选一个项目 under it opens the list.
        // The draft stays; nothing has been saved or started.
        const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
        await input.fill('修一下测试')
        const place = page.locator('.workbench-home .home-headline')
        expect(await place.innerText()).toContain('想做什么？')
        expect(await page.getByText('选择项目', { exact: true }).count()).toBe(0)
        await place.getByRole('button', { name: /^项目：/u }).click()
        const open = page.getByRole('menuitem', { name: '添加项目…', exact: true })
        await open.waitFor()
        expect(await promptValue(input)).toBe('修一下测试')
        expect((await owner.json<AppSnapshot>('snapshot')).tasks).toHaveLength(0)
        expect((await owner.json<{ agents: AgentSettings[] }>('agents')).agents).toEqual([])

        // The Host's data folder remains protected; the refusal keeps the draft in place.
        await application.evaluate(({ BrowserWindow, dialog }, chosen) => {
          dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [chosen] })) as typeof dialog.showOpenDialog
          BrowserWindow.prototype.isFocused = () => true
        }, host.dataDir)
        await open.click()
        const projectMenu = page.getByRole('menu', { name: '项目', exact: true })
        expect(await projectMenu.count()).toBe(1)
        await projectMenu.getByText(/^没有打开 .*不能添加到项目的目录重叠。$/u).waitFor()
        expect(await promptValue(input)).toBe('修一下测试')

        // The chosen folder is a project at once, named in the question; a list asked for earlier stays shut.
        await application.evaluate(({ dialog }, chosen) => {
          dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [chosen] })) as typeof dialog.showOpenDialog
        }, project)
        await open.click()
        await page.locator('.home-headline').getByText('rust-learn', { exact: true }).first().waitFor()
        // Shut by the choice, not opened again: the title can name the project while the list still fades out.
        expect(await page.locator('.home-headline [aria-haspopup]').first().getAttribute('aria-expanded')).toBe('false')
        await open.waitFor({ state: 'hidden' })
        await expect.poll(() => input.evaluate(element => element === document.activeElement)).toBe(true)

        // Sending saves the preset's definition and runs it: the person installed it, so nothing asks.
        const asked = host.presence.requests.length
        await input.press('Meta+Enter')
        await expect.poll(async () => (await owner.json<{ agents: AgentSettings[] }>('agents')).agents.length).toBe(1)
        expect((await owner.json<{ agents: AgentSettings[] }>('agents')).agents).toMatchObject([{ id: 'codex', presetId: 'codex' }])
        await page.locator('.transcript').getByText('echo: 修一下测试', { exact: true }).waitFor()
        expect(host.presence.requests).toHaveLength(asked)
        expect(await found.count()).toBe(0)
        // That Latch does not isolate it and what it can do is the reply's mark and name's tooltip, on every session.
        expect(await page.locator('.transcript .assistant-meta-who + [role="tooltip"]').first().textContent()).toBe(
          'Latch 不隔离 Codex。Codex 能读写这台 Mac 上的文件并运行命令。权限是 Codex 自己的设置。',
        )
        expect(await page.locator('.session-start-note').count()).toBe(0)

        // The next session has no row for it either.
        await application.evaluate(({ dialog }) => {
          dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
        })
        await startNew(page, 1440)
        await input.fill('再来一个')
        await input.press('Meta+Enter')
        await page.locator('.transcript').getByText('echo: 再来一个', { exact: true }).waitFor()
        expect(await page.locator('.session-start-note').count()).toBe(0)

        // 不选项目 works too: a new empty folder, nothing refused.
        await startNew(page, 1440)
        await place.getByRole('button', { name: /^项目：/u }).click()
        await page.getByText('Codex 在一个新的空文件夹里开始', { exact: true }).click()
        await input.fill('随便试试')
        await input.press('Meta+Enter')
        await page.locator('.transcript').getByText('echo: 随便试试', { exact: true }).waitFor()
        await noHorizontalOverflow(page)

        // 添加项目, the ＋ beside the sidebar's 项目 heading: from a session, a cancel stays put, a refusal says so, a
        // folder starts there.
        const pick = (chosen: string | null) =>
          application!.evaluate(({ dialog }, path) => {
            dialog.showOpenDialog = (async () =>
              path ? { canceled: false, filePaths: [path] } : { canceled: true, filePaths: [] }) as typeof dialog.showOpenDialog
          }, chosen)
        expect(await page.locator('.sidebar-add-project').count()).toBe(0)
        const add = page.locator('.sidebar-group-label').getByRole('button', { name: '添加项目', exact: true })
        await pick(null)
        await add.click()
        await page.locator('.transcript').getByText('echo: 随便试试', { exact: true }).waitFor()
        await pick(host.dataDir)
        await add.click()
        await page
          .locator('.toast')
          .getByText(/^没有打开 .*不能添加到项目的目录重叠。$/u)
          .waitFor()
        await page.locator('.transcript').getByText('echo: 随便试试', { exact: true }).waitFor()
        // A program folder explicitly chosen in the native picker is a usable project, with a warning before sending.
        await pick(codeRoot)
        await add.click()
        await place.getByText('latch-program', { exact: true }).first().waitFor()
        await page.locator('#session-navigation').getByText('latch-program', { exact: true }).waitFor()
        await page
          .locator('.composer-notice')
          .getByText('正在开发当前运行的 Latch，构建或重启可能影响当前使用。', { exact: true })
          .waitFor()
        const before = host.presence.requests.length
        await input.fill('检查 Latch 源码')
        const submitted = page.waitForResponse(
          response => response.url().endsWith('/link/api/tasks') && response.request().method() === 'POST',
        )
        await input.press('Meta+Enter')
        const response = await submitted
        expect(response.status()).toBe(201)
        const { sessionId } = (await response.json()) as { sessionId: string }
        await page.locator('.transcript').getByText('echo: 检查 Latch 源码', { exact: true }).waitFor()
        expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.cwd).toBe(await realpath(codeRoot))
        expect(host.presence.requests).toHaveLength(before)
      } finally {
        await application?.close()
        await host.close()
        await rm(directory, { recursive: true, force: true })
      }
    })

    it('uses actual ACP command updates and ranked Tab insertion without sending, then executes Enter once', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'latch-electron-slash-')),
        provider = localProvider(),
        host = await startTestHost({ demo: false, providerId: provider.id, plugins: [provider] }),
        agentLog = join(directory, 'agent.ndjson')
      let application: ElectronApplication | undefined
      try {
        const owner = await host.enroll({ listener: 'unix' }),
          added = await owner.confirmed('agents', {
            method: 'POST',
            body: { name: '命令验收 Harness', command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_LOG: agentLog } },
          })
        expect(added.status).toBe(201)
        const agent = ((await added.json()) as { agent: AgentSettings }).agent,
          started = await owner.confirmed('tasks', {
            method: 'POST',
            body: { prompt: 'plan', harnessId: agent.id, requestId: randomUUID() },
          })
        expect(started.status).toBe(201)
        const sessionId = ((await started.json()) as { sessionId: string }).sessionId
        await expect.poll(async () => (await owner.json<TaskDetail>('tasks/' + sessionId)).summary.status).toBe('idle')
        expect((await owner.json<TaskDetail>('tasks/' + sessionId)).commands).toEqual([{ name: 'init', description: 'init' }])
        const templates = [
          ['review', '检查改动', '阅读改动，并解释结果。'],
          ['review-notes', '整理评审笔记', '整理这些笔记。'],
          ['code-review', '代码核对', '核对代码。'],
          ['prereview', '准备审阅', '准备审阅材料。'],
        ] as const
        for (const [id, name, content] of templates)
          await owner.json('prompts/' + id, { method: 'PUT', body: { id, name, content, scope: { kind: 'all' } } })
        const promptCount = async () =>
          (await readFile(agentLog, 'utf8'))
            .split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line) as { event: string; method?: string })
            .filter(event => event.event === 'recv' && event.method === 'session/prompt').length
        expect(await promptCount()).toBe(1)
        application = await launch(host, join(directory, 'electron'))
        const page = await application.firstWindow()
        await resize(application, page, 1440)
        await enroll(page)
        await page.locator(`[data-task-id="${sessionId}"]`).click()
        for (const width of [1440, 900, 390]) {
          await resize(application, page, width)
          const input = page.getByRole('textbox', { name: '继续对话', exact: true }),
            menu = page.locator('.ui-suggest:popover-open'),
            list = menu.getByRole('listbox', { name: '命令与提示模板', exact: true })
          await input.fill('/init')
          await list.getByRole('option').filter({ hasText: '/init' }).waitFor()
          await input.press('ArrowDown')
          await input.press('ArrowUp')
          await input.press('Tab')
          expect(await promptValue(input)).toBe('/init ')
          await menu.waitFor({ state: 'hidden' })
          await input.fill('')
          await input.fill('/init')
          await list.getByRole('option').filter({ hasText: '/init' }).waitFor()
          await input.press('Tab')
          expect(await promptValue(input)).toBe('/init ')
          await expect.poll(() => input.evaluate(element => element === document.activeElement)).toBe(true)
          await input.fill('/review')
          await expect.poll(() => list.getByRole('option').count()).toBe(4)
          expect(await list.getByRole('option').locator('.ui-suggest-label').allTextContents()).toEqual(
            templates.map(([id, name]) => '/' + id + ' · ' + name),
          )
          await input.press('ArrowDown')
          expect(await list.getByRole('option').nth(1).getAttribute('aria-selected')).toBe('true')
          await input.press('ArrowUp')
          expect(await list.getByRole('option').nth(0).getAttribute('aria-selected')).toBe('true')
          await input.press('Enter')
          expect(await promptValue(input)).toBe(templates[0][2])
          await input.fill('/检查')
          await list.getByRole('option').filter({ hasText: '/review · 检查改动' }).waitFor()
          await input.press('Tab')
          expect(await promptValue(input)).toBe(templates[0][2])
          await input.fill('/')
          await list.getByRole('group', { name: '提示模板', exact: true }).waitFor()
          await list.getByRole('group', { name: '命令验收 Harness', exact: true }).waitFor()
          expect(await list.getByRole('group', { name: '提示模板', exact: true }).getByRole('option').count()).toBe(4)
          const native = list.getByRole('group', { name: '命令验收 Harness', exact: true })
          expect(await native.getByRole('option').locator('.ui-suggest-label').allTextContents()).toEqual(['/init', '/compact'])
          const compact = native.getByRole('option').filter({ hasText: '/compact' })
          expect(await compact.getAttribute('aria-disabled')).toBe('true')
          expect(await compact.locator('.ui-suggest-description').textContent()).toBe('这个 Harness 尚不支持')
          // Native commands, templates and Latch actions retain their own sources; recent insertions come first.
          const actions = list.getByRole('group', { name: 'Latch', exact: true }).getByRole('option')
          expect((await actions.locator('.ui-suggest-label').allTextContents()).toSorted()).toEqual(
            ['/clear', '/btw', '/fork', '/new', '/model', '/think', '/permissions', '/changes'].toSorted(),
          )
          const disabled = await actions.evaluateAll(rows => rows.map(row => row.getAttribute('aria-disabled') === 'true'))
          expect(disabled).toEqual(disabled.toSorted((a, b) => Number(a) - Number(b)))
          expect(await list.getByRole('group').evaluateAll(groups => groups.map(group => group.getAttribute('aria-label')))).toEqual([
            '最近',
            '命令验收 Harness',
            '提示模板',
            'Latch',
          ])
          // /btw is listed where the session cannot fork into a side question, disabled with its reason.
          expect(
            await list
              .getByRole('group', { name: 'Latch', exact: true })
              .getByRole('option')
              .filter({ hasText: '/btw' })
              .getAttribute('aria-disabled'),
          ).toBe('true')
          for (const option of await list.getByRole('option').all()) {
            const disabled = (await option.getAttribute('aria-disabled')) === 'true'
            if (disabled) expect((await option.locator('.ui-suggest-description').textContent())?.trim()).not.toBe('')
            await reachable(option, { allowDisabled: disabled })
          }
          await noHorizontalOverflow(page, menu)
          await mkdir('test-results/desktop-first-use', { recursive: true })
          await page.screenshot({ path: `test-results/desktop-first-use/slash-${width}.png`, animations: 'disabled' })
          await input.press('Escape')
          await menu.waitFor({ state: 'hidden' })
          expect(await promptValue(input)).toBe('/')
          await input.fill('/not-a-command-9281')
          await menu.getByRole('status').waitFor()
          expect(await menu.getByRole('status').textContent()).toBe('没有「/not-a-command-9281」· Enter 原样发给 命令验收 Harness')
          await input.press('Escape')
          await menu.waitFor({ state: 'hidden' })
          expect(await promptValue(input)).toBe('/not-a-command-9281')
          expect(await promptCount()).toBe(1)
          expect(
            (await owner.json<TaskDetail>('tasks/' + sessionId)).messages
              .filter(message => message.role === 'user')
              .map(message => message.text),
          ).toEqual(['plan'])
        }
        const input = page.getByRole('textbox', { name: '继续对话', exact: true })
        await input.fill('/init')
        await page.getByRole('listbox', { name: '命令与提示模板', exact: true }).getByRole('option').filter({ hasText: '/init' }).waitFor()
        await input.press('Enter')
        await expect.poll(promptCount).toBe(2)
        await expect.poll(async () => (await owner.json<TaskDetail>('tasks/' + sessionId)).summary.status).toBe('idle')
        expect(
          (await owner.json<TaskDetail>('tasks/' + sessionId)).messages
            .filter(message => message.role === 'user')
            .map(message => message.text),
        ).toEqual(['plan', '/init'])
      } finally {
        await application?.close()
        await host.close()
        await rm(directory, { recursive: true, force: true })
      }
    })
  },
)
