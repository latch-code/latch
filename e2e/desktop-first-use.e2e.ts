import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import type { AppSnapshot, AgentSettings, TaskDetail } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { backToPhoneSessions, closeSettings, noHorizontalOverflow, openSection, openSettings, reachable } from './helpers/layout.ts'

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
async function resize(application: ElectronApplication, page: Page, width: number) {
  await application.evaluate(({ BrowserWindow }, width) => {
    const window = BrowserWindow.getAllWindows()[0]!
    window.setMinimumSize(320, 400)
    window.setSize(width, 1000)
  }, width)
  await page.waitForFunction(width => innerWidth === width, width)
  await page.emulateMedia({ colorScheme: width === 900 ? 'dark' : 'light', reducedMotion: 'reduce' })
}
async function enroll(page: Page) {
  page.setDefaultTimeout(15_000)
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await page.locator('.app-shell[data-connection="connected"]').waitFor()
}
async function startNew(page: Page, width: number) {
  if (width === 390) await backToPhoneSessions(page)
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
        await setup.getByRole('button', { name: /^也可以用 Latch 内置/ }).click()
        await setup.getByRole('region', { name: '添加模型服务', exact: true }).waitFor()
        await setup.getByRole('group', { name: '选择服务', exact: true }).waitFor()
        expect(await page.locator('.settings-page').count()).toBe(0)
        expect(await input.inputValue()).toBe(missingDraft)
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
        await notice.getByRole('button', { name: '在终端里登录' }).click()
        await expect.poll(() => scripts.length).toBe(1)
        await expect.poll(() => existsSync(loginFile)).toBe(true)
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

    it('runs a Harness found on this computer with nothing to add, asking only for the folder', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'latch-electron-found-'))
      const bin = join(directory, 'bin')
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
      const host = await startTestHost({
        demo: false,
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
        const owner = await host.enroll({ listener: 'unix' })
        expect((await owner.json<{ agents: AgentSettings[] }>('agents')).agents).toEqual([])

        // Enter with no folder asks for one and keeps the draft; nothing has been saved or started.
        const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
        await input.fill('修一下测试')
        await input.press('Meta+Enter')
        const open = page.getByRole('menuitemradio', { name: '打开文件夹…' }).or(page.getByRole('option', { name: '打开文件夹…' }))
        await open.waitFor()
        expect(await input.inputValue()).toBe('修一下测试')
        expect((await owner.json<AppSnapshot>('snapshot')).tasks).toHaveLength(0)
        expect((await owner.json<{ agents: AgentSettings[] }>('agents')).agents).toEqual([])

        // A folder the Host refuses says so in the list, at once.
        await application.evaluate(({ BrowserWindow, dialog }, chosen) => {
          dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [chosen] })) as typeof dialog.showOpenDialog
          BrowserWindow.prototype.isFocused = () => true
        }, process.cwd())
        await open.click()
        await page.getByText(/^没有打开 .*不能作为项目$/u).waitFor()

        // The chosen folder is a project at once, named in the question; a list asked for earlier stays shut.
        await application.evaluate(({ dialog }, chosen) => {
          dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [chosen] })) as typeof dialog.showOpenDialog
        }, project)
        await open.click()
        await page.locator('.new-session-title').getByText('rust-learn', { exact: true }).first().waitFor()
        expect(await open.isVisible()).toBe(false)
        await expect.poll(() => input.evaluate(element => element === document.activeElement)).toBe(true)

        // Sending saves the definition and runs what was saved.
        await input.press('Meta+Enter')
        await expect.poll(async () => (await owner.json<{ agents: AgentSettings[] }>('agents')).agents.length).toBe(1)
        expect((await owner.json<{ agents: AgentSettings[] }>('agents')).agents).toMatchObject([{ id: 'codex', presetId: 'codex' }])
        await page.locator('.transcript').getByText('echo: 修一下测试', { exact: true }).waitFor()
        // The first start of this launch in this project says what the Harness can do, and it stays.
        const startNote = page.locator('.session-start-note')
        await startNote
          .getByText('Codex 能读写这台 Mac 上的文件并运行命令。权限是 Codex 自己的设置，Latch 不隔离它。', { exact: true })
          .waitFor()

        // The next start of the same launch here does not repeat it.
        await application.evaluate(({ dialog }) => {
          dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
        })
        await startNew(page, 1440)
        await input.fill('再来一个')
        await input.press('Meta+Enter')
        await page.locator('.transcript').getByText('echo: 再来一个', { exact: true }).waitFor()
        expect(await startNote.count()).toBe(0)

        // 不选项目 works too: a new empty folder, nothing refused.
        await startNew(page, 1440)
        await page.locator('.new-session-title button').first().click()
        await page.getByText('在一个新的空文件夹里开始', { exact: true }).click()
        await input.fill('随便试试')
        await input.press('Meta+Enter')
        await page.locator('.transcript').getByText('echo: 随便试试', { exact: true }).waitFor()
        await noHorizontalOverflow(page)

        // 添加项目 at the sidebar's foot: from a session, a cancel stays put, a refusal says so, a folder starts there.
        const pick = (chosen: string | null) =>
          application!.evaluate(({ dialog }, path) => {
            dialog.showOpenDialog = (async () =>
              path ? { canceled: false, filePaths: [path] } : { canceled: true, filePaths: [] }) as typeof dialog.showOpenDialog
          }, chosen)
        const add = page.getByRole('button', { name: '添加项目', exact: true })
        await pick(null)
        await add.click()
        await page.locator('.transcript').getByText('echo: 随便试试', { exact: true }).waitFor()
        await pick(process.cwd())
        await add.click()
        await page
          .locator('.toast')
          .getByText(/^没有打开 .*不能作为项目$/u)
          .waitFor()
        await page.locator('.transcript').getByText('echo: 随便试试', { exact: true }).waitFor()
        const second = join(directory, 'second')
        await mkdir(second)
        await pick(second)
        await add.click()
        await page.locator('.new-session-title').getByText('second', { exact: true }).first().waitFor()
        await page.locator('#session-navigation').getByText('second', { exact: true }).waitFor()
      } finally {
        await application?.close()
        await host.close()
        await rm(directory, { recursive: true, force: true })
      }
    })

    it('uses actual ACP command updates, template IDs and ranked keyboard insertion without sending at three widths', async () => {
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
            menu = page.getByRole('region', { name: '命令与提示模板', exact: true }),
            list = menu.getByRole('listbox', { name: '命令与提示模板', exact: true })
          await input.fill('/init')
          await list.getByRole('option').filter({ hasText: '/init' }).waitFor()
          await input.press('ArrowDown')
          await input.press('ArrowUp')
          await input.press('Enter')
          expect(await input.inputValue()).toBe('/init ')
          await menu.waitFor({ state: 'detached' })
          await input.fill('/init')
          await input.press('Tab')
          expect(await input.inputValue()).toBe('/init ')
          await expect.poll(() => input.evaluate(element => element === document.activeElement)).toBe(true)
          await input.fill('/review')
          await expect.poll(() => list.getByRole('option').count()).toBe(4)
          expect(await list.getByRole('option').locator('strong').allTextContents()).toEqual(
            templates.map(([id, name]) => '/' + id + ' · ' + name),
          )
          await input.press('ArrowDown')
          expect(await list.getByRole('option').nth(1).getAttribute('aria-selected')).toBe('true')
          await input.press('ArrowUp')
          expect(await list.getByRole('option').nth(0).getAttribute('aria-selected')).toBe('true')
          await input.press('Enter')
          expect(await input.inputValue()).toBe(templates[0][2])
          await input.fill('/检查')
          await list.getByRole('option').filter({ hasText: '/review · 检查改动' }).waitFor()
          await input.press('Tab')
          expect(await input.inputValue()).toBe(templates[0][2])
          await input.fill('/')
          await list.getByRole('group', { name: '提示模板', exact: true }).waitFor()
          await list.getByRole('group', { name: 'Harness 命令', exact: true }).waitFor()
          expect(await list.getByRole('group', { name: '提示模板', exact: true }).getByRole('option').count()).toBe(4)
          expect(await list.getByRole('group', { name: 'Harness 命令', exact: true }).getByRole('option').count()).toBe(1)
          expect(await list.getByRole('group').evaluateAll(groups => groups.map(group => group.getAttribute('aria-label')))).toEqual([
            '提示模板',
            'Harness 命令',
          ])
          for (const option of await list.getByRole('option').all()) await reachable(option)
          await noHorizontalOverflow(page, menu)
          await mkdir('test-results/desktop-first-use', { recursive: true })
          await page.screenshot({ path: `test-results/desktop-first-use/slash-${width}.png`, animations: 'disabled' })
          await input.press('Escape')
          await menu.waitFor({ state: 'detached' })
          expect(await input.inputValue()).toBe('/')
          await input.fill('/not-a-command-9281')
          await menu.getByRole('status').waitFor()
          expect(await menu.getByRole('status').textContent()).toBe('没有匹配的命令或提示模板')
          await input.press('Escape')
          await menu.waitFor({ state: 'detached' })
          expect(await input.inputValue()).toBe('/not-a-command-9281')
          expect(await promptCount()).toBe(1)
          expect(
            (await owner.json<TaskDetail>('tasks/' + sessionId)).messages
              .filter(message => message.role === 'user')
              .map(message => message.text),
          ).toEqual(['plan'])
        }
      } finally {
        await application?.close()
        await host.close()
        await rm(directory, { recursive: true, force: true })
      }
    })
  },
)
