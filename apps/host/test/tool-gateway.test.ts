import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gatewayRefusal, ToolGatewayServer, type GatewayCall } from '../src/tool-gateway.ts'

const cleanups: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const TOOLS = [
  { name: 'browser_tabs', description: 'tabs', inputSchema: { type: 'object' } },
  { name: 'browser_wait', description: 'wait', inputSchema: { type: 'object' } },
]

async function gateway(admits?: (sessionId: string) => boolean) {
  const root = await mkdtemp(join(tmpdir(), 'lbt-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const calls: GatewayCall[] = []
  const server = new ToolGatewayServer({
    socketPath: join(root, 'tools', 'gateway.sock'),
    ...(admits ? { admits } : {}),
    tools: () => TOOLS,
    call: async input => {
      calls.push(input)
      if (input.tool === 'browser_wait') {
        await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }))
        // main takes a while to report the stopped call, and cannot say whether it acted.
        await new Promise(resolve => setTimeout(resolve, 100))
        return { content: [{ type: 'text', text: 'stopped' }], isError: true, unknown: true as const }
      }
      return { content: [{ type: 'text', text: `${input.tool} for ${input.sessionId}` }] }
    },
  })
  await server.start()
  cleanups.push(() => server.close())
  return { root, server, calls, socketPath: join(root, 'tools', 'gateway.sock') }
}

/** A connection that sends request lines and reads reply lines; `closed` resolves when the gateway ends it. */
function connect(socketPath: string) {
  const socket: Socket = createConnection(socketPath)
  cleanups.push(() => socket.destroy())
  const replies: any[] = []
  const waiters = new Set<() => void>()
  let buffer = ''
  socket.setEncoding('utf8').on('data', chunk => {
    buffer += chunk
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      replies.push(JSON.parse(buffer.slice(0, end)))
      buffer = buffer.slice(end + 1)
      for (const wake of [...waiters]) wake()
    }
  })
  const closed = new Promise<void>(resolve => socket.once('close', () => resolve()))
  return {
    socket,
    closed,
    send: (message: unknown) => socket.write(typeof message === 'string' ? message : `${JSON.stringify(message)}\n`),
    reply: (id: unknown) =>
      new Promise<any>(resolve => {
        const look = () => {
          const found = replies.find(item => item.id === id)
          if (!found) return
          waiters.delete(look)
          resolve(found)
        }
        waiters.add(look)
        look()
      }),
  }
}

describe('the tool gateway', () => {
  it('listens only on a 0600 Unix socket in a 0700 directory, and is gone with its directory when closed', async () => {
    const { server, root, socketPath } = await gateway()
    expect((await stat(join(root, 'tools'))).mode & 0o777).toBe(0o700)
    const socket = await stat(socketPath)
    expect(socket.isSocket()).toBe(true)
    expect(socket.mode & 0o777).toBe(0o600)
    // No TCP port: `address()` of a Unix listener is its path.
    expect((server as unknown as { server: { address(): unknown } }).server.address()).toBe(socketPath)
    await server.close()
    await expect(stat(join(root, 'tools'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('mints an lbt1. token per lease, keeps only its hash, and checks it on every request', async () => {
    const { server, socketPath, calls } = await gateway()
    const lease = server.open({ sessionId: 'session-a' })!
    expect(lease.token).toMatch(/^lbt1\.[A-Za-z0-9_-]{43}$/u)
    // Handed over in a private file beside the socket, gone when the lease ends.
    const file = await stat(lease.tokenFile)
    expect([file.isFile(), file.mode & 0o777]).toEqual([true, 0o600])
    expect(await readFile(lease.tokenFile, 'utf8')).toBe(lease.token)
    const short = server.open({ sessionId: 'session-a' })!
    short.close()
    await expect(stat(short.tokenFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(short.token).not.toBe(lease.token)
    const held = JSON.stringify([...(server as unknown as { bindings: Map<string, unknown> }).bindings.keys()])
    expect(held).not.toContain(lease.token)
    const client = connect(socketPath)
    client.send({ id: 1, token: lease.token, method: 'tools/list' })
    expect((await client.reply(1)).result.tools.map((tool: { name: string }) => tool.name)).toEqual(['browser_tabs', 'browser_wait'])
    client.send({ id: 2, token: lease.token, method: 'tools/call', params: { name: 'browser_tabs', arguments: {} } })
    expect((await client.reply(2)).result).toEqual({ content: [{ type: 'text', text: 'browser_tabs for session-a' }] })
    expect(calls.map(call => [call.sessionId, call.tool])).toEqual([['session-a', 'browser_tabs']])
    // A tool the gateway does not serve, or arguments that are not an object.
    client.send({ id: 3, token: lease.token, method: 'tools/call', params: { name: 'shell', arguments: {} } })
    expect((await client.reply(3)).error).toMatchObject({ code: -32602 })
    client.send({ id: 4, token: lease.token, method: 'tools/call', params: { name: 'browser_tabs', arguments: [] } })
    expect((await client.reply(4)).error).toMatchObject({ code: -32602 })
    // Revoked between two requests on the same connection: refused, and the connection ends.
    lease.close()
    expect(lease.active()).toBe(false)
    client.send({ id: 5, token: lease.token, method: 'tools/list' })
    expect((await client.reply(5)).error).toMatchObject({ code: -32001 })
    await client.closed
    expect(calls).toHaveLength(1)
  })

  it('mints no token for a session it does not admit now', async () => {
    let provider = false
    const { server } = await gateway(() => provider)
    expect(server.open({ sessionId: 'session-e' })).toBeUndefined()
    provider = true
    expect(server.open({ sessionId: 'session-e' })?.token).toMatch(/^lbt1\./u)
  })

  it('refuses a wrong token, an old one, and one of a session that ended', async () => {
    const { server, socketPath } = await gateway()
    const wrong = connect(socketPath)
    wrong.send({ id: 1, token: `lbt1.${'x'.repeat(43)}`, method: 'tools/list' })
    expect((await wrong.reply(1)).error).toMatchObject({ code: -32001 })
    await wrong.closed
    const old = server.open({ sessionId: 'session-b' })!
    old.close()
    const fresh = server.open({ sessionId: 'session-b' })!
    const stale = connect(socketPath)
    stale.send({ id: 1, token: old.token, method: 'tools/list' })
    expect((await stale.reply(1)).error).toMatchObject({ code: -32001 })
    server.revokeSession('session-b', 'deleted')
    expect(fresh.active()).toBe(false)
    const ended = connect(socketPath)
    ended.send({ id: 1, token: fresh.token, method: 'tools/list' })
    expect((await ended.reply(1)).error).toMatchObject({ code: -32001 })
  })

  it('tells the process of an archived session why its token stopped working', async () => {
    const { server, socketPath } = await gateway()
    const lease = server.open({ sessionId: 'session-f' })!
    server.revokeSession('session-f', 'archived')
    const client = connect(socketPath)
    client.send({ id: 1, token: lease.token, method: 'tools/list' })
    expect((await client.reply(1)).error.message).toContain('会话恢复（Agent 进程重新启动）后再试')
    await expect(stat(lease.tokenFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('answers nothing to a request that is not its protocol, such as a page’s HTTP request', async () => {
    const { server, socketPath, calls } = await gateway()
    server.open({ sessionId: 'session-c' })
    const page = connect(socketPath)
    page.send('GET /link/api/host-info HTTP/1.1\r\nHost: localhost\r\n\r\n')
    await page.closed
    const tokenless = connect(socketPath)
    tokenless.send({ id: 1, method: 'tools/call', params: { name: 'browser_tabs', arguments: {} } })
    expect((await tokenless.reply(1)).error).toMatchObject({ code: -32001 })
    expect(calls).toEqual([])
  })

  it('stops a call on its cancel, on a stop of the turn, on the revocation of its token and when its connection ends', async () => {
    const { server, socketPath, calls } = await gateway()
    const lease = server.open({ sessionId: 'session-d', describe: tool => ({ toolCallId: `row-${tool}` }) })!
    const client = connect(socketPath)
    const wait = (id: number) =>
      client.send({ id, token: lease.token, method: 'tools/call', params: { name: 'browser_wait', arguments: { tabId: 'x' } } })
    wait(1)
    await expect.poll(() => calls.length).toBe(1)
    expect(calls[0]!.context).toEqual({ toolCallId: 'row-browser_wait' })
    client.send({ id: 1, token: lease.token, method: 'cancel' })
    expect((await client.reply(1)).result).toEqual({ content: [{ type: 'text', text: 'stopped' }], isError: true })
    wait(2)
    await expect.poll(() => calls.length).toBe(2)
    // A stop of the turn: settled only once the call ended, and it says the result is unknown.
    lease.cancel()
    let ended = false
    const settled = lease.settled().then(answer => ((ended = true), answer))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(ended).toBe(false)
    expect(await settled).toEqual({ resultUnknown: true })
    expect((await client.reply(2)).result.content[0].text).toBe('stopped')
    expect(await lease.settled()).toEqual({ resultUnknown: false })
    expect(lease.active()).toBe(true)
    wait(3)
    await expect.poll(() => calls.length).toBe(3)
    lease.close()
    expect((await client.reply(3)).result.content[0].text).toBe('stopped')
    const other = server.open({ sessionId: 'session-d' })!
    const gone = connect(socketPath)
    gone.send({ id: 1, token: other.token, method: 'tools/call', params: { name: 'browser_wait', arguments: {} } })
    await expect.poll(() => calls.length).toBe(4)
    gone.socket.destroy()
    await expect.poll(() => calls[3]!.signal.aborted).toBe(true)
  })
})

describe('which gateway calls are refused before the broker', () => {
  const summary = { status: 'running' as const }
  const acp = { kind: 'acp', level: 'L3' }
  it('takes only a running turn of a project session on a full-access ACP harness', () => {
    expect(gatewayRefusal(summary, acp, 'running')).toBeUndefined()
    expect(gatewayRefusal({ status: 'waiting-approval' }, acp, 'running')).toBeUndefined()
    expect(gatewayRefusal(undefined, acp, 'running')).toBe('no-project')
    for (const flag of [
      { archived: true },
      { agent: { customAgentId: 'agt_1' } },
      { personal: { assistantId: 'a' } },
      { generalChat: true as const },
      { mode: 'chat' as const },
    ])
      expect(gatewayRefusal({ ...summary, ...flag } as never, acp, 'running'), JSON.stringify(flag)).toBe('no-project')
    expect(gatewayRefusal(summary, { kind: 'builtin', level: 'L1' }, 'running')).toBe('not-full-access')
    expect(gatewayRefusal(summary, { kind: 'plugin', level: 'L3' }, 'running')).toBe('not-full-access')
    expect(gatewayRefusal(summary, undefined, 'running')).toBe('not-full-access')
    expect(gatewayRefusal(summary, acp, 'stopping')).toBe('stopping')
    expect(gatewayRefusal(summary, acp, 'none')).toBe('no-turn')
    expect(gatewayRefusal(summary, acp, undefined)).toBe('no-turn')
    expect(gatewayRefusal({ status: 'idle' }, acp, 'running')).toBe('no-turn')
  })
})
