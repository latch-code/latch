import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Http2ServerResponse } from 'node:http2'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { startRelay } from '@latch/relay'
import { createTransportCertificate, PaddedStream } from '@latch/link-client'
import { buildSwiftFixture, swiftFixturePath } from '@latch/testkit'
import { startTestHost } from './helpers/host.ts'

const descriptors = vi.hoisted(() => new Map<object, { close(): Promise<void>; origin: string }>())
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...original,
    async open(...args: Parameters<typeof original.open>) {
      const handle = await original.open(...args),
        close = handle.close.bind(handle)
      descriptors.set(handle, { close, origin: new Error('Unclosed native fixture descriptor').stack ?? 'unknown' })
      handle.close = async () => {
        try {
          await close()
        } finally {
          descriptors.delete(handle)
        }
      }
      return handle
    },
  }
})
let binary = ''
describe.skipIf(process.platform !== 'darwin')('Swift native relay interoperability', () => {
  beforeAll(async () => {
    await buildSwiftFixture()
    binary = await swiftFixturePath()
  }, 600_000)
  it.each([
    [
      'nativeRelayLifecycle',
      {
        paired: true,
        persistedBeforeComplete: true,
        mutualTLS: true,
        requiresWindow: true,
        verified: true,
        relayPairingRefused: true,
        created: true,
        files: true,
        events: true,
        resumedWithoutSigning: true,
        replayedAfterReconnect: true,
        rootRevocationClosedLease: true,
      },
    ],
    ['nativeDirectTransfer', { bulk: true, direct: true, afterCancel: false, bytes: 1_048_576, chunks: 17 }],
    ['nativeRelayTransferNormal', { bulk: true, direct: false, afterCancel: false, bytes: 1_048_576, chunks: 17 }],
    ['nativeRelayBulkCancel', { cancelled: true, retried: true, identityKept: true }],
    ['nativeRelayBulkEarlyCancel', { cancelled: true, retried: true, identityKept: true }],
    [
      'nativeRelayBulkReauthenticate',
      { supersededReadDenied: true, reconnectDidNotSign: true, explicitUnlockRetried: true, signatures: 3 },
    ],
    ['nativeRelayBulkNormal', { bulk: true, direct: false, afterCancel: false, bytes: 1_048_576 }],
    ['nativeRelayBulkLegacy', { bulk: true, direct: false, afterCancel: false, bytes: 1_048_576, chunks: 17 }],
    ['nativeRelayBulkAfterCancel', { bulk: true, direct: false, afterCancel: true, bytes: 1_048_576 }],
    ['nativeRelayTransferAfterCancel', { bulk: true, direct: false, afterCancel: true, bytes: 1_048_576, chunks: 17 }],
  ])('runs %s through its fixed authenticated native path', async (operation, expected) => {
    const directory = await mkdtemp(join(tmpdir(), 'latch-swift-relay-')),
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
    const bulkStreams: PaddedStream[] = []
    const originalBulk = PaddedStream.prototype.enableBulk
    const bulkSpy = vi.spyOn(PaddedStream.prototype, 'enableBulk').mockImplementation(function (this: PaddedStream) {
      bulkStreams.push(this)
      originalBulk.call(this)
    })
    const transferRanges: number[] = []
    const originalEnd = Http2ServerResponse.prototype.end
    const responseSpy = vi.spyOn(Http2ServerResponse.prototype, 'end').mockImplementation(function (
      this: Http2ServerResponse,
      ...args: Parameters<typeof originalEnd>
    ) {
      const range = typeof this.req.headers.range === 'string' ? /^bytes=(\d+)-(\d+)$/u.exec(this.req.headers.range) : undefined
      if (range && this.req.method === 'GET') transferRanges.push(Number(range[2]) - Number(range[1]) + 1)
      if (operation === 'nativeRelayBulkLegacy' && typeof args[0] === 'string' && this.req.url?.startsWith('/link/api/snapshot')) {
        const value = JSON.parse(args[0]) as { catalog?: { features?: Record<string, unknown> } }
        if (value.catalog?.features) {
          delete value.catalog.features.nativeBulkStream
          args[0] = JSON.stringify(value)
        }
      }
      return Reflect.apply(originalEnd, this, args) as Http2ServerResponse
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
      expect(relay.status().registrationWork?.accepted).toBe(2)
      expect(relay.status().gateway?.healthy).toBe(true)
      const invited = await desktop.request('native/pairings', { method: 'POST', body: {} })
      expect(invited.status).toBe(201)
      const { invitation } = (await invited.json()) as { invitation: { payload: string } }
      const requestId = randomUUID()
      await writeFile(join(host.workspaceRoot, 'notes.txt'), 'Swift relay file fixture')
      await writeFile(join(host.workspaceRoot, 'large.txt'), Buffer.alloc(1_048_576, 120))
      const input = {
        operation,
        requestId,
        payload: invitation.payload,
        trustAnchor: new X509Certificate(tls.cert).raw.toString('hex'),
      }
      const fixtureHost = host
      const response = await new Promise<unknown>((resolve, reject) => {
        const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], env: {} })
        let output = '',
          diagnostic = ''
        const timer = setTimeout(
          () => {
            child.kill('SIGKILL')
            reject(new Error('Swift relay fixture timeout'))
          },
          operation.includes('Transfer') || operation.includes('Bulk') ? 10_000 + 16 * (250 + Math.ceil(65_536 / 1021) * 40) : 20_000,
        )
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
          if (code !== 0) {
            reject(new Error(diagnostic || 'Swift relay fixture rejected connection'))
            return
          }
          try {
            const value: unknown = JSON.parse(output)
            resolve(value)
          } catch {
            reject(new Error('Swift relay returned invalid JSON'))
          }
        })
        child.stdin.end(JSON.stringify(input))
      })
      if (operation === 'nativeRelayBulkCancel' || operation === 'nativeRelayBulkEarlyCancel') {
        const { cancelMs, ...value } = response as Record<string, unknown>
        expect(value).toEqual(expected)
        expect(cancelMs).toBeGreaterThanOrEqual(0)
        expect(cancelMs).toBeLessThan(1000)
        if (operation === 'nativeRelayBulkCancel') expect(bulkStreams).toHaveLength(2)
        else {
          expect(bulkStreams.length).toBeGreaterThanOrEqual(1)
          expect(bulkStreams.length).toBeLessThanOrEqual(2)
        }
        await writeFile(`/private/tmp/latch-remote-bulk-metrics-${operation}.json`, JSON.stringify({ cancelMs }))
      } else if (operation === 'nativeRelayBulkReauthenticate') {
        expect(response).toEqual(expected)
      } else if (operation.includes('Transfer') || operation.includes('Bulk')) {
        const { firstChunkMs, totalMs, chunks, ...value } = response as Record<string, unknown>
        expect('chunks' in expected ? { ...value, chunks } : value).toEqual(expected)
        if (operation === 'nativeRelayBulkLegacy') {
          expect(transferRanges.filter(amount => amount >= 16_384)).toHaveLength(17)
          expect(Math.max(...transferRanges)).toBe(65_536)
        }
        if (operation === 'nativeRelayBulkNormal' || operation === 'nativeRelayBulkAfterCancel') {
          expect(transferRanges.filter(amount => amount >= 16_384)).toEqual([1_048_576])
        }
        expect(firstChunkMs).toBeGreaterThan(0)
        expect(totalMs).toBeGreaterThanOrEqual(Number(firstChunkMs))
        const measurement = {
          direct: operation === 'nativeDirectTransfer',
          afterCancel: operation.endsWith('AfterCancel'),
          firstChunkMs,
          totalMs,
          companion: operation.includes('Bulk'),
          progressChunks: chunks,
          downlinkCells: bulkStreams.map(stream => stream.traffic()),
          outerWebSockets: relay.status().webSockets,
        }
        console.info('Native padded transfer fixture milliseconds', measurement)
        await writeFile(`/private/tmp/latch-remote-bulk-metrics-${operation}.json`, JSON.stringify(measurement))
      } else expect(response).toEqual(expected)
      if (operation === 'nativeRelayLifecycle') {
        const snapshot = await desktop.json<{ tasks: Array<{ id: string }> }>('snapshot')
        expect(snapshot.tasks).toHaveLength(1)
        const detail = await desktop.json<{ messages: Array<{ requestId?: string; text: string }> }>(`tasks/${snapshot.tasks[0]!.id}`)
        expect(detail.messages.find(message => message.requestId === requestId)?.text).toBe('Swift relay fixture `notes.txt`')
      }
      await vi.waitFor(() => expect(relay.status().connections).toBe(1), { timeout: 3000 })
      if (operation === 'nativeRelayLifecycle') {
        // The phone acknowledged its removal, so the Host's next pass hands the node its denial: for today's and
        // tomorrow's routes, and for yesterday's only while its passes last. The node closes a control connection that
        // sends one it will not keep, so the connection has to be there after the denials are.
        await vi.waitFor(() => expect(relay.status().denials.tags).toBeGreaterThanOrEqual(2), { timeout: 5000 })
        for (const until = Date.now() + 1500; Date.now() < until; await new Promise(done => setTimeout(done, 50)))
          expect(relay.status()).toMatchObject({ connections: 1, controls: 1 })
      }
    } finally {
      responseSpy.mockRestore()
      bulkSpy.mockRestore()
      await host?.close()
      await relay.close()
      await rm(directory, { recursive: true, force: true })
      const leaked = [...descriptors.values()]
      await Promise.all(leaked.map(item => item.close()))
      descriptors.clear()
      expect(leaked.map(item => item.origin)).toEqual([])
    }
  })
})
