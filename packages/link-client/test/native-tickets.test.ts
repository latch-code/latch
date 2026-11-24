import { createServer, connect } from 'node:net'
import { generateKeyPairSync, sign } from 'node:crypto'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { createServer as createTlsServer, connect as connectTls } from 'node:tls'
import { afterEach, expect, it, vi } from 'vitest'
import { acceptNative, connectNative, createTransportCertificate, nodeCrypto } from '../src/index.ts'

const observed = vi.hoisted(() => ({ tickets: 0, capture: undefined as Buffer | undefined, offer: false }))
vi.mock('node:tls', async importOriginal => {
  const original = await importOriginal<typeof import('node:tls')>()
  return {
    ...original,
    connect(options: import('node:tls').ConnectionOptions, callback?: () => void) {
      const socket = original.connect({ ...options, ...(observed.offer ? { session: observed.capture } : {}) }, callback)
      socket.on('session', (ticket: Buffer) => {
        observed.tickets++
        if (ticket.length <= 16384) observed.capture = ticket
      })
      return socket
    },
  }
})
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
  observed.tickets = 0
  observed.capture = undefined
  observed.offer = false
})
it('never issues an inner TLS ticket or resumes when a previously captured ticket is offered', async () => {
  const device = createTransportCertificate(),
    transport = createTransportCertificate(),
    root = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
    knockKey = nodeCrypto.random(32)
  const legacy = createTlsServer({ cert: transport.cert, key: transport.key, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' }, socket => {
    socket.on('error', () => {})
    socket.on('data', bytes => socket.write(bytes))
  })
  legacy.listen(0, '127.0.0.1')
  await once(legacy, 'listening')
  cleanup.push(async () => {
    await new Promise<void>(resolve => legacy.close(() => resolve()))
  })
  const oldClient = connectTls({
    port: (legacy.address() as import('node:net').AddressInfo).port,
    host: '127.0.0.1',
    servername: 'transport.latch.invalid',
    ca: transport.cert,
  })
  cleanup.push(() => {
    oldClient.destroy()
  })
  oldClient.on('error', () => {})
  const ticket = once(oldClient, 'session')
  await once(oldClient, 'secureConnect')
  const oldEcho = once(oldClient, 'data')
  oldClient.write('fixture')
  await oldEcho
  await ticket
  expect(Boolean(observed.capture)).toBe(true)
  const oldClosed = once(oldClient, 'close')
  oldClient.destroy()
  await oldClosed
  observed.tickets = 0
  const sockets = new Set<import('node:net').Socket>()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    void acceptNative(
      socket,
      { path: 'direct' },
      {
        tlsBinary: resolve('dist/native/latch-native-tls'),
        certificate: transport,
        identity: {
          publicKeySpki: root.publicKey.export({ type: 'spki', format: 'der' }),
          sign: input => sign('sha256', input, { key: root.privateKey, dsaEncoding: 'ieee-p1363' }),
        },
        devices: () => [{ id: 'ticket-fixture', kind: 'registered', certificate: device.cert, knockKey }],
        isActive: () => true,
        replay: new Map(),
      },
    )
      .then(({ socket: secure }) => {
        secure.on('error', () => {})
        secure.on('data', bytes => secure.write(bytes))
      })
      .catch(() => socket.destroy())
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  const port = (server.address() as import('node:net').AddressInfo).port,
    identity = { rootSpki: root.publicKey.export({ type: 'spki', format: 'der' }), knockKey, certificate: device.cert, key: device.key }
  const open = async () => {
    const raw = connect(port, '127.0.0.1')
    raw.on('error', () => {})
    const socket = await connectNative(raw, { path: 'direct' }, identity)
    cleanup.push(() => {
      socket.destroy()
    })
    const echoed = once(socket, 'data')
    socket.write(Buffer.from('fixture'))
    await echoed
    expect(socket.isSessionReused()).toBe(false)
    const closed = once(socket, 'close')
    socket.end()
    await closed
  }
  await open()
  expect(observed.tickets).toBe(0)
  observed.offer = true
  await open()
  expect(observed.tickets).toBe(0)
})
