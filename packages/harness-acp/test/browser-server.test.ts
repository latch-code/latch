import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BROWSER_INSTRUCTIONS, browserServer } from '../src/browser-server.ts'

const cleanups: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const TOKEN = `lbt1.${'k'.repeat(43)}`

/** A stand-in for the Host's tool gateway: records each request line and answers through `answer`. */
async function fakeGateway(answer: (request: any, socket: Socket) => unknown) {
  const directory = await mkdtemp(join(tmpdir(), 'lbt-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const socketPath = join(directory, 'g.sock')
  const requests: any[] = []
  const server: Server = createServer(socket => {
    let buffer = ''
    socket.setEncoding('utf8').on('data', chunk => {
      buffer += chunk
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const request = JSON.parse(buffer.slice(0, end))
        buffer = buffer.slice(end + 1)
        requests.push(request)
        const reply = answer(request, socket)
        if (reply !== undefined) socket.write(`${JSON.stringify(reply)}\n`)
      }
    })
  })
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const tokenFile = join(directory, 't.lbt')
  await writeFile(tokenFile, TOKEN, { mode: 0o600 })
  return { socketPath, tokenFile, requests, server }
}

/** Starts the server as an agent would from its `mcpServers` entry, and speaks MCP to it over stdio. */
function start(socketPath: string, tokenFile: string) {
  const entry = browserServer({ socketPath, tokenFile })
  const child: ChildProcessWithoutNullStreams = spawn(entry.command, entry.args, { env: {}, stdio: 'pipe' })
  cleanups.push(() => child.kill())
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))
  const replies = new Map<number, (message: any) => void>()
  let buffer = ''
  child.stdout.setEncoding('utf8').on('data', chunk => {
    buffer += chunk
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, end))
      buffer = buffer.slice(end + 1)
      replies.get(message.id)?.(message)
    }
  })
  let next = 1
  return {
    entry,
    exited,
    ask(method: string, params?: unknown): { id: number; reply: Promise<any> } {
      const id = next++
      const reply = new Promise<any>(resolve => replies.set(id, resolve))
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`)
      return { id, reply }
    },
    tell(method: string, params?: unknown) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`)
    },
  }
}

describe('the latch-browser MCP server', () => {
  it('is the Host’s Node with fixed source and two paths as arguments, with no environment and no token', () => {
    const entry = browserServer({ socketPath: '/tmp/latch-x/tools/gateway.sock', tokenFile: '/tmp/latch-x/tools/a.lbt' })
    expect(entry).toMatchObject({ name: 'latch-browser', command: process.execPath, env: [] })
    expect(entry).not.toHaveProperty('type')
    expect(entry.args.slice(0, 2)).toEqual(['--disable-sigusr1', '-e'])
    expect(entry.args.slice(-2)).toEqual(['/tmp/latch-x/tools/gateway.sock', '/tmp/latch-x/tools/a.lbt'])
    expect(JSON.stringify(entry)).not.toContain('lbt1.')
  })

  it('refuses to start without its private token file, and deletes the file once it reaches the gateway', async () => {
    const gateway = await fakeGateway(request => ({ id: request.id, result: { tools: [] } }))
    expect(await start(gateway.socketPath, `${gateway.tokenFile}.missing`).exited).toBe(1)
    await chmod(gateway.tokenFile, 0o644)
    expect(await start(gateway.socketPath, gateway.tokenFile).exited).toBe(1)
    await chmod(gateway.tokenFile, 0o600)
    // A throwaway copy that only answers the handshake leaves the file for the copy that lists tools.
    const probe = start(gateway.socketPath, gateway.tokenFile)
    await probe.ask('initialize', { protocolVersion: '2025-11-25' }).reply
    expect((await stat(gateway.tokenFile)).isFile()).toBe(true)
    const server = start(gateway.socketPath, gateway.tokenFile)
    expect((await server.ask('tools/list').reply).result).toEqual({ tools: [] })
    expect(gateway.requests).toEqual([{ id: 1, token: TOKEN, method: 'tools/list' }])
    await expect(stat(gateway.tokenFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('answers initialize itself and forwards tools/list and tools/call with the token on every request', async () => {
    const gateway = await fakeGateway(request =>
      request.method === 'tools/list'
        ? { id: request.id, result: { tools: [{ name: 'browser_tabs', description: 'tabs', inputSchema: { type: 'object' } }] } }
        : { id: request.id, result: { content: [{ type: 'text', text: `called ${request.params.name}` }] } },
    )
    const server = start(gateway.socketPath, gateway.tokenFile)
    const init = await server.ask('initialize', { protocolVersion: '2025-11-25', capabilities: {} }).reply
    expect(init.result).toMatchObject({ protocolVersion: '2025-11-25', serverInfo: { name: 'latch-browser' } })
    // The few rules the tools need, as the server's instructions.
    expect(init.result.instructions).toBe(BROWSER_INSTRUCTIONS)
    expect(BROWSER_INSTRUCTIONS).toMatch(/browser_viewport[^\n]*then browser_read/u)
    expect(gateway.requests).toEqual([])
    const listed = await server.ask('tools/list').reply
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['browser_tabs'])
    const called = await server.ask('tools/call', { name: 'browser_tabs', arguments: {} }).reply
    expect(called.result).toEqual({ content: [{ type: 'text', text: 'called browser_tabs' }] })
    expect(gateway.requests).toEqual([
      { id: 1, token: TOKEN, method: 'tools/list' },
      { id: 2, token: TOKEN, method: 'tools/call', params: { name: 'browser_tabs', arguments: {} } },
    ])
    expect((await server.ask('resources/list').reply).error).toMatchObject({ code: -32601 })
  })

  it('forwards a cancel of a call, and turns a refusal of the gateway into a failed call', async () => {
    const gateway = await fakeGateway(request => {
      if (request.method === 'cancel') return { id: request.id, result: { content: [{ type: 'text', text: 'stopped' }], isError: true } }
      if (request.params?.name === 'browser_wait') return undefined
      return { id: request.id, error: { code: -32001, message: 'The Latch tool token is not valid.' } }
    })
    const server = start(gateway.socketPath, gateway.tokenFile)
    const waiting = server.ask('tools/call', { name: 'browser_wait', arguments: { tabId: 'x' } })
    await expect.poll(() => gateway.requests.length).toBe(1)
    server.tell('notifications/cancelled', { requestId: waiting.id })
    expect((await waiting.reply).result).toEqual({ content: [{ type: 'text', text: 'stopped' }], isError: true })
    expect(gateway.requests[1]).toEqual({ id: gateway.requests[0].id, token: TOKEN, method: 'cancel' })
    const refused = await server.ask('tools/call', { name: 'browser_tabs', arguments: {} }).reply
    expect(refused.result).toEqual({ content: [{ type: 'text', text: 'The Latch tool token is not valid.' }], isError: true })
  })

  it('says the tools are unavailable when the gateway is not there', async () => {
    const gateway = await fakeGateway(() => undefined)
    const server = start(join(tmpdir(), `latch-missing-${process.pid}.sock`), gateway.tokenFile)
    const called = await server.ask('tools/call', { name: 'browser_tabs', arguments: {} }).reply
    expect(called.result.isError).toBe(true)
    expect(called.result.content[0].text).toContain('not reachable')
  })
})
