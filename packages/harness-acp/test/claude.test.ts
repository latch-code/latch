import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertCommandVersion,
  forgetCommandLookups,
  presetRoute,
  resolveCommand,
  selectProfile,
  setCommandSearch,
  setLoginPrograms,
} from '../src/index.ts'
import {
  claudeArgs,
  ClaudeWire,
  routeWarnings,
  type ClaudeQuery,
  type ClaudeQueryFunction,
  type ClaudeSpawnOptions,
} from '../src/wires/claude.ts'
import { ConnectionClosed, type ExitInfo, type SpawnSpec } from '../src/wires/process.ts'
import { RpcError } from '../src/protocol.ts'
import { claudeErrorQuota, claudeUsageQuota, claudeUsageRead } from '../src/quota.ts'
import { ForkRefused, type WireHandlers } from '../src/wires/types.ts'
import { answer, claudeFixture, line, prompt, uuidOf, type ClaudeFixture } from './helpers/claude-store.ts'

const run = promisify(execFile)
const SESSION = '0b7c3f2e-5d1a-4c8e-9f60-1a2b3c4d5e6f'
/** Shaped like Latch's gateway token, and built here so the file holds none. */
const TOKEN = ['lmg1', 'x'.repeat(40)].join('.')
const MODELS = [
  {
    value: 'default',
    displayName: 'Default',
    resolvedModel: 'claude-opus-5',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high'],
  },
  {
    value: 'sonnet',
    displayName: 'Sonnet',
    resolvedModel: 'claude-sonnet-5',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'high'],
    supportsAutoMode: true,
  },
]

/** A queue the fake reads from and writes to, as the SDK's streams would. */
class Channel<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiting: Array<(result: IteratorResult<T>) => void> = []
  private done = false
  push(item: T): void {
    const next = this.waiting.shift()
    if (next) next({ value: item, done: false })
    else this.items.push(item)
  }
  end(): void {
    this.done = true
    for (const next of this.waiting.splice(0)) next({ value: undefined, done: true })
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () =>
        this.items.length
          ? Promise.resolve({ value: this.items.shift()!, done: false })
          : this.done
            ? Promise.resolve({ value: undefined, done: true })
            : new Promise(resolve => this.waiting.push(resolve)),
    }
  }
}

/** The SDK's `query()`, as far as the wire uses it: what it was given, and messages the test sends as `claude`. */
class FakeQuery implements ClaudeQuery {
  readonly out = new Channel<unknown>()
  readonly prompts: Array<Record<string, unknown>> = []
  readonly calls: Array<[string, ...unknown[]]> = []
  interruptAck?: () => void
  closed = false
  constructor(
    readonly options: Record<string, unknown>,
    prompt: AsyncIterable<unknown>,
  ) {
    void (async () => {
      for await (const item of prompt) this.prompts.push(item as Record<string, unknown>)
    })()
  }
  [Symbol.asyncIterator]() {
    return this.out[Symbol.asyncIterator]()
  }
  interrupt(): Promise<unknown> {
    this.calls.push(['interrupt'])
    return new Promise(resolve => {
      this.interruptAck = () => resolve({ still_queued: [] })
    })
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
  async stopTask(taskId: string) {
    this.calls.push(['stopTask', taskId])
  }
  async initializationResult() {
    return {
      models: MODELS,
      commands: [{ name: 'review', description: 'Review a change', argumentHint: '<ref>' }],
      account: { email: 'someone@example.com', organization: 'Org', subscriptionType: 'max', apiProvider: 'firstParty' },
    }
  }
  async supportedCommands() {
    return []
  }
  async getContextUsage() {
    return { totalTokens: 4321, maxTokens: 200_000, model: 'claude-opus-5' }
  }
  close() {
    this.closed = true
    this.out.end()
  }
  canUseTool(tool: string, input: Record<string, unknown>, toolUseID: string, extra: Record<string, unknown> = {}) {
    const ask = this.options.canUseTool as (tool: string, input: Record<string, unknown>, context: unknown) => Promise<unknown>
    return ask(tool, input, { signal: new AbortController().signal, toolUseID, ...extra })
  }
}

interface Harness {
  wire: ClaudeWire
  queries: FakeQuery[]
  notifications: Array<Record<string, unknown>>
  /** Every notification with the session it was sent on. */
  sent: Array<{ method: string; sessionId?: string; update?: Record<string, unknown>; params: unknown }>
  asked: Array<{ method: string; params: Record<string, unknown> }>
  exits: ExitInfo[]
  answer: (params: Record<string, unknown>) => unknown
}

const SPEC: SpawnSpec = {
  command: '/opt/people/bin/claude',
  args: [],
  cwd: tmpdir(),
  env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/home/someone', TMPDIR: tmpdir(), ANTHROPIC_AUTH_TOKEN: TOKEN },
  maxLineBytes: 1024 * 1024,
  redact: text => text.split(TOKEN).join('[redacted]'),
}

function harness(route?: { model: string; models: string[] }, spec: SpawnSpec = SPEC, store = false): Harness {
  const queries: FakeQuery[] = []
  const query: ClaudeQueryFunction = ({ prompt, options }) => {
    const made = new FakeQuery(options, prompt)
    queries.push(made)
    return made
  }
  const h: Harness = {
    queries,
    notifications: [],
    sent: [],
    asked: [],
    exits: [],
    answer: () => ({ outcome: { outcome: 'selected', optionId: 'allow-once' } }),
    wire: undefined!,
  }
  const handlers: WireHandlers = {
    request: async (method, params) => {
      h.asked.push({ method, params: params as Record<string, unknown> })
      return h.answer(params as Record<string, unknown>)
    },
    notification: (method, params) => {
      const { sessionId, update } = params as { sessionId?: string; update?: Record<string, unknown> }
      h.sent.push({ method, ...(sessionId ? { sessionId } : {}), ...(update ? { update } : {}), params })
      if (method === 'session/update' && update) h.notifications.push(update)
    },
    exit: info => h.exits.push(info),
  }
  h.wire = ClaudeWire.spawn(spec, handlers, route ? ({ ...route, modelCapabilities: {}, setThinking: () => {} } as never) : undefined, {
    query,
    ...(store ? { store: true } : {}),
  })
  return h
}

const updates = (h: Harness, kind: string) => h.notifications.filter(update => update.sessionUpdate === kind)
const optionValue = (options: unknown, id: string) =>
  (options as Array<{ id: string; currentValue: string }>).find(option => option.id === id)?.currentValue
const tick = () => new Promise(resolve => setImmediate(resolve))

afterEach(() => {
  vi.restoreAllMocks()
  setCommandSearch(undefined)
  setLoginPrograms(undefined)
  forgetCommandLookups()
})

describe('Claude through the Agent SDK', () => {
  it('starts the person’s claude with the runtime’s environment, their settings and Claude Code’s own prompt and tools', async () => {
    const h = harness()
    const init = (await h.wire.request('initialize', {})) as Record<string, any>
    expect(init.agentCapabilities.sessionCapabilities).toEqual({ resume: {}, close: {} })
    const opened = (await h.wire.request('session/new', {
      cwd: '/work',
      mcpServers: [{ name: 'latch-skills', command: '/usr/bin/node', args: ['--disable-sigusr1', '-e', 'x'], env: [] }],
      _meta: { claudeCode: { options: { settings: { apiKeyHelper: '', availableModels: ['m'] }, other: 'ignored' } } },
    })) as { sessionId: string; configOptions: unknown[] }
    const options = h.queries[0]!.options
    expect(opened.sessionId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(options).toMatchObject({
      cwd: '/work',
      pathToClaudeCodeExecutable: SPEC.command,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      tools: { type: 'preset', preset: 'claude_code' },
      includePartialMessages: true,
      permissionMode: 'default',
      sessionId: opened.sessionId,
      settings: { apiKeyHelper: '', availableModels: ['m'] },
      mcpServers: { 'latch-skills': { type: 'stdio', command: '/usr/bin/node', args: ['--disable-sigusr1', '-e', 'x'] } },
    })
    expect(options.resume).toBeUndefined()
    // Never the Host's environment, which the SDK takes when it is given none; Claude says when a turn is over.
    expect(options.env).toEqual({ ...SPEC.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' })
    expect(opened.configOptions.map(option => (option as { id: string }).id)).toEqual(['mode', 'model', 'effort'])
    expect(optionValue(opened.configOptions, 'mode')).toBe('default')
    // The CLI reports the model it runs; the default row resolves to it.
    expect(optionValue(opened.configOptions, 'model')).toBe('default')
    expect(optionValue(opened.configOptions, 'effort')).toBe('default')
  })

  it('refuses arguments in the definition: the SDK writes them all', () => {
    expect(() => claudeArgs(['--model', 'x'])).toThrow(/参数由 Latch 与 SDK 设置/u)
    expect(() => harness(undefined, { ...SPEC, args: ['--debug'] })).toThrow()
  })

  it('reports Claude commands on open, keeps their hints and replaces the list when the SDK changes it', async () => {
    const h = harness()
    const { sessionId } = (await h.wire.request('session/new', { cwd: '/work', mcpServers: [] })) as { sessionId: string }
    const q = h.queries[0]!
    const reports = () => updates(h, 'available_commands_update').map(update => update.availableCommands)
    const review = { name: 'review', description: 'Review a change', input: { hint: '<ref>' } }
    expect(reports()).toEqual([[review]])
    const system = { type: 'system', session_id: sessionId }
    q.out.push({ ...system, subtype: 'init', slash_commands: ['review', 'summary', 'exit'], terminal_slash_commands: ['exit'] })
    q.out.push({ ...system, subtype: 'init', slash_commands: ['review', 'summary', 'exit'], terminal_slash_commands: ['exit'] })
    const changed = { ...system, subtype: 'commands_changed' }
    q.out.push({ ...changed, session_id: SESSION, commands: [] })
    q.out.push({ ...changed, parent_tool_use_id: 'child-tool', commands: [] })
    q.out.push({ ...changed, commands: [{ name: 'mcp:tools:fix', argumentHint: '<file>' }, { name: 'exit' }] })
    q.out.push({ ...changed, commands: [] })
    await tick()
    expect(reports()).toEqual([[review], [review, { name: 'summary' }], [{ name: 'mcp:tools:fix', input: { hint: '<file>' } }], []])
    expect(q.prompts).toEqual([])
  })

  it('keeps an empty command update that arrives before the initial command snapshot', async () => {
    const init = FakeQuery.prototype.initializationResult
    vi.spyOn(FakeQuery.prototype, 'initializationResult').mockImplementationOnce(async function (this: FakeQuery) {
      this.out.push({ type: 'system', subtype: 'commands_changed', session_id: SESSION, commands: [] })
      await tick()
      return init.call(this)
    })
    const h = harness()
    await h.wire.request('session/resume', { sessionId: SESSION, cwd: '/work', mcpServers: [] })
    expect(updates(h, 'available_commands_update').map(update => update.availableCommands)).toEqual([[]])
  })

  it('sends the input, streams text and thinking, reports tool calls and ends the turn with its usage', async () => {
    const h = harness()
    const { sessionId } = (await h.wire.request('session/new', { cwd: '/work', mcpServers: [] })) as { sessionId: string }
    const q = h.queries[0]!
    const answered = h.wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] })
    await tick()
    expect(q.prompts[0]).toMatchObject({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      parent_tool_use_id: null,
    })
    const uuid = q.prompts[0]!.uuid as string
    expect(updates(h, 'available_commands_update')[0]!.availableCommands).toEqual([
      { name: 'review', description: 'Review a change', input: { hint: '<ref>' } },
    ])
    q.out.push({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'msg_1' } } })
    q.out.push({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } },
    })
    q.out.push({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } },
    })
    q.out.push({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } },
    })
    q.out.push({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'msg_1',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'Hello' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/work/a.txt' } },
        ],
      },
    })
    q.out.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body' }] },
    })
    q.out.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      stop_reason: 'end_turn',
      user_message_uuid: uuid,
      total_cost_usd: 0.25,
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 },
    })
    await expect(answered).resolves.toEqual({
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 20, cachedReadTokens: 300, cachedWriteTokens: 40 },
    })
    // Streamed once: the whole message adds nothing already sent.
    expect(updates(h, 'agent_message_chunk').map(update => (update.content as { text: string }).text)).toEqual(['Hel', 'lo'])
    expect(updates(h, 'agent_thought_chunk').map(update => (update.content as { text: string }).text)).toEqual(['hmm'])
    expect(updates(h, 'tool_call')[0]).toMatchObject({
      toolCallId: 'toolu_1',
      kind: 'read',
      title: 'Read a.txt',
      locations: [{ path: '/work/a.txt', line: 1 }],
    })
    expect(updates(h, 'tool_call_update')[0]).toMatchObject({ toolCallId: 'toolu_1', status: 'completed' })
    expect(updates(h, 'usage_update').at(-1)).toMatchObject({
      sessionUpdate: 'usage_update',
      used: 4321,
      size: 200_000,
      cost: { amount: 0.25, currency: 'USD' },
    })
  })

  it('adds nothing twice when claude sends the streamed message one content block at a time', async () => {
    const h = harness()
    const { sessionId } = (await h.wire.request('session/new', { cwd: '/work', mcpServers: [] })) as { sessionId: string }
    const q = h.queries[0]!
    const answered = h.wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] })
    await tick()
    const stream = (event: unknown) => q.out.push({ type: 'stream_event', parent_tool_use_id: null, event })
    const whole = (block: unknown) =>
      q.out.push({ type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_2', content: [block] } })
    stream({ type: 'message_start', message: { id: 'msg_2' } })
    stream({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'think' } })
    whole({ type: 'thinking', thinking: 'think' })
    stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } })
    whole({ type: 'text', text: 'answer' })
    q.out.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      user_message_uuid: q.prompts[0]!.uuid,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    await answered
    expect(updates(h, 'agent_thought_chunk').map(update => (update.content as { text: string }).text)).toEqual(['think'])
    expect(updates(h, 'agent_message_chunk').map(update => (update.content as { text: string }).text)).toEqual(['answer'])
  })

  it('reports usage alone for a turn Claude Code started itself, and passes rate limits as the adapter does', async () => {
    const h = harness()
    const { sessionId } = (await h.wire.request('session/new', { cwd: '/work', mcpServers: [] })) as { sessionId: string }
    const q = h.queries[0]!
    const answered = h.wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] })
    await tick()
    q.out.push({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' } })
    q.out.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      user_message_uuid: 'someone-else',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    await tick()
    let settled = false
    void answered.then(() => (settled = true))
    await tick()
    expect(settled).toBe(false)
    expect(updates(h, 'usage_update')[0]).toEqual({
      sessionUpdate: 'usage_update',
      _meta: { '_claude/rateLimit': { status: 'allowed', rateLimitType: 'five_hour' } },
    })
    q.out.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      user_message_uuid: q.prompts[0]!.uuid,
      usage: { input_tokens: 2, output_tokens: 3 },
    })
    await expect(answered).resolves.toMatchObject({ stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 3 } })
  })

  it('asks before a call and hands back exactly what was decided: allowed with its own input, or refused', async () => {
    const h = harness()
    await h.wire.request('session/new', { cwd: '/work', mcpServers: [] })
    const q = h.queries[0]!
    const input = { command: 'rm -rf build' }
    await expect(q.canUseTool('Bash', input, 'toolu_9')).resolves.toEqual({
      behavior: 'allow',
      updatedInput: input,
      toolUseID: 'toolu_9',
      decisionClassification: 'user_temporary',
    })
    expect(h.asked[0]).toMatchObject({
      method: 'session/request_permission',
      params: {
        toolCall: { toolCallId: 'toolu_9', kind: 'execute', rawInput: input },
        options: [
          { optionId: 'allow-once', kind: 'allow_once' },
          { optionId: 'reject', kind: 'reject_once' },
        ],
      },
    })
    // The call was reported before it was asked about.
    expect(updates(h, 'tool_call')[0]).toMatchObject({ toolCallId: 'toolu_9' })
    h.answer = () => ({ outcome: { outcome: 'selected', optionId: 'reject' } })
    await expect(q.canUseTool('Write', { file_path: '/work/b', content: 'x' }, 'toolu_10')).resolves.toMatchObject({
      behavior: 'deny',
      toolUseID: 'toolu_10',
    })
    h.answer = () => ({ outcome: { outcome: 'cancelled' } })
    await expect(q.canUseTool('Bash', input, 'toolu_11')).resolves.toMatchObject({ behavior: 'deny' })
    // Leaving a plan only to Manual, with the plan in the call's input.
    h.answer = () => ({ outcome: { outcome: 'selected', optionId: 'exit-plan-default' } })
    await expect(q.canUseTool('ExitPlanMode', { plan: 'do it' }, 'toolu_12')).resolves.toMatchObject({
      behavior: 'allow',
      updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }],
    })
    expect(h.asked.at(-1)!.params).toMatchObject({ toolCall: { kind: 'switch_mode', rawInput: { plan: 'do it' } } })
    // A plain allow never accepts a plan.
    h.answer = () => ({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    await expect(q.canUseTool('ExitPlanMode', { plan: 'do it' }, 'toolu_13')).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('settles a cancelled turn only once claude acknowledged the interrupt and ended the turn', async () => {
    const h = harness()
    const { sessionId } = (await h.wire.request('session/new', { cwd: '/work', mcpServers: [] })) as { sessionId: string }
    const q = h.queries[0]!
    const answered = h.wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'long' }] })
    let settled = false
    void answered.then(() => (settled = true))
    await tick()
    h.wire.notify('session/cancel', { sessionId })
    expect(q.calls).toContainEqual(['interrupt'])
    q.out.push({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      user_message_uuid: q.prompts[0]!.uuid,
      usage: { input_tokens: 1, output_tokens: 0 },
    })
    await tick()
    await tick()
    expect(settled).toBe(false)
    q.interruptAck!()
    await expect(answered).resolves.toMatchObject({ stopReason: 'cancelled' })
  })

  it('resumes a session the adapter created by the same ID, with the same mode, model and effort IDs', async () => {
    const h = harness()
    const resumed = (await h.wire.request('session/resume', { sessionId: SESSION, cwd: '/work', mcpServers: [] })) as {
      sessionId: string
      configOptions: Array<{ id: string; options: Array<{ value: string }> }>
    }
    expect(resumed.sessionId).toBe(SESSION)
    expect(h.queries[0]!.options.resume).toBe(SESSION)
    expect(h.queries[0]!.options.sessionId).toBeUndefined()
    // claude-agent-acp's option IDs and mode IDs (session-config-ids.js, session-mode.js).
    expect(resumed.configOptions.map(option => option.id)).toEqual(['mode', 'model', 'effort'])
    expect(resumed.configOptions[0]!.options.map(option => option.value)).toEqual(['default', 'acceptEdits', 'plan', 'bypassPermissions'])
    // Anything that is not one of Claude's session IDs is not looked for.
    await expect(h.wire.request('session/resume', { sessionId: '../x', cwd: '/work' })).rejects.toMatchObject({ code: -32002 })
  })

  it('changes mode, model and effort through the SDK and reads a mode Claude changed itself', async () => {
    const h = harness()
    const { sessionId } = (await h.wire.request('session/new', { cwd: '/work', mcpServers: [] })) as { sessionId: string }
    const q = h.queries[0]!
    let answer = (await h.wire.request('session/set_config_option', { sessionId, configId: 'mode', value: 'plan' })) as {
      configOptions: unknown
    }
    expect(optionValue(answer.configOptions, 'mode')).toBe('plan')
    answer = (await h.wire.request('session/set_config_option', { sessionId, configId: 'model', value: 'sonnet' })) as {
      configOptions: unknown
    }
    expect(optionValue(answer.configOptions, 'model')).toBe('sonnet')
    answer = (await h.wire.request('session/set_config_option', { sessionId, configId: 'effort', value: 'high' })) as {
      configOptions: unknown
    }
    expect(optionValue(answer.configOptions, 'effort')).toBe('high')
    await h.wire.request('session/set_config_option', { sessionId, configId: 'effort', value: 'default' })
    await h.wire.request('session/set_config_option', { sessionId, configId: 'model', value: 'default' })
    expect(q.calls).toEqual([
      ['setPermissionMode', 'plan'],
      ['setModel', 'sonnet'],
      ['applyFlagSettings', { effortLevel: 'high' }],
      ['applyFlagSettings', { effortLevel: null }],
      ['setModel', undefined],
    ])
    await expect(h.wire.request('session/set_config_option', { sessionId, configId: 'mode', value: 'dontAsk' })).rejects.toMatchObject({
      code: -32602,
    })
    q.out.push({ type: 'system', subtype: 'status', status: null, permissionMode: 'acceptEdits' })
    await tick()
    expect(optionValue(updates(h, 'config_option_update').at(-1)!.configOptions, 'mode')).toBe('acceptEdits')
  })

  it('names a call Claude refused by its own rules the way the adapter does', async () => {
    const h = harness()
    await h.wire.request('session/new', { cwd: '/work', mcpServers: [] })
    h.queries[0]!.out.push({
      type: 'system',
      subtype: 'permission_denied',
      tool_use_id: 'toolu_3',
      decision_reason_type: 'classifier',
      decision_reason: 'risky',
    })
    await tick()
    expect(updates(h, 'tool_call_update')[0]).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'toolu_3',
      status: 'failed',
      _meta: { claudeCode: { toolResponse: { decisionReasonType: 'classifier', decisionReason: 'risky' } } },
    })
  })

  it('offers only the route’s models and reports no cost on a gateway route', async () => {
    const h = harness({ model: 'sonnet', models: ['sonnet'] })
    const { sessionId, configOptions } = (await h.wire.request('session/new', { cwd: '/work', mcpServers: [] })) as {
      sessionId: string
      configOptions: unknown
    }
    expect(optionValue(configOptions, 'model')).toBe('sonnet')
    await expect(h.wire.request('session/set_config_option', { sessionId, configId: 'model', value: 'opus' })).rejects.toMatchObject({
      code: -32602,
    })
    const q = h.queries[0]!
    const answered = h.wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] })
    await tick()
    q.out.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      user_message_uuid: q.prompts[0]!.uuid,
      total_cost_usd: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    await answered
    const usage = updates(h, 'usage_update').at(-1)
    expect(usage).toMatchObject({ sessionUpdate: 'usage_update', used: 4321, size: 200_000 })
    expect(usage).not.toHaveProperty('cost')
  })
})

describe('the claude process', () => {
  /** What the SDK would hand `spawnClaudeCodeProcess`, with a program that prints what it got and the group it runs in. */
  const printer = (signal: AbortSignal, exitCode = 0): ClaudeSpawnOptions => ({
    command: process.execPath,
    args: [
      '-e',
      `process.stdout.write(JSON.stringify({ env: process.env, argv: process.argv.slice(1) }) + '\\n'); setTimeout(() => process.exit(${exitCode}), 50)`,
    ],
    env: {
      ...SPEC.env,
      // What the SDK adds, and what a Host would have that the runtime left out.
      CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
      CLAUDE_AGENT_SDK_VERSION: '0.3.322',
      HOST_ONLY_SECRET: 'not-for-claude',
      LATCH_API_KEY: 'not-for-claude',
    },
    signal,
  })

  it('runs in its own process group with the runtime’s environment, the token only there, and its end closes the wire', async () => {
    const h = harness(undefined, { ...SPEC, command: process.execPath })
    const { sessionId } = (await h.wire.request('session/new', { cwd: tmpdir(), mcpServers: [] })) as { sessionId: string }
    const q = h.queries[0]!
    const spawn = q.options.spawnClaudeCodeProcess as (options: ClaudeSpawnOptions) => {
      stdout: NodeJS.ReadableStream
      on(event: 'exit', listener: (code: number | null) => void): void
    }
    const answered = h.wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] })
    const child = spawn(printer(new AbortController().signal, 3))
    let printed = ''
    child.stdout.on('data', (chunk: Buffer) => (printed += chunk.toString('utf8')))
    const pid = await vi.waitFor(() => {
      const found = printed && (JSON.parse(printed.split('\n')[0]!) as { env: Record<string, string>; argv: string[] })
      if (!found) throw new Error('not yet')
      return found
    })
    expect(pid.env).toMatchObject({ ...SPEC.env, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_VERSION: '0.3.322' })
    expect(pid.env.HOST_ONLY_SECRET).toBeUndefined()
    expect(pid.env.LATCH_API_KEY).toBeUndefined()
    expect(pid.argv.join(' ')).not.toContain(TOKEN)
    expect(JSON.stringify(q.options.mcpServers)).not.toContain(TOKEN)
    const exit = await new Promise<number | null>(resolve => child.on('exit', resolve))
    expect(exit).toBe(3)
    // The process ended by itself: the turn fails as a closed connection, and the runtime hears of the exit once.
    await expect(answered).rejects.toBeInstanceOf(ConnectionClosed)
    expect(h.exits).toHaveLength(1)
    expect(h.wire.closed).toBe(true)
  })

  it('leads its own group, and stop ends the whole group', async () => {
    const h = harness(undefined, { ...SPEC, command: process.execPath })
    await h.wire.request('session/new', { cwd: tmpdir(), mcpServers: [] })
    const spawn = h.queries[0]!.options.spawnClaudeCodeProcess as (options: ClaudeSpawnOptions) => { stdout: NodeJS.ReadableStream }
    const options = printer(new AbortController().signal)
    const child = spawn({ ...options, args: ['-e', 'setInterval(() => {}, 1000); process.stdout.write(String(process.pid) + "\\n")'] })
    let printed = ''
    child.stdout.on('data', (chunk: Buffer) => (printed += chunk.toString('utf8')))
    const pid = Number(await vi.waitFor(() => printed.trim() || Promise.reject(new Error('not yet'))))
    const { stdout } = await run('/bin/ps', ['-o', 'pgid=', '-p', String(pid)])
    expect(Number(stdout.trim())).toBe(pid)
    const info = await h.wire.stop('stop', 200)
    expect(info.reason).toBe('stop')
    expect(() => process.kill(-pid, 0)).toThrow()
    expect(h.exits).toHaveLength(1)
  })

  it('stops at once when no session has started claude yet', async () => {
    const h = harness()
    await expect(h.wire.stop('stop', 100)).resolves.toMatchObject({ reason: 'stop' })
    expect(h.exits).toHaveLength(1)
    await expect(h.wire.request('session/new', { cwd: '/work' })).rejects.toBeInstanceOf(ConnectionClosed)
  })
})

describe('the Claude Agent preset’s route', () => {
  /** A directory with the named programs; `claude --version` prints `version`. */
  async function programs(names: string[], version = '2.1.327'): Promise<string> {
    const bin = await mkdtemp(join(tmpdir(), 'latch-claude-route-'))
    for (const name of names) {
      await writeFile(join(bin, name), `#!/bin/sh\nif [ "$1" = --version ]; then echo '${version} (Claude Code)'; fi\n`)
      await chmod(join(bin, name), 0o755)
    }
    setCommandSearch(() => [bin])
    setLoginPrograms(resolveCommand)
    forgetCommandLookups()
    return bin
  }

  it('goes directly to claude when it is new enough, to the adapter only without claude, and never swaps a claude too old', async () => {
    const both = await programs(['claude', 'claude-agent-acp'])
    const direct = presetRoute('claude-agent')!
    expect(direct).toMatchObject({ command: 'claude', args: [] })
    expect(selectProfile(direct).profile?.wire).toBe('claude')
    await expect(assertCommandVersion(direct)).resolves.toBeUndefined()
    await rm(both, { recursive: true, force: true })

    const adapterOnly = await programs(['claude-agent-acp'])
    const adapter = presetRoute('claude-agent')!
    expect(adapter).toMatchObject({ command: 'claude-agent-acp', args: [] })
    expect(selectProfile(adapter).profile?.wire).toBeUndefined()
    await rm(adapterOnly, { recursive: true, force: true })

    const old = await programs(['claude', 'claude-agent-acp'], '2.1.300')
    const refused = presetRoute('claude-agent')!
    expect(refused.command).toBe('claude')
    await expect(assertCommandVersion(refused)).rejects.toMatchObject({ status: 409, code: 'harness-version-unsupported' })
    await rm(old, { recursive: true, force: true })
  })

  it('keeps a definition saved on the adapter on the adapter', () => {
    const saved = { id: 'c', name: 'Claude', presetId: 'claude-agent', command: 'claude-agent-acp', args: [], env: {}, enabled: true }
    expect(selectProfile(saved).profile?.wire).toBeUndefined()
    expect(selectProfile(saved).profile?.permission.versionRule).toBeDefined()
  })
})

describe('what the adapter shows, on the direct wire', () => {
  const opened = async (h: Harness, init: Record<string, unknown> = {}) => {
    await h.wire.request('initialize', init)
    return ((await h.wire.request('session/new', { cwd: '/work', mcpServers: [] })) as { sessionId: string }).sessionId
  }
  const optionIds = (h: Harness) =>
    ((h.asked.at(-1)!.params.options as Array<{ optionId: string; kind: string }>) ?? []).map(option => `${option.optionId}:${option.kind}`)

  it('offers always-allow with Claude’s own suggestion and hands it back as updatedPermissions, unless an ask rule forced the ask', async () => {
    const h = harness()
    await opened(h)
    const q = h.queries[0]!
    const rule = [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' },
    ]
    h.answer = () => ({ outcome: { outcome: 'selected', optionId: 'allow-with-updates' } })
    await expect(q.canUseTool('Bash', { command: 'npm test' }, 'toolu_a', { suggestions: rule })).resolves.toMatchObject({
      behavior: 'allow',
      updatedPermissions: rule,
      decisionClassification: 'user_permanent',
    })
    expect(optionIds(h)).toEqual(['allow-once:allow_once', 'allow-with-updates:allow_always', 'reject:reject_once'])
    expect((h.asked.at(-1)!.params.options as Array<{ name: string }>)[1]!.name).toBe("Yes, and don't ask again for npm test commands")
    // Reading in the session directory: Claude's session rule, as the adapter labels it.
    const read = [{ type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '/work/**' }], behavior: 'allow', destination: 'session' }]
    await q.canUseTool('Read', { file_path: '/work/a.txt' }, 'toolu_b', { suggestions: read })
    expect((h.asked.at(-1)!.params.options as Array<{ name: string }>)[1]!.name).toBe('Yes, during this session')
    // The person's own ask rule asked: never a rule that outlives this answer.
    await q.canUseTool('Bash', { command: 'npm test' }, 'toolu_c', {
      suggestions: rule,
      matchedAskRule: { source: 'user', toolName: 'Bash' },
    })
    expect(optionIds(h)).toEqual(['allow-once:allow_once', 'reject:reject_once'])
  })

  it('asks Claude’s own questions through the question form and answers into the tool’s input, or turns the tool off without one', async () => {
    const plain = harness()
    await opened(plain)
    expect(plain.queries[0]!.options.disallowedTools).toEqual(['AskUserQuestion'])

    const h = harness()
    await opened(h, { clientCapabilities: { elicitation: { form: {} } } })
    const q = h.queries[0]!
    expect(q.options.disallowedTools).toBeUndefined()
    const input = {
      questions: [{ question: 'Which colour?', header: 'Colour', options: [{ label: 'Blue' }, { label: 'Green', description: 'leafy' }] }],
    }
    h.answer = () => ({ action: 'accept', content: { question_0: 'Green', question_0_custom: 'pale' } })
    await expect(q.canUseTool('AskUserQuestion', input, 'toolu_q')).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { ...input, answers: { 'Which colour?': 'Green' }, annotations: { 'Which colour?': { notes: 'pale' } } },
    })
    const asked = h.asked.at(-1)!
    expect(asked.method).toBe('elicitation/create')
    expect(asked.params).toMatchObject({
      mode: 'form',
      toolCallId: 'toolu_q',
      message: 'Which colour?',
      requestedSchema: {
        type: 'object',
        properties: {
          question_0: {
            type: 'string',
            title: 'Colour',
            oneOf: [
              { const: 'Blue', title: 'Blue' },
              { const: 'Green', title: 'Green', description: 'leafy' },
            ],
          },
          question_0_custom: { type: 'string', title: 'Other' },
        },
      },
    })
    h.answer = () => ({ action: 'cancel' })
    await expect(q.canUseTool('AskUserQuestion', input, 'toolu_r')).rejects.toThrow('Tool use aborted')
  })

  it('offers the adapter’s plan exits, and keep planning ends the turn as cancelled', async () => {
    const h = harness()
    const sessionId = await opened(h)
    const q = h.queries[0]!
    const answered = h.wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'plan it' }] })
    await tick()
    h.answer = () => ({ outcome: { outcome: 'selected', optionId: 'reject' } })
    await expect(q.canUseTool('ExitPlanMode', { plan: 'step one' }, 'toolu_p')).resolves.toMatchObject({
      behavior: 'deny',
      message: 'User chose to keep planning',
      interrupt: true,
    })
    expect(optionIds(h)).toEqual([
      'exit-plan-default:allow_once',
      // Bypass is on offer (the session may switch to it), so it leads, as in the adapter.
      'exit-plan-clear-bypass:allow_always',
      'exit-plan-bypass:allow_always',
      'reject:reject_once',
    ])
    q.out.push({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      user_message_uuid: q.prompts[0]!.uuid,
      usage: { input_tokens: 1, output_tokens: 0 },
    })
    await expect(answered).resolves.toMatchObject({ stopReason: 'cancelled' })
    // Accepting moves Claude to the mode the choice names, reported back as its own change.
    h.answer = () => ({ outcome: { outcome: 'selected', optionId: 'exit-plan-default' } })
    await h.wire.request('session/set_config_option', { sessionId, configId: 'mode', value: 'plan' })
    await expect(q.canUseTool('ExitPlanMode', { plan: 'step one' }, 'toolu_p2')).resolves.toMatchObject({
      behavior: 'allow',
      updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }],
    })
    expect(optionValue(updates(h, 'config_option_update').at(-1)!.configOptions, 'mode')).toBe('default')
    // A choice it did not offer is refused.
    h.answer = () => ({ outcome: { outcome: 'selected', optionId: 'exit-plan-accept-edits' } })
    await expect(q.canUseTool('ExitPlanMode', { plan: 'step one' }, 'toolu_p3')).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('shows a subagent as a child session: announced, its words and calls there, its asks there, stopped alone, ended by its call', async () => {
    const h = harness()
    const sessionId = await opened(h)
    const q = h.queries[0]!
    const answered = h.wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'delegate' }] })
    await tick()
    q.out.push({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'm1',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_agent',
            name: 'Agent',
            input: { description: 'Look around', subagent_type: 'Explore', prompt: 'x' },
          },
        ],
      },
    })
    q.out.push({ type: 'system', subtype: 'task_started', task_id: 'task-7', tool_use_id: 'toolu_agent', description: 'Look around' })
    q.out.push({
      type: 'assistant',
      parent_tool_use_id: 'toolu_agent',
      message: {
        id: 'm2',
        content: [
          { type: 'text', text: 'child says' },
          { type: 'tool_use', id: 'toolu_child', name: 'Read', input: { file_path: '/work/b' } },
        ],
      },
    })
    q.out.push({
      type: 'user',
      parent_tool_use_id: 'toolu_agent',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_child', content: 'b body' }] },
    })
    await tick()
    const child = `${sessionId}/subagent/toolu_agent`
    const on = (id: string) => h.sent.filter(item => item.sessionId === id).map(item => item.update)
    expect(on(sessionId).filter(update => update?.sessionUpdate === 'subagent_update')).toEqual([
      { sessionUpdate: 'subagent_update', sessionId: child, title: 'Explore', description: 'Look around', state: { state: 'running' } },
      { sessionUpdate: 'subagent_update', sessionId: child, capabilities: { cancel: {} } },
    ])
    expect(on(child).map(update => update?.sessionUpdate)).toEqual(['agent_message_chunk', 'tool_call', 'tool_call_update'])
    // Its ask goes on its own session.
    await q.canUseTool('Bash', { command: 'ls' }, 'toolu_child2', { agentID: 'task-7' })
    expect(h.asked.at(-1)!.params.sessionId).toBe(child)
    h.wire.notify('session/cancel', { sessionId: child })
    expect(q.calls).toContainEqual(['stopTask', 'task-7'])
    q.out.push({
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: 'found it' }] },
    })
    q.out.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      user_message_uuid: q.prompts[0]!.uuid,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    await answered
    expect(
      on(sessionId).at(-2)
        ?? on(sessionId).find(
          update => update?.sessionUpdate === 'subagent_update' && 'capabilities' in update && update.capabilities === null,
        ),
    ).toBeDefined()
    expect(
      on(sessionId).some(
        update => update?.sessionUpdate === 'subagent_update' && (update.state as { stopReason?: string })?.stopReason === 'end_turn',
      ),
    ).toBe(true)
  })

  it('carries the edit diffs and locations the adapter sends, and the real change once a write ran', async () => {
    const h = harness()
    await opened(h)
    const q = h.queries[0]!
    q.out.push({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'm3',
        content: [
          { type: 'tool_use', id: 'toolu_e', name: 'Edit', input: { file_path: '/work/a.ts', old_string: 'one', new_string: 'two' } },
          { type: 'tool_use', id: 'toolu_w', name: 'Write', input: { file_path: '/work/b.ts', content: 'new file' } },
          { type: 'tool_use', id: 'toolu_n', name: 'NotebookEdit', input: { notebook_path: '/work/c.ipynb', new_source: 'x' } },
        ],
      },
    })
    q.out.push({
      type: 'user',
      parent_tool_use_id: null,
      tool_use_result: { type: 'update', filePath: '/work/b.ts', structuredPatch: [{ newStart: 3, lines: [' keep', '-old', '+new'] }] },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_w', content: 'The file has been updated.' }] },
    })
    await tick()
    const calls = updates(h, 'tool_call')
    expect(calls[0]).toMatchObject({
      title: 'Edit a.ts',
      kind: 'edit',
      locations: [{ path: '/work/a.ts' }],
      content: [{ type: 'diff', path: '/work/a.ts', oldText: 'one', newText: 'two' }],
    })
    expect(calls[1]).toMatchObject({
      title: 'Write b.ts',
      content: [{ type: 'diff', path: '/work/b.ts', oldText: null, newText: 'new file' }],
    })
    expect(calls[2]).toMatchObject({ title: 'NotebookEdit', kind: 'other' })
    expect(updates(h, 'tool_call_update')[0]).toMatchObject({
      toolCallId: 'toolu_w',
      status: 'completed',
      content: [{ type: 'diff', path: '/work/b.ts', oldText: 'keep\nold', newText: 'keep\nnew' }],
      locations: [{ path: '/work/b.ts', line: 3 }],
    })
  })

  it('keeps the task list as the session’s plan, from TodoWrite and from the Task tools’ results, with no rows of their own', async () => {
    const h = harness()
    await opened(h)
    const q = h.queries[0]!
    q.out.push({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'm4',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_t',
            name: 'TodoWrite',
            input: {
              todos: [
                { content: 'Read', status: 'completed', activeForm: 'Reading' },
                { content: 'Write', status: 'in_progress', activeForm: 'Writing' },
              ],
            },
          },
        ],
      },
    })
    q.out.push({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'm5',
        content: [{ type: 'tool_use', id: 'toolu_c1', name: 'TaskCreate', input: { subject: 'Test it', activeForm: 'Testing it' } }],
      },
    })
    q.out.push({
      type: 'user',
      parent_tool_use_id: null,
      tool_use_result: { task: { id: '1', subject: 'Test it' } },
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_c1', content: 'Task #1 created successfully: Test it' }],
      },
    })
    q.out.push({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'm6',
        content: [{ type: 'tool_use', id: 'toolu_u1', name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } }],
      },
    })
    q.out.push({
      type: 'user',
      parent_tool_use_id: null,
      tool_use_result: { success: true, taskId: '1', updatedFields: ['status'] },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_u1', content: 'Updated' }] },
    })
    await tick()
    expect(updates(h, 'plan').map(update => update.entries)).toEqual([
      [
        { content: 'Read', status: 'completed', priority: 'medium' },
        { content: 'Writing', status: 'in_progress', priority: 'medium' },
      ],
      [{ content: 'Test it', status: 'pending', priority: 'medium' }],
      [{ content: 'Testing it', status: 'in_progress', priority: 'medium' }],
    ])
    expect(updates(h, 'tool_call')).toEqual([])
    expect(updates(h, 'tool_call_update')).toEqual([])
  })

  it('passes the rate limit Claude reported with a turn refused for it, which the quota reads as the adapter’s', async () => {
    const h = harness()
    const sessionId = await opened(h)
    const q = h.queries[0]!
    const answered = h.wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] })
    await tick()
    const limit = { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 3600 }
    q.out.push({ type: 'rate_limit_event', rate_limit_info: limit })
    q.out.push({
      type: 'assistant',
      parent_tool_use_id: null,
      error: 'rate_limit',
      message: { id: 'm7', content: [{ type: 'text', text: 'You hit your limit' }] },
    })
    q.out.push({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'You hit your limit',
      user_message_uuid: q.prompts[0]!.uuid,
      usage: { input_tokens: 0, output_tokens: 0 },
    })
    const error = (await answered.catch((caught: unknown) => caught)) as RpcError
    expect(error).toBeInstanceOf(RpcError)
    expect(error.data).toEqual({ errorKind: 'rate_limit', rateLimit: limit })
    expect(claudeErrorQuota(error.data, Date.now())?.windows[0]).toMatchObject({ kind: 'five-hour', state: 'limited' })
    expect(claudeUsageQuota(updates(h, 'usage_update')[0]!, Date.now())?.windows[0]).toMatchObject({ kind: 'five-hour', state: 'limited' })
  })

  it('pushes the login Claude reports, never its address or organization, and the gateway’s on a route', async () => {
    const own = harness()
    await opened(own)
    expect(own.sent.filter(item => item.method === '_auth/status_update').map(item => item.params)).toEqual([
      { authStatus: { kind: 'account', label: 'Claude Max' } },
    ])
    expect(JSON.stringify(own.sent)).not.toContain('someone@example.com')
    const routed = harness({ model: 'sonnet', models: ['sonnet'] })
    await opened(routed)
    expect(routed.sent.filter(item => item.method === '_auth/status_update').map(item => item.params)).toEqual([
      { authStatus: { kind: 'gateway', label: 'Custom model gateway' } },
    ])
  })
})

describe('Claude’s own store, read only where the Host lets the wire', () => {
  const S1 = '11111111-1111-4111-8111-111111111111'
  const LATCH_MESSAGE = '44444444-4444-4444-8444-444444444444'
  let fixture: ClaudeFixture | undefined
  afterEach(async () => {
    await fixture?.remove()
    fixture = undefined
  })

  async function stored(store = true) {
    fixture = await claudeFixture()
    const spec: SpawnSpec = { ...SPEC, cwd: fixture.project, env: { ...fixture.env } }
    return harness(undefined, spec, store)
  }

  it('without the Host’s leave, advertises no list, load or delete, forks nothing and reads nothing', async () => {
    const h = await stored(false)
    const init = (await h.wire.request('initialize', {})) as Record<string, any>
    expect(init.agentCapabilities.loadSession).toBe(false)
    expect(init.agentCapabilities.sessionCapabilities).toEqual({ resume: {}, close: {} })
    expect(h.wire.forks).toBeUndefined()
    await expect(h.wire.request('session/list', {})).rejects.toMatchObject({ code: -32601 })
    await expect(h.wire.request('session/delete', { sessionId: S1 })).rejects.toMatchObject({ code: -32601 })
    await expect(h.wire.request('_latch/session/fork', { sessionId: S1, cwd: '/w', through: S1 })).rejects.toThrow(/不能读写/u)
    // A session's start reads no settings either: the menu is the full one.
    await writeFile(join(fixture!.config, 'settings.json'), JSON.stringify({ permissions: { disableBypassPermissionsMode: 'disable' } }))
    const opened = (await h.wire.request('session/new', { cwd: fixture!.project, mcpServers: [] })) as { configOptions: any[] }
    expect(opened.configOptions[0].options.map((item: { value: string }) => item.value)).toContain('bypassPermissions')
  })

  it('deletes a session’s transcript without starting claude', async () => {
    const h = await stored()
    const init = (await h.wire.request('initialize', {})) as Record<string, any>
    expect(init.agentCapabilities).toMatchObject({ loadSession: true, sessionCapabilities: { list: {}, delete: {} } })
    expect(h.wire.forks).toBe(true)
    const file = await fixture!.write(S1, [line(S1, fixture!.project, 'sdk-ts')(prompt(uuidOf(1), null, 'hi'))])
    await h.wire.request('session/delete', { sessionId: S1 })
    expect(existsSync(file)).toBe(false)
    expect(h.queries).toHaveLength(0)
    // Gone already: nothing to say.
    await expect(h.wire.request('session/delete', { sessionId: S1 })).resolves.toEqual({})
  })

  it('marks each turn with Latch’s own message ID, once', async () => {
    const h = await stored()
    const { sessionId } = (await h.wire.request('session/new', { cwd: fixture!.project, mcpServers: [] })) as { sessionId: string }
    const q = h.queries[0]!
    void h.wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] }, undefined, undefined, undefined, {
      messageId: LATCH_MESSAGE,
    })
    await tick()
    expect(q.prompts[0]!.uuid).toBe(LATCH_MESSAGE)
    q.out.push({ type: 'result', subtype: 'success', user_message_uuid: LATCH_MESSAGE, stop_reason: 'end_turn', usage: {} })
    await tick()
    await tick()
    void h.wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'again' }] }, undefined, undefined, undefined, {
      messageId: LATCH_MESSAGE,
    })
    await tick()
    expect(q.prompts[1]!.uuid).not.toBe(LATCH_MESSAGE)
  })

  it('offers no mode Claude’s settings disable and never starts with the flag that allows it; says where rules come from', async () => {
    const h = await stored()
    await writeFile(
      join(fixture!.config, 'settings.json'),
      JSON.stringify({
        permissions: {
          disableBypassPermissionsMode: 'disable',
          disableAutoMode: 'disable',
          defaultMode: 'acceptEdits',
          allow: ['Bash(npm test:*)'],
        },
        maxEffortLevel: 'low',
      }),
    )
    const opened = (await h.wire.request('session/new', { cwd: fixture!.project, mcpServers: [] })) as Record<string, any>
    const options = h.queries[0]!.options
    expect(options.allowDangerouslySkipPermissions).toBe(false)
    // Latch never starts in a wider mode than asking, whatever the settings name.
    expect(options.permissionMode).toBe('default')
    expect(opened.configOptions[0].options.map((item: { value: string }) => item.value)).toEqual(['default', 'acceptEdits', 'plan'])
    // `low` and nothing above it.
    expect(opened.configOptions[2].options.map((item: { value: string }) => item.value)).toEqual(['default', 'low'])
    expect(opened._meta.latch.permissionNotes.join('\n')).toMatch(/Bash\(npm test:\*\)（用户设置）/u)
    expect(opened._meta.latch.permissionNotes.join('\n')).toMatch(/默认模式是 acceptEdits；Latch 仍从「询问」开始/u)
    await expect(
      h.wire.request('session/set_config_option', { sessionId: opened.sessionId, configId: 'mode', value: 'bypassPermissions' }),
    ).rejects.toThrow(/不允许/u)
  })

  it('says a session Claude no longer has is gone, before starting claude for it', async () => {
    const h = await stored()
    await writeFile(join(fixture!.config, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 14 }))
    const refused = (await h.wire
      .request('session/resume', { sessionId: S1, cwd: fixture!.project, mcpServers: [] })
      .catch((error: unknown) => error)) as RpcError
    expect(refused).toBeInstanceOf(RpcError)
    expect(refused.code).toBe(-32002)
    expect((refused.data as { lostReason: string }).lostReason).toMatch(/14 天/u)
    expect(h.queries).toHaveLength(0)
  })

  it('lists Claude’s sessions, replays one and goes on in it; refuses one another claude holds', async () => {
    const h = await stored()
    const l = line(S1, fixture!.project)
    await fixture!.write(S1, [
      l(prompt(uuidOf(1), null, 'from the terminal')),
      l(answer(uuidOf(2), uuidOf(1), 'msg_1', [{ type: 'text', text: 'hello back' }])),
    ])
    const listed = (await h.wire.request('session/list', {})) as { sessions: any[]; nextCursor: unknown }
    expect(listed.sessions).toEqual([expect.objectContaining({ sessionId: S1, cwd: fixture!.project, title: 'from the terminal' })])
    expect(listed.nextCursor).toBeNull()
    const loaded = (await h.wire.request('session/load', { sessionId: S1, cwd: fixture!.project, mcpServers: [] })) as { sessionId: string }
    expect(loaded.sessionId).toBe(S1)
    const replay = h.sent.filter(item => item.sessionId === S1 && item.update).map(item => item.update!.sessionUpdate)
    expect(replay).toEqual(['user_message_chunk', 'agent_message_chunk', 'available_commands_update'])
    // The original session goes on, as `/resume` would.
    expect(h.queries[0]!.options.resume).toBe(S1)
    await h.wire.request('session/close', { sessionId: S1 })
    const registry = join(fixture!.config, 'sessions')
    await mkdir(registry, { recursive: true })
    await writeFile(join(registry, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: S1 }))
    await expect(h.wire.request('session/load', { sessionId: S1, cwd: fixture!.project, mcpServers: [] })).rejects.toThrow(/busy/u)
  })

  it('forks Claude’s own record at the turn Latch’s message opened, and refuses where the transcript does not have it', async () => {
    const h = await stored()
    const source = '55555555-5555-4555-8555-555555555555'
    const second = '66666666-6666-4666-8666-666666666666'
    const l = line(source, fixture!.project, 'sdk-ts')
    await fixture!.write(source, [
      l(prompt(LATCH_MESSAGE, null, 'first')),
      l(answer(uuidOf(2), LATCH_MESSAGE, 'msg_1', [{ type: 'text', text: 'one' }])),
      l(prompt(second, uuidOf(2), 'second')),
      l(answer(uuidOf(4), second, 'msg_2', [{ type: 'text', text: 'two' }])),
    ])
    const forked = (await h.wire.request('_latch/session/fork', {
      sessionId: source,
      cwd: fixture!.project,
      before: new Date().toISOString(),
      through: LATCH_MESSAGE,
      mcpServers: [],
    })) as { sessionId: string }
    expect(forked.sessionId).not.toBe(source)
    expect(h.queries[0]!.options.resume).toBe(forked.sessionId)
    const copy = await readFile(join(fixture!.projectDir, `${forked.sessionId}.jsonl`), 'utf8')
    expect(copy).toContain('"text":"one"')
    expect(copy).not.toContain('"text":"two"')
    await h.wire.request('session/close', { sessionId: forked.sessionId })
    await expect(
      h.wire.request('_latch/session/fork', { sessionId: source, cwd: fixture!.project, through: uuidOf(77), mcpServers: [] }),
    ).rejects.toBeInstanceOf(ForkRefused)
  })

  it('settles a cancelled turn whose result came once Claude says it is idle, and ends no turn on an idle alone', async () => {
    const h = await stored()
    const { sessionId } = (await h.wire.request('session/new', { cwd: fixture!.project, mcpServers: [] })) as { sessionId: string }
    const q = h.queries[0]!
    const answered = h.wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] })
    let settled: unknown
    void answered.then(value => (settled = value))
    await tick()
    // An idle owed to an earlier result: the turn goes on.
    q.out.push({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(settled).toBeUndefined()
    h.wire.notify('session/cancel', { sessionId })
    q.out.push({ type: 'result', subtype: 'success', user_message_uuid: q.prompts[0]!.uuid, stop_reason: 'end_turn', usage: {} })
    await tick()
    expect(settled).toBeUndefined()
    // The interrupt is not acknowledged yet; Claude says the turn is over.
    q.out.push({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    await vi.waitFor(() => expect(settled).toMatchObject({ stopReason: 'cancelled' }))
  })

  it('asks Claude for its limits on the session’s process, told to skip its scan, and reads only the shape it knows', async () => {
    const h = harness()
    const { sessionId } = (await h.wire.request('session/new', { cwd: '/work', mcpServers: [] })) as { sessionId: string }
    // A Claude without the experimental request: nothing is said.
    await expect(h.wire.request('_latch/quota/read', {})).rejects.toMatchObject({ code: -32601 })
    let asked: unknown
    Object.assign(h.queries[0]!, {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (options: unknown) => {
        asked = options
        return {
          subscription_type: 'max',
          rate_limits_available: true,
          rate_limits: { five_hour: { utilization: 42, resets_at: new Date(Date.now() + 3_600_000).toISOString() }, seven_day: null },
        }
      },
    })
    const answer = await h.wire.request('_latch/quota/read', { sessionId })
    expect(asked).toEqual({ skipBehaviors: true })
    const report = claudeUsageRead(answer, Date.now())
    expect(report).toMatchObject({ windows: [{ kind: 'five-hour', usedPercent: 42 }], plan: 'max' })
    // Claude says plan limits do not apply (an API key): nothing to report, which is not a failure.
    expect(claudeUsageRead({ rate_limits_available: false, rate_limits: null }, Date.now())).toBeNull()
    // Limits said to apply, with no window figure Latch knows: nothing to show either.
    expect(claudeUsageRead({ rate_limits_available: true, rate_limits: null }, Date.now())).toBeNull()
    expect(
      claudeUsageRead({ rate_limits_available: true, rate_limits: { five_hour: null, seven_day: { utilization: null } } }, Date.now()),
    ).toBeNull()
    expect(claudeUsageRead({ something: 'else' }, Date.now())).toBeUndefined()
  })

  it('asks for its limits with no session open on one opened just to ask: saved nowhere, no hooks or MCP, then closed', async () => {
    const h = harness()
    const asked: unknown[] = []
    const proto = FakeQuery.prototype as unknown as Record<string, unknown>
    proto.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = async (options: unknown) => {
      asked.push(options)
      return { subscription_type: 'pro', rate_limits_available: true, rate_limits: { seven_day: { utilization: 7, resets_at: null } } }
    }
    try {
      const answer = await h.wire.request('_latch/quota/read', {})
      expect(claudeUsageRead(answer, Date.now())).toMatchObject({ windows: [{ kind: 'weekly', usedPercent: 7 }], plan: 'pro' })
      expect(asked).toEqual([{ skipBehaviors: true }])
      const q = h.queries[0]!
      expect(q.options).toMatchObject({ cwd: SPEC.cwd, persistSession: false, strictMcpConfig: true, mcpServers: {} })
      expect(q.options.settings).toEqual({ disableAllHooks: true })
      expect(q.closed).toBe(true)
      // A session opened afterwards is an ordinary one: saved, with the person's hooks and MCP servers.
      await h.wire.request('session/new', { cwd: '/work', mcpServers: [] })
      expect(h.queries[1]!.options).not.toHaveProperty('persistSession')
      expect(h.queries[1]!.options).not.toHaveProperty('strictMcpConfig')
      expect(h.queries[1]!.options).not.toHaveProperty('settings')
    } finally {
      delete proto.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
    }
  })

  it('reports Claude’s own MCP servers once the session has a turn, not those Latch gave it', async () => {
    const h = harness()
    const { sessionId } = (await h.wire.request('session/new', {
      cwd: '/work',
      mcpServers: [{ name: 'latch-skills', command: '/usr/bin/node', args: [], env: [] }],
    })) as { sessionId: string }
    Object.assign(h.queries[0]!, {
      mcpServerStatus: async () => [
        { name: 'latch-skills', status: 'connected', scope: 'dynamic', tools: [{}] },
        { name: 'github', status: 'needs-auth', scope: 'user' },
        { name: 'docs', status: 'connected', scope: 'project', tools: [{}, {}] },
      ],
    })
    void h.wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] })
    await vi.waitFor(() => expect(updates(h, '_latch_mcp_status')).toHaveLength(1))
    expect(updates(h, '_latch_mcp_status')[0]!.servers).toEqual([
      { name: 'github', state: 'needs-login', origin: 'user' },
      { name: 'docs', state: 'ready', tools: 2, origin: 'project' },
    ])
  })

  it('warns before the first turn of what in Claude’s settings may keep Latch’s model service from working', () => {
    const settings = { disableBypass: false, disableAuto: false, allow: [], hooks: false, managed: true }
    const route = { model: 'svc-model', models: ['svc-model'], modelCapabilities: {}, setThinking: () => {} } as never
    expect(routeWarnings({ ...settings, managedKeyHelper: true, managedModels: ['opus'] }, route)).toEqual([
      expect.stringMatching(/密钥脚本/u),
      expect.stringMatching(/svc-model 不在其中/u),
    ])
    expect(routeWarnings({ ...settings, managedModels: ['svc-model'] }, route)).toEqual([])
    // On Claude's own login, its own endpoint is where the session's requests go.
    expect(routeWarnings({ ...settings, ownEndpoint: true }, undefined)).toEqual([expect.stringMatching(/ANTHROPIC_BASE_URL/u)])
    expect(routeWarnings(undefined, route)).toEqual([])
  })

  it('reports per-model effort options up front and truncates oversized command descriptions within protocol bounds', async () => {
    const h = harness()
    const proto = FakeQuery.prototype as unknown as { initializationResult: () => Promise<unknown> }
    const original = proto.initializationResult
    proto.initializationResult = async () => ({
      models: [...MODELS, { value: 'haiku', displayName: 'Haiku', resolvedModel: 'claude-haiku-5', supportsEffort: false }],
      commands: [{ name: '/bytedcli', description: `${'命'.repeat(999)}🙂tail`, argumentHint: `${'参'.repeat(499)}🙂tail` }],
      account: { email: 'someone@example.com', organization: 'Org', subscriptionType: 'max', apiProvider: 'firstParty' },
    })
    try {
      const opened = (await h.wire.request('session/new', { cwd: '/work', mcpServers: [] }, 5_000)) as {
        _meta?: {
          latch?: { perModel?: Array<{ model: string; options: Array<{ category?: string; options?: Array<{ value: string }> }> }> }
        }
      }
      expect(opened._meta?.latch?.perModel).toEqual([
        expect.objectContaining({
          model: 'default',
          options: [expect.objectContaining({ category: 'thought_level' })],
        }),
        expect.objectContaining({
          model: 'sonnet',
          options: [expect.objectContaining({ category: 'thought_level' })],
        }),
        { model: 'haiku', options: [] },
      ])
      const reported = updates(h, 'available_commands_update').at(-1)?.availableCommands as Array<{
        name: string
        description?: string
        input?: { hint?: string }
      }>
      expect(reported).toEqual([{ name: 'bytedcli', description: `${'命'.repeat(999)}…`, input: { hint: `${'参'.repeat(499)}…` } }])
    } finally {
      proto.initializationResult = original
    }
  })
})
