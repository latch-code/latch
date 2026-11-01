import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
async function enroll(page: Page, name: string) {
  page.setDefaultTimeout(15_000)
  await page.getByRole('textbox', { name: '设备名称', exact: true }).fill(name)
  await page.getByRole('button', { name: '请求本机确认', exact: true }).click()
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
        host = await startTestHost({ demo: false, providerId: provider.id, plugins: [provider] })
      let application: ElectronApplication | undefined
      try {
        const owner = await host.enroll({ listener: 'unix' })
        expect((await owner.json<AppSnapshot>('snapshot')).demo).toBe(false)
        application = await launch(host, join(directory, 'electron'))
        const page = await application.firstWindow()
        await resize(application, page, width)
        await enroll(page, '首次使用 ' + width)
        if (width === 390) await startNew(page, width)
        const guide = page.getByRole('region', { name: '开始使用', exact: true }),
          input = page.getByRole('textbox', { name: '新会话消息', exact: true }),
          draft = '选择 Agent 的时候保留这一份尚未发送的草稿。'
        await input.fill(draft)
        if (width === 390) {
          // The phone uses the actual new-session sheet, which does not claim to render desktop onboarding.
          expect(await guide.count()).toBe(0)
          await page.getByRole('dialog', { name: '新会话', exact: true }).getByRole('button', { name: '添加 Agent', exact: true }).click()
        } else {
          await guide.waitFor()
          expect(await guide.locator(':scope > div').count()).toBe(3)
          await guide
            .locator(':scope > div')
            .filter({ hasText: '选择 Agent 与模型' })
            .getByRole('button', { name: '更换', exact: true })
            .click()
        }
        const agents = page.getByRole('group', { name: '添加 Agent', exact: true })
        await agents.waitFor()
        expect(await page.locator('.settings-page').count()).toBe(0)
        expect(await input.inputValue()).toBe(draft)
        expect((await owner.json<AppSnapshot>('snapshot')).tasks).toHaveLength(0)
        await page.keyboard.press('Escape')
        await agents.waitFor({ state: 'hidden' })
        if (width !== 390) {
          for (const title of ['选择 Agent 与模型', '选择项目', '写下第一个任务']) {
            const row = guide.locator(':scope > div').filter({ hasText: title })
            await row.getByRole('button', { name: '跳过', exact: true }).click()
            await row.waitFor({ state: 'detached' })
          }
          await guide.waitFor({ state: 'detached' })
          expect(await input.inputValue()).toBe(draft)
        }
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
        expect(await guide.count()).toBe(0)
        const missingDraft = '缺少模型时也不能丢掉这份草稿。'
        await input.fill(missingDraft)
        expect((await owner.request('plugins/' + provider.id, { method: 'POST', body: { enabled: false } })).status).toBe(200)
        const setup = page.locator('.setup-card')
        await setup.getByText('连接模型服务', { exact: true }).waitFor()
        await setup.getByRole('button', { name: '添加模型服务', exact: true }).click()
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
            body: { name: '命令验收 Agent', command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_LOG: agentLog } },
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
          ['review', '检查变更', '阅读变更，并解释结果。'],
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
        await enroll(page, '命令验收电脑')
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
          await list.getByRole('option').filter({ hasText: '/review · 检查变更' }).waitFor()
          await input.press('Tab')
          expect(await input.inputValue()).toBe(templates[0][2])
          await input.fill('/')
          await list.getByRole('group', { name: '提示模板', exact: true }).waitFor()
          await list.getByRole('group', { name: 'Agent 命令', exact: true }).waitFor()
          expect(await list.getByRole('group', { name: '提示模板', exact: true }).getByRole('option').count()).toBe(4)
          expect(await list.getByRole('group', { name: 'Agent 命令', exact: true }).getByRole('option').count()).toBe(1)
          expect(await list.getByRole('group').evaluateAll(groups => groups.map(group => group.getAttribute('aria-label')))).toEqual([
            '提示模板',
            'Agent 命令',
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
