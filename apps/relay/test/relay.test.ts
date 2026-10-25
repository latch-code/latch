import { createHash, generateKeyPairSync, createPublicKey, sign } from 'node:crypto'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  attachMac,
  equal,
  hex,
  holder,
  issuePass,
  makeProof,
  registrationInput,
  registrationMac,
  routeId,
  routeKey,
  UTC_DAY,
  type RelayMessage,
} from '@latch/link-wire'
import {
  acceptNative,
  connectNative,
  connectRelayTunnel,
  createTransportCertificate,
  nodeCrypto,
  registerRelay,
  RelayControl,
} from '@latch/link-client'
import { RelayCore, type RelayPeer } from '../src/core.ts'
import { addressPrefix, startRelay } from '../src/server.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function credentials(now: number, relayId: Uint8Array) {
  const day = Math.floor(now / 1000 / UTC_DAY),
    seed = nodeCrypto.random(32),
    key = await routeKey(nodeCrypto, seed, relayId, day),
    publicKey = await nodeCrypto.publicKey(key),
    device = await holder(nodeCrypto, seed, relayId, new Uint8Array([1]), day)
  const pass = await issuePass(nodeCrypto, key, {
    pairing: false,
    relayId,
    day,
    notBefore: day * UTC_DAY,
    notAfter: (day + 1) * UTC_DAY,
    routePub: publicKey,
    holderPub: await nodeCrypto.publicKey(device.seed),
    tag: device.tag,
  })
  return { day, key, publicKey, device, pass, routeId: await routeId(nodeCrypto, publicKey) }
}
function peer(id: number, prefix = '192.0.2.0/24'): RelayPeer & { output: RelayMessage[]; closed?: number } {
  return {
    id,
    prefix,
    output: [],
    async send(message) {
      this.output.push(message)
    },
    close(code) {
      this.closed = code
    },
  }
}
describe('relay trust and bounded state', () => {
  it('requires private registration authentication before allocating a route', async () => {
    const now = Date.now(),
      relayId = nodeCrypto.random(16),
      token = nodeCrypto.random(32),
      data = await credentials(now, relayId),
      control = peer(1)
    const core = new RelayCore({ crypto: nodeCrypto, relayId, registrationToken: token, now: () => now })
    core.connect(control, 'host')
    await core.receive(1, { type: 'hello' })
    const hello = control.output[0]
    if (hello?.type !== 'challenge') throw new Error('No challenge')
    const input = registrationInput(relayId, hello.nonce, data.day, data.publicKey)
    await core.receive(1, {
      type: 'register',
      previous: new Uint8Array(32),
      day: data.day,
      routePub: data.publicKey,
      signature: await nodeCrypto.sign(data.key, input),
      regMac: new Uint8Array(16),
      alternate: false,
    })
    expect(control.closed).toBe(4100)
    expect(core.status().routes).toBe(0)
  })
  it('rejects proof replay, scopes DENY to the route, and leaves DATA alive across control reconnects', async () => {
    let now = Date.now()
    const relayId = nodeCrypto.random(16),
      token = nodeCrypto.random(32),
      data = await credentials(now, relayId)
    const core = new RelayCore({ crypto: nodeCrypto, relayId, registrationToken: token, now: () => now })
    const control = peer(1)
    core.connect(control, 'host')
    await core.receive(1, { type: 'hello' })
    const hello = control.output.shift()
    if (hello?.type !== 'challenge') throw new Error('No challenge')
    const input = registrationInput(relayId, hello.nonce, data.day, data.publicKey)
    await core.receive(1, {
      type: 'register',
      previous: new Uint8Array(32),
      day: data.day,
      routePub: data.publicKey,
      signature: await nodeCrypto.sign(data.key, input),
      regMac: await registrationMac(nodeCrypto, token, input),
      alternate: false,
    })
    const registered = control.output.shift()
    if (registered?.type !== 'registered') throw new Error('Not registered')
    const client = peer(2),
      proof = await makeProof(nodeCrypto, data.device.seed, data.pass, now)
    core.connect(client, 'client')
    await core.receive(2, { type: 'admit', proof })
    const open = control.output.shift()
    if (open?.type !== 'open') throw new Error('No pending connection')
    const replay = peer(3)
    core.connect(replay, 'client')
    await core.receive(3, { type: 'admit', proof })
    expect(replay.closed).toBe(4100)
    const upstream = peer(4),
      nonce = nodeCrypto.random(16)
    core.connect(upstream, 'data')
    await core.receive(4, {
      type: 'attach',
      routeId: registered.routeId,
      connection: open.connection,
      nonce,
      mac: await attachMac(nodeCrypto, registered.token, registered.routeId, open.connection, nonce),
    })
    expect(upstream.output.map(value => value.type)).toEqual(['attached', 'spliced'])
    core.disconnect(1)
    now += 25_000
    core.sweep()
    await core.receive(2, { type: 'data', data: new Uint8Array([9]) })
    expect(upstream.output.at(-1)).toEqual({ type: 'data', data: new Uint8Array([9]) })
    expect(client.closed).toBeUndefined()
  })
  it('bounds pending state and expires unauthenticated peers without changing existing routes', async () => {
    let now = Date.now()
    const core = new RelayCore({
      crypto: nodeCrypto,
      relayId: nodeCrypto.random(16),
      openRegistration: true,
      now: () => now,
      maxConnections: 8,
      maxPerPrefix: 2,
    })
    expect(core.connect(peer(1), 'client')).toBe(true)
    expect(core.connect(peer(2), 'host')).toBe(true)
    const rejected = peer(3)
    expect(core.connect(rejected, 'host')).toBe(false)
    expect(rejected.closed).toBe(4302)
    now += 3001
    core.sweep()
    expect(core.status().connections).toBe(0)
    expect(addressPrefix('::ffff:192.0.2.3')).toBe('192.0.2.0/24')
    expect(addressPrefix('2001:0db8:0001::3')).toBe('2001:db8:1::/48')
  })
})
describe('real TLS over an opaque self-hosted relay', () => {
  it('shares one control across independent routes and drops or denies only the named membership', async () => {
    const certificate = createTransportCertificate(Date.now(), 3_600_000, 'localhost'),
      relayId = nodeCrypto.random(16),
      token = nodeCrypto.random(32)
    const relay = await startRelay({
      cert: certificate.cert,
      key: certificate.key,
      host: '127.0.0.1',
      port: 0,
      relayId,
      registrationToken: token,
    })
    cleanup.push(() => relay.close())
    const resolved = vi.fn(async () => '127.0.0.1')
    const endpoint = {
      url: new URL(`https://localhost:${relay.port}`),
      relayId,
      ca: certificate.cert,
      spki: createHash('sha256').update(certificate.spki).digest(),
      resolveAddress: resolved,
    }
    const control = await RelayControl.connect({ ...endpoint, registrationToken: token })
    cleanup.push(() => control.close())
    const first = await credentials(Date.now(), relayId),
      second = await credentials(Date.now(), relayId)
    const routes = await Promise.all(
      [first, second].map(value => control.register({ routeKey: value.key, day: value.day, alternate: false })),
    )
    expect(relay.status()).toMatchObject({ routes: 2, connections: 1 })
    const setups = [control.accept(), control.accept()]
    const downstream = await Promise.all(
      [first, second].map(value => connectRelayTunnel({ ...endpoint, pass: value.pass, holderKey: value.device.seed })),
    )
    const upstream = await Promise.all(setups)
    for (const value of upstream) {
      value.finishSetup()
      value.stream.on('error', () => {})
      value.stream.on('data', chunk => value.stream.write(chunk))
      cleanup.push(() => {
        value.stream.destroy()
      })
    }
    for (const stream of downstream) {
      stream.on('error', () => {})
      cleanup.push(() => {
        stream.destroy()
      })
    }
    const echo = async (index: number) => {
      const response = once(downstream[index]!, 'data')
      downstream[index]!.write(`route ${index}`)
      expect((await response)[0].toString()).toBe(`route ${index}`)
    }
    await echo(0)
    await echo(1)
    expect(resolved.mock.calls.length).toBe(5)
    await control.drop(routes[0]!.routeId)
    await echo(0)
    await echo(1)
    await control.deny(routes[1]!.routeId, [first.device.tag])
    await echo(1)
    await control.deny(routes[1]!.routeId, [second.device.tag])
    await vi.waitFor(() => expect(downstream[1]!.destroyed).toBe(true))
    await echo(0)
    control.close()
    await echo(0)
  })
  it('splices mutual TLS and Host identity verification without interpreting application bytes', async () => {
    const certificate = createTransportCertificate(Date.now(), 3_600_000, 'localhost'),
      relayId = nodeCrypto.random(16),
      token = nodeCrypto.random(32)
    const relay = await startRelay({
      cert: certificate.cert,
      key: certificate.key,
      host: '127.0.0.1',
      port: 0,
      relayId,
      registrationToken: token,
    })
    cleanup.push(() => relay.close())
    const forbidden = await fetch(`http://127.0.0.1:${relay.adminPort}/drain`, {
      method: 'POST',
      headers: { origin: 'https://untrusted.invalid', 'x-latch-relay-admin': '1' },
    })
    expect(forbidden.status).toBe(403)
    expect(relay.status().draining).toBe(false)
    const endpoint = {
        url: new URL(`https://localhost:${relay.port}`),
        relayId,
        ca: certificate.cert,
        spki: createHash('sha256').update(certificate.spki).digest(),
      },
      data = await credentials(Date.now(), relayId)
    const control = await registerRelay({ ...endpoint, routeKey: data.key, day: data.day, registrationToken: token, alternate: false })
    cleanup.push(() => control.close())
    expect(equal(control.routeId, data.routeId)).toBe(true)
    const pending = control.accept(),
      downstream = await connectRelayTunnel({ ...endpoint, pass: data.pass, holderKey: data.device.seed }),
      upstream = await pending
    downstream.on('error', () => {})
    upstream.stream.on('error', () => {})
    cleanup.push(() => {
      downstream.destroy()
      upstream.stream.destroy()
    })
    expect(hex(upstream.passTag)).toBe(hex(data.device.tag))
    const hostCertificate = createTransportCertificate(),
      device = createTransportCertificate(),
      root = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
      knockKey = nodeCrypto.random(32)
    const binding = { path: 'relay' as const, relayId, routeId: control.routeId }
    const accepted = acceptNative(upstream.stream, binding, {
      certificate: hostCertificate,
      identity: {
        publicKeySpki: root.publicKey.export({ format: 'der', type: 'spki' }),
        sign: (input: Uint8Array) => sign('sha256', input, { key: root.privateKey, dsaEncoding: 'ieee-p1363' }),
      },
      devices: () => [{ id: 'one', kind: 'registered' as const, certificate: device.cert, knockKey }],
      isActive: () => true,
      replay: new Map(),
    })
    const secure = await connectNative(downstream, binding, {
        rootSpki: createPublicKey(root.privateKey).export({ format: 'der', type: 'spki' }),
        knockKey,
        certificate: device.cert,
        key: device.key,
      }),
      host = await accepted
    secure.on('error', () => {})
    host.socket.on('error', () => {})
    cleanup.push(() => {
      secure.destroy()
      host.socket.destroy()
    })
    const response = once(host.socket, 'data')
    secure.write('opaque encrypted session')
    expect((await response)[0].toString()).toBe('opaque encrypted session')
    expect(host.deviceId).toBe('one')
    expect(relay.status()).toMatchObject({ connections: 3, routes: 1, pending: 0 })
  })
})
