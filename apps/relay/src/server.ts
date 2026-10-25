import { constants, randomBytes } from 'node:crypto'
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createHttpServer } from 'node:http'
import { isIP } from 'node:net'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import { acceptKey, RelaySocket } from '@latch/link-client/websocket'
import { nodeCrypto } from '@latch/link-client/crypto'
import { RelayCore, type RelayCoreOptions } from './core.ts'

export function addressPrefix(input: string): string {
  let address = input.toLowerCase()
  if (address.startsWith('::ffff:') && isIP(address.slice(7)) === 4) address = address.slice(7)
  if (isIP(address) === 4) return `${address.split('.').slice(0, 3).join('.')}.0/24`
  if (isIP(address) !== 6) throw new RangeError('Invalid peer address')
  const [left = '', right = ''] = address.split('::'),
    head = left ? left.split(':') : [],
    tail = right ? right.split(':') : []
  const parts = address.includes('::') ? [...head, ...Array.from({ length: 8 - head.length - tail.length }, () => '0'), ...tail] : head
  return `${parts
    .slice(0, 3)
    .map(value => Number.parseInt(value, 16).toString(16))
    .join(':')}::/48`
}

export interface StartRelayOptions extends Omit<RelayCoreOptions, 'crypto' | 'now'> {
  cert: string | Buffer
  key: string | Buffer
  host: string
  port: number
  adminPort?: number
}

export async function startRelay(
  options: StartRelayOptions,
): Promise<{ port: number; adminPort: number; status: RelayCore['status']; close(): Promise<void> }> {
  const core = new RelayCore({ ...options, crypto: nodeCrypto, now: Date.now })
  const peers = new Set<RelaySocket>()
  const raw = new Set<import('node:stream').Duplex>()
  const server = createHttpsServer(
    {
      cert: options.cert,
      key: options.key,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      ALPNProtocols: ['http/1.1'],
      secureOptions: constants.SSL_OP_NO_TICKET,
      sessionIdContext: randomBytes(16).toString('hex'),
      maxHeaderSize: 4096,
    },
    (req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      if (req.method === 'GET' && req.url === '/healthz') {
        res.writeHead(core.status().draining ? 503 : 200)
        res.end('ok\n')
      } else {
        res.writeHead(404)
        res.end()
      }
    },
  )
  server.headersTimeout = 5000
  server.requestTimeout = 5000
  server.maxRequestsPerSocket = 1
  server.on('connection', socket => {
    raw.add(socket)
    socket.once('close', () => raw.delete(socket))
    if (raw.size > (options.maxConnections ?? 1024) + 32) socket.destroy()
  })
  server.on('tlsClientError', () => {})
  let sequence = 0
  server.on('upgrade', (request, rawSocket, head) => {
    const socket = rawSocket as import('node:tls').TLSSocket
    const headers = request.headers,
      key = headers['sec-websocket-key']
    const names = request.rawHeaders.filter((_, index) => index % 2 === 0).map(value => value.toLowerCase())
    const valid =
      request.method === 'GET'
      && ['/v1/h', '/v1/d', '/v1/c'].includes(request.url ?? '')
      && request.httpVersion === '1.1'
      && typeof key === 'string'
      && /^[A-Za-z0-9+/]{22}==$/u.test(key)
      && Buffer.from(key, 'base64').length === 16
      && headers['sec-websocket-version'] === '13'
      && headers['sec-websocket-protocol'] === 'latch-relay.1'
      && headers.upgrade?.toLowerCase() === 'websocket'
      && headers.connection?.toLowerCase() === 'upgrade'
      && !headers.origin
      && !headers['content-length']
      && !headers['transfer-encoding']
      && !headers['sec-websocket-extensions']
      && new Set(names).size === names.length
    if (!valid || !socket.remoteAddress) {
      socket.destroy()
      return
    }
    const id = ++sequence,
      peer = new RelaySocket(socket, false, head),
      role = request.url === '/v1/h' ? 'host' : request.url === '/v1/d' ? 'data' : 'client'
    peers.add(peer)
    socket.once('close', () => {
      peers.delete(peer)
      core.disconnect(id)
    })
    if (
      !core.connect(
        { id, prefix: addressPrefix(socket.remoteAddress), send: message => peer.send(message), close: code => peer.close(code) },
        role,
      )
    )
      return
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\nSec-WebSocket-Protocol: latch-relay.1\r\n\r\n`,
    )
    void (async () => {
      try {
        for (;;) await core.receive(id, await peer.receive(0))
      } catch {
        core.disconnect(id)
        peer.close()
      }
    })()
  })
  const admin = createHttpServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Type', 'application/json')
    const address = admin.address() as AddressInfo | null
    if (!address || req.headers.host !== `127.0.0.1:${address.port}` || req.headers.origin || req.headers['sec-fetch-site']) {
      res.writeHead(403)
      res.end('{}')
      return
    }
    if (req.method === 'GET' && req.url === '/status') {
      res.end(JSON.stringify(core.status()))
      return
    }
    if (
      req.method === 'POST'
      && req.url === '/drain'
      && req.headers['x-latch-relay-admin'] === '1'
      && !req.headers['transfer-encoding']
      && (!req.headers['content-length'] || req.headers['content-length'] === '0')
    ) {
      core.drain()
      res.end('{"draining":true}')
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
  const timer = setInterval(() => core.sweep(), 1000)
  timer.unref()
  try {
    admin.listen(options.adminPort ?? 0, '127.0.0.1')
    await once(admin, 'listening')
    server.listen(options.port, options.host)
    await once(server, 'listening')
  } catch (error) {
    clearInterval(timer)
    admin.close()
    server.close()
    throw error
  }
  return {
    port: (server.address() as AddressInfo).port,
    adminPort: (admin.address() as AddressInfo).port,
    status: () => core.status(),
    async close() {
      clearInterval(timer)
      core.drain()
      for (const peer of peers) peer.close(4300)
      for (const socket of raw) socket.destroy()
      await Promise.all([
        new Promise<void>(resolve => server.close(() => resolve())),
        new Promise<void>(resolve => admin.close(() => resolve())),
      ])
    },
  }
}
