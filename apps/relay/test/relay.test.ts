import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import { createHash, generateKeyPairSync, createPublicKey, sign } from 'node:crypto'
import { once } from 'node:events'
import { resolve } from 'node:path'
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
function peer(id: number, prefix = '192.0.2.0/24'): RelayPeer & { output: RelayMessage[]; closed?: number; spliced: boolean } {
  return {
    id,
    prefix,
    output: [],
    spliced: false,
    markSpliced() {
      this.spliced = true
    },
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
    expect(replay.spliced).toBe(false)
    expect(client.spliced).toBe(false)
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
    expect(upstream.spliced).toBe(true)
    expect(client.spliced).toBe(true)
    expect(control.spliced).toBe(false)
    core.disconnect(1)
    now += 25_000
    core.sweep()
    await core.receive(2, { type: 'data', data: new Uint8Array([9]) })
    expect(upstream.output.at(-1)).toEqual({ type: 'data', data: new Uint8Array([9]) })
    expect(client.closed).toBeUndefined()
  })
  it('counts distinct holders per route instead of rejecting the same device after 32 reconnects', async () => {
    const now = Date.now(),
      relayId = nodeCrypto.random(16),
      data = await credentials(now, relayId),
      control = peer(1)
    const core = new RelayCore({ crypto: nodeCrypto, relayId, openRegistration: true, now: () => now })
    core.connect(control, 'host')
    await core.receive(1, { type: 'hello' })
    const challenge = control.output.shift()
    if (challenge?.type !== 'challenge') throw new Error('Missing challenge')
    const input = registrationInput(relayId, challenge.nonce, data.day, data.publicKey)
    await core.receive(1, {
      type: 'register',
      day: data.day,
      routePub: data.publicKey,
      signature: await nodeCrypto.sign(data.key, input),
      regMac: new Uint8Array(16),
      previous: new Uint8Array(32),
      alternate: false,
    })
    for (let attempt = 0; attempt < 40; attempt++) {
      const client = peer(attempt + 2)
      core.connect(client, 'client')
      await core.receive(client.id, { type: 'admit', proof: await makeProof(nodeCrypto, data.device.seed, data.pass, now) })
      expect(client.output[0]?.type).toBe('admitted')
      expect(client.closed).toBeUndefined()
      core.disconnect(client.id)
    }
    for (let distinct = 1; distinct <= 32; distinct++) {
      const device = await holder(nodeCrypto, nodeCrypto.random(32), relayId, new Uint8Array([distinct]), data.day)
      const pass = await issuePass(nodeCrypto, data.key, {
        pairing: false,
        relayId,
        day: data.day,
        notBefore: data.day * UTC_DAY,
        notAfter: (data.day + 1) * UTC_DAY,
        routePub: data.publicKey,
        holderPub: await nodeCrypto.publicKey(device.seed),
        tag: device.tag,
      })
      const client = peer(100 + distinct)
      core.connect(client, 'client')
      await core.receive(client.id, { type: 'admit', proof: await makeProof(nodeCrypto, device.seed, pass, now) })
      if (distinct < 32) expect(client.output[0]?.type).toBe('admitted')
      else expect(client.closed).toBe(4102)
      core.disconnect(client.id)
    }
  })
  it('counts one holder across alternate pass tags for the two-pending and four-spliced limits', async () => {
    const now = Date.now(),
      relayId = nodeCrypto.random(16),
      data = await credentials(now, relayId),
      control = peer(1)
    const core = new RelayCore({ crypto: nodeCrypto, relayId, openRegistration: true, now: () => now })
    core.connect(control, 'host')
    await core.receive(1, { type: 'hello' })
    const challenge = control.output.shift()
    if (challenge?.type !== 'challenge') throw new Error('Missing challenge')
    const input = registrationInput(relayId, challenge.nonce, data.day, data.publicKey)
    await core.receive(1, {
      type: 'register',
      day: data.day,
      routePub: data.publicKey,
      signature: await nodeCrypto.sign(data.key, input),
      regMac: new Uint8Array(16),
      previous: new Uint8Array(32),
      alternate: false,
    })
    const registered = control.output.shift()
    if (registered?.type !== 'registered') throw new Error('Missing registration')
    const admit = async (id: number) => {
      const pass = await issuePass(nodeCrypto, data.key, {
        pairing: false,
        relayId,
        day: data.day,
        notBefore: data.day * UTC_DAY,
        notAfter: (data.day + 1) * UTC_DAY,
        routePub: data.publicKey,
        holderPub: await nodeCrypto.publicKey(data.device.seed),
        tag: nodeCrypto.random(16),
      })
      const client = peer(id)
      core.connect(client, 'client')
      await core.receive(id, { type: 'admit', proof: await makeProof(nodeCrypto, data.device.seed, pass, now) })
      return client
    }
    const first = await admit(2),
      second = await admit(3),
      excessPending = await admit(4)
    expect(first.output[0]?.type).toBe('admitted')
    expect(second.output[0]?.type).toBe('admitted')
    expect(excessPending.closed).toBe(4102)
    core.disconnect(2)
    core.disconnect(3)
    control.output.length = 0
    for (let index = 0; index < 4; index++) {
      const client = await admit(10 + index)
      expect(client.output[0]?.type).toBe('admitted')
      const open = control.output.pop()
      if (open?.type !== 'open') throw new Error('Missing open')
      const upstream = peer(100 + index),
        nonce = nodeCrypto.random(16)
      core.connect(upstream, 'data')
      await core.receive(upstream.id, {
        type: 'attach',
        routeId: registered.routeId,
        connection: open.connection,
        nonce,
        mac: await attachMac(nodeCrypto, registered.token, registered.routeId, open.connection, nonce),
      })
      expect(upstream.output.at(-1)?.type).toBe('spliced')
    }
    expect((await admit(50)).closed).toBe(4102)
  })
  it('isolates replay capacity by both endpoint prefixes so one valid tenant cannot fill the node ledger', async () => {
    const now = Date.now(),
      relayId = nodeCrypto.random(16),
      core = new RelayCore({ crypto: nodeCrypto, relayId, openRegistration: true, now: () => now, maxPrefixFraction: 0.0002 })
    const register = async (id: number, prefix: string) => {
      const data = await credentials(now, relayId),
        control = peer(id, prefix)
      core.connect(control, 'host')
      await core.receive(id, { type: 'hello' })
      const challenge = control.output.shift()
      if (challenge?.type !== 'challenge') throw new Error('Missing challenge')
      const input = registrationInput(relayId, challenge.nonce, data.day, data.publicKey)
      await core.receive(id, {
        type: 'register',
        day: data.day,
        routePub: data.publicKey,
        signature: await nodeCrypto.sign(data.key, input),
        regMac: new Uint8Array(16),
        previous: new Uint8Array(32),
        alternate: false,
      })
      return data
    }
    const first = await register(1, '192.0.2.0/24'),
      second = await register(2, '203.0.113.0/24')
    for (let attempt = 0; attempt < 4; attempt++) {
      const client = peer(10 + attempt, '198.51.100.0/24')
      core.connect(client, 'client')
      await core.receive(client.id, { type: 'admit', proof: await makeProof(nodeCrypto, first.device.seed, first.pass, now) })
      if (attempt < 3) expect(client.output[0]?.type).toBe('admitted')
      else expect(client.closed).toBe(4100)
      core.disconnect(client.id)
    }
    const independent = peer(30, '198.51.101.0/24')
    core.connect(independent, 'client')
    await core.receive(30, { type: 'admit', proof: await makeProof(nodeCrypto, second.device.seed, second.pass, now) })
    expect(independent.output[0]?.type).toBe('admitted')
  })
  it('reclaims the oldest unauthenticated peer from the largest prefix share and allows nine hosts behind one NAT', () => {
    let now = 0
    const core = new RelayCore({
      crypto: nodeCrypto,
      relayId: nodeCrypto.random(16),
      openRegistration: true,
      now: () => ++now,
      maxConnections: 10,
      maxPreauthConnections: 3,
    })
    const a = peer(1),
      b = peer(2),
      c = peer(3),
      outsider = peer(4, '198.51.100.0/24')
    core.connect(a, 'host')
    core.connect(b, 'host')
    core.connect(c, 'client')
    expect(core.connect(outsider, 'client')).toBe(true)
    expect(a.closed).toBe(4302)
    expect(b.closed).toBeUndefined()
    expect(outsider.closed).toBeUndefined()
    const nat = new RelayCore({ crypto: nodeCrypto, relayId: nodeCrypto.random(16), openRegistration: true, now: () => now })
    for (let id = 1; id <= 9; id++) expect(nat.connect(peer(id), 'host')).toBe(true)
    expect(nat.status().connections).toBe(9)
  })
  it('bounds route occupancy per source prefix without evicting previously registered routes', async () => {
    const now = Date.now(),
      relayId = nodeCrypto.random(16)
    const core = new RelayCore({ crypto: nodeCrypto, relayId, openRegistration: true, now: () => now, maxRoutes: 4, maxRoutesPerPrefix: 1 })
    const register = async (id: number, prefix: string) => {
      const control = peer(id, prefix),
        data = await credentials(now, relayId)
      core.connect(control, 'host')
      await core.receive(id, { type: 'hello' })
      const hello = control.output.shift()
      if (hello?.type !== 'challenge') throw new Error('No challenge')
      const input = registrationInput(relayId, hello.nonce, data.day, data.publicKey)
      await core.receive(id, {
        type: 'register',
        previous: new Uint8Array(32),
        day: data.day,
        routePub: data.publicKey,
        signature: await nodeCrypto.sign(data.key, input),
        regMac: new Uint8Array(16),
        alternate: false,
      })
      return control
    }
    const first = await register(1, '192.0.2.0/24'),
      excess = await register(2, '192.0.2.0/24'),
      outsider = await register(3, '198.51.100.0/24')
    expect(first.closed).toBeUndefined()
    expect(excess.closed).toBe(4302)
    expect(outsider.closed).toBeUndefined()
    expect(core.status().routes).toBe(2)
  })
  it('preserves an authenticated control when its prefix capacity is full', async () => {
    const now = Date.now(),
      relayId = nodeCrypto.random(16),
      data = await credentials(now, relayId),
      control = peer(1)
    const core = new RelayCore({ crypto: nodeCrypto, relayId, openRegistration: true, now: () => now, maxPerPrefix: 1 })
    core.connect(control, 'host')
    await core.receive(1, { type: 'hello' })
    const challenge = control.output.shift()
    if (challenge?.type !== 'challenge') throw new Error('Missing challenge')
    const input = registrationInput(relayId, challenge.nonce, data.day, data.publicKey)
    await core.receive(1, {
      type: 'register',
      day: data.day,
      routePub: data.publicKey,
      signature: await nodeCrypto.sign(data.key, input),
      regMac: new Uint8Array(16),
      previous: new Uint8Array(32),
      alternate: false,
    })
    const newcomer = peer(2)
    expect(core.connect(newcomer, 'host')).toBe(false)
    expect(newcomer.closed).toBe(4302)
    expect(control.closed).toBeUndefined()
    expect(core.status()).toMatchObject({ connections: 1, controls: 1 })
  })
  it('keeps the prefix bound while replacing its oldest unauthenticated peer, then expires the remaining peers', async () => {
    let now = Date.now()
    const core = new RelayCore({
      crypto: nodeCrypto,
      relayId: nodeCrypto.random(16),
      openRegistration: true,
      now: () => now,
      maxConnections: 8,
      maxPerPrefix: 2,
    })
    const oldest = peer(1),
      second = peer(2),
      replacement = peer(3)
    expect(core.connect(oldest, 'client')).toBe(true)
    expect(core.connect(second, 'host')).toBe(true)
    expect(core.connect(replacement, 'host')).toBe(true)
    expect(oldest.closed).toBe(4302)
    expect(second.closed).toBeUndefined()
    expect(core.status().connections).toBe(2)
    now += 3001
    core.sweep()
    expect(core.status().connections).toBe(0)
    expect(addressPrefix('::ffff:192.0.2.3')).toBe('192.0.2.0/24')
    expect(addressPrefix('2001:0db8:0001::3')).toBe('2001:db8:1::/48')
  })
})
describe('real TLS over an opaque self-hosted relay', () => {
  it('returns bounded HTTP 503 when admission is refused before the WebSocket upgrade', async () => {
    const certificate = createTransportCertificate(Date.now(), 3_600_000, 'localhost')
    const relay = await startRelay({
      cert: certificate.cert,
      key: certificate.key,
      host: '127.0.0.1',
      port: 0,
      relayId: nodeCrypto.random(16),
      openRegistration: true,
    })
    cleanup.push(() => relay.close())
    relay.drain()
    const socket = tlsConnect({ host: '127.0.0.1', port: relay.port, rejectUnauthorized: false })
    cleanup.push(() => {
      socket.destroy()
    })
    await once(socket, 'secureConnect')
    socket.write(
      'GET /v1/h HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: AQEBAQEBAQEBAQEBAQEBAQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: latch-relay.1\r\n\r\n',
    )
    let response = ''
    for await (const data of socket) response += String(data)
    expect(response).toBe('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    expect(relay.status().connections).toBe(0)
  })
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
    expect(relay.status()).toMatchObject({ routes: 2, connections: 1, controls: 1, withoutAlternate: 1 })
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
      tlsBinary: resolve('dist/native/latch-native-tls'),
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

it('acknowledges durable denials and restores them across DROP, DEPART and a real Node relay restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'relay-deny-restart-'))
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }))
  const certificate = createTransportCertificate(Date.now(), 3_600_000, 'localhost'),
    relayId = nodeCrypto.random(16),
    token = nodeCrypto.random(32)
  const options = { dataDir, cert: certificate.cert, key: certificate.key, host: '127.0.0.1', port: 0, relayId, registrationToken: token }
  let relay = await startRelay(options)
  cleanup.push(() => relay.close())
  const endpoint = () => ({
    url: new URL(`https://localhost:${relay.port}`),
    relayId,
    ca: certificate.cert,
    spki: createHash('sha256').update(certificate.spki).digest(),
  })
  const data = await credentials(Date.now(), relayId),
    control = await RelayControl.connect({ ...endpoint(), registrationToken: token })
  await control.register({ routeKey: data.key, day: data.day, alternate: false })
  const receipt = await control.deny(data.routeId, [data.device.tag, data.device.tag])
  expect(receipt.count).toBe(1)
  const files = await readdir(join(dataDir, 'denials'))
  expect(files).toHaveLength(1)
  expect(await readFile(join(dataDir, 'denials', files[0]!), 'utf8')).not.toContain(hex(data.routeId))
  await control.drop(data.routeId)
  control.close()
  await relay.close()
  relay = await startRelay(options)
  const reopened = await RelayControl.connect({ ...endpoint(), registrationToken: token })
  cleanup.push(() => reopened.close())
  await reopened.register({ routeKey: data.key, day: data.day, alternate: false })
  await expect(connectRelayTunnel({ ...endpoint(), pass: data.pass, holderKey: data.device.seed })).rejects.toThrow()
  expect((await reopened.deny(data.routeId, [data.device.tag])).count).toBe(1)
  await reopened.depart(1)
  await relay.close()
})
it('rejects actual outer TLS session resumption in the Node validation adapter', async () => {
  const certificate = createTransportCertificate(Date.now(), 3_600_000, 'localhost')
  const relay = await startRelay({
    cert: certificate.cert,
    key: certificate.key,
    host: '127.0.0.1',
    port: 0,
    relayId: nodeCrypto.random(16),
    registrationToken: nodeCrypto.random(32),
  })
  cleanup.push(() => relay.close())
  const dial = async (session?: Buffer) => {
    const socket = tlsConnect({
      host: '127.0.0.1',
      port: relay.port,
      ca: certificate.cert,
      servername: 'localhost',
      ALPNProtocols: ['http/1.1'],
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      ...(session ? { session } : {}),
    })
    let tickets = 0,
      received: Buffer | undefined
    socket.on('session', session => {
      tickets++
      received = session
    })
    await once(socket, 'secureConnect')
    socket.write('GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
    socket.resume()
    const resumed = socket.isSessionReused(),
      initial = socket.getSession()
    await once(socket, 'close')
    return { resumed, stored: received ?? initial, tickets }
  }
  const first = await dial()
  expect(first.resumed).toBe(false)
  const second = await dial(first.stored)
  expect(second.resumed).toBe(false)
})
