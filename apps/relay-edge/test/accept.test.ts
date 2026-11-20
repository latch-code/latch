import { afterEach, expect, it } from 'vitest'
import { createTransportCertificate, nodeCrypto } from '@latch/link-client'
import { hex } from '@latch/link-wire'
import { runAcceptance } from '../scripts/accept-core.ts'
import { startTlsEdge } from './tls-edge.ts'

/**
 * The owner's acceptance run, exercised against the local Workers adapter over real TLS. On Cloudflare the same items
 * check what this fixture cannot: the platform's own buffering, close and memory.
 */
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run()
})

it('passes every item against the local edge and prints nothing secret', async () => {
  const certificate = createTransportCertificate(Date.now(), 3_600_000, 'localhost')
  const seed = nodeCrypto.random(32),
    relayId = nodeCrypto.random(16),
    token = nodeCrypto.random(32),
    admin = hex(nodeCrypto.random(32))
  const edge = await startTlsEdge({
    seed,
    relayId,
    certificate,
    env: {
      REGISTRATION_TOKEN: hex(token),
      OPEN_REGISTRATION: 'false',
      ADMIN_TOKEN: admin,
    },
  })
  cleanup.push(() => edge.close())
  const items = await runAcceptance(
    {
      url: edge.url,
      relayId,
      relayKey: await nodeCrypto.publicKey(seed),
      shard: 0,
      registrationToken: token,
      adminToken: admin,
      sockets: 12,
      slowSeconds: 30,
      slowRate: 4 * 1024 * 1024,
      lineBytes: 8 * 1024 * 1024,
      lineRate: 8 * 1024 * 1024,
    },
    { ca: certificate.cert, address: '127.0.0.1' },
  )
  expect(items.map(item => [item.name, item.result])).toEqual([
    ['healthz', 'pass'],
    ['admin', 'pass'],
    ['wrong-key', 'pass'],
    ['register', 'pass'],
    ['cover', 'pass'],
    ['unauthenticated', 'pass'],
    ['oversized', 'pass'],
    ['line-rate', 'pass'],
    ['slow-reader', 'pass'],
  ])
  const printed = JSON.stringify(items)
  for (const secret of [hex(token), Buffer.from(token).toString('base64url'), admin, hex(seed), edge.url.host])
    expect(printed).not.toContain(secret)
}, 120_000)

it('stops before any load when the admin token does not prove the relay is the operator’s own', async () => {
  const certificate = createTransportCertificate(Date.now(), 3_600_000, 'localhost')
  const relayId = nodeCrypto.random(16),
    seed = nodeCrypto.random(32)
  const edge = await startTlsEdge({ seed, relayId, certificate, env: { ADMIN_TOKEN: hex(nodeCrypto.random(32)) } })
  cleanup.push(() => edge.close())
  const items = await runAcceptance(
    {
      url: edge.url,
      relayId,
      relayKey: await nodeCrypto.publicKey(seed),
      shard: 0,
      adminToken: hex(nodeCrypto.random(32)),
      sockets: 4,
      slowSeconds: 1,
      slowRate: 1024,
      lineBytes: 1024,
      lineRate: 1024,
    },
    { ca: certificate.cert, address: '127.0.0.1' },
  )
  expect(items.map(item => [item.name, item.result])).toEqual([
    ['healthz', 'pass'],
    ['admin', 'fail'],
    ['wrong-key', 'skipped'],
    ['register', 'skipped'],
    ['cover', 'skipped'],
    ['unauthenticated', 'skipped'],
    ['oversized', 'skipped'],
    ['line-rate', 'skipped'],
    ['slow-reader', 'skipped'],
  ])
  // Nothing reached a node object: no load ran against a relay that is not provably the operator's.
  expect([...edge.objects.nodes.values()].every(node => node.status().sockets === 0)).toBe(true)
}, 60_000)
