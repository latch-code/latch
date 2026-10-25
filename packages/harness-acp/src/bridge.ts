import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type {
  Approval,
  ApprovalOptionKind,
  Message,
  SessionConfigOption,
  SessionPermission,
  TaskDetail,
  TaskStatus,
  TaskSummary,
  ToolDecision,
} from '@latch/protocol'
import {
  AppError,
  type HarnessHostOptions,
  type HarnessSecurityEvent,
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
import { isoTime, ReasoningTimer, RunClock, sha256Hex } from '@latch/core/node-kit'
import { redactor, resolveCommand } from './command.ts'
import { AgentConnection, ConnectionClosed, ConnectionStopping, RequestTimeout, type ExitInfo } from './connection.ts'
import { agentEnvironment } from './environment.ts'
import {
  append,
  blockText,
  clip,
  configFromOptions,
  foldConfig,
  mergeTool,
  modelName,
  planEntries,
  pretty,
  settleTool,
  settleToolMessage,
  TOOL_TEXT_LIMIT,
  toolDetail,
  toolLabel,
  toolMessage,
  type ToolState,
} from './mapping.ts'
import {
  classifyMode,
  filterPermissionOptions,
  isVisibleOption,
  launchHash,
  selectProfile,
  type LaunchFolders,
  type ProfileSelection,
} from './permission.ts'
import type { AcpPermissionProfile } from './profiles/index.ts'
import { fingerprintProjectConfig, PROJECT_CONFIG_LIMITS, type ProjectConfig } from './project-config.ts'
import {
  cancelRequest,
  chunkUpdate,
  configUpdate,
  commandsUpdate,
  infoUpdate,
  initializeResult,
  modeUpdate,
  usageUpdate,
  permissionRequest,
  planUpdate,
  promptResult,
  PROTOCOL_VERSION,
  RPC,
  RpcError,
  sessionState,
  toolFields,
  updateEnvelope,
  type PermissionOption,
  type RpcId,
  type ToolFields,
} from './protocol.ts'
import { createAcpStore, emptyAcpState, type AcpRecord, type AcpState, type AcpStore, type AcpTask } from './store.ts'
import type { AgentHealth, AgentRecord, ResolvedOptions } from './types.ts'

export const CLIENT_VERSION = '0.1.0'
const CANCELLED_OUTCOME = { outcome: { outcome: 'cancelled' } }

/** The agent process of one session (or of a removed session being deleted) and what `initialize` reported. */
interface Live {
  /** Latch task this process serves; also names its private temporary directory. */
  key: string
  connection: AgentConnection
  initialized: boolean
  capabilities: { resume: boolean; load: boolean; delete: boolean; additionalDirectories: boolean }
  authMethods: Array<{ name: string; description?: string }>
  agentVersion?: string
  /** ACP session → Latch task. Updates for unbound sessions, including a session/load replay, are discarded. */
  sessions: Map<string, string>
  idleTimer?: NodeJS.Timeout
  /** For choosing which idle process to stop when the process limit is reached. */
  lastUsed: number
}

interface Segment {
  id: string
  text: string
  reasoning: string
  acpMessageId?: string
  /** When its first chunk arrived, in clock milliseconds. */
  createdAt: number
  reasoningTimer: ReasoningTimer
}

interface Run {
  /** `TaskSummary.runId` once the turn is recorded; a cancel naming another run leaves this one alone. */
  id: string
  taskId: string
  seq: number
  prompt: string
  live?: Live
  acpSessionId?: string
  /** session/prompt was written; updates from now on belong to this turn. */
  sent: boolean
  cancelRequested: boolean
  activity: NonNullable<TaskDetail['activity']>
  /** From the prompt to the turn's end, with the approval wait. */
  clock: RunClock
  /** The user message of this turn, once recorded; it carries the turn's times when the turn ends. */
  userMessageId?: string
  /** The last change of visible output, in clock milliseconds. */
  lastOutputAt?: number
  segment?: Segment
  graceTimer?: NodeJS.Timeout
  /** System notes appended once the turn settles, after its last reply. */
  notes: string[]
  done: Promise<void>
  resolveDone(): void
}

interface Permission {
  approval: Approval
  live: Live
  rpcId: RpcId
  taskId: string
  tool: ToolState
  /** Everything the agent offered; only `visible` options can be chosen. */
  options: PermissionOption[]
  visible: PermissionOption[]
  claimed: boolean
  answer(result: unknown): void
  fail(error: Error): void
}

interface Binding {
  live: Live
  acpSessionId: string
}

/** What a new process would launch: `hash` covers the project configuration, `definitionHash` only the definition. */
interface Launch {
  command: string
  hash: string
  definitionHash: string
}

/** The launch the owner confirmed for a session, as stored with it. */
interface Confirmed {
  launchHash?: string
  definitionHash?: string
  /** The other folders the agent receives, which the launch covers. */
  folders?: LaunchFolders
}

/** A launch shown in a local confirmation: its definition part, and the folders it passes (`''` for none). */
interface Previewed {
  definitionHash: string
  folders: string
}

/** The project a new session works in, as it records it. */
interface Scope {
  workspaceId: string
  /** Every folder of the session in order, as the Host registered them; `[0]` is at `cwd`. */
  folders: ProjectFolder[]
  /** The folders the agent receives besides `cwd`; absent when there are none. */
  passed?: LaunchFolders
}

/** A mode change Latch requested and is waiting on; the agent's reports meanwhile are measured against `allowed`. */
interface ModeChange {
  /** The mode being left and the one requested. */
  allowed: Array<string | undefined>
  /** Last mode the agent reported while the change was open, including in its response. */
  reported?: string
}

/** Recorded, and shown, as the observed mode when the agent stops reporting a mode it reported before. */
const UNREPORTED_MODE = '未报告'

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
function codeOf(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

function assertPrompt(prompt: unknown, requestId: unknown): void {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 1_000_000)
    throw new AppError(400, 'invalid-prompt', '请输入不超过 1 MB 的任务内容')
  if (typeof requestId !== 'string' || !requestId || requestId.length > 256)
    throw new AppError(400, 'invalid-request-id', '缺少有效的请求标识')
}

function cancelledBeforeSend(): AppError {
  return new AppError(409, 'cancelled-before-send', '已在发送给 Harness 之前取消')
}

function definitionChanged(): AppError {
  return new AppError(409, 'agent-definition-changed', 'Agent 定义已变化，该会话不能继续。请新建会话（需要本机确认）。')
}

function permissionDrift(): AppError {
  return new AppError(409, 'permission-drift', '该会话检测到权限模式漂移，已停止接收输入。请新建会话。')
}

function workspaceChanged(): AppError {
  return new AppError(409, 'workspace-changed', '这个会话使用的文件夹已不在项目中或找不到了，不能继续。请新建会话。')
}

function scopeUnavailable(): AppError {
  return new AppError(400, 'workspace-unavailable', '所选项目的文件夹与此节点登记的不一致')
}

/** How the folders a launch passes are compared: in order, with how they are passed. */
function foldersKey(folders: LaunchFolders | undefined): string {
  return folders?.paths.length ? JSON.stringify([folders.via, folders.paths]) : ''
}

/** The folders a session's stored launch passes, as `Confirmed` carries them. */
function storedFolders(acp: AcpRecord): LaunchFolders | undefined {
  return acp.folderVia && acp.folders?.length ? { via: acp.folderVia, paths: [...acp.folders] } : undefined
}

/** What the owner confirmed for a session, from its stored record. */
function confirmedOf(acp: AcpRecord): Confirmed {
  const folders = storedFolders(acp)
  return { launchHash: acp.launchHash, definitionHash: acp.definitionHash, ...(folders ? { folders } : {}) }
}

function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Stops waiting on `promise` once `signal` aborts; the work itself continues for other waiters. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

function describeExit(info: ExitInfo): string {
  if (info.error) return info.error
  if (info.signal) return `信号 ${info.signal}`
  return `退出码 ${info.code ?? '未知'}`
}

/** Configuration files named in a note, before the rest are only counted. */
const NOTE_PATHS = 8
/** Recently previewed launch fingerprints kept to tell, at start, which part of a refused one changed. */
const PREVIEWS = 64

/** Relative to the first of `roots` that holds it, else absolute. */
function displayPath(path: string, roots: string[]): string {
  for (const root of roots) {
    const inside = relative(root, path)
    if (inside && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) return inside.split(sep).join('/')
  }
  return path
}

function selected(optionId: string): unknown {
  return { outcome: { outcome: 'selected', optionId } }
}

/**
 * One agent process per Latch task, each with its own working directory, environment and temporary directory;
 * Latch task ↔ ACP session is 1:1. Every session is full access (L3): the agent's own permission mode and questions
 * are advisory, and Latch only refuses to continue when it cannot confirm that mode.
 */
export class AcpBridge implements Bridge {
  private state: AcpState = emptyAcpState()
  private readonly store: AcpStore
  private readonly workspaceRoot: string
  private readonly redact: (text: string) => string
  private readonly selection: ProfileSelection
  private readonly profile?: AcpPermissionProfile
  private readonly clock: () => number
  private readonly runs = new Map<string, Run>()
  private readonly permissions = new Map<string, Permission>()
  private readonly tools = new Map<string, { seq: number; calls: Map<string, ToolState> }>()
  /** Assistant text that arrived outside a turn and is being appended to a settled message. */
  private readonly stray = new Map<string, { id: string; acpMessageId?: string }>()
  /** Setup of a task's ACP session; a cancel before session/prompt aborts it instead of killing the process. */
  private readonly attaching = new Map<string, { promise: Promise<Binding>; controller: AbortController }>()
  /** Background cleanup of removed tasks: session/delete, process stop, temporary directory. */
  private readonly forgetting = new Map<string, Promise<void>>()
  private readonly inflight = new Map<string, { payloadHash: string; promise: Promise<void> }>()
  private readonly listeners = new Set<(sessionId?: string) => void>()
  private readonly lifetime = new AbortController()
  private readonly lives = new Map<string, Live>()
  private readonly spawning = new Map<string, Promise<Live>>()
  /** Requests on a task's process outside a turn or setup, such as a config change; its process must not be stopped. */
  private readonly holds = new Map<string, number>()
  /** Tasks whose ACP session is being set up and first checked; mode reports then are its starting point, not drift. */
  private readonly quiet = new Map<string, number>()
  /** Mode changes Latch has requested per task and not yet seen answered. */
  private readonly changes = new Map<string, Set<ModeChange>>()
  /** Tasks whose recorded mode dates from an earlier process and has not been reported by the current one. */
  private readonly unconfirmed = new Set<string>()
  /** Launch fingerprint → its definition part and folders, for launches recently shown in a local confirmation. */
  private readonly previews = new Map<string, Previewed>()
  /** New sessions whose agent is started, to learn whether it takes their folders, before they are recorded. */
  private readonly creating = new Map<string, { payloadHash: string; promise: Promise<{ sessionId: string }> }>()
  private started?: Promise<void>
  private closing?: Promise<void>
  private closed = false
  private loaded = false
  private storageFailure?: unknown
  private writing?: Promise<void>
  private version = 0
  private durable = 0
  private waiters: Array<{ version: number; resolve(): void; reject(error: unknown): void }> = []

  constructor(
    private readonly agent: AgentRecord,
    private readonly options: HarnessHostOptions,
    private readonly health: AgentHealth,
    private readonly limits: ResolvedOptions,
    private readonly onClosed?: () => void,
  ) {
    this.store = createAcpStore(options.dataDir)
    this.workspaceRoot = resolve(options.workspaceRoot)
    this.redact = redactor(agent.env)
    this.selection = selectProfile(agent)
    this.profile = this.selection.profile?.permission
    this.clock = options.clock ?? Date.now
  }

  private now(): string {
    return isoTime(this.clock())
  }

  /** Moves a turn to a phase; `since` changes only when the phase or its tool does. */
  private phase(run: Run, phase: NonNullable<TaskDetail['activity']>['phase'], toolName?: string): void {
    if (run.activity.phase === phase && run.activity.toolName === toolName && run.activity.since) return
    run.activity = { phase, ...(toolName !== undefined ? { toolName } : {}), since: this.now() }
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new AppError(503, 'runtime-closed', '运行节点已关闭'))
    return (this.started ??= (async () => {
      this.state = await this.store.load()
      this.loaded = true
      let changed = false
      for (const task of Object.values(this.state.tasks)) {
        if (task.summary.status !== 'running' && task.summary.status !== 'waiting-approval') continue
        const at = this.now()
        for (const item of task.messages) settleToolMessage(item, at)
        task.summary.status = 'interrupted'
        // The turn did not settle, so its user message gets no times: its duration is unknown.
        task.messages.push({
          id: randomUUID(),
          role: 'system',
          text: '上次运行被中断。旧审批已失效；请核对工具副作用后再明确发起后续任务。',
          state: 'failed',
          createdAt: this.now(),
        })
        this.touch(task)
        changed = true
      }
      if (changed) {
        this.mark()
        await this.flush()
      }
    })())
  }

  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.closed = true
      this.lifetime.abort()
      await this.started?.catch(() => {})
      const runs = [...this.runs.values()]
      for (const run of runs) this.requestCancel(run, false)
      if (runs.length)
        await this.within(Promise.all(runs.map(run => run.done)), Math.min(this.limits.cancelGraceMs, this.limits.stopGraceMs))
      // Stopping the processes settles every remaining turn and setup request as interrupted.
      await this.stopAll()
      await Promise.allSettled([...this.spawning.values()])
      await this.stopAll()
      await Promise.allSettled([...this.creating.values()].map(entry => entry.promise))
      await Promise.allSettled([...this.forgetting.values()])
      await Promise.all(runs.map(run => run.done))
      await Promise.allSettled([...this.inflight.values()].map(entry => entry.promise))
      await Promise.all([...this.runs.values()].map(run => run.done))
      if (this.loaded) await this.flush().catch(() => {})
      try {
        await this.store.close()
      } finally {
        this.listeners.clear()
        this.onClosed?.()
      }
    })())
  }

  async listTasks(): Promise<TaskSummary[]> {
    await this.ready()
    return structuredClone(
      Object.values(this.state.tasks)
        .map(task => task.summary)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    )
  }

  async detail(sessionId: string): Promise<TaskDetail> {
    await this.ready()
    const task = this.task(sessionId)
    const run = this.runs.get(sessionId)
    const active = task.summary.status === 'running' || task.summary.status === 'waiting-approval'
    const segment = active ? run?.segment : undefined
    return structuredClone({
      summary: task.summary,
      messages: task.messages,
      approvals: this.openApprovals(sessionId),
      liveText: segment?.text ?? '',
      cursor: task.revision,
      ...(segment ? { liveMessageId: segment.id } : {}),
      ...(segment?.reasoning ? { liveReasoning: segment.reasoning, ...segment.reasoningTimer.live() } : {}),
      ...(active && run ? { activity: run.activity, ...run.clock.live() } : {}),
      ...(active && run?.lastOutputAt !== undefined ? { lastOutputAt: isoTime(run.lastOutputAt) } : {}),
      ...(task.usageReport ? { usageReport: task.usageReport } : {}),
      ...(task.commands ? { commands: task.commands } : {}),
      ...(task.plan ? { plan: task.plan } : {}),
      ...(task.config?.length ? { config: task.config } : {}),
      permission: this.permissionView(task),
    })
  }

  async launchPreview(input: { cwd: string; workspaceId?: string; folders?: ReadonlyArray<ProjectFolder> }): Promise<LaunchPreview> {
    await this.ready()
    // The agent is given the registered path; configuration is looked up along it and along its real path.
    const given = await this.workspace(input.cwd)
    const cwd = await realpath(given)
    const passed = (await this.scopeOf(input, given))?.passed
    const project = await this.projectConfig(given, passed)
    const launch = this.currentLaunch(project, passed)
    this.previews.delete(launch.hash)
    this.previews.set(launch.hash, { definitionHash: launch.definitionHash, folders: foldersKey(passed) })
    for (const [hash] of this.previews) {
      if (this.previews.size <= PREVIEWS) break
      this.previews.delete(hash)
    }
    const materializedEnv = await this.selection.profile?.materialize?.({ dataDir: this.options.dataDir })
    const env = agentEnvironment({
      resolvedCommand: launch.command,
      profile: this.profile,
      materializedEnv,
      definitionEnv: this.agent.env,
      sessionTmpDir: this.tmpRoot(),
    })
    return {
      launchHash: launch.hash,
      definitionHash: launch.definitionHash,
      command: launch.command,
      args: [...this.agent.args],
      envNames: Object.keys(env).sort(),
      definitionEnvNames: Object.keys(this.agent.env).sort(),
      cwd,
      ...(passed ? { folders: [...passed.paths] } : {}),
      ...(this.selection.preset ? { presetId: this.selection.preset.id } : {}),
      // Looked up again for every start: whether the command is the preset's own depends on where the Host finds it now.
      verified: selectProfile(this.agent).verified,
      approvals: this.profile?.approvals ?? 'prompts',
      readback: this.profile?.readback ?? 'none',
      // Configuration in the other folders is named by its full path, so it never reads as the session directory's.
      notes: [...this.permissionNotes(), ...this.folderNotes(passed), ...this.projectNotes(project, [given, cwd])],
    }
  }

  async createTask(input: CreateTaskInput): Promise<{ sessionId: string }> {
    await this.ready()
    assertPrompt(input.prompt, input.requestId)
    const key = digest(['create', input.requestId])
    const payloadHash = digest({
      prompt: input.prompt,
      mode: input.mode ?? 'agent',
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(Array.isArray(input.folders) && input.folders.length > 1 ? { folders: input.folders.map(({ id, path }) => ({ id, path })) } : {}),
    })
    const pending = this.creating.get(key)
    if (pending) {
      if (pending.payloadHash !== payloadHash) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同任务内容')
      return pending.promise
    }
    // Reserve before filesystem checks: another body with this ID cannot overtake a slow first check.
    const promise = this.createTaskOnce(input).finally(() => this.creating.delete(key))
    this.creating.set(key, { payloadHash, promise })
    return promise
  }

  private async createTaskOnce(input: CreateTaskInput): Promise<{ sessionId: string }> {
    await this.ready()
    assertPrompt(input.prompt, input.requestId)
    const mode = input.mode ?? 'agent'
    if (mode === 'chat') throw new AppError(400, 'mode-unsupported', `${this.agent.name} 只支持 Agent 模式`)
    if (mode !== 'agent') throw new AppError(400, 'invalid-mode', '对话模式必须是 chat 或 agent')
    if (typeof input.expectedLaunchHash !== 'string' || !input.expectedLaunchHash) {
      throw new AppError(409, 'l3-confirmation-missing', '此会话没有经过本机确认，不能启动。')
    }
    const cwd = await this.workspace(input.cwd)
    const scope = await this.scopeOf(input, cwd)
    // Read before the receipt check: nothing may wait between that check and the reservation below, except for a start
    // that `creating` keeps to one per request.
    const project = await this.projectConfig(cwd, scope?.passed)
    this.assertOpen()
    const key = digest(['create', input.requestId])
    // Folders join the hash only when there are several, so receipts written before they existed still match.
    const payloadHash = digest({
      prompt: input.prompt,
      mode,
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(scope && scope.folders.length > 1 ? { folders: (input.folders ?? []).map(({ id, path }) => ({ id, path })) } : {}),
    })
    const receipt = this.state.receipts[key]
    if (receipt) {
      if (receipt.payloadHash !== payloadHash) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同任务内容')
      if (receipt.deleted) throw new AppError(410, 'task-deleted', '该任务已删除')
      await this.flush()
      return { sessionId: receipt.taskId }
    }
    const launch = this.currentLaunch(project, scope?.passed)
    if (launch.hash !== input.expectedLaunchHash) throw this.launchRefusal(input.expectedLaunchHash, launch, scope?.passed)
    const sessionId = `task-${randomUUID()}`
    const create = {
      sessionId,
      prompt: input.prompt,
      requestId: input.requestId,
      key,
      payloadHash,
      cwd,
      launch,
      ...(scope ? { scope } : {}),
    }
    if (scope?.passed?.via !== 'acp') return this.record(create)
    // Whether the agent takes the other folders is known only once it has started, so it starts before the session
    // exists; held, so that no other start stops it as idle meanwhile.
    const passed = scope.passed
    this.enter(this.holds, sessionId)
    return (async () => {
      try {
        const live = await this.ensureProcess(sessionId, cwd, {
          launchHash: launch.hash,
          definitionHash: launch.definitionHash,
          folders: passed,
        })
        if (!live.capabilities.additionalDirectories) throw this.foldersUnsupported(true)
        return await this.record(create)
      } catch (error) {
        if (!Object.hasOwn(this.state.tasks, sessionId)) await this.discardProcess(sessionId)
        throw error
      } finally {
        this.leave(this.holds, sessionId)
      }
    })()
  }

  /** Records a new session with its creation receipt and starts its first turn. */
  private async record(create: {
    sessionId: string
    prompt: string
    key: string
    payloadHash: string
    requestId: string
    cwd: string
    launch: Launch
    scope?: Scope
  }): Promise<{ sessionId: string }> {
    const { sessionId, prompt, cwd, launch, scope } = create
    this.assertOpen()
    const run = this.reserve(sessionId, 1, prompt)
    const at = isoTime(run.clock.startedAt)
    run.userMessageId = randomUUID()
    this.state.tasks[sessionId] = {
      summary: {
        id: sessionId,
        title: prompt.trim().replace(/\s+/g, ' ').slice(0, 80),
        status: 'running',
        updatedAt: at,
        createdAt: at,
        cwd,
        mode: 'agent',
        ...(scope
          ? { workspaceId: scope.workspaceId, folders: scope.folders.map(({ id, path }) => ({ id, path })), folderAccess: 'all' as const }
          : {}),
        runId: run.id,
      },
      messages: [{ id: run.userMessageId, role: 'user', text: prompt, requestId: create.requestId, createdAt: at }],
      revision: 1,
      acp: {
        cwd,
        turnSeq: 1,
        launchHash: launch.hash,
        definitionHash: launch.definitionHash,
        ...(this.selection.profile ? { profilePresetId: this.selection.profile.presetId } : {}),
        ...(scope?.passed ? { folders: [...scope.passed.paths], folderVia: scope.passed.via } : {}),
      },
    }
    this.state.receipts[create.key] = { taskId: sessionId, payloadHash: create.payloadHash, kind: 'create' }
    this.tools.set(sessionId, { seq: 1, calls: new Map() })
    this.mark()
    this.notify(sessionId)
    try {
      await this.flush()
    } catch (error) {
      this.release(run)
      throw error
    }
    this.begin(run)
    return { sessionId }
  }

  async prompt(sessionId: string, prompt: string, requestId: string, options: PromptOptions = {}): Promise<void> {
    await this.ready()
    assertPrompt(prompt, requestId)
    const key = digest(['prompt', sessionId, requestId])
    const payloadHash = digest(options.model ? { prompt, model: options.model } : prompt)
    const repeated = (): Promise<void> | undefined => {
      const receipt = this.state.receipts[key]
      if (receipt) {
        if (receipt.payloadHash !== payloadHash) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同输入')
        return this.flush()
      }
      const pending = this.inflight.get(key)
      if (pending) {
        if (pending.payloadHash !== payloadHash) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同输入')
        return pending.promise
      }
      return undefined
    }
    let answered = repeated()
    if (!answered) {
      const task = this.task(sessionId)
      this.assertUsable(task)
      await this.assertWorkspace(task)
      await this.assertLaunch(task.acp.cwd, confirmedOf(task.acp))
      this.assertOpen()
      answered = repeated()
    }
    if (answered) return answered
    const task = this.task(sessionId)
    if (this.runs.has(sessionId) || task.summary.status === 'running' || task.summary.status === 'waiting-approval') {
      throw new AppError(409, 'task-running', '任务仍在运行，请等待完成或先取消')
    }
    const run = this.reserve(sessionId, task.acp.turnSeq + 1, prompt)
    const promise = (async () => {
      try {
        // Reattach and confirm the mode before recording, so a refused turn leaves no side effects.
        await this.attach(sessionId)
        this.assertOpen()
        if (run.cancelRequested) throw cancelledBeforeSend()
        const current = this.task(sessionId)
        this.assertUsable(current)
        current.acp.turnSeq = run.seq
        run.userMessageId = randomUUID()
        current.messages.push({ id: run.userMessageId, role: 'user', text: prompt, requestId, createdAt: isoTime(run.clock.startedAt) })
        current.summary.status = 'running'
        current.summary.runId = run.id
        this.touch(current)
        this.state.receipts[key] = { taskId: sessionId, payloadHash, kind: 'prompt' }
        this.tools.set(sessionId, { seq: run.seq, calls: new Map() })
        this.stray.delete(sessionId)
        this.mark()
        this.notify(sessionId)
        await this.flush()
      } catch (error) {
        this.release(run)
        this.notify(sessionId)
        throw error
      }
      this.begin(run)
    })().finally(() => this.inflight.delete(key))
    this.inflight.set(key, { payloadHash, promise })
    return promise
  }

  async cancel(sessionId: string, options: CancelOptions = {}): Promise<boolean> {
    await this.ready()
    this.task(sessionId)
    const run = this.runs.get(sessionId)
    // Checked before anything awaits, so a turn that starts after this point is never the one cancelled.
    if (!run || (options.runId !== undefined && run.id !== options.runId)) return false
    this.requestCancel(run, true)
    // Acknowledged only once the agent settled the turn, or its process was stopped.
    await run.done
    if (this.storageFailure) throw new AppError(503, 'storage-unavailable', '执行已停止，但取消状态未能持久化')
    return true
  }

  approvals(): Approval[] {
    return [...this.permissions.values()].filter(item => !item.claimed).map(item => structuredClone(item.approval))
  }

  async decide(approvalId: string, decision: 'allow' | 'reject', options: DecideOptions = {}): Promise<boolean> {
    if (decision !== 'allow' && decision !== 'reject') throw new AppError(400, 'invalid-decision', '无效的审批决定')
    const permission = this.permissions.get(approvalId)
    if (!permission || permission.claimed || this.closed) return false
    const option = this.chooseOption(permission, decision, options.optionId)
    const via = options.via === 'this-mac' || options.via === 'other-device' ? options.via : undefined
    // Claimed synchronously, before any concurrent decision can compete. A note has nowhere to go: a permission answer
    // carries no text, so the page sends it as the next message instead.
    this.closePermission(permission, option ? selected(option.optionId) : CANCELLED_OUTCOME, {
      outcome: decision === 'allow' ? 'allowed' : 'rejected',
      at: this.now(),
      ...(via ? { via } : {}),
    })
    return true
  }

  subscribe(listener: (sessionId?: string) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async remove(sessionId: string): Promise<void> {
    await this.ready()
    const task = this.task(sessionId)
    if (
      this.runs.has(sessionId)
      || this.attaching.has(sessionId)
      || task.summary.status === 'running'
      || task.summary.status === 'waiting-approval'
    ) {
      throw new AppError(409, 'task-running', '任务仍在运行，请等待完成或先取消')
    }
    const { acpSessionId, cwd, deletable } = task.acp
    const recorded = structuredClone(task)
    delete this.state.tasks[sessionId]
    for (const [key, receipt] of Object.entries(this.state.receipts)) {
      if (receipt.taskId !== sessionId) continue
      if (receipt.kind === 'create') receipt.deleted = true
      else delete this.state.receipts[key]
    }
    this.tools.delete(sessionId)
    this.stray.delete(sessionId)
    this.unconfirmed.delete(sessionId)
    this.mark()
    await this.flush()
    this.notify(sessionId)
    this.forget(sessionId, acpSessionId, cwd, deletable === true, confirmedOf(recorded.acp), () => this.stillListed(recorded))
  }

  async classifyConfigChange(sessionId: string, configId: string, value: string): Promise<ConfigChangeClass> {
    await this.ready()
    const task = this.task(sessionId)
    const option = task.config?.find(item => item.id === configId)
    if (!option) throw new AppError(404, 'config-not-found', '该会话没有这个设置项')
    if (!this.isModeOption(task, option)) return 'neutral'
    return classifyMode(this.profile, this.expectedMode(task) ?? option.currentValue, value)
  }

  async setConfig(sessionId: string, configId: string, value: string, options: SetConfigOptions = {}): Promise<void> {
    await this.ready()
    const task = this.task(sessionId)
    const option = task.config?.find(item => item.id === configId)
    if (!option) throw new AppError(404, 'config-not-found', '该会话没有这个设置项')
    if (typeof value !== 'string' || !option.options.some(item => item.value === value))
      throw new AppError(400, 'config-value-invalid', '设置值不在可选范围内')
    this.assertUsable(task)
    await this.assertLaunch(task.acp.cwd, confirmedOf(task.acp))
    const mode = this.isModeOption(task, option)
    if (mode) {
      const change = classifyMode(this.profile, this.expectedMode(task) ?? option.currentValue, value)
      if (change === 'forbidden') throw new AppError(400, 'mode-forbidden', '该模式由模型代为批准，Latch 不提供')
      if (change === 'wider' && options.allowWiden !== true) throw new AppError(403, 'stepup-required', '放宽权限模式需要在本机确认')
    }
    if (option.currentValue === value) {
      if (mode && task.acp.expectedMode !== value) {
        task.acp.expectedMode = value
        this.touch(task)
        this.mark()
        this.notify(sessionId)
        await this.flush()
      }
      return
    }
    const run = this.runs.get(sessionId)
    if (run && !run.sent) throw new AppError(409, 'task-running', '会话正在启动，请稍后再修改设置')
    await this.assertWorkspace(task)
    this.enter(this.holds, sessionId)
    try {
      const binding = await this.attach(sessionId)
      const legacy = task.acp.configSource === 'legacy'
      const method = !legacy ? 'session/set_config_option' : option.category === 'model' ? 'session/set_model' : 'session/set_mode'
      const params = !legacy
        ? { sessionId: binding.acpSessionId, configId, value }
        : option.category === 'model'
          ? { sessionId: binding.acpSessionId, modelId: value }
          : { sessionId: binding.acpSessionId, modeId: value }
      const apply = async (change?: ModeChange): Promise<void> => {
        let result: unknown
        try {
          result = await binding.live.connection.request(method, params, this.limits.requestTimeoutMs)
        } catch (error) {
          if (this.state.tasks[sessionId]?.acp.drift) throw permissionDrift()
          if (error instanceof RpcError && error.code === RPC.methodNotFound)
            throw new AppError(501, 'not-supported', `${this.agent.name} 不支持修改该设置`)
          throw this.publicError(error, binding.live)
        }
        const current = this.state.tasks[sessionId]
        if (!current) return
        const parsed = configUpdate.safeParse(result)
        if (!legacy && parsed.success) this.reportConfig(current, parsed.data.configOptions)
        else if (!mode) {
          const target = current.config?.find(item => item.id === configId)
          if (target) target.currentValue = value
        }
        if (mode && !current.acp.drift) current.acp.expectedMode = value
        this.applyModel(current)
        this.touch(current)
        this.mark()
        this.notify(sessionId)
        await this.flush()
        if (current.acp.drift) throw permissionDrift()
        // A legacy agent that has not reported yet is checked again before the next prompt. One that reports a mode
        // wider than the requested one did not take it, and a turn must not go on in the mode the owner moved away from.
        const answered = change?.reported === undefined ? 'neutral' : classifyMode(this.profile, value, change.reported)
        if (answered === 'wider' || answered === 'forbidden') this.unverifiedChange(current, value)
      }
      if (!mode) await apply()
      else await this.changeMode(sessionId, [this.expectedMode(task) ?? this.modeOption(task)?.currentValue, value], apply)
    } finally {
      this.leave(this.holds, sessionId)
      this.scheduleIdle(sessionId)
    }
  }

  // ---- task state -------------------------------------------------------------------------------------------

  private async ready(): Promise<void> {
    await this.start()
    this.assertOpen()
  }

  private assertOpen(): void {
    if (this.closed) throw new AppError(503, 'runtime-closed', '运行节点已关闭')
    if (this.storageFailure) throw new AppError(503, 'storage-unavailable', '持久化失败，运行节点已停止接收新操作。请检查数据存储。')
  }

  private task(id: string): AcpTask {
    const task = Object.hasOwn(this.state.tasks, id) ? this.state.tasks[id] : undefined
    if (!task) throw new AppError(404, 'task-not-found', '找不到该任务')
    return task
  }

  private touch(task: AcpTask): void {
    task.revision++
    task.summary.updatedAt = this.now()
  }

  private openApprovals(taskId: string): Approval[] {
    return [...this.permissions.values()].filter(item => item.taskId === taskId && !item.claimed).map(item => item.approval)
  }

  private notify(sessionId?: string): void {
    for (const listener of this.listeners) {
      try {
        listener(sessionId)
      } catch {
        /* One subscriber cannot block execution or other subscribers. */
      }
    }
  }

  private securityEvent(event: HarnessSecurityEvent): void {
    try {
      this.options.securityEvent?.(event)
    } catch {
      /* The Host audits these; a failure never blocks the session. */
    }
  }

  private enter(counts: Map<string, number>, key: string): void {
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  private leave(counts: Map<string, number>, key: string): void {
    const count = (counts.get(key) ?? 1) - 1
    if (count > 0) counts.set(key, count)
    else counts.delete(key)
  }

  /** Runs one of Latch's own mode changes. Until it settles, the agent may report the mode it leaves or the requested one. */
  private async changeMode(taskId: string, allowed: Array<string | undefined>, work: (change: ModeChange) => Promise<void>): Promise<void> {
    const change: ModeChange = { allowed }
    let open = this.changes.get(taskId)
    if (!open) this.changes.set(taskId, (open = new Set()))
    open.add(change)
    try {
      await work(change)
    } finally {
      open.delete(change)
      if (!open.size && this.changes.get(taskId) === open) this.changes.delete(taskId)
    }
  }

  private async workspace(input: string | undefined): Promise<string> {
    const target = input ?? this.workspaceRoot
    if (typeof target !== 'string' || !isAbsolute(target))
      throw new AppError(400, 'workspace-unavailable', '工作目录必须是 Host 已登记的项目目录')
    const real = await realpath(target).catch(() => undefined)
    const roots = (this.options.workspaces?.() ?? [this.workspaceRoot]).map(root => resolve(root))
    if (real) for (const root of roots) if ((await realpath(root).catch(() => undefined)) === real) return root
    throw new AppError(400, 'workspace-unavailable', '工作目录不是 Host 已登记的项目目录，或目录已不存在')
  }

  private async assertWorkspace(task: AcpTask): Promise<void> {
    if (!(await this.stillListed(task))) throw workspaceChanged()
  }

  /**
   * Whether a session may still work where it started. One that recorded folders needs its project in `projects()`
   * with each of them (same ID and real path, and for the folders the agent receives the real path it was given); a
   * different primary folder now does not matter. One without folders needs its directory among `workspaces()`.
   */
  private async stillListed(task: AcpTask): Promise<boolean> {
    const { workspaceId, folders } = task.summary
    if (folders === undefined)
      return this.workspace(task.acp.cwd).then(
        () => true,
        () => false,
      )
    const project = workspaceId === undefined ? undefined : this.options.projects?.().find(item => item.id === workspaceId)
    if (!project || !folders.length) return false
    const passed = task.acp.folders ?? []
    for (const [index, folder] of folders.entries()) {
      const listed = project.folders.find(item => item.id === folder.id)
      const real = listed && (await realpath(listed.path).catch(() => undefined))
      if (!real || real !== (await realpath(folder.path).catch(() => undefined))) return false
      if (index > 0 && task.acp.folderVia !== undefined && passed[index - 1] !== real) return false
    }
    return true
  }

  /**
   * The project a new session records, for a harness that takes a project's folders. `workspaceId` must name a project
   * in `projects()` whose primary folder is at `cwd`; `folders[0]` must be that folder and every folder one of the
   * project's (same ID and real path). Undefined when the input names no project or the profile takes no folders.
   */
  private async scopeOf(input: { workspaceId?: unknown; folders?: unknown }, cwd: string): Promise<Scope | undefined> {
    const take = this.selection.profile?.folders
    if (!take || (input.workspaceId === undefined && input.folders === undefined)) return undefined
    const requested = input.folders
    if (typeof input.workspaceId !== 'string' || !Array.isArray(requested) || !requested.length || requested.length > 64)
      throw scopeUnavailable()
    const project = this.options.projects?.().find(item => item.id === input.workspaceId)
    const primary = await realpath(cwd).catch(() => undefined)
    if (!project?.folders.length || !primary || (await realpath(project.folders[0]!.path).catch(() => undefined)) !== primary)
      throw scopeUnavailable()
    const folders: ProjectFolder[] = []
    const paths: string[] = []
    for (const [index, folder] of (requested as unknown[]).entries()) {
      const { id, path } = (isObject(folder) ? folder : {}) as { id?: unknown; path?: unknown }
      if (typeof id !== 'string' || typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw scopeUnavailable()
      const listed = project.folders.find(item => item.id === id)
      if (!listed || folders.some(item => item.id === id) || (index === 0 && id !== project.folders[0]!.id)) throw scopeUnavailable()
      const real = await realpath(path).catch(() => undefined)
      if (!real || real !== (await realpath(listed.path).catch(() => undefined))) throw scopeUnavailable()
      if (index === 0) {
        folders.push({ id, path: cwd })
        continue
      }
      // ACP asks clients to leave out the session directory and repeats; folders of one project never are either.
      if (real === primary || paths.includes(real)) throw scopeUnavailable()
      folders.push({ id, path: resolve(listed.path) })
      paths.push(real)
    }
    if (take.via === 'args') {
      if (paths.length > take.maxExtra)
        throw new AppError(
          409,
          'harness-folder-limit',
          `${this.agent.name} 最多使用 ${take.maxExtra + 1} 个文件夹，这个项目有 ${folders.length} 个，会话没有开始`,
        )
      // The harness splits the value on commas, so such a path would name other directories.
      if (paths.some(path => path.includes(',')))
        throw new AppError(400, 'workspace-folder-chars', '文件夹路径不能包含逗号、* 或 ?：部分 Agent 会把它们当作分隔符或通配符。')
    }
    return { workspaceId: project.id, folders, ...(paths.length ? { passed: { via: take.via, paths } } : {}) }
  }

  // ---- permission profile ---------------------------------------------------------------------------------------

  /** The name of whoever reads the profile's project configuration. */
  private harnessName(): string {
    return this.selection.preset?.name ?? this.agent.name
  }

  private projectConfigChanged(): AppError {
    return new AppError(
      409,
      'project-config-changed',
      `项目中的 ${this.harnessName()} 配置在确认后发生了变化，该会话不能继续。请新建会话（需要本机确认）。`,
    )
  }

  /**
   * The configuration the profile names, found from `cwd` and from each folder in `passed` upwards; undefined when the
   * profile names none. With other folders the profile's own folder configuration counts in all of them.
   */
  private async projectConfig(cwd: string, passed?: LaunchFolders): Promise<ProjectConfig | undefined> {
    const profile = this.selection.profile
    const names = new Set(profile?.projectConfigPaths ?? [])
    if (passed && profile?.folders?.via === 'acp') for (const name of profile.folders.configPaths) names.add(name)
    if (!names.size) return undefined
    return fingerprintProjectConfig(passed ? [cwd, ...passed.paths] : cwd, [...names], profile?.projectConfigManaged)
  }

  /** What the confirmation says about the other folders the agent receives. */
  private folderNotes(passed: LaunchFolders | undefined): string[] {
    const take = this.selection.profile?.folders
    if (!passed || !take) return []
    const name = this.agent.name
    const how =
      take.via === 'acp'
        ? `经 ACP 的 additionalDirectories 传给 ${name}；它的当前版本没有声明支持时，会话不会开始`
        : `以 ${take.flag} 参数传给 ${name}，排在定义的参数之后`
    return [`其他 ${passed.paths.length} 个文件夹${how}。文件夹范围由 ${name} 自己执行，不是隔离`]
  }

  /** Why a new session's launch is not the confirmed one: its definition, the folders it passes, or the project configuration. */
  private launchRefusal(expected: string, launch: Launch, passed: LaunchFolders | undefined): AppError {
    const previewed = this.previews.get(expected)
    if (!previewed || previewed.definitionHash !== launch.definitionHash) return definitionChanged()
    return previewed.folders === foldersKey(passed) ? this.projectConfigChanged() : workspaceChanged()
  }

  private foldersUnsupported(starting: boolean): AppError {
    const name = this.agent.name
    return new AppError(
      409,
      'agent-folders-unsupported',
      starting
        ? `${name} 的当前版本没有声明支持多个文件夹，会话没有开始。请更新它，或使用只有一个文件夹的项目。`
        : `${name} 的当前版本没有声明支持多个文件夹，本轮没有发送。请更新它，或在只有一个文件夹的项目中新建会话。`,
    )
  }

  /** Arguments that pass the other folders, after the definition's own. */
  private folderArgs(passed: LaunchFolders | undefined): string[] {
    const take = this.selection.profile?.folders
    if (passed?.via !== 'args' || take?.via !== 'args') return []
    return passed.paths.flatMap(path => [take.flag, path])
  }

  private projectNotes(project: ProjectConfig | undefined, roots: string[]): string[] {
    if (!project?.digest) return []
    const names = project.entries.map(entry => `${displayPath(entry.path, roots)}${entry.unreadable ? '（无法读取）' : ''}`)
    const listed =
      names.length > NOTE_PATHS ? `${names.slice(0, NOTE_PATHS).join('、')} 等 ${names.length} 项` : names.join('、') || '（未列出）'
    const partial = project.truncated ? `（文件过多或层级过深，只比较了前 ${PROJECT_CONFIG_LIMITS.entries} 项）` : ''
    return [`项目中有 ${this.harnessName()} 配置：${listed}。启动指纹包含这些配置的内容${partial}，确认后如有增删或修改，该会话不能继续`]
  }

  /**
   * What a new process would launch now. The resolved path is part of the fingerprint, and so is the digest of
   * `project`; without project configuration both hashes are the definition's.
   */
  private currentLaunch(project?: ProjectConfig, passed?: LaunchFolders): Launch {
    const command = resolveCommand(this.agent.command)
    if (!command)
      throw new AppError(
        503,
        'agent-not-found',
        `未找到命令 ${this.agent.command}。请先安装 ${this.agent.name}，或在设置中填写可执行文件的绝对路径。`,
      )
    const definition = {
      resolvedCommand: command,
      args: this.agent.args,
      definitionEnv: this.agent.env,
      ...(this.selection.profile ? { presetId: this.selection.profile.presetId } : {}),
      profileVersion: 1 as const,
    }
    const definitionHash = launchHash(definition)
    const hash =
      project?.digest || passed
        ? launchHash({
            ...definition,
            ...(project?.digest ? { projectConfig: project.digest } : {}),
            ...(passed ? { folders: passed } : {}),
          })
        : definitionHash
    return { command, hash, definitionHash }
  }

  private assertConfirmed(confirmed: Confirmed): asserts confirmed is Confirmed & { launchHash: string } {
    if (!confirmed.launchHash)
      throw new AppError(409, 'l3-confirmation-missing', '此会话创建于安全升级之前，不能继续。请新建会话（需要本机确认）。')
  }

  /** The launch of a session in `cwd` with the folders it passes, unless it is no longer the one the owner confirmed. */
  private async assertLaunch(cwd: string, confirmed: Confirmed): Promise<Launch> {
    this.assertConfirmed(confirmed)
    const launch = this.currentLaunch(await this.projectConfig(cwd, confirmed.folders), confirmed.folders)
    if (launch.hash === confirmed.launchHash) return launch
    // A session confirmed before project configuration counted stored only the definition's fingerprint.
    throw launch.definitionHash === (confirmed.definitionHash ?? confirmed.launchHash) ? this.projectConfigChanged() : definitionChanged()
  }

  /**
   * Input to an existing session: refused after drift, without a confirmed launch, or once the definition changed.
   * The project configuration takes file system reads, so callers check it with `assertLaunch`.
   */
  private assertUsable(task: AcpTask): void {
    if (task.acp.drift) throw permissionDrift()
    this.assertConfirmed(confirmedOf(task.acp))
    if (this.currentLaunch().definitionHash !== (task.acp.definitionHash ?? task.acp.launchHash)) throw definitionChanged()
  }

  private expectedMode(task: AcpTask): string | undefined {
    return task.acp.expectedMode ?? this.profile?.expectedMode
  }

  private isModeOption(task: AcpTask, option: SessionConfigOption): boolean {
    return option.category === 'mode' || (task.acp.configSource === 'legacy' && option.id === 'mode')
  }

  private modeOption(task: AcpTask): SessionConfigOption | undefined {
    return task.config?.find(item => this.isModeOption(task, item))
  }

  private permissionView(task: AcpTask): SessionPermission {
    const expected = this.expectedMode(task)
    return {
      level: 'L3',
      enforcer: 'NONE',
      readback: this.profile?.readback === 'mode' || task.acp.expectedMode !== undefined ? 'mode' : 'none',
      verifiedDefinition: this.selection.verified,
      approvals: this.profile?.approvals ?? 'prompts',
      ...(expected !== undefined ? { expectedMode: expected } : {}),
      ...(task.acp.drift ? { drift: task.acp.drift } : {}),
      notes: this.permissionNotes(),
    }
  }

  private permissionNotes(): string[] {
    return [...(this.profile?.notes ?? []), ...(this.selection.notes ?? [])]
  }

  /**
   * The session's reported mode must equal the expected one before a prompt. A mismatch, or a mode recorded before
   * the process was restarted, is set once and read back from the response or the agent's notifications; anything
   * short of a confirmed match refuses the turn.
   */
  private async verifyMode(taskId: string, binding: Binding, signal: AbortSignal): Promise<void> {
    const task = this.task(taskId)
    const expected = this.expectedMode(task)
    if (expected === undefined) return
    const option = this.modeOption(task)
    if (option && (option.currentValue !== expected || this.unconfirmed.has(taskId))) {
      try {
        await this.applyMode(taskId, binding, option, expected, signal)
      } catch (error) {
        if (signal.aborted) throw signal.reason
        if (error instanceof ConnectionClosed || error instanceof ConnectionStopping) throw error
        // Any other failure leaves the mode unconfirmed, which refuses the turn below.
      }
    }
    const current = this.state.tasks[taskId]
    if (current?.acp.drift) throw permissionDrift()
    if (current && !this.unconfirmed.has(taskId) && this.modeOption(current)?.currentValue === expected) return
    this.securityEvent({ type: 'permission-unverified', sessionId: taskId })
    throw new AppError(409, 'permission-unverified', `无法确认 ${this.agent.name} 已进入预期的权限模式，未发送本轮输入。`)
  }

  private async applyMode(
    taskId: string,
    binding: Binding,
    option: SessionConfigOption,
    value: string,
    signal: AbortSignal,
  ): Promise<void> {
    const legacy = this.task(taskId).acp.configSource === 'legacy'
    await this.changeMode(taskId, [value, option.currentValue], async () => {
      const result = await binding.live.connection.request(
        legacy ? 'session/set_mode' : 'session/set_config_option',
        legacy ? { sessionId: binding.acpSessionId, modeId: value } : { sessionId: binding.acpSessionId, configId: option.id, value },
        this.limits.requestTimeoutMs,
        signal,
      )
      const task = this.state.tasks[taskId]
      if (!task) return
      // An empty set_mode response confirms nothing; a legacy agent reports the change with current_mode_update.
      const parsed = configUpdate.safeParse(result)
      if (!legacy && parsed.success) this.reportConfig(task, parsed.data.configOptions)
      this.touch(task)
      this.mark()
      this.notify(taskId)
    })
  }

  /**
   * A mode the agent reported. Wider or forbidden than the expected one, or while Latch changes the mode wider than
   * both the mode left and the one requested, ends the session's input for good.
   */
  private observeMode(task: AcpTask, before: string | undefined, value: string): void {
    const taskId = task.summary.id
    const changes = this.changes.get(taskId)
    for (const change of changes ?? []) change.reported = value
    if (value === before || task.acp.drift || this.quiet.has(taskId)) return
    const expected = this.expectedMode(task) ?? before
    const allowed = changes?.size ? [...changes].flatMap(change => change.allowed) : [expected]
    // A stricter mode is kept until the next prompt sets the expected one again.
    if (allowed.some(mode => ['neutral', 'stricter'].includes(classifyMode(this.profile, mode, value)))) return
    this.drift(task, expected, value)
  }

  /** The agent's full option list, from a notification or a set response; its mode is checked like any report. */
  private reportConfig(task: AcpTask, items: unknown[]): void {
    const prior = this.modeOption(task)
    task.config = configFromOptions(items)
    task.acp.configSource = 'options'
    // ACP makes the category optional, so an option once known as the mode keeps that role under its id.
    if (prior && !this.modeOption(task)) {
      const same = task.config.find(item => item.id === prior.id)
      if (same) same.category = 'mode'
    }
    this.applyModel(task)
    const after = this.modeOption(task)?.currentValue
    if (after !== undefined) {
      this.unconfirmed.delete(task.summary.id)
      this.observeMode(task, prior?.currentValue, after)
    } else if (prior) {
      // A mode the agent stops reporting could be any mode.
      this.observeMode(task, prior.currentValue, UNREPORTED_MODE)
    }
  }

  /** The agent answered a mode change without taking it: a sent turn is cancelled, and input waits for a confirmed mode. */
  private unverifiedChange(task: AcpTask, value: string): never {
    const taskId = task.summary.id
    const run = this.runs.get(taskId)
    if (run?.sent) {
      run.notes.push(`无法确认 ${this.agent.name} 已切换到 ${clip(value, 64)} 模式，已取消本轮。`)
      this.requestCancel(run, true)
    }
    this.securityEvent({ type: 'permission-unverified', sessionId: taskId })
    throw new AppError(409, 'permission-unverified', `无法确认 ${this.agent.name} 已切换到所选的权限模式。`)
  }

  private drift(task: AcpTask, expected: string | undefined, observed: string): void {
    const taskId = task.summary.id
    task.acp.drift = { at: this.now(), observed: clip(observed, 64) }
    task.summary.permissionDrift = true
    // Rejected before the cancel, which would answer them as cancelled.
    for (const permission of [...this.permissions.values()]) {
      if (permission.taskId === taskId) this.closePermission(permission, this.rejection(permission.visible), this.unanswered())
    }
    const note = `检测到权限模式变化（${clip(expected ?? '未知', 64)} → ${clip(observed, 64)}），已取消本轮并拒绝挂起的询问。该会话不再接受输入，请新建会话。`
    const run = this.runs.get(taskId)
    if (run) {
      run.notes.push(note)
      this.requestCancel(run, true)
    } else task.messages.push({ id: randomUUID(), role: 'system', text: note, state: 'failed' })
    this.touch(task)
    this.mark()
    this.notify(taskId)
    this.securityEvent({ type: 'permission-drift', sessionId: taskId, observedHash: sha256Hex(observed) })
    // The session takes no more input, so its process has nothing left to do once the turn settles.
    const live = this.lives.get(taskId)
    if (live) {
      void (run?.done ?? Promise.resolve()).then(() => {
        if (this.lives.get(taskId) === live) void live.connection.stop('stop', this.limits.stopGraceMs)
      })
    }
  }

  /** The record of an ask that Latch closed for nobody (the turn stopped, the process ended): never a person's rejection. */
  private unanswered(): ToolDecision {
    return { outcome: 'cancelled', at: this.now() }
  }

  private rejection(visible: PermissionOption[]): unknown {
    const option = visible.find(item => item.kind === 'reject_once')
    return option ? selected(option.optionId) : CANCELLED_OUTCOME
  }

  /** Never upgrades a plain allow or reject to a choice that stores a rule inside the agent. */
  private chooseOption(permission: Permission, decision: 'allow' | 'reject', optionId: string | undefined): PermissionOption | undefined {
    if (optionId !== undefined) {
      const option = permission.options.find(item => item.optionId === optionId)
      if (!option) throw new AppError(400, 'approval-option-invalid', '该审批选项不存在')
      if (!isVisibleOption(this.profile, option)) throw new AppError(400, 'approval-option-hidden', '该选项会持久保存授权，Latch 不提供')
      if (!option.kind.startsWith(decision)) throw new AppError(400, 'approval-option-mismatch', '审批选项与决定不一致')
      return option
    }
    const option = permission.visible.find(item => item.kind === `${decision}_once`)
    if (option) return option
    // Rejecting always works: without a one-time reject the request is answered as cancelled.
    if (decision === 'reject') return undefined
    throw new AppError(400, 'approval-option-required', '请选择具体的审批选项')
  }

  // ---- persistence: memory is authoritative, snapshots are written in order and coalesced -------------------

  private mark(): void {
    this.version++
    this.pump()
  }

  /** Resolves once every change made so far is durable. */
  private flush(): Promise<void> {
    if (this.storageFailure)
      return Promise.reject(new AppError(503, 'storage-unavailable', '持久化失败，运行节点已停止接收新操作。请检查数据存储。'))
    if (this.durable >= this.version) return Promise.resolve()
    return new Promise((resolve, reject) => {
      this.waiters.push({ version: this.version, resolve, reject })
      this.pump()
    })
  }

  private pump(): void {
    if (this.writing || this.storageFailure || !this.loaded || this.durable >= this.version) return
    this.writing = (async () => {
      while (this.durable < this.version) {
        const version = this.version
        await this.store.write(`${JSON.stringify(this.state)}\n`)
        this.durable = version
        const ready = this.waiters.filter(waiter => waiter.version <= version)
        this.waiters = this.waiters.filter(waiter => waiter.version > version)
        for (const waiter of ready) waiter.resolve()
      }
    })()
      .catch(error => {
        this.storageFailure = error
        for (const waiter of this.waiters.splice(0))
          waiter.reject(new AppError(503, 'storage-unavailable', '持久化失败，运行节点已停止接收新操作。请检查数据存储。'))
        for (const run of this.runs.values()) this.requestCancel(run, true)
      })
      .finally(() => {
        this.writing = undefined
      })
  }

  // ---- turns --------------------------------------------------------------------------------------------------

  private reserve(taskId: string, seq: number, prompt: string): Run {
    let resolveDone!: () => void
    const done = new Promise<void>(resolve => {
      resolveDone = resolve
    })
    const clock = new RunClock(this.clock)
    // Until session/prompt is written the agent's process and session are being prepared.
    const run: Run = {
      id: randomUUID(),
      taskId,
      seq,
      prompt,
      sent: false,
      cancelRequested: false,
      activity: { phase: 'starting', since: isoTime(clock.startedAt) },
      clock,
      notes: [],
      done,
      resolveDone,
    }
    this.runs.set(taskId, run)
    return run
  }

  private release(run: Run): void {
    clearTimeout(run.graceTimer)
    if (this.runs.get(run.taskId) === run) this.runs.delete(run.taskId)
    run.resolveDone()
    this.scheduleIdle(run.taskId)
  }

  private begin(run: Run): void {
    void this.drive(run)
  }

  private async drive(run: Run): Promise<void> {
    let status: TaskStatus = 'idle'
    const notes: string[] = []
    try {
      if (run.cancelRequested) {
        status = 'cancelled'
        return
      }
      // Binding also confirms the permission mode, right before the prompt is written.
      const binding = await this.attach(run.taskId)
      if (run.cancelRequested) {
        status = 'cancelled'
        return
      }
      run.live = binding.live
      run.acpSessionId = binding.acpSessionId
      this.holdIdle(binding.live)
      run.sent = true
      this.phase(run, 'model')
      this.notify(run.taskId)
      const result = await binding.live.connection.request('session/prompt', {
        sessionId: binding.acpSessionId,
        prompt: [{ type: 'text', text: run.prompt }],
      })
      status = this.outcome(run, result, notes)
    } catch (error) {
      status = this.failure(run, error, notes)
    } finally {
      this.finishTurn(run, status, [...run.notes, ...notes])
    }
  }

  private outcome(run: Run, result: unknown, notes: string[]): TaskStatus {
    const parsed = promptResult.safeParse(result)
    const task = this.state.tasks[run.taskId]
    if (parsed.success && parsed.data.usage && task) {
      // Agents disagree on whether this is per turn or per session, so it replaces rather than adds.
      task.summary.usage = { inputTokens: parsed.data.usage.inputTokens, outputTokens: parsed.data.usage.outputTokens }
    }
    const stopReason = parsed.success ? parsed.data.stopReason : undefined
    if (run.cancelRequested) {
      if (stopReason !== 'cancelled')
        notes.push(`已请求取消；${this.agent.name} 以 ${clip(this.redact(stopReason ?? '无效响应'), 64)} 结束本轮，已按取消处理。`)
      return 'cancelled'
    }
    switch (stopReason) {
      case 'end_turn':
        return 'idle'
      case 'cancelled':
        return 'cancelled'
      case 'max_tokens':
        notes.push('模型输出达到长度上限，回复可能不完整。')
        return 'failed'
      case 'max_turn_requests':
        notes.push(`已达到 ${this.agent.name} 的单轮请求上限，本轮提前结束。`)
        return 'failed'
      case 'refusal':
        notes.push('模型拒绝继续处理本轮请求。')
        return 'failed'
      case undefined:
        notes.push(`${this.agent.name} 返回了无效的本轮结束响应。`)
        return 'failed'
      default:
        notes.push(`${this.agent.name} 以未知原因 ${clip(this.redact(stopReason), 64)} 结束本轮。`)
        return 'failed'
    }
  }

  private failure(run: Run, error: unknown, notes: string[]): TaskStatus {
    if (error instanceof ConnectionClosed) {
      notes.push(this.exitNote(run, error.info))
      return run.sent ? 'interrupted' : 'failed'
    }
    if (run.cancelRequested) {
      // Before session/prompt nothing ran, so how the abandoned setup ended is not worth reporting.
      if (!run.sent) {
        if (this.closed) notes.push(`Latch 关闭时本轮尚未发送给 ${this.agent.name}，已取消。`)
        return 'cancelled'
      }
      if (!(error instanceof RpcError && error.code === RPC.cancelled))
        notes.push(`取消时 ${this.agent.name} 返回错误：${clip(this.redact(message(error)), 1000)}`)
      return 'cancelled'
    }
    if (error instanceof ConnectionStopping) {
      notes.push(`${this.agent.name} 进程正在停止，本轮输入未发送。请重试。`)
      return 'failed'
    }
    if (error instanceof RpcError) {
      if (error.code === RPC.cancelled) return 'cancelled'
      if (error.code === RPC.authRequired) {
        notes.push(this.authMessage(run.live))
        return 'failed'
      }
      if (error.code === RPC.notFound) {
        if (run.live && run.acpSessionId) run.live.sessions.delete(run.acpSessionId)
        notes.push(`${this.agent.name} 找不到这个会话，请新建会话。`)
        return 'failed'
      }
      notes.push(`${this.agent.name} 返回错误：${clip(this.redact(error.message), 1000)}`)
      return 'failed'
    }
    notes.push(error instanceof AppError ? error.message : `${this.agent.name} 运行失败：${clip(this.redact(message(error)), 1000)}`)
    return 'failed'
  }

  private exitNote(run: Run, info: ExitInfo): string {
    const name = this.agent.name
    if (info.reason === 'kill') {
      if (info.cause === run.taskId)
        return `取消未在 ${Math.ceil(this.limits.cancelGraceMs / 1000)} 秒内完成，已强制结束 ${name} 进程；本轮已中断。请核对工具副作用。`
      return `${name} 进程已被强制结束；本轮已中断。请核对工具副作用。`
    }
    if (info.reason === 'stop') return `${name} 进程已随 Latch 关闭而结束；本轮已中断。请核对工具副作用。`
    if (info.reason === 'overflow') return `${name} 输出了超过限制的单行消息，进程已被结束；本轮已中断。请核对工具副作用。`
    return `${name} 进程意外退出（${describeExit(info)}）；本轮已中断。正在执行的工具结果未知，请核对实际副作用。${info.stderr ? '错误输出已记入 Host 日志。' : ''}`
  }

  private finishTurn(run: Run, status: TaskStatus, notes: string[]): void {
    clearTimeout(run.graceTimer)
    for (const permission of [...this.permissions.values()]) {
      if (permission.taskId === run.taskId) this.closePermission(permission, CANCELLED_OUTCOME, this.unanswered())
    }
    const task = this.state.tasks[run.taskId]
    if (task) {
      const at = this.now()
      if (run.segment) this.settleSegment(run, task, status === 'idle' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed')
      const tools = this.tools.get(run.taskId)
      if (tools?.seq === run.seq) {
        for (const state of tools.calls.values()) if (settleTool(state, at)) this.upsert(task, toolMessage(state))
      }
      task.summary.status = status
      for (const note of notes) {
        task.messages.push({
          id: randomUUID(),
          role: 'system',
          text: note,
          ...(status === 'failed' || status === 'interrupted' ? { state: 'failed' as const } : {}),
          createdAt: at,
        })
      }
      const prompt = run.userMessageId === undefined ? undefined : task.messages.find(item => item.id === run.userMessageId)
      if (prompt) prompt.turn = run.clock.turn()
      this.touch(task)
      this.mark()
    }
    if (this.runs.get(run.taskId) === run) this.runs.delete(run.taskId)
    this.notify(run.taskId)
    this.scheduleIdle(run.taskId)
    void this.flush()
      .catch(() => {})
      .finally(() => run.resolveDone())
  }

  private requestCancel(run: Run, withGrace: boolean): void {
    if (!run.cancelRequested) {
      run.cancelRequested = true
      this.phase(run, 'cancelling', run.activity.toolName)
      if (run.sent && run.live && run.acpSessionId) run.live.connection.notify('session/cancel', { sessionId: run.acpSessionId })
      // Nothing reached the agent yet: withdraw the session setup instead of waiting for it.
      else if (!run.sent)
        this.attaching
          .get(run.taskId)
          ?.controller.abort(this.closed ? new AppError(503, 'runtime-closed', '运行节点已关闭') : cancelledBeforeSend())
      for (const permission of [...this.permissions.values()]) {
        if (permission.taskId === run.taskId) this.closePermission(permission, CANCELLED_OUTCOME, this.unanswered())
      }
      this.notify(run.taskId)
    }
    // Only a sent turn can keep the process busy; a turn cancelled earlier never sends its prompt.
    if (withGrace && run.sent && !run.graceTimer) {
      run.graceTimer = setTimeout(() => this.forceStop(run), this.limits.cancelGraceMs)
      run.graceTimer.unref()
    }
  }

  /** The only way to settle a turn the agent will not end. The process serves only this session. */
  private forceStop(run: Run): void {
    if (this.runs.get(run.taskId) !== run || !run.live) return
    void run.live.connection.stop('kill', this.limits.stopGraceMs, run.taskId)
  }

  // ---- process and session lifecycle ----------------------------------------------------------------------------

  private tmpRoot(): string {
    return this.options.tmpRoot ?? join(this.options.dataDir, 'tmp')
  }

  private tmpDirFor(key: string): string {
    return join(this.tmpRoot(), sha256Hex(key).slice(0, 16))
  }

  /** The session's own TMPDIR: created 0700, and refused when it is a link or someone else's. */
  private async prepareTmpDir(key: string): Promise<string> {
    await mkdir(this.tmpRoot(), { recursive: true, mode: 0o700 })
    const directory = this.tmpDirFor(key)
    await mkdir(directory, { mode: 0o700 }).catch(error => {
      if (codeOf(error) !== 'EEXIST') throw error
    })
    const info = await lstat(directory)
    const uid = process.getuid?.()
    const insecure =
      !info.isDirectory() || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || (uid !== undefined && info.uid !== uid)))
    if (insecure) throw new AppError(503, 'agent-start-failed', `${this.agent.name} 启动失败：会话临时目录的属主或权限不安全`)
    return directory
  }

  private async stopAll(): Promise<void> {
    await Promise.all([...this.lives.values()].map(live => live.connection.stop('stop', this.limits.stopGraceMs)))
  }

  private async ensureProcess(key: string, cwd: string, confirmed: Confirmed): Promise<Live> {
    for (;;) {
      const pending = this.spawning.get(key)
      if (pending) return pending
      const live = this.lives.get(key)
      if (live?.initialized && !live.connection.stopping) return live
      // A process being stopped would drop new requests; start its successor only once it is gone.
      if (live) {
        await live.connection.exited
        continue
      }
      const spawn = this.spawnProcess(key, cwd, confirmed).finally(() => {
        if (this.spawning.get(key) === spawn) this.spawning.delete(key)
      })
      this.spawning.set(key, spawn)
      return spawn
    }
  }

  /** Stops the least recently used idle process whose session can be restored, when the limit is reached. */
  private makeRoom(): void {
    const running = [...this.lives.values()].filter(live => !live.connection.stopping)
    if (running.length < this.limits.maxProcesses) return
    const victim = running
      .filter(live => live.initialized && (live.capabilities.resume || live.capabilities.load) && !this.busy(live.key))
      .sort((a, b) => a.lastUsed - b.lastUsed)[0]
    if (!victim) throw new AppError(503, 'agent-busy', `同时运行的 ${this.agent.name} 会话过多，请先结束一些会话`)
    this.holdIdle(victim)
    void victim.connection.stop('stop', this.limits.stopGraceMs)
  }

  private async spawnProcess(key: string, cwd: string, confirmed: Confirmed): Promise<Live> {
    const name = this.agent.name
    const paused = this.health.pausedUntil()
    if (paused) throw new AppError(503, 'agent-paused', `${name} 在一分钟内连续崩溃 3 次，已暂停自动重启。请检查安装与登录状态，稍后再试。`)
    // Every start reads the project configuration again: the agent loads it now, not when the session was confirmed.
    await this.assertLaunch(cwd, confirmed)
    const wait = this.health.restartDelay(this.limits.restartDelayMs)
    if (wait) await sleep(wait, undefined, { signal: this.lifetime.signal, ref: false }).catch(() => {})
    this.assertOpen()
    const sessionTmpDir = await this.prepareTmpDir(key)
    const materializedEnv = await this.selection.profile?.materialize?.({ dataDir: this.options.dataDir })
    this.assertOpen()
    // Checked again after the awaits: the command found on PATH or the project configuration may have changed meanwhile.
    const { command } = await this.assertLaunch(cwd, confirmed)
    this.assertOpen()
    this.makeRoom()
    let live!: Live
    let connection: AgentConnection
    try {
      connection = AgentConnection.spawn(
        {
          command,
          args: [...this.agent.args, ...this.folderArgs(confirmed.folders)],
          cwd,
          env: agentEnvironment({
            resolvedCommand: command,
            profile: this.profile,
            materializedEnv,
            definitionEnv: this.agent.env,
            sessionTmpDir,
          }),
          maxLineBytes: this.limits.maxLineBytes,
          redact: this.redact,
        },
        {
          request: (method, params, id) => this.onRequest(live, method, params, id),
          notification: (method, params) => this.onNotification(live, method, params),
          exit: info => this.onExit(live, info),
        },
      )
    } catch (error) {
      const detail = clip(this.redact(message(error)), 1000)
      this.health.lastError = `无法启动：${clip(detail, 300)}`
      throw new AppError(503, 'agent-start-failed', `${name} 启动失败：${detail}`)
    }
    live = {
      key,
      connection,
      initialized: false,
      capabilities: { resume: false, load: false, delete: false, additionalDirectories: false },
      authMethods: [],
      sessions: new Map(),
      lastUsed: Date.now(),
    }
    this.lives.set(key, live)
    try {
      const result = initializeResult.safeParse(
        await connection.request(
          'initialize',
          {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo: { name: 'latch', title: 'Latch', version: CLIENT_VERSION },
          },
          this.limits.requestTimeoutMs,
        ),
      )
      if (!result.success) throw new Error('initialize 响应无效')
      if (result.data.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`Harness 使用 ACP 协议版本 ${result.data.protocolVersion}，Latch 仅支持版本 ${PROTOCOL_VERSION}`)
      }
      const reported = result.data.agentInfo?.version ?? undefined
      const rule = this.profile?.versionRule
      if (rule && (typeof reported !== 'string' || !new RegExp(rule.pattern).test(reported))) {
        throw new AppError(
          409,
          'harness-version-unsupported',
          `${name} 版本 ${clip(this.redact(reported ?? '未知'), 64)} 未经验证（${rule.message}），已拒绝启动。`,
        )
      }
      const capabilities = result.data.agentCapabilities
      live.capabilities = {
        resume: capabilities?.sessionCapabilities?.resume != null,
        load: capabilities?.loadSession === true,
        delete: capabilities?.sessionCapabilities?.delete != null,
        additionalDirectories: isObject(capabilities?.sessionCapabilities?.additionalDirectories),
      }
      live.authMethods = (result.data.authMethods ?? []).slice(0, 16).map(method => ({
        name: clip(this.redact(method.name), 200),
        ...(method.description ? { description: clip(this.redact(method.description), 500) } : {}),
      }))
      if (reported) live.agentVersion = clip(reported, 100)
      live.initialized = true
      this.health.lastError = undefined
      return live
    } catch (error) {
      const info = error instanceof ConnectionClosed ? error.info : await connection.stop('kill', this.limits.stopGraceMs)
      if (error instanceof AppError) {
        this.health.lastError = clip(error.message, 300)
        throw error
      }
      const exited = error instanceof ConnectionClosed || error instanceof ConnectionStopping ? info : undefined
      if (this.closed) throw new AppError(503, 'runtime-closed', '运行节点已关闭')
      // The agent's own error text can echo configured secrets; its stderr goes only to the Host log.
      const detail = clip(
        this.redact(
          exited
            ? exited.reason === 'spawn'
              ? `无法启动（${exited.error}）`
              : `进程退出（${describeExit(exited)}）`
            : error instanceof RequestTimeout
              ? '初始化超时'
              : message(error),
        ),
        1000,
      )
      this.health.lastError = clip(detail, 300)
      throw new AppError(503, 'agent-start-failed', `${name} 启动失败：${detail}${info.stderr ? '。错误输出已记入 Host 日志。' : ''}`)
    }
  }

  private onExit(live: Live, info: ExitInfo): void {
    if (this.lives.get(live.key) === live) this.lives.delete(live.key)
    clearTimeout(live.idleTimer)
    live.sessions.clear()
    for (const permission of [...this.permissions.values()]) {
      if (permission.live === live) this.closePermission(permission, CANCELLED_OUTCOME, this.unanswered())
    }
    const unexpected = !info.reason || info.reason === 'overflow'
    if (unexpected) {
      this.health.crashed()
      if (live.initialized) this.health.lastError = `进程意外退出（${describeExit(info)}）`
    }
    this.notify()
    if (info.stderr && (unexpected || !live.initialized)) {
      try {
        this.limits.log(`Harness ${this.agent.id} 进程结束（${describeExit(info)}），stderr 末尾（已脱敏）：\n${info.stderr}`)
      } catch {
        /* Diagnostics never block cleanup. */
      }
    }
  }

  /** Binds the task's ACP session on its process (new, resumed or loaded) and confirms its mode. Concurrent calls share one attempt. */
  private attach(taskId: string): Promise<Binding> {
    const existing = this.attaching.get(taskId)
    if (existing) return existing.promise
    const controller = new AbortController()
    const promise = this.bind(taskId, controller.signal).finally(() => {
      this.attaching.delete(taskId)
      this.scheduleIdle(taskId)
    })
    this.attaching.set(taskId, { promise, controller })
    return promise
  }

  private async bind(taskId: string, signal: AbortSignal): Promise<Binding> {
    const task = this.task(taskId)
    const { cwd } = task.acp
    const running = this.lives.get(taskId)
    if (running) this.holdIdle(running)
    let live: Live | undefined
    let quiet = false
    try {
      // A session's folders are checked before every start, resume or load of its agent: they change what it receives.
      if (task.summary.folders !== undefined) await this.assertWorkspace(task)
      live = await abortable(this.ensureProcess(taskId, cwd, confirmedOf(task.acp)), signal)
      this.holdIdle(live)
      const current = this.task(taskId).acp.acpSessionId
      // Mode reports while a session is set up and first checked are its starting point, not drift. A bound session
      // may be mid-turn, where only the modes of Latch's own changes are expected.
      if (!current || live.sessions.get(current) !== taskId) {
        this.enter(this.quiet, taskId)
        quiet = true
      }
      const binding = await this.session(taskId, live, signal)
      await this.verifyMode(taskId, binding, signal)
      return binding
    } catch (error) {
      if (signal.aborted) throw signal.reason
      throw this.publicError(error, live)
    } finally {
      if (quiet) this.leave(this.quiet, taskId)
    }
  }

  private async session(taskId: string, live: Live, signal: AbortSignal): Promise<Binding> {
    const connection = live.connection
    const setup = (method: string, params: unknown): Promise<unknown> =>
      connection.request(method, params, this.limits.requestTimeoutMs, signal)
    const task = this.task(taskId)
    const cwd = task.acp.cwd
    const current = task.acp.acpSessionId
    if (current && live.sessions.get(current) === taskId) return { live, acpSessionId: current }
    // ACP wants the whole list again for every new, resumed or loaded session: omitting it would drop the folders.
    const passed = storedFolders(task.acp)
    const directories = passed?.via === 'acp' ? { additionalDirectories: [...passed.paths] } : {}
    if (passed?.via === 'acp' && !live.capabilities.additionalDirectories) {
      void live.connection.stop('stop', this.limits.stopGraceMs)
      throw this.foldersUnsupported(false)
    }
    let acpSessionId: string
    let result: unknown
    if (!current) {
      result = await setup('session/new', { cwd, mcpServers: [], ...directories })
      const id = sessionState.safeParse(result)
      if (!id.success || !id.data.sessionId) throw new AppError(502, 'agent-protocol', `${this.agent.name} 未返回有效的会话标识`)
      acpSessionId = id.data.sessionId
    } else if (live.capabilities.resume) {
      result = await setup('session/resume', { sessionId: current, cwd, mcpServers: [], ...directories })
      acpSessionId = current
    } else if (live.capabilities.load) {
      // The replay arrives before the response while the session is still unbound, so it is discarded.
      result = await setup('session/load', { sessionId: current, cwd, mcpServers: [], ...directories })
      acpSessionId = current
    } else {
      throw new AppError(409, 'harness-session-lost', '该 Harness 不支持恢复会话，请新建会话')
    }
    const target = this.state.tasks[taskId]
    if (!target) throw new AppError(404, 'task-not-found', '找不到该任务')
    live.sessions.set(acpSessionId, taskId)
    target.acp.acpSessionId = acpSessionId
    target.acp.deletable = live.capabilities.delete
    if (live.agentVersion) target.acp.agentVersion = live.agentVersion
    const parsed = sessionState.safeParse(result)
    const folded = parsed.success ? foldConfig(parsed.data) : undefined
    if (folded) {
      target.config = folded.options
      target.acp.configSource = folded.source
      this.applyModel(target)
    }
    // A restored session can come back in another mode than the previous process last reported, so the recorded
    // mode is no evidence; unless this response reports one, the mode is set and read back before the next prompt.
    if (folded?.options.some(item => this.isModeOption(target, item))) this.unconfirmed.delete(taskId)
    else if (current) this.unconfirmed.add(taskId)
    this.touch(target)
    this.mark()
    this.notify(taskId)
    if (!current) {
      // A prompt follows at once. Were the Host to crash before this is durable, the task could not find the agent
      // session that received it, and the next prompt would quietly start a fresh one.
      await this.flush()
      if (connection.stopping || live.sessions.get(acpSessionId) !== taskId)
        throw new AppError(503, 'agent-exited', `${this.agent.name} 进程已退出，请重试`)
    }
    return { live, acpSessionId }
  }

  private publicError(error: unknown, live: Live | undefined): AppError {
    const name = this.agent.name
    if (error instanceof AppError) return error
    if (error instanceof ConnectionClosed)
      return new AppError(503, 'agent-exited', `${name} 进程已退出（${this.redact(describeExit(error.info))}）。`)
    if (error instanceof ConnectionStopping) return new AppError(503, 'agent-exited', `${name} 进程正在停止，请稍后重试。`)
    if (error instanceof RequestTimeout) return new AppError(504, 'agent-timeout', `${name} 长时间没有响应，请稍后重试`)
    if (error instanceof RpcError) {
      if (error.code === RPC.authRequired) return new AppError(409, 'agent-auth-required', this.authMessage(live))
      if (error.code === RPC.notFound) return new AppError(409, 'harness-session-lost', '该 Harness 已找不到这个会话，请新建会话')
      return new AppError(502, 'agent-error', `${name} 返回错误：${clip(this.redact(error.message), 1000)}`)
    }
    return new AppError(500, 'agent-error', `${name} 运行失败：${clip(this.redact(message(error)), 1000)}`)
  }

  private authMessage(live: Live | undefined): string {
    const methods = live?.authMethods ?? []
    const lines = methods.map(method => `- ${method.name}${method.description ? `：${method.description}` : ''}`)
    return `${this.agent.name} 需要登录。请在运行 Latch 的电脑上完成该 Harness 的登录后重试。${lines.length ? `\n\n可用的登录方式：\n${lines.join('\n')}` : ''}`
  }

  private holdIdle(live: Live): void {
    clearTimeout(live.idleTimer)
    live.idleTimer = undefined
    live.lastUsed = Date.now()
  }

  /** Stops a task's idle process only when its session can be restored later. */
  private scheduleIdle(key: string): void {
    const live = this.lives.get(key)
    if (!live?.initialized || live.connection.stopping || this.closed) return
    this.holdIdle(live)
    if (!live.capabilities.resume && !live.capabilities.load) return
    if (this.busy(key)) return
    live.idleTimer = setTimeout(() => {
      live.idleTimer = undefined
      // stop() marks the connection as stopping at once, so ensureProcess hands no new work to it.
      if (this.lives.get(key) === live && !this.busy(key)) void live.connection.stop('stop', this.limits.stopGraceMs)
    }, this.limits.idleMs)
    live.idleTimer.unref()
  }

  private busy(key: string): boolean {
    return this.runs.has(key) || this.attaching.has(key) || this.forgetting.has(key) || this.spawning.has(key) || this.holds.has(key)
  }

  /**
   * Cleans up after a removed task in the background: asks the agent to delete its session when it offers that,
   * starting a process only for the launch the owner confirmed and only in a project the Host still lists, then stops
   * the process and removes its TMPDIR. Otherwise, or after a failure, only the agent's own copy is left behind.
   */
  private forget(
    key: string,
    acpSessionId: string | undefined,
    cwd: string,
    deletable: boolean,
    confirmed: Confirmed,
    listed: () => Promise<boolean>,
  ): void {
    const work: Promise<void> = (async () => {
      try {
        await this.spawning.get(key)?.catch(() => undefined)
        let live = this.lives.get(key)
        if (live && (!live.initialized || live.connection.stopping)) {
          await live.connection.exited
          live = undefined
        }
        if (!acpSessionId) return
        live?.sessions.delete(acpSessionId)
        if (
          live
            ? !live.capabilities.delete
            : !deletable
              || !(await this.assertLaunch(cwd, confirmed).then(
                () => true,
                () => false,
              ))
        )
          return
        // Agents can run code from their working directory, and the other folders they receive, at start-up; a project
        // the owner removed, or one that lost a session's folder, gets none.
        if (!live && !(await listed())) {
          this.limits.log(
            `已删除 ${this.agent.name} 会话在 Latch 中的记录。该会话使用的文件夹已不在 Host 的项目列表中，未启动 ${this.agent.name} 删除它自己保存的会话副本。`,
          )
          return
        }
        const target = live ?? (await this.ensureProcess(key, cwd, confirmed))
        target.sessions.delete(acpSessionId)
        if (!target.capabilities.delete) return
        this.holdIdle(target)
        await target.connection.request('session/delete', { sessionId: acpSessionId }, Math.min(this.limits.requestTimeoutMs, 10_000))
      } catch {
        /* Best effort. */
      } finally {
        const live = this.lives.get(key)
        if (live) await live.connection.stop('stop', this.limits.stopGraceMs).catch(() => {})
        await rm(this.tmpDirFor(key), { recursive: true, force: true }).catch(() => {})
      }
    })().finally(() => {
      if (this.forgetting.get(key) === work) this.forgetting.delete(key)
    })
    this.forgetting.set(key, work)
  }

  /** Stops the process started for a session that was never recorded, and removes its temporary directory. */
  private async discardProcess(key: string): Promise<void> {
    await this.spawning.get(key)?.catch(() => undefined)
    const live = this.lives.get(key)
    if (live) await live.connection.stop('stop', this.limits.stopGraceMs).catch(() => {})
    await rm(this.tmpDirFor(key), { recursive: true, force: true }).catch(() => {})
  }

  private async within(promise: Promise<unknown>, ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        promise,
        new Promise(resolve => {
          timer = setTimeout(resolve, ms)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  // ---- agent messages ---------------------------------------------------------------------------------------------

  private onRequest(live: Live, method: string, params: unknown, id: RpcId): Promise<unknown> {
    if (method === 'session/request_permission') return this.onPermission(live, params, id)
    // File system, terminal and elicitation are not advertised, so agents must not call them.
    return Promise.reject(new RpcError(RPC.methodNotFound, `Method not found: ${clip(method, 200)}`))
  }

  private onNotification(live: Live, method: string, params: unknown): void {
    if (method === 'session/update') return this.onUpdate(live, params)
    if (method === '$/cancel_request') {
      const parsed = cancelRequest.safeParse(params)
      if (!parsed.success) return
      for (const permission of [...this.permissions.values()]) {
        if (permission.live === live && permission.rpcId === parsed.data.requestId)
          this.closePermission(permission, new RpcError(RPC.cancelled, 'Request cancelled'))
      }
    }
  }

  private onUpdate(live: Live, params: unknown): void {
    const envelope = updateEnvelope.safeParse(params)
    if (!envelope.success) return
    const taskId = live.sessions.get(envelope.data.sessionId)
    const task = taskId ? this.state.tasks[taskId] : undefined
    if (!taskId || !task) return
    const update = envelope.data.update
    const candidate = this.runs.get(taskId)
    const run = candidate?.sent && candidate.live === live ? candidate : undefined
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const parsed = chunkUpdate.safeParse(update)
        if (!parsed.success) return
        const piece = blockText(parsed.data.content)
        if (!piece) return
        const kind = update.sessionUpdate === 'agent_message_chunk' ? 'text' : 'reasoning'
        const acpMessageId = parsed.data.messageId && parsed.data.messageId.length <= 200 ? parsed.data.messageId : undefined
        if (run) this.appendLive(run, task, kind, piece, acpMessageId)
        else this.appendStray(task, kind, piece, acpMessageId)
        return
      }
      case 'tool_call':
      case 'tool_call_update': {
        const parsed = toolFields.safeParse(update)
        if (parsed.success) this.applyTool(task, run, parsed.data, update.sessionUpdate === 'tool_call')
        return
      }
      case 'plan': {
        const parsed = planUpdate.safeParse(update)
        if (!parsed.success) return
        task.plan = planEntries(parsed.data.entries)
        if (run) run.lastOutputAt = this.clock()
        break
      }
      case 'session_info_update': {
        const parsed = infoUpdate.safeParse(update)
        const title = parsed.success ? parsed.data.title?.trim().replace(/\s+/g, ' ') : undefined
        if (!title) return
        task.summary.title = clip(title, 200)
        break
      }
      case 'current_mode_update': {
        const parsed = modeUpdate.safeParse(update)
        if (!parsed.success) return
        const option = this.modeOption(task)
        const before = option?.currentValue
        // Tracked even when the value is not one of the offered modes: an unknown mode must not read as the old one.
        if (option) {
          option.currentValue = parsed.data.currentModeId
          this.unconfirmed.delete(taskId)
        }
        this.observeMode(task, before, parsed.data.currentModeId)
        break
      }
      case 'config_option_update': {
        const parsed = configUpdate.safeParse(update)
        if (!parsed.success) return
        this.reportConfig(task, parsed.data.configOptions)
        break
      }
      case 'usage_update': {
        // A report about the session, not output: it does not move lastOutputAt.
        const parsed = usageUpdate.safeParse(update)
        if (!parsed.success) return
        const { used, size, cost } = parsed.data
        if (used === undefined && size === undefined && !cost) return
        task.usageReport = {
          ...(used !== undefined ? { contextUsed: used } : {}),
          ...(size !== undefined ? { contextSize: size } : {}),
          ...(cost ? { cost: { amount: cost.amount, currency: cost.currency } } : {}),
          at: this.now(),
        }
        break
      }
      case 'available_commands_update': {
        const parsed = commandsUpdate.safeParse(update)
        if (!parsed.success) return
        task.commands = parsed.data.availableCommands.map(command => ({
          name: command.name,
          ...(command.description ? { description: command.description } : {}),
          ...(command.input?.hint ? { inputHint: command.input.hint } : {}),
        }))
        break
      }
      // user_message_chunk and unknown kinds carry nothing Latch shows.
      default:
        return
    }
    this.touch(task)
    this.mark()
    this.notify(taskId)
  }

  private messageId(task: AcpTask, acpMessageId: string | undefined): string {
    if (acpMessageId) {
      const id = `msg:${acpMessageId}`
      if (!task.messages.some(item => item.id === id)) return id
    }
    return randomUUID()
  }

  private appendLive(run: Run, task: AcpTask, kind: 'text' | 'reasoning', piece: string, acpMessageId: string | undefined): void {
    let segment = run.segment
    if (segment && acpMessageId && segment.acpMessageId && segment.acpMessageId !== acpMessageId) {
      this.settleSegment(run, task, 'completed')
      segment = undefined
    }
    if (!segment)
      segment = run.segment = {
        id: this.messageId(task, acpMessageId),
        text: '',
        reasoning: '',
        ...(acpMessageId ? { acpMessageId } : {}),
        createdAt: this.clock(),
        reasoningTimer: new ReasoningTimer(this.clock),
      }
    else if (acpMessageId && !segment.acpMessageId) segment.acpMessageId = acpMessageId
    if (kind === 'text') {
      segment.text = append(segment.text, piece)
      segment.reasoningTimer.text()
    } else {
      segment.reasoning = append(segment.reasoning, piece)
      segment.reasoningTimer.reasoning()
    }
    run.lastOutputAt = this.clock()
    if (!run.cancelRequested && run.activity.phase !== 'approval') this.phase(run, 'model')
    this.notify(task.summary.id)
  }

  private settleSegment(run: Run, task: AcpTask, state: NonNullable<Message['state']>): void {
    const segment = run.segment
    run.segment = undefined
    if (!segment || (!segment.text && !segment.reasoning)) return
    const reasoningMs = segment.reasoningTimer.end()
    const model = modelName(task.config)
    task.messages.push({
      id: segment.id,
      role: 'assistant',
      text: segment.text,
      state,
      ...(segment.reasoning ? { reasoning: segment.reasoning } : {}),
      createdAt: isoTime(segment.createdAt),
      completedAt: this.now(),
      ...(reasoningMs !== undefined ? { reasoningMs } : {}),
      ...(model ? { model: clip(model, 200) } : {}),
    })
    this.touch(task)
    this.mark()
  }

  /** Text outside a turn is settled at once, extending the previous stray message while it stays last. */
  private appendStray(task: AcpTask, kind: 'text' | 'reasoning', piece: string, acpMessageId: string | undefined): void {
    const taskId = task.summary.id
    const open = this.stray.get(taskId)
    const last = task.messages.at(-1)
    let target =
      open && last?.id === open.id && (!acpMessageId || !open.acpMessageId || open.acpMessageId === acpMessageId) ? last : undefined
    if (!target) {
      target = { id: this.messageId(task, acpMessageId), role: 'assistant', text: '', state: 'completed', createdAt: this.now() }
      task.messages.push(target)
      this.stray.set(taskId, { id: target.id, ...(acpMessageId ? { acpMessageId } : {}) })
    }
    if (kind === 'text') target.text = append(target.text, piece)
    else target.reasoning = append(target.reasoning ?? '', piece)
    this.touch(task)
    this.mark()
    this.notify(taskId)
  }

  private toolState(task: AcpTask, toolCallId: string): ToolState {
    const taskId = task.summary.id
    let tools = this.tools.get(taskId)
    if (!tools) {
      tools = { seq: task.acp.turnSeq, calls: new Map() }
      this.tools.set(taskId, tools)
    }
    let state = tools.calls.get(toolCallId)
    if (!state) {
      // Agents reuse IDs such as `call_1` in every turn, so the turn number scopes them.
      state = { id: `tool:${tools.seq}:${toolCallId}`, content: [], locations: [], awaiting: 0 }
      tools.calls.set(toolCallId, state)
    }
    return state
  }

  private upsert(task: AcpTask, item: Message): void {
    const index = task.messages.findIndex(existing => existing.id === item.id)
    if (index >= 0) task.messages[index] = item
    else task.messages.push(item)
  }

  private applyTool(task: AcpTask, run: Run | undefined, fields: ToolFields, created: boolean): void {
    if (created && run?.segment) this.settleSegment(run, task, 'completed')
    const state = this.toolState(task, fields.toolCallId)
    mergeTool(state, fields, this.now())
    this.upsert(task, toolMessage(state))
    if (run) run.lastOutputAt = this.clock()
    if (run && !run.cancelRequested && !this.openApprovals(task.summary.id).length) {
      if (state.status === 'in_progress') this.phase(run, 'tool', toolLabel(state))
      else if (state.status === 'completed' || state.status === 'failed') this.phase(run, 'model')
    }
    this.touch(task)
    this.mark()
    this.notify(task.summary.id)
  }

  private onPermission(live: Live, params: unknown, rpcId: RpcId): Promise<unknown> {
    const parsed = permissionRequest.safeParse(params)
    if (!parsed.success) return Promise.reject(new RpcError(RPC.invalidParams, 'Invalid params'))
    const taskId = live.sessions.get(parsed.data.sessionId)
    const task = taskId ? this.state.tasks[taskId] : undefined
    const run = taskId ? this.runs.get(taskId) : undefined
    const filtered = filterPermissionOptions(this.profile, parsed.data.options)
    if (task?.acp.drift) return Promise.resolve(this.rejection(filtered.visible))
    if (!taskId || !task || !run?.sent || run.live !== live || run.cancelRequested || this.closed) return Promise.resolve(CANCELLED_OUTCOME)
    if (run.segment) this.settleSegment(run, task, 'completed')
    const state = this.toolState(task, parsed.data.toolCall.toolCallId)
    mergeTool(state, parsed.data.toolCall, this.now())
    if (filtered.autoReject) {
      // Persistent or unknown choices only: nothing Latch could offer, so the request is refused at once.
      this.upsert(task, toolMessage(state))
      task.messages.push({
        id: randomUUID(),
        role: 'system',
        text: `已自动拒绝：${this.agent.name} 只提供会持久保存的选项或未知选项，Latch 不提供。`,
        createdAt: this.now(),
      })
      this.touch(task)
      this.mark()
      this.notify(taskId)
      this.securityEvent({ type: 'approval-auto-rejected', sessionId: taskId, reason: filtered.autoReject.reason })
      return Promise.resolve(filtered.autoReject.optionId ? selected(filtered.autoReject.optionId) : CANCELLED_OUTCOME)
    }
    state.awaiting++
    const approval: Approval = {
      id: randomUUID(),
      sessionId: taskId,
      toolName: toolLabel(state),
      toolCallId: state.id.slice('tool:'.length),
      reason: clip(state.title || `${this.agent.name} 请求执行一项操作`, 1000),
      ...(state.rawInput !== undefined ? { arguments: clip(pretty(state.rawInput), TOOL_TEXT_LIMIT) } : {}),
      requestedAt: this.now(),
      options: filtered.visible.map(option => ({
        id: option.optionId,
        label: clip(option.name, 200),
        kind: option.kind as ApprovalOptionKind,
      })),
      tool: toolDetail(state),
      // The harness asks on its own terms in a full-access session: a prompt, not a security boundary.
      risk: 'R2',
      advisory: true,
    }
    return new Promise((resolve, reject) => {
      this.permissions.set(approval.id, {
        approval,
        live,
        rpcId,
        taskId,
        tool: state,
        options: parsed.data.options,
        visible: filtered.visible,
        claimed: false,
        answer: resolve,
        fail: reject,
      })
      this.upsert(task, toolMessage(state))
      task.summary.status = 'waiting-approval'
      run.clock.openWait(approval.id)
      run.lastOutputAt = this.clock()
      this.phase(run, 'approval', approval.toolName)
      this.touch(task)
      this.mark()
      this.notify(taskId)
    })
  }

  /**
   * `decision`: the record the ask leaves on its call; an agent that withdrew its own ask leaves none. A call the agent
   * asks about more than once keeps an allowance it was given: what it did after that was allowed, so a later
   * rejection must not make the call read as one that never ran.
   */
  private closePermission(permission: Permission, result: unknown, decision?: ToolDecision): void {
    if (!this.permissions.delete(permission.approval.id)) return
    permission.claimed = true
    permission.tool.awaiting = Math.max(0, permission.tool.awaiting - 1)
    if (decision && permission.tool.decision?.outcome !== 'allowed') permission.tool.decision = decision
    if (result instanceof Error) permission.fail(result)
    else permission.answer(result)
    const task = this.state.tasks[permission.taskId]
    this.runs.get(permission.taskId)?.clock.closeWait(permission.approval.id)
    if (task) {
      this.upsert(task, toolMessage(permission.tool))
      const run = this.runs.get(permission.taskId)
      if (!this.openApprovals(permission.taskId).length) {
        if (task.summary.status === 'waiting-approval') task.summary.status = 'running'
        if (run && !run.cancelRequested) this.phase(run, 'model')
      }
      this.touch(task)
      this.mark()
    }
    this.notify(permission.taskId)
  }

  private applyModel(task: AcpTask): void {
    const model = modelName(task.config)
    if (model) task.summary.model = clip(model, 200)
  }
}
