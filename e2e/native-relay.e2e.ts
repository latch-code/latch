import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { startRelay } from '@latch/relay'
import {
  connectRelayTunnel,
  createTransportCertificate,
  nodeCrypto,
  openNativeHttp,
  verifyAddressBook,
  type NativeHttpClient,
} from '@latch/link-client'
import { decodePass, nativeKnockSecret, nativeVerificationText, routeId } from '@latch/link-wire'
import { startTestHost } from './helpers/host.ts'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).toReversed()) await close()
})
function ok<T>(result: { status: number; body: unknown }, status = 200): T {
  expect(result.status).toBe(status)
  return result.body as T
}

it('pairs through a real private relay, caches passes before commit, and survives lost create/complete acknowledgements', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'latch-native-relay-e2e-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const tls = createTransportCertificate(Date.now(), 3_600_000, 'localhost'),
    relayId = randomBytes(16),
    token = randomBytes(32)
  const relay = await startRelay({ host: '127.0.0.1', port: 0, cert: tls.cert, key: tls.key, relayId, registrationToken: token })
  cleanup.push(() => relay.close())
  const dataDir = join(directory, 'data'),
    nativeDir = join(dataDir, 'native')
  await mkdir(nativeDir, { recursive: true, mode: 0o700 })
  const profile = {
    relayId: relayId.toString('hex'),
    url: `https://localhost:${relay.port}/`,
    spkiHash: createHash('sha256').update(tls.spki).digest('hex'),
    registrationKey: `lrt1.${token.toString('base64url')}`,
    seeds: [`lrs1.${randomBytes(32).toString('base64url')}`, `lrs1.${randomBytes(32).toString('base64url')}`],
    activeSlot: 0,
    rotationDay: 0,
    rotations: 0,
  }
  await writeFile(
    join(nativeDir, 'relays.json'),
    JSON.stringify({ version: 1, generation: 0, discoveryKey: `lnd1.${randomBytes(32).toString('base64url')}`, profiles: [profile] }),
    { mode: 0o600 },
  )
  const host = await startTestHost({
    dataDir,
    workspaceRoot: join(directory, 'workspace'),
    nativeRelayCa: tls.cert,
    egressLookup: (_hostname, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]),
  })
  cleanup.push(() => host.close())
  const desktop = await host.enroll({ listener: 'unix' })
  expect(
    (await desktop.confirmed('policy', { method: 'PATCH', body: { hostEgressAllow: { add: [`localhost:${relay.port}`] } } })).status,
  ).toBe(200)
  host.presence.mode = 'manual'
  await vi.waitFor(() => expect(relay.status().routes).toBe(3), { timeout: 3000 })
  expect(relay.status().connections).toBe(1)
  const invited = await desktop.request('native/pairings', { method: 'POST', body: {} })
  expect(invited.status).toBe(201)
  const { invitation } = (await invited.json()) as { invitation: { payload: string } }
  const payload = JSON.parse(Buffer.from(invitation.payload.slice('LATCHPAIR1.'.length), 'base64url').toString()) as {
    rootSpki: string
    invitation: string
    direct: unknown[]
    relays: Array<{ pass: string; holderSeed: string }>
  }
  expect(payload.direct).toHaveLength(0)
  expect(payload.relays).toHaveLength(1)
  const endpoint = {
    url: new URL(profile.url),
    relayId,
    spki: Buffer.from(profile.spkiHash, 'hex'),
    ca: tls.cert,
    resolveAddress: async () => '127.0.0.1',
  }
  const pairPass = Buffer.from(payload.relays[0]!.pass, 'base64url'),
    pairKey = Buffer.from(payload.relays[0]!.holderSeed, 'base64url')
  const binding = { path: 'relay' as const, relayId, routeId: await routeId(nodeCrypto, decodePass(pairPass).routePub) }
  const knockKey = createHash('sha256').update(payload.invitation).digest(),
    rootSpki = Buffer.from(payload.rootSpki, 'base64url')
  const temporary = async (): Promise<NativeHttpClient> => {
    const tunnel = await connectRelayTunnel({ ...endpoint, pass: pairPass, holderKey: pairKey })
    tunnel.on('error', () => {})
    const client = await openNativeHttp(tunnel, binding, { rootSpki, knockKey, pairing: true })
    cleanup.push(() => client.close())
    return client
  }
  const first = await temporary(),
    device = createTransportCertificate(),
    verification = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const create = host.host.security.enrollments.create.bind(host.host.security.enrollments)
  const createFault = vi.spyOn(host.host.security.enrollments, 'create').mockImplementationOnce(async (...args) => {
    const result = await create(...args)
    first.close()
    return result
  })
  await expect(
    first.request('POST', '/link/api/enrollments', {
      name: 'Relay phone fixture',
      publicKey: device.spki.toString('base64url'),
      invitation: payload.invitation,
      native: {
        certificate: device.cert,
        verificationKey: verification.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
      },
    }),
  ).rejects.toThrow()
  createFault.mockRestore()
  const recovered = await temporary()
  const enrollment = ok<{ enrollment: { id: string; nonce: string; status: string } }>(
    await recovered.request('GET', '/link/api/native/pairing'),
  ).enrollment
  const signature = sign('sha256', Buffer.from(`latch-enroll-v1\n${host.host.hostId}\n${enrollment.id}\n${enrollment.nonce}`), {
    key: createPrivateKey(device.key),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url')
  expect((await recovered.request('POST', `/link/api/enrollments/${enrollment.id}/prepare`, { signature })).status).toBe(409)
  host.presence.approveNext()
  await vi.waitFor(async () =>
    expect(
      ok<{ enrollment: { status: string } }>(await recovered.request('GET', `/link/api/enrollments/${enrollment.id}`)).enrollment.status,
    ).toBe('approved'),
  )
  expect((await recovered.request('GET', '/link/api/enrollments/enr_other')).status).toBe(401)
  expect(
    (await recovered.request('POST', '/link/api/enrollments', { name: 'Duplicate', publicKey: device.spki.toString('base64url') })).status,
  ).toBe(401)
  expect((await recovered.request('GET', '/link/api/snapshot')).status).toBe(401)
  expect((await recovered.request('POST', `/link/api/enrollments/${enrollment.id}/prepare`, { signature: 'invalid' })).status).toBe(401)
  const prepared = ok<{ deviceId: string; addressBook: string }>(
    await recovered.request('POST', `/link/api/enrollments/${enrollment.id}/prepare`, { signature }),
  )
  expect(host.host.security.devices.get(prepared.deviceId)).toBeUndefined()
  const book = verifyAddressBook(prepared.addressBook, rootSpki, { hostId: host.host.hostId, deviceId: prepared.deviceId })
  expect(book.relays[0]!.passes).toHaveLength(62)
  const complete = host.host.security.enrollments.complete.bind(host.host.security.enrollments)
  vi.spyOn(host.host.security.enrollments, 'complete').mockImplementationOnce(async (...args) => {
    const result = await complete(...args)
    recovered.close()
    return result
  })
  await expect(recovered.request('POST', `/link/api/enrollments/${enrollment.id}/complete`, { signature })).rejects.toThrow()
  const selected = book.relays[0]!.passes[0]!,
    regular = decodePass(selected.pass)
  expect(regular.pairing).toBe(false)
  const registeredTunnel = await connectRelayTunnel({ ...endpoint, pass: selected.pass, holderKey: selected.holderSeed })
  registeredTunnel.on('error', () => {})
  const registered = await openNativeHttp(
    registeredTunnel,
    { ...binding, routeId: await routeId(nodeCrypto, regular.routePub) },
    {
      rootSpki,
      certificate: device.cert,
      key: device.key,
      knockKey: await nodeCrypto.hash(
        await nativeKnockSecret(nodeCrypto, knockKey, device.spki, verification.publicKey.export({ type: 'spki', format: 'der' })),
      ),
    },
  )
  cleanup.push(() => registered.close())
  const snapshot = ok<{ device: { id: string; status: string; scopes: string[] } }>(await registered.request('GET', '/link/api/snapshot'))
  expect(snapshot.device.id).toBe(prepared.deviceId)
  expect(snapshot.device.status).toBe('review')
  expect(snapshot.device.scopes).toEqual(['view'])
  expect((await registered.request('POST', '/link/api/native/address-book', {})).status).toBe(403)
  const challenge = ok<{ nonce: string; appOpenId: string; expiresAt: number }>(
    await registered.request('POST', '/link/api/native/verification/challenge', { appOpenId: 'native-relay-fixture-open' }),
  )
  const verificationSignature = sign(
    'sha256',
    Buffer.from(nativeVerificationText(host.host.hostId, prepared.deviceId, challenge.nonce, challenge.expiresAt, challenge.appOpenId)),
    { key: verification.privateKey, dsaEncoding: 'ieee-p1363' },
  ).toString('base64url')
  expect((await registered.request('POST', '/link/api/native/verification', { signature: verificationSignature })).status).toBe(200)
  expect((await registered.request('POST', '/link/api/native/address-book', {})).status).toBe(200)
  expect(ok<{ device: { scopes: string[] } }>(await registered.request('GET', '/link/api/snapshot')).device.scopes).toEqual(['view'])
  expect((await registered.request('POST', '/link/api/native/pairings', {})).status).toBe(403)
  const retry = await temporary()
  const repeated = ok<{ device: { id: string } }>(
    await retry.request('POST', `/link/api/enrollments/${enrollment.id}/complete`, { signature }),
  )
  expect(repeated.device.id).toBe(prepared.deviceId)
  expect(host.host.security.devices.list().filter(item => item.id === prepared.deviceId)).toHaveLength(1)
  const confirmations = host.presence.requests.length
  expect(
    (await desktop.request('policy', { method: 'PATCH', body: { hostEgressAllow: { remove: [`localhost:${relay.port}`] } } })).status,
  ).toBe(200)
  expect(host.presence.requests.length).toBe(confirmations)
  await vi.waitFor(() => expect(registered.isClosed()).toBe(true), { timeout: 3000 })
  await vi.waitFor(() => expect(relay.status().connections).toBe(0), { timeout: 3000 })
  expect(host.host.security.devices.get(prepared.deviceId)?.status).toBe('review')
})
