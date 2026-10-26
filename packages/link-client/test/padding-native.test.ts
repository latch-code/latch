import { generateKeyPairSync, sign } from 'node:crypto'
import { createServer, connect } from 'node:net'
import { once } from 'node:events'
import { createServer as createHttp2Server } from 'node:http2'
import { resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { acceptNative, connectNative, createTransportCertificate, NativeHttpClient, nodeCrypto } from '../src/index.ts'
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})
it.each(['window-expiry', 'new-app-generation'])('discards already queued private bytes after %s over genuine inner TLS', async cause => {
  const root = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
    certificate = createTransportCertificate(),
    device = createTransportCertificate(),
    knockKey = nodeCrypto.random(32)
  const binding = { path: 'relay' as const, relayId: new Uint8Array(16).fill(1), routeId: new Uint8Array(16).fill(2) }
  const raw = new Set<import('node:net').Socket>()
  let deadline = performance.now() + 10000,
    generation = 1,
    queued = false
  const server = createServer(socket => {
    raw.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => raw.delete(socket))
    void acceptNative(socket, binding, {
      tlsBinary: resolve('dist/native/latch-native-tls'),
      certificate,
      replay: new Map(),
      identity: {
        publicKeySpki: root.publicKey.export({ format: 'der', type: 'spki' }),
        sign: input => sign('sha256', input, { key: root.privateKey, dsaEncoding: 'ieee-p1363' }),
      },
      devices: () => [{ id: 'padding-fixture', kind: 'registered', certificate: device.cert, knockKey }],
      isActive: () => true,
    })
      .then(({ socket: transport, padding }) => {
        padding!.guard(() => performance.now() < deadline && generation === 1)
        const http = createHttp2Server((_request, response) => {
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ private: 'queued-secret-content' }))
          queued = true
          if (cause === 'window-expiry') deadline = 0
          else generation++
        })
        http.on('sessionError', () => transport.destroy())
        http.emit('connection', transport)
      })
      .catch(() => socket.destroy())
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanup.push(async () => {
    for (const socket of raw) socket.destroy()
    await new Promise<void>(done => server.close(() => done()))
  })
  const transport = await connectNative(connect((server.address() as import('node:net').AddressInfo).port, '127.0.0.1'), binding, {
    rootSpki: root.publicKey.export({ format: 'der', type: 'spki' }),
    knockKey,
    certificate: device.cert,
    key: device.key,
  })
  const received: Buffer[] = []
  transport.on('data', (bytes: Buffer) => received.push(Buffer.from(bytes)))
  const client = new NativeHttpClient(transport)
  cleanup.push(() => client.close())
  await expect(client.request('GET', '/link/api/private')).rejects.toThrow(/result unknown/u)
  expect(queued).toBe(true)
  expect(Buffer.concat(received).includes(Buffer.from('queued-secret-content'))).toBe(false)
})
