import { spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, X509Certificate } from 'node:crypto'
import { channel } from 'node:diagnostics_channel'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Http2ServerResponse, type IncomingHttpHeaders, type ServerHttp2Stream } from 'node:http2'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createSelfSignedRelayCertificate, startRelay } from '@latch/relay'
import { createTransportCertificate, PaddedStream } from '@latch/link-client'
import { buildSwiftFixture, swiftFixturePath } from '@latch/testkit'
import { startTestHost } from './helpers/host.ts'
import { startShapedProxy } from './helpers/shaped-proxy.ts'

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
    ['nativeRelayFailover', { recoveredOnRelay: true, windowResumed: true }],
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
    ['nativeRelayUpload', { interrupted: true, kept: true, resumed: true, next: true }],
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
    const transferRanges: number[] = [],
      partsAnswered: number[] = [],
      startSessions = new Set<ServerHttp2Stream['session']>(),
      partSessions = new Set<ServerHttp2Stream['session']>()
    const uploadPart = /\/attachments\/uploads\/[A-Za-z0-9_-]{22}\/parts\/(\d+)$/u
    const streamCreated = channel('http2.server.stream.created')
    // A cancelled part can finish on the Host after Node has detached the stream from its session.
    const rememberUploadSession = (event: unknown) => {
      const { headers, stream } = event as { headers: IncomingHttpHeaders; stream: ServerHttp2Stream }
      const path = headers[':path'] ?? ''
      if (headers[':method'] === 'POST' && path === '/link/api/attachments/uploads') startSessions.add(stream.session)
      if (headers[':method'] === 'PUT' && uploadPart.test(path)) partSessions.add(stream.session)
    }
    const originalEnd = Http2ServerResponse.prototype.end
    const responseSpy = vi.spyOn(Http2ServerResponse.prototype, 'end').mockImplementation(function (
      this: Http2ServerResponse,
      ...args: Parameters<typeof originalEnd>
    ) {
      const range = typeof this.req.headers.range === 'string' ? /^bytes=(\d+)-(\d+)$/u.exec(this.req.headers.range) : undefined
      if (range && this.req.method === 'GET') transferRanges.push(Number(range[2]) - Number(range[1]) + 1)
      const part = uploadPart.exec(this.req.url ?? '')
      // Only a real answer: a part whose stream closed under it is ended without one.
      if (part && this.req.method === 'PUT' && this.statusCode === 200 && typeof args[0] === 'string' && args[0].startsWith('{"upload"')) {
        partsAnswered.push(Number(part[1]))
      }
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
    // A slow download holds the reauthentication read open. A cold origin followed by normal WAN round trips
    // keeps failover's individual handshakes moving while their total exceeds eight seconds.
    const shaping =
      operation === 'nativeRelayBulkReauthenticate'
        ? { rttMs: 0, mbps: 1.5 }
        : operation === 'nativeRelayFailover'
          ? { connectMs: 5500, rttMs: 650, mbps: 100 }
          : undefined
    const slow = shaping && (await startShapedProxy({ host: '127.0.0.1', port: relay.port }, shaping))
    try {
      if (operation === 'nativeRelayUpload') streamCreated.subscribe(rememberUploadSession)
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
        ...(slow ? { relayPort: slow.port } : {}),
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
          operation.includes('Transfer') || operation.includes('Bulk')
            ? 10_000 + 16 * (250 + Math.ceil(65_536 / 1021) * 40)
            : operation === 'nativeRelayUpload'
              ? 90_000
              : operation === 'nativeRelayFailover'
                ? 45_000
                : 20_000,
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
      } else if (operation === 'nativeRelayUpload') {
        const { nextMs, ...flags } = response as Record<string, unknown>
        expect(flags).toEqual(expected)
        // A companion per attempt and one for the next file; every part was taken exactly once, the retry sending only
        // the missing ones.
        expect(bulkStreams.length).toBeGreaterThanOrEqual(3)
        expect(partsAnswered.toSorted((a, b) => a - b)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 5, 6, 7, 8])
        // No part went on the control connection, the next file's included: each went on a companion.
        expect(startSessions.size).toBeGreaterThanOrEqual(2)
        expect(partSessions.size).toBeGreaterThan(0)
        expect([...startSessions, ...partSessions].every(session => session !== undefined)).toBe(true)
        expect([...partSessions].filter(session => startSessions.has(session))).toEqual([])
        expect(nextMs).toBeGreaterThan(0)
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
      if (operation === 'nativeRelayUpload') streamCreated.unsubscribe(rememberUploadSession)
      responseSpy.mockRestore()
      bulkSpy.mockRestore()
      await host?.close()
      await slow?.close()
      await relay.close()
      await rm(directory, { recursive: true, force: true })
      const leaked = [...descriptors.values()]
      await Promise.all(leaked.map(item => item.close()))
      descriptors.clear()
      expect(leaked.map(item => item.origin)).toEqual([])
    }
  })

  it('connects from the real Swift native client and Node Host over a zero-domain bare-IP self-signed SPKI-pinned relay without custom CA anchors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'latch-swift-bare-ip-'))
    const tls = createSelfSignedRelayCertificate('127.0.0.1')
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
        maxHandshakes: 16,
        handshakesPerSecond: 100,
        handshakeBurst: 16,
        prefixFraction: 1,
      },
      registrationWork: { softRoutesPerPrefix: 1, minBits: 0, maxBits: 0, maxConcurrent: 2 },
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
              url: `https://127.0.0.1:${relay.port}/`,
              spkiHash: tls.spkiHash,
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
      // Neither `nativeRelayCa` on the Node Host nor `trustAnchor` on the Swift client is passed!
      host = await startTestHost({
        dataDir,
        workspaceRoot: join(directory, 'workspace'),
        native: { host: '127.0.0.1', port: 0 },
      })
      const desktop = await host.enroll({ listener: 'unix' })
      expect(
        (await desktop.confirmed('policy', { method: 'PATCH', body: { hostEgressAllow: { add: [`127.0.0.1:${relay.port}`] } } })).status,
      ).toBe(200)
      await vi.waitFor(() => expect(relay.status().routes).toBe(3), { timeout: 5_000 })

      const invited = await desktop.request('native/pairings', { method: 'POST', body: {} })
      expect(invited.status).toBe(201)
      const { invitation } = (await invited.json()) as { invitation: { payload: string } }
      const requestId = randomUUID()
      await writeFile(join(host.workspaceRoot, 'notes.txt'), 'Swift relay file fixture')

      const response = await new Promise<unknown>((resolvePromise, reject) => {
        const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], env: {} })
        let output = '',
          diagnostic = ''
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error('Swift bare-IP relay fixture timeout'))
        }, 25_000)
        child.stdout.on('data', (data: Buffer) => {
          output += data.toString()
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
            reject(new Error(diagnostic || `Swift bare-IP relay fixture exited ${code}`))
            return
          }
          resolvePromise(JSON.parse(output) as unknown)
        })
        child.stdin.end(JSON.stringify({ operation: 'nativeRelayLifecycle', requestId, payload: invitation.payload }))
      })
      expect(response).toMatchObject({
        paired: true,
        mutualTLS: true,
        verified: true,
        created: true,
        files: true,
        events: true,
        replayedAfterReconnect: true,
        rootRevocationClosedLease: true,
      })
    } finally {
      await host?.close()
      await relay.close()
      await rm(directory, { recursive: true, force: true })
      const leaked = [...descriptors.values()]
      await Promise.all(leaked.map(item => item.close()))
      descriptors.clear()
      expect(leaked.map(item => item.origin)).toEqual([])
    }
  })

  it('rejects a CA-signed leaf certificate missing its issuer chain on Swift even when its SPKI matches spkiHash', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'latch-swift-chainless-leaf-'))
    const der = (tag: number, ...parts: readonly Uint8Array[]): Buffer => {
      const value = Buffer.concat(parts)
      const len =
        value.length < 128 ? [value.length] : value.length < 256 ? [0x81, value.length] : [0x82, value.length >> 8, value.length & 255]
      return Buffer.concat([Buffer.from([tag, ...len]), value])
    }
    const seq = (...parts: readonly Uint8Array[]) => der(0x30, ...parts)
    const caKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const leafKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const caSpki = caKeys.publicKey.export({ type: 'spki', format: 'der' })
    const leafSpki = leafKeys.publicKey.export({ type: 'spki', format: 'der' })
    const leafSpkiHash = createHash('sha256').update(leafSpki).digest('hex')
    const alg = seq(der(0x06, Buffer.from('2a8648ce3d040302', 'hex')))
    const caDn = seq(der(0x31, seq(der(0x06, Buffer.from('550403', 'hex')), der(0x0c, Buffer.from('Untrusted Relay CA')))))
    const leafDn = seq(der(0x31, seq(der(0x06, Buffer.from('550403', 'hex')), der(0x0c, Buffer.from('127.0.0.1')))))
    const now = Date.now()
    const utc = (d: Date) => der(0x17, Buffer.from(`${d.toISOString().replace(/[-:T]/gu, '').slice(2, 14)}Z`))
    const validity = seq(utc(new Date(now - 60_000)), utc(new Date(now + 86_400_000)))
    const caExts = der(
      0xa3,
      seq(
        seq(der(0x06, Buffer.from('551d13', 'hex')), der(0x01, Buffer.from([0xff])), der(0x04, seq(der(0x01, Buffer.from([0xff]))))),
        seq(der(0x06, Buffer.from('551d0f', 'hex')), der(0x01, Buffer.from([0xff])), der(0x04, der(0x03, Buffer.from([1, 0x86])))),
      ),
    )
    const caTbs = seq(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([1])), alg, caDn, validity, caDn, caSpki, caExts)
    const caDer = seq(caTbs, alg, der(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', caTbs, caKeys.privateKey)])))
    const caPem = `-----BEGIN CERTIFICATE-----\n${caDer
      .toString('base64')
      .match(/.{1,64}/gu)!
      .join('\n')}\n-----END CERTIFICATE-----\n`

    // Leaf has IP SAN 127.0.0.1 (7f 00 00 01) and is signed by `caKeys`, served WITHOUT `caPem` in the server chain!
    const leafExts = der(
      0xa3,
      seq(
        seq(der(0x06, Buffer.from('551d13', 'hex')), der(0x01, Buffer.from([0xff])), der(0x04, seq())),
        seq(der(0x06, Buffer.from('551d11', 'hex')), der(0x04, seq(der(0x87, Buffer.from([127, 0, 0, 1]))))),
      ),
    )
    const leafTbs = seq(
      der(0xa0, der(0x02, Buffer.from([2]))),
      der(0x02, Buffer.from([2])),
      alg,
      caDn,
      validity,
      leafDn,
      leafSpki,
      leafExts,
    )
    const leafDer = seq(leafTbs, alg, der(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', leafTbs, caKeys.privateKey)])))
    const leafOnlyPem = `-----BEGIN CERTIFICATE-----\n${leafDer
      .toString('base64')
      .match(/.{1,64}/gu)!
      .join('\n')}\n-----END CERTIFICATE-----\n`
    const leafKeyPem = leafKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

    const relayId = randomBytes(16),
      token = randomBytes(32)
    const relay = await startRelay({
      host: '127.0.0.1',
      port: 0,
      cert: leafOnlyPem,
      key: leafKeyPem,
      relayId,
      registrationToken: token,
      maxConnections: 32,
      gateway: {
        binary: resolve('dist/relay/latch-relay-tls'),
        maxHandshakes: 16,
        handshakesPerSecond: 100,
        handshakeBurst: 16,
        prefixFraction: 1,
      },
      registrationWork: { softRoutesPerPrefix: 1, minBits: 0, maxBits: 0, maxConcurrent: 2 },
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
              url: `https://127.0.0.1:${relay.port}/`,
              spkiHash: leafSpkiHash,
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
      // Give the Host `caPem` so routes ARE registered on the relay; Swift gets NO `trustAnchor`, testing the self-signed exception!
      host = await startTestHost({
        dataDir,
        workspaceRoot: join(directory, 'workspace'),
        nativeRelayCa: caPem,
        native: { host: '127.0.0.1', port: 0 },
      })
      const desktop = await host.enroll({ listener: 'unix' })
      expect(
        (await desktop.confirmed('policy', { method: 'PATCH', body: { hostEgressAllow: { add: [`127.0.0.1:${relay.port}`] } } })).status,
      ).toBe(200)
      await vi.waitFor(() => expect(relay.status().routes).toBe(3), { timeout: 5_000 })

      const invited = await desktop.request('native/pairings', { method: 'POST', body: {} })
      expect(invited.status).toBe(201)
      const { invitation } = (await invited.json()) as { invitation: { payload: string } }

      const exitCode = await new Promise<number>((resolvePromise, reject) => {
        const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], env: {} })
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error('Swift chainless leaf fixture timeout'))
        }, 40_000)
        child.once('error', error => {
          clearTimeout(timer)
          reject(error)
        })
        child.once('close', code => {
          clearTimeout(timer)
          resolvePromise(code ?? 1)
        })
        child.stdin.end(JSON.stringify({ operation: 'nativeRelayLifecycle', requestId: randomUUID(), payload: invitation.payload }))
      })
      expect(exitCode).not.toBe(0)
    } finally {
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
