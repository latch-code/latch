import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { Approval, HarnessInfo, HarnessSource, SessionPermission, TaskDetail, TaskSummary } from '@latch/protocol'
import {
  AppError,
  type HarnessDriver,
  type Bridge,
  type ConfigChangeClass,
  type CreateTaskInput,
  type DecideOptions,
  type LaunchPreview,
  type ProjectFolder,
  type PromptOptions,
  type SetConfigOptions,
} from '@latch/sdk'
import { writeFileAtomic } from '@latch/core/node-kit'
import { SESSION_FOLDER_NAME } from './session-folders.ts'

/**
 * `harnessId` is Host-only. `workspaceId` and `folders` reach only drivers that declare `projectFolders: 'all'`; the
 * hub strips them for every other driver, which then works in `cwd` alone.
 */
export interface HubCreateInput extends CreateTaskInput {
  harnessId?: string
  /** The project the Host expanded `cwd` from; kept in the Host's session metadata. */
  workspaceId?: string
  /** The name of the folder the Host made for this session alone in its start directory (`cwd`); never sent to the driver. */
  sessionFolder?: string
}

/** Host-level session metadata; it applies to every harness. `title: null` removes an override. */
export interface SessionMetaPatch {
  title?: string | null
  pinned?: boolean
  archived?: boolean
}

export interface HarnessMount {
  /** Creates the unstarted Bridge; the hub starts it. */
  create(): Bridge
  /** Returns the registry lease after the Bridge has closed. */
  release(): void
  source: HarnessSource
  /** Overrides `driver.capabilities`, e.g. for a built-in driver that predates the field. */
  capabilities?: Pick<HarnessInfo, 'modes' | 'models'>
  /** A required driver that fails to start fails `attach`; others are listed as unavailable. */
  required?: boolean
}

export interface HubOptions {
  /** Directory for `sessions-meta.json`. */
  dataDir: string
  /** Harness for `createTask` without `harnessId`. */
  defaultId: () => string
  log?: (message: string) => void
}

interface Entry {
  driver: HarnessDriver
  source: HarnessSource
  capabilities?: Pick<HarnessInfo, 'modes' | 'models'>
  bridge?: Bridge
  release?: () => void
  unsubscribe?: () => void
  /** Start failure; the entry stays listed as unavailable. */
  failure?: string
  /** Not routable until `start()` resolves. */
  starting?: boolean
  detaching?: boolean
  /** createTask, prompt and setConfig calls the Bridge has not settled yet. */
  accepting: number
}

type Member = Entry & { bridge: Bridge }

const META_FILE = 'sessions-meta.json'
const metaSchema = z.object({
  version: z.literal(1),
  sessions: z
    .array(
      z.object({
        id: z.string().min(1).max(256),
        title: z.string().min(1).max(200).optional(),
        pinned: z.literal(true).optional(),
        archived: z.literal(true).optional(),
        /** The project the session was started in; written once, right after the driver created it. */
        workspaceId: z
          .string()
          .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u)
          .optional(),
        /** The name of the folder the Host made for the session in its start directory; written with `workspaceId`. */
        sessionFolder: z.string().regex(SESSION_FOLDER_NAME).optional(),
      }),
    )
    .max(100_000),
})
type StoredMeta = Omit<z.infer<typeof metaSchema>['sessions'][number], 'id'>

const DEFAULT_CAPABILITIES: Pick<HarnessInfo, 'modes' | 'models'> = { modes: ['chat', 'agent'], models: 'agent' }
const ACTIVE = new Set<TaskSummary['status']>(['running', 'waiting-approval'])
const MAX_DETAIL_APPROVALS = 1024
const PLUGIN_NOTE = '第三方 Harness 插件，Latch 无法核实其执行范围'

/** Builtin runs under Latch's own approvals (L1); ACP agents and plugin harnesses run unsandboxed (L3). */
const PRIMARY_ACCESS = new Set<unknown>(['primary', 'primary-asks', 'primary-unbounded'])

/** What clients are told about a project's other folders: `all` only for a driver that receives them all. */
function folderInfo(driver: HarnessDriver): Pick<HarnessInfo, 'projectFolders'> {
  const declared: unknown = driver.folderAccess
  const { access, max } = (typeof declared === 'object' && declared !== null ? declared : {}) as { access?: unknown; max?: unknown }
  if (driver.projectFolders === 'all')
    return {
      projectFolders: {
        access: 'all',
        ...(access === 'all' && Number.isSafeInteger(max) && (max as number) >= 1 ? { max: max as number } : {}),
      },
    }
  return PRIMARY_ACCESS.has(access) ? { projectFolders: { access: access as 'primary' | 'primary-asks' | 'primary-unbounded' } } : {}
}

function levelFor(source: HarnessSource): 'L1' | 'L3' {
  return source === 'builtin' ? 'L1' : 'L3'
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
function codeOf(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

/** Atomic, serialized writer for the Host's per-session overlay (title, pin, archive). */
class SessionMetaStore {
  private queue: Promise<void> = Promise.resolve()

  private constructor(
    private readonly path: string,
    private readonly dataDir: string,
    private entries: Map<string, StoredMeta>,
  ) {}

  static async open(dataDir: string): Promise<SessionMetaStore> {
    const path = join(dataDir, META_FILE)
    let text: string | undefined
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error
    }
    const entries = new Map<string, StoredMeta>()
    if (text !== undefined) {
      let parsed: z.infer<typeof metaSchema>
      try {
        parsed = metaSchema.parse(JSON.parse(text))
      } catch {
        throw new AppError(500, 'config-corrupt', `会话设置文件 ${path} 无法读取，原文件已保留；请修复或移走后重启`)
      }
      for (const { id, ...meta } of parsed.sessions) entries.set(id, meta)
    }
    return new SessionMetaStore(path, dataDir, entries)
  }

  get(sessionId: string): StoredMeta | undefined {
    return this.entries.get(sessionId)
  }

  /** The names of the folders the Host made for sessions it still has metadata for. */
  sessionFolders(): string[] {
    const names: string[] = []
    for (const meta of this.entries.values()) if (meta.sessionFolder) names.push(meta.sessionFolder)
    return names
  }

  /** Publishes in memory only after the rename, so a failed write leaves the previous state visible. */
  update(sessionId: string, change: (meta: StoredMeta) => StoredMeta | undefined): Promise<void> {
    const run = this.queue.then(async () => {
      const next = new Map(this.entries)
      const meta = change({ ...next.get(sessionId) })
      if (meta && Object.keys(meta).length) next.set(sessionId, meta)
      else next.delete(sessionId)
      await this.write(next)
      this.entries = next
    })
    this.queue = run.then(
      () => {},
      () => {},
    )
    return run
  }

  flush(): Promise<void> {
    return this.queue
  }

  private async write(entries: Map<string, StoredMeta>): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 })
    const sessions = [...entries].map(([id, meta]) => ({ id, ...meta }))
    await writeFileAtomic(this.path, JSON.stringify({ version: 1, sessions }) + '\n', { prefix: `${META_FILE}.` })
  }
}

/**
 * One Bridge over every mounted HarnessDriver. Session and approval IDs pass through verbatim; the
 * routes are derived from createTask results, notifications and listings, never persisted, so they
 * rebuild after a restart and cannot drift from the drivers' own state.
 */
export class HarnessHub implements Bridge {
  private readonly entries = new Map<string, Entry>()
  private readonly routes = new Map<string, string>()
  /** Approvals seen only through `detail()`, for drivers that do not list them in `approvals()`. */
  private readonly detailApprovals = new Map<string, string>()
  private readonly listeners = new Set<(sessionId?: string) => void>()
  private readonly collisions = new Set<string>()
  private readonly log: (message: string) => void
  private closing?: Promise<void>

  private constructor(
    private readonly options: HubOptions,
    private readonly meta: SessionMetaStore,
  ) {
    this.log = options.log ?? (text => console.error(`[Latch] ${text}`))
  }

  static async open(options: HubOptions): Promise<HarnessHub> {
    return new HarnessHub(options, await SessionMetaStore.open(options.dataDir))
  }

  /** Mounts a driver: creates and starts its Bridge. Order matters: on an ID collision the earlier mount wins. */
  async attach(driver: HarnessDriver, mount: HarnessMount): Promise<HarnessInfo> {
    const current = this.entries.get(driver.id)
    const refusal = this.closing
      ? new AppError(503, 'host-closing', '运行节点正在关闭')
      : current?.bridge || current?.starting
        ? new AppError(409, 'harness-exists', `Harness ${driver.id} 已加载`)
        : undefined
    if (refusal) {
      mount.release()
      throw refusal
    }
    const entry: Entry = {
      driver,
      source: mount.source,
      starting: true,
      accepting: 0,
      ...(mount.capabilities ? { capabilities: mount.capabilities } : {}),
    }
    this.entries.delete(driver.id)
    this.entries.set(driver.id, entry)
    let bridge: Bridge | undefined
    try {
      bridge = mount.create()
      entry.unsubscribe = bridge.subscribe(sessionId => {
        if (this.entries.get(driver.id) !== entry) return
        if (sessionId && !this.claim(driver.id, sessionId)) return
        this.emit(sessionId)
      })
      await bridge.start()
      // close() or detach() ran while this driver was starting; it was never visible, so retire it here.
      if (this.closing || this.entries.get(driver.id) !== entry)
        throw new AppError(503, 'harness-detached', `Harness ${driver.id} 已在启动期间停用`)
      Object.assign(entry, { bridge, release: mount.release })
    } catch (error) {
      entry.unsubscribe?.()
      delete entry.unsubscribe
      try {
        await bridge?.close()
      } catch (closeError) {
        this.log(`Harness ${driver.id} 启动失败后清理失败：${message(closeError)}`)
      } finally {
        mount.release()
      }
      if (mount.required || this.entries.get(driver.id) !== entry) {
        if (this.entries.get(driver.id) === entry) this.entries.delete(driver.id)
        throw error
      }
      entry.failure = `启动失败：${message(error)}`
      this.log(`Harness ${driver.id} ${entry.failure}`)
    } finally {
      delete entry.starting
    }
    this.emit()
    return this.describe(entry)
  }

  /** Unmounts a driver after its sessions settle; its sessions disappear until it is mounted again. */
  async detach(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return
    if (!entry.bridge) {
      this.entries.delete(id)
      this.emit()
      return
    }
    if (entry.detaching) throw new AppError(409, 'harness-busy', `Harness ${id} 正在停用`)
    const member = entry as Member
    // A Bridge may list a new session or turn only once the call settles, so in-flight work counts as running.
    if (member.accepting) throw new AppError(409, 'harness-busy', `${member.driver.name} 正在接收新的请求，请稍后再试`)
    member.detaching = true
    let tasks: TaskSummary[]
    try {
      tasks = await member.bridge.listTasks()
    } catch (error) {
      member.detaching = false
      throw error
    }
    if (tasks.some(task => ACTIVE.has(task.status))) {
      member.detaching = false
      throw new AppError(409, 'harness-busy', `${member.driver.name} 仍有运行中的会话，请等待完成或先取消`)
    }
    this.entries.delete(id)
    for (const [sessionId, owner] of this.routes) if (owner === id) this.routes.delete(sessionId)
    for (const [approvalId, owner] of this.detailApprovals) if (owner === id) this.detailApprovals.delete(approvalId)
    member.unsubscribe?.()
    // The driver is already unrouted; a failed close must not leave the caller's change half-applied.
    try {
      await member.bridge.close()
    } catch (error) {
      this.log(`Harness ${id} 关闭失败：${message(error)}`)
    } finally {
      member.release?.()
      this.emit()
    }
  }

  has(id: string): boolean {
    return Boolean(this.entries.get(id)?.bridge)
  }

  sourceOf(harnessId: string): HarnessSource | undefined {
    return this.entries.get(harnessId)?.source
  }

  /** Unknown harnesses count as L3, the level that allows the least. */
  levelOf(harnessId: string): 'L1' | 'L3' {
    const source = this.sourceOf(harnessId)
    return source ? levelFor(source) : 'L3'
  }

  /** True while any L3 session is running or waiting for approval; local confirmation stays blocked meanwhile. */
  async hasUnsandboxedActivity(): Promise<boolean> {
    for (const [member, tasks] of await this.discover()) {
      if (levelFor(member.source) === 'L3' && tasks.some(task => ACTIVE.has(task.status))) return true
    }
    return false
  }

  /** Drivers without a classifier have no permission-mode options; their changes are neutral. */
  async classifyConfigChange(sessionId: string, configId: string, value: string): Promise<ConfigChangeClass> {
    const member = await this.route(sessionId)
    return member.bridge.classifyConfigChange ? member.bridge.classifyConfigChange(sessionId, configId, value) : 'neutral'
  }

  /** What a new L3 session would launch; undefined for drivers that cannot describe it (third-party plugins). */
  /** The project's folders reach only a driver that declares `projectFolders: 'all'`, as in `createTask`. */
  async launchPreviewOf(
    harnessId: string,
    cwd: string,
    project?: { workspaceId: string; folders: ReadonlyArray<ProjectFolder> },
  ): Promise<LaunchPreview | undefined> {
    const member = this.member(harnessId)
    if (!member) throw new AppError(409, 'harness-unavailable', `Harness ${harnessId} 当前不可用`)
    if (!member.bridge.launchPreview) return undefined
    return member.bridge.launchPreview(
      member.driver.projectFolders === 'all' && project ? { cwd, workspaceId: project.workspaceId, folders: project.folders } : { cwd },
    )
  }

  info(id: string): HarnessInfo | undefined {
    const entry = this.entries.get(id)
    return entry && this.describe(entry)
  }

  /** Mounted drivers and drivers that failed to start, in mount order. */
  drivers(): HarnessInfo[] {
    return [...this.entries.values()].map(entry => this.describe(entry))
  }

  /** The harness that owns a session. */
  async harnessOf(sessionId: string): Promise<string> {
    return (await this.route(sessionId)).driver.id
  }

  async start(): Promise<void> {
    if (this.closing) throw new AppError(503, 'host-closing', '运行节点正在关闭')
  }

  close(): Promise<void> {
    return (this.closing ??= (async () => {
      const failures: unknown[] = []
      for (const entry of [...this.entries.values()].reverse()) {
        if (!entry.bridge) continue
        entry.unsubscribe?.()
        try {
          await entry.bridge.close()
        } catch (error) {
          failures.push(error)
        } finally {
          entry.release?.()
        }
      }
      this.entries.clear()
      this.routes.clear()
      this.listeners.clear()
      try {
        await this.meta.flush()
      } catch (error) {
        failures.push(error)
      }
      if (failures.length) throw new AggregateError(failures, 'Harness hub cleanup failed')
    })())
  }

  async listTasks(): Promise<TaskSummary[]> {
    const merged: TaskSummary[] = []
    for (const [member, tasks] of await this.discover()) {
      for (const task of tasks) if (this.routes.get(task.id) === member.driver.id) merged.push(this.present(member.driver.id, task))
    }
    return merged.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async detail(sessionId: string): Promise<TaskDetail> {
    const member = await this.route(sessionId)
    const detail = await member.bridge.detail(sessionId)
    for (const approval of detail.approvals) this.rememberApproval(approval.id, member.driver.id)
    return { ...detail, summary: this.present(member.driver.id, detail.summary), permission: this.permission(member, detail.permission) }
  }

  async createTask(input: HubCreateInput): Promise<{ sessionId: string }> {
    const { harnessId, workspaceId, folders, sessionFolder, ...rest } = input
    const id = harnessId ?? this.options.defaultId()
    const entry = this.entries.get(id)
    if (!entry?.bridge) throw new AppError(409, 'harness-unavailable', `Harness ${id} 当前不可用`)
    const task: CreateTaskInput =
      entry.driver.projectFolders === 'all' && workspaceId !== undefined && folders !== undefined ? { ...rest, workspaceId, folders } : rest
    const result = await this.accept(entry as Member, bridge => bridge.createTask(task))
    if (!this.claim(id, result.sessionId)) {
      throw new AppError(502, 'session-id-collision', `Harness ${id} 返回的会话标识已属于另一个 Harness`)
    }
    // Without it the session is grouped and matched by its directory, as sessions from before projects had several folders.
    if (workspaceId)
      await this.meta
        .update(result.sessionId, current => ({ ...current, workspaceId, ...(sessionFolder ? { sessionFolder } : {}) }))
        .catch(error => this.log(`会话 ${result.sessionId} 的项目记录写入失败：${message(error)}`))
    return result
  }

  /** The names of the folders the Host made for sessions, from the session metadata. */
  sessionFolders(): string[] {
    return this.meta.sessionFolders()
  }

  /** Preserve a legacy session's uniquely identified project before its primary folder changes. */
  async recordWorkspace(sessionId: string, workspaceId: string): Promise<void> {
    await this.route(sessionId)
    await this.meta.update(sessionId, current => (current.workspaceId === undefined ? { ...current, workspaceId } : current))
  }

  async prompt(sessionId: string, prompt: string, requestId: string, options?: PromptOptions): Promise<void> {
    await this.accept(await this.route(sessionId), bridge =>
      options ? bridge.prompt(sessionId, prompt, requestId, options) : bridge.prompt(sessionId, prompt, requestId),
    )
  }

  async cancel(sessionId: string): Promise<void> {
    await (await this.route(sessionId)).bridge.cancel(sessionId)
  }

  approvals(): Approval[] {
    const all: Approval[] = []
    for (const [member, approvals] of this.listApprovals()) {
      for (const approval of approvals) if (this.claim(member.driver.id, approval.sessionId)) all.push(approval)
    }
    return all
  }

  /** A pending approval by ID, including one a driver reports only in its session detail. */
  async findApproval(approvalId: string): Promise<{ approval: Approval; harnessId: string } | undefined> {
    for (const [member, approvals] of this.listApprovals()) {
      const found = approvals.find(approval => approval.id === approvalId)
      if (found && this.claim(member.driver.id, found.sessionId)) return { approval: found, harnessId: member.driver.id }
    }
    const owner = this.detailApprovals.get(approvalId)
    const member = owner ? this.member(owner) : undefined
    if (!member) return undefined
    for (const task of await member.bridge.listTasks()) {
      if (task.status !== 'waiting-approval' || this.routes.get(task.id) !== member.driver.id) continue
      const found = (await member.bridge.detail(task.id)).approvals.find(approval => approval.id === approvalId)
      if (found) return { approval: found, harnessId: member.driver.id }
    }
    return undefined
  }

  async decide(approvalId: string, decision: 'allow' | 'reject', options?: DecideOptions): Promise<boolean> {
    const owners = this.listApprovals()
      .filter(([, approvals]) => approvals.some(approval => approval.id === approvalId))
      .map(([member]) => member)
    if (owners.length > 1) {
      // Refusing an ambiguous decision is the only choice that cannot approve the wrong operation.
      this.log(`审批标识 ${approvalId} 同时属于 ${owners.map(owner => owner.driver.id).join('、')}，已拒绝路由`)
      return false
    }
    const fallback = this.detailApprovals.get(approvalId)
    const member = owners[0] ?? (fallback ? this.member(fallback) : undefined)
    if (!member) return false
    const accepted = await (options ? member.bridge.decide(approvalId, decision, options) : member.bridge.decide(approvalId, decision))
    if (accepted) this.detailApprovals.delete(approvalId)
    return accepted
  }

  subscribe(listener: (sessionId?: string) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async remove(sessionId: string): Promise<void> {
    const member = await this.route(sessionId)
    if (!member.bridge.remove) throw new AppError(409, 'delete-unsupported', `${member.driver.name} 不支持删除会话`)
    await member.bridge.remove(sessionId)
    this.routes.delete(sessionId)
    // The session is already gone; a stale overlay entry is harmless, a reported failure would mislead.
    if (this.meta.get(sessionId))
      await this.meta.update(sessionId, () => undefined).catch(error => this.log(`会话设置清理失败：${message(error)}`))
  }

  async setConfig(sessionId: string, configId: string, value: string, options?: SetConfigOptions): Promise<void> {
    const member = await this.route(sessionId)
    await this.accept(member, bridge => {
      if (!bridge.setConfig) throw new AppError(501, 'not-supported', `${member.driver.name} 不支持修改会话选项`)
      return options ? bridge.setConfig(sessionId, configId, value, options) : bridge.setConfig(sessionId, configId, value)
    })
  }

  /** Applies a Host-level title, pin or archive change and returns the updated summary. */
  async updateMeta(sessionId: string, patch: SessionMetaPatch): Promise<TaskSummary> {
    const member = await this.route(sessionId)
    await this.meta.update(sessionId, current => {
      const next = { ...current }
      if (patch.title === null) delete next.title
      else if (patch.title !== undefined) next.title = patch.title
      if (patch.pinned !== undefined) {
        if (patch.pinned) next.pinned = true
        else delete next.pinned
      }
      if (patch.archived !== undefined) {
        if (patch.archived) next.archived = true
        else delete next.archived
      }
      return next
    })
    this.emit(sessionId)
    return this.present(member.driver.id, (await member.bridge.detail(sessionId)).summary)
  }

  private member(id: string): Member | undefined {
    const entry = this.entries.get(id)
    return entry?.bridge ? (entry as Member) : undefined
  }

  private members(): Member[] {
    return [...this.entries.values()].filter((entry): entry is Member => Boolean(entry.bridge))
  }

  /** Lists every driver; one failing driver is logged and skipped instead of failing the whole listing. */
  private async discover(): Promise<Array<[Member, TaskSummary[]]>> {
    const members = this.members()
    const settled = await Promise.allSettled(members.map(member => member.bridge.listTasks()))
    const listed: Array<[Member, TaskSummary[]]> = []
    settled.forEach((result, index) => {
      const member = members[index]!
      if (result.status === 'rejected') {
        this.log(`Harness ${member.driver.id} 无法列出会话：${message(result.reason)}`)
        return
      }
      for (const task of result.value) this.claim(member.driver.id, task.id)
      listed.push([member, result.value])
    })
    return listed
  }

  private listApprovals(): Array<[Member, Approval[]]> {
    const listed: Array<[Member, Approval[]]> = []
    for (const member of this.members()) {
      try {
        listed.push([member, member.bridge.approvals()])
      } catch (error) {
        this.log(`Harness ${member.driver.id} 无法列出审批：${message(error)}`)
      }
    }
    return listed
  }

  /** Routes a session, re-listing once for IDs not seen yet (e.g. after a restart). */
  private async route(sessionId: string): Promise<Member> {
    let member = this.owner(sessionId)
    if (!member) {
      await this.discover()
      member = this.owner(sessionId)
    }
    if (!member) throw new AppError(404, 'task-not-found', '找不到该任务')
    return member
  }

  /**
   * Runs a call that starts new work. The mount check and the count happen in one synchronous step,
   * so `detach` either sees the call or the call sees the detach.
   */
  private async accept<T>(member: Member, call: (bridge: Bridge) => Promise<T>): Promise<T> {
    if (member.detaching || this.entries.get(member.driver.id) !== member)
      throw new AppError(409, 'harness-unavailable', `${member.driver.name} 正在停用`)
    member.accepting++
    try {
      return await call(member.bridge)
    } finally {
      member.accepting--
    }
  }

  private owner(sessionId: string): Member | undefined {
    const id = this.routes.get(sessionId)
    return id ? this.member(id) : undefined
  }

  /** First claim wins; a later driver reporting the same ID is hidden and logged once. */
  private claim(harnessId: string, sessionId: string): boolean {
    const owner = this.routes.get(sessionId)
    if (owner === harnessId) return true
    if (owner && this.member(owner)) {
      if (!this.collisions.has(sessionId)) {
        this.collisions.add(sessionId)
        this.log(`会话标识 ${sessionId} 同时出现在 ${owner} 与 ${harnessId}，保留 ${owner}`)
      }
      return false
    }
    this.routes.set(sessionId, harnessId)
    return true
  }

  private rememberApproval(approvalId: string, harnessId: string): void {
    this.detailApprovals.delete(approvalId)
    this.detailApprovals.set(approvalId, harnessId)
    if (this.detailApprovals.size > MAX_DETAIL_APPROVALS) this.detailApprovals.delete(this.detailApprovals.keys().next().value!)
  }

  /** Builtin: Latch enforces. ACP: what the bridge verified, but never more than L3. Plugin harness: nothing verified. */
  private permission(member: Member, reported: SessionPermission | undefined): SessionPermission {
    if (member.source === 'builtin') return { level: 'L1', enforcer: 'LATCH', notes: [] }
    if (member.source === 'acp') return { ...reported, notes: [...(reported?.notes ?? [])], level: 'L3', enforcer: 'NONE' }
    return { level: 'L3', enforcer: 'NONE', notes: [PLUGIN_NOTE] }
  }

  private present(harnessId: string, summary: TaskSummary): TaskSummary {
    // Only the Host makes a session's own folder: a driver's claim is dropped.
    const { pinned: _pinned, archived: _archived, level: _level, sessionFolder: _sessionFolder, ...rest } = summary
    const meta = this.meta.get(summary.id)
    return {
      ...rest,
      harnessId,
      level: this.levelOf(harnessId),
      ...(this.entries.get(harnessId)?.driver.projectFolders !== 'all' ? { folderAccess: 'primary' as const } : {}),
      ...(meta?.title ? { title: meta.title } : {}),
      ...(meta?.pinned ? { pinned: true } : {}),
      ...(meta?.archived ? { archived: true } : {}),
      ...(meta?.workspaceId ? { workspaceId: meta.workspaceId } : {}),
      ...(meta?.sessionFolder ? { sessionFolder: true as const } : {}),
    }
  }

  private describe(entry: Entry): HarnessInfo {
    const { driver } = entry
    const capabilities = entry.capabilities ?? driver.capabilities ?? DEFAULT_CAPABILITIES
    let status: HarnessInfo['status'] = 'ready'
    let statusMessage: string | undefined
    if (entry.failure) {
      status = 'unavailable'
      statusMessage = entry.failure
    } else if (entry.starting) {
      status = 'unavailable'
      statusMessage = '正在启动'
    } else {
      try {
        const reported = driver.status?.()
        if (reported) {
          status = reported.status
          statusMessage = reported.statusMessage
        }
      } catch (error) {
        status = 'unavailable'
        statusMessage = message(error)
      }
    }
    return {
      id: driver.id,
      name: driver.name,
      ...(driver.description ? { description: driver.description } : {}),
      source: entry.source,
      status,
      ...(statusMessage ? { statusMessage } : {}),
      modes: [...capabilities.modes],
      models: capabilities.models,
      level: levelFor(entry.source),
      ...folderInfo(driver),
    }
  }

  private emit(sessionId?: string): void {
    for (const listener of this.listeners) {
      try {
        listener(sessionId)
      } catch {
        /* One subscriber cannot block the others. */
      }
    }
  }
}
