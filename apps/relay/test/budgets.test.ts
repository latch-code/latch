import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { createTransportCertificate, nodeCrypto, RelayControl, connectRelayTunnel } from '@latch/link-client'
import { holder, issuePass, routeKey, UTC_DAY } from '@latch/link-wire'
import { startRelay } from '../src/server.ts'
const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
it.each([undefined, 'outer-pad-v2'] as const)(
  'gates data admission while keeping control available and accounts profile %s',
  async profile => {
    const dataDir = await mkdtemp(join(tmpdir(), 'latch-relay-budgets-'))
    cleanup.push(() => rm(dataDir, { recursive: true, force: true }))
    const certificate = createTransportCertificate(Date.now(), 3600000, 'localhost'),
      relayId = nodeCrypto.random(16)
    let rx = 1000,
      tx = 2000
    const relay = await startRelay({
      dataDir,
      host: '127.0.0.1',
      port: 0,
      cert: certificate.cert,
      key: certificate.key,
      relayId,
      openRegistration: true,
      quota: {
        monthlyBytes: 3100000000000,
        resetDay: 1,
        timezone: 'UTC',
        count: 'in+out',
        iface: 'eth0',
        burstBytes: 65536,
        stopRatio: 0.9,
      },
      fairness: { prefixDailyShare: 0.01, overageFactor: 0.1 },
      networkCounter: async () => ({ rx, tx, boot: 'a'.repeat(64) }),
      memoryReader: async () => ({ used: 100, limit: 100000000, includesSockets: true }),
    })
    cleanup.push(() => relay.close())
    const endpoint = {
      profile,
      url: new URL(`https://localhost:${relay.port}`),
      relayId,
      ca: certificate.cert,
      spki: createHash('sha256').update(certificate.spki).digest(),
      resolveAddress: async () => '127.0.0.1',
    }
    const control = await RelayControl.connect(endpoint)
    cleanup.push(() => control.close())
    const day = Math.floor(Date.now() / 1000 / UTC_DAY),
      seed = nodeCrypto.random(32),
      key = await routeKey(nodeCrypto, seed, relayId, day),
      device = await holder(nodeCrypto, seed, relayId, new Uint8Array([1]), day)
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
    await control.register({ routeKey: key, day, alternate: false })
    await expect(connectRelayTunnel({ ...endpoint, pass, holderKey: device.seed })).rejects.toThrow()
    const admin = `http://127.0.0.1:${relay.adminPort}`
    expect(
      (
        await fetch(`${admin}/quota`, {
          method: 'POST',
          headers: { 'x-latch-relay-admin': '1', 'Content-Type': 'application/json', Origin: 'https://example.test' },
          body: JSON.stringify({ usedBytes: 0 }),
        })
      ).status,
    ).toBe(403)
    const calibrated = await fetch(`${admin}/quota`, {
      method: 'POST',
      headers: { 'x-latch-relay-admin': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ usedBytes: 0 }),
    })
    expect(calibrated.ok).toBe(true)
    const accepted = control.accept(),
      client = await connectRelayTunnel({ ...endpoint, pass, holderKey: device.seed }),
      upstream = await accepted
    upstream.finishSetup()
    client.on('error', () => {})
    upstream.stream.on('error', () => {})
    cleanup.push(() => {
      client.destroy()
      upstream.stream.destroy()
    })
    const received = new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      let count = 0
      upstream.stream.on('data', (chunk: Buffer) => {
        count += chunk.length
        if (count > 16_384) {
          reject(new Error('Unexpected extra bytes'))
          return
        }
        chunks.push(chunk)
        if (count === 16_384) resolve(Buffer.concat(chunks))
      })
    })
    client.write(Buffer.alloc(16384, 7))
    expect(await received).toEqual(Buffer.alloc(16384, 7))
    if (profile) {
      expect(relay.status().webSockets.paddingReceivedBytes).toBeGreaterThan(0)
      expect(relay.status().webSockets.paddingWrittenBytes).toBeGreaterThan(0)
      client.destroy()
      upstream.stream.destroy()
      await Promise.all([client.transportClosed, upstream.stream.transportClosed])
    }
    rx += 100
    tx += 200
    await vi.waitFor(() => expect(relay.status().quota).toMatchObject({ monthlyUsed: 300, calibrated: true, healthy: true }), {
      timeout: 5000,
    })
    const status = await (await fetch(`${admin}/status`)).json()
    expect(status.quota).toMatchObject({ monthlyUsed: 300, calibrated: true, healthy: true })
    expect(status.forwarding.waiting).toBe(0)
    const ledger = await readFile(join(dataDir, 'quota.json'), 'utf8')
    expect(ledger).not.toContain('127.0.0')
    expect(ledger).not.toContain(Buffer.from(device.tag).toString('hex'))
    expect((await fetch(`${admin}/drain`, { method: 'POST', headers: { 'x-latch-relay-admin': '1' } })).ok).toBe(true)
  },
)
