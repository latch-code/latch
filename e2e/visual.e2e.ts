import { chromium, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { build, preview } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentPresetSettings, AgentSettings, AppSnapshot, Approval, TaskDetail, TaskStatus, TurnChanges } from '@latch/protocol'
import { AppError, type HarnessPlugin, type ModelDelta, type ToolDefinition } from '@latch/sdk'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, connected, nameNextEnrollment } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import {
  backToSection,
  noHorizontalOverflow,
  openSection,
  openSettings,
  backToPhoneSessions,
  openSession as openListedSession,
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

/** A reply with code that arrives: a long open fence, with a line too long for any width, then its end. */
const ARRIVING_CODE = `这是设置页保存路径的完整实现：

\`\`\`ts
${Array.from({ length: 30 }, (_, index) =>
  index % 7 === 3
    ? `// 第 ${index + 1} 行：省略表示保留，null 表示清除，这条说明长到任何宽度都放不下，需要横向滚动才能读到结尾。`
    : `export const field${index + 1} = await readProvider("provider-${index + 1}", { retry: ${index % 3} })`,
).join('\n')}
export const last`
let releaseArrivingCode: (() => void) | undefined

const PROMPTS = {
  code: '给我设置页保存路径的完整实现',
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
        if (messages[last]?.content === PROMPTS.code) {
          advance(1200)
          yield text(ARRIVING_CODE)
          await new Promise<void>(done => {
            releaseArrivingCode = done
          })
          signal.throwIfAborted()
          advance(1200)
          yield text(' = true\n```\n\n以上就是全部。')
          yield stop
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

/** The tablet's session list, which slides over from the left. */
async function openDrawer(target: Page): Promise<Locator> {
  await target.getByRole('button', { name: '打开会话列表', exact: true }).filter({ visible: true }).first().click()
  const drawer = target.getByRole('dialog', { name: '会话导航', exact: true })
  await drawer.waitFor()
  return drawer
}

/** The right panel beside the conversation on the desktop, a sheet over it on tablets, a pushed page on phones. */
async function openDetails(target: Page, viewport: VisualViewport): Promise<void> {
  const toggle = target.locator('.topbar').getByRole('button', { name: '侧边面板', exact: true })
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
  if (viewport.name === 'phone') await target.getByRole('region', { name: '侧边面板', exact: true }).locator('.session-panels').waitFor()
  else await target.getByRole('complementary', { name: '侧边面板', exact: true }).locator('.session-panels').waitFor()
  await settleMotion(target)
}

async function closeDetails(target: Page, viewport: VisualViewport): Promise<void> {
  if (viewport.name === 'phone') {
    await target.getByRole('button', { name: '返回', exact: true }).click()
    await target.locator('.info-page').waitFor({ state: 'detached' })
    return
  }
  if (viewport.name === 'tablet') {
    const panel = target.getByRole('complementary', { name: '侧边面板', exact: true })
    if (await panel.isVisible()) {
      const close = panel.getByRole('button', { name: '关闭', exact: true })
      await reachable(close)
      await close.click()
      await panel.waitFor({ state: 'hidden' })
    }
    return
  }
  const toggle = target.locator('.topbar').getByRole('button', { name: '侧边面板', exact: true })
  if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click()
  await settleMotion(target)
}

/** A diff's two sides colour as separate jobs, and motion settling says nothing about either. */
async function diffColoured(target: Page): Promise<void> {
  for (const side of ['remove', 'add']) {
    await target.locator(`.diff-view .diff-${side} [class^="syn-"]`).first().waitFor({ state: 'attached' })
  }
}

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

/** Optional approval metadata may be absent; a current Host must then display the conservative R2 fallback. */
const withoutApprovalMetadata = (approvals: Approval[]): Approval[] =>
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
      uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
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
    releaseArrivingCode?.()
    // A failed setup may not have assigned sessions yet; settle every run this fixture started before closing its Host.
    if (host)
      for (const task of await host.bridge.listTasks())
        if (task.status === 'running' || task.status === 'waiting-approval') await host.bridge.cancel(task.id).catch(() => {})
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
  /** A run's files are watched for moments after it ends, and the next session writes in the same folder. */
  async function watchEnded(id: string): Promise<void> {
    await expect.poll(async () => (await detail(id)).messages.some(message => message.outputsPending), { timeout: 20_000 }).toBe(false)
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
  async function home(target: Page, reducedMotion: 'reduce' | 'no-preference' = 'no-preference'): Promise<void> {
    await target.context().setOffline(false)
    await target.emulateMedia({ reducedMotion })
    await target.evaluate(() => sessionStorage.clear())
    await target.goto(`${host.loopbackOrigin}/link/`)
    await connected(target)
  }
  /** The new session is the home's input on every width; 新建会话 leads there and focuses it. */
  async function newSession(target: Page): Promise<void> {
    // Each capture starts with the Host's default choice, not a model selected by an earlier surface.
    await target.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith('latch.composer.')) localStorage.removeItem(key)
    })
    await home(target, 'reduce')
    // The home keeps its draft and its first card arms again each time it is shown: every capture starts from an
    // empty input and a card that takes presses.
    const settled = async () => {
      await target.locator('.workbench-home').getByRole('textbox', { name: '新会话消息', exact: true }).fill('')
      await expect.poll(() => target.locator('.workbench-home :is(.approval-panel, .question-card)[data-arming]').count()).toBe(0)
    }
    if ((await target.locator('.phone-tabs').count()) > 0) {
      // A phone's Code tab is the home; its options are the row of chips over the input.
      await target.locator('.workbench-home').getByRole('group', { name: '会话选项', exact: true }).waitFor()
      await settled()
      await settleMotion(target)
      return
    }
    await target.getByRole('button', { name: '新建会话', exact: true }).filter({ visible: true }).first().click()
    await target.locator('.workbench-home').getByRole('textbox', { name: '新会话消息', exact: true }).waitFor()
    await target.locator('.drawer-backdrop').waitFor({ state: 'detached' })
    await settled()
  }
  /** A session from the list: the sidebar, the tablet's drawer, or a phone's list (the session's page pushed over it). */
  async function openSession(target: Page, viewport: VisualViewport, id: string): Promise<void> {
    await home(target)
    await openListedSession(target, id)
    await target.locator('.drawer-backdrop').waitFor({ state: 'detached' })
    if (viewport.name === 'phone') await target.locator('.phone-list[data-covered]').waitFor()
    await target.locator(`[data-task-id="${id}"][aria-current="page"]`).waitFor({ state: 'attached' })
    await target.locator('.transcript-content').waitFor()
    await target.locator('.transcript .ui-loading').waitFor({ state: 'detached' })
    // The read marker is stored by an effect after the transcript renders; let it run before anything reloads the page.
    await target.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  }

  /**
   * A phone's explicit history page: 等你处理 and a section per group, its search, the menu of a row pressed and
   * held, a pinned session and the archived filter. Every change made here is undone before it returns.
   */
  async function capturePhoneSessions(target: Page, viewport: VisualViewport): Promise<void> {
    await home(target)
    await backToPhoneSessions(target)
    const list = target.locator('#session-navigation')
    const head = list.locator('.phone-list-head')
    await reachable(head.getByRole('button', { name: '新建会话', exact: true }))
    await reachable(list.locator('.phone-group[data-shelf="waiting"]').locator('[data-task-id]').first())
    // The rows say their state in status words; the second line adds what the slot does not say, never a preview.
    const row = (id: string) => list.locator(`[data-task-id="${id}"]`)
    // Rows still moving when a click scrolls them into view land the list at a different offset on each run.
    const scrollList = (to: 'top' | 'end') =>
      list.locator('.phone-list-scroll').evaluate((element, end) => {
        element.scrollTop = end ? element.scrollHeight : 0
      }, to === 'end')
    await row(sessions.running).locator('.ui-status-word[data-tone="running"] .ui-spinner').waitFor()
    await row(sessions.cancelled).locator('.ui-status-word', { hasText: '已停止' }).waitFor()
    await row(sessions.r1).locator('.ui-status-word', { hasText: '等你处理' }).waitFor()
    await noHorizontalOverflow(target)
    await settleMotion(target)
    await recorder.capture(target, viewport, 'navigation', 'the complete session history reached from Home')

    // Search filters the titles; 取消 clears it.
    const search = list.getByRole('searchbox', { name: '搜索会话', exact: true })
    await search.fill('发布')
    await row(sessions.done).waitFor({ state: 'detached' })
    await row(sessions.hidden).waitFor()
    // The search of message text answers on its own time, and its results push the list down.
    await list.locator('.content-search[aria-busy="false"]').waitFor()
    await settleMotion(target)
    await recorder.capture(target, viewport, 'navigation-search', 'searching titles and message text')
    await list.getByRole('button', { name: '取消', exact: true }).click()
    await row(sessions.done).waitFor()
    await settleMotion(target)

    // A row pressed and held (or its context menu) opens the session's menu as a sheet.
    const title = (await detail(sessions.unread)).summary.title
    await row(sessions.unread).click({ button: 'right' })
    const rowMenu = target.getByRole('menu', { name: title, exact: true })
    await rowMenu.waitFor()
    for (const name of ['重命名', '置顶', '归档', '导出 Markdown', '删除'])
      await reachable(rowMenu.getByRole('menuitem', { name, exact: true }))
    await settleMotion(target)
    await scrollList('top')
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
      await scrollList('top')
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
    await scrollList('top')
    await recorder.capture(target, viewport, 'navigation-row-menu-long', "a long-titled row's menu")
    await target.keyboard.press('Escape')
    await longMenu.waitFor({ state: 'hidden' })
    await local.json(`tasks/${sessions.unread}`, { method: 'PATCH', body: { title } })
    await row(sessions.unread).getByText(title, { exact: true }).waitFor()

    // A pinned session leads its section, marked with the pin.
    await local.json(`tasks/${sessions.plan}`, { method: 'PATCH', body: { pinned: true } })
    const pinned = row(sessions.plan).locator('.session-pin')
    await pinned.waitFor()
    await expect.poll(() => list.locator('[data-leaving]').count()).toBe(0)
    // The menus closed from the keyboard and gave focus back to a lower row; a touch leaves none.
    await target.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    })
    await settleMotion(target)
    await scrollList('top')
    await recorder.capture(target, viewport, 'navigation-pinned', 'a pinned session at the head of its section')
    await local.json(`tasks/${sessions.plan}`, { method: 'PATCH', body: { pinned: false } })
    await pinned.waitFor({ state: 'detached' })
    await expect.poll(() => list.locator('[data-leaving]').count()).toBe(0)

    // Once something is archived, the list ends with 已归档.
    await local.json(`tasks/${sessions.cancelled}`, { method: 'PATCH', body: { archived: true } })
    const archived = list.getByRole('button', { name: /^已归档的会话/ })
    await reachable(archived)
    await archived.click()
    await list.locator('[data-session-filter="archived"]').waitFor()
    await row(sessions.cancelled).waitFor()
    await settleMotion(target)
    await recorder.capture(target, viewport, 'navigation-archived', 'the archived list')
    await list.locator('.phone-archived-back').click()
    await local.json(`tasks/${sessions.cancelled}`, { method: 'PATCH', body: { archived: false } })
    await row(sessions.cancelled).waitFor()
    await expect.poll(() => archived.count()).toBe(0)

    // The computer it comes from heads the list; the list no longer ends with a way to sync (the notices have 重试).
    expect(await list.locator('.phone-list-host').innerText()).toBe(HOST_NAME)
    expect(await list.getByRole('button', { name: '同步最新状态', exact: true }).count()).toBe(0)
    await settleMotion(target)
    await scrollList('end')
    await recorder.capture(target, viewport, 'navigation-end', 'the end of the list')

    // Offline, the list says so at its top, with 重试.
    await pages.get(viewport.name)!.context.setOffline(true)
    const banner = list.locator('.banner-region').getByText('这台设备没有联网', { exact: true })
    await banner.waitFor()
    await reachable(list.locator('.banner-region').getByRole('button', { name: '重试', exact: true }))
    await list.locator('.ui-collapse[data-settled] > .ui-collapse-inner > .banner-region').first().waitFor()
    await settleMotion(target)
    await scrollList('top')
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
      await target.getByText(/^这个浏览器还没连接到 Latch。/).waitFor()
      await recorder.capture(target, viewport, 'enrollment-invitation', 'browser without an invitation')
      const invitation = await testHost.invite(['view', 'run', 'approve:standard', 'approve:elevated', 'admin'], 'loopback-tcp')
      await target.goto(invitation.url)
      await target.getByRole('heading', { name: '连接到 Latch', exact: true }).waitFor()
      await nameNextEnrollment(target, DEVICE_NAMES[viewport.name])
      // Every browser device here manages the Host (its invitation allows it), so each one reaches all settings.
      await reachable(target.getByRole('button', { name: '连接这个浏览器', exact: true }))
      await recorder.capture(target, viewport, 'enrollment', 'form')

      await target.getByRole('button', { name: '连接这个浏览器', exact: true }).click()
      await testHost.presence.waitForRequest()
      await target.getByRole('heading', { name: '在 Mac 上确认', exact: true }).waitFor()
      await reachable(target.getByRole('button', { name: '取消', exact: true }))
      await recorder.capture(target, viewport, 'enrollment-waiting', 'waiting for local confirmation')

      // Refused on the Host computer: that request used the invitation up, so the outcome stands above the way to a new
      // link, and the browser comes back with a new one.
      testHost.presence.denyNext()
      await target.getByText('Mac 上取消了连接。', { exact: true }).waitFor()
      await target.getByText(/^这个浏览器还没连接到 Latch。/).waitFor()
      await recorder.capture(target, viewport, 'enrollment-denied', 'refused on the Host computer')

      await target.goto((await testHost.invite(['view', 'run', 'approve:standard', 'approve:elevated', 'admin'], 'loopback-tcp')).url)
      await nameNextEnrollment(target, DEVICE_NAMES[viewport.name])
      await target.getByRole('button', { name: '连接这个浏览器', exact: true }).click()
      await testHost.presence.waitForRequest()
      await target.getByRole('heading', { name: '在 Mac 上确认', exact: true }).waitFor()
      testHost.presence.approveNext()
      await connected(target)
      await target.locator('.workbench-empty').getByText('还没有会话', { exact: true }).waitFor()
      await reachable(target.locator('.workbench-home').getByRole('textbox', { name: '新会话消息', exact: true }))
      if (viewport.name === 'phone')
        await reachable(target.locator('.workbench-home .composer-chips').getByRole('button', { name: /^项目：/u }))
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
      await readOnly.goto((await testHost.invite(['view', 'run', 'approve:standard', 'approve:elevated'], 'loopback-tcp')).url)
      await readOnly.getByRole('heading', { name: '连接到 Latch', exact: true }).waitFor()
      await nameNextEnrollment(readOnly, `只读的${DEVICE_NAMES[viewport.name].replace(/^我的/, '')}`)
      await readOnly.getByRole('button', { name: '连接这个浏览器', exact: true }).click()
      await testHost.presence.waitForRequest()
      testHost.presence.approveNext()
      await connected(readOnly)
    }
  })

  // ---- Phase 2: sessions in every state --------------------------------------------------------------------

  it('drives sessions into every state through the Host API', async () => {
    local = await testHost.enroll({ listener: 'unix', name: '本机桌面端' })
    // Full file/diff surfaces require explicit data access before any L3 session can block widening.
    // The separate non-admin devices remain work-scoped for restricted file and settings captures.
    for (const { page: target } of pages.values()) {
      const device = await target.evaluate(async () => {
        const snapshot: AppSnapshot = await (await fetch('/link/api/snapshot')).json()
        return snapshot.device
      })
      expect(device.dataScope).toBe('work')
      await local.confirmedJson(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
      expect(
        await target.evaluate(async () => {
          const snapshot: AppSnapshot = await (await fetch('/link/api/snapshot')).json()
          return snapshot.device.dataScope
        }),
      ).toBe('all')
    }
    // Projects are added from the desktop app, which signs the request in its main process.
    expect((await local.addFolders({ paths: [join(projects, 'website')], name: 'website' })).status).toBe(201)
    const saved = await local.confirmed('agents', {
      method: 'POST',
      body: { name: '本地 ACP Harness', command: process.execPath, args: [FAKE_ACP_AGENT], env: {} },
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
      // Further apart than a run's start may precede its prompt, so each turn finds its own record.
      advance(5_000)
      await local.json(`tasks/${plan}/prompt`, { method: 'POST', body: { prompt, requestId: randomUUID() } })
      await expect
        .poll(async () => {
          const current = await detail(plan)
          return [current.messages.filter(message => message.role === 'user').length, current.summary.status]
        })
        .toEqual([turn + 2, 'idle'])
    }
    // The next session writes in this folder: the last turn is recorded first, or those writes would count as its own.
    await expect
      .poll(async () => (await local.json<{ turns: TurnChanges[] }>(`tasks/${plan}/changes/turns`)).turns.at(-1)?.state)
      .toBe('settled')
    await watchEnded(plan)
    await local.json(`tasks/${plan}`, { method: 'PATCH', body: { title: '梳理会话恢复的实现' } })

    const done = await start(PROMPTS.done)
    const write = await pendingApproval(done)
    // The person takes a while to look at the change; the turn's working time leaves the wait out.
    advance(35_000)
    await allow(write)
    await settled(done, 'idle')
    await watchEnded(done)

    const failed = await start(PROMPTS.failed)
    await allow(await pendingApproval(failed))
    await settled(failed, 'failed')
    await watchEnded(failed)

    const cancelled = await start(PROMPTS.cancelled)
    await allow(await pendingApproval(cancelled))
    await toolRunning(cancelled)
    // The desktop page watches the run end: its tool row's spinner cross-fades into the tool's icon and the words of
    // the new state fade in.
    const watching = pages.get('desktop')!.page
    await openSession(
      watching,
      VISUAL_VIEWPORTS.find(item => item.name === 'desktop')!,
      cancelled,
    )
    await watching.locator('.tool-card .tool-card-icon .ui-spinner').waitFor()
    await local.json(`tasks/${cancelled}/cancel`, { method: 'POST' })
    await settled(cancelled, 'cancelled')
    await watching.locator('.tool-card-icon[data-shift] > .ui-status-glyph-leaving .ui-spinner').waitFor({ state: 'attached' })
    await watching.locator('.tool-card-state[data-shift]', { hasText: '已取消' }).waitFor()
    await home(watching)
    await watchEnded(cancelled)

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
    // The first approval joins the already failed session in Home's attention group; the live count changes from one to two.
    await pages
      .get('desktop')!
      .page.locator('.workbench-home [data-group="attention"] .ui-count[data-shift]', { hasText: /^2$/u })
      .waitFor({ state: 'attached' })
    await pages
      .get('tablet')!
      .page.locator('.workbench-home [data-group="attention"] .ui-count[data-shift]', { hasText: /^2$/u })
      .waitFor({ state: 'attached' })
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
      // read while the page watches cross-fades its row's check into its time.
      const settles: boolean[] = []
      for (const seen of Object.values(sessions).filter(id => id !== sessions.unread)) {
        const row = target.locator(`#session-navigation [data-task-id="${seen}"]`)
        const wasUnread = viewport.name === 'desktop' && (await row.locator('.ui-status-unread').count()) > 0
        await openSession(target, viewport, seen)
        if (wasUnread && (await row.locator('.ui-status-shown > .ui-status-time').count()) > 0)
          settles.push((await row.locator('.ui-status-slot[data-shift]').count()) > 0)
      }
      if (viewport.name === 'desktop') {
        expect(settles.length).toBeGreaterThan(0)
        expect(new Set(settles)).toEqual(new Set([true]))
      }
      await home(target)
      await expect
        .poll(() =>
          target
            .locator('.session-item.is-unread [data-task-id], .phone-row.is-unread[data-task-id]')
            .evaluateAll(items => items.map(item => item.dataset.taskId)),
        )
        .toEqual([sessions.unread])

      // New session: the question and the input with its one control.
      await newSession(target)
      const composer = target.getByRole('textbox', { name: '新会话消息', exact: true })
      await reachable(composer)
      await reachable(target.locator('.workbench-home').getByRole('button', { name: '发送', exact: true }), { allowDisabled: true })
      await recorder.capture(target, viewport, 'new-session', 'empty')
      await target.getByRole('textbox', { name: '新会话消息', exact: true }).blur()
      await settleMotion(target)
      if (viewport.name !== 'phone')
        await recorder.capture(target, viewport, 'new-session-draft', 'the quiet empty workspace with compact agent choices')
      // A draft opens on a Harness that can run commands; the services' surfaces belong to the built-in one.
      await target.getByRole('button', { name: /^Harness：/ }).click()
      await target.getByRole(viewport.name === 'phone' ? 'radio' : 'menuitemradio', { name: /Latch 内置/ }).click()
      await settleMotion(target)
      if (viewport.name === 'phone') {
        const sheet = target.locator('.workbench-home .composer-chips')
        // The project and the model are chips that open single-choice sheets of their own.
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
          .locator('.setup-panel-note', { hasText: '的 设置 › 模型 里填写' })
          .waitFor()
        await settleMotion(target)
        await recorder.capture(target, viewport, 'new-session-model-add-key', 'a service that needs a key, on a device that cannot set one')
        await target.keyboard.press('Escape')
        await target.getByRole('region', { name: 'DeepSeek', exact: true }).waitFor({ state: 'hidden' })
      }
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
      await target.getByRole('button', { name: /^Harness：/ }).click()
      await target.getByRole(viewport.name === 'phone' ? 'radio' : 'menuitemradio', { name: /Latch 内置/ }).click()
      // The phone sheet covers Home's same setup state; only the modal's controls may be reached.
      const setup = target.locator('.workbench-home .setup-card')
      await setup.getByText('还没有模型服务。', { exact: true }).waitFor()
      expect(await target.getByRole('button', { name: '添加模型服务', exact: true }).count()).toBe(1)
      await reachable(setup.getByRole('button', { name: '添加模型服务', exact: true }))
      await reachable(target.locator('.workbench-home').getByRole('button', { name: '发送', exact: true }), { allowDisabled: true })
      await recorder.capture(target, viewport, 'new-session-setup', 'no model service yet: the card that adds one')
      await setup.getByRole('button', { name: '添加模型服务', exact: true }).click()
      const inCard = setup.getByRole('region', { name: '添加模型服务', exact: true })
      await reachable(inCard.getByRole('button', { name: 'DeepSeek', exact: true }))
      await settleMotion(target)
      await recorder.capture(target, viewport, 'new-session-setup-add', 'the services to add, opened inside the card')
      await target.unroute('**/link/api/snapshot')

      // The built-in demo model is marked, on the page's header or the sheet. The catalog reads the scripted service as
      // the demo one for this.
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
      await target.getByRole('button', { name: /^Harness：/ }).click()
      await target.getByRole(viewport.name === 'phone' ? 'radio' : 'menuitemradio', { name: /Latch 内置/ }).click()
      await target
        .getByText(/^演示/u)
        .filter({ visible: true })
        .first()
        .waitFor()
      await recorder.capture(target, viewport, 'new-session-demo', 'the demo model is marked')
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
        // A device with nothing remembered: more than one engine, so it asks, with none marked.
        await desktopApp.addInitScript(() => {
          for (const key of Object.keys(localStorage)) if (key.startsWith('latch.composer.')) localStorage.removeItem(key)
        })
        await presetsAsMissing(desktopApp)
        await desktopApp.emulateMedia({ reducedMotion: 'reduce' })
        await desktopApp.goto(`${host.loopbackOrigin}/link/`)
        await connected(desktopApp)
        await desktopApp.getByRole('button', { name: '新建会话', exact: true }).filter({ visible: true }).first().click()
        await desktopApp.locator('.workbench-home').getByRole('textbox', { name: '新会话消息', exact: true }).waitFor()
        // Nothing to answer first: the Harness it found is already chosen.
        expect(await desktopApp.getByRole('button', { name: /^Harness：本地 ACP Harness/ }).count()).toBe(1)
        // Nothing typed yet: the start button rests on the same neutral fill as an empty send, its lock kept.
        const startButton = desktopApp.getByRole('button', { name: '发送', exact: true })
        await reachable(startButton, { allowDisabled: true })
        expect(await startButton.getAttribute('aria-disabled')).toBe('true')
        await desktopApp.evaluate(() => new Promise(done => setTimeout(done, 400)))
        await recorder.capture(desktopApp, viewport, 'new-session-full-access-empty', 'starting a full-access session, nothing typed yet')
        await desktopApp.getByRole('textbox', { name: '新会话消息', exact: true }).fill('列出项目根目录')
        await reachable(desktopApp.getByRole('button', { name: '发送', exact: true }))
        expect(await desktopApp.getByText('Latch 不隔离它', { exact: true }).count()).toBe(0)
        await desktopApp.getByRole('textbox', { name: '新会话消息', exact: true }).blur()
        await desktopApp.evaluate(() => new Promise(done => setTimeout(done, 400)))
        await recorder.capture(desktopApp, viewport, 'new-session-full-access', 'starting a full-access session in the desktop app')
        // An engine is added where it is chosen: the presets not added yet, then one of them with its install command.
        await desktopApp.getByRole('button', { name: /^Harness：/ }).click()
        await desktopApp.getByRole('menuitem', { name: '添加 Harness…', exact: true }).click()
        const presets = desktopApp.getByRole('group', { name: '添加 Harness', exact: true })
        await reachable(presets.getByRole('button', { name: /^Codex/ }))
        await desktopApp.evaluate(() => new Promise(done => setTimeout(done, 400)))
        await recorder.capture(desktopApp, viewport, 'new-session-harness', 'the engines that can be added')
        await presets.getByRole('button', { name: /^Codex/ }).click()
        const codex = desktopApp.getByRole('region', { name: 'Codex', exact: true })
        await reachable(codex.getByRole('button', { name: '复制安装命令', exact: true }))
        await desktopApp.evaluate(() => new Promise(done => setTimeout(done, 400)))
        await recorder.capture(desktopApp, viewport, 'new-session-add-agent', 'one engine: what is missing and how to install it')
        await desktopApp.keyboard.press('Escape')
        await desktopApp.close()
      }

      // Sessions in each state.
      const sidebar = viewport.name === 'desktop' ? target.locator('#session-navigation') : undefined
      await openSession(target, viewport, sessions.running)
      await shows(target, '用例覆盖了省略密钥的情况，运行一次确认。')
      await reachable(target.getByRole('button', { name: '停止', exact: true }))
      // Running work turns the spinner on its tool row, and the title row says what runs and for how long, once: no line
      // is drawn under the turn. The bar above the input says nothing then, and the open session's own row says it runs
      // like any other.
      await target.locator('.tool-card .ui-spinner').first().waitFor()
      await target.locator('.topbar .ui-status-word').filter({ visible: true }).first().waitFor()
      expect(await target.locator('.status-line, .status-clock').count()).toBe(0)
      expect(await target.locator('.run-bar-collapse[data-state="open"]').count()).toBe(0)
      if (sidebar)
        expect(await sidebar.locator(`[data-task-id="${sessions.running}"] .ui-spinner`).filter({ visible: true }).count()).toBe(1)
      await settleMotion(target)
      await recorder.capture(target, viewport, 'session-running', 'tool running')
      if (sidebar) await recorder.capture(target, viewport, 'sidebar-running', 'running session selected', sidebar)

      await pages.get(viewport.name)!.context.setOffline(true)
      await target.getByText('这台设备没有联网', { exact: true }).filter({ visible: true }).first().waitFor()
      // The banner at the top of the conversation unfolds like a disclosure.
      await target.locator('.ui-collapse[data-settled] > .ui-collapse-inner > .banner-region').first().waitFor()
      await settleMotion(target)
      await recorder.capture(target, viewport, 'session-offline', 'client offline while a tool runs')
      if (sidebar) await recorder.capture(target, viewport, 'sidebar-offline', 'offline', sidebar)
      await pages.get(viewport.name)!.context.setOffline(false)
      await connected(target)

      // Stopping: the bar over the input says the outcome of a stop that never answered, the title row a stop under way.
      // Neither request reaches the Host, so the run goes on; the next page load forgets both.
      await target.route('**/link/api/tasks/*/cancel', route => route.abort('connectionreset'))
      await target.getByRole('button', { name: '停止', exact: true }).click()
      const runBar = target.locator('.run-bar')
      // Said once, here: 「尚未确认 · 重试」, with no red notice above the input and the stop button still a square.
      await runBar.locator('.run-bar-status', { hasText: '尚未确认' }).waitFor()
      await reachable(runBar.getByRole('button', { name: '重试', exact: true }))
      expect(await target.locator('.composer-stack > .ui-notice').count()).toBe(0)
      await target.locator('.stop-button .stop-glyph').waitFor()
      // Nothing is known to be stopping: the title row says what runs again and claims no 正在停止.
      await target.locator('.topbar .ui-status-word').filter({ visible: true }).first().waitFor()
      expect(await target.locator('.status-line').count()).toBe(0)
      expect(await target.locator('.topbar').getByText('正在停止', { exact: true }).count()).toBe(0)
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
      await target.locator('.topbar').getByText('正在停止', { exact: true }).filter({ visible: true }).first().waitFor()
      expect(await target.locator('.status-line').count()).toBe(0)
      expect(await target.getByRole('button', { name: '停止', exact: true }).getAttribute('aria-disabled')).toBe('true')
      await settleMotion(target)
      await recorder.capture(target, viewport, 'session-stopping', 'a stop under way')
      releaseStop?.()
      await runBar.locator('.run-bar-status', { hasText: '尚未确认' }).waitFor()
      await target.unroute('**/link/api/tasks/*/cancel')
      expect(await status(sessions.running)).toBe('running')

      // Reasoning still streaming: the thinking row says so with its light and its seconds, the status line how long the
      // run has worked.
      await openSession(target, viewport, sessions.thinking)
      await target.locator('.thinking.is-live').getByText('思考中', { exact: true }).waitFor()
      await target.locator('.thinking.is-live .process-time').waitFor()
      await settleMotion(target)
      await recorder.capture(target, viewport, 'session-thinking', 'reasoning streams')

      await openSession(target, viewport, sessions.done)
      await shows(target, /建议再补一条/)
      if (sidebar) {
        // The project tree uses a complete glyph instead of clipping status words; its accessible name retains the state.
        const row = (id: string) => sidebar.locator(`[data-task-id="${id}"]`)
        await row(sessions.running).locator('.session-row-glyph[data-tone="running"] .ui-spinner').waitFor()
        for (const id of [sessions.r1, sessions.r2, sessions.hidden, sessions.advisory]) {
          await row(id).locator('.session-row-glyph[data-tone="waiting"]').waitFor()
          expect(await row(id).locator('.sr-only').textContent()).toContain('等你处理')
        }
        await row(sessions.failed).locator('.session-row-glyph[data-tone="failed"]').waitFor()
        expect(await row(sessions.failed).locator('.sr-only').textContent()).toContain('失败')
        expect(await row(sessions.cancelled).locator('.sr-only').textContent()).toContain('已停止')
        await row(sessions.unread).locator('.session-row-glyph[data-tone="neutral"]').waitFor()
        expect(await row(sessions.unread).locator('..').getAttribute('class')).toContain('is-unread')
        expect(await row(sessions.unread).locator('.sr-only').textContent()).toContain('有新内容')
        await row(sessions.plan).locator('.session-row-glyph[data-tone="neutral"]').waitFor()
        // The rows above the list are ghost rows: the open session's neutral selection is the column's only resting fill.
        const fills = await sidebar
          .locator('.sidebar-nav-row[aria-label="搜索"], .shelf-head')
          .evaluateAll(items => items.map(item => getComputedStyle(item).backgroundColor))
        expect(fills.length).toBeGreaterThanOrEqual(2)
        for (const fill of fills) expect(fill).toBe('rgba(0, 0, 0, 0)')
        expect(await sidebar.locator('.session-item.is-selected').evaluate(item => getComputedStyle(item).backgroundColor)).not.toBe(
          'rgba(0, 0, 0, 0)',
        )
        // A healthy connection is not named: the panel has no footer.
        expect(await sidebar.locator('.sidebar-footer').count()).toBe(0)
      }
      // The work has folded into one line; the prose stays.
      const fold = target.locator('.work-fold').last()
      await fold.getByText(/^已工作/).waitFor()
      await settleMotion(target)
      await recorder.capture(target, viewport, 'session-done', 'done with tools and a diff')
      if (sidebar) await recorder.capture(target, viewport, 'sidebar-done', 'done session selected', sidebar)

      // The settled turn's footer: when the reply was sent and its tokens, each count with its unit; the time's tooltip
      // says when the turn began and ended and how long it worked, the approval wait left out.
      const lastReply = target.locator('.turn:last-child .turn-reply')
      const facts = lastReply.locator('.turn-footer .turn-facts')
      await facts.getByText(/^输入 [\d.]+k? tokens$/).waitFor({ state: 'attached' })
      await facts.getByText(/^输出 [\d.]+k? tokens$/).waitFor({ state: 'attached' })
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
        await target
          .getByRole('menu', { name: /^模型/ })
          .getByRole('menuitemradio', { name: 'fixture-small' })
          .click()
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
      await target.locator('.work-group[data-settled]').first().waitFor()
      await settleMotion(target)
      await recorder.capture(target, viewport, 'session-done-fold', 'the folded process opened')

      // The write is one row; it opens to a short preview, coloured, with the way to the whole change.
      // A's default overview column routes file rows to the panel; close it to exercise the inline preview.
      if (viewport.name === 'desktop') await closeDetails(target, viewport)
      const write = target.locator('.tool-card[data-kind="edit"] .tool-card-header').last()
      await reachable(write)
      await write.click()
      await target.locator('.tool-card[data-open] .diff-view').getByText('省略表示保留').first().waitFor()
      await diffColoured(target)
      await write.scrollIntoViewIfNeeded()
      await settleMotion(target)
      await recorder.capture(target, viewport, 'session-diff', 'done session with a file edit opened to its preview')

      await openSession(target, viewport, sessions.plan)
      await shows(target, 'planned')
      await recorder.capture(target, viewport, 'session-plan', 'full-access session done with a plan')
      await openDetails(target, viewport)
      await recorder.capture(target, viewport, 'panel-launcher', 'the right panel with nothing open')
      await closeDetails(target, viewport)

      await openSession(target, viewport, sessions.failed)
      await target.locator('.topbar').getByText('失败', { exact: true }).waitFor()
      await recorder.capture(target, viewport, 'session-failed', 'failed')
      if (sidebar) await recorder.capture(target, viewport, 'sidebar-failed', 'failed session selected', sidebar)

      // A failed latest turn offers to send its prompt again; a command it ran may run again, so it asks first.
      const resend = target.locator('.turn:last-child .turn-footer').getByRole('button', { name: '重试', exact: true })
      if (!viewport.touch) await target.locator('.turn:last-child .turn-reply').hover()
      await reachable(resend)
      await resend.click()
      await target.getByText(/^上一次已经执行了 1 个操作：运行 1 条命令。/).waitFor()
      await settleMotion(target)
      await recorder.capture(target, viewport, 'session-failed-retry', 'resending a failed turn asks first')
      await target.locator('.turn-retry-confirm').getByRole('button', { name: '取消', exact: true }).click()

      await openSession(target, viewport, sessions.cancelled)
      await target.locator('.topbar').getByText('已停止', { exact: true }).waitFor()
      if (sidebar) {
        // The top bar and its row say the same word, now that the run has settled.
        expect(await sidebar.locator(`[data-task-id="${sessions.cancelled}"] .sr-only`).textContent()).toContain('已停止')
      }
      await recorder.capture(target, viewport, 'session-cancelled', 'cancelled')
      if (sidebar) await recorder.capture(target, viewport, 'sidebar-cancelled', 'cancelled session selected', sidebar)

      // A rejected write: its row reads 「已拒绝 · 时间」 in the hint ink, once, with no diff under it and no 失败.
      await openSession(target, viewport, sessions.rejected)
      await target
        .locator('.work-fold')
        .getByText(/1 步被拒绝/)
        .click()
      const record = target.locator('.tool-card .tool-decision-words')
      await record.waitFor()
      expect(await record.textContent()).toMatch(/^已拒绝 · /u)
      expect(await target.locator('.tool-card .diff-view, .tool-card .state-failed, .tool-decision').count()).toBe(0)
      await recorder.capture(target, viewport, 'session-rejected', 'a write rejected with what to do instead')

      // Approvals.
      await openSession(target, viewport, sessions.r1)
      const r1 = target.locator('[data-approval-id]')
      await target.locator('[data-approval-id]:not([data-arming])').waitFor()
      await reachable(r1.getByRole('button', { name: '允许', exact: true }))
      await reachable(r1.getByRole('button', { name: '拒绝', exact: true }))
      // The title is what it asks to do; no word of waiting stands in for it.
      await r1.locator('.approval-title .approval-object').waitFor()
      expect(await r1.locator('.approval-title').textContent()).not.toMatch(/等你处理|需要你允许/u)
      await recorder.capture(target, viewport, 'approval-r1', 'R1 waiting for approval')
      if (sidebar) await recorder.capture(target, viewport, 'sidebar-waiting', 'session waiting for approval selected', sidebar)
      // The rest of the Host's choices sit behind 更多, one name at every width (a bottom sheet on phones).
      const choices = r1.getByRole('button', { name: '更多', exact: true })
      await reachable(choices)
      await choices.click()
      await target.getByRole('menuitem', { name: /这个会话都允许这类操作/ }).waitFor()
      await recorder.capture(target, viewport, 'approval-r1-more', 'the other approval choices open')
      await target.keyboard.press('Escape')
      await target.getByRole('menuitem', { name: /这个会话都允许这类操作/ }).waitFor({ state: 'hidden' })

      // Evidence starts expanded in v8. 收起 is one of 更多's choices; folded, the card offers a small outlined 查看改动,
      // and reopening keeps the controls in the same card. The title leads with the glyph of its kind, not a dot.
      const toggle = r1.locator('.approval-see')
      const foldPreview = async () => {
        await choices.click()
        await target.getByRole('menuitem', { name: '收起', exact: true }).click()
        await reachable(toggle)
        expect(await toggle.getAttribute('aria-expanded')).toBe('false')
        expect(await toggle.evaluate(element => element.classList.contains('ui-button'))).toBe(true)
      }
      expect(await toggle.count()).toBe(0)
      expect(await r1.locator('.approval-dot').count()).toBe(0)
      await r1.locator('.approval-title .approval-kind svg').waitFor()
      await foldPreview()
      await toggle.click()
      await expect.poll(() => toggle.count()).toBe(0)
      if (viewport.name === 'phone') {
        // The paper stays short: the first rows of the diff and a fold bar for the rest.
        await reachable(r1.getByRole('button', { name: '展开其余 13 行', exact: true }))
      }
      await settleMotion(target)
      await recorder.capture(target, viewport, 'approval-r1-preview', 'the preview unfolded')
      if (viewport.name === 'desktop') {
        // The card and the diff under review keep their look under styles added to the page.
        await expectUnmovedByInjectedStyles(target, [
          '[data-approval-id] .approval-title',
          '[data-approval-id] .approval-object',
          '[data-approval-id] .diff-line',
          '[data-approval-id] .diff-text',
          '[data-approval-id] .ui-button',
        ])
      }
      await foldPreview()

      // A decision whose answer never arrived: the card offers to send the same choice again.
      await target.route('**/link/api/approvals/**', route => route.abort('connectionreset'))
      // Typing says what to do instead: 拒绝 becomes 拒绝并发送, and the text goes with it.
      const answerBox = target.getByRole('textbox', { name: '拒绝并说明改做什么…', exact: true })
      await answerBox.fill('先写到草稿目录')
      await r1.getByRole('button', { name: '拒绝并发送', exact: true }).waitFor()
      await settleMotion(target)
      await recorder.capture(target, viewport, 'approval-r1-note', 'typing turns 拒绝 into 拒绝并发送')
      await answerBox.fill('')
      await r1.getByRole('button', { name: '拒绝', exact: true }).click()
      await r1.getByText('「拒绝」的结果未知', { exact: true }).waitFor()
      // 重试 is the one clear action: no blue.
      expect(await r1.locator('.ui-button[data-variant="primary"]').count()).toBe(0)
      await reachable(r1.getByRole('button', { name: '重试', exact: true }))
      await recorder.capture(target, viewport, 'approval-uncertain', 'the outcome of a decision is unknown')
      await target.unroute('**/link/api/approvals/**')

      await openDetails(target, viewport)
      if (viewport.name === 'desktop') {
        // The column's edge toward the paper resizes it: its line under a held hover, and with keyboard focus.
        const edge = target.getByRole('separator', { name: '调整侧边面板宽度', exact: true })
        await reachable(edge)
        let release = await forceState(target, '.inspector-resize', ['hover'])
        await target.evaluate(() => new Promise(done => setTimeout(done, 500)))
        await recorder.capture(target, viewport, 'inspector-resize-hover', 'the edge of the right panel under the pointer')
        await release()
        release = await forceState(target, '.inspector-resize', ['focus', 'focus-visible'])
        await recorder.capture(target, viewport, 'inspector-resize-focus', 'the edge of the right panel with keyboard focus')
        await release()
      }
      await closeDetails(target, viewport)

      await openSession(target, viewport, sessions.r2)
      const r2 = target.locator('[data-approval-id]')
      await target.locator('[data-approval-id]:not([data-arming])').waitFor()
      await reachable(r2.getByRole('button', { name: /允许/ }).first())
      await reachable(r2.getByRole('button', { name: '拒绝', exact: true }))
      await recorder.capture(target, viewport, 'approval-r2', 'R2 on a connected device, which can answer it')

      await openSession(target, viewport, sessions.hidden)
      const hidden = target.locator('[data-approval-id]')
      await target.locator('[data-approval-id]:not([data-arming])').waitFor()
      await hidden.getByText('含有不可见字符，已标出', { exact: true }).waitFor()
      await reachable(hidden.getByRole('button', { name: '允许', exact: true }))
      expect(await hidden.locator('.ui-button[data-variant="primary"]').count()).toBe(0)
      await recorder.capture(target, viewport, 'approval-hidden', 'R1 whose content hides characters')

      await openSession(target, viewport, sessions.advisory)
      const advisory = target.locator('[data-approval-id]')
      await target.locator('[data-approval-id]:not([data-arming])').waitFor()
      await advisory.locator('.approval-note').waitFor()
      // The agent's own words for its option stay in the tooltip; the button reads in the product's words.
      await reachable(advisory.getByRole('button', { name: '拒绝', exact: true }))
      await recorder.capture(target, viewport, 'approval-advisory', 'full-access question shown as advisory')

      // The agent's plan is a work row; it opens to the list.
      const planChip = target.getByRole('button', { name: '计划 0/2', exact: true })
      await reachable(planChip)
      await planChip.click()
      await target.getByText('List the project root', { exact: true }).last().waitFor()
      await settleMotion(target)
      await recorder.capture(target, viewport, 'session-plan-popover', "the plan row's list open")
      await planChip.click()

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
      await target.locator('[data-approval-id]:not([data-arming])').waitFor()
      await locked.getByText('这台设备不能允许这一步', { exact: true }).waitFor()
      expect(await locked.getByRole('button', { name: /允许/ }).count()).toBe(0)
      await locked.locator('.approval-title .approval-object').waitFor()
      await reachable(locked.getByRole('button', { name: '拒绝', exact: true }))
      await recorder.capture(target, viewport, 'approval-r1-locked', 'R1 on a device without 批准普通操作')
      await target.unroute('**/link/api/snapshot')

      // Keep the required Host identity: missing optional risk/options/advisory metadata is treated as R2.
      await target.route('**/link/api/snapshot', async route => {
        const response = await route.fetch()
        const snapshot: AppSnapshot = await response.json()
        await route.fulfill({ response, json: { ...snapshot, approvals: withoutApprovalMetadata(snapshot.approvals) } })
      })
      await target.route(`**/link/api/tasks/${sessions.r1}`, async route => {
        if (route.request().method() !== 'GET') return route.fallback()
        const response = await route.fetch()
        const current: TaskDetail = await response.json()
        await route.fulfill({ response, json: { ...current, approvals: withoutApprovalMetadata(current.approvals) } })
      })
      try {
        await openSession(target, viewport, sessions.r1)
        const fallback = target.locator('[data-approval-id]')
        await target.locator('[data-approval-id]:not([data-arming])').waitFor()
        expect(await fallback.getAttribute('data-risky')).toBe('')
        const allowButton = fallback.getByRole('button', { name: '允许', exact: true })
        await reachable(allowButton)
        expect(await allowButton.getAttribute('aria-keyshortcuts')).toBeNull()
        await reachable(fallback.getByRole('button', { name: '拒绝', exact: true }))
        await recorder.capture(target, viewport, 'approval-missing-risk', 'missing optional approval metadata: conservative R2')
      } finally {
        await target.unroute(`**/link/api/tasks/${sessions.r1}`)
        await target.unroute('**/link/api/snapshot')
      }

      // A turn taken back, and a record that does not cover its folder. This device was actually granted file access.
      const doneAt = (await detail(sessions.done)).messages.find((message: { role: string }) => message.role === 'user')?.createdAt
      const turnList = {
        scope: 'turn',
        turnId: 'visual-turn',
        files: [
          { root: 'default', path: 'apps/web/src/release.ts', status: 'M', add: 12, del: 3 },
          { root: 'default', path: 'docs/RELEASE.md', status: 'A', add: 40, del: 0 },
        ],
        totals: { files: 2, add: 52, del: 3 },
        partial: true,
      }
      const undoneRecord = { turnId: 'visual-turn', startedAt: doneAt, state: 'settled', files: 2, undone: true, notePending: true }
      let undoneShown = false
      await target.route(`**/link/api/tasks/${sessions.done}/changes/turns`, route =>
        route.fulfill({
          json: { turns: [undoneShown ? undoneRecord : { turnId: 'visual-turn', startedAt: doneAt, state: 'settled', files: 2 }] },
        }),
      )
      await target.route(`**/link/api/tasks/${sessions.done}/changes?*`, route =>
        route.fulfill({
          json: undoneShown
            ? { ...turnList, undone: true, undo: { available: false, reason: 'undone' }, redo: { available: true } }
            : { ...turnList, undo: { available: true }, redo: { available: false, reason: 'not-undone' } },
        }),
      )
      await openSession(target, viewport, sessions.done)
      await target.getByText('记录不完整：文件夹太大', { exact: true }).waitFor()
      await settleMotion(target)
      await recorder.capture(target, viewport, 'turn-record-partial', "a turn's card on a record that does not cover the folder")
      undoneShown = true
      await home(target)
      await openSession(target, viewport, sessions.done)
      await target.getByRole('button', { name: '恢复', exact: true }).waitFor()
      await settleMotion(target)
      await recorder.capture(target, viewport, 'turn-undone', 'a turn taken back: the record line and 恢复')
      await target.unroute(`**/link/api/tasks/${sessions.done}/changes?*`)
      await target.unroute(`**/link/api/tasks/${sessions.done}/changes/turns`)
      await target.unroute('**/link/api/snapshot')

      // Navigation: the drawer on tablets.
      if (viewport.name === 'tablet') {
        await home(target)
        const drawer = await openDrawer(target)
        for (const name of ['新建会话', '关闭会话列表']) await reachable(drawer.getByRole('button', { name, exact: true }))
        // The tablet's sliding project tree uses the same complete state glyphs as the desktop.
        await drawer.locator(`[data-task-id="${sessions.running}"] .session-row-glyph[data-tone="running"] .ui-spinner`).waitFor()
        await noHorizontalOverflow(target, drawer)
        await settleMotion(target)
        await recorder.capture(target, viewport, 'navigation', 'session list drawer')
        await drawer.getByRole('button', { name: '关闭会话列表', exact: true }).click()
        await target.locator('.drawer-backdrop').waitFor({ state: 'detached' })
      }
      // Navigation on a phone: the explicit history retains its search, row menus and archive.
      if (viewport.name === 'phone') await capturePhoneSessions(target, viewport)

      // On a phone the title's menu holds the session's actions, as a sheet; 同步最新状态 is the connection's 重试.
      if (viewport.name === 'phone') {
        await openSession(target, viewport, sessions.done)
        const title = target.locator('.topbar .topbar-title-button')
        await reachable(title)
        await title.click()
        const menu = target.getByRole('menu', { name: /^会话：/ })
        await menu.waitFor()
        for (const name of ['重命名', '置顶', '归档', '导出 Markdown', '删除'])
          await reachable(menu.getByRole('menuitem', { name, exact: true }))
        expect(await menu.getByRole('menuitem', { name: '同步最新状态', exact: true }).count()).toBe(0)
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
          // ⋯ holds the same actions as the title.
          await target.locator('.topbar').getByRole('button', { name: '会话操作', exact: true }).click()
          const more = target.getByRole('menu', { name: '会话操作', exact: true })
          for (const name of ['重命名', '置顶', '归档', '导出 Markdown', '删除'])
            await reachable(more.getByRole('menuitem', { name, exact: true }))
          expect(await more.getByRole('menuitem', { name: '同步最新状态', exact: true }).count()).toBe(0)
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
        // The menu gave focus back to its ⋯, whose ring and revealed actions would stay in the next captures.
        await target.evaluate(() => {
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        })
        await settleMotion(target)

        // A project group offers a new session in that project.
        const group = sidebar.locator('.session-group[aria-label="website"]')
        await group.locator('.project-group-heading').hover()
        await reachable(group.getByRole('button', { name: '在 website 中新建会话', exact: true }))
        release = await forceState(target, '#session-navigation .session-group[aria-label="website"] .project-group-heading', ['hover'])
        await recorder.capture(target, viewport, 'sidebar-group-hover', "a project group's head under the pointer, with its +", sidebar)
        await release()

        // A pinned session leads its own shelf, marked with the pin.
        await local.json(`tasks/${sessions.plan}`, { method: 'PATCH', body: { pinned: true } })
        const pinnedRow = sidebar.locator(`.session-item:has([data-task-id="${sessions.plan}"]) .session-pin`)
        await pinnedRow.waitFor()
        await expect.poll(() => sidebar.locator('[data-leaving]').count()).toBe(0)
        await settleMotion(target)
        await recorder.capture(target, viewport, 'sidebar-pinned', 'a pinned session at the head of its shelf', sidebar)
        await local.json(`tasks/${sessions.plan}`, { method: 'PATCH', body: { pinned: false } })
        await pinnedRow.waitFor({ state: 'detached' })
        await expect.poll(() => sidebar.locator('[data-leaving]').count()).toBe(0)

        // Shut: the column slides away and the top bar offers to open it again.
        await target.getByRole('button', { name: '收起侧栏', exact: true }).click()
        await target.locator('.app-shell[data-sidebar="collapsed"]').waitFor()
        const expand = target.getByRole('button', { name: '展开侧栏', exact: true })
        await expect.poll(() => target.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('展开侧栏')
        await reachable(expand)
        await reachable(target.locator('.titlebar').getByRole('button', { name: '新建会话', exact: true }))
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
        await recorder.capture(target, viewport, 'sidebar-archived', 'the archived list', sidebar)
        await sidebar.locator('.archived-back').click()
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
      await settings.getByRole('radio', { name: '跟随系统' }).waitFor()
      await recorder.capture(target, viewport, 'settings-general', 'general')
      for (const [surface, section, ready] of [
        ['settings-providers', '模型', settings.getByText('本地模型服务').first()],
        ['settings-agents', 'Harness', settings.getByText('本地 ACP Harness').first()],
        ['settings-workspaces', '项目', settings.getByText('website').first()],
        ['settings-plugins', '插件', target.locator('.plugin-nav-row').first()],
        ['settings-devices', '设备', settings.getByText(`在 ${HOST_NAME} 上的 Latch 里连接`, { exact: true })],
        ['settings-about', '关于', settings.getByText('Harness 和插件以你的权限运行', { exact: true }).first()],
      ] as const) {
        await openSection(settings, section)
        await ready.waitFor()
        await noHorizontalOverflow(target, settings)
        await recorder.capture(target, viewport, surface, section)
        const top = () => (viewport.name === 'phone' ? settings.locator('.settings-level[data-state="top"]') : settings)
        if (surface === 'settings-providers') {
          // A saved service's page: its connection, key, models and the way to remove it.
          await settings.getByRole('button', { name: '编辑 DeepSeek', exact: true }).click()
          await reachable(top().getByRole('switch', { name: '启用', exact: true }))
          await reachable(top().getByRole('button', { name: '检测连接', exact: true }))
          await reachable(top().getByRole('button', { name: '获取模型', exact: true }))
          await reachable(top().getByRole('radio', { name: '默认使用 deepseek-reasoner', exact: true }))
          await reachable(top().getByRole('button', { name: '删除', exact: true }))
          await noHorizontalOverflow(target, settings)
          await recorder.capture(target, viewport, 'settings-provider', 'a saved model service')
          await backToSection(settings)
          // Every model-service preset with its brand's icon (a custom service has the plug glyph).
          await settings.getByRole('button', { name: '添加模型服务', exact: true }).click()
          const sheet = target.getByRole('dialog', { name: '添加模型服务', exact: true })
          const presets = sheet.locator('.preset-card')
          await expect.poll(() => presets.count()).toBe(13)
          expect(await presets.locator('.ui-tile').count()).toBe(13)
          await recorder.capture(target, viewport, 'settings-provider-presets', 'choosing a model-service preset')
          // Adding one: the address, the check, the models and 保存; a browser cannot set keys.
          await sheet.getByRole('button', { name: 'OpenAI', exact: true }).click()
          for (const control of [
            sheet.getByLabel('地址', { exact: true }),
            sheet.getByRole('button', { name: '检测连接', exact: true }),
            sheet.getByLabel('手动添加模型 ID', { exact: true }),
            sheet.getByRole('button', { name: '保存', exact: true }),
          ])
            await reachable(control, { allowDisabled: true })
          await sheet.getByText(`保存后在 ${HOST_NAME} 上填写密钥`, { exact: true }).waitFor()
          await recorder.capture(target, viewport, 'settings-provider-add', 'adding a model service from a preset')
          await sheet.getByRole('button', { name: '取消', exact: true }).click()
          await sheet.waitFor({ state: 'hidden' })
        }
        if (surface === 'settings-agents') {
          // An agent's page: 启用, its definition read-only in a browser, detection with the path and the red group.
          await settings.getByRole('button', { name: '编辑 本地 ACP Harness', exact: true }).click()
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
    'captures restricted files and settings for a device without 管理此 Host at $name width',
    async viewport => {
      const target = readOnlyPages.get(viewport.name)!.page
      await target.goto(`${host.loopbackOrigin}/link/`)
      await connected(target)
      expect(
        await target.evaluate(async () => {
          const snapshot: AppSnapshot = await (await fetch('/link/api/snapshot')).json()
          return snapshot.device.dataScope
        }),
      ).toBe('work')
      await openSession(target, viewport, sessions.done)
      await shows(target, /建议再补一条/)
      const restricted = await target.evaluate(async id => {
        const current: TaskDetail = await (await fetch(`/link/api/tasks/${id}`)).json()
        return current
      }, sessions.done)
      const edit = restricted.messages.find(message => message.tool?.kind === 'edit')
      expect(edit).toBeDefined()
      expect(edit!.tool).not.toHaveProperty('diffs')
      expect(JSON.stringify(edit)).toContain('src/settings.ts')
      expect(JSON.stringify(edit)).not.toContain('省略表示保留')
      const fold = target.locator('.work-fold').last()
      if ((await fold.getAttribute('aria-expanded')) !== 'true') await fold.click()
      const tool = target.locator('.tool-card[data-kind="edit"]').last()
      await reachable(tool.locator('.tool-card-header'))
      await tool.locator('.tool-card-header').click()
      await expect.poll(() => tool.getAttribute('data-open')).not.toBeNull()
      expect(await tool.locator('.diff-view').count()).toBe(0)
      expect(await tool.innerText()).not.toContain('省略表示保留')
      await recorder.capture(target, viewport, 'session-diff-restricted', 'work-scoped device: edit status and path, no file diff')
      {
        const settings = await openSettings(target, '设置')
        await openSection(settings, '通用')
        await settings.getByRole('radio', { name: '跟随系统' }).waitFor()
        // Only what this device may use is listed, and the list says where the rest is.
        expect(await settings.getByRole('tab', { name: '模型', exact: true }).count()).toBe(0)
        await noHorizontalOverflow(target, settings)
        await recorder.capture(target, viewport, 'settings-readonly', 'settings for a device that cannot manage the Host')
        await closeSettings(settings)
      }
    },
    120_000,
  )

  it.each(VISUAL_VIEWPORTS)(
    'captures the palette and the find bar at $name width',
    async viewport => {
      const target = page(viewport)
      await home(target)
      await target.keyboard.press('Control+k')
      const palette = target.getByRole('dialog', { name: '命令面板', exact: true })
      await palette.waitFor()
      await noHorizontalOverflow(target, palette)
      await settleMotion(target)
      await recorder.capture(target, viewport, 'palette', 'recent sessions and commands, before anything is typed')
      await palette.getByRole('searchbox').fill('发布')
      // The search of message text answers on its own time.
      await palette.getByText('正在搜索消息…', { exact: true }).waitFor({ state: 'detached' })
      await noHorizontalOverflow(target, palette)
      await settleMotion(target)
      await recorder.capture(target, viewport, 'palette-search', 'results in groups, message text last')
      await palette.getByRole('searchbox').press('Escape')
      await palette.getByRole('searchbox').press('Escape')
      await palette.waitFor({ state: 'detached' })

      await openSession(target, viewport, sessions.done)
      await target.keyboard.press('Control+f')
      const find = target.getByRole('search', { name: '会话内查找' })
      await find.waitFor()
      const title = (await detail(sessions.done)).messages.find(message => message.role === 'user')!.text.slice(0, 2)
      await find.getByRole('searchbox').fill(title)
      await expect.poll(() => find.getByRole('status').textContent()).toMatch(/^1\//u)
      await noHorizontalOverflow(target, find)
      await settleMotion(target)
      await recorder.capture(target, viewport, 'find', 'the find bar over the conversation, with its matches tinted')
      await find.getByRole('button', { name: '关闭查找', exact: true }).click()
      await find.waitFor({ state: 'detached' })

      // A phone has no such page: it has no keys.
      if (viewport.name !== 'phone') {
        // Alt / lays the keys over the session; its link leads to the same table as a page.
        await target.keyboard.press('Alt+/')
        const keys = target.getByRole('dialog', { name: '快捷键', exact: true })
        await keys.getByRole('searchbox', { name: '搜索快捷键', exact: true }).waitFor()
        await settleMotion(target)
        await recorder.capture(target, viewport, 'shortcuts-overlay', 'the keys of this kind of client over the session')
        await keys.getByRole('button', { name: '设置 › 快捷键', exact: true }).click()
        await target.locator('.settings-page').getByRole('searchbox', { name: '搜索快捷键', exact: true }).waitFor()
        await settleMotion(target)
        await recorder.capture(target, viewport, 'settings-shortcuts', 'the keys of this kind of client')
      }
      await home(target)
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
            expect(switchTrack).toBe(viewport.touch ? '44px' : '34px')
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
          await openDetails(target, viewport)
        },
      ],
      [
        'approval-r1',
        async () => {
          await openSession(target, viewport, sessions.r1)
          await closeDetails(target, viewport)
          await target.locator('[data-approval-id]').getByRole('button', { name: '允许', exact: true }).waitFor()
        },
      ],
    ]
    for (const [surface, drive] of again) {
      await drive()
      await settleMotion(target)
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

  // ---- Code in a reply ------------------------------------------------------------------------------------------

  it('captures code arriving and settled at each viewport', async () => {
    const id = await start(PROMPTS.code, 'chat')
    await expect.poll(async () => (await detail(id)).liveText.length, { timeout: 20_000 }).toBeGreaterThan(0)
    for (const viewport of VISUAL_VIEWPORTS) {
      const target = page(viewport)
      await openSession(target, viewport, id)
      const block = target.locator('.message-code.is-tail')
      await block.getByText('前 14 行已收起', { exact: true }).waitFor()
      await block.locator('.syn-comment').first().waitFor()
      await block.locator('.syn-keyword').last().waitFor()
      await noHorizontalOverflow(target)
      await settleMotion(target)
      await recorder.capture(target, viewport, 'session-code-arriving', 'a long code block arrives: its newest lines, coloured')
    }
    releaseArrivingCode?.()
    await settled(id, 'idle')
    for (const viewport of VISUAL_VIEWPORTS) {
      const target = page(viewport)
      await openSession(target, viewport, id)
      const block = target.locator('.message-code.is-collapsed')
      await block.getByRole('button', { name: '展开全部 31 行', exact: true }).waitFor()
      await block.locator('.syn-keyword').first().waitFor()
      await noHorizontalOverflow(target)
      await settleMotion(target)
      await recorder.capture(target, viewport, 'session-code-settled', 'the same block settled: its first lines, with more to expand')
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
