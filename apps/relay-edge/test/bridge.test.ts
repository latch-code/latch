import { once } from 'node:events'
import { afterEach, expect, it } from 'vitest'
import { holder, issuePass, routeKey, UTC_DAY } from '@latch/link-wire'
import { connectRelayTunnel, createTransportCertificate, nodeCrypto, RelayControl, type RelayEndpoint } from '@latch/link-client'
import type { FakeObjects } from './harness.ts'
import { startTlsEdge } from './tls-edge.ts'

/**
 * The real Node clients (RelayControl, connectRelayTunnel) against the edge adapter, through real TLS and the same
 * WebSocket framing the edge puts on the wire. Like the edge, the bridge answers WebSocket pings itself.
 */
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run()
})
const certificate = createTransportCertificate(Date.now(), 3_600_000, 'localhost')
const relayId = nodeCrypto.random(16)

async function edgeServer(seed: Uint8Array): Promise<{ url: URL; objects: FakeObjects }> {
  const edge = await startTlsEdge({ seed, relayId, certificate, env: { OPEN_REGISTRATION: 'true' } })
  cleanup.push(() => edge.close())
  return edge
}

async function credentials() {
  const now = Date.now(),
    day = Math.floor(now / 1000 / UTC_DAY),
    seed = nodeCrypto.random(32),
    key = await routeKey(nodeCrypto, seed, relayId, day),
    device = await holder(nodeCrypto, seed, relayId, Uint8Array.of(1), day)
  const pass = await issuePass(nodeCrypto, key, {
    pairing: false,
    relayId,
    day,
    notBefore: day * UTC_DAY,
    notAfter: (day + 1) * UTC_DAY,
    routePub: await nodeCrypto.publicKey(key),
    holderPub: await nodeCrypto.publicKey(device.seed),
    tag: device.tag,
  })
  return { day, key, device, pass }
}

it('registers, admits and carries bytes both ways for the real Node clients, racing a wrong-key origin', async () => {
  const seed = nodeCrypto.random(32),
    impostor = await edgeServer(nodeCrypto.random(32)),
    real = await edgeServer(seed)
  const endpoint: RelayEndpoint = {
    // The first origin answers with another relay key: it loses the race to the second, whatever its hostname.
    url: impostor.url,
    extraUrls: [real.url],
    relayId,
    edge: { relayKey: await nodeCrypto.publicKey(seed), shard: 0 },
    ca: certificate.cert,
    profile: 'outer-pad-v2',
    resolveAddress: async () => '127.0.0.1',
  }
  const control = await RelayControl.connect({ ...endpoint })
  cleanup.push(() => control.close())
  expect(control.roundTripMs).toBeGreaterThanOrEqual(0)
  const value = await credentials()
  await control.register({ routeKey: value.key, day: value.day, alternate: false })
  const setup = control.accept()
  const downstream = await connectRelayTunnel({ ...endpoint, pass: value.pass, holderKey: value.device.seed })
  const upstream = await setup
  upstream.finishSetup()
  upstream.stream.on('data', chunk => upstream.stream.write(chunk))
  cleanup.push(() => {
    upstream.stream.destroy()
    downstream.destroy()
  })
  const echoed = once(downstream, 'data')
  downstream.write(Buffer.from('across the edge'))
  expect(String((await echoed)[0])).toBe('across the edge')
  expect(upstream.passTag).toEqual(value.device.tag)
  expect(impostor.objects.nodes.size + real.objects.nodes.size).toBe(2)
}, 30_000)

it('refuses a node whose challenge is signed by another key before sending anything that depends on it', async () => {
  const real = await edgeServer(nodeCrypto.random(32))
  const value = await credentials()
  const endpoint: RelayEndpoint = {
    url: real.url,
    relayId,
    edge: { relayKey: await nodeCrypto.publicKey(nodeCrypto.random(32)), shard: 0 },
    ca: certificate.cert,
    profile: 'outer-pad-v2',
    resolveAddress: async () => '127.0.0.1',
  }
  await expect(connectRelayTunnel({ ...endpoint, pass: value.pass, holderKey: value.device.seed })).rejects.toThrow(
    'Relay identity rejected',
  )
  await expect(RelayControl.connect({ ...endpoint })).rejects.toThrow('Relay identity rejected')
  // The node saw HELLOs and nothing after them: no proof and no registration.
  const node = [...real.objects.nodes.values()][0]!
  expect(node.status()).toMatchObject({ routes: 0, pending: 0 })
}, 30_000)
