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
      // A small backlog bound, so that the loopback socket buffers fill within the test.
      LIMITS: JSON.stringify({ maxBacklogBytes: 65_536 }),
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
      slowRate: 512 * 1024,
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
    ['slow-reader', 'pass'],
  ])
  const printed = JSON.stringify(items)
  for (const secret of [hex(token), Buffer.from(token).toString('base64url'), admin, hex(seed), edge.url.host])
    expect(printed).not.toContain(secret)
}, 120_000)

it('fails the identity item when the node answers with another relay key', async () => {
  const certificate = createTransportCertificate(Date.now(), 3_600_000, 'localhost')
  const relayId = nodeCrypto.random(16)
  const edge = await startTlsEdge({ seed: nodeCrypto.random(32), relayId, certificate, env: { OPEN_REGISTRATION: 'true' } })
  cleanup.push(() => edge.close())
  const items = await runAcceptance(
    { url: edge.url, relayId, relayKey: nodeCrypto.random(32), shard: 0, sockets: 1, slowSeconds: 1, slowRate: 1024 },
    { ca: certificate.cert, address: '127.0.0.1' },
  )
  // Every handshake that checks the key refuses this node; health and the hidden admin routes still answer.
  expect(Object.fromEntries(items.map(item => [item.name, item.result]))).toMatchObject({
    healthz: 'pass',
    register: 'fail',
    cover: 'fail',
    'slow-reader': 'skipped',
  })
}, 60_000)
