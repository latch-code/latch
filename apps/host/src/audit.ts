import { chmod, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'

export type StepupMethod = 'none' | 'lpc-local' | 'offline'
export interface AuditActor {
  deviceId?: string
  listener: 'unix' | 'loopback-tcp' | 'lan-tls' | 'tailnet-tls' | 'host' | 'cli'
  via?: 'http' | 'cli' | 'startup'
}

const GENESIS = '0'.repeat(64)
const FILE = 'audit.jsonl'

// Detail values are limited to ids, hashes, enums, booleans and counts: never names, titles, paths, commands or secrets.
const hex64 = z.string().regex(/^[0-9a-f]{64}$/u)
const opaqueId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,255}$/u)
const deviceId = z.string().regex(/^dev_[A-Za-z0-9_-]{22}$/u)
const prefixed = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_-]{22}$`, 'u'))
const count = z.number().int().min(0).max(1_000_000_000)
const listener = z.enum(['unix', 'loopback-tcp', 'lan-tls', 'tailnet-tls'])
const scopes = z.array(z.enum(['view', 'run', 'approve:standard', 'approve:elevated', 'admin', 'secrets'])).max(6)
const dataScope = z.enum(['work', 'all'])
const risk = z.enum(['R0', 'R1', 'R2'])
const presenceAction = z.enum([
  'device.enroll',
  'device.grant',
  'task.start-l3',
  'task.mode-widen',
  'agent.define',
  'policy.change',
  'provider.set-key',
  'approval.r2',
])
const fieldPath = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/u)
  .max(128)
const policyChange = z.strictObject({
  before: z.union([hex64, z.literal('')]),
  after: hex64,
  fields: z.array(fieldPath).max(64),
  lowering: z.boolean(),
})
const deviceOnly = z.strictObject({ deviceId })
const ticket = z.strictObject({ ticketId: prefixed('chl') })
const workspaceChange = z.strictObject({ workspaceId: opaqueId, pathHash: hex64 })
const folderId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/u)
const folderVia = z.enum(['picker', 'drop', 'cli'])

/** Strict detail schema per action. */
export const AUDIT_DETAIL = {
  'host.started': z.strictObject({
    hostId: z.string().regex(/^[a-z2-7]{52}$/u),
    version: z.string().regex(/^[0-9A-Za-z.+-]{1,64}$/u),
    policyHash: hex64,
    settingsHash: hex64,
    devMode: z.boolean(),
  }),
  'audit.torn-tail-removed': z.strictObject({ bytes: count }),
  'policy.created': policyChange,
  'policy.changed': policyChange,
  'policy.changed-outside': z.strictObject({ expected: hex64, actual: hex64 }),
  'presence.helper.pinned': z.strictObject({ cdhash: z.string().regex(/^[0-9a-f]{40}$/u) }),
  'presence.result': z.strictObject({
    confirmationId: prefixed('cfm'),
    action: presenceAction,
    result: z.enum(['denied', 'timeout', 'cancelled', 'error']),
  }),
  'device.enroll.requested': z.strictObject({
    enrollmentId: prefixed('enr'),
    listener,
    fingerprint: z.string().regex(/^[A-Z2-7]{20}$/u),
    scopes,
    invitationId: prefixed('inv').optional(),
  }),
  'device.enrolled': z.strictObject({
    deviceId,
    enrollmentId: prefixed('enr'),
    listener,
    method: z.enum(['lpc', 'offline', 'invitation']),
    scopes,
    dataScope,
    pairedByDeviceId: deviceId.optional(),
  }),
  'device.enroll.failed': z.strictObject({
    enrollmentId: prefixed('enr'),
    reason: z.enum(['denied', 'expired', 'cancelled', 'signature', 'commit']),
  }),
  'device.revoked': z.strictObject({ deviceId, reason: z.enum(['manual', 'self', 'replay', 'cascade', 'migration']), cascaded: count }),
  'device.review': z.strictObject({ deviceId, causeDeviceId: deviceId }),
  'device.scopes.changed': z.strictObject({ deviceId, added: scopes, removed: scopes, dataScope: dataScope.optional() }),
  'device.renamed': deviceOnly,
  /** A renewal answered with a new credential; it replaces the current one only when first used. */
  'device.credential.issued': deviceOnly,
  /** The renewed credential was used for the first time and became current. */
  'device.credential.rotated': deviceOnly,
  'pairing.invited': z.strictObject({ invitationId: prefixed('inv'), scopes }),
  'offline.ticket.created': ticket,
  'offline.ticket.consumed': ticket,
  'migration.devices.v2': z.strictObject({ revoked: count, legacy: count }),
  'approval.decided': z.strictObject({
    approvalId: opaqueId,
    sessionId: opaqueId,
    harnessId: opaqueId,
    risk,
    advisory: z.boolean(),
    decision: z.enum(['allow', 'reject']),
    optionKind: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
    previewHash: hex64.optional(),
  }),
  'approval.stale': z.strictObject({ approvalId: opaqueId }),
  /** Written before a full-access session is spawned; nothing is spawned without it. */
  'task.l3.start-requested': z.strictObject({ harnessId: opaqueId, launchHash: hex64, folderCount: count.optional() }),
  'task.l3.started': z.strictObject({ sessionId: opaqueId, harnessId: opaqueId, launchHash: hex64, folderCount: count.optional() }),
  'task.l3.start-failed': z.strictObject({ harnessId: opaqueId, launchHash: hex64 }),
  'task.cancelled': z.strictObject({ sessionId: opaqueId }),
  'task.mode.widened': z.strictObject({ sessionId: opaqueId, toHash: hex64 }),
  'task.permission-drift': z.strictObject({ sessionId: opaqueId, observedHash: hex64 }),
  'task.approval-auto-rejected': z.strictObject({ sessionId: opaqueId, reason: z.enum(['persistent-only', 'unknown-kind']) }),
  'agent.defined': z.strictObject({ agentId: opaqueId, definitionHash: hex64, created: z.boolean() }),
  'agent.deleted': z.strictObject({ agentId: opaqueId }),
  'provider.secret.set': z.strictObject({ providerId: opaqueId, originHash: hex64 }),
  'provider.secret.cleared': z.strictObject({ providerId: opaqueId, reason: z.enum(['origin-changed', 'manual', 'deleted']) }),
  /**
   * A new project; `pathHash` is its primary folder's, `foldersHash` the canonical list of all its folders. `session`:
   * a session's own folder that the desktop saved as a project.
   */
  'workspace.added': z.strictObject({
    workspaceId: opaqueId,
    pathHash: hex64,
    folderCount: count.optional(),
    foldersHash: hex64.optional(),
    via: z.enum([...folderVia.options, 'session']).optional(),
  }),
  'workspace.removed': workspaceChange,
  /** A folder joined a project, or (`replacesFolder`) took the place of one of its folders, keeping its ID. */
  'workspace.folder-added': z.strictObject({
    workspaceId: opaqueId,
    folderId,
    pathHash: hex64,
    via: folderVia,
    replacesFolder: z.boolean(),
  }),
  'workspace.folder-removed': z.strictObject({ workspaceId: opaqueId, folderId, pathHash: hex64 }),
  /** A rename, a new glyph or a new folder order; the folder set is unchanged. */
  'workspace.changed': z.strictObject({
    workspaceId: opaqueId,
    renamed: z.boolean(),
    glyphChanged: z.boolean(),
    primaryChanged: z.boolean(),
    reordered: z.boolean(),
  }),
  /** A saved project that became unusable (a folder failing the rules, missing or unreadable); it stays in settings. */
  'workspace.disabled': z.strictObject({
    workspaceId: opaqueId,
    reason: z.enum(['overlap', 'code-root', 'protected', 'invalid', 'missing', 'permission']),
    folderIndex: count.optional(),
  }),
  /** A settings write by the Host, with the canonical hashes before and after. */
  'settings.changed': z.strictObject({ before: z.union([hex64, z.literal('')]), after: hex64 }),
  'settings.changed-outside': z.strictObject({ expected: z.union([hex64, z.literal('')]), actual: hex64 }),
  /** An unterminated, unparsable last line of auth/revocations.jsonl (an append cut short) was moved aside. */
  'device.revocations.torn-tail-removed': z.strictObject({ bytes: count }),
  /** Best-effort follow-up when an action audited before taking effect then failed to commit. */
  'action.failed': z.strictObject({ refSeq: z.number().int().min(1) }),
} as const

export type AuditAction = keyof typeof AUDIT_DETAIL
export type AuditDetail<A extends AuditAction> = z.input<(typeof AUDIT_DETAIL)[A]>

const actions = Object.keys(AUDIT_DETAIL) as [AuditAction, ...AuditAction[]]
const actorSchema = z.strictObject({
  deviceId: deviceId.optional(),
  listener: z.enum(['unix', 'loopback-tcp', 'lan-tls', 'tailnet-tls', 'host', 'cli']),
  via: z.enum(['http', 'cli', 'startup']).optional(),
})
const recordSchema = z.strictObject({
  v: z.literal(1),
  seq: z.number().int().min(1),
  at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
  actor: actorSchema,
  action: z.enum(actions),
  target: z.union([opaqueId, z.literal('')]),
  stepup: z.enum(['none', 'lpc-local', 'offline']),
  detail: z.record(z.string(), z.unknown()),
  prev: hex64,
  hash: hex64,
})
export type AuditRecord = z.infer<typeof recordSchema>

type Failure = { ok: false; line: number; reason: 'json' | 'schema' | 'seq' | 'prev' | 'hash' }
type Verified = { ok: true; head: { seq: number; hash: string }; records: AuditRecord[] }

function hashRecord(record: Omit<AuditRecord, 'hash'>): string {
  return sha256Hex(canonicalJson(record))
}

/** Verifies complete, newline-terminated lines. */
function verifyLines(lines: string[]): Verified | Failure {
  let head = { seq: 0, hash: GENESIS }
  const records: AuditRecord[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = index + 1
    let value: unknown
    try {
      value = JSON.parse(lines[index]!)
    } catch {
      return { ok: false, line, reason: 'json' }
    }
    const parsed = recordSchema.safeParse(value)
    if (!parsed.success || !AUDIT_DETAIL[parsed.data.action].safeParse(parsed.data.detail).success)
      return { ok: false, line, reason: 'schema' }
    const record = parsed.data
    if (record.seq !== head.seq + 1) return { ok: false, line, reason: 'seq' }
    if (record.prev !== head.hash) return { ok: false, line, reason: 'prev' }
    const { hash, ...body } = record
    if (hashRecord(body) !== hash) return { ok: false, line, reason: 'hash' }
    head = { seq: record.seq, hash }
    records.push(record)
  }
  return { ok: true, head, records }
}

function splitComplete(text: string): { lines: string[]; tail: string } {
  const end = text.lastIndexOf('\n')
  const complete = end < 0 ? '' : text.slice(0, end)
  return { lines: complete === '' && end < 0 ? [] : complete.split('\n'), tail: text.slice(end + 1) }
}

/** Read-only verification of an audit file (also used by `pnpm latch audit verify`). A torn final line fails as 'json'. */
export async function verifyAuditFile(path: string): Promise<{ ok: true; head: { seq: number; hash: string }; records: number } | Failure> {
  const text = await readFile(path, 'utf8')
  const { lines, tail } = splitComplete(text)
  const result = verifyLines(lines)
  if (!result.ok) return result
  if (tail !== '') return { ok: false, line: lines.length + 1, reason: 'json' }
  return { ok: true, head: result.head, records: result.records.length }
}

/** Test seam: the subset of a file handle the log writes through. */
export interface AuditFileHandle {
  write(data: Buffer): Promise<{ bytesWritten: number }>
  sync(): Promise<void>
  truncate(length: number): Promise<void>
  close(): Promise<void>
}
export interface AuditFs {
  open(path: string): Promise<AuditFileHandle>
}

const defaultFs: AuditFs = { open: path => open(path, 'a', 0o600) }

function unavailable(): AppError {
  return new AppError(503, 'audit-unavailable', '审计记录写入失败，操作未执行')
}

/**
 * Append-only hash chain in `<data>/audit/audit.jsonl`. An append resolves only after its line is fsynced; callers
 * audit before an action takes effect. This is tamper-evident, not tamper-proof: a same-user process can rewrite the
 * file, which clients detect by comparing checkpoints (`hashAt`).
 */
export class AuditLog {
  private queue: Promise<unknown> = Promise.resolve()
  private headState = { seq: 0, hash: GENESIS }
  private readonly hashes: string[] = []
  private readonly latestByAction = new Map<AuditAction, AuditRecord>()
  private bytes = 0
  private poisoned = false

  private constructor(
    private readonly handle: AuditFileHandle,
    private readonly now: () => number,
  ) {}

  static async open(directory: string, options: { now?: () => number; fs?: AuditFs } = {}): Promise<AuditLog> {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32' && ((await stat(directory)).mode & 0o077) !== 0) await chmod(directory, 0o700)
    const path = join(directory, FILE)
    let text = ''
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const { lines, tail } = splitComplete(text)
    const verified = verifyLines(lines)
    if (!verified.ok) {
      throw new AppError(
        500,
        'audit-chain-broken',
        `审计记录在第 ${verified.line} 行校验失败。原文件已保留；如需继续，请把 audit/audit.jsonl 移走后重启。`,
      )
    }
    const now = options.now ?? Date.now
    let tornBytes = 0
    if (tail !== '') {
      // A final line without its newline was never acknowledged: keep a copy, then cut it away.
      tornBytes = Buffer.byteLength(tail)
      await writeFile(join(directory, `${FILE}.torn-${now()}`), tail, { mode: 0o600, flag: 'wx' })
    }
    const handle = await (options.fs ?? defaultFs).open(path)
    if (process.platform !== 'win32' && ((await stat(path)).mode & 0o077) !== 0) await chmod(path, 0o600)
    const log = new AuditLog(handle, now)
    log.bytes = Buffer.byteLength(text) - tornBytes
    if (tornBytes) {
      await handle.truncate(log.bytes)
      await handle.sync()
    }
    log.headState = verified.head
    for (const record of verified.records) {
      log.hashes.push(record.hash)
      log.latestByAction.set(record.action, record)
    }
    if (tornBytes)
      await log.append({ action: 'audit.torn-tail-removed', actor: { listener: 'host', via: 'startup' }, detail: { bytes: tornBytes } })
    return log
  }

  head(): { seq: number; hash: string } {
    return { ...this.headState }
  }

  async hashAt(seq: number): Promise<string | undefined> {
    if (!Number.isInteger(seq) || seq < 1) return undefined
    return this.hashes[seq - 1]
  }

  /** The most recent record among `actions`, in chain order. */
  latest(actions: readonly AuditAction[]): AuditRecord | undefined {
    let found: AuditRecord | undefined
    for (const action of actions) {
      const record = this.latestByAction.get(action)
      if (record && (!found || record.seq > found.seq)) found = record
    }
    return found && structuredClone(found)
  }

  /** The most recent record of one action (for example the last `host.started`, to compare its hashes at startup). */
  lastOf(action: AuditAction): AuditRecord | undefined {
    return this.latest([action])
  }

  /** Validation failures throw `audit-detail-invalid` (a programming error: the action must be refused). */
  append<A extends AuditAction>(event: {
    action: A
    actor: AuditActor
    target?: string
    stepup?: StepupMethod
    detail: AuditDetail<A>
  }): Promise<{ seq: number; hash: string }> {
    const run = this.queue.then(() => this.write(event))
    this.queue = run.catch(() => {})
    return run
  }

  private async write<A extends AuditAction>(event: {
    action: A
    actor: AuditActor
    target?: string
    stepup?: StepupMethod
    detail: AuditDetail<A>
  }): Promise<{ seq: number; hash: string }> {
    const schema = AUDIT_DETAIL[event.action] as z.ZodType | undefined
    const detail = schema?.safeParse(event.detail)
    const actor = actorSchema.safeParse(event.actor)
    const target = event.target ?? ''
    if (!schema || !detail?.success || !actor.success || !(target === '' || opaqueId.safeParse(target).success)) {
      throw new AppError(500, 'audit-detail-invalid', '审计记录内容无效，操作未执行')
    }
    if (this.poisoned) throw unavailable()
    const body: Omit<AuditRecord, 'hash'> = {
      v: 1,
      seq: this.headState.seq + 1,
      at: new Date(this.now()).toISOString(),
      actor: actor.data,
      action: event.action,
      target,
      stepup: event.stepup ?? 'none',
      detail: detail.data as Record<string, unknown>,
      prev: this.headState.hash,
    }
    const record: AuditRecord = { ...body, hash: hashRecord(body) }
    const line = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8')
    try {
      // A short count without an error (a disk filling up mid-write) must not be acknowledged as a full record.
      const { bytesWritten } = await this.handle.write(line)
      if (bytesWritten !== line.length) throw new Error('short write')
      await this.handle.sync()
    } catch {
      // Cut back to the last acknowledged byte so the chain stays valid; if that fails too, refuse every later append.
      try {
        await this.handle.truncate(this.bytes)
        await this.handle.sync()
      } catch {
        this.poisoned = true
      }
      throw unavailable()
    }
    this.bytes += line.length
    this.headState = { seq: record.seq, hash: record.hash }
    this.hashes.push(record.hash)
    this.latestByAction.set(record.action, record)
    return { seq: record.seq, hash: record.hash }
  }

  async close(): Promise<void> {
    await this.queue
    await this.handle.close()
  }
}
