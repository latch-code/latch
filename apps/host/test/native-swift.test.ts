import { spawn } from 'node:child_process'
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
  WebSocketParser,
  decodeMessage,
  uint,
  knock,
  serverBinding,
  routeId,
  encodeAddressBook,
  addressBookSigningInput,
  issuePass,
  decodeAddressBook,
  decodeRelayAuthority,
  decodeRelayDirectory,
  encodeRelayAuthority,
  encodeRelayDirectory,
  encodeSignedRelayDirectory,
  encodeDirectorySource,
  relayAuthorityInput,
  relayDirectoryInput,
  directoryEpochInput,
  formatPairingPayload,
  gatewayHash,
  invitationCode,
  parsePairingPayload,
} from '@latch/link-wire'
import { nodeCrypto } from '@latch/link-client/crypto'
import { swiftFixturePath, testHarness } from '@latch/testkit'
import { startTestHost } from './helpers/host.ts'
import { startNativeHost } from '../src/native.ts'
import { loadOrCreateHostIdentity } from '../src/identity.ts'
import { base32 } from '../src/crypto.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
let binary = ''
async function invoke(input: unknown, onDiagnostic?: (text: string) => Promise<void>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8' } })
    let output = '',
      diagnostic = '',
      notified = false
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
      if (onDiagnostic && !notified && diagnostic.includes('Native personal waiting for desktop grant\n')) {
        notified = true
        void onDiagnostic(diagnostic).catch(error => {
          child.kill('SIGKILL')
          reject(error)
        })
      }
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
  it('uses the same bounded first-flight bucket grid in Swift without waiting for a future handshake flight', async () => {
    const first = Buffer.from(encodeFrame({ opcode: 2, payload: new Uint8Array([0, 4]) }, new Uint8Array([1, 2, 3, 4]))).toString('hex')
    const second = Buffer.from(encodeFrame({ opcode: 2, payload: new Uint8Array([0, 5]) }, new Uint8Array([1, 2, 3, 4]))).toString('hex')
    const result = await invoke({
      operation: 'outerPadding',
      actions: [
        { time: 0, frames: [first] },
        { time: 39, frames: [second] },
        { time: 40 },
        { time: 40 },
        { time: 80 },
        { time: 3000 },
        { time: 3001 },
      ],
    })
    expect(result.bufferedBytes).toBe(0)
    const batches = (result.batches as string[]).map(value => Buffer.from(value, 'hex'))
    expect(batches.map(value => value.length)).toEqual([4096, 4096, 4096])
    const frames = new WebSocketParser(true).feed(batches[0]!)
    expect(frames.map(value => decodeMessage(value.payload, 2).type)).toEqual(['data', 'data', 'pad'])
    expect(frames.slice(0, 2).map(value => Buffer.from(value.payload).toString('hex'))).toEqual(['0004', '0005'])
  })
  it('keeps the explicit v3 relay profile and outer-padding HMAC bound to the shared wire vector', async () => {
    const vectors = JSON.parse(await readFile(join(root, 'packages/testkit/vectors/link-v1.json'), 'utf8')) as {
      outerRelayV2: { knock: string; serverBinding: string }
      addressBookV3: { issuedAt: number; hostId: string; deviceId: string; generation: number; payloadHash: string }
    }
    const signed = vectors.addressBookV3
    expect(await invoke({ operation: 'addressBook', ...signed, timeMs: signed.issuedAt, profiles: true })).toEqual({
      hostId: signed.hostId,
      deviceId: signed.deviceId,
      generation: signed.generation,
      payloadHash: signed.payloadHash,
      relays: 1,
      profiles: ['outer-pad-v2'],
    })
    const result = await invoke({ ...vectors, operation: 'vectors', binding: 'relay-pad-v2' })
    expect(result.knock).toBe(vectors.outerRelayV2.knock)
    expect(result.serverBinding).toBe(vectors.outerRelayV2.serverBinding)
  })
  it('keeps both directory floors through encrypted restart, revoked online keys and unknown commits in Swift', async () => {
    const vectors = JSON.parse(await readFile(join(root, 'packages/testkit/vectors/link-v1.json'), 'utf8')) as {
      directory: { authority: string; addresses: string; root: string; now: number }
      addressBook: { encoded: string; payload: string; rootSpki: string; deviceId: string; issuedAt: number }
    }
    const book = decodeAddressBook(Buffer.from(vectors.addressBook.payload, 'hex')),
      authority = decodeRelayAuthority(Buffer.from(vectors.directory.authority, 'hex')),
      online = decodeRelayDirectory(Buffer.from(vectors.directory.addresses, 'hex'))
    authority.nodes[0]!.relayId = book.relays[0]!.relayId
    authority.nodes[0]!.spkiHashes = [book.relays[0]!.spkiHash]
    online.nodes[0]!.relayId = book.relays[0]!.relayId
    async function seal(seed = Buffer.alloc(32, 4)) {
      const root = encodeRelayAuthority(authority)
      online.rootGeneration = authority.generation
      online.rootHash = await nodeCrypto.hash(root)
      const addresses = encodeRelayDirectory(online)
      const bundle = encodeSignedRelayDirectory({
        authority: root,
        directory: addresses,
        rootSignature: await nodeCrypto.sign(Buffer.alloc(32, 3), relayAuthorityInput(root)),
        signature: await nodeCrypto.sign(seed, relayDirectoryInput(addresses)),
      })
      return { bytes: Buffer.from(bundle).toString('hex'), rootHash: online.rootHash, hash: await nodeCrypto.hash(addresses) }
    }
    const first = await seal()
    online.generation = Number.MAX_SAFE_INTEGER
    online.nodes[0]!.addresses = ['1.1.1.1']
    const second = await seal()
    const source = { anchors: [Buffer.from(vectors.directory.root, 'hex')], mirrors: ['https://directory.example/relays-v1.bin'] }
    const freshSource = {
      ...source,
      minimum: { generation: 1, hash: first.rootHash },
      minimumOnline: { generation: Number.MAX_SAFE_INTEGER, hash: second.hash },
    }
    authority.generation++
    authority.revokedKeys = [online.key]
    const revoked = await seal()
    const replacement = Buffer.alloc(32, 5)
    authority.generation++
    authority.keys.push({ ...authority.keys[0]!, publicKey: await nodeCrypto.publicKey(replacement) })
    online.key = await nodeCrypto.publicKey(replacement)
    online.generation = 1
    const reissued = await seal(replacement)
    const cache = {
      book: vectors.addressBook.encoded,
      rootSpki: vectors.addressBook.rootSpki,
      deviceId: vectors.addressBook.deviceId,
      now: vectors.directory.now,
      bookTime: vectors.addressBook.issuedAt,
      source: Buffer.from(encodeDirectorySource(source)).toString('hex'),
      freshSource: Buffer.from(encodeDirectorySource(freshSource)).toString('hex'),
      first: first.bytes,
      second: second.bytes,
      revoked: revoked.bytes,
      reissued: reissued.bytes,
    }
    expect(await invoke({ operation: 'directoryCache', cache })).toEqual({
      unknownStayedClosed: true,
      rootRevocationSurvivedRestart: true,
      freshOfflineReplayRejected: true,
      reissued: true,
      rejected: 4,
    })
    expect(await invoke({ operation: 'directoryResolver', cache })).toEqual({ coalesced: true, revoked: true, cancelled: true })
  })
  it('matches stable directory hints and bounds fragmented HTTP mirror bodies before signatures', async () => {
    const { directoryEpoch: vector } = JSON.parse(await readFile(join(root, 'packages/testkit/vectors/link-v1.json'), 'utf8')) as {
      directoryEpoch: { source: string; hash: string; absentHash: string }
    }
    expect(createHash('sha256').update(directoryEpochInput()).digest('hex')).toBe(vector.absentHash)
    expect(await invoke({ operation: 'directoryEpoch', source: vector.source })).toEqual({
      hash: vector.hash,
      absentHash: vector.absentHash,
    })
    const body = Buffer.from('signed-public-directory-fixture'),
      hash = createHash('sha256').update(body).digest('hex')
    const fixed = Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n`), body])
    const chunked = Buffer.from(
      `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${body.length.toString(16)}\r\n${body.toString()}\r\n0\r\n\r\n`,
    )
    const eof = Buffer.concat([Buffer.from('HTTP/1.0 200 OK\r\n\r\n'), body])
    const valid = [fixed, chunked, eof].flatMap(bytes =>
      [1, 7, 8192].map(fragment => ({ bytes: bytes.toString('hex'), fragment, valid: true, hash })),
    )
    const invalid = [
      'HTTP/1.1 302 Redirect\r\nLocation: https://other.example/\r\n\r\n',
      'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\nab',
      'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\nab',
      'HTTP/1.1 200 OK\r\nContent-Length: 32769\r\n\r\n',
      'HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\n\r\nabc',
      'HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\nshort',
      `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${'1\r\na\r\n'.repeat(1025)}0\r\n\r\n`,
      `HTTP/1.1 200 OK\r\n\r\n${'a'.repeat(32769)}`,
      `HTTP/1.1 200 OK\r\nX-Fill: ${'a'.repeat(8192)}`,
    ].map(value => ({ bytes: Buffer.from(value).toString('hex'), fragment: 8192, valid: false }))
    expect(await invoke({ operation: 'directoryHTTP', cases: [...valid, ...invalid] })).toEqual({
      accepted: valid.length,
      rejected: invalid.length,
    })
  })
  it('matches directory source and opt-in address-book v2 vectors without changing the v1 contract', async () => {
    const vectors = JSON.parse(await readFile(join(root, 'packages/testkit/vectors/link-v1.json'), 'utf8')) as {
      directorySource: { mirrors: string[]; invalidMirrors: string[] }
      directorySourceOnline: { mirrors: string[]; invalidMirrors: string[] }
      addressBookV2: { hostId: string; deviceId: string; generation: number; payloadHash: string; issuedAt: number }
      addressBookV2Online: { hostId: string; deviceId: string; generation: number; payloadHash: string; issuedAt: number }
    }
    expect(await invoke({ operation: 'directorySource', source: vectors.directorySource })).toEqual({
      anchors: 1,
      mirrors: vectors.directorySource.mirrors,
      generation: 1,
      rejected: vectors.directorySource.invalidMirrors.length,
    })
    expect(await invoke({ operation: 'directorySource', source: vectors.directorySourceOnline })).toEqual({
      anchors: 1,
      mirrors: vectors.directorySourceOnline.mirrors,
      generation: 1,
      onlineGeneration: 1,
      rejected: vectors.directorySourceOnline.invalidMirrors.length,
    })
    for (const book of [vectors.addressBookV2, vectors.addressBookV2Online])
      expect(await invoke({ operation: 'addressBook', ...book, timeMs: book.issuedAt })).toEqual({
        hostId: book.hostId,
        deviceId: book.deviceId,
        generation: book.generation,
        payloadHash: book.payloadHash,
        relays: 0,
        directoryAnchors: 1,
      })
  })
  it('verifies the offline directory Root and online address delegation with the shared checkpoint', async () => {
    const { directory } = JSON.parse(await readFile(join(root, 'packages/testkit/vectors/link-v1.json'), 'utf8')) as {
      directory: Record<string, unknown>
    }
    expect(await invoke({ operation: 'directory', directory })).toEqual({
      verified: true,
      rejected: 3,
      rootHash: directory.rootHash,
      hash: directory.hash,
    })
  })
  it('matches padding cells and every fragmented small-cell boundary with the shared wire vector', async () => {
    const { padding } = JSON.parse(await readFile(join(root, 'packages/testkit/vectors/link-v1.json'), 'utf8')) as {
      padding: { payload: string; small: string; largeDummyHash: string }
    }
    expect(await invoke({ operation: 'padding', padding })).toEqual({ small: padding.small, largeDummyHash: padding.largeDummyHash })
  })
  beforeAll(async () => {
    binary = await swiftFixturePath()
  })
  it('matches shared knock, HKDF pairing, P256 verification and recovery vectors using CryptoKit', async () => {
    const vectors = JSON.parse(await readFile(join(root, 'packages/testkit/vectors/link-v1.json'), 'utf8')) as {
      knock: string
      serverBinding: string
      pairing: { knockSecret: string }
      nativeVerification: { text: string; recoverySecret: string }
    }
    expect(await invoke({ ...vectors, operation: 'vectors' })).toEqual({
      knock: vectors.knock,
      serverBinding: vectors.serverBinding,
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
  it('reads the pairing QR as the shared vectors pin it, and refuses what is not one', async () => {
    const vectors = JSON.parse(await readFile(join(root, 'packages/testkit/vectors/link-v1.json'), 'utf8')) as {
      pairingQr: {
        rootSpki: string
        secret: string
        expiresAt: number
        lan: Array<{ address: string; port: number }>
        code: string
        knockKey: string
        encoded: string
        invalid: unknown[]
      }
    }
    const qr = vectors.pairingQr
    const publicAddress = Buffer.from(qr.encoded, 'hex')
    // The first endpoint's address, made public; the vector's second endpoint is untouched.
    publicAddress.set([8, 8, 8, 8], 114)
    const value = (await invoke({ pairingQr: qr, publicAddress: publicAddress.toString('hex'), operation: 'pairingQr' })) as {
      lan: Array<{ address: string; port: number }>
    } & Record<string, unknown>
    expect(value).toEqual({
      rootSpki: qr.rootSpki,
      secret: qr.secret,
      expiresAt: qr.expiresAt,
      code: qr.code,
      knockKey: qr.knockKey,
      lan: qr.lan,
      rejected: qr.invalid.length,
      oldRefused: true,
      foreignRefused: true,
      expired: true,
      linkRefused: true,
      longRefused: true,
      publicRefused: true,
      recognized: true,
      foreignRecognized: false,
    })
  })
  it('reports a matching gateway hash for a Wi-Fi client and for the phone that is the hotspot, and none off the subnet', async () => {
    const mask = 'fffffff0',
      peer = '172.20.10.2',
      expected = Buffer.from(await gatewayHash(nodeCrypto, peer, 28, '172.20.10.1')).toString('hex')
    const gateway = async (input: Record<string, unknown>) => (await invoke({ operation: 'pairingGateway', peer, ...input })).hash
    expect(await gateway({ interfaces: [{ address: '172.20.10.5', mask }], routers: ['172.20.10.1'] })).toBe(expected)
    // The hotspot itself has no router on that network: it is the router.
    expect(await gateway({ interfaces: [{ address: '172.20.10.1', mask }], routers: ['10.1.2.3'] })).toBe(expected)
    expect(await gateway({ interfaces: [{ address: '192.168.1.5', mask: 'ffffff00' }], routers: ['192.168.1.1'] })).toBeUndefined()
    // IPv6: the router is link-local, outside the prefix, and the Mac hashes that same address.
    const v6Mask = 'ffffffffffffffff0000000000000000'
    const v6 = Buffer.from(await gatewayHash(nodeCrypto, 'fd00::2', 64, 'fe80::1')).toString('hex')
    expect(await gateway({ peer: 'fd00::2', interfaces: [{ address: 'fd00::9', mask: v6Mask }], routers: ['fe80::1'] })).toBe(v6)
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
        const response = await (await host.enroll({ listener: 'unix' })).request('native/pairings', { method: 'POST', body: {} })
        const { invitation } = (await response.json()) as { invitation: { payload: string } }
        const payload = parsePairingPayload(invitation.payload)
        const input = {
          port: host.host.nativePort,
          rootSpki: Buffer.from(payload.rootSpki).toString('hex'),
          knockKey: createHash('sha256').update(invitationCode(payload.secret)).digest('hex'),
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
      const response = await (await host.enroll({ listener: 'unix' })).request('native/pairings', { method: 'POST', body: {} })
      const { invitation } = (await response.json()) as { invitation: { payload: string } }
      const payload = parsePairingPayload(invitation.payload)
      expect(
        await invoke({
          operation: 'nativeLeaseExpiry',
          rejectRecovery,
          directRecovery,
          port: faulty.port,
          rootSpki: Buffer.from(payload.rootSpki).toString('hex'),
          knockKey: createHash('sha256').update(invitationCode(payload.secret)).digest('hex'),
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
  it('projects Host sessions for the phone: shelves, frozen words, turns, approvals and what it may start', async () => {
    const at = (minute: number) => `2026-11-01T10:${String(minute).padStart(2, '0')}:00.000Z`
    const result = (await invoke({
      operation: 'phoneProjection',
      hostNow: at(30),
      query: '密钥',
      stamps: ['2026-11-01T10:30:00Z', '2026-11-01T10:30:00.500Z', 'not a date'],
      statuses: ['failed', 'cancelled', 'interrupted', 'idle'],
      runEnds: [
        { runEnd: { reason: 'process-exited', unknownResults: [{ name: 'pnpm test' }] } },
        { runEnd: { reason: 'forced-stop', unknownResultCount: 2, unknownResults: [{ name: 'a' }, { name: 'b' }] } },
        { runEnd: { reason: 'host-stopped' } },
        { runEnd: { reason: 'turn-ended' } },
        { runEnd: { reason: 'turn-ended', unknownResultCount: 1 } },
        {},
      ],
      delivered: {
        summary: { live: { activity: 'starting' } },
        messages: [
          { id: 'u', role: 'user', text: '去做' },
          { id: 'gone', role: 'assistant', text: '', outputs: [{ path: 'old.ts', change: 'deleted' }] },
        ],
      },
      workspaces: [
        { id: 'default', name: '默认文件夹', path: '/work' },
        { id: 'latch', name: 'latch', path: '/work/latch' },
      ],
      tasks: [
        { id: 'a', title: '等批准', status: 'waiting-approval', updatedAt: at(1), workspaceId: 'latch' },
        { id: 'b', title: '问一句', status: 'running', pendingQuestions: 1, updatedAt: at(2), workspaceId: 'latch' },
        {
          id: 'c',
          title: '修复密钥',
          status: 'running',
          updatedAt: at(3),
          workspaceId: 'latch',
          live: { activity: 'model', lastEventAt: at(3) },
        },
        {
          id: 'd',
          title: '安静',
          status: 'running',
          updatedAt: at(4),
          workspaceId: 'latch',
          live: { activity: 'command', lastEventAt: at(4), silent: true },
        },
        {
          id: 'e',
          title: '停止中',
          status: 'running',
          updatedAt: at(5),
          mode: 'chat',
          live: { activity: 'cancelling', silent: true, lastEventAt: at(5) },
        },
        {
          id: 'f',
          title: '强停',
          status: 'interrupted',
          updatedAt: at(6),
          mode: 'chat',
          runEnd: { reason: 'forced-stop', at: at(6), unknownResultCount: 2 },
        },
        { id: 'g', title: '失败', status: 'idle', runOutcome: 'failed', updatedAt: at(7), workspaceId: 'gone' },
        { id: 'h', title: '归档', status: 'idle', archived: true, updatedAt: at(8) },
        { id: 'i', title: '助手', status: 'idle', personal: { assistantId: 'asst_x' }, updatedAt: at(9) },
      ],
      detail: {
        summary: { id: 'c', status: 'running', level: 'L3', branch: 'main', live: { activity: 'command', lastEventAt: at(29) } },
        permission: { level: 'L3', readback: 'mode', defaultMode: 'read-only', neverAskModes: ['yolo'] },
        config: [{ id: 'm', category: 'mode', currentValue: 'yolo', options: [{ value: 'yolo', name: 'Yolo' }] }],
        usageReport: { contextUsed: 62, contextSize: 100, at: at(29) },
        approvals: [],
        runStartedAt: at(28),
        runWaitMs: 60_000,
        liveText: '还在写',
        messages: [
          { id: 'u1', role: 'user', text: '第一轮', turn: { activeMs: 133_000 } },
          { id: 't1', role: 'tool', state: 'completed', tool: { kind: 'read', locations: ['/a/one.ts'] } },
          { id: 't2', role: 'tool', state: 'completed', tool: { kind: 'read', locations: ['/a/two.ts'] } },
          {
            id: 't3',
            role: 'tool',
            state: 'completed',
            tool: { kind: 'edit', diffs: [{ path: 'a.ts', oldText: 'x\ny\n', newText: 'x\nz\nw\n' }] },
          },
          {
            id: 't4',
            role: 'tool',
            state: 'failed',
            tool: { kind: 'edit', decision: { outcome: 'rejected', at: at(1) }, diffs: [{ path: 'no.ts', oldText: '', newText: 'n\n' }] },
          },
          { id: 'a1', role: 'assistant', text: '好了' },
          { id: 'u2', role: 'user', text: '第二轮' },
          { id: 't5', role: 'tool', state: 'running', tool: { kind: 'execute', input: '{"command":"pnpm test"}' } },
        ],
      },
      outputs: [{ path: 'a.ts' }, { path: 'made.pptx', root: 'r' }],
      canApprove: true,
      canApproveElevated: true,
      canRun: true,
      approvals: [
        { toolName: 'write_file', risk: 'R1', tool: { toolTitle: '写入', locations: ['src/a.ts'] } },
        { toolName: 'write_file', risk: 'R1', tool: { toolTitle: '写入', locations: ['src/a.ts', 'src/b.ts', 'src/c.ts'] } },
        {
          toolName: 'write_file',
          risk: 'R1',
          options: [
            { id: 'o1', kind: 'allow_once' },
            { id: 'o2', kind: 'allow_always' },
          ],
        },
        { toolName: 'write_file', risk: 'R1', options: [{ id: 'o2', kind: 'allow_always' }] },
        { toolName: 'write_file', risk: 'R2', riskReason: 'outside-workspace' },
        { toolName: 'shell', advisory: true, risk: 'R2' },
        { toolName: 'write_file' },
      ],
      inputs: [
        { summary: { level: 'L1' }, canRun: true, connected: true },
        { summary: { level: 'L3' }, canRun: true, connected: true },
        { summary: { level: 'L1' }, canRun: true, connected: false },
        { summary: { level: 'L1', permissionDrift: true }, canRun: true, connected: true },
        { summary: { level: 'L1' }, canRun: false, connected: true },
      ],
      catalog: {
        harnesses: [
          testHarness('codex', { label: 'Codex' }),
          testHarness('broken', { label: 'Broken', status: 'unavailable' }),
          testHarness('standard', { kind: 'builtin', label: 'Latch 内置' }),
        ],
        workspaces: [
          { id: 'sealed', name: 'sealed' },
          { id: 'latch', name: 'latch' },
          { id: 'gone', name: 'gone', unavailable: '找不到这个文件夹' },
        ],
        providers: [{ id: 'p', name: 'P', models: ['m1', 'm2'], defaultModel: 'm1' }],
        defaults: { harnessId: 'codex', workspaceId: 'sealed', mode: 'agent', model: { providerId: 'p', model: 'm2' } },
      },
    })) as Record<string, unknown>
    expect(result.parsed).toEqual([Date.parse('2026-11-01T10:30:00Z') / 1000, Date.parse('2026-11-01T10:30:00.500Z') / 1000, -1])
    // A last-confirmed time older than today says which day it belongs to.
    expect(result.confirmed).toEqual([true, true, true])
    expect(result.clocks).toEqual(['0:47', '12:03', '1:02:03'])
    expect(result.durations).toEqual(['', '1.2 秒', '12 秒', '2 分 13 秒', '1 小时 2 分'])
    expect(result.runEnds).toEqual([
      { failed: true, text: 'Codex 已退出 · 这一轮没有完成 · 这 1 条命令结果未知，请核对', unknown: ['pnpm test'] },
      { failed: false, text: '已强制停止 · 这 2 条命令结果未知，请核对', unknown: ['a', 'b'] },
      { failed: false, text: '这一轮被中断了', unknown: [] },
      null,
      { failed: false, text: 'Codex 结束了这一轮 · 这 1 条命令结果未知，请核对', unknown: [] },
      null,
    ])
    expect(result.outcomes).toEqual(['failed', 'stopped', 'interrupted', 'completed'])
    expect(result.delivery).toBe('Mac 已收到')
    expect(result.hasFiles).toEqual([true, false])
    expect(result.noteTooLong).toEqual([false, true, false])
    // Backing out of Face ID is quiet; a sheet that failed says so, and neither reads as a lost connection.
    expect(result.faceId).toEqual([true, true, false, true, false, false])
    expect(result.rows).toEqual(['waiting', 'waiting', 'running', 'silent', 'stopping', 'ended:已强制停止:2', 'failed', 'read', 'read'])
    // A list that may be stale draws nothing live; a run that has already ended still says how.
    expect(result.frozen).toEqual(['frozen', 'frozen', 'frozen', 'frozen', 'frozen', 'ended:已强制停止:2', 'failed', 'read', 'read'])
    expect(result.shelves).toEqual([
      { label: '等你处理', ids: ['d', 'b', 'a'] },
      { label: 'latch', ids: ['c'] },
      { label: '对话', ids: ['g', 'f', 'e'] },
    ])
    expect(result.found).toEqual(['latch'])
    expect(result.turns).toEqual([
      {
        blocks: [{ work: ['reads:2', '编辑 a.ts', '编辑 no.ts'] }, { prose: '好了' }],
        folds: true,
        fold: '已工作 2 分 13 秒 · 1 步被拒绝',
        // The rejected edit never ran, and a file the tools edited keeps their counts over the watcher's.
        files: ['a.ts', 'made.pptx'],
        add: -1,
        del: -1,
      },
      {
        blocks: [{ work: ['运行 pnpm test'] }, { prose: '还在写' }],
        folds: true,
        fold: '已工作',
        files: ['a.ts', 'made.pptx'],
        add: -1,
        del: -1,
      },
    ])
    expect(result.status).toEqual({ text: '命令运行中 · pnpm test', clock: '1:00', tone: 'plain', actions: [] })
    expect(result.subtitle).toEqual(['Codex', '完全访问', 'main', '62%'])
    expect(result.fullAccess).toBe(true)
    expect(result.input).toEqual(['', '', 'Mac 不在线', '这个会话的权限变了，已停止接受输入', '这台手机不能发送消息'])
    expect(result.approvals).toEqual([
      { heading: '写入 src/a.ts', canAllow: true, option: '', refusal: '', clause: '' },
      { heading: '写入 src/a.ts 等 3 处', canAllow: true, option: '', refusal: '', clause: '' },
      { heading: 'write_file', canAllow: true, option: 'o1', refusal: '', clause: '' },
      { heading: 'write_file', canAllow: false, option: '', refusal: '这一步不能只允许一次', clause: '' },
      { heading: 'write_file', canAllow: true, option: '', refusal: '', clause: '在项目文件夹之外' },
      { heading: 'shell', canAllow: true, option: '', refusal: '', clause: '' },
      { heading: 'write_file', canAllow: true, option: '', refusal: '', clause: '高风险' },
    ])
    expect(result.engines).toEqual([
      { id: 'standard', name: 'Latch 内置' },
      { id: 'codex', name: 'Codex' },
    ])
    expect(result.projects).toEqual([{ id: 'sealed' }, { id: 'latch' }])
    expect(result.choice).toEqual({ harness: 'codex', workspace: 'sealed', model: 'm2' })
    expect(result.blocker).toBe('')
    expect(result.fields).toEqual({
      prompt: '开始',
      harnessId: 'codex',
      workspaceId: 'sealed',
      mode: 'agent',
      model: { providerId: 'p', model: 'm2' },
    })
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
  it('rebuilds App paths for verified relay identity and profile changes without reconnecting on pass renewal', async () => {
    const root = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
      rootSpki = root.publicKey.export({ format: 'der', type: 'spki' }),
      holderSeed = Buffer.alloc(32, 8),
      routeSeed = Buffer.alloc(32, 7),
      day = 20000,
      now = day * 86400000 + 3600000,
      relays = await Promise.all(
        [9, 10].map(async id => ({
          relayId: Buffer.alloc(16, id),
          url: `https://relay${id}.example`,
          spkiHash: Buffer.alloc(32, id),
          passes: await Promise.all(
            [day, day + 1].map(async day => ({
              holderSeed,
              pass: await issuePass(nodeCrypto, routeSeed, {
                pairing: false,
                relayId: Buffer.alloc(16, id),
                day,
                notBefore: day * 86400 - 900,
                notAfter: (day + 1) * 86400 + 900,
                routePub: await nodeCrypto.publicKey(routeSeed),
                holderPub: await nodeCrypto.publicKey(holderSeed),
                tag: Buffer.alloc(16, day % 255),
              }),
            })),
          ),
        })),
      ),
      book = {
        hostId: base32(createHash('sha256').update(rootSpki).digest()),
        deviceId: `dev_${'A'.repeat(22)}`,
        generation: 1,
        issuedAt: now - 1000,
        expiresAt: now + 86400000,
        discoveryKey: Buffer.alloc(32, 4),
        lan: [],
        relays,
      }
    const encode = (patch: Partial<Parameters<typeof encodeAddressBook>[0]> = {}) => {
      const payload = encodeAddressBook({ ...book, ...patch }),
        signature = sign('sha256', addressBookSigningInput(payload), { key: root.privateKey, dsaEncoding: 'ieee-p1363' })
      return `LATCHBOOK1.${Buffer.concat([payload, signature]).toString('base64url')}`
    }
    const input = {
      operation: 'bookPathChange',
      rootSpki: rootSpki.toString('hex'),
      deviceId: book.deviceId,
      timeMs: now,
      previous: encode(),
    }
    const refreshed = encode({
      generation: 2,
      issuedAt: now,
      relays: relays.toReversed().map(relay => ({ ...relay, url: 'https://new-address.example', passes: relay.passes.toReversed() })),
    })
    expect(await invoke({ ...input, current: refreshed })).toEqual({ migrate: false })
    for (const patch of [
      { discoveryKey: Buffer.alloc(32, 5) },
      { relays: relays.slice(1) },
      { relays: relays.map((relay, i) => ({ ...relay, ...(i === 0 ? { spkiHash: Buffer.alloc(32, 6) } : {}) })) },
      { relays: relays.map((relay, i) => ({ ...relay, ...(i === 0 ? { profile: 'outer-pad-v2' as const } : {}) })) },
    ])
      expect(await invoke({ ...input, current: encode({ generation: 2, ...patch }) })).toEqual({ migrate: true })
    expect(await invoke({ ...input, previous: encode({ relays: relays.slice(1) }), current: encode() })).toEqual({ migrate: true })
    expect(await invoke({ ...input, previous: undefined, current: encode() })).toEqual({ migrate: true })
    await expect(invoke({ ...input, current: refreshed.slice(0, -6) + 'AAAAAA' })).rejects.toThrow('rejected')
  })
  it('selects relay admission at each dial from one fixed verified book and refuses its expiry', async () => {
    const root = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
      rootSpki = root.publicKey.export({ format: 'der', type: 'spki' }),
      relayId = Buffer.alloc(16, 9),
      holderSeed = Buffer.alloc(32, 8),
      routeSeed = Buffer.alloc(32, 7),
      day = 20000,
      issuedAt = day * 86400000,
      expiresAt = issuedAt + 2 * 86400000,
      passes = await Promise.all(
        [day, day + 1].map(async day => ({
          holderSeed,
          pass: await issuePass(nodeCrypto, routeSeed, {
            pairing: false,
            relayId,
            day,
            notBefore: day * 86400 - 900,
            notAfter: (day + 1) * 86400 + 900,
            routePub: await nodeCrypto.publicKey(routeSeed),
            holderPub: await nodeCrypto.publicKey(holderSeed),
            tag: Buffer.alloc(16, day % 255),
          }),
        })),
      ),
      deviceId = `dev_${'A'.repeat(22)}`,
      payload = encodeAddressBook({
        hostId: base32(createHash('sha256').update(rootSpki).digest()),
        deviceId,
        generation: 1,
        issuedAt,
        expiresAt,
        discoveryKey: Buffer.alloc(32, 4),
        lan: [],
        relays: [{ relayId, url: 'https://relay.example', spkiHash: Buffer.alloc(32, 5), passes }],
      }),
      signature = sign('sha256', addressBookSigningInput(payload), { key: root.privateKey, dsaEncoding: 'ieee-p1363' }),
      input = {
        operation: 'relayAdmission',
        rootSpki: rootSpki.toString('hex'),
        deviceId,
        timeMs: issuedAt + 3600000,
        encoded: `LATCHBOOK1.${Buffer.concat([payload, signature]).toString('base64url')}`,
      }
    expect(await invoke({ ...input, times: [issuedAt + 3600000, issuedAt + 86400000 + 3600000, expiresAt - 1] })).toEqual({
      selected: [0, 1, 1],
    })
    for (const time of [issuedAt - 901000, expiresAt, expiresAt + 1])
      await expect(invoke({ ...input, times: [time] })).rejects.toThrow('rejected')
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
      const draftPayload = formatPairingPayload({
        rootSpki: Buffer.from(first.profile.device.rootSpki, 'base64'),
        secret: Buffer.alloc(16, 1),
        expiresAt: Math.floor(now / 1000) + 600,
        lan: [{ address: '127.0.0.1', port: 1 }],
      })
      const input = {
        operation: 'profiles',
        directory: temporary,
        key: '11'.repeat(32),
        profiles: profiles.map(item => item.profile),
        revocation: revocations[0],
        secondRevocation: revocations[1],
        draft: {
          payload: draftPayload,
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
  it('uses Personal APIs from the actual Swift workspace without persisting hidden memory in chats', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const response = await (await host.enroll({ listener: 'unix' })).request('native/pairings', { method: 'POST', body: {} })
      const { invitation } = (await response.json()) as { invitation: { payload: string } }
      const result = await invoke({ operation: 'nativePersonal', payload: invitation.payload, port: host.host.nativePort })
      expect(result).toEqual({
        personal: true,
        group: true,
        strictGroupCancel: true,
        routine: true,
        personalQueue: true,
        controlRecovery: true,
        windowRequired: true,
        privateHistory: true,
        cachedClassification: true,
        sameRequest: true,
        pendingCleared: true,
        phoneWorkspace: true,
      })
      expect((await owner.json<{ assistants: unknown[] }>('personal')).assistants).toEqual([])
      expect((await owner.json<{ tasks: unknown[] }>('snapshot')).tasks).toEqual([])
      const audit = await readFile(join(host.dataDir, 'audit', 'audit.jsonl'), 'utf8')
      expect(audit).not.toContain('Swift private')
    } finally {
      await host.close()
    }
  }, 30_000)
  it('rejects noncanonical base64url, trailing bytes and unsafe integers without trapping', async () => {
    expect(await invoke({ base64url: 'Zm9v' })).toEqual({ base64url: 'Zm9v', base32: 'mzxw6' })
    for (const base64url of ['A', 'Zh', 'Zg==', 'Z g', 'Zg\n']) await expect(invoke({ base64url })).rejects.toThrow('rejected')
    for (const hex of ['ffffffffffffffff', '0020000000000000', '000000000000000100'])
      await expect(invoke({ operation: 'reader', hex, size: 8 })).rejects.toThrow('rejected')
  })
})
