import { scryptSync, webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { hex, REGISTRATION_WORK } from '@latch/link-wire'
import { nodeCrypto } from '@latch/link-client/crypto'
import { addressPrefix } from '@latch/relay'
import { webLinkCrypto } from '../src/crypto.ts'
import { createEdgeWorker } from '../src/edge.ts'
import { edgeAddressPrefix } from '../src/prefix.ts'
import { checkWork, encodeWorkRequest, scrypt } from '../src/scrypt.ts'
import type { EdgeEnv, EdgeSubtle } from '../src/platform.ts'
import { FakeClock, FakeObjects, FakeResponse, fakePlatform, request } from './harness.ts'

const subtle = webcrypto.subtle as unknown as EdgeSubtle
const ADMIN = 'a'.repeat(40)
function setup(overrides: Partial<EdgeEnv> = {}) {
  const clock = new FakeClock(),
    platform = fakePlatform(clock)
  let env: EdgeEnv = {}
  const objects = new FakeObjects(platform, () => env)
  env = {
    NODE: objects.namespace(),
    NODE_HOSTS: 'latch-relay-ne.example.workers.dev, ne.relay.example',
    LOCATION_HINT: 'apac-ne',
    RELAY_ID: hex(new Uint8Array(16).fill(7)),
    OPEN_REGISTRATION: 'true',
    RELAY_SIGNING_SEED: hex(new Uint8Array(32).fill(9)),
    ADMIN_TOKEN: ADMIN,
    ...overrides,
  }
  return { worker: createEdgeWorker(platform), env, objects }
}
const upgrade = (extra: Record<string, string | undefined> = {}) =>
  Object.fromEntries(
    Object.entries({
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
      'sec-websocket-protocol': 'latch-relay.2',
      'cf-connecting-ip': '203.0.113.77',
      ...extra,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )

describe('edge Worker front', () => {
  it('routes a checked upgrade to the shard object near its hint and passes only the role and the prefix', async () => {
    const t = setup({ SHARDS: '2' })
    for (const host of ['latch-relay-ne.example.workers.dev', 'ne.relay.example']) {
      const response = await t.worker.fetch(request(`https://${host}/v1/c/1`, 'GET', upgrade()), t.env)
      expect(response.status).toBe(101)
    }
    const sent = t.objects.requests.filter(item => item.url === 'https://node/ws')
    expect(sent.map(item => item.headers)).toEqual([
      { Upgrade: 'websocket', 'X-Latch-Role': 'client', 'X-Latch-Prefix': '203.0.113.0/24' },
      { Upgrade: 'websocket', 'X-Latch-Role': 'client', 'X-Latch-Prefix': '203.0.113.0/24' },
    ])
    expect(JSON.stringify(t.objects.requests)).not.toContain('203.0.113.77')
    expect(sent[0]!.name).toBe(`${t.env.RELAY_ID}:1:1`)
    expect(t.objects.hints.get(sent[0]!.name)).toBe('apac-ne')
  })

  it('refuses what the self-hosted relay refuses, without saying why', async () => {
    const t = setup()
    const url = 'https://latch-relay-ne.example.workers.dev'
    for (const [path, headers, status] of [
      ['/v1/c/0', upgrade({ origin: 'https://evil.example' }), 400],
      ['/v1/c/0', upgrade({ 'sec-websocket-extensions': 'permessage-deflate' }), 400],
      ['/v1/c/0', upgrade({ 'sec-websocket-protocol': 'latch-relay.1' }), 400],
      ['/v1/c/0', upgrade({ 'sec-websocket-key': 'short' }), 400],
      ['/v1/c/0', upgrade({ 'content-length': '3' }), 400],
      ['/v1/c/0', upgrade({ 'cf-connecting-ip': undefined }), 400],
      ['/v1/c/0', upgrade({ 'cf-connecting-ip': 'not-an-ip' }), 400],
      ['/v1/c/1', upgrade(), 400],
      ['/v1/c', upgrade(), 404],
      ['/v1/x/0', upgrade(), 404],
      ['/v1/c/0?pass=1', upgrade(), 404],
    ] as const) {
      const response = await t.worker.fetch(request(`${url}${path}`, 'GET', headers), t.env)
      expect(response.status).toBe(status)
      expect(await response.text()).toBe('')
    }
    // Edge-consumed handshake headers may be absent.
    const minimal = upgrade({ 'sec-websocket-key': undefined, 'sec-websocket-version': undefined, connection: undefined })
    expect((await t.worker.fetch(request(`${url}/v1/h/0`, 'GET', minimal), t.env)).status).toBe(101)
    expect((await t.worker.fetch(request('https://other.example/v1/c/0', 'GET', upgrade()), t.env)).status).toBe(503)
    for (const env of [{ RELAY_SIGNING_SEED: undefined }, { RELAY_ID: 'zz' }, { SHARDS: '17' }, { LOCATION_HINT: undefined }]) {
      const broken = setup(env)
      expect((await broken.worker.fetch(request(`${url}/v1/c/0`, 'GET', upgrade()), broken.env)).status).toBe(503)
    }
  })

  it('serves health openly and status and drain only with the admin token', async () => {
    const t = setup()
    const url = 'https://latch-relay-ne.example.workers.dev'
    expect((await t.worker.fetch(request(`${url}/healthz`), t.env)).status).toBe(200)
    for (const authorization of [undefined, 'Bearer short', `Bearer ${'b'.repeat(40)}`, ADMIN])
      expect((await t.worker.fetch(request(`${url}/admin/status`, 'GET', authorization ? { authorization } : {}), t.env)).status).toBe(404)
    const status = (await t.worker.fetch(
      request(`${url}/admin/status`, 'GET', { authorization: `Bearer ${ADMIN}` }),
      t.env,
    )) as FakeResponse
    expect(status.status).toBe(200)
    expect(JSON.parse(status.body!).shards[0]).toMatchObject({ ready: true, routes: 0, pairs: 0 })
    expect((await t.worker.fetch(request(`${url}/admin/drain`, 'GET', { authorization: `Bearer ${ADMIN}` }), t.env)).status).toBe(404)
    expect((await t.worker.fetch(request(`${url}/admin/drain`, 'POST', { authorization: `Bearer ${ADMIN}` }), t.env)).status).toBe(200)
    // Health never reaches a node object (no billed request); the drain shows in the admin status.
    expect((await t.worker.fetch(request(`${url}/healthz`), t.env)).status).toBe(200)
    const drained = (await t.worker.fetch(
      request(`${url}/admin/status`, 'GET', { authorization: `Bearer ${ADMIN}` }),
      t.env,
    )) as FakeResponse
    expect(JSON.parse(drained.body!).shards[0]).toMatchObject({ ready: false, draining: true })
    const requests = t.objects.requests.length
    await t.worker.fetch(request(`${url}/healthz`), t.env)
    expect(t.objects.requests.length).toBe(requests)
    const unset = setup({ ADMIN_TOKEN: undefined })
    expect((await unset.worker.fetch(request(`${url}/admin/drain`, 'POST', { authorization: `Bearer ${ADMIN}` }), unset.env)).status).toBe(
      404,
    )
  })
})

describe('edge building blocks match the Node implementations', () => {
  it('WebCrypto LinkCrypto signs, derives and hashes as Node does', async () => {
    const crypto = webLinkCrypto(subtle, size => webcrypto.getRandomValues(new Uint8Array(size)))
    const seed = new Uint8Array(32).fill(3),
      input = Uint8Array.of(1, 2, 3)
    expect(await crypto.publicKey(seed)).toEqual(await nodeCrypto.publicKey(seed))
    expect(await crypto.sign(seed, input)).toEqual(await nodeCrypto.sign(seed, input))
    expect(await crypto.verify(await nodeCrypto.publicKey(seed), input, await nodeCrypto.sign(seed, input))).toBe(true)
    expect(await crypto.verify(await nodeCrypto.publicKey(seed), Uint8Array.of(9), await nodeCrypto.sign(seed, input))).toBe(false)
    expect(await crypto.hash(input)).toEqual(await nodeCrypto.hash(input))
    expect(await crypto.hmac(seed, input)).toEqual(await nodeCrypto.hmac(seed, input))
    expect(await crypto.derive(seed, input, input, 32)).toEqual(await nodeCrypto.derive(seed, input, input, 32))
  })

  it('computes the fairness prefix exactly as the self-hosted relay does', () => {
    for (const address of [
      '203.0.113.77',
      '::ffff:198.51.100.4',
      '2001:db8:abcd:12::1',
      '2001:0db8:0000:0001:0000:0000:0000:0001',
      '::1',
      '2400:cb00::',
      '64:ff9b::192.0.2.1',
      'FE80::1',
    ])
      expect(edgeAddressPrefix(address)).toBe(addressPrefix(address))
    for (const bad of ['', '1.2.3', '256.1.1.1', '1::2::3', 'gggg::1', '1.2.3.4.5', '1:2:3:4:5:6:7:8:9'])
      expect(() => edgeAddressPrefix(bad)).toThrow()
  })

  it('verifies registration work with the same scrypt as the self-hosted relay', async () => {
    const { N, r, p, keyLength, maxMemory } = REGISTRATION_WORK
    const password = Uint8Array.from({ length: 200 }, (_, index) => index),
      salt = new Uint8Array(32).fill(5)
    expect(hex(await scrypt(subtle, password, salt))).toBe(hex(scryptSync(password, salt, keyLength, { N, r, p, maxmem: maxMemory })))
    expect(await checkWork(subtle, encodeWorkRequest({ bits: 0, salt, input: password }))).toBe(true)
    expect(await checkWork(subtle, encodeWorkRequest({ bits: 0, salt, input: password.subarray(0, 8) }))).toBe(false)
    expect(await checkWork(subtle, Uint8Array.of(23, ...salt, ...password))).toBe(false)
  }, 30_000)
})
