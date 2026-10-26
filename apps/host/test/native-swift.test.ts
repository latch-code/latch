import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  ascii,
  concat,
  encodeFrame,
  field,
  uint,
  knock,
  serverBinding,
  routeId,
  encodeAddressBook,
  addressBookSigningInput,
} from '@latch/link-wire'
import { nodeCrypto } from '@latch/link-client/crypto'
import { startTestHost } from './helpers/host.ts'
import { startNativeHost } from '../src/native.ts'
import { loadOrCreateHostIdentity } from '../src/identity.ts'
import { base32 } from '../src/crypto.ts'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../../../', import.meta.url)),
  packagePath = join(root, 'native/ios')
let binary = ''
async function invoke(input: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8' } })
    let output = '',
      diagnostic = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Swift fixture timeout'))
    }, 15_000)
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString()
      if (output.length > 1_048_576) child.kill('SIGKILL')
    })
    child.stderr.on('data', (data: Buffer) => {
      diagnostic = (diagnostic + data.toString()).slice(0, 2000)
    })
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', code => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(diagnostic || 'Swift fixture rejected input'))
        return
      }
      try {
        resolve(JSON.parse(output) as Record<string, unknown>)
      } catch {
        reject(new Error('Invalid Swift fixture output'))
      }
    })
    child.stdin.end(JSON.stringify(input))
  })
}

describe.skipIf(process.platform !== 'darwin')('Swift native core interoperability', () => {
  beforeAll(async () => {
    await exec(
      'swift',
      ['build', '--package-path', packagePath, '--product', 'LatchNativeFixture', '--jobs', '4', '--disable-automatic-resolution'],
      { timeout: 120_000, maxBuffer: 2_097_152 },
    )
    const { stdout } = await exec('swift', ['build', '--package-path', packagePath, '--show-bin-path', '--disable-automatic-resolution'])
    binary = join(stdout.trim(), 'LatchNativeFixture')
  }, 150_000)
  it('matches shared knock, HKDF pairing, P256 verification and recovery vectors using CryptoKit', async () => {
    const vectors = JSON.parse(await readFile(join(root, 'packages/testkit/vectors/link-v1.json'), 'utf8')) as {
      knock: string
      serverBinding: string
      pairing: { code: string; knockSecret: string }
      nativeVerification: { text: string; recoverySecret: string }
    }
    expect(await invoke({ ...vectors, operation: 'vectors' })).toEqual({
      knock: vectors.knock,
      serverBinding: vectors.serverBinding,
      pairingCode: vectors.pairing.code,
      knockSecret: vectors.pairing.knockSecret,
      verificationText: vectors.nativeVerification.text,
      recoverySecret: vectors.nativeVerification.recoverySecret,
      verified: true,
    })
    const values = vectors as unknown as Record<string, string | number>
    const bytes = (key: string) => Buffer.from(String(values[key]), 'hex')
    const binding = { path: 'relay' as const, relayId: bytes('relayId'), routeId: await routeId(nodeCrypto, bytes('routePub')) }
    const relay = await invoke({ ...vectors, operation: 'vectors', binding: 'relay' })
    expect(relay.knock).toBe(
      Buffer.from(await knock(nodeCrypto, bytes('knockKey'), binding, Number(values.timeMs), bytes('nonce'))).toString('hex'),
    )
    expect(relay.serverBinding).toBe(
      Buffer.from(await serverBinding(nodeCrypto, bytes('knockKey'), binding, bytes('nonce'), ascii(String(values.certificate)))).toString(
        'hex',
      ),
    )
  })
  it('accepts a root proof only for the pinned root, nonce, actual transport key and system clock', async () => {
    const rootKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
      transport = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const rootSpki = rootKey.publicKey.export({ format: 'der', type: 'spki' }),
      transportSpki = transport.publicKey.export({ format: 'der', type: 'spki' }),
      nonce = Buffer.alloc(16, 7)
    const before = 1000,
      after = 301_000
    const signed = concat(ascii('latch-host-proof-v1\0'), field(transportSpki), nonce, uint(before, 8), uint(after, 8))
    const signature = sign('sha256', signed, { key: rootKey.privateKey, dsaEncoding: 'ieee-p1363' })
    const proof = Buffer.from(concat(field(rootSpki), uint(before, 8), uint(after, 8), signature)).toString('hex')
    const input = {
      operation: 'hostProof',
      proof,
      rootSpki: rootSpki.toString('hex'),
      transportSpki: transportSpki.toString('hex'),
      nonce: nonce.toString('hex'),
      timeMs: 2000,
    }
    expect(await invoke(input)).toEqual({ verified: true })
    for (const patch of [
      { timeMs: 999 },
      { timeMs: after + 1 },
      { nonce: Buffer.alloc(16, 8).toString('hex') },
      { transportSpki: rootSpki.toString('hex') },
      { rootSpki: transportSpki.toString('hex') },
      { proof: `${proof}00` },
    ])
      await expect(invoke({ ...input, ...patch })).rejects.toThrow('rejected')
  })
  it.each([0, 8])(
    'performs the native lifecycle and recovers a signed tombstone after %i days',
    async days => {
      let offset = 0,
        agedRevocation = false
      const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 }, now: () => Date.now() + offset })
      const readCandidates = host.host.security.devices.nativeTransportCandidates.bind(host.host.security.devices)
      const candidates = vi.spyOn(host.host.security.devices, 'nativeTransportCandidates').mockImplementation(() => {
        if (days && host.host.security.devices.nativeRevocations().length) {
          // Move only Host policy time at the next real transport lookup, after revocation was persisted.
          offset = days * 86400_000
          agedRevocation = true
        }
        return readCandidates()
      })
      let resumeAttempts = 0
      const faulty = await startNativeHost({
        tlsBinary: join(root, 'dist/native/latch-native-tls'),
        identity: await loadOrCreateHostIdentity(host.dataDir),
        devices: host.host.security.devices,
        enrollments: host.host.security.enrollments,
        bind: { host: '127.0.0.1', port: 0 },
        handler(req, res) {
          if (req.url === '/link/api/native/verification/resume') resumeAttempts++
          const revocation = req.url === '/link/api/native/revocation'
          res.writeHead(revocation ? 200 : 503, { 'content-type': 'application/json' })
          res.end(JSON.stringify(revocation ? { revocation: null } : { error: 'temporary-unavailable' }))
        },
      })
      try {
        const response = await host.raw('unix', 'api/native/pairings', { method: 'POST', body: {} })
        const { invitation } = (await response.json()) as { invitation: { payload: string } }
        const payload = JSON.parse(Buffer.from(invitation.payload.slice('LATCHPAIR1.'.length), 'base64url').toString()) as {
          rootSpki: string
          invitation: string
        }
        const input = {
          port: host.host.nativePort,
          rootSpki: Buffer.from(payload.rootSpki, 'base64url').toString('hex'),
          knockKey: createHash('sha256').update(payload.invitation).digest('hex'),
        }
        expect(await invoke({ ...input, operation: 'nativeProbe' })).toEqual({ status: 401 })
        await writeFile(join(host.workspaceRoot, 'notes.txt'), 'Swift file fixture')
        const requestId = randomUUID()
        expect(await invoke({ ...input, faultPort: faulty.port, payload: invitation.payload, requestId, operation: 'nativePair' })).toEqual(
          {
            paired: true,
            verified: true,
            created: true,
            persistedBeforeComplete: true,
            bookRefreshed: true,
            bookRefreshCoalesced: true,
            epochHintUntrusted: true,
            resumedWithoutSigning: true,
            oldLeaseClosed: true,
            workspace: true,
            events: true,
            streamRequiresWindow: true,
            replayedAfterMetadata: true,
            rootRevocationClosedLease: true,
            files: true,
            pendingCleared: true,
            freeCancel: true,
            fallbackAfterHandshake: true,
            fallbackAfterResumeFailure: true,
            expiredLeafRejected: true,
          },
        )
        expect(agedRevocation).toBe(days > 0)
        candidates.mockRestore()
        offset = 0
        expect(resumeAttempts).toBeGreaterThan(0)
        const owner = await host.enroll({ listener: 'unix' })
        const snapshot = await owner.json<{ tasks: Array<{ id: string }> }>('snapshot')
        expect(snapshot.tasks).toHaveLength(1)
        const detail = await owner.json<{ messages: Array<{ requestId?: string; text: string }> }>(`tasks/${snapshot.tasks[0]!.id}`)
        expect(detail.messages.find(message => message.requestId === requestId)?.text).toBe('Swift native fixture `notes.txt`')
      } finally {
        candidates.mockRestore()
        offset = 0
        await faulty.close()
        await host.close()
      }
    },
    30_000,
  )
  it.each([
    { name: 'accepted recovery', rejectRecovery: false, directRecovery: false },
    { name: 'rejected reconnect recovery', rejectRecovery: true, directRecovery: false },
    { name: 'rejected explicit unlock recovery', rejectRecovery: true, directRecovery: true },
  ])('expires a restored body lease offline after $name', async ({ rejectRecovery, directRecovery }) => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    let opening = '',
      until = '',
      signatures = 0,
      recoveries = 0
    const token = `lnw1.${Buffer.alloc(32, 7).toString('base64url')}`
    const faulty = await startNativeHost({
      tlsBinary: join(root, 'dist/native/latch-native-tls'),
      identity: await loadOrCreateHostIdentity(host.dataDir),
      devices: host.host.security.devices,
      enrollments: host.host.security.enrollments,
      bind: { host: '127.0.0.1', port: 0 },
      handler(req, res) {
        let bytes = 0
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > 8192) req.destroy()
          else chunks.push(chunk)
        })
        req.on('end', () => {
          const input = JSON.parse(Buffer.concat(chunks).toString()) as { appOpenId?: string; proofReceipt?: string }
          let status = 404,
            result: unknown = {}
          if (req.url === '/link/api/native/verification/challenge') {
            opening = input.appOpenId ?? ''
            status = 200
            result = { nonce: 'expiry-fixture-challenge', appOpenId: opening, expiresAt: Date.now() + 60_000, generation: 1 }
          } else if (req.url === '/link/api/native/verification') {
            signatures++
            until = new Date(Date.now() + 1200).toISOString()
            status = rejectRecovery && signatures > 1 ? 200 : 503
            if (status === 200) result = { verifiedUntil: until, windowToken: token }
          } else if (
            req.url === '/link/api/native/verification/recover'
            && input.appOpenId === opening
            && input.proofReceipt?.startsWith('lnp1.')
          ) {
            recoveries++
            status = rejectRecovery ? 403 : 200
            if (status === 200) result = { verifiedUntil: until, windowToken: token }
          }
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(result))
        })
      },
    })
    try {
      const response = await host.raw('unix', 'api/native/pairings', { method: 'POST', body: {} })
      const { invitation } = (await response.json()) as { invitation: { payload: string } }
      const payload = JSON.parse(Buffer.from(invitation.payload.slice('LATCHPAIR1.'.length), 'base64url').toString()) as {
        rootSpki: string
        invitation: string
      }
      expect(
        await invoke({
          operation: 'nativeLeaseExpiry',
          rejectRecovery,
          directRecovery,
          port: faulty.port,
          rootSpki: Buffer.from(payload.rootSpki, 'base64url').toString('hex'),
          knockKey: createHash('sha256').update(payload.invitation).digest('hex'),
        }),
      ).toEqual({
        recoveredWithoutSigning: !rejectRecovery,
        rejectedRecoveryReverified: rejectRecovery,
        expiredWithoutNetwork: true,
        reboundObserverDidNotExtend: true,
        cancelledObserverSettled: true,
        cacheClosed: true,
      })
      expect(signatures).toBe(rejectRecovery ? 2 : 1)
      expect(recoveries).toBe(1)
    } finally {
      await faulty.close()
      await host.close()
    }
  })
  it('sends neither TLS bytes nor its device certificate to an unauthenticated preflight peer', async () => {
    let received = 0
    const server = createServer(socket => {
      let answered = false
      socket.setTimeout(3000, () => socket.destroy())
      socket.on('error', () => undefined)
      socket.on('data', bytes => {
        received += bytes.length
        if (!answered && received >= 32) {
          answered = true
          const body = concat(field(new Uint8Array([1, 2, 3])), new Uint8Array(32))
          socket.write(concat(uint(body.length, 2), body))
        }
        if (received > 4096) socket.destroy()
      })
    })
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('Missing temporary native listener')
      const root = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'der' })
      await expect(
        invoke({
          operation: 'nativeProbe',
          port: address.port,
          rootSpki: root.toString('hex'),
          knockKey: '11'.repeat(32),
          withFixtureIdentity: true,
        }),
      ).rejects.toThrow('rejected')
      expect(received).toBe(32)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
  it('preserves split UTF-8 event bodies and rejects unbounded or malformed SSE', async () => {
    const text = Buffer.from('event: task-state\r\ndata: {"text":"你好"}\r\n\r\n: heartbeat\n\nevent: refresh\ndata: {}\n\n')
    const chunks = Array.from(text, byte => Buffer.from([byte]).toString('hex'))
    expect(await invoke({ operation: 'events', chunks })).toEqual({
      events: [
        { type: 'task-state', data: '{"text":"你好"}' },
        { type: 'refresh', data: '{}' },
      ],
    })
    await expect(invoke({ operation: 'events', oversizedLine: true })).rejects.toThrow('rejected')
    for (const invalid of [Buffer.from([100, 97, 116, 97, 58, 0xff, 10, 10]), Buffer.from('event: unsafe.event\n\n')])
      await expect(invoke({ operation: 'events', chunks: [invalid.toString('hex')] })).rejects.toThrow('rejected')
  })
  it('matches the existing strict WebSocket wire codec with fragmented input and refuses unsupported frames', async () => {
    const payload = Buffer.from('public relay fixture'),
      mask = Buffer.from([1, 2, 3, 4])
    const incoming = Buffer.from(encodeFrame({ opcode: 2, payload }))
    expect(
      await invoke({
        operation: 'relayFrames',
        chunks: Array.from(incoming, byte => Buffer.from([byte]).toString('hex')),
        payload: payload.toString('hex'),
        mask: mask.toString('hex'),
      }),
    ).toEqual({
      frames: [{ opcode: 2, payload: payload.toString('hex') }],
      encoded: Buffer.from(encodeFrame({ opcode: 2, payload }, mask)).toString('hex'),
    })
    for (const hex of ['0200', '8100', 'c200', '828000000000', '827e0001', '8801ff', '887e0080']) {
      await expect(invoke({ operation: 'relayFrames', chunks: [hex] })).rejects.toThrow('rejected')
    }
  })
  it('matches the anonymous discovery and gateway vectors without historical or textual address ambiguity', async () => {
    const vectors = JSON.parse(await readFile(join(root, 'packages/testkit/vectors/link-v1.json'), 'utf8')) as {
      discovery: {
        key: string
        day: number
        epoch: { hash: string; input: string }
        names: Array<{ label: string }>
        gateways: Array<{ address: string; prefixLength: number; gateway: string; hash: string }>
      }
    }
    const value = vectors.discovery
    expect(await invoke({ operation: 'discovery', ...value })).toEqual({
      labels: value.names.map(item => item.label),
      hashes: value.gateways.map(item => item.hash),
      epoch: value.epoch.hash,
    })
    const mapped = {
      ...value.gateways[0]!,
      address: `::ffff:${value.gateways[0]!.address}`,
      gateway: `::ffff:${value.gateways[0]!.gateway}`,
    }
    expect((await invoke({ operation: 'discovery', ...value, gateways: [mapped] })).hashes).toEqual([mapped.hash])
    expect((await invoke({ operation: 'discovery', ...value, gateways: [{ ...value.gateways[0], mask: 'ffffff00' }] })).hashes).toEqual([
      value.gateways[0]!.hash,
    ])
    for (const mask of ['ffff00ff', '00000000', 'ffffff', 'ff'.repeat(16)])
      await expect(invoke({ operation: 'discovery', ...value, gateways: [{ ...value.gateways[0], mask }] })).rejects.toThrow('rejected')
    await expect(invoke({ operation: 'discovery', ...value, gateways: [{ ...value.gateways[0], prefixLength: 33 }] })).rejects.toThrow(
      'rejected',
    )
  })
  it('accepts credential retirement only for this fixed Root and device signed revocation', async () => {
    const vectors = JSON.parse(await readFile(join(root, 'packages/testkit/vectors/link-v1.json'), 'utf8')) as {
      nativeRevocation: { rootSpki: string; hostId: string; deviceId: string; revokedAt: number; signature: string; tombstoneHash: string }
    }
    const value = vectors.nativeRevocation
    expect(await invoke({ operation: 'revocation', ...value })).toEqual({ verified: true, tombstoneHash: value.tombstoneHash })
    for (const patch of [
      { expectedDeviceId: `dev_${'A'.repeat(22)}` },
      { expectedHostId: 'a'.repeat(52) },
      { revokedAt: value.revokedAt + 1 },
      { signature: 'A'.repeat(86) },
      { rootSpki: '00'.repeat(91) },
    ])
      await expect(invoke({ operation: 'revocation', ...value, ...patch })).rejects.toThrow('rejected')
  })
  it('keeps filtered-stream sequence gaps and heartbeat cursors without treating metadata revision as applied body state', async () => {
    const epoch = 'abc123-test-epoch'
    const text = Buffer.from(
      `id: ${epoch}:3\nevent: refresh\ndata: {"type":"refresh"}\n\nid: ${epoch}:19\n: resumed\n\nid: ${epoch}:25\n: heartbeat\n\n`,
    )
    expect(await invoke({ operation: 'events', chunks: [text.toString('hex')] })).toEqual({
      events: [
        { type: 'refresh', data: '{"type":"refresh"}', cursor: `${epoch}:3` },
        { type: 'resumed', data: '', cursor: `${epoch}:19` },
        { type: 'heartbeat', data: '', cursor: `${epoch}:25` },
      ],
    })
    for (const id of [`${epoch}:01`, `${epoch}:-1`, `${epoch}:9007199254740992`, 'unsafe epoch:1'])
      await expect(invoke({ operation: 'events', chunks: [Buffer.from(`id: ${id}\n\n`).toString('hex')] })).rejects.toThrow('rejected')
  })
  it('verifies the signed address-book vector and refuses rollback, identity changes and expiry', async () => {
    const vectors = JSON.parse(await readFile(join(root, 'packages/testkit/vectors/link-v1.json'), 'utf8')) as {
      addressBook: {
        encoded: string
        rootSpki: string
        deviceId: string
        hostId: string
        issuedAt: number
        expiresAt: number
        generation: number
        payloadHash: string
      }
      discovery: { key: string }
    }
    const book = vectors.addressBook
    const input = {
      operation: 'addressBook',
      ...book,
      timeMs: book.issuedAt,
      priorGeneration: book.generation,
      priorHash: book.payloadHash,
    }
    expect(await invoke(input)).toEqual({
      hostId: book.hostId,
      deviceId: book.deviceId,
      generation: book.generation,
      payloadHash: book.payloadHash,
      relays: 1,
    })
    expect(await invoke({ ...input, operation: 'discoveryKey', timeMs: book.expiresAt + 1 })).toEqual({ key: vectors.discovery.key })
    for (const patch of [
      { priorGeneration: book.generation + 1 },
      { priorHash: '00'.repeat(32) },
      { deviceId: `dev_${'A'.repeat(22)}` },
      { timeMs: book.expiresAt + 1 },
      { encoded: `${book.encoded}AA` },
    ])
      await expect(invoke({ ...input, ...patch })).rejects.toThrow('rejected')
    for (const patch of [{ priorGeneration: book.generation + 1 }, { priorHash: '00'.repeat(32) }, { encoded: `${book.encoded}AA` }])
      await expect(invoke({ ...input, ...patch, operation: 'discoveryKey', timeMs: book.expiresAt + 1 })).rejects.toThrow('rejected')
  })
  it('keeps two computers with the same device ID isolated through concurrent saves, locking and signed retirement', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'latch-swift-profiles-'))
    try {
      const now = Date.now(),
        deviceId = `dev_${'A'.repeat(22)}`
      const profiles = ['profile alpha', 'profile beta'].map(name => {
        const root = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
        const rootSpki = root.publicKey.export({ type: 'spki', format: 'der' })
        const hostId = base32(createHash('sha256').update(rootSpki).digest())
        const payload = Buffer.from(
          encodeAddressBook({
            hostId,
            deviceId,
            generation: 1,
            issuedAt: now - 1000,
            expiresAt: now + 86_400_000,
            discoveryKey: Buffer.alloc(32, 4),
            lan: [],
            relays: [],
          }),
        )
        const signature = sign('sha256', addressBookSigningInput(payload), { key: root.privateKey, dsaEncoding: 'ieee-p1363' })
        const publicKey = () =>
          generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
        return {
          signingKey: root.privateKey,
          profile: {
            name,
            prepared: false,
            device: {
              hostId,
              deviceId,
              rootSpki: rootSpki.toString('base64'),
              knockKey: Buffer.alloc(32, 7).toString('base64'),
              signedAddressBook: `LATCHBOOK1.${Buffer.concat([payload, signature]).toString('base64url')}`,
              bookGeneration: 1,
              bookHash: createHash('sha256').update(payload).digest('base64'),
            },
            keys: {
              connectionTag: Buffer.from(`fixture.connection.${randomUUID()}`).toString('base64'),
              verificationTag: Buffer.from(`fixture.verification.${randomUUID()}`).toString('base64'),
              connectionSpki: publicKey(),
              verificationSpki: publicKey(),
            },
          },
        }
      })
      const first = profiles[0]!,
        revokedAt = Date.now()
      const revocations = profiles.map(item => ({
        hostId: item.profile.device.hostId,
        deviceId,
        revokedAt,
        signature: sign('sha256', Buffer.from(`latch-native-revoked-v1\n${item.profile.device.hostId}\n${deviceId}\n${revokedAt}`), {
          key: item.signingKey,
          dsaEncoding: 'ieee-p1363',
        }).toString('base64url'),
      }))
      const invitation = {
        v: 1,
        rootSpki: Buffer.from(first.profile.device.rootSpki, 'base64').toString('base64url'),
        invitation: `lpi1-${'A'.repeat(26)}`,
        direct: [{ host: '127.0.0.1', port: 1 }],
        relays: [],
        expiresAt: new Date(now + 600_000).toISOString(),
      }
      const input = {
        operation: 'profiles',
        directory: temporary,
        key: '11'.repeat(32),
        profiles: profiles.map(item => item.profile),
        revocation: revocations[0],
        secondRevocation: revocations[1],
        draft: {
          payload: `LATCHPAIR1.${Buffer.from(JSON.stringify(invitation)).toString('base64url')}`,
          keys: first.profile.keys,
          name: 'fixture draft',
        },
      }
      expect(await invoke(input)).toEqual({
        sameDeviceIdIsolated: true,
        concurrentSave: true,
        encryptedRecovery: true,
        lockClosedCache: true,
        immutableDraft: true,
        rootBoundRetirement: true,
        otherCachePreserved: true,
        retirementRetry: true,
        ciphertextProtected: true,
      })
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })
  it('stores authenticated ciphertext with private permissions, rejects substitutions and never follows cache symlinks', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'latch-swift-cache-test-')),
      directory = join(temporary, 'cache')
    const input = { operation: 'vault', directory, key: '11'.repeat(32), expected: 'fixture plaintext' }
    try {
      expect(await invoke({ ...input, text: input.expected })).toEqual({ matches: true, backupExcluded: true })
      const file = join(directory, 'meta-item.lcache'),
        cipher = await readFile(file)
      expect(cipher.includes(Buffer.from(input.expected))).toBe(false)
      expect(await invoke(input)).toEqual({ matches: true, backupExcluded: true })
      await expect(invoke({ ...input, key: '22'.repeat(32) })).rejects.toThrow('rejected')
      await copyFile(file, join(directory, 'meta-other.lcache'))
      await expect(invoke({ ...input, name: 'other' })).rejects.toThrow('rejected')
      await expect(invoke({ ...input, name: '../item' })).rejects.toThrow('rejected')
      const tampered = Buffer.from(cipher)
      tampered[tampered.length - 1]! ^= 1
      await writeFile(file, tampered)
      await expect(invoke(input)).rejects.toThrow('rejected')
      await writeFile(file, cipher)
      await chmod(file, 0o644)
      await expect(invoke(input)).rejects.toThrow('rejected')
      await rm(file)
      const outside = join(temporary, 'outside')
      await mkdir(outside, { mode: 0o700 })
      const outsideFile = join(outside, 'private')
      await writeFile(outsideFile, cipher, { mode: 0o600 })
      await symlink(outsideFile, file)
      await expect(invoke(input)).rejects.toThrow('rejected')
      await symlink(outside, join(temporary, 'alias'))
      await expect(invoke({ ...input, directory: join(temporary, 'alias') })).rejects.toThrow('rejected')
      expect(await readFile(outsideFile)).toEqual(cipher)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })
  it('rejects noncanonical base64url, trailing bytes and unsafe integers without trapping', async () => {
    expect(await invoke({ base64url: 'Zm9v' })).toEqual({ base64url: 'Zm9v', base32: 'mzxw6' })
    for (const base64url of ['A', 'Zh', 'Zg==', 'Z g', 'Zg\n']) await expect(invoke({ base64url })).rejects.toThrow('rejected')
    for (const hex of ['ffffffffffffffff', '0020000000000000', '000000000000000100'])
      await expect(invoke({ operation: 'reader', hex, size: 8 })).rejects.toThrow('rejected')
  })
})
