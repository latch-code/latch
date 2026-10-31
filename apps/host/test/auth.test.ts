import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isLocalListener, LISTENER_CLASSES, type BlockingTask, type Device, type DeviceScope, type ListenerClass } from '@latch/protocol'
import { sha256Hex } from '@latch/core/node-kit'
import {
  P256_VECTOR,
  enrollSigningText,
  renewSigningText,
  testDeviceKey,
  type TestDeviceKey,
  createTestPresence,
  type TestPresence,
} from '@latch/testkit'
import { AuditLog, verifyAuditFile, type AuditFs } from '../src/audit.ts'
import {
  CREDENTIAL_LIFETIME,
  DeviceStore,
  EnrollmentService,
  LAST_SEEN_PERSIST,
  PENDING_LIFETIME,
  RENEW_INTERVAL,
  ROTATION_GRACE,
  createOfflineTicket,
  type ConnectionContext,
  type DeviceFs,
} from '../src/auth.ts'
import { deviceFingerprint } from '../src/crypto.ts'
import { ceilingFor, defaultPolicy } from '../src/policy.ts'
import { paramsHash, PresenceService } from '../src/presence.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const hostId = P256_VECTOR.hostId
const unix: ConnectionContext = { listener: 'unix', origin: 'unix:', remoteAddress: '' }
const loopback: ConnectionContext = { listener: 'loopback-tcp', origin: `http://h-${hostId}.localhost:4317`, remoteAddress: '127.0.0.1' }
const otherLoopback: ConnectionContext = { ...loopback, origin: `http://h-${hostId}.localhost:5000` }
const tls: ConnectionContext = { listener: 'tailnet-tls', origin: 'https://latch.example.ts.net', remoteAddress: '100.100.1.2' }

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), 'latch-auth-'))
  cleanups.push(() => rmSync(path, { recursive: true, force: true }))
  return path
}

interface Fixture {
  dataDir: string
  authDir: string
  clock: { now: number }
  audit: AuditLog
  devices: DeviceStore
  presence: TestPresence
  enrollments: EnrollmentService
  reopen(options?: { fs?: DeviceFs }): Promise<DeviceStore>
  auditRecords(): Array<{ action: string; actor: Record<string, unknown>; stepup: string; detail: Record<string, unknown> }>
}

async function fixture(
  options: {
    dataDir?: string
    presence?: TestPresence
    fs?: DeviceFs
    auditFs?: AuditFs
    /** The full-access sessions holding confirmations back; none by default. */
    blockingTasks?: () => Promise<BlockingTask[]>
  } = {},
): Promise<Fixture> {
  const dataDir = options.dataDir ?? tempDir()
  const authDir = join(dataDir, 'auth')
  const clock = { now: Date.UTC(2026, 9, 23, 10) }
  const now = () => clock.now
  const audit = await AuditLog.open(join(dataDir, 'audit'), { now, ...(options.auditFs ? { fs: options.auditFs } : {}) })
  cleanups.push(() => audit.close())
  const devices = await DeviceStore.open({ directory: authDir, hostId, audit, now, fs: options.fs })
  const presence = options.presence ?? createTestPresence()
  const service = new PresenceService({ backend: presence, hostId, audit, now, blockingTasks: options.blockingTasks ?? (async () => []) })
  const enrollments = new EnrollmentService({ hostId, devices, presence: service, audit, directory: authDir, now })
  return {
    dataDir,
    authDir,
    clock,
    audit,
    devices,
    presence,
    enrollments,
    reopen: reopenOptions => DeviceStore.open({ directory: authDir, hostId, audit, now, fs: reopenOptions?.fs }),
    auditRecords: () =>
      readFileSync(join(dataDir, 'audit', 'audit.jsonl'), 'utf8')
        .trimEnd()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line)),
  }
}

interface Enrolled {
  id: string
  credential: string
  key: TestDeviceKey
  connection: ConnectionContext
}

/** An invitation for `connection`'s listener and origin, issued as the command line (or `inviter`) would. */
async function invitationFor(
  context: Fixture,
  connection: ConnectionContext,
  options: { scopes?: DeviceScope[]; inviter?: Device } = {},
): Promise<string> {
  return (await context.enrollments.createInvitation({ ...options, listener: connection.listener, origin: connection.origin }, actor)).code
}

/** Off host.sock, enrolls with a fresh invitation for that listener unless given an invitation or an offline code. */
async function enroll(
  context: Fixture,
  connection: ConnectionContext,
  options: { scopes?: DeviceScope[]; invitation?: string; offlineCode?: string; name?: string } = {},
): Promise<Enrolled> {
  const key = testDeviceKey()
  const invitable = options.scopes?.filter(scope => scope !== 'approve:elevated' && scope !== 'secrets')
  const invitation =
    options.invitation
    ?? (isLocalListener(connection.listener) || options.offlineCode !== undefined
      ? undefined
      : await invitationFor(context, connection, invitable ? { scopes: invitable } : {}))
  const view = await context.enrollments.create(
    {
      publicKey: key.spki,
      name: options.name ?? '测试设备',
      scopes: options.scopes,
      invitation,
      offlineCode: options.offlineCode,
    },
    connection,
  )
  await vi.waitFor(() => expect(context.enrollments.status(view.id, connection).status).toBe('approved'))
  const result = await context.enrollments.complete(view.id, key.sign(enrollSigningText(hostId, view.id, view.nonce!)), connection)
  return { id: result.device.id, credential: result.credential, key, connection }
}

function presented(device: Enrolled) {
  return { kind: device.connection.listener === 'unix' ? ('header' as const) : ('cookie' as const), value: device.credential }
}

/** Renews with `device`'s credential; the answer is pending until it is presented. */
async function renew(context: Fixture, device: Enrolled): Promise<Enrolled> {
  const credentialHash = sha256Hex(device.credential)
  const { nonce } = context.devices.challenge(device.id, credentialHash)
  const result = await context.devices.renew({
    deviceId: device.id,
    nonce,
    signature: device.key.sign(renewSigningText(hostId, device.id, nonce)),
    connection: device.connection,
    credentialHash,
  })
  return { ...device, credential: result.credential }
}

/** Renews and presents the new credential once, which makes it current. */
async function renewAndUse(context: Fixture, device: Enrolled): Promise<Enrolled> {
  const renewed = await renew(context, device)
  expect(await context.devices.authenticate(presented(renewed), renewed.connection)).toMatchObject({ ok: true })
  return renewed
}

const actor = { listener: 'unix' as const, via: 'http' as const }

describe('device credentials', () => {
  it('binds a credential to its listener and origin', async () => {
    const context = await fixture()
    const browser = await enroll(context, loopback)
    expect(browser.credential).toMatch(/^ldc1\.dev_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u)
    const ok = await context.devices.authenticate(presented(browser), loopback)
    expect(ok).toMatchObject({
      ok: true,
      device: {
        id: browser.id,
        status: 'active',
        listener: 'loopback-tcp',
        scopes: ['view', 'run', 'approve:standard'],
        dataScope: 'work',
      },
      renewDue: false,
    })
    expect(ok.ok && ok.renewAfter).toBe(context.clock.now + RENEW_INTERVAL)
    expect(await context.devices.authenticate(presented(browser), otherLoopback)).toEqual({
      ok: false,
      code: 'listener-mismatch',
      deviceId: browser.id,
    })
    expect(await context.devices.authenticate(presented(browser), tls)).toEqual({
      ok: false,
      code: 'listener-mismatch',
      deviceId: browser.id,
    })
    // A cookie credential presented as a header (or on host.sock) is ignored.
    expect(await context.devices.authenticate({ kind: 'header', value: browser.credential }, loopback)).toEqual({
      ok: false,
      code: 'unauthorized',
    })
    expect(await context.devices.authenticate({ kind: 'header', value: browser.credential }, unix)).toEqual({
      ok: false,
      code: 'listener-mismatch',
      deviceId: browser.id,
    })
    expect(context.devices.isActive(browser.id)).toBe(true)
    expect(context.devices.get(browser.id)?.status).toBe('active')
    expect(await context.devices.authenticate(undefined, loopback)).toEqual({ ok: false, code: 'unauthorized' })
    expect(await context.devices.authenticate({ kind: 'cookie', value: 'garbage' }, loopback)).toEqual({ ok: false, code: 'unauthorized' })
    expect(
      await context.devices.authenticate(
        { kind: 'cookie', value: `${browser.credential.slice(0, -1)}${browser.credential.endsWith('A') ? 'B' : 'A'}` },
        loopback,
      ),
    ).toEqual({ ok: false, code: 'unauthorized' })
  })

  it('requires renewal after 24 hours and expires after 30 days', async () => {
    const context = await fixture()
    const device = await enroll(context, loopback)
    context.clock.now += RENEW_INTERVAL + 1
    expect(await context.devices.authenticate(presented(device), loopback)).toEqual({
      ok: false,
      code: 'renewal-required',
      deviceId: device.id,
    })
    const renewed = await renew(context, device)
    expect(await context.devices.authenticate(presented(renewed), loopback)).toMatchObject({ ok: true })
    expect(context.devices.get(device.id)?.credentialExpiresAt).toBe(
      new Date(Date.UTC(2026, 9, 23, 10) + CREDENTIAL_LIFETIME).toISOString(),
    )
    context.clock.now = Date.UTC(2026, 9, 23, 10) + CREDENTIAL_LIFETIME + 1
    expect(await context.devices.authenticate(presented(renewed), loopback)).toEqual({
      ok: false,
      code: 'credential-expired',
      deviceId: device.id,
    })
    expect(context.devices.isActive(device.id)).toBe(false)
    expect(() => context.devices.challenge(device.id)).toThrow(expect.objectContaining({ status: 401 }))
  })

  it('checks renewal challenges and signatures', async () => {
    const context = await fixture()
    const device = await enroll(context, loopback)
    const other = await enroll(context, loopback)
    context.clock.now += RENEW_INTERVAL + 1
    const sign = (nonce: string, key = device.key, id = device.id) => key.sign(renewSigningText(hostId, id, nonce))
    const invalid = expect.objectContaining({ status: 401, code: 'invalid-signature' })

    const first = context.devices.challenge(device.id)
    expect(first.expiresAt).toBe(context.clock.now + 60_000)
    await expect(
      context.devices.renew({ deviceId: device.id, nonce: first.nonce, signature: sign(first.nonce, other.key), connection: loopback }),
    ).rejects.toEqual(invalid)
    // The challenge was consumed by the failed attempt.
    await expect(
      context.devices.renew({ deviceId: device.id, nonce: first.nonce, signature: sign(first.nonce), connection: loopback }),
    ).rejects.toEqual(invalid)

    const foreign = context.devices.challenge(other.id)
    await expect(
      context.devices.renew({ deviceId: device.id, nonce: foreign.nonce, signature: sign(foreign.nonce), connection: loopback }),
    ).rejects.toEqual(invalid)

    const stale = context.devices.challenge(device.id)
    context.clock.now += 60_001
    await expect(
      context.devices.renew({ deviceId: device.id, nonce: stale.nonce, signature: sign(stale.nonce), connection: loopback }),
    ).rejects.toEqual(invalid)

    const wrongText = context.devices.challenge(device.id)
    await expect(
      context.devices.renew({
        deviceId: device.id,
        nonce: wrongText.nonce,
        signature: device.key.sign(enrollSigningText(hostId, device.id, wrongText.nonce)),
        connection: loopback,
      }),
    ).rejects.toEqual(invalid)

    const elsewhere = context.devices.challenge(device.id)
    await expect(
      context.devices.renew({ deviceId: device.id, nonce: elsewhere.nonce, signature: sign(elsewhere.nonce), connection: otherLoopback }),
    ).rejects.toMatchObject({ status: 401, code: 'listener-mismatch' })

    const ok = context.devices.challenge(device.id)
    await expect(
      context.devices.renew({ deviceId: device.id, nonce: ok.nonce, signature: sign(ok.nonce), connection: loopback }),
    ).resolves.toMatchObject({ device: { id: device.id } })
    expect(context.auditRecords().filter(record => record.action === 'device.credential.issued')).toHaveLength(1)
    expect(context.auditRecords().filter(record => record.action === 'device.credential.rotated')).toHaveLength(0)
  })

  it('keeps the replaced credential for a 60 s grace window once the new one is used, then treats its use as a replay', async () => {
    const context = await fixture()
    const admin = await enroll(context, unix, { name: '桌面' })
    const invited = await enroll(context, tls, {
      invitation: (
        await context.enrollments.createInvitation(
          { inviter: context.devices.get(admin.id), listener: tls.listener, origin: tls.origin },
          actor,
        )
      ).code,
    })
    const device = await enroll(context, loopback)
    context.clock.now += RENEW_INTERVAL + 1
    const renewed = await renew(context, device)
    // Until the new credential is used, the old one is still the current one (and still due for renewal).
    expect(await context.devices.authenticate(presented(device), loopback)).toEqual({
      ok: false,
      code: 'renewal-required',
      deviceId: device.id,
    })
    expect(await context.devices.authenticate(presented(renewed), loopback)).toMatchObject({ ok: true, renewDue: false })
    expect(await context.devices.authenticate(presented(device), loopback)).toMatchObject({ ok: true, device: { id: device.id } })
    // Inside the grace window the replaced credential can no longer renew.
    const rotated = expect.objectContaining({ status: 409, code: 'credential-rotated' })
    expect(() => context.devices.challenge(device.id, sha256Hex(device.credential))).toThrow(rotated)
    expect(() => context.devices.challenge(device.id)).toThrow(rotated)
    const nonce = context.devices.challenge(device.id, sha256Hex(renewed.credential)).nonce
    await expect(
      context.devices.renew({
        deviceId: device.id,
        nonce,
        signature: device.key.sign(renewSigningText(hostId, device.id, nonce)),
        connection: loopback,
        credentialHash: sha256Hex(device.credential),
      }),
    ).rejects.toEqual(rotated)
    context.clock.now += ROTATION_GRACE + 1
    expect(await context.devices.authenticate(presented(renewed), loopback)).toMatchObject({ ok: true })
    expect(await context.devices.authenticate(presented(device), loopback)).toEqual({
      ok: false,
      code: 'device-revoked',
      deviceId: device.id,
    })
    expect(context.devices.get(device.id)).toMatchObject({ status: 'revoked', revokedReason: 'replay' })
    expect(await context.devices.authenticate(presented(renewed), loopback)).toEqual({
      ok: false,
      code: 'device-revoked',
      deviceId: device.id,
    })
    const revocations = readFileSync(join(context.authDir, 'revocations.jsonl'), 'utf8')
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(revocations).toEqual([{ at: context.clock.now, deviceId: device.id, reason: 'replay' }])
    expect(context.auditRecords().find(record => record.action === 'device.revoked')?.detail).toEqual({
      deviceId: device.id,
      reason: 'replay',
      cascaded: 0,
    })

    // Replaying the unix admin's old credential cascades to the device it invited.
    context.clock.now += RENEW_INTERVAL + 1
    const adminRenewed = await renewAndUse(context, admin)
    context.clock.now += ROTATION_GRACE + 1
    expect(await context.devices.authenticate(presented(admin), unix)).toMatchObject({ code: 'device-revoked' })
    expect(await context.devices.authenticate(presented(adminRenewed), unix)).toMatchObject({ code: 'device-revoked' })
    expect(context.devices.get(invited.id)).toMatchObject({ status: 'review', scopes: ['view'] })
  })

  it('keeps the old credential current when a renewal answer is lost, and revokes nothing when it renews again', async () => {
    const context = await fixture()
    const device = await enroll(context, loopback)
    context.clock.now += RENEW_INTERVAL + 1
    // The answer to this renewal never arrives.
    await renew(context, device)
    expect(await context.devices.authenticate(presented(device), loopback)).toEqual({
      ok: false,
      code: 'renewal-required',
      deviceId: device.id,
    })
    context.clock.now += ROTATION_GRACE + 1
    const second = await renew(context, device)
    context.clock.now += ROTATION_GRACE + 1
    expect(await context.devices.authenticate(presented(device), loopback)).toEqual({
      ok: false,
      code: 'renewal-required',
      deviceId: device.id,
    })
    expect(await context.devices.authenticate(presented(second), loopback)).toMatchObject({ ok: true })
    expect(context.devices.get(device.id)).toMatchObject({ status: 'active' })
    expect(
      context
        .auditRecords()
        .map(record => record.action)
        .filter(action => action.startsWith('device.credential') || action === 'device.revoked'),
    ).toEqual(['device.credential.issued', 'device.credential.issued', 'device.credential.rotated'])
  })

  it('makes a renewed credential current on its first use, after a restart too, and keeps only its hash on disk', async () => {
    const context = await fixture()
    const device = await enroll(context, loopback)
    context.clock.now += RENEW_INTERVAL + 1
    const renewedAt = context.clock.now
    const renewed = await renew(context, device)
    const stored = () => devicesFile(context).devices.find(item => item.id === device.id)!
    expect(stored()).toMatchObject({ pending: { hash: sha256Hex(renewed.credential), issuedAt: renewedAt }, previous: [] })
    expect((stored().credential as { hash: string }).hash).toBe(sha256Hex(device.credential))
    expect(context.devices.streamAllowed(device.id, sha256Hex(renewed.credential))).toBe(false)

    const reopened = await context.reopen()
    context.clock.now += 1000
    const first = await reopened.authenticate(presented(renewed), loopback)
    expect(first).toMatchObject({
      ok: true,
      renewDue: false,
      renewAfter: context.clock.now + RENEW_INTERVAL,
      credentialHash: sha256Hex(renewed.credential),
    })
    expect(stored()).toMatchObject({ credential: { hash: sha256Hex(renewed.credential), rotatedAt: context.clock.now } })
    expect(stored().pending).toBeUndefined()
    expect(stored().previous).toEqual([
      { hash: sha256Hex(device.credential), rotatedAt: Date.UTC(2026, 9, 23, 10), graceUntil: context.clock.now + ROTATION_GRACE },
    ])
    expect(reopened.streamAllowed(device.id, sha256Hex(renewed.credential))).toBe(true)
    // Presenting it again changes nothing more.
    expect(await reopened.authenticate(presented(renewed), loopback)).toMatchObject({ ok: true })
    expect(context.auditRecords().filter(record => record.action === 'device.credential.rotated')).toEqual([
      expect.objectContaining({ actor: { deviceId: device.id, listener: 'loopback-tcp', via: 'http' }, detail: { deviceId: device.id } }),
    ])
  })

  it('drops a renewed credential that is not used within ten minutes', async () => {
    const context = await fixture()
    const device = await enroll(context, loopback)
    const renewed = await renew(context, device)
    context.clock.now += PENDING_LIFETIME + 1
    expect(await context.devices.authenticate(presented(renewed), loopback)).toEqual({ ok: false, code: 'unauthorized' })
    expect(await context.devices.authenticate(presented(device), loopback)).toMatchObject({
      ok: true,
      credentialHash: sha256Hex(device.credential),
    })
    await context.devices.rename(device.id, '书房', actor)
    expect(devicesFile(context).devices.find(item => item.id === device.id)!.pending).toBeUndefined()
    expect(context.devices.get(device.id)?.status).toBe('active')

    // A later renewal replaces an unused one; the replaced answer is simply unknown.
    const first = await renew(context, device)
    const second = await renew(context, device)
    expect(await context.devices.authenticate(presented(first), loopback)).toEqual({ ok: false, code: 'unauthorized' })
    expect(await context.devices.authenticate(presented(second), loopback)).toMatchObject({ ok: true })
    expect(context.devices.get(device.id)?.status).toBe('active')
  })

  it('cascades a revocation to the devices it invited and lets an admin restore them with a step-up', async () => {
    const context = await fixture()
    const desktop = await enroll(context, unix)
    const invitation = await context.enrollments.createInvitation(
      {
        inviter: context.devices.get(desktop.id),
        scopes: ['view', 'run', 'approve:standard', 'admin'],
        listener: tls.listener,
        origin: tls.origin,
      },
      actor,
    )
    const phone = await enroll(context, tls, { invitation: invitation.code, scopes: ['view', 'run', 'approve:standard', 'admin'] })
    expect(context.devices.get(phone.id)).toMatchObject({
      pairedBy: { method: 'invitation', deviceId: desktop.id },
      scopes: ['view', 'run', 'approve:standard', 'admin'],
    })
    const result = await context.devices.revoke(desktop.id, 'manual', actor)
    expect(result).toMatchObject({
      device: { id: desktop.id, status: 'revoked', revokedReason: 'manual' },
      cascaded: [phone.id],
      audited: true,
    })
    expect(context.devices.get(phone.id)).toMatchObject({ status: 'review', scopes: ['view'] })
    expect(await context.devices.authenticate(presented(phone), tls)).toMatchObject({
      ok: true,
      device: { status: 'review', scopes: ['view'] },
    })
    expect(
      context
        .auditRecords()
        .filter(record => record.action === 'device.review')
        .map(record => record.detail),
    ).toEqual([{ deviceId: phone.id, causeDeviceId: desktop.id }])
    expect(context.devices.hasActiveAdmin()).toBe(false)

    await expect(context.devices.setScopes(phone.id, { scopes: ['view', 'run'] }, actor, 'none')).rejects.toMatchObject({
      status: 403,
      code: 'stepup-required',
    })
    await expect(context.devices.setScopes(phone.id, { scopes: ['view', 'secrets'] }, actor, 'lpc-local')).rejects.toMatchObject({
      status: 400,
      code: 'scope-not-grantable',
    })
    expect(await context.devices.setScopes(phone.id, { scopes: ['view', 'run'] }, actor, 'lpc-local')).toMatchObject({
      status: 'active',
      scopes: ['view', 'run'],
    })
    expect(await context.devices.setScopes(phone.id, { scopes: ['view'] }, actor, 'none')).toMatchObject({
      status: 'active',
      scopes: ['view'],
    })
    expect(
      context
        .auditRecords()
        .filter(record => record.action === 'device.scopes.changed')
        .map(record => [record.detail, record.stepup]),
    ).toEqual([
      [{ deviceId: phone.id, added: ['run'], removed: [] }, 'lpc-local'],
      [{ deviceId: phone.id, added: [], removed: ['run'] }, 'none'],
    ])
    // Revoking again is a no-op.
    expect((await context.devices.revoke(desktop.id, 'manual', actor)).cascaded).toEqual([])
  })

  it('keeps a revocation through a crash before devices.json is rewritten, and over a restored backup', async () => {
    let failRename = false
    const fs: DeviceFs = {
      open: (path, flags, mode) => open(path, flags, mode),
      rename: async (from, to) => {
        if (failRename) throw Object.assign(new Error('crash'), { code: 'EIO' })
        await rename(from, to)
      },
    }
    const context = await fixture({ fs })
    const device = await enroll(context, loopback)
    const backup = readFileSync(join(context.authDir, 'devices.json'), 'utf8')
    failRename = true
    await context.devices.revoke(device.id, 'manual', actor)
    expect(JSON.parse(readFileSync(join(context.authDir, 'devices.json'), 'utf8')).devices[0].status).toBe('active')
    const reopened = await context.reopen()
    expect(reopened.get(device.id)).toMatchObject({ status: 'revoked', revokedReason: 'manual' })
    expect(await reopened.authenticate(presented(device), loopback)).toMatchObject({ code: 'device-revoked' })
    expect(JSON.parse(readFileSync(join(context.authDir, 'devices.json'), 'utf8')).devices[0].status).toBe('revoked')

    writeFileSync(join(context.authDir, 'devices.json'), backup)
    expect((await context.reopen()).get(device.id)?.status).toBe('revoked')
    // A torn final line that still parses counts; garbage in the middle is refused.
    const log = join(context.authDir, 'revocations.jsonl')
    writeFileSync(log, `${readFileSync(log, 'utf8')}{"at":1,"devic`)
    await expect(context.reopen()).resolves.toBeTruthy()
    writeFileSync(log, `garbage\n${readFileSync(log, 'utf8')}`)
    await expect(context.reopen()).rejects.toMatchObject({ status: 500, code: 'devices-corrupt' })
  })

  it('never writes a credential to disk and keeps files private', async () => {
    const context = await fixture()
    const device = await enroll(context, loopback)
    const desktop = await enroll(context, unix)
    context.clock.now += RENEW_INTERVAL + 1
    const renewed = await renew(context, device)
    await context.devices.revoke(desktop.id, 'self', actor)
    for (const name of readdirSync(context.authDir)) {
      const text = readFileSync(join(context.authDir, name), 'utf8')
      for (const secret of [device.credential, renewed.credential, desktop.credential]) {
        expect(text).not.toContain(secret)
        expect(text).not.toContain(secret.split('.')[2])
      }
      expect(statSync(join(context.authDir, name)).mode & 0o077).toBe(0)
    }
    expect(readFileSync(join(context.dataDir, 'audit', 'audit.jsonl'), 'utf8')).not.toContain(device.credential.split('.')[2])
    expect(statSync(context.authDir).mode & 0o777).toBe(0o700)
    expect(await verifyAuditFile(join(context.dataDir, 'audit', 'audit.jsonl'))).toMatchObject({ ok: true })
  })

  it('refuses a corrupt or foreign devices.json without overwriting it', async () => {
    const context = await fixture()
    await enroll(context, loopback)
    const path = join(context.authDir, 'devices.json')
    const original = readFileSync(path, 'utf8')
    writeFileSync(path, '{broken')
    await expect(context.reopen()).rejects.toMatchObject({ status: 500, code: 'devices-corrupt' })
    expect(readFileSync(path, 'utf8')).toBe('{broken')
    writeFileSync(path, original.replace(hostId, 'b'.repeat(52)))
    await expect(context.reopen()).rejects.toMatchObject({ code: 'devices-host-mismatch', message: '设备登记属于另一台 Host' })
    writeFileSync(path, original.replace('"version": 2', '"version": 3'))
    await expect(context.reopen()).rejects.toMatchObject({ code: 'devices-corrupt' })
  })

  it('renames devices and validates names', async () => {
    const context = await fixture()
    const device = await enroll(context, loopback)
    expect(await context.devices.rename(device.id, '  书房  ', actor)).toMatchObject({ name: '书房' })
    await expect(context.devices.rename(device.id, '', actor)).rejects.toMatchObject({ status: 400 })
    await expect(context.devices.rename(device.id, 'a\nb', actor)).rejects.toMatchObject({ status: 400 })
    await expect(context.devices.rename('dev_missing', 'x', actor)).rejects.toMatchObject({ status: 404 })
  })

  it('finishes the last-seen write that no request awaits before close resolves, and starts none after it', async () => {
    let holding = false
    const held: Array<() => void> = []
    let opened = 0
    const fs: DeviceFs = {
      open: (path, flags, mode) => {
        opened++
        return open(path, flags, mode)
      },
      rename: async (from, to) => {
        if (holding) await new Promise<void>(done => held.push(done))
        await rename(from, to)
      },
    }
    const context = await fixture({ fs })
    const device = await enroll(context, loopback)
    holding = true
    context.clock.now += LAST_SEEN_PERSIST
    // Answered at once; devices.json is written in the background and held at the rename.
    expect(await context.devices.authenticate(presented(device), loopback)).toMatchObject({ ok: true })
    let closed = false
    const closing = context.devices.close().then(() => {
      closed = true
    })
    await new Promise(done => setTimeout(done, 50))
    expect(held).toHaveLength(1)
    expect(closed).toBe(false)
    holding = false
    for (const done of held) done()
    await closing
    const seenAt = new Date(context.clock.now).toISOString()
    expect(devicesFile(context).devices[0]).toMatchObject({ lastSeenAt: seenAt })
    expect(readdirSync(context.authDir).filter(name => name.endsWith('.tmp'))).toEqual([])

    const writes = opened
    context.clock.now += LAST_SEEN_PERSIST
    expect(await context.devices.authenticate(presented(device), loopback)).toMatchObject({ ok: true })
    await new Promise(done => setImmediate(done))
    expect(opened).toBe(writes)
    expect(devicesFile(context).devices[0]).toMatchObject({ lastSeenAt: seenAt })
  })
})

describe('migration from v1', () => {
  function writeV1(authDir: string, now: number) {
    mkdirSync(authDir, { recursive: true, mode: 0o700 })
    const hash = (token: string) => createHash('sha256').update(token).digest('hex')
    const base = { createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-02T00:00:00.000Z' }
    writeFileSync(
      join(authDir, 'devices.json'),
      JSON.stringify({
        version: 1,
        devices: [
          {
            ...base,
            id: 'a2c4e6a8-0000-4000-8000-000000000001',
            name: '书房电脑',
            role: 'owner',
            revoked: false,
            tokenHash: hash('owner-token-value'),
            expiresAt: now + 86_400_000,
          },
          {
            ...base,
            id: 'a2c4e6a8-0000-4000-8000-000000000002',
            name: '手机',
            role: 'controller',
            revoked: false,
            tokenHash: hash('controller'),
            expiresAt: now + 86_400_000,
          },
          {
            ...base,
            id: 'a2c4e6a8-0000-4000-8000-000000000003',
            name: '旧电脑',
            role: 'owner',
            revoked: true,
            tokenHash: hash('old'),
            expiresAt: now + 86_400_000,
          },
        ],
        pairings: [{ tokenHash: hash('pairing'), expiresAt: now + 60_000 }],
      }),
      { mode: 0o600 },
    )
    writeFileSync(join(authDir, 'owner-token'), 'x'.repeat(43), { mode: 0o600 })
  }

  it('revokes controllers, keeps owners only as legacy-pending, and deletes the owner token', async () => {
    const dataDir = tempDir()
    writeV1(join(dataDir, 'auth'), Date.UTC(2026, 9, 23, 10))
    const context = await fixture({ dataDir })
    expect(existsSync(join(context.authDir, 'owner-token'))).toBe(false)
    const stored = JSON.parse(readFileSync(join(context.authDir, 'devices.json'), 'utf8'))
    expect(stored).toMatchObject({ version: 2, hostId })
    expect(JSON.stringify(stored)).not.toContain('pairings')
    const byName = Object.fromEntries(stored.devices.map((device: { name: string }) => [device.name, device]))
    expect(byName['书房电脑']).toMatchObject({
      status: 'legacy-pending',
      scopes: ['view'],
      listener: 'loopback-tcp',
      origin: '',
      publicKey: '',
      fingerprint: '',
      credential: null,
      legacyTokenHash: createHash('sha256').update('owner-token-value').digest('hex'),
      pairedBy: { method: 'migration' },
    })
    expect(byName['手机']).toMatchObject({ status: 'revoked', revokedReason: 'migration' })
    expect(byName['旧电脑']).toMatchObject({ status: 'revoked', revokedReason: 'migration' })
    for (const device of stored.devices) expect(device.id).toMatch(/^dev_[A-Za-z0-9_-]{22}$/u)
    const revoked = readFileSync(join(context.authDir, 'revocations.jsonl'), 'utf8')
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line).deviceId)
    expect(revoked.sort()).toEqual([byName['手机'].id, byName['旧电脑'].id].sort())
    expect(
      context
        .auditRecords()
        .filter(record => record.action === 'migration.devices.v2')
        .map(record => record.detail),
    ).toEqual([{ revoked: 2, legacy: 1 }])

    // The old cookie only learns that it must re-confirm, and only on loopback.
    expect(await context.devices.authenticate({ kind: 'legacy-cookie', value: 'owner-token-value' }, loopback)).toEqual({
      ok: false,
      code: 'legacy-reconfirm',
      legacyName: '书房电脑',
    })
    expect(await context.devices.authenticate({ kind: 'legacy-cookie', value: 'owner-token-value' }, tls)).toEqual({
      ok: false,
      code: 'unauthorized',
    })
    expect(await context.devices.authenticate({ kind: 'legacy-cookie', value: 'controller' }, loopback)).toEqual({
      ok: false,
      code: 'unauthorized',
    })
    expect(context.devices.isActive(byName['书房电脑'].id)).toBe(false)
    expect(context.devices.hasActiveAdmin()).toBe(false)

    // Opening again changes nothing.
    const before = readFileSync(join(context.authDir, 'devices.json'), 'utf8')
    await context.reopen()
    expect(readFileSync(join(context.authDir, 'devices.json'), 'utf8')).toBe(before)
    expect(context.auditRecords().filter(record => record.action === 'migration.devices.v2')).toHaveLength(1)
  })

  it('retires the legacy record when that browser re-enrolls', async () => {
    const dataDir = tempDir()
    writeV1(join(dataDir, 'auth'), Date.UTC(2026, 9, 23, 10))
    const context = await fixture({ dataDir })
    const key = testDeviceKey()
    const invitation = await invitationFor(context, loopback)
    const view = await context.enrollments.create({ publicKey: key.spki, name: '', invitation }, loopback, {
      kind: 'legacy-cookie',
      value: 'owner-token-value',
    })
    await vi.waitFor(() => expect(context.enrollments.status(view.id, loopback).status).toBe('approved'))
    expect(context.presence.requests[0]!.preview.lines[0]).toEqual({ label: '设备名称', value: '书房电脑' })
    const result = await context.enrollments.complete(view.id, key.sign(enrollSigningText(hostId, view.id, view.nonce!)), loopback)
    expect(result.device.name).toBe('书房电脑')
    expect(await context.devices.authenticate({ kind: 'legacy-cookie', value: 'owner-token-value' }, loopback)).toEqual({
      ok: false,
      code: 'unauthorized',
    })
    expect(context.devices.list().find(device => device.name === '书房电脑' && device.pairedBy.method === 'migration')).toMatchObject({
      status: 'revoked',
      revokedReason: 'migration',
    })
  })

  it('deletes a stray owner token when there is no device file', async () => {
    const dataDir = tempDir()
    mkdirSync(join(dataDir, 'auth'), { recursive: true })
    writeFileSync(join(dataDir, 'auth', 'owner-token'), 'x'.repeat(43))
    const context = await fixture({ dataDir })
    expect(existsSync(join(context.authDir, 'owner-token'))).toBe(false)
    expect(JSON.parse(readFileSync(join(context.authDir, 'devices.json'), 'utf8'))).toEqual({ version: 2, hostId, devices: [] })
  })
})

describe('this computer', () => {
  /** One connection per listener class. */
  const connections: Record<ListenerClass, ConnectionContext> = {
    unix,
    'loopback-tcp': loopback,
    'lan-tls': { listener: 'lan-tls', origin: 'https://latch.example.lan', remoteAddress: '192.168.1.20' },
    'tailnet-tls': tls,
    'native-direct': { listener: 'native-direct', origin: 'https://native.example.invalid', remoteAddress: '192.168.1.20' },
    'native-relay': { listener: 'native-relay', origin: 'https://native.example.invalid', remoteAddress: '中继路径' },
  }

  it('counts only host.sock as this computer: every other listener needs its own invitation, refuses offline codes and cannot show a confirmation uninvited', async () => {
    expect(Object.keys(connections).toSorted()).toEqual(LISTENER_CLASSES.toSorted())
    for (const listener of LISTENER_CLASSES) {
      const local = listener === 'unix'
      const connection = connections[listener]
      expect(isLocalListener(listener)).toBe(local)
      expect(ceilingFor(defaultPolicy('darwin'), listener)).toBe(local ? 'L2' : 'L1')
      const context = await fixture({ presence: createTestPresence({ mode: 'manual' }) })
      const ticket = await createOfflineTicket(context.authDir, { now: () => context.clock.now })
      expect(await context.enrollments.info(connection)).toMatchObject({ invitationRequired: !local, offlineCodeAccepted: local })

      // An offline code skips the local confirmation, so only host.sock takes it; elsewhere it is not even used up.
      const offline = context.enrollments.create({ publicKey: testDeviceKey().spki, name: '离线', offlineCode: ticket.code }, connection)
      if (local) await expect(offline).resolves.toMatchObject({ status: 'approved' })
      else {
        await expect(offline).rejects.toMatchObject({ status: 403, code: 'offline-code-invalid' })
        expect((await context.enrollments.info(unix)).offlineCodeAccepted).toBe(true)
      }
      for (const scope of ['approve:elevated', 'secrets'] as const) {
        const elevated = context.enrollments.create({ publicKey: testDeviceKey().spki, name: '高', scopes: ['view', scope] }, connection)
        if (!local) {
          await expect(elevated).rejects.toMatchObject({ status: 400, code: 'scope-not-grantable' })
          continue
        }
        const view = await elevated
        await context.presence.waitForRequest()
        context.presence.denyNext()
        await vi.waitFor(() => expect(context.enrollments.status(view.id, connection).status).toBe('denied'))
      }
      const shown = context.presence.requests.length

      // Without an invitation only host.sock makes the Host show its confirmation window.
      const uninvited = context.enrollments.create({ publicKey: testDeviceKey().spki, name: '无邀请' }, connection)
      if (local) {
        await expect(uninvited).resolves.toMatchObject({ status: 'pending' })
        await vi.waitFor(() => expect(context.presence.requests).toHaveLength(shown + 1))
        expect(context.presence.requests.at(-1)!.preview.requester).toMatchObject({ listener: 'unix', remoteAddress: '本机 host.sock' })
        continue
      }
      await expect(uninvited).rejects.toMatchObject({ status: 403, code: 'invitation-required' })
      if (listener === 'native-direct' || listener === 'native-relay') {
        expect(context.presence.requests).toHaveLength(shown)
        continue
      }
      // An invitation opens only the listener and origin it was issued for.
      for (const other of LISTENER_CLASSES.filter(item => item !== listener && !isLocalListener(item))) {
        const foreign = await invitationFor(context, connections[other])
        await expect(
          context.enrollments.create({ publicKey: testDeviceKey().spki, name: '别处', invitation: foreign }, connection),
        ).rejects.toMatchObject({ status: 403, code: 'invitation-invalid' })
      }
      await expect(
        context.enrollments.create(
          { publicKey: testDeviceKey().spki, name: '别的端口', invitation: await invitationFor(context, connection) },
          { ...connection, origin: `${connection.origin}0` },
        ),
      ).rejects.toMatchObject({ code: 'invitation-invalid' })
      expect(context.presence.requests).toHaveLength(shown)

      // With its own invitation the request is shown, never as coming from this computer.
      const invited = await context.enrollments.create(
        { publicKey: testDeviceKey().spki, name: '受邀', invitation: await invitationFor(context, connection) },
        connection,
      )
      expect(invited.status).toBe('pending')
      const { preview } = await context.presence.waitForRequest()
      expect(preview.requester).toEqual({ deviceName: '受邀', listener, remoteAddress: connection.remoteAddress })
      const source = preview.lines.find(line => line.label === '来源地址')!.value
      expect(source).not.toContain('host.sock')
      expect(preview.lines.find(line => line.label === '连接方式')!.value).not.toMatch(/本机/u)
      if (listener === 'loopback-tcp') expect(source).toBe('127.0.0.1 · 回环端口（也可能是转发进来的连接）')
      context.presence.denyNext()
    }
  })

  it('lets a device take the confirmation window from a waiting enrollment only over host.sock', async () => {
    for (const listener of LISTENER_CLASSES) {
      const context = await fixture()
      const backend = createTestPresence({ mode: 'manual' })
      const presence = new PresenceService({ backend, hostId, audit: context.audit, blockingTasks: async () => [] })
      const params = { enrollmentId: 'enr_x' }
      await presence.request({
        action: 'device.enroll',
        subject: { form: 'device.enroll-named', slots: { device: '受邀' } },
        requester: { deviceName: '受邀', listener: 'lan-tls', remoteAddress: '192.168.1.20' },
        lines: [],
        warnings: [],
        paramsHash: paramsHash('device.enroll', params),
      })
      await backend.waitForRequest()
      const device = presence.request({
        action: 'policy.change',
        subject: { form: 'policy.local', slots: { level: '完全访问' } },
        requester: { deviceId: `dev_${'D'.repeat(22)}`, deviceName: '设备', listener, remoteAddress: connections[listener].remoteAddress },
        lines: [],
        warnings: [],
        paramsHash: paramsHash('policy.change', { baseHash: 'a', nextHash: 'b' }),
      })
      if (isLocalListener(listener)) await expect(device).resolves.toMatchObject({ status: 'pending' })
      else await expect(device).rejects.toMatchObject({ status: 409, code: 'presence-busy' })
    }
  })
})

describe('enrollment', () => {
  it('shows the device on the Host and completes only with a signature from the enrolling key', async () => {
    const context = await fixture({ presence: createTestPresence({ mode: 'manual' }) })
    expect(await context.enrollments.info(loopback)).toEqual({
      hostId,
      listener: 'loopback-tcp',
      presence: { status: 'available' },
      invitationRequired: true,
      offlineCodeAccepted: false,
    })
    expect((await context.enrollments.info(unix)).firstDevice).toBe(true)
    const key = testDeviceKey()
    const scopes: DeviceScope[] = ['view', 'run', 'approve:standard', 'admin']
    const view = await context.enrollments.create(
      { publicKey: key.spki, name: '我的浏览器', scopes, invitation: await invitationFor(context, loopback, { scopes }) },
      loopback,
    )
    const fingerprint = deviceFingerprint(Buffer.from(key.spki, 'base64url'))
    expect(view).toEqual({
      id: expect.stringMatching(/^enr_/u),
      status: 'pending',
      fingerprint,
      nonce: expect.any(String),
      expiresAt: new Date(context.clock.now + 120_000).toISOString(),
      hashDisplay: expect.stringMatching(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/u),
      // A loopback peer may arrive through a forwarded port: the sheet names the device, never where it is.
      reason: '允许「我的浏览器」连接这台 Mac',
    })
    const { preview } = await context.presence.waitForRequest()
    expect(preview.title).toBe('允许新设备连接')
    expect(preview.reason).toBe(view.reason)
    expect(preview.requester).toEqual({ deviceName: '我的浏览器', listener: 'loopback-tcp', remoteAddress: '127.0.0.1' })
    // Loopback is never presented as this computer: a forwarded port arrives there as 127.0.0.1 too.
    expect(preview.lines).toEqual([
      { label: '设备名称', value: '我的浏览器' },
      { label: '设备指纹', value: fingerprint },
      { label: '来源地址', value: '127.0.0.1 · 回环端口（也可能是转发进来的连接）' },
      { label: '连接方式', value: `回环端口 · ${loopback.origin}` },
      { label: '请求的权限', value: '查看、发起和继续会话、批准普通操作、管理此 Host' },
      { label: '数据范围', value: '工作' },
      { label: '邀请来源', value: '命令行' },
    ])
    expect(JSON.stringify(preview)).not.toContain('本机')
    expect(preview.warnings).toEqual([
      '只有在你正在登记这台设备、并且两边显示的指纹完全一致时才确认。',
      '该设备将可以管理此 Host（模型服务、插件、项目和其他设备）。',
    ])
    expect(context.presence.requests[0]!.requireBiometric).toBe(true)
    expect(context.enrollments.status(view.id, loopback)).toEqual({
      id: view.id,
      status: 'pending',
      fingerprint,
      expiresAt: view.expiresAt,
      hashDisplay: view.hashDisplay,
      reason: view.reason,
    })
    await expect(context.enrollments.complete(view.id, 'x', loopback)).rejects.toMatchObject({ status: 409, code: 'enrollment-pending' })
    expect(() => context.enrollments.status(view.id, otherLoopback)).toThrow(
      expect.objectContaining({ status: 409, code: 'listener-mismatch', message: '请在发起登记的同一页面完成登记' }),
    )
    expect(() => context.enrollments.status('enr_missing', loopback)).toThrow(
      expect.objectContaining({ status: 404, code: 'enrollment-not-found' }),
    )
    context.presence.approveNext()
    await vi.waitFor(() => expect(context.enrollments.status(view.id, loopback).status).toBe('approved'))

    const other = testDeviceKey()
    const sign = (signer: TestDeviceKey) => signer.sign(enrollSigningText(hostId, view.id, view.nonce!))
    await expect(context.enrollments.complete(view.id, sign(other), loopback)).rejects.toMatchObject({
      status: 401,
      code: 'invalid-signature',
    })
    await expect(context.enrollments.complete(view.id, sign(key), otherLoopback)).rejects.toMatchObject({ code: 'listener-mismatch' })
    const result = await context.enrollments.complete(view.id, sign(key), loopback)
    expect(result.device).toMatchObject({
      name: '我的浏览器',
      listener: 'loopback-tcp',
      fingerprint,
      scopes: ['view', 'run', 'approve:standard', 'admin'],
      dataScope: 'work',
      pairedBy: { method: 'invitation' },
    })
    await expect(context.enrollments.complete(view.id, sign(key), loopback)).rejects.toMatchObject({
      status: 409,
      code: 'enrollment-completed',
    })
    expect(context.devices.hasActiveAdmin()).toBe(true)
    expect((await context.enrollments.info(unix)).firstDevice).toBe(false)
    const records = context.auditRecords()
    expect(records.find(record => record.action === 'device.enroll.requested')?.detail).toMatchObject({
      listener: 'loopback-tcp',
      fingerprint: fingerprint.replace(/ /gu, ''),
      scopes: ['view', 'run', 'approve:standard', 'admin'],
    })
    expect(records.find(record => record.action === 'device.enrolled')).toMatchObject({
      stepup: 'lpc-local',
      detail: { deviceId: result.device.id, method: 'invitation' },
    })
  })

  it('voids the enrollment after three bad signatures', async () => {
    const context = await fixture()
    const key = testDeviceKey()
    const view = await context.enrollments.create(
      { publicKey: key.spki, name: '浏览器', invitation: await invitationFor(context, loopback) },
      loopback,
    )
    await vi.waitFor(() => expect(context.enrollments.status(view.id, loopback).status).toBe('approved'))
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(context.enrollments.complete(view.id, testDeviceKey().sign('x'), loopback)).rejects.toMatchObject({
        status: 401,
        code: 'invalid-signature',
      })
    }
    await expect(
      context.enrollments.complete(view.id, key.sign(enrollSigningText(hostId, view.id, view.nonce!)), loopback),
    ).rejects.toMatchObject({ status: 410 })
    expect(
      context
        .auditRecords()
        .filter(record => record.action === 'device.enroll.failed')
        .map(record => record.detail.reason),
    ).toEqual(['signature'])
  })

  it('reports denials and expiry, and cancels the local dialog', async () => {
    const context = await fixture({ presence: createTestPresence({ mode: 'manual' }) })
    const denied = await context.enrollments.create(
      { publicKey: testDeviceKey().spki, name: 'a', invitation: await invitationFor(context, loopback) },
      loopback,
    )
    await context.presence.waitForRequest()
    context.presence.denyNext()
    await vi.waitFor(() => expect(context.enrollments.status(denied.id, loopback).status).toBe('denied'))
    await expect(context.enrollments.complete(denied.id, 'x', loopback)).rejects.toMatchObject({
      status: 403,
      code: 'enrollment-denied',
      message: '本机拒绝了此设备',
    })

    const expired = await context.enrollments.create(
      { publicKey: testDeviceKey().spki, name: 'b', invitation: await invitationFor(context, loopback) },
      loopback,
    )
    await context.presence.waitForRequest()
    context.clock.now += 120_001
    expect(context.enrollments.status(expired.id, loopback).status).toBe('expired')
    await expect(context.enrollments.complete(expired.id, 'x', loopback)).rejects.toMatchObject({ status: 410, code: 'enrollment-expired' })

    const cancelled = await context.enrollments.create(
      { publicKey: testDeviceKey().spki, name: 'c', invitation: await invitationFor(context, loopback) },
      loopback,
    )
    await context.presence.waitForRequest()
    context.enrollments.cancel(cancelled.id, loopback)
    expect(context.enrollments.status(cancelled.id, loopback).status).toBe('cancelled')
    expect(() => context.presence.approveNext()).toThrow()
    await vi.waitFor(() =>
      expect(
        context
          .auditRecords()
          .filter(record => record.action === 'device.enroll.failed')
          .map(record => record.detail.reason),
      ).toEqual(['denied', 'expired', 'cancelled']),
    )
  })

  it('gives a device confirmed late in the 120 s a full minute to sign', async () => {
    const context = await fixture({ presence: createTestPresence({ mode: 'manual' }) })
    const key = testDeviceKey()
    const view = await context.enrollments.create(
      { publicKey: key.spki, name: 'late', invitation: await invitationFor(context, loopback) },
      loopback,
    )
    expect(Date.parse(view.expiresAt) - context.clock.now).toBe(120_000)
    await context.presence.waitForRequest()
    context.clock.now += 113_000
    context.presence.approveNext()
    await vi.waitFor(() => expect(context.enrollments.status(view.id, loopback).status).toBe('approved'))
    // The deadline the page polls moves to a minute after the approval.
    expect(Date.parse(context.enrollments.status(view.id, loopback).expiresAt) - context.clock.now).toBe(60_000)
    context.clock.now += 55_000
    const done = await context.enrollments.complete(view.id, key.sign(enrollSigningText(hostId, view.id, view.nonce!)), loopback)
    expect(done.device.name).toBe('late')
  })

  it('refuses elevated scopes off host.sock and grants all six on host.sock', async () => {
    const context = await fixture()
    for (const scope of ['approve:elevated', 'secrets'] as const) {
      await expect(
        context.enrollments.create({ publicKey: testDeviceKey().spki, name: 'x', scopes: ['view', scope] }, loopback),
      ).rejects.toMatchObject({ status: 400, code: 'scope-not-grantable', message: '该权限在此连接方式下不可授予' })
    }
    await expect(
      context.enrollments.create({ publicKey: testDeviceKey().spki, name: 'x', scopes: ['root' as DeviceScope] }, loopback),
    ).rejects.toMatchObject({ status: 400 })
    await expect(context.enrollments.create({ publicKey: 'bad', name: 'x' }, loopback)).rejects.toMatchObject({
      status: 400,
      code: 'invalid-public-key',
    })
    const desktop = await enroll(context, unix)
    expect(context.devices.get(desktop.id)).toMatchObject({
      listener: 'unix',
      scopes: ['view', 'run', 'approve:standard', 'approve:elevated', 'admin', 'secrets'],
      dataScope: 'all',
    })
    expect(context.presence.requests.at(-1)!.preview.lines.find(line => line.label === '来源地址')?.value).toBe('本机 host.sock')
  })

  it('keeps an invitation that a held-back enrollment could not use, so the same code works once the session ends', async () => {
    let holding: BlockingTask[] = []
    const context = await fixture({ blockingTasks: async () => holding })
    const desktop = await enroll(context, unix, { name: '桌面' })
    const invitation = await context.enrollments.createInvitation(
      { inviter: context.devices.get(desktop.id), listener: tls.listener, origin: tls.origin },
      actor,
    )
    holding = [{ id: 'ses_full', title: '修复设置页', harnessId: 'codex' }]
    const before = context.presence.requests.length
    // Held back before the invitation is spent; an anonymous requester learns nothing about the session.
    for (let attempt = 0; attempt < 2; attempt++) {
      const refused = context.enrollments.create({ publicKey: testDeviceKey().spki, name: '手机', invitation: invitation.code }, tls)
      await expect(refused).rejects.toMatchObject({ status: 409, code: 'presence-blocked', details: { action: 'device.enroll' } })
      await expect(refused).rejects.not.toMatchObject({ details: { blockingTasks: expect.anything() } })
    }
    // Without a valid invitation the refusal stays the invitation's, so nobody learns that a session runs.
    await expect(
      context.enrollments.create({ publicKey: testDeviceKey().spki, name: '手机', invitation: 'lpi1-AAAAAAAAAAAAAAAAAAAAAAAAAA' }, tls),
    ).rejects.toMatchObject({ code: 'invitation-invalid' })
    expect(context.presence.requests).toHaveLength(before)
    expect(
      context.auditRecords().some(record => record.action === 'device.enroll.requested' && record.detail.listener === 'tailnet-tls'),
    ).toBe(false)

    holding = []
    const phone = await enroll(context, tls, { invitation: invitation.code, name: '手机' })
    expect(context.devices.get(phone.id)).toMatchObject({ pairedBy: { method: 'invitation', deviceId: desktop.id } })
    await expect(
      context.enrollments.create({ publicKey: testDeviceKey().spki, name: '第二台', invitation: invitation.code }, tls),
    ).rejects.toMatchObject({ code: 'invitation-invalid' })
  })

  it('puts an invitation back when the confirmation is refused after it was spent, until its inviter is revoked', async () => {
    const presence = createTestPresence()
    const context = await fixture({ presence })
    const desktop = await enroll(context, unix, { name: '桌面' })
    const invitation = await context.enrollments.createInvitation(
      { inviter: context.devices.get(desktop.id), listener: tls.listener, origin: tls.origin },
      actor,
    )
    // Another enrollment holds the confirmation window: the phone is told it is busy, and keeps its code.
    presence.mode = 'manual'
    const waiting = await context.enrollments.create({ publicKey: testDeviceKey().spki, name: '另一台' }, unix)
    const phoneRequest = { publicKey: testDeviceKey().spki, name: '手机', invitation: invitation.code }
    await expect(context.enrollments.create(phoneRequest, tls)).rejects.toMatchObject({ code: 'presence-busy' })
    presence.approveNext()
    await vi.waitFor(() => expect(context.enrollments.status(waiting.id, unix).status).toBe('approved'))
    presence.mode = 'approve'
    let phone: Enrolled | undefined
    await vi.waitFor(async () => {
      phone = await enroll(context, tls, { invitation: invitation.code, name: '手机' })
    })
    expect(context.devices.get(phone!.id)?.listener).toBe('tailnet-tls')

    // A code put back still dies with its inviter.
    const second = await context.enrollments.createInvitation(
      { inviter: context.devices.get(desktop.id), listener: tls.listener, origin: tls.origin },
      actor,
    )
    presence.mode = 'manual'
    await context.enrollments.create({ publicKey: testDeviceKey().spki, name: '又一台' }, unix)
    const tablet = { publicKey: testDeviceKey().spki, name: '平板', invitation: second.code }
    await expect(context.enrollments.create(tablet, tls)).rejects.toMatchObject({ code: 'presence-busy' })
    await context.devices.revoke(desktop.id, 'manual', actor)
    await expect(context.enrollments.create(tablet, tls)).rejects.toMatchObject({ code: 'invitation-invalid' })
  })

  it('requires a single-use invitation on TLS listeners, capped to its scopes', async () => {
    const context = await fixture()
    const desktop = await enroll(context, unix, { name: '桌面' })
    expect(await context.enrollments.info(tls)).toEqual({
      hostId,
      listener: 'tailnet-tls',
      presence: { status: 'available' },
      invitationRequired: true,
      offlineCodeAccepted: false,
    })
    await expect(context.enrollments.create({ publicKey: testDeviceKey().spki, name: '手机' }, tls)).rejects.toMatchObject({
      status: 403,
      code: 'invitation-required',
    })
    await expect(
      context.enrollments.create({ publicKey: testDeviceKey().spki, name: '手机', invitation: 'lpi1-AAAAAAAAAAAAAAAAAAAAAAAAAA' }, tls),
    ).rejects.toMatchObject({ status: 403, code: 'invitation-invalid' })
    await expect(
      context.enrollments.createInvitation({ scopes: ['view', 'secrets'], listener: tls.listener, origin: tls.origin }, actor),
    ).rejects.toMatchObject({ code: 'scope-not-grantable' })
    await expect(context.enrollments.createInvitation({ listener: tls.listener, origin: '' }, actor)).rejects.toMatchObject({
      status: 409,
      code: 'tls-not-configured',
    })
    await expect(
      context.enrollments.createInvitation({ listener: tls.listener, origin: 'http://latch.example' }, actor),
    ).rejects.toMatchObject({ code: 'tls-not-configured' })

    const invitation = await context.enrollments.createInvitation(
      { inviter: context.devices.get(desktop.id), listener: tls.listener, origin: tls.origin },
      actor,
    )
    expect(invitation).toEqual({
      id: expect.stringMatching(/^inv_/u),
      code: expect.stringMatching(/^lpi1-[A-Z2-7]{26}$/u),
      url: `${tls.origin}/link/#pair=${invitation.code}`,
      scopes: ['view', 'run', 'approve:standard'],
      expiresAt: new Date(context.clock.now + 600_000).toISOString(),
    })
    await expect(
      context.enrollments.create(
        { publicKey: testDeviceKey().spki, name: '手机', invitation: invitation.code, scopes: ['view', 'admin'] },
        tls,
      ),
    ).rejects.toMatchObject({ status: 400, code: 'scope-not-grantable' })
    const phone = await enroll(context, tls, { invitation: invitation.code, name: '手机' })
    expect(context.devices.get(phone.id)).toMatchObject({
      listener: 'tailnet-tls',
      scopes: ['view', 'run', 'approve:standard'],
      pairedBy: { method: 'invitation', deviceId: desktop.id },
    })
    expect(context.presence.requests.at(-1)!.preview.lines.at(-1)).toEqual({ label: '邀请来源', value: '桌面' })
    await expect(
      context.enrollments.create({ publicKey: testDeviceKey().spki, name: '第二台', invitation: invitation.code }, tls),
    ).rejects.toMatchObject({ code: 'invitation-invalid' })
    expect(context.auditRecords().find(record => record.action === 'pairing.invited')?.detail).toEqual({
      invitationId: invitation.id,
      scopes: ['view', 'run', 'approve:standard'],
      listener: 'tailnet-tls',
    })
    expect(readFileSync(join(context.dataDir, 'audit', 'audit.jsonl'), 'utf8')).not.toContain(invitation.code)

    const expiring = await context.enrollments.createInvitation({ listener: tls.listener, origin: tls.origin }, actor)
    context.clock.now += 600_001
    await expect(
      context.enrollments.create({ publicKey: testDeviceKey().spki, name: '手机', invitation: expiring.code }, tls),
    ).rejects.toMatchObject({ code: 'invitation-invalid' })

    // An invitation dies with its inviter.
    const orphan = await context.enrollments.createInvitation(
      { inviter: context.devices.get(desktop.id), listener: tls.listener, origin: tls.origin },
      actor,
    )
    await context.devices.revoke(desktop.id, 'manual', actor)
    await expect(
      context.enrollments.create({ publicKey: testDeviceKey().spki, name: '手机', invitation: orphan.code }, tls),
    ).rejects.toMatchObject({ code: 'invitation-invalid' })
  })

  it('spends an invitation only once its confirmation window was shown', async () => {
    const context = await fixture({ presence: createTestPresence({ mode: 'manual' }) })
    // A request on host.sock holds the window, so the browser's request is refused before anything is shown.
    const desktop = await context.enrollments.create({ publicKey: testDeviceKey().spki, name: '桌面' }, unix)
    await context.presence.waitForRequest()
    const code = await invitationFor(context, loopback)
    const submit = () => context.enrollments.create({ publicKey: testDeviceKey().spki, name: '浏览器', invitation: code }, loopback)
    await expect(submit()).rejects.toMatchObject({ status: 409, code: 'presence-busy' })
    expect(context.presence.requests).toHaveLength(1)
    context.presence.denyNext()
    await vi.waitFor(() => expect(context.enrollments.status(desktop.id, unix).status).toBe('denied'))

    // The same link works once the window is free, and is spent by the window it shows, whatever the answer.
    await expect(submit()).resolves.toMatchObject({ status: 'pending' })
    expect((await context.presence.waitForRequest()).preview.requester).toMatchObject({ listener: 'loopback-tcp' })
    context.presence.denyNext()
    await expect(submit()).rejects.toMatchObject({ status: 403, code: 'invitation-invalid' })
    expect(context.presence.requests).toHaveLength(2)
  })

  it('accepts a one-time offline code on host.sock only, and never uses it up elsewhere', async () => {
    const context = await fixture({ presence: createTestPresence({ mode: 'unavailable' }) })
    const ticket = await createOfflineTicket(context.authDir, { now: () => context.clock.now })
    expect(ticket).toEqual({
      code: expect.stringMatching(/^lpo1-[A-Z2-7]{26}$/u),
      expiresAt: context.clock.now + 15 * 60_000,
      ticketId: expect.stringMatching(/^chl_/u),
    })
    expect(statSync(join(context.authDir, 'offline-enrollments.json')).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(context.authDir, 'offline-enrollments.json'), 'utf8')).not.toContain(ticket.code)
    expect(await context.enrollments.info(unix)).toMatchObject({
      presence: { status: 'unavailable', message: '测试中的本机确认不可用' },
      offlineCodeAccepted: true,
    })
    await expect(context.enrollments.create({ publicKey: testDeviceKey().spki, name: 'x' }, unix)).rejects.toMatchObject({
      status: 503,
      code: 'presence-unavailable',
    })
    // A valid code is refused off host.sock and stays usable: the loopback port may be forwarded from another computer.
    for (const connection of [loopback, tls]) {
      expect((await context.enrollments.info(connection)).offlineCodeAccepted).toBe(false)
      await expect(
        context.enrollments.create({ publicKey: testDeviceKey().spki, name: 'x', offlineCode: ticket.code }, connection),
      ).rejects.toMatchObject({ status: 403, code: 'offline-code-invalid' })
    }
    await expect(
      context.enrollments.create({ publicKey: testDeviceKey().spki, name: 'x', offlineCode: 'lpo1-AAAAAAAAAAAAAAAAAAAAAAAAAA' }, unix),
    ).rejects.toMatchObject({ code: 'offline-code-invalid', message: '离线登记码无效或已过期' })

    const key = testDeviceKey()
    const view = await context.enrollments.create({ publicKey: key.spki, name: '桌面', offlineCode: ticket.code, scopes: ['view'] }, unix)
    expect(view.status).toBe('approved')
    const result = await context.enrollments.complete(view.id, key.sign(enrollSigningText(hostId, view.id, view.nonce!)), unix)
    expect(result.device).toMatchObject({
      scopes: ['view', 'run', 'approve:standard', 'approve:elevated', 'admin', 'secrets'],
      dataScope: 'all',
      pairedBy: { method: 'offline' },
    })
    await expect(
      context.enrollments.create({ publicKey: testDeviceKey().spki, name: 'again', offlineCode: ticket.code }, unix),
    ).rejects.toMatchObject({ code: 'offline-code-invalid' })
    const records = context.auditRecords()
    expect(records.filter(record => record.action === 'offline.ticket.consumed')).toEqual([
      expect.objectContaining({ stepup: 'offline', detail: { ticketId: ticket.ticketId } }),
    ])
    expect(records.find(record => record.action === 'device.enrolled')).toMatchObject({ stepup: 'offline', detail: { method: 'offline' } })

    const late = await createOfflineTicket(context.authDir, { now: () => context.clock.now })
    context.clock.now += 15 * 60_000 + 1
    await expect(
      context.enrollments.create({ publicKey: testDeviceKey().spki, name: 'late', offlineCode: late.code }, unix),
    ).rejects.toMatchObject({ code: 'offline-code-invalid' })
    expect((await context.enrollments.info(unix)).offlineCodeAccepted).toBe(false)
  })

  it('refuses the enrollment when the audit log cannot record it', async () => {
    const context = await fixture()
    const auditFile = join(context.dataDir, 'audit', 'audit.jsonl')
    await context.audit.close()
    const broken = await AuditLog.open(join(context.dataDir, 'audit'), {
      fs: {
        async open(path) {
          const handle = await open(path, 'a', 0o600)
          return {
            write: data => handle.write(data),
            sync: async () => {
              throw new Error('EIO')
            },
            truncate: () => Promise.reject(new Error('EIO')),
            close: () => handle.close(),
          }
        },
      },
    })
    cleanups.push(() => broken.close())
    const devices = await DeviceStore.open({ directory: context.authDir, hostId, audit: broken, now: () => context.clock.now })
    const service = new PresenceService({
      backend: createTestPresence(),
      hostId,
      audit: broken,
      now: () => context.clock.now,
      blockingTasks: async () => [],
    })
    const enrollments = new EnrollmentService({
      hostId,
      devices,
      presence: service,
      audit: broken,
      directory: context.authDir,
      now: () => context.clock.now,
    })
    await expect(enrollments.create({ publicKey: testDeviceKey().spki, name: 'x' }, unix)).rejects.toMatchObject({
      status: 503,
      code: 'audit-unavailable',
    })
    expect(existsSync(auditFile)).toBe(true)
  })
})

/** An audit seam whose fsync after a write fails while `failing` is set; the cut-back succeeds, so the log recovers. */
function switchableAudit(): { fs: AuditFs; state: { failing: boolean } } {
  const state = { failing: false }
  const fs: AuditFs = {
    async open(path) {
      const handle = await open(path, 'a', 0o600)
      let written = false
      return {
        write: data => {
          written = true
          return handle.write(data)
        },
        sync: async () => {
          const afterWrite = written
          written = false
          if (state.failing && afterWrite) throw Object.assign(new Error('EIO'), { code: 'EIO' })
          await handle.sync()
        },
        truncate: length => handle.truncate(length),
        close: () => handle.close(),
      }
    },
  }
  return { fs, state }
}

const devicesFile = (context: Fixture) =>
  JSON.parse(readFileSync(join(context.authDir, 'devices.json'), 'utf8')) as { devices: Array<Record<string, unknown>> }

describe('event stream credentials', () => {
  it('allows a stream only while its credential is current and not due for renewal, or inside the rotation grace', async () => {
    const context = await fixture()
    const device = await enroll(context, loopback)
    const hash = sha256Hex(device.credential)
    const outcome = await context.devices.authenticate(presented(device), loopback)
    expect(outcome.ok && outcome.credentialHash).toBe(hash)
    expect(context.devices.streamAllowed(device.id, hash)).toBe(true)
    expect(context.devices.streamAllowed(device.id, sha256Hex('ldc1.other'))).toBe(false)
    expect(context.devices.streamAllowed(device.id, 'not-hex')).toBe(false)
    expect(context.devices.streamAllowed(`dev_${'Z'.repeat(22)}`, hash)).toBe(false)

    // Past the renewal deadline a stream opened with this credential ends.
    context.clock.now += RENEW_INTERVAL + 1
    expect(context.devices.streamAllowed(device.id, hash)).toBe(false)
    const renewed = await renew(context, device)
    const fresh = sha256Hex(renewed.credential)
    // A renewed credential carries streams once it has been used.
    expect(context.devices.streamAllowed(device.id, fresh)).toBe(false)
    expect((await context.devices.authenticate(presented(renewed), loopback)).ok).toBe(true)
    expect(context.devices.streamAllowed(device.id, fresh)).toBe(true)
    expect(context.devices.streamAllowed(device.id, hash)).toBe(true)
    context.clock.now += ROTATION_GRACE + 1
    expect(context.devices.streamAllowed(device.id, hash)).toBe(false)
    // Checking a stream never counts as presenting the old credential.
    expect(context.devices.get(device.id)?.status).toBe('active')
    expect((await context.devices.authenticate(presented(renewed), loopback)).ok).toBe(true)

    await context.devices.revoke(device.id, 'manual', actor)
    expect(context.devices.streamAllowed(device.id, fresh)).toBe(false)

    const other = await enroll(context, loopback)
    context.clock.now = Date.UTC(2026, 9, 23, 10) + CREDENTIAL_LIFETIME + 1
    expect(context.devices.streamAllowed(other.id, sha256Hex(other.credential))).toBe(false)
  })
})

describe('revocation durability', () => {
  async function invitedPhone(context: Fixture) {
    const desktop = await enroll(context, unix, { name: '桌面' })
    const scopes: DeviceScope[] = ['view', 'run', 'approve:standard', 'admin']
    const invitation = await context.enrollments.createInvitation(
      { inviter: context.devices.get(desktop.id), scopes, listener: tls.listener, origin: tls.origin },
      actor,
    )
    const phone = await enroll(context, tls, { invitation: invitation.code, scopes, name: '手机' })
    return { desktop, phone }
  }

  it('derives the cascade again on open when devices.json missed the revocation', async () => {
    let failRename = false
    const fs: DeviceFs = {
      open: (path, flags, mode) => open(path, flags, mode),
      rename: async (from, to) => {
        if (failRename) throw Object.assign(new Error('crash'), { code: 'EIO' })
        await rename(from, to)
      },
    }
    const context = await fixture({ fs })
    const { desktop, phone } = await invitedPhone(context)
    failRename = true
    expect((await context.devices.revoke(desktop.id, 'manual', actor)).cascaded).toEqual([phone.id])
    expect(devicesFile(context).devices.find(device => device.id === phone.id)).toMatchObject({ status: 'active' })

    const reopened = await context.reopen()
    expect(reopened.get(desktop.id)).toMatchObject({ status: 'revoked' })
    expect(reopened.get(phone.id)).toMatchObject({ status: 'review', scopes: ['view'] })
    expect(await reopened.authenticate(presented(phone), tls)).toMatchObject({ ok: true, device: { status: 'review', scopes: ['view'] } })
    expect(devicesFile(context).devices.find(device => device.id === phone.id)).toMatchObject({
      status: 'review',
      scopes: ['view'],
      scopesBeforeReview: ['view', 'run', 'approve:standard', 'admin'],
    })
    expect(
      context
        .auditRecords()
        .filter(record => record.action === 'device.review')
        .map(record => [record.detail, record.actor]),
    ).toEqual([
      [{ deviceId: phone.id, causeDeviceId: desktop.id }, actor],
      [
        { deviceId: phone.id, causeDeviceId: desktop.id },
        { listener: 'host', via: 'startup' },
      ],
    ])
  })

  it('applies the cascade over a restored backup, and keeps devices an admin restored afterwards', async () => {
    const context = await fixture()
    const { desktop, phone } = await invitedPhone(context)
    const path = join(context.authDir, 'devices.json')
    const backup = readFileSync(path, 'utf8')
    await context.devices.revoke(desktop.id, 'manual', actor)
    writeFileSync(path, backup)
    let reopened = await context.reopen()
    expect(reopened.get(desktop.id)?.status).toBe('revoked')
    expect(reopened.get(phone.id)).toMatchObject({ status: 'review', scopes: ['view'] })
    expect(await reopened.authenticate(presented(phone), tls)).toMatchObject({ ok: true, device: { scopes: ['view'] } })

    expect(await reopened.setScopes(phone.id, { scopes: ['view', 'run'] }, actor, 'lpc-local')).toMatchObject({
      status: 'active',
      scopes: ['view', 'run'],
    })
    reopened = await context.reopen()
    expect(reopened.get(phone.id)).toMatchObject({ status: 'active', scopes: ['view', 'run'] })
  })

  it('cancels the enrollments and invitations of a revoked inviter', async () => {
    const context = await fixture()
    const desktop = await enroll(context, unix, { name: '桌面' })
    const inviter = context.devices.get(desktop.id)
    const scopes: DeviceScope[] = ['view', 'run', 'approve:standard', 'admin']
    const used = await context.enrollments.createInvitation({ inviter, scopes, listener: tls.listener, origin: tls.origin }, actor)
    const unused = await context.enrollments.createInvitation({ inviter, listener: tls.listener, origin: tls.origin }, actor)
    const key = testDeviceKey()
    const view = await context.enrollments.create({ publicKey: key.spki, name: '手机', invitation: used.code, scopes }, tls)
    await vi.waitFor(() => expect(context.enrollments.status(view.id, tls).status).toBe('approved'))

    expect((await context.devices.revoke(desktop.id, 'manual', actor)).cascaded).toEqual([])
    expect(context.enrollments.status(view.id, tls).status).toBe('cancelled')
    await expect(
      context.enrollments.complete(view.id, key.sign(enrollSigningText(hostId, view.id, view.nonce!)), tls),
    ).rejects.toMatchObject({ status: 410, code: 'enrollment-cancelled' })
    await expect(
      context.enrollments.create({ publicKey: testDeviceKey().spki, name: '手机', invitation: unused.code }, tls),
    ).rejects.toMatchObject({ code: 'invitation-invalid' })
    expect(context.devices.list().filter(device => device.listener === 'tailnet-tls')).toEqual([])
    await vi.waitFor(() =>
      expect(
        context
          .auditRecords()
          .filter(record => record.action === 'device.enroll.failed')
          .map(record => record.detail.reason),
      ).toEqual(['cancelled']),
    )
  })

  it('closes the local dialog of a pending enrollment when its inviter is revoked', async () => {
    const context = await fixture({ presence: createTestPresence({ mode: 'manual' }) })
    const ticket = await createOfflineTicket(context.authDir, { now: () => context.clock.now })
    const desktop = await enroll(context, unix, { offlineCode: ticket.code })
    const invitation = await context.enrollments.createInvitation(
      { inviter: context.devices.get(desktop.id), listener: tls.listener, origin: tls.origin },
      actor,
    )
    const view = await context.enrollments.create({ publicKey: testDeviceKey().spki, name: '手机', invitation: invitation.code }, tls)
    await context.presence.waitForRequest()
    await context.devices.revoke(desktop.id, 'manual', actor)
    expect(context.enrollments.status(view.id, tls).status).toBe('cancelled')
    expect(() => context.presence.approveNext()).toThrow()
  })

  it('refuses to create a device paired by an inviter that is no longer active', async () => {
    const context = await fixture()
    const desktop = await enroll(context, unix)
    await context.devices.revoke(desktop.id, 'manual', actor)
    const input = (deviceId: string) => ({
      name: '手机',
      connection: tls,
      publicKeyDer: Buffer.from(testDeviceKey().spki, 'base64url'),
      scopes: ['view'] as DeviceScope[],
      dataScope: 'work' as const,
      pairedBy: { method: 'invitation' as const, deviceId },
      enrollmentId: `enr_${'A'.repeat(22)}`,
    })
    const enrolled = { listener: 'tailnet-tls' as const, via: 'http' as const }
    await expect(context.devices.create(input(desktop.id), enrolled, 'lpc-local')).rejects.toMatchObject({
      status: 403,
      code: 'invitation-invalid',
    })
    await expect(context.devices.create(input(`dev_${'Q'.repeat(22)}`), enrolled, 'lpc-local')).rejects.toMatchObject({
      status: 403,
      code: 'invitation-invalid',
    })
    expect(context.devices.list().filter(device => device.listener === 'tailnet-tls')).toEqual([])
  })
})

describe('revocation log repair', () => {
  it('moves an unparsable torn tail aside, so the next revocation keeps the Host startable', async () => {
    const context = await fixture()
    const first = await enroll(context, loopback)
    const second = await enroll(context, loopback)
    await context.devices.revoke(first.id, 'manual', actor)
    const log = join(context.authDir, 'revocations.jsonl')
    const acknowledged = readFileSync(log, 'utf8')
    const fragment = '{"at":1,"devic'
    writeFileSync(log, `${acknowledged}${fragment}`)

    const reopened = await context.reopen()
    expect(readFileSync(log, 'utf8')).toBe(acknowledged)
    const torn = join(context.authDir, `revocations.jsonl.torn-${context.clock.now}`)
    expect(readFileSync(torn, 'utf8')).toBe(fragment)
    expect(statSync(torn).mode & 0o777).toBe(0o600)
    expect(
      context
        .auditRecords()
        .filter(record => record.action === 'device.revocations.torn-tail-removed')
        .map(record => record.detail),
    ).toEqual([{ bytes: fragment.length }])

    await reopened.revoke(second.id, 'manual', actor)
    const again = await context.reopen()
    expect(again.get(first.id)?.status).toBe('revoked')
    expect(again.get(second.id)?.status).toBe('revoked')
  })

  it('keeps and terminates a torn last line that still parses', async () => {
    const context = await fixture()
    const first = await enroll(context, loopback)
    const second = await enroll(context, loopback)
    const log = join(context.authDir, 'revocations.jsonl')
    const line = JSON.stringify({ at: context.clock.now, deviceId: first.id, reason: 'manual' })
    writeFileSync(log, line, { mode: 0o600 })
    const reopened = await context.reopen()
    expect(reopened.get(first.id)).toMatchObject({ status: 'revoked', revokedReason: 'manual' })
    expect(readFileSync(log, 'utf8')).toBe(`${line}\n`)
    await reopened.revoke(second.id, 'manual', actor)
    expect((await context.reopen()).get(second.id)?.status).toBe('revoked')
    expect(
      readFileSync(log, 'utf8')
        .trimEnd()
        .split('\n')
        .map(item => JSON.parse(item).deviceId),
    ).toEqual([first.id, second.id])
  })

  it('cuts a short revocation append off again instead of leaving a fragment behind', async () => {
    const mode = { short: false, failTruncate: false }
    const fs: DeviceFs = {
      async open(path, flags, fileMode) {
        const handle = await open(path, flags, fileMode)
        if (!path.endsWith('revocations.jsonl') || flags !== 'a') return handle
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'write' && mode.short) {
              return async (data: Buffer) => {
                const part = data.subarray(0, 10)
                await target.write(part)
                return { bytesWritten: part.length, buffer: data }
              }
            }
            if (property === 'truncate' && mode.failTruncate)
              return async () => {
                throw Object.assign(new Error('EIO'), { code: 'EIO' })
              }
            const value = Reflect.get(target, property, target) as unknown
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
      },
      rename,
    }
    const context = await fixture({ fs })
    const devices = await Promise.all([enroll(context, loopback), enroll(context, loopback), enroll(context, loopback)])
    const log = join(context.authDir, 'revocations.jsonl')

    mode.short = true
    // The log append fails, devices.json still records the revocation.
    await context.devices.revoke(devices[0]!.id, 'manual', actor)
    expect(existsSync(log) ? readFileSync(log, 'utf8') : '').toBe('')

    // When the cut-back fails too, the fragment is repaired before the next append.
    mode.failTruncate = true
    await context.devices.revoke(devices[1]!.id, 'manual', actor)
    expect(readFileSync(log, 'utf8')).not.toMatch(/\n$/u)
    mode.short = false
    mode.failTruncate = false
    await context.devices.revoke(devices[2]!.id, 'manual', actor)
    expect(
      readFileSync(log, 'utf8')
        .trimEnd()
        .split('\n')
        .map(item => JSON.parse(item).deviceId),
    ).toEqual([devices[2]!.id])

    const reopened = await context.reopen()
    for (const device of devices) expect(reopened.get(device.id)?.status).toBe('revoked')
  })
})

describe('privilege-reducing changes and the audit log', () => {
  it('applies a pure scope reduction while the audit log fails, and still refuses raising', async () => {
    const audit = switchableAudit()
    const context = await fixture({ auditFs: audit.fs })
    const browser = await enroll(context, loopback, { scopes: ['view', 'run', 'approve:standard', 'admin'] })
    audit.state.failing = true
    await expect(context.devices.changeScopes(browser.id, { scopes: ['view', 'run'] }, actor, 'none')).resolves.toMatchObject({
      audited: false,
      device: { scopes: ['view', 'run'] },
    })
    expect(devicesFile(context).devices.find(device => device.id === browser.id)).toMatchObject({ scopes: ['view', 'run'] })
    await expect(context.devices.setScopes(browser.id, { scopes: ['view', 'run', 'admin'] }, actor, 'lpc-local')).rejects.toMatchObject({
      status: 503,
      code: 'audit-unavailable',
    })
    await expect(context.devices.setScopes(browser.id, { dataScope: 'all' }, actor, 'lpc-local')).rejects.toMatchObject({
      status: 503,
      code: 'audit-unavailable',
    })
    expect(context.devices.get(browser.id)).toMatchObject({ scopes: ['view', 'run'], dataScope: 'work' })

    audit.state.failing = false
    await expect(context.devices.changeScopes(browser.id, { scopes: ['view'] }, actor, 'none')).resolves.toMatchObject({
      audited: true,
      device: { scopes: ['view'] },
    })
    expect(
      context
        .auditRecords()
        .filter(record => record.action === 'device.scopes.changed')
        .map(record => record.detail.removed),
    ).toEqual([['run']])
  })
})

describe('device names', () => {
  it('refuses names the confirmation dialog would have to escape', async () => {
    const context = await fixture()
    for (const name of ['手机 工作目录：/Users/me', 'a‮b', 'x​y', 'tag\u{E0041}', 'soft­hyphen', `e${'́'.repeat(5)}`]) {
      await expect(context.enrollments.create({ publicKey: testDeviceKey().spki, name }, loopback)).rejects.toMatchObject({
        status: 400,
        code: 'invalid-device-name',
        message: '设备名称不能包含控制字符或不可见字符',
      })
    }
    const device = await enroll(context, loopback, { name: 'Zoë 的 iPhone' })
    await expect(context.devices.rename(device.id, '书房 目标路径', actor)).rejects.toMatchObject({ code: 'invalid-device-name' })
  })

  it('accepts emoji names whose joiners and presentation selectors are part of the emoji', async () => {
    const context = await fixture()
    for (const name of ['❤️ iPhone', '👨‍💻 Mac', '1️⃣ 号机']) {
      const device = await enroll(context, loopback, { name })
      expect(context.devices.get(device.id)?.name).toBe(name)
      expect(context.presence.requests.at(-1)!.preview.requester.deviceName).toBe(name)
    }
    for (const name of ['a‍b', '👨‍‍💻', 'x️', '#️', ' iPhone\n']) {
      await expect(context.enrollments.create({ publicKey: testDeviceKey().spki, name }, loopback)).rejects.toMatchObject({
        code: 'invalid-device-name',
      })
    }
  })

  it('replaces a migrated name that cannot be shown before the takeover is confirmed', async () => {
    const dataDir = tempDir()
    const authDir = join(dataDir, 'auth')
    mkdirSync(authDir, { recursive: true, mode: 0o700 })
    writeFileSync(
      join(authDir, 'devices.json'),
      JSON.stringify({
        version: 1,
        devices: [
          {
            id: 'a2c4e6a8-0000-4000-8000-000000000001',
            name: '书房 工作目录：/',
            role: 'owner',
            revoked: false,
            tokenHash: createHash('sha256').update('owner-token-value').digest('hex'),
            expiresAt: Date.UTC(2026, 9, 23, 10) + 86_400_000,
            createdAt: '2026-01-01T00:00:00.000Z',
            lastSeenAt: '2026-01-02T00:00:00.000Z',
          },
        ],
      }),
      { mode: 0o600 },
    )
    const context = await fixture({ dataDir })
    expect(await context.devices.authenticate({ kind: 'legacy-cookie', value: 'owner-token-value' }, loopback)).toEqual({
      ok: false,
      code: 'legacy-reconfirm',
      legacyName: '未命名设备',
    })
    const key = testDeviceKey()
    const invitation = await invitationFor(context, loopback)
    const view = await context.enrollments.create({ publicKey: key.spki, name: '', invitation }, loopback, {
      kind: 'legacy-cookie',
      value: 'owner-token-value',
    })
    expect(context.presence.requests[0]!.preview.lines[0]).toEqual({ label: '设备名称', value: '未命名设备' })
    await vi.waitFor(() => expect(context.enrollments.status(view.id, loopback).status).toBe('approved'))
    const result = await context.enrollments.complete(view.id, key.sign(enrollSigningText(hostId, view.id, view.nonce!)), loopback)
    expect(result.device.name).toBe('未命名设备')
  })
})

describe('scope changes against a confirmed base', () => {
  it('applies a change only while the device still has the base the confirmation showed', async () => {
    const context = await fixture()
    const browser = await enroll(context, loopback, { scopes: ['view', 'run', 'approve:standard', 'admin'] })
    const base = {
      scopes: ['view', 'run', 'approve:standard', 'admin'] as DeviceScope[],
      dataScope: 'work' as const,
      status: 'active' as const,
    }
    const changed = expect.objectContaining({ status: 409, code: 'device-changed', message: '设备权限已被修改，请刷新后重试' })
    for (const stale of [
      { ...base, scopes: ['view', 'run', 'approve:standard'] as DeviceScope[] },
      { ...base, scopes: ['view', 'run', 'approve:standard', 'admin', 'admin'] as DeviceScope[] },
      { ...base, dataScope: 'all' as const },
      { ...base, status: 'review' as const },
    ]) {
      await expect(context.devices.changeScopes(browser.id, { scopes: ['view', 'run'] }, actor, 'lpc-local', stale)).rejects.toEqual(
        changed,
      )
    }
    expect(context.devices.get(browser.id)).toMatchObject({ scopes: base.scopes })

    // Two changes confirmed against the same base: the queue applies the first, and the second no longer matches.
    const [first, second] = await Promise.allSettled([
      context.devices.changeScopes(browser.id, { scopes: ['view', 'run'] }, actor, 'none', base),
      context.devices.changeScopes(
        browser.id,
        { scopes: ['view', 'run', 'approve:standard', 'admin'], dataScope: 'all' },
        actor,
        'lpc-local',
        { ...base, scopes: [...base.scopes].reverse() },
      ),
    ])
    expect(first).toMatchObject({ status: 'fulfilled', value: { audited: true, device: { scopes: ['view', 'run'] } } })
    expect(second).toMatchObject({ status: 'rejected', reason: changed })
    expect(context.devices.get(browser.id)).toMatchObject({ scopes: ['view', 'run'], dataScope: 'work' })
    await expect(
      context.devices.setScopes(browser.id, { scopes: ['view'] }, actor, 'none', {
        scopes: ['run', 'view'],
        dataScope: 'work',
        status: 'active',
      }),
    ).resolves.toMatchObject({ scopes: ['view'] })
  })
})
