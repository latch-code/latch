import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { startRelay } from '@latch/relay'
import { connectRelayTunnel, createTransportCertificate, nodeCrypto, openNativeHttp } from '@latch/link-client'
import {
  decodePass,
  encodeRelayAuthority,
  encodeRelayDirectory,
  encodeSignedRelayDirectory,
  relayAuthorityInput,
  relayDirectoryInput,
  routeId,
} from '@latch/link-wire'
import type { NativeLinkInfo } from '@latch/protocol'
import { startTestHost } from './helpers/host.ts'

const dials = vi.hoisted(() => [] as string[])
vi.mock('node:https', async importOriginal => {
  const original = await importOriginal<typeof import('node:https')>()
  return {
    ...original,
    request(url: URL, options: import('node:https').RequestOptions) {
      if (!['old-relay.example', 'relay.example'].includes(url.hostname)) return original.request(url, options)
      dials.push(url.hostname)
      // Model an unreachable old public address and a reachable new public address without contacting a real network.
      return original.request(url, {
        ...options,
        lookup(_hostname, lookupOptions, callback) {
          const address = url.hostname === 'relay.example' ? '127.0.0.1' : '127.0.0.2'
          if (typeof lookupOptions === 'object' && lookupOptions.all) callback(null, [{ address, family: 4 }])
          else callback(null, address, 4)
        },
      })
    },
  }
})
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
  dials.length = 0
})

it('recovers the same approved relay through a signed public address, reaches real inner TLS, and closes it on Root revocation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'latch-directory-e2e-'))
  cleanup.push(() => rm(directory, { force: true, recursive: true }))
  const certificate = createTransportCertificate(Date.now(), 3_600_000, 'relay.example'),
    relayId = randomBytes(16),
    token = randomBytes(32)
  const relay = await startRelay({
    host: '127.0.0.1',
    port: 0,
    cert: certificate.cert,
    key: certificate.key,
    relayId,
    registrationToken: token,
    maxConnections: 32,
    registrationWork: { softRoutesPerPrefix: 1, minBits: 0, maxBits: 0, maxConcurrent: 2 },
    gateway: {
      binary: resolve('dist/relay/latch-relay-tls'),
      maxHandshakes: 8,
      handshakesPerSecond: 100,
      handshakeBurst: 8,
      prefixFraction: 1,
    },
  })
  cleanup.push(() => relay.close())
  const now = Date.now(),
    offline = new Uint8Array(32).fill(3),
    online = new Uint8Array(32).fill(4),
    onlinePublic = await nodeCrypto.publicKey(online),
    pin = createHash('sha256').update(certificate.spki).digest()
  const authority = {
    generation: 1,
    issuedAt: now - 1000,
    expiresAt: now + 86_400_000,
    keys: [{ publicKey: onlinePublic, notBefore: now - 1000, notAfter: now + 86_400_000 }],
    revokedKeys: [] as Uint8Array[],
    nodes: [{ relayId, region: 'self-hosted', spkiHashes: [pin], ports: [relay.port] }],
  }
  async function bundle() {
    const root = encodeRelayAuthority(authority),
      addresses = encodeRelayDirectory({
        generation: 1,
        issuedAt: now - 1000,
        expiresAt: now + 3600_000,
        rootGeneration: authority.generation,
        rootHash: await nodeCrypto.hash(root),
        key: onlinePublic,
        nodes: [{ relayId, host: 'relay.example', port: relay.port, addresses: ['8.8.8.8'] }],
      })
    return encodeSignedRelayDirectory({
      authority: root,
      rootSignature: await nodeCrypto.sign(offline, relayAuthorityInput(root)),
      directory: addresses,
      signature: await nodeCrypto.sign(online, relayDirectoryInput(addresses)),
    })
  }
  let payload = await bundle()
  const config = {
      anchors: [Buffer.from(await nodeCrypto.publicKey(offline)).toString('hex')],
      mirrors: ['https://directory.example/addresses.bin'],
    },
    dataDir = join(directory, 'data')
  await mkdir(join(dataDir, 'native'), { recursive: true, mode: 0o700 })
  await writeFile(
    join(dataDir, 'native/relays.json'),
    JSON.stringify({
      version: 1,
      generation: 0,
      discoveryKey: `lnd1.${randomBytes(32).toString('base64url')}`,
      directory: config,
      profiles: [
        {
          relayId: relayId.toString('hex'),
          url: `https://old-relay.example:${relay.port}/`,
          spkiHash: pin.toString('hex'),
          registrationKey: `lrt1.${token.toString('base64url')}`,
          seeds: [`lrs1.${randomBytes(32).toString('base64url')}`, `lrs1.${randomBytes(32).toString('base64url')}`],
          activeSlot: 0,
          rotationDay: 0,
          rotations: 0,
        },
      ],
    }),
    { mode: 0o600 },
  )
  const host = await startTestHost({
    dataDir,
    workspaceRoot: join(directory, 'workspace'),
    nativeRelayCa: certificate.cert,
    egressLookup: (_name, _options, callback) => callback(null, [{ address: '8.8.4.4', family: 4 }]),
    nativeDirectoryFetch: async () => new Response(new Uint8Array(payload)),
  })
  cleanup.push(() => host.close())
  await vi.waitFor(
    () =>
      expect({ routes: relay.status().routes, dials }).toEqual({
        routes: 3,
        dials: expect.arrayContaining(['relay.example']),
      }),
    { timeout: 7000 },
  )
  expect(dials.slice(0, 2)).toEqual(['old-relay.example', 'relay.example'])
})
