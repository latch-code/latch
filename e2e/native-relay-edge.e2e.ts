import { createServer, type Server } from 'node:https'
import { webcrypto } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { Duplex } from 'node:stream'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { encodeFrame, WebSocketParser } from '@latch/link-wire'
import { createTransportCertificate, nodeCrypto } from '@latch/link-client'
import { acceptKey } from '@latch/link-client/websocket'
import { createEdgeWorker } from '@latch/relay-edge/edge'
import { EdgeNode } from '@latch/relay-edge/node'
import type { EdgeEnv, EdgePlatform, EdgeRequest, EdgeResponse, EdgeSubtle, EdgeWebSocket } from '@latch/relay-edge/platform'
import type { NativeLinkInfo, NativeRelayTest } from '@latch/protocol'
import { startTestHost } from './helpers/host.ts'

/**
 * 添加中继 for a person's own edge relay, end to end on this Mac: the real Host adds it from a relay file (with the local
 * confirmation the test backend answers), dials it through real TLS and WebSocket framing, tests it, turns it off and on,
 * refuses a file whose key does not match, and removes it. The node is the real edge adapter on a fake Workers platform.
 */
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run()
})

class Response implements EdgeResponse {
  constructor(
    readonly status: number,
    readonly body?: string,
    readonly socket?: ServerSide,
  ) {}
  text() {
    return Promise.resolve(this.body ?? '')
  }
}
/** The node's half of a WebSocket; `deliver` and `shut` are bound to the TLS socket once upgraded. */
class ServerSide implements EdgeWebSocket {
  deliver: (payload: Uint8Array) => void = () => {}
  shut: (code: number) => void = () => {}
  private closed = false
  private readonly listeners = new Map<string, Array<(event: { data: unknown }) => void>>()
  accept() {}
  send(data: ArrayBuffer | Uint8Array) {
    if (this.closed) throw new Error('closed')
    this.deliver(new Uint8Array(data instanceof Uint8Array ? data : data))
  }
  close(code?: number) {
    if (this.closed) return
    this.closed = true
    this.shut(code ?? 1000)
    setImmediate(() => this.emit('close'))
  }
  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  emit(type: string, event: { data: unknown } = { data: undefined }) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

async function edgeRelay(seed: Uint8Array, relayId: string, token: Uint8Array) {
  const certificate = createTransportCertificate(Date.now(), 3_600_000, 'localhost')
  const platform: EdgePlatform = {
    subtle: webcrypto.subtle as unknown as EdgeSubtle,
    random: size => webcrypto.getRandomValues(new Uint8Array(size)),
    now: () => Date.now(),
    respond: (status, body) => new Response(status, body),
    pair: () => {
      const server = new ServerSide()
      return [server, server]
    },
    upgrade: client => new Response(101, undefined, client as ServerSide),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: handle => clearInterval(handle as NodeJS.Timeout),
  }
  const nodes = new Map<string, EdgeNode>()
  const request = (url: string, method: string, headers: Record<string, string>): EdgeRequest => {
    const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
    return { method, url, headers: { get: name => lower.get(name.toLowerCase()) ?? null }, arrayBuffer: async () => new ArrayBuffer(0) }
  }
  const env: EdgeEnv = {
    NODE_HOSTS: 'localhost',
    LOCATION_HINT: 'apac-ne',
    RELAY_ID: relayId,
    RELAY_SIGNING_SEED: Buffer.from(seed).toString('hex'),
    REGISTRATION_TOKEN: Buffer.from(token).toString('hex'),
    NODE: {
      idFromName: name => name,
      get: id => ({
        fetch: async (url, init) => {
          let node = nodes.get(id as string)
          if (!node) {
            const database = new DatabaseSync(':memory:')
            node = new EdgeNode(
              {
                storage: {
                  sql: {
                    exec: (query, ...bindings) => {
                      const statement = database.prepare(query)
                      const rows = /^\s*select/iu.test(query)
                        ? (statement.all(...bindings) as Array<Record<string, unknown>>)
                        : (statement.run(...bindings), [])
                      return { toArray: () => rows }
                    },
                  },
                  setAlarm: async () => {},
                },
                blockConcurrencyWhile: callback => callback(),
              },
              env,
              platform,
            )
            await Promise.resolve()
            nodes.set(id as string, node)
          }
          return node.fetch(request(url, init.method, init.headers))
        },
      }),
    },
  }
  const worker = createEdgeWorker(platform)
  const server: Server = createServer({ cert: certificate.cert, key: certificate.key, minVersion: 'TLSv1.3', ALPNProtocols: ['http/1.1'] })
  server.on('upgrade', (incoming, raw: Duplex, head: Buffer) => {
    const headers: Record<string, string> = { 'cf-connecting-ip': '127.0.0.1' }
    for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers[name] = value
    void worker.fetch(request(`https://localhost${incoming.url}`, incoming.method ?? 'GET', headers), env).then(response => {
      const socket = (response as Response).socket
      if (response.status !== 101 || !socket) {
        raw.end(`HTTP/1.1 ${response.status} Refused\r\nContent-Length: 0\r\n\r\n`)
        return
      }
      raw.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(String(incoming.headers['sec-websocket-key']))}\r\nSec-WebSocket-Protocol: latch-relay.2\r\n\r\n`,
      )
      const parser = new WebSocketParser(true)
      socket.deliver = payload => {
        if (!raw.destroyed) raw.write(encodeFrame({ opcode: 2, payload }))
      }
      socket.shut = code => {
        if (!raw.destroyed) raw.end(encodeFrame({ opcode: 8, payload: Uint8Array.of(code >> 8, code & 255) }))
      }
      const feed = (chunk: Buffer) => {
        try {
          for (const frame of parser.feed(chunk)) {
            if (frame.opcode === 2) {
              const data = frame.payload.buffer.slice(frame.payload.byteOffset, frame.payload.byteOffset + frame.payload.byteLength)
              socket.emit('message', { data })
            } else if (frame.opcode === 9) raw.write(encodeFrame({ opcode: 10, payload: frame.payload }))
            else if (frame.opcode === 8) raw.destroy()
          }
        } catch {
          raw.destroy()
        }
      }
      if (head.length) feed(head)
      raw.on('data', feed)
      raw.on('close', () => socket.emit('close'))
      raw.on('error', () => {})
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanup.push(async () => {
    for (const node of nodes.values()) node.dispose()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  return { port: (server.address() as AddressInfo).port, certificate }
}

it('adds an own edge relay from its file, tests it, turns it off and on, refuses a wrong key and removes it', async () => {
  const seed = nodeCrypto.random(32),
    token = nodeCrypto.random(32),
    relayId = Buffer.from(nodeCrypto.random(16)).toString('hex')
  const relay = await edgeRelay(seed, relayId, token)
  const host = await startTestHost({
    native: { host: '127.0.0.1', port: 0 },
    nativeRelayCa: relay.certificate.cert,
    egressLookup: (_hostname, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]),
  })
  cleanup.push(() => host.close())
  const desktop = await host.enroll({ listener: 'unix' })
  expect(
    (await desktop.confirmed('policy', { method: 'PATCH', body: { hostEgressAllow: { add: [`localhost:${relay.port}`] } } })).status,
  ).toBe(200)
  const file = {
    relayId,
    url: `https://localhost:${relay.port}/`,
    kind: 'edge' as const,
    relayKey: Buffer.from(await nodeCrypto.publicKey(seed)).toString('hex'),
    registrationKey: `lrt1.${Buffer.from(token).toString('base64url')}`,
  }

  // A file naming another key: the node's signature does not match, and the step says so.
  const wrong = {
    requestId: crypto.randomUUID(),
    profile: { ...file, relayKey: Buffer.from(await nodeCrypto.publicKey(nodeCrypto.random(32))).toString('hex') },
  }
  const refused = await desktop.confirmed('native/relays', { method: 'POST', body: wrong })
  expect(refused.status).toBe(503)
  expect(((await refused.json()) as { error: string }).error).toBe('native-relay-key-mismatch')
  expect((await desktop.request(`native/relay-requests/${wrong.requestId}`, { method: 'DELETE' })).status).toBe(200)

  const added = await desktop.confirmed('native/relays', { method: 'POST', body: { requestId: crypto.randomUUID(), profile: file } })
  expect(added.status).toBe(201)
  const info = (await added.json()) as NativeLinkInfo
  const keyHash = Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from(file.relayKey, 'hex')))
    .toString('hex')
    .slice(0, 8)
  expect(info.relays).toMatchObject([{ relayId, kind: 'edge', addresses: 1, keyHash }])
  expect(JSON.stringify(info)).not.toContain(file.registrationKey)
  await vi.waitFor(
    async () =>
      expect((await desktop.json<NativeLinkInfo>('native/info')).relays[0]).toMatchObject({
        status: 'connected',
        latencyMs: expect.any(Number),
      }),
    { timeout: 10_000 },
  )

  const tested = await desktop.json<NativeRelayTest>(`native/relays/${relayId}/test`, { method: 'POST', body: {} })
  expect(tested).toMatchObject({ reached: 'registered', latencyMs: expect.any(Number) })
  expect(tested.failure).toBeUndefined()

  expect(
    (await desktop.json<NativeLinkInfo>(`native/relays/${relayId}`, { method: 'PATCH', body: { disabled: true } })).relays[0],
  ).toMatchObject({
    status: 'disabled',
  })
  expect(
    (await desktop.json<NativeLinkInfo>(`native/relays/${relayId}`, { method: 'PATCH', body: { disabled: false } })).relays[0]?.status,
  ).not.toBe('disabled')

  expect((await desktop.json<NativeLinkInfo>(`native/relays/${relayId}`, { method: 'DELETE' })).relays).toEqual([])
}, 60_000)
