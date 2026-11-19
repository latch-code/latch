import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppError } from '@latch/sdk'
import { createAcpAgentPlugin, forgetCommandLookups, setCommandSearch, type AgentRecord } from '../src/index.ts'
import { selectProfile } from '../src/permission.ts'
import { agentEnvironment } from '../src/environment.ts'
import { ConnectionClosed, type ExitInfo } from '../src/wires/process.ts'
import { RpcError } from '../src/protocol.ts'
import { CursorWire, cursorRunnerArgs, setCursorSdkModule } from '../src/wires/cursor.ts'
import { activate, fakePrograms, openBridge } from './helpers/replay.ts'

const FAKE_SDK = resolve(import.meta.dirname, 'fixtures/fake-cursor-sdk.mjs')
/** Built here so the file holds no key-shaped literal. */
const KEY = ['key', 'f'.repeat(48)].join('_')

const cleanups: Array<() => Promise<void> | void> = []
beforeEach(() => setCursorSdkModule(FAKE_SDK))
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  setCursorSdkModule(undefined)
  setCommandSearch(undefined)
  forgetCommandLookups()
})

async function scratch(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-cursor-sdk-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

async function calls(log: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(log, 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

interface Opened {
  wire: CursorWire
  updates: Array<Record<string, unknown>>
  exits: ExitInfo[]
  log: string
  root: string
  tmp: string
}

async function openWire(key: string | null = KEY, extra: Record<string, string> = {}): Promise<Opened> {
  const root = await scratch()
  const tmp = join(root, 'tmp')
  await mkdir(tmp, { mode: 0o700 })
  const log = join(root, 'calls.jsonl')
  const updates: Array<Record<string, unknown>> = []
  const exits: ExitInfo[] = []
  const wire = CursorWire.spawn(
    {
      command: '/nonexistent/cursor-agent',
      args: ['acp'],
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: root,
        TMPDIR: tmp,
        FAKE_CURSOR_LOG: log,
        ...(key === null ? {} : { CURSOR_API_KEY: key }),
        ...extra,
      },
      maxLineBytes: 4 * 1024 * 1024,
      redact: text => text.split(KEY).join('[redacted]'),
    },
    {
      request: () => Promise.reject(new Error('the runner sends no requests')),
      notification: (_method, params) => void updates.push((params as { update: Record<string, unknown> }).update),
      exit: info => void exits.push(info),
    },
  )
  cleanups.push(() => wire.stop('kill', 0).then(() => undefined))
  return { wire, updates, exits, log, root, tmp }
}

async function session(opened: Opened): Promise<string> {
  await opened.wire.request('initialize', { protocolVersion: 1 }, 10_000)
  const answer = (await opened.wire.request('session/new', { cwd: opened.root, mcpServers: [] }, 10_000)) as { sessionId: string }
  return answer.sessionId
}

describe('Cursor through its official SDK', () => {
  it('opens a session in the strictest mode, with the key handed to every call and the store in the session folder', async () => {
    const opened = await openWire()
    await opened.wire.request('initialize', { protocolVersion: 1 }, 10_000)
    const answer = (await opened.wire.request('session/new', { cwd: opened.root, mcpServers: [] }, 10_000)) as {
      sessionId: string
      configOptions: Array<{ id: string; currentValue: string; options: Array<{ value: string; name: string }> }>
    }
    expect(answer.sessionId).toBe('agent-1')
    const model = answer.configOptions.find(option => option.id === 'model')!
    expect(model.currentValue).toBe('composer-2?thinking=high')
    expect(model.options.map(option => option.value)).toEqual(['composer-2?thinking=high', 'composer-2', 'gpt-5'])
    const mode = answer.configOptions.find(option => option.id === 'mode')!
    expect(mode.currentValue).toBe('read-only')
    expect(mode.options.map(option => option.value)).toEqual(['read-only', 'sandbox', 'full'])
    const made = await calls(opened.log)
    expect(made.find(call => call.call === 'models')).toEqual({ call: 'models', apiKey: KEY })
    expect(made.find(call => call.call === 'create')).toMatchObject({
      apiKey: KEY,
      model: { id: 'composer-2', params: [{ id: 'thinking', value: 'high' }] },
      tools: ['read', 'grep', 'glob', 'ls'],
      mcpServers: null,
      settingSources: ['project'],
      sandbox: false,
      store: join(opened.tmp, 'cursor-sdk-store'),
    })
  })

  it('streams text, thinking and tool calls, and ends the turn with its tokens and the billed cost', async () => {
    const opened = await openWire()
    const sessionId = await session(opened)
    const result = await opened.wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] })
    expect(result).toEqual({
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 2, cachedWriteTokens: 1, thoughtTokens: 3 },
    })
    const kinds = opened.updates.map(update => update.sessionUpdate)
    expect(kinds).toEqual([
      'agent_thought_chunk',
      'agent_message_chunk',
      'agent_message_chunk',
      'tool_call',
      'tool_call_update',
      'tool_call',
      'tool_call_update',
      'agent_message_chunk',
      'usage_update',
    ])
    const text = opened.updates
      .filter(update => update.sessionUpdate === 'agent_message_chunk')
      .map(update => (update.content as { text: string }).text)
    // The whole message the stream also carries is not added to the deltas.
    expect(text.join('')).toBe('HelloDone')
    expect(opened.updates[3]).toMatchObject({
      toolCallId: 'call-1',
      name: 'read',
      kind: 'read',
      status: 'in_progress',
      title: 'read README.md',
    })
    expect(opened.updates[4]).toMatchObject({ toolCallId: 'call-1', status: 'completed' })
    expect(opened.updates[5]).toMatchObject({ toolCallId: 'call-2', kind: 'execute', title: 'shell false' })
    expect(opened.updates[6]).toMatchObject({ toolCallId: 'call-2', status: 'failed' })
    // A tool call between them starts a new reply.
    expect(opened.updates[2]!.messageId).not.toBe(opened.updates[7]!.messageId)
    expect(opened.updates.at(-1)).toEqual({ sessionUpdate: 'usage_update', cost: { amount: 0.025, currency: 'USD' } })
  })

  it('takes whole messages only when the SDK streamed no deltas', async () => {
    const opened = await openWire()
    const sessionId = await session(opened)
    await opened.wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'whole' }] })
    expect(opened.updates.filter(update => update.sessionUpdate === 'agent_message_chunk').map(update => update.content)).toEqual([
      { type: 'text', text: 'Whole reply' },
    ])
  })

  it("reopens the same agent with the mode's tools and sandbox, and has no mode that asks", async () => {
    const opened = await openWire()
    const sessionId = await session(opened)
    const answer = (await opened.wire.request('session/set_config_option', { sessionId, configId: 'mode', value: 'sandbox' }, 10_000)) as {
      configOptions: Array<{ id: string; currentValue: string }>
    }
    expect(answer.configOptions.find(option => option.id === 'mode')!.currentValue).toBe('sandbox')
    expect((await calls(opened.log)).filter(call => call.call === 'resume')).toEqual([
      expect.objectContaining({ agentId: 'agent-1', apiKey: KEY, tools: null, sandbox: true, settingSources: ['project'] }),
    ])
    await opened.wire.request('session/set_config_option', { sessionId, configId: 'model', value: 'gpt-5' }, 10_000)
    await opened.wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'whole' }] })
    expect((await calls(opened.log)).find(call => call.call === 'send')).toMatchObject({ model: { id: 'gpt-5' } })
    // ACP Cursor's 「先问你」 has no counterpart here: refused, never stood in for by a wider mode.
    const refused = opened.wire.request('session/set_config_option', { sessionId, configId: 'mode', value: 'agent' }, 10_000)
    await expect(refused).rejects.toBeInstanceOf(AppError)
    await expect(refused).rejects.toMatchObject({ status: 409, code: 'permission-ask-unavailable' })
  })

  it('stays on the mode it had when the SDK refuses the sandbox', async () => {
    const opened = await openWire(KEY, { FAKE_CURSOR_NO_SANDBOX: '1' })
    const sessionId = await session(opened)
    await expect(
      opened.wire.request('session/set_config_option', { sessionId, configId: 'mode', value: 'sandbox' }, 10_000),
    ).rejects.toMatchObject({ message: 'Sandboxing is not supported on this host' })
    const resumed = (await calls(opened.log)).filter(call => call.call === 'resume')
    expect(resumed.map(call => call.sandbox)).toEqual([true, false])
    expect(resumed[1]).toMatchObject({ tools: ['read', 'grep', 'glob', 'ls'] })
    await expect(opened.wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'whole' }] })).resolves.toMatchObject({
      stopReason: 'end_turn',
    })
  })

  it('resumes an agent by its ID and gives the mode again, and says when Cursor no longer has it', async () => {
    const opened = await openWire()
    await opened.wire.request('initialize', { protocolVersion: 1 }, 10_000)
    const answer = (await opened.wire.request('session/resume', { sessionId: 'agent-7', cwd: opened.root, mcpServers: [] }, 10_000)) as {
      sessionId: string
    }
    expect(answer.sessionId).toBe('agent-7')
    expect((await calls(opened.log)).find(call => call.call === 'resume')).toMatchObject({
      agentId: 'agent-7',
      tools: ['read', 'grep', 'glob', 'ls'],
    })
    const other = await openWire()
    await other.wire.request('initialize', { protocolVersion: 1 }, 10_000)
    await expect(
      other.wire.request('session/resume', { sessionId: 'gone', cwd: other.root, mcpServers: [] }, 10_000),
    ).rejects.toMatchObject({
      message: 'Session not found',
    })
  })

  it('confirms a cancel only once the SDK reports the run cancelled', async () => {
    const opened = await openWire()
    const sessionId = await session(opened)
    const turn = opened.wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'slow' }] })
    await expect.poll(() => opened.updates.some(update => update.sessionUpdate === 'agent_message_chunk')).toBe(true)
    let settled = false
    void turn.then(() => (settled = true))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(settled).toBe(false)
    opened.wire.notify('session/cancel', { sessionId })
    await expect(turn).resolves.toEqual({ stopReason: 'cancelled' })
    expect((await calls(opened.log)).some(call => call.call === 'cancel')).toBe(true)
  })

  it('keeps a stop that arrives before the SDK has started the run, and cancels the run once it has', async () => {
    const opened = await openWire()
    const sessionId = await session(opened)
    const turn = opened.wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'late' }] })
    await expect.poll(async () => (await calls(opened.log)).some(call => call.call === 'send')).toBe(true)
    opened.wire.notify('session/cancel', { sessionId })
    await expect(turn).resolves.toEqual({ stopReason: 'cancelled' })
    expect((await calls(opened.log)).some(call => call.call === 'cancel')).toBe(true)
  })

  it('adds text to a running turn through the SDK', async () => {
    const opened = await openWire()
    const sessionId = await session(opened)
    const turn = opened.wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'slow' }] })
    await expect.poll(() => opened.updates.length).toBeGreaterThan(0)
    await expect(
      opened.wire.request('_session/steering', { sessionId, prompt: [{ type: 'text', text: 'also this' }] }, 10_000),
    ).resolves.toEqual({
      outcome: 'injected',
    })
    opened.wire.notify('session/cancel', { sessionId })
    await turn
    expect((await calls(opened.log)).find(call => call.call === 'steer')).toEqual({ call: 'steer', text: 'also this' })
  })

  it('fails a turn the SDK failed, with the key masked out of its words', async () => {
    const opened = await openWire()
    const sessionId = await session(opened)
    const failed = opened.wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'fail' }] })
    await expect(failed).rejects.toBeInstanceOf(RpcError)
    const error = (await failed.catch((reason: unknown) => reason)) as Error
    expect(error.message).toContain('Unauthorized key [redacted]')
    expect(error.message).not.toContain(KEY)
  })

  it('reports the runner exiting during a turn', async () => {
    const opened = await openWire()
    const sessionId = await session(opened)
    await expect(opened.wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'crash' }] })).rejects.toBeInstanceOf(
      ConnectionClosed,
    )
    expect(opened.exits).toHaveLength(1)
    expect(opened.exits[0]!.code).toBe(7)
    expect(opened.wire.stderrTail()).not.toContain(KEY)
  })

  it('keeps the key out of the arguments, and out of the environment the agent and its tools see', async () => {
    expect(cursorRunnerArgs().join(' ')).not.toContain(KEY)
    expect(cursorRunnerArgs()[0]).toBe('--disable-sigusr1')
    const opened = await openWire()
    const sessionId = await session(opened)
    await opened.wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'env' }] })
    const said = opened.updates.find(update => update.sessionUpdate === 'agent_message_chunk')!.content as { text: string }
    const seen = JSON.parse(said.text) as { names: string[]; key: string | null }
    expect(seen.key).toBeNull()
    expect(seen.names).not.toContain('CURSOR_API_KEY')
    expect(seen.names).toContain('CURSOR_DATA_DIR')
  })

  it('refuses to start without a key, without loading the SDK', async () => {
    const opened = await openWire(null)
    await expect(opened.wire.request('initialize', { protocolVersion: 1 }, 10_000)).rejects.toMatchObject({ code: 'cursor-key-missing' })
    expect(await calls(opened.log)).toEqual([])
  })
})

describe('choosing the Cursor route', () => {
  const definition = (env: Record<string, string>): AgentRecord => ({
    id: 'cursor',
    name: 'Cursor',
    presetId: 'cursor',
    command: 'cursor-agent',
    args: ['acp'],
    env,
    enabled: true,
  })

  it('takes the SDK only with a key and a runner, and keeps cursor-agent acp otherwise', () => {
    expect(selectProfile(definition({ CURSOR_API_KEY: KEY })).profile?.wire).toBe('cursor')
    expect(selectProfile(definition({ CURSOR_API_KEY: ' ' })).profile?.wire).toBeUndefined()
    expect(selectProfile(definition({})).profile?.permission.expectedMode).toBe('agent')
  })

  it('passes the runner no Host variable', async () => {
    const root = await scratch()
    const profile = selectProfile(definition({ CURSOR_API_KEY: KEY })).profile!
    const env = agentEnvironment({
      resolvedCommand: process.execPath,
      profile: profile.permission,
      definitionEnv: { CURSOR_API_KEY: KEY },
      sessionTmpDir: root,
      hostEnv: { HOME: root, PATH: '/usr/bin', LATCH_DATA_DIR: root, NODE_OPTIONS: '--inspect', npm_config_x: '1', SECRET_HOST: 'x' },
      shellEnv: {},
    })
    expect(Object.keys(env).filter(name => /^(?:LATCH_|NODE_OPTIONS|npm_|SECRET_HOST)/u.test(name))).toEqual([])
    expect(env.CURSOR_API_KEY).toBe(KEY)
  })

  it('runs a session on the runner, never cursor-agent, and refuses a mode that would have to ask', async () => {
    const root = await scratch()
    const bin = join(root, 'bin')
    const marks = join(root, 'marks')
    await mkdir(marks)
    await fakePrograms(bin, marks)
    setCommandSearch(() => [bin])
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const tmpRoot = join(root, 'run-tmp')
    await mkdir(tmpRoot, { mode: 0o700 })
    const log = join(root, 'calls.jsonl')
    const record = definition({ CURSOR_API_KEY: KEY, FAKE_CURSOR_LOG: log })
    const driver = await activate(
      createAcpAgentPlugin(record, { stopGraceMs: 300, requestTimeoutMs: 5_000, restartDelayMs: 0, log: () => {} }),
      cleanups,
    )
    expect(driver.permission).toMatchObject({ approvals: 'none' })
    const bridge = await openBridge(driver, { dataDir: join(root, 'data'), workspace, tmpRoot }, cleanups)
    const preview = await bridge.launchPreview!({ cwd: workspace })
    expect(preview.command).toBe(process.execPath)
    expect(preview.args).toEqual(cursorRunnerArgs())
    expect(JSON.stringify(preview)).not.toContain(KEY)
    await expect(
      bridge.createTask({ prompt: 'hi', requestId: 'asks', cwd: workspace, config: [{ configId: 'mode', value: 'agent' }] }),
    ).rejects.toMatchObject({ status: 409, code: 'permission-ask-unavailable' })
    const { sessionId } = await bridge.createTask({ prompt: 'hi', requestId: 'first', cwd: workspace })
    await expect.poll(async () => (await bridge.detail(sessionId)).summary.status, { timeout: 10_000 }).toBe('idle')
    const detail = await bridge.detail(sessionId)
    expect(detail.permission).toMatchObject({ approvals: 'none', expectedMode: 'read-only' })
    expect(JSON.stringify(detail)).not.toContain(KEY)
    expect(JSON.stringify(detail)).toContain('HelloDone'.slice(0, 3))
    expect(await readdir(marks)).toEqual([])
    expect((await calls(log)).find(call => call.call === 'create')).toMatchObject({ apiKey: KEY, tools: ['read', 'grep', 'glob', 'ls'] })

    // The session's model and mode outlive its process: a new one resumes the agent and sets both again.
    await bridge.setConfig!(sessionId, 'model', 'gpt-5')
    await bridge.setConfig!(sessionId, 'mode', 'sandbox')
    await bridge.close()
    const again = await openBridge(driver, { dataDir: join(root, 'data'), workspace, tmpRoot }, cleanups)
    await again.prompt(sessionId, 'whole', 'second')
    await expect.poll(async () => (await again.detail(sessionId)).summary.status, { timeout: 10_000 }).toBe('idle')
    const made = await calls(log)
    const resumed = made.filter(call => call.call === 'resume').at(-1)
    expect(resumed).toMatchObject({ agentId: 'agent-1', apiKey: KEY })
    expect(made.filter(call => call.call === 'send').at(-1)).toMatchObject({
      text: expect.stringContaining('whole'),
      model: { id: 'gpt-5' },
    })
    expect((await again.detail(sessionId)).permission).toMatchObject({ expectedMode: 'sandbox' })
    expect(made.filter(call => call.call === 'resume').at(-1)).toMatchObject({ sandbox: true })
  })
})
