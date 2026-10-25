import { chromium, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { build, preview } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentPresetSettings, AgentSettings, AppSnapshot, Approval, TaskDetail, TaskStatus } from '@latch/protocol'
import { AppError, type HarnessPlugin, type ModelDelta, type ToolDefinition } from '@latch/sdk'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import {
  backToSection,
  noHorizontalOverflow,
  openSection,
  openSettings,
  backToPhoneSessions,
  reachable,
  closeSettings,
} from './helpers/layout.ts'
import { expectUnmovedByInjectedStyles } from './helpers/security.ts'
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
const HOST_NAME = 'MacBook Pro'

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
    if (args.command === FAILING_COMMAND) {
      advance(1800)
      throw new Error('2 个测试未通过：tests/release.test.ts')
    }
    await hold(signal)
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

/**
 * The Host's clock for the times it records on runs and messages. It starts a minute after the page's frozen clock
 * (sessions changed after a device enrolled count as unread there) and moves only where the scripted model streams or
 * the scenario waits for a person, so every time, duration and live counter on screen comes out the same on every run.
 */
let hostClock = VISUAL_TIME + 60_000
const advance = (ms: number) => {
  hostClock += ms
}

/** Holds a stream until the test releases or cancels it, as a long step does. */
function hold(signal: AbortSignal): Promise<void> {
  return new Promise<void>((done, fail) => {
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
}

const PROMPTS = {
  done: '修复设置页保存后密钥被清空的问题',
  running: '运行设置页的回归测试',
  failed: '检查发布脚本的签名步骤',
  cancelled: '整理本周的发布说明',
  r1: '把会话恢复的结论写进笔记',
  r2: '在提交前检查里加上类型检查',
  hidden: '更新发布说明的版本号',
  unread: '总结今天完成的工作',
  thinking: '评估会话恢复的两种做法',
  rejected: '把发布计划写进 docs/plan.md',
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
  // Rejected on the Host's own desktop with what to do instead; the model answers the note.
  [PROMPTS.rejected]: [
    [
      text('我把发布计划写进 `docs/plan.md`，写入前请你确认。'),
      call('write_file', { path: 'docs/plan.md', content: '# 发布计划\n\n1. 冻结功能\n2. 回归测试\n3. 发布\n' }),
      toolTurn,
    ],
    [text('好的，没有写入文件。计划如下，你看过之后我再决定写到哪里：\n\n1. 冻结功能\n2. 回归测试\n3. 发布'), stop],
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
        if (messages[last]?.content === PROMPTS.thinking) {
          // Reasoning that is still going on when the page looks.
          advance(800)
          yield { type: 'reasoning', text: 'resume 不重放历史，返回更快；load 会把整段对话重放一遍。要看客户端是否保存了完整记录。' }
          advance(14_000)
          await hold(signal)
          return
        }
        const script = SCRIPTS[messages[last]?.content ?? '']
        const turn = script?.[messages.slice(last + 1).filter(message => message.role === 'tool').length]
        if (turn === undefined) throw new Error(`No scripted turn for ${messages[last]?.content}`)
        if (turn instanceof Error) {
          advance(2400)
          throw turn
        }
        // Each step takes its time on the Host's clock: a model's first words after a moment, the answer some seconds
        // after its reasoning began.
        let reasoning = false
        for (const delta of turn) {
          if (delta.type === 'reasoning') {
            advance(600)
            reasoning = true
          } else if (delta.type === 'text') {
            advance(reasoning ? 6000 : 1200)
            reasoning = false
          } else if (delta.type === 'tool-call') advance(400)
          else if (delta.type === 'finish') advance(300)
          yield delta
        }
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
  thinking: string
  done: string
  failed: string
  cancelled: string
  unread: string
  running: string
  r2: string
  hidden: string
  r1: string
  advisory: string
  rejected: string
}

// ---- Page drivers that need nothing from the scenario ---------------------------------------------------------

/** The tablet's session list, which slides over from the rail. */
async function openDrawer(target: Page): Promise<Locator> {
  await target.getByRole('button', { name: '打开会话列表', exact: true }).filter({ visible: true }).first().click()
  const drawer = target.getByRole('dialog', { name: '会话导航', exact: true })
  await drawer.waitFor()
  return drawer
}

/**
 * 会话信息: the column beside the paper on the desktop, where it is open by default from 1440px; on tablets as narrow
 * as the reference one and on phones, a page that takes the conversation's place.
 */
async function openDetails(target: Page, viewport: VisualViewport): Promise<void> {
  const toggle = target.locator('.topbar').getByRole('button', { name: '会话信息', exact: true })
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
  if (viewport.name === 'desktop')
    await target.getByRole('complementary', { name: '会话信息', exact: true }).locator('.inspector').waitFor()
  else await target.getByRole('region', { name: '会话信息', exact: true }).locator('.inspector').waitFor()
  await settleMotion(target)
}

async function closeDetails(target: Page, viewport: VisualViewport): Promise<void> {
  // The desktop column stays open, as it is by default at that width.
  if (viewport.name === 'desktop') return
  await target.getByRole('button', { name: viewport.name === 'phone' ? '返回' : '返回对话', exact: true }).click()
  await target.locator('.info-page').waitFor({ state: 'detached' })
}

/** Waits until nothing on the page is moving but the live indicators, which keep turning by design. */
async function settleMotion(target: Page): Promise<void> {
  await target.waitForFunction(() =>
    document.getAnimations().every(animation => animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity),
  )
  await target.evaluate(() => new Promise(done => setTimeout(done, 260)))
}

/** The given message of a settled session is on screen. */
async function shows(target: Page, value: string | RegExp): Promise<void> {
  await target.locator('.transcript').getByText(value).last().waitFor()
}

/** What this computer has of each agent preset depends on the machine: the list says none is installed. */
async function presetsAsMissing(target: Page): Promise<void> {
  await target.route('**/link/api/agents', async route => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    const body: { agents: AgentSettings[]; presets: AgentPresetSettings[] } = await response.json()
    await route.fulfill({
      response,
      json: { ...body, presets: body.presets.map(preset => ({ ...preset, detected: { found: false } })) },
    })
  })
}

// ---- The gallery of primitives --------------------------------------------------------------------------------

/**
 * Builds the test-only gallery of @latch/ui (packages/ui/test/gallery) into a temporary directory with Vite and serves
 * it on 127.0.0.1 at a free port. It is never part of dist/web.
 */
async function serveGallery(): Promise<{ url: string; close: () => Promise<void> }> {
  const root = resolve('packages/ui/test/gallery')
  const outDir = await mkdtemp(join(tmpdir(), 'latch-ui-gallery-'))
  const quiet = { logLevel: 'warn', configFile: false } as const
  try {
    await build({
      ...quiet,
      root,
      base: './',
      build: {
        outDir,
        emptyOutDir: true,
        rolldownOptions: {
          // Icon modules carry a "use client" directive that has no meaning in a single-page bundle.
          onwarn(warning, warn) {
            if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning)
          },
        },
      },
    })
    const server = await preview({ ...quiet, root, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } })
    const url = server.resolvedUrls?.local[0]
    if (!url) throw new Error('The gallery server reported no address')
    return {
      url,
      close: async () => {
        await server.close()
        await rm(outDir, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await rm(outDir, { recursive: true, force: true })
    throw error
  }
}

/**
 * Holds a pseudo-class (hover, focus-visible) on the first element `selector` finds, through the DevTools protocol, so a
 * capture shows it: the recorder rests the pointer in the corner before every capture. Returns the release.
 */
async function forceState(page: Page, selector: string, states: string[]): Promise<() => Promise<void>> {
  const session = await page.context().newCDPSession(page)
  await session.send('DOM.enable')
  await session.send('CSS.enable')
  const { root } = await session.send('DOM.getDocument', { depth: -1 })
  const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector })
  if (!nodeId) throw new Error(`No element matches ${selector}`)
  await session.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: states })
  return async () => {
    await session.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] })
    await session.detach()
  }
}

/** Waits until the shell's columns have finished moving (opening or shutting the sidebar slides its track). */
async function shellSettled(target: Page): Promise<void> {
  await target.waitForFunction(() => document.querySelector('.app-shell')?.getAnimations({ subtree: false }).length === 0)
  await target.evaluate(() => new Promise(done => setTimeout(done, 260)))
}

/**
 * Hover, press and keyboard focus cannot be held on a still page, so the gallery marks the samples that show them with
 * `data-force="<pseudo-class>"` (and `data-force-at`, a selector inside the sample). The DevTools protocol forces that
 * state on the element, and the real stylesheet draws it.
 */
async function forceGalleryStates(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page)
  await session.send('DOM.enable')
  await session.send('CSS.enable')
  const { root } = await session.send('DOM.getDocument', { depth: -1 })
  const { nodeIds } = await session.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '[data-force]' })
  for (const nodeId of nodeIds) {
    const { attributes } = await session.send('DOM.getAttributes', { nodeId })
    const attribute = (name: string) => {
      const index = attributes.indexOf(name)
      return index >= 0 ? attributes[index + 1] : undefined
    }
    const state = attribute('data-force')
    const { nodeId: target } = await session.send('DOM.querySelector', { nodeId, selector: attribute('data-force-at') ?? ':scope > *' })
    if (!state || !target) throw new Error(`No element to force ${state ?? 'a state'} on`)
    await session.send('CSS.forcePseudoState', { nodeId: target, forcedPseudoClasses: [state] })
  }
}

/** Approvals as a Host of the previous build sent them: no risk, no options of its own, no advisory flag. */
const previousBuild = (approvals: Approval[]): Approval[] =>
  approvals.map(({ risk: _risk, options: _options, advisory: _advisory, ...rest }) => rest)

describe('visual capture of the real product', () => {
  let projects: string
  let testHost: TestHost
  let host: TestHost['host']
  let browser: Browser
  let local: TestDevice
  let sessions: Sessions
  const recorder = new VisualRecorder()
  const pages = new Map<VisualViewport['name'], { context: BrowserContext; page: Page }>()
  /** One device per width without 管理此 Host, for the read-only settings. */
  const readOnlyPages = new Map<VisualViewport['name'], { context: BrowserContext; page: Page }>()

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
      // The times recorded on runs and messages follow the scripted clock above.
      clock: () => hostClock,
      // The computer's name in the sidebar's footer, the same on every machine.
      hostName: HOST_NAME,
      workspaceRoot: join(projects, 'latch-app'),
    })
    host = testHost.host
    browser = await chromium.launch(browserLaunchOptions())
    await recorder.start()
  })

  afterAll(async () => {
    await recorder.writeIndex()
    // Assigned only once the scenario has been built.
    if (local && sessions)
      for (const id of [sessions.running, sessions.thinking]) await local.request(`tasks/${id}/cancel`, { method: 'POST' }).catch(() => {})
    for (const { context } of [...pages.values(), ...readOnlyPages.values()]) await context.close().catch(() => {})
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
    await target.emulateMedia({ reducedMotion: 'no-preference' })
    await target.evaluate(() => sessionStorage.clear())
    await target.goto(`${host.loopbackOrigin}/link/`)
    await connected(target)
  }
  /** The new-session page uses the same compact controls while empty or drafting. */
  async function newSession(target: Page): Promise<void> {
    await home(target)
    await target.emulateMedia({ reducedMotion: 'reduce' })
    await target.getByRole('button', { name: '新建会话', exact: true }).filter({ visible: true }).first().click()
    if ((await target.locator('.phone-list').count()) > 0) {
      await target.getByRole('dialog', { name: '新会话', exact: true }).waitFor()
      await settleMotion(target)
      return
    }
    await target.locator('.workspace.is-new').waitFor()
    await target.locator('.drawer-backdrop').waitFor({ state: 'detached' })
  }
  /** A session from the list: the sidebar, the tablet's drawer, or a phone's list (the session's page pushed over it). */
  async function openSession(target: Page, viewport: VisualViewport, id: string): Promise<void> {
    await home(target)
    if (viewport.name === 'tablet') await openDrawer(target)
    await target.locator(`[data-task-id="${id}"]`).click()
    await target.locator('.drawer-backdrop').waitFor({ state: 'detached' })
    if (viewport.name === 'phone') await target.locator('.phone-list[data-covered]').waitFor()
    await target.locator(`[data-task-id="${id}"][aria-current="page"]`).waitFor({ state: 'attached' })
    await target.locator('.transcript-content').waitFor()
    await target.locator('.transcript .ui-loading').waitFor({ state: 'detached' })
    // The read marker is stored by an effect after the transcript renders; let it run before anything reloads the page.
    await target.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  }

  /**
   * The ceilings of 设置 › 电脑 as a browser that manages the Host sees them: the local ladder (everything below the
   * current 完全访问 can be chosen), the remote ladder (raising shows why it is not possible here) and the list page of
   * agents other devices may use. Nothing is changed.
   */
  async function captureCeilings(target: Page, viewport: VisualViewport, settings: Locator): Promise<void> {
    for (const [surface, name, description] of [
      ['settings-computer-local-menu', '在这台电脑上发起', 'the ceiling for sessions started on this computer'],
      ['settings-computer-remote-menu', '从手机和其他电脑发起', 'the ceiling for other devices; raising is not possible here'],
    ] as const) {
      await settings.getByRole('button', { name: new RegExp(`^${name}：`) }).click()
      const layer =
        viewport.name === 'phone'
          ? target.getByRole('dialog', { name, exact: true })
          : target.getByRole('menu', { name: new RegExp(`^${name}：`) })
      await layer.waitFor()
      for (const item of await layer.getByRole(viewport.name === 'phone' ? 'radio' : 'menuitemradio').all())
        await reachable(item, { allowDisabled: true })
      await recorder.capture(target, viewport, surface, description)
      await target.keyboard.press('Escape')
      await layer.waitFor({ state: 'hidden' })
    }
    // The list pages: a page of its own, pushed with its own bar on phones and with a way back above it elsewhere.
    for (const [surface, row, all, description] of [
      ['settings-computer-agents', /^其他设备可用的 Agent/, '全部 Agent', 'the agents other devices may use'],
      ['settings-computer-workspaces', /^其他设备可用的项目/, '全部项目', 'the projects other devices may use'],
    ] as const) {
      await settings.getByRole('button', { name: row }).click()
      const list = viewport.name === 'phone' ? settings.locator('.settings-level[data-state="top"]') : settings
      // A browser cannot widen the list: the switch is locked with its reason when only some are allowed.
      await reachable(list.getByRole('switch', { name: all, exact: true }), { allowDisabled: true })
      const back = list.getByRole('button', { name: viewport.name === 'phone' ? '返回电脑' : '电脑', exact: true })
      await reachable(back)
      await noHorizontalOverflow(target, settings)
      await recorder.capture(target, viewport, surface, description)
      await back.click()
      await settings.getByRole('button', { name: /^在这台电脑上发起：/ }).waitFor()
      await expect.poll(() => settings.locator('.settings-layout').getAttribute('data-level')).not.toBe('page')
    }

    // A lowering the Host applied without writing its audit log: the change stays, and the page says so in red.
    const audit = host.security.audit
    const append = audit.append.bind(audit)
    audit.append = () => Promise.reject(new AppError(503, 'audit-unavailable', '审计记录写入失败，操作未执行'))
    try {
      const remoteStart = settings.getByRole('switch', { name: '允许其他设备在这里新建会话', exact: true })
      await remoteStart.click()
      await expect.poll(() => host.security.policy.get().remote.allowRemoteStart).toBe(false)
      await settings.getByText(/没有写入审计记录/).waitFor()
    } finally {
      audit.append = append
    }
    await noHorizontalOverflow(target, settings)
    await recorder.capture(target, viewport, 'settings-computer-audit-failed', 'a lowering applied without an audit record')
    // Back as it was. A full-access session waits by now, so the Host's local confirmation would refuse the raise; the
    // test sets it the way the offline command does, while the Host is stopped.
    const current = host.security.policy.get()
    await host.security.policy.update(
      { ...current, remote: { ...current.remote, allowRemoteStart: true } },
      { listener: 'cli', via: 'cli' },
      'offline',
    )
  }

  /**
   * A phone's root page: the list with 等你处理 and a paper card per group, its search, the menu of a row pressed and
   * held, a pinned session and the archived filter. Every change made here is undone before it returns.
   */
  async function capturePhoneSessions(target: Page, viewport: VisualViewport): Promise<void> {
    await home(target)
    const list = target.locator('#session-navigation')
    const head = list.locator('.phone-list-head')
    for (const name of ['设置', '搜索会话', '新建会话']) await reachable(head.getByRole('button', { name, exact: true }))
    const filters = list.getByRole('group', { name: '筛选会话', exact: true })
    for (const name of ['全部', '对话', 'Agent']) await reachable(filters.getByRole('button', { name, exact: true }))
    await reachable(list.locator('.phone-inbox'))
    // The rows draw their status slots at 16; the second line adds what the slot does not say, never a preview.
    const row = (id: string) => list.locator(`[data-task-id="${id}"]`)
    await row(sessions.running).locator('.ui-comet[data-size="16"]').waitFor()
    await row(sessions.running)
      .getByText(/ · 正在运行$/)
      .waitFor()
    await row(sessions.cancelled)
      .getByText(/ · 已取消$/)
      .waitFor()
    await row(sessions.r1).locator('.ui-waiting-pill', { hasText: '待批准' }).waitFor()
    await noHorizontalOverflow(target)
    await settleMotion(target)
    await recorder.capture(target, viewport, 'navigation', 'the session list, the root page')

    // Search unfolds under the header and filters the titles; 取消 clears it and folds it away.
    await head.getByRole('button', { name: '搜索会话', exact: true }).click()
    const search = list.getByRole('searchbox', { name: '搜索会话', exact: true })
    await search.fill('发布')
    await row(sessions.done).waitFor({ state: 'detached' })
    await row(sessions.hidden).waitFor()
    await settleMotion(target)
    await recorder.capture(target, viewport, 'navigation-search', 'searching titles')
    await list.getByRole('button', { name: '取消', exact: true }).click()
    await row(sessions.done).waitFor()

    // A row pressed and held (or its context menu) opens the session's menu as a sheet.
    const title = (await detail(sessions.unread)).summary.title
    await row(sessions.unread).click({ button: 'right' })
    const rowMenu = target.getByRole('menu', { name: title, exact: true })
    await rowMenu.waitFor()
    for (const name of ['重命名', '置顶', '归档', '导出 Markdown', '删除'])
      await reachable(rowMenu.getByRole('menuitem', { name, exact: true }))
    await settleMotion(target)
    await recorder.capture(target, viewport, 'navigation-row-menu', "a row's menu after a long press")
    await target.keyboard.press('Escape')
    await rowMenu.waitFor({ state: 'hidden' })

    // Its 重命名 and 删除 ask in sheets of their own: 取消 · the question · the action.
    for (const [surface, item, dialog, action, description] of [
      ['navigation-rename', '重命名', '重命名会话', '保存', 'renaming a session from its row'],
      ['navigation-delete', '删除', '删除会话', '删除', 'the confirmation before a session is deleted'],
    ] as const) {
      await row(sessions.unread).click({ button: 'right' })
      await rowMenu.waitFor()
      await rowMenu.getByRole('menuitem', { name: item, exact: true }).click()
      const ask = target.getByRole('dialog', { name: dialog, exact: true })
      await ask.waitFor()
      await reachable(ask.getByRole('button', { name: '取消', exact: true }))
      await reachable(ask.getByRole('button', { name: action, exact: true }), { allowDisabled: true })
      await settleMotion(target)
      await recorder.capture(target, viewport, surface, description)
      await ask.getByRole('button', { name: '取消', exact: true }).click()
      await ask.waitFor({ state: 'hidden' })
    }
    expect((await detail(sessions.unread)).summary.title).toBe(title)

    // A long title ends in an ellipsis between 取消 and the edge; neither covers the other.
    const longTitle = '修复设置页保存模型服务之后 API Key 会被清空的问题，并补上回归测试与说明'
    await local.json(`tasks/${sessions.unread}`, { method: 'PATCH', body: { title: longTitle } })
    await row(sessions.unread).getByText(longTitle).waitFor()
    await row(sessions.unread).click({ button: 'right' })
    const longMenu = target.getByRole('dialog', { name: longTitle, exact: true })
    await longMenu.waitFor()
    const header = await longMenu.locator('.ui-sheet-header').evaluate(bar => {
      const cancel = bar.querySelector('.ui-sheet-cancel')!.getBoundingClientRect()
      const heading = bar.querySelector('.ui-sheet-title')!
      return { apart: cancel.right <= heading.getBoundingClientRect().left, cut: heading.scrollWidth > heading.clientWidth }
    })
    expect(header).toEqual({ apart: true, cut: true })
    await settleMotion(target)
    await recorder.capture(target, viewport, 'navigation-row-menu-long', "a long-titled row's menu")
    await target.keyboard.press('Escape')
    await longMenu.waitFor({ state: 'hidden' })
    await local.json(`tasks/${sessions.unread}`, { method: 'PATCH', body: { title } })
    await row(sessions.unread).getByText(title, { exact: true }).waitFor()

    // A pinned session leads the list in a card of its own.
    await local.json(`tasks/${sessions.plan}`, { method: 'PATCH', body: { pinned: true } })
    const pinned = list.locator('.phone-group[aria-label="置顶"]')
    await pinned.locator(`[data-task-id="${sessions.plan}"]`).waitFor()
    await expect.poll(() => list.locator('[data-leaving]').count()).toBe(0)
    // The menus closed from the keyboard and gave focus back to a lower row; a touch leaves none, and the card leads the
    // list.
    await target.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    })
    await list.locator('.phone-list-scroll').evaluate(element => {
      element.scrollTop = 0
    })
    await settleMotion(target)
    await recorder.capture(target, viewport, 'navigation-pinned', 'a pinned session in the card above the projects')
    await local.json(`tasks/${sessions.plan}`, { method: 'PATCH', body: { pinned: false } })
    await pinned.waitFor({ state: 'detached' })
    await expect.poll(() => list.locator('[data-leaving]').count()).toBe(0)

    // Once something is archived, the pills offer 已归档.
    await local.json(`tasks/${sessions.cancelled}`, { method: 'PATCH', body: { archived: true } })
    const archived = filters.getByRole('button', { name: '已归档', exact: true })
    await reachable(archived)
    await archived.click()
    await list.locator('[data-session-filter="archived"]').waitFor()
    await row(sessions.cancelled).waitFor()
    await settleMotion(target)
    await recorder.capture(target, viewport, 'navigation-archived', 'the archived filter')
    await filters.getByRole('button', { name: '全部', exact: true }).click()
    await local.json(`tasks/${sessions.cancelled}`, { method: 'PATCH', body: { archived: false } })
    await row(sessions.cancelled).waitFor()
    await expect.poll(() => archived.count()).toBe(0)

    // The list ends with the computer it comes from and 同步最新状态, which reads the Host's state again.
    const foot = list.locator('.phone-list-foot')
    const sync = foot.getByRole('button', { name: '同步最新状态', exact: true })
    await reachable(sync)
    expect(await foot.locator('.phone-list-host').innerText()).toBe(HOST_NAME)
    const snapshots: string[] = []
    const watch = (request: { url: () => string }) => {
      if (new URL(request.url()).pathname.endsWith('/link/api/snapshot')) snapshots.push(request.url())
    }
    target.on('request', watch)
    await sync.click()
    await expect.poll(() => snapshots.length).toBeGreaterThan(0)
    target.off('request', watch)
    await settleMotion(target)
    await recorder.capture(target, viewport, 'navigation-end', 'the end of the list: the computer and 同步最新状态')

    // Offline, the list says so at its top, with 重试.
    await list.locator('.phone-list-scroll').evaluate(element => {
      element.scrollTop = 0
    })
    await pages.get(viewport.name)!.context.setOffline(true)
    const banner = list.locator('.banner-region').getByText('当前设备已离线', { exact: true })
    await banner.waitFor()
    await reachable(list.locator('.banner-region').getByRole('button', { name: '重试', exact: true }))
    await list.locator('.ui-collapse[data-settled] > .ui-collapse-inner > .banner-region').first().waitFor()
    await settleMotion(target)
    await recorder.capture(target, viewport, 'navigation-offline', 'the list while this device is offline')
    await pages.get(viewport.name)!.context.setOffline(false)
    await connected(target)
    await banner.waitFor({ state: 'detached' })
  }

  // ---- Phase 1: enrollment and the first run --------------------------------------------------------------

  it('captures enrollment, the wait for local confirmation and the first run at each viewport', async () => {
    for (const viewport of VISUAL_VIEWPORTS.toSorted((a, b) => b.width - a.width)) {
      const context = await visualContext(browser, viewport)
      const target = await context.newPage()
      pages.set(viewport.name, { context, page: target })
      // Loopback takes a one-time invitation; without one the page says where to get it.
      await target.goto(`${host.loopbackOrigin}/link/`)
      await target.getByText(/^这台电脑上的浏览器也需要一次性登记链接。/).waitFor()
      await recorder.capture(target, viewport, 'enrollment-invitation', 'browser without an invitation')
      const invitation = await testHost.invite(['view', 'run', 'approve:standard', 'admin'], 'loopback-tcp')
      await target.goto(invitation.url)
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

      // Refused on the Host computer: that request used the invitation up, so the outcome stands above the way to a new
      // link, and the browser comes back with a new one.
      testHost.presence.denyNext()
      await target.getByText('本机拒绝了此设备。', { exact: true }).waitFor()
      await target.getByText(/^这台电脑上的浏览器也需要一次性登记链接。/).waitFor()
      await recorder.capture(target, viewport, 'enrollment-denied', 'refused on the Host computer')

      await target.goto((await testHost.invite(['view', 'run', 'approve:standard', 'admin'], 'loopback-tcp')).url)
      await name.fill(DEVICE_NAMES[viewport.name])
      await target.getByRole('checkbox', { name: '管理此 Host（模型服务、插件、项目和设备）', exact: true }).setChecked(true)
      await target.getByRole('button', { name: '请求本机确认', exact: true }).click()
      await testHost.presence.waitForRequest()
      await target.getByRole('heading', { name: '等待本机确认', exact: true }).waitFor()
      testHost.presence.approveNext()
      await connected(target)
      await target.getByText('会话会保存在这里').first().waitFor({ state: 'attached' })
      // A phone opens on its empty session list; wider screens on the new-session page.
      if (viewport.name === 'phone') await reachable(target.locator('.phone-empty').getByRole('button', { name: '新建会话', exact: true }))
      else await reachable(target.getByRole('textbox', { name: '新会话消息', exact: true }))
      if (viewport.name !== 'phone') {
        await target.emulateMedia({ reducedMotion: 'reduce' })
        await target.evaluate(() => new Promise(done => setTimeout(done, 400)))
      }
      await recorder.capture(target, viewport, 'new-session-first-run', 'no sessions')
      await target.emulateMedia({ reducedMotion: 'no-preference' })

      // A second device at this width without 管理此 Host, enrolled now: once a full-access session waits, the Host's
      // local confirmation serves only rejections, enrollment included.
      const readOnlyContext = await visualContext(browser, viewport)
      const readOnly = await readOnlyContext.newPage()
      readOnlyPages.set(viewport.name, { context: readOnlyContext, page: readOnly })
      await readOnly.goto((await testHost.invite(['view', 'run', 'approve:standard'], 'loopback-tcp')).url)
      await readOnly.getByRole('heading', { name: '连接到 Latch', exact: true }).waitFor()
      const readOnlyName = readOnly.getByLabel('设备名称', { exact: true })
      await readOnlyName.fill(`只读的${DEVICE_NAMES[viewport.name].replace(/^我的/, '')}`)
      await readOnlyName.blur()
      await readOnly.getByRole('button', { name: '请求本机确认', exact: true }).click()
      await testHost.presence.waitForRequest()
      testHost.presence.approveNext()
      await connected(readOnly)
    }
  })

  // ---- Phase 2: sessions in every state --------------------------------------------------------------------

  it('drives sessions into every state through the Host API', async () => {
    local = await testHost.enroll({ listener: 'unix', name: '本机桌面端' })
    // Projects are added from the desktop app, which signs the request in its main process.
    expect((await local.addFolders({ paths: [join(projects, 'website')], name: 'website' })).status).toBe(201)
    const saved = await local.confirmed('agents', {
      method: 'POST',
      body: { name: '本地 ACP Agent', command: process.execPath, args: [FAKE_ACP_AGENT], env: {} },
    })
    expect(saved.status).toBe(201)
    const { agent }: { agent: AgentSettings } = await saved.json()
    // A saved model service with a key, for its page in settings. The key is a test value; it never leaves the Host.
    const provider = await local.confirmed('providers', {
      method: 'POST',
      body: {
        name: 'DeepSeek',
        kind: 'openai-compatible',
        presetId: 'deepseek',
        baseURL: 'https://api.deepseek.com/v1',
        apiKey: 'visual-fixture-key',
        models: ['deepseek-chat', 'deepseek-reasoner'],
        defaultModel: 'deepseek-chat',
      },
    })
    expect(provider.status).toBe(201)

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
    const write = await pendingApproval(done)
    // The person takes a while to look at the change; the turn's working time leaves the wait out.
    advance(35_000)
    await allow(write)
    await settled(done, 'idle')

    const failed = await start(PROMPTS.failed)
    await allow(await pendingApproval(failed))
    await settled(failed, 'failed')

    const cancelled = await start(PROMPTS.cancelled)
    await allow(await pendingApproval(cancelled))
    await toolRunning(cancelled)
    // The desktop page watches the run end: its tool row's comet cross-fades into the tool's icon and the words of the
    // new state rise into place.
    const watching = pages.get('desktop')!.page
    await openSession(
      watching,
      VISUAL_VIEWPORTS.find(item => item.name === 'desktop')!,
      cancelled,
    )
    await watching.locator('.tool-card .tool-card-icon .ui-comet').waitFor()
    await local.json(`tasks/${cancelled}/cancel`, { method: 'POST' })
    await settled(cancelled, 'cancelled')
    await watching.locator('.tool-card-icon[data-shift] > .ui-status-glyph-leaving .ui-comet').waitFor({ state: 'attached' })
    await watching.locator('.tool-card-state[data-shift]', { hasText: '已取消' }).waitFor()
    await home(watching)

    const unread = await start(PROMPTS.unread, 'chat')
    await settled(unread, 'idle')

    // A write rejected on the Host's own desktop, with what to do instead: the row reads its record, not a failure.
    const rejected = await start(PROMPTS.rejected)
    await local.json(`approvals/${encodeURIComponent(await pendingApproval(rejected))}`, {
      method: 'POST',
      body: { decision: 'reject', note: '先把计划发给我看', requestId: randomUUID() },
    })
    await settled(rejected, 'idle')

    const thinking = await start(PROMPTS.thinking, 'chat')
    await expect.poll(async () => (await detail(thinking)).liveReasoning?.length ?? 0, { timeout: 20_000 }).toBeGreaterThan(0)

    const running = await start(PROMPTS.running)
    await allow(await pendingApproval(running))
    await toolRunning(running)

    const hidden = await start(PROMPTS.hidden)
    await pendingApproval(hidden)
    // The first approval to arrive while the pages watch: the 待批准 row (the rail's button on tablets) appears with its
    // count, which ripples once because the page saw it arrive.
    await pages
      .get('desktop')!
      .page.locator('.approvals-row .ui-count', { hasText: '1' })
      .locator('.ui-count-ripple')
      .waitFor({ state: 'attached' })
    await pages.get('tablet')!.page.locator('.rail .ui-count', { hasText: '1' }).locator('.ui-count-ripple').waitFor({ state: 'attached' })
    const r2 = await start(PROMPTS.r2)
    await pendingApproval(r2)
    expect((await detail(r2)).approvals[0].risk).toBe('R2')
    const r1 = await start(PROMPTS.r1)
    await pendingApproval(r1)
    expect((await detail(r1)).approvals[0].risk).toBe('R1')

    // The full-access agent asks; in a browser that question is advisory. It comes last: while a full-access session
    // waits, the Host's local confirmation serves only rejections.
    const advisory = await startAgent(agent.id, 'plan-ask')
    await pendingApproval(advisory)
    await local.json(`tasks/${advisory}`, { method: 'PATCH', body: { title: '列出项目根目录' } })

    sessions = { plan, thinking, done, failed, cancelled, unread, running, hidden, r2, r1, advisory, rejected }
    for (const { page: target } of pages.values()) await target.locator(`[data-task-id="${running}"]`).waitFor({ state: 'attached' })
  })

  // ---- Phase 3: every surface at every viewport ------------------------------------------------------------

  it.each(VISUAL_VIEWPORTS)(
    'captures every surface at $name width and keeps its controls reachable',
    async viewport => {
      const target = page(viewport)
      // A person who has looked at every session but one: that one keeps its unread mark. On the desktop, a session
      // read while the page watches lets its row's dot sink as its time fades in.
      const settles: Array<string | null> = []
      for (const seen of Object.values(sessions).filter(id => id !== sessions.unread)) {
        const row = target.locator(`#session-navigation [data-task-id="${seen}"]`)
        const wasUnread = viewport.name === 'desktop' && (await row.locator('.ui-status-dot').count()) > 0
        await openSession(target, viewport, seen)
        if (wasUnread && (await row.locator('.ui-status-time').count()) > 0)
          settles.push(await row.locator('.ui-status-slot').getAttribute('data-settle'))
      }
      if (viewport.name === 'desktop') {
        expect(settles.length).toBeGreaterThan(0)
        expect(new Set(settles)).toEqual(new Set(['dot-time']))
      }
      await home(target)
      await expect
        .poll(() =>
          target
            .locator('.session-item.is-unread [data-task-id], .phone-row.is-unread[data-task-id]')
            .evaluateAll(items => items.map(item => item.dataset.taskId)),
        )
        .toEqual([sessions.unread])

      // New session: the harness tiles, the input and its pickers.
      await newSession(target)
      const composer = target.getByRole('textbox', { name: '新会话消息', exact: true })
      await reachable(composer)
      await reachable(target.getByRole('button', { name: viewport.name === 'phone' ? '开始' : '发送', exact: true }), {
        allowDisabled: true,
      })
      const harnesses = target.getByRole('radiogroup', { name: 'Agent', exact: true })
      for (const way of [/^Latch 内置\s*Agent$/, /^Latch 内置\s*只对话$/]) await reachable(harnesses.getByRole('radio', { name: way }))
      // The full-access agent can only start from the desktop app: its tile says so and cannot be chosen here.
      const agentTile = harnesses.getByRole('radio', { name: /本地 ACP Agent/ })
      await reachable(agentTile, { allowDisabled: true })
      expect(await agentTile.getAttribute('aria-disabled')).toBe('true')
      expect(await agentTile.textContent()).toContain('仅本机桌面端')
      await recorder.capture(target, viewport, 'new-session', 'empty')
      await target.getByRole('textbox', { name: '新会话消息', exact: true }).blur()
      await settleMotion(target)
      if (viewport.name !== 'phone')
        await recorder.capture(target, viewport, 'new-session-draft', 'the quiet empty workspace with compact agent choices')
      if (viewport.name === 'phone') {
        // The harness tiles: an added full-access agent and the presets not added yet cannot start here, and say why.
        const sheet = target.getByRole('dialog', { name: '新会话', exact: true })
        const tiles = sheet.getByRole('radiogroup', { name: 'Agent', exact: true })
        expect(await tiles.getByRole('radio', { name: /^Latch 内置\s*Agent$/ }).getAttribute('aria-checked')).toBe('true')
        const agent = tiles.getByRole('radio', { name: /^本地 ACP Agent/ })
        expect(await agent.getAttribute('aria-disabled')).toBe('true')
        await agent.click({ force: true })
        await sheet.locator('.ui-tile-choice-reason').waitFor()
        expect(await tiles.getByRole('radio', { name: /^Latch 内置\s*Agent$/ }).getAttribute('aria-checked')).toBe('true')
        await recorder.capture(
          target,
          viewport,
          'new-session-phone-harness-unavailable',
          'a full-access agent says why it cannot start from a phone',
        )
        // The project and the model are rows that open single-choice sheets of their own.
        for (const [surface, row, title] of [
          ['new-session-project', /^项目：/, '项目'],
          ['new-session-model', /^模型：/, '模型'],
        ] as const) {
          await sheet.getByRole('button', { name: row }).click()
          const picker = target.getByRole('dialog', { name: title, exact: true })
          await picker.waitFor()
          for (const option of await picker.getByRole('radio').all()) await reachable(option, { allowDisabled: true })
          await settleMotion(target)
          await recorder.capture(target, viewport, surface, `${title} sheet open`)
          await target.keyboard.press('Escape')
          await picker.waitFor({ state: 'hidden' })
        }
      } else {
        for (const [surface, trigger, menu] of [
          ['new-session-model', /^模型：/, '模型'],
          ['new-session-project', /^项目：/, '项目'],
        ] as const) {
          await target.getByRole('button', { name: trigger }).click()
          const layer = target.getByRole('menu', { name: menu, exact: true })
          await layer.waitFor()
          for (const item of await layer.getByRole('menuitem').all()) await reachable(item)
          await settleMotion(target)
          await recorder.capture(target, viewport, surface, `${menu} open`)
          await target.keyboard.press('Escape')
          await layer.waitFor({ state: 'hidden' })
        }
        // A model service is added where the model is chosen: the menu turns into the small panel.
        await target.getByRole('button', { name: /^模型：/ }).click()
        await target.getByRole('menuitem', { name: '添加模型服务…', exact: true }).click()
        const services = target.getByRole('region', { name: '添加模型服务', exact: true })
        await reachable(services.getByRole('button', { name: 'DeepSeek', exact: true }))
        await settleMotion(target)
        await recorder.capture(target, viewport, 'new-session-model-add', 'adding a model service in place')
        await services.getByRole('button', { name: 'DeepSeek', exact: true }).click()
        // A browser cannot set keys: the panel says where it can be done.
        await target
          .getByRole('region', { name: 'DeepSeek', exact: true })
          .locator('.setup-panel-note', { hasText: '密钥只能在运行 Latch 的电脑上用桌面端填写' })
          .waitFor()
        await settleMotion(target)
        await recorder.capture(target, viewport, 'new-session-model-add-key', 'a service that needs a key, on a device that cannot set one')
        await target.keyboard.press('Escape')
        await target.getByRole('region', { name: 'DeepSeek', exact: true }).waitFor({ state: 'hidden' })
      }
      // Adding an agent in place: the presets not added yet, then one of them with its install command.
      await presetsAsMissing(target)
      await target.getByRole('button', { name: /^添加 Agent/ }).click()
      const presetList = target.getByRole('group', { name: '添加 Agent', exact: true })
      await reachable(presetList.getByRole('button', { name: /^Codex/ }))
      await settleMotion(target)
      await recorder.capture(target, viewport, 'new-session-harness', 'the presets that can be added')
      await presetList.getByRole('button', { name: /^Codex/ }).click()
      const codex = target.getByRole('region', { name: 'Codex', exact: true })
      await reachable(codex.getByRole('button', { name: '复制安装命令', exact: true }))
      await codex.getByText('在运行 Latch 的电脑上添加：设置 › Agent 成员').waitFor()
      await settleMotion(target)
      await recorder.capture(target, viewport, 'new-session-add-agent', 'one preset: what is missing and where to add it')
      await target.keyboard.press('Escape')
      await codex.waitFor({ state: 'hidden' })
      await target.unroute('**/link/api/agents')
      if (viewport.name === 'desktop') {
        // ⋯ on the new-session page holds 同步最新状态, the only place it lives while the connection is healthy.
        await target.locator('.topbar').getByRole('button', { name: '会话操作', exact: true }).click()
        const more = target.getByRole('menu', { name: '会话操作', exact: true })
        await reachable(more.getByRole('menuitem', { name: '同步最新状态', exact: true }))
        await recorder.capture(target, viewport, 'new-session-more-menu', '⋯ open on the new-session page')
        await target.keyboard.press('Escape')
        await more.waitFor({ state: 'detached' })
      }
      await harnesses.getByRole('radio', { name: /^Latch 内置\s*只对话$/ }).click()
      await recorder.capture(target, viewport, 'new-session-chat', 'the built-in harness for conversation only: no project')
      // Pressed, a tile that cannot be chosen says why under the row.
      await agentTile.click({ force: true })
      await target.locator('.harness-choice .ui-tile-choice-reason', { hasText: '仅本机桌面端' }).waitFor()
      await recorder.capture(target, viewport, 'new-session-harness-unavailable', 'why a harness cannot be chosen here')
      await harnesses.getByRole('radio', { name: /^Latch 内置\s*Agent$/ }).click()

      // Nothing to start with yet: no model service. The card above the input offers one, and the same panel as the
      // model picker's opens inside it. The Host's catalog is read without its services for this.
      await target.route('**/link/api/snapshot', async route => {
        const response = await route.fetch()
        const snapshot: AppSnapshot = await response.json()
        const catalog = snapshot.catalog && {
          ...snapshot.catalog,
          providers: [],
          defaults: { ...snapshot.catalog.defaults, model: undefined },
        }
        await route.fulfill({ response, json: { ...snapshot, ...(catalog ? { catalog } : {}) } })
      })
      await newSession(target)
      const setup = target.locator('.setup-card')
      await setup.getByText('连接模型服务', { exact: true }).waitFor()
      await reachable(setup.getByRole('button', { name: '添加模型服务', exact: true }))
      await reachable(target.getByRole('button', { name: viewport.name === 'phone' ? '开始' : '发送', exact: true }), {
        allowDisabled: true,
      })
      await recorder.capture(target, viewport, 'new-session-setup', 'no model service yet: the card that adds one')
      await setup.getByRole('button', { name: '添加模型服务', exact: true }).click()
      const inCard = setup.getByRole('region', { name: '添加模型服务', exact: true })
      await reachable(inCard.getByRole('button', { name: 'DeepSeek', exact: true }))
      await settleMotion(target)
      await recorder.capture(target, viewport, 'new-session-setup-add', 'the services to add, opened inside the card')
      await target.unroute('**/link/api/snapshot')

      // The built-in demo model: the prompts it knows, each marked 演示. The catalog reads the scripted service as the
      // demo one for this.
      await target.route('**/link/api/snapshot', async route => {
        const response = await route.fetch()
        const snapshot: AppSnapshot = await response.json()
        const catalog = snapshot.catalog && {
          ...snapshot.catalog,
          providers: snapshot.catalog.providers.map(provider =>
            provider.id === PROVIDER ? { ...provider, kind: 'demo' as const } : provider,
          ),
        }
        await route.fulfill({ response, json: { ...snapshot, ...(catalog ? { catalog } : {}) } })
      })
      await newSession(target)
      const demoTasks = target.getByRole('region', { name: '演示任务', exact: true })
      await demoTasks.getByText('演示', { exact: true }).first().waitFor()
      for (const card of await demoTasks.getByRole('button').all()) await reachable(card)
      await recorder.capture(target, viewport, 'new-session-demo', 'the demo model: prompts it knows, each marked 演示')
      await target.unroute('**/link/api/snapshot')
      await home(target)

      if (viewport.name === 'desktop') {
        // The desktop app on this computer, as a separate tab of the same device: the full-access agent can start, the
        // send button describes starting the session, and the row under the input names the level.
        const desktopApp = await pages.get(viewport.name)!.context.newPage()
        await desktopApp.addInitScript(() => {
          Object.defineProperty(window, 'latchShell', { value: { kind: 'electron', devMode: false, platform: 'darwin' } })
        })
        await desktopApp.route('**/link/api/snapshot', async route => {
          const response = await route.fetch()
          const snapshot: AppSnapshot = await response.json()
          await route.fulfill({ response, json: { ...snapshot, device: { ...snapshot.device, listener: 'unix' } } })
        })
        await desktopApp.emulateMedia({ reducedMotion: 'reduce' })
        await desktopApp.goto(`${host.loopbackOrigin}/link/`)
        await connected(desktopApp)
        await desktopApp.getByRole('button', { name: '新建会话', exact: true }).filter({ visible: true }).first().click()
        await desktopApp.locator('.workspace.is-new').waitFor()
        await desktopApp
          .getByRole('radiogroup', { name: 'Agent', exact: true })
          .getByRole('radio', { name: /本地 ACP Agent/ })
          .click()
        // Nothing typed yet: the start button rests on the same neutral fill as an empty send, its lock kept.
        const startButton = desktopApp.getByRole('button', { name: '开始会话', exact: true })
        await reachable(startButton, { allowDisabled: true })
        expect(await startButton.getAttribute('aria-disabled')).toBe('true')
        await desktopApp.evaluate(() => new Promise(done => setTimeout(done, 400)))
        await recorder.capture(desktopApp, viewport, 'new-session-full-access-empty', 'starting a full-access session, nothing typed yet')
        await desktopApp.getByRole('textbox', { name: '新会话消息', exact: true }).fill('列出项目根目录')
        await reachable(desktopApp.getByRole('button', { name: '开始会话', exact: true }))
        await reachable(desktopApp.getByRole('button', { name: '权限：完全访问，查看电脑与权限上限', exact: true }))
        expect(await desktopApp.getByText('开启完全访问会话需要本机确认。该会话可以读写 Latch 数据和 Host 身份私钥。').count()).toBe(0)
        await desktopApp.getByRole('textbox', { name: '新会话消息', exact: true }).blur()
        await desktopApp.evaluate(() => new Promise(done => setTimeout(done, 400)))
        await recorder.capture(desktopApp, viewport, 'new-session-full-access', 'starting a full-access session in the desktop app')
        await desktopApp.close()

        // The same tab where this computer cannot confirm (its helper is missing): starting is blocked, and why is the
        // button's tooltip.
        const blockedApp = await pages.get(viewport.name)!.context.newPage()
        await blockedApp.addInitScript(() => {
          Object.defineProperty(window, 'latchShell', { value: { kind: 'electron', devMode: false, platform: 'darwin' } })
        })
        await blockedApp.route('**/link/api/snapshot', async route => {
          const response = await route.fetch()
          const snapshot: AppSnapshot = await response.json()
          await route.fulfill({
            response,
            json: {
              ...snapshot,
              device: { ...snapshot.device, listener: 'unix' },
              ...(snapshot.host ? { host: { ...snapshot.host, presence: { status: 'unavailable', message: '找不到本机确认组件' } } } : {}),
            },
          })
        })
        await blockedApp.emulateMedia({ reducedMotion: 'reduce' })
        await blockedApp.goto(`${host.loopbackOrigin}/link/`)
        await connected(blockedApp)
        await blockedApp.getByRole('button', { name: '新建会话', exact: true }).filter({ visible: true }).first().click()
        await blockedApp.locator('.workspace.is-new').waitFor()
        await blockedApp
          .getByRole('radiogroup', { name: 'Agent', exact: true })
          .getByRole('radio', { name: /本地 ACP Agent/ })
          .click()
        await blockedApp.getByRole('textbox', { name: '新会话消息', exact: true }).fill('列出项目根目录')
        const blockedStart = blockedApp.getByRole('button', { name: '开始会话', exact: true })
        await reachable(blockedStart, { allowDisabled: true })
        expect(await blockedStart.getAttribute('aria-disabled')).toBe('true')
        expect(await blockedStart.getAttribute('aria-describedby')).toBeTruthy()
        await blockedApp.getByRole('textbox', { name: '新会话消息', exact: true }).blur()
        await blockedApp.evaluate(() => new Promise(done => setTimeout(done, 400)))
        await recorder.capture(blockedApp, viewport, 'new-session-full-access-blocked', 'starting is blocked: this computer cannot confirm')
        await blockedApp.close()
      }

      // Sessions in each state.
      const sidebar = viewport.name === 'desktop' ? target.locator('#session-navigation') : undefined
      await openSession(target, viewport, sessions.running)
      await shows(target, '用例覆盖了省略密钥的情况，运行一次确认。')
      await reachable(target.getByRole('button', { name: '停止', exact: true }))
      // Running work turns the comet on its tool row and the turn ends with the live line, which says how long the run
      // has worked; the bar above the input says nothing then, and the open session's own row leaves its comet out.
      await target.locator('.tool-card .ui-comet').first().waitFor()
      await target
        .locator('.turn-footer.is-live')
        .getByText(/^已运行 /)
        .waitFor()
      expect(await target.locator('.run-bar-collapse[data-state="open"]').count()).toBe(0)
      if (sidebar) expect(await sidebar.locator(`[data-task-id="${sessions.running}"] .ui-comet`).count()).toBe(0)
      await settleMotion(target)
      await recorder.capture(target, viewport, 'session-running', 'tool running')
      if (sidebar) await recorder.capture(target, viewport, 'sidebar-running', 'running session selected', sidebar)

      await pages.get(viewport.name)!.context.setOffline(true)
      await target
        .getByRole('button', { name: /^离线/ })
        .filter({ visible: true })
        .first()
        .waitFor()
      // The banner at the top of the conversation unfolds like a disclosure.
      await target.locator('.ui-collapse[data-settled] > .ui-collapse-inner > .banner-region').first().waitFor()
      await settleMotion(target)
      await recorder.capture(target, viewport, 'session-offline', 'client offline while a tool runs')
      if (sidebar) await recorder.capture(target, viewport, 'sidebar-offline', 'offline', sidebar)
      await pages.get(viewport.name)!.context.setOffline(false)
      await connected(target)

      // Stopping, as the bar over the input says it: the outcome of a stop that never answered, then a stop under way.
      // Neither request reaches the Host, so the run goes on; the next page load forgets both.
      await target.route('**/link/api/tasks/*/cancel', route => route.abort('connectionreset'))
      await target.getByRole('button', { name: '停止', exact: true }).click()
      const runBar = target.locator('.run-bar')
      // Said once, here: 「尚未确认 · 重试」, with no red notice above the input and the stop button still a square.
      await runBar.locator('.run-bar-status', { hasText: '尚未确认' }).waitFor()
      await reachable(runBar.getByRole('button', { name: '重试', exact: true }))
      expect(await target.locator('.composer-stack > .ui-notice').count()).toBe(0)
      await target.locator('.stop-button .stop-glyph').waitFor()
      // Nothing is known to be stopping: the live line says how long the run has worked again once it has held 正在停止…
      // its moment, and the top bar claims no 正在取消.
      await target
        .locator('.turn-footer.is-live')
        .getByText(/^已运行 /)
        .waitFor()
      expect(await target.locator('.topbar').getByText('正在取消', { exact: true }).count()).toBe(0)
      await target.locator('.run-bar-collapse[data-settled]').waitFor()
      await settleMotion(target)
      await recorder.capture(target, viewport, 'session-stop-uncertain', 'a stop whose outcome is unknown')
      await target.unroute('**/link/api/tasks/*/cancel')
      // Held until captured, then dropped as well: the stop never reaches the Host.
      let releaseStop: (() => void) | undefined
      const holding = new Promise<void>(done => {
        releaseStop = done
      })
      await target.route('**/link/api/tasks/*/cancel', async route => {
        await holding
        await route.abort('connectionreset')
      })
      await runBar.getByRole('button', { name: '重试', exact: true }).click()
      await runBar.getByText('正在停止…', { exact: true }).waitFor()
      expect(await target.getByRole('button', { name: '停止', exact: true }).getAttribute('aria-disabled')).toBe('true')
      await settleMotion(target)
      await recorder.capture(target, viewport, 'session-stopping', 'a stop under way')
      releaseStop?.()
      await runBar.locator('.run-bar-status', { hasText: '尚未确认' }).waitFor()
      await target.unroute('**/link/api/tasks/*/cancel')
      expect(await status(sessions.running)).toBe('running')

      // Reasoning still streaming: the thinking row says so with its light and its seconds, the live line keeps only
      // how long the run has worked.
      await openSession(target, viewport, sessions.thinking)
      await target.locator('.thinking.is-live').getByText('正在思考', { exact: true }).waitFor()
      await target.locator('.thinking.is-live .process-time').waitFor()
      await settleMotion(target)
      await recorder.capture(target, viewport, 'session-thinking', 'reasoning streams')

      await openSession(target, viewport, sessions.done)
      await shows(target, /建议再补一条/)
      if (sidebar) {
        // Each row's status slot shows one thing: the running comet, the waiting pill, failed, unread or the time, which
        // is also what a cancelled session shows.
        const row = (id: string) => sidebar.locator(`[data-task-id="${id}"]`)
        await row(sessions.running).locator('.ui-comet').waitFor()
        for (const id of [sessions.r1, sessions.r2, sessions.hidden, sessions.advisory])
          await row(id).locator('.ui-waiting-pill', { hasText: '待批准' }).waitFor()
        await row(sessions.failed).locator('.ui-status-failed', { hasText: '失败' }).waitFor()
        await row(sessions.cancelled).locator('.ui-status-time').waitFor()
        await row(sessions.unread).locator('.ui-status-dot').waitFor()
        await row(sessions.plan).locator('.ui-status-time').waitFor()
        // The rows above the list are ghost rows: the open session's neutral selection is the column's only resting fill.
        const fills = await sidebar
          .locator('.search-field, .approvals-row')
          .evaluateAll(items => items.map(item => getComputedStyle(item).backgroundColor))
        expect(fills).toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)'])
        expect(await sidebar.locator('.session-item.is-selected').evaluate(item => getComputedStyle(item).backgroundColor)).not.toBe(
          'rgba(0, 0, 0, 0)',
        )
        // The footer names the computer the Host runs on, and says nothing about a healthy connection.
        expect(await sidebar.locator('.host-name').innerText()).toBe(HOST_NAME)
        expect(await sidebar.locator('.connection-badge').count()).toBe(0)
      }
      // The process before the answer has folded into one row; the write's diff stays in view as evidence.
      const fold = target.locator('.fold-toggle')
      await fold.getByText(/^已处理 · 思考 6 秒 · 读取 1 个文件/).waitFor()
      await target.locator('.diff-view').getByText('省略表示保留').first().waitFor()
      await recorder.capture(target, viewport, 'session-done', 'done with tools and a diff')
      if (sidebar) await recorder.capture(target, viewport, 'sidebar-done', 'done session selected', sidebar)

      // The settled turn's footer: when the reply was sent and its tokens, each count with its unit; the time's tooltip
      // says when the turn began and ended and how long it worked, the approval wait left out.
      const lastReply = target.locator('.turn:last-child .turn-reply')
      const facts = lastReply.locator('.turn-footer .turn-facts')
      await facts.getByText(/^输入 [\d.]+k? tokens$/).waitFor({ state: 'attached' })
      await facts.getByText(/^输出 [\d.]+k? tokens$/).waitFor({ state: 'attached' })
      expect(await facts.getByText(/^用时 /).count()).toBe(0)
      if (viewport.touch) await lastReply.locator('.turn-footer[data-pinned]').waitFor()
      else {
        const release = await forceState(target, '.turn:last-child .turn-reply', ['hover'])
        await settleMotion(target)
        await recorder.capture(target, viewport, 'session-footer', 'the turn footer under the pointer')
        await release()
        // The time's tooltip, opened from the keyboard so it stays while the pointer rests in the corner for the capture.
        await target.keyboard.press('Shift')
        await facts.locator('time').focus()
        await target
          .getByRole('tooltip')
          .filter({ visible: true })
          .getByText(/开始 · .* 完成 · 用时 /)
          .waitFor()
        await settleMotion(target)
        await recorder.capture(target, viewport, 'session-footer-time', "the reply's time with its start, end and working time")
        await facts.locator('time').blur()
      }

      // The model for the next message: a switch reads 「下一条：…」, and its undo leads the menu's footer.
      if (viewport.name !== 'phone') {
        // The input's own picker; the session information has one too.
        const input = target.locator('.composer')
        await input.getByRole('button', { name: /^模型：/ }).click()
        await target.getByRole('menu', { name: '模型', exact: true }).getByRole('menuitemradio', { name: 'fixture-small' }).click()
        const switched = input.getByRole('button', { name: '模型：下一条：fixture-small', exact: true })
        await switched.click()
        const undo = target.getByRole('menuitem', { name: '撤销切换，继续使用 fixture-large', exact: true })
        await reachable(undo)
        await settleMotion(target)
        await recorder.capture(target, viewport, 'session-model-switch', 'a model switch for the next message, with its undo')
        await undo.click()
        await input.getByRole('button', { name: '模型：fixture-large', exact: true }).waitFor()
      }

      // Opening the fold shows the rows as they were.
      await reachable(fold)
      await fold.click()
      await target.locator('.process-fold[data-open] .ui-collapse[data-settled]').waitFor()
      await settleMotion(target)
      await recorder.capture(target, viewport, 'session-done-fold', 'the folded process opened')

      // The write's diff stays in view; its row opens the card with the call's arguments and output.
      const write = target.locator('.tool-card', { has: target.locator('.diff-view') }).locator('.tool-card-header')
      await reachable(write)
      await write.click()
      await target.locator('.tool-card[data-open] .tool-card-body').getByText('输出', { exact: true }).waitFor()
      await write.scrollIntoViewIfNeeded()
      await settleMotion(target)
      await recorder.capture(target, viewport, 'session-diff', 'done session with its diff and its tool card open')

      await openSession(target, viewport, sessions.plan)
      await shows(target, 'planned')
      await recorder.capture(target, viewport, 'session-plan', 'full-access session done with a plan')
      await openDetails(target, viewport)
      await recorder.capture(
        target,
        viewport,
        'session-plan-info',
        'session information with the plan, the usage the agent reported and the changes',
      )
      // Each block folds from its header, and this device remembers it.
      const usageBlock = target.locator('.info-block[data-block="usage"]').last()
      await usageBlock.getByRole('button', { name: '用量', exact: true }).click()
      await usageBlock.locator('.ui-collapse[data-state="closed"]').waitFor({ state: 'attached' })
      await settleMotion(target)
      await recorder.capture(target, viewport, 'session-info-folded', 'a block of the session information folded')
      await usageBlock.getByRole('button', { name: '用量', exact: true }).click()
      await usageBlock.locator('.ui-collapse[data-settled]').waitFor()
      await closeDetails(target, viewport)

      await openSession(target, viewport, sessions.failed)
      await target.locator('.topbar').getByText('失败', { exact: true }).waitFor()
      await recorder.capture(target, viewport, 'session-failed', 'failed')
      if (sidebar) await recorder.capture(target, viewport, 'sidebar-failed', 'failed session selected', sidebar)

      // A failed latest turn offers to send its prompt again; a command it ran may run again, so it asks first.
      const resend = target.locator('.turn:last-child .turn-footer').getByRole('button', { name: '重新发送', exact: true })
      if (!viewport.touch) await target.locator('.turn:last-child .turn-reply').hover()
      await reachable(resend)
      await resend.click()
      await target.getByText(/^上一次已经执行了 1 个操作：运行 1 条命令。/).waitFor()
      await settleMotion(target)
      await recorder.capture(target, viewport, 'session-failed-retry', 'resending a failed turn asks first')
      await target.locator('.turn-retry-confirm').getByRole('button', { name: '取消', exact: true }).click()

      await openSession(target, viewport, sessions.cancelled)
      await target.locator('.topbar').getByText('已取消', { exact: true }).waitFor()
      if (sidebar) {
        // The top bar names it cancelled; its row shows its time.
        await sidebar.locator(`[data-task-id="${sessions.cancelled}"]`).locator('.ui-status-time').waitFor()
      }
      await recorder.capture(target, viewport, 'session-cancelled', 'cancelled')
      if (sidebar) await recorder.capture(target, viewport, 'sidebar-cancelled', 'cancelled session selected', sidebar)

      // A rejected write: its row reads 「已拒绝 · 时间」 in the hint ink, once, with no diff under it and no 失败.
      await openSession(target, viewport, sessions.rejected)
      const record = target.locator('.tool-card .tool-decision-words')
      await record.waitFor()
      expect(await record.textContent()).toMatch(/^已拒绝 · /u)
      expect(await target.locator('.tool-card .diff-view, .tool-card .state-failed, .tool-decision').count()).toBe(0)
      await recorder.capture(target, viewport, 'session-rejected', 'a write rejected with what to do instead')

      // Approvals.
      await openSession(target, viewport, sessions.r1)
      const r1 = target.locator('[data-approval-id]')
      await reachable(r1.getByRole('button', { name: '允许一次', exact: true }))
      await reachable(r1.getByRole('button', { name: '拒绝', exact: true }))
      // The card waits for the person with the one amber pill in its header.
      await r1.locator('.tool-card-header .ui-waiting-pill', { hasText: '待批准' }).waitFor()
      await recorder.capture(target, viewport, 'approval-r1', 'R1 waiting for approval')
      if (sidebar) await recorder.capture(target, viewport, 'sidebar-waiting', 'session waiting for approval selected', sidebar)
      if (viewport.name === 'desktop') {
        // Each line of the open preview reads both numbers, sign and text on one row; the phones' single column stays out.
        const rows = await r1.locator('.approval-preview .diff-line').evaluateAll(lines =>
          lines.map(line => ({
            one: getComputedStyle(line.querySelector('.diff-ln-one')!).display,
            height: line.getBoundingClientRect().height,
            lineHeight: parseFloat(getComputedStyle(line).lineHeight),
          })),
        )
        expect(rows.length).toBeGreaterThan(0)
        for (const row of rows) expect(row).toEqual({ one: 'none', height: row.lineHeight, lineHeight: row.lineHeight })
        // The card and the diff under review keep their look under styles added to the page.
        await expectUnmovedByInjectedStyles(target, [
          '[data-approval-id] .tool-card-title',
          '[data-approval-id] .approval-reason',
          '[data-approval-id] .approval-footnote',
          '[data-approval-id] .diff-fold',
          '[data-approval-id] .diff-path',
          '[data-approval-id] .diff-path-name',
          '[data-approval-id] .diff-path-folder',
          '[data-approval-id] .diff-line',
          '[data-approval-id] .diff-text',
          '[data-approval-id] .ui-button',
        ])
      }

      // The rest of the Host's choices sit behind ⋯ (a bottom sheet of 更多选项 on phones).
      const choices =
        viewport.name === 'phone'
          ? r1.getByRole('button', { name: '更多选项', exact: true })
          : r1.getByRole('button', { name: '更多批准选项', exact: true })
      await reachable(choices)
      await choices.click()
      await target.getByRole('menuitem', { name: /本会话始终允许/ }).waitFor()
      await recorder.capture(target, viewport, 'approval-r1-more', 'the other approval choices open')
      await target.keyboard.press('Escape')
      await target.getByRole('menuitem', { name: /本会话始终允许/ }).waitFor({ state: 'hidden' })

      // The preview folds from its default: open on wider screens (it fits in 240 with its fold bar), folded on phones.
      const toggle = r1.locator('.approval-toggle')
      await reachable(toggle)
      await toggle.click()
      await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe(viewport.name === 'phone' ? 'true' : 'false')
      if (viewport.name === 'phone') {
        // The paper stays short: the first rows of the diff and a fold bar for the rest.
        await reachable(r1.getByRole('button', { name: '展开其余 13 行', exact: true }))
        const paper = await r1.locator('.approval-preview .diff-file').boundingBox()
        expect(paper && paper.height <= 240).toBe(true)
        // Each line reads number, sign, text on one row: one line-number column on phones.
        const lines = await r1.locator('.approval-preview .diff-line').evaluateAll(rows =>
          rows.map(row => ({
            old: getComputedStyle(row.querySelector('.diff-ln-old')!).display,
            height: row.getBoundingClientRect().height,
            lineHeight: parseFloat(getComputedStyle(row).lineHeight),
          })),
        )
        expect(lines.length).toBeGreaterThan(0)
        for (const line of lines) expect(line).toEqual({ old: 'none', height: line.lineHeight, lineHeight: line.lineHeight })
      }
      await recorder.capture(target, viewport, 'approval-r1-preview', 'the preview toggled from its default')

      // With the keyboard on the card, its shortcuts show next to the buttons (not on touch screens).
      if (!viewport.touch) {
        await r1.getByRole('button', { name: '允许一次', exact: true }).focus()
        await expect.poll(() => r1.locator('.approval-keys').evaluate(element => getComputedStyle(element).opacity)).toBe('1')
        await recorder.capture(target, viewport, 'approval-r1-keys', 'the card holds focus and shows its shortcuts')
      }

      // A decision whose answer never arrived: the card offers to send the same choice again.
      await target.route('**/link/api/approvals/**', route => route.abort('connectionreset'))
      // The first 拒绝 asks what to do instead in the composer; the second sends the rejection.
      await r1.getByRole('button', { name: '拒绝', exact: true }).click()
      await target.getByRole('textbox', { name: '告诉 Agent 改做什么', exact: true }).waitFor()
      await recorder.capture(target, viewport, 'approval-r1-note', 'after 拒绝, the composer asks what to do instead')
      await r1.getByRole('button', { name: '拒绝', exact: true }).click()
      await r1.getByText('「拒绝」的结果未知', { exact: true }).waitFor()
      // 重试 is the one clear action: no blue, nothing behind ⋯.
      expect(await r1.locator('.ui-button[data-variant="primary"]').count()).toBe(0)
      expect(await r1.locator('.approval-more').count()).toBe(0)
      await reachable(r1.getByRole('button', { name: '重试', exact: true }))
      await recorder.capture(target, viewport, 'approval-uncertain', 'the outcome of a decision is unknown')
      await target.unroute('**/link/api/approvals/**')

      await openDetails(target, viewport)
      await recorder.capture(target, viewport, 'session-info', 'session information of a session waiting for approval')
      if (viewport.name === 'phone') {
        // A phone changes the session's model in 会话信息: the picker is a sheet, and a switch for the next message says
        // so with the way back, in the page and above the input.
        const info = target.getByRole('region', { name: '会话信息', exact: true })
        await info.getByRole('button', { name: /^模型：/ }).click()
        const models = target.getByRole('dialog', { name: '模型', exact: true })
        await models.waitFor()
        await settleMotion(target)
        await recorder.capture(target, viewport, 'session-info-model', 'the model picker of the session information as a sheet')
        await models.getByRole('radio', { name: /^fixture-small/ }).click()
        await models.waitFor({ state: 'hidden' })
        await info.getByText('下一条消息起使用 fixture-small').waitFor()
        await reachable(info.getByRole('button', { name: '撤销切换', exact: true }))
        await settleMotion(target)
        await recorder.capture(target, viewport, 'session-info-model-switch', 'a model switch for the next message, with the way back')
        // Back in the conversation, a small chip above the input says which model the next message uses.
        await closeDetails(target, viewport)
        const chip = target.locator('.composer-dock .composer-above').getByText(/fixture-small/)
        await chip.waitFor()
        await settleMotion(target)
        await recorder.capture(target, viewport, 'session-next-model', 'the chip above the input after a model switch')
        await openDetails(target, viewport)
        await info.getByRole('button', { name: '撤销切换', exact: true }).click()
        await info.getByText('下一条消息起使用 fixture-small').waitFor({ state: 'detached' })
      }
      if (viewport.name === 'desktop') {
        // The column's edge toward the paper resizes it: its line under a held hover, and with keyboard focus.
        const edge = target.getByRole('separator', { name: '调整会话信息宽度', exact: true })
        await reachable(edge)
        let release = await forceState(target, '.inspector-resize', ['hover'])
        await target.evaluate(() => new Promise(done => setTimeout(done, 500)))
        await recorder.capture(target, viewport, 'inspector-resize-hover', 'the edge of the session information under the pointer')
        await release()
        release = await forceState(target, '.inspector-resize', ['focus', 'focus-visible'])
        await recorder.capture(target, viewport, 'inspector-resize-focus', 'the edge of the session information with keyboard focus')
        await release()
      }
      await closeDetails(target, viewport)

      await openSession(target, viewport, sessions.r2)
      const r2 = target.locator('[data-approval-id]')
      await r2.getByText('高风险操作只能在运行 Latch 的电脑上用 Latch 桌面端批准', { exact: true }).waitFor()
      expect(await r2.getByRole('button', { name: /允许/ }).count()).toBe(0)
      await reachable(r2.getByRole('button', { name: '拒绝', exact: true }))
      await recorder.capture(target, viewport, 'approval-r2-locked', 'R2 on a device that cannot approve it')

      await openSession(target, viewport, sessions.hidden)
      const hidden = target.locator('[data-approval-id]')
      await hidden.getByText(/^内容包含不可见或改变显示方向的字符/).waitFor()
      await reachable(hidden.getByRole('button', { name: '允许一次', exact: true }))
      // Nothing broader than allowing once is one tap away from content that may read as something else.
      expect(await hidden.locator('.approval-more').count()).toBe(0)
      expect(await hidden.locator('.ui-button[data-variant="primary"]').count()).toBe(0)
      await recorder.capture(target, viewport, 'approval-hidden', 'R1 whose content hides characters')

      await openSession(target, viewport, sessions.advisory)
      const advisory = target.locator('[data-approval-id]')
      await advisory.getByText('仅提示', { exact: true }).waitFor()
      // The agent's own words for its option stay in the tooltip; the button reads in the product's words.
      await reachable(advisory.getByRole('button', { name: '拒绝', exact: true }))
      await recorder.capture(target, viewport, 'approval-advisory', 'full-access question shown as advisory')

      // The agent's plan is a chip in the bar above the input; it opens the list.
      const planChip = target.getByRole('button', { name: '计划 0/2', exact: true })
      await reachable(planChip)
      await planChip.click()
      await target.getByText('List the project root', { exact: true }).last().waitFor()
      await settleMotion(target)
      await recorder.capture(target, viewport, 'session-plan-popover', "the plan chip's list open")
      await target.keyboard.press('Escape')

      // The ordinary request on a device without 批准普通操作: the lock and the reason stand where allowing was, and the
      // card still waits for someone (待批准). The snapshot is the Host's own, less that one scope.
      await target.route('**/link/api/snapshot', async route => {
        const response = await route.fetch()
        const snapshot: AppSnapshot = await response.json()
        snapshot.device.scopes = snapshot.device.scopes.filter(scope => scope !== 'approve:standard')
        await route.fulfill({ response, json: snapshot })
      })
      await openSession(target, viewport, sessions.r1)
      const locked = target.locator('[data-approval-id]')
      await locked.getByText('此设备没有「批准普通操作」权限', { exact: true }).waitFor()
      expect(await locked.getByRole('button', { name: /允许/ }).count()).toBe(0)
      await locked.locator('.tool-card-header .ui-waiting-pill', { hasText: '待批准' }).waitFor()
      await reachable(locked.getByRole('button', { name: '拒绝', exact: true }))
      await recorder.capture(target, viewport, 'approval-r1-locked', 'R1 on a device without 批准普通操作')
      await target.unroute('**/link/api/snapshot')

      // A Host of the previous build: no device rights or risk in what it sends, so the card offers plain 拒绝 and
      // 允许一次 under the legacy-Host banner.
      await target.route('**/link/api/snapshot', async route => {
        const response = await route.fetch()
        const body: AppSnapshot = await response.json()
        const { host: _host, ...snapshot } = body
        await route.fulfill({ response, json: { ...snapshot, approvals: previousBuild(snapshot.approvals) } })
      })
      await target.route(`**/link/api/tasks/${sessions.r1}`, async route => {
        if (route.request().method() !== 'GET') return route.fallback()
        const response = await route.fetch()
        const current: TaskDetail = await response.json()
        await route.fulfill({ response, json: { ...current, approvals: previousBuild(current.approvals) } })
      })
      await openSession(target, viewport, sessions.r1)
      const legacy = target.locator('[data-approval-id]')
      await target.getByText('此 Host 仍是旧版本，重启 Host 后启用设备确认。', { exact: true }).waitFor()
      await reachable(legacy.getByRole('button', { name: '允许一次', exact: true }))
      await reachable(legacy.getByRole('button', { name: '拒绝', exact: true }))
      expect(await legacy.locator('.approval-more').count()).toBe(0)
      await recorder.capture(target, viewport, 'approval-legacy', 'a Host of the previous build: plain allow and reject')
      await target.unroute(`**/link/api/tasks/${sessions.r1}`)
      await target.unroute('**/link/api/snapshot')

      // Navigation: the drawer on tablets.
      if (viewport.name === 'tablet') {
        await home(target)
        const drawer = await openDrawer(target)
        for (const name of ['新建会话', '设置', '关闭会话列表']) await reachable(drawer.getByRole('button', { name, exact: true }))
        // The tablet's sliding sidebar draws its status slots at 12.
        await drawer.locator(`[data-task-id="${sessions.running}"] .ui-comet[data-size="12"]`).waitFor()
        await noHorizontalOverflow(target, drawer)
        await settleMotion(target)
        await recorder.capture(target, viewport, 'navigation', 'session list drawer')
        await drawer.getByRole('button', { name: '关闭会话列表', exact: true }).click()
        await target.locator('.drawer-backdrop').waitFor({ state: 'detached' })
      }
      // Navigation on a phone: the session list is the root page.
      if (viewport.name === 'phone') await capturePhoneSessions(target, viewport)

      // On a phone the title's menu holds the session's actions and 同步最新状态, as a sheet.
      if (viewport.name === 'phone') {
        await openSession(target, viewport, sessions.done)
        const title = target.locator('.topbar .topbar-title-button')
        await reachable(title)
        await title.click()
        const menu = target.getByRole('menu', { name: /^会话：/ })
        await menu.waitFor()
        for (const name of ['重命名', '置顶', '归档', '导出 Markdown', '删除', '同步最新状态'])
          await reachable(menu.getByRole('menuitem', { name, exact: true }))
        await settleMotion(target)
        await recorder.capture(target, viewport, 'session-menu', "the title's menu as a sheet")
        await target.keyboard.press('Escape')
        await menu.waitFor({ state: 'hidden' })
        // Back to the list: the page slides away and the list is the page again.
        await backToPhoneSessions(target)
      }
      // The session's own menu opens from its title.
      if (viewport.name !== 'phone') {
        await openSession(target, viewport, sessions.done)
        const title = target.locator('.topbar-title-button')
        await reachable(title)
        await title.click()
        const menu = target.getByRole('menu', { name: /^会话：/ })
        await menu.waitFor()
        for (const name of ['重命名', '置顶', '归档', '导出 Markdown', '删除'])
          await reachable(menu.getByRole('menuitem', { name, exact: true }))
        await recorder.capture(target, viewport, 'session-menu', 'the title button opens the session menu')
        await target.keyboard.press('Escape')
        await menu.waitFor({ state: 'detached' })
        if (viewport.name === 'desktop') {
          // ⋯ holds the same actions and 同步最新状态.
          await target.locator('.topbar').getByRole('button', { name: '会话操作', exact: true }).click()
          const more = target.getByRole('menu', { name: '会话操作', exact: true })
          for (const name of ['重命名', '置顶', '归档', '导出 Markdown', '删除', '同步最新状态'])
            await reachable(more.getByRole('menuitem', { name, exact: true }))
          await recorder.capture(target, viewport, 'session-more-menu', "the top bar's ⋯ menu open")
          await target.keyboard.press('Escape')
          await more.waitFor({ state: 'detached' })
        }
      }

      if (sidebar) {
        // A row under the pointer: the hover fill, and ⋯ in place of its status.
        let release = await forceState(target, `#session-navigation .session-item:has([data-task-id="${sessions.failed}"])`, ['hover'])
        await recorder.capture(target, viewport, 'sidebar-row-hover', 'a row under the pointer, ⋯ in place of its status', sidebar)
        await release()

        // A row's ⋯ menu, which takes the place of its status.
        const unreadRow = sidebar.locator('.session-item', { has: target.locator(`[data-task-id="${sessions.unread}"]`) })
        await unreadRow.hover()
        const more = unreadRow.getByRole('button', { name: /^更多操作：/ })
        await reachable(more)
        await more.click()
        const rowMenu = target.getByRole('menu', { name: /^会话操作：/ })
        await rowMenu.waitFor()
        for (const name of ['重命名', '置顶', '归档', '导出 Markdown', '删除'])
          await reachable(rowMenu.getByRole('menuitem', { name, exact: true }))
        await recorder.capture(target, viewport, 'sidebar-row-menu', "a row's ⋯ menu open", sidebar)
        await target.keyboard.press('Escape')
        await rowMenu.waitFor({ state: 'detached' })

        // Search: the title filter with the filter pills under it.
        const search = sidebar.getByRole('searchbox', { name: '搜索会话', exact: true })
        await search.click()
        const filters = sidebar.getByRole('group', { name: '筛选会话', exact: true })
        for (const name of ['全部', '对话', 'Agent']) await reachable(filters.getByRole('button', { name, exact: true }))
        await search.fill('发布')
        await sidebar.locator(`[data-task-id="${sessions.done}"]`).waitFor({ state: 'detached' })
        await sidebar.locator(`[data-task-id="${sessions.hidden}"]`).waitFor()
        await shellSettled(target)
        await recorder.capture(target, viewport, 'sidebar-search', 'searching titles, with the filter pills', sidebar)
        await search.fill('')
        await search.blur()
        await sidebar.locator('.sidebar-filters:not([data-open])').waitFor({ state: 'attached' })

        // A project group offers a new session in that project.
        const group = sidebar.locator('.session-group', { hasText: 'latch-app' })
        await group.locator('.session-group-head').hover()
        await reachable(group.getByRole('button', { name: '在 latch-app 中新建会话', exact: true }))
        release = await forceState(target, '#session-navigation .session-group[aria-label="latch-app"] .session-group-head', ['hover'])
        await recorder.capture(target, viewport, 'sidebar-group-hover', "a project group's head under the pointer, with its +", sidebar)
        await release()

        // A pinned session leads the list in its own group.
        await local.json(`tasks/${sessions.plan}`, { method: 'PATCH', body: { pinned: true } })
        const pinnedGroup = sidebar.locator('.session-group[aria-label="置顶"]')
        await pinnedGroup.locator(`[data-task-id="${sessions.plan}"]`).waitFor()
        await expect.poll(() => sidebar.locator('[data-leaving]').count()).toBe(0)
        await shellSettled(target)
        await recorder.capture(target, viewport, 'sidebar-pinned', 'a pinned session in the group above the projects', sidebar)
        await local.json(`tasks/${sessions.plan}`, { method: 'PATCH', body: { pinned: false } })
        await pinnedGroup.waitFor({ state: 'detached' })
        await expect.poll(() => sidebar.locator('[data-leaving]').count()).toBe(0)

        // Shut: the column slides away and the top bar offers to open it again.
        await sidebar.getByRole('button', { name: '收起侧栏', exact: true }).click()
        await target.locator('.app-shell[data-sidebar="collapsed"]').waitFor()
        const expand = target.getByRole('button', { name: '展开侧栏', exact: true })
        await expect.poll(() => target.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('展开侧栏')
        await reachable(expand)
        await reachable(target.locator('.topbar').getByRole('button', { name: '新建会话', exact: true }))
        await shellSettled(target)
        await recorder.capture(target, viewport, 'sidebar-collapsed', 'the sidebar shut, opened again from the top bar')
        await expand.click()
        await target.locator('.app-shell[data-sidebar="open"]').waitFor()
        await shellSettled(target)

        // The resize handle on the sidebar's edge: its line under a held hover, and with keyboard focus.
        const handle = target.getByRole('separator', { name: '调整侧栏宽度', exact: true })
        await reachable(handle)
        release = await forceState(target, '.sidebar-resize', ['hover'])
        await target.evaluate(() => new Promise(done => setTimeout(done, 500)))
        await recorder.capture(target, viewport, 'sidebar-resize-hover', 'the resize handle under the pointer')
        await release()
        release = await forceState(target, '.sidebar-resize', ['focus', 'focus-visible'])
        await recorder.capture(target, viewport, 'sidebar-resize-focus', 'the resize handle with keyboard focus')
        await release()

        // Archived sessions: a quiet row at the end of the list opens them under their own filter.
        await local.json(`tasks/${sessions.cancelled}`, { method: 'PATCH', body: { archived: true } })
        const archivedRow = sidebar.getByRole('button', { name: '已归档的会话（1）', exact: true })
        await reachable(archivedRow)
        await expect.poll(() => sidebar.locator('[data-leaving]').count()).toBe(0)
        await shellSettled(target)
        await recorder.capture(target, viewport, 'sidebar-archived-row', 'the quiet 已归档 row at the end of the list', sidebar)
        await archivedRow.click()
        await sidebar.locator('[data-session-filter="archived"]').waitFor()
        await sidebar.locator(`[data-task-id="${sessions.cancelled}"]`).waitFor()
        await shellSettled(target)
        await recorder.capture(target, viewport, 'sidebar-archived', 'the archived filter', sidebar)
        await filters.getByRole('button', { name: '全部', exact: true }).click()
        await local.json(`tasks/${sessions.cancelled}`, { method: 'PATCH', body: { archived: false } })
        await sidebar.locator(`[data-task-id="${sessions.cancelled}"]`).waitFor()
        await expect.poll(() => sidebar.locator('.archived-row').count()).toBe(0)
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
        ['settings-computer', '电脑', settings.getByRole('button', { name: /^在这台电脑上发起：/ })],
        ['settings-providers', '模型服务', settings.getByText('本地模型服务').first()],
        ['settings-agents', 'Agent 成员', settings.getByText('本地 ACP Agent').first()],
        ['settings-workspaces', '项目', settings.getByText('website').first()],
        ['settings-plugins', '插件', settings.getByRole('switch').first()],
        ['settings-devices', '设备', settings.getByText('本机桌面端').first()],
        ['settings-about', '关于', settings.getByText('Apache License 2.0').first()],
      ] as const) {
        await openSection(settings, section)
        await ready.waitFor()
        await noHorizontalOverflow(target, settings)
        await recorder.capture(target, viewport, surface, section)
        if (surface === 'settings-computer') await captureCeilings(target, viewport, settings)
        if (surface === 'settings-devices') {
          // Phone access without HTTPS: the start options open under their disclosure, one per line, never sideways.
          const disclosure = settings.getByRole('button', { name: '用自己的 HTTPS 证书配置（需要重启 Host）', exact: true })
          await disclosure.click()
          await settings.locator('.pair-flags code').waitFor()
          await settleMotion(target)
          await noHorizontalOverflow(target, settings)
          await recorder.capture(target, viewport, 'settings-devices-tls-open', 'the HTTPS start options opened')
          await disclosure.click()
        }
        const top = () => (viewport.name === 'phone' ? settings.locator('.settings-level[data-state="top"]') : settings)
        if (surface === 'settings-providers') {
          // A saved service's page: its connection, key, models and the red group, every value in a card.
          await settings.getByRole('button', { name: /^DeepSeek/ }).click()
          await reachable(top().getByRole('switch', { name: '启用', exact: true }))
          await reachable(top().getByRole('button', { name: '检测连接', exact: true }))
          await reachable(top().getByRole('button', { name: '获取模型', exact: true }))
          await reachable(top().getByRole('radio', { name: '默认使用 deepseek-reasoner', exact: true }))
          await reachable(top().getByRole('button', { name: '删除', exact: true }))
          await noHorizontalOverflow(target, settings)
          await recorder.capture(target, viewport, 'settings-provider', 'a saved model service')
          await backToSection(settings)
          // Every model-service preset with its brand's icon (a custom service has the plug glyph).
          await settings.getByRole('button', { name: '添加服务…', exact: true }).click()
          const presets = top().locator('.preset-card')
          await expect.poll(() => presets.count()).toBe(13)
          expect(await presets.locator('.ui-tile').count()).toBe(13)
          await noHorizontalOverflow(target, settings)
          await recorder.capture(target, viewport, 'settings-provider-presets', 'choosing a model-service preset')
          // Adding one: fields in cards, the check, the models and 保存服务 at the end; a browser cannot set keys.
          await top()
            .getByRole('button', { name: /^OpenAI/ })
            .click()
          for (const control of [
            top().getByLabel('名称', { exact: true }),
            top().getByLabel('API 地址', { exact: true }),
            top().getByRole('button', { name: '检测连接', exact: true }),
            top().getByLabel('手动添加模型 ID', { exact: true }),
            top().getByRole('button', { name: '保存服务', exact: true }),
          ])
            await reachable(control, { allowDisabled: true })
          await top()
            .getByText('这个服务需要密钥：保存后，在运行 Latch 的电脑上 设置 › 模型服务 填写密钥，它才能使用。', { exact: true })
            .waitFor()
          await noHorizontalOverflow(target, settings)
          await recorder.capture(target, viewport, 'settings-provider-add', 'adding a model service from a preset')
          await backToSection(settings)
        }
        if (surface === 'settings-agents') {
          // An agent's page: 启用, its definition read-only in a browser, detection with the path and the red group.
          await settings.getByRole('button', { name: '编辑 本地 ACP Agent', exact: true }).click()
          await reachable(top().getByRole('switch', { name: '启用', exact: true }))
          await reachable(top().getByRole('button', { name: '重新检测', exact: true }))
          await reachable(top().getByRole('button', { name: '复制命令路径', exact: true }))
          await reachable(top().getByRole('button', { name: '删除', exact: true }))
          await noHorizontalOverflow(target, settings)
          await recorder.capture(target, viewport, 'settings-agent', 'an added agent')
          await backToSection(settings)
        }
      }
      await closeSettings(settings)
    },
    600_000,
  )

  // ---- A device that cannot manage the Host ------------------------------------------------------------------

  it.each(VISUAL_VIEWPORTS)(
    'captures 设置 › 电脑 read-only for a device without 管理此 Host at $name width',
    async viewport => {
      const target = readOnlyPages.get(viewport.name)!.page
      await target.goto(`${host.loopbackOrigin}/link/`)
      await connected(target)
      {
        const settings = await openSettings(target, '设置')
        await openSection(settings, '电脑')
        await settings.getByRole('heading', { name: '权限上限', exact: true }).waitFor()
        // The ceilings are values here, with no picker; the caption says who can change them.
        expect(await settings.getByRole('button', { name: /^在这台电脑上发起：/ }).count()).toBe(0)
        await settings.getByText('只有能管理此 Host 的设备可以修改上限。', { exact: true }).waitFor()
        await noHorizontalOverflow(target, settings)
        await recorder.capture(target, viewport, 'settings-computer-readonly', 'the ceilings for a device that cannot manage the Host')
        await closeSettings(settings)
      }
    },
    120_000,
  )

  // ---- The primitives -----------------------------------------------------------------------------------------

  it('captures the gallery of the design system primitives at each viewport', async () => {
    const gallery = await serveGallery()
    try {
      for (const viewport of VISUAL_VIEWPORTS) {
        const context = await visualContext(browser, viewport)
        try {
          const target = await context.newPage()
          await target.goto(gallery.url)
          const main = target.getByRole('main', { name: '@latch/ui' })
          await main.waitFor()
          await forceGalleryStates(target)
          // Samples that open as they mount (a disclosure, the reason under a row of tiles) have finished moving.
          await settleMotion(target)
          // Capture each section within the viewport. A single phone gallery exceeds Chromium's texture limit;
          // captureBeyondViewport can also drop touch emulation, so every section must fit before it is captured.
          const sections = main.locator('.gallery-header, .gallery-section')
          for (const section of await sections.all()) {
            const name = (await section.getAttribute('aria-label')) ?? 'overview'
            const before = await section.boundingBox()
            expect(before).not.toBeNull()
            await target.setViewportSize({ width: viewport.width, height: Math.max(viewport.height, Math.ceil(before!.height) + 32) })
            await section.scrollIntoViewIfNeeded()
            const box = await section.boundingBox()
            expect(box && box.height <= (target.viewportSize()?.height ?? 0)).toBe(true)
            const switchTrack = await target
              .getByRole('switch')
              .first()
              .evaluate(element => getComputedStyle(element, '::before').width)
            expect(switchTrack).toBe(viewport.touch ? '44px' : '32px')
            await recorder.capture(target, viewport, `ui-gallery-${name}`, `design system: ${name}`, section)
          }
        } finally {
          await context.close()
        }
      }
    } finally {
      await gallery.close()
    }
  })

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
