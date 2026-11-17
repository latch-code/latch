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
    DAILY_MESSAGES: '100000',
    MONTHLY_MESSAGES: '1000000',
    WORK: service,
    ...overrides,
  }
  const objects = new FakeObjects(platform, () => env)
  cleanup.push(() => {
    for (const name of [...objects.nodes.keys()]) objects.reset(name)
  })
  async function open(role: EdgeRole, prefix = '192.0.2.0/24', name = 'n'): Promise<ClientSocket> {
    const node = await objects.object(name)
    const response = (await node.fetch(
      request('https://node/ws', 'GET', { 'x-latch-role': role, 'x-latch-prefix': prefix }),
    )) as FakeResponse
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
  async function register(host: ClientSocket, value: Credentials, skip = 0) {
    const challenge = await hello(host, 'host')
    const input = registrationInput(relayId, challenge.nonce, value.day, value.publicKey)
    const register: Extract<RelayMessage, { type: 'register' }> = {
      type: 'register',
      previous: new Uint8Array(32),
      day: value.day,
      routePub: value.publicKey,
      signature: await nodeCrypto.sign(value.key, input),
      regMac: new Uint8Array(16),
      alternate: false,
    }
    host.send(register)
    return { challenge, register, reply: await host.next(clock, skip + 1) }
  }
  async function join(value: Credentials, prefix = '198.51.100.0/24') {
    const host = await open('host')
    const { reply } = await register(host, value)
    if (reply.type !== 'registered') throw new Error(`expected registered, got ${reply.type}`)
    const client = await open('client', prefix)
    const challenge = await hello(client, 'client')
    const proof = await makeProof(nodeCrypto, value.device.seed, value.pass, challenge.timeMs, challenge.nonce)
    client.send({ type: 'bound-admit', proof })
    expect((await client.next(clock, 1)).type).toBe('admitted')
    const open_ = await host.next(clock, 2)
    if (open_.type !== 'open') throw new Error('expected open')
    const data = await open('data')
    await hello(data, 'data')
    const nonce = nodeCrypto.random(16)
    data.send({
      type: 'attach',
      routeId: value.routeId,
      connection: open_.connection,
      nonce,
      mac: await attachMac(nodeCrypto, reply.token, value.routeId, open_.connection, nonce),
    })
    expect((await data.next(clock, 1)).type).toBe('attached')
    expect((await data.next(clock, 2)).type).toBe('spliced')
    expect((await client.next(clock, 2)).type).toBe('spliced')
    return { host, client, data, proof, token: reply.token }
  }
  return { clock, objects, env, open, hello, credentials, register, join }
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
    await t.clock.advance(40)
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

  it('drains: GOAWAY to Hosts, new sockets refused, health 503', async () => {
    const t = setup()
    const value = await t.credentials()
    const host = await t.open('host')
    await t.register(host, value)
    const node = await t.objects.object('n')
    expect((await node.fetch(request('https://node/health'))).status).toBe(200)
    expect((await node.fetch(request('https://node/drain', 'POST'))).status).toBe(200)
    expect(await host.next(t.clock, 2)).toEqual({ type: 'goaway', reason: 1, retryAfterMs: 30_000 })
    expect((await node.fetch(request('https://node/health'))).status).toBe(503)
    const late = await t.open('client')
    expect(late.closed).toBe(4302)
  })

  it('caps spending: refuses every role with 4304 and evicts joined pairs once the budget is spent', async () => {
    const t = setup({ DAILY_MESSAGES: '30' })
    const value = await t.credentials()
    const { client, data, host } = await t.join(value)
    for (let index = 0; index < 30; index++) client.send({ type: 'data', data: Uint8Array.of(index) })
    await settle()
    await t.clock.advance(1000)
    expect(client.closed).toBe(4304)
    expect(data.closed).toBeDefined()
    expect(host.messages().some(message => message.type === 'goaway' && message.reason === 3)).toBe(true)
    expect((await t.open('host')).closed).toBe(4304)
    expect((await t.open('client')).closed).toBe(4304)
    // The reservation survives a reset: a restarted object is still over the cap.
    t.objects.reset('n')
    expect((await t.open('host')).closed).toBe(4304)
  })

  it('fails closed without caps, a seed or a relay ID', async () => {
    for (const env of [{ DAILY_MESSAGES: undefined }, { MONTHLY_MESSAGES: '0' }]) {
      const t = setup(env)
      expect((await t.open('host')).closed).toBe(4304)
    }
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
      expect((await node.fetch(request('https://node/health'))).status).toBe(503)
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

  it('bounds connections per address prefix and refuses clients once the object is full', async () => {
    const t = setup({ LIMITS: JSON.stringify({ maxPerPrefix: 2, maxRoutesPerPrefix: 8, maxPairs: 1 }) })
    const first = await t.open('client', '203.0.113.0/24')
    await t.open('client', '203.0.113.0/24')
    await t.open('client', '203.0.113.0/24')
    expect(first.closed).toBe(4302)
    const value = await t.credentials()
    await t.join(value)
    expect((await t.open('client', '192.0.2.0/24')).closed).toBe(4302)
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
})
