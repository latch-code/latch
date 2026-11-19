// The Claude Agent SDK wire under the real runtime, with a fake `query()` in place of the SDK: no `claude`, no model.
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DriverTaskDetail } from '@latch/protocol'
import type { Bridge, HarnessDriver, HarnessHostOptions, HarnessPlugin } from '@latch/sdk'
import {
  createAcpAgentPlugin,
  forgetCommandLookups,
  resolveCommand,
  setCommandSearch,
  setLoginPrograms,
  type AcpAgentOptions,
  type AgentRecord,
} from '../src/index.ts'
import { setClaudeQuery, type ClaudeQuery } from '../src/wires/claude.ts'
import { answer, claudeFixture, line, prompt, uuidOf, type ClaudeFixture } from './helpers/claude-store.ts'

const FAST: AcpAgentOptions = { cancelGraceMs: 2_000, stopGraceMs: 200, restartDelayMs: 0, requestTimeoutMs: 5_000, log: () => {} }
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  setClaudeQuery(undefined)
  setCommandSearch(undefined)
  setLoginPrograms(undefined)
  forgetCommandLookups()
})
let requests = 0
const rid = () => `claude-${++requests}`

const MODELS = [
  { value: 'default', displayName: 'Default', resolvedModel: 'claude-x', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
]

/** What a turn of the fake does with the prompt it was given, as `claude` would answer it. */
type Script = (query: ScriptedQuery, prompt: Record<string, unknown>) => Promise<void>

class ScriptedQuery implements ClaudeQuery {
  private queue: unknown[] = []
  private waiting?: (result: IteratorResult<unknown>) => void
  private done = false
  readonly calls: Array<[string, ...unknown[]]> = []
  readonly prompts: Array<Record<string, unknown>> = []
  constructor(
    readonly options: Record<string, unknown>,
    prompt: AsyncIterable<unknown>,
    script: Script,
  ) {
    void (async () => {
      for await (const item of prompt) {
        this.calls.push(['prompt'])
        this.prompts.push(item as Record<string, unknown>)
        await script(this, item as Record<string, unknown>)
      }
    })()
  }
  send(message: unknown): void {
    if (this.waiting) {
      const next = this.waiting
      this.waiting = undefined
      next({ value: message, done: false })
    } else this.queue.push(message)
  }
  reply(prompt: Record<string, unknown>, text: string): void {
    this.send({ type: 'assistant', parent_tool_use_id: null, message: { id: `m-${rid()}`, content: [{ type: 'text', text }] } })
    this.send({
      type: 'result',
      subtype: 'success',
      is_error: false,
      user_message_uuid: prompt.uuid,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  }
  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () =>
        this.queue.length
          ? Promise.resolve({ value: this.queue.shift(), done: false })
          : this.done
            ? Promise.resolve({ value: undefined, done: true })
            : new Promise(resolve => (this.waiting = resolve)),
    }
  }
  async interrupt() {
    return {}
  }
  async setPermissionMode(mode: string) {
    this.calls.push(['setPermissionMode', mode])
  }
  async setModel(model?: string) {
    this.calls.push(['setModel', model])
  }
  async applyFlagSettings(settings: Record<string, unknown>) {
    this.calls.push(['applyFlagSettings', settings])
  }
  async initializationResult() {
    return { models: MODELS, commands: [] }
  }
  async supportedCommands() {
    return []
  }
  async getContextUsage() {
    return { totalTokens: 10, maxTokens: 1000, model: 'claude-x' }
  }
  async stopTask() {}
  close() {
    this.done = true
    this.waiting?.({ value: undefined, done: true })
  }
}

async function activate(plugin: HarnessPlugin): Promise<HarnessDriver> {
  const drivers: HarnessDriver[] = []
  const disposers: Array<() => void | Promise<void>> = []
  await plugin.activate({
    registerHarness: driver => void drivers.push(driver),
    registerProvider: () => {},
    registerTool: () => {},
    registerClientPanel: () => {},
    registerSkill: () => {},
    registerTransport: () => {},
    registerUiPanel: () => {},
    onDispose: dispose => void disposers.push(dispose),
  })
  cleanups.push(async () => {
    for (const dispose of disposers.reverse()) await dispose()
  })
  return drivers[0]!
}

/** A computer whose `claude` is a stub that only prints a version, and a runtime whose SDK is the script. */
async function computer(script: Script, host: Partial<HarnessHostOptions> = {}, extra: { options?: AcpAgentOptions } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-claude-runtime-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const bin = join(root, 'bin')
  const main = join(root, 'main')
  for (const directory of [bin, main, join(root, 'data'), join(root, 'run-tmp')]) await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(join(bin, 'claude'), `#!/bin/sh\nif [ "$1" = --version ]; then echo '2.1.327 (Claude Code)'; fi\n`)
  await chmod(join(bin, 'claude'), 0o755)
  setCommandSearch(() => [bin])
  setLoginPrograms(resolveCommand)
  forgetCommandLookups()
  const queries: ScriptedQuery[] = []
  setClaudeQuery(({ prompt, options }) => {
    const made = new ScriptedQuery(options, prompt, script)
    queries.push(made)
    return made
  })
  const record: AgentRecord = {
    id: 'claude',
    name: 'Claude Agent',
    presetId: 'claude-agent',
    command: 'claude',
    args: [],
    env: {},
    enabled: true,
  }
  const projects = [{ id: 'proj', folders: [{ id: 'main', path: main }] }]
  const drivers = new Map<boolean, HarnessDriver>()
  const driverFor = async (store: boolean) => {
    let made = drivers.get(store)
    if (!made) {
      made = await activate(createAcpAgentPlugin(record, { ...FAST, ...extra.options, ...(store ? { claudeStore: true } : {}) }))
      drivers.set(store, made)
    }
    return made
  }
  const driver = await driverFor(extra.options?.claudeStore === true)
  const open = async (store = extra.options?.claudeStore === true, listed: typeof projects = projects): Promise<Bridge> => {
    const bridge = (await driverFor(store)).create({
      projects: () => structuredClone(listed),
      ...host,
      dataDir: join(root, 'data'),
      workspaceRoot: main,
      tmpRoot: join(root, 'run-tmp'),
      workspaces: () => [main],
      providerId: 'unused',
      registry: {
        acquire() {
          throw new Error('unused')
        },
      },
    } as HarnessHostOptions)
    cleanups.push(() => bridge.close())
    await bridge.start()
    return bridge
  }
  return { main, open, queries, driver }
}

async function until(bridge: Bridge, id: string, predicate: (detail: DriverTaskDetail) => boolean): Promise<DriverTaskDetail> {
  await vi.waitFor(async () => expect(predicate(await bridge.detail(id))).toBe(true), { timeout: 8_000, interval: 10 })
  return bridge.detail(id)
}
const settled = (bridge: Bridge, id: string) =>
  until(bridge, id, detail => detail.summary.status !== 'running' && detail.summary.status !== 'waiting-approval')
const said = (detail: DriverTaskDetail) =>
  detail.messages
    .filter(message => message.role === 'assistant')
    .map(message => message.text)
    .join('\n')

describe('the Claude Agent SDK wire under the runtime', () => {
  it('puts a resumed session back in the mode Latch recorded for it before its next prompt', async () => {
    const t = await computer(async (query, prompt) => query.reply(prompt, 'ok'))
    let bridge = await t.open()
    const config = [{ configId: 'mode', value: 'acceptEdits' }]
    const { launchHash } = await bridge.launchPreview!({ cwd: t.main, config })
    const { sessionId } = await bridge.createTask({ prompt: 'one', requestId: rid(), cwd: t.main, config, expectedLaunchHash: launchHash })
    expect((await settled(bridge, sessionId)).summary.status).toBe('idle')
    expect(t.queries[0]!.calls.slice(0, 2)).toEqual([['setPermissionMode', 'acceptEdits'], ['prompt']])
    await bridge.close()
    bridge = await t.open()
    await bridge.prompt(sessionId, 'two', rid())
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.status).toBe('idle')
    // A new `claude` resumed the same Claude session, in Claude's default, and Latch set its own mode again first.
    const resumed = t.queries[1]!
    expect(resumed.options.resume).toBe(t.queries[0]!.options.sessionId)
    expect(resumed.calls.slice(0, 2)).toEqual([['setPermissionMode', 'acceptEdits'], ['prompt']])
    expect(detail.config?.find(option => option.category === 'mode')?.currentValue).toBe('acceptEdits')
  })

  it('shows only the one-time choices of an ask, as for the adapter, and hands Claude what the person chose', async () => {
    let decided: unknown
    const t = await computer(async (query, prompt) => {
      const ask = query.options.canUseTool as (tool: string, input: unknown, context: unknown) => Promise<unknown>
      decided = await ask(
        'Bash',
        { command: 'npm test' },
        {
          signal: new AbortController().signal,
          toolUseID: 'toolu_1',
          suggestions: [
            { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' },
          ],
        },
      )
      query.reply(prompt, 'done')
    })
    const bridge = await t.open()
    const { launchHash } = await bridge.launchPreview!({ cwd: t.main })
    const { sessionId } = await bridge.createTask({ prompt: 'run tests', requestId: rid(), cwd: t.main, expectedLaunchHash: launchHash })
    await until(bridge, sessionId, detail => detail.summary.status === 'waiting-approval')
    const [approval] = bridge.approvals()
    expect(approval!.options?.map(option => `${option.id}:${option.kind}`)).toEqual(['allow-once:allow_once', 'reject:reject_once'])
    await bridge.decide(approval!.id, 'allow')
    expect((await settled(bridge, sessionId)).summary.status).toBe('idle')
    expect(decided).toMatchObject({ behavior: 'allow', updatedInput: { command: 'npm test' }, decisionClassification: 'user_temporary' })
  })

  it('asks the person Claude’s own question on the question card and gives Claude the answer', async () => {
    let decided: unknown
    const t = await computer(
      async (query, prompt) => {
        const ask = query.options.canUseTool as (tool: string, input: unknown, context: unknown) => Promise<unknown>
        decided = await ask(
          'AskUserQuestion',
          { questions: [{ question: 'Which colour?', options: [{ label: 'Blue' }, { label: 'Green' }] }] },
          { signal: new AbortController().signal, toolUseID: 'toolu_q' },
        )
        query.reply(prompt, 'noted')
      },
      {
        askUser: async input => {
          expect(input.prompt).toBe('Which colour?')
          expect(input.questions[0]!.options.map(option => option.label)).toEqual(['Blue', 'Green'])
          return {
            text: JSON.stringify({
              kind: 'latch.question-result',
              requestId: 'r',
              answers: [{ questionId: input.questions[0]!.id, label: 'Which colour?', optionIds: ['o1'], choices: ['Green'] }],
            }),
          }
        },
      },
    )
    const bridge = await t.open()
    const { launchHash } = await bridge.launchPreview!({ cwd: t.main })
    const { sessionId } = await bridge.createTask({ prompt: 'ask me', requestId: rid(), cwd: t.main, expectedLaunchHash: launchHash })
    const detail = await settled(bridge, sessionId)
    expect(detail.summary.status).toBe('idle')
    expect(said(detail)).toContain('noted')
    expect(decided).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Which colour?': 'Green' } } })
  })
})

describe('Claude’s own store under the runtime (a configuration directory of the test’s own)', () => {
  const S1 = '11111111-1111-4111-8111-111111111111'

  async function withStore(store: boolean) {
    const fixture = await claudeFixture()
    cleanups.push(() => fixture.remove())
    // Where `claude` keeps its store comes from the Host's environment (or its login shell), never a definition.
    vi.stubEnv('CLAUDE_CONFIG_DIR', fixture.config)
    cleanups.push(() => void vi.unstubAllEnvs())
    const t = await computer(async (query, prompt) => query.reply(prompt, 'ok'), {}, { options: { claudeStore: store } })
    return { ...t, fixture }
  }

  /** The transcript `claude` would have written for the session, keyed by the prompt's own ID. */
  async function transcript(fixture: ClaudeFixture, sessionId: string, promptId: string, cwd: string) {
    const l = line(sessionId, cwd, 'sdk-ts')
    return fixture.write(sessionId, [
      l(prompt(promptId, null, 'one')),
      l(answer(uuidOf(2), promptId, 'msg_1', [{ type: 'text', text: 'ok' }])),
    ])
  }

  it('deletes the transcript of a session Latch started, and of one recorded before it could', async () => {
    const t = await withStore(false)
    // Recorded without the Host's leave: `deletable` stays false on record.
    let bridge = await t.open(false)
    const { launchHash } = await bridge.launchPreview!({ cwd: t.main })
    const { sessionId } = await bridge.createTask({ prompt: 'one', requestId: rid(), cwd: t.main, expectedLaunchHash: launchHash })
    await settled(bridge, sessionId)
    const claudeId = t.queries[0]!.options.sessionId as string
    const promptId = (await bridge.detail(sessionId)).messages.find(message => message.role === 'user')!.id
    // Without the leave, the turn went out under an ID of the wire's own.
    expect(t.queries[0]!.options).not.toHaveProperty('resume')
    await bridge.close()
    const file = await transcript(t.fixture, claudeId, promptId, t.main)
    // Nothing of the project is needed to delete it: its Claude settings changed and it is no longer listed.
    await mkdir(join(t.main, '.claude'), { recursive: true })
    await writeFile(join(t.main, '.claude', 'settings.json'), '{"permissions":{}}')
    bridge = await t.open(true, [])
    await bridge.remove!(sessionId)
    await vi.waitFor(() => expect(existsSync(file)).toBe(false), { timeout: 8_000, interval: 20 })
  })

  it('marks the turn with Latch’s message ID, so a fork can find it', async () => {
    const t = await withStore(true)
    const bridge = await t.open()
    const { launchHash } = await bridge.launchPreview!({ cwd: t.main })
    const { sessionId } = await bridge.createTask({ prompt: 'one', requestId: rid(), cwd: t.main, expectedLaunchHash: launchHash })
    const detail = await settled(bridge, sessionId)
    const first = detail.messages.find(message => message.role === 'user')!
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/u)
    expect(t.queries[0]!.calls).toContainEqual(['prompt'])
    expect(t.queries[0]!.prompts.at(0)?.uuid).toBe(first.id)
  })

  it('imports a terminal session, keeps its original unless the person chooses to delete it too', async () => {
    const t = await withStore(true)
    const l = line(S1, t.main)
    const file = await t.fixture.write(S1, [
      l(prompt(uuidOf(1), null, 'from the terminal')),
      l(answer(uuidOf(2), uuidOf(1), 'msg_1', [{ type: 'text', text: 'hello back' }])),
    ])
    const bridge = await t.open()
    const listed = await bridge.listExternalSessions!()
    expect(listed.sessions.map(row => row.agentSessionId)).toEqual([S1])
    const place = { agentSessionId: S1, cwd: t.main, workspaceId: 'proj', folders: [{ id: 'main', path: t.main }] }
    const load = await bridge.loadExternalSession!(place)
    expect(load.messages.map(message => `${message.role}:${message.text}`)).toEqual(['user:from the terminal', 'assistant:hello back'])
    expect(load.useUnknown).toBe(true)
    const kept = await bridge.adoptExternalSession!({ ...place, sessionId: `task-${randomUUID()}`, loadId: load.loadId, title: 'imported' })
    await bridge.remove!(kept.sessionId)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(existsSync(file)).toBe(true)
    const gone = await bridge.adoptExternalSession!({ ...place, sessionId: `task-${randomUUID()}`, title: 'imported again' })
    await bridge.remove!(gone.sessionId, { original: true })
    await vi.waitFor(() => expect(existsSync(file)).toBe(false), { timeout: 8_000, interval: 20 })
  })

  it('brings in nothing and deletes nothing of Claude’s without the Host’s leave', async () => {
    const t = await withStore(false)
    await t.fixture.write(S1, [line(S1, t.main)(prompt(uuidOf(1), null, 'from the terminal'))])
    expect(t.driver.historyImport).toBeUndefined()
    expect(t.driver.historyDelete).toBeUndefined()
    const bridge = await t.open(false)
    await expect(bridge.listExternalSessions!()).rejects.toMatchObject({ code: 'history-not-supported' })
  })

  it('counts both routes as one store, Claude’s configuration directory, so a session is brought in once', async () => {
    const t = await withStore(true)
    const direct = await t.open()
    const adapter = (
      await activate(
        createAcpAgentPlugin(
          {
            id: 'claude-acp',
            name: 'Claude Agent',
            presetId: 'claude-agent',
            command: '/opt/x/claude-agent-acp',
            args: [],
            env: {},
            enabled: true,
          },
          FAST,
        ),
      )
    ).create({
      dataDir: join(t.fixture.root, 'adapter-data'),
      workspaceRoot: t.main,
      tmpRoot: join(t.fixture.root, 'adapter-tmp'),
      workspaces: () => [t.main],
      projects: () => [],
      providerId: 'unused',
      registry: { acquire: () => ({}) as never },
    } as unknown as HarnessHostOptions)
    expect(direct.historyStore!()).toBe(adapter.historyStore!())
    expect(direct.historyStore!()).toMatch(/^claude-config:[0-9a-f]{64}$/u)
  })
})
