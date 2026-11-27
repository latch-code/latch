import { createHash } from 'node:crypto'
import { mkdtemp, rm, chmod, lstat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as connectTls, createServer as createTlsServer } from 'node:tls'
import { connect as connectNet } from 'node:net'
import { once } from 'node:events'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTransportCertificate, renewDeviceCertificate, nodeCrypto, RelayControl, registerRelay } from '@latch/link-client'
import { routeKey, UTC_DAY } from '@latch/link-wire'
import { startRelay } from '../src/server.ts'
import { checkGateway } from '../src/gateway.ts'
import { decodeProxyHeader, listenPrivateBackend } from '../src/proxy.ts'
import { buildTestGateway } from './build-gateway.ts'
let directory: string, binary: string
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'latch-gateway-test-'))
  binary = await buildTestGateway(directory)
}, 65_000)
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

describe('ticket-free standard-library TLS gateway', () => {
  it('registers a ninth same-source private Host through the real worker and memory-work verifier behind Go TLS', async () => {
    const certificate = createTransportCertificate(Date.now(), 3_600_000, 'localhost'),
      relayId = nodeCrypto.random(16),
      registrationToken = nodeCrypto.random(32)
    const relay = await startRelay({
      cert: certificate.cert,
      key: certificate.key,
      relayId,
      registrationToken,
      host: '127.0.0.1',
      port: 0,
      maxConnections: 32,
      maxRoutes: 32,
      registrationWork: { softRoutesPerPrefix: 8, minBits: 0, maxBits: 0, maxConcurrent: 1 },
      gateway: { binary, maxHandshakes: 8, handshakesPerSecond: 100, handshakeBurst: 8, prefixFraction: 1 },
    })
    const endpoint = {
      url: new URL(`https://localhost:${relay.port}`),
      relayId,
      registrationToken,
      ca: certificate.cert,
      spki: createHash('sha256').update(certificate.spki).digest(),
      resolveAddress: async () => '127.0.0.1',
    }
    const controls: RelayControl[] = [],
      day = Math.floor(Date.now() / 1000 / UTC_DAY)
    try {
      for (let id = 0; id < 9; id++) {
        const control = await RelayControl.connect(endpoint)
        controls.push(control)
        expect((await control.register({ routeKey: nodeCrypto.random(32), day, alternate: false })).status).toBe(0)
      }
      expect(relay.status()).toMatchObject({ routes: 9, controls: 9, registrationWork: { active: 0, accepted: 1, rejected: 0 } })
      const compatible = await registerRelay({ ...endpoint, routeKey: nodeCrypto.random(32), day, alternate: false })
      expect(relay.status()).toMatchObject({ routes: 10, registrationWork: { active: 0, accepted: 2, rejected: 0 } })
      compatible.close()
    } finally {
      for (const control of controls) control.close()
      await relay.close()
    }
  })
  it('compiles a patched runtime and forbids altered gateway executable permissions', async () => {
    await checkGateway(binary)
    await chmod(binary, 0o777)
    await expect(checkGateway(binary)).rejects.toThrow('executable')
    await chmod(binary, 0o755)
  })
  it('emits no TLS1.3 tickets and rejects an actual resumption offer while serving real relay control', async () => {
    const certificate = createTransportCertificate(Date.now(), 3_600_000, 'localhost'),
      relayId = nodeCrypto.random(16)
    const old = createTlsServer({ key: certificate.key, cert: certificate.cert, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' }, socket => {
      socket.on('error', () => {})
      socket.write('fixture')
      setTimeout(() => socket.end(), 80)
    })
    old.listen(0, '127.0.0.1')
    await once(old, 'listening')
    const oldAddress = old.address()
    if (!oldAddress || typeof oldAddress === 'string') throw new Error('Fixture bind')
    let ticket: Buffer | undefined
    const first = connectTls({
      host: '127.0.0.1',
      port: oldAddress.port,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
    })
    first.on('session', value => {
      ticket = value
    })
    first.resume()
    await once(first, 'close')
    await new Promise<void>(resolve => old.close(() => resolve()))
    expect(ticket?.length).toBeGreaterThan(0)
    const relay = await startRelay({
      cert: certificate.cert,
      key: certificate.key,
      relayId,
      openRegistration: true,
      host: '127.0.0.1',
      port: 0,
      maxConnections: 32,
      gateway: { binary, maxHandshakes: 8, handshakesPerSecond: 100, handshakeBurst: 8, prefixFraction: 1 },
    })
    try {
      let tickets = 0
      const client = connectTls({
        host: '127.0.0.1',
        port: relay.port,
        rejectUnauthorized: false,
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        session: ticket,
      })
      client.on('session', () => tickets++)
      await once(client, 'secureConnect')
      expect(client.getProtocol()).toBe('TLSv1.3')
      expect(client.isSessionReused()).toBe(false)
      client.write('GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
      let data = ''
      for await (const bytes of client) data += String(bytes)
      expect(data).toContain('200 OK')
      expect(data).toContain('ok\n')
      expect(tickets).toBe(0)
      const control = await RelayControl.connect({
        url: new URL(`https://localhost:${relay.port}`),
        ca: certificate.cert,
        spki: createHash('sha256').update(certificate.spki).digest(),
        relayId,
        resolveAddress: async () => '127.0.0.1',
      })
      try {
        const day = Math.floor(Date.now() / 1000 / UTC_DAY)
        const registered = await control.register({
          routeKey: await routeKey(nodeCrypto, nodeCrypto.random(32), relayId, day),
          day,
          alternate: false,
        })
        expect(registered.status).toBe(0)
        expect((await control.deny(registered.routeId, [nodeCrypto.random(16)])).count).toBe(1)
      } finally {
        control.close()
      }
    } finally {
      await relay.close()
    }
  })
  it('renews the same pinned SPKI without dropping control and refuses silent key changes while retaining the active certificate', async () => {
    const certificate = createTransportCertificate(),
      renewed = renewDeviceCertificate(certificate.key, Date.now(), 8 * 3600000),
      relayId = nodeCrypto.random(16)
    const certPath = join(directory, 'renewable.pem'),
      keyPath = join(directory, 'renewable-key.pem')
    await writeFile(certPath, certificate.cert, { mode: 0o600 })
    await writeFile(keyPath, certificate.key, { mode: 0o600 })
    const relay = await startRelay({
      host: '127.0.0.1',
      port: 0,
      cert: certificate.cert,
      key: certificate.key,
      relayId,
      openRegistration: true,
      tlsFiles: { certificateFile: certPath, keyFile: keyPath },
      gateway: { binary, maxHandshakes: 8, handshakesPerSecond: 100, handshakeBurst: 8, prefixFraction: 1 },
    })
    const endpoint = {
      url: new URL(`https://transport.latch.invalid:${relay.port}`),
      ca: certificate.cert,
      spki: createHash('sha256').update(certificate.spki).digest(),
      relayId,
      resolveAddress: async () => '127.0.0.1',
    }
    const control = await RelayControl.connect(endpoint)
    const observe = async () => {
      const client = connectTls({
        host: '127.0.0.1',
        port: relay.port,
        ca: certificate.cert,
        servername: 'transport.latch.invalid',
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
      })
      let tickets = 0
      client.on('session', () => tickets++)
      await once(client, 'secureConnect')
      const raw = client.getPeerCertificate().raw
      client.destroy()
      await once(client, 'close')
      expect(tickets).toBe(0)
      return raw
    }
    try {
      expect(await observe()).toEqual(certificate.der)
      await writeFile(certPath, renewed.cert)
      const reload = () => fetch(`http://127.0.0.1:${relay.adminPort}/reload`, { method: 'POST', headers: { 'x-latch-relay-admin': '1' } })
      expect((await reload()).status).toBe(200)
      expect(await observe()).toEqual(renewed.der)
      const day = Math.floor(Date.now() / 1000 / UTC_DAY)
      expect(
        (await control.register({ routeKey: await routeKey(nodeCrypto, nodeCrypto.random(32), relayId, day), day, alternate: false }))
          .status,
      ).toBe(0)
      expect(relay.status()).toMatchObject({ ready: true, certificate: { renewalWarning: true }, runtime: { protocol: 2 } })
      const foreign = createTransportCertificate()
      await writeFile(certPath, foreign.cert)
      await writeFile(keyPath, foreign.key)
      expect((await reload()).status).toBe(409)
      expect(await observe()).toEqual(renewed.der)
      await writeFile(certPath, renewed.cert)
      await writeFile(keyPath, certificate.key)
      await chmod(keyPath, 0o644)
      expect((await reload()).status).toBe(409)
      expect(control.isClosed()).toBe(false)
    } finally {
      control.close()
      await relay.close()
    }
  })
  it('does not admit a public Node TLS adapter as a production fallback', async () => {
    const certificate = createTransportCertificate()
    await expect(
      startRelay({
        cert: certificate.cert,
        key: certificate.key,
        host: '0.0.0.0',
        port: 0,
        relayId: nodeCrypto.random(16),
        openRegistration: true,
      }),
    ).rejects.toThrow('ticket-free')
  })
})

it('accepts only exact bounded gateway address headers over a private socket', async () => {
  const header = Buffer.alloc(28)
  Buffer.from('\r\n\r\n\0\r\nQUIT\n').copy(header)
  header[12] = 0x21
  header[13] = 0x11
  header.writeUInt16BE(12, 14)
  header.set([192, 0, 2, 31, 127, 0, 0, 1], 16)
  expect(decodeProxyHeader(header.subarray(0, 15))).toBeUndefined()
  expect(decodeProxyHeader(header)).toEqual({ address: '192.0.2.31', consumed: 28 })
  const extended = Buffer.from(header)
  extended.writeUInt16BE(13, 14)
  expect(() => decodeProxyHeader(extended)).toThrow('address')
  const parent = await mkdtemp('/tmp/latch-proxy-test-'),
    socketPath = join(parent, 'backend')
  const received: string[] = []
  const backend = await listenPrivateBackend(socketPath, (socket, source) => {
    received.push(source)
    socket.end('ok')
  })
  try {
    expect((await lstat(socketPath)).mode & 0o777).toBe(0o600)
    const socket = connectNet(socketPath)
    socket.write(header.subarray(0, 10))
    socket.write(header.subarray(10))
    socket.resume()
    await once(socket, 'close')
    expect(received).toEqual(['192.0.2.31'])
    const bad = connectNet(socketPath)
    bad.on('error', () => {})
    bad.write(extended)
    bad.resume()
    await once(bad, 'close')
    expect(received).toHaveLength(1)
  } finally {
    await backend.close()
    await rm(parent, { recursive: true, force: true })
  }
})
