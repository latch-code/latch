import { randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { McpServerView, McpServersResponse, TaskDetail } from '@latch/protocol'
import { maskKnownSecrets, redactKnownSecrets, redactSecrets, setKnownSecrets } from '@latch/core/node-kit'
import { AppError } from '@latch/sdk'
import { FAKE_ACP_AGENT, FAKE_MCP_STDIO, type TestDevice } from '@latch/testkit'
import {
  isConfirmed,
  looksLikePathOrUrl,
  runnerTarget,
  secretRefusal,
  serverEnvironment,
  specHash,
  testServer,
  widens,
  within,
  type McpState,
} from '../src/mcp.ts'
import { middleSlot } from '../src/presence-reason.ts'
import { namedPaths } from '../src/routes/mcp.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const SECRET = 'mcp-secret-value-0123456789'

/** The fake server, copied out of Latch's program directory: 测试 never runs a program from there. */
let SERVER = ''
beforeAll(async () => {
  const folder = await mkdtemp(join(tmpdir(), 'latch-mcp-server-'))
  SERVER = join(folder, 'fake-mcp-stdio.mjs')
  await copyFile(FAKE_MCP_STDIO, SERVER)
})
afterAll(() => rm(join(SERVER, '..'), { recursive: true, force: true }))

async function host(): Promise<{ t: TestHost; desktop: TestDevice; browser: TestDevice }> {
  const t = await startTestHost({ demo: false })
  cleanups.push(() => t.close())
  const desktop = await t.enroll({ listener: 'unix' })
  const browser = await t.enroll({ scopes: ['view', 'run', 'admin'] })
  return { t, desktop, browser }
}

async function audit(t: TestHost): Promise<Array<{ action: string; stepup: string; detail: Record<string, unknown> }>> {
  return (await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
}

async function body(response: Response): Promise<any> {
  const text = await response.text()
  return text ? JSON.parse(text) : undefined
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, attempts = 400): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await read()
    if (done(value)) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('timed out')
}

const settled = (device: TestDevice, sessionId: string) =>
  waitFor(
    () => device.json<TaskDetail>(`tasks/${sessionId}`),
    detail => !['running', 'waiting-approval', 'starting'].includes(detail.summary.status),
  )

const lastText = (detail: TaskDetail) =>
  detail.messages
    .filter(message => message.role === 'assistant')
    .map(message => message.text)
    .at(-1) ?? ''

function definition(name: string, extra: Record<string, unknown> = {}) {
  return {
    requestId: randomUUID(),
    baseRevision: 0,
    name,
    command: process.execPath,
    args: [SERVER],
    env: {},
    secrets: {},
    projectCwd: false,
    scope: { all: true, agents: [], projects: [] },
    ...extra,
  }
}

describe('设置 › MCP: Latch’s own MCP servers', () => {
  it('adds only from this Mac with a confirmation, never returns a secret, and replays a request by its ID', async () => {
    const { t, desktop, browser } = await host()
    expect(await desktop.json<McpServersResponse>('mcp/servers')).toEqual({ revision: 0, servers: [] })
    const input = definition('files', { secrets: { API_TOKEN: SECRET } })
    // Off this Mac: refused before anything is asked.
    expect(await body(await browser.request('mcp/servers', { body: input }))).toMatchObject({ error: 'local-only' })
    // On it, without the confirmation: nothing is saved.
    const asked = await desktop.request('mcp/servers', { body: input })
    expect(asked.status).toBe(403)
    const ticket = (await body(asked)).confirmation
    expect(ticket).toMatchObject({ action: 'mcp.server.apply', title: '添加 MCP 服务器', form: 'mcp.server.apply-runner' })
    // Node runs a script: the sheet names the script after the program.
    // Node runs a script: the sheet names the program by its file name, the script cut in its middle, and a hash of it.
    expect(ticket.reason).toMatch(/^让 Agent 运行 node .*….*stdio\.mjs（[0-9a-f]{4}，MCP「files」）$/u)
    expect(JSON.stringify(ticket)).not.toContain(SECRET)
    expect(ticket.lines).toContainEqual({ label: '秘密变量', value: 'API_TOKEN' })
    expect((await desktop.json<McpServersResponse>('mcp/servers')).servers).toEqual([])
    const before = t.presence.requests.length
    const added = await desktop.confirmedJson<{ server: McpServerView; revision: number }>('mcp/servers', { body: input })
    expect(t.presence.requests).toHaveLength(before + 1)
    expect(added.server).toMatchObject({
      name: 'files',
      command: process.execPath,
      args: [SERVER],
      env: [{ name: 'API_TOKEN', set: true, secret: true }],
      enabled: true,
      scope: { all: true },
    })
    expect(added.revision).toBe(1)
    // Nothing a device reads carries the value: not the answer, the list, the snapshot or the audit log.
    const read = await browser.json<McpServersResponse>('mcp/servers')
    for (const text of [JSON.stringify(added), JSON.stringify(read), JSON.stringify(await browser.json('snapshot'))])
      expect(text).not.toContain(SECRET)
    const records = await audit(t)
    expect(JSON.stringify(records)).not.toContain(SECRET)
    expect(JSON.stringify(records.filter(record => record.action.startsWith('mcp.')))).not.toContain('files')
    expect(records.find(record => record.action === 'mcp.server.added')).toMatchObject({
      stepup: 'lpc-local',
      detail: { serverId: added.server.id, envCount: 1, scope: 'all', projectCwd: false },
    })
    // The value lives in one 0600 file; the definitions file never holds it.
    const directory = join(t.dataDir, 'mcp')
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect((await stat(join(directory, 'secrets.json'))).mode & 0o777).toBe(0o600)
    expect((await stat(join(directory, 'servers.json'))).mode & 0o777).toBe(0o600)
    expect(await readFile(join(directory, 'secrets.json'), 'utf8')).toContain(SECRET)
    expect(await readFile(join(directory, 'servers.json'), 'utf8')).not.toContain(SECRET)
    // In the forms text carries them too: JSON-escaped and URL-encoded.
    const odd = 'p@ss/w"rd-12345'
    setKnownSecrets('test', [odd, 'short'])
    expect(maskKnownSecrets(JSON.stringify({ odd }))).toBe('{"odd":"[redacted]"}')
    expect(maskKnownSecrets(`?k=${encodeURIComponent(odd)}`)).toBe('?k=[redacted]')
    expect(maskKnownSecrets('a short word')).toBe('a short word')
    setKnownSecrets('test', [])
    // Saved values are masked wherever the Host redacts.
    expect(redactKnownSecrets(`token ${SECRET} end`)).toBe('token [redacted] end')
    // Only what the Host sends out: a check for secret shapes in files and text is not changed by saved values.
    expect(redactSecrets(`token ${SECRET} end`)).toBe(`token ${SECRET} end`)
    // The same request again is answered as before, without a second confirmation; its ID with another body is refused.
    const again = await desktop.request('mcp/servers', { body: input })
    expect(again.status).toBe(201)
    expect((await body(again)).server.id).toBe(added.server.id)
    expect(t.presence.requests).toHaveLength(before + 1)
    expect(await body(await desktop.request('mcp/servers', { body: { ...input, name: 'other' } }))).toMatchObject({
      error: 'request-conflict',
    })
  })

  it('refuses unknown fields, reserved variables, Latch’s own names and a command inside a project or the data directory', async () => {
    const { t, desktop } = await host()
    const asked = t.presence.requests.length
    const refused = async (input: Record<string, unknown>) => (await body(await desktop.request('mcp/servers', { body: input }))).error
    expect(await refused({ ...definition('a'), extra: true })).toBe('invalid-input')
    expect(await refused(definition('a', { env: { NODE_OPTIONS: '--inspect' } }))).toBe('invalid-input')
    expect(await refused(definition('a', { env: { PATH: '/tmp' } }))).toBe('invalid-input')
    // A secret may not be what decides which code or files load, and a value that names a path or a place is plain.
    for (const secrets of [{ NODE_PATH: 'abcdefgh' }, { UV_INDEX_URL: 'abcdefgh' }, { PYTHONPATH: 'x' }])
      expect(await refused(definition('a', { secrets }))).toBe('mcp-secret-not-allowed')
    for (const value of ['/usr/local/lib', '~/servers', 'https://registry.example.com', './x'])
      expect(await refused(definition('a', { secrets: { TOKEN: value } }))).toBe('mcp-secret-not-allowed')
    expect(await refused(definition('latch-files'))).toBe('invalid-input')
    expect(await refused(definition('a', { command: 'bin/server' }))).toBe('mcp-command-not-found')
    const script = join(t.workspaceRoot, 'server.sh')
    await writeFile(script, '#!/bin/sh\n')
    await chmod(script, 0o755)
    expect(await refused(definition('a', { command: script }))).toBe('mcp-command-forbidden')
    const inData = join(t.dataDir, 'server.sh')
    await writeFile(inData, '#!/bin/sh\n')
    await chmod(inData, 0o755)
    expect(await refused(definition('a', { command: inData }))).toBe('mcp-command-forbidden')
    // Each was refused before anything was asked.
    expect(t.presence.requests).toHaveLength(asked)
  })

  it('confirms a wider definition only: a secret’s value, 「用在」, tools, 停用 and 移除 ask nothing', async () => {
    const { t, desktop, browser } = await host()
    const added = await desktop.confirmedJson<{ server: McpServerView }>('mcp/servers', {
      body: definition('files', { secrets: { API_TOKEN: SECRET } }),
    })
    const id = added.server.id
    let revision = added.server.revision
    const patch = (device: TestDevice, change: Record<string, unknown>) =>
      device.request(`mcp/servers/${id}`, { method: 'PATCH', body: { requestId: randomUUID(), baseRevision: revision, ...change } })
    const ok = async (response: Response) => {
      expect(response.status).toBe(200)
      revision = (await body(response)).server.revision
    }
    const confirmations = t.presence.requests.length
    await ok(await patch(desktop, { secrets: { API_TOKEN: 'another-secret-value' } }))
    await ok(await patch(desktop, { scope: { all: false, agents: [], projects: ['default'] } }))
    await ok(await patch(desktop, { disabledTools: ['slow'] }))
    await ok(await patch(desktop, { secrets: { API_TOKEN: null } }))
    expect(t.presence.requests).toHaveLength(confirmations)
    // A plain variable is part of what runs: adding, changing or removing one is asked.
    const plain = await patch(desktop, { env: { LOG_LEVEL: 'debug' } })
    expect(plain.status).toBe(403)
    expect((await body(plain)).confirmation.lines).toContainEqual({ label: '环境变量', value: 'LOG_LEVEL=debug' })
    // Another argument, or a new variable, runs something not confirmed: asked again.
    const wider = await patch(desktop, { args: [SERVER, '--wider'] })
    expect(wider.status).toBe(403)
    expect((await body(wider)).confirmation.action).toBe('mcp.server.apply')
    expect((await desktop.json<McpServersResponse>('mcp/servers')).servers[0]!.args).toEqual([SERVER])
    const confirmed = await desktop.confirmed(`mcp/servers/${id}`, {
      method: 'PATCH',
      body: { requestId: randomUUID(), baseRevision: revision, secrets: { NEW_NAME: 'xxxxxxxxxx' } },
    })
    await ok(confirmed)
    expect(t.presence.requests).toHaveLength(confirmations + 3)
    // A stale revision is refused.
    expect(
      await body(
        await desktop.request(`mcp/servers/${id}`, { method: 'PATCH', body: { requestId: randomUUID(), baseRevision: 1, enabled: false } }),
      ),
    ).toMatchObject({ error: 'mcp-changed' })
    // 停用 from any device that manages this Host; anything else only from this Mac.
    expect(await body(await patch(browser, { enabled: true, disabledTools: [] }))).toMatchObject({ error: 'local-only' })
    await ok(await patch(browser, { enabled: false }))
    expect(await body(await patch(browser, { enabled: true }))).toMatchObject({ error: 'local-only' })
    const kinds = (await audit(t))
      .filter(record => record.action === 'mcp.server.changed')
      .map(record => [record.detail.kinds, record.stepup])
    expect(kinds).toEqual([
      [['secret'], 'none'],
      [['scope'], 'none'],
      [['tools'], 'none'],
      [['spec'], 'none'],
      [['spec'], 'lpc-local'],
      [['enabled'], 'none'],
    ])
    expect((await browser.request(`mcp/servers/${id}`, { method: 'DELETE' })).status).toBe(403)
    expect((await desktop.request(`mcp/servers/${id}`, { method: 'DELETE' })).status).toBe(200)
    expect(await desktop.json<McpServersResponse>('mcp/servers')).toMatchObject({ servers: [] })
    expect(await readFile(join(t.dataDir, 'mcp', 'secrets.json'), 'utf8')).not.toContain('another-secret-value')
    expect(t.presence.requests).toHaveLength(confirmations + 3)
  })

  it('runs 测试 once in an empty folder with only the configured variables, and records what it listed', async () => {
    const { t, desktop } = await host()
    const log = join(await mkdtemp(join(tmpdir(), 'latch-mcp-log-')), 'server.log')
    cleanups.push(() => rm(join(log, '..'), { recursive: true, force: true }))
    const added = await desktop.confirmedJson<{ server: McpServerView }>('mcp/servers', {
      body: definition('files', { env: { FAKE_MCP_LOG: log }, secrets: { API_TOKEN: SECRET } }),
    })
    expect(added.server.report).toBeUndefined()
    // Off this Mac it never runs.
    const browser = await t.enroll({ scopes: ['view', 'run', 'admin'] })
    expect(await body(await browser.request(`mcp/servers/${added.server.id}/test`, { body: { requestId: randomUUID() } }))).toMatchObject({
      error: 'local-only',
    })
    const tested = await desktop.json<{ status: string; tools: string[]; server: McpServerView }>(`mcp/servers/${added.server.id}/test`, {
      body: { requestId: randomUUID() },
    })
    expect(tested).toMatchObject({ status: 'ok', tools: ['echo', 'slow', 'env_names', 'where'] })
    expect(tested.server.report).toMatchObject({ status: 'ok', via: 'test', tools: ['echo', 'slow', 'env_names', 'where'] })
    const lines = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    const start = lines.find(line => line.event === 'start')
    expect(start.envNames).toEqual(expect.arrayContaining(['API_TOKEN', 'FAKE_MCP_LOG', 'PATH']))
    expect(start.envNames.filter((name: string) => /^(LATCH_|FAKE_ACP|NODE_OPTIONS|VITEST)/u.test(name))).toEqual([])
    expect(JSON.stringify(lines)).not.toContain(SECRET)
    // An empty folder of its own, gone afterwards; the client's capabilities are not offered.
    await expect(stat(start.cwd)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(lines.find(line => line.method === 'initialize').capabilities).toEqual({})
    expect((await audit(t)).filter(record => record.action === 'mcp.server.test')).toHaveLength(1)
  })

  it('bounds 测试 in time, ends the whole process group, and calls a server that exits or never answers failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-mcp-test-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const log = join(root, 'server.log')
    const launch = (mode: string) => ({
      command: process.execPath,
      args: [SERVER],
      env: serverEnvironment(process.execPath, { FAKE_MCP_MODE: mode, FAKE_MCP_LOG: log }, []),
    })
    const started = Date.now()
    expect(await testServer(launch('silent'), { tmpRoot: root, timeoutMs: 400 })).toEqual({ status: 'failed', reason: 'timeout' })
    expect(Date.now() - started).toBeLessThan(5_000)
    const pid = JSON.parse((await readFile(log, 'utf8')).trim().split('\n')[0]!).pid as number
    await waitFor(
      async () => {
        try {
          process.kill(pid, 0)
          return false
        } catch {
          return true
        }
      },
      gone => gone,
    )
    expect(await testServer(launch('crash'), { tmpRoot: root, timeoutMs: 5_000 })).toEqual({ status: 'failed', reason: 'exited' })
    expect(await testServer(launch('noisy'), { tmpRoot: root, timeoutMs: 5_000 })).toEqual({ status: 'failed', reason: 'output-too-large' })
    expect(await testServer(launch('ask'), { tmpRoot: root, timeoutMs: 5_000 })).toMatchObject({ status: 'ok' })
  })

  it('refuses to add a server while a full-access session waits', async () => {
    const { t, desktop } = await host()
    await desktop.confirmedJson('agents', {
      body: {
        id: 'fake',
        name: 'Fake',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_STATE: join(t.root, 'state.json') },
      },
    })
    const created = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
      body: { prompt: 'delegate stop', requestId: randomUUID(), harnessId: 'fake' },
    })
    const blocked = await waitFor(
      () => desktop.request('mcp/servers', { body: definition('files') }).then(body),
      reply => reply?.error === 'presence-blocked',
    )
    expect(blocked).toMatchObject({ error: 'presence-blocked', blockingTasks: [{ id: created.sessionId }] })
    expect((await desktop.json<McpServersResponse>('mcp/servers')).servers).toEqual([])
  })
})

describe('Latch’s MCP servers in a session, through latch-mcp and the tool gateway', () => {
  it('gives the agent a bridge that starts the server cleanly, records every call first, honours tool switches, and drops a server switched off at the next start', async () => {
    const { t, desktop } = await host()
    const root = await mkdtemp(join(tmpdir(), 'latch-mcp-session-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const log = join(root, 'server.log')
    await desktop.confirmedJson('agents', {
      body: {
        id: 'mcp-agent',
        name: 'MCP Agent',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_MCP: 'dsh', FAKE_ACP_STATE: join(root, 'state.json'), FAKE_ACP_LOG: join(root, 'agent.log') },
      },
    })
    const added = await desktop.confirmedJson<{ server: McpServerView }>('mcp/servers', {
      body: definition('files', { env: { FAKE_MCP_LOG: log }, secrets: { API_TOKEN: SECRET } }),
    })
    const created = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
      body: { prompt: 'mcp files echo {"text":"hi"}', requestId: randomUUID(), harnessId: 'mcp-agent' },
    })
    const { sessionId } = created
    let detail = await settled(desktop, sessionId)
    expect(lastText(detail)).toBe('files.echo: ok: echo: hi')
    // A server that says a secret back: the agent's text and the tool's output reach no device with it.
    await desktop.json(`tasks/${sessionId}/prompt`, {
      body: { requestId: randomUUID(), prompt: `mcp files echo ${JSON.stringify({ text: SECRET })}` },
    })
    detail = await settled(desktop, sessionId)
    expect(lastText(detail)).toBe('files.echo: ok: echo: [redacted]')
    expect(JSON.stringify(detail.messages.filter(message => message.role !== 'user'))).not.toContain(SECRET)

    // The server ran with its own variables only, in an empty folder; the agent's never reached it.
    const lines = async () =>
      (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
    const start = (await lines()).find(line => line.event === 'start')
    expect(start.envNames).toEqual(expect.arrayContaining(['API_TOKEN', 'FAKE_MCP_LOG', 'PATH']))
    expect(start.envNames.filter((name: string) => /^(FAKE_ACP|LATCH_)/u.test(name))).toEqual([])
    expect(start.cwd).not.toBe(t.workspaceRoot)
    // The agent's own record of the server holds no secret: only the bridge's paths.
    const sessionLines = (await readFile(join(root, 'agent.log'), 'utf8')).split('\n').filter(line => line.includes('"session/new"'))
    expect(sessionLines.length).toBeGreaterThan(0)
    expect(sessionLines.join('\n')).not.toContain(SECRET)
    const records = (await audit(t)).filter(record => record.action.startsWith('mcp.tool.')).slice(0, 2)
    expect(records.map(record => [record.action, record.detail.serverId, record.detail.sessionId])).toEqual([
      ['mcp.tool.called', added.server.id, sessionId],
      ['mcp.tool.settled', added.server.id, sessionId],
    ])
    expect(records[1]!.detail).toMatchObject({ result: 'ok', callId: records[0]!.detail.callId })
    // The bridge reported what the server listed.
    await waitFor(
      () => desktop.json<McpServersResponse>('mcp/servers'),
      list => list.servers[0]?.report?.via === 'session',
    )
    // A tool switched off is refused at the next call, and the call is never sent to the server.
    const patched = await desktop.json<{ server: McpServerView }>(`mcp/servers/${added.server.id}`, {
      method: 'PATCH',
      body: { requestId: randomUUID(), baseRevision: added.server.revision, disabledTools: ['echo'] },
    })
    await desktop.json(`tasks/${sessionId}/prompt`, { body: { requestId: randomUUID(), prompt: 'mcp files echo {"text":"again"}' } })
    detail = await settled(desktop, sessionId)
    expect(lastText(detail)).toMatch(/^files\.echo: error: /u)
    expect((await lines()).filter(line => line.method === 'tools/call')).toHaveLength(2)
    // Switched off: the running bridge ends its server, and the next start of the agent does not get it.
    await desktop.json(`mcp/servers/${added.server.id}`, {
      method: 'PATCH',
      body: { requestId: randomUUID(), baseRevision: patched.server.revision, enabled: false },
    })
    await waitFor(lines, entries => entries.some(line => line.event === 'end' || line.event === 'sigterm'))
    const next = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
      body: { prompt: 'mcp files where', requestId: randomUUID(), harnessId: 'mcp-agent' },
    })
    expect(lastText(await settled(desktop, next.sessionId))).toBe('no MCP server files')
  })

  it('starts the session without a server that fails, and says so in the session', async () => {
    const { desktop } = await host()
    const root = await mkdtemp(join(tmpdir(), 'latch-mcp-broken-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    await desktop.confirmedJson('agents', {
      body: {
        id: 'mcp-agent',
        name: 'MCP Agent',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_MCP: 'dsh', FAKE_ACP_STATE: join(root, 'state.json') },
      },
    })
    await desktop.confirmedJson('mcp/servers', { body: definition('broken', { env: { FAKE_MCP_MODE: 'crash' } }) })
    const created = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
      body: { prompt: 'mcp-list broken', requestId: randomUUID(), harnessId: 'mcp-agent' },
    })
    const detail = await settled(desktop, created.sessionId)
    expect(detail.summary.status).toBe('idle')
    expect(lastText(detail)).toBe('broken tools: ')
    expect(detail.messages.some(message => message.role === 'system' && message.text === 'MCP 服务器「broken」没有启动：进程已退出')).toBe(
      true,
    )
    const list = await desktop.json<McpServersResponse>('mcp/servers')
    expect(list.servers[0]!.report).toMatchObject({ status: 'failed', reason: 'exited', via: 'session' })
  })
})

/** Makes the Host's audit log refuse the actions `failing` picks, as a full disk would; everything else is written. */
function failAudit(t: TestHost, failing: (action: string) => boolean) {
  const append = t.host.security.audit.append.bind(t.host.security.audit)
  const spy = vi
    .spyOn(t.host.security.audit, 'append')
    .mockImplementation(event =>
      failing(event.action) ? Promise.reject(new AppError(503, 'audit-unavailable', '审计不可用')) : append(event),
    )
  cleanups.push(() => spy.mockRestore())
  return spy
}

async function mcpAgent(desktop: TestDevice, root: string) {
  await desktop.confirmedJson('agents', {
    body: {
      id: 'mcp-agent',
      name: 'MCP Agent',
      command: process.execPath,
      args: [FAKE_ACP_AGENT],
      env: { FAKE_ACP_MCP: 'dsh', FAKE_ACP_STATE: join(root, 'state.json') },
    },
  })
}

const logLines = async (log: string): Promise<any[]> => {
  try {
    return (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
  } catch {
    return []
  }
}

describe('MCP changes that widen are on record first, on the real Host', () => {
  it('saves nothing when the record of an add, a wider 「用在」 or a tool switched back on cannot be written; narrowing goes ahead', async () => {
    const { t, desktop } = await host()
    const spy = failAudit(t, action => action.startsWith('mcp.'))
    const refused = await desktop.confirmed('mcp/servers', { body: definition('files') })
    expect(refused.status).toBe(503)
    expect((await desktop.json<McpServersResponse>('mcp/servers')).servers).toEqual([])
    spy.mockRestore()
    const { server } = await desktop.confirmedJson<{ server: McpServerView }>('mcp/servers', {
      body: definition('files', { scope: { all: false, agents: [], projects: ['default'] } }),
    })
    const narrowed = await desktop.json<{ server: McpServerView }>(`mcp/servers/${server.id}`, {
      method: 'PATCH',
      body: { requestId: randomUUID(), baseRevision: server.revision, disabledTools: ['slow'] },
    })
    failAudit(t, action => action === 'mcp.server.changed')
    const patch = (change: Record<string, unknown>) =>
      desktop.request(`mcp/servers/${server.id}`, {
        method: 'PATCH',
        body: { requestId: randomUUID(), baseRevision: narrowed.server.revision, ...change },
      })
    expect((await patch({ scope: { all: true, agents: [], projects: [] } })).status).toBe(503)
    expect((await patch({ scope: { all: false, agents: [], projects: ['default', 'other'] } })).status).toBe(503)
    expect((await patch({ disabledTools: [] })).status).toBe(503)
    const kept = (await desktop.json<McpServersResponse>('mcp/servers')).servers[0]!
    expect(kept).toMatchObject({
      scope: { all: false, projects: ['default'] },
      disabledTools: ['slow'],
      revision: narrowed.server.revision,
    })
    // 停用 only narrows: it goes ahead, and says the record is missing.
    const stopped = await patch({ enabled: false })
    expect(stopped.status).toBe(200)
    expect(stopped.headers.get('x-latch-audit')).toBe('failed')
  })

  it('saves nothing when the record of switching on, a new secret value, a new Agent, a wider definition or 测试 cannot be written', async () => {
    const { t, desktop } = await host()
    const { server } = await desktop.confirmedJson<{ server: McpServerView }>('mcp/servers', {
      body: definition('files', { secrets: { API_TOKEN: SECRET }, scope: { all: false, agents: [], projects: ['default'] } }),
    })
    const off = await desktop.json<{ server: McpServerView }>(`mcp/servers/${server.id}`, {
      method: 'PATCH',
      body: { requestId: randomUUID(), baseRevision: server.revision, enabled: false },
    })
    failAudit(t, action => action === 'mcp.server.changed' || action === 'mcp.server.test')
    const patch = (change: Record<string, unknown>) =>
      desktop.confirmed(`mcp/servers/${server.id}`, {
        method: 'PATCH',
        body: { requestId: randomUUID(), baseRevision: off.server.revision, ...change },
      })
    const agentId = `agt_${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`
    for (const change of [
      { enabled: true },
      { secrets: { API_TOKEN: 'another-secret-value' } },
      { secrets: { API_TOKEN: null } },
      { scope: { all: false, agents: [agentId], projects: ['default'] } },
      { args: [SERVER, '--wider'] },
    ])
      expect((await patch(change)).status, JSON.stringify(change)).toBe(503)
    const kept = (await desktop.json<McpServersResponse>('mcp/servers')).servers[0]!
    expect(kept).toMatchObject({ enabled: false, args: [SERVER], scope: { agents: [] }, revision: off.server.revision })
    expect(kept.env).toEqual([{ name: 'API_TOKEN', set: true, secret: true }])
    expect(await readFile(join(t.dataDir, 'mcp', 'secrets.json'), 'utf8')).toContain(SECRET)
    // 测试 runs nothing when its record cannot be written.
    const log = join(await mkdtemp(join(tmpdir(), 'latch-mcp-testlog-')), 'server.log')
    cleanups.push(() => rm(join(log, '..'), { recursive: true, force: true }))
    const second = await desktop.confirmedJson<{ server: McpServerView }>('mcp/servers', {
      body: definition('second', {
        env: { FAKE_MCP_LOG: log },
        baseRevision: (await desktop.json<McpServersResponse>('mcp/servers')).revision,
      }),
    })
    expect((await desktop.request(`mcp/servers/${second.server.id}/test`, { body: { requestId: randomUUID() } })).status).toBe(503)
    expect(await logLines(log)).toEqual([])
  })

  it('starts no server and sends no call whose record cannot be written', async () => {
    const { t, desktop } = await host()
    const root = await mkdtemp(join(tmpdir(), 'latch-mcp-audit-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const log = join(root, 'server.log')
    await mcpAgent(desktop, root)
    await desktop.confirmedJson('mcp/servers', { body: definition('files', { env: { FAKE_MCP_LOG: log } }) })
    const created = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
      body: { prompt: 'mcp files echo {"text":"one"}', requestId: randomUUID(), harnessId: 'mcp-agent' },
    })
    expect(lastText(await settled(desktop, created.sessionId))).toBe('files.echo: ok: echo: one')
    const spy = failAudit(t, action => action === 'mcp.tool.called')
    await desktop.json(`tasks/${created.sessionId}/prompt`, { body: { requestId: randomUUID(), prompt: 'mcp files echo {"text":"two"}' } })
    expect(lastText(await settled(desktop, created.sessionId))).toBe(
      'files.echo: error: Latch could not record this call, so it was not made.',
    )
    expect((await logLines(log)).filter(line => line.method === 'tools/call')).toHaveLength(1)
    spy.mockRestore()
    // A start whose record cannot be written does not start: the session goes on without the server.
    failAudit(t, action => action === 'mcp.server.started')
    const starts = (await logLines(log)).filter(line => line.event === 'start').length
    const next = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
      body: { prompt: 'mcp-list files', requestId: randomUUID(), harnessId: 'mcp-agent' },
    })
    expect(lastText(await settled(desktop, next.sessionId))).toBe('files tools: ')
    expect((await logLines(log)).filter(line => line.event === 'start')).toHaveLength(starts)
  })

  it('records each start and the session’s set of servers, and ends a running server when 「用在」 no longer covers it', async () => {
    const { t, desktop } = await host()
    const root = await mkdtemp(join(tmpdir(), 'latch-mcp-scope-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const log = join(root, 'server.log')
    await mcpAgent(desktop, root)
    const { server } = await desktop.confirmedJson<{ server: McpServerView }>('mcp/servers', {
      body: definition('files', { env: { FAKE_MCP_LOG: log } }),
    })
    const created = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
      body: { prompt: 'mcp files echo {"text":"one"}', requestId: randomUUID(), harnessId: 'mcp-agent' },
    })
    await settled(desktop, created.sessionId)
    const records = await audit(t)
    expect(records.find(record => record.action === 'mcp.server.started')?.detail).toMatchObject({
      serverId: server.id,
      sessionId: created.sessionId,
      specHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })
    expect(records.find(record => record.action === 'task.l3.started')?.detail.mcpSetHash).toMatch(/^[0-9a-f]{64}$/u)
    await desktop.json(`mcp/servers/${server.id}`, {
      method: 'PATCH',
      body: { requestId: randomUUID(), baseRevision: server.revision, scope: { all: false, agents: [], projects: ['elsewhere'] } },
    })
    await waitFor(
      () => logLines(log),
      lines => lines.some(line => line.event === 'end' || line.event === 'sigterm'),
    )
  })

  it('never runs 测试 for a program or a path that is in a project, a worktree, a session or Latch’s data', async () => {
    const { t, desktop } = await host()
    const script = join(t.workspaceRoot, 'server.mjs')
    await writeFile(script, '')
    const add = async (name: string, args: string[], env: Record<string, string> = {}) =>
      (
        await desktop.confirmedJson<{ server: McpServerView }>('mcp/servers', {
          body: definition(name, { args, env, baseRevision: (await desktop.json<McpServersResponse>('mcp/servers')).revision }),
        })
      ).server
    for (const server of [
      await add('in-project', [script]),
      await add('flagged', [`--entry=${script}`]),
      await add('folder', ['${workspaceFolder}/x.mjs']),
      await add('url', [pathToFileURL(script).href]),
      // Latch's own program directory, where the fixture lives.
      await add('program', [FAKE_MCP_STDIO]),
      // A plain variable that names project code (`NODE_OPTIONS` itself is never a server's variable).
      await add('variable', [SERVER], { SERVER_ROOT: t.workspaceRoot }),
    ]) {
      const reply = await desktop.request(`mcp/servers/${server.id}/test`, { body: { requestId: randomUUID() } })
      expect(reply.status).toBe(409)
      expect(await body(reply)).toMatchObject({ error: 'mcp-test-repository' })
    }
    expect((await audit(t)).filter(record => record.action === 'mcp.server.test')).toEqual([])
    // A relative path is read as the program would from 测试's own folder.
    expect(namedPaths(['../escape/x.mjs', 'word', '--flag=./y'], '/tmp/root/test')).toEqual(
      expect.arrayContaining(['/tmp/root/escape/x.mjs', '/tmp/root/test/y']),
    )
    expect(namedPaths(['word'], '/tmp/root/test')).toEqual([])
  })
})

describe('the rules of a definition', () => {
  const state = (change: Partial<McpState> = {}): McpState => ({
    command: '/usr/bin/server',
    args: [],
    env: {},
    secretNames: ['TOKEN'],
    projectCwd: false,
    scope: { all: false, agents: [], projects: ['a'] },
    enabled: true,
    disabledTools: ['x'],
    secretHashes: { TOKEN: 'h1' },
    ...change,
  })
  it('tells what needs the confirmation, what is on record first, and what only narrows', () => {
    expect(widens(state(), state({ args: ['--more'] }))).toBe('spec')
    expect(widens(state(), state({ env: { LEVEL: 'debug' } }))).toBe('spec')
    expect(widens(state({ env: { LEVEL: 'debug' } }), state())).toBe('spec')
    expect(widens(state(), state({ secretNames: ['TOKEN', 'OTHER'] }))).toBe('spec')
    expect(widens(state(), state({ scope: { all: true, agents: [], projects: [] } }))).toBe('use')
    expect(widens(state(), state({ scope: { all: false, agents: [], projects: ['a', 'b'] } }))).toBe('use')
    expect(widens(state(), state({ disabledTools: [] }))).toBe('use')
    expect(widens(state({ enabled: false }), state())).toBe('use')
    expect(widens(state(), state({ secretHashes: { TOKEN: 'h2' } }))).toBe('use')
    expect(widens(state(), state({ scope: { all: false, agents: [], projects: [] }, disabledTools: ['x', 'y'], enabled: false }))).toBe(
      false,
    )
    expect(widens(state(), state({ secretNames: [], secretHashes: {} }))).toBe('use')
  })
  it('keeps loaders, package sources and paths out of secrets, and lets a base64 value starting with a slash be one', () => {
    for (const name of [
      'JDK_JAVA_OPTIONS',
      'PERLLIB',
      'PIPX_HOME',
      'BUN_INSTALL',
      'DENO_DIR',
      'GEM_HOME',
      'SHELLOPTS',
      'PS4',
      'LUA_INIT',
      'GOFLAGS',
      'CLASSPATH',
      'GOPROXY',
      'CARGO_HOME',
      'RUSTFLAGS',
      'npm_config_registry',
    ])
      expect(secretRefusal(name, 'abcdefgh'), name).toBeDefined()
    for (const value of [
      'localhost:8080',
      'proxy.internal:3128/x',
      'data:text/plain,hi',
      'file:///etc/x',
      '/usr/local/lib',
      '/Users/me',
      '~/x',
      'https://a.b',
    ])
      expect(looksLikePathOrUrl(value), value).toBe(true)
    for (const value of ['/aB3+xyz9==', '/QmFzZTY0c2VjcmV0', 'sk-live-123', 'plain words'])
      expect(looksLikePathOrUrl(value), value).toBe(false)
  })

  it('names what a runner or an interpreter runs, and binds a definition to what was confirmed', () => {
    const clear = (target: string) => ({ target, ambiguous: false })
    expect(runnerTarget('/opt/homebrew/bin/npx', ['-y', '@scope/server'])).toEqual(clear('@scope/server'))
    // The package an option names is what runs, not the first word after it.
    expect(runnerTarget('/opt/homebrew/bin/npx', ['--package=evil-pkg', '@scope/server'])).toEqual(clear('evil-pkg'))
    expect(runnerTarget('/opt/homebrew/bin/npx', ['-p', 'evil-pkg', 'server'])).toEqual(clear('evil-pkg'))
    expect(runnerTarget('/usr/local/bin/pnpx', ['--package', 'evil', 'server'])).toEqual(clear('evil'))
    expect(runnerTarget('/usr/local/bin/uvx', ['--from', 'git+https://x/y', 'tool'])).toEqual(clear('git+https://x/y'))
    expect(runnerTarget('/usr/local/bin/uvx', ['--with', 'extra', 'mcp-server-git'])).toEqual(clear('mcp-server-git'))
    expect(runnerTarget('/usr/local/bin/pipx', ['run', '--spec', 'evil', 'tool'])).toEqual(clear('evil'))
    expect(runnerTarget('/usr/bin/python3', ['-m', 'server'])).toEqual(clear('server'))
    expect(runnerTarget('/usr/bin/python3', ['-mserver'])).toEqual(clear('server'))
    expect(runnerTarget('/usr/local/bin/deno', ['run', '-A', 'main.ts'])).toEqual(clear('main.ts'))
    expect(runnerTarget('/usr/local/bin/node', ['--require', 'pre.js', 'main.js'])).toEqual(clear('main.js'))
    expect(runnerTarget('/usr/bin/ruby', ['-rlib', 'main.rb'])).toEqual(clear('main.rb'))
    // Inline code, or an option it does not know: the raw first argument, and the hash.
    expect(runnerTarget('/usr/local/bin/node', ['-e', 'require("x")'])).toEqual({ target: '-e', ambiguous: true })
    expect(runnerTarget('/opt/homebrew/bin/npx', ['--mystery', 'x', 'pkg'])).toEqual({ target: '--mystery', ambiguous: true })
    expect(runnerTarget('/usr/local/bin/server', ['--stdio'])).toBeUndefined()
    expect(middleSlot('evilmodelcontextprotocol/server-github', 32)).not.toBe(middleSlot('@modelcontextprotocol/server-github', 32))
    expect(within('/proj', '/proj/..bin/x')).toBe(true)
    expect(within('/proj', '/project/x')).toBe(false)
    const spec = { command: '/usr/bin/server', args: [], env: {}, secretNames: ['TOKEN'], projectCwd: false }
    const confirmed = { hash: specHash(spec), secretNames: ['TOKEN'] }
    expect(isConfirmed({ ...spec, confirmed })).toBe(true)
    expect(isConfirmed({ ...spec, secretNames: [], confirmed })).toBe(true)
    expect(isConfirmed({ ...spec, args: ['--other'], confirmed })).toBe(false)
    expect(isConfirmed({ ...spec, secretNames: ['TOKEN', 'NEW'], confirmed })).toBe(false)
  })
})
