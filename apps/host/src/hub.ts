import { setTimeout as delay } from 'node:timers/promises'
import type {
  Approval,
  HarnessInfo,
  HarnessSource,
  KeepWaitingResult,
  RunEnd,
  SessionPermission,
  TaskDetail,
  TaskSummary,
} from '@latch/protocol'
import {
  AppError,
  type HarnessDriver,
  type Bridge,
  type CancelOptions,
  type ConfigChangeClass,
  type CreateTaskInput,
  type DecideOptions,
  type LaunchPreview,
  type ProjectFolder,
  type PromptOptions,
  type SetConfigOptions,
} from '@latch/sdk'
import { RUN_ID, SessionMetaStore, type SessionReceipts } from './session-meta.ts'
import { BranchReader } from './branch-reader.ts'
import { projectIdOf, type LifecycleEvent, type SessionLifecycle } from './session-lifecycle.ts'
import { RunSilence, SILENCE_THRESHOLDS, type LiveRun } from './run-silence.ts'

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
  forkOf?: TaskSummary['forkOf']
  initialTitle?: string
  /** The automation this session is a run of. */
  automationId?: string
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
  capabilities?: Pick<HarnessInfo, 'modes' | 'models' | 'attachments'>
  /** A required driver that fails to start fails `attach`; others are listed as unavailable. */
  required?: boolean
}

export interface HubOptions {
  /** Directory for `sessions-meta.json`. */
  dataDir: string
  /** Harness for `createTask` without `harnessId`. */
  defaultId: () => string
  log?: (message: string) => void
  /** Clock for receipt expiry. */
  now?: () => number
  /** Told when an announced run settles and when a session is archived or deleted. */
  lifecycle?: SessionLifecycle
  /** Silence thresholds other than the defaults, for tests. */
  silenceThresholds?: typeof SILENCE_THRESHOLDS
}

interface Entry {
  driver: HarnessDriver
  source: HarnessSource
  capabilities?: Pick<HarnessInfo, 'modes' | 'models' | 'attachments'>
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

const DEFAULT_CAPABILITIES: Pick<HarnessInfo, 'modes' | 'models' | 'attachments'> = { modes: ['chat', 'agent'], models: 'agent' }
const ACTIVE = new Set<TaskSummary['status']>(['running', 'waiting-approval'])
const MAX_DETAIL_APPROVALS = 1024
/** As often as the Host's event stream reads a changed session. */
const RUN_READ_MS = 40
/** A longer prompt leaves no room for a note below the drivers' 1 MB limit; the note waits for the next message. */
const PROMPT_NOTE_ROOM = 999_000
const SLASH_COMMAND = /^\/\S/u

/** As long as a run's first prompt waits for its snapshot: past this the message goes out and the note waits for the next one. */
const PROMPT_NOTE_MS = 15_000
/** The messages that went out without their note, so that a retry carries the same words. */
const NOTELESS_PROMPTS = 256

/**
 * What a message must carry to the engine; a retry with the same request ID gets the same words. `signal` aborts when
 * the message stops waiting, and from then on the read must leave the note due.
 */
export type PromptNote = (sessionId: string, requestId: string, signal: AbortSignal) => Promise<string | undefined>
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

/**
 * How a run ended, for what can be read without opening a session's content: the list and a cancel receipt. What was
 * running is a command's text, and it stays in the session's detail.
 */
export function runEndOutline({ reason, at, unknownResults, unknownResultsTruncated }: RunEnd): RunEnd {
  return {
    reason,
    at,
    ...(unknownResults?.length ? { unknownResultCount: unknownResults.length } : {}),
    ...(unknownResultsTruncated ? { unknownResultsTruncated } : {}),
  }
}

/** A list entry: the list can be read without opening a session's content, so what a run is running stays in its detail. */
function listed(task: TaskSummary): TaskSummary {
  const entry = task.runEnd ? { ...task, runEnd: runEndOutline(task.runEnd) } : task
  if (!entry.live) return entry
  const { commandName: _commandName, unrecognized, ...live } = entry.live
  return {
    ...entry,
    live: { ...live, ...(unrecognized ? { unrecognized: { count: unrecognized.count, at: unrecognized.at } } : {}) },
  }
}

/**
 * What makes other devices read the list again. Every word of a stream moves `lastEventAt`, and a list read per word
 * would cost far more than it tells: a row needs to know when the activity or the silence changes, and when an engine
 * goes on from a request Latch did not recognise.
 */
export function listSignature({ live, ...summary }: TaskSummary): unknown {
  if (!live) return summary
  const { activity, runId, silenceThresholdMs, silent, unrecognized, lastEventAt } = live
  return {
    ...summary,
    live: {
      activity,
      runId,
      silenceThresholdMs,
      silent,
      unrecognized: unrecognized?.count,
      wentOn: unrecognized && Date.parse(lastEventAt) > Date.parse(unrecognized.at),
    },
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
/**
 * One Bridge over every mounted HarnessDriver. Session and approval IDs pass through verbatim; the
 * routes are derived from createTask results, notifications and listings, never persisted, so they
 * rebuild after a restart and cannot drift from the drivers' own state.
 */
export class HarnessHub implements Bridge {
  private readonly entries = new Map<string, Entry>()
  private readonly routes = new Map<string, string>()
  private readonly personalOwners = new Map<string, NonNullable<TaskSummary['personal']>>()
  private readonly agentOwners = new Map<string, NonNullable<TaskSummary['agent']>>()
  private readonly briefSessions = new Set<string>()
  /** Approvals seen only through `detail()`, for drivers that do not list them in `approvals()`. */
  private readonly detailApprovals = new Map<string, string>()
  private readonly listeners = new Set<(sessionId?: string) => void>()
  private readonly collisions = new Set<string>()
  /** Sessions with a coalesced read of their announced run under way; `again`: another change arrived since it began. */
  private readonly runReads = new Map<string, { again: boolean }>()
  private promptNote: PromptNote | undefined
  private promptNoteMs = PROMPT_NOTE_MS
  private readonly notelessPrompts = new Set<string>()
  private readonly log: (message: string) => void
  private readonly branches: BranchReader
  private readonly silence: RunSilence
  private closing?: Promise<void>

  private constructor(
    private readonly options: HubOptions,
    private readonly meta: SessionMetaStore,
  ) {
    this.log = options.log ?? (text => console.error(`[Latch] ${text}`))
    this.branches = new BranchReader({
      now: options.now,
      changed: () => {
        if (!this.closing) this.emit()
      },
    })
    this.silence = new RunSilence({
      now: options.now ?? Date.now,
      ...(options.silenceThresholds ? { thresholds: options.silenceThresholds } : {}),
      runs: () => this.members().flatMap(member => this.liveOf(member)),
      reportsRuns: sessionId => {
        const owner = this.routes.get(sessionId)
        const bridge = owner ? this.member(owner)?.bridge : undefined
        return !bridge || bridge.liveRuns !== undefined
      },
      changed: sessionId => this.emit(sessionId),
    })
  }

  static async open(options: HubOptions): Promise<HarnessHub> {
    const log = options.log ?? (text => console.error(`[Latch] ${text}`))
    return new HarnessHub(options, await SessionMetaStore.open(options.dataDir, { log, ...(options.now ? { now: options.now } : {}) }))
  }

  /** Receipts of approval decisions and cancels, kept with each session in `sessions-meta.json`. */
  get receipts(): SessionReceipts {
    return this.meta
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
        if (sessionId && entry.bridge) this.readRun(entry.bridge, sessionId)
        if (sessionId) this.silence.check()
      })
      await bridge.start()
      // close() or detach() ran while this driver was starting; it was never visible, so retire it here.
      if (this.closing || this.entries.get(driver.id) !== entry)
        throw new AppError(503, 'harness-detached', `Harness ${driver.id} 已在启动期间停用`)
      if (driver.agentContext)
        for (const task of await bridge.listTasks()) {
          if (task.personal) await this.recordPersonal(task.id, task.personal)
          if (task.agent) await this.recordAgent(task.id, task.agent)
          if (task.agentPrivate) this.briefSessions.add(task.id)
        }
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

  /**
   * The L3 sessions running or waiting for approval, the ones waiting for an answer first, then the latest: while any
   * exists, the local confirmations that would outlive them are refused.
   */
  async unsandboxedTasks(): Promise<TaskSummary[]> {
    const found: TaskSummary[] = []
    for (const [member, tasks] of await this.discover()) {
      if (levelFor(member.source) !== 'L3') continue
      for (const task of tasks) if (ACTIVE.has(task.status)) found.push(this.present(member.driver.id, task))
    }
    const waiting = (task: TaskSummary) => (task.status === 'waiting-approval' ? 0 : 1)
    return found.sort((a, b) => waiting(a) - waiting(b) || b.updatedAt.localeCompare(a.updatedAt))
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
      this.silence.close()
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
      await this.branches.close()
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
      for (const task of tasks) if (this.routes.get(task.id) === member.driver.id) merged.push(listed(this.present(member.driver.id, task)))
    }
    return merged.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** A session's summary as its own driver lists it: no other driver is waited for, and the session is routed from here on. */
  async runSummary(harnessId: string, sessionId: string): Promise<TaskSummary | undefined> {
    const found = (await this.member(harnessId)?.bridge.listTasks())?.find(task => task.id === sessionId)
    return found && this.claim(harnessId, sessionId) ? this.present(harnessId, found) : undefined
  }

  /** One session's summary, without reading its messages. */
  async summary(sessionId: string): Promise<TaskSummary> {
    const member = await this.route(sessionId)
    const found = (await member.bridge.listTasks()).find(task => task.id === sessionId)
    if (!found) throw new AppError(404, 'task-not-found', '找不到该任务')
    return this.present(member.driver.id, found)
  }

  async detail(sessionId: string): Promise<TaskDetail> {
    const member = await this.route(sessionId)
    const detail = await member.bridge.detail(sessionId)
    for (const approval of detail.approvals) this.rememberApproval(approval.id, member.driver.id)
    const fork = this.meta.get(sessionId)?.forkOf
    const firstUser = detail.messages.findIndex(message => message.role === 'user')
    const messages = fork
      ? detail.messages.map((message, index) => (index === firstUser ? { ...message, forkContext: fork } : message))
      : detail.messages
    return {
      ...detail,
      messages,
      summary: this.present(member.driver.id, detail.summary),
      permission: this.permission(member, detail.permission),
    }
  }

  async createTask(input: HubCreateInput): Promise<{ sessionId: string }> {
    const { harnessId, workspaceId, folders, sessionFolder, forkOf, initialTitle, automationId, ...rest } = input
    const id = harnessId ?? this.options.defaultId()
    const entry = this.entries.get(id)
    if (!entry?.bridge) throw new AppError(409, 'harness-unavailable', `Harness ${id} 当前不可用`)
    const task: CreateTaskInput =
      entry.driver.projectFolders === 'all' && workspaceId !== undefined && folders !== undefined ? { ...rest, workspaceId, folders } : rest
    const result = await this.accept(entry as Member, bridge => bridge.createTask(task))
    if (!this.claim(id, result.sessionId)) {
      throw new AppError(502, 'session-id-collision', `Harness ${id} 返回的会话标识已属于另一个 Harness`)
    }
    if (input.agentContext?.personal) await this.recordPersonal(result.sessionId, input.agentContext.personal)
    if (input.agentContext?.agent) await this.recordAgent(result.sessionId, input.agentContext.agent)
    if (input.agentContext && !input.agentContext.personal && !input.agentContext.agent)
      await this.recordPrivate(result.sessionId).catch(error => this.log(`会话 ${result.sessionId} 的私有标记写入失败：${message(error)}`))
    if (automationId)
      await this.meta
        .update(result.sessionId, current => ({ ...current, automationId, ...(initialTitle ? { title: initialTitle.slice(0, 120) } : {}) }))
        .catch(error => this.log(`会话 ${result.sessionId} 的自动化记录写入失败：${message(error)}`))
    // Without it the session is grouped and matched by its directory, as sessions from before projects had several folders.
    if (workspaceId)
      await this.meta
        .update(result.sessionId, current => ({ ...current, workspaceId, ...(sessionFolder ? { sessionFolder } : {}) }))
        .catch(error => this.log(`会话 ${result.sessionId} 的项目记录写入失败：${message(error)}`))
    if (forkOf)
      await this.meta.update(result.sessionId, current => {
        if (current.forkOf && (current.forkOf.taskId !== forkOf.taskId || current.forkOf.upToMessageId !== forkOf.upToMessageId))
          throw new AppError(409, 'request-conflict', '同一个请求标识不能分叉自不同位置')
        return current.forkOf ? current : { ...current, forkOf, ...(initialTitle ? { title: initialTitle.slice(0, 120) } : {}) }
      })
    return result
  }

  /** Host private-body classification remains available even when the driver cannot list its tasks. */
  personalOf(sessionId: string): TaskSummary['personal'] {
    return this.personalOwners.get(sessionId) ?? this.meta.get(sessionId)?.personal
  }

  private rememberPersonal(sessionId: string, owner: NonNullable<TaskSummary['personal']>): void {
    if (!/^asst_[a-f0-9-]{36}$/u.test(owner.assistantId) || (owner.groupId !== undefined && !/^grp_[a-f0-9-]{36}$/u.test(owner.groupId)))
      throw new AppError(502, 'personal-owner-invalid', '执行端返回了无效的个人助手归属。')
    const current = this.personalOf(sessionId)
    if (current && (current.assistantId !== owner.assistantId || current.groupId !== owner.groupId))
      throw new AppError(409, 'personal-owner-changed', '会话归属已改变。')
    this.personalOwners.set(sessionId, structuredClone(owner))
  }
  /** Mark private before awaiting storage; a failed write never reclassifies a real session as ordinary. */
  async recordPersonal(sessionId: string, owner: NonNullable<TaskSummary['personal']>): Promise<void> {
    this.rememberPersonal(sessionId, owner)
    const persisted = this.meta.get(sessionId)?.personal
    if (persisted && persisted.assistantId === owner.assistantId && persisted.groupId === owner.groupId) return
    await this.meta.update(sessionId, current => ({ ...current, personal: structuredClone(owner) }))
  }

  /** Whether reading the session takes the agent data scope, without asking the driver. */
  agentPrivate(sessionId: string): boolean {
    const meta = this.meta.get(sessionId)
    return this.briefSessions.has(sessionId) || !!meta?.agentPrivate || !!meta?.automationId || this.agentOf(sessionId) !== undefined
  }
  /** Mark private before awaiting storage; a failed write never reclassifies a real session as ordinary. */
  private async recordPrivate(sessionId: string): Promise<void> {
    this.briefSessions.add(sessionId)
    if (!this.meta.get(sessionId)?.agentPrivate) await this.meta.update(sessionId, current => ({ ...current, agentPrivate: true as const }))
  }
  /** The session's agent, which makes its contents private; available even when the driver cannot list its tasks. */
  agentOf(sessionId: string): TaskSummary['agent'] {
    return this.agentOwners.get(sessionId) ?? this.meta.get(sessionId)?.agent
  }
  private rememberAgent(sessionId: string, owner: NonNullable<TaskSummary['agent']>): void {
    if (!/^agt_[a-f0-9-]{36}$/u.test(owner.customAgentId)) throw new AppError(502, 'agent-owner-invalid', '执行端返回了无效的 Agent 归属。')
    const current = this.agentOf(sessionId)
    if (current && current.customAgentId !== owner.customAgentId) throw new AppError(409, 'agent-owner-changed', '会话的 Agent 已改变。')
    this.agentOwners.set(sessionId, structuredClone(owner))
  }
  /** Mark private before awaiting storage; a failed write never reclassifies a real session as ordinary. */
  async recordAgent(sessionId: string, owner: NonNullable<TaskSummary['agent']>): Promise<void> {
    this.rememberAgent(sessionId, owner)
    if (this.meta.get(sessionId)?.agent?.customAgentId === owner.customAgentId) return
    await this.meta.update(sessionId, current => ({ ...current, agent: structuredClone(owner) }))
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

  /** Registers what a message must carry to the engine, read just before each prompt is sent. */
  notePrompts(note: PromptNote, boundMs = PROMPT_NOTE_MS): void {
    this.promptNote = note
    this.promptNoteMs = boundMs
  }

  /** The note in the message's own text: a plugin's driver delivers it too, and the conversation shows what was sent. */
  private async withNote(read: PromptNote, sessionId: string, prompt: string, requestId: string): Promise<string> {
    // A command must stay the first thing in its message, and text ahead of it would turn it into a plain message.
    if (prompt.length > PROMPT_NOTE_ROOM || SLASH_COMMAND.test(prompt) || this.notelessPrompts.has(requestId)) return prompt
    const abandon = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const overdue = new Promise<undefined>(resolve => {
      timer = setTimeout(() => {
        abandon.abort()
        this.notelessPrompts.add(requestId)
        if (this.notelessPrompts.size > NOTELESS_PROMPTS) this.notelessPrompts.delete(this.notelessPrompts.values().next().value!)
        this.log(`会话 ${sessionId} 的撤销说明读取超时，留给下一条消息`)
        resolve(undefined)
      }, this.promptNoteMs)
    })
    const reading = read(sessionId, requestId, abandon.signal).catch((error: unknown) => {
      this.log(`会话 ${sessionId} 的撤销说明读取失败：${message(error)}`)
      return undefined
    })
    const note = await Promise.race([reading, overdue]).finally(() => clearTimeout(timer))
    return note ? `${note}\n\n${prompt}` : prompt
  }

  async prompt(sessionId: string, prompt: string, requestId: string, options?: PromptOptions): Promise<void> {
    const member = await this.route(sessionId)
    // Before the turn is accepted, so the session is never readable as ordinary while the context is on its way.
    if (options?.agentContext && !options.agentContext.personal && !options.agentContext.agent) await this.recordPrivate(sessionId)
    // Not a step of its own without a watched run: `accept` follows the route directly.
    if (this.options.lifecycle?.watchedRun(sessionId)) await this.readRunNow(member.bridge, sessionId)
    // As above: without a note to read, `accept` follows the route directly.
    const text = this.promptNote ? await this.withNote(this.promptNote, sessionId, prompt, requestId) : prompt
    await this.accept(member, bridge =>
      options ? bridge.prompt(sessionId, text, requestId, options) : bridge.prompt(sessionId, text, requestId),
    )
  }

  async cancel(sessionId: string, options?: CancelOptions): Promise<boolean | void> {
    const member = await this.route(sessionId)
    const cancelling = options ? member.bridge.cancel(sessionId, options) : member.bridge.cancel(sessionId)
    this.options.lifecycle?.cancelRequested(sessionId, options?.runId)
    const cancelled = await cancelling
    await this.readRunNow(member.bridge, sessionId)
    return cancelled
  }

  /** 「继续等」: asks later about this run's silence; nothing else about the run changes. */
  async keepWaiting(sessionId: string, input: { runId: string; thresholdMs: number }): Promise<KeepWaitingResult> {
    const member = await this.route(sessionId)
    const run = await this.liveRun(member, sessionId)
    const result = this.silence.keepWaiting(run, input.thresholdMs, input.runId)
    if (result.outcome === 'extended') this.emit(sessionId)
    return result
  }

  /** Asks a run's own driver to cancel it, without waiting for the run to settle. */
  cancelRun(harnessId: string, sessionId: string, runId: string): void {
    void this.member(harnessId)
      ?.bridge.cancel(sessionId, { runId })
      .catch(error => this.log(`会话 ${sessionId} 的运行未能取消：${message(error)}`))
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
    await this.readRunNow(member.bridge, sessionId)
    // Read before the driver and the metadata forget it.
    const projectId = await this.projectFor('sessionDeleted', member, sessionId)
    await member.bridge.remove(sessionId)
    this.routes.delete(sessionId)
    // The session is already gone; a stale overlay entry is harmless, a reported failure would mislead.
    if (this.meta.has(sessionId)) await this.meta.remove(sessionId).catch(error => this.log(`会话设置清理失败：${message(error)}`))
    this.options.lifecycle?.sessionDeleted(sessionId, projectId)
  }

  async setConfig(sessionId: string, configId: string, value: string, options?: SetConfigOptions): Promise<void> {
    const member = await this.route(sessionId)
    await this.accept(member, bridge => {
      options?.authorize?.()
      if (!bridge.setConfig) throw new AppError(501, 'not-supported', `${member.driver.name} 不支持修改会话选项`)
      return options ? bridge.setConfig(sessionId, configId, value, options) : bridge.setConfig(sessionId, configId, value)
    })
  }

  /** Applies a Host-level title, pin or archive change and returns the updated summary. */
  async updateMeta(sessionId: string, patch: SessionMetaPatch): Promise<TaskSummary> {
    const member = await this.route(sessionId)
    let archived = false
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
      // Updates run one at a time, so of two requests to archive the same session only one archives it.
      archived = next.archived === true && current.archived !== true
      return next
    })
    if (archived) this.options.lifecycle?.sessionArchived(sessionId, await this.projectFor('sessionArchived', member, sessionId))
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

  private liveOf(member: Member): LiveRun[] {
    try {
      return (member.bridge.liveRuns?.() ?? []).filter(run => this.routes.get(run.sessionId) === member.driver.id)
    } catch (error) {
      this.log(`Harness ${member.driver.id} 无法报告运行状态：${message(error)}`)
      return []
    }
  }

  /** `liveRuns` is optional, and a driver without it says the same in `TaskSummary.live`. */
  private async liveRun(member: Member, sessionId: string): Promise<LiveRun | undefined> {
    if (member.bridge.liveRuns) return this.liveOf(member).find(item => item.sessionId === sessionId)
    const live = (await member.bridge.listTasks()).find(task => task.id === sessionId)?.live
    return live && typeof live.lastEventAt === 'string' ? { sessionId, live } : undefined
  }

  private present(harnessId: string, summary: TaskSummary): TaskSummary {
    if (summary.personal) this.rememberPersonal(summary.id, summary.personal)
    if (summary.agent) this.rememberAgent(summary.id, summary.agent)
    if (summary.agentPrivate) this.briefSessions.add(summary.id)
    // Only the Host makes a session's own folder: a driver's claim is dropped.
    const {
      pinned: _pinned,
      archived: _archived,
      level: _level,
      sessionFolder: _sessionFolder,
      forkOf: _forkOf,
      automationId: _automationId,
      runId,
      live,
      ...rest
    } = summary
    const meta = this.meta.get(summary.id)
    const personal = this.personalOf(summary.id)
    const agent = this.agentOf(summary.id)
    return this.branches.decorate({
      ...rest,
      // A run ID a cancel could not carry is left out, so the page sends a plain stop rather than one the Host refuses.
      ...(typeof runId === 'string' && RUN_ID.test(runId) ? { runId } : {}),
      ...(live && typeof live.lastEventAt === 'string' ? { live: this.silence.evaluate(summary.id, live) } : {}),
      harnessId,
      level: this.levelOf(harnessId),
      ...(this.entries.get(harnessId)?.driver.projectFolders !== 'all' ? { folderAccess: 'primary' as const } : {}),
      ...(meta?.title ? { title: meta.title } : {}),
      ...(meta?.pinned ? { pinned: true } : {}),
      ...(meta?.archived ? { archived: true } : {}),
      ...(meta?.workspaceId ? { workspaceId: meta.workspaceId } : {}),
      ...(meta?.forkOf ? { forkOf: meta.forkOf } : {}),
      ...(personal ? { personal } : {}),
      ...(agent ? { agent } : {}),
      ...(this.agentPrivate(summary.id) && !agent ? { agentPrivate: true as const } : {}),
      ...(meta?.automationId ? { automationId: meta.automationId } : {}),
      ...(meta?.sessionFolder ? { sessionFolder: true as const } : {}),
    })
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
      ...(driver.agentContext ? { agentContext: driver.agentContext } : {}),
      ...(driver.skills ? { skills: driver.skills } : {}),
      ...(capabilities.attachments ? { attachments: structuredClone(capabilities.attachments) } : {}),
      level: levelFor(entry.source),
      ...folderInfo(driver),
    }
  }

  /** The session's project for an event's listeners; the driver is asked only when one listens and the metadata has none. */
  private async projectFor(event: LifecycleEvent, member: Member, sessionId: string): Promise<string> {
    const workspaceId = this.meta.get(sessionId)?.workspaceId
    if (workspaceId !== undefined || !this.options.lifecycle?.listens(event)) return projectIdOf({ workspaceId })
    const listed = await member.bridge.listTasks().catch(() => [])
    return projectIdOf({ workspaceId: listed.find(task => task.id === sessionId)?.workspaceId })
  }

  /**
   * After a change a driver reports for a session whose run someone is waiting on, reads its summary, at most once per
   * `RUN_READ_MS`: a listing clones every session, and drivers report each streamed chunk. A change during a read
   * causes one more. `prompt`, `cancel` and `remove` read at once, so a run's end is seen before the next run hides it.
   */
  private readRun(bridge: Bridge, sessionId: string): void {
    if (!this.options.lifecycle?.watchedRun(sessionId) || this.closing) return
    const pending = this.runReads.get(sessionId)
    if (pending) {
      pending.again = true
      return
    }
    const read = { again: true }
    this.runReads.set(sessionId, read)
    void (async () => {
      try {
        while (read.again && !this.closing) {
          read.again = false
          await delay(RUN_READ_MS, undefined, { ref: false })
          await this.readRunNow(bridge, sessionId)
        }
      } finally {
        this.runReads.delete(sessionId)
      }
    })()
  }

  private async readRunNow(bridge: Bridge, sessionId: string): Promise<void> {
    const lifecycle = this.options.lifecycle
    const runId = lifecycle?.watchedRun(sessionId)
    if (!lifecycle || runId === undefined) return
    try {
      const summary = (await bridge.listTasks()).find(task => task.id === sessionId)
      if (summary) lifecycle.observe(summary, runId)
    } catch (error) {
      this.log(`会话 ${sessionId} 的运行状态读取失败：${message(error)}`)
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
