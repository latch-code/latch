import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FAKE_MCP_STDIO } from '@latch/testkit'
import { mcpBridgeServer } from '../src/mcp-bridge.ts'

const cleanups: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const TOKEN = `lbt1.${'m'.repeat(43)}`

async function waitFor<T>(read: () => Promise<T> | T, done: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = await read()
    if (done(value)) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('timed out')
}

/**
 * A stand-in for the Host's tool gateway: answers `mcp/launch` with the fake server and `env`, records every request,
 * and lets a test hold or refuse `mcp/call`.
 */
async function fakeGateway(
  input: {
    env?: Record<string, string>
    disabledTools?: string[]
    call?: (request: any) => unknown
    /** Answers `mcp/prompt`; the default records it. */
    prompt?: (request: any, answer: (reply: unknown) => void) => unknown
    /** The launch says the server is a remote address. */
    remote?: true
    /** Latch's own instructions and per-tool hints in the launch. */
    instructions?: string
    offHints?: Record<string, string>
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'lmcp-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const log = join(directory, 'server.log')
  const socketPath = join(directory, 'g.sock')
  const requests: any[] = []
  const sockets = new Set<Socket>()
  const server: Server = createServer(socket => {
    sockets.add(socket)
    let buffer = ''
    socket.setEncoding('utf8').on('data', chunk => {
      buffer += chunk
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const request = JSON.parse(buffer.slice(0, end))
        buffer = buffer.slice(end + 1)
        requests.push(request)
        const answer = (reply: unknown) => socket.write(`${JSON.stringify({ id: request.id, ...(reply as object) })}\n`)
        if (request.method === 'mcp/launch' && input.remote) answer({ result: { remote: true, disabledTools: [] } })
        else if (request.method === 'mcp/prompt' && input.prompt) {
          const reply = input.prompt(request, answer)
          if (reply) answer(reply)
        } else if (request.method === 'mcp/launch')
          answer({
            result: {
              command: process.execPath,
              args: [FAKE_MCP_STDIO],
              env: { PATH: process.env.PATH ?? '', FAKE_MCP_LOG: log, ...input.env },
              cwd: directory,
              disabledTools: input.disabledTools ?? [],
              ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
              ...(input.offHints ? { offHints: input.offHints } : {}),
            },
          })
        else if (request.method === 'mcp/call') {
          const reply = input.call ? input.call(request) : { result: { callId: '00000000-0000-4000-8000-000000000001' } }
          if (reply) answer(reply)
        } else answer({ result: {} })
      }
    })
  })
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const tokenFile = join(directory, 't.lbt')
  await writeFile(tokenFile, TOKEN, { mode: 0o600 })
  const lines = async () => {
    try {
      return (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
    } catch {
      return []
    }
  }
  return { socketPath, tokenFile, requests, lines, end: () => sockets.forEach(socket => socket.destroy()) }
}

/** Starts the bridge as an agent would from its `mcpServers` entry, with the agent's own variables, and speaks MCP to it. */
function start(socketPath: string, tokenFile: string) {
  const entry = mcpBridgeServer({ name: 'files', socketPath, tokenFile })
  const child: ChildProcessWithoutNullStreams = spawn(entry.command, entry.args, {
    env: { AGENT_SECRET: 'never-for-the-server', LATCH_THING: 'x' },
    stdio: 'pipe',
  })
  cleanups.push(() => child.kill())
  const replies = new Map<number, (message: any) => void>()
  const notes: any[] = []
  const completed: number[] = []
  let buffer = ''
  child.stdout.setEncoding('utf8').on('data', chunk => {
    buffer += chunk
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, end))
      buffer = buffer.slice(end + 1)
      if (message.id === undefined) notes.push(message)
      else {
        completed.push(message.id)
        replies.get(message.id)?.(message)
      }
    }
  })
  let next = 1
  const ask = (method: string, params?: unknown): Promise<any> => {
    const id = next++
    const reply = new Promise<any>(resolve => replies.set(id, resolve))
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`)
    return reply
  }
  const tell = (method: string, params?: unknown) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  const initialize = async () => {
    const reply = await ask('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: { sampling: {}, roots: {} },
      clientInfo: { name: 'agent' },
    })
    tell('notifications/initialized')
    return reply
  }
  return { entry, child, ask, tell, initialize, notes, completed }
}

describe('the latch-mcp bridge', () => {
  it('is the Host’s Node with fixed source and two paths, under the server’s name, with no environment, no token and no secret', () => {
    const entry = mcpBridgeServer({ name: 'github', socketPath: '/tmp/latch-x/tools/gateway.sock', tokenFile: '/tmp/latch-x/tools/a.lbt' })
    expect(entry).toMatchObject({ name: 'github', command: process.execPath, env: [] })
    expect(entry).not.toHaveProperty('type')
    expect(entry.args.slice(0, 2)).toEqual(['--disable-sigusr1', '-e'])
    expect(entry.args.slice(-2)).toEqual(['/tmp/latch-x/tools/gateway.sock', '/tmp/latch-x/tools/a.lbt'])
    expect(entry.args).toHaveLength(5)
  })

  it('takes its token only at initialize, then starts the server with exactly the Host’s environment and passes tools through', async () => {
    const gateway = await fakeGateway({ env: { API_TOKEN: 'server-secret' }, disabledTools: ['slow'] })
    const bridge = start(gateway.socketPath, gateway.tokenFile)
    // A throwaway copy asking the 2026 handshake starts nothing and leaves the token for the copy that lists tools.
    expect((await bridge.ask('server/discover', { supportedVersions: ['2026-07-28'] })).error).toMatchObject({ code: -32601 })
    expect(gateway.requests).toEqual([])
    expect((await stat(gateway.tokenFile)).isFile()).toBe(true)
    const init = await bridge.initialize()
    expect(init.result).toMatchObject({ serverInfo: { name: 'fake-mcp' }, capabilities: { tools: { listChanged: true } } })
    // Tools and prompts: resources the server has are not offered to the agent.
    expect(Object.keys(init.result.capabilities)).toEqual(['tools', 'prompts'])
    await expect(stat(gateway.tokenFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(gateway.requests[0]).toMatchObject({ method: 'mcp/launch', token: TOKEN })
    const listed = await bridge.ask('tools/list')
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['echo', 'env_names', 'where'])
    await waitFor(
      () => gateway.requests,
      requests => requests.some(request => request.method === 'mcp/report'),
    )
    expect(gateway.requests.find(request => request.method === 'mcp/report').params).toEqual({
      ok: true,
      tools: ['echo', 'slow', 'env_names', 'where'],
    })
    // The server sees the Host's list of variables and nothing of the agent's.
    const names = await bridge.ask('tools/call', { name: 'env_names', arguments: {} })
    // (macOS adds `__CF_USER_TEXT_ENCODING` to every process it starts.)
    expect(names.result.content[0].text.split(',').filter((name: string) => !name.startsWith('__CF_'))).toEqual([
      'API_TOKEN',
      'FAKE_MCP_LOG',
      'PATH',
    ])
    const started = (await gateway.lines()).find(line => line.event === 'start')
    expect(started.envNames).not.toContain('AGENT_SECRET')
    // It was not offered the agent's capabilities either.
    expect((await gateway.lines()).find(line => line.method === 'initialize').capabilities).toEqual({})
    // A tool switched off is refused without reaching the server or the record.
    const off = await bridge.ask('tools/call', { name: 'slow', arguments: { ms: 1 } })
    expect(off.result).toMatchObject({ isError: true })
    expect((await gateway.lines()).filter(line => line.tool === 'slow')).toEqual([])
  })

  it('gives Latch’s instructions in place of the server’s, and says what to do instead of a tool that is off', async () => {
    const own = await fakeGateway({ env: { FAKE_MCP_INSTRUCTIONS: 'Use run_steps.' }, disabledTools: ['slow'] })
    const plain = start(own.socketPath, own.tokenFile)
    // Without Latch's text, the server's own passes through, and a refusal says only that the tool is off.
    expect((await plain.initialize()).result.instructions).toBe('Use run_steps.')
    expect((await plain.ask('tools/call', { name: 'slow', arguments: {} })).result.content[0].text).toBe(
      'This tool is switched off in Latch.',
    )

    const gateway = await fakeGateway({
      env: { FAKE_MCP_INSTRUCTIONS: 'Use run_steps.' },
      disabledTools: ['slow', 'where'],
      instructions: 'Latch: one call per step.',
      offHints: { slow: 'Make one call per step instead.' },
    })
    const bridge = start(gateway.socketPath, gateway.tokenFile)
    expect((await bridge.initialize()).result.instructions).toBe('Latch: one call per step.')
    expect((await bridge.ask('tools/call', { name: 'slow', arguments: {} })).result).toEqual({
      content: [{ type: 'text', text: 'This tool is switched off in Latch. Make one call per step instead.' }],
      isError: true,
    })
    // A tool that is off with no hint: the refusal alone.
    expect((await bridge.ask('tools/call', { name: 'where', arguments: {} })).result.content[0].text).toBe(
      'This tool is switched off in Latch.',
    )
  })

  it('records each call before sending it, sends nothing when the record fails, and reports the outcome', async () => {
    let held = false
    let refuse = false
    const gateway = await fakeGateway({
      call: () => {
        if (refuse) return { error: { code: -32000, message: 'Latch could not record this call, so it was not made.' } }
        held = true
        return undefined
      },
    })
    const bridge = start(gateway.socketPath, gateway.tokenFile)
    await bridge.initialize()
    const pending = bridge.ask('tools/call', { name: 'echo', arguments: { text: 'hi' } })
    await waitFor(
      () => gateway.requests,
      requests => requests.some(request => request.method === 'mcp/call'),
    )
    expect(held).toBe(true)
    // Held at the gateway: the server has not been sent the call.
    expect((await gateway.lines()).filter(line => line.method === 'tools/call')).toEqual([])
    const call = gateway.requests.find(request => request.method === 'mcp/call')
    expect(call.params).toEqual({ tool: 'echo' })
    expect(JSON.stringify(call)).not.toContain('hi')
    refuse = true
    const refused = await bridge.ask('tools/call', { name: 'echo', arguments: { text: 'no' } })
    expect(refused.result).toEqual({
      content: [{ type: 'text', text: 'Latch could not record this call, so it was not made.' }],
      isError: true,
    })
    expect((await gateway.lines()).filter(line => line.method === 'tools/call')).toEqual([])
    void pending
  })

  it('answers a server that will not start with no tools and reports why, and ends the server when the gateway ends the token', async () => {
    const broken = await fakeGateway({ env: { FAKE_MCP_MODE: 'crash' } })
    const bridge = start(broken.socketPath, broken.tokenFile)
    const init = await bridge.initialize()
    expect(init.result).toMatchObject({ capabilities: { tools: {} } })
    expect((await bridge.ask('tools/list')).result).toEqual({ tools: [] })
    await waitFor(
      () => broken.requests,
      requests => requests.some(request => request.method === 'mcp/report'),
    )
    expect(broken.requests.find(request => request.method === 'mcp/report').params).toEqual({ ok: false, reason: 'exited' })
    expect((await bridge.ask('tools/call', { name: 'echo', arguments: {} })).result).toMatchObject({ isError: true })

    const live = await fakeGateway()
    const running = start(live.socketPath, live.tokenFile)
    await running.initialize()
    expect((await running.ask('tools/call', { name: 'echo', arguments: { text: 'one' } })).result.content[0].text).toBe('echo: one')
    // Removed in Latch: the gateway ends the connection, and the server's process group goes.
    live.end()
    await waitFor(live.lines, lines => lines.some(line => line.event === 'sigterm' || line.event === 'end'))
    expect((await running.ask('tools/call', { name: 'echo', arguments: {} })).result).toMatchObject({ isError: true })
  })

  it('declines the server’s own requests and passes only a changed tool list on', async () => {
    const gateway = await fakeGateway({ env: { FAKE_MCP_MODE: 'changed' } })
    const bridge = start(gateway.socketPath, gateway.tokenFile)
    await bridge.initialize()
    await waitFor(
      () => bridge.notes,
      notes => notes.length > 0,
    )
    expect(bridge.notes).toEqual([{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }])
    const asking = await fakeGateway({ env: { FAKE_MCP_MODE: 'ask' } })
    const other = start(asking.socketPath, asking.tokenFile)
    await other.initialize()
    await waitFor(asking.lines, lines => lines.some(line => line.event === 'reply'))
    expect(other.notes).toEqual([])
  })

  it('passes a local command’s prompts through, records each prompts/get first and sends none when the record fails', async () => {
    let refuse = false
    const gateway = await fakeGateway({
      prompt: () =>
        refuse ? { error: { code: -32000, message: 'Latch could not record this prompt, so it was not fetched.' } } : { result: {} },
    })
    const bridge = start(gateway.socketPath, gateway.tokenFile)
    // Prompts are offered as a plain capability; resources are not.
    expect((await bridge.initialize()).result.capabilities).toEqual({ tools: { listChanged: true }, prompts: {} })
    const listed = await bridge.ask('prompts/list')
    expect(listed.result.prompts.map((prompt: { name: string }) => prompt.name)).toContain('review')
    const got = await bridge.ask('prompts/get', { name: 'review', arguments: { topic: 'the plan' } })
    expect(got.result.messages[0].content.text).toBe('Review the plan in a plain tone.')
    const record = gateway.requests.find(request => request.method === 'mcp/prompt')
    // The gateway hears the prompt's name alone: no argument and no text.
    expect(record.params).toEqual({ prompt: 'review' })
    expect(JSON.stringify(gateway.requests)).not.toContain('the plan')
    const lines = await gateway.lines()
    expect(lines.filter(line => line.method === 'prompts/get')).toEqual([
      expect.objectContaining({ prompt: 'review', argumentNames: ['topic'] }),
    ])
    refuse = true
    const refused = await bridge.ask('prompts/get', { name: 'hello' })
    expect(refused.error).toEqual({ code: -32000, message: 'Latch could not record this prompt, so it was not fetched.' })
    expect((await gateway.lines()).filter(line => line.method === 'prompts/get')).toHaveLength(1)
  })

  it('ignores a child’s prompt response while audit and provenance are pending', async () => {
    let approve: ((reply: unknown) => void) | undefined
    const gateway = await fakeGateway({
      env: { FAKE_MCP_MODE: 'early-prompt' },
      prompt: (_, answer) => {
        approve = answer
      },
    })
    const bridge = start(gateway.socketPath, gateway.tokenFile)
    await bridge.initialize()
    let finished = 0
    const requested = bridge.ask('prompts/get', { name: 'hello' }).then(reply => {
      finished++
      return reply
    })
    await waitFor(() => approve, Boolean)
    // The fake server responds to ID 2 before it answers the ping. Its stdout is ordered.
    expect((await bridge.ask('ping')).result).toEqual({})
    expect(finished).toBe(0)
    const error = { code: -32000, message: 'The prompt could not be marked.' }
    approve!({ error })
    expect((await requested).error).toEqual(error)
    expect((await gateway.lines()).filter(line => line.method === 'prompts/get')).toEqual([])
  })

  it('cancels a held prompt without sending the request or its cancellation to the child', async () => {
    let approve: ((reply: unknown) => void) | undefined
    const gateway = await fakeGateway({
      prompt: (_, answer) => {
        approve = answer
      },
    })
    const bridge = start(gateway.socketPath, gateway.tokenFile)
    await bridge.initialize()
    const pending = bridge.ask('prompts/get', { name: 'hello' })
    await waitFor(() => approve, Boolean)
    bridge.tell('notifications/cancelled', { requestId: 2 })
    expect((await bridge.ask('ping')).result).toEqual({})
    approve!({ result: {} })
    expect((await pending).error.message).toBe('The prompt was not fetched.')
    expect((await gateway.lines()).filter(line => ['prompts/get', 'notifications/cancelled'].includes(line.method))).toEqual([])
  })

  it('settles a held prompt once if the gateway closes its bridge', async () => {
    const gateway = await fakeGateway({ prompt: () => undefined })
    const bridge = start(gateway.socketPath, gateway.tokenFile)
    await bridge.initialize()
    const pending = bridge.ask('prompts/get', { name: 'hello' })
    await waitFor(
      () => gateway.requests,
      requests => requests.some(request => request.method === 'mcp/prompt'),
    )
    gateway.end()
    const reply = await pending
    expect(reply.error).toEqual({ code: -32000, message: 'This MCP server is not running.' })
    // A later request is handled after the disconnect and its waiting promise continuations.
    expect((await bridge.ask('ping')).result).toEqual({})
    expect(bridge.completed.filter(id => id === reply.id)).toHaveLength(1)
  })

  it('offers an agent no prompts of a remote server', async () => {
    const gateway = await fakeGateway({ remote: true })
    const bridge = start(gateway.socketPath, gateway.tokenFile)
    expect((await bridge.initialize()).result.capabilities).toEqual({ tools: {} })
    expect((await bridge.ask('prompts/list')).error).toMatchObject({ code: -32601 })
    expect((await bridge.ask('prompts/get', { name: 'hello' })).error).toMatchObject({ code: -32601 })
    expect(gateway.requests.filter(request => request.method === 'mcp/prompt' || request.params?.method?.startsWith('prompts/'))).toEqual(
      [],
    )
  })
})
