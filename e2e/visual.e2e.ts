import { chromium, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentSettings, TaskDetail, TaskStatus } from '@latch/protocol'
import type { HarnessPlugin, ModelDelta, ToolDefinition } from '@latch/sdk'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSection, openSettings, reachable } from './helpers/layout.ts'
import {
  VISUAL_DIFF_OUTPUT,
  VISUAL_OUTPUT,
  VISUAL_TIME,
  VISUAL_VIEWPORTS,
  VisualRecorder,
  captureName,
  compareWithBaseline,
  diffImages,
  visualContext,
  type VisualViewport,
} from './helpers/visual.ts'

/**
 * Drives the real product (an in-process Host, the built page, a scripted local model and the fake ACP agent) into
 * every state it can show and captures each one at phone, tablet and desktop width in light and dark; see
 * docs/TESTING.md「视觉截图」. Session content, device names and paths are fixed, and the page and Host clocks are
 * frozen, so the captures are the same on every run on one machine.
 */

const PROVIDER = 'visual-model'
const MODEL = { providerId: PROVIDER, model: 'fixture-large' }
const DEVICE_NAMES: Record<VisualViewport['name'], string> = { desktop: '我的电脑', tablet: '我的平板', phone: '我的手机' }

// ---- Project files --------------------------------------------------------------------------------------------

const SETTINGS_BEFORE = `export interface ProviderInput {
  name: string
  baseUrl: string
  apiKey?: string | null
}

export async function saveProvider(id: string, input: ProviderInput) {
  const current = await readProvider(id)
  const record = {
    name: input.name,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey ?? '',
  }
  return writeProvider(id, { ...current, ...record })
}
`
const SETTINGS_AFTER = SETTINGS_BEFORE.replace(
  "    apiKey: input.apiKey ?? '',\n",
  "    // 省略表示保留，null 表示清除\n    apiKey: input.apiKey === undefined ? current.apiKey : (input.apiKey ?? ''),\n",
)
const NOTES = `# ACP 会话恢复

| 方法 | 重放历史 | 适用场景 |
| --- | --- | --- |
| session/resume | 否 | 客户端已保存完整记录 |
| session/load | 是 | 换设备或重建界面 |

## 结论

- 两者都用来继续已有会话。
- resume 不重放历史，返回更快。
- load 会把整段对话重放一遍再返回。
- Agent 不支持 resume 时退回 load。

## 待办

- 在设置里说明两种方式的区别。
- 为恢复失败补一条回归测试。
`
const PROJECT: Record<string, string> = {
  'src/settings.ts': SETTINGS_BEFORE,
  'tests/settings.test.ts': `import { expect, it } from 'vitest'
import { saveProvider } from '../src/settings.ts'

it('keeps the saved key when the form leaves it out', async () => {
  const saved = await saveProvider('openai', { name: 'OpenAI', baseUrl: 'https://api.example.com' })
  expect(saved.apiKey).toBe('saved-key')
})
`,
  'scripts/release.sh': '#!/bin/sh\nset -eu\npnpm build\npnpm test tests/release.test.ts\n',
  '.husky/pre-commit': 'pnpm lint\n',
  'docs/README.md': '# 文档\n',
  'docs/release.md': '# 发布说明 1.1\n',
}

// ---- The scripted model ---------------------------------------------------------------------------------------

/** A test command that fails at once; every other command runs until the test releases or cancels it. */
const FAILING_COMMAND = 'pnpm test tests/release.test.ts'
const held = new Set<() => void>()

const runTests: ToolDefinition = {
  name: 'run_tests',
  description: '运行项目的测试命令。',
  kind: 'execute',
  requiresApproval: true,
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false },
  async execute(args, { signal }) {
    if (args.command === FAILING_COMMAND) throw new Error('2 个测试未通过：tests/release.test.ts')
    await new Promise<void>((done, fail) => {
      const release = () => {
        held.delete(release)
        done()
      }
      held.add(release)
      signal.addEventListener(
        'abort',
        () => {
          held.delete(release)
          fail(signal.reason)
        },
        { once: true },
      )
    })
    return { text: '12 项测试通过。' }
  },
}

const call = (name: string, args: Record<string, unknown>): ModelDelta => ({
  type: 'tool-call',
  call: { id: `call-${name}-${randomUUID()}`, name, arguments: args },
})
const text = (value: string): ModelDelta => ({ type: 'text', text: value })
const toolTurn: ModelDelta = { type: 'finish', reason: 'tool-calls' }
const stop: ModelDelta = { type: 'finish', reason: 'stop' }

const PROMPTS = {
  done: '修复设置页保存后密钥被清空的问题',
  running: '运行设置页的回归测试',
  failed: '检查发布脚本的签名步骤',
  cancelled: '整理本周的发布说明',
  r1: '把会话恢复的结论写进笔记',
  r2: '在提交前检查里加上类型检查',
  hidden: '更新发布说明的版本号',
  unread: '总结今天完成的工作',
} as const

/** Each prompt's model turns, one per tool result after the prompt; an Error makes that turn fail. */
const SCRIPTS: Record<string, Array<ModelDelta[] | Error>> = {
  [PROMPTS.done]: [
    [
      { type: 'reasoning', text: '密钥被清空，说明保存时传入了空值。先看保存接口怎样处理 apiKey。' },
      text('先看看保存接口是怎么处理空密钥的。'),
      call('read_file', { path: 'src/settings.ts' }),
      { type: 'usage', inputTokens: 4200, outputTokens: 640 },
      toolTurn,
    ],
    [
      text('找到原因了：表单提交空字符串时，接口把它当成「清除密钥」。改成**省略字段表示保留**，显式传 `null` 才清除。'),
      call('write_file', { path: 'src/settings.ts', content: SETTINGS_AFTER }),
      { type: 'usage', inputTokens: 5100, outputTokens: 980 },
      toolTurn,
    ],
    [
      text(
        '已修复，改动在 `src/settings.ts`：\n\n- 省略 `apiKey` 时保留已保存的密钥\n- 显式传 `null` 才会清除\n\n建议再补一条「保存其他字段不影响密钥」的回归测试。',
      ),
      { type: 'usage', inputTokens: 6300, outputTokens: 1500 },
      stop,
    ],
  ],
  [PROMPTS.running]: [
    [text('先读一下现有的测试。'), call('read_file', { path: 'tests/settings.test.ts' }), toolTurn],
    [text('用例覆盖了省略密钥的情况，运行一次确认。'), call('run_tests', { command: 'pnpm test tests/settings.test.ts' }), toolTurn],
  ],
  [PROMPTS.failed]: [
    [text('先运行发布前的检查。'), call('run_tests', { command: FAILING_COMMAND }), toolTurn],
    new Error('模型服务返回错误（HTTP 503）：服务暂时不可用'),
  ],
  [PROMPTS.cancelled]: [[text('先运行一次完整测试，确认可以发布。'), call('run_tests', { command: 'pnpm test' }), toolTurn]],
  [PROMPTS.r1]: [
    [
      text('两者都用来继续已有会话：resume 不重放历史，load 会把整段对话重放一遍再返回。我把对比整理成笔记，写入前请你确认。'),
      call('write_file', { path: 'docs/notes.md', content: NOTES }),
      toolTurn,
    ],
  ],
  [PROMPTS.r2]: [
    [
      text('在提交前钩子里加上类型检查。这个文件会在每次提交时执行，所以写入前需要确认。'),
      call('write_file', { path: '.husky/pre-commit', content: 'pnpm lint\npnpm typecheck\n' }),
      toolTurn,
    ],
  ],
  // The new title carries a zero-width space, which the approval card marks for the reviewer.
  [PROMPTS.hidden]: [
    [text('把发布说明的版本号改成 1.2。'), call('write_file', { path: 'docs/release.md', content: '# 发布​说明 1.2\n' }), toolTurn],
  ],
  [PROMPTS.unread]: [
    [
      text(
        '今天完成了 3 件事：\n\n1. 修复设置页保存后密钥被清空的问题\n2. 整理 ACP 会话恢复的笔记\n3. 更新发布说明的草稿\n\n发布脚本的签名步骤还在等测试结果。',
      ),
      stop,
    ],
  ],
}

const visualPlugin: HarnessPlugin = {
  id: 'visual-fixture',
  name: '界面验收模型',
  version: '1.0.0',
  description: '按提示返回固定内容的本地模型，只在测试中使用。',
  activate(context) {
    context.registerTool(runTests)
    context.registerProvider({
      id: PROVIDER,
      name: '本地模型服务',
      model: MODEL.model,
      models: [MODEL.model, 'fixture-small'],
      async *stream({ messages, signal }) {
        signal.throwIfAborted()
        const last = messages.findLastIndex(message => message.role === 'user')
        const script = SCRIPTS[messages[last]?.content ?? '']
        const turn = script?.[messages.slice(last + 1).filter(message => message.role === 'tool').length]
        if (turn === undefined) throw new Error(`No scripted turn for ${messages[last]?.content}`)
        if (turn instanceof Error) throw turn
        yield* turn
      },
    })
  },
}

// ---- Helpers ---------------------------------------------------------------------------------------------------

/**
 * Paths show in the inspector, the project picker and settings, so the projects live at a fixed place under the temp
 * directory instead of a fresh random one. A marker with the owner's PID keeps two runs from sharing it.
 */
async function claimProjects(): Promise<string> {
  const root = join(await realpath(tmpdir()), 'latch-visual')
  const marker = join(root, '.owner')
  const owner = Number(await readFile(marker, 'utf8').catch(() => 'NaN'))
  if (Number.isInteger(owner) && owner !== process.pid) {
    let alive = true
    try {
      process.kill(owner, 0)
    } catch {
      alive = false
    }
    if (alive) throw new Error(`${root} is in use by process ${owner}`)
  }
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(marker, String(process.pid))
  for (const [path, content] of Object.entries(PROJECT)) {
    await mkdir(dirname(join(root, 'latch-app', path)), { recursive: true })
    await writeFile(join(root, 'latch-app', path), content)
  }
  await mkdir(join(root, 'website'))
  await writeFile(join(root, 'website', 'README.md'), '# website\n')
  return root
}

interface Sessions {
  plan: string
  done: string
  failed: string
  cancelled: string
  unread: string
  running: string
  r2: string
  hidden: string
  r1: string
  advisory: string
}

// ---- Page drivers that need nothing from the scenario ---------------------------------------------------------

async function openDrawer(target: Page): Promise<Locator> {
  await target.getByRole('button', { name: '打开会话列表', exact: true }).filter({ visible: true }).first().click()
  const drawer = target.getByRole('dialog', { name: '会话导航', exact: true })
  await drawer.waitFor()
  return drawer
}

/** Session details: a pane beside the transcript on desktop, a sheet from the session menu elsewhere. */
async function openDetails(target: Page, viewport: VisualViewport): Promise<void> {
  if (viewport.name === 'desktop') {
    await target.getByRole('button', { name: '会话详情', exact: true }).click()
    await target.getByRole('complementary', { name: '会话详情', exact: true }).waitFor()
  } else {
    await target.getByRole('button', { name: '会话操作', exact: true }).click()
    await target.getByRole('menuitem', { name: '会话详情', exact: true }).click()
    await target.getByRole('dialog', { name: '会话详情', exact: true }).waitFor()
  }
  await target.locator('.inspector').getByText('正在读取…').waitFor({ state: 'detached' })
}

async function closeDetails(target: Page, viewport: VisualViewport): Promise<void> {
  // The desktop pane is a per-device preference, so it is closed again for the surfaces after it.
  if (viewport.name === 'desktop') await target.getByRole('button', { name: '收起会话详情', exact: true }).click()
  else await target.keyboard.press('Escape')
  await target.locator('.inspector').waitFor({ state: 'detached' })
}

/** The given message of a settled session is on screen. */
async function shows(target: Page, value: string | RegExp): Promise<void> {
  await target.locator('.transcript').getByText(value).last().waitFor()
}

describe('visual capture of the real product', () => {
  let projects: string
  let testHost: TestHost
  let host: TestHost['host']
  let browser: Browser
  let local: TestDevice
  let sessions: Sessions
  const recorder = new VisualRecorder()
  const pages = new Map<VisualViewport['name'], { context: BrowserContext; page: Page }>()

  beforeAll(async () => {
    projects = await claimProjects()
    testHost = await startTestHost({
      uiDir: resolve(process.env.HARNESS_E2E_UI_DIR ?? 'dist/web'),
      demo: false,
      plugins: [visualPlugin],
      providerId: PROVIDER,
      presenceMode: 'manual',
      // The Host's clock (credentials, enrollments, device activity) stands still at the page clock's instant.
      now: () => VISUAL_TIME,
      workspaceRoot: join(projects, 'latch-app'),
    })
    host = testHost.host
    browser = await chromium.launch(browserLaunchOptions())
    await recorder.start()
  })

  afterAll(async () => {
    await recorder.writeIndex()
    // Assigned only once the scenario has been built.
    if (local && sessions) await local.request(`tasks/${sessions.running}/cancel`, { method: 'POST' }).catch(() => {})
    for (const { context } of pages.values()) await context.close().catch(() => {})
    await browser?.close()
    await testHost?.close()
    if (projects) await rm(projects, { recursive: true, force: true })
  })

  const page = (viewport: VisualViewport) => pages.get(viewport.name)!.page
  const detail = (id: string): Promise<TaskDetail> => host.bridge.detail(id)
  const status = async (id: string): Promise<TaskStatus> => (await detail(id)).summary.status
  async function settled(id: string, expected: TaskStatus): Promise<void> {
    await expect.poll(() => status(id), { timeout: 20_000 }).toBe(expected)
  }
  async function pendingApproval(id: string): Promise<string> {
    await expect.poll(async () => (await detail(id)).approvals.length, { timeout: 20_000 }).toBe(1)
    return (await detail(id)).approvals[0].id
  }
  async function start(prompt: string, mode: 'agent' | 'chat' = 'agent'): Promise<string> {
    const { sessionId } = await local.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt, requestId: randomUUID(), mode, model: MODEL },
    })
    return sessionId
  }
  /** A session on a full-access agent; starting one takes the Host's local confirmation. */
  async function startAgent(harnessId: string, prompt: string): Promise<string> {
    const response = await local.confirmed('tasks', {
      method: 'POST',
      body: { prompt, requestId: randomUUID(), mode: 'agent', harnessId },
    })
    expect(response.status).toBe(201)
    const { sessionId }: { sessionId: string } = await response.json()
    return sessionId
  }
  /** Allows from the Host's own desktop; high-risk approvals go through its local confirmation. */
  async function allow(approvalId: string): Promise<void> {
    const response = await local.confirmed(`approvals/${encodeURIComponent(approvalId)}`, {
      method: 'POST',
      body: { decision: 'allow', requestId: randomUUID() },
    })
    expect({ status: response.status, body: response.status === 200 ? null : await response.text() }).toEqual({ status: 200, body: null })
  }
  async function toolRunning(id: string): Promise<void> {
    await expect
      .poll(async () => (await detail(id)).messages.some(message => message.role === 'tool' && message.state === 'running'), {
        timeout: 20_000,
      })
      .toBe(true)
  }

  // ---- Page drivers ------------------------------------------------------------------------------------------

  /**
   * Opens the app as a fresh tab would: no session selected (the selection lives in sessionStorage). Every surface is
   * reached from here, so what it shows never depends on the surface captured before it.
   */
  async function home(target: Page): Promise<void> {
    await target.evaluate(() => sessionStorage.clear())
    await target.goto(`${host.loopbackOrigin}/link/`)
    await connected(target)
  }
  async function newSession(target: Page): Promise<void> {
    await home(target)
    await target.getByRole('button', { name: '新建会话', exact: true }).filter({ visible: true }).first().click()
    await target.locator('.workspace.is-new').waitFor()
    await target.locator('.drawer-backdrop').waitFor({ state: 'detached' })
  }
  async function openSession(target: Page, viewport: VisualViewport, id: string): Promise<void> {
    await home(target)
    if (viewport.name !== 'desktop') await openDrawer(target)
    await target.locator(`[data-task-id="${id}"]`).click()
    await target.locator('.drawer-backdrop').waitFor({ state: 'detached' })
    await target.locator(`[data-task-id="${id}"][aria-current="page"]`).waitFor({ state: 'attached' })
    await target.locator('.transcript-content').waitFor()
    await target.locator('.transcript .loading-line').waitFor({ state: 'detached' })
    // The read marker is stored by an effect after the transcript renders; let it run before anything reloads the page.
    await target.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  }

  // ---- Phase 1: enrollment and the first run --------------------------------------------------------------

  it('captures enrollment, the wait for local confirmation and the first run at each viewport', async () => {
    for (const viewport of VISUAL_VIEWPORTS.toSorted((a, b) => b.width - a.width)) {
      const context = await visualContext(browser, viewport)
      const target = await context.newPage()
      pages.set(viewport.name, { context, page: target })
      await target.goto(`${host.loopbackOrigin}/link/`)
      await target.getByRole('heading', { name: '连接到 Latch', exact: true }).waitFor()
      const name = target.getByLabel('设备名称', { exact: true })
      await name.fill(DEVICE_NAMES[viewport.name])
      await name.blur()
      // Every browser device manages the Host, so each one reaches all settings.
      await target.getByRole('checkbox', { name: '管理此 Host（模型服务、插件、项目和设备）', exact: true }).setChecked(true)
      await reachable(target.getByRole('button', { name: '请求本机确认', exact: true }))
      await recorder.capture(target, viewport, 'enrollment', 'form')

      await target.getByRole('button', { name: '请求本机确认', exact: true }).click()
      await testHost.presence.waitForRequest()
      await target.getByRole('heading', { name: '等待本机确认', exact: true }).waitFor()
      await reachable(target.getByRole('button', { name: '取消', exact: true }))
      await recorder.capture(target, viewport, 'enrollment-waiting', 'waiting for local confirmation')

      testHost.presence.approveNext()
      await connected(target)
      await target.getByText('会话会保存在这里').first().waitFor({ state: 'attached' })
      await reachable(target.getByRole('textbox', { name: '新会话消息', exact: true }))
      await recorder.capture(target, viewport, 'new-session-first-run', 'no sessions')
    }
  })

  // ---- Phase 2: sessions in every state --------------------------------------------------------------------

  it('drives sessions into every state through the Host API', async () => {
    local = await testHost.enroll({ listener: 'unix', name: '本机桌面端' })
    await local.json('workspaces', { method: 'POST', body: { path: join(projects, 'website'), name: 'website' } })
    const saved = await local.confirmed('agents', {
      method: 'POST',
      body: { name: '本地 ACP Agent', command: process.execPath, args: [FAKE_ACP_AGENT], env: {} },
    })
    expect(saved.status).toBe(201)
    const { agent }: { agent: AgentSettings } = await saved.json()

    // A full-access session on the ACP agent: thinking, a tool with a diff, then a plan with usage.
    const plan = await startAgent(agent.id, 'think')
    await settled(plan, 'idle')
    for (const [turn, prompt] of ['tool', 'plan'].entries()) {
      await local.json(`tasks/${plan}/prompt`, { method: 'POST', body: { prompt, requestId: randomUUID() } })
      await expect
        .poll(async () => {
          const current = await detail(plan)
          return [current.messages.filter(message => message.role === 'user').length, current.summary.status]
        })
        .toEqual([turn + 2, 'idle'])
    }
    await local.json(`tasks/${plan}`, { method: 'PATCH', body: { title: '梳理会话恢复的实现' } })

    const done = await start(PROMPTS.done)
    await allow(await pendingApproval(done))
    await settled(done, 'idle')

    const failed = await start(PROMPTS.failed)
    await allow(await pendingApproval(failed))
    await settled(failed, 'failed')

    const cancelled = await start(PROMPTS.cancelled)
    await allow(await pendingApproval(cancelled))
    await toolRunning(cancelled)
    await local.json(`tasks/${cancelled}/cancel`, { method: 'POST' })
    await settled(cancelled, 'cancelled')

    const unread = await start(PROMPTS.unread, 'chat')
    await settled(unread, 'idle')

    const running = await start(PROMPTS.running)
    await allow(await pendingApproval(running))
    await toolRunning(running)

    const hidden = await start(PROMPTS.hidden)
    await pendingApproval(hidden)
    const r2 = await start(PROMPTS.r2)
    await pendingApproval(r2)
    expect((await detail(r2)).approvals[0].risk).toBe('R2')
    const r1 = await start(PROMPTS.r1)
    await pendingApproval(r1)
    expect((await detail(r1)).approvals[0].risk).toBe('R1')

    // The full-access agent asks; in a browser that question is advisory. It comes last: while a full-access session
    // waits, the Host's local confirmation serves only rejections.
    const advisory = await startAgent(agent.id, 'permission')
    await pendingApproval(advisory)
    await local.json(`tasks/${advisory}`, { method: 'PATCH', body: { title: '列出项目根目录' } })

    sessions = { plan, done, failed, cancelled, unread, running, hidden, r2, r1, advisory }
    for (const { page: target } of pages.values()) await target.locator(`[data-task-id="${running}"]`).waitFor({ state: 'attached' })
  })

  // ---- Phase 3: every surface at every viewport ------------------------------------------------------------

  it.each(VISUAL_VIEWPORTS)(
    'captures every surface at $name width and keeps its controls reachable',
    async viewport => {
      const target = page(viewport)
      // A person who has looked at every session but one: that one keeps its unread mark.
      for (const seen of Object.values(sessions).filter(id => id !== sessions.unread)) await openSession(target, viewport, seen)
      await home(target)
      await expect
        .poll(() => target.locator('.session-item.is-unread [data-task-id]').evaluateAll(items => items.map(item => item.dataset.taskId)))
        .toEqual([sessions.unread])

      // New session and its pickers.
      await newSession(target)
      const composer = target.getByRole('textbox', { name: '新会话消息', exact: true })
      await reachable(composer)
      await reachable(target.getByRole('button', { name: '发送', exact: true }), { allowDisabled: true })
      await recorder.capture(target, viewport, 'new-session', 'empty')
      if (viewport.name === 'phone') {
        await target.getByRole('button', { name: /^运行设置：/ }).click()
        await target.getByRole('dialog', { name: '运行设置', exact: true }).waitFor()
        await recorder.capture(target, viewport, 'new-session-run-settings', 'harness, model and project sheet')
        await target.keyboard.press('Escape')
      } else {
        for (const [surface, trigger, menu] of [
          ['new-session-harness', /^Harness：/, '选择 Harness'],
          ['new-session-model', /^模型：/, '选择模型'],
          ['new-session-project', /^项目：/, '选择项目'],
        ] as const) {
          await target.getByRole('button', { name: trigger }).click()
          await target.getByRole('menu', { name: menu, exact: true }).waitFor()
          await recorder.capture(target, viewport, surface, `${menu} open`)
          await target.keyboard.press('Escape')
          await target.getByRole('menu', { name: menu, exact: true }).waitFor({ state: 'detached' })
        }
      }
      const modes = target.getByRole('group', { name: '会话模式', exact: true })
      await modes.getByRole('button', { name: '对话', exact: true }).click()
      await recorder.capture(target, viewport, 'new-session-chat', 'chat mode')
      await modes.getByRole('button', { name: 'Agent', exact: true }).click()

      // Sessions in each state.
      const sidebar = viewport.name === 'desktop' ? target.locator('#session-navigation') : undefined
      await openSession(target, viewport, sessions.running)
      await shows(target, '用例覆盖了省略密钥的情况，运行一次确认。')
      await reachable(target.getByRole('button', { name: '取消任务', exact: true }))
      await recorder.capture(target, viewport, 'session-running', 'tool running')
      if (sidebar) await recorder.capture(target, viewport, 'sidebar-running', 'running session selected', sidebar)

      await pages.get(viewport.name)!.context.setOffline(true)
      await target.getByRole('button', { name: '离线', exact: true }).filter({ visible: true }).first().waitFor()
      await recorder.capture(target, viewport, 'session-offline', 'client offline while a tool runs')
      if (sidebar) await recorder.capture(target, viewport, 'sidebar-offline', 'offline', sidebar)
      await pages.get(viewport.name)!.context.setOffline(false)
      await connected(target)

      await openSession(target, viewport, sessions.done)
      await shows(target, /建议再补一条/)
      await recorder.capture(target, viewport, 'session-done', 'done with tools and a diff')
      if (sidebar) await recorder.capture(target, viewport, 'sidebar-done', 'done session selected', sidebar)

      // The write's diff, as a reader opens it.
      const write = target.locator('.tool-card-header', { hasText: '写入 src/settings.ts' })
      await reachable(write)
      await write.click()
      await target.locator('.tool-card-body').filter({ hasText: '省略表示保留' }).waitFor()
      await write.scrollIntoViewIfNeeded()
      await recorder.capture(target, viewport, 'session-diff', 'done session with its diff expanded')

      await openSession(target, viewport, sessions.plan)
      await shows(target, 'planned')
      await recorder.capture(target, viewport, 'session-plan', 'full-access session done with a plan')
      await openDetails(target, viewport)
      await recorder.capture(target, viewport, 'session-plan-info', 'details with the plan and the tool timeline')
      await closeDetails(target, viewport)

      await openSession(target, viewport, sessions.failed)
      await target.locator('.topbar').getByText('失败', { exact: true }).waitFor()
      await recorder.capture(target, viewport, 'session-failed', 'failed')
      if (sidebar) await recorder.capture(target, viewport, 'sidebar-failed', 'failed session selected', sidebar)

      await openSession(target, viewport, sessions.cancelled)
      await target.locator('.topbar').getByText('已取消', { exact: true }).waitFor()
      await recorder.capture(target, viewport, 'session-cancelled', 'cancelled')
      if (sidebar) await recorder.capture(target, viewport, 'sidebar-cancelled', 'cancelled session selected', sidebar)

      // Approvals.
      await openSession(target, viewport, sessions.r1)
      const r1 = target.locator('[data-approval-id]')
      await reachable(r1.getByRole('button', { name: '允许一次', exact: true }))
      await reachable(r1.getByRole('button', { name: '拒绝', exact: true }))
      await recorder.capture(target, viewport, 'approval-r1', 'R1 waiting for approval')

      await openDetails(target, viewport)
      await recorder.capture(target, viewport, 'session-info', 'details of a session waiting for approval')
      await closeDetails(target, viewport)

      await openSession(target, viewport, sessions.r2)
      const r2 = target.locator('[data-approval-id]')
      await r2.getByText('高风险操作只能在执行端电脑上用 Latch 桌面端批准', { exact: true }).waitFor()
      expect(await r2.getByRole('button', { name: /允许/ }).count()).toBe(0)
      await reachable(r2.getByRole('button', { name: '拒绝', exact: true }))
      await recorder.capture(target, viewport, 'approval-r2-locked', 'R2 on a device that cannot approve it')

      await openSession(target, viewport, sessions.hidden)
      const hidden = target.locator('[data-approval-id]')
      await hidden.getByText(/^内容包含不可见或改变显示方向的字符/).waitFor()
      await reachable(hidden.getByRole('button', { name: '允许一次', exact: true }))
      await recorder.capture(target, viewport, 'approval-hidden', 'R1 whose content hides characters')

      await openSession(target, viewport, sessions.advisory)
      const advisory = target.locator('[data-approval-id]')
      await advisory.getByText('提示，不是安全边界', { exact: true }).waitFor()
      await reachable(advisory.getByRole('button', { name: 'Reject', exact: true }))
      await recorder.capture(target, viewport, 'approval-advisory', 'full-access question shown as advisory')

      // Navigation: the drawer on phones and tablets.
      if (viewport.name !== 'desktop') {
        await home(target)
        const drawer = await openDrawer(target)
        for (const name of ['新建会话', '设置', '设备', '关闭会话列表']) await reachable(drawer.getByRole('button', { name, exact: true }))
        await noHorizontalOverflow(target, drawer)
        await recorder.capture(target, viewport, 'navigation', 'session list drawer')
        await drawer.getByRole('button', { name: '关闭会话列表', exact: true }).click()
        await target.locator('.drawer-backdrop').waitFor({ state: 'detached' })
      }

      // Settings, section by section.
      await home(target)
      const settings = await openSettings(target, '设置')
      if (viewport.name === 'phone') {
        await recorder.capture(target, viewport, 'settings', 'section list')
        await openSection(settings, '通用')
      }
      await settings.getByRole('heading', { name: '新会话默认值' }).waitFor()
      await recorder.capture(target, viewport, 'settings-general', 'general')
      for (const [surface, section, ready] of [
        ['settings-providers', '模型服务', settings.getByText('本地模型服务').first()],
        ['settings-agents', 'Agent', settings.getByText('本地 ACP Agent').first()],
        ['settings-workspaces', '项目', settings.getByText('website').first()],
        ['settings-plugins', '插件', settings.getByRole('switch').first()],
        ['settings-devices', '设备', settings.getByText('本机桌面端').first()],
        ['settings-about', '关于', settings.getByText('Apache License 2.0').first()],
      ] as const) {
        await openSection(settings, section)
        await ready.waitFor()
        await noHorizontalOverflow(target, settings)
        await recorder.capture(target, viewport, surface, section)
      }
      await settings.getByRole('button', { name: '关闭', exact: true }).click()
    },
    600_000,
  )

  // ---- Stability ----------------------------------------------------------------------------------------------

  it('captures the same pixels when a surface is driven again', async () => {
    const viewport = VISUAL_VIEWPORTS.find(item => item.name === 'desktop')!
    const target = page(viewport)
    const again: Array<[string, () => Promise<void>]> = [
      ['new-session', () => newSession(target)],
      [
        'session-done',
        async () => {
          await openSession(target, viewport, sessions.done)
          await shows(target, /建议再补一条/)
        },
      ],
      [
        'approval-r1',
        async () => {
          await openSession(target, viewport, sessions.r1)
          await target.locator('[data-approval-id]').getByRole('button', { name: '允许一次', exact: true }).waitFor()
        },
      ],
    ]
    for (const [surface, drive] of again) {
      await drive()
      for (const theme of ['light', 'dark'] as const) {
        await target.emulateMedia({ colorScheme: theme })
        const file = captureName(surface, viewport.name, theme)
        const repeated = await recorder.shot(target)
        const diff = await diffImages(browser, repeated, await readFile(join(VISUAL_OUTPUT, file)))
        if (diff.image) {
          // Kept for diagnosis: the second capture and where it differs from the first.
          await mkdir(join(VISUAL_DIFF_OUTPUT, 'repeat'), { recursive: true })
          await writeFile(join(VISUAL_DIFF_OUTPUT, 'repeat', file), repeated)
          await writeFile(join(VISUAL_DIFF_OUTPUT, 'repeat', file.replace(/\.png$/, '.diff.png')), diff.image)
        }
        expect({ surface, theme, diffPixels: diff.diffPixels, sizeMatches: diff.sizeMatches }).toEqual({
          surface,
          theme,
          diffPixels: 0,
          sizeMatches: true,
        })
      }
      await target.emulateMedia({ colorScheme: 'light' })
    }
  })

  // ---- Comparison with an earlier run --------------------------------------------------------------------------

  it.skipIf(!process.env.LATCH_VISUAL_BASELINE)('compares every capture with the run in LATCH_VISUAL_BASELINE', async () => {
    await recorder.writeIndex()
    const results = await compareWithBaseline(browser, recorder.entries, resolve(process.env.LATCH_VISUAL_BASELINE!))
    if (process.env.LATCH_VISUAL_STRICT === '1') {
      expect(results.filter(result => result.status !== 'same').map(result => `${result.file}: ${result.status}`)).toEqual([])
    }
  })
})
