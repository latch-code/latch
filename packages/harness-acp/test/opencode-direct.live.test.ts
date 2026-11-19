import { existsSync, mkdirSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { startFakeModels } from '@latch/testkit'
import { execFileSync } from 'node:child_process'
import { clientCapabilities, PERMISSION_FACTS, RELEASE_CLAIM } from '../src/protocol.ts'
import { opencodeProfile } from '../src/profiles/opencode.ts'
import { openWire } from '../src/wires/index.ts'
import { descendants } from '../src/wires/process.ts'
import type { AgentWire } from '../src/wires/types.ts'

/**
 * The installed OpenCode, both routes on one temporary home and one local fake model: a session `opencode acp` made
 * resumes on the server wire with the same session ID, options and modes, and the server wire's record replays.
 */
const binary = process.env.LATCH_OPENCODE_GATEWAY_BINARY

/** A stdio MCP server that says whether it can see the server's password, and answers just enough to be connected. */
const MCP_STUB = `const fs = require('node:fs')
fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify({ password: Boolean(process.env.OPENCODE_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD) }))
let buffer = ''
process.stdin.on('data', chunk => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    let message
    try { message = JSON.parse(line) } catch { continue }
    if (message.id === undefined) continue
    const result = message.method === 'initialize'
      ? { protocolVersion: (message.params && message.params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } }
      : message.method === 'tools/list' ? { tools: [] } : {}
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
  }
})
`

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Options = Array<{ id: string; currentValue: string; options: Array<{ value: string }> }>

it.skipIf(!binary)(
  'resumes a session opencode acp made on the server wire, with the same IDs and options',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-opencode-direct-wire-')))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const home = join(root, 'home')
    const cwd = join(root, 'workspace')
    for (const path of [home, cwd, join(home, '.config'), join(home, '.local/share'), join(home, '.local/state'), join(home, '.cache')])
      await mkdir(path, { recursive: true })
    const seen = join(root, 'shell-environment.txt')
    const diagnostic = `found=; for name in OPENCODE_PASSWORD OPENCODE_SERVER_PASSWORD; do eval value=\\$$name; [ -n "$value" ] && found="$found$name "; done; printf "[$found]" > ${seen}`
    const mcpOut = join(root, 'mcp-environment.json')
    const mcpStub = join(root, 'mcp-stub.cjs')
    await writeFile(mcpStub, MCP_STUB)
    const upstream = await startFakeModels({
      replyFor: request => {
        if (request.model === 'fake-model-large') return { text: 'Title' }
        const messages = (request.body as { messages?: Array<{ role?: string }> }).messages ?? []
        if (messages.at(-1)?.role === 'tool') return { text: 'direct answer' }
        if (JSON.stringify(request.body).includes('second turn'))
          return { tool: { name: /^(shell|bash)$/u, input: { command: diagnostic, description: 'Check the environment' } } }
        return { text: 'acp answer' }
      },
    })
    cleanups.push(() => upstream.close())
    // Latch's rules, without which the server wire does not start a server.
    const config = {
      ...(JSON.parse(opencodeProfile.permission.defaultEnv.OPENCODE_CONFIG_CONTENT!) as Record<string, unknown>),
      model: 'latch/fake-model',
      small_model: 'latch/fake-model-large',
      providers: {
        latch: {
          name: 'Latch',
          env: ['LMG_TOKEN'],
          package: '@opencode/ai/providers/openai-compatible',
          settings: { baseURL: `${upstream.origin}/v1`, encoding: 'none' },
          models: {
            'fake-model': {
              name: 'fake-model',
              capabilities: { input: ['text'], output: ['text'], reasoning: { supported: true, effort: ['low', 'high'] } },
            },
            'fake-model-large': {
              name: 'fake-model-large',
              capabilities: { input: ['text'], output: ['text'], reasoning: { supported: false } },
            },
          },
        },
      },
    }
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local/share'),
      XDG_STATE_HOME: join(home, '.local/state'),
      XDG_CACHE_HOME: join(home, '.cache'),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      LMG_TOKEN: 'fake-token',
    }
    let processes = 0
    const started = (kind: 'acp' | 'opencode', updates: Array<Record<string, unknown>>): AgentWire => {
      // Each process has its own temporary directory, as the runtime gives one.
      const tmp = join(root, `tmp-${processes++}`)
      mkdirSync(tmp, { mode: 0o700 })
      const wire = openWire(
        kind,
        {
          command: binary!,
          args: kind === 'acp' ? ['acp'] : [],
          cwd,
          env: { ...env, TMPDIR: tmp },
          maxLineBytes: 8 * 1024 * 1024,
          redact: text => text,
        },
        {
          request: async method => (method === 'session/request_permission' ? { outcome: { outcome: 'selected', optionId: 'once' } } : {}),
          notification: (method, params) => {
            if (method === 'session/update') updates.push((params as { update: Record<string, unknown> }).update)
          },
          exit: () => {},
        },
      )
      cleanups.push(async () => void (await wire.stop('kill', 2_000)))
      return wire
    }
    const initialize = { protocolVersion: 1, clientCapabilities: clientCapabilities(true), clientInfo: { name: 'latch', version: '0' } }

    const acpUpdates: Array<Record<string, unknown>> = []
    const acp = started('acp', acpUpdates)
    await acp.request('initialize', initialize, 60_000)
    const made = (await acp.request('session/new', { cwd, mcpServers: [] }, 60_000)) as { sessionId: string; configOptions: Options }
    expect(made.sessionId).toMatch(/^ses/u)
    expect(
      await acp.request('session/prompt', { sessionId: made.sessionId, prompt: [{ type: 'text', text: 'first turn' }] }, 60_000),
    ).toMatchObject({
      stopReason: 'end_turn',
    })
    expect(acpUpdates.some(update => update.sessionUpdate === 'agent_message_chunk' && JSON.stringify(update).includes('acp answer'))).toBe(
      true,
    )
    await acp.stop('stop', 5_000)

    const directUpdates: Array<Record<string, unknown>> = []
    const direct = started('opencode', directUpdates)
    expect(await direct.request('initialize', initialize, 60_000)).toMatchObject({
      agentInfo: { name: 'OpenCode', version: expect.stringMatching(/^2\./u) },
    })
    const probe = { name: 'latch-mcp-probe', command: process.execPath, args: [mcpStub], env: [{ name: 'PROBE_OUT', value: mcpOut }] }
    const resumed = (await direct.request('session/resume', { sessionId: made.sessionId, cwd, mcpServers: [probe] }, 60_000)) as {
      configOptions: Options
    }
    const shape = (options: Options) =>
      options.map(option => [option.id, option.currentValue, option.options.map(item => item.value).sort()])
    expect(shape(resumed.configOptions)).toEqual(shape(made.configOptions))
    expect(
      await direct.request('session/prompt', { sessionId: made.sessionId, prompt: [{ type: 'text', text: 'second turn' }] }),
    ).toMatchObject({
      stopReason: 'end_turn',
      usage: { inputTokens: expect.any(Number) },
    })
    expect(
      directUpdates.some(update => update.sessionUpdate === 'agent_message_chunk' && JSON.stringify(update).includes('direct answer')),
    ).toBe(true)
    // The shell tool's command saw neither name of the server's password: the wire's plugin, with no gateway involved.
    expect(await readFile(seen, 'utf8')).toBe('[]')
    // The MCP server Latch gave the session started, and nothing about it was written into OpenCode's configuration.
    await vi.waitFor(() => expect(existsSync(mcpOut)).toBe(true), { timeout: 20_000 })
    const mcpEnvironment = JSON.parse(await readFile(mcpOut, 'utf8')) as { password: boolean }
    expect(mcpEnvironment.password).toBe(false)
    for (const name of await readdir(join(home, '.config'), { recursive: true })) {
      const path = join(home, '.config', String(name))
      if ((await stat(path)).isFile()) expect(await readFile(path, 'utf8')).not.toContain('latch-mcp-probe')
    }

    // A new session on the server wire offers what a new one on opencode acp offers.
    const fresh = (await direct.request('session/new', { cwd, mcpServers: [] }, 60_000)) as { sessionId: string; configOptions: Options }
    expect(shape(fresh.configOptions)).toEqual(shape(made.configOptions))

    const replayed: Array<Record<string, unknown>> = []
    const reader = started('opencode', replayed)
    await reader.request('initialize', initialize, 60_000)
    await reader.request('session/load', { sessionId: made.sessionId, cwd, mcpServers: [] }, 60_000)
    const said = replayed.map(update => JSON.stringify(update)).join('\n')
    for (const text of ['first turn', 'acp answer', 'second turn', 'direct answer']) expect(said).toContain(text)

    const pids = [...((await descendants(process.pid)) ?? new Map()).keys()]
    await direct.stop('stop', 5_000)
    await reader.stop('stop', 5_000)
    const left = (await descendants(process.pid)) ?? new Map()
    expect(pids.filter(pid => left.has(pid))).toEqual([])
  },
  180_000,
)

/**
 * The server wire alone on a temporary home (`serve --stdio`, never a subcommand that reaches the person's background
 * service), its model a closed loopback port so nothing can answer: a claim a killed run left is let go on resume
 * without a model, and the project's saved 「总是允许」 come with the session. The temporary database is seeded with
 * the system's sqlite3, as a killed run and OpenCode's TUI would leave it.
 */
it.skipIf(!binary || !existsSync('/usr/bin/sqlite3'))(
  'releases a leftover claim on resume and reports the saved allows, through serve --stdio',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-opencode-claim-')))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const home = join(root, 'home')
    const cwd = join(root, 'workspace')
    for (const path of [home, cwd]) await mkdir(path, { recursive: true })
    const config = {
      ...(JSON.parse(opencodeProfile.permission.defaultEnv.OPENCODE_CONFIG_CONTENT!) as Record<string, unknown>),
      enabled_providers: ['latchdead'],
      provider: {
        latchdead: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'x' }, models: { m: {} } },
      },
      model: 'latchdead/m',
      small_model: 'latchdead/m',
    }
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local/share'),
      XDG_STATE_HOME: join(home, '.local/state'),
      XDG_CACHE_HOME: join(home, '.cache'),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    }
    const db = join(home, '.local/share/opencode/opencode.db')
    const sql = (text: string) => execFileSync('/usr/bin/sqlite3', [db, text]).toString().trim()
    let processes = 0
    const started = async (): Promise<AgentWire> => {
      const tmp = join(root, `tmp-${processes++}`)
      mkdirSync(tmp, { mode: 0o700 })
      const wire = openWire(
        'opencode',
        { command: binary!, args: [], cwd, env: { ...env, TMPDIR: tmp }, maxLineBytes: 8 * 1024 * 1024, redact: text => text },
        { request: async () => ({}), notification: () => {}, exit: () => {} },
      )
      cleanups.push(async () => void (await wire.stop('kill', 2_000)))
      await wire.request('initialize', { protocolVersion: 1, clientCapabilities: clientCapabilities(true) }, 60_000)
      return wire
    }
    let wire = await started()
    const { sessionId } = (await wire.request('session/new', { cwd, mcpServers: [] }, 60_000)) as { sessionId: string }
    const stopped = await wire.stop('stop', 5_000)
    // `--stdio` ended with its input.
    expect(stopped.signal).toBeNull()
    const now = Date.now()
    sql(`UPDATE session_v2 SET time_suspended=${now}, time_busy=${now} WHERE id='${sessionId}'`)
    const project = sql(`SELECT project_id FROM session_v2 WHERE id='${sessionId}'`)
    sql(`INSERT INTO permission VALUES ('psv_latch1', '${project}', 'shell', 'git *', ${now}, ${now})`)
    wire = await started()
    const resumed = (await wire.request('session/resume', { sessionId, cwd, mcpServers: [], [RELEASE_CLAIM]: true }, 60_000)) as {
      _meta?: Record<string, unknown>
    }
    expect(resumed._meta?.[PERMISSION_FACTS]).toEqual(['总是允许 · shell git *'])
    await wire.stop('stop', 5_000)
    expect(sql(`SELECT coalesce(time_suspended, 'released') FROM session_v2 WHERE id='${sessionId}'`)).toBe('released')
  },
  120_000,
)
