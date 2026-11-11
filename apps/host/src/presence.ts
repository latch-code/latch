import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import {
  escapeSecurityText,
  isLocalListener,
  type BlockingTask,
  type ConfirmationTicket,
  type PresenceAction,
  type PresenceAvailability,
  type PresenceOutcome,
  type PresencePreview,
  type PresenceReasonForm,
  type PresenceSubject,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import type { AuditLog } from './audit.ts'
import { hashDisplay as formatHash, randomId, randomNonce } from './crypto.ts'
import type { PolicyStore } from './policy.ts'
import { presenceReason } from './presence-reason.ts'

export { enrollmentSubject, policySubject, presenceReason, REASON_FORMS, reasonSlots } from './presence-reason.ts'

/**
 * The few things a connected device may not do by itself, each confirmed with Touch ID or the login password on this
 * computer: what lets a new device in or widens one, where keys and traffic may go, and code loaded into the process that
 * holds them. Everything else a person does (starting agents, choosing their permission, answering them) needs only the
 * device's own scopes: agents are trusted local code with no sandbox, so a prompt there protects nothing.
 *
 * The title is fixed wording per action, for the client's card; the system sheet shows the reason instead. Only a policy
 * change that adds one outbound address is titled by that address (targetTitle): the Host checked it as `host:port`, so
 * nobody chose those words freely.
 *
 * While a full-access (L3) session runs or waits for an answer, its unsandboxed process may be the one asking, and each of
 * these outlives that session, so every one is refused until it ends.
 */
export const PRESENCE_ACTIONS: Readonly<Record<PresenceAction, { title: string; target?: (target: string) => string }>> = {
  'plugin.package.apply': { title: '应用自定义插件' },
  'device.enroll': { title: '允许新设备连接' },
  'device.enroll-native': { title: '配对原生设备' },
  'device.grant': { title: '为设备增加权限' },
  'policy.change': { title: '放宽本机安全策略', target: target => `允许 Host 访问 ${target}` },
  // The first use of a model-service address: the address, its key and its outbound allowance in one confirmation.
  'provider.confirm-origin': { title: '确认模型服务地址', target: target => `确认模型服务地址 ${target}` },
}

/** The refusal's text; clients show their own words for the code. */
const BLOCKED_MESSAGE = '有完全访问会话正在运行或等你处理。为防止 Agent 冒用你的确认，这项确认要等它结束。'
/** At most this many blocking sessions are listed in a refusal. */
const BLOCKING_LIMIT = 10

const TARGET = /^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):\d{1,5}$/u

/** The title of a request: the fixed wording, or the checked `host:port` it adds for the actions worded around one. */
function targetTitle(action: PresenceAction, target: string | undefined): string {
  const entry = PRESENCE_ACTIONS[action]
  if (target === undefined || !entry.target || target.length > 260 || !TARGET.test(target)) return entry.title
  return escapeSecurityText(target) === target ? entry.target(target) : entry.title
}

/** The Host's own limit: at expiry the helper gets SIGTERM, which closes the system sheet. */
export const CONFIRMATION_LIFETIME_MS = 120_000
/** Sent to the helper so it closes the sheet itself just before the Host's limit, also if the Host is gone. */
export const HELPER_TIMEOUT_SECONDS = 115
const PREVIEW_LIMIT = 64 * 1024
const COOLDOWN_MS = 5 * 60_000
const DENIALS_BEFORE_COOLDOWN = 3
const STDOUT_LIMIT = 4096

/** The shared security-text rule; the macOS helper's `visible()` applies the same one. */
export { escapeSecurityText as escapePreviewText } from '@latch/protocol'

export function buildPreview(
  input: Omit<PresencePreview, 'v' | 'nonce' | 'expiresAt' | 'title' | 'reason'> & { now: number; target?: string },
): {
  preview: PresencePreview
  previewHash: string
  hashDisplay: string
} {
  const requester: PresencePreview['requester'] = {
    ...(input.requester.deviceId !== undefined ? { deviceId: input.requester.deviceId } : {}),
    ...(input.requester.deviceName !== undefined ? { deviceName: escapeSecurityText(input.requester.deviceName) } : {}),
    listener: input.requester.listener,
    remoteAddress: escapeSecurityText(input.requester.remoteAddress),
  }
  const subject: PresenceSubject = {
    form: input.subject.form,
    slots: Object.fromEntries(Object.entries(input.subject.slots).map(([name, value]) => [name, escapeSecurityText(value)])),
  }
  const preview: PresencePreview = {
    v: 2,
    hostId: input.hostId,
    action: input.action,
    title: targetTitle(input.action, input.target),
    reason: presenceReason(input.action, subject),
    subject,
    requester,
    lines: input.lines.map(line => ({ label: escapeSecurityText(line.label), value: escapeSecurityText(line.value) })),
    warnings: [...input.warnings],
    nonce: randomNonce(),
    expiresAt: new Date(input.now + CONFIRMATION_LIFETIME_MS).toISOString(),
  }
  const canonical = canonicalJson(preview)
  if (Buffer.byteLength(canonical) > PREVIEW_LIMIT) throw new AppError(413, 'preview-too-large', '确认内容过长')
  const previewHash = sha256Hex(canonical)
  return { preview, previewHash, hashDisplay: formatHash(previewHash) }
}

/** Binds a confirmation to the exact request parameters. */
export function paramsHash(action: PresenceAction, params: Record<string, unknown>): string {
  return sha256Hex(canonicalJson({ action, params }))
}

export interface PresenceBackend {
  readonly kind: 'macos-helper' | 'none' | 'test'
  availability(): Promise<PresenceAvailability>
  /** Shows the preview and asks for OS authentication. Must not throw for denials; must honour signal (abort = cancelled). */
  confirm(request: {
    preview: PresencePreview
    previewHash: string
    hashDisplay: string
    requireBiometric: boolean
    signal: AbortSignal
  }): Promise<PresenceOutcome>
}

export type ExecFileLike = (file: string, args: readonly string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>
export interface ChildProcessLike {
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  kill(signal?: NodeJS.Signals): boolean
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
}
export type SpawnLike = (
  file: string,
  args: readonly string[],
  options: { env: Record<string, string>; cwd: string; stdio: ['pipe', 'pipe', 'ignore'] },
) => ChildProcessLike

const defaultExecFile: ExecFileLike = (file, args) =>
  new Promise(resolve => {
    nodeExecFile(file, [...args], { env: {}, cwd: '/', timeout: 15_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })

const defaultSpawn: SpawnLike = (file, args, options) => nodeSpawn(file, [...args], options)

const PLATFORM_MESSAGE = '此系统暂不支持本机确认（Touch ID 或登录密码）'
const MISSING_MESSAGE = '未找到本机确认组件。请运行 pnpm build:presence 后重启 Host。'
const SIGNATURE_MESSAGE = '本机确认组件的签名或文件权限无效。请运行 pnpm build:presence 后重启 Host。'
const MISMATCH_MESSAGE = '本机确认组件与记录的签名不一致。如果你重新构建了它，请停止 Host 后运行 pnpm latch presence repin。'
const PIN_LOST_MESSAGE = '本机确认组件的签名记录已丢失（policy.json 被修改或删除）。请停止 Host 后运行 pnpm latch presence repin。'

function noneBackend(availability: Extract<PresenceAvailability, { status: 'unavailable' }>): PresenceBackend {
  return {
    kind: 'none',
    async availability() {
      return availability
    },
    async confirm() {
      return { result: 'error', message: availability.message }
    },
  }
}

/** Absolute path of the helper inside the code root. */
export function presenceHelperPath(codeRoot: string): string {
  return join(codeRoot, 'dist', 'native', 'latch-presence')
}

/**
 * The production backends. A test backend is never constructed here: tests inject their own through dependency
 * injection, so a production Host cannot be switched to an always-approving backend.
 */
export function createPresenceBackend(options: {
  platform?: NodeJS.Platform
  codeRoot: string
  policy: PolicyStore
  execFile?: ExecFileLike
  spawn?: SpawnLike
}): PresenceBackend {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin') return noneBackend({ status: 'unavailable', reason: 'platform', message: PLATFORM_MESSAGE })
  if (options.policy.get().presence.backend === 'none') {
    return noneBackend({ status: 'unavailable', reason: 'disabled', message: '本机确认已在安全策略（policy.json）中停用' })
  }
  return new MacHelperBackend(
    presenceHelperPath(options.codeRoot),
    options.policy,
    options.execFile ?? defaultExecFile,
    options.spawn ?? defaultSpawn,
  )
}

const CODESIGN = '/usr/bin/codesign'

class MacHelperBackend implements PresenceBackend {
  readonly kind = 'macos-helper' as const
  private cached?: { at: number; value: PresenceAvailability }

  constructor(
    private readonly path: string,
    private readonly policy: PolicyStore,
    private readonly execFile: ExecFileLike,
    private readonly spawn: SpawnLike,
  ) {}

  async availability(): Promise<PresenceAvailability> {
    if (this.cached && Date.now() - this.cached.at < 60_000) return this.cached.value
    const value = await this.check()
    this.cached = { at: Date.now(), value }
    return value
  }

  /** File ownership and mode, then the code signature pinned by cdhash (trust on first use). */
  private async check(): Promise<PresenceAvailability> {
    let info
    try {
      info = await lstat(this.path)
    } catch {
      return { status: 'unavailable', reason: 'helper-missing', message: MISSING_MESSAGE }
    }
    const uid = process.getuid?.()
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022) !== 0 || (info.uid !== uid && info.uid !== 0)) {
      return { status: 'unavailable', reason: 'helper-signature', message: SIGNATURE_MESSAGE }
    }
    const signatureValid = async () => (await this.execFile(CODESIGN, ['--verify', '--strict', this.path])).code === 0
    let pinned = this.policy.get().presence.helperCdhash
    if (pinned === null) {
      if (!(await signatureValid())) return { status: 'unavailable', reason: 'helper-signature', message: SIGNATURE_MESSAGE }
      const details = await this.execFile(CODESIGN, ['-dvvv', this.path])
      const cdhash = /^CDHash=([0-9a-f]{40})$/mu.exec(details.stderr)?.[1]
      if (details.code !== 0 || !cdhash) return { status: 'unavailable', reason: 'helper-signature', message: SIGNATURE_MESSAGE }
      // Refused when an earlier pin was lost: the binary here is not necessarily the one first trusted.
      try {
        await this.policy.pinHelperCdhash(cdhash)
      } catch (error) {
        if (error instanceof AppError && error.code === 'presence-repin-required')
          return { status: 'unavailable', reason: 'cdhash-mismatch', message: PIN_LOST_MESSAGE }
        throw error
      }
      pinned = cdhash
    }
    const requirement = await this.execFile(CODESIGN, ['--verify', '--strict', `-R=cdhash H"${pinned}"`, this.path])
    if (requirement.code === 0) return { status: 'available', backend: 'macos-helper' }
    if (await signatureValid()) return { status: 'unavailable', reason: 'cdhash-mismatch', message: MISMATCH_MESSAGE }
    return { status: 'unavailable', reason: 'helper-signature', message: SIGNATURE_MESSAGE }
  }

  async confirm(request: {
    preview: PresencePreview
    previewHash: string
    hashDisplay: string
    requireBiometric: boolean
    signal: AbortSignal
  }): Promise<PresenceOutcome> {
    if (request.signal.aborted) return { result: 'cancelled' }
    // Checked again right before every run, never from the cache.
    const availability = await this.check()
    this.cached = { at: Date.now(), value: availability }
    if (availability.status !== 'available') return { result: 'error', message: availability.message }
    if (request.signal.aborted) return { result: 'cancelled' }
    const input = `${JSON.stringify({
      v: 2,
      preview: request.preview,
      previewHash: request.previewHash,
      timeoutSeconds: HELPER_TIMEOUT_SECONDS,
      requireBiometric: request.requireBiometric,
    })}\n`
    return await new Promise<PresenceOutcome>(resolve => {
      let child: ChildProcessLike
      try {
        child = this.spawn(this.path, [], { env: {}, cwd: '/', stdio: ['pipe', 'pipe', 'ignore'] })
      } catch {
        resolve({ result: 'error', message: '无法启动本机确认组件' })
        return
      }
      let settled = false
      let output = Buffer.alloc(0)
      let overflow = false
      const finish = (outcome: PresenceOutcome) => {
        if (settled) return
        settled = true
        request.signal.removeEventListener('abort', onAbort)
        resolve(outcome)
      }
      const onAbort = () => {
        child.kill('SIGTERM')
        finish({ result: 'cancelled' })
      }
      request.signal.addEventListener('abort', onAbort, { once: true })
      child.once('error', () => finish({ result: 'error', message: '无法启动本机确认组件' }))
      child.stdout?.on('data', (chunk: Buffer) => {
        if (overflow) return
        output = Buffer.concat([output, chunk])
        if (output.length > STDOUT_LIMIT) {
          overflow = true
          child.kill('SIGTERM')
          finish({ result: 'error', message: '本机确认组件返回了无效结果' })
        }
      })
      child.once('exit', () => finish(parseHelperOutput(output.toString('utf8'), request.preview.nonce, request.previewHash)))
      child.stdin?.on('error', () => {})
      child.stdin?.end(input)
    })
  }
}

function parseHelperOutput(text: string, nonce: string, previewHash: string): PresenceOutcome {
  const malformed: PresenceOutcome = { result: 'error', message: '本机确认组件返回了无效结果' }
  const line = text.split('\n')[0] ?? ''
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return malformed
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return malformed
  const record = value as Record<string, unknown>
  switch (record.result) {
    case 'approved':
      if (record.v !== 1 || (record.method !== 'biometric' && record.method !== 'password')) return malformed
      if (record.nonce !== nonce || record.previewHash !== previewHash)
        return { result: 'error', message: '本机确认组件返回了不匹配的结果' }
      return { result: 'approved', method: record.method, nonce, previewHash }
    case 'denied':
    case 'cancelled':
    case 'timeout':
      return { result: record.result }
    case 'error':
      if (record.error === 'biometry-lockout')
        return { result: 'error', message: 'Touch ID 已锁定，下次确认改用登录密码', failure: 'biometry-lockout' }
      return {
        result: 'error',
        message:
          record.error === 'preview-hash-mismatch' || record.error === 'reason-mismatch' ? '本机确认组件无法核对确认内容' : '本机确认失败',
      }
    default:
      return malformed
  }
}

export interface ConfirmationRecord extends ConfirmationTicket {
  reason: string
  form: PresenceReasonForm
  lines: PresencePreview['lines']
  warnings: string[]
  paramsHash: string
  previewHash: string
  requesterDeviceId?: string
  method?: 'biometric' | 'password'
  failure?: 'biometry-lockout'
  settled: Promise<PresenceOutcome>
}

interface Entry {
  record: ConfirmationRecord
  preview: PresencePreview
  requester: PresencePreview['requester']
  createdAt: number
  expiresAtMs: number
  controller: AbortController
  done: boolean
}

function ticketOf(record: ConfirmationRecord): ConfirmationTicket {
  return {
    id: record.id,
    action: record.action,
    title: record.title,
    status: record.status,
    hashDisplay: record.hashDisplay,
    expiresAt: record.expiresAt,
    reason: record.reason,
    form: record.form,
    lines: record.lines.map(line => ({ ...line })),
    warnings: [...record.warnings],
    ...(record.failure ? { failure: record.failure } : {}),
  }
}

const RETENTION_MS = 10 * 60_000

/** Requests without a device ID come from anonymous enrollments. */
function requesterKind(requester: PresencePreview['requester']): 'device' | 'anonymous' {
  return requester.deviceId === undefined ? 'anonymous' : 'device'
}

/**
 * Local presence confirmations (LPC): one at a time, 120 s to show and consume, single use, bound to the requester and
 * to the exact request parameters.
 */
export class PresenceService {
  private readonly backend: PresenceBackend
  private readonly hostId: string
  private readonly audit: AuditLog
  private readonly now: () => number
  private readonly blockingTasks: () => Promise<BlockingTask[]>
  private readonly entries = new Map<string, Entry>()
  private active?: Entry
  /**
   * Denials of requests from enrolled devices, and separately of anonymous requests (enrollments). Anyone holding an
   * invitation, or able to open host.sock, may ask to enroll; dismissing those dialogs must not lock the owner out.
   */
  private readonly denials = { device: 0, anonymous: 0 }
  private readonly cooldownUntil = { device: 0, anonymous: 0 }

  constructor(options: {
    backend: PresenceBackend
    hostId: string
    audit: AuditLog
    now?: () => number
    /** The full-access sessions running or waiting for an answer; the actions marked `refuse` wait for them to end. */
    blockingTasks: () => Promise<BlockingTask[]>
  }) {
    this.backend = options.backend
    this.hostId = options.hostId
    this.audit = options.audit
    this.now = options.now ?? Date.now
    this.blockingTasks = options.blockingTasks
  }

  availability(): Promise<PresenceAvailability> {
    return this.backend.availability()
  }

  /**
   * Refuses the way `request` would before anything else happens: no confirmation component, or a full-access session
   * holding this action back. A caller checks first when a refusal must not spend something single-use (an invitation).
   */
  async assertCanRequest(action: PresenceAction, revealBlocking = false): Promise<void> {
    const availability = await this.backend.availability()
    if (availability.status !== 'available') throw new AppError(503, 'presence-unavailable', `本机确认不可用：${availability.message}`)
    await this.assertNotHeldBack(action, revealBlocking)
  }

  /** A full-access session holds back every confirmation; also what takes none (the desktop's first connection) waits for it to end. */
  async assertNotHeldBack(action: PresenceAction, revealBlocking = false): Promise<void> {
    const blocking = await this.blockingTasks()
    if (blocking.length === 0) return
    throw new AppError(409, 'presence-blocked', BLOCKED_MESSAGE, {
      action,
      ...(revealBlocking
        ? { blockingTasks: blocking.slice(0, BLOCKING_LIMIT).map(({ id, title, harnessId }) => ({ id, title, harnessId })) }
        : {}),
    })
  }

  /** Starts one confirmation and returns at once; `settled` resolves when the backend answers. */
  async request(input: {
    action: PresenceAction
    requester: PresencePreview['requester']
    /** What the system sheet names; the reason is built from it. */
    subject: PresenceSubject
    lines: PresencePreview['lines']
    warnings: string[]
    paramsHash: string
    /** A checked `host:port` the request adds, for the title of the actions worded around one. */
    target?: string
    /** A refusal names the sessions holding it back only for a requester that may view sessions. */
    revealBlocking?: boolean
  }): Promise<ConfirmationRecord> {
    await this.assertCanRequest(input.action, input.revealBlocking === true)
    const now = this.now()
    const kind = requesterKind(input.requester)
    // Device cooldowns stop everyone; an anonymous cooldown only stops further anonymous requests.
    const until = kind === 'device' ? this.cooldownUntil.device : Math.max(this.cooldownUntil.device, this.cooldownUntil.anonymous)
    if (now < until) {
      const seconds = Math.ceil((until - now) / 1000)
      throw new AppError(429, 'presence-cooldown', `本机确认连续被拒绝 3 次，请 ${Math.ceil(seconds / 60)} 分钟后再试`, {
        retryAfter: seconds,
      })
    }
    this.expire()
    const waiting = this.active && !this.active.done ? this.active : undefined
    // The owner's own desktop takes the dialog back from a pending anonymous request (it settles as cancelled).
    if (waiting && !(kind === 'device' && isLocalListener(input.requester.listener) && requesterKind(waiting.requester) === 'anonymous')) {
      throw new AppError(409, 'presence-busy', '本机正在等待另一项确认，请先完成或取消')
    }

    const { preview, previewHash, hashDisplay } = buildPreview({
      hostId: this.hostId,
      action: input.action,
      requester: input.requester,
      subject: input.subject,
      lines: input.lines,
      warnings: input.warnings,
      now,
      ...(input.target === undefined ? {} : { target: input.target }),
    })
    if (waiting) this.abandon(waiting)
    const controller = new AbortController()
    let resolveSettled!: (outcome: PresenceOutcome) => void
    const record: ConfirmationRecord = {
      id: randomId('cfm'),
      action: input.action,
      title: preview.title,
      status: 'pending',
      hashDisplay,
      expiresAt: preview.expiresAt,
      reason: preview.reason,
      form: preview.subject.form,
      lines: preview.lines,
      warnings: preview.warnings,
      paramsHash: input.paramsHash,
      previewHash,
      ...(input.requester.deviceId !== undefined ? { requesterDeviceId: input.requester.deviceId } : {}),
      settled: new Promise(resolve => {
        resolveSettled = resolve
      }),
    }
    const entry: Entry = {
      record,
      preview,
      requester: input.requester,
      createdAt: now,
      expiresAtMs: now + CONFIRMATION_LIFETIME_MS,
      controller,
      done: false,
    }
    this.prune(now)
    this.entries.set(record.id, entry)
    this.active = entry

    const timer = setTimeout(() => controller.abort('expired'), CONFIRMATION_LIFETIME_MS)
    timer.unref?.()
    void (async () => {
      let outcome: PresenceOutcome
      try {
        outcome = await this.backend.confirm({ preview, previewHash, hashDisplay, requireBiometric: true, signal: controller.signal })
      } catch (error) {
        outcome = { result: 'error', message: error instanceof Error ? error.message : '本机确认失败' }
      }
      clearTimeout(timer)
      if (outcome.result === 'approved' && (outcome.nonce !== preview.nonce || outcome.previewHash !== previewHash)) {
        outcome = { result: 'error', message: '本机确认组件返回了不匹配的结果' }
      }
      if (outcome.result === 'cancelled' && controller.signal.reason === 'expired') outcome = { result: 'timeout' }
      this.settle(entry, outcome)
      resolveSettled(outcome)
    })()
    return record
  }

  /** Cancels an entry that is still waiting; its backend run settles as `cancelled`, which never counts as a denial. */
  private abandon(entry: Entry): void {
    if (entry.record.status === 'pending' || entry.record.status === 'approved') entry.record.status = 'cancelled'
    if (this.active === entry) this.active = undefined
    if (!entry.done) entry.controller.abort('cancelled')
  }

  private settle(entry: Entry, outcome: PresenceOutcome): void {
    entry.done = true
    if (this.active === entry) this.active = undefined
    const record = entry.record
    const expired = this.now() > entry.expiresAtMs
    const kind = requesterKind(entry.requester)
    if (outcome.result === 'approved') {
      this.denials[kind] = 0
      if (record.status === 'pending') {
        record.status = expired ? 'expired' : 'approved'
        record.method = outcome.method
      }
      return
    }
    if (outcome.result === 'denied') {
      this.denials[kind] += 1
      if (this.denials[kind] >= DENIALS_BEFORE_COOLDOWN) {
        this.denials[kind] = 0
        this.cooldownUntil[kind] = this.now() + COOLDOWN_MS
      }
    }
    if (record.status === 'pending' && outcome.result === 'error' && outcome.failure) record.failure = outcome.failure
    if (record.status === 'pending') {
      record.status =
        outcome.result === 'denied'
          ? 'denied'
          : outcome.result === 'timeout'
            ? 'expired'
            : outcome.result === 'cancelled'
              ? 'cancelled'
              : 'error'
    }
    // Denials are privilege-reducing outcomes: an audit failure must not change them.
    const { deviceId, listener } = entry.requester
    void this.audit
      .append({
        action: 'presence.result',
        actor: { ...(deviceId ? { deviceId } : {}), listener, via: listener === 'cli' ? 'cli' : 'http' },
        target: record.id,
        detail: { confirmationId: record.id, action: record.action, result: outcome.result },
      })
      .catch(() => {})
  }

  private expire(): void {
    const now = this.now()
    for (const entry of this.entries.values()) {
      const status = entry.record.status
      if ((status === 'pending' || status === 'approved') && now > entry.expiresAtMs) {
        entry.record.status = 'expired'
        if (!entry.done) entry.controller.abort('expired')
      }
    }
  }

  private prune(now: number): void {
    for (const [id, entry] of this.entries) if (entry.done && now - entry.createdAt > RETENTION_MS) this.entries.delete(id)
  }

  private lookup(id: string, requesterDeviceId: string | undefined): Entry | undefined {
    const entry = this.entries.get(id)
    return entry && entry.record.requesterDeviceId === requesterDeviceId ? entry : undefined
  }

  /** Undefined when another device asks. */
  get(id: string, requesterDeviceId?: string): ConfirmationTicket | undefined {
    this.expire()
    const entry = this.lookup(id, requesterDeviceId)
    return entry && ticketOf(entry.record)
  }

  cancel(id: string, requesterDeviceId?: string): void {
    const entry = this.lookup(id, requesterDeviceId)
    if (!entry) return
    const status = entry.record.status
    if (status === 'pending' || status === 'approved') entry.record.status = 'cancelled'
    if (!entry.done) entry.controller.abort('cancelled')
  }

  /** Verifies and consumes an approved confirmation for exactly this binding. */
  consume(
    id: string,
    binding: { action: PresenceAction; requesterDeviceId?: string; paramsHash: string },
  ): { stepup: 'lpc-local'; method: 'biometric' | 'password' } {
    this.expire()
    const entry = this.lookup(id, binding.requesterDeviceId)
    if (!entry) throw new AppError(404, 'confirmation-not-found', '找不到该确认')
    const record = entry.record
    switch (record.status) {
      case 'pending':
        throw new AppError(409, 'confirmation-pending', '本机尚未确认')
      case 'denied':
        throw new AppError(403, 'confirmation-denied', '本机拒绝了此操作')
      case 'expired':
        throw new AppError(410, 'confirmation-expired', '本机确认已超时，请重试')
      case 'cancelled':
        throw new AppError(410, 'confirmation-cancelled', '本机确认已取消，请重试')
      case 'error':
        throw new AppError(409, 'confirmation-failed', '本机确认失败，请重试')
      case 'consumed':
        throw new AppError(409, 'confirmation-used', '该确认已使用')
      case 'approved':
        break
    }
    if (record.action !== binding.action || record.paramsHash !== binding.paramsHash) {
      // The approved preview no longer matches the request: void it so it cannot be replayed with other parameters.
      record.status = 'cancelled'
      throw new AppError(409, 'confirmation-mismatch', '确认内容与本次请求不一致，请重新确认')
    }
    record.status = 'consumed'
    return { stepup: 'lpc-local', method: record.method! }
  }
}
