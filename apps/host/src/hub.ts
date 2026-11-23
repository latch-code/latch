import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { withHarnessPromptSource } from '@latch/harness-acp'
import { pairRoute, PROVIDER_WIRES, readSessionSkills } from '@latch/protocol'
import { setTimeout as delay } from 'node:timers/promises'
import type {
  Approval,
  BoardPlace,
  BoardPriority,
  HarnessInfo,
  HarnessCapabilities,
  HarnessCommandCatalogue,
  KeepWaitingResult,
  ModelCapabilities,
  ProviderKind,
  RunEnd,
  SessionPermission,
  TaskDetail,
  DriverTaskSummary,
  GitPrBinding,
  RunLive,
  TaskSummary,
  TeamMembership,
} from '@latch/protocol'
import {
  AppError,
  type HarnessDriver,
  type Bridge,
  type CancelOptions,
  type ConfigChangeClass,
  type ConfigReading,
  type CreateTaskInput,
  type DecideOptions,
  type ExternalSessionAdopt,
  type LaunchPreview,
  type ModelRoute,
  type ProjectFolder,
  type PromptOptions,
  type ServiceDeclaration,
  type SetConfigOptions,
  type SteerOutcome,
} from '@latch/sdk'
import { notSentConfig } from './config-requests.ts'
import { harnessFacts, trustOf, type HarnessKind, type HarnessTrust } from './harness-trust.ts'
import { RUN_ID, SessionMetaStore, type ImportedMeta, type PageOrigin, type SessionReceipts } from './session-meta.ts'
import { SESSION_FOLDER_NAME } from './session-folders.ts'
import { BranchReader } from './branch-reader.ts'
import type { BoardAttended } from './board.ts'
import { projectIdOf, type LifecycleEvent, type SessionLifecycle } from './session-lifecycle.ts'
import { RunSilence, SILENCE_THRESHOLDS, type LiveRun } from './run-silence.ts'

/**
 * `harnessId` is Host-only. Only drivers declaring `projectFolders: 'all'` receive the folders. A command-cache reader
 * also receives the project ID, so suggestions from different projects never share a scope; its files remain `cwd` alone.
 */
export interface HubCreateInput extends CreateTaskInput {
  harnessId?: string
  /** The project the Host expanded `cwd` from; kept in the Host's session metadata. */
  workspaceId?: string
  /** The name of the folder the Host made for this session alone in its start directory (`cwd`); never sent to the driver. */
  sessionFolder?: string
  /** The worktree the Host made for this session (`cwd`), its branch and its unfiltered count; never sent to the driver. */
  worktree?: { path: string; branch: string; unfiltered?: number }
  /** Kept in the Host's session metadata; never sent to the driver. */
  firstStart?: true
  forkOf?: TaskSummary['forkOf']
  initialTitle?: string
  /** The automation this session is a run of. */
  automationId?: string
  /** A conversation with 通用 in 我的 Agent; kept in the Host's session metadata, never sent to the driver. */
  generalChat?: true
  /** Started from a 待办 whose 要求 came from outside content; kept in the Host's metadata, never sent to the driver. */
  outsideStart?: true
}

/** Host-level session metadata; it applies to every harness. `title: null` removes an override. */
export interface SessionMetaPatch {
  title?: string | null
  pinned?: boolean
  archived?: boolean
  /** Normalised tags (`normalizeBoardTags`); null or empty removes them. */
  tags?: string[] | null
  /** A checked card note (`checkedNote`); null removes it. */
  note?: string | null
  /** null is 中: the field goes. */
  priority?: BoardPriority | null
}

export interface HarnessMount {
  /** Creates the unstarted Bridge; the hub starts it. */
  create(): Bridge
  /** Returns the registry lease after the Bridge has closed. */
  release(): void
  /** From which plugin registered the driver, never from the driver. */
  kind: HarnessKind
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
  /** A saved model service as 设置 › 模型 has it, turned on or off; undefined once it is deleted. */
  service?: (providerId: string) => { name: string; enabled: boolean } | undefined
  /**
   * The saved services sessions may use now, as settings declare them: their protocol, models and declared capabilities,
   * never a key. Each Harness's options for a draft on one of their models follow from these.
   */
  services?: () => ReadonlyArray<{
    providerId: string
    kind: ProviderKind
    models: readonly string[]
    modelCapabilities?: Readonly<Record<string, ModelCapabilities>>
  }>
  /** What a model request of the session waits for: `service`, by name, for that service's place; neither for the Host's own limit. */
  queueOf?: (sessionId: string) => { service?: string } | undefined
  /**
   * The session's group on the board, from the finished summary and the Host's own records (`board.ts`). Called for
   * every summary that leaves the hub, so it reads only what is at hand and never waits.
   */
  board?: (summary: TaskSummary, record: { attended?: BoardAttended; pr: boolean }) => BoardPlace | undefined
  /** The 待办 a session belongs to, as `TaskSummary.itemId` shows it; read from memory, never waited on. */
  itemOf?: (sessionId: string) => string | undefined
  /** The team a session is a member of, as `TaskSummary.teamOf` shows it; read from memory, never waited on. */
  teamOf?: (sessionId: string) => TeamMembership | undefined
  /** Before a session is removed, with whether it is private now: what holds it may need to remember that. A throw keeps it. */
  beforeRemove?: (sessionId: string, isPrivate: boolean) => Promise<void>
}

interface Entry {
  generation: string
  driver: HarnessDriver
  trust: HarnessTrust
  capabilities: HarnessCapabilities
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
  const { activity, runId, silenceThresholdMs, silent, unrecognized, lastEventAt, queued, queuedFor } = live
  return {
    ...summary,
    live: {
      activity,
      queued,
      queuedFor,
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
  /**
   * The project of the session being created. A driver starts the first run before `createTask` returns and the session's
   * project is recorded, so that run's lookup would otherwise file its changes under the default project.
   */
  private readonly creatingTask = new AsyncLocalStorage<{
    workspaceId: string | undefined
    agentId: string | undefined
    automation: boolean
  }>()
  private readonly personalOwners = new Map<string, NonNullable<TaskSummary['personal']>>()
  private readonly agentOwners = new Map<string, NonNullable<TaskSummary['agent']>>()
  private readonly briefSessions = new Set<string>()
  /** Sessions started with `propose_memory`, in memory as soon as they start. */
  private readonly proposalSessions = new Set<string>()
  private readonly workProposalSessions = new Set<string>()
  private readonly outsideStarts = new Set<string>()
  /** Conversations with 通用, in memory as soon as they start, before their record is written. */
  private readonly generalChats = new Set<string>()
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
    const capabilities = harnessFacts(driver.capabilities, driver.name, mount.kind)
    const entry: Entry = {
      generation: randomUUID(),
      driver,
      trust: trustOf(mount.kind, capabilities),
      capabilities,
      starting: true,
      accepting: 0,
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
    let tasks: DriverTaskSummary[]
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

  /** Undefined for a harness that is not attached, which every check treats as vouching for nothing. */
  trustOf(harnessId: string): HarnessTrust | undefined {
    return this.entries.get(harnessId)?.trust
  }

  /** Unknown harnesses count as L3, the level that allows the least. */
  levelOf(harnessId: string): 'L1' | 'L3' {
    return this.trustOf(harnessId)?.level ?? 'L3'
  }

  /**
   * The L3 sessions running or waiting for approval, the ones waiting for an answer first, then the latest: while any
   * exists, the local confirmations that would outlive them are refused.
   */
  async unsandboxedTasks(): Promise<TaskSummary[]> {
    const found: TaskSummary[] = []
    for (const [member, tasks] of await this.discover()) {
      if (member.trust.level !== 'L3') continue
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
    modelRoute?: ModelRoute,
    config?: ReadonlyArray<{ configId: string; value: string }>,
  ): Promise<LaunchPreview | undefined> {
    const member = this.member(harnessId)
    if (!member) throw new AppError(409, 'harness-unavailable', `Harness ${harnessId} 当前不可用`)
    if (!member.bridge.launchPreview) {
      if (modelRoute)
        throw new AppError(400, 'model-route-unsupported', `${this.describe(member).capabilities.display.label} 不能经 Latch 使用模型服务`)
      return undefined
    }
    return member.bridge.launchPreview({
      ...(member.driver.projectFolders === 'all' && project
        ? { cwd, workspaceId: project.workspaceId, folders: project.folders }
        : { cwd }),
      ...(modelRoute ? { modelRoute } : {}),
      ...(config ? { config } : {}),
    })
  }

  /** A previous real session's suggestions. The final guard is Host-only and grants no access to their source. */
  async commandCatalogueOf(
    harnessId: string,
    input: Parameters<NonNullable<Bridge['commandCatalogue']>>[0],
  ): Promise<{ sourceSessionId: string; catalogue: HarnessCommandCatalogue; current(): boolean } | undefined> {
    const member = this.member(harnessId)
    if (!member?.bridge.commandCatalogue) return undefined
    const { folders, ...context } = input
    const result = await member.bridge.commandCatalogue({
      ...context,
      ...(member.driver.projectFolders === 'all' && folders ? { folders } : {}),
    })
    if (!result) return undefined
    const current = () =>
      !this.closing
      && this.member(harnessId) === member
      && this.ownerOf(result.sourceSessionId) === harnessId
      && this.meta.has(result.sourceSessionId)
    return current() ? { ...result, current } : undefined
  }

  /** 设置 › 扩展: the latest report from a registered ordinary session of this driver. */
  async latestCommandReportOf(
    harnessId: string,
    acceptsSource: (sessionId: string) => boolean,
    verifySource: (sessionId: string) => Promise<boolean>,
  ) {
    const member = this.member(harnessId)
    if (!member?.bridge.latestCommandReport) return undefined
    const accept = (sessionId: string) =>
      this.member(harnessId) === member && this.extensionReportProjectOf(harnessId, sessionId) !== undefined && acceptsSource(sessionId)
    const result = await member.bridge.latestCommandReport(accept, async sessionId => accept(sessionId) && (await verifySource(sessionId)))
    if (!result) return undefined
    const { sourceSessionId, workspaceId, current: guard } = result
    if (workspaceId === undefined || typeof guard !== 'function') return undefined
    const source = this.meta.get(sourceSessionId)
    if (!source || source.workspaceId !== workspaceId || !accept(sourceSessionId)) return undefined
    const current = () => {
      const meta = this.meta.get(sourceSessionId)
      if (
        !meta
        || meta.workspaceId !== workspaceId
        || meta.sessionFolder !== source.sessionFolder
        || meta.worktree !== source.worktree
        || !accept(sourceSessionId)
      )
        return false
      try {
        return guard.call(result) === true
      } catch {
        return false
      }
    }
    return { ...result, sourceSessionId, workspaceId, current }
  }

  /** A missing registration, including an early report for a session still being created, confers no source authority. */
  extensionReportProjectOf(harnessId: string, sessionId: string): string | undefined {
    const member = this.member(harnessId)
    const meta = this.meta.get(sessionId)
    if (
      this.closing
      || !member
      || member.detaching
      || this.ownerOf(sessionId) !== harnessId
      || !meta?.extensionReportSource
      || meta.worktree?.removed
    )
      return undefined
    return this.agentPrivate(sessionId) ? undefined : meta.workspaceId
  }

  info(id: string): HarnessInfo | undefined {
    const entry = this.entries.get(id)
    return entry && this.describe(entry)
  }

  /** Mounted drivers and drivers that failed to start, in mount order. */
  drivers(): HarnessInfo[] {
    return [...this.entries.values()].map(entry => this.describe(entry))
  }

  /** The Git branch a new session in `cwd` would start on, as last read. */
  branchOf(cwd: string): string | undefined {
    return this.branches.branchOf(cwd)
  }

  /** HEAD moved in these folders: the branch they show is read again at once. */
  branchMoved(folders: readonly string[]): void {
    this.branches.invalidate(folders)
  }

  /** The harness that owns a session, as far as the hub has seen it; no driver is asked. */
  ownerOf(sessionId: string): string | undefined {
    return this.routes.get(sessionId)
  }

  /**
   * The project a session belongs to, from the Host's records; no driver is asked. A first turn may run before its
   * start is recorded: the project being started then.
   */
  projectOf(sessionId: string): string | undefined {
    const workspaceId = this.meta.get(sessionId)?.workspaceId ?? this.creatingTask.getStore()?.workspaceId
    if (workspaceId !== undefined) return workspaceId
    return this.routes.has(sessionId) ? projectIdOf({}) : undefined
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

  /**
   * Every session, and whether the list is whole: every mounted harness listed, and none failed to mount or is still
   * starting. Only a whole list can prove that no session holds something.
   */
  async listTasksProven(): Promise<{ tasks: TaskSummary[]; complete: boolean; listed: ReadonlySet<string> }> {
    const members = this.members()
    const discovered = await this.discover()
    const tasks: TaskSummary[] = []
    for (const [member, list] of discovered)
      for (const task of list) if (this.routes.get(task.id) === member.driver.id) tasks.push(listed(this.present(member.driver.id, task)))
    const complete = discovered.length === members.length && [...this.entries.values()].every(entry => !entry.failure && !entry.starting)
    return { tasks, complete, listed: new Set(discovered.map(([member]) => member.driver.id)) }
  }

  /** A session's summary as its own driver lists it: no other driver is waited for, and the session is routed from here on. */
  async runSummary(harnessId: string, sessionId: string): Promise<TaskSummary | undefined> {
    const found = (await this.member(harnessId)?.bridge.listTasks())?.find(task => task.id === sessionId)
    if (!found || !this.claim(harnessId, sessionId)) return undefined
    const summary = this.present(harnessId, found)
    const creating = this.creatingTask.getStore()?.workspaceId
    return creating !== undefined && summary.workspaceId === undefined ? { ...summary, workspaceId: creating } : summary
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
    const meta = this.meta.get(sessionId)
    const fork = meta?.forkOf
    const firstUser = detail.messages.findIndex(message => message.role === 'user')
    // A text rebuild's first message carries the rebuilt conversation before the person's words, unless it began a new context.
    const rebuilt =
      !fork && meta?.imported?.mode === 'text' && meta.imported.prefixLength && !detail.messages[firstUser]?.freshContext
        ? {
            from: this.entries.get(meta.imported.from)?.capabilities.display.label ?? meta.imported.from,
            prefixLength: meta.imported.prefixLength,
            ...(meta.imported.truncated ? { truncated: true as const } : {}),
          }
        : undefined
    const messages =
      fork || rebuilt
        ? detail.messages.map((message, index) =>
            index === firstUser ? { ...message, ...(fork ? { forkContext: fork } : { importContext: rebuilt! }) } : message,
          )
        : detail.messages
    const { skills: reportedSkills, skillsTruncated, ...withoutSkills } = detail
    const skills = readSessionSkills(reportedSkills)
    return {
      ...withoutSkills,
      ...(skills ? { skills, ...(skillsTruncated === true ? { skillsTruncated: true as const } : {}) } : {}),
      messages,
      summary: this.present(member.driver.id, detail.summary),
      permission: this.permission(member, detail.permission),
    }
  }

  async createTask(input: HubCreateInput): Promise<{ sessionId: string }> {
    const {
      harnessId,
      workspaceId,
      folders,
      sessionFolder,
      worktree,
      firstStart,
      forkOf,
      initialTitle,
      automationId,
      generalChat,
      outsideStart,
      extensionReportReady: _extensionReportReady,
      ...rest
    } = input
    const id = harnessId ?? this.options.defaultId()
    const entry = this.entries.get(id)
    if (!entry?.bridge) throw new AppError(409, 'harness-unavailable', `Harness ${id} 当前不可用`)
    const allFolders = entry.driver.projectFolders === 'all'
    const ordinary = entry.bridge.latestCommandReport && workspaceId && !input.agentContext && !automationId && !generalChat && !input.seed
    let settleReportSource: (() => void) | undefined
    const extensionReportReady = ordinary
      ? new Promise<void>(resolve => {
          settleReportSource = resolve
        })
      : undefined
    const task: CreateTaskInput = {
      ...rest,
      // The driver reports the session before the Host's own record of it is written: it starts with this name, not
      // one from the prompt, which for a fork or a moved conversation begins with the Host's record of the source.
      ...(initialTitle ? { title: initialTitle.slice(0, 120) } : {}),
      ...(extensionReportReady ? { extensionReportReady } : {}),
      ...((allFolders ? folders !== undefined : entry.bridge.commandCatalogue) && workspaceId !== undefined ? { workspaceId } : {}),
      ...(allFolders && workspaceId !== undefined && folders !== undefined ? { folders } : {}),
    }
    const result = await this.accept(entry as Member, bridge =>
      withHarnessPromptSource({ method: 'create', requestId: input.requestId, text: input.prompt }, () =>
        this.creatingTask.run(
          { workspaceId, agentId: input.agentContext?.agent?.customAgentId, automation: automationId !== undefined },
          () => bridge.createTask(task),
        ),
      ),
    ).catch((error: unknown) => {
      settleReportSource?.()
      throw error
    })
    if (!this.claim(id, result.sessionId)) {
      settleReportSource?.()
      throw new AppError(502, 'session-id-collision', `Harness ${id} 返回的会话标识已属于另一个 Harness`)
    }
    if (input.agentContext?.agent) await this.recordAgent(result.sessionId, input.agentContext.agent)
    if (input.agentContext && !input.agentContext.agent)
      await this.recordPrivate(result.sessionId).catch(error => this.log(`会话 ${result.sessionId} 的私有标记写入失败：${message(error)}`))
    if (automationId)
      await this.meta
        .update(result.sessionId, current => ({ ...current, automationId, ...(initialTitle ? { title: initialTitle.slice(0, 120) } : {}) }))
        .catch(error => this.log(`会话 ${result.sessionId} 的定时任务记录写入失败：${message(error)}`))
    if (outsideStart) {
      // In memory before any write: its first turn may propose before the record is on disk.
      this.outsideStarts.add(result.sessionId)
      await this.meta
        .update(result.sessionId, current => ({ ...current, outsideStart: true as const }))
        .catch(error => this.log(`会话 ${result.sessionId} 的外部内容标记写入失败：${message(error)}`))
    }
    if (input.workProposals) {
      this.workProposalSessions.add(result.sessionId)
      await this.meta
        .update(result.sessionId, current => ({ ...current, workProposals: true as const }))
        .catch(error => this.log(`会话 ${result.sessionId} 的看板提议标记写入失败：${message(error)}`))
    }
    if (input.agentContext?.proposals) {
      // In memory before the write: its first turn may propose before the record is on disk.
      this.proposalSessions.add(result.sessionId)
      await this.meta
        .update(result.sessionId, current => ({ ...current, proposals: true as const }))
        .catch(error => this.log(`会话 ${result.sessionId} 的记忆提议标记写入失败：${message(error)}`))
    }
    if (generalChat) await this.recordGeneralChat(result.sessionId)
    if (initialTitle && !automationId && !forkOf)
      await this.meta
        .update(result.sessionId, current => ({ ...current, title: initialTitle.slice(0, 120) }))
        .catch(error => this.log(`会话 ${result.sessionId} 的标题写入失败：${message(error)}`))
    // Without it the session is grouped and matched by its directory, as sessions from before projects had several folders.
    if (workspaceId || worktree)
      await this.meta
        .update(result.sessionId, current => ({
          ...current,
          ...(workspaceId ? { workspaceId } : {}),
          ...(ordinary && this.member(id) === entry && !this.agentPrivate(result.sessionId)
            ? { extensionReportSource: true as const }
            : {}),
          ...(sessionFolder ? { sessionFolder } : {}),
          ...(worktree
            ? {
                worktree: {
                  path: worktree.path,
                  branch: worktree.branch,
                  ...(worktree.unfiltered ? { unfiltered: worktree.unfiltered } : {}),
                },
              }
            : {}),
          ...(firstStart ? { firstStart } : {}),
        }))
        .finally(settleReportSource)
        .catch(error => this.log(`会话 ${result.sessionId} 的项目记录写入失败：${message(error)}`))
    if (forkOf)
      await this.meta.update(result.sessionId, current => {
        if (current.forkOf && (current.forkOf.taskId !== forkOf.taskId || current.forkOf.upToMessageId !== forkOf.upToMessageId))
          throw new AppError(409, 'request-conflict', '同一个请求标识不能分叉自不同位置')
        return current.forkOf ? current : { ...current, forkOf, ...(initialTitle ? { title: initialTitle.slice(0, 120) } : {}) }
      })
    // What was written above (title, fork, project) changes the session as listed since the driver last reported it.
    this.emit(result.sessionId)
    return result
  }

  /** An assistant's or a group's session; available even when the driver cannot list its tasks. */
  personalOf(sessionId: string): TaskSummary['personal'] {
    return this.personalOwners.get(sessionId) ?? this.meta.get(sessionId)?.personal
  }

  private rememberPersonal(sessionId: string, owner: NonNullable<TaskSummary['personal']>): void {
    if (!/^asst_[a-f0-9-]{36}$/u.test(owner.assistantId) || (owner.groupId !== undefined && !/^grp_[a-f0-9-]{36}$/u.test(owner.groupId)))
      throw new AppError(502, 'personal-owner-invalid', '执行端返回了无效的会话归属。')
    const current = this.personalOf(sessionId)
    if (current && (current.assistantId !== owner.assistantId || current.groupId !== owner.groupId))
      throw new AppError(409, 'personal-owner-changed', '会话归属已改变。')
    this.personalOwners.set(sessionId, structuredClone(owner))
  }
  /** Mark private before awaiting storage; a failed write never reclassifies a real session as ordinary. */
  private async recordPersonal(sessionId: string, owner: NonNullable<TaskSummary['personal']>): Promise<void> {
    this.rememberPersonal(sessionId, owner)
    const persisted = this.meta.get(sessionId)?.personal
    if (persisted && persisted.assistantId === owner.assistantId && persisted.groupId === owner.groupId) return
    await this.meta.update(sessionId, current => ({ ...current, personal: structuredClone(owner) }))
  }

  /** Whether reading the session takes the agent data scope, without asking the driver. */
  agentPrivate(sessionId: string): boolean {
    const meta = this.meta.get(sessionId)
    return (
      this.briefSessions.has(sessionId)
      || !!meta?.agentPrivate
      // Brought in from outside Latch's authority: it may hold anything the person ever pasted there.
      || !!meta?.imported
      || !!meta?.automationId
      // A conversation with 通用 in 我的 Agent is private whatever 通用 held when it started.
      || !!meta?.generalChat
      || this.agentOf(sessionId) !== undefined
      || this.personalOf(sessionId) !== undefined
    )
  }
  /** Mark private before awaiting storage; a failed write never reclassifies a real session as ordinary. */
  private async recordPrivate(sessionId: string): Promise<void> {
    const withdrawReport = this.meta.get(sessionId)?.extensionReportSource && !this.agentPrivate(sessionId)
    this.briefSessions.add(sessionId)
    if (withdrawReport) this.emit(sessionId)
    if (!this.meta.get(sessionId)?.agentPrivate) await this.meta.update(sessionId, current => ({ ...current, agentPrivate: true as const }))
  }
  /** As recordPrivate: private in memory before the write, so a failed write never leaves it readable by a smaller scope. */
  private async recordGeneralChat(sessionId: string): Promise<void> {
    this.briefSessions.add(sessionId)
    this.generalChats.add(sessionId)
    if (!this.meta.get(sessionId)?.generalChat) await this.meta.update(sessionId, current => ({ ...current, generalChat: true as const }))
  }
  /** The schedule a session is a run of, once its record is written. */
  automationOf(sessionId: string): string | undefined {
    return this.meta.get(sessionId)?.automationId
  }
  /**
   * Whether the session runs with nobody watching: an automation's run (我的 Agent's schedules are automations), also
   * while it is still being created, before its record is written.
   */
  unattended(sessionId: string): boolean {
    return this.automationOf(sessionId) !== undefined || this.creatingTask.getStore()?.automation === true
  }
  /** Whether the session was started with `proposals` in its context. */
  proposalsOf(sessionId: string): boolean {
    return this.proposalSessions.has(sessionId) || this.meta.get(sessionId)?.proposals === true
  }
  /** Whether the session was started with the board's proposal tools (`CreateTaskInput.workProposals`). */
  workProposalsOf(sessionId: string): boolean {
    return this.workProposalSessions.has(sessionId) || this.meta.get(sessionId)?.workProposals === true
  }
  /** Started from a 待办 whose 要求 came from outside content: what its context proposes is external. */
  outsideStartOf(sessionId: string): boolean {
    const meta = this.meta.get(sessionId)
    // A session brought in from a CLI's own record holds whatever was ever in it.
    return this.outsideStarts.has(sessionId) || meta?.outsideStart === true || meta?.imported !== undefined
  }
  /** Started by a plugin page: it proposes nothing to the board. */
  pageOriginOf(sessionId: string): boolean {
    return this.meta.get(sessionId)?.origin !== undefined
  }
  /** A conversation with 通用 in 我的 Agent; known before its record is written. */
  generalChatOf(sessionId: string): boolean {
    return this.generalChats.has(sessionId) || this.meta.get(sessionId)?.generalChat === true
  }
  /** The session's agent, which makes its contents private; available even when the driver cannot list its tasks. */
  agentOf(sessionId: string): TaskSummary['agent'] {
    return this.agentOwners.get(sessionId) ?? this.meta.get(sessionId)?.agent
  }

  /** The Host's owner in an async task creation, even if its first model request runs before the driver returns the ID. */
  startingAgentId(): string | undefined {
    return this.creatingTask.getStore()?.agentId
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

  /** The record a harness's external session IDs belong to (`Bridge.historyStore`). */
  historyStoreOf(harnessId: string): string | undefined {
    try {
      return this.member(harnessId)?.bridge.historyStore?.()
    } catch {
      return undefined
    }
  }

  /** Whether a session of this harness can wait for its first message with a seed (`CreateTaskInput.seed`). */
  acceptsSeed(harnessId: string): boolean {
    return this.entries.get(harnessId)?.driver.seededStart === true
  }

  /** Sessions brought in from a harness's own record, from the session metadata. */
  importedSessions(): Array<{ sessionId: string; imported: ImportedMeta }> {
    return this.meta.imported()
  }

  /** Marks a session as brought in, which makes it private; written before the session exists when its ID is known. */
  async recordImported(sessionId: string, imported: ImportedMeta, workspaceId?: string): Promise<void> {
    await this.meta.update(sessionId, current => ({
      ...current,
      imported: structuredClone(imported),
      ...(workspaceId ? { workspaceId } : {}),
    }))
    this.emit(sessionId)
  }

  /** Undoes `recordImported` for a session that was not created after all. */
  async forgetImported(sessionId: string): Promise<void> {
    if (this.routes.has(sessionId)) return
    await this.meta.update(sessionId, () => undefined)
  }

  /** The drivers that may bring in their own earlier sessions, with their bridges when started. */
  historyDrivers(): Array<{ id: string; label: string; ready: boolean; bridge?: Bridge }> {
    return [...this.entries.values()]
      .filter(entry => entry.driver.historyImport === true && !entry.detaching)
      .map(entry => {
        const info = this.describe(entry)
        return {
          id: entry.driver.id,
          label: info.capabilities.display.label,
          ready: !!entry.bridge && !entry.starting && info.status === 'ready',
          ...(entry.bridge ? { bridge: entry.bridge } : {}),
        }
      })
  }

  /** Every harness session behind a Latch session of any driver, except those brought in: never offered for import. */
  agentSessionIds(): string[] {
    const ids = new Set<string>()
    for (const member of this.members()) {
      try {
        for (const id of member.bridge.agentSessionIds?.() ?? []) ids.add(id)
      } catch (error) {
        this.log(`Harness ${member.driver.id} 无法列出它的会话：${message(error)}`)
      }
    }
    return [...ids]
  }

  /** Records a session bound to an earlier session of the harness `harnessId`, under the ID the Host chose. */
  async adoptExternal(
    harnessId: string,
    input: ExternalSessionAdopt,
  ): Promise<{ sessionId: string; messageCount: number; droppedBefore: number; launchHash: string }> {
    const member = this.member(harnessId)
    if (!member) throw new AppError(409, 'harness-unavailable', `Harness ${harnessId} 当前不可用`)
    const result = await this.accept(member, bridge => {
      if (!bridge.adoptExternalSession) throw new AppError(409, 'history-not-supported', `${member.driver.name} 不能接入已有会话。`)
      return bridge.adoptExternalSession(input)
    })
    if (result.sessionId !== input.sessionId || !this.claim(harnessId, result.sessionId))
      throw new AppError(502, 'session-id-collision', `Harness ${harnessId} 返回的会话标识已属于另一个 Harness`)
    this.emit(result.sessionId)
    return result
  }

  /** The worktrees the Host made for sessions, from the session metadata. */
  worktrees(): Array<{ sessionId: string; path: string; workspaceId?: string; removed?: true }> {
    return this.meta.worktrees()
  }

  /** The worktree the Host made for this session, from its own records; never from the driver. */
  worktreeOf(sessionId: string): { path: string; branch: string; removed?: true } | undefined {
    const worktree = this.meta.get(sessionId)?.worktree
    return worktree && { path: worktree.path, branch: worktree.branch, ...(worktree.removed ? { removed: true as const } : {}) }
  }

  /**
   * What the Host's own records say about a session, whether or not its Harness lists it now: undefined once its
   * metadata is gone (the session was deleted). `private`: personal, of 我的 Agent, or with private context.
   */
  sessionRecord(sessionId: string): { archived: boolean; private: boolean } | undefined {
    const meta = this.meta.get(sessionId)
    if (!meta) return undefined
    return {
      archived: meta.archived === true,
      private: meta.personal !== undefined || meta.agent !== undefined || meta.agentPrivate === true || this.agentPrivate(sessionId),
    }
  }

  /** The session's worktree was removed: it stays, read-only for files, and says so. */
  async worktreeRemoved(sessionId: string): Promise<void> {
    await this.meta.update(sessionId, current =>
      current.worktree ? { ...current, worktree: { ...current.worktree, removed: true } } : current,
    )
    this.emit(sessionId)
  }

  /** The person's markers on the session's latest marked settlement (`attend`). */
  attendedOf(sessionId: string): BoardAttended | undefined {
    const attended = this.meta.get(sessionId)?.attended
    return attended && { ...attended }
  }

  /** The pull request 交付 bound to the session. */
  prOf(sessionId: string): GitPrBinding | undefined {
    const pr = this.meta.get(sessionId)?.pr
    return pr && { ...pr }
  }

  /** Settles when the session metadata holds it; only a session the Host knows. */
  async bindPr(sessionId: string, pr: GitPrBinding): Promise<void> {
    await this.route(sessionId)
    await this.meta.update(sessionId, current => ({ ...current, pr: { ...pr } }))
  }

  async unbindPr(sessionId: string): Promise<void> {
    await this.meta.update(sessionId, current => {
      const next = { ...current }
      delete next.pr
      return next
    })
  }

  /** The names of the folders the Host made for sessions, from the session metadata. */
  sessionFolders(): string[] {
    return this.meta.sessionFolders()
  }

  /** The Host-allocated relative folder name, never a path supplied by a driver. */
  sessionFolderOf(sessionId: string): string | undefined {
    return this.meta.get(sessionId)?.sessionFolder
  }

  /** The plugin page that started the session, from the Host's own records. */
  originOf(sessionId: string): PageOrigin | undefined {
    const origin = this.meta.get(sessionId)?.origin
    return origin && { ...origin }
  }
  findOrigin(app: string, requestId: string, install: string): string | undefined {
    return this.meta.findOrigin(app, requestId, install)
  }
  /** Sessions whose permissions a person changed in this run, for a page start recorded after the change. */
  private readonly touched = new Set<string>()
  /** A person is changing the permission mode of a page's session: the page may no longer drive it. */
  async markOriginChanged(sessionId: string): Promise<void> {
    // A session a page is still starting has no origin yet: the mark waits for `recordOrigin`.
    this.touched.delete(sessionId)
    this.touched.add(sessionId)
    for (const id of this.touched) {
      if (this.touched.size <= 10_000) break
      this.touched.delete(id)
    }
    if (!this.meta.get(sessionId)?.origin || this.meta.get(sessionId)?.origin?.changed) return
    await this.meta.update(sessionId, current => (current.origin ? { ...current, origin: { ...current.origin, changed: true } } : current))
  }
  /** Marks a session as a page's; a session already marked for another page or request is refused. */
  async recordOrigin(sessionId: string, origin: PageOrigin, title?: string): Promise<void> {
    await this.meta.update(sessionId, current => {
      if (
        current.origin
        && (current.origin.app !== origin.app || current.origin.requestId !== origin.requestId || current.origin.install !== origin.install)
      )
        throw new AppError(409, 'request-conflict', '这个会话已属于另一个请求。')
      const recorded = current.origin ?? { ...origin, ...(this.touched.has(sessionId) ? { changed: true as const } : {}) }
      return { ...current, origin: recorded, ...(title && !current.title ? { title: title.slice(0, 120) } : {}) }
    })
    this.emit(sessionId)
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
    // A driver that cannot record outside content would drop the mark: refused before anything is sent.
    if (options?.outsideContent && !member.bridge.markOutsideContent)
      throw new AppError(503, 'post-unmarked', '这个 Harness 不能把这次发送标为外部内容，没有发出。')
    // Before the turn is accepted, so the session is never readable as ordinary while the context is on its way.
    if (options?.agentContext && !options.agentContext.agent) await this.recordPrivate(sessionId)
    // Not a step of its own without a watched run: `accept` follows the route directly.
    if (this.options.lifecycle?.watchedRun(sessionId)) await this.readRunNow(member.bridge, sessionId)
    // As above: without a note to read, `accept` follows the route directly.
    const text = this.promptNote ? await this.withNote(this.promptNote, sessionId, prompt, requestId) : prompt
    try {
      await this.accept(member, bridge =>
        withHarnessPromptSource({ method: 'prompt', sessionId, requestId, text: prompt }, () =>
          options ? bridge.prompt(sessionId, text, requestId, options) : bridge.prompt(sessionId, text, requestId),
        ),
      )
    } finally {
      if (options?.freshContext) await this.dropSeedPrefix(member, sessionId)
    }
  }

  /**
   * A text rebuild whose first message started a new context sent no seed: its first message has no prefix to fold. Kept
   * while a user message before the new context carries it.
   */
  private async dropSeedPrefix(member: Member, sessionId: string): Promise<void> {
    if (!this.meta.get(sessionId)?.imported?.prefixLength) return
    try {
      const detail = await member.bridge.detail(sessionId)
      const first = detail.messages.find(message => message.role === 'user')
      // Cleared without a message yet (the turn was refused after the clear): the seed is gone all the same.
      if (first ? !first.freshContext : !detail.contextCleared) return
      await this.meta.update(sessionId, current => {
        if (!current.imported) return current
        const { prefixLength: _prefix, truncated: _truncated, ...imported } = current.imported
        return { ...current, imported }
      })
      this.emit(sessionId)
    } catch (error) {
      this.log(`会话 ${sessionId} 的接入记录未能更新：${message(error)}`)
    }
  }

  /** Adds text to the session's running turn; `prompt-required` from a driver that cannot. */
  async steer(
    sessionId: string,
    prompt: string,
    requestId: string,
    beforeSteer?: (runId: string) => ((couldBeInjected: boolean) => void) | undefined,
  ): Promise<SteerOutcome> {
    const member = await this.route(sessionId)
    const bridge = member.bridge
    if (!bridge.steer) return 'prompt-required'
    return await this.accept(member, () =>
      withHarnessPromptSource({ method: 'steer', sessionId, requestId, text: prompt, ...(beforeSteer ? { beforeSteer } : {}) }, () =>
        bridge.steer!(sessionId, prompt, requestId),
      ),
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

  /** Stops one subagent of the session's turn; see `Bridge.cancelSubagent`. */
  async cancelSubagent(sessionId: string, subagentId: string): Promise<boolean> {
    const member = await this.route(sessionId)
    if (!member.bridge.cancelSubagent) return false
    return member.bridge.cancelSubagent(sessionId, subagentId)
  }

  async markOutsideContent(sessionId: string): Promise<void> {
    const { bridge } = await this.route(sessionId)
    if (!bridge.markOutsideContent) throw new AppError(503, 'mcp-prompt-unmarked', '该 Harness 无法保存 MCP 提示的来源')
    await bridge.markOutsideContent(sessionId)
  }

  /**
   * Whether the session's agent can be given the team tools: started with the board's channel, by a driver that reads
   * a team's roster again when told (`Bridge.teamChanged`).
   */
  teamChannel(sessionId: string): boolean {
    return this.workProposalsOf(sessionId) && typeof this.owner(sessionId)?.bridge?.teamChanged === 'function'
  }

  /** The team the session leads changed: its driver reads the roster again. Never fails the caller. */
  async teamChanged(sessionId: string): Promise<void> {
    const bridge = this.owner(sessionId)?.bridge
    if (!bridge?.teamChanged || !this.workProposalsOf(sessionId)) return
    await bridge
      .teamChanged(sessionId)
      .catch(error => this.log(`团队名单没有交给会话 ${sessionId}：${error instanceof Error ? error.message : String(error)}`))
  }

  /** Starts a settled session's process ahead of its next turn (`Bridge.warm`); false when its driver has none or declined. */
  async warm(sessionId: string): Promise<boolean> {
    const { bridge } = await this.route(sessionId)
    if (!bridge.warm) return false
    return bridge.warm(sessionId).catch(() => false)
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

  /** Something outside a session changed what the catalog says, such as a harness found too old: clients read it again. */
  changed(): void {
    if (!this.closing) this.emit()
  }

  subscribe(listener: (sessionId?: string) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Whether deleting this session can delete its original in its harness's own record too (`historyDelete`). */
  async deletesOriginal(sessionId: string): Promise<boolean> {
    const member = await this.route(sessionId)
    return member.driver.historyImport === true && member.driver.historyDelete === true
  }

  async remove(sessionId: string, options: { original?: boolean } = {}): Promise<void> {
    const member = await this.route(sessionId)
    if (!member.bridge.remove) throw new AppError(409, 'delete-unsupported', `${member.driver.name} 不支持删除会话`)
    if (options.original && !(member.driver.historyImport && member.driver.historyDelete))
      throw new AppError(409, 'delete-original-unsupported', `${member.driver.name} 不能删除接入会话的原会话`)
    await this.readRunNow(member.bridge, sessionId)
    // Read before the driver and the metadata forget it.
    const projectId = await this.projectFor('sessionDeleted', member, sessionId)
    await this.options.beforeRemove?.(sessionId, this.agentPrivate(sessionId))
    await member.bridge.remove(sessionId, options.original ? { original: true } : undefined)
    this.routes.delete(sessionId)
    // The session is already gone; a stale overlay entry is harmless, a reported failure would mislead.
    if (this.meta.has(sessionId)) await this.meta.remove(sessionId).catch(error => this.log(`会话设置清理失败：${message(error)}`))
    this.options.lifecycle?.sessionDeleted(sessionId, projectId)
  }

  async setConfig(sessionId: string, configId: string, value: string, options?: SetConfigOptions): Promise<void> {
    // A refusal before the driver has the change certainly did not apply.
    let handed = false
    try {
      const member = await this.route(sessionId)
      await this.accept(member, bridge => {
        options?.authorize?.()
        if (!bridge.setConfig) throw new AppError(501, 'not-supported', `${member.driver.name} 不支持修改会话选项`)
        handed = true
        return options ? bridge.setConfig(sessionId, configId, value, options) : bridge.setConfig(sessionId, configId, value)
      })
    } catch (error) {
      throw handed ? error : notSentConfig(error)
    }
  }

  /** What the agent itself reports of one option now; a driver that cannot read it reports nothing. */
  async readConfig(sessionId: string, configId: string, value: string): Promise<ConfigReading> {
    const member = await this.route(sessionId)
    return this.accept(member, bridge =>
      bridge.readConfig ? bridge.readConfig(sessionId, configId, value) : Promise.resolve<ConfigReading>({ kind: 'unread' }),
    )
  }

  /**
   * Records a person's marker on one settlement of the session: a failed run opened, unknown results checked. A marker
   * on another settlement replaces it; on the same one the flags add up. The summary's `updatedAt` does not move.
   */
  async attend(sessionId: string, mark: BoardAttended): Promise<TaskSummary> {
    const member = await this.route(sessionId)
    await this.meta.update(sessionId, current => {
      const before = current.attended?.settle === mark.settle ? current.attended : undefined
      return {
        ...current,
        attended: {
          settle: mark.settle,
          ...(before?.opened || mark.opened ? { opened: true as const } : {}),
          ...(before?.checked || mark.checked ? { checked: true as const } : {}),
        },
      }
    })
    this.emit(sessionId)
    return this.present(member.driver.id, (await member.bridge.detail(sessionId)).summary)
  }

  /** Applies a Host-level title, pin, archive, tag or priority change and returns the updated summary. */
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
      if (patch.tags !== undefined) {
        if (patch.tags?.length) next.tags = [...patch.tags]
        else delete next.tags
      }
      if (patch.priority !== undefined) {
        if (patch.priority) next.priority = patch.priority
        else delete next.priority
      }
      if (patch.note !== undefined) {
        if (patch.note) next.note = patch.note
        else delete next.note
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
  private async discover(): Promise<Array<[Member, DriverTaskSummary[]]>> {
    const members = this.members()
    const settled = await Promise.allSettled(members.map(member => member.bridge.listTasks()))
    const listed: Array<[Member, DriverTaskSummary[]]> = []
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

  /** Latch enforces, or: what the bridge verified, but never more than L3. Plugin harness: nothing verified. */
  private permission(member: Member, reported: SessionPermission | undefined): SessionPermission {
    if (member.trust.level === 'L1') {
      // Latch enforces; a driver says only which of its levels the session is at.
      const { expectedMode, defaultMode, modeTiers } = reported ?? {}
      return {
        level: 'L1',
        enforcer: 'LATCH',
        ...(typeof expectedMode === 'string' ? { expectedMode } : {}),
        ...(typeof defaultMode === 'string' ? { defaultMode } : {}),
        ...(modeTiers ? { modeTiers: structuredClone(modeTiers) } : {}),
        notes: [],
      }
    }
    if (member.trust.kind === 'acp') return { ...reported, notes: [...(reported?.notes ?? [])], level: 'L3', enforcer: 'NONE' }
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

  private present(harnessId: string, summary: DriverTaskSummary): TaskSummary {
    if (summary.personal) this.rememberPersonal(summary.id, summary.personal)
    if (summary.agent) this.rememberAgent(summary.id, summary.agent)
    if (summary.agentPrivate) this.briefSessions.add(summary.id)
    if (harnessId === 'standard' && summary.generalChat) this.generalChats.add(summary.id)
    // Only the Host makes a session's own folder or worktree: a driver's claim is dropped.
    const {
      pinned: _pinned,
      archived: _archived,
      level: _level,
      sessionFolder: _sessionFolder,
      worktree: _worktree,
      firstStart: _firstStart,
      forkOf: _forkOf,
      imported: _imported,
      automationId: _automationId,
      generalChat: _generalChat,
      origin: _origin,
      tags: _tags,
      priority: _priority,
      note: _note,
      board: _board,
      itemId: _itemId,
      teamOf: _teamOf,
      runId,
      live,
      modelRoute,
      ...rest
    } = summary
    const meta = this.meta.get(summary.id)
    const personal = this.personalOf(summary.id)
    const agent = this.agentOf(summary.id)
    const presented = this.branches.decorate({
      ...rest,
      // A run ID a cancel could not carry is left out, so the page sends a plain stop rather than one the Host refuses.
      ...(typeof runId === 'string' && RUN_ID.test(runId) ? { runId } : {}),
      ...(live && typeof live.lastEventAt === 'string'
        ? { live: this.withQueue(summary.id, this.silence.evaluate(summary.id, live)) }
        : {}),
      ...(modelRoute ? { modelRoute: this.routeOf(modelRoute) } : {}),
      harnessId,
      level: this.levelOf(harnessId),
      ...(this.entries.get(harnessId)?.driver.projectFolders !== 'all' ? { folderAccess: 'primary' as const } : {}),
      ...(meta?.title ? { title: meta.title } : {}),
      ...(meta?.pinned ? { pinned: true } : {}),
      ...(meta?.archived ? { archived: true } : {}),
      ...(meta?.tags?.length ? { tags: [...meta.tags] } : {}),
      ...(meta?.priority ? { priority: meta.priority } : {}),
      ...(meta?.note ? { note: meta.note } : {}),
      ...(meta?.workspaceId ? { workspaceId: meta.workspaceId } : {}),
      ...(meta?.forkOf ? { forkOf: meta.forkOf } : {}),
      ...(meta?.imported
        ? {
            imported: {
              from: meta.imported.from,
              mode: meta.imported.mode,
              ...(meta.imported.prefixLength ? { prefixLength: meta.imported.prefixLength } : {}),
              ...(meta.imported.truncated ? { truncated: true as const } : {}),
              ...(meta.imported.fromTaskId ? { fromTaskId: meta.imported.fromTaskId } : {}),
            },
          }
        : {}),
      ...(personal ? { personal } : {}),
      ...(agent ? { agent } : {}),
      ...(this.agentPrivate(summary.id) && !agent ? { agentPrivate: true as const } : {}),
      ...(meta?.automationId ? { automationId: meta.automationId } : {}),
      ...(this.generalChatOf(summary.id) && !agent ? { generalChat: true as const } : {}),
      ...(meta?.origin ? { origin: { app: meta.origin.app, requestId: meta.origin.requestId } } : {}),
      ...(meta?.sessionFolder && SESSION_FOLDER_NAME.test(meta.sessionFolder) ? { sessionFolder: true as const } : {}),
      ...(meta?.worktree
        ? {
            worktree: {
              branch: meta.worktree.branch,
              ...(meta.worktree.unfiltered ? { unfiltered: meta.worktree.unfiltered } : {}),
              ...(meta.worktree.removed ? { removed: true as const } : {}),
            },
          }
        : {}),
      ...(meta?.firstStart ? { firstStart: true as const } : {}),
    })
    const itemId = this.options.itemOf?.(summary.id)
    if (itemId) presented.itemId = itemId
    const teamOf = this.options.teamOf?.(summary.id)
    if (teamOf) presented.teamOf = teamOf
    const board = this.options.board?.(presented, {
      ...(meta?.attended ? { attended: { ...meta.attended } } : {}),
      pr: meta?.pr !== undefined,
    })
    return board ? { ...presented, board } : presented
  }

  /** What the route says of its service comes from the Host's records, never from the driver. */
  private routeOf(route: NonNullable<TaskSummary['modelRoute']>): NonNullable<TaskSummary['modelRoute']> {
    const { name: _name, off: _off, fallbacks: listed, ...rest } = route
    const service = this.options.service?.(route.providerId)
    const fallbacks = listed?.map(({ providerId, model }) => {
      const name = this.options.service?.(providerId)?.name
      return { providerId, model, ...(name ? { name } : {}) }
    })
    const base = { ...rest, ...(fallbacks?.length ? { fallbacks } : {}) }
    if (!service) return base
    return { ...base, name: service.name, ...(service.enabled ? {} : { off: true as const }) }
  }

  /** The service a model request of the run waits for a place of, as the Host's scheduler says; a driver never sets it. */
  private withQueue(sessionId: string, live: RunLive): RunLive {
    const { queued: _queued, queuedFor: _service, ...rest } = live
    const waiting = this.options.queueOf?.(sessionId)
    return waiting ? { ...rest, queued: true, ...(waiting.service ? { queuedFor: waiting.service } : {}) } : rest
  }

  private describe(entry: Entry): HarnessInfo {
    const { driver } = entry
    const declared = driver.capabilities
    const { capabilities } = entry
    let status: HarnessInfo['status'] = 'ready'
    let statusMessage: string | undefined
    let statusReason: HarnessInfo['statusReason']
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
          if (reported.status === 'unavailable' && (reported.statusReason === 'outdated' || reported.statusReason === 'moved'))
            statusReason = reported.statusReason
        }
      } catch (error) {
        status = 'unavailable'
        statusMessage = message(error)
      }
    }
    const login = driver.login?.()
    let catalogue: HarnessInfo['catalogue']
    let serviceOptions: HarnessInfo['serviceOptions']
    let catalogueRead: HarnessInfo['catalogueRead']
    let customModels: string[] | undefined
    let reported: HarnessInfo['attachmentsReported']
    let ownMcp: HarnessInfo['ownMcp']
    let quota: HarnessInfo['quota']
    let quotaRead: HarnessInfo['quotaRead']
    try {
      ownMcp = entry.bridge?.ownMcp?.()
      quota = entry.bridge?.quota?.()
      quotaRead = entry.bridge?.quotaRead?.()
      reported = entry.bridge?.promptCapabilities?.()
      catalogue = entry.bridge?.catalogue?.()
      const declarations = entry.bridge?.serviceOptions ? this.serviceDeclarations(capabilities) : []
      if (declarations.length) serviceOptions = entry.bridge!.serviceOptions!(declarations)
      catalogueRead = entry.bridge?.readCatalogue ? entry.bridge.catalogueRead?.() : undefined
      customModels = entry.bridge?.customModels?.()
    } catch (error) {
      this.log(`Harness ${driver.id} 的可选项读取失败：${message(error)}`)
    }
    return {
      id: driver.id,
      ...(driver.description ? { description: driver.description } : {}),
      capabilities: structuredClone(capabilities),
      ...(entry.trust.kind === 'acp' ? { editable: true as const } : {}),
      status,
      ...(statusMessage ? { statusMessage } : {}),
      ...(statusReason ? { statusReason } : {}),
      modes: [...(declared?.modes ?? ['chat', 'agent'])],
      ...(driver.agentContext ? { agentContext: driver.agentContext } : {}),
      ...(driver.skills ? { skills: driver.skills } : {}),
      ...(declared?.attachments ? { attachments: structuredClone(declared.attachments) } : {}),
      ...(reported ? { attachmentsReported: { images: reported.images === true, text: reported.text === true } } : {}),
      level: entry.trust.level,
      ...folderInfo(driver),
      ...(driver.permission ? { permission: { ...driver.permission } } : {}),
      ...(login ? { login } : {}),
      ...(catalogue ? { catalogue: structuredClone(catalogue) } : {}),
      ...(serviceOptions?.length ? { serviceOptions: structuredClone(serviceOptions) } : {}),
      ...(catalogueRead ? { catalogueRead: structuredClone(catalogueRead) } : {}),
      ...(entry.bridge?.commandCatalogue ? { commandCatalogue: { generation: entry.generation } } : {}),
      ...(entry.bridge?.latestCommandReport && driver.extensionSupport
        ? { extensionSupport: structuredClone(driver.extensionSupport) }
        : {}),
      ...(customModels?.length ? { customModels: [...customModels] } : {}),
      ...(ownMcp ? { ownMcp: structuredClone(ownMcp) } : {}),
      ...(quota ? { quota: structuredClone(quota) } : {}),
      ...(quotaRead ? { quotaRead: structuredClone(quotaRead) } : {}),
      ...(driver.historyImport || driver.seededStart
        ? {
            history: {
              ...(driver.historyImport ? { list: true as const } : {}),
              ...(driver.seededStart ? { rebuild: true as const } : {}),
              ...(driver.historyImport && driver.historyDelete ? { deleteOriginal: true as const } : {}),
            },
          }
        : {}),
    }
  }

  /** The saved services this harness can reach through the gateway, with the protocols on both sides as a route has them. */
  private serviceDeclarations(capabilities: HarnessCapabilities): ServiceDeclaration[] {
    if (capabilities.models.owner === 'latch') return []
    return (this.options.services?.() ?? []).flatMap(service => {
      const route = pairRoute(capabilities, { kind: service.kind })
      if (route.kind !== 'passthrough' && route.kind !== 'translate') return []
      return [
        {
          providerId: service.providerId,
          entry: route.wire,
          upstream: route.kind === 'translate' ? route.upstream : PROVIDER_WIRES[service.kind],
          models: service.models,
          ...(service.modelCapabilities ? { modelCapabilities: service.modelCapabilities } : {}),
        },
      ]
    })
  }

  /** Reads what a harness offers before a session; see `Bridge.readCatalogue`. */
  async readHarnessCatalogue(id: string, auto: boolean, before: () => Promise<void>, model?: string): Promise<{ ran: boolean }> {
    const member = this.member(id)
    if (!member) throw new AppError(409, 'harness-unavailable', `Harness ${id} 当前不可用`)
    if (!member.bridge.readCatalogue) throw new AppError(409, 'catalogue-unsupported', '这个 Harness 不能在开始前读取可选项。')
    return member.bridge.readCatalogue({ auto, before, ...(model !== undefined ? { model } : {}) })
  }

  /** 读取 of a harness's own MCP servers; see `Bridge.readOwnMcp`. */
  async readHarnessMcp(id: string, before: () => Promise<void>): Promise<void> {
    const member = this.member(id)
    if (!member) throw new AppError(409, 'harness-unavailable', `Harness ${id} 当前不可用`)
    if (!member.bridge.readOwnMcp || !member.bridge.ownMcp?.()) throw new AppError(409, 'mcp-not-reported', '这个 Harness 不报告自己的 MCP')
    await member.bridge.readOwnMcp({ before })
  }

  /** Someone looks at a harness's limits; see `Bridge.refreshQuota`. False: it has no way to be asked. */
  refreshHarnessQuota(id: string, options: { retry: boolean; before: () => Promise<void> }): boolean {
    const bridge = this.member(id)?.bridge
    if (!bridge?.refreshQuota) return false
    void bridge.refreshQuota(options).catch(() => {})
    return true
  }

  /** Logs a harness out; see `Bridge.logout`. */
  async logoutHarness(id: string): Promise<void> {
    const member = this.member(id)
    if (!member) throw new AppError(409, 'harness-unavailable', `Harness ${id} 当前不可用`)
    if (!member.bridge.logout) throw new AppError(409, 'logout-unsupported', '这个 Harness 不能从 Latch 退出登录。')
    await member.bridge.logout()
  }

  /** What a harness says about logging in now, as a client sees it. */
  harnessLogin(id: string): HarnessInfo['login'] {
    return this.member(id)?.driver.login?.()
  }

  async setHarnessModels(id: string, models: readonly string[]): Promise<void> {
    const member = this.member(id)
    if (!member) throw new AppError(409, 'harness-unavailable', `Harness ${id} 当前不可用`)
    if (!member.bridge.setCustomModels) throw new AppError(409, 'models-unsupported', '这个 Harness 不能填写模型 ID。')
    await member.bridge.setCustomModels(models)
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
