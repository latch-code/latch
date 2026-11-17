import { chmod, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { LISTENER_CLASSES, type ListenerClass } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import { AGENT_ACTIONS } from './audit-actions/agents.ts'
import { BROWSER_ACTIONS } from './audit-actions/browser.ts'
import { CHANGE_ACTIONS } from './audit-actions/changes.ts'
import { DEVICE_ACTIONS } from './audit-actions/devices.ts'
import { attachmentId, deviceId, hex64, opaqueId } from './audit-actions/fields.ts'
import { GIT_ACTIONS } from './audit-actions/git.ts'
import { HOST_ACTIONS } from './audit-actions/host.ts'
import { MCP_ACTIONS } from './audit-actions/mcp.ts'
import { NATIVE_APPROVAL_ACTIONS } from './audit-actions/native-approvals.ts'
import { NATIVE_ACTIONS } from './audit-actions/native.ts'
import { PERSONAL_ACTIONS } from './audit-actions/personal.ts'
import { PUSH_ACTIONS } from './audit-actions/push.ts'
import { SESSION_ACTIONS } from './audit-actions/sessions.ts'
import { SIMULATOR_ACTIONS } from './audit-actions/simulators.ts'
import { TERMINAL_ACTIONS } from './audit-actions/terminal.ts'

/** `preset`: no confirmation, because the Host matched the change to its own preset table (a preset's command as it names it). */
export type StepupMethod = 'none' | 'preset' | 'lpc-local' | 'shell-local' | 'offline'
export interface AuditActor {
  deviceId?: string
  listener: ListenerClass | 'host' | 'cli'
  via?: 'http' | 'cli' | 'startup'
}

const GENESIS = '0'.repeat(64)
const FILE = 'audit.jsonl'

/** Strict detail schema per action, assembled from the per-area files in `audit-actions/`; each action is in one of them. */
export const AUDIT_DETAIL = {
  ...HOST_ACTIONS,
  ...SESSION_ACTIONS,
  ...DEVICE_ACTIONS,
  ...NATIVE_ACTIONS,
  ...PERSONAL_ACTIONS,
  ...AGENT_ACTIONS,
  ...CHANGE_ACTIONS,
  ...GIT_ACTIONS,
  ...TERMINAL_ACTIONS,
  ...BROWSER_ACTIONS,
  ...SIMULATOR_ACTIONS,
  ...NATIVE_APPROVAL_ACTIONS,
  ...PUSH_ACTIONS,
  ...MCP_ACTIONS,
} as const

export type AuditAction = keyof typeof AUDIT_DETAIL
export type AuditDetail<A extends AuditAction> = z.input<(typeof AUDIT_DETAIL)[A]>

const actions = Object.keys(AUDIT_DETAIL) as [AuditAction, ...AuditAction[]]
const targetSchema = z.union([opaqueId, attachmentId, z.literal('')])
const actorSchema = z.strictObject({
  deviceId: deviceId.optional(),
  listener: z.enum([...LISTENER_CLASSES, 'host', 'cli']),
  via: z.enum(['http', 'cli', 'startup']).optional(),
})
const recordSchema = z.strictObject({
  v: z.literal(1),
  seq: z.number().int().min(1),
  at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
  actor: actorSchema,
  action: z.enum(actions),
  target: targetSchema,
  stepup: z.enum(['none', 'preset', 'lpc-local', 'shell-local', 'offline']),
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

/** Read-only snapshot for an offline tool inspecting a running Host; never repairs or appends to its log. */
export async function readLatestAuditRecord(path: string, actions: readonly AuditAction[]): Promise<AuditRecord | undefined> {
  const { lines } = splitComplete(await readFile(path, 'utf8'))
  const verified = verifyLines(lines)
  if (!verified.ok) throw new AppError(500, 'audit-chain-broken', '审计记录无法核对，未执行本机确认。')
  return verified.records.findLast(record => actions.includes(record.action))
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
  /** What full-access sessions started with: their launch fingerprints, definitions and harnesses. */
  private readonly started = { launches: new Set<string>(), definitions: new Set<string>(), harnesses: new Set<string>() }
  private bytes = 0
  /** Where each record's line starts in the file, by `seq - 1`: what `readBefore` seeks to. */
  private readonly offsets: number[] = []
  private poisoned = false

  private constructor(
    private readonly handle: AuditFileHandle,
    private readonly now: () => number,
    private readonly path: string,
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
    const log = new AuditLog(handle, now, path)
    log.bytes = Buffer.byteLength(text) - tornBytes
    if (tornBytes) {
      await handle.truncate(log.bytes)
      await handle.sync()
    }
    log.headState = verified.head
    let offset = 0
    for (const [index, record] of verified.records.entries()) {
      log.offsets.push(offset)
      offset += Buffer.byteLength(lines[index]!) + 1
      log.hashes.push(record.hash)
      log.index(record)
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

  /** Worktree removals that happened, by request and by worktree hash, for retries after a restart (bounded). */
  private readonly worktreeRemovals = new Map<string, AuditRecord>()

  /** The `worktree.result` record of a removal: `request:<hash>` or `tree:<hash>`. */
  worktreeRemoval(key: string): AuditRecord | undefined {
    const found = this.worktreeRemovals.get(key)
    return found && structuredClone(found)
  }

  /** Worktree removals that began (`worktree.remove`, written before Git runs), by worktree hash (bounded). */
  private readonly worktreeRemovalsBegun = new Map<string, AuditRecord>()

  /** The `worktree.remove` record of the last removal that began for this worktree hash. */
  worktreeRemovalBegun(worktreeHash: string): AuditRecord | undefined {
    const found = this.worktreeRemovalsBegun.get(worktreeHash)
    return found && structuredClone(found)
  }

  private index(record: AuditRecord): void {
    this.latestByAction.set(record.action, record)
    if (record.action === 'worktree.remove') {
      const key = String(record.detail.worktreeHash)
      this.worktreeRemovalsBegun.delete(key)
      this.worktreeRemovalsBegun.set(key, record)
      while (this.worktreeRemovalsBegun.size > 2048) this.worktreeRemovalsBegun.delete(this.worktreeRemovalsBegun.keys().next().value!)
      return
    }
    if (record.action === 'worktree.result' && record.detail.outcome === 'removed') {
      for (const key of [`request:${String(record.detail.requestHash)}`, `tree:${String(record.detail.worktreeHash)}`]) {
        this.worktreeRemovals.delete(key)
        this.worktreeRemovals.set(key, record)
      }
      while (this.worktreeRemovals.size > 2048) this.worktreeRemovals.delete(this.worktreeRemovals.keys().next().value!)
      return
    }
    if (record.action !== 'task.l3.started') return
    const { launchHash, definitionHash, harnessId } = record.detail
    if (typeof launchHash === 'string') this.started.launches.add(launchHash)
    if (typeof definitionHash === 'string') this.started.definitions.add(definitionHash)
    if (typeof harnessId === 'string') this.started.harnesses.add(harnessId)
  }

  /**
   * What earlier full-access starts after a local confirmation had in common with this one, as this log records them:
   * the same launch fingerprint, the same definition (so only the project's configuration differs), or only the same
   * harness. A moved-away or reset log only makes every start read as a first one again, which names more.
   */
  startedBefore(input: { launchHash: string; definitionHash?: string; harnessId: string }): 'launch' | 'definition' | 'harness' | 'never' {
    if (this.started.launches.has(input.launchHash)) return 'launch'
    if (input.definitionHash !== undefined && this.started.definitions.has(input.definitionHash)) return 'definition'
    return this.started.harnesses.has(input.harnessId) ? 'harness' : 'never'
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

  /**
   * Up to `count` records just before `before` (a seq), oldest first, read from the file by the offsets this log keeps:
   * only acknowledged lines, each checked against the record schema and its detail schema; a line that no longer reads
   * as one (the file was changed underneath) ends the read there. For 审计记录 (`audit-view.ts`), read-only.
   */
  async readBefore(before: number, count: number): Promise<AuditRecord[]> {
    const end = Math.min(before - 1, this.headState.seq)
    const start = Math.max(1, end - Math.max(0, Math.floor(count)) + 1)
    if (end < 1 || start > end) return []
    const from = this.offsets[start - 1]!
    const to = end === this.headState.seq ? this.bytes : this.offsets[end]!
    const file = await open(this.path, 'r')
    try {
      const buffer = Buffer.alloc(to - from)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, from)
      const records: AuditRecord[] = []
      for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
        if (!line) continue
        let value: unknown
        try {
          value = JSON.parse(line)
        } catch {
          break
        }
        const parsed = recordSchema.safeParse(value)
        if (!parsed.success || !AUDIT_DETAIL[parsed.data.action].safeParse(parsed.data.detail).success) break
        records.push(parsed.data)
      }
      return records
    } finally {
      await file.close()
    }
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
    if (!schema || !detail?.success || !actor.success || !targetSchema.safeParse(target).success) {
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
    this.offsets.push(this.bytes)
    this.bytes += line.length
    this.headState = { seq: record.seq, hash: record.hash }
    this.hashes.push(record.hash)
    this.index(record)
    return { seq: record.seq, hash: record.hash }
  }

  async close(): Promise<void> {
    await this.queue
    await this.handle.close()
  }
}
