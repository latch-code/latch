import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, McpHttpServerView, McpServerView, McpServersResponse, TaskDetail } from '@latch/protocol'
import { AppError, type HarnessPlugin, type ModelProvider } from '@latch/sdk'
import { FAKE_ACP_AGENT, startFakeMcpHttp, type FakeMcpHttp, type FakeMcpHttpOptions, type TestDevice } from '@latch/testkit'
import { createEgressFetch } from '../src/egress.ts'
import { httpSpecHash, isConfirmed, remoteAddress, widens, type McpState } from '../src/mcp.ts'
import { MAX_DECLINES, MAX_PER_ORIGIN, McpRemoteSession, builtinToolName, maskStrings } from '../src/mcp-remote.ts'
import { ToolGatewayServer } from '../src/tool-gateway.ts'
import { redactKnownSecrets, setKnownSecrets } from '@latch/core/node-kit'
import { isMcpServerName } from '@latch/protocol'
import { classifyStandardCall } from '../src/risk.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const TOKEN = 'Bearer remote-mcp-token-0123456789'
const RAW = 'remote-mcp-token-0123456789'

async function fake(options: FakeMcpHttpOptions = {}): Promise<FakeMcpHttp> {
  const server = await startFakeMcpHttp({ keepHeaders: ['authorization'], ...options })
  cleanups.push(() => server.close())
  return server
}

/** The Host's own outbound fetch, allowing exactly the fake's loopback port. */
const egressTo = (server: FakeMcpHttp) => createEgressFetch({ allow: () => [new URL(server.origin).host] })

async function body(response: Response): Promise<any> {
  const text = await response.text()
  return text ? JSON.parse(text) : undefined
}

async function audit(t: TestHost): Promise<Array<{ action: string; stepup: string; detail: Record<string, unknown> }>> {
  return (await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
}

describe('the Host’s MCP client for remote servers', () => {
  it('initializes once, then sends the session ID, the protocol version and the headers with every request', async () => {
    const server = await fake()
    const session = new McpRemoteSession({ url: server.url, headers: { Authorization: TOKEN }, fetch: egressTo(server) })
    const tools = await session.listTools()
    expect(tools.map(tool => tool.name)).toEqual(['echo', 'slow', 'big'])
    const answer = await session.callTool('echo', { text: 'hi' })
    expect(answer).toEqual({ result: { content: [{ type: 'text', text: '{"text":"hi"}' }] } })
    const [init, initialized, list, call] = server.requests
    expect(init).toMatchObject({ rpc: 'initialize', headers: { authorization: TOKEN } })
    expect(init!.sessionId).toBeUndefined()
    expect((init!.body as any).params).toMatchObject({ protocolVersion: '2025-06-18', capabilities: {} })
    for (const request of [initialized, list, call])
      expect(request).toMatchObject({ sessionId: 'fake-session-1', protocolVersion: '2025-06-18', headers: { authorization: TOKEN } })
    expect(initialized!.rpc).toBe('notifications/initialized')
    await session.close()
    expect(server.deleted).toEqual(['fake-session-1'])
  })

  it('reads an event stream, declines the server’s own request, and starts again once when the server forgets the session', async () => {
    const server = await fake({ answer: 'sse', askFirst: true })
    const session = new McpRemoteSession({ url: server.url, headers: {}, fetch: egressTo(server) })
    expect(await session.callTool('echo', { text: 'a' })).toMatchObject({ result: { content: [{ text: '{"text":"a"}' }] } })
    // The server's sampling request was answered with method not found, never served.
    await vi.waitFor(() =>
      expect(server.requests.find(request => (request.body as any)?.id === 'server-ask' && !request.rpc)?.body).toMatchObject({
        error: { code: -32601 },
      }),
    )
    server.forget()
    expect(await session.callTool('echo', { text: 'b' })).toMatchObject({ result: { content: [{ text: '{"text":"b"}' }] } })
    expect(server.requests.filter(request => request.rpc === 'initialize')).toHaveLength(2)
  })

  it('bounds an answer’s size and time, and tells the server when a call is stopped', async () => {
    const server = await fake()
    const session = new McpRemoteSession({ url: server.url, headers: {}, fetch: egressTo(server), timeoutMs: 400 })
    await expect(session.callTool('big', {})).rejects.toMatchObject({ reason: 'output-too-large' })
    await expect(session.callTool('slow', {})).rejects.toMatchObject({ reason: 'timeout' })
    const stop = new AbortController()
    const patient = new McpRemoteSession({ url: server.url, headers: {}, fetch: egressTo(server) })
    const call = patient.callTool('slow', {}, stop.signal)
    await vi.waitFor(() => expect(server.requests.filter(request => request.rpc === 'tools/call').length).toBeGreaterThan(2))
    stop.abort()
    await expect(call).rejects.toBeDefined()
    await vi.waitFor(() => expect(server.cancelled.length).toBeGreaterThan(0))
  })

  it('never follows a redirect, goes nowhere the outbound rules refuse, and says a login is needed without trying one', async () => {
    const elsewhere = await fake()
    const redirecting = await fake({ redirect: `${elsewhere.url}?stolen=1` })
    const both = createEgressFetch({ allow: () => [new URL(redirecting.origin).host, new URL(elsewhere.origin).host] })
    const session = new McpRemoteSession({ url: redirecting.url, headers: { Authorization: TOKEN }, fetch: both })
    const refused = await session.listTools().catch((error: unknown) => error)
    expect(refused).toMatchObject({ reason: 'refused' })
    expect(elsewhere.requests).toEqual([])
    // Not allowed by the outbound rules: nothing reaches the server.
    const unallowed = await fake()
    const denied = new McpRemoteSession({
      url: unallowed.url,
      headers: { Authorization: TOKEN },
      fetch: createEgressFetch({ allow: () => [] }),
    })
    expect(await denied.listTools().catch((error: unknown) => error)).toMatchObject({ reason: 'refused' })
    expect(unallowed.requests).toEqual([])
    const login = await fake({ login: true })
    const asks = new McpRemoteSession({ url: login.url, headers: {}, fetch: egressTo(login) })
    expect(await asks.listTools().catch((error: unknown) => error)).toMatchObject({ reason: 'auth-required' })
    // No error says a header's value.
    for (const error of [refused]) expect(String((error as Error).message)).not.toContain(RAW)
  })

  it('keeps an address as origin and path, https or this Mac’s loopback, and binds headers to it', () => {
    expect(remoteAddress('https://mcp.example.com/v1/mcp')).toBe('https://mcp.example.com/v1/mcp')
    expect(remoteAddress('http://127.0.0.1:3845/mcp')).toBe('http://127.0.0.1:3845/mcp')
    for (const url of [
      'http://example.com/mcp',
      'http://10.0.0.2/mcp',
      'https://a.b/mcp?x=1',
      'https://u:p@a.b/',
      'https://a.b/#f',
      'file:///x',
    ])
      expect(remoteAddress(url), url).toBeUndefined()
    const spec = { url: 'https://a.b/mcp', headerNames: ['Authorization'] }
    const confirmed = { hash: httpSpecHash(spec), secretNames: ['Authorization'] }
    expect(isConfirmed({ transport: 'http', ...spec, confirmed })).toBe(true)
    expect(isConfirmed({ transport: 'http', ...spec, url: 'https://a.b/other', confirmed })).toBe(false)
    expect(isConfirmed({ transport: 'http', ...spec, headerNames: ['Authorization', 'X-Key'], confirmed })).toBe(false)
    const state = (change: Partial<Extract<McpState, { transport: 'http' }>> = {}): McpState => ({
      transport: 'http',
      ...spec,
      scope: { all: true, agents: [], projects: [] },
      enabled: true,
      disabledTools: [],
      secretHashes: { Authorization: 'h1' },
      ...change,
    })
    expect(widens(state(), state({ url: 'https://a.b/other' }))).toBe('spec')
    expect(widens(state(), state({ url: 'https://c.d/mcp' }))).toBe('spec')
    expect(widens(state(), state({ headerNames: ['Authorization', 'X-Key'] }))).toBe('spec')
    expect(widens(state(), state({ secretHashes: { Authorization: 'h2' } }))).toBe('use')
    expect(widens(state(), state({ headerNames: [], secretHashes: {} }))).toBe('use')
    expect(widens(state(), state({ enabled: false }))).toBe(false)
  })

  it('names a remote tool for the built-in Harness as model APIs accept, and classes every call R2', () => {
    const A = `mcp_${'A'.repeat(22)}`
    const B = `mcp_${'B'.repeat(22)}`
    expect(builtinToolName(A, 'github', 'search_issues')).toMatch(/^mcp__github__search_issues_[0-9a-f]{8}$/u)
    expect(builtinToolName(A, 'github', 'a.b/c')).toMatch(/^mcp__github__a_b_c_[0-9a-f]{8}$/u)
    // Two tools whose names read the same once rewritten, and two servers whose names and tools join the same way,
    // never share one: the hash is always there.
    expect(builtinToolName(A, 'github', 'a.b')).not.toBe(builtinToolName(A, 'github', 'a_b'))
    expect(builtinToolName(A, 'a', 'b__c')).not.toBe(builtinToolName(B, 'a__b', 'c'))
    const long = builtinToolName(A, 'a-very-long-server-name-here', 'and_a_tool_name_that_goes_on_and_on_and_on')
    expect(long).toMatch(/^[A-Za-z0-9_-]{1,64}$/u)
    expect(long).not.toBe(builtinToolName(A, 'a-very-long-server-name-here', 'and_a_tool_name_that_goes_on_and_on_and_on_2'))
    // `__` separates server and tool, so a new server's name never holds it.
    expect(isMcpServerName('a__b')).toBe(false)
    expect(isMcpServerName('a_b-c')).toBe(true)
    // An answer's keys are masked as its values are.
    setKnownSecrets('test-keys', [RAW])
    expect(maskStrings({ [RAW]: [RAW, 1] }, redactKnownSecrets)).toEqual({ '[redacted]': ['[redacted]', 1] })
    setKnownSecrets('test-keys', [])
    expect(classifyStandardCall({ pluginId: undefined, toolName: 'mcp__github__search', args: {}, demo: false, folders: [] })).toEqual({
      risk: 'R2',
      reason: 'mcp-tool',
    })
  })
})

async function host(options: Parameters<typeof startTestHost>[0] = {}) {
  const t = await startTestHost({ demo: false, ...options })
  cleanups.push(() => t.close())
  const desktop = await t.enroll({ listener: 'unix' })
  const browser = await t.enroll({ scopes: ['view', 'run', 'admin'] })
  return { t, desktop, browser }
}

function remote(name: string, url: string, extra: Record<string, unknown> = {}) {
  return {
    requestId: randomUUID(),
    baseRevision: 0,
    transport: 'http',
    name,
    url,
    headers: { Authorization: TOKEN },
    scope: { all: true, agents: [], projects: [] },
    ...extra,
  }
}

describe('设置 › MCP: remote addresses', () => {
  it('confirms the address, its header names and its outbound allowance in one request, and never returns a header’s value', async () => {
    const server = await fake()
    const { t, desktop, browser } = await host()
    const input = remote('remote', server.url)
    expect(await body(await browser.request('mcp/servers', { body: input }))).toMatchObject({ error: 'local-only' })
    const asked = await desktop.request('mcp/servers', { body: input })
    expect(asked.status).toBe(403)
    const ticket = (await body(asked)).confirmation
    const target = new URL(server.origin).host
    expect(ticket).toMatchObject({ action: 'mcp.server.apply', form: 'mcp.server.apply-remote', title: '添加 MCP 服务器' })
    expect(ticket.reason).toBe(`让 Latch 连接 ${target}（MCP 服务器「remote」）`)
    expect(ticket.lines).toEqual(
      expect.arrayContaining([
        { label: '地址', value: server.url },
        { label: '请求头', value: 'Authorization（值只发往这个地址）' },
        { label: '出站许可', value: `允许 Host 访问 ${target}（这台电脑上的地址）` },
      ]),
    )
    expect(JSON.stringify(ticket)).not.toContain(RAW)
    const before = t.presence.requests.length
    const added = await desktop.confirmedJson<{ server: McpHttpServerView }>('mcp/servers', { body: input })
    expect(t.presence.requests).toHaveLength(before + 1)
    expect(added.server).toMatchObject({ transport: 'http', url: server.url, headers: [{ name: 'Authorization', set: true }] })
    for (const text of [
      JSON.stringify(added),
      JSON.stringify(await browser.json('mcp/servers')),
      JSON.stringify(await browser.json('snapshot')),
      JSON.stringify(await audit(t)),
      await readFile(join(t.dataDir, 'mcp', 'servers.json'), 'utf8'),
    ])
      expect(text).not.toContain(RAW)
    expect(await readFile(join(t.dataDir, 'mcp', 'secrets.json'), 'utf8')).toContain(RAW)
    // The allowance is in the policy, on record with the same confirmation.
    const policy = JSON.parse(await readFile(join(t.dataDir, 'policy.json'), 'utf8'))
    expect(policy.hostEgressAllow).toContain(target)
    const records = await audit(t)
    expect(records.find(record => record.action === 'mcp.server.added')).toMatchObject({
      stepup: 'lpc-local',
      detail: { transport: 'http' },
    })
    expect(records.find(record => record.action === 'policy.changed')?.stepup).toBe('lpc-local')
    // A second server at an address already allowed is confirmed for itself, with no allowance asked for again.
    const second = await desktop.request('mcp/servers', { body: remote('second', `${server.origin}/other`, { baseRevision: 1 }) })
    const lines: Array<{ label: string }> = (await body(second)).confirmation.lines
    expect(lines.map(line => line.label)).not.toContain('出站许可')
    // Plain http elsewhere, a query or credentials in the address: refused before anything is asked.
    const asks = t.presence.requests.length
    for (const url of ['http://example.com/mcp', `${server.url}?token=x`, 'https://user:pw@example.com/mcp'])
      expect((await body(await desktop.request('mcp/servers', { body: remote('bad', url, { baseRevision: 1 }) }))).error).toBe(
        'mcp-url-invalid',
      )
    expect(
      (await body(await desktop.request('mcp/servers', { body: remote('bad', server.url, { baseRevision: 1, headers: { Host: 'x' } }) })))
        .error,
    ).toBe('invalid-input')
    // `__` is how the built-in Harness separates server and tool: never in a new name.
    expect((await body(await desktop.request('mcp/servers', { body: remote('a__b', server.url, { baseRevision: 1 }) }))).error).toBe(
      'invalid-input',
    )
    expect(t.presence.requests).toHaveLength(asks)
  })

  it('asks again for another origin or path or a new header name; a header’s new value, removing one or 停用 ask nothing', async () => {
    const server = await fake()
    const { t, desktop } = await host()
    const { server: added } = await desktop.confirmedJson<{ server: McpServerView }>('mcp/servers', { body: remote('remote', server.url) })
    let revision = added.revision
    const patch = (change: Record<string, unknown>) =>
      desktop.request(`mcp/servers/${added.id}`, { method: 'PATCH', body: { requestId: randomUUID(), baseRevision: revision, ...change } })
    const ok = async (response: Response) => {
      expect(response.status).toBe(200)
      revision = (await body(response)).server.revision
    }
    const confirmations = t.presence.requests.length
    await ok(await patch({ headers: { Authorization: 'Bearer another-token-value-123' } }))
    await ok(await patch({ disabledTools: ['slow'] }))
    expect(t.presence.requests).toHaveLength(confirmations)
    for (const change of [{ url: `${server.origin}/elsewhere` }, { headers: { 'X-Api-Key': 'another-secret-value' } }]) {
      const wider = await patch(change)
      expect(wider.status, JSON.stringify(change)).toBe(403)
      expect((await body(wider)).confirmation.form).toBe('mcp.server.apply-remote')
    }
    expect((await patch({ command: '/bin/sh' })).status).toBe(400)
    await ok(await patch({ headers: { Authorization: null } }))
    await ok(await patch({ enabled: false }))
    expect(t.presence.requests).toHaveLength(confirmations + 2)
    expect((await desktop.json<McpServersResponse>('mcp/servers')).servers[0]).toMatchObject({ url: server.url, headers: [] })
  })

  it('runs 测试 from the Host and records what it listed, or that the server asks for a login', async () => {
    const server = await fake()
    const login = await fake({ login: true })
    const { desktop } = await host()
    const { server: added } = await desktop.confirmedJson<{ server: McpServerView }>('mcp/servers', { body: remote('remote', server.url) })
    const tested = await desktop.json<{ status: string; tools: string[] }>(`mcp/servers/${added.id}/test`, {
      body: { requestId: randomUUID() },
    })
    expect(tested).toMatchObject({ status: 'ok', tools: ['echo', 'slow', 'big'] })
    expect(server.requests[0]!.headers).toEqual({ authorization: TOKEN })
    const { server: second } = await desktop.confirmedJson<{ server: McpServerView }>('mcp/servers', {
      body: remote('login', login.url, { baseRevision: (await desktop.json<McpServersResponse>('mcp/servers')).revision }),
    })
    const failed = await desktop.json<{ status: string; reason: string; server: McpServerView }>(`mcp/servers/${second.id}/test`, {
      body: { requestId: randomUUID() },
    })
    expect(failed).toMatchObject({
      status: 'failed',
      reason: 'auth-required',
      server: { report: { status: 'failed', reason: 'auth-required' } },
    })
  })
})

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

describe('remote servers in sessions', () => {
  it('relays an external agent’s calls through latch-mcp to the Host, which alone holds the headers, records each call first and masks what comes back', async () => {
    const server = await fake()
    const logs: string[] = []
    const { t, desktop } = await host({ log: text => logs.push(text) })
    const root = await mkdtemp(join(tmpdir(), 'latch-mcp-remote-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    await desktop.confirmedJson('agents', {
      body: {
        id: 'mcp-agent',
        name: 'MCP Agent',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_MCP: 'dsh', FAKE_ACP_STATE: join(root, 'state.json'), FAKE_ACP_LOG: join(root, 'agent.log') },
      },
    })
    const { server: added } = await desktop.confirmedJson<{ server: McpServerView }>('mcp/servers', { body: remote('remote', server.url) })
    const created = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
      body: { prompt: 'mcp-list remote', requestId: randomUUID(), harnessId: 'mcp-agent' },
    })
    const { sessionId } = created
    expect(lastText(await settled(desktop, sessionId))).toBe('remote tools: echo,slow,big')
    await desktop.json(`tasks/${sessionId}/prompt`, { body: { requestId: randomUUID(), prompt: 'mcp remote echo {"text":"hi"}' } })
    expect(lastText(await settled(desktop, sessionId))).toBe('remote.echo: ok: {"text":"hi"}')
    // A server that says its header back: masked before the agent sees it.
    await desktop.json(`tasks/${sessionId}/prompt`, {
      body: { requestId: randomUUID(), prompt: 'mcp remote echo {"echoHeader":"authorization"}' },
    })
    const detail = await settled(desktop, sessionId)
    expect(lastText(detail)).toBe('remote.echo: ok: {"echoHeader":"authorization"} [redacted]')
    expect(JSON.stringify(detail)).not.toContain(RAW)
    // The agent's side never had the header: not in its session/new, not in its log.
    expect(await readFile(join(root, 'agent.log'), 'utf8')).not.toContain(RAW)
    expect(server.requests.filter(request => request.rpc === 'tools/call').every(request => request.headers.authorization === TOKEN)).toBe(
      true,
    )
    const records = await audit(t)
    expect(JSON.stringify(records)).not.toContain(RAW)
    const calls = records.filter(record => record.action.startsWith('mcp.tool.'))
    expect(calls.map(record => [record.action, record.detail.serverId])).toEqual([
      ['mcp.tool.called', added.id],
      ['mcp.tool.settled', added.id],
      ['mcp.tool.called', added.id],
      ['mcp.tool.settled', added.id],
    ])
    expect(records.find(record => record.action === 'task.l3.started')?.detail.mcpSetHash).toMatch(/^[0-9a-f]{64}$/u)
    // A call whose record cannot be written is not sent.
    const append = t.host.security.audit.append.bind(t.host.security.audit)
    const spy = vi
      .spyOn(t.host.security.audit, 'append')
      .mockImplementation(event =>
        event.action === 'mcp.tool.called' ? Promise.reject(new AppError(503, 'audit-unavailable', '审计不可用')) : append(event),
      )
    const sent = server.requests.filter(request => request.rpc === 'tools/call').length
    await desktop.json(`tasks/${sessionId}/prompt`, { body: { requestId: randomUUID(), prompt: 'mcp remote echo {"text":"x"}' } })
    expect(lastText(await settled(desktop, sessionId))).toBe('remote.echo: error: Latch could not record this call, so it was not made.')
    expect(server.requests.filter(request => request.rpc === 'tools/call')).toHaveLength(sent)
    spy.mockRestore()
    // 停用 ends the relay: the next call is refused and nothing more reaches the server.
    const list = await desktop.json<McpServersResponse>('mcp/servers')
    await desktop.json(`mcp/servers/${added.id}`, {
      method: 'PATCH',
      body: { requestId: randomUUID(), baseRevision: list.servers[0]!.revision, enabled: false },
    })
    await desktop.json(`tasks/${sessionId}/prompt`, { body: { requestId: randomUUID(), prompt: 'mcp remote echo {"text":"y"}' } })
    expect(lastText(await settled(desktop, sessionId))).toMatch(/^remote\.echo: error: /u)
    expect(server.requests.filter(request => request.rpc === 'tools/call')).toHaveLength(sent)
    // Nor did the Host's log ever carry it.
    expect(logs.join('\n')).not.toContain(RAW)
  })

  it('gives the built-in Harness each remote tool as mcp__<server>__<tool>, asked every time (R2) with no 始终允许', async () => {
    const server = await fake()
    const provider: ModelProvider = {
      id: 'scripted',
      name: 'Scripted',
      model: 'scripted',
      async *stream({ messages, tools }) {
        if (messages.at(-1)?.role === 'tool') {
          yield { type: 'text', text: `done: ${String(messages.at(-1)?.content ?? '')}` }
          yield { type: 'finish', reason: 'stop' }
          return
        }
        const name = tools?.find(tool => tool.name.startsWith('mcp__remote__echo'))?.name ?? 'missing'
        yield { type: 'tool-call', call: { id: `call-${randomUUID()}`, name, arguments: { echoHeader: 'authorization' } } }
        yield { type: 'finish', reason: 'tool-calls' }
      },
    }
    const plugin: HarnessPlugin = {
      id: 'scripted',
      name: 'Scripted',
      version: '1',
      description: 'fixture',
      activate(ctx) {
        ctx.registerProvider(provider)
      },
    }
    const { t, desktop } = await host({ providerId: 'scripted', plugins: [plugin] })
    const { server: added } = await desktop.confirmedJson<{ server: McpServerView }>('mcp/servers', { body: remote('remote', server.url) })
    const created = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
      body: { prompt: 'call it', requestId: randomUUID(), mode: 'agent', harnessId: 'standard' },
    })
    const approval = await waitFor(
      async () => (await desktop.json<AppSnapshot>('snapshot')).approvals.find(item => item.sessionId === created.sessionId),
      found => found !== undefined,
    )
    expect(approval).toMatchObject({
      risk: 'R2',
      riskReason: 'mcp-tool',
      toolName: expect.stringMatching(/^mcp__remote__echo_[0-9a-f]{8}$/u),
    })
    expect(approval!.options?.map(option => option.kind)).not.toContain('allow_always')
    // Nothing was sent before the person allowed it.
    expect(server.requests.filter(request => request.rpc === 'tools/call')).toEqual([])
    await desktop.json(`approvals/${approval!.id}`, { method: 'POST', body: { decision: 'allow' } })
    const detail = await settled(desktop, created.sessionId)
    expect(lastText(detail)).toBe('done: {"echoHeader":"authorization"} [redacted]')
    expect(JSON.stringify(detail)).not.toContain(RAW)
    expect(server.requests.filter(request => request.rpc === 'tools/call')).toHaveLength(1)
    const records = await audit(t)
    expect(records.filter(record => record.action.startsWith('mcp.tool.')).map(record => [record.action, record.detail.serverId])).toEqual([
      ['mcp.tool.called', added.id],
      ['mcp.tool.settled', added.id],
    ])
    // Only remote addresses reach the built-in Harness: a local command is never run by the Host for it.
    expect(JSON.stringify(records)).not.toContain(RAW)
  })
})

describe('remote MCP: the review’s cases', () => {
  it('refuses a redirect to another path on the same origin, and never sends the headers there', async () => {
    const same = await startFakeMcpHttp({ keepHeaders: ['authorization'], redirect: '/other' })
    cleanups.push(() => same.close())
    const session = new McpRemoteSession({ url: same.url, headers: { Authorization: TOKEN }, fetch: egressTo(same) })
    expect(await session.listTools().catch((error: unknown) => error)).toMatchObject({ reason: 'refused' })
    expect(same.requests.filter(request => request.path === '/other')).toEqual([])
    expect(same.requests).toHaveLength(1)
  })

  it('replies to at most 16 of the server’s own requests per answer, and keeps at most 8 requests in flight per origin', async () => {
    const asking = await fake({ answer: 'sse', askFirst: true, asks: 40 })
    const session = new McpRemoteSession({ url: asking.url, headers: {}, fetch: egressTo(asking) })
    await session.callTool('echo', { text: 'a' })
    await new Promise(resolve => setTimeout(resolve, 300))
    const declined = (call: number) =>
      asking.requests.filter(request => !request.rpc && String((request.body as any)?.id ?? '').startsWith('server-ask')).length - call
    // `initialize`'s answer had no asks; `tools/call`'s had 40: only 16 got a reply.
    expect(declined(0)).toBe(MAX_DECLINES)
    const slow = await fake({ slowMs: 300 })
    const many = new McpRemoteSession({ url: slow.url, headers: {}, fetch: egressTo(slow) })
    await many.initialize()
    await Promise.all(Array.from({ length: MAX_PER_ORIGIN + 6 }, () => many.callTool('slow', {})))
    expect(slow.peak()).toBeLessThanOrEqual(MAX_PER_ORIGIN)
  })

  it('relays nothing to a remote server whose launch was refused, its start not on record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lbt-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const relayed: string[] = []
    const gateway = new ToolGatewayServer({
      socketPath: join(root, 'tools', 'gateway.sock'),
      tools: () => [],
      call: async () => ({ content: [] }),
      mcp: {
        select: async () => [{ serverId: `mcp_${'A'.repeat(22)}`, name: 'remote', specHash: 'a'.repeat(64) }],
        launch: async () => {
          throw new AppError(503, 'audit-failed', 'Latch could not record this start, so the server was not started.')
        },
        remote: async (_binding, method) => {
          relayed.push(method)
          return {}
        },
        report: () => {},
        callStarted: async () => 'x',
        callEnded: () => {},
        closed: () => {},
      },
    })
    await gateway.start()
    cleanups.push(() => gateway.close())
    const [lease] = await gateway.openMcp({ sessionId: 's1', cwd: root })
    const { createConnection } = await import('node:net')
    const socket = createConnection(join(root, 'tools', 'gateway.sock'))
    cleanups.push(() => {
      socket.destroy()
    })
    const replies: any[] = []
    let buffer = ''
    socket.setEncoding('utf8').on('data', chunk => {
      buffer += chunk
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        replies.push(JSON.parse(buffer.slice(0, end)))
        buffer = buffer.slice(end + 1)
      }
    })
    const send = (id: number, method: string, params: unknown = {}) =>
      socket.write(`${JSON.stringify({ id, token: lease!.token, method, params })}\n`)
    send(1, 'mcp/launch')
    await vi.waitFor(() => expect(replies.find(reply => reply.id === 1)?.error).toBeDefined())
    for (const [id, method] of [
      [2, 'initialize'],
      [3, 'tools/list'],
      [4, 'tools/call'],
    ] as const)
      send(id, 'mcp/remote', { method, params: { name: 'echo' } })
    await vi.waitFor(() => expect(replies.filter(reply => reply.id >= 2)).toHaveLength(3))
    expect(replies.filter(reply => reply.id >= 2).every(reply => reply.error?.message === 'This server was not started.')).toBe(true)
    expect(relayed).toEqual([])
  })

  it('never sends new headers to the old address when the address changes while a call’s record is held', async () => {
    const old = await fake()
    const next = await fake()
    const { t, desktop } = await host({ providerId: 'scripted', plugins: [scriptedEcho()] })
    const { server: added } = await desktop.confirmedJson<{ server: McpServerView }>('mcp/servers', { body: remote('remote', old.url) })
    // Hold the record of the call until the address and its header have changed (a built-in session is no full-access
    // one, so the change is not blocked meanwhile).
    const append = t.host.security.audit.append.bind(t.host.security.audit)
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let holding = false
    const spy = vi.spyOn(t.host.security.audit, 'append').mockImplementation(async event => {
      if (event.action === 'mcp.tool.called') {
        holding = true
        await held
      }
      return append(event)
    })
    cleanups.push(() => spy.mockRestore())
    const created = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
      body: { prompt: 'call it', requestId: randomUUID(), mode: 'agent', harnessId: 'standard' },
    })
    const approval = await waitFor(
      async () => (await desktop.json<AppSnapshot>('snapshot')).approvals.find(item => item.sessionId === created.sessionId),
      found => found !== undefined,
    )
    await desktop.json(`approvals/${approval!.id}`, { method: 'POST', body: { decision: 'allow' } })
    await vi.waitFor(() => expect(holding).toBe(true), { timeout: 10_000 })
    const list = await desktop.json<McpServersResponse>('mcp/servers')
    const moved = await desktop.confirmed(`mcp/servers/${added.id}`, {
      method: 'PATCH',
      body: {
        requestId: randomUUID(),
        baseRevision: list.servers[0]!.revision,
        url: next.url,
        headers: { Authorization: 'Bearer the-new-token-for-next-0000' },
      },
    })
    expect(moved.status).toBe(200)
    release()
    await settled(desktop, created.sessionId)
    expect(old.requests.some(request => request.headers.authorization?.includes('the-new-token'))).toBe(false)
    expect(old.requests.filter(request => request.rpc === 'tools/call')).toEqual([])
    expect(next.requests).toEqual([])
  })

  it('writes the built-in Harness’s start record first: without it, or without the call’s record, nothing is sent', async () => {
    const server = await fake()
    const provider: ModelProvider = {
      id: 'scripted',
      name: 'Scripted',
      model: 'scripted',
      async *stream({ messages, tools }) {
        if (messages.at(-1)?.role === 'tool') {
          yield { type: 'text', text: `done: ${String(messages.at(-1)?.content ?? '')}` }
          yield { type: 'finish', reason: 'stop' }
          return
        }
        const name = tools?.find(tool => tool.name.startsWith('mcp__remote__echo'))?.name ?? 'missing'
        yield { type: 'tool-call', call: { id: `call-${randomUUID()}`, name, arguments: { text: 'x' } } }
        yield { type: 'finish', reason: 'tool-calls' }
      },
    }
    const plugin: HarnessPlugin = {
      id: 'scripted',
      name: 'Scripted',
      version: '1',
      description: 'fixture',
      activate(ctx) {
        ctx.registerProvider(provider)
      },
    }
    const { t, desktop } = await host({ providerId: 'scripted', plugins: [plugin] })
    await desktop.confirmedJson<{ server: McpServerView }>('mcp/servers', { body: remote('remote', server.url) })
    const append = t.host.security.audit.append.bind(t.host.security.audit)
    let failing = 'mcp.server.started'
    const spy = vi
      .spyOn(t.host.security.audit, 'append')
      .mockImplementation(event =>
        event.action === failing ? Promise.reject(new AppError(503, 'audit-unavailable', '审计不可用')) : append(event),
      )
    cleanups.push(() => spy.mockRestore())
    const first = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
      body: { prompt: 'call it', requestId: randomUUID(), mode: 'agent', harnessId: 'standard' },
    })
    await settled(desktop, first.sessionId)
    // No start record: the run had no remote tool, and the server heard nothing at all.
    expect(server.requests).toEqual([])
    failing = 'mcp.tool.called'
    const second = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
      body: { prompt: 'call it', requestId: randomUUID(), mode: 'agent', harnessId: 'standard' },
    })
    const approval = await waitFor(
      async () => (await desktop.json<AppSnapshot>('snapshot')).approvals.find(item => item.sessionId === second.sessionId),
      found => found !== undefined,
    )
    await desktop.json(`approvals/${approval!.id}`, { method: 'POST', body: { decision: 'allow' } })
    expect(lastText(await settled(desktop, second.sessionId))).toContain('Latch could not record this call')
    expect(server.requests.filter(request => request.rpc === 'tools/call')).toEqual([])
  })

  it('offers to remove the allowance only this server used, and removes it without a confirmation', async () => {
    const server = await fake()
    const { t, desktop } = await host()
    const target = new URL(server.origin).host
    const { server: first } = await desktop.confirmedJson<{ server: McpServerView }>('mcp/servers', { body: remote('first', server.url) })
    const { server: second } = await desktop.confirmedJson<{ server: McpServerView }>('mcp/servers', {
      body: remote('second', `${server.origin}/two`, { baseRevision: 1 }),
    })
    const allowanceOf = async (id: string) =>
      ((await desktop.json<McpServersResponse>('mcp/servers')).servers.find(item => item.id === id) as McpHttpServerView).allowance
    // Two servers share it: neither may take it away.
    expect(await allowanceOf(first.id)).toBeUndefined()
    expect((await desktop.request(`mcp/servers/${first.id}?allowance=remove`, { method: 'DELETE' })).status).toBe(200)
    const policy = async () => JSON.parse(await readFile(join(t.dataDir, 'policy.json'), 'utf8')).hostEgressAllow as string[]
    expect(await policy()).toContain(target)
    expect(await allowanceOf(second.id)).toBe(target)
    const confirmations = t.presence.requests.length
    const removed = await desktop.json<{ allowanceRemoved?: string }>(`mcp/servers/${second.id}?allowance=remove`, { method: 'DELETE' })
    expect(removed.allowanceRemoved).toBe(target)
    expect(await policy()).not.toContain(target)
    expect(t.presence.requests).toHaveLength(confirmations)
  })
})

/** A model that calls the remote server's `echo` once, then says what came back. */
function scriptedEcho(): HarnessPlugin {
  const provider: ModelProvider = {
    id: 'scripted',
    name: 'Scripted',
    model: 'scripted',
    async *stream({ messages, tools }) {
      if (messages.at(-1)?.role === 'tool') {
        yield { type: 'text', text: `done: ${String(messages.at(-1)?.content ?? '')}` }
        yield { type: 'finish', reason: 'stop' }
        return
      }
      const name = tools?.find(tool => tool.name.startsWith('mcp__remote__echo'))?.name ?? 'missing'
      yield { type: 'tool-call', call: { id: `call-${randomUUID()}`, name, arguments: { text: 'x' } } }
      yield { type: 'finish', reason: 'tool-calls' }
    },
  }
  return {
    id: 'scripted',
    name: 'Scripted',
    version: '1',
    description: 'fixture',
    activate(ctx) {
      ctx.registerProvider(provider)
    },
  }
}
