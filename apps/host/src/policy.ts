import { isIPv6 } from 'node:net'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { ListenerClass, PermissionLevel } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex, writeFileAtomic } from '@latch/core/node-kit'
import type { AuditActor, AuditLog, StepupMethod } from './audit.ts'

const FILE = 'policy.json'

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u

/** Exact `host:port`: lowercase host name or IPv4, bracketed IPv6, explicit port. */
export function isEgressEntry(value: string): boolean {
  if (typeof value !== 'string' || value.length > 260) return false
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+):([1-9][0-9]{0,4})$/u.exec(value)
  if (!match || Number(match[2]) > 65535) return false
  const host = match[1]!
  if (host.startsWith('[')) return isIPv6(host.slice(1, -1))
  return host.length <= 253 && host.split('.').every(label => HOST_LABEL.test(label))
}

const level = z.enum(['L0', 'L1', 'L2'])
const idList = z.array(z.string().min(1).max(128)).max(256).nullable()

export const policySchema = z.strictObject({
  version: z.literal(1),
  local: z.strictObject({ maxLevel: level, allowL3: z.boolean() }),
  remote: z.strictObject({
    maxLevel: level,
    allowRemoteStart: z.boolean(),
    /** null = any harness. */
    harnesses: idList,
    /** Workspace IDs; null = any. */
    workspaces: idList,
    allowInstall: z.literal(false),
  }),
  insecureLan: z.strictObject({ enabled: z.literal(false) }),
  /** The operator channel is not implemented yet; entries are ignored with a startup warning. */
  operators: z.array(z.unknown()).max(16),
  presence: z.strictObject({
    backend: z.enum(['macos-helper', 'none']),
    helperCdhash: z
      .string()
      .regex(/^[0-9a-f]{40}$/u)
      .nullable(),
  }),
  hostEgressAllow: z
    .array(z.string().refine(isEgressEntry, '出站白名单条目必须是 host:port'))
    .max(64)
    .refine(list => new Set(list).size === list.length, '出站白名单条目不能重复'),
  keyBackend: z.literal('file'),
  /** Stored only; unattended runs are not implemented yet. */
  unattended: z.strictObject({
    maxLevel: level,
    allowAutoApproveRules: z.boolean(),
    approvalTtlHours: z.strictObject({ standard: z.number().int().min(1).max(720), acp: z.number().int().min(1).max(720) }),
    pauseAfterIdleDays: z.number().int().min(1).max(365),
  }),
})
export type Policy = z.infer<typeof policySchema>

export function defaultPolicy(platform: NodeJS.Platform): Policy {
  return {
    version: 1,
    local: { maxLevel: 'L2', allowL3: true },
    remote: { maxLevel: 'L1', allowRemoteStart: true, harnesses: ['standard'], workspaces: null, allowInstall: false },
    insecureLan: { enabled: false },
    operators: [],
    presence: { backend: platform === 'darwin' ? 'macos-helper' : 'none', helperCdhash: null },
    hostEgressAllow: [],
    keyBackend: 'file',
    unattended: { maxLevel: 'L1', allowAutoApproveRules: false, approvalTtlHours: { standard: 8, acp: 1 }, pauseAfterIdleDays: 14 },
  }
}

const LEVEL_RANK: Record<PermissionLevel, number> = { L0: 0, L1: 1, L2: 2, L3: 3 }

function flatten(value: unknown, prefix: string, output: Map<string, unknown>): void {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value)) flatten(item, prefix ? `${prefix}.${key}` : key, output)
  } else output.set(prefix, value)
}

function leaves(policy: Policy): Map<string, unknown> {
  const output = new Map<string, unknown>()
  flatten(policy, '', output)
  return output
}

function display(value: unknown): string {
  if (value === undefined) return '（无）'
  return typeof value === 'string' ? value : canonicalJson(value)
}

/** Display lines for a confirmation preview: one entry per changed leaf (arrays are leaves). */
export function policyDiff(prev: Policy, next: Policy): Array<{ path: string; before: string; after: string }> {
  const before = leaves(prev)
  const after = leaves(next)
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort()
  return paths.flatMap(path => {
    const a = before.get(path)
    const b = after.get(path)
    if (a !== undefined && b !== undefined && canonicalJson(a) === canonicalJson(b)) return []
    return [{ path, before: display(a), after: display(b) }]
  })
}

function isSubset(next: readonly string[], prev: readonly string[]): boolean {
  const allowed = new Set(prev)
  return next.every(item => allowed.has(item))
}

function narrowerList(prev: string[] | null, next: string[] | null): boolean {
  if (next === null) return prev === null
  return prev === null || isSubset(next, prev)
}

/** True iff every changed field moves to a stricter value. Anything else (including presence and unattended) raises. */
export function isLowering(prev: Policy, next: Policy): boolean {
  for (const { path } of policyDiff(prev, next)) {
    switch (path) {
      case 'local.maxLevel':
        if (LEVEL_RANK[next.local.maxLevel] > LEVEL_RANK[prev.local.maxLevel]) return false
        break
      case 'remote.maxLevel':
        if (LEVEL_RANK[next.remote.maxLevel] > LEVEL_RANK[prev.remote.maxLevel]) return false
        break
      case 'local.allowL3':
        if (next.local.allowL3) return false
        break
      case 'remote.allowRemoteStart':
        if (next.remote.allowRemoteStart) return false
        break
      case 'remote.harnesses':
        if (!narrowerList(prev.remote.harnesses, next.remote.harnesses)) return false
        break
      case 'remote.workspaces':
        if (!narrowerList(prev.remote.workspaces, next.remote.workspaces)) return false
        break
      case 'hostEgressAllow':
        if (!isSubset(next.hostEgressAllow, prev.hostEgressAllow)) return false
        break
      default:
        return false
    }
  }
  return true
}

/** unix → local ceiling; every other listener → remote ceiling. */
export function ceilingFor(policy: Policy, listener: ListenerClass): PermissionLevel {
  return listener === 'unix' ? policy.local.maxLevel : policy.remote.maxLevel
}

function invalid(detail: string): AppError {
  return new AppError(500, 'policy-invalid', `安全策略文件 policy.json 无效，原文件已保留：${detail}`)
}

/** `<data>/policy.json`: local ceilings and Host-wide security switches. Out-of-band edits are detected and audited, not blocked. */
export class PolicyStore {
  private queue: Promise<unknown> = Promise.resolve()
  /** Chinese startup warnings (never secrets). */
  readonly warnings: string[] = []

  private constructor(
    private readonly dataDir: string,
    private readonly audit: AuditLog,
    private policy: Policy,
  ) {}

  static async open(options: { dataDir: string; audit: AuditLog; platform?: NodeJS.Platform }): Promise<PolicyStore> {
    const path = join(options.dataDir, FILE)
    let text: string | undefined
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw invalid((error as NodeJS.ErrnoException).code ?? '读取失败')
    }
    // The last hash this Host knowingly wrote or started with; anything else was edited outside Latch.
    const last = options.audit.latest(['host.started', 'policy.created', 'policy.changed'])
    const expected = last ? String(last.action === 'host.started' ? last.detail.policyHash : last.detail.after) : undefined
    if (text === undefined) {
      const policy = defaultPolicy(options.platform ?? process.platform)
      const store = new PolicyStore(options.dataDir, options.audit, policy)
      // A missing file after this Host has run before was deleted outside Latch; the defaults are not what it knew.
      if (expected && expected !== store.hash()) {
        await options.audit.append({
          action: 'policy.changed-outside',
          actor: { listener: 'host', via: 'startup' },
          detail: { expected, actual: store.hash() },
        })
        store.warnings.push('policy.json 在 Latch 之外被删除，已按默认值重建并记入审计。')
      }
      await options.audit.append({
        action: 'policy.created',
        actor: { listener: 'host', via: 'startup' },
        detail: { before: '', after: store.hash(), fields: [], lowering: false },
      })
      await writeFileAtomic(join(options.dataDir, FILE), `${JSON.stringify(policy, null, 2)}\n`, { prefix: '.policy-' })
      return store
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      throw invalid('JSON 格式无效')
    }
    const insecure = (raw as { insecureLan?: { enabled?: unknown } } | null)?.insecureLan?.enabled
    if (insecure === true) {
      throw new AppError(
        500,
        'insecure-lan-removed',
        '明文局域网接入已移除。请把 policy.json 中的 insecureLan.enabled 改为 false，并用 HTTPS 入口接入手机。',
      )
    }
    const parsed = policySchema.safeParse(raw)
    if (!parsed.success) throw invalid(parsed.error.issues.map(issue => `${issue.path.join('.') || '（根）'}：${issue.message}`).join('；'))
    const store = new PolicyStore(options.dataDir, options.audit, parsed.data)
    if (parsed.data.operators.length) store.warnings.push('policy.json 中的 operators 已忽略：无界面确认通道尚未实现。')
    if (expected && expected !== store.hash()) {
      await options.audit.append({
        action: 'policy.changed-outside',
        actor: { listener: 'host', via: 'startup' },
        detail: { expected, actual: store.hash() },
      })
      store.warnings.push('policy.json 在 Latch 之外被修改过，已记入审计。')
    }
    return store
  }

  get(): Policy {
    return structuredClone(this.policy)
  }

  hash(): string {
    return sha256Hex(canonicalJson(this.policy))
  }

  /**
   * Audits 'policy.changed' first, then writes atomically. Raising changes need a step-up (local confirmation, or the
   * offline CLI while the Host is stopped); lowering changes do not, and still apply when the audit log fails
   * (`audited: false`; callers answer `x-latch-audit: failed`). With `expectedBaseHash` (the policy a confirmation
   * showed), the change applies only while the policy still hashes to it, checked on this store's queue.
   */
  update(next: Policy, actor: AuditActor, stepup: StepupMethod, expectedBaseHash?: string): Promise<{ audited: boolean }> {
    const run = this.queue.then(async () => {
      if (expectedBaseHash !== undefined && expectedBaseHash !== this.hash())
        throw new AppError(409, 'policy-changed', '安全策略已被修改，请刷新后重试')
      const parsed = policySchema.safeParse(next)
      if (!parsed.success)
        throw new AppError(400, 'invalid-policy', `安全策略无效：${parsed.error.issues.map(issue => issue.message).join('；')}`)
      const prev = this.policy
      const candidate = parsed.data
      const diff = policyDiff(prev, candidate)
      if (diff.length === 0) return { audited: true }
      const lowering = isLowering(prev, candidate)
      if (!lowering && stepup === 'none') throw new AppError(403, 'stepup-required', '需要在本机确认', { stepup: { where: 'this-device' } })
      return this.commit(
        candidate,
        diff.map(item => item.path),
        lowering,
        actor,
        stepup,
      )
    })
    this.queue = run.catch(() => {})
    return run
  }

  /**
   * Startup only, no confirmation: trust-on-first-use pin of the presence helper's code directory hash. Only the first
   * pin is automatic; once the audit log holds one, an empty pin means policy.json was reset, and re-pinning whatever
   * binary is present would accept a swapped helper, so it needs `pnpm latch presence repin`. Runs on the same queue as
   * `update`, so a confirmed change based on the unpinned policy is refused afterwards.
   */
  pinHelperCdhash(cdhash: string): Promise<void> {
    const run = this.queue.then(async () => {
      if (!/^[0-9a-f]{40}$/u.test(cdhash)) throw new AppError(500, 'presence-cdhash-invalid', '本机确认组件的签名摘要格式无效')
      const pinned = this.policy.presence.helperCdhash
      if (pinned === cdhash) return
      if (pinned !== null)
        throw new AppError(
          409,
          'presence-already-pinned',
          '本机确认组件已登记其他签名；如需更换，请停止 Host 后运行 pnpm latch presence repin。',
        )
      if (this.audit.latest(['presence.helper.pinned'])) {
        throw new AppError(
          409,
          'presence-repin-required',
          '本机确认组件的登记签名已丢失（policy.json 被修改或删除）。请停止 Host 后运行 pnpm latch presence repin。',
        )
      }
      await this.audit.append({ action: 'presence.helper.pinned', actor: { listener: 'host', via: 'startup' }, detail: { cdhash } })
      const candidate = structuredClone(this.policy)
      candidate.presence.helperCdhash = cdhash
      await this.commit(candidate, ['presence.helperCdhash'], false, { listener: 'host', via: 'startup' }, 'none')
    })
    this.queue = run.catch(() => {})
    return run
  }

  /** Lowering changes are privilege-reducing: an audit failure is reported, never allowed to keep the wider policy. */
  private async commit(
    candidate: Policy,
    fields: string[],
    lowering: boolean,
    actor: AuditActor,
    stepup: StepupMethod,
  ): Promise<{ audited: boolean }> {
    const before = this.hash()
    const after = sha256Hex(canonicalJson(candidate))
    let seq: number | undefined
    try {
      seq = (await this.audit.append({ action: 'policy.changed', actor, stepup, detail: { before, after, fields, lowering } })).seq
    } catch (error) {
      if (!lowering || !(error instanceof AppError && error.code === 'audit-unavailable')) throw error
    }
    try {
      await writeFileAtomic(join(this.dataDir, FILE), `${JSON.stringify(candidate, null, 2)}\n`, { prefix: '.policy-' })
    } catch (error) {
      if (seq !== undefined) await this.audit.append({ action: 'action.failed', actor, detail: { refSeq: seq } }).catch(() => {})
      throw error
    }
    this.policy = candidate
    return { audited: seq !== undefined }
  }
}
