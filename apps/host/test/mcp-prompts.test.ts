import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CustomAgent, McpServerView, McpServersResponse, MemoryProposal, TaskDetail } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { FAKE_ACP_AGENT, FAKE_MCP_STDIO, startFakeMcpHttp, type TestDevice } from '@latch/testkit'
import { promptHash } from '../src/mcp.ts'
import { ToolGatewayServer } from '../src/tool-gateway.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function audit(t: TestHost): Promise<Array<{ action: string; actor: Record<string, unknown>; detail: Record<string, unknown> }>> {
  return (await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
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

/** A Host with the fake ACP agent (it takes MCP servers) and one remote MCP server used everywhere. */
async function withAgent(env: Record<string, string> = {}) {
  const server = await startFakeMcpHttp()
  cleanups.push(() => server.close())
  const t = await startTestHost({ demo: false })
  cleanups.push(() => t.close())
  const desktop = await t.enroll({ listener: 'unix' })
  const root = await mkdtemp(join(tmpdir(), 'latch-mcp-prompts-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  await desktop.confirmedJson('agents', {
    body: {
      id: 'prompt-agent',
      name: 'Prompt Agent',
      command: process.execPath,
      args: [FAKE_ACP_AGENT],
      env: { FAKE_ACP_MCP: 'dsh', FAKE_ACP_STATE: join(root, 'state.json'), FAKE_ACP_LOG: join(root, 'agent.log'), ...env },
    },
  })
  await desktop.confirmedJson('mcp/servers', {
    body: {
      requestId: randomUUID(),
      baseRevision: 0,
      transport: 'http',
      name: 'remote',
      url: server.url,
      headers: {},
      scope: { all: true, agents: [], projects: [] },
    },
  })
  return { t, desktop, server, root }
}
const rpc = (server: Awaited<ReturnType<typeof startFakeMcpHttp>>, method: string) =>
  server.requests.filter(request => request.rpc === method)

async function addFiles(desktop: TestDevice, log: string): Promise<McpServerView> {
  const { server: files } = await desktop.confirmedJson<{ server: McpServerView }>('mcp/servers', {
    body: {
      requestId: randomUUID(),
      baseRevision: (await desktop.json<McpServersResponse>('mcp/servers')).revision,
      name: 'files',
      command: process.execPath,
      args: [FAKE_MCP_STDIO],
      env: { FAKE_MCP_LOG: log },
      secrets: {},
      projectCwd: false,
      scope: { all: true, agents: [], projects: [] },
    },
  })
  return files
}

describe('MCP prompts through the latch-mcp bridge', () => {
  it('records a local command’s prompt before its bridge forwards it, marks the turn that read it, and forwards none unrecorded or of a remote server', async () => {
    const { t, desktop, server, root } = await withAgent()
    const log = join(root, 'server.log')
    const files = await addFiles(desktop, log)
    // A session started now gets both bridges.
    const { sessionId } = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
      body: { prompt: 'echo first', requestId: randomUUID(), harnessId: 'prompt-agent' },
    })
    await settled(desktop, sessionId)
    const say = async (prompt: string) => {
      await desktop.json(`tasks/${sessionId}/prompt`, { body: { requestId: randomUUID(), prompt } })
      return settled(desktop, sessionId)
    }
    const gets = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(line => line.includes('"prompts/get"')).length
    const detail = await say('mcp-prompt files review {"topic":"x"}')
    expect(lastText(detail)).toBe('files:review: ok: Review x in a plain tone.')
    // The Host cannot see the text, so the turn that fetched it says where its context came from.
    expect(detail.messages.findLast(message => message.role === 'user')).toMatchObject({ origin: 'mcp-prompt' })
    const records = await audit(t)
    expect(records.filter(record => record.action === 'mcp.prompt.got').map(record => [record.detail, record.actor.listener])).toEqual([
      [{ serverId: files.id, sessionId, promptHash: promptHash(files.id, 'review') }, 'host'],
    ])
    expect(await gets()).toBe(1)
    // A remote server's prompts are not relayed: its bridge forwards neither request.
    expect(lastText(await say('mcp-prompts remote'))).toBe('remote prompts: error: Method not found')
    expect(lastText(await say('mcp-prompt remote hello'))).toBe('remote:hello: error: Method not found')
    expect(rpc(server, 'prompts/list')).toEqual([])
    expect(rpc(server, 'prompts/get')).toEqual([])
    // No record, no fetch.
    const append = t.host.security.audit.append.bind(t.host.security.audit)
    const spy = vi
      .spyOn(t.host.security.audit, 'append')
      .mockImplementation(event =>
        event.action === 'mcp.prompt.got' ? Promise.reject(new AppError(503, 'audit-unavailable', '审计不可用')) : append(event),
      )
    expect(lastText(await say('mcp-prompt files hello'))).toBe(
      'files:hello: error: Latch could not record this prompt, so it was not fetched.',
    )
    spy.mockRestore()
    expect(await gets()).toBe(1)
    // The audit can succeed while persisting provenance fails. The command still receives no request.
    const marker = vi
      .spyOn(t.host.bridge, 'markOutsideContent')
      .mockRejectedValueOnce(new AppError(503, 'storage-unavailable', '持久化不可用'))
    try {
      expect(lastText(await say('mcp-prompt files hello'))).toBe(
        'files:hello: error: Latch could not mark this session, so the prompt was not fetched.',
      )
      expect(await gets()).toBe(1)
    } finally {
      marker.mockRestore()
    }
    // No longer used in this session: the bridge is gone, and nothing more reaches the command.
    const list = await desktop.json<McpServersResponse>('mcp/servers')
    await desktop.json(`mcp/servers/${files.id}`, {
      method: 'PATCH',
      body: {
        requestId: randomUUID(),
        baseRevision: list.servers.find(item => item.id === files.id)!.revision,
        scope: { all: false, agents: [], projects: ['another-project'] },
      },
    })
    expect(lastText(await say('mcp-prompt files hello'))).toMatch(/^(files:hello: error: |no MCP server files)/u)
    expect(await gets()).toBe(1)
  })

  it('clears old prompt provenance and preserves a new MCP read made during session/new', async () => {
    const { t, desktop, root } = await withAgent({ FAKE_ACP_MCP_PROMPT_ON_NEW: '3' })
    const log = join(root, 'server.log')
    const files = await addFiles(desktop, log)
    const agent = await desktop.json<CustomAgent>('custom-agents', {
      body: { requestId: randomUUID(), name: 'Prompt Agent', harnessId: 'prompt-agent' },
    })
    const { sessionId } = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
      body: { prompt: 'mcp-prompt files hello', requestId: randomUUID(), customAgentId: agent.id },
    })
    expect(lastText(await settled(desktop, sessionId))).toBe('files:hello: ok: Hello from the fake MCP server.')
    const proposeAfterClear = async (content: string) => {
      await desktop.json(`tasks/${sessionId}/prompt`, {
        body: { requestId: randomUUID(), prompt: `propose ${content}`, freshContext: true },
      })
      const detail = await settled(desktop, sessionId)
      expect(detail.messages.findLast(message => message.role === 'user')?.freshContext).toBe(true)
      return vi.waitFor(
        async () => {
          const { proposals } = await desktop.json<{ proposals: MemoryProposal[] }>(`custom-agents/${agent.id}/proposals`)
          const found = proposals.find(proposal => proposal.content === content)
          expect(found).toBeDefined()
          return found!
        },
        { timeout: 5000 },
      )
    }
    expect(await proposeAfterClear('Old context cleared')).toMatchObject({ external: false })
    const proposal = await proposeAfterClear('New context read a prompt')
    const started = (await readFile(join(root, 'agent.log'), 'utf8')).split('\n').filter(line => line.includes('"mcp-start-prompt"'))
    expect(started).toHaveLength(1)
    expect(JSON.parse(started[0]!)).toMatchObject({ text: 'Hello from the fake MCP server.' })
    expect((await readFile(log, 'utf8')).split('\n').filter(line => line.includes('"prompts/get"'))).toHaveLength(2)
    expect((await audit(t)).filter(record => record.action === 'mcp.prompt.got').map(record => record.detail)).toEqual(
      Array.from({ length: 2 }, () => ({ serverId: files.id, sessionId, promptHash: promptHash(files.id, 'hello') })),
    )
    expect(proposal).toMatchObject({ external: true })
  })

  it('takes mcp/prompt at the gateway only from a bridge whose local command it started', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lbt-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const recorded: string[] = []
    const ids = { local: `mcp_${'A'.repeat(22)}`, remote: `mcp_${'B'.repeat(22)}`, refused: `mcp_${'C'.repeat(22)}` }
    const gateway = new ToolGatewayServer({
      socketPath: join(root, 'tools', 'gateway.sock'),
      tools: () => [],
      call: async () => ({ content: [] }),
      mcp: {
        select: async () => [
          { serverId: ids.local, name: 'files', specHash: 'a'.repeat(64) },
          { serverId: ids.remote, name: 'remote', specHash: 'b'.repeat(64) },
          { serverId: ids.refused, name: 'refused', specHash: 'c'.repeat(64) },
        ],
        launch: async binding => {
          if (binding.serverId === ids.refused) throw new AppError(503, 'audit-failed', 'The server start could not be audited.')
          return binding.serverId === ids.remote
            ? { remote: true, disabledTools: [] }
            : { command: process.execPath, args: [], env: {}, cwd: root, disabledTools: [] }
        },
        promptStarted: async (binding, prompt) => {
          if (prompt === 'refused')
            throw new AppError(409, 'mcp-server-gone', 'This MCP server was removed, switched off or changed in Latch.')
          recorded.push(`${binding.serverId.slice(4, 5)}:${prompt}`)
        },
        report: () => {},
        callStarted: async () => 'x',
        callEnded: () => {},
        closed: () => {},
      },
    })
    await gateway.start()
    cleanups.push(() => gateway.close())
    const [files, remoteLease, failedLease] = await gateway.openMcp({ sessionId: 's1', cwd: root })
    const { createConnection } = await import('node:net')
    const socket = createConnection(join(root, 'tools', 'gateway.sock'))
    cleanups.push(() => {
      socket.destroy()
    })
    const replies = new Map<number, any>()
    let buffer = ''
    socket.setEncoding('utf8').on('data', chunk => {
      buffer += chunk
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const reply = JSON.parse(buffer.slice(0, end))
        replies.set(reply.id, reply)
        buffer = buffer.slice(end + 1)
      }
    })
    let next = 1
    const ask = async (token: string, method: string, params: unknown = {}) => {
      const id = next++
      socket.write(`${JSON.stringify({ id, token, method, params })}\n`)
      await vi.waitFor(() => expect(replies.has(id)).toBe(true))
      return replies.get(id)
    }
    // Before its launch a bridge has started nothing.
    expect((await ask(files!.token, 'mcp/prompt', { prompt: 'hello' })).error.message).toBe('This server was not started.')
    await ask(files!.token, 'mcp/launch')
    expect((await ask(files!.token, 'mcp/prompt', { prompt: 'hello' })).result).toEqual({})
    for (const prompt of ['', 'x'.repeat(257), 7]) expect((await ask(files!.token, 'mcp/prompt', { prompt })).error.code).toBe(-32602)
    // The Host's refusal reaches the bridge in the Host's words.
    expect((await ask(files!.token, 'mcp/prompt', { prompt: 'refused' })).error.message).toBe(
      'This MCP server was removed, switched off or changed in Latch.',
    )
    // A remote server's bridge never records a prompt.
    await ask(remoteLease!.token, 'mcp/launch')
    expect((await ask(remoteLease!.token, 'mcp/prompt', { prompt: 'hello' })).error.message).toBe('This server was not started.')
    expect((await ask(failedLease!.token, 'mcp/launch')).error.message).toBe('The server start could not be audited.')
    expect(await ask(failedLease!.token, 'mcp/prompt', { prompt: 'hello' })).toMatchObject({
      error: { message: 'This server was not started.' },
    })
    expect(recorded).toEqual(['A:hello'])
  })
})
