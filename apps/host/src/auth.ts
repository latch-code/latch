import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, open as openFile, readFile, rename as renameFile, stat, unlink, writeFile, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  isAcceptableDeviceName,
  isLocalListener,
  isNativeListener,
  LISTENER_CLASSES,
  LISTENER_LABELS,
  SCOPE_LABELS,
  type DataScope,
  type Device,
  type DeviceScope,
  type DeviceStatus,
  type EnrollmentInfo,
  type EnrollmentInvitationOffer,
  type EnrollmentView,
  type WaitingEnrollmentView,
  type InvitationView,
  type ListenerClass,
  type NativePairingStatus,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { sha256Hex, syncDirectory, writeFileAtomic } from '@latch/core/node-kit'
import { isSocketTransport } from './access.ts'
import type { AuditActor, AuditLog, StepupMethod } from './audit.ts'
import { constantTimeEqualHex, deviceFingerprint, parseP256Spki, randomCode, randomId, randomNonce, verifyP256 } from './crypto.ts'
import { enrollmentSubject, paramsHash, type PresenceService } from './presence.ts'
import { validateNativeIdentity, type NativeIdentityInput, type NativeRegistrationIdentity } from './native-identity.ts'
import { nativeKnockSecret } from '@latch/link-wire'
import { nodeCrypto } from '@latch/link-client/crypto'

export const CREDENTIAL_LIFETIME = 30 * 24 * 60 * 60_000
export const RENEW_INTERVAL = 24 * 60 * 60_000
/** How long a replaced credential is still accepted (except for renewal) after its successor was first used. */
export const ROTATION_GRACE = 60_000
/** A renewed credential that is never presented is dropped after this long. */
export const PENDING_LIFETIME = 10 * 60_000
export const CHALLENGE_TTL = 60_000
/** A nonce for one signed folder add from the desktop app. */
export const FOLDER_GRANT_TTL = 60_000
const MAX_FOLDER_GRANTS = 4
export const LAST_SEEN_PERSIST = 5 * 60_000
const PRUNE_AFTER = 90 * 24 * 60 * 60_000
/** Time to confirm an enrollment: the local confirmation's own lifetime, so the page counts down to the sheet closing. */
export const ENROLLMENT_LIFETIME = 120_000
/** Once confirmed, the new device has at least this long to sign, however late in the 120 s the person touched the sensor. */
export const ENROLLMENT_SIGNING_WINDOW = 60_000
export const INVITATION_LIFETIME = 10 * 60_000
/** A pairing QR's life; the Mac's sheet shows a fresh one every minute, so at most two are live. */
export const NATIVE_INVITATION_LIFETIME = 120_000
const MAX_NATIVE_INVITATIONS = 2
const NATIVE_SHEET_MEMORY = 5 * 60_000
/** The sheet asks every second; this much silence means the window closed or the app quit. */
const NATIVE_SHEET_SILENCE = 8_000
/** A device enrolled from a QR is removed if another device presents that QR within this long. */
export const NATIVE_CONTENTION_WINDOW = 120_000
/** How long a removed phone that has not read its tombstone keeps the Mac reachable for it. */
const TOMBSTONE_DELIVERY_WINDOW = 7 * 24 * 60 * 60_000
export const OFFLINE_TICKET_LIFETIME = 15 * 60_000
const MAX_PENDING_ENROLLMENTS = 32
const MAX_INVITATIONS = 32
const MAX_OFFLINE_TICKETS = 8
const SIGNATURE_ATTEMPTS = 3

/**
 * What the desktop app's main process signs to add folders: the Host, the device, a nonce from
 * `POST /folder-grants`, and the SHA-256 (hex) of `canonicalJson` of the request body without `signature`.
 */
export function foldersSigningText(hostId: string, deviceId: string, nonce: string, bodyHash: string): string {
  return `latch-folders-v1\n${hostId}\n${deviceId}\n${nonce}\n${bodyHash}`
}

export const ALL_SCOPES: readonly DeviceScope[] = ['view', 'run', 'approve:standard', 'approve:elevated', 'admin', 'secrets']
/** Key entry stays on the desktop app for now; this one scope is what a device on another listener cannot hold. */
export const UNIX_ONLY_SCOPES: readonly DeviceScope[] = ['secrets']
const DEFAULT_REMOTE_SCOPES: readonly DeviceScope[] = ['view', 'run', 'approve:standard', 'approve:elevated']
/** What pairing a phone on the Mac's own network grants; there is no choice to make and nothing to grant later. */
const NATIVE_PAIRED_SCOPES: readonly DeviceScope[] = ['view', 'run', 'approve:standard', 'approve:elevated']
const INVITABLE_SCOPES: readonly DeviceScope[] = ['view', 'run', 'approve:standard', 'approve:elevated', 'admin']
/** Name used when a migrated record's name cannot be shown in a confirmation dialog. */
const DEFAULT_DEVICE_NAME = '未命名设备'
/** The confirmation sheet's device slot (`presence-reason.ts`): a number added to a name must fit inside it. */
const SHEET_NAME_GRAPHEMES = 20
const NAME_GRAPHEMES = new Intl.Segmenter('und', { granularity: 'grapheme' })

const DEVICES_FILE = 'devices.json'
const REVOCATIONS_FILE = 'revocations.jsonl'
const OFFLINE_FILE = 'offline-enrollments.json'
const LEGACY_TOKEN_FILE = 'owner-token'

const hex64 = z.string().regex(/^[0-9a-f]{64}$/u)
const scopeEnum = z.enum(['view', 'run', 'approve:standard', 'approve:elevated', 'admin', 'secrets'])
const deviceIdSchema = z.string().regex(/^dev_[A-Za-z0-9_-]{22}$/u)
const revokedReason = z.enum(['manual', 'self', 'replay', 'cascade', 'migration'])

const storedDevice = z.strictObject({
  id: deviceIdSchema,
  name: z.string().min(1).max(80),
  status: z.enum(['active', 'review', 'revoked', 'legacy-pending']),
  listener: z.enum(LISTENER_CLASSES),
  /** 'unix:' | 'http://h-<hostId>.localhost:<port>' | the TLS public origin; '' for legacy-pending. */
  origin: z.string().max(300),
  /** base64url SPKI DER; '' for legacy-pending. */
  publicKey: z.string(),
  fingerprint: z.string(),
  scopes: z.array(scopeEnum).max(6),
  scopesBeforeReview: z.array(scopeEnum).optional(),
  dataScope: z.enum(['work', 'all']),
  pairedBy: z.strictObject({
    method: z.enum(['lpc', 'offline', 'invitation', 'migration']),
    deviceId: z.string().optional(),
    invitationId: z.string().optional(),
  }),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  /** Epoch ms: enrollment + 30 days, never extended. */
  credentialExpiresAt: z.number(),
  credential: z.strictObject({ hash: hex64, rotatedAt: z.number() }).nullable(),
  previous: z.array(z.strictObject({ hash: hex64, rotatedAt: z.number(), graceUntil: z.number() })).max(4),
  /** A renewed credential not used yet: it becomes current when first presented. */
  pending: z.strictObject({ hash: hex64, issuedAt: z.number() }).optional(),
  legacyTokenHash: hex64.optional(),
  native: z
    .strictObject({
      certificate: z.string().max(8192),
      verificationKey: z.string().max(256),
      lastVerifiedAt: z.number().int().nonnegative(),
      knockHash: hex64,
      revocationAcknowledgedAt: z.number().int().nonnegative().optional(),
    })
    .optional(),
  revokedAt: z.number().optional(),
  revokedReason: revokedReason.optional(),
})
type StoredDevice = z.infer<typeof storedDevice>
const devicesFile = z.strictObject({
  version: z.literal(2),
  hostId: z.string(),
  devices: z.array(storedDevice).max(1000),
  /** Set once any device record has existed and never cleared: pruning old records does not make this a new Host again. */
  enrolled: z.literal(true).optional(),
  /** Read once from files written while the global input pause existed, then dropped (see `load`). */
  nativeInputsPaused: z.boolean().optional(),
})
type DevicesFile = z.infer<typeof devicesFile>

const legacyFile = z.object({
  version: z.literal(1),
  devices: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      role: z.enum(['owner', 'controller']),
      createdAt: z.string(),
      lastSeenAt: z.string(),
      revoked: z.boolean(),
      tokenHash: z.string(),
      expiresAt: z.number(),
    }),
  ),
  pairings: z.array(z.unknown()).optional(),
})

const revocationLine = z.strictObject({ at: z.number().int(), deviceId: deviceIdSchema, reason: revokedReason })
type RevocationLine = z.infer<typeof revocationLine>

function parseRevocation(bytes: Buffer): RevocationLine | undefined {
  try {
    const parsed = revocationLine.safeParse(JSON.parse(bytes.toString('utf8')))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

const offlineFile = z.strictObject({
  version: z.literal(1),
  tickets: z
    .array(
      z.strictObject({
        id: z.string().regex(/^chl_[A-Za-z0-9_-]{22}$/u),
        codeHash: hex64,
        expiresAt: z.number(),
        scopesProfile: z.literal('offline'),
      }),
    )
    .max(64),
})
type OfflineTicket = z.infer<typeof offlineFile>['tickets'][number]

const CREDENTIAL = /^ldc1\.(dev_[A-Za-z0-9_-]{22})\.[A-Za-z0-9_-]{43}$/u

export interface ConnectionContext {
  listener: ListenerClass
  origin: string
  remoteAddress: string
}
export type PresentedCredential =
  | { kind: 'cookie' | 'header'; value: string }
  /** `harness_link=…` from the previous build; read on loopback-tcp only. */
  | { kind: 'legacy-cookie'; value: string }

export type AuthOutcome =
  /** `credentialHash` is the SHA-256 of the presented credential (current or previous); event streams re-check it. */
  | { ok: true; device: Device; renewAfter: number; renewDue: boolean; credentialHash: string }
  | {
      ok: false
      code: 'unauthorized' | 'renewal-required' | 'credential-expired' | 'device-revoked' | 'listener-mismatch' | 'credential-rotated'
      deviceId?: string
    }
  | { ok: false; code: 'legacy-reconfirm'; legacyName: string }

/** Test seam for crash injection; defaults to node:fs/promises. */
export interface DeviceFs {
  open(path: string, flags: string, mode?: number): Promise<FileHandle>
  rename(from: string, to: string): Promise<void>
}
const defaultFs: DeviceFs = { open: (path, flags, mode) => openFile(path, flags, mode), rename: renameFile }

const codeOf = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code
/** PresenceService refusals raised before it shows a window. */
function notNearby(): AppError {
  return new AppError(403, 'pairing-not-nearby', '手机需要和这台 Mac 连接同一个 Wi‑Fi')
}
function contended(): AppError {
  return new AppError(409, 'pairing-contended', '有两台设备扫了同一个二维码，已全部取消。请重新扫码。')
}

const UNSHOWN_PRESENCE = new Set(['presence-unavailable', 'presence-blocked', 'presence-cooldown', 'presence-busy'])

/** What a confirmation names as the source of a request made on host.sock. */
const LOCAL_SOURCE = '本机 host.sock'
/** Loopback peers may arrive through a forwarded port, so a confirmation never presents them as this computer. */
const FORWARDABLE_PORT = '回环端口（也可能是转发进来的连接）'

function sourceText(connection: ConnectionContext): string {
  if (isLocalListener(connection.listener)) return LOCAL_SOURCE
  if (connection.listener === 'loopback-tcp') return `${connection.remoteAddress} · ${FORWARDABLE_PORT}`
  return connection.remoteAddress
}

/** Canonical order, `view` always included, unknown names rejected. */
function normalizeScopes(scopes: readonly string[]): DeviceScope[] {
  const wanted = new Set<string>(['view', ...scopes])
  for (const scope of wanted) if (!ALL_SCOPES.includes(scope as DeviceScope)) throw new AppError(400, 'invalid-scope', '未知的设备权限')
  return ALL_SCOPES.filter(scope => wanted.has(scope))
}

function requireGrantable(scopes: readonly DeviceScope[], listener: ListenerClass): void {
  if (!isLocalListener(listener) && scopes.some(scope => UNIX_ONLY_SCOPES.includes(scope))) {
    throw new AppError(400, 'scope-not-grantable', '该权限在此连接方式下不可授予')
  }
}

function deviceName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name || name.length > 80) throw new AppError(400, 'invalid-device-name', '设备名称需要 1–80 个字符')
  // The name heads confirmation dialogs; anything the dialog would have to escape could imitate other lines there.
  if (!isAcceptableDeviceName(value as string)) throw new AppError(400, 'invalid-device-name', '设备名称不能包含控制字符或不可见字符')
  // The sheet's sentence quotes the name with these: one inside it could close the quote and add words of its own.
  if (/[「」]/u.test(name)) throw new AppError(400, 'invalid-device-name', '设备名称不能包含「」')
  return name
}

/** A migrated record's name, or the default when it is not one a device could be given today. */
function legacyName(name: string): string {
  return isAcceptableDeviceName(name) ? name.trim() : DEFAULT_DEVICE_NAME
}

function unauthorized(): AppError {
  return new AppError(401, 'unauthorized', '请先在本机确认这台设备')
}

function writeAtomic(fs: DeviceFs, directory: string, file: string, content: unknown): Promise<void> {
  return writeFileAtomic(join(directory, file), `${JSON.stringify(content, null, 2)}\n`, {
    prefix: `.${file.replace(/\.json$/u, '')}-`,
    fs,
  })
}

async function preparePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32' && ((await stat(directory)).mode & 0o077) !== 0) await chmod(directory, 0o700)
}

function corrupt(file: string, detail: string): AppError {
  return new AppError(500, 'devices-corrupt', `设备文件 auth/${file} 无法读取，原文件已保留：${detail}`)
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function publicDevice(device: StoredDevice): Device {
  return {
    id: device.id,
    name: device.name,
    status: device.status,
    listener: device.listener,
    scopes: [...device.scopes],
    dataScope: device.dataScope,
    fingerprint: device.fingerprint,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    credentialExpiresAt: iso(device.native ? device.native.lastVerifiedAt + CREDENTIAL_LIFETIME : device.credentialExpiresAt),
    pairedBy: { method: device.pairedBy.method, ...(device.pairedBy.deviceId ? { deviceId: device.pairedBy.deviceId } : {}) },
    ...(device.revokedAt !== undefined ? { revokedAt: iso(device.revokedAt) } : {}),
    ...(device.revokedReason ? { revokedReason: device.revokedReason } : {}),
  }
}

function newCredential(deviceId: string): string {
  return `ldc1.${deviceId}.${randomBytes(32).toString('base64url')}`
}

/** The part of a device a scope change is decided against. */
export interface DeviceScopeBase {
  scopes: DeviceScope[]
  dataScope: DataScope
  status: DeviceStatus
}

function sameBase(device: StoredDevice, base: DeviceScopeBase): boolean {
  if (!base || !Array.isArray(base.scopes) || base.dataScope !== device.dataScope || base.status !== device.status) return false
  const expected = new Set<string>(base.scopes)
  return expected.size === base.scopes.length && expected.size === device.scopes.length && device.scopes.every(scope => expected.has(scope))
}

/** View only until an admin restores it; the previous scopes are kept for that. */
function demote(device: StoredDevice): void {
  device.status = 'review'
  device.scopesBeforeReview = device.scopes
  device.scopes = ['view']
}

function cascadeNative(device: StoredDevice, at: number): void {
  device.status = 'revoked'
  device.revokedAt = at
  device.revokedReason = 'cascade'
  delete device.pending
}

/**
 * Enrolled devices (`auth/devices.json`, version 2). Credentials are bearer secrets bound to one listener and origin;
 * only their SHA-256 hashes are stored. Revocations are also appended to `auth/revocations.jsonl`, which wins on open.
 */
export class DeviceStore {
  private state: DevicesFile
  private queue: Promise<unknown> = Promise.resolve()
  private readonly challenges = new Map<string, { deviceId: string; expiresAt: number }>()
  private readonly folderGrants = new Map<string, { deviceId: string; expiresAt: number }>()
  private readonly lastPersistedSeen = new Map<string, number>()
  /** The revocation log may end in an unterminated fragment that could not be repaired yet; fixed before the next append. */
  private revocationsTorn = false
  private readonly revocationListeners: Array<(deviceId: string) => void> = []
  private closed = false

  private constructor(
    private readonly directory: string,
    readonly hostId: string,
    private readonly audit: AuditLog,
    private readonly now: () => number,
    private readonly fs: DeviceFs,
  ) {
    this.state = { version: 2, hostId, devices: [] }
  }

  static async open(options: {
    directory: string
    hostId: string
    audit: AuditLog
    now?: () => number
    fs?: DeviceFs
  }): Promise<DeviceStore> {
    const store = new DeviceStore(options.directory, options.hostId, options.audit, options.now ?? Date.now, options.fs ?? defaultFs)
    await preparePrivateDirectory(options.directory)
    await store.load()
    return store
  }

  private get path(): string {
    return join(this.directory, DEVICES_FILE)
  }

  private async load(): Promise<void> {
    let text: string | undefined
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw corrupt(DEVICES_FILE, codeOf(error) ?? '读取失败')
    }
    let dirty = false
    const loweredByPause: Array<{ deviceId: string; removed: StoredDevice['scopes'] }> = []
    if (text === undefined) dirty = true
    else {
      let raw: unknown
      try {
        raw = JSON.parse(text)
      } catch {
        throw corrupt(DEVICES_FILE, 'JSON 格式无效')
      }
      const version = (raw as { version?: unknown } | null)?.version
      if (version === 1) {
        const legacy = legacyFile.safeParse(raw)
        if (!legacy.success) throw corrupt(DEVICES_FILE, '旧版格式无效')
        await this.migrate(legacy.data)
      } else {
        const parsed = devicesFile.safeParse(raw)
        if (!parsed.success) throw corrupt(DEVICES_FILE, version === 2 ? '格式无效' : `不支持的版本 ${String(version)}`)
        if (parsed.data.hostId !== this.hostId) throw new AppError(500, 'devices-host-mismatch', '设备文件属于另一台 Host')
        for (const device of parsed.data.devices) {
          if (isNativeListener(device.listener) !== Boolean(device.native)) throw corrupt(DEVICES_FILE, '原生身份缺失或入口不匹配')
          if (device.native) {
            try {
              validateNativeIdentity(device.native, Buffer.from(device.publicKey, 'base64url'), true)
            } catch {
              throw corrupt(DEVICES_FILE, '原生设备密钥无效')
            }
          }
        }
        this.state = parsed.data
        // The pause is gone. A Host stopped while paused must not hand its phones their input back on upgrade: they stay
        // read-only one by one, and pairing again is the way back.
        if (this.state.nativeInputsPaused !== undefined) {
          if (this.state.nativeInputsPaused)
            for (const device of this.state.devices)
              if (device.native && device.status !== 'revoked') {
                const removed = device.scopes.filter(scope => scope !== 'view')
                device.scopes = ['view']
                delete device.scopesBeforeReview
                if (removed.length) loweredByPause.push({ deviceId: device.id, removed })
              }
          delete this.state.nativeInputsPaused
          dirty = true
        }
      }
    }
    const replayed = await this.applyRevocationLog()
    if (replayed.changed) dirty = true
    if (this.prune()) dirty = true
    if (dirty) await this.persist()
    await this.removeLegacyToken()
    for (const device of this.state.devices) this.lastPersistedSeen.set(device.id, Date.parse(device.lastSeenAt) || 0)
    // Best effort, like the cascade itself: these only take privilege away.
    const actor: AuditActor = { listener: 'host', via: 'startup' }
    for (const { deviceId, removed } of loweredByPause)
      await this.audit
        .append({ action: 'device.scopes.changed', actor, target: deviceId, detail: { deviceId, added: [], removed } })
        .catch(() => {})
    for (const review of replayed.reviews) {
      await this.audit.append({ action: 'device.review', actor, target: review.deviceId, detail: review }).catch(() => {})
    }
    for (const id of replayed.nativeRevoked)
      await this.audit
        .append({ action: 'device.revoked', actor, target: id, detail: { deviceId: id, reason: 'cascade', cascaded: 0 } })
        .catch(() => {})
    if (replayed.tornBytes) {
      await this.audit
        .append({ action: 'device.revocations.torn-tail-removed', actor, detail: { bytes: replayed.tornBytes } })
        .catch(() => {})
    }
  }

  /** v1 → v2: controllers are revoked; owners keep only a "please re-confirm" marker for their old cookie. */
  private async migrate(legacy: z.infer<typeof legacyFile>): Promise<void> {
    const now = this.now()
    const devices: StoredDevice[] = []
    const revocations: Array<z.infer<typeof revocationLine>> = []
    let legacyCount = 0
    for (const item of legacy.devices) {
      const id = randomId('dev')
      const usable = item.role === 'owner' && !item.revoked && item.expiresAt > now && hex64.safeParse(item.tokenHash).success
      const name = item.name.trim().slice(0, 80) || DEFAULT_DEVICE_NAME
      const base: StoredDevice = {
        id,
        name,
        status: usable ? 'legacy-pending' : 'revoked',
        listener: 'loopback-tcp',
        origin: '',
        publicKey: '',
        fingerprint: '',
        scopes: ['view'],
        dataScope: 'work',
        pairedBy: { method: 'migration' },
        createdAt: item.createdAt,
        lastSeenAt: item.lastSeenAt,
        credentialExpiresAt: item.expiresAt,
        credential: null,
        previous: [],
      }
      if (usable) {
        base.legacyTokenHash = item.tokenHash
        legacyCount += 1
      } else {
        base.revokedAt = now
        base.revokedReason = 'migration'
        revocations.push({ at: now, deviceId: id, reason: 'migration' })
      }
      devices.push(base)
    }
    for (const entry of revocations) await this.appendRevocation(entry)
    this.state = { version: 2, hostId: this.hostId, devices }
    await this.persist()
    await this.audit.append({
      action: 'migration.devices.v2',
      actor: { listener: 'host', via: 'startup' },
      detail: { revoked: revocations.length, legacy: legacyCount },
    })
  }

  private async removeLegacyToken(): Promise<void> {
    try {
      await unlink(join(this.directory, LEGACY_TOKEN_FILE))
      await syncDirectory(this.directory)
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error
    }
  }

  private get revocationsPath(): string {
    return join(this.directory, REVOCATIONS_FILE)
  }

  /**
   * Replays the revocation log over devices.json. A logged revocation that devices.json does not show yet (a crash
   * before the rewrite, a failed write, or a restored backup) also never recorded its cascade, so the cascade is
   * derived again here. Devices restored by an admin after a persisted revocation are left alone.
   */
  private async applyRevocationLog(): Promise<{
    changed: boolean
    reviews: Array<{ deviceId: string; causeDeviceId: string }>
    nativeRevoked: string[]
    tornBytes: number
  }> {
    const result = {
      changed: false,
      reviews: [] as Array<{ deviceId: string; causeDeviceId: string }>,
      nativeRevoked: [] as string[],
      tornBytes: 0,
    }
    let bytes: Buffer
    try {
      bytes = await readFile(this.revocationsPath)
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return result
      throw corrupt(REVOCATIONS_FILE, codeOf(error) ?? '读取失败')
    }
    const apply = (line: RevocationLine) => {
      const device = this.state.devices.find(item => item.id === line.deviceId)
      if (!device || device.status === 'revoked') return
      device.status = 'revoked'
      device.revokedAt = line.at
      device.revokedReason = line.reason
      for (const item of this.cascadeTargets(device.id)) {
        if (item.native) {
          cascadeNative(item, line.at)
          result.nativeRevoked.push(item.id)
        } else {
          demote(item)
          result.reviews.push({ deviceId: item.id, causeDeviceId: device.id })
        }
      }
      result.changed = true
    }
    const end = bytes.lastIndexOf(0x0a) + 1
    const complete = bytes.subarray(0, end).toString('utf8')
    const segments = complete === '' ? [] : complete.slice(0, -1).split('\n')
    for (const [index, segment] of segments.entries()) {
      const parsed = parseRevocation(Buffer.from(segment, 'utf8'))
      if (!parsed) throw corrupt(REVOCATIONS_FILE, `第 ${index + 1} 行无效`)
      apply(parsed)
    }
    // An unterminated last line may be a revocation cut short by a crash; honour it when it parses.
    const tail = parseRevocation(bytes.subarray(end))
    if (tail) apply(tail)
    try {
      result.tornBytes = await this.repairRevocationTail(bytes)
    } catch {
      this.revocationsTorn = true
    }
    return result
  }

  /**
   * Leaves the log ending on a line boundary, so a later append can never turn a fragment into an unreadable middle
   * line: a last line that parses gets its newline, anything else is copied to `revocations.jsonl.torn-<ms>` and cut
   * off. Returns the number of bytes cut.
   */
  private async repairRevocationTail(bytes: Buffer): Promise<number> {
    const end = bytes.lastIndexOf(0x0a) + 1
    const tail = bytes.subarray(end)
    if (tail.length === 0) {
      this.revocationsTorn = false
      return 0
    }
    const terminate = parseRevocation(tail) !== undefined
    if (!terminate) await this.keepTornTail(tail)
    const handle = await this.fs.open(this.revocationsPath, 'r+', 0o600)
    try {
      if (terminate) await handle.write(Buffer.from('\n'), 0, 1, bytes.length)
      else await handle.truncate(end)
      await handle.sync()
    } finally {
      await handle.close()
    }
    this.revocationsTorn = false
    return terminate ? 0 : tail.length
  }

  private async keepTornTail(tail: Buffer): Promise<void> {
    const base = join(this.directory, `${REVOCATIONS_FILE}.torn-${this.now()}`)
    try {
      await writeFile(base, tail, { mode: 0o600, flag: 'wx' })
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') throw error
      await writeFile(`${base}-${randomUUID()}`, tail, { mode: 0o600, flag: 'wx' })
    }
    await syncDirectory(this.directory)
  }

  private async appendRevocation(entry: RevocationLine): Promise<void> {
    if (this.revocationsTorn) {
      let bytes = Buffer.alloc(0)
      try {
        bytes = await readFile(this.revocationsPath)
      } catch (error) {
        if (codeOf(error) !== 'ENOENT') throw error
      }
      await this.repairRevocationTail(bytes)
    }
    const handle = await this.fs.open(this.revocationsPath, 'a', 0o600)
    try {
      const { size } = await handle.stat()
      const data = Buffer.from(`${JSON.stringify(entry)}\n`, 'utf8')
      try {
        const { bytesWritten } = await handle.write(data)
        if (bytesWritten !== data.length) throw new Error('short write')
        await handle.sync()
      } catch (error) {
        // Cut the unacknowledged fragment off again; if that fails too, repair before the next append.
        try {
          await handle.truncate(size)
          await handle.sync()
        } catch {
          this.revocationsTorn = true
        }
        throw error
      }
    } finally {
      await handle.close()
    }
  }

  /** Active devices paired through an invitation from `deviceId`; revoking that inviter moves them to review. */
  private cascadeTargets(deviceId: string): StoredDevice[] {
    const targets: StoredDevice[] = [],
      pending = [deviceId],
      seen = new Set(pending)
    for (let index = 0; index < pending.length; index++) {
      for (const item of this.state.devices) {
        if (
          item.pairedBy.deviceId !== pending[index]
          || seen.has(item.id)
          || !(item.status === 'active' || (item.native && item.status === 'review'))
        )
          continue
        seen.add(item.id)
        targets.push(item)
        if (item.native) pending.push(item.id)
      }
    }
    return targets
  }

  private prune(): boolean {
    const now = this.now()
    const before = this.state.devices.length
    let changed = false
    if (before > 0 && !this.state.enrolled) {
      this.state.enrolled = true
      changed = true
    }
    this.state.devices = this.state.devices.filter(device => {
      if (device.status === 'revoked' && device.revokedAt !== undefined && now - device.revokedAt > PRUNE_AFTER) return false
      if (device.native && device.status !== 'revoked') return true
      return now - device.credentialExpiresAt <= PRUNE_AFTER
    })
    for (const device of this.state.devices) {
      if (device.pending && now - device.pending.issuedAt > PENDING_LIFETIME) {
        delete device.pending
        changed = true
      }
    }
    return changed || this.state.devices.length !== before
  }

  private persist(): Promise<void> {
    this.prune()
    return writeAtomic(this.fs, this.directory, DEVICES_FILE, this.state)
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task)
    this.queue = run.catch(() => {})
    return run
  }

  private find(deviceId: string): StoredDevice | undefined {
    return this.state.devices.find(device => device.id === deviceId)
  }

  private usable(device: StoredDevice): boolean {
    return (device.status === 'active' || device.status === 'review') && this.now() <= device.credentialExpiresAt
  }

  async authenticate(presented: PresentedCredential | undefined, connection: ConnectionContext): Promise<AuthOutcome> {
    const denied: AuthOutcome = { ok: false, code: 'unauthorized' }
    if (!presented || typeof presented.value !== 'string') return denied
    const now = this.now()
    if (presented.kind === 'legacy-cookie') {
      if (connection.listener !== 'loopback-tcp' || !/^[\w-]{1,128}$/u.test(presented.value)) return denied
      const hash = sha256Hex(presented.value)
      let match: StoredDevice | undefined
      for (const device of this.state.devices) {
        const equal =
          device.status === 'legacy-pending' && device.legacyTokenHash !== undefined && constantTimeEqualHex(device.legacyTokenHash, hash)
        if (equal && now <= device.credentialExpiresAt) match = device
      }
      return match ? { ok: false, code: 'legacy-reconfirm', legacyName: legacyName(match.name) } : denied
    }
    // Cookies on TCP listeners, the authorization header on host.sock; the other form is ignored.
    if (presented.kind !== (isSocketTransport(connection.listener) ? 'header' : 'cookie')) return denied
    const parsed = CREDENTIAL.exec(presented.value)
    if (!parsed) return denied
    const device = this.find(parsed[1]!)
    if (!device || device.status === 'legacy-pending') return denied
    const hash = sha256Hex(presented.value)
    const current = device.credential !== null && constantTimeEqualHex(device.credential.hash, hash)
    const previous = current ? undefined : device.previous.find(entry => constantTimeEqualHex(entry.hash, hash))
    const pending = !current && !previous && device.pending !== undefined && constantTimeEqualHex(device.pending.hash, hash)
    if (!current && !previous && !pending) return denied
    if (device.status === 'revoked') return { ok: false, code: 'device-revoked', deviceId: device.id }
    if (connection.listener !== device.listener || connection.origin !== device.origin)
      return { ok: false, code: 'listener-mismatch', deviceId: device.id }
    if (now > device.credentialExpiresAt) return { ok: false, code: 'credential-expired', deviceId: device.id }
    if (previous && now > previous.graceUntil) {
      // A rotated-out credential used after its grace window was copied: revoke the device.
      await this.serialize(() => this.revokeStored(device, 'replay', { deviceId: device.id, listener: connection.listener, via: 'http' }))
      return { ok: false, code: 'device-revoked', deviceId: device.id }
    }
    if (pending && !(await this.serialize(() => this.promote(device.id, hash, connection)))) return denied
    const rotatedAt = device.credential!.rotatedAt
    if (!previous && now - rotatedAt > RENEW_INTERVAL) return { ok: false, code: 'renewal-required', deviceId: device.id }
    this.touch(device, now)
    return {
      ok: true,
      device: publicDevice(device),
      renewAfter: rotatedAt + RENEW_INTERVAL,
      renewDue: now - rotatedAt > RENEW_INTERVAL,
      credentialHash: hash,
    }
  }

  /**
   * The first use of a renewed credential makes it current; the one it replaces stays accepted for the grace window
   * (renewal excepted). Until then the old credential stays current, so a renewal whose answer was lost costs nothing.
   * Returns whether `hash` is now current; false when the pending entry expired unused or another renewal replaced it.
   */
  private async promote(deviceId: string, hash: string, connection: ConnectionContext): Promise<boolean> {
    const device = this.find(deviceId)
    if (!device || !this.usable(device) || !device.credential) return false
    if (constantTimeEqualHex(device.credential.hash, hash)) return true
    if (!device.pending || !constantTimeEqualHex(device.pending.hash, hash)) return false
    const now = this.now()
    if (now - device.pending.issuedAt > PENDING_LIFETIME) {
      delete device.pending
      return false
    }
    const actor: AuditActor = { deviceId, listener: connection.listener, via: 'http' }
    // The new credential was issued, signed for and audited already; this record only marks when it took over.
    const seq = await this.audit.append({ action: 'device.credential.rotated', actor, target: deviceId, detail: { deviceId } }).then(
      result => result.seq,
      () => undefined,
    )
    const before = { credential: device.credential, previous: device.previous, pending: device.pending }
    device.previous = [
      { hash: device.credential.hash, rotatedAt: device.credential.rotatedAt, graceUntil: now + ROTATION_GRACE },
      ...device.previous,
    ].slice(0, 4)
    device.credential = { hash, rotatedAt: now }
    delete device.pending
    try {
      await this.persist()
    } catch (error) {
      Object.assign(device, before)
      if (seq !== undefined) await this.audit.append({ action: 'action.failed', actor, detail: { refSeq: seq } }).catch(() => {})
      throw error
    }
    return true
  }

  /**
   * Renewal is refused with a credential a newer one already replaced. Without the presented hash (a credential due
   * for renewal), it is refused while any replaced credential is still inside its grace window.
   */
  private refuseRotatedOut(device: StoredDevice, credentialHash: string | undefined, now: number): void {
    const rotated = new AppError(409, 'credential-rotated', '凭据已在其他页面续期，请刷新')
    if (credentialHash === undefined) {
      if (device.previous.some(entry => now <= entry.graceUntil)) throw rotated
      return
    }
    if (device.credential && constantTimeEqualHex(device.credential.hash, credentialHash)) return
    if (device.previous.some(entry => constantTimeEqualHex(entry.hash, credentialHash))) throw rotated
    throw unauthorized()
  }

  /**
   * Whether a long-lived stream opened with the credential hashing to `credentialHash` may keep receiving data: the
   * device is usable, and the credential is either current and not yet due for renewal, or a rotated-out one still
   * inside its grace window. Never revokes or audits; replay detection stays in `authenticate`.
   */
  streamAllowed(deviceId: string, credentialHash: string): boolean {
    const device = this.find(deviceId)
    if (device?.native)
      return (
        device.status !== 'revoked'
        && device.status !== 'legacy-pending'
        && device.credential !== null
        && constantTimeEqualHex(device.credential.hash, credentialHash)
      )
    if (!device || !this.usable(device) || !device.credential) return false
    const now = this.now()
    if (constantTimeEqualHex(device.credential.hash, credentialHash)) return now - device.credential.rotatedAt <= RENEW_INTERVAL
    const previous = device.previous.find(entry => constantTimeEqualHex(entry.hash, credentialHash))
    return previous !== undefined && now <= previous.graceUntil
  }

  private touch(device: StoredDevice, now: number): void {
    device.lastSeenAt = iso(now)
    if (this.closed || now - (this.lastPersistedSeen.get(device.id) ?? 0) < LAST_SEEN_PERSIST) return
    this.lastPersistedSeen.set(device.id, now)
    void this.serialize(() => this.persist()).catch(() => {})
  }

  /**
   * Waits for every queued write, including the last-seen updates that no request awaits, so the Host has stopped
   * writing auth/ before its shutdown completes and the data-dir lock is released. Later last-seen updates stay in
   * memory only.
   */
  async close(): Promise<void> {
    this.closed = true
    let pending: Promise<unknown>
    do {
      pending = this.queue
      await pending
    } while (pending !== this.queue)
  }

  /** Called synchronously after every revocation (including replay revocations), before it is audited. */
  onRevoked(listener: (deviceId: string) => void): void {
    this.revocationListeners.push(listener)
  }

  /** Status active or review, and the 30-day credential lifetime not exceeded. */
  isActive(deviceId: string): boolean {
    const device = this.find(deviceId)
    return device !== undefined && this.usable(device)
  }

  /** Whether the device can still stand behind unattended work. Asks without counting as the device being seen. */
  standsBehind(deviceId: string): boolean {
    const device = this.find(deviceId)
    if (!device) return false
    if (!isNativeListener(device.listener)) return this.usable(device)
    return (
      !!device.native
      && !!device.credential
      && (device.status === 'active' || device.status === 'review')
      && this.now() - device.native.lastVerifiedAt <= CREDENTIAL_LIFETIME
    )
  }

  nativeCandidates(): Array<{ id: string; kind: 'registered'; certificate: string; knockKey: Uint8Array }> {
    return this.state.devices
      .filter(device => device.native && device.credential && (device.status === 'active' || device.status === 'review'))
      .map(device => ({
        id: device.id,
        kind: 'registered',
        certificate: device.native!.certificate,
        knockKey: Buffer.from(device.native!.knockHash, 'hex'),
      }))
  }

  nativeRevocations(): Array<{ id: string; revokedAt: number; acknowledged: boolean }> {
    return this.state.devices
      .filter(device => device.native && device.status === 'revoked' && device.revokedAt !== undefined)
      .map(device => ({ id: device.id, revokedAt: device.revokedAt!, acknowledged: device.native!.revocationAcknowledgedAt !== undefined }))
  }
  nativeTransportCandidates(): ReturnType<DeviceStore['nativeCandidates']> {
    const now = this.now()
    const revoked = this.state.devices
      .filter(
        device => device.native && device.status === 'revoked' && device.revokedAt !== undefined && now - device.revokedAt < PRUNE_AFTER,
      )
      .map(device => ({
        id: device.id,
        kind: 'registered' as const,
        certificate: device.native!.certificate,
        knockKey: Buffer.from(device.native!.knockHash, 'hex'),
      }))
    return [...this.nativeCandidates(), ...revoked]
  }
  acknowledgeNativeRevocation(deviceId: string, revokedAt: number): Promise<void> {
    return this.serialize(async () => {
      const device = this.find(deviceId)
      if (!device?.native || device.status !== 'revoked' || device.revokedAt !== revokedAt)
        throw new AppError(401, 'unauthorized', '设备认证失败')
      if (device.native.revocationAcknowledgedAt !== undefined) return
      device.native.revocationAcknowledgedAt = this.now()
      try {
        await this.persist()
      } catch (error) {
        delete device.native.revocationAcknowledgedAt
        throw error
      }
    })
  }

  /**
   * A new device's name, told apart from the Host's other devices with 「(2)」 and so on, before it reaches the
   * confirmation sheet. The sheet shows at most 20 graphemes of a name (`presence-reason.ts`, the device slot) and cuts
   * the end, so a numbered name is shortened in front of its number until it fits: the number is what tells two
   * devices apart while confirming. A name that is not taken is kept whole.
   */
  distinctName(name: string): string {
    const taken = new Set(this.state.devices.filter(device => device.status !== 'revoked').map(device => device.name))
    if (!taken.has(name)) return name
    const clusters = Array.from(NAME_GRAPHEMES.segment(name), part => part.segment)
    for (let number = 2; number < 100; number++) {
      const suffix = ` (${number})`
      const room = Math.max(1, SHEET_NAME_GRAPHEMES - suffix.length)
      const candidate = `${clusters.slice(0, room).join('').trimEnd()}${suffix}`
      if (!taken.has(candidate)) return candidate
    }
    return name
  }

  /** A paired phone exists, or a removed one has yet to read its tombstone: the Mac stays reachable for them. */
  nativeReachable(): boolean {
    const now = this.now()
    return this.state.devices.some(
      device =>
        device.native
        && (device.status === 'revoked'
          ? device.revokedAt !== undefined
            && device.native.revocationAcknowledgedAt === undefined
            && now - device.revokedAt < TOMBSTONE_DELIVERY_WINDOW
          : device.status === 'active' || device.status === 'review'),
    )
  }
  nativeStatus(deviceId: string): Device['native'] | undefined {
    const device = this.find(deviceId)
    if (!device?.native) return undefined
    return {
      lastVerifiedAt: iso(device.native.lastVerifiedAt),
      input:
        device.status === 'revoked'
          ? 'revoked'
          : device.status === 'review'
            ? 'review'
            : this.now() - device.native.lastVerifiedAt > CREDENTIAL_LIFETIME
              ? 'verification-required'
              : 'ready',
    }
  }

  nativeVerificationKey(deviceId: string): string | undefined {
    return this.find(deviceId)?.native?.verificationKey
  }

  authenticateNative(deviceId: string): AuthOutcome {
    const device = this.find(deviceId)
    if (!device?.native || !device.credential || !isNativeListener(device.listener)) return { ok: false, code: 'unauthorized' }
    if (device.status === 'revoked' || device.status === 'legacy-pending') return { ok: false, code: 'device-revoked', deviceId }
    const result = publicDevice(device)
    if (this.now() - device.native.lastVerifiedAt > CREDENTIAL_LIFETIME) result.scopes = ['view']
    this.touch(device, this.now())
    return { ok: true, device: result, credentialHash: device.credential.hash, renewAfter: this.now() + RENEW_INTERVAL, renewDue: false }
  }

  markNativeVerified(deviceId: string, listener: ListenerClass): Promise<number> {
    return this.serialize(async () => {
      const device = this.find(deviceId)
      if (!device?.native || (device.status !== 'active' && device.status !== 'review')) throw unauthorized()
      const now = this.now(),
        before = { verified: device.native.lastVerifiedAt, expires: device.credentialExpiresAt }
      const { seq } = await this.audit.append({
        action: 'device.native.verified',
        actor: { deviceId, listener, via: 'http' },
        target: deviceId,
        detail: { deviceId },
      })
      device.native.lastVerifiedAt = now
      device.credentialExpiresAt = now + CREDENTIAL_LIFETIME
      try {
        await this.persist()
      } catch (error) {
        device.native.lastVerifiedAt = before.verified
        device.credentialExpiresAt = before.expires
        await this.audit.append({ action: 'action.failed', actor: { listener: 'host' }, detail: { refSeq: seq } }).catch(() => {})
        throw error
      }
      return now + 10 * 60_000
    })
  }

  get(deviceId: string): Device | undefined {
    const device = this.find(deviceId)
    return device && publicDevice(device)
  }

  list(): Device[] {
    return this.state.devices.map(publicDevice)
  }

  /** Whether any device was ever enrolled here, revoked and pruned ones included. */
  everEnrolled(): boolean {
    return this.state.enrolled === true || this.state.devices.length > 0
  }

  /** The non-expired legacy-pending record matching an old `harness_link` cookie value. */
  legacyMatch(cookieValue: string): Device | undefined {
    if (!/^[\w-]{1,128}$/u.test(cookieValue)) return undefined
    const hash = sha256Hex(cookieValue)
    const now = this.now()
    const device = this.state.devices.find(
      item =>
        item.status === 'legacy-pending'
        && item.legacyTokenHash !== undefined
        && constantTimeEqualHex(item.legacyTokenHash, hash)
        && now <= item.credentialExpiresAt,
    )
    return device && publicDevice(device)
  }

  create(
    input: {
      name: string
      connection: ConnectionContext
      publicKeyDer: Buffer
      scopes: DeviceScope[]
      dataScope: DataScope
      pairedBy: Device['pairedBy']
      enrollmentId: string
      native?: NativeRegistrationIdentity
      reservedNativeId?: string
      /** Unconfirmed, as the first device: refused once any device has been written, here on the store's queue. */
      firstUse?: true
    },
    actor: AuditActor,
    stepup: StepupMethod,
  ): Promise<{ device: Device; credential: string }> {
    return this.serialize(async () => {
      if (input.firstUse && this.everEnrolled()) throw new AppError(410, 'enrollment-cancelled', '连接请求已取消，请重新提交')
      const name = deviceName(input.name)
      const { der } = parseP256Spki(Buffer.from(input.publicKeyDer).toString('base64url'))
      const scopes = normalizeScopes(input.scopes)
      requireGrantable(scopes, input.connection.listener)
      if (input.dataScope !== 'work' && input.dataScope !== 'all') throw new AppError(400, 'invalid-data-scope', '数据范围无效')
      const method = input.pairedBy.method
      if (method === 'migration') throw new AppError(400, 'invalid-pairing', '连接方式无效')
      // Checked on the store's queue, after any revocation queued before it: an enrollment whose inviter was revoked
      // in the meantime would otherwise create an active device that the inviter's cascade never reached.
      if (input.pairedBy.deviceId !== undefined) {
        const inviter = this.find(input.pairedBy.deviceId)
        if (!inviter || inviter.status !== 'active' || !this.usable(inviter))
          throw new AppError(403, 'invitation-invalid', '配对码无效或已过期')
      }
      const native = isNativeListener(input.connection.listener) && input.native ? validateNativeIdentity(input.native, der) : undefined
      if (native && this.nativeCandidates().length >= 96) throw new AppError(429, 'native-device-limit', '手机连接数已达到上限')
      if (isNativeListener(input.connection.listener) !== Boolean(native))
        throw new AppError(400, 'native-identity-required', '手机连接必须绑定连接证书与验证密钥')
      if (native && !/^[a-f0-9]{64}$/u.test(input.native!.knockHash))
        throw new AppError(400, 'native-identity-invalid', '原生设备的敲门派生无效')
      const now = this.now()
      if (
        input.reservedNativeId !== undefined
        && (!native || !/^dev_[A-Za-z0-9_-]{22}$/u.test(input.reservedNativeId) || this.find(input.reservedNativeId))
      )
        throw new AppError(409, 'native-identity-conflict', '原生设备身份发生冲突，请重新配对')
      const id = input.reservedNativeId ?? randomId('dev')
      const credential = newCredential(id)
      const record: StoredDevice = {
        id,
        name,
        status: 'active',
        listener: input.connection.listener,
        origin: input.connection.origin,
        publicKey: der.toString('base64url'),
        fingerprint: deviceFingerprint(der),
        scopes,
        dataScope: input.dataScope,
        pairedBy: { method, ...(input.pairedBy.deviceId ? { deviceId: input.pairedBy.deviceId } : {}) },
        createdAt: iso(now),
        lastSeenAt: iso(now),
        credentialExpiresAt: now + CREDENTIAL_LIFETIME,
        credential: { hash: sha256Hex(credential), rotatedAt: now },
        previous: [],
        ...(native ? { native: { ...native, knockHash: input.native!.knockHash, lastVerifiedAt: now } } : {}),
      }
      const { seq } = await this.audit.append({
        action: 'device.enrolled',
        actor,
        stepup,
        target: id,
        detail: {
          deviceId: id,
          enrollmentId: input.enrollmentId,
          listener: record.listener,
          method,
          scopes: record.scopes,
          dataScope: record.dataScope,
          ...(record.pairedBy.deviceId ? { pairedByDeviceId: record.pairedBy.deviceId } : {}),
        },
      })
      this.state.devices.push(record)
      try {
        await this.persist()
      } catch (error) {
        // `enrolled` stays set: the write may have reached the disk before it failed.
        this.state.devices = this.state.devices.filter(device => device !== record)
        await this.audit.append({ action: 'action.failed', actor, detail: { refSeq: seq } }).catch(() => {})
        throw error
      }
      this.lastPersistedSeen.set(id, now)
      return { device: publicDevice(record), credential }
    })
  }

  /** In memory, single use, 60 s. `credentialHash` is the SHA-256 of the credential the request presented. */
  challenge(deviceId: string, credentialHash?: string): { nonce: string; expiresAt: number } {
    const device = this.find(deviceId)
    if (!device || !this.usable(device)) throw unauthorized()
    const now = this.now()
    this.refuseRotatedOut(device, credentialHash, now)
    for (const [nonce, entry] of this.challenges) if (entry.expiresAt < now) this.challenges.delete(nonce)
    const mine = [...this.challenges].filter(([, entry]) => entry.deviceId === deviceId)
    for (const [nonce] of mine.slice(0, Math.max(0, mine.length - 3))) this.challenges.delete(nonce)
    const nonce = randomNonce()
    const expiresAt = now + CHALLENGE_TTL
    this.challenges.set(nonce, { deviceId, expiresAt })
    return { nonce, expiresAt }
  }

  /**
   * In memory, single use, 60 s, at most four outstanding per device: the nonce of one folder add, which the desktop
   * app's main process signs (`foldersSigningText`) together with the request body.
   */
  folderGrant(deviceId: string, credentialHash?: string): { nonce: string; expiresAt: number } {
    const device = this.find(deviceId)
    if (!device || !this.usable(device)) throw unauthorized()
    const now = this.now()
    this.refuseRotatedOut(device, credentialHash, now)
    for (const [nonce, entry] of this.folderGrants) if (entry.expiresAt < now) this.folderGrants.delete(nonce)
    const mine = [...this.folderGrants].filter(([, entry]) => entry.deviceId === deviceId)
    for (const [nonce] of mine.slice(0, Math.max(0, mine.length - (MAX_FOLDER_GRANTS - 1)))) this.folderGrants.delete(nonce)
    const nonce = randomNonce()
    const expiresAt = now + FOLDER_GRANT_TTL
    this.folderGrants.set(nonce, { deviceId, expiresAt })
    return { nonce, expiresAt }
  }

  /**
   * Consumes the nonce and checks the device's signature over the body hash. A missing, reused, expired or foreign
   * nonce or a bad signature refuses the whole request, and the nonce is gone either way.
   */
  verifyFolderGrant(input: { deviceId: string; nonce: unknown; bodyHash: string; signature: unknown }): void {
    const invalid = new AppError(403, 'folder-grant-invalid', '添加文件夹的请求没有通过桌面端校验，没有加入任何文件夹')
    const nonce = typeof input.nonce === 'string' ? input.nonce : undefined
    const grant = nonce === undefined ? undefined : this.folderGrants.get(nonce)
    if (nonce === undefined || !grant) throw invalid
    this.folderGrants.delete(nonce)
    if (grant.deviceId !== input.deviceId || grant.expiresAt < this.now()) throw invalid
    const device = this.find(input.deviceId)
    if (!device || !this.usable(device) || !device.publicKey || typeof input.signature !== 'string') throw invalid
    const { key } = parseP256Spki(device.publicKey)
    if (!verifyP256(key, foldersSigningText(this.hostId, device.id, nonce, input.bodyHash), input.signature)) throw invalid
  }

  /**
   * Issues a new credential as `pending`; the presented one stays current until the new one is first used, and a
   * later renewal replaces a pending one. `credentialHash` is the SHA-256 of the credential the request presented.
   */
  renew(input: {
    deviceId: string
    nonce: string
    signature: string
    connection: ConnectionContext
    credentialHash?: string
  }): Promise<{ device: Device; credential: string }> {
    return this.serialize(async () => {
      const invalidSignature = new AppError(401, 'invalid-signature', '签名校验失败')
      const challenge = typeof input.nonce === 'string' ? this.challenges.get(input.nonce) : undefined
      if (challenge) this.challenges.delete(input.nonce)
      const now = this.now()
      if (!challenge || challenge.deviceId !== input.deviceId || challenge.expiresAt < now) throw invalidSignature
      const device = this.find(input.deviceId)
      if (!device || device.status === 'revoked') throw new AppError(401, 'device-revoked', '此设备已被撤销，请重新在本机确认')
      if (!this.usable(device) || !device.credential) {
        throw now > device.credentialExpiresAt
          ? new AppError(401, 'credential-expired', '这台设备的连接已满 30 天，请重新在本机确认')
          : unauthorized()
      }
      if (input.connection.listener !== device.listener || input.connection.origin !== device.origin) {
        throw new AppError(401, 'listener-mismatch', '此设备凭据不能在当前地址使用，请重新在本机确认')
      }
      this.refuseRotatedOut(device, input.credentialHash, now)
      const { key } = parseP256Spki(device.publicKey)
      if (!verifyP256(key, `latch-renew-v1\n${this.hostId}\n${device.id}\n${input.nonce}`, input.signature)) throw invalidSignature
      const credential = newCredential(device.id)
      const actor: AuditActor = { deviceId: device.id, listener: input.connection.listener, via: 'http' }
      const { seq } = await this.audit.append({
        action: 'device.credential.issued',
        actor,
        target: device.id,
        detail: { deviceId: device.id },
      })
      const replaced = device.pending
      device.pending = { hash: sha256Hex(credential), issuedAt: now }
      try {
        await this.persist()
      } catch (error) {
        if (replaced) device.pending = replaced
        else delete device.pending
        await this.audit.append({ action: 'action.failed', actor, detail: { refSeq: seq } }).catch(() => {})
        throw error
      }
      return { device: publicDevice(device), credential }
    })
  }

  rename(deviceId: string, name: string, actor: AuditActor): Promise<Device> {
    return this.serialize(async () => {
      const device = this.find(deviceId)
      if (!device || device.status === 'revoked' || device.status === 'legacy-pending')
        throw new AppError(404, 'device-not-found', '找不到该设备')
      const next = deviceName(name)
      await this.audit.append({ action: 'device.renamed', actor, target: deviceId, detail: { deviceId } })
      const previous = device.name
      device.name = next
      try {
        await this.persist()
      } catch (error) {
        device.name = previous
        throw error
      }
      return publicDevice(device)
    })
  }

  /** Raising (more scopes, or `all` data) needs a step-up; leaving review requires raising past `view`. */
  async setScopes(
    deviceId: string,
    change: { scopes?: DeviceScope[]; dataScope?: DataScope },
    actor: AuditActor,
    stepup: StepupMethod,
    expectedBase?: DeviceScopeBase,
  ): Promise<Device> {
    return (await this.changeScopes(deviceId, change, actor, stepup, expectedBase)).device
  }

  /**
   * `setScopes`, also reporting whether the change was audited. A pure reduction (scopes removed, data narrowed,
   * nothing added) still applies when the audit log fails, like revocation; callers answer `x-latch-audit: failed`.
   * With `expectedBase` (what a confirmation showed), the change applies only if the device still has exactly that
   * base, compared on this store's queue so no other change can slip in between.
   */
  changeScopes(
    deviceId: string,
    change: { scopes?: DeviceScope[]; dataScope?: DataScope },
    actor: AuditActor,
    stepup: StepupMethod,
    expectedBase?: DeviceScopeBase,
  ): Promise<{ device: Device; audited: boolean }> {
    return this.serialize(async () => {
      const device = this.find(deviceId)
      if (!device || !this.usable(device)) throw new AppError(404, 'device-not-found', '找不到该设备')
      if (expectedBase && !sameBase(device, expectedBase)) throw new AppError(409, 'device-changed', '设备权限已被修改，请刷新后重试')
      const scopes = change.scopes ? normalizeScopes(change.scopes) : [...device.scopes]
      requireGrantable(scopes, device.listener)
      const dataScope = change.dataScope ?? device.dataScope
      if (dataScope !== 'work' && dataScope !== 'all') throw new AppError(400, 'invalid-data-scope', '数据范围无效')
      const added = scopes.filter(scope => !device.scopes.includes(scope))
      const removed = device.scopes.filter(scope => !scopes.includes(scope))
      const widened = dataScope === 'all' && device.dataScope === 'work'
      if (!added.length && !removed.length && dataScope === device.dataScope) return { device: publicDevice(device), audited: true }
      const raising = added.length > 0 || widened
      if (raising && stepup === 'none') throw new AppError(403, 'stepup-required', '需要在本机确认', { stepup: { where: 'this-device' } })
      let audited = true
      try {
        await this.audit.append({
          action: 'device.scopes.changed',
          actor,
          stepup,
          target: deviceId,
          detail: { deviceId, added, removed, ...(dataScope !== device.dataScope ? { dataScope } : {}) },
        })
      } catch (error) {
        if (raising || !(error instanceof AppError && error.code === 'audit-unavailable')) throw error
        audited = false
      }
      const before = {
        scopes: device.scopes,
        dataScope: device.dataScope,
        status: device.status,
        scopesBeforeReview: device.scopesBeforeReview,
      }
      device.scopes = scopes
      device.dataScope = dataScope
      if (device.status === 'review' && added.length) {
        device.status = 'active'
        delete device.scopesBeforeReview
      }
      try {
        await this.persist()
      } catch (error) {
        Object.assign(device, before)
        throw error
      }
      return { device: publicDevice(device), audited }
    })
  }

  /**
   * Revocation never waits for, or fails because of, the audit log. The append to revocations.jsonl comes first, so a
   * crash before devices.json is rewritten still leaves the device revoked.
   */
  revoke(
    deviceId: string,
    reason: 'manual' | 'self' | 'replay',
    actor: AuditActor,
  ): Promise<{ device: Device; cascaded: string[]; audited: boolean }> {
    return this.serialize(async () => {
      const device = this.find(deviceId)
      if (!device) throw new AppError(404, 'device-not-found', '找不到该设备')
      if (device.status === 'revoked') return { device: publicDevice(device), cascaded: [], audited: true }
      return this.revokeStored(device, reason, actor)
    })
  }

  /** Retires a migrated legacy record once its browser has re-enrolled. */
  retireLegacy(deviceId: string, actor: AuditActor): Promise<void> {
    return this.serialize(async () => {
      const device = this.find(deviceId)
      if (!device || device.status !== 'legacy-pending') return
      await this.revokeStored(device, 'migration', actor)
    })
  }

  private async revokeStored(
    device: StoredDevice,
    reason: 'manual' | 'self' | 'replay' | 'migration',
    actor: AuditActor,
  ): Promise<{ device: Device; cascaded: string[]; audited: boolean }> {
    if (device.status === 'revoked') return { device: publicDevice(device), cascaded: [], audited: true }
    const now = this.now()
    device.status = 'revoked'
    device.revokedAt = now
    device.revokedReason = reason
    for (const [nonce, entry] of this.challenges) if (entry.deviceId === device.id) this.challenges.delete(nonce)
    for (const [nonce, entry] of this.folderGrants) if (entry.deviceId === device.id) this.folderGrants.delete(nonce)
    // The cascade below is not logged separately: replaying this line on open derives it again.
    let logged = true
    try {
      await this.appendRevocation({ at: now, deviceId: device.id, reason })
    } catch {
      logged = false
    }

    const cascaded = this.cascadeTargets(device.id)
    for (const item of cascaded) {
      if (item.native) cascadeNative(item, now)
      else demote(item)
    }
    for (const listener of this.revocationListeners) {
      for (const id of [device.id, ...cascaded.filter(item => item.native).map(item => item.id)]) {
        try {
          listener(id)
        } catch {
          /* a listener must not undo a revocation */
        }
      }
    }
    let audited = true
    try {
      await this.audit.append({
        action: 'device.revoked',
        actor,
        target: device.id,
        detail: { deviceId: device.id, reason, cascaded: cascaded.length },
      })
    } catch {
      audited = false
    }
    for (const item of cascaded) {
      try {
        await this.audit.append(
          item.native
            ? { action: 'device.revoked', actor, target: item.id, detail: { deviceId: item.id, reason: 'cascade', cascaded: 0 } }
            : { action: 'device.review', actor, target: item.id, detail: { deviceId: item.id, causeDeviceId: device.id } },
        )
      } catch {
        audited = false
      }
    }
    let saved = true
    try {
      await this.persist()
    } catch {
      saved = false
    }
    if (!logged && !saved) {
      throw new AppError(500, 'revocation-not-persisted', '撤销已在本次运行中生效，但未能写入磁盘；重启 Host 前请检查数据目录。')
    }
    return { device: publicDevice(device), cascaded: cascaded.map(item => item.id), audited }
  }
}

export interface EnrollmentRequest {
  /** base64url SPKI DER (P-256). */
  publicKey: string
  /** 1–80 characters after trim. */
  name: string
  /** Requested; defaults per listener. */
  scopes?: DeviceScope[]
  dataScope?: DataScope
  /** 'lpi1-…' */
  invitation?: string
  /** 'lpo1-…' */
  offlineCode?: string
  native?: NativeIdentityInput
  /** The phone's current network, as `gatewayHash` (link-wire) gives it. */
  gatewayHash?: string
}

/** What only the route knows about a phone's pairing request: the socket it arrived on and that QR's own budget. */
export interface NativePairingContext {
  /** The proof that the peer of this socket is on the Mac's network: the network to remember if it pairs, else false. */
  nearby(gatewayHash: Uint8Array): Promise<string | false>
  /** Spends this QR's budget. Reached only by a request that would ask for a new confirmation. */
  budget(): void
  /** A contention's audit record could not be written; the burn went ahead. */
  auditFailed(): void
}

/**
 * One pairing sheet: every QR it showed shares one claim, so a second set of keys on any of them ends all of them. The
 * sheet rotates its QR and the previous one stays valid, because the first scan can sit behind a system prompt.
 */
interface NativeSession {
  /** Every QR of this sheet, by code hash, with its invitation. */
  codes: Map<string, string>
  claim?: {
    invitationId: string
    /** Connection and verification keys: the same phone retrying is not contention. */
    keysHash: string
    enrollmentId: string
    /** Its enrollment is not recorded yet: the audit record and the confirmation request are still running. */
    inFlight: boolean
  }
  burned: boolean
  /** The sheet closed: its QRs are dead and nothing more can burn it. */
  closed: boolean
  closedAt?: number
  /** The phone it paired, for the question that follows. Outlives the enrollment: the sheet waits for an answer. */
  completed?: { deviceId: string; name: string }
  /** When the sheet last asked. A sheet that stops asking has gone, whether or not it could say so. */
  polled?: number
}

interface Enrollment {
  id: string
  status: EnrollmentView['status']
  fingerprint: string
  nonce: string
  expiresAt: number
  connection: ConnectionContext
  publicKeyDer: Buffer
  name: string
  scopes: DeviceScope[]
  dataScope: DataScope
  method: 'lpc' | 'offline' | 'invitation'
  /** Nothing confirmed this: see `firstUse`. */
  firstUse?: true
  inviterDeviceId?: string
  invitationId?: string
  confirmationId?: string
  hashDisplay?: string
  /** What the Host computer's system sheet shows; it names the fingerprint the person compares. */
  reason?: string
  failures: number
  legacyDeviceId?: string
  completing: boolean
  native?: NativeRegistrationIdentity
  reservedNativeId?: string
  /** Set when this enrollment's QR was contended: a completion still under way removes the device it just made. */
  contended?: boolean
  completedAt?: number
  /** The network the proximity proof named, remembered only once this phone is actually paired. */
  network?: string
  session?: NativeSession
}

interface Invitation {
  id: string
  codeHash: string
  scopes: DeviceScope[]
  expiresAt: number
  /** The only listener and origin it can be used on. */
  listener: ListenerClass
  origin: string
  inviterDeviceId?: string
  inviterName?: string
}

async function readOfflineTickets(directory: string): Promise<OfflineTicket[]> {
  let text: string
  try {
    text = await readFile(join(directory, OFFLINE_FILE), 'utf8')
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return []
    throw corrupt(OFFLINE_FILE, codeOf(error) ?? '读取失败')
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw corrupt(OFFLINE_FILE, 'JSON 格式无效')
  }
  const parsed = offlineFile.safeParse(raw)
  if (!parsed.success) throw corrupt(OFFLINE_FILE, '格式无效')
  return parsed.data.tickets
}

async function writeOfflineTickets(directory: string, tickets: OfflineTicket[]): Promise<void> {
  await writeAtomic(defaultFs, directory, OFFLINE_FILE, { version: 1, tickets })
}

/**
 * One-time offline enrollment code, written while the Host is stopped (CLI). It relies on no malicious process of the
 * same user running at that moment.
 */
export async function createOfflineTicket(
  authDirectory: string,
  options: { now?: () => number } = {},
): Promise<{ code: string; expiresAt: number; ticketId: string }> {
  const now = (options.now ?? Date.now)()
  await preparePrivateDirectory(authDirectory)
  const tickets = (await readOfflineTickets(authDirectory)).filter(ticket => ticket.expiresAt > now)
  const code = randomCode('lpo1')
  const ticket: OfflineTicket = {
    id: randomId('chl'),
    codeHash: sha256Hex(code),
    expiresAt: now + OFFLINE_TICKET_LIFETIME,
    scopesProfile: 'offline',
  }
  await writeOfflineTickets(authDirectory, [...tickets, ticket].slice(-MAX_OFFLINE_TICKETS))
  return { code, expiresAt: ticket.expiresAt, ticketId: ticket.id }
}

/**
 * Device enrollment. On host.sock: local confirmation, or an offline code. On every other listener: an invitation issued
 * for that listener, still confirmed locally; no offline code. Pending enrollments and invitations live in memory only.
 */
export class EnrollmentService {
  private readonly hostId: string
  private readonly devices: DeviceStore
  private readonly presence: PresenceService
  private readonly audit: AuditLog
  private readonly directory: string
  private readonly now: () => number
  private readonly enrollments = new Map<string, Enrollment>()
  private readonly invitations = new Map<string, Invitation>()
  /** Pairing sheets, by the code hash of each of their QRs. */
  private readonly nativeSessions = new Map<string, NativeSession>()
  /** The sheet new QRs join. */
  private currentSession: NativeSession | undefined
  /** What the Mac's sheet follows, by invitation; kept past expiry so it can still say what happened. */
  private readonly nativeSheets = new Map<string, { expiresAt: number; offNetwork: boolean; session: NativeSession }>()
  private offlineQueue: Promise<unknown> = Promise.resolve()
  private invitationQueue: Promise<unknown> = Promise.resolve()
  /** The enrollment taking the first use while its request is still being recorded (see `firstUse`). */
  private firstUseClaim: string | undefined

  constructor(options: {
    hostId: string
    devices: DeviceStore
    presence: PresenceService
    audit: AuditLog
    directory: string
    now?: () => number
  }) {
    this.hostId = options.hostId
    this.devices = options.devices
    this.presence = options.presence
    this.audit = options.audit
    this.directory = options.directory
    this.now = options.now ?? Date.now
    this.devices.onRevoked(deviceId => this.dropInvitedBy(deviceId))
  }

  /** A revoked inviter's unused invitations die, and its pending or approved enrollments are cancelled. */
  private dropInvitedBy(deviceId: string): void {
    for (const [id, invitation] of this.invitations) if (invitation.inviterDeviceId === deviceId) this.invitations.delete(id)
    for (const enrollment of this.enrollments.values()) {
      if (enrollment.inviterDeviceId !== deviceId || (enrollment.status !== 'pending' && enrollment.status !== 'approved')) continue
      enrollment.status = 'cancelled'
      if (enrollment.confirmationId) this.presence.cancel(enrollment.confirmationId)
      void this.failed(enrollment.id, 'cancelled', { listener: 'host' })
    }
  }

  /**
   * The desktop's own first connection, on the Host's socket before any device was ever enrolled here: there is nothing
   * yet to protect from it, so it needs no confirmation. The device store remembers that a device was enrolled after
   * the records themselves are pruned, so revoking or outliving every device does not reopen this, and one such
   * enrollment at a time can be open. Every later device goes through the confirmation.
   */
  private firstUse(connection: ConnectionContext): boolean {
    return (
      connection.listener === 'unix'
      && !this.devices.everEnrolled()
      && this.firstUseClaim === undefined
      && ![...this.enrollments.values()].some(item => item.firstUse && (item.status === 'approved' || item.status === 'completed'))
    )
  }

  async info(connection: ConnectionContext, legacyName?: string): Promise<EnrollmentInfo> {
    const availability = await this.presence.availability()
    const local = isLocalListener(connection.listener)
    const now = this.now()
    const offline = local && (await readOfflineTickets(this.directory).catch(() => [])).some(ticket => ticket.expiresAt > now)
    return {
      hostId: this.hostId,
      listener: connection.listener,
      presence: availability.status === 'available' ? { status: 'available' } : { status: 'unavailable', message: availability.message },
      ...(local ? { firstDevice: this.firstUse(connection) } : {}),
      invitationRequired: !local,
      offlineCodeAccepted: offline,
      ...(connection.listener === 'loopback-tcp' && legacyName ? { legacy: { name: legacyName } } : {}),
    }
  }

  private prune(): void {
    const now = this.now()
    for (const [id, enrollment] of this.enrollments) {
      if (now > enrollment.expiresAt + ENROLLMENT_LIFETIME) this.enrollments.delete(id)
    }
    for (const [id, invitation] of this.invitations) if (now > invitation.expiresAt) this.invitations.delete(id)
    for (const session of new Set(this.nativeSessions.values()))
      if (session.polled !== undefined && !session.closed && !session.burned && now - session.polled > NATIVE_SHEET_SILENCE)
        this.closeSession(session)
    for (const [hash, session] of this.nativeSessions) {
      const sheet = this.nativeSheets.get(session.codes.get(hash) ?? '')
      const live = sheet !== undefined && now <= sheet.expiresAt && !session.closed && !session.burned
      if (!live && (!session.claim || (!session.claim.inFlight && !this.enrollments.has(session.claim.enrollmentId))))
        this.nativeSessions.delete(hash)
    }
    for (const [id, sheet] of this.nativeSheets) {
      const session = sheet.session
      // A sheet still asking about its phone keeps what it asks about, however long the person takes.
      if (session.polled !== undefined && !session.closed && !session.burned) continue
      if (now > Math.max(sheet.expiresAt, session.closedAt ?? 0) + NATIVE_SHEET_MEMORY) this.nativeSheets.delete(id)
    }
  }

  private assertPendingRoom(): void {
    if (
      [...this.enrollments.values()].filter(item => item.status === 'pending' || item.status === 'approved').length
      >= MAX_PENDING_ENROLLMENTS
    )
      throw new AppError(429, 'rate-limited', '请求过于频繁，请稍后再试', { retryAfter: 20 })
  }

  /** The legacy cookie (loopback only) lets the new device take over the old name and retires the old record. */
  async create(
    request: EnrollmentRequest,
    connection: ConnectionContext,
    legacy?: PresentedCredential,
    pairing?: NativePairingContext,
  ): Promise<EnrollmentView> {
    this.prune()
    // A phone gets past this only after its claim is checked: another QR holder must not be able to fill it.
    if (!isNativeListener(connection.listener)) this.assertPendingRoom()
    if (!request || typeof request !== 'object') throw new AppError(400, 'invalid-request', '连接请求无效')
    const { der } = parseP256Spki(request.publicKey)
    let native: NativeRegistrationIdentity | undefined
    if (!isNativeListener(connection.listener) && request.native)
      throw new AppError(400, 'native-identity-invalid', '此入口不接受原生设备身份')
    if (isNativeListener(connection.listener)) {
      // The result is fixed, so a phone asking for anything is not asking this Host.
      if (request.scopes !== undefined || request.dataScope !== undefined)
        throw new AppError(400, 'scope-not-grantable', '该权限在此连接方式下不可授予')
    } else if (request.gatewayHash !== undefined) throw new AppError(400, 'invalid-request', '连接请求无效')
    const action = isNativeListener(connection.listener) ? 'device.enroll-native' : 'device.enroll'
    const legacyDevice =
      connection.listener === 'loopback-tcp' && legacy?.kind === 'legacy-cookie' ? this.devices.legacyMatch(legacy.value) : undefined
    // A migrated name is checked like any other before it reaches the confirmation dialog. A takeover keeps its name
    // unnumbered: the record it replaces is the one holding that name.
    const name =
      legacyDevice && (typeof request.name !== 'string' || request.name.trim() === '')
        ? legacyName(legacyDevice.name)
        : legacyDevice
          ? deviceName(request.name)
          : this.devices.distinctName(deviceName(request.name))
    if (request.scopes !== undefined && (!Array.isArray(request.scopes) || request.scopes.some(scope => typeof scope !== 'string'))) {
      throw new AppError(400, 'invalid-scope', '未知的设备权限')
    }
    if (request.dataScope !== undefined && request.dataScope !== 'work' && request.dataScope !== 'all')
      throw new AppError(400, 'invalid-data-scope', '数据范围无效')
    const local = isLocalListener(connection.listener)
    const id = randomId('enr')
    const now = this.now()
    const nativeRequest = isNativeListener(connection.listener)
    let scopes = nativeRequest
      ? [...NATIVE_PAIRED_SCOPES]
      : request.scopes
        ? normalizeScopes(request.scopes)
        : local
          ? [...ALL_SCOPES]
          : [...DEFAULT_REMOTE_SCOPES]
    let dataScope: DataScope = nativeRequest ? 'all' : (request.dataScope ?? (local ? 'all' : 'work'))
    requireGrantable(scopes, connection.listener)
    let method: Enrollment['method'] = 'lpc'
    let invitation: Invitation | undefined
    let ticket: OfflineTicket | undefined
    let session: NativeSession | undefined
    let keysHash = ''
    let network: string | undefined

    if (request.offlineCode !== undefined) {
      // Offline codes skip the local confirmation, so only the desktop app's socket takes them.
      if (!local) throw new AppError(403, 'offline-code-invalid', '离线连接码无效或已过期')
      ticket = await this.findOfflineTicket(request.offlineCode)
      if (!ticket) throw new AppError(403, 'offline-code-invalid', '离线连接码无效或已过期')
      method = 'offline'
      scopes = [...ALL_SCOPES]
      dataScope = 'all'
    } else if (!local) {
      // Without an invitation no listener but host.sock can make the Host show a confirmation.
      if (request.invitation === undefined)
        throw new AppError(403, 'invitation-required', '新设备需要一次性邀请：请在运行 Latch 的电脑上用 Latch 桌面端生成')
      if (nativeRequest) {
        // Relay and carrier paths never reach this: their knocks do not accept a QR.
        if (connection.listener !== 'native-direct' || !pairing) throw notNearby()
        if (!request.native) throw new AppError(400, 'native-identity-required', '原生配对必须提供独立的连接密钥与验证密钥')
        const identity = validateNativeIdentity(request.native, der)
        const secret = await nativeKnockSecret(
          nodeCrypto,
          Buffer.from(sha256Hex(request.invitation as string), 'hex'),
          der,
          Buffer.from(identity.verificationKey, 'base64url'),
        )
        native = { ...identity, knockHash: sha256Hex(secret) }
        secret.fill(0)
        keysHash = sha256Hex(`${der.toString('base64url')}\n${identity.verificationKey}`)
        const codeHash = sha256Hex(String(request.invitation))
        session = this.nativeSessions.get(codeHash)
        if (!session) throw new AppError(403, 'invitation-invalid', '配对码无效或已过期')
        // The same keys get their own enrollment back, for free: a retry needs no proof and spends nothing.
        const own = this.ownEnrollment(session, keysHash)
        if (own) return own
        const proof = await this.proveNearby(request, session, codeHash, pairing!)
        network = proof
        // Other keys that passed the gate burn the sheet here, before anything a QR holder could have spent.
        const held = await this.checkClaim(session, keysHash, connection, pairing!)
        if (held) return held
        this.assertPendingRoom()
        pairing!.budget()
      }
      invitation = this.findInvitation(request.invitation, connection)
      if (!invitation) throw new AppError(403, 'invitation-invalid', '配对码无效或已过期')
      if (!nativeRequest) {
        if (!request.scopes) scopes = scopes.filter(scope => invitation!.scopes.includes(scope))
        if (scopes.some(scope => !invitation!.scopes.includes(scope)))
          throw new AppError(400, 'scope-not-grantable', '该权限在此连接方式下不可授予')
      }
      // A confirmation that cannot start (a full-access session holds it back, or the component is unavailable) must not
      // spend the invitation: the phone is told to try again once the session ends, with the same code. Checked only for
      // a valid invitation, so nobody without one learns that a session runs.
      await this.presence.assertCanRequest(action)
      if (session) {
        const held = await this.checkClaim(session, keysHash, connection, pairing!)
        if (held) return held
      }
      // Single use: consumed by the first create that passes validation and may ask for the confirmation. Another
      // create may have taken it during the check.
      if (this.findInvitation(request.invitation, connection) !== invitation) {
        if (session) {
          const held = await this.checkClaim(session, keysHash, connection, pairing!)
          if (held) return held
        }
        throw new AppError(403, 'invitation-invalid', '配对码无效或已过期')
      }
      this.invitations.delete(invitation.id)
      if (session) session.claim = { invitationId: invitation.id, keysHash, enrollmentId: id, inFlight: true }
      method = 'invitation'
    }
    const firstUse = method === 'lpc' && this.firstUse(connection)
    // Taken before the first await: a second request on the socket in the meantime goes through the confirmation.
    if (firstUse) this.firstUseClaim = id
    const releaseFirstUse = () => {
      if (this.firstUseClaim === id) this.firstUseClaim = undefined
    }
    if (firstUse)
      try {
        await this.presence.assertNotHeldBack('device.enroll')
      } catch (error) {
        releaseFirstUse()
        throw error
      }
    const fingerprint = deviceFingerprint(der)
    const actor: AuditActor = { listener: connection.listener, via: 'http' }
    try {
      await this.audit.append({
        action: 'device.enroll.requested',
        actor,
        target: id,
        detail: {
          enrollmentId: id,
          listener: connection.listener,
          fingerprint: fingerprint.replace(/ /gu, ''),
          scopes,
          ...(invitation ? { invitationId: invitation.id } : {}),
        },
      })
    } catch (error) {
      releaseFirstUse()
      if (session) session.claim = undefined
      this.restoreInvitation(invitation, session)
      throw error
    }
    const enrollment: Enrollment = {
      id,
      status: 'pending',
      fingerprint,
      nonce: randomNonce(),
      expiresAt: now + ENROLLMENT_LIFETIME,
      connection: { ...connection },
      publicKeyDer: der,
      name,
      scopes,
      dataScope,
      method,
      failures: 0,
      completing: false,
      ...(native ? { native, reservedNativeId: randomId('dev') } : {}),
      ...(network ? { network } : {}),
      ...(session ? { session } : {}),
      ...(invitation?.inviterDeviceId ? { inviterDeviceId: invitation.inviterDeviceId } : {}),
      ...(invitation ? { invitationId: invitation.id } : {}),
      ...(legacyDevice ? { legacyDeviceId: legacyDevice.id } : {}),
    }

    if (ticket) {
      await this.consumeOfflineTicket(ticket, actor)
      enrollment.status = 'approved'
      this.enrollments.set(id, enrollment)
      return this.view(enrollment, true)
    }

    if (firstUse) {
      enrollment.firstUse = true
      enrollment.status = 'approved'
      enrollment.expiresAt = Math.max(enrollment.expiresAt, now + ENROLLMENT_SIGNING_WINDOW)
      this.enrollments.set(id, enrollment)
      // The stored enrollment holds it from here.
      releaseFirstUse()
      return this.view(enrollment, true)
    }

    const lines = nativeRequest
      ? [
          { label: '设备名称', value: name },
          { label: '请求的权限', value: scopes.map(scope => SCOPE_LABELS[scope]).join('、') },
          { label: '数据范围', value: '全部' },
        ]
      : [
          { label: '设备名称', value: name },
          { label: '设备指纹', value: fingerprint },
          { label: '来源地址', value: sourceText(connection) },
          { label: '连接方式', value: `${LISTENER_LABELS[connection.listener]} · ${connection.origin}` },
          { label: '请求的权限', value: scopes.map(scope => SCOPE_LABELS[scope]).join('、') },
          { label: '数据范围', value: dataScope === 'all' ? '全部' : '工作' },
          ...(invitation ? [{ label: '邀请来源', value: invitation.inviterName ?? '命令行' }] : []),
        ]
    const warnings = nativeRequest
      ? ['只有在你正在连接这台手机时才确认。']
      : ['只有在你正在连接这台设备、并且两边显示的指纹完全一致时才确认。']
    if (scopes.includes('admin')) warnings.push('该设备将可以管理此 Host（模型服务、插件、项目和其他设备）。')
    const binding = paramsHash(action, {
      enrollmentId: id,
      publicKey: request.publicKey,
      ...(native ? { certificateHash: sha256Hex(native.certificate), verificationKeyHash: sha256Hex(native.verificationKey) } : {}),
      name,
      scopes,
      dataScope,
      listener: connection.listener,
      origin: connection.origin,
      ...(invitation ? { invitationId: invitation.id } : {}),
    })
    let confirmation
    try {
      confirmation = await this.presence.request({
        action,
        requester: { deviceName: name, listener: connection.listener, remoteAddress: local ? LOCAL_SOURCE : connection.remoteAddress },
        subject: enrollmentSubject(connection.listener, name),
        lines,
        warnings,
        paramsHash: binding,
      })
    } catch (error) {
      // These refusals come before any window is shown, so the invitation is still unspent; anything else spends it.
      if (session) session.claim = undefined
      if (UNSHOWN_PRESENCE.has(String(codeOf(error)))) this.restoreInvitation(invitation, session)
      await this.failed(id, 'cancelled', actor)
      throw error
    }
    enrollment.confirmationId = confirmation.id
    enrollment.hashDisplay = confirmation.hashDisplay
    enrollment.reason = confirmation.reason
    this.enrollments.set(id, enrollment)
    if (session?.claim) {
      session.claim.inFlight = false
      // Another device presented a QR of this sheet, or the sheet closed, while the confirmation was being asked for.
      if (session.burned || session.closed) {
        enrollment.status = 'cancelled'
        enrollment.contended = session.burned
        this.presence.cancel(confirmation.id)
        await this.failed(id, 'cancelled', actor)
        throw session.burned ? contended() : new AppError(403, 'invitation-invalid', '配对码无效或已过期')
      }
    }
    void confirmation.settled.then(async outcome => {
      if (enrollment.status !== 'pending') return
      if (outcome.result === 'approved') {
        try {
          this.presence.consume(confirmation.id, { action, paramsHash: binding })
          if (enrollment.inviterDeviceId !== undefined && !this.devices.isActive(enrollment.inviterDeviceId))
            throw new Error('inviter revoked')
          const now = this.now()
          enrollment.status = now > enrollment.expiresAt ? 'expired' : 'approved'
          // The page reads the new deadline from its next poll.
          if (enrollment.status === 'approved') enrollment.expiresAt = Math.max(enrollment.expiresAt, now + ENROLLMENT_SIGNING_WINDOW)
          return
        } catch {
          enrollment.status = 'cancelled'
        }
      } else {
        enrollment.status = outcome.result === 'denied' ? 'denied' : outcome.result === 'timeout' ? 'expired' : 'cancelled'
      }
      await this.failed(id, enrollment.status === 'denied' ? 'denied' : enrollment.status === 'expired' ? 'expired' : 'cancelled', actor)
    })
    return this.view(enrollment, true)
  }

  private async failed(
    enrollmentId: string,
    reason: 'denied' | 'expired' | 'cancelled' | 'signature' | 'commit',
    actor: AuditActor,
  ): Promise<void> {
    await this.audit
      .append({ action: 'device.enroll.failed', actor, target: enrollmentId, detail: { enrollmentId, reason } })
      .catch(() => {})
  }

  /**
   * Puts back an invitation that a create took but that showed no confirmation, so the same link can be submitted again.
   * It keeps its own expiry, and the inviter is checked again when it is used.
   */
  private restoreInvitation(invitation: Invitation | undefined, session?: NativeSession): void {
    if (!invitation || invitation.expiresAt < this.now() || this.invitations.size >= MAX_INVITATIONS) return
    // A closed sheet or a contended QR stays dead.
    if (session?.burned || session?.closed || (session && !this.nativeSheets.has(invitation.id))) return
    if (invitation.inviterDeviceId !== undefined && !this.devices.isActive(invitation.inviterDeviceId)) return
    this.invitations.set(invitation.id, invitation)
  }

  /**
   * The proximity gate. Only a code that is live or spent gets here, so nobody without a QR reaches the network helper.
   * A refusal spends nothing another phone needs, and anything short of a proof fails closed.
   */
  private async proveNearby(
    request: EnrollmentRequest,
    session: NativeSession,
    codeHash: string,
    pairing: NativePairingContext,
  ): Promise<string> {
    const gateway =
      typeof request.gatewayHash === 'string' && /^[a-f0-9]{64}$/u.test(request.gatewayHash)
        ? Buffer.from(request.gatewayHash, 'hex')
        : undefined
    const proof = gateway ? await pairing.nearby(gateway).catch(() => false as const) : false
    if (proof === false) {
      const sheet = this.nativeSheets.get(session.codes.get(codeHash) ?? '')
      if (sheet) sheet.offNetwork = true
      throw notNearby()
    }
    return proof
  }

  /** This phone's own enrollment, when these keys hold the sheet's claim. No claim, or other keys: undefined. */
  private ownEnrollment(session: NativeSession, keysHash: string): EnrollmentView | undefined {
    const claim = session.claim
    if (session.burned || !claim || !constantTimeEqualHex(claim.keysHash, keysHash)) return undefined
    const enrollment = this.enrollments.get(claim.enrollmentId)
    // Its own first request is still asking for the confirmation; the phone asks again.
    if (!enrollment && claim.inFlight) throw new AppError(409, 'enrollment-pending', '本机尚未确认')
    if (!enrollment) return undefined
    return this.claimOpen(enrollment) ? this.view(enrollment, true) : undefined
  }

  /** The same keys get their own enrollment back; other keys burn the sheet. Nothing claimed: undefined. */
  private async checkClaim(
    session: NativeSession,
    keysHash: string,
    connection: ConnectionContext,
    pairing: NativePairingContext,
  ): Promise<EnrollmentView | undefined> {
    if (session.burned) throw contended()
    const own = this.ownEnrollment(session, keysHash)
    if (own) return own
    const claim = session.claim
    if (!claim) return undefined
    const enrollment = this.enrollments.get(claim.enrollmentId)
    if (!claim.inFlight && (!enrollment || !this.claimOpen(enrollment))) {
      // Denied, cancelled or timed out: nothing to burn, and the sheet's other QR is free. A device past its window stays.
      if (session.completed) throw new AppError(403, 'invitation-invalid', '配对码无效或已过期')
      session.claim = undefined
      return undefined
    }
    // The sheet was closed, which counts as the person's answer: nothing more burns it.
    if (session.closed) throw new AppError(403, 'invitation-invalid', '配对码无效或已过期')
    await this.burn(session, connection, pairing)
    throw contended()
  }

  /**
   * Two sets of keys presented one sheet's QRs, and the Host cannot tell which is the person's: everything from that
   * sheet ends. Only ever takes privilege away, so a failed audit record does not stop it.
   */
  private async burn(session: NativeSession, connection: ConnectionContext, pairing: NativePairingContext): Promise<void> {
    session.burned = true
    if (this.currentSession === session) this.currentSession = undefined
    for (const id of session.codes.values()) this.invitations.delete(id)
    const actor: AuditActor = { listener: connection.listener, via: 'http' }
    const claim = session.claim!
    let cancelled = 0,
      removed = 0
    const enrollment = this.enrollments.get(claim.enrollmentId)
    if (enrollment) {
      enrollment.contended = true
      if (enrollment.status === 'pending' || enrollment.status === 'approved') {
        enrollment.status = 'cancelled'
        if (enrollment.confirmationId) this.presence.cancel(enrollment.confirmationId)
        cancelled += 1
        await this.failed(enrollment.id, 'cancelled', actor)
      } else if (enrollment.status === 'completed' && enrollment.reservedNativeId) {
        const device = this.devices.get(enrollment.reservedNativeId)
        if (device && device.status !== 'revoked' && this.now() - Date.parse(device.createdAt) <= NATIVE_CONTENTION_WINDOW) {
          if (!(await this.removeUnwanted(device.id, actor))) pairing.auditFailed()
          removed += 1
        }
      }
    }
    await this.audit
      .append({
        action: 'pairing.contended',
        actor,
        target: claim.invitationId,
        detail: { invitationId: claim.invitationId, cancelled, removed },
      })
      .catch(() => pairing.auditFailed())
  }

  private sessionContinues(session: NativeSession): boolean {
    if (session.closed || session.burned || session.completed) return false
    const claim = session.claim
    const enrollment = claim && this.enrollments.get(claim.enrollmentId)
    if (claim?.inFlight || (enrollment && this.claimOpen(enrollment))) return true
    return [...session.codes.values()].some(id => this.invitations.has(id))
  }

  /** A device that should not have been paired: it goes at once, and the Mac stays open for no tombstone of its. */
  private async removeUnwanted(deviceId: string, actor: AuditActor): Promise<boolean> {
    const { audited } = await this.devices.revoke(deviceId, 'manual', actor)
    const revocation = this.devices.nativeRevocations().find(item => item.id === deviceId)
    if (revocation) await this.devices.acknowledgeNativeRevocation(deviceId, revocation.revokedAt).catch(() => {})
    return audited
  }

  /** Whether a spent QR still answers its phone: while confirming, while signing, and briefly after completing. */
  private claimOpen(enrollment: Enrollment): boolean {
    const now = this.now()
    if (enrollment.status === 'pending' || enrollment.status === 'approved') return now <= enrollment.expiresAt
    return (
      enrollment.status === 'completed'
      && enrollment.completedAt !== undefined
      && now - enrollment.completedAt <= NATIVE_CONTENTION_WINDOW
      && this.devices.get(enrollment.reservedNativeId ?? '')?.status === 'active'
    )
  }

  /**
   * The knocks a sheet's QRs open: unused ones, and while a phone holds the claim every QR of that sheet, so a second phone
   * can still present its own. A closed sheet opens only the claimed QR, for its own phone to finish. Never on relay or
   * carrier paths.
   */
  nativeInvitations(): Array<{ id: string; kind: 'pairing'; knockKey: Uint8Array }> {
    this.prune()
    const usable = (inviter?: string) => !inviter || this.devices.isActive(inviter)
    const open = new Map<string, string>()
    for (const item of this.invitations.values())
      if (isNativeListener(item.listener) && usable(item.inviterDeviceId)) open.set(item.codeHash, item.id)
    for (const [hash, session] of this.nativeSessions) {
      const claim = session.claim
      if (session.burned || !claim) continue
      const enrollment = this.enrollments.get(claim.enrollmentId)
      if (enrollment ? !this.claimOpen(enrollment) || !usable(enrollment.inviterDeviceId) : !claim.inFlight) continue
      const id = session.codes.get(hash)
      if (id && (!session.closed || id === claim.invitationId)) open.set(hash, id)
    }
    return Array.from(open, ([hash, id]) => ({ id, kind: 'pairing' as const, knockKey: Buffer.from(hash, 'hex') }))
  }

  /** A QR the sheet still shows, or a phone it let in that has not finished. */
  nativePairingOpen(): boolean {
    return this.nativeInvitations().length > 0
  }

  /** Whether a phone could finish pairing now: a full-access session holds the confirmation back. */
  assertCanPair(): Promise<void> {
    return this.presence.assertCanRequest('device.enroll-native')
  }

  /**
   * Closing the sheet: all its QRs die, whichever one is named, and a pairing that has not completed ends with them.
   * The person's answer comes after completion, so nothing unfinished is left to arrive unasked.
   */
  revokeNativeInvitation(id: string): void {
    this.prune()
    const session = this.nativeSheets.get(id)?.session
    if (session) this.closeSession(session)
    else this.invitations.delete(id)
  }

  private closeSession(session: NativeSession): void {
    if (session.closed) return
    session.closed = true
    session.closedAt = this.now()
    if (this.currentSession === session) this.currentSession = undefined
    for (const code of session.codes.values()) this.invitations.delete(code)
    const enrollment = session.claim && this.enrollments.get(session.claim.enrollmentId)
    if (enrollment?.status === 'pending' || enrollment?.status === 'approved') {
      enrollment.status = 'cancelled'
      if (enrollment.confirmationId) this.presence.cancel(enrollment.confirmationId)
      void this.failed(enrollment.id, 'cancelled', { listener: 'host' })
    }
  }

  /**
   * The person said the phone in their hand is not connected: the device goes, and the sheet with it. Answers only for
   * what it did: a sheet that no longer knows its device says so, and the caller removes it by ID.
   */
  async rejectNativePairing(id: string, actor: AuditActor): Promise<{ audited: boolean }> {
    const session = this.nativeSheets.get(id)?.session
    if (!session?.completed) throw new AppError(404, 'pairing-device-unknown', '找不到这次连接的设备，请在设备列表里移除它')
    this.closeSession(session)
    const device = this.devices.get(session.completed.deviceId)
    if (!device) throw new AppError(404, 'device-not-found', '找不到该设备')
    if (device.status === 'revoked') return { audited: true }
    return { audited: await this.removeUnwanted(device.id, actor) }
  }

  /** What the Mac's sheet shows for one of its QRs. Names only what the phone itself reported, for the sheet to escape. */
  nativePairingStatus(id: string): NativePairingStatus {
    this.prune()
    const sheet = this.nativeSheets.get(id)
    if (!sheet) return { state: 'expired', offNetwork: false }
    const session = sheet.session,
      base = { offNetwork: sheet.offNetwork }
    if (!session.closed) session.polled = this.now()
    if (session.burned) return { ...base, state: 'contended' }
    if (session.completed) return { ...base, state: 'done', device: session.completed.name, deviceId: session.completed.deviceId }
    let claim = session.claim
    const enrollment = claim && this.enrollments.get(claim.enrollmentId)
    if (claim?.inFlight && !enrollment) return { ...base, state: 'confirming' }
    if (claim && !enrollment) {
      // Its record is gone: it was refused long ago, and is no longer confirming anything.
      session.claim = undefined
      claim = undefined
    }
    const unused = session.closed || this.now() > sheet.expiresAt ? 'expired' : this.invitations.has(id) ? 'ready' : 'expired'
    if (!claim || !enrollment) return { ...base, state: unused }
    const device = { device: enrollment.name }
    switch (enrollment.status) {
      case 'pending':
        return { ...base, ...device, state: 'confirming' }
      case 'approved':
        return { ...base, ...device, state: 'approved' }
      case 'expired':
        return claim.invitationId === id ? { ...base, ...device, state: 'timeout' } : { ...base, state: unused }
      default:
        return claim.invitationId === id ? { ...base, ...device, state: 'cancelled' } : { ...base, state: unused }
    }
  }

  /**
   * What an invitation lets its holder ask for, `admin` among it, so the page can say so before the person acts and ask
   * for no more. Spends nothing, and tells the holder nothing a request would not: asking for more than an invitation
   * grants is refused unspent.
   */
  invitationOffer(code: unknown, connection: ConnectionContext): EnrollmentInvitationOffer {
    this.prune()
    const invitation = this.findInvitation(code, connection)
    if (!invitation) throw new AppError(403, 'invitation-invalid', '配对码无效或已过期')
    return { admin: invitation.scopes.includes('admin'), scopes: [...invitation.scopes] }
  }

  /** An unexpired invitation issued for exactly this listener and origin, from an inviter that is still active. */
  private findInvitation(code: unknown, connection: ConnectionContext): Invitation | undefined {
    if (typeof code !== 'string' || !/^lpi1-[A-Z2-7]{26}$/u.test(code)) return undefined
    const hash = sha256Hex(code)
    const now = this.now()
    let found: Invitation | undefined
    for (const invitation of this.invitations.values()) {
      if (constantTimeEqualHex(invitation.codeHash, hash) && invitation.expiresAt >= now) found = invitation
    }
    if (
      !found
      || !(found.listener === connection.listener || (isNativeListener(found.listener) && isNativeListener(connection.listener)))
      || found.origin !== connection.origin
    )
      return undefined
    if (found.inviterDeviceId && !this.devices.isActive(found.inviterDeviceId)) return undefined
    return found
  }

  private async findOfflineTicket(code: unknown): Promise<OfflineTicket | undefined> {
    if (typeof code !== 'string' || !/^lpo1-[A-Z2-7]{26}$/u.test(code)) return undefined
    const hash = sha256Hex(code)
    const now = this.now()
    let found: OfflineTicket | undefined
    for (const ticket of await readOfflineTickets(this.directory)) {
      if (constantTimeEqualHex(ticket.codeHash, hash) && ticket.expiresAt >= now) found = ticket
    }
    return found
  }

  private consumeOfflineTicket(ticket: OfflineTicket, actor: AuditActor): Promise<void> {
    const run = this.offlineQueue.then(async () => {
      const tickets = await readOfflineTickets(this.directory)
      if (!tickets.some(item => item.id === ticket.id)) throw new AppError(403, 'offline-code-invalid', '离线连接码无效或已过期')
      await this.audit.append({
        action: 'offline.ticket.consumed',
        actor,
        stepup: 'offline',
        target: ticket.id,
        detail: { ticketId: ticket.id },
      })
      const now = this.now()
      await writeOfflineTickets(
        this.directory,
        tickets.filter(item => item.id !== ticket.id && item.expiresAt > now),
      )
    })
    this.offlineQueue = run.catch(() => {})
    return run
  }

  private lookup(id: unknown, connection: ConnectionContext): Enrollment {
    const enrollment = typeof id === 'string' ? this.enrollments.get(id) : undefined
    if (!enrollment) throw new AppError(404, 'enrollment-not-found', '找不到这个连接请求')
    if (
      !(
        enrollment.connection.listener === connection.listener
        || (isNativeListener(enrollment.connection.listener) && isNativeListener(connection.listener))
      )
      || enrollment.connection.origin !== connection.origin
    ) {
      throw new AppError(409, 'listener-mismatch', '请在发起连接的同一页面完成连接')
    }
    if ((enrollment.status === 'pending' || enrollment.status === 'approved') && this.now() > enrollment.expiresAt) {
      enrollment.status = 'expired'
      if (enrollment.confirmationId) this.presence.cancel(enrollment.confirmationId)
      void this.failed(enrollment.id, 'expired', { listener: connection.listener, via: 'http' })
    }
    return enrollment
  }

  private view(enrollment: Enrollment, withNonce: boolean): EnrollmentView {
    return {
      id: enrollment.id,
      status: enrollment.status,
      fingerprint: enrollment.fingerprint,
      ...(withNonce ? { nonce: enrollment.nonce } : {}),
      expiresAt: iso(enrollment.expiresAt),
      ...(enrollment.hashDisplay ? { hashDisplay: enrollment.hashDisplay } : {}),
      ...(enrollment.reason ? { reason: enrollment.reason } : {}),
      ...(enrollment.contended ? { contended: true } : {}),
      scopes: [...enrollment.scopes],
      dataScope: enrollment.dataScope,
    }
  }

  /** Enrollments still waiting, for the desktop's pairing panel; the fingerprint is the code both screens show. */
  waiting(): WaitingEnrollmentView[] {
    const now = this.now()
    const views: WaitingEnrollmentView[] = []
    for (const item of this.enrollments.values()) {
      if ((item.status !== 'pending' && item.status !== 'approved') || now > item.expiresAt) continue
      views.push({
        id: item.id,
        name: item.name,
        fingerprint: item.fingerprint,
        listener: item.connection.listener,
        method: item.method,
        status: item.status,
        expiresAt: iso(item.expiresAt),
        ...(item.invitationId ? { invitationId: item.invitationId } : {}),
        ...(item.reason ? { reason: item.reason } : {}),
        scopes: [...item.scopes],
        dataScope: item.dataScope,
      })
    }
    return views
  }

  status(id: string, connection: ConnectionContext): EnrollmentView {
    return this.view(this.lookup(id, connection), false)
  }

  nativeStatus(id: string, connection: ConnectionContext): EnrollmentView {
    const enrollment = this.lookup(id, connection)
    if (!enrollment.native || !isNativeListener(connection.listener)) throw unauthorized()
    return this.view(enrollment, true)
  }

  private verifyEnrollment(enrollment: Enrollment, signature: string, connection: ConnectionContext): void {
    const { key } = parseP256Spki(enrollment.publicKeyDer.toString('base64url'))
    if (verifyP256(key, `latch-enroll-v1\n${this.hostId}\n${enrollment.id}\n${enrollment.nonce}`, signature)) return
    enrollment.failures += 1
    if (enrollment.failures >= SIGNATURE_ATTEMPTS && enrollment.status !== 'completed') {
      enrollment.status = 'cancelled'
      void this.failed(enrollment.id, 'signature', { listener: connection.listener, via: 'http' })
    }
    throw new AppError(401, 'invalid-signature', '签名校验失败')
  }

  /** Reveals outer pass material only after OS approval and proof of the enrolled connection key. No device exists yet. */
  prepareNative(id: string, signature: string, connection: ConnectionContext): string {
    const enrollment = this.lookup(id, connection)
    if (
      !isNativeListener(connection.listener)
      || !enrollment.native
      || !enrollment.reservedNativeId
      || !['approved', 'completed'].includes(enrollment.status)
    )
      throw new AppError(409, 'enrollment-not-ready', '请先在 Mac 完成本机确认')
    if (enrollment.status === 'completed' && !['active', 'review'].includes(this.devices.get(enrollment.reservedNativeId)?.status ?? ''))
      throw unauthorized()
    this.verifyEnrollment(enrollment, signature, connection)
    return enrollment.reservedNativeId
  }

  async complete(
    id: string,
    signature: string,
    connection: ConnectionContext,
  ): Promise<{ device: Device; credential: string; network?: string }> {
    const enrollment = this.lookup(id, connection)
    switch (enrollment.status) {
      case 'pending':
        throw new AppError(409, 'enrollment-pending', '本机尚未确认')
      case 'denied':
        throw new AppError(403, 'enrollment-denied', '本机拒绝了此设备')
      case 'expired':
        throw new AppError(410, 'enrollment-expired', '连接请求已超时，请重新提交')
      case 'cancelled':
        throw new AppError(410, 'enrollment-cancelled', '连接请求已取消，请重新提交')
      case 'completed':
        if (enrollment.native && isNativeListener(connection.listener)) {
          const deviceId = this.prepareNative(id, signature, connection),
            device = this.devices.get(deviceId)
          if (!device) throw unauthorized()
          return { device, credential: '' }
        }
        throw new AppError(409, 'enrollment-completed', '这次连接已完成')
      case 'approved':
        break
    }
    if (enrollment.completing) throw new AppError(409, 'enrollment-pending', '本机尚未确认')
    const actor: AuditActor = { listener: connection.listener, via: 'http' }
    this.verifyEnrollment(enrollment, signature, connection)
    if (enrollment.firstUse && this.devices.everEnrolled()) {
      enrollment.status = 'cancelled'
      throw new AppError(410, 'enrollment-cancelled', '连接请求已取消，请重新提交')
    }
    enrollment.completing = true
    try {
      const result = await this.devices.create(
        {
          name: enrollment.name,
          connection: enrollment.connection,
          publicKeyDer: enrollment.publicKeyDer,
          scopes: enrollment.scopes,
          dataScope: enrollment.dataScope,
          enrollmentId: enrollment.id,
          ...(enrollment.native ? { native: enrollment.native } : {}),
          ...(enrollment.reservedNativeId ? { reservedNativeId: enrollment.reservedNativeId } : {}),
          ...(enrollment.firstUse ? { firstUse: true as const } : {}),
          pairedBy: { method: enrollment.method, ...(enrollment.inviterDeviceId ? { deviceId: enrollment.inviterDeviceId } : {}) },
        },
        actor,
        enrollment.firstUse ? 'none' : enrollment.method === 'offline' ? 'offline' : 'lpc-local',
      )
      // Burned or cancelled while the device was being written: nobody will be asked about it, so it does not stay.
      const ended = (enrollment.status as EnrollmentView['status']) === 'cancelled' || enrollment.contended
      if (ended) {
        await this.removeUnwanted(result.device.id, actor).catch(() => {})
        enrollment.status = 'cancelled'
        throw enrollment.contended ? contended() : new AppError(410, 'enrollment-cancelled', '连接请求已取消，请重新提交')
      }
      enrollment.status = 'completed'
      enrollment.completedAt = this.now()
      if (enrollment.session) enrollment.session.completed = { deviceId: result.device.id, name: enrollment.name }
      if (enrollment.legacyDeviceId)
        await this.devices
          .retireLegacy(enrollment.legacyDeviceId, { deviceId: result.device.id, listener: connection.listener, via: 'http' })
          .catch(() => {})
      return { ...result, ...(enrollment.network ? { network: enrollment.network } : {}) }
    } catch (error) {
      // The store wrote another device first, so this was no longer the first connection.
      if (error instanceof AppError && error.code === 'enrollment-cancelled') enrollment.status = 'cancelled'
      await this.failed(enrollment.id, 'commit', actor)
      throw error
    } finally {
      enrollment.completing = false
    }
  }

  cancel(id: string, connection: ConnectionContext): void {
    const enrollment = this.lookup(id, connection)
    if (enrollment.status !== 'pending' && enrollment.status !== 'approved') return
    enrollment.status = 'cancelled'
    if (enrollment.confirmationId) this.presence.cancel(enrollment.confirmationId)
    void this.failed(enrollment.id, 'cancelled', { listener: connection.listener, via: 'http' })
  }

  /**
   * Ten minutes, single use, in memory, valid on one listener and origin only: the TLS entry for a phone, or loopback
   * for a browser on this computer. The code is returned exactly once and never logged.
   */
  createInvitation(...input: Parameters<EnrollmentService['issueInvitation']>): Promise<InvitationView> {
    const operation = this.invitationQueue.then(() => this.issueInvitation(...input))
    this.invitationQueue = operation.catch(() => {})
    return operation
  }

  private async issueInvitation(
    input: { inviter?: Device; scopes?: DeviceScope[]; listener: ListenerClass; origin: string },
    actor: AuditActor,
  ): Promise<InvitationView> {
    // The Host's own listeners only: callers pass the TLS entry or the loopback origin it started with.
    if (isLocalListener(input.listener)) throw new Error('host.sock enrollment takes no invitation')
    let origin: URL | undefined
    try {
      origin = new URL(input.origin)
    } catch {
      origin = undefined
    }
    const loopback = input.listener === 'loopback-tcp'
    if (!origin || origin.protocol !== (loopback ? 'http:' : 'https:') || origin.origin !== input.origin) {
      if (loopback) throw new Error('invalid loopback origin')
      throw new AppError(409, 'tls-not-configured', '尚未配置 HTTPS 入口，无法生成手机配对码')
    }
    if (input.inviter && !this.devices.isActive(input.inviter.id)) throw unauthorized()
    const nativeInvite = isNativeListener(input.listener)
    const scopes = nativeInvite ? [...NATIVE_PAIRED_SCOPES] : input.scopes ? normalizeScopes(input.scopes) : [...DEFAULT_REMOTE_SCOPES]
    if (scopes.some(scope => !INVITABLE_SCOPES.includes(scope)))
      throw new AppError(400, 'scope-not-grantable', '该权限在此连接方式下不可授予')
    this.prune()
    if (nativeInvite) {
      // The sheet refreshes its QR every minute; the oldest beyond two dies, so a photo of it is worth nothing sooner.
      const live = [...this.invitations.values()].filter(item => isNativeListener(item.listener))
      for (const item of live.slice(0, Math.max(0, live.length - MAX_NATIVE_INVITATIONS + 1))) this.invitations.delete(item.id)
    }
    if (this.invitations.size >= MAX_INVITATIONS) throw new AppError(429, 'rate-limited', '请求过于频繁，请稍后再试', { retryAfter: 60 })
    const id = randomId('inv')
    const code = randomCode('lpi1')
    const expiresAt = this.now() + (nativeInvite ? NATIVE_INVITATION_LIFETIME : INVITATION_LIFETIME)
    await this.audit.append({
      action: 'pairing.invited',
      actor,
      target: id,
      detail: { invitationId: id, scopes, listener: input.listener },
    })
    this.invitations.set(id, {
      id,
      codeHash: sha256Hex(code),
      scopes,
      expiresAt,
      listener: input.listener,
      origin: input.origin,
      ...(input.inviter ? { inviterDeviceId: input.inviter.id, inviterName: input.inviter.name } : {}),
    })
    if (nativeInvite) {
      // A new QR joins the sheet only while that sheet is still pairing. One with no live QR left, or whose claim has ended,
      // was left behind without a word, and its phone is nothing to do with this one.
      const reusable = this.currentSession && this.sessionContinues(this.currentSession) ? this.currentSession : undefined
      if (this.currentSession && !reusable) this.closeSession(this.currentSession)
      const session: NativeSession = reusable ?? { codes: new Map(), burned: false, closed: false }
      this.currentSession = session
      session.codes.set(sha256Hex(code), id)
      this.nativeSessions.set(sha256Hex(code), session)
      this.nativeSheets.set(id, { expiresAt, offNetwork: false, session })
    }
    return { id, code, url: `${input.origin}/link/#pair=${code}`, scopes, expiresAt: iso(expiresAt) }
  }
}
