import { createServer, type Server } from 'node:https'
import { webcrypto } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { encodeFrame, hex, holder, issuePass, routeKey, UTC_DAY, WebSocketParser } from '@latch/link-wire'
import { connectRelayTunnel, createTransportCertificate, nodeCrypto, RelayControl, type RelayEndpoint } from '@latch/link-client'
import { acceptKey } from '@latch/link-client/websocket'
import { createEdgeWorker } from '../src/edge.ts'
import type { EdgeEnv, EdgePlatform, EdgeSubtle } from '../src/platform.ts'
import { ClientSocket, FakeObjects, FakeResponse, request } from './harness.ts'

/**
 * The real Node clients (RelayControl, connectRelayTunnel) against the edge adapter, through real TLS and the same
 * WebSocket framing the edge puts on the wire. Like the edge, the bridge answers WebSocket pings itself.
 */
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run()
})
const certificate = createTransportCertificate(Date.now(), 3_600_000, 'localhost')
const relayId = nodeCrypto.random(16)

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
        accept() {}
        send(data: Uint8Array) {
          if (this.closed) throw new Error('closed')
          client.deliver(new Uint8Array(data))
        }
        close(code?: number) {
          if (this.closed) return
          this.closed = true
          client.shut(code ?? 1000)
          setImmediate(() => this.emit('close'))
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

async function edgeServer(seed: Uint8Array): Promise<{ url: URL; objects: FakeObjects }> {
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
    DAILY_MESSAGES: '1000000',
    MONTHLY_MESSAGES: '10000000',
  }
  const worker = createEdgeWorker(platform)
  const server: Server = createServer({ cert: certificate.cert, key: certificate.key, minVersion: 'TLSv1.3', ALPNProtocols: ['http/1.1'] })
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
      client.deliver = payload => {
        if (!raw.destroyed) raw.write(encodeFrame({ opcode: 2, payload }))
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
      raw.on('close', () => client.close())
      raw.on('error', () => {})
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanup.push(async () => {
    for (const name of [...objects.nodes.keys()]) objects.reset(name)
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  return { url: new URL(`https://localhost:${(server.address() as AddressInfo).port}`), objects }
}

async function credentials() {
  const now = Date.now(),
    day = Math.floor(now / 1000 / UTC_DAY),
    seed = nodeCrypto.random(32),
    key = await routeKey(nodeCrypto, seed, relayId, day),
    device = await holder(nodeCrypto, seed, relayId, Uint8Array.of(1), day)
  const pass = await issuePass(nodeCrypto, key, {
    pairing: false,
    relayId,
    day,
    notBefore: day * UTC_DAY,
    notAfter: (day + 1) * UTC_DAY,
    routePub: await nodeCrypto.publicKey(key),
    holderPub: await nodeCrypto.publicKey(device.seed),
    tag: device.tag,
  })
  return { day, key, device, pass }
}

it('registers, admits and carries bytes both ways for the real Node clients, racing a wrong-key origin', async () => {
  const seed = nodeCrypto.random(32),
    impostor = await edgeServer(nodeCrypto.random(32)),
    real = await edgeServer(seed)
  const endpoint: RelayEndpoint = {
    // The first origin answers with another relay key: it loses the race to the second, whatever its hostname.
    url: impostor.url,
    extraUrls: [real.url],
    relayId,
    edge: { relayKey: await nodeCrypto.publicKey(seed), shard: 0 },
    ca: certificate.cert,
    profile: 'outer-pad-v2',
    resolveAddress: async () => '127.0.0.1',
  }
  const control = await RelayControl.connect({ ...endpoint })
  cleanup.push(() => control.close())
  expect(control.roundTripMs).toBeGreaterThanOrEqual(0)
  const value = await credentials()
  await control.register({ routeKey: value.key, day: value.day, alternate: false })
  const setup = control.accept()
  const downstream = await connectRelayTunnel({ ...endpoint, pass: value.pass, holderKey: value.device.seed })
  const upstream = await setup
  upstream.finishSetup()
  upstream.stream.on('data', chunk => upstream.stream.write(chunk))
  cleanup.push(() => {
    upstream.stream.destroy()
    downstream.destroy()
  })
  const echoed = once(downstream, 'data')
  downstream.write(Buffer.from('across the edge'))
  expect(String((await echoed)[0])).toBe('across the edge')
  expect(upstream.passTag).toEqual(value.device.tag)
  expect(impostor.objects.nodes.size + real.objects.nodes.size).toBe(2)
}, 30_000)

it('refuses a node whose challenge is signed by another key before sending anything that depends on it', async () => {
  const real = await edgeServer(nodeCrypto.random(32))
  const value = await credentials()
  const endpoint: RelayEndpoint = {
    url: real.url,
    relayId,
    edge: { relayKey: await nodeCrypto.publicKey(nodeCrypto.random(32)), shard: 0 },
    ca: certificate.cert,
    profile: 'outer-pad-v2',
    resolveAddress: async () => '127.0.0.1',
  }
  await expect(connectRelayTunnel({ ...endpoint, pass: value.pass, holderKey: value.device.seed })).rejects.toThrow('Relay unavailable')
  await expect(RelayControl.connect({ ...endpoint })).rejects.toThrow('Relay unavailable')
  // The node saw HELLOs and nothing after them: no proof and no registration.
  const node = [...real.objects.nodes.values()][0]!
  expect(node.status()).toMatchObject({ routes: 0, pending: 0 })
}, 30_000)
