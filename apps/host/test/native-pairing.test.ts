import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '@latch/sdk'
import { connectPluginTransport } from '../src/native-transports.ts'
import { createTransportCertificate, openNativeHttp, verifyAddressBook, type NativeHttpClient } from '@latch/link-client'
import { invitationCode, parsePairingPayload } from '@latch/link-wire'
import type { Device, NativePairingInvitation, NativePairingStatus } from '@latch/protocol'
import type { TestDevice } from '@latch/testkit'
import { messageCarrierFixture } from './helpers/message-carrier.ts'
import { startTestHost, type TestHost, type TestHostOptions } from './helpers/host.ts'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).toReversed()) await close()
})

const GATEWAY = '0'.repeat(64)
const DIRECT = (t: TestHost) => ({
  listener: 'native-direct' as const,
  origin: `https://native-${t.host.hostId}.invalid`,
  remoteAddress: '127.0.0.1',
})

const owners = new WeakMap<TestHost, TestDevice>()
/** The desktop device: a QR needs 管理此 Host. Its own confirmation leaves no trace in what the test counts. */
async function ownerOf(t: TestHost): Promise<TestDevice> {
  const known = owners.get(t)
  if (known) return known
  const mode = t.presence.mode
  t.presence.mode = 'approve'
  const owner = await t.enroll({ listener: 'unix' })
  t.presence.mode = mode
  t.presence.requests.length = 0
  owners.set(t, owner)
  return owner
}

async function host(options: TestHostOptions = {}): Promise<TestHost> {
  const started = await startTestHost({ native: { host: '127.0.0.1', port: 0 }, presenceMode: 'manual', ...options })
  cleanup.push(() => started.close())
  await ownerOf(started)
  return started
}

async function qr(t: TestHost): Promise<{ invitation: NativePairingInvitation; code: string; rootSpki: Uint8Array; knockKey: Buffer }> {
  const response = await (await ownerOf(t)).request('native/pairings', { method: 'POST', body: {} })
  expect(response.status).toBe(201)
  const { invitation } = (await response.json()) as { invitation: NativePairingInvitation }
  const decoded = parsePairingPayload(invitation.payload),
    code = invitationCode(decoded.secret)
  return { invitation, code, rootSpki: decoded.rootSpki, knockKey: createHash('sha256').update(code).digest() }
}

async function open(t: TestHost, invited: Awaited<ReturnType<typeof qr>>): Promise<NativeHttpClient> {
  const socket = connect(t.host.nativePort!, '127.0.0.1')
  socket.on('error', () => {})
  const client = await openNativeHttp(socket, { path: 'direct' }, { rootSpki: invited.rootSpki, knockKey: invited.knockKey, pairing: true })
  cleanup.push(() => client.close())
  return client
}

function phone(name = '测试手机') {
  const certificate = createTransportCertificate(),
    verification = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return {
    certificate,
    body: (code: string, extra: Record<string, unknown> = {}) => ({
      name,
      publicKey: certificate.spki.toString('base64url'),
      invitation: code,
      gatewayHash: GATEWAY,
      native: {
        certificate: certificate.cert,
        verificationKey: verification.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
      },
      ...extra,
    }),
    signature(t: TestHost, enrollment: { id: string; nonce: string }) {
      return sign('sha256', Buffer.from(`latch-enroll-v1\n${t.host.hostId}\n${enrollment.id}\n${enrollment.nonce}`), {
        key: createPrivateKey(certificate.key),
        dsaEncoding: 'ieee-p1363',
      }).toString('base64url')
    },
  }
}

interface View {
  id: string
  nonce: string
  status: string
}

const status = async (t: TestHost, id: string) =>
  (await (await (await ownerOf(t)).request(`native/pairings/${id}`)).json()) as NativePairingStatus

const auditLines = async (t: TestHost) => (await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8')).trimEnd().split('\n')
const auditOf = async (t: TestHost, action: string) =>
  (await auditLines(t)).map(line => JSON.parse(line) as { action: string; detail: unknown }).filter(line => line.action === action)

async function pairToApproved(t: TestHost, device = phone()) {
  const invited = await qr(t),
    client = await open(t, invited)
  const created = await client.request('POST', '/link/api/enrollments', device.body(invited.code))
  expect(created.status).toBe(202)
  const enrollment = (created.body as { enrollment: View }).enrollment
  await t.presence.waitForRequest()
  t.presence.approveNext()
  await vi.waitFor(async () =>
    expect(((await client.request('GET', `/link/api/enrollments/${enrollment.id}`)).body as { enrollment: View }).enrollment.status).toBe(
      'approved',
    ),
  )
  return { invited, client, device, enrollment }
}

it('issues a QR with the LAN endpoint only, for two minutes, that a closed sheet revokes', async () => {
  const t = await host()
  const before = Date.now()
  const invited = await qr(t)
  const decoded = parsePairingPayload(invited.invitation.payload)
  expect(invited.invitation.payload.startsWith('LATCHPAIR2.')).toBe(true)
  expect(Object.keys(invited.invitation).toSorted()).toEqual(['expiresAt', 'id', 'payload'])
  expect(decoded.lan).toEqual([{ address: '127.0.0.1', port: t.host.nativePort }])
  expect(decoded.expiresAt * 1000).toBeLessThanOrEqual(before + 121_000)
  expect(decoded.expiresAt * 1000).toBeGreaterThanOrEqual(before + 115_000)
  expect(await status(t, invited.invitation.id)).toEqual({ state: 'ready', offNetwork: false })
  // The secret is not in the audit log, in any form.
  const log = (await auditLines(t)).join('\n')
  expect(log).not.toContain(invited.code)
  expect(log).not.toContain(invited.invitation.payload)
  expect(log).not.toContain(invited.knockKey.toString('hex'))

  expect((await (await ownerOf(t)).request(`native/pairings/${invited.invitation.id}`, { method: 'DELETE' })).status).toBe(200)
  await expect(open(t, invited)).rejects.toThrow()
  expect(t.host.security.enrollments.nativePairingOpen()).toBe(false)
})

it('stops accepting a QR after two minutes, and keeps at most two live', async () => {
  let now = Date.now()
  const t = await host({ now: () => now })
  const first = await qr(t),
    second = await qr(t),
    third = await qr(t)
  await expect(open(t, first)).rejects.toThrow()
  expect(await status(t, first.invitation.id)).toEqual({ state: 'expired', offNetwork: false })
  const live = await open(t, second)
  live.close()
  now += 120_001
  await expect(open(t, third)).rejects.toThrow()
  expect(await status(t, third.invitation.id)).toEqual({ state: 'expired', offNetwork: false })
})

it('refuses a request without proof it is nearby, says so to the sheet, and leaves the QR usable', async () => {
  let nearby = false
  const seen: Array<{ pairing: boolean; hash: string }> = []
  const t = await host({
    nativeNearby: (opening, hash) => {
      seen.push({ pairing: opening.pairing, hash: Buffer.from(hash).toString('hex') })
      return nearby
    },
  })
  const invited = await qr(t),
    client = await open(t, invited),
    device = phone()
  const refused = await client.request('POST', '/link/api/enrollments', device.body(invited.code))
  expect(refused.status).toBe(403)
  expect(refused.body).toMatchObject({ error: 'pairing-not-nearby' })
  expect(seen).toEqual([{ pairing: true, hash: GATEWAY }])
  expect(t.presence.requests).toHaveLength(0)
  expect(await status(t, invited.invitation.id)).toEqual({ state: 'ready', offNetwork: true })
  // No hash, no proof: the gate is not even asked.
  const { gatewayHash: _omitted, ...withoutHash } = device.body(invited.code)
  expect((await client.request('POST', '/link/api/enrollments', withoutHash)).body).toMatchObject({ error: 'pairing-not-nearby' })
  expect(seen).toHaveLength(1)
  nearby = true
  expect((await client.request('POST', '/link/api/enrollments', device.body(invited.code))).status).toBe(202)
  expect(t.presence.requests).toHaveLength(1)
})

it('fails closed when nothing can prove proximity: no seam and no network component', async () => {
  const t = await host({ nativeNearby: undefined })
  const invited = await qr(t),
    client = await open(t, invited)
  expect((await client.request('POST', '/link/api/enrollments', phone().body(invited.code))).body).toMatchObject({
    error: 'pairing-not-nearby',
  })
})

it('fails closed when the proximity check itself breaks', async () => {
  const t = await host({
    nativeNearby: () => {
      throw new Error('helper gone')
    },
  })
  const invited = await qr(t),
    client = await open(t, invited)
  expect((await client.request('POST', '/link/api/enrollments', phone().body(invited.code))).body).toMatchObject({
    error: 'pairing-not-nearby',
  })
})

it('asks for one confirmation naming the escaped device, and grants the fixed result', async () => {
  const t = await host()
  const owner = await t.enroll({ listener: 'unix' })
  const { client, device, enrollment } = await pairToApproved(t, phone('工作手机'))
  const preview = t.presence.requests.at(-1)!.preview
  expect(preview.action).toBe('device.enroll-native')
  expect(preview.subject).toEqual({ form: 'device.enroll-native', slots: { device: '工作手机' } })
  expect(preview.reason).toBe('允许「工作手机」连接这台 Mac')
  expect(JSON.stringify(preview)).not.toContain('指纹')
  const signature = device.signature(t, enrollment)
  const prepared = await client.request('POST', `/link/api/enrollments/${enrollment.id}/prepare`, { signature })
  expect(prepared.body).toMatchObject({ deviceId: expect.any(String), addressBook: expect.any(String), hostName: expect.any(String) })
  const completed = await client.request('POST', `/link/api/enrollments/${enrollment.id}/complete`, { signature })
  expect(completed.status).toBe(200)
  expect((completed.body as { device: Device }).device).toMatchObject({
    status: 'active',
    scopes: ['view', 'run', 'approve:standard', 'approve:elevated'],
    dataScope: 'all',
    listener: 'native-direct',
  })
})

it('pairs while a saved relay address is outside the address-book grammar, signing a book with the other relays', async () => {
  // Built-in entries reach relays.json through the saved schema, like a file written before the shared grammar.
  const good = { relayId: 'a'.repeat(32), kind: 'self' as const, url: 'https://relay.example/', spkiHash: 'b'.repeat(64) }
  const bad = ['https://relay.example/?', 'https://other.example/#', 'https://a_b.example/'].map((url, index) => ({
    relayId: String(index + 1).repeat(32),
    kind: 'self' as const,
    url,
    spkiHash: 'c'.repeat(64),
  }))
  const t = await host({ officialRelays: [good, ...bad] })
  const { client, device, enrollment, invited } = await pairToApproved(t)
  const signature = device.signature(t, enrollment)
  const prepared = await client.request('POST', `/link/api/enrollments/${enrollment.id}/prepare`, { signature })
  expect(prepared.status).toBe(200)
  const body = prepared.body as { deviceId: string; addressBook: string }
  const book = verifyAddressBook(body.addressBook, invited.rootSpki, { hostId: t.host.hostId, deviceId: body.deviceId })
  expect(book.relays.map(relay => Buffer.from(relay.relayId).toString('hex'))).toEqual([good.relayId])
  expect((await client.request('POST', `/link/api/enrollments/${enrollment.id}/complete`, { signature })).status).toBe(200)
})

it('escapes what the device calls itself before the sheet shows it', async () => {
  const t = await host()
  const invited = await qr(t),
    client = await open(t, invited)
  const refused = await client.request('POST', '/link/api/enrollments', phone('手机\u202e伪装').body(invited.code))
  expect(refused.body).toMatchObject({ error: 'invalid-device-name' })
  expect(t.presence.requests).toHaveLength(0)
})

it('takes no scope or data-scope request from the phone', async () => {
  const t = await host()
  const invited = await qr(t),
    client = await open(t, invited)
  for (const extra of [{ scopes: ['view'] }, { dataScope: 'work' }, { scopes: ['admin'] }]) {
    const refused = await client.request('POST', '/link/api/enrollments', phone().body(invited.code, extra))
    expect(refused.status).toBe(400)
    expect(refused.body).toMatchObject({ error: 'scope-not-grantable' })
  }
  expect(t.presence.requests).toHaveLength(0)
  expect((await client.request('POST', '/link/api/enrollments', phone().body(invited.code))).status).toBe(202)
})

it('tells a same-named device apart', async () => {
  const t = await host()
  const first = await pairToApproved(t, phone('iPhone'))
  await first.client.request('POST', `/link/api/enrollments/${first.enrollment.id}/complete`, {
    signature: first.device.signature(t, first.enrollment),
  })
  await (await ownerOf(t)).request(`native/pairings/${first.invited.invitation.id}`, { method: 'DELETE' })
  await pairToApproved(t, phone('iPhone'))
  expect(t.presence.requests.at(-1)!.preview.reason).toBe('允许「iPhone (2)」连接这台 Mac')
})

it('renames another device from the Mac only', async () => {
  const t = await host()
  const first = await pairToApproved(t)
  const { device } = (
    await first.client.request('POST', `/link/api/enrollments/${first.enrollment.id}/complete`, {
      signature: first.device.signature(t, first.enrollment),
    })
  ).body as { device: Device }
  const owner = await ownerOf(t)
  const renamed = await owner.request(`devices/${device.id}/name`, { method: 'PATCH', body: { name: '我的手机' } })
  expect(renamed.status).toBe(200)
  expect(t.host.security.devices.get(device.id)?.name).toBe('我的手机')
  const browser = await t.enroll({ listener: 'loopback-tcp' })
  expect((await browser.request(`devices/${device.id}/name`, { method: 'PATCH', body: { name: 'x' } })).status).toBe(403)
})

it('gives the same phone its own enrollment back: a retry with the same keys is not contention', async () => {
  const t = await host()
  const invited = await qr(t),
    device = phone()
  const first = await open(t, invited)
  const created = ((await first.request('POST', '/link/api/enrollments', device.body(invited.code))).body as { enrollment: View })
    .enrollment
  await t.presence.waitForRequest()
  first.close()
  const second = await open(t, invited)
  // A fresh opening learns nothing about the enrollment until it presents the same keys.
  expect((await second.request('GET', '/link/api/native/pairing')).body).toEqual({ enrollment: null })
  expect((await second.request('GET', `/link/api/enrollments/${created.id}`)).status).toBe(401)
  const again = await second.request('POST', '/link/api/enrollments', device.body(invited.code))
  expect(again.status).toBe(202)
  expect((again.body as { enrollment: View }).enrollment).toMatchObject({ id: created.id, nonce: created.nonce, status: 'pending' })
  expect(t.presence.requests).toHaveLength(1)
  expect(await auditOf(t, 'pairing.contended')).toHaveLength(0)
  expect(((await second.request('GET', '/link/api/native/pairing')).body as { enrollment: View }).enrollment.id).toBe(created.id)
  t.presence.approveNext()
  await vi.waitFor(async () => expect((await status(t, invited.invitation.id)).state).toBe('approved'))
  expect(await status(t, invited.invitation.id)).toMatchObject({ device: '测试手机' })
})

it('burns the QR when other keys present it during the confirmation: cancels it, closes the sheet, refuses itself', async () => {
  const t = await host()
  const invited = await qr(t),
    first = await open(t, invited),
    device = phone('先到的手机')
  const created = ((await first.request('POST', '/link/api/enrollments', device.body(invited.code))).body as { enrollment: View })
    .enrollment
  await t.presence.waitForRequest()
  const cancel = vi.spyOn(t.host.security.presence, 'cancel')

  const contender = await open(t, invited)
  const refused = await contender.request('POST', '/link/api/enrollments', phone('后到的手机').body(invited.code))
  expect(refused.status).toBe(409)
  expect(refused.body).toMatchObject({ error: 'pairing-contended' })
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(t.host.security.enrollments.status(created.id, DIRECT(t)).status).toBe('cancelled')
  expect(await status(t, invited.invitation.id)).toEqual({ state: 'contended', offNetwork: false })
  expect(await auditOf(t, 'pairing.contended')).toMatchObject([
    { detail: { invitationId: invited.invitation.id, cancelled: 1, removed: 0 } },
  ])
  // Burned: not the first phone, not a third, and no second window.
  expect(t.presence.requests).toHaveLength(1)
  await expect(open(t, invited)).rejects.toThrow()
  expect(t.host.security.enrollments.nativePairingOpen()).toBe(false)
})

it('removes a device enrolled from a QR when other keys present it within two minutes', async () => {
  let now = Date.now()
  const t = await host({ now: () => now })
  const { invited, client, device, enrollment } = await pairToApproved(t)
  const { device: enrolled } = (
    await client.request('POST', `/link/api/enrollments/${enrollment.id}/complete`, { signature: device.signature(t, enrollment) })
  ).body as { device: Device }
  expect(t.host.security.devices.get(enrolled.id)?.status).toBe('active')
  now += 60_000
  const contender = await open(t, invited)
  expect((await contender.request('POST', '/link/api/enrollments', phone('另一台').body(invited.code))).body).toMatchObject({
    error: 'pairing-contended',
  })
  expect(t.host.security.devices.get(enrolled.id)?.status).toBe('revoked')
  expect(await auditOf(t, 'pairing.contended')).toMatchObject([{ detail: { cancelled: 0, removed: 1 } }])
})

it('leaves a device alone once its two minutes are over: the QR no longer opens at all', async () => {
  let now = Date.now()
  const t = await host({ now: () => now })
  const { invited, client, device, enrollment } = await pairToApproved(t)
  const { device: enrolled } = (
    await client.request('POST', `/link/api/enrollments/${enrollment.id}/complete`, { signature: device.signature(t, enrollment) })
  ).body as { device: Device }
  now += 120_001
  await expect(open(t, invited)).rejects.toThrow()
  expect(t.host.security.devices.get(enrolled.id)?.status).toBe('active')
  expect(await auditOf(t, 'pairing.contended')).toHaveLength(0)
})

it('removes the device a completion in flight makes, when contention lands during it', async () => {
  const t = await host()
  const { invited, client, device, enrollment } = await pairToApproved(t)
  const { devices } = t.host.security
  const create = devices.create.bind(devices)
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  vi.spyOn(devices, 'create').mockImplementationOnce(async (...args) => {
    const result = await create(...args)
    await gate
    return result
  })
  const completing = client.request('POST', `/link/api/enrollments/${enrollment.id}/complete`, {
    signature: device.signature(t, enrollment),
  })
  await vi.waitFor(() => expect(devices.create).toHaveBeenCalled())
  const contender = await open(t, invited)
  expect((await contender.request('POST', '/link/api/enrollments', phone('另一台').body(invited.code))).body).toMatchObject({
    error: 'pairing-contended',
  })
  release()
  const completed = await completing
  expect(completed.status).toBe(409)
  expect(completed.body).toMatchObject({ error: 'pairing-contended' })
  const made = devices.list().find(item => item.listener === 'native-direct')
  expect(made?.status).toBe('revoked')
})

it('burns even when a second request arrives before the first has asked for the confirmation', async () => {
  const t = await host()
  const { presence } = t.host.security
  const request = presence.request.bind(presence),
    cancel = vi.spyOn(presence, 'cancel')
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  vi.spyOn(presence, 'request').mockImplementationOnce(async input => {
    await gate
    return request(input)
  })
  const invited = await qr(t),
    first = await open(t, invited),
    contender = await open(t, invited)
  const pending = first.request('POST', '/link/api/enrollments', phone('先到的手机').body(invited.code))
  await vi.waitFor(() => expect(presence.request).toHaveBeenCalled())
  expect((await contender.request('POST', '/link/api/enrollments', phone('后到的手机').body(invited.code))).body).toMatchObject({
    error: 'pairing-contended',
  })
  release()
  expect((await pending).body).toMatchObject({ error: 'pairing-contended' })
  expect(presence.request).toHaveBeenCalledTimes(1)
  expect(cancel).toHaveBeenCalledTimes(1)
})

it('burns and still reports when the audit record fails', async () => {
  const t = await host()
  const invited = await qr(t),
    first = await open(t, invited)
  const created = ((await first.request('POST', '/link/api/enrollments', phone().body(invited.code))).body as { enrollment: View })
    .enrollment
  await t.presence.waitForRequest()
  const append = t.host.security.audit.append.bind(t.host.security.audit)
  vi.spyOn(t.host.security.audit, 'append').mockImplementation(event =>
    event.action === 'pairing.contended' ? Promise.reject(new Error('fixture audit unavailable')) : append(event),
  )
  const contender = await open(t, invited)
  const refused = await contender.request('POST', '/link/api/enrollments', phone('另一台').body(invited.code))
  expect(refused.status).toBe(409)
  expect(refused.headers['x-latch-audit']).toBe('failed')
  expect(t.host.security.enrollments.status(created.id, DIRECT(t)).status).toBe('cancelled')
})

it('does not let a stranger on another network burn a QR', async () => {
  let nearby = true
  const t = await host({ nativeNearby: () => nearby })
  const invited = await qr(t),
    first = await open(t, invited)
  const created = ((await first.request('POST', '/link/api/enrollments', phone().body(invited.code))).body as { enrollment: View })
    .enrollment
  await t.presence.waitForRequest()
  nearby = false
  const stranger = await open(t, invited)
  expect((await stranger.request('POST', '/link/api/enrollments', phone('远处').body(invited.code))).body).toMatchObject({
    error: 'pairing-not-nearby',
  })
  expect(t.host.security.enrollments.status(created.id, DIRECT(t)).status).toBe('pending')
  expect(await status(t, invited.invitation.id)).toMatchObject({ state: 'confirming', offNetwork: true })
})

it('closing the sheet ends a pairing that has not completed, approved or not', async () => {
  const t = await host()
  const invited = await qr(t),
    pending = await open(t, invited)
  const { id } = ((await pending.request('POST', '/link/api/enrollments', phone().body(invited.code))).body as { enrollment: View })
    .enrollment
  await t.presence.waitForRequest()
  await (await ownerOf(t)).request(`native/pairings/${invited.invitation.id}`, { method: 'DELETE' })
  expect(t.host.security.enrollments.status(id, DIRECT(t)).status).toBe('cancelled')

  const approved = await pairToApproved(t)
  await (await ownerOf(t)).request(`native/pairings/${approved.invited.invitation.id}`, { method: 'DELETE' })
  const completed = await approved.client.request('POST', `/link/api/enrollments/${approved.enrollment.id}/complete`, {
    signature: approved.device.signature(t, approved.enrollment),
  })
  expect(completed.status).toBe(410)
  expect(t.host.security.devices.list().filter(item => item.listener === 'native-direct')).toEqual([])
})

it('wins over an enrollment not yet recorded when the sheet closes', async () => {
  const t = await host()
  const { presence } = t.host.security
  const request = presence.request.bind(presence),
    cancel = vi.spyOn(presence, 'cancel')
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  vi.spyOn(presence, 'request').mockImplementationOnce(async input => {
    await gate
    return request(input)
  })
  const invited = await qr(t),
    client = await open(t, invited)
  const pending = client.request('POST', '/link/api/enrollments', phone().body(invited.code))
  await vi.waitFor(() => expect(presence.request).toHaveBeenCalled())
  await (await ownerOf(t)).request(`native/pairings/${invited.invitation.id}`, { method: 'DELETE' })
  release()
  expect((await pending).body).toMatchObject({ error: 'invitation-invalid' })
  expect(cancel).toHaveBeenCalledTimes(1)
})

it('treats a whole sheet as one claim: other keys on the sibling QR burn the sheet and the device from it', async () => {
  let now = Date.now()
  const t = await host({ now: () => now })
  const older = await qr(t)
  now += 60_000
  const newer = await qr(t)
  const first = await open(t, older),
    attacker = phone('陌生设备')
  const created = ((await first.request('POST', '/link/api/enrollments', attacker.body(older.code))).body as { enrollment: View })
    .enrollment
  await t.presence.waitForRequest()
  t.presence.approveNext()
  await vi.waitFor(() => expect(t.host.security.enrollments.status(created.id, DIRECT(t)).status).toBe('approved'))
  const { device } = (
    await first.request('POST', `/link/api/enrollments/${created.id}/complete`, { signature: attacker.signature(t, created) })
  ).body as { device: Device }
  // The owner scans the QR on screen, the other one of the sheet.
  const owner = await open(t, newer)
  expect((await owner.request('POST', '/link/api/enrollments', phone('我的手机').body(newer.code))).body).toMatchObject({
    error: 'pairing-contended',
  })
  expect(t.host.security.devices.get(device.id)?.status).toBe('revoked')
  for (const invited of [older, newer]) {
    expect(await status(t, invited.invitation.id)).toMatchObject({ state: 'contended' })
    await expect(open(t, invited)).rejects.toThrow()
  }
  // A removed device that was the only one keeps nothing open for it.
  expect(t.host.security.devices.nativeReachable()).toBe(false)
  // A fresh sheet starts clean.
  const fresh = await qr(t)
  ;(await open(t, fresh)).close()
  expect(await status(t, fresh.invitation.id)).toEqual({ state: 'ready', offNetwork: false })
})

it('lets the same keys use either QR of a sheet without contention', async () => {
  const t = await host()
  const a = await qr(t),
    b = await qr(t),
    device = phone()
  const first = await open(t, a)
  const created = ((await first.request('POST', '/link/api/enrollments', device.body(a.code))).body as { enrollment: View }).enrollment
  await t.presence.waitForRequest()
  const second = await open(t, b)
  expect(((await second.request('POST', '/link/api/enrollments', device.body(b.code))).body as { enrollment: View }).enrollment.id).toBe(
    created.id,
  )
  expect(await auditOf(t, 'pairing.contended')).toHaveLength(0)
})

it('frees a sheet after a refusal: the next phone is not contention', async () => {
  const t = await host()
  const a = await qr(t),
    b = await qr(t)
  const first = await open(t, a)
  await first.request('POST', '/link/api/enrollments', phone('甲').body(a.code))
  await t.presence.waitForRequest()
  t.presence.denyNext()
  await vi.waitFor(async () => expect((await status(t, a.invitation.id)).state).toBe('cancelled'))
  expect(await status(t, b.invitation.id)).toEqual({ state: 'ready', offNetwork: false })
  const second = await open(t, b)
  expect((await second.request('POST', '/link/api/enrollments', phone('乙').body(b.code))).status).toBe(202)
  expect(await auditOf(t, 'pairing.contended')).toHaveLength(0)
})

it('burns when two different sets of keys resume in the same tick', async () => {
  const t = await host()
  const a = await qr(t),
    one = await open(t, a),
    two = await open(t, a)
  const answers = await Promise.all([
    one.request('POST', '/link/api/enrollments', phone('甲').body(a.code)),
    two.request('POST', '/link/api/enrollments', phone('乙').body(a.code)),
  ])
  expect(answers.map(item => item.status)).toEqual([409, 409])
  expect(await status(t, a.invitation.id)).toMatchObject({ state: 'contended' })
  expect(await auditOf(t, 'pairing.contended')).toHaveLength(1)
})

it('tells the first phone why when it is burned', async () => {
  const t = await host()
  const a = await qr(t),
    first = await open(t, a)
  const { id } = ((await first.request('POST', '/link/api/enrollments', phone('甲').body(a.code))).body as { enrollment: View }).enrollment
  await t.presence.waitForRequest()
  const second = await open(t, a)
  await second.request('POST', '/link/api/enrollments', phone('乙').body(a.code))
  expect(((await first.request('GET', `/link/api/enrollments/${id}`)).body as { enrollment: unknown }).enrollment).toMatchObject({
    status: 'cancelled',
    contended: true,
  })
})

it('asks after approval: the status names the device, and 没有，移除 removes it at once with no confirmation', async () => {
  const t = await host()
  const owner = await ownerOf(t)
  const paired = await pairToApproved(t)
  const { device } = (
    await paired.client.request('POST', `/link/api/enrollments/${paired.enrollment.id}/complete`, {
      signature: paired.device.signature(t, paired.enrollment),
    })
  ).body as { device: Device }
  const id = paired.invited.invitation.id
  expect(await status(t, id)).toMatchObject({ state: 'done', device: '测试手机', deviceId: device.id })
  const shown = t.presence.requests.length
  expect((await owner.request(`native/pairings/${id}/device`, { method: 'DELETE' })).status).toBe(200)
  expect(t.presence.requests).toHaveLength(shown)
  expect(t.host.security.devices.get(device.id)?.status).toBe('revoked')
  expect(t.host.security.devices.nativeReachable()).toBe(false)
  await expect(open(t, paired.invited)).rejects.toThrow()
})

it('counts a closed sheet as done: nothing burns the device afterwards', async () => {
  const t = await host()
  const paired = await pairToApproved(t)
  const { device } = (
    await paired.client.request('POST', `/link/api/enrollments/${paired.enrollment.id}/complete`, {
      signature: paired.device.signature(t, paired.enrollment),
    })
  ).body as { device: Device }
  await (await ownerOf(t)).request(`native/pairings/${paired.invited.invitation.id}`, { method: 'DELETE' })
  const contender = await open(t, paired.invited)
  expect((await contender.request('POST', '/link/api/enrollments', phone('另一台').body(paired.invited.code))).body).toMatchObject({
    error: 'invitation-invalid',
  })
  expect(t.host.security.devices.get(device.id)?.status).toBe('active')
})

it('removes the device on 没有，移除 however long the person took, and says so only when it did', async () => {
  let now = Date.now()
  const t = await host({ now: () => now })
  const owner = await ownerOf(t)
  const complete = async () => {
    const paired = await pairToApproved(t)
    const { device } = (
      await paired.client.request('POST', `/link/api/enrollments/${paired.enrollment.id}/complete`, {
        signature: paired.device.signature(t, paired.enrollment),
      })
    ).body as { device: Device }
    return { paired, device }
  }
  // The sheet keeps asking for ten minutes, well past when the enrollment was pruned.
  const first = await complete()
  for (let elapsed = 0; elapsed < 600_000; elapsed += 5000) {
    now += 5000
    expect(await status(t, first.paired.invited.invitation.id)).toMatchObject({ state: 'done', deviceId: first.device.id })
  }
  const removed = await owner.request(`native/pairings/${first.paired.invited.invitation.id}/device`, { method: 'DELETE' })
  expect(removed.status).toBe(200)
  expect(await removed.json()).toEqual({ removed: true })
  expect(t.host.security.devices.get(first.device.id)?.status).toBe('revoked')
  expect(await auditOf(t, 'device.revoked')).toMatchObject([{ detail: { deviceId: first.device.id } }])

  // A Host that no longer knows the sheet refuses, and the device is still removable by its ID.
  const second = await complete()
  now += 3_600_000
  await status(t, second.paired.invited.invitation.id)
  now += 3_600_000
  t.host.security.enrollments.nativeInvitations()
  const unknown = await owner.request(`native/pairings/${second.paired.invited.invitation.id}/device`, { method: 'DELETE' })
  expect(unknown.status).toBe(404)
  expect(t.host.security.devices.get(second.device.id)?.status).toBe('active')
  expect((await owner.request(`devices/${second.device.id}`, { method: 'DELETE' })).status).toBe(200)
})

it('starts a clean sheet after one that ended without a word: no false contention, and a QR that reads ready', async () => {
  const t = await host()
  const first = await pairToApproved(t)
  const { device } = (
    await first.client.request('POST', `/link/api/enrollments/${first.enrollment.id}/complete`, {
      signature: first.device.signature(t, first.enrollment),
    })
  ).body as { device: Device }
  // No DELETE: the window closed.
  const next = await qr(t)
  expect(await status(t, next.invitation.id)).toEqual({ state: 'ready', offNetwork: false })
  const client = await open(t, next)
  expect((await client.request('POST', '/link/api/enrollments', phone('第二台').body(next.code))).status).toBe(202)
  expect(t.host.security.devices.get(device.id)?.status).toBe('active')
  expect(await auditOf(t, 'pairing.contended')).toHaveLength(0)
})

it('treats a sheet that stopped asking as closed: its QRs die and an unfinished pairing ends', async () => {
  let now = Date.now()
  const t = await host({ now: () => now })
  const invited = await qr(t),
    pending = await open(t, invited)
  const { id } = ((await pending.request('POST', '/link/api/enrollments', phone().body(invited.code))).body as { enrollment: View })
    .enrollment
  await t.presence.waitForRequest()
  await status(t, invited.invitation.id)
  now += 7000
  expect((await status(t, invited.invitation.id)).state).toBe('confirming')
  now += 9000
  expect(t.host.security.enrollments.nativePairingOpen()).toBe(false)
  expect(t.host.security.enrollments.status(id, DIRECT(t)).status).toBe('cancelled')
})

it('lets a closing sheet beat a completion in flight', async () => {
  const t = await host()
  const { invited, client, device, enrollment } = await pairToApproved(t)
  const { devices } = t.host.security
  const create = devices.create.bind(devices)
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  vi.spyOn(devices, 'create').mockImplementationOnce(async (...args) => {
    const result = await create(...args)
    await gate
    return result
  })
  const completing = client.request('POST', `/link/api/enrollments/${enrollment.id}/complete`, {
    signature: device.signature(t, enrollment),
  })
  await vi.waitFor(() => expect(devices.create).toHaveBeenCalled())
  await (await ownerOf(t)).request(`native/pairings/${invited.invitation.id}`, { method: 'DELETE' })
  release()
  expect((await completing).status).toBe(410)
  expect(devices.list().find(item => item.listener === 'native-direct')?.status).toBe('revoked')
})

it('keeps the real phone in when 64 idle connections hold the listener', async () => {
  const t = await host()
  const a = await qr(t)
  const idle = await Promise.all(
    Array.from({ length: 64 }, async () => {
      const socket = connect(t.host.nativePort!, '127.0.0.1')
      socket.on('error', () => {})
      await new Promise(resolve => socket.once('connect', resolve))
      cleanup.push(() => void socket.destroy())
      return socket
    }),
  )
  const client = await open(t, a)
  expect((await client.request('POST', '/link/api/enrollments', phone().body(a.code))).status).toBe(202)
  expect(idle.some(socket => socket.destroyed)).toBe(true)
})

it('reads a refused claim as free once its record is gone, not as confirming', async () => {
  let now = Date.now()
  const t = await host({ now: () => now })
  const a = await qr(t),
    first = await open(t, a)
  await first.request('POST', '/link/api/enrollments', phone('甲').body(a.code))
  await t.presence.waitForRequest()
  t.presence.denyNext()
  await vi.waitFor(async () => expect((await status(t, a.invitation.id)).state).toBe('cancelled'))
  const next = await qr(t)
  for (let elapsed = 0; elapsed < 300_000; elapsed += 5000) {
    now += 5000
    expect((await status(t, next.invitation.id)).state).not.toBe('confirming')
  }
})

it('takes an ordinary cancel and rescan from the phone as no contention', async () => {
  const t = await host()
  const a = await qr(t),
    b = await qr(t),
    first = await open(t, a)
  const { id } = ((await first.request('POST', '/link/api/enrollments', phone().body(a.code))).body as { enrollment: View }).enrollment
  await t.presence.waitForRequest()
  expect((await first.request('DELETE', `/link/api/enrollments/${id}`)).status).toBe(200)
  const second = await open(t, b)
  expect((await second.request('POST', '/link/api/enrollments', phone('新钥匙').body(b.code))).status).toBe(202)
  expect(await auditOf(t, 'pairing.contended')).toHaveLength(0)
})

it('refuses a QR, its status and closing it to a process on this Mac with no device', async () => {
  const t = await host()
  expect((await t.raw('unix', 'api/native/pairings', { method: 'POST', body: {} })).status).toBe(401)
  const a = await qr(t)
  expect((await t.raw('unix', `api/native/pairings/${a.invitation.id}`)).status).toBe(401)
  expect((await t.raw('unix', `api/native/pairings/${a.invitation.id}`, { method: 'DELETE' })).status).toBe(401)
  ;(await open(t, a)).close()
})

describe('under the real rate limits, a QR holder cannot suppress the burn', () => {
  const real = { rateLimits: 'default' as const }
  it('same-keys retries are free, and other keys still burn after them', async () => {
    const t = await host(real)
    const a = await qr(t),
      attacker = await open(t, a),
      keys = phone('陌生设备')
    for (let round = 0; round < 12; round++)
      expect((await attacker.request('POST', '/link/api/enrollments', keys.body(a.code))).status).toBe(202)
    const owner = await open(t, a)
    expect((await owner.request('POST', '/link/api/enrollments', phone('我的手机').body(a.code))).body).toMatchObject({
      error: 'pairing-contended',
    })
  })
  it('refusals from another network spend nothing the real phone needs, on this QR or the next', async () => {
    let nearby = false
    const t = await host({ ...real, nativeNearby: () => nearby })
    const a = await qr(t)
    for (let client = 0; client < 3; client++) {
      const stranger = await open(t, a)
      for (let round = 0; round < 5; round++) await stranger.request('POST', '/link/api/enrollments', phone('远处').body(a.code))
    }
    nearby = true
    const owner = await open(t, a)
    expect((await owner.request('POST', '/link/api/enrollments', phone('我的手机').body(a.code))).status).toBe(202)
    expect((await open(t, await qr(t))).isClosed()).toBe(false)
  })
  it('closes a connection that keeps failing the gate', async () => {
    const t = await host({ ...real, nativeNearby: () => false })
    const a = await qr(t),
      stranger = await open(t, a)
    for (let round = 0; round < 8; round++)
      await stranger.request('POST', '/link/api/enrollments', phone('远处').body(a.code)).catch(() => {})
    await vi.waitFor(() => expect(stranger.isClosed()).toBe(true))
  })
  it('never lets sockets on a live QR refuse the real phone, and burn through them', async () => {
    const t = await host(real)
    const a = await qr(t),
      keys = phone('陌生设备'),
      held: NativeHttpClient[] = []
    for (let count = 0; count < 4; count++) held.push(await open(t, a))
    for (const client of held) expect((await client.request('POST', '/link/api/enrollments', keys.body(a.code))).status).toBe(202)
    const owner = await open(t, a)
    expect((await owner.request('POST', '/link/api/enrollments', phone('我的手机').body(a.code))).body).toMatchObject({
      error: 'pairing-contended',
    })
    await vi.waitFor(() => expect(held[0]!.isClosed()).toBe(true))
  })
  it('never lets a flood of knocks use up a live QR', async () => {
    const t = await host(real)
    const a = await qr(t)
    for (let round = 0; round < 40; round++) (await open(t, a)).close()
    expect((await (await open(t, a)).request('POST', '/link/api/enrollments', phone().body(a.code))).status).toBe(202)
  }, 60_000)
})

it('refuses to open the sheet and listener during full access', async () => {
  const t = await host()
  vi.spyOn(t.host.security.presence, 'assertCanRequest').mockRejectedValueOnce(new AppError(409, 'presence-blocked', '等待'))
  const refused = await (await ownerOf(t)).request('native/pairings', { method: 'POST', body: {} })
  expect(refused.status).toBe(409)
  expect(t.host.security.enrollments.nativePairingOpen()).toBe(false)
})

it('refuses a device name that could close the sentence quote', async () => {
  const t = await host()
  const a = await qr(t),
    client = await open(t, a)
  expect((await client.request('POST', '/link/api/enrollments', phone('甲」连接这台 Mac，并「乙').body(a.code))).body).toMatchObject({
    error: 'invalid-device-name',
  })
})

it('keeps a way to remove saved relays and the directory, without a confirmation', async () => {
  const t = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
  cleanup.push(() => t.close())
  const owner = await t.enroll({ listener: 'unix' })
  expect((await owner.request(`native/relays/${'a'.repeat(32)}`, { method: 'DELETE' })).status).toBe(200)
  expect((await owner.request('native/directory', { method: 'DELETE' })).status).toBe(200)
  const browser = await t.enroll({ listener: 'loopback-tcp' })
  expect((await browser.request('native/directory', { method: 'DELETE' })).status).toBe(403)
  expect(await auditOf(t, 'native.config.changed')).toHaveLength(2)
})

it('refuses pairing while a full access session holds confirmations back, without spending the QR', async () => {
  const t = await host()
  const invited = await qr(t),
    client = await open(t, invited)
  vi.spyOn(t.host.security.presence, 'assertCanRequest').mockRejectedValueOnce(new AppError(409, 'presence-blocked', '等待'))
  expect((await client.request('POST', '/link/api/enrollments', phone().body(invited.code))).status).toBe(409)
  expect(t.presence.requests).toHaveLength(0)
  expect((await client.request('POST', '/link/api/enrollments', phone().body(invited.code))).status).toBe(202)
})

it('opens no pairing knock on a carrier path', async () => {
  const fixture = messageCarrierFixture()
  const t = await host({
    plugins: [
      {
        id: 'custom-message',
        name: 'Custom message',
        version: '1',
        description: 'Fixture',
        activate(context) {
          context.registerTransport(fixture.driver)
        },
      },
    ],
  })
  await vi.waitFor(() => expect(fixture.listen).toHaveBeenCalledTimes(1))
  const invited = await qr(t)
  await expect(
    connectPluginTransport(t.host.registry, fixture.descriptor, { rootSpki: invited.rootSpki, knockKey: invited.knockKey, pairing: true }),
  ).rejects.toThrow()
  // Still live on the listener it belongs to.
  ;(await open(t, invited)).close()
})

it('refuses a request whose listener is not the direct one, whatever reaches the service', async () => {
  const t = await host()
  const invited = await qr(t)
  await expect(
    t.host.security.enrollments.create(
      phone().body(invited.code),
      { listener: 'native-relay', origin: `https://native-${t.host.hostId}.invalid`, remoteAddress: '中继路径' },
      undefined,
      { nearby: async () => '', budget() {}, auditFailed() {} },
    ),
  ).rejects.toMatchObject({ code: 'pairing-not-nearby' })
  expect(t.presence.requests).toHaveLength(0)
})

it('lowers phones to view-only, one by one, when the Host stopped with the old pause on', async () => {
  const t = await startTestHost({ native: { host: '127.0.0.1', port: 0 }, presenceMode: 'manual' })
  const first = await pairToApproved(t)
  const { device } = (
    await first.client.request('POST', `/link/api/enrollments/${first.enrollment.id}/complete`, {
      signature: first.device.signature(t, first.enrollment),
    })
  ).body as { device: Device }
  const { dataDir, workspaceRoot } = t
  first.client.close()
  await t.host.close()
  const file = join(dataDir, 'auth', 'devices.json')
  const stored = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  await writeFile(file, JSON.stringify({ ...stored, nativeInputsPaused: true }), { mode: 0o600 })
  const second = await startTestHost({ dataDir, workspaceRoot, native: { host: '127.0.0.1', port: 0 } })
  cleanup.push(async () => {
    await second.close()
    await t.close()
  })
  expect(second.host.security.devices.get(device.id)?.scopes).toEqual(['view'])
  expect(await readFile(file, 'utf8')).not.toContain('nativeInputsPaused')
  expect(await auditOf(second, 'device.scopes.changed')).toMatchObject([{ detail: { deviceId: device.id, added: [] } }])
})
