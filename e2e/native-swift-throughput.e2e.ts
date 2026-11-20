import { spawn } from 'node:child_process'
import { createHash, randomBytes, X509Certificate } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { startRelay } from '@latch/relay'
import { createTransportCertificate, PaddedStream } from '@latch/link-client'
import { buildSwiftFixture, swiftFixturePath } from '@latch/testkit'
import { startTestHost } from './helpers/host.ts'
import { startShapedProxy, type ShapedLink } from './helpers/shaped-proxy.ts'

/**
 * Explicit-download and control-read throughput between the Swift client and the Host through a local relay, with a
 * shaped phone leg. The self-hosted relay runs without a quota, so it never paces. `LATCH_TRANSFER_MATRIX=1` runs RTT
 * 50/150/300 ms × 20/50/100 Mbit/s, `LATCH_TRANSFER_CASE=<rtt>,<mbps>,<bytes>` one case; the default is one short case.
 */
const MATRIX = process.env.LATCH_TRANSFER_MATRIX === '1'
const single = /^(\d+),(\d+),(\d+)$/u.exec(process.env.LATCH_TRANSFER_CASE ?? '')
const cases: Array<ShapedLink & { bytes: number }> = single
  ? [{ rttMs: Number(single[1]), mbps: Number(single[2]), bytes: Number(single[3]) }]
  : MATRIX
    ? [50, 150, 300].flatMap(rttMs => [20, 50, 100].map(mbps => ({ rttMs, mbps, bytes: 8_388_608 })))
    : [{ rttMs: 50, mbps: 50, bytes: 4_194_304 }]

let binary = ''
describe.skipIf(process.platform !== 'darwin')('Swift native relay throughput', () => {
  beforeAll(async () => {
    await buildSwiftFixture()
    binary = await swiftFixturePath()
  }, 600_000)
  const rows: Array<Record<string, unknown>> = []
  it.each(cases)(
    'measures $bytes bytes at RTT $rttMs ms and $mbps Mbit/s',
    async ({ rttMs, mbps, bytes }) => {
      const directory = await mkdtemp(join(tmpdir(), 'latch-swift-throughput-')),
        tls = createTransportCertificate(Date.now(), 3_600_000, 'localhost')
      const relayId = randomBytes(16),
        token = randomBytes(32)
      const relay = await startRelay({
        host: '127.0.0.1',
        port: 0,
        cert: tls.cert,
        key: tls.key,
        relayId,
        registrationToken: token,
        maxConnections: 32,
        gateway: {
          binary: resolve('dist/relay/latch-relay-tls'),
          maxHandshakes: 8,
          handshakesPerSecond: 100,
          handshakeBurst: 8,
          prefixFraction: 1,
        },
        registrationWork: { softRoutesPerPrefix: 1, minBits: 0, maxBits: 0, maxConcurrent: 2 },
      })
      const proxy = await startShapedProxy({ host: '127.0.0.1', port: relay.port }, { rttMs, mbps })
      const bulkStreams: PaddedStream[] = []
      const originalBulk = PaddedStream.prototype.enableBulk
      const bulkSpy = vi.spyOn(PaddedStream.prototype, 'enableBulk').mockImplementation(function (this: PaddedStream) {
        bulkStreams.push(this)
        originalBulk.call(this)
      })
      let host: Awaited<ReturnType<typeof startTestHost>> | undefined
      try {
        const dataDir = join(directory, 'data'),
          nativeDir = join(dataDir, 'native')
        await mkdir(nativeDir, { recursive: true, mode: 0o700 })
        await writeFile(
          join(nativeDir, 'relays.json'),
          JSON.stringify({
            version: 1,
            generation: 0,
            discoveryKey: `lnd1.${randomBytes(32).toString('base64url')}`,
            profiles: [
              {
                relayId: relayId.toString('hex'),
                url: `https://localhost:${relay.port}/`,
                spkiHash: createHash('sha256').update(tls.spki).digest('hex'),
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
        host = await startTestHost({
          dataDir,
          workspaceRoot: join(directory, 'workspace'),
          nativeRelayCa: tls.cert,
          native: { host: '127.0.0.1', port: 0 },
          egressLookup: (_hostname, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]),
        })
        const desktop = await host.enroll({ listener: 'unix' })
        expect(
          (await desktop.confirmed('policy', { method: 'PATCH', body: { hostEgressAllow: { add: [`localhost:${relay.port}`] } } })).status,
        ).toBe(200)
        await vi.waitFor(() => expect(relay.status().routes).toBe(3), { timeout: 3000 })
        const invited = await desktop.request('native/pairings', { method: 'POST', body: {} })
        const { invitation } = (await invited.json()) as { invitation: { payload: string } }
        await writeFile(join(host.workspaceRoot, 'notes.txt'), 'Swift relay file fixture')
        // A remote text preview stops at 2 MiB; zero bytes read as an opaque file, which goes to 20 MiB.
        await writeFile(join(host.workspaceRoot, 'large.bin'), Buffer.alloc(bytes))
        const input = {
          operation: 'nativeRelayThroughput',
          requestId: crypto.randomUUID(),
          payload: invitation.payload,
          trustAnchor: new X509Certificate(tls.cert).raw.toString('hex'),
          relayPort: proxy.port,
          bytes,
        }
        const response = await new Promise<{ bulkMs: number; partsMs: number[]; coverMs: number; controlMs: number; bytes: number }>(
          (done, reject) => {
            const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], env: {} })
            let output = '',
              diagnostic = ''
            const timer = setTimeout(() => {
              child.kill('SIGKILL')
              reject(new Error('Swift throughput fixture timeout'))
            }, 170_000)
            child.stdout.on('data', (data: Buffer) => {
              output += data.toString()
              if (output.length > 1_048_576) child.kill('SIGKILL')
            })
            child.stderr.on('data', (data: Buffer) => {
              diagnostic = (diagnostic + data.toString()).slice(0, 4096)
            })
            child.once('error', error => {
              clearTimeout(timer)
              reject(error)
            })
            child.once('close', code => {
              clearTimeout(timer)
              if (code !== 0) reject(new Error(diagnostic || 'Swift throughput fixture failed'))
              else
                try {
                  done(JSON.parse(output) as never)
                } catch {
                  reject(new Error('Swift throughput fixture returned invalid JSON'))
                }
            })
            child.stdin.end(JSON.stringify(input))
          },
        )
        // The shaped leg really carried the transfer: the phone reached the relay only through the proxy.
        expect(proxy.stats().down).toBeGreaterThan(bytes + 1_048_576)
        const cells = bulkStreams.map(stream => stream.traffic()),
          total = cells.reduce((sum, item) => sum + item.cells, 0),
          dummies = cells.reduce((sum, item) => sum + item.dummyCells, 0)
        const row = {
          rttMs,
          mbps,
          bytes,
          bulkMs: Math.round(response.bulkMs),
          partsMs: response.partsMs.join(' '),
          bulkKiBps: Math.round(bytes / 1024 / (response.bulkMs / 1000)),
          coverMs: Math.round(response.coverMs),
          controlMs: Math.round(response.controlMs),
          controlKiBps: Math.round(1024 / (response.controlMs / 1000)),
          bulkConnections: bulkStreams.length,
          cells: total,
          dummyRatio: total ? Number((dummies / total).toFixed(3)) : 0,
          paddedBytes: cells.reduce((sum, item) => sum + item.paddedBytes, 0),
        }
        rows.push(row)
        console.info('Native transfer throughput', row)
        await mkdir('test-results/native-throughput', { recursive: true })
        await writeFile('test-results/native-throughput/rows.json', JSON.stringify(rows, null, 2))
        expect(bulkStreams.length).toBeGreaterThanOrEqual(1)
        expect(response.bytes).toBe(bytes)
      } finally {
        bulkSpy.mockRestore()
        await host?.close()
        await proxy.close()
        await relay.close()
        await rm(directory, { recursive: true, force: true })
      }
    },
    200_000,
  )
})
