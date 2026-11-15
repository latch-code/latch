import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { AppError } from '@latch/sdk'
import type { GitPrBinding, TaskSummary } from '@latch/protocol'
import { writeFileAtomic } from '@latch/core/node-kit'
import { runEndSchema } from '@latch/core/run-end'
import { HELPER_HOME_NAME, SESSION_FOLDER_NAME } from './session-folders.ts'
import { PR_URL } from './git-pr.ts'
import { BRANCH_NAME } from './worktrees.ts'

export const SESSION_META_FILE = 'sessions-meta.json'
/** A receipt answers retries for this long, and never longer than its session exists. */
export const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const RECEIPTS_PER_DEVICE = 10_000
export const MAX_RECEIPTS = 100_000
/** Sessions with metadata the file holds; receipt-only entries come on top, so the read limit covers both. */
const MAX_META_SESSIONS = 100_000
/** `TaskSummary.runId` as the Host accepts it in a cancel; the Hub drops a driver's run ID of any other form. */
export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,127}$/u

const TASK_STATUSES = ['idle', 'running', 'waiting-approval', 'cancelled', 'failed', 'interrupted'] as const
/** `Date#toISOString()`, the only form the Host writes. */
const isoTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
const requestIdText = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u)
const deviceIdText = z.string().min(1).max(64)
const runIdText = z.string().regex(RUN_ID)
/** `<pluginId>/<appId>` of a plugin page. */
export const APP_REF = /^[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}$/u

// Every persisted field must be listed: z.object drops unknown keys on load.
const approvalReceiptSchema = z.object({
  kind: z.literal('approval'),
  approvalId: z.string().min(1).max(256),
  requestId: requestIdText.optional(),
  deviceId: deviceIdText,
  decision: z.enum(['allow', 'reject']),
  optionId: z.string().min(1).max(128).optional(),
  optionKind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
  at: isoTime,
})
const cancelReceiptSchema = z.object({
  kind: z.literal('cancel'),
  requestId: requestIdText,
  deviceId: deviceIdText,
  runId: runIdText.optional(),
  outcome: z.enum(['stopped', 'ended']),
  status: z.enum(TASK_STATUSES).optional(),
  runEnd: runEndSchema.optional(),
  at: isoTime,
})
const configReceiptSchema = z.strictObject({
  kind: z.literal('config'),
  requestId: requestIdText,
  deviceId: deviceIdText,
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/u),
  state: z.enum(['pending', 'applied', 'failed', 'unknown']),
  at: isoTime,
  /** Hash of the option's value before the change, as `payloadHash` is of the asked one: 核对 reads it as failed. */
  priorHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  /** The audit entry of the change, for the entry that settles it. */
  auditSeq: z.number().int().min(1).optional(),
})
const oidText = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u)
const hex64Text = z.string().regex(/^[a-f0-9]{64}$/u)
/** The pull request bound to a session (docs/GIT-DELIVERY.md#pr-与检查). */
const branchText = z
  .string()
  .min(1)
  .max(256)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f\u007f]+$/u)
const prBindingSchema = z.strictObject({
  number: z.number().int().positive().max(999_999_999),
  url: z.string().max(512).regex(PR_URL),
  /** For display: never handed back to Git. */
  base: branchText,
  head: branchText,
})
/**
 * A commit, push or pull request of 交付 (docs/GIT-DELIVERY.md): written `pending` before Git runs, so a retry or a later Host process
 * never runs it a second time. A `pending` one read from the file is `unknown`: Git may or may not have finished.
 */
const gitReceiptSchema = z.strictObject({
  kind: z.literal('git'),
  operation: z.enum(['commit', 'push', 'pr', 'stage', 'unstage']),
  requestId: requestIdText,
  deviceId: deviceIdText,
  payloadHash: hex64Text,
  state: z.enum(['pending', 'done', 'failed', 'unknown']),
  /** Commit: HEAD before (absent on an unborn branch), the index's tree, the subject line's hash, hooks skipped. */
  preHead: oidText.optional(),
  indexTree: oidText.optional(),
  subjectHash: hex64Text.optional(),
  skipHooks: z.literal(true).optional(),
  /** Commit: where HEAD pointed, `refs/heads/<branch>` or `HEAD` when detached; absent in receipts written before it. */
  headRef: z
    .string()
    .max(1024)
    .regex(/^(?:HEAD|refs\/heads\/[^\u0000-\u001f\u007f]+)$/u)
    .optional(),
  startedAt: isoTime.optional(),
  /** Push: the remote's name, the ref on it, the commit sent, and whether the push sets the upstream. */
  remote: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u)
    .optional(),
  ref: z.string().min(12).max(1024).startsWith('refs/heads/').optional(),
  localSha: oidText.optional(),
  setUpstream: z.literal(true).optional(),
  via: z.enum(['upstream', 'push-remote', 'origin']).optional(),
  /** The commit made, once done. */
  commit: oidText.optional(),
  /**
   * Staging by line: the index entry the write replaces, the blob it puts there, and how many changed lines it picks.
   * A retry whose answer was lost is settled by which of the two the index holds.
   */
  preIndex: oidText.optional(),
  resultOid: oidText.optional(),
  lines: z.number().int().min(1).max(40_000).optional(),
  /** PR: the pull request made or bound, once done; `linked` when it was found open rather than made. */
  pr: prBindingSchema.optional(),
  linked: z.literal(true).optional(),
  /** The fixed reason a failed one gives on a retry, and the hook that failed. */
  code: z
    .string()
    .regex(/^(?:git|gh|pr)-[a-z-]{1,60}$/u)
    .optional(),
  hook: z
    .string()
    .regex(/^[a-z0-9-]{1,40}$/u)
    .optional(),
  exitCode: z.number().int().min(-1).max(255).optional(),
  at: isoTime,
})
const receiptSchema = z.discriminatedUnion('kind', [approvalReceiptSchema, cancelReceiptSchema, configReceiptSchema, gitReceiptSchema])

/** One session's entry; `update` checks each change against it, so the file never holds what it cannot read back. */
const sessionEntrySchema = z.object({
  id: z.string().min(1).max(256),
  title: z.string().min(1).max(200).optional(),
  pinned: z.literal(true).optional(),
  archived: z.literal(true).optional(),
  personal: z.strictObject({ assistantId: z.string().min(1).max(128), groupId: z.string().min(1).max(128).optional() }).optional(),
  agent: z.strictObject({ customAgentId: z.string().min(1).max(128) }).optional(),
  automationId: z.string().min(1).max(64).optional(),
  generalChat: z.literal(true).optional(),
  proposals: z.literal(true).optional(),
  origin: z
    .strictObject({
      app: z.string().regex(APP_REF),
      requestId: requestIdText,
      install: z
        .string()
        .regex(/^[A-Za-z0-9_-]{22}$/u)
        .optional(),
      level: z.enum(['L1', 'L3']).optional(),
      mode: z.string().max(256).optional(),
      changed: z.literal(true).optional(),
    })
    .optional(),
  agentPrivate: z.literal(true).optional(),
  workspaceId: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u)
    .optional(),
  sessionFolder: z.union([z.string().regex(SESSION_FOLDER_NAME), z.string().regex(HELPER_HOME_NAME)]).optional(),
  worktree: z
    .strictObject({
      path: z.string().min(2).max(4096).startsWith('/'),
      branch: z.string().regex(BRANCH_NAME),
      unfiltered: z.number().int().min(1).max(10_000_000).optional(),
      removed: z.literal(true).optional(),
    })
    .optional(),
  firstStart: z.literal(true).optional(),
  pr: prBindingSchema.optional(),
  forkOf: z
    .object({
      taskId: z.string().min(1).max(256),
      upToMessageId: z.string().min(1).max(256),
      title: z.string().max(80),
      turn: z.number().int().nonnegative(),
      prefixLength: z.number().int().min(1).max(201_000),
      truncated: z.literal(true).optional(),
    })
    .optional(),
  imported: z
    .strictObject({
      from: z.string().min(1).max(128),
      store: z.string().min(1).max(200).optional(),
      mode: z.enum(['native', 'text']),
      agentSessionId: z.string().min(1).max(512).optional(),
      fromTaskId: z.string().min(1).max(256).optional(),
      prefixLength: z.number().int().min(1).max(201_000).optional(),
      truncated: z.literal(true).optional(),
    })
    .optional(),
  receipts: z.array(z.unknown()).max(MAX_RECEIPTS).optional(),
})

/**
 * Version 1 since titles, pins and archives; receipts were added as an optional field, so files written before them
 * load unchanged and older builds read newer files (dropping the receipts) while they hold at most 100,000 sessions.
 * Receipts are checked one by one: one that this build cannot read (a later kind, a damaged entry) is left out instead
 * of failing the whole file.
 */
const metaSchema = z.object({
  version: z.literal(1),
  sessions: z.array(sessionEntrySchema).max(MAX_META_SESSIONS + MAX_RECEIPTS),
})

export type ApprovalRecord = z.infer<typeof approvalReceiptSchema>
export type CancelRecord = z.infer<typeof cancelReceiptSchema>
export type ConfigRecord = z.infer<typeof configReceiptSchema>
export type GitRecord = z.infer<typeof gitReceiptSchema>
export type StoredReceipt = ApprovalRecord | CancelRecord | ConfigRecord | GitRecord
/**
 * The plugin page that started a session: its plugin record (`install`), and the permission level and mode the session
 * started with, so a page cannot drive a session a person widened.
 */
export interface PageOrigin {
  app: string
  requestId: string
  install?: string
  level?: 'L1' | 'L3'
  mode?: string
  /** A person asked to change the session's permission mode after the page started it. */
  changed?: true
}
/** Host-level session metadata (title, pin, archive); receipts are kept beside it. */
export interface StoredMeta {
  personal?: TaskSummary['personal']
  agent?: TaskSummary['agent']
  automationId?: string
  /** A conversation with 通用 in 我的 Agent. */
  generalChat?: true
  /** Started with `propose_memory`: only such a session's driver may hand the Host proposals. */
  proposals?: true
  /** The plugin page that started the session, with the page's own request ID. */
  origin?: PageOrigin
  agentPrivate?: true
  title?: string
  pinned?: true
  archived?: true
  workspaceId?: string
  sessionFolder?: string
  /**
   * The worktree the Host made for the session (its `cwd`), the branch it made with it, and how many tracked files were
   * left as Git stores them because their filter did not run; `removed` once the worktree was removed (the session stays,
   * read-only).
   */
  worktree?: { path: string; branch: string; unfiltered?: number; removed?: true }
  firstStart?: true
  /** The pull request 交付 made or found for the session's branch. */
  pr?: GitPrBinding
  forkOf?: TaskSummary['forkOf']
  /**
   * Brought in from the harness `from`'s own session `agentSessionId` (docs/HARNESSES.md#接入已有会话), or rebuilt as text
   * from the Latch session `fromTaskId` that was. Makes the session private. One Latch session per external session.
   */
  imported?: ImportedMeta
}

export interface ImportedMeta {
  from: string
  /** The record the external session ID belongs to (`Bridge.historyStore`); one Latch session per ID in it. */
  store?: string
  mode: 'native' | 'text'
  agentSessionId?: string
  fromTaskId?: string
  prefixLength?: number
  truncated?: true
}

interface Entry {
  sessionId: string
  receipt: StoredReceipt
}

/** What the Host reads and records about approval decisions and cancels. */
export interface SessionReceipts {
  /** The recorded decision on an approval, from any device. */
  approval(approvalId: string): { sessionId: string; record: ApprovalRecord } | undefined
  /** A cancel this device sent on this session with this `requestId`. */
  cancel(sessionId: string, deviceId: string, requestId: string): CancelRecord | undefined
  /**
   * Visible to the two lookups at once; the returned promise settles when the file holds it. A failed write leaves the
   * receipt in memory and in the next write.
   */
  record(sessionId: string, receipt: ApprovalRecord | CancelRecord): Promise<void>
  config(sessionId: string, deviceId: string, requestId: string): ConfigRecord | undefined
  /** Config identities never expire before their session; capacity is refused before an Agent can be invoked. */
  recordConfig(sessionId: string, receipt: ConfigRecord): Promise<void>
  /** A commit or push of 交付 this device sent on this session with this `requestId`. */
  git(sessionId: string, deviceId: string, requestId: string): GitRecord | undefined
  /** Settles when the file holds it; a failed write throws, so a write that must be on record first does not run. */
  recordGit(sessionId: string, receipt: GitRecord): Promise<void>
}

function codeOf(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

function cancelKey(sessionId: string, deviceId: string, requestId: string): string {
  return `${sessionId}\n${deviceId}\n${requestId}`
}

export interface SessionMetaOptions {
  now?: () => number
  log?: (message: string) => void
}

/**
 * Atomic, serialized writer for the Host's per-session overlay: title, pin and archive, and the receipts of approval
 * decisions, cancels and configuration changes. Decisions/cancels expire after seven days; config identities remain
 * until session deletion. All receipts share finite device/Host capacities; config insertion fails closed.
 */
export class SessionMetaStore implements SessionReceipts {
  private queue: Promise<void> = Promise.resolve()
  /** A receipt write that is queued and not yet started: receipts recorded meanwhile share it. */
  private pendingWrite: Promise<void> | undefined
  /** Insertion order is age order: entries are added with the current time and loaded sorted by it. */
  private readonly entries = new Set<Entry>()
  private readonly approvals = new Map<string, Entry>()
  private readonly cancels = new Map<string, Entry>()
  private readonly configs = new Map<string, Entry>()
  private readonly gits = new Map<string, Entry>()
  private readonly perDevice = new Map<string, number>()

  private constructor(
    private readonly path: string,
    private readonly dataDir: string,
    private meta: Map<string, StoredMeta>,
    private readonly now: () => number,
  ) {}

  static async open(dataDir: string, options: SessionMetaOptions = {}): Promise<SessionMetaStore> {
    const path = join(dataDir, SESSION_META_FILE)
    let text: string | undefined
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error
    }
    const meta = new Map<string, StoredMeta>()
    const loaded: Entry[] = []
    let skipped = 0
    if (text !== undefined) {
      let parsed: z.infer<typeof metaSchema>
      try {
        parsed = metaSchema.parse(JSON.parse(text))
      } catch {
        throw new AppError(500, 'config-corrupt', `会话设置文件 ${path} 无法读取，原文件已保留；请修复或移走后重启`)
      }
      for (const { id, receipts, ...fields } of parsed.sessions) {
        if (Object.keys(fields).length) meta.set(id, fields)
        for (const value of receipts ?? []) {
          const receipt = receiptSchema.safeParse(value)
          if (receipt.success) {
            if ((receipt.data.kind === 'config' || receipt.data.kind === 'git') && receipt.data.state === 'pending')
              receipt.data.state = 'unknown'
            loaded.push({ sessionId: id, receipt: receipt.data })
          } else if (typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'config') {
            throw new AppError(500, 'config-corrupt', '会话配置回执无法读取，原文件已保留。')
          } else skipped++
        }
      }
    }
    const store = new SessionMetaStore(path, dataDir, meta, options.now ?? Date.now)
    loaded.sort((a, b) => Date.parse(a.receipt.at) - Date.parse(b.receipt.at))
    const configDevices = new Map<string, number>()
    for (const entry of loaded) {
      if (entry.receipt.kind === 'config') {
        if (
          store.config(entry.sessionId, entry.receipt.deviceId, entry.receipt.requestId)
          || store.configs.size >= MAX_RECEIPTS
          || (configDevices.get(entry.receipt.deviceId) ?? 0) >= RECEIPTS_PER_DEVICE
        )
          throw new AppError(500, 'config-corrupt', '会话配置回执有重复标识或超过容量，原文件已保留。')
        configDevices.set(entry.receipt.deviceId, (configDevices.get(entry.receipt.deviceId) ?? 0) + 1)
      }
      store.insert(entry)
    }
    store.prune()
    if (skipped) options.log?.(`会话设置文件中有 ${skipped} 条无法识别的回执，已忽略`)
    return store
  }

  get(sessionId: string): StoredMeta | undefined {
    return this.meta.get(sessionId)
  }

  /** The session a plugin page started with this request ID. */
  findOrigin(app: string, requestId: string, install: string): string | undefined {
    for (const [sessionId, meta] of this.meta)
      if (meta.origin?.app === app && meta.origin.requestId === requestId && meta.origin.install === install) return sessionId
    return undefined
  }

  /** Sessions brought in from a harness's own record. */
  imported(): Array<{ sessionId: string; imported: ImportedMeta }> {
    return [...this.meta.entries()].flatMap(([sessionId, meta]) => (meta.imported ? [{ sessionId, imported: meta.imported }] : []))
  }

  /** Folder names owned by sessions in the Host metadata. */
  sessionFolders(): string[] {
    return [...this.meta.values()].flatMap(meta => (meta.sessionFolder ? [meta.sessionFolder] : []))
  }

  /** The worktrees the Host made for sessions, with the project each session started in. */
  worktrees(): Array<{ sessionId: string; path: string; workspaceId?: string; removed?: true }> {
    return [...this.meta.entries()].flatMap(([sessionId, meta]) =>
      meta.worktree
        ? [
            {
              sessionId,
              path: meta.worktree.path,
              ...(meta.workspaceId ? { workspaceId: meta.workspaceId } : {}),
              ...(meta.worktree.removed ? { removed: true as const } : {}),
            },
          ]
        : [],
    )
  }

  /** Whether the session has metadata or receipts to remove. */
  has(sessionId: string): boolean {
    if (this.meta.has(sessionId)) return true
    for (const entry of this.entries) if (entry.sessionId === sessionId) return true
    return false
  }

  /** Publishes in memory only after the rename, so a failed write leaves the previous metadata visible. */
  update(sessionId: string, change: (meta: StoredMeta) => StoredMeta | undefined): Promise<void> {
    return this.enqueue(async () => {
      const next = new Map(this.meta)
      const meta = change({ ...next.get(sessionId) })
      if (meta && Object.keys(meta).length && !sessionEntrySchema.safeParse({ id: sessionId, ...meta }).success)
        throw new AppError(500, 'session-meta-invalid', '会话设置无法保存：内容不符合格式，没有写入。')
      if (meta && Object.keys(meta).length) next.set(sessionId, meta)
      else next.delete(sessionId)
      await this.write(next)
      this.meta = next
    })
  }

  /** Drops the session's metadata and receipts. */
  remove(sessionId: string): Promise<void> {
    // Deleting the entry being visited is safe for a Set: iteration continues with the next one.
    for (const entry of this.entries) if (entry.sessionId === sessionId) this.delete(entry)
    return this.update(sessionId, () => undefined)
  }

  approval(approvalId: string): { sessionId: string; record: ApprovalRecord } | undefined {
    this.prune()
    const entry = this.approvals.get(approvalId)
    return entry?.receipt.kind === 'approval' ? { sessionId: entry.sessionId, record: entry.receipt } : undefined
  }

  cancel(sessionId: string, deviceId: string, requestId: string): CancelRecord | undefined {
    this.prune()
    const receipt = this.cancels.get(cancelKey(sessionId, deviceId, requestId))?.receipt
    return receipt?.kind === 'cancel' ? receipt : undefined
  }

  record(sessionId: string, receipt: ApprovalRecord | CancelRecord): Promise<void> {
    this.insert({ sessionId, receipt: structuredClone(receipt) })
    this.prune()
    // The write reads the receipts when it starts, so every receipt recorded before then is in it.
    this.pendingWrite ??= this.enqueue(async () => {
      this.pendingWrite = undefined
      await this.write(this.meta)
    })
    return this.pendingWrite
  }

  config(sessionId: string, deviceId: string, requestId: string): ConfigRecord | undefined {
    const value = this.configs.get(cancelKey(sessionId, deviceId, requestId))?.receipt
    return value?.kind === 'config' ? structuredClone(value) : undefined
  }

  recordConfig(sessionId: string, input: ConfigRecord): Promise<void> {
    const receipt = configReceiptSchema.parse(input),
      previous = this.config(sessionId, receipt.deviceId, receipt.requestId)
    if (previous && previous.payloadHash !== receipt.payloadHash)
      throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同配置。')
    this.prune()
    if (!previous && (this.entries.size >= MAX_RECEIPTS || (this.perDevice.get(receipt.deviceId) ?? 0) >= RECEIPTS_PER_DEVICE))
      throw new AppError(409, 'config-receipt-limit', '配置回执已满，请删除不需要的旧会话后再修改。')
    this.insert({ sessionId, receipt })
    return this.enqueue(async () => {
      try {
        await this.write(this.meta)
      } catch {
        const current = this.config(sessionId, receipt.deviceId, receipt.requestId)
        if (current?.payloadHash === receipt.payloadHash) this.insert({ sessionId, receipt: { ...current, state: 'unknown' } })
        throw new AppError(503, 'config-outcome-unknown', '配置修改结果尚未确认，请查询原请求，不能重复执行。')
      }
    })
  }

  git(sessionId: string, deviceId: string, requestId: string): GitRecord | undefined {
    this.prune()
    const value = this.gits.get(cancelKey(sessionId, deviceId, requestId))?.receipt
    return value?.kind === 'git' ? structuredClone(value) : undefined
  }

  async recordGit(sessionId: string, input: GitRecord): Promise<void> {
    const receipt = gitReceiptSchema.parse(input),
      key = cancelKey(sessionId, receipt.deviceId, receipt.requestId)
    const entry: Entry = { sessionId, receipt }
    this.insert(entry)
    this.prune()
    try {
      await this.enqueue(() => this.write(this.meta))
    } catch (error) {
      // A start that is not on record does not run, so it must not answer a retry either.
      if (receipt.state === 'pending' && this.gits.get(key) === entry) this.delete(entry)
      throw error
    }
  }

  flush(): Promise<void> {
    return this.queue
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task)
    this.queue = run.then(
      () => {},
      () => {},
    )
    return run
  }

  private insert(entry: Entry): void {
    const { receipt, sessionId } = entry
    // A key is answered by its first receipt; a second one for the same key only happens when a file was edited.
    if (receipt.kind === 'approval') {
      const previous = this.approvals.get(receipt.approvalId)
      if (previous) this.delete(previous)
      this.approvals.set(receipt.approvalId, entry)
    } else {
      const key = cancelKey(sessionId, receipt.deviceId, receipt.requestId),
        index = this.indexOf(receipt.kind)
      const previous = index.get(key)
      if (previous) this.delete(previous)
      index.set(key, entry)
    }
    this.entries.add(entry)
    this.perDevice.set(receipt.deviceId, (this.perDevice.get(receipt.deviceId) ?? 0) + 1)
  }

  private indexOf(kind: 'cancel' | 'config' | 'git'): Map<string, Entry> {
    return kind === 'config' ? this.configs : kind === 'git' ? this.gits : this.cancels
  }

  private delete(entry: Entry): void {
    if (!this.entries.delete(entry)) return
    const { receipt, sessionId } = entry
    if (receipt.kind === 'approval') {
      if (this.approvals.get(receipt.approvalId) === entry) this.approvals.delete(receipt.approvalId)
    } else {
      const key = cancelKey(sessionId, receipt.deviceId, receipt.requestId)
      const index = this.indexOf(receipt.kind)
      if (index.get(key) === entry) index.delete(key)
    }
    const count = (this.perDevice.get(receipt.deviceId) ?? 1) - 1
    if (count > 0) this.perDevice.set(receipt.deviceId, count)
    else this.perDevice.delete(receipt.deviceId)
  }

  private prune(): void {
    const oldest = this.now() - RECEIPT_TTL_MS
    for (const entry of this.entries) {
      if (entry.receipt.kind === 'config') continue
      const at = Date.parse(entry.receipt.at)
      if (this.entries.size <= MAX_RECEIPTS && at >= oldest) break
      this.delete(entry)
    }
    for (const [device, count] of this.perDevice) {
      if (count <= RECEIPTS_PER_DEVICE) continue
      let excess = count - RECEIPTS_PER_DEVICE
      for (const entry of this.entries) {
        if (excess === 0) break
        if (entry.receipt.deviceId !== device || entry.receipt.kind === 'config') continue
        this.delete(entry)
        excess--
      }
    }
  }

  private async write(meta: Map<string, StoredMeta>): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 })
    const receipts = new Map<string, StoredReceipt[]>()
    for (const { sessionId, receipt } of this.entries) {
      const list = receipts.get(sessionId)
      if (list) list.push(receipt)
      else receipts.set(sessionId, [receipt])
    }
    const sessions = [...meta].map(([id, fields]) => ({ id, ...fields, ...(receipts.has(id) ? { receipts: receipts.get(id) } : {}) }))
    for (const [id, list] of receipts) if (!meta.has(id)) sessions.push({ id, receipts: list })
    await writeFileAtomic(this.path, JSON.stringify({ version: 1, sessions }) + '\n', { prefix: `${SESSION_META_FILE}.` })
  }
}
