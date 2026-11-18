import { createServer, type Server } from 'node:https'
import { webcrypto } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { encodeFrame, hex, WebSocketParser } from '@latch/link-wire'
import { acceptKey } from '@latch/link-client/websocket'
import { createEdgeWorker } from '../src/edge.ts'
import type { EdgeEnv, EdgePlatform, EdgeSubtle, EdgeWebSocket } from '../src/platform.ts'
import { ClientSocket, FakeObjects, FakeResponse, request } from './harness.ts'

function realPlatform(): EdgePlatform {
  return {
    subtle: webcrypto.subtle as unknown as EdgeSubtle,
    random: size => webcrypto.getRandomValues(new Uint8Array(size)),
    now: () => Date.now(),
    respond: (status, body, headers) => new FakeResponse(status, body, headers),
    pair() {
      const client = new ClientSocket()
      const server = new (class {
        listeners = new Map<string, Array<(event: { data: unknown }) => void>>()
        closed = false
        bufferedAmount = 0
        binaryType: EdgeWebSocket['binaryType'] = 'blob'
        accept() {}
        send(data: Uint8Array) {
          if (this.closed) throw new Error('closed')
          this.bufferedAmount += data.length
          client.deliver(new Uint8Array(data), () => (this.bufferedAmount -= data.length))
        }
        close(code?: number) {
          if (this.closed) return
          this.closed = true
          client.shut(code ?? 1000)
        }
        addEventListener(type: string, listener: (event: { data: unknown }) => void) {
          this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
        }
        emit(type: string, event: { data: unknown } = { data: undefined }) {
          for (const listener of this.listeners.get(type) ?? []) listener(event)
        }
      })()
      client.server = server as never
      return [client, server]
    },
    upgrade: (client, protocol) => new FakeResponse(101, undefined, { 'Sec-WebSocket-Protocol': protocol }, client as ClientSocket),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: handle => clearInterval(handle as NodeJS.Timeout),
  }
}

/**
 * The edge Worker and node objects behind a local TLS server with the framing the edge puts on the wire. Like the
 * edge, it answers WebSocket pings itself.
 */
export async function startTlsEdge(options: {
  seed: Uint8Array
  relayId: Uint8Array
  certificate: { cert: string; key: string }
  env?: Partial<EdgeEnv>
}): Promise<{ url: URL; objects: FakeObjects; close(): Promise<void> }> {
  const { seed, relayId, certificate } = options
  const platform = realPlatform()
  let env: EdgeEnv = {}
  const objects = new FakeObjects(platform, () => env)
  env = {
    NODE: objects.namespace(),
    NODE_HOSTS: 'localhost',
    LOCATION_HINT: 'apac-ne',
    RELAY_ID: hex(relayId),
    OPEN_REGISTRATION: 'true',
    RELAY_SIGNING_SEED: hex(seed),
    ...options.env,
  }
  const worker = createEdgeWorker(platform)
  const server: Server = createServer({ cert: certificate.cert, key: certificate.key, minVersion: 'TLSv1.3', ALPNProtocols: ['http/1.1'] })
  // Plain requests (health, admin) are answered by the Worker as on the edge.
  server.on('request', (incoming, outgoing) => {
    const headers: Record<string, string> = { 'cf-connecting-ip': '127.0.0.1' }
    for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers[name] = value
    void worker.fetch(request(`https://localhost${incoming.url}`, incoming.method, headers), env).then(response => {
      const answer = response as FakeResponse
      outgoing.writeHead(answer.status, answer.headers).end(answer.body ?? '')
    })
  })
  server.on('upgrade', (incoming, raw: Duplex, head: Buffer) => {
    const headers: Record<string, string> = { 'cf-connecting-ip': '127.0.0.1' }
    for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers[name] = value
    void worker.fetch(request(`https://localhost${incoming.url}`, incoming.method, headers), env).then(response => {
      const client = (response as FakeResponse).client
      if (response.status !== 101 || !client) {
        raw.end(`HTTP/1.1 ${response.status} Refused\r\nContent-Length: 0\r\n\r\n`)
        return
      }
      raw.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(String(incoming.headers['sec-websocket-key']))}\r\nSec-WebSocket-Protocol: latch-relay.2\r\n\r\n`,
      )
      const parser = new WebSocketParser(true)
      client.deliver = (payload, written) => {
        if (!raw.destroyed) raw.write(encodeFrame({ opcode: 2, payload }), () => written?.())
      }
      client.shut = code => {
        client.closed = code
        if (!raw.destroyed) raw.end(encodeFrame({ opcode: 8, payload: Uint8Array.of(code >> 8, code & 255) }))
      }
      const feed = (chunk: Buffer) => {
        try {
          for (const frame of parser.feed(chunk)) {
            if (frame.opcode === 2) client.raw(frame.payload)
            else if (frame.opcode === 9) raw.write(encodeFrame({ opcode: 10, payload: frame.payload }))
            else if (frame.opcode === 8) raw.destroy()
          }
        } catch {
          raw.destroy()
        }
      }
      if (head.length) feed(head)
      raw.on('data', feed)
      raw.on('close', () => client.server.emit('close'))
      raw.on('error', () => {})
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    url: new URL(`https://localhost:${(server.address() as AddressInfo).port}`),
    objects,
    async close() {
      for (const name of [...objects.nodes.keys()]) objects.reset(name)
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
  }
}
