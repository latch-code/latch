import { createServer, connect } from 'node:net'
import { generateKeyPairSync, createPublicKey, sign } from 'node:crypto'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { createServer as tlsServer, connect as tlsConnect, createSecureContext, checkServerIdentity } from 'node:tls'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { knock, Reader, type KnockBinding } from '@latch/link-wire'
import {
  acceptNative,
  connectNative,
  createTransportCertificate,
  createDeviceTrustAnchor,
  renewDeviceCertificate,
  nodeCrypto,
} from '../src/index.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture(device = createTransportCertificate(), count = 1, binding: KnockBinding = { path: 'direct' }) {
  const host = createTransportCertificate(),
    root = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
    knockKey = nodeCrypto.random(32)
  const sockets = new Set<import('node:net').Socket>(),
    failures: string[] = []
  let active = true
  const options = {
    tlsBinary: resolve('dist/native/latch-native-tls'),
    certificate: host,
    identity: {
      publicKeySpki: root.publicKey.export({ format: 'der', type: 'spki' }),
      sign: (input: Uint8Array) => sign('sha256', input, { key: root.privateKey, dsaEncoding: 'ieee-p1363' }),
    },
    devices: () =>
      Array.from({ length: count }, (_, index) => ({
        id: index === count - 1 ? 'device-1' : `tombstone-${index}`,
        kind: 'registered' as const,
        knockKey: index === count - 1 ? knockKey : new Uint8Array(32).fill(index % 256),
        certificate: device.cert,
      })),
    isActive: () => active,
    replay: new Map<string, number>(),
  }
  const server = createServer(socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    void acceptNative(socket, binding, options)
      .then(({ socket: secure }) => {
        secure.on('error', () => {})
        secure.on('data', data => secure.write(data))
      })
      .catch(error => failures.push(String(error)))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  return {
    port: (server.address() as import('node:net').AddressInfo).port,
    failures,
    client: {
      rootSpki: createPublicKey(root.privateKey).export({ format: 'der', type: 'spki' }),
      knockKey,
      certificate: device.cert,
      key: device.key,
    },
    revoke() {
      active = false
    },
  }
}
describe('native Host authentication before application bytes', () => {
  it('settles an incomplete knock on close before its authentication deadline', async () => {
    const raw = new PassThrough(),
      certificate = createTransportCertificate(),
      root = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    let settled = false
    const pending = acceptNative(
      raw,
      { path: 'direct' },
      {
        tlsBinary: resolve('dist/native/latch-native-tls'),
        certificate,
        identity: {
          publicKeySpki: root.publicKey.export({ type: 'spki', format: 'der' }),
          sign: input => sign('sha256', input, { key: root.privateKey, dsaEncoding: 'ieee-p1363' }),
        },
        devices: () => [],
        isActive: () => false,
        replay: new Map(),
      },
    ).catch(() => {
      settled = true
    })
    raw.destroy()
    await new Promise(resolve => setImmediate(resolve))
    try {
      expect(settled).toBe(true)
    } finally {
      await pending
    }
  })
  it('bounds active, revoked and invitation knock candidates while delivering a retained tombstone at the last slot', async () => {
    const permitted = await fixture(createTransportCertificate(), 1032),
      raw = connect(permitted.port, '127.0.0.1')
    raw.on('error', () => {})
    const socket = await connectNative(raw, { path: 'direct' }, permitted.client)
    socket.destroy()
    const excessive = await fixture(createTransportCertificate(), 1033),
      blocked = connect(excessive.port, '127.0.0.1')
    blocked.on('error', () => {})
    await expect(connectNative(blocked, { path: 'direct' }, excessive.client)).rejects.toThrow('authentication failed')
  })
  it.each([
    { servername: '', protocol: 'h2', relay: false },
    { servername: 'wrong.latch.invalid', protocol: 'h2', relay: false },
    { servername: 'transport.latch.invalid', protocol: 'latch-pad/1', relay: false },
    { servername: 'transport.latch.invalid', protocol: 'h2', relay: true },
  ])(
    'refuses wrong SNI or a protocol that disagrees with the authenticated binding ($protocol/$relay/$servername)',
    async ({ servername, protocol, relay }) => {
      const binding: KnockBinding = relay
        ? { path: 'relay', relayId: new Uint8Array(16).fill(1), routeId: new Uint8Array(16).fill(2) }
        : { path: 'direct' }
      const test = await fixture(undefined, 1, binding),
        raw = connect(test.port, '127.0.0.1')
      raw.on('error', () => {})
      const exact = async (size: number): Promise<Buffer> => {
        for (;;) {
          const value = raw.read(size) as Buffer | null
          if (value) return value
          await once(raw, 'readable', { signal: AbortSignal.timeout(3000) })
        }
      }
      raw.write(await knock(nodeCrypto, test.client.knockKey, binding, Date.now()))
      const size = (await exact(2)).readUInt16BE(),
        record = new Reader(await exact(size)),
        certificate = record.field(4096)
      const client = tlsConnect({
        socket: raw,
        servername,
        ca: new (await import('node:crypto')).X509Certificate(certificate).toString(),
        cert: test.client.certificate,
        key: test.client.key,
        checkServerIdentity: (_name, presented) => checkServerIdentity('transport.latch.invalid', presented),
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        ALPNProtocols: [protocol],
      })
      client.on('error', () => {})
      const observed: Buffer[] = []
      client.on('data', data => observed.push(data))
      client.setTimeout(2000, () => client.destroy())
      await new Promise<void>(resolve => client.once('close', () => resolve()))
      expect(Buffer.concat(observed)).toHaveLength(0)
      await vi.waitFor(() => expect(test.failures).toHaveLength(1))
    },
  )
  it('issues a local trust anchor for an enrolled SPKI', () => {
    const device = createTransportCertificate(),
      root = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const anchor = createDeviceTrustAnchor(device.spki, {
      publicKeySpki: root.publicKey.export({ format: 'der', type: 'spki' }),
      sign: input => sign('sha256', input, { key: root.privateKey, dsaEncoding: 'ieee-p1363' }),
    })
    expect(anchor).toContain('BEGIN CERTIFICATE')
  })
  it('validates a renewed certificate with the platform trust store', async () => {
    const device = createTransportCertificate(Date.now() - 7_200_000),
      renewal = renewDeviceCertificate(device.key),
      host = createTransportCertificate(),
      root = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const anchor = createDeviceTrustAnchor(device.spki, {
      publicKeySpki: root.publicKey.export({ format: 'der', type: 'spki' }),
      sign: input => sign('sha256', input, { key: root.privateKey, dsaEncoding: 'ieee-p1363' }),
    })
    const context = createSecureContext({
      cert: host.cert,
      key: host.key,
      ca: [anchor, device.cert],
      allowPartialTrustChain: true,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
    })
    const server = tlsServer({
      cert: host.cert,
      key: host.key,
      ca: [anchor, device.cert],
      allowPartialTrustChain: true,
      SNICallback: (_hostname, callback) => callback(null, context),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
    })
    const outcome = new Promise<string>(resolve => {
      server.once('secureConnection', socket => {
        socket.end()
        resolve('authorized')
      })
      server.once('tlsClientError', (_error, socket) => resolve(String(socket.authorizationError)))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
    const client = tlsConnect({
      host: '127.0.0.1',
      port: (server.address() as import('node:net').AddressInfo).port,
      servername: 'transport.latch.invalid',
      ca: host.cert,
      cert: renewal.cert,
      key: device.key,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
    })
    client.on('error', () => {})
    cleanup.push(() => {
      client.destroy()
    })
    expect(await outcome).toBe('authorized')
  })
  it('accepts a fresh same-key leaf after the enrolled presentation expires', async () => {
    const expired = createTransportCertificate(Date.now() - 7_200_000),
      test = await fixture(expired)
    const renewal = renewDeviceCertificate(expired.key)
    expect(renewal.spki).toEqual(expired.spki)
    const raw = connect(test.port, '127.0.0.1')
    raw.on('error', () => {})
    const secure = await connectNative(raw, { path: 'direct' }, { ...test.client, certificate: renewal.cert })
    cleanup.push(() => {
      secure.destroy()
    })
    const response = once(secure, 'data')
    secure.write('same registered connection key')
    expect((await response)[0].toString()).toBe('same registered connection key')
    expect(test.failures).toEqual([])
    const old = connect(test.port, '127.0.0.1')
    old.on('error', () => {})
    await expect(connectNative(old, { path: 'direct' }, test.client)).rejects.toThrow()
  })
  it('uses real platform mutual TLS and verifies the fixed Host root', async () => {
    const test = await fixture(),
      raw = connect(test.port, '127.0.0.1')
    raw.on('error', () => {})
    const secure = await connectNative(raw, { path: 'direct' }, test.client)
    cleanup.push(() => {
      secure.destroy()
    })
    const response = once(secure, 'data')
    secure.write('authenticated payload')
    expect((await response)[0].toString()).toBe('authenticated payload')
    expect(secure.getProtocol()).toBe('TLSv1.3')
    expect(test.failures).toEqual([])
  })
  it('rejects a different Host root even when it knows the knock key', async () => {
    const test = await fixture(),
      wrong = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'der', type: 'spki' })
    const raw = connect(test.port, '127.0.0.1')
    raw.on('error', () => {})
    await expect(connectNative(raw, { path: 'direct' }, { ...test.client, rootSpki: wrong })).rejects.toThrow('authentication failed')
  })
  it('does not send a client certificate or TLS ClientHello to a server without a valid preflight binding', async () => {
    const observed: Buffer[] = [],
      certificate = createTransportCertificate()
    const evil = createServer(socket => {
      socket.on('error', () => {})
      socket.on('data', data => {
        observed.push(data)
        socket.write(Buffer.concat([Buffer.from([0, 34, 0, 0]), Buffer.alloc(32)]))
      })
    })
    evil.listen(0, '127.0.0.1')
    await once(evil, 'listening')
    cleanup.push(async () => {
      await new Promise<void>(resolve => evil.close(() => resolve()))
    })
    const raw = connect((evil.address() as import('node:net').AddressInfo).port, '127.0.0.1')
    raw.on('error', () => {})
    await expect(
      connectNative(
        raw,
        { path: 'direct' },
        { rootSpki: new Uint8Array(), knockKey: nodeCrypto.random(32), certificate: certificate.cert, key: certificate.key },
      ),
    ).rejects.toThrow()
    expect(Buffer.concat(observed)).toHaveLength(32)
  })
  it('does not disclose the Host certificate to an unknown or revoked device', async () => {
    const test = await fixture()
    test.revoke()
    const raw = connect(test.port, '127.0.0.1'),
      observed: Buffer[] = []
    raw.on('error', () => {})
    raw.on('data', data => observed.push(data))
    await expect(connectNative(raw, { path: 'direct' }, test.client)).rejects.toThrow()
    expect(Buffer.concat(observed)).toHaveLength(0)
  })
  it('rejects an unregistered TLS certificate even with a valid knock', async () => {
    const test = await fixture(),
      different = createTransportCertificate(),
      raw = connect(test.port, '127.0.0.1')
    raw.on('error', () => {})
    await expect(
      connectNative(raw, { path: 'direct' }, { ...test.client, certificate: different.cert, key: different.key }),
    ).rejects.toThrow()
    await vi.waitFor(() => expect(test.failures).toHaveLength(1))
  })
})
