import { scryptSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  attachMac,
  hex,
  holder,
  issuePass,
  makeProof,
  registrationInput,
  registrationMac,
  registrationWorkInput,
  decodeMessage,
  encodeMessage,
  REGISTRATION_WORK,
  routeId,
  routeKey,
  UTC_DAY,
  verifyEdgeChallenge,
  workDigestMeetsBits,
  type EdgeRole,
  type RelayMessage,
} from '@latch/link-wire'
import { nodeCrypto } from '@latch/link-client/crypto'
import { createWorkHandler } from '../src/work-handler.ts'
import { frameBytes } from '../src/node.ts'
import { EDGE_BUFFER_LIMITS } from '../src/buffers.ts'
import type { EdgeEnv, EdgeService } from '../src/platform.ts'
import { ClientSocket, FakeClock, FakeObjects, FakeResponse, fakePlatform, request, settle } from './harness.ts'
import { webcrypto } from 'node:crypto'

const relayId = new Uint8Array(16).fill(7),
  relaySeed = new Uint8Array(32).fill(9)
const relayKey = await nodeCrypto.publicKey(relaySeed)
const cleanup: Array<() => void> = []
afterEach(() => {
  for (const run of cleanup.splice(0)) run()
})

function setup(overrides: Partial<EdgeEnv> = {}) {
  const clock = new FakeClock(),
    platform = fakePlatform(clock)
  const work = createWorkHandler(
    webcrypto.subtle as never,
    (status, body) => new FakeResponse(status, body ? hex(new Uint8Array(body)) : undefined),
  )
  const service: EdgeService = {
    fetch: async (url, init) => {
      const response = await work.fetch(request(url, init.method, { 'content-length': String(init.body.length) }, init.body))
      const body = Uint8Array.from((await response.text()).match(/../gu) ?? [], byte => Number.parseInt(byte, 16))
      return { status: response.status, arrayBuffer: async () => body.buffer as ArrayBuffer }
    },
  }
  const env: EdgeEnv = {
    RELAY_ID: hex(relayId),
    OPEN_REGISTRATION: 'true',
    RELAY_SIGNING_SEED: hex(relaySeed),
    WORK: service,
    ...overrides,
  }
  const objects = new FakeObjects(platform, () => env)
  cleanup.push(() => {
    for (const name of [...objects.nodes.keys()]) objects.reset(name)
  })
  async function attempt(role: EdgeRole, prefix = '192.0.2.0/24', name = 'n'): Promise<FakeResponse> {
    const node = await objects.object(name)
    return (await node.fetch(request('https://node/ws', 'GET', { 'x-latch-role': role, 'x-latch-prefix': prefix }))) as FakeResponse
  }
  async function open(role: EdgeRole, prefix = '192.0.2.0/24', name = 'n'): Promise<ClientSocket> {
    const response = await attempt(role, prefix, name)
    expect(response.status).toBe(101)
    expect(response.headers['Sec-WebSocket-Protocol']).toBe('latch-relay.2')
    await settle()
    return response.client!
  }
  async function hello(socket: ClientSocket, role: EdgeRole) {
    const clientNonce = nodeCrypto.random(32)
    socket.send({ type: 'edge-hello', clientNonce })
    const challenge = await socket.next(clock)
    if (challenge.type !== 'edge-challenge') throw new Error('expected challenge')
    expect(
      await verifyEdgeChallenge(
        nodeCrypto,
        relayKey,
        { relayId, role, clientNonce, relayNonce: challenge.nonce, timeMs: challenge.timeMs, requiresToken: challenge.requiresToken },
        challenge.signature,
      ),
    ).toBe(true)
    return challenge
  }
  async function credentials(deviceId = 1) {
    const day = Math.floor(clock.now / 1000 / UTC_DAY),
      seed = nodeCrypto.random(32),
      key = await routeKey(nodeCrypto, seed, relayId, day),
      publicKey = await nodeCrypto.publicKey(key),
      device = await holder(nodeCrypto, seed, relayId, Uint8Array.of(deviceId), day)
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
    return { day, key, publicKey, device, pass, seed, routeId: await routeId(nodeCrypto, publicKey) }
  }
  type Credentials = Awaited<ReturnType<typeof credentials>>
  async function register(host: ClientSocket, value: Credentials, skip = 0, previous: Uint8Array = new Uint8Array(32)) {
    const challenge = await hello(host, 'host')
    const input = registrationInput(relayId, challenge.nonce, value.day, value.publicKey)
    const register: Extract<RelayMessage, { type: 'register' }> = {
      type: 'register',
      previous,
      day: value.day,
      routePub: value.publicKey,
      signature: await nodeCrypto.sign(value.key, input),
      regMac: new Uint8Array(16),
      alternate: false,
    }
    host.send(register)
    return { challenge, register, reply: await host.next(clock, skip + 1) }
  }
  /** Another holder's pass on the same route: one more phone of the same Host. */
  async function holderOf(value: Credentials, deviceId: number) {
    const device = await holder(nodeCrypto, value.seed, relayId, Uint8Array.of(deviceId), value.day)
    const pass = await issuePass(nodeCrypto, value.key, {
      pairing: false,
      relayId,
      day: value.day,
      notBefore: value.day * UTC_DAY,
      notAfter: (value.day + 1) * UTC_DAY,
      routePub: value.publicKey,
      holderPub: await nodeCrypto.publicKey(device.seed),
      tag: device.tag,
    })
    return { device, pass }
  }
  async function join(value: Credentials, prefix = '198.51.100.0/24') {
    const host = await open('host')
    const { reply } = await register(host, value)
    if (reply.type !== 'registered') throw new Error(`expected registered, got ${reply.type}`)
    return { host, ...(await pair(host, value, reply.token, prefix)) }
  }
  async function pair(
    host: ClientSocket,
    value: Credentials,
    token: Uint8Array,
    prefix = '198.51.100.0/24',
    who: { device: { seed: Uint8Array }; pass: Uint8Array } = value,
  ) {
    const seen = host.messages().filter(message => message.type !== 'pad').length
    const client = await open('client', prefix)
    const challenge = await hello(client, 'client')
    const proof = await makeProof(nodeCrypto, who.device.seed, who.pass, challenge.timeMs, challenge.nonce)
    client.send({ type: 'bound-admit', proof })
    expect((await client.next(clock, 1)).type).toBe('admitted')
    const open_ = await host.next(clock, seen)
    if (open_.type !== 'open') throw new Error('expected open')
    const data = await open('data')
    await hello(data, 'data')
    const nonce = nodeCrypto.random(16)
    data.send({
      type: 'attach',
      routeId: value.routeId,
      connection: open_.connection,
      nonce,
      mac: await attachMac(nodeCrypto, token, value.routeId, open_.connection, nonce),
    })
    expect((await data.next(clock, 1)).type).toBe('attached')
    expect((await data.next(clock, 2)).type).toBe('spliced')
    expect((await client.next(clock, 2)).type).toBe('spliced')
    await settle()
    return { client, data, proof, token }
  }
  return { clock, platform, objects, env, attempt, open, hello, credentials, holderOf, register, join, pair }
}

describe('edge relay node', () => {
  it('registers, admits with the nonce-bound proof, joins and carries DATA both ways', async () => {
    const t = setup()
    const value = await t.credentials()
    const { client, data } = await t.join(value)
    client.send({ type: 'data', data: Uint8Array.of(1, 2, 3) })
    data.send({ type: 'data', data: Uint8Array.of(4, 5) })
    expect(await data.next(t.clock, 3)).toEqual({ type: 'data', data: Uint8Array.of(1, 2, 3) })
    expect(await client.next(t.clock, 3)).toEqual({ type: 'data', data: Uint8Array.of(4, 5) })
  })

  it('pads the first three seconds of node output to 4 KiB buckets on the 40 ms grid', async () => {
    const t = setup()
    const client = await t.open('client')
    client.send({ type: 'edge-hello', clientNonce: nodeCrypto.random(32) })
    await t.clock.advance(40)
    await t.clock.advance(40)
    const sizes = client.received.map(payload => frameBytes(payload.length, false))
    expect(client.messages().map(message => message.type)).toEqual(['pad', 'edge-challenge', 'pad'])
    expect(sizes.reduce((a, b) => a + b, 0) % 4096).toBe(0)
    await t.clock.advance(3100)
    const before = client.received.length
    client.send({ type: 'ping' })
    await settle()
    expect(
      client
        .messages()
        .slice(before)
        .map(message => message.type),
    ).toEqual(['pong'])
  })

  it('refuses a replayed proof, an unbound v1 proof and the self-hosted HELLO', async () => {
    const t = setup()
    const value = await t.credentials()
    const { proof } = await t.join(value)
    const replay = await t.open('client', '203.0.113.0/24')
    await t.hello(replay, 'client')
    replay.send({ type: 'bound-admit', proof })
    // The proof check is real crypto: give it a few grid steps under a loaded machine.
    for (let step = 0; step < 10 && replay.closed === undefined; step++) await t.clock.advance(40)
    expect(replay.closed).toBe(4100)

    const unbound = await t.open('client', '203.0.113.0/24')
    const challenge = await t.hello(unbound, 'client')
    unbound.send({ type: 'admit', proof: await makeProof(nodeCrypto, value.device.seed, value.pass, challenge.timeMs) })
    await t.clock.advance(40)
    expect(unbound.closed).toBe(4400)

    const early = await t.open('client', '203.0.113.0/24')
    early.send({ type: 'bound-admit', proof })
    await t.clock.advance(40)
    expect(early.closed).toBe(4400)

    for (const role of ['host', 'client', 'data'] as const) {
      const plain = await t.open(role, '203.0.113.0/24')
      plain.send({ type: 'hello' })
      await t.clock.advance(40)
      expect(plain.closed).toBe(4400)
    }
  })

  it('makes DATA legs prove the relay first and attach only after the challenge', async () => {
    const t = setup()
    const value = await t.credentials()
    const host = await t.open('host')
    const { reply } = await t.register(host, value)
    if (reply.type !== 'registered') throw new Error('expected registered')
    const data = await t.open('data')
    data.send({ type: 'attach', routeId: value.routeId, connection: new Uint8Array(8), nonce: new Uint8Array(16), mac: new Uint8Array(16) })
    await t.clock.advance(40)
    expect(data.closed).toBe(4400)
  })

  it('answers application pings and closes a peer silent past the dead-peer limit', async () => {
    const t = setup()
    const value = await t.credentials()
    const host = await t.open('host')
    await t.register(host, value)
    host.send({ type: 'ping' })
    expect(await host.next(t.clock, 2)).toEqual({ type: 'pong' })
    for (let elapsed = 0; elapsed < 70_000; elapsed += 20_000) {
      await t.clock.advance(20_000)
      host.send({ type: 'ping' })
      await settle()
    }
    expect(host.closed).toBeUndefined()
    await t.clock.advance(76_000)
    expect(host.closed).toBe(1001)
  })

  it('drains: GOAWAY to Hosts and new sockets refused', async () => {
    const t = setup()
    const value = await t.credentials()
    const host = await t.open('host')
    await t.register(host, value)
    const node = await t.objects.object('n')
    expect(node.status()).toMatchObject({ ready: true })
    expect((await node.fetch(request('https://node/drain', 'POST'))).status).toBe(200)
    expect(await host.next(t.clock, 2)).toEqual({ type: 'goaway', reason: 1, retryAfterMs: 30_000 })
    expect(node.status()).toMatchObject({ ready: false, draining: true })
    const late = await t.open('client')
    expect(late.closed).toBe(4302)
  })

  it('bounds what a socket may send before it is authenticated: two messages, cover PAD only, a PING per 15 s', async () => {
    const t = setup()
    const chatty = await t.open('host')
    for (let index = 0; index < 3; index++) chatty.send({ type: 'deny', routeId: new Uint8Array(16), tags: [] })
    await settle()
    expect(chatty.closed).toBe(4400)
    const padHost = await t.open('host', '198.51.100.0/24')
    padHost.send({ type: 'pad', data: new Uint8Array(1) })
    await settle()
    expect(padHost.closed).toBe(4400)
    const late = await t.open('client', '198.51.100.0/24')
    await t.clock.advance(3600)
    late.send({ type: 'pad', data: new Uint8Array(1) })
    await settle()
    expect(late.closed).toBe(4400)
    const pinger = await t.open('host', '203.0.113.0/24')
    pinger.send({ type: 'ping' })
    await settle()
    expect(pinger.closed).toBeUndefined()
    pinger.send({ type: 'ping' })
    await settle()
    expect(pinger.closed).toBe(4400)
  })

  it('keeps the three-second outer cover through the inner handshake after the join', async () => {
    const t = setup()
    const value = await t.credentials()
    const { client, data } = await t.join(value)
    const before = client.received.length
    data.send({ type: 'data', data: Uint8Array.of(9) })
    await settle()
    // Still inside the first three seconds: the DATA waits for the 40 ms grid and leaves with a PAD to the bucket.
    expect(client.received.length).toBe(before)
    await t.clock.advance(40)
    const batch = client.received.slice(before)
    expect(batch.map(payload => decodeMessage(payload, 2).type)).toEqual(['data', 'pad'])
    expect(batch.reduce((sum, payload) => sum + frameBytes(payload.length, false), 0) % 4096).toBe(0)
  })

  it('arms its alarm only while sockets are connected', async () => {
    const t = setup()
    await t.objects.object('n')
    expect(t.objects.alarms.has('n')).toBe(false)
    const socket = await t.open('host')
    expect(t.objects.alarms.has('n')).toBe(true)
    socket.close()
    await settle()
    t.objects.alarms.delete('n')
    await (await t.objects.object('n')).alarm()
    expect(t.objects.alarms.has('n')).toBe(false)
  })

  it('fails closed without a seed, a relay ID or a registration choice', async () => {
    for (const env of [
      { RELAY_SIGNING_SEED: 'aa' },
      { RELAY_ID: undefined },
      { LIMITS: '{"maxPairs":-1}' },
      // Open registration is never a default: no token and no explicit choice, or both at once, is not a configuration.
      { OPEN_REGISTRATION: undefined },
      { REGISTRATION_TOKEN: 'ab'.repeat(32) },
    ]) {
      const t = setup(env)
      const node = await t.objects.object('n')
      expect(
        (await node.fetch(request('https://node/ws', 'GET', { 'x-latch-role': 'host', 'x-latch-prefix': '192.0.2.0/24' }))).status,
      ).toBe(503)
      expect(node.status()).toMatchObject({ ready: false })
    }
  })

  it('registers only Hosts holding the registration token of a personal relay', async () => {
    const token = new Uint8Array(32).fill(4)
    const t = setup({ OPEN_REGISTRATION: undefined, REGISTRATION_TOKEN: hex(token) })
    const value = await t.credentials()
    const without = await t.open('host')
    const challenge = await t.hello(without, 'host')
    expect(challenge.requiresToken).toBe(true)
    without.send({
      type: 'register',
      previous: new Uint8Array(32),
      day: value.day,
      routePub: value.publicKey,
      signature: await nodeCrypto.sign(value.key, registrationInput(relayId, challenge.nonce, value.day, value.publicKey)),
      regMac: new Uint8Array(16),
      alternate: false,
    })
    await t.clock.advance(40)
    expect(without.closed).toBe(4100)
    const host = await t.open('host')
    const second = await t.hello(host, 'host')
    const input = registrationInput(relayId, second.nonce, value.day, value.publicKey)
    host.send({
      type: 'register',
      previous: new Uint8Array(32),
      day: value.day,
      routePub: value.publicKey,
      signature: await nodeCrypto.sign(value.key, input),
      regMac: await registrationMac(nodeCrypto, token, input),
      alternate: false,
    })
    expect(await host.next(t.clock, 1)).toMatchObject({ type: 'registered' })
  })

  it('keeps DENY tags in storage across an object reset', async () => {
    const t = setup()
    const value = await t.credentials()
    const host = await t.open('host')
    await t.register(host, value)
    host.send({ type: 'deny', routeId: value.routeId, tags: [value.device.tag] })
    const ack = await host.next(t.clock, 2)
    expect(ack).toMatchObject({ type: 'deny-ack', count: 1 })
    t.objects.reset('n')
    const again = await t.open('host')
    await t.register(again, value)
    const client = await t.open('client', '198.51.100.0/24')
    const challenge = await t.hello(client, 'client')
    client.send({
      type: 'bound-admit',
      proof: await makeProof(nodeCrypto, value.device.seed, value.pass, challenge.timeMs, challenge.nonce),
    })
    await t.clock.advance(40)
    expect(client.closed).toBe(4100)
  })

  it('refuses new phones once the object carries its capacity of joined pairs', async () => {
    const t = setup({ LIMITS: JSON.stringify({ maxPairs: 1 }) })
    await t.join(await t.credentials())
    expect((await t.open('client', '100.64.0.0/24')).closed).toBe(4302)
  })

  it('bounds connections per address prefix', async () => {
    const t = setup({ LIMITS: JSON.stringify({ maxPerPrefix: 2, maxRoutesPerPrefix: 8 }) })
    const first = await t.open('client', '203.0.113.0/24')
    await t.open('client', '203.0.113.0/24')
    await t.open('client', '203.0.113.0/24')
    expect(first.closed).toBe(4302)
  })

  it('bounds the cover queue before sending it to the runtime', async () => {
    const t = setup()
    const value = await t.credentials()
    const { client, data } = await t.join(value)
    // Still inside the cover: more than 64 KiB queued for the phone closes it, as on the self-hosted relay.
    for (let index = 0; index < 5; index++) data.send({ type: 'data', data: new Uint8Array(16_000) })
    await settle()
    expect(client.closed).toBe(4302)
  })

  it('closes a slow reader on its reported backlog and holds its slot for the hold time by the clock', async () => {
    const t = setup({ LIMITS: JSON.stringify({ maxConnections: 3, maxBacklogBytes: 65_536 }) })
    const { client, data } = await t.join(await t.credentials())
    await t.clock.advance(3100)
    data.server.paused = true
    for (let index = 0; index < 20 && data.server.closeCode === undefined; index++) {
      client.send({ type: 'data', data: new Uint8Array(16_000) })
      await t.clock.advance(40)
    }
    expect(data.server.closeCode).toBe(4302)
    expect(data.server.bufferedAmount).toBeLessThanOrEqual(65_536 + 16_100)
    const node = await t.objects.object('n')
    // The closed sockets keep their slots for the hold time, whatever the runtime reports or delivers.
    const slots = () => (node.status().buffered as { slots: number }).slots
    expect(slots()).toBe(3)
    data.server.paused = false
    data.server.flush()
    await settle()
    expect(slots()).toBe(3)
    await t.clock.advance(EDGE_BUFFER_LIMITS.closeHoldMs)
    expect(slots()).toBe(1)
    expect(node.status().buffered).toMatchObject({ bytes: 0 })
  })

  it.each([undefined, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'serves a socket whose runtime reports bufferedAmount as %s',
    async amount => {
      const t = setup()
      const pair = t.platform.pair
      t.platform.pair = () => {
        const [client, server] = pair()
        Object.defineProperty(server, 'bufferedAmount', { value: amount })
        return [client, server]
      }
      expect((await t.attempt('client')).status).toBe(101)
    },
  )

  it('lets a phone with a pass and a Host re-registration through while five prefixes squat on unauthenticated sockets', async () => {
    const t = setup()
    const value = await t.credentials()
    const host = await t.open('host', '203.0.113.0/24')
    const { reply } = await t.register(host, value)
    if (reply.type !== 'registered') throw new Error('expected registered')
    // Five prefixes open client sockets that never send anything, faster than the core closes them.
    const squat = async (count: number) => {
      for (let index = 0; index < count; index++) await t.open('client', `10.0.${index % 5}.0/24`)
    }
    await squat(25)
    const node = await t.objects.object('n')
    expect((node.status().buffered as { covered: number }).covered).toBe(EDGE_BUFFER_LIMITS.maxCovered)
    // A phone of a sixth prefix (and the Host's DATA leg) get in: squatters of the largest prefixes make room.
    const { client } = await t.pair(host, value, reply.token, '198.51.100.0/24')
    expect(client.closed).toBeUndefined()
    // The Host re-registers on a new control socket with its token, still while squatters keep coming.
    await squat(5)
    host.close()
    await settle()
    const again = await t.open('host', '203.0.113.0/24')
    const second = await t.register(again, value, 0, reply.token)
    expect(second.reply.type).toBe('registered')
    expect((node.status().buffered as { refused: number }).refused).toBe(0)
    expect(node.status().startedAt).toEqual(expect.any(Number))
  })

  it('makes room for a phone when other prefixes hold every connection slot', async () => {
    const t = setup({ LIMITS: JSON.stringify({ maxConnections: 8 }) })
    const value = await t.credentials()
    const host = await t.open('host', '203.0.113.0/24')
    const { reply } = await t.register(host, value)
    if (reply.type !== 'registered') throw new Error('expected registered')
    // Two prefixes fill the remaining slots with Host-role sockets that never authenticate.
    for (let index = 0; index < 7; index++) await t.open('host', `10.0.${index % 2}.0/24`)
    expect((await t.objects.object('n')).status().sockets).toBe(8)
    const { client } = await t.pair(host, value, reply.token, '198.51.100.0/24')
    expect(client.closed).toBeUndefined()
    expect(host.closed).toBeUndefined()
  })

  it('closes on malformed input: text, unknown tags, oversized and truncated messages', async () => {
    const t = setup()
    for (const payload of ['hello', Uint8Array.of(200), new Uint8Array(65_537), Uint8Array.of(39, 1, 2)]) {
      const socket = await t.open('client')
      socket.raw(payload)
      await t.clock.advance(40)
      expect(socket.closed).toBe(4400)
    }
  })

  it('takes the registration work off the object to the work Worker and accepts a real solution', async () => {
    const t = setup({ LIMITS: JSON.stringify({ softRoutesPerPrefix: 1, maxRoutesPerPrefix: 8, minBits: 0, maxBits: 2 }) })
    const first = await t.open('host')
    await t.register(first, await t.credentials())
    const host = await t.open('host')
    const value = await t.credentials(2)
    const { challenge, register, reply } = await t.register(host, value)
    if (reply.type !== 'registration-work') throw new Error(`expected work, got ${reply.type}`)
    const packet = encodeMessage(register)
    let solution = new Uint8Array(8)
    for (let counter = 0; ; counter++) {
      solution = new Uint8Array(8)
      new DataView(solution.buffer).setUint32(4, counter)
      const input = registrationWorkInput(relayId, challenge.nonce, reply.nonce, packet, solution)
      const { N, r, p, keyLength, maxMemory } = REGISTRATION_WORK
      if (workDigestMeetsBits(scryptSync(input, reply.nonce, keyLength, { N, r, p, maxmem: maxMemory }), reply.bits)) break
    }
    host.send({ type: 'registration-proof', routeId: reply.routeId, nonce: reply.nonce, solution })
    await t.clock.advance(40)
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(await host.next(t.clock, 2)).toMatchObject({ type: 'registered', status: 0 })
  }, 30_000)

  it('holds a work slot until the work Worker answers, also past the timeout', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => (release = resolve))
    const service: EdgeService = {
      fetch: async () => {
        await pending
        return { status: 200, arrayBuffer: async () => Uint8Array.of(0).buffer as ArrayBuffer }
      },
    }
    const t = setup({ WORK: service, LIMITS: JSON.stringify({ softRoutesPerPrefix: 1, maxRoutesPerPrefix: 8, maxConcurrent: 1 }) })
    const first = await t.open('host')
    await t.register(first, await t.credentials())
    const ask = async (index: number) => {
      const host = await t.open('host')
      const { reply } = await t.register(host, await t.credentials(index))
      if (reply.type !== 'registration-work') throw new Error('expected work')
      host.send({ type: 'registration-proof', routeId: reply.routeId, nonce: reply.nonce, solution: new Uint8Array(8) })
      await settle()
      return host
    }
    const slow = await ask(2)
    await t.clock.advance(2000)
    expect(slow.closed).toBe(4302)
    // The first job still runs in the work Worker: the next proof finds no free slot.
    const next = await ask(3)
    expect(next.closed).toBe(4302)
    release()
    await settle()
    const after = await ask(4)
    await settle()
    expect(after.closed).toBe(4100)
  })
})
