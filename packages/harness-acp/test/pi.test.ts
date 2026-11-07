import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { formatTranscript, readReplayStatus, REPLAY_AGENT, replayEnv, type ReplayEntry, type ReplayHeader } from '@latch/testkit'
import { createAcpAgentPlugin, forgetCommandLookups, setCommandSearch, type AgentRecord } from '../src/index.ts'
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
    expect(notes[0]).toContain('pi 发来一个 Latch 看不懂的请求：extension_ui/select')
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
    expect(notes[0]).toContain('pi 压缩上下文失败：Compaction failed: 401 Incorrect API key provided:')
    expect(JSON.stringify(detail)).not.toContain(KEY)
  })
})
