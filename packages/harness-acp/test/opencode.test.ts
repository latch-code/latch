import http from 'node:http'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '@latch/sdk'
import { RPC, RpcError } from '../src/protocol.ts'
import { opencodeProfile } from '../src/profiles/opencode.ts'
import { openWire } from '../src/wires/index.ts'
import { messageId, opencodeArgs } from '../src/wires/opencode.ts'
import { ConnectionClosed, type ExitInfo } from '../src/wires/process.ts'
import type { AgentWire } from '../src/wires/types.ts'

/**
 * A stand-in for `opencode serve`: the child only reports its pid, arguments and password to the test's own server, which
 * plays OpenCode 2.2.6's API and event stream, then says where it listens as the real one does.
 */
const STUB = `#!/usr/bin/env node
const http = require('node:http')
const port = Number(process.env.FAKE_PORT)
const body = JSON.stringify({ pid: process.pid, argv: process.argv, password: process.env.OPENCODE_PASSWORD, legacy: process.env.OPENCODE_SERVER_PASSWORD, user: process.env.OPENCODE_SERVER_USERNAME, config: process.env.OPENCODE_CONFIG_CONTENT })
const request = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/__register', headers: { 'content-type': 'application/json' } }, response => {
  response.resume()
  response.on('end', () => {
    process.stderr.write('debug: password is ' + process.env.OPENCODE_PASSWORD + '\\n')
    process.stdout.write('server listening on http://127.0.0.1:' + port + '\\n')
  })
})
request.end(body)
setInterval(() => {}, 1000)
`

interface Seen {
  method: string
  path: string
  authorization?: string
  body?: unknown
}

interface Registered {
  pid: number
  argv: string[]
  password?: string
  legacy?: string
  user?: string
  config?: string
}

type Route = (body: unknown, path: string) => { status?: number; body?: unknown } | undefined

const MODELS = [
  {
    id: 'fake-model',
    modelID: 'fake-model',
    providerID: 'latch',
    name: 'fake-model',
    enabled: true,
    variants: [{ id: 'low' }, { id: 'high' }],
    limit: { context: 100000 },
  },
  { id: 'fake-two', modelID: 'fake-two', providerID: 'latch', name: 'fake-two', enabled: true, variants: [], limit: { context: 50000 } },
  { id: 'off', modelID: 'off', providerID: 'other', name: 'Off', enabled: false, variants: [] },
]
const AGENTS = [
  { id: 'build', name: 'Build', mode: 'primary', hidden: false, description: 'The default agent.' },
  { id: 'general', name: 'General', mode: 'subagent', hidden: false },
  { id: 'title', name: 'Title', mode: 'primary', hidden: true },
  { id: 'plan', name: 'Plan', mode: 'primary', hidden: false, description: 'Read-only agent.' },
  { id: 'auto-edit', name: 'auto-edit', mode: 'primary', hidden: false, description: 'x' },
  { id: 'yolo', name: 'yolo', mode: 'primary', hidden: false, description: 'y' },
]

async function startFake(options: { version?: string; wrongPid?: boolean; noApi?: boolean } = {}) {
  const seen: Seen[] = []
  const streams = new Set<http.ServerResponse>()
  const routes = new Map<string, Route>()
  let registered!: (value: Registered) => void
  const child = new Promise<Registered>(resolve => {
    registered = resolve
  })
  let pid = 0
  const sessions = new Map<string, Record<string, unknown>>()
  let password = ''
  const server = http.createServer((request, response) => {
    let text = ''
    request.on('data', chunk => (text += chunk))
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://x')
      const body = text ? (JSON.parse(text) as unknown) : undefined
      const reply = (status: number, value?: unknown) => {
        response.writeHead(status, value === undefined ? {} : { 'content-type': 'application/json' })
        response.end(value === undefined ? undefined : JSON.stringify(value))
      }
      if (url.pathname === '/__register') {
        const info = body as Registered
        pid = info.pid
        password = info.password ?? ''
        registered(info)
        return reply(204)
      }
      seen.push({ method: request.method ?? '', path: `${url.pathname}${url.search}`, authorization: request.headers.authorization, body })
      if (request.headers.authorization !== `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`)
        return reply(401, { _tag: 'UnauthorizedError', message: 'Unauthorized' })
      const key = `${request.method} ${url.pathname}`
      const custom = routes.get(key)?.(body, url.pathname)
      if (custom) return reply(custom.status ?? 200, custom.body)
      if (key === 'GET /api/event') {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({ id: 'evt_0', type: 'server.connected', data: {} })}\n\n`)
        streams.add(response)
        response.on('close', () => streams.delete(response))
        return
      }
      if (options.noApi && url.pathname.startsWith('/api/')) return reply(404, { message: 'Not Found' })
      if (key === 'GET /api/info')
        return reply(200, { version: options.version ?? '2.2.6', pid: options.wrongPid ? pid + 1 : pid, urls: [], paths: { tmp: '/tmp' } })
      if (key === 'GET /api/plugin') return reply(200, { data: [{ id: 'core' }] })
      if (key === 'GET /api/model') return reply(200, { data: MODELS })
      if (key === 'GET /api/model/default') return reply(200, { data: MODELS[0] })
      if (key === 'GET /api/agent') return reply(200, { data: AGENTS })
      if (key === 'GET /api/command') return reply(200, { data: [{ name: 'review', description: 'review changes' }, { name: 'compact' }] })
      if (key === 'GET /api/session/active') return reply(200, { data: {} })
      if (key === 'POST /api/session') {
        const id = `ses_${sessions.size + 1}`
        const location = (body as { location: { directory: string } }).location
        const session = { id, projectID: 'p', cost: 0, tokens: {}, time: { created: 1, updated: 2 }, location }
        sessions.set(id, session)
        return reply(200, { data: session })
      }
      const sessionMatch = /^\/api\/session\/([^/]+)(\/.*)?$/u.exec(url.pathname)
      if (sessionMatch) {
        const session = sessions.get(sessionMatch[1]!)
        if (!session) return reply(404, { _tag: 'SessionNotFoundError', sessionID: sessionMatch[1], message: 'not found' })
        const rest = sessionMatch[2] ?? ''
        if (request.method === 'GET' && rest === '') return reply(200, { data: { ...session, cost: 0.25 } })
        if (rest === '/prompt' || rest === '/compact' || rest === '/synthetic')
          return reply(200, { data: { id: (body as { id?: string }).id ?? 'msg_x', sessionID: session.id, type: 'user' } })
        if (rest === '/interrupt') return reply(200, { interrupted: true })
        if (rest === '/model' || rest === '/agent' || rest === '/command' || rest.endsWith('/reply')) return reply(204)
        if (rest === '/message') return reply(200, { data: [], cursor: {} })
        if (request.method === 'DELETE') return reply(204)
        return reply(204)
      }
      if (request.method === 'PUT' && url.pathname.startsWith('/api/experimental/mcp/')) return reply(200, { data: {} })
      reply(404, { _tag: 'NotFound', message: 'no route' })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    port,
    seen,
    child,
    routes,
    sessions,
    emit(type: string, data: Record<string, unknown>) {
      const line = `data: ${JSON.stringify({ id: `evt_${type}`, type, data })}\n\n`
      for (const stream of streams) stream.write(line)
    },
    dropStreams() {
      for (const stream of streams) stream.destroy()
    },
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

type Fake = Awaited<ReturnType<typeof startFake>>

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function open(fake: Fake, answer?: (method: string, params: unknown) => Promise<unknown>, extraEnv: Record<string, string> = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'latch-opencode-wire-')))
  const tmp = join(cwd, 'tmp')
  await mkdir(tmp, { mode: 0o700 })
  const program = join(cwd, 'opencode-stub')
  await writeFile(program, STUB)
  await chmod(program, 0o755)
  const updates: Array<{ sessionId: string; update: Record<string, unknown> }> = []
  const requests: Array<{ method: string; params: unknown }> = []
  const notes: Array<{ method: string; params: unknown }> = []
  let exit: ExitInfo | undefined
  const wire: AgentWire = openWire(
    'opencode',
    {
      command: program,
      args: [],
      cwd,
      env: {
        PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
        FAKE_PORT: String(fake.port),
        OPENCODE_SERVER_USERNAME: 'someone',
        TMPDIR: tmp,
        ...extraEnv,
      },
      maxLineBytes: 1024 * 1024,
      redact: text => text,
    },
    {
      request: async (method, params) => {
        requests.push({ method, params })
        if (!answer) throw new RpcError(RPC.methodNotFound, 'none')
        return answer(method, params)
      },
      notification: (method, params) => {
        if (method === 'session/update') updates.push(params as (typeof updates)[number])
        else notes.push({ method, params })
      },
      exit: info => {
        exit = info
      },
    },
  )
  cleanups.push(async () => {
    await wire.stop('kill', 1000)
    await rm(cwd, { recursive: true, force: true })
  })
  return { wire, cwd, tmp, updates, requests, notes, exit: () => exit }
}

async function started(answer?: (method: string, params: unknown) => Promise<unknown>) {
  const fake = await startFake()
  cleanups.push(fake.close)
  const opened = await open(fake, answer)
  const init = await opened.wire.request('initialize', { protocolVersion: 1, clientCapabilities: { session: { compaction: {} } } }, 10_000)
  const created = (await opened.wire.request('session/new', { cwd: opened.cwd, mcpServers: [] }, 10_000)) as {
    sessionId: string
    configOptions: Array<{ id: string; currentValue: string; options: Array<{ value: string }> }>
  }
  return { fake, ...opened, init, created }
}

const promptOf = (fake: Fake) => fake.seen.findLast(item => item.path.endsWith('/prompt'))!

describe('OpenCode server wire', () => {
  it('starts the server on a loopback port it picks, with the password only in its environment', async () => {
    const { fake, init, wire } = await started()
    const child = await fake.child
    expect(child.argv.slice(-5)).toEqual(['serve', '--hostname', '127.0.0.1', '--port', '0'])
    expect(child.password).toMatch(/^[\w-]{40,}$/u)
    expect(child.legacy).toBe(child.password)
    expect(child.user).toBeUndefined()
    expect(child.argv.join(' ')).not.toContain(child.password)
    expect(init).toMatchObject({
      protocolVersion: 1,
      agentInfo: { name: 'OpenCode', version: '2.2.6' },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true },
        sessionCapabilities: { resume: {}, list: {}, close: {}, delete: {} },
      },
    })
    // Every request carries the password; none puts it anywhere else.
    expect(fake.seen.length).toBeGreaterThan(3)
    for (const item of fake.seen) {
      expect(item.authorization).toBe(`Basic ${Buffer.from(`opencode:${child.password}`).toString('base64')}`)
      expect(item.path).not.toContain(child.password!)
      expect(JSON.stringify(item.body ?? null)).not.toContain(child.password!)
    }
    await vi.waitFor(() => expect(wire.stderrTail()).toContain('debug: password is'))
    expect(wire.stderrTail()).not.toContain(child.password)
  })

  it('refuses a server older than the one it was checked against, and one another process answers for', async () => {
    const old = await startFake({ version: '2.2.5' })
    cleanups.push(old.close)
    const first = await open(old)
    const refused = await first.wire.request('initialize', { protocolVersion: 1 }, 10_000).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(AppError)
    expect(refused).toMatchObject({ code: 'harness-version-unsupported' })
    expect((refused as Error).message).toContain('opencode acp')
    const other = await startFake({ wrongPid: true })
    cleanups.push(other.close)
    const second = await open(other)
    await expect(second.wire.request('initialize', { protocolVersion: 1 }, 10_000)).rejects.toThrow(/Another program/u)
  })

  it('creates a session in the folder with the ACP route’s options and registers its MCP servers', async () => {
    const fake = await startFake()
    cleanups.push(fake.close)
    const { wire, cwd } = await open(fake)
    await wire.request('initialize', { protocolVersion: 1 }, 10_000)
    const created = (await wire.request(
      'session/new',
      { cwd, mcpServers: [{ name: 'latch-skills', command: '/bin/echo', args: ['x'], env: [{ name: 'A', value: 'b' }] }] },
      10_000,
    )) as { sessionId: string; configOptions: Array<Record<string, unknown>> }
    expect(created.sessionId).toBe('ses_1')
    expect(fake.seen.find(item => item.method === 'POST' && item.path === '/api/session')?.body).toEqual({ location: { directory: cwd } })
    expect(fake.seen.find(item => item.method === 'PUT')).toMatchObject({
      path: `/api/experimental/mcp/latch-skills?location%5Bdirectory%5D=${encodeURIComponent(cwd)}`,
      body: {
        config: {
          type: 'local',
          command: ['/bin/echo', 'x'],
          environment: { A: 'b', OPENCODE_PASSWORD: '', OPENCODE_SERVER_PASSWORD: '' },
        },
      },
    })
    const [model, effort, mode] = created.configOptions
    expect(model).toMatchObject({ id: 'model', category: 'model', currentValue: 'latch/fake-model' })
    expect((model!.options as Array<{ value: string }>).map(option => option.value)).toEqual(['latch/fake-model', 'latch/fake-two'])
    expect(effort).toMatchObject({ id: 'effort', category: 'thought_level', currentValue: 'default' })
    expect((effort!.options as Array<{ value: string }>).map(option => option.value)).toEqual(['low', 'high', 'default'])
    expect(mode).toMatchObject({ id: 'mode', category: 'mode', currentValue: 'build' })
    expect((mode!.options as Array<{ value: string }>).map(option => option.value)).toEqual(['build', 'plan', 'auto-edit', 'yolo'])
  })

  it('streams a reply, its thinking and a tool, and answers with the turn’s usage once the run ends', async () => {
    const { fake, wire, created, updates, cwd } = await started()
    const sessionID = created.sessionId
    const answer = wire.request('session/prompt', {
      sessionId: sessionID,
      prompt: [
        { type: 'text', text: 'Say hello' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'latch-attachment:1', mimeType: 'text/plain', text: 'notes' } },
      ],
    })
    await vi.waitFor(() => expect(promptOf(fake)).toBeDefined())
    const sent = promptOf(fake).body as { id: string; text: string; files: unknown[]; delivery: string }
    expect(sent.id).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/u)
    expect(sent).toMatchObject({
      text: 'Say hello\n[latch-attachment:1]\nnotes',
      files: [{ uri: 'data:image/png;base64,AAAA', name: 'image' }],
      delivery: 'steer',
    })
    let settled = false
    void answer.then(() => (settled = true))
    const m = 'msg_a'
    fake.emit('session.execution.started', { sessionID })
    fake.emit('session.inbox.delivered', { sessionID, inboxID: sent.id })
    fake.emit('session.step.started', { sessionID, assistantMessageID: m })
    fake.emit('session.reasoning.delta', { sessionID, assistantMessageID: m, ordinal: 0, delta: 'thinking' })
    fake.emit('session.text.delta', { sessionID, assistantMessageID: m, ordinal: 0, delta: 'Hello' })
    fake.emit('session.tool.input.started', { sessionID, assistantMessageID: m, id: 'call_1', name: 'shell' })
    fake.emit('session.tool.called', { sessionID, assistantMessageID: m, id: 'call_1', input: { command: 'echo hi', description: 'x' } })
    fake.emit('session.tool.success', {
      sessionID,
      assistantMessageID: m,
      id: 'call_1',
      content: [{ type: 'text', text: 'hi\n' }],
      metadata: { exit: 0 },
    })
    fake.emit('session.step.ended', {
      sessionID,
      finish: 'stop',
      tokens: { input: 60, output: 20, reasoning: 5, cache: { read: 40, write: 2 } },
    })
    await vi.waitFor(() => expect(updates.some(item => item.update.status === 'completed')).toBe(true))
    expect(settled).toBe(false)
    fake.emit('session.execution.succeeded', { sessionID })
    expect(await answer).toEqual({
      stopReason: 'end_turn',
      usage: { inputTokens: 60, outputTokens: 20, totalTokens: 127, thoughtTokens: 5, cachedReadTokens: 40, cachedWriteTokens: 2 },
      _meta: {},
    })
    const kinds = updates.map(item => item.update.sessionUpdate)
    expect(kinds[0]).toBe('available_commands_update')
    expect(updates[0]!.update.availableCommands).toEqual([
      { name: 'review', description: 'review changes' },
      { name: 'compact', description: 'Compact the session' },
    ])
    expect(updates.find(item => item.update.sessionUpdate === 'agent_thought_chunk')?.update).toMatchObject({
      messageId: 'msg_a:reasoning:0',
      content: { type: 'text', text: 'thinking' },
    })
    expect(updates.find(item => item.update.sessionUpdate === 'agent_message_chunk')?.update).toMatchObject({
      messageId: m,
      content: { text: 'Hello' },
    })
    expect(updates.find(item => item.update.sessionUpdate === 'tool_call')?.update).toMatchObject({
      toolCallId: 'call_1',
      name: 'shell',
      kind: 'execute',
      status: 'pending',
    })
    expect(updates.find(item => item.update.status === 'in_progress')?.update).toMatchObject({
      title: 'echo hi',
      rawInput: { command: 'echo hi', cwd },
      locations: [{ path: cwd }],
    })
    expect(updates.find(item => item.update.status === 'completed')?.update).toMatchObject({
      content: [{ type: 'content', content: { type: 'text', text: 'hi\n' } }],
      rawOutput: { metadata: { exit: 0 } },
    })
    expect(updates.at(-1)?.update).toEqual({
      sessionUpdate: 'usage_update',
      used: 127,
      size: 100000,
      cost: { amount: 0.25, currency: 'USD' },
    })
  })

  it('puts a permission request to the person and sends back allow once, always or reject', async () => {
    const decisions = ['once', 'reject', 'always']
    const { fake, wire, created, requests } = await started(async () => ({ outcome: { outcome: 'selected', optionId: decisions.shift() } }))
    const sessionID = created.sessionId
    const answer = wire.request('session/prompt', { sessionId: sessionID, prompt: [{ type: 'text', text: 'run' }] })
    await vi.waitFor(() => expect(promptOf(fake)).toBeDefined())
    fake.emit('session.inbox.delivered', { sessionID, inboxID: (promptOf(fake).body as { id: string }).id })
    fake.emit('session.tool.input.started', { sessionID, id: 'call_1', name: 'shell' })
    fake.emit('session.tool.called', { sessionID, id: 'call_1', input: { command: 'rm x' } })
    for (const id of ['per_1', 'per_2', 'per_3'])
      fake.emit('permission.asked', { id, sessionID, action: 'shell', resources: ['rm x'], source: { type: 'tool', id: 'call_1' } })
    await vi.waitFor(() => expect(fake.seen.filter(item => item.path.includes('/permission/')).length).toBe(3))
    expect(requests[0]).toMatchObject({
      method: 'session/request_permission',
      params: {
        sessionId: sessionID,
        toolCall: { toolCallId: 'call_1', name: 'shell', title: 'rm x', kind: 'execute', rawInput: { command: 'rm x' } },
        options: [
          { optionId: 'once', kind: 'allow_once' },
          { optionId: 'always', kind: 'allow_always' },
          { optionId: 'reject', kind: 'reject_once' },
        ],
      },
    })
    expect(fake.seen.filter(item => item.path.includes('/permission/')).map(item => [item.path, item.body])).toEqual([
      [`/api/session/${sessionID}/permission/per_1/reply`, { decision: 'once' }],
      [`/api/session/${sessionID}/permission/per_2/reply`, { decision: 'reject' }],
      [`/api/session/${sessionID}/permission/per_3/reply`, { decision: 'always' }],
    ])
    fake.emit('session.tool.failed', { sessionID, id: 'call_1', error: { type: 'aborted', message: 'The user declined this tool call' } })
    fake.emit('session.step.failed', { sessionID, error: { type: 'aborted', message: 'Step interrupted' } })
    fake.emit('session.execution.interrupted', { sessionID, reason: 'shutdown' })
    expect(await answer).toMatchObject({ stopReason: 'cancelled' })
  })

  it('confirms a stop only when the server says the run ended, refusing the ask still open', async () => {
    let release!: (value: unknown) => void
    const { fake, wire, created } = await started(() => new Promise(resolve => (release = resolve)))
    const sessionID = created.sessionId
    const answer = wire.request('session/prompt', { sessionId: sessionID, prompt: [{ type: 'text', text: 'slow' }] })
    let settled = false
    void answer.then(() => (settled = true))
    await vi.waitFor(() => expect(promptOf(fake)).toBeDefined())
    fake.emit('session.execution.started', { sessionID })
    fake.emit('session.inbox.delivered', { sessionID, inboxID: (promptOf(fake).body as { id: string }).id })
    fake.emit('permission.asked', { id: 'per_9', sessionID, action: 'shell', resources: ['x'] })
    await vi.waitFor(() => expect(release).toBeDefined())
    wire.notify('session/cancel', { sessionId: sessionID })
    await vi.waitFor(() => expect(fake.seen.some(item => item.path === `/api/session/${sessionID}/interrupt`)).toBe(true))
    expect(fake.seen.find(item => item.path.endsWith('/per_9/reply'))?.body).toEqual({ decision: 'reject' })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(settled).toBe(false)
    // The person's late answer is not sent again.
    release({ outcome: { outcome: 'selected', optionId: 'once' } })
    fake.emit('session.step.failed', { sessionID, error: { type: 'aborted', message: 'Step interrupted' } })
    fake.emit('session.execution.interrupted', { sessionID, reason: 'user' })
    expect(await answer).toMatchObject({ stopReason: 'cancelled' })
    expect(fake.seen.filter(item => item.path.endsWith('/per_9/reply'))).toHaveLength(1)
  })

  it('withdraws a prompt the server has not taken yet when stopped before its run starts', async () => {
    const { fake, wire, created } = await started()
    const sessionID = created.sessionId
    const answer = wire.request('session/prompt', { sessionId: sessionID, prompt: [{ type: 'text', text: 'never' }] })
    await vi.waitFor(() => expect(promptOf(fake)).toBeDefined())
    wire.notify('session/cancel', { sessionId: sessionID })
    expect(await answer).toMatchObject({ stopReason: 'cancelled' })
    const id = (promptOf(fake).body as { id: string }).id
    expect(fake.seen.some(item => item.method === 'DELETE' && item.path === `/api/session/${sessionID}/inbox/${id}`)).toBe(true)
  })

  it('fails a turn with the server’s reason, without the password', async () => {
    const { fake, wire, created } = await started()
    const child = await fake.child
    const sessionID = created.sessionId
    const answer = wire.request('session/prompt', { sessionId: sessionID, prompt: [{ type: 'text', text: 'fail' }] })
    await vi.waitFor(() => expect(promptOf(fake)).toBeDefined())
    fake.emit('session.inbox.delivered', { sessionID, inboxID: (promptOf(fake).body as { id: string }).id })
    fake.emit('session.execution.failed', {
      sessionID,
      error: { type: 'provider.invalid-request', message: `planned refusal ${child.password}` },
    })
    const error = (await answer.catch((caught: unknown) => caught)) as Error
    expect(error.message).toContain('planned refusal')
    expect(error.message).not.toContain(child.password)
    fake.routes.set('POST /api/session/ses_1/model', () => ({ status: 500, body: { message: `broke with ${child.password}` } }))
    const refused = (await wire
      .request('session/set_config_option', { sessionId: sessionID, configId: 'model', value: 'latch/fake-two' }, 5_000)
      .catch((caught: unknown) => caught)) as Error
    expect(refused.message).toContain('OpenCode answered 500')
    expect(refused.message).not.toContain(child.password)
  })

  it('changes the model, its effort and the mode through the server', async () => {
    const { fake, wire, created } = await started()
    const sessionID = created.sessionId
    const changed = (await wire.request(
      'session/set_config_option',
      { sessionId: sessionID, configId: 'effort', value: 'high' },
      5_000,
    )) as {
      configOptions: Array<{ id: string; currentValue: string }>
    }
    expect(changed.configOptions.find(option => option.id === 'effort')?.currentValue).toBe('high')
    await wire.request('session/set_config_option', { sessionId: sessionID, configId: 'mode', value: 'plan' }, 5_000)
    const model = (await wire.request(
      'session/set_config_option',
      { sessionId: sessionID, configId: 'model', value: 'latch/fake-two' },
      5_000,
    )) as {
      configOptions: Array<{ id: string; currentValue: string }>
    }
    expect(model.configOptions.map(option => [option.id, option.currentValue])).toEqual([
      ['model', 'latch/fake-two'],
      ['mode', 'plan'],
    ])
    expect(fake.seen.filter(item => item.path.endsWith('/model') || item.path.endsWith('/agent')).map(item => item.body)).toEqual([
      { model: { providerID: 'latch', id: 'fake-model', variant: 'high' } },
      { agent: 'plan' },
      { model: { providerID: 'latch', id: 'fake-two' } },
    ])
    await expect(
      wire.request('session/set_config_option', { sessionId: sessionID, configId: 'mode', value: 'nope' }, 5_000),
    ).rejects.toThrow(/mode not found/u)
  })

  it('resumes a session by its ID in the same folder and says when the server has none', async () => {
    const { wire, cwd, created } = await started()
    expect(await wire.request('session/resume', { sessionId: created.sessionId, cwd, mcpServers: [] }, 5_000)).toMatchObject({
      configOptions: expect.any(Array),
    })
    const lost = await wire
      .request('session/resume', { sessionId: 'ses_missing', cwd, mcpServers: [] }, 5_000)
      .catch((error: unknown) => error)
    expect(lost).toMatchObject({ code: RPC.notFound })
    await expect(wire.request('session/resume', { sessionId: created.sessionId, cwd: tmpdir(), mcpServers: [] }, 5_000)).rejects.toThrow(
      /does not belong/u,
    )
  })

  it('replays a loaded session’s record as the ACP route does', async () => {
    const { fake, wire, cwd, created, updates } = await started()
    fake.routes.set(`GET /api/session/${created.sessionId}/message`, () => ({
      body: {
        data: [
          { id: 'msg_1', type: 'user', text: 'hi' },
          {
            id: 'msg_2',
            type: 'assistant',
            content: [
              { type: 'reasoning', text: 'hm' },
              { type: 'text', text: 'hello' },
              {
                type: 'tool',
                id: 'call_1',
                name: 'read',
                state: { status: 'completed', input: { path: 'a.txt' }, content: [{ type: 'text', text: 'A' }] },
              },
            ],
          },
        ],
        cursor: {},
      },
    }))
    await wire.request('session/load', { sessionId: created.sessionId, cwd, mcpServers: [] }, 5_000)
    expect(updates.map(item => [item.update.sessionUpdate, item.update.messageId ?? item.update.toolCallId])).toEqual([
      ['user_message_chunk', 'msg_1'],
      ['agent_thought_chunk', 'msg_2:reasoning:0'],
      ['agent_message_chunk', 'msg_2'],
      ['tool_call', 'call_1'],
      ['tool_call_update', 'call_1'],
    ])
    expect(updates.at(-1)?.update).toMatchObject({ status: 'completed', locations: [{ path: join(cwd, 'a.txt') }] })
  })

  it('marks a subagent’s calls and asks as the ACP route does, on the session that started it', async () => {
    const { fake, wire, created, updates, requests } = await started(async () => ({ outcome: { outcome: 'selected', optionId: 'once' } }))
    const sessionID = created.sessionId
    wire.request('session/prompt', { sessionId: sessionID, prompt: [{ type: 'text', text: 'delegate' }] }).catch(() => {})
    await vi.waitFor(() => expect(promptOf(fake)).toBeDefined())
    fake.emit('session.inbox.delivered', { sessionID, inboxID: (promptOf(fake).body as { id: string }).id })
    fake.emit('session.created', { sessionID: 'ses_child', parentID: sessionID, title: 'Explore' })
    fake.emit('session.tool.input.started', { sessionID: 'ses_child', id: 'call_c', name: 'shell' })
    fake.emit('permission.asked', {
      id: 'per_c',
      sessionID: 'ses_child',
      action: 'shell',
      resources: ['ls'],
      source: { type: 'tool', id: 'call_c' },
    })
    await vi.waitFor(() => expect(fake.seen.some(item => item.path === '/api/session/ses_child/permission/per_c/reply')).toBe(true))
    expect(updates.find(item => item.update.sessionUpdate === 'tool_call')?.update).toMatchObject({
      toolCallId: 'ses_child:call_c',
      title: 'Explore: shell',
      _meta: { 'opencode/child-session': { id: 'ses_child', parentID: sessionID, depth: 1, title: 'Explore' } },
    })
    expect(requests[0]?.params).toMatchObject({
      sessionId: sessionID,
      toolCall: { toolCallId: 'ses_child:call_c', _meta: { 'opencode/child-session': { id: 'ses_child' } } },
    })
    expect(opencodeProfile.readProjectedChild!(updates.find(item => item.update.sessionUpdate === 'tool_call')!.update)).toMatchObject({
      child: { sessionId: 'ses_child', parentSessionId: sessionID, title: 'Explore' },
      value: { toolCallId: 'call_c', title: 'shell' },
    })
  })

  it('ends its turn when the server exits, and ends the server when the event stream is lost', async () => {
    const { fake, wire, created, exit } = await started()
    const child = await fake.child
    const answer = wire.request('session/prompt', { sessionId: created.sessionId, prompt: [{ type: 'text', text: 'x' }] })
    await vi.waitFor(() => expect(promptOf(fake)).toBeDefined())
    fake.dropStreams()
    expect(await answer.catch((error: unknown) => error)).toBeInstanceOf(ConnectionClosed)
    await wire.exited
    expect(exit()).toBeDefined()
    expect(() => process.kill(child.pid, 0)).toThrow()
  })

  it('stops the server at once on stop: it does not end with its stdin', async () => {
    const { fake, wire } = await started()
    const child = await fake.child
    const before = Date.now()
    await wire.stop('stop', 5_000)
    expect(Date.now() - before).toBeLessThan(4_000)
    expect(() => process.kill(child.pid, 0)).toThrow()
  })

  it('refuses arguments that would make it another command or listen elsewhere', () => {
    expect(opencodeArgs(['--log-level', 'debug'])).toEqual(['--log-level', 'debug', 'serve', '--hostname', '127.0.0.1', '--port', '0'])
    for (const reserved of ['acp', 'serve', '--port=4096', '--hostname', 'run'])
      expect(() => opencodeArgs([reserved])).toThrow(/由 Latch 设置/u)
    const first = messageId(1795047138527)
    const second = messageId(1795047138527)
    expect(first < second).toBe(true)
    expect(first).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/u)
  })
  it('keeps the password from the commands OpenCode runs with a private plugin, beside the configuration’s own', async () => {
    const fake = await startFake()
    cleanups.push(fake.close)
    const config = JSON.stringify({ permission: { '*': 'ask' }, plugins: ['/elsewhere/own-plugin'] })
    const { wire, tmp } = await open(fake, undefined, { OPENCODE_CONFIG_CONTENT: config })
    await wire.request('initialize', { protocolVersion: 1 }, 10_000)
    const child = await fake.child
    const seen = JSON.parse(child.config!) as { permission: unknown; plugins: string[] }
    const plugin = join(tmp, 'latch-opencode-server')
    expect(seen).toEqual({ permission: { '*': 'ask' }, plugins: ['/elsewhere/own-plugin', plugin] })
    const file = join(plugin, 'index.ts')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    const source = await readFile(file, 'utf8')
    expect(source).toContain("context.shell.hook('create.before'")
    expect(source).toContain('OPENCODE_SERVER_PASSWORD')
    expect(source).not.toContain(child.password!)
    // Without a place for the plugin, or a configuration it can add to, the server does not start.
    const other = await startFake()
    cleanups.push(other.close)
    await expect(open(other, undefined, { OPENCODE_CONFIG_CONTENT: '[1]' })).rejects.toThrow(/OPENCODE_CONFIG_CONTENT/u)
  })

  it('refuses a server without the 2.x API as a version it does not speak', async () => {
    const fake = await startFake({ noApi: true })
    cleanups.push(fake.close)
    const { wire } = await open(fake)
    await expect(wire.request('initialize', { protocolVersion: 1 }, 10_000)).rejects.toMatchObject({ code: 'harness-version-unsupported' })
  })

  it('withdraws a request the server says is no longer asked', async () => {
    const { fake, wire, created, notes } = await started(() => new Promise(() => {}))
    const sessionID = created.sessionId
    wire.request('session/prompt', { sessionId: sessionID, prompt: [{ type: 'text', text: 'x' }] }).catch(() => {})
    await vi.waitFor(() => expect(promptOf(fake)).toBeDefined())
    fake.emit('session.inbox.delivered', { sessionID, inboxID: (promptOf(fake).body as { id: string }).id })
    fake.emit('permission.asked', { id: 'per_x', sessionID, action: 'shell', resources: ['x'] })
    fake.emit('permission.replied', { sessionID, requestID: 'per_x', reply: 'reject' })
    await vi.waitFor(() => expect(notes).toContainEqual({ method: '$/cancel_request', params: { requestId: 'opencode-per_x' } }))
    expect(fake.seen.some(item => item.path.includes('/per_x/reply'))).toBe(false)
  })
})
