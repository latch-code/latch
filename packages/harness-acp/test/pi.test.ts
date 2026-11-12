import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { formatTranscript, readReplayStatus, REPLAY_AGENT, replayEnv, type ReplayEntry, type ReplayHeader } from '@latch/testkit'
import {
  agentProbePreview,
  createAcpAgentPlugin,
  forgetCommandLookups,
  probeAgent,
  setCommandSearch,
  type AgentRecord,
} from '../src/index.ts'
import { forkPlan } from '../src/wires/pi.ts'
import { activate, fakePrograms, openBridge, replayTranscript } from './helpers/replay.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  setCommandSearch(undefined)
  forgetCommandLookups()
})

/** Shaped like a model key, and built here so the file holds none. */
const KEY = ['sk', 'ant', 'api03', 'a'.repeat(40)].join('-')
const FILE = '/home/replay/.pi/agent/sessions/--workspace--/2026-01-01T00-00-00-000Z_1.jsonl'
const MODEL = { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', provider: 'anthropic', reasoning: true, contextWindow: 200000 }
const STATE = { model: MODEL, thinkingLevel: 'medium', isStreaming: false, sessionFile: FILE, sessionId: '1', messageCount: 0 }

const out = (method: string, params?: Record<string, unknown>): ReplayEntry => ({
  type: 'expect_outbound',
  frame: { kind: 'request', method, ...(params ? { params } : {}) },
})
const answer = (method: string, result?: unknown): ReplayEntry => ({
  type: 'emit_inbound',
  frame: { kind: 'response', method, ...(result === undefined ? {} : { result }) },
})
const event = (method: string, params?: Record<string, unknown>): ReplayEntry => ({
  type: 'emit_inbound',
  frame: { kind: 'notification', method, ...(params ? { params } : {}) },
})
/** A pi process starting and opening the session it started with. */
const opened: ReplayEntry[] = [
  out('get_state'),
  answer('get_state', STATE),
  out('clear_queue'),
  answer('clear_queue', { steering: [], followUp: [] }),
  out('get_state'),
  answer('get_state', STATE),
  out('get_available_models'),
  answer('get_available_models', { models: [MODEL] }),
  out('get_available_thinking_levels'),
  answer('get_available_thinking_levels', { levels: ['off', 'low', 'medium', 'high'] }),
]
const stats: ReplayEntry[] = [out('get_session_stats'), answer('get_session_stats', { tokens: { input: 10, output: 2 }, cost: 0.001 })]

async function transcript(scenario: string, steps: ReplayHeader['steps'], entries: ReplayEntry[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'latch-pi-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, `${scenario}.ndjson`)
  const header: ReplayHeader = {
    type: 'transcript_start',
    harness: 'pi',
    protocol: 'pi-rpc',
    version: 1,
    scenario,
    source: 'hand-written',
    agent: { name: 'pi', version: '1.5.0' },
    basis: ['pi 1.5.0 packages/coding-agent/docs/rpc.md'],
    steps,
  }
  await writeFile(path, formatTranscript({ header, entries }))
  return path
}

describe('pi over its own RPC', () => {
  it('refuses a definition whose arguments set what the wire does, and shows the RPC arguments in a launch', async () => {
    const record = (args: string[]): AgentRecord => ({ id: 'pi', name: 'pi', presetId: 'pi', command: 'pi', args, env: {}, enabled: true })
    for (const args of [['--mode', 'json'], ['--mode=json'], ['-p'], ['--no-session'], ['--session', '/tmp/x.jsonl'], ['-c']])
      expect(() => createAcpAgentPlugin(record(args)), args.join(' ')).toThrow(/由 Latch 设置/u)
    expect(() => createAcpAgentPlugin(record(['--model', 'anthropic/claude-sonnet-4-5']))).not.toThrow()

    const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-pi-')))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const bin = join(root, 'bin')
    const marks = join(root, 'marks')
    await mkdir(marks)
    await fakePrograms(bin, marks)
    setCommandSearch(() => [bin])
    const driver = await activate(createAcpAgentPlugin(record([])), cleanups)
    const paths = { dataDir: join(root, 'data'), workspace: root, tmpRoot: join(root, 'tmp') }
    const bridge = await openBridge(driver, paths, cleanups)
    const preview = await bridge.launchPreview!({ cwd: root })
    expect(preview).toMatchObject({ command: join(bin, 'pi'), args: ['--mode', 'rpc'], approvals: 'none', verified: true })
    expect(driver.description).toContain('pi 的 RPC 模式')
    // pi receives the session's folder only, whatever the project holds.
    expect(driver.projectFolders).toBeUndefined()
    // Describing the launch ran nothing: the fake pi leaves a mark when it runs.
    expect(await readdir(marks)).toEqual([])
  })

  it('refuses a pi too old to clear its queue, when a session starts and in a test start', async () => {
    // pi before 0.84.4 answers clear_queue as a command it does not know, and before 0.80.4 never settles a turn.
    const old: ReplayEntry[] = [
      out('get_state'),
      answer('get_state', STATE),
      out('clear_queue'),
      { type: 'emit_inbound', frame: { kind: 'response', method: 'clear_queue', error: 'Unknown command: clear_queue' } },
    ]
    const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-pi-')))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const bin = join(root, 'bin')
    const marks = join(root, 'marks')
    await mkdir(marks)
    await fakePrograms(bin, marks)
    setCommandSearch(() => [bin])
    const record = (path: string, status: string): AgentRecord => ({
      id: 'pi',
      name: 'pi',
      presetId: 'pi',
      command: process.execPath,
      args: [REPLAY_AGENT],
      env: replayEnv({ transcript: path, status, workspace: root }),
      enabled: true,
    })
    const refusal = 'pi 的版本低于 0.84.4（它不认识 clear_queue），已拒绝启动。升级到 0.84.4 或更高版本后再试。'

    const started = join(root, 'started.json')
    const plugin = createAcpAgentPlugin(record(await transcript('old', [], old), started), {
      stopGraceMs: 300,
      requestTimeoutMs: 5_000,
      log: () => {},
    })
    const driver = await activate(plugin, cleanups)
    const bridge = await openBridge(driver, { dataDir: join(root, 'data'), workspace: root, tmpRoot: join(root, 'tmp') }, cleanups)
    const { sessionId } = await bridge.createTask({ prompt: 'hello', requestId: 'old-pi', cwd: root })
    await expect.poll(async () => (await bridge.detail(sessionId)).summary.status, { timeout: 5_000 }).toBe('failed')
    const detail = await bridge.detail(sessionId)
    expect(detail.messages.filter(message => message.role === 'system').map(message => message.text)).toContain(refusal)
    // Nothing was sent past the check: no session, no prompt.
    expect(readReplayStatus(started)).toMatchObject({ cursor: old.length, total: old.length })

    const probed = join(root, 'probed.json')
    const agent = record(await transcript('old-probe', [], old), probed)
    const options = { dataDir: join(root, 'probe-data'), cwd: root }
    const preview = await agentProbePreview(agent, options)
    const result = await probeAgent(agent, { ...options, expectedLaunchHash: preview.launchHash })
    expect(result.status).toBe('failed')
    expect(result.diagnostic).toContain(refusal)
    expect(await readdir(marks)).toEqual([])
  })

  it('reads its lists only when a person asks, in an empty private folder, and sends no prompt', async () => {
    const path = await transcript('catalogue', [], opened)
    const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-pi-')))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const bin = join(root, 'bin')
    const marks = join(root, 'marks')
    await mkdir(marks)
    await fakePrograms(bin, marks)
    setCommandSearch(() => [bin])
    const status = join(root, 'status.json')
    const record: AgentRecord = {
      id: 'pi',
      name: 'pi',
      presetId: 'pi',
      command: process.execPath,
      args: [REPLAY_AGENT],
      env: replayEnv({ transcript: path, status, workspace: root }),
      enabled: true,
    }
    const driver = await activate(createAcpAgentPlugin(record, { stopGraceMs: 300, requestTimeoutMs: 5_000, log: () => {} }), cleanups)
    const bridge = await openBridge(driver, { dataDir: join(root, 'data'), workspace: root, tmpRoot: join(root, 'tmp') }, cleanups)

    // A draft selecting pi starts nothing: pi loads the person's extensions when it starts.
    expect(bridge.catalogueRead!()).toMatchObject({ when: 'request' })
    expect(await bridge.readCatalogue!({ auto: true })).toEqual({ ran: false })
    expect(readReplayStatus(status)).toBeUndefined()

    expect(await bridge.readCatalogue!({ auto: false })).toEqual({ ran: true })
    const played = readReplayStatus(status)!
    expect(played.failure).toBeUndefined()
    expect(played.cursor).toBe(played.total)
    expect(played.starts).toHaveLength(1)
    expect(played.starts[0]!.argv).toEqual(['--mode', 'rpc'])
    expect(played.starts[0]!.cwd.startsWith(join(root, 'tmp', 'catalogue-'))).toBe(true)
    const catalogue = bridge.catalogue!()
    expect(catalogue?.options.find(option => option.category === 'model')?.options.map(option => option.value)).toEqual([
      'anthropic/claude-sonnet-4-5',
    ])
    expect(catalogue?.options.find(option => option.category === 'thought_level')?.currentValue).toBe('medium')
    expect(await readdir(marks)).toEqual([])
  })

  it('says what a pi extension asked that Latch cannot answer, and tells pi it was cancelled', async () => {
    const path = await transcript(
      'dialog',
      [{ step: 'prompt', text: 'Pick one' }, { step: 'settle' }],
      [
        ...opened,
        out('prompt', { message: 'Pick one' }),
        answer('prompt', { disposition: 'started' }),
        event('agent_start'),
        {
          type: 'emit_inbound',
          frame: {
            kind: 'request',
            method: 'extension_ui_request',
            params: { method: 'select', title: 'Which branch?', options: ['main', 'dev'] },
          },
        },
        { type: 'expect_outbound', frame: { kind: 'response', method: 'extension_ui_request', result: { cancelled: true } } },
        event('message_start', { message: { role: 'assistant', content: [] } }),
        event('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'Staying on main.' }], stopReason: 'stop' } }),
        event('agent_end', { messages: [], willRetry: false }),
        event('agent_settled', { aborted: false }),
        ...stats,
      ],
    )
    const { detail, status, marks } = await replayTranscript(path, cleanups)
    expect(status?.failure).toBeUndefined()
    expect(status).toMatchObject({ cursor: status?.total })
    expect(marks).toEqual([])
    expect(detail.summary.status).toBe('idle')
    expect(detail.permission?.notes).toEqual(['pi 执行工具前不请求审批，只有扩展要求确认时才会问你'])
    const notes = detail.messages.filter(message => message.role === 'system').map(message => message.text)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('pi 发来请求 extension_ui/select：Latch 不支持这个请求')
    expect(notes[0]).toContain('Which branch?')
    // The reply came whole at its end, with no pieces before it.
    expect(detail.messages.filter(message => message.role === 'assistant').map(message => message.text)).toEqual(['Staying on main.'])
    expect(detail.usageReport?.cost).toEqual({ amount: 0.001, currency: 'USD' })
  })

  it('says which additions to the turn a stop withdrew before pi read them', async () => {
    const path = await transcript(
      'stop_after_steer',
      [
        { step: 'prompt', text: 'Build it' },
        { step: 'steer', text: 'Also lint', when: 'tool' },
        { step: 'cancel', when: 'tool' },
        { step: 'settle' },
      ],
      [
        ...opened,
        out('prompt', { message: 'Build it' }),
        answer('prompt', { disposition: 'started' }),
        event('agent_start'),
        event('tool_execution_start', { toolCallId: 'call-1', toolName: 'bash', args: { command: 'npm run build' } }),
        out('steer', { message: 'Also lint' }),
        answer('steer', { disposition: 'queued' }),
        out('clear_queue'),
        answer('clear_queue', { steering: ['Also lint'], followUp: [] }),
        out('abort'),
        event('tool_execution_end', {
          toolCallId: 'call-1',
          toolName: 'bash',
          result: { content: [{ type: 'text', text: 'Command aborted' }] },
          isError: true,
        }),
        event('agent_end', { messages: [], willRetry: false }),
        event('agent_settled', { aborted: true }),
        answer('abort'),
        ...stats,
      ],
    )
    const { detail, status } = await replayTranscript(path, cleanups)
    expect(status?.failure).toBeUndefined()
    expect(detail.summary.status).toBe('cancelled')
    expect(detail.messages.find(message => message.role === 'user' && message.steered)?.text).toBe('Also lint')
    const notes = detail.messages.filter(message => message.role === 'system').map(message => message.text)
    expect(notes).toContain('pi 提示：停止前追加的内容还没送到 pi，已撤回\nAlso lint')
  })

  it("fails the turn with pi's own words when the model service refused it, keys left out", async () => {
    const path = await transcript(
      'provider_failure',
      [{ step: 'prompt', text: 'Say hello' }, { step: 'settle' }],
      [
        ...opened,
        out('prompt', { message: 'Say hello' }),
        answer('prompt', { disposition: 'started' }),
        event('agent_start'),
        event('message_start', { message: { role: 'assistant', content: [] } }),
        event('message_end', {
          message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '529 overloaded_error: Overloaded' },
        }),
        event('auto_retry_start', { attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: `401 invalid x-api-key ${KEY}` }),
        event('agent_end', { messages: [], willRetry: false }),
        event('agent_settled', { aborted: false }),
        ...stats,
      ],
    )
    const { detail, status } = await replayTranscript(path, cleanups)
    expect(status?.failure).toBeUndefined()
    expect(detail.summary.status).toBe('failed')
    const notes = detail.messages.filter(message => message.role === 'system').map(message => message.text)
    expect(notes.at(-1)).toBe('pi 返回错误：529 overloaded_error: Overloaded')
    // A service's error that echoes a key reaches the session without it.
    expect(notes[0]).toContain('pi 警告：401 invalid x-api-key')
    expect(notes.join('\n')).not.toContain(KEY)
  })

  it('starts a new pi session in the same process for a new context, on the same model and thinking', async () => {
    const turn = (text: string, reply: string): ReplayEntry[] => [
      out('prompt', { message: text }),
      answer('prompt', { disposition: 'started' }),
      event('agent_start'),
      event('message_start', { message: { role: 'assistant', content: [] } }),
      event('message_update', { assistantMessageEvent: { type: 'text_delta', delta: reply } }),
      event('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: reply }], stopReason: 'stop' } }),
      event('agent_end', { messages: [], willRetry: false }),
      event('agent_settled', { aborted: false }),
      ...stats,
    ]
    const next = FILE.replace('_1.jsonl', '_2.jsonl')
    const path = await transcript(
      'fresh_context',
      [{ step: 'prompt', text: 'First' }, { step: 'settle' }, { step: 'prompt', text: 'Again', fresh: true }, { step: 'settle' }],
      [
        ...opened,
        ...turn('First', 'one'),
        out('new_session'),
        answer('new_session', { cancelled: false }),
        out('get_state'),
        answer('get_state', { ...STATE, sessionFile: next, sessionId: '2' }),
        out('get_available_models'),
        answer('get_available_models', { models: [MODEL] }),
        out('get_available_thinking_levels'),
        answer('get_available_thinking_levels', { levels: ['off', 'low', 'medium', 'high'] }),
        ...turn('Again', 'two'),
      ],
    )
    const { detail, status } = await replayTranscript(path, cleanups)
    expect(status?.failure).toBeUndefined()
    expect(status?.starts).toHaveLength(1)
    expect(detail.messages.filter(message => message.role === 'user').map(message => [message.text, message.freshContext])).toEqual([
      ['First', undefined],
      ['Again', true],
    ])
    expect(detail.messages.filter(message => message.role === 'assistant').map(message => message.thinking)).toEqual(['中', '中'])
  })

  it("stops a /compact with pi's abort, and refuses to add one to a running turn", async () => {
    const first = (text: string, reply: string): ReplayEntry[] => [
      out('prompt', { message: text }),
      answer('prompt', { disposition: 'started' }),
      event('agent_start'),
      event('message_start', { message: { role: 'assistant', content: [] } }),
      event('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: reply }], stopReason: 'stop' } }),
      event('agent_end', { messages: [], willRetry: false }),
      event('agent_settled', { aborted: false }),
      ...stats,
    ]
    const entries: ReplayEntry[] = [
      ...opened,
      ...first('Say hello', 'Hello.'),
      out('compact', { customInstructions: 'Keep the plan' }),
      event('compaction_start', { reason: 'manual' }),
      out('clear_queue'),
      answer('clear_queue', { steering: [], followUp: [] }),
      out('abort'),
      event('compaction_end', { reason: 'manual', aborted: true, willRetry: false }),
      { type: 'emit_inbound', frame: { kind: 'response', method: 'compact', error: 'Compaction cancelled' } },
      answer('abort'),
      ...stats,
    ]
    const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-pi-')))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const bin = join(root, 'bin')
    const marks = join(root, 'marks')
    await mkdir(marks)
    await fakePrograms(bin, marks)
    setCommandSearch(() => [bin])
    const status = join(root, 'status.json')
    const record: AgentRecord = {
      id: 'pi',
      name: 'pi',
      presetId: 'pi',
      command: process.execPath,
      args: [REPLAY_AGENT],
      env: replayEnv({ transcript: await transcript('compact_stop', [], entries), status, workspace: root }),
      enabled: true,
    }
    const driver = await activate(createAcpAgentPlugin(record, { stopGraceMs: 300, requestTimeoutMs: 5_000, log: () => {} }), cleanups)
    const bridge = await openBridge(driver, { dataDir: join(root, 'data'), workspace: root, tmpRoot: join(root, 'tmp') }, cleanups)
    const { sessionId } = await bridge.createTask({ prompt: 'Say hello', requestId: 'first', cwd: root })
    await expect.poll(async () => (await bridge.detail(sessionId)).summary.status, { timeout: 5_000 }).toBe('idle')
    expect((await bridge.detail(sessionId)).commands).toEqual([expect.objectContaining({ name: 'compact', idleOnly: true })])

    await bridge.prompt(sessionId, '/compact  Keep the plan ', 'compact')
    const rows = async () => (await bridge.detail(sessionId)).messages.map(message => `${message.role}:${message.text}`)
    await expect.poll(rows, { timeout: 5_000 }).toContain('system:pi 正在压缩上下文…')
    await expect(bridge.steer!(sessionId, '/compact', 'added')).rejects.toThrow(/没有接受这条追加/u)
    await bridge.cancel(sessionId)
    await expect.poll(async () => (await bridge.detail(sessionId)).summary.status, { timeout: 5_000 }).toBe('cancelled')
    expect((await rows()).slice(2)).toEqual(['user:/compact  Keep the plan ', 'system:pi 已取消压缩上下文'])
    expect(readReplayStatus(status)).toMatchObject({ cursor: entries.length, total: entries.length })
    expect(await readdir(marks)).toEqual([])
  })

  it("says a compaction failed with the model service's words, keys left out", async () => {
    const path = await transcript(
      'compaction_failure',
      [{ step: 'prompt', text: 'Say hello' }, { step: 'settle' }],
      [
        ...opened,
        out('prompt', { message: 'Say hello' }),
        answer('prompt', { disposition: 'started' }),
        event('agent_start'),
        event('message_start', { message: { role: 'assistant', content: [] } }),
        event('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'Hello.' }], stopReason: 'stop' } }),
        event('agent_end', { messages: [], willRetry: false }),
        event('compaction_start', { reason: 'threshold' }),
        event('compaction_end', {
          reason: 'threshold',
          aborted: false,
          willRetry: false,
          errorMessage: `Compaction failed: 401 Incorrect API key provided: ${KEY}`,
        }),
        event('agent_settled', { aborted: false }),
        ...stats,
      ],
    )
    const { detail, status } = await replayTranscript(path, cleanups)
    expect(status?.failure).toBeUndefined()
    expect(detail.summary.status).toBe('idle')
    const notes = detail.messages.filter(message => message.role === 'system').map(message => message.text)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('pi 压缩上下文失败：401 Incorrect API key provided:')
    expect(JSON.stringify(detail)).not.toContain(KEY)
  })

  describe("a fork of a pi session, in pi's own record", () => {
    const T0 = Date.parse('2026-01-01T00:00:00.000Z')
    const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()
    const message = (id: string, parentId: string | null, seconds: number, role: string, text: string) => ({
      type: 'message',
      id,
      parentId,
      timestamp: at(seconds),
      message: { role, content: role === 'user' ? text : [{ type: 'text', text }] },
    })
    /** pi's record of the source: two turns, the second begun a minute after the first. */
    const RECORD = [
      message('u1', null, 0.5, 'user', 'First'),
      message('a1', 'u1', 1, 'assistant', 'one'),
      message('u2', 'a1', 60.5, 'user', 'Second'),
      message('a2', 'u2', 61, 'assistant', 'two'),
    ]
    const SEED = '以下是会话「First」到第 1 轮为止的记录\n<会话记录>…</会话记录>\n\n'
    const START = FILE.replace('_1.jsonl', '_start.jsonl')
    const FORKED = FILE.replace('_1.jsonl', '_fork.jsonl')
    const turn = (text: string, reply: string): ReplayEntry[] => [
      out('prompt', { message: text }),
      answer('prompt', { disposition: 'started' }),
      event('agent_start'),
      event('message_start', { message: { role: 'assistant', content: [] } }),
      event('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: reply }], stopReason: 'stop' } }),
      event('agent_end', { messages: [], willRetry: false }),
      event('agent_settled', { aborted: false }),
      ...stats,
    ]
    const lists: ReplayEntry[] = [
      out('get_available_models'),
      answer('get_available_models', { models: [MODEL] }),
      out('get_available_thinking_levels'),
      answer('get_available_thinking_levels', { levels: ['off', 'low', 'medium', 'high'] }),
    ]
    /** The forking process: started, then what it does to open the fork, then the fork's first turn. */
    const forking = (fork: ReplayEntry[], sent: string): ReplayEntry[] => [
      out('get_state'),
      answer('get_state', { ...STATE, sessionFile: START }),
      out('clear_queue'),
      answer('clear_queue', { steering: [], followUp: [] }),
      ...fork,
      ...turn(sent, 'three'),
    ]
    const switched: ReplayEntry[] = [
      out('switch_session', { sessionPath: FILE }),
      answer('switch_session', { cancelled: false }),
      out('get_entries'),
      answer('get_entries', { entries: RECORD, leafId: 'a2' }),
    ]
    /** After pi could not: off the source onto a new session of its own, which the fork then opens. */
    const left: ReplayEntry[] = [
      out('new_session'),
      answer('new_session', { cancelled: false }),
      out('get_state'),
      answer('get_state', { ...STATE, sessionFile: START }),
      ...lists,
    ]

    /**
     * A pi session of two turns on a clock the test moves, closed, then forked after its first turn by a new process. With
     * `next`, the fork's first turn is stopped before pi opens a session, and `next` is sent as its second.
     */
    async function forkFirstTurn(fork: ReplayEntry[], sent: string, next?: string) {
      const entries: ReplayEntry[] = [
        ...opened,
        ...turn('First', 'one'),
        ...turn('Second', 'two'),
        { type: 'runtime_exit' },
        ...forking(fork, sent),
      ]
      const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-pi-')))
      cleanups.push(() => rm(root, { recursive: true, force: true }))
      const bin = join(root, 'bin')
      const marks = join(root, 'marks')
      await mkdir(marks)
      await fakePrograms(bin, marks)
      setCommandSearch(() => [bin])
      const status = join(root, 'status.json')
      const record: AgentRecord = {
        id: 'pi',
        name: 'pi',
        presetId: 'pi',
        command: process.execPath,
        args: [REPLAY_AGENT],
        env: replayEnv({ transcript: await transcript('fork', [], entries), status, workspace: root }),
        enabled: true,
      }
      const driver = await activate(createAcpAgentPlugin(record, { stopGraceMs: 300, requestTimeoutMs: 5_000, log: () => {} }), cleanups)
      let now = T0
      const open = async () => {
        const bridge = driver.create({
          dataDir: join(root, 'data'),
          workspaceRoot: root,
          tmpRoot: join(root, 'tmp'),
          providerId: 'unused',
          registry: {
            acquire() {
              throw new Error('ACP sessions do not lease Host providers')
            },
          },
          securityEvent: () => {},
          clock: () => now,
        })
        cleanups.push(() => bridge.close())
        await bridge.start()
        return bridge
      }
      const launch = async (bridge: Awaited<ReturnType<typeof open>>) => (await bridge.launchPreview!({ cwd: root })).launchHash
      const settled = async (bridge: Awaited<ReturnType<typeof open>>, sessionId: string) =>
        expect.poll(async () => (await bridge.detail(sessionId)).summary.status, { timeout: 5_000 }).toBe('idle')

      const first = await open()
      const { sessionId: source } = await first.createTask({
        prompt: 'First',
        requestId: 'first',
        cwd: root,
        expectedLaunchHash: await launch(first),
      })
      await settled(first, source)
      now = T0 + 60_000
      await first.prompt(source, 'Second', 'second')
      await settled(first, source)
      const upTo = (await first.detail(source)).messages.find(item => item.role === 'assistant')!.id
      await first.close()

      now = T0 + 120_000
      const second = await open()
      const { sessionId } = await second.createTask({
        prompt: `${SEED}Branch`,
        requestId: 'fork',
        cwd: root,
        fork: { taskId: source, upToMessageId: upTo, prefixLength: SEED.length },
        expectedLaunchHash: await launch(second),
      })
      if (next !== undefined) {
        expect(await second.cancel(sessionId)).toBe(true)
        expect((await second.detail(sessionId)).summary.status).toBe('cancelled')
        await second.prompt(sessionId, next, 'next')
      }
      await settled(second, sessionId)
      expect(readReplayStatus(status)).toMatchObject({ cursor: entries.length, total: entries.length })
      expect(await readdir(marks)).toEqual([])
      return (await second.detail(sessionId)).messages
    }

    it("forks before the first user message of the next turn, and sends the person's words alone", async () => {
      const messages = await forkFirstTurn(
        [
          ...switched,
          out('fork', { entryId: 'u2' }),
          answer('fork', { text: 'Second', cancelled: false }),
          out('get_state'),
          answer('get_state', { ...STATE, sessionFile: FORKED }),
          out('get_entries', { since: 'a1' }),
          answer('get_entries', { entries: [], leafId: 'a1' }),
          out('get_state'),
          answer('get_state', { ...STATE, sessionFile: FORKED }),
          ...lists,
        ],
        'Branch',
      )
      const first = messages.find(item => item.role === 'user')!
      expect(first).toMatchObject({ text: `${SEED}Branch`, nativeFork: true })
      expect(messages.filter(item => item.role === 'system')).toEqual([])
    })

    it('sends the text record when a pi extension cancels the fork, after leaving the source', async () => {
      const messages = await forkFirstTurn(
        [...switched, out('fork', { entryId: 'u2' }), answer('fork', { cancelled: true }), ...left],
        `${SEED}Branch`,
      )
      expect(messages.find(item => item.role === 'user')?.nativeFork).toBeUndefined()
      expect(messages.filter(item => item.role === 'system').map(item => item.text)).toEqual([
        'pi 没有用它自己的记录分叉：它的扩展取消了分叉。这次以文字带上来源会话到这一轮为止的记录。',
      ])
    })

    it('opens a session of its own when the first turn stopped before pi opened one, and says nothing of a fork', async () => {
      // Only the first turn carries the text record; a later one sent with pi's own fork, or with a note that the record
      // came along, would not be what pi got.
      const messages = await forkFirstTurn(
        [out('get_state'), answer('get_state', { ...STATE, sessionFile: START }), ...lists],
        'Next',
        'Next',
      )
      expect(messages.filter(item => item.role === 'user').map(item => [item.text, item.nativeFork])).toEqual([
        [`${SEED}Branch`, undefined],
        ['Next', undefined],
      ])
      expect(messages.filter(item => item.role === 'system')).toEqual([])
    })

    it("sends the text record when the source's session file is gone", async () => {
      // pi opens a file that is not there as an empty session rather than refusing.
      const messages = await forkFirstTurn(
        [
          out('switch_session', { sessionPath: FILE }),
          answer('switch_session', { cancelled: false }),
          out('get_entries'),
          answer('get_entries', { entries: [], leafId: null }),
          ...left,
        ],
        `${SEED}Branch`,
      )
      expect(messages.filter(item => item.role === 'system').map(item => item.text)).toEqual([
        'pi 没有用它自己的记录分叉：找不到来源会话在这一轮之前的记录。这次以文字带上来源会话到这一轮为止的记录。',
      ])
    })

    it('sends the text record when the copy pi made does not end at the turn', async () => {
      const messages = await forkFirstTurn(
        [
          ...switched,
          out('fork', { entryId: 'u2' }),
          answer('fork', { text: 'Second', cancelled: false }),
          out('get_state'),
          answer('get_state', { ...STATE, sessionFile: FORKED }),
          out('get_entries', { since: 'a1' }),
          answer('get_entries', { entries: [RECORD[2]], leafId: 'u2' }),
          ...left,
        ],
        `${SEED}Branch`,
      )
      expect(messages.filter(item => item.role === 'system').map(item => item.text)).toEqual([
        'pi 没有用它自己的记录分叉：分叉出的记录没有停在这一轮。这次以文字带上来源会话到这一轮为止的记录。',
      ])
    })

    it('plans the fork on the branch pi is on, by the time the next turn began', () => {
      const before = at(60)
      expect(forkPlan({ entries: RECORD, leafId: 'a2' }, before)).toEqual({ command: { type: 'fork', entryId: 'u2' }, keep: 'a1' })
      // The latest turn: the whole branch, settings written since then included.
      const setting = { type: 'model_change', id: 'm1', parentId: 'a2', timestamp: at(90), provider: 'openai', modelId: 'gpt-5.5' }
      expect(forkPlan({ entries: [...RECORD, setting], leafId: 'm1' }, at(120))).toEqual({ command: { type: 'clone' }, keep: 'm1' })
      // An abandoned branch is not what the model saw.
      const abandoned = message('x2', 'a1', 30, 'user', 'Abandoned')
      expect(forkPlan({ entries: [...RECORD, abandoned], leafId: 'a2' }, before)).toEqual({
        command: { type: 'fork', entryId: 'u2' },
        keep: 'a1',
      })
      // A /compact begun after the turn wrote no user message, and its summary must not come along.
      const compaction = { type: 'compaction', id: 'c1', parentId: 'a1', timestamp: at(62), summary: 'Summary', firstKeptEntryId: 'a1' }
      const after = { ...RECORD[2], parentId: 'c1', timestamp: at(120.5) }
      expect(forkPlan({ entries: [RECORD[0], RECORD[1], compaction, after], leafId: 'u2' }, before)).toBe(
        '它的记录在这一轮之后还有别的内容，例如压缩',
      )
      expect(forkPlan({ entries: [], leafId: null }, before)).toBe('找不到来源会话在这一轮之前的记录')
      expect(forkPlan({ entries: [{ ...RECORD[0], timestamp: 'later' }], leafId: 'u1' }, before)).toBe('它的会话记录缺少时间')
      expect(forkPlan({ entries: [RECORD[1]], leafId: 'a1' }, before)).toBe('它的会话记录不完整')
      expect(forkPlan({ entries: RECORD, leafId: 'a2' }, 'soon')).toBe('它的会话记录读不懂')
    })
  })
})
