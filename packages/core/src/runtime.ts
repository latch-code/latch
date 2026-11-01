import { RunFileTracking, recordFileOutputs } from './file-tracking.ts'
import { createHash, randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileMentionContext, isAttachmentRef, escapeSecurityText, rejectionNote } from '@latch/protocol'
import type {
  AttachmentRef,
  Approval,
  ApprovalOption,
  Message,
  ModelRef,
  PersonalExecutionContext,
  RiskLevel,
  RunLive,
  TaskDetail,
  TaskMode,
  TaskStatus,
  TaskSummary,
  TokenUsage,
  ToolDecision,
  ToolDetail,
  UnknownResult,
} from '@latch/protocol'
import {
  AppError,
  type FileTrackingInput,
  type FileTrackingHandle,
  type AttachmentContent,
  type ModelMessage,
  type CapabilityLease,
  type RuntimeRegistry,
  type ToolCall,
  type ToolDefinition,
  type ToolRiskInput,
  type Bridge,
  type CancelOptions,
  type CreateTaskInput,
  type DecideOptions,
  type HostProject,
  type ProjectFolder,
  type PromptOptions,
  type SessionFolder,
} from '@latch/sdk'
import { runEndRecord } from './run-end.ts'
import { isoTime, ReasoningTimer, RunClock } from './node-kit/timing.ts'
import { createSnapshotStore, emptyRuntimeState } from './store.ts'
import type { RuntimeState, RuntimeStore, StoredTask } from './store.ts'

function privateContext(value: PersonalExecutionContext | undefined): PersonalExecutionContext | undefined {
  if (value === undefined) return undefined
  if (
    !value
    || !/^asst_[a-f0-9-]{36}$/u.test(value.owner?.assistantId ?? '')
    || (value.owner.groupId !== undefined && !/^grp_[a-f0-9-]{36}$/u.test(value.owner.groupId))
    || typeof value.instructions !== 'string'
    || value.instructions.length > 600_000
    || !/^[a-f0-9]{64}$/u.test(value.revision)
    || !Array.isArray(value.pluginIds)
    || value.pluginIds.length > 64
    || value.pluginIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(id))
    || new Set(value.pluginIds).size !== value.pluginIds.length
    || (value.sharedMessages !== undefined
      && (!value.owner.groupId
        || !Array.isArray(value.sharedMessages)
        || value.sharedMessages.length > 64
        || value.sharedMessages.some(
          message =>
            !message
            || typeof message !== 'object'
            || !['user', 'assistant'].includes(message.role)
            || typeof message.text !== 'string'
            || message.text.length > 64000
            || Object.keys(message).some(key => key !== 'role' && key !== 'text'),
        )
        || Buffer.byteLength(JSON.stringify(value.sharedMessages)) > 256 * 1024))
    || (value.expectedRevisions !== undefined
      && (!value.expectedRevisions
        || typeof value.expectedRevisions !== 'object'
        || Array.isArray(value.expectedRevisions)
        || Object.keys(value.expectedRevisions).length > 128
        || Object.entries(value.expectedRevisions).some(
          ([id, hash]) => !/^[A-Za-z0-9_-]{1,64}$/u.test(id) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash),
        )))
  )
    throw new AppError(400, 'personal-context-invalid', '个人助手上下文无效。')
  return structuredClone(value)
}

export interface RuntimeOptions {
  trackFiles?: (input: FileTrackingInput) => Promise<FileTrackingHandle>
  readAttachment?: (ref: AttachmentRef, signal?: AbortSignal) => Promise<AttachmentContent>
  dataDir: string
  /** Working directory of sessions created without `cwd`. */
  workspaceRoot: string
  /** Directories a session may use as `cwd`, compared by real path. Defaults to `[workspaceRoot]`. */
  workspaces?: () => string[]
  /**
   * Projects a session may use now, with their folders (`default` is the start directory). A session created with
   * `workspaceId` and `folders` needs them to match a listed project, and keeps them: later input and allowed calls
   * need every folder to still be a folder of that project. Without it such sessions cannot be created.
   */
  projects?: () => HostProject[]
  registry: RuntimeRegistry
  /** Provider of sessions that have not chosen one. */
  providerId: string | (() => string)
  /** Model for new sessions that do not choose one; such sessions keep it until a prompt switches it. */
  defaultModel?: () => ModelRef | undefined
  maxSteps?: number
  /**
   * Host classifier, called right before each tool call. R0 runs without approval; R1 asks and offers
   * "本会话始终允许"; R2 asks every time without that option. A rejection or unknown value counts as R2.
   * Absent: legacy behaviour, where `requiresApproval` means R1 and anything else R0.
   */
  classifyToolCall?(input: ToolRiskInput): Promise<RiskLevel>
  /** Private 0700 directory for per-session temporary files. The built-in tools write in place and do not use it yet. */
  tmpRoot?: string
  /** Alternate backends must atomically commit state and receipts, with one writer. */
  store?: RuntimeStore
  /** Milliseconds since the epoch for every recorded time. Default `Date.now`. */
  clock?: () => number
}

export const APPROVAL_OPTIONS: readonly ApprovalOption[] = Object.freeze([
  { id: 'allow_once', label: '允许一次', kind: 'allow_once' },
  { id: 'allow_always', label: '本会话始终允许', kind: 'allow_always' },
  { id: 'reject_once', label: '拒绝', kind: 'reject_once' },
])
/** R2 is asked every time, so it never offers a standing allowance. */
export const HIGH_RISK_APPROVAL_OPTIONS: readonly ApprovalOption[] = Object.freeze(
  APPROVAL_OPTIONS.filter(option => option.kind !== 'allow_always'),
)

const RISK_LEVELS: ReadonlySet<unknown> = new Set<RiskLevel>(['R0', 'R1', 'R2'])
/** The ID of the one folder of a session that recorded no folders: its working directory. */
const SINGLE_FOLDER_ID = 'default'

/** An approval's answer: a person's (with where they decided and, for a rejection, what to do instead) or the run stopping. */
type Decision = {
  decision: 'allow' | 'reject' | 'cancel'
  at: string
  always?: boolean
  via?: ToolDecision['via']
  note?: string
}
type Preview = Pick<ToolDetail, 'title' | 'diffs'>

interface PendingApproval {
  value: Approval
  claimed: boolean
  resolve(decision: Decision): void
  signal: AbortSignal
}
interface Run {
  instructions?: string
  sharedMessages?: ModelMessage[]
  id: string
  sessionId: string
  mode: TaskMode
  /** Model ID sent to the provider for every step of this run, and the service that provides it. */
  model: string
  providerId: string
  /** The user message that started the run; it carries the turn's times once the run settles. */
  userMessageId: string
  clock: RunClock
  /** The last change of visible output, in clock milliseconds. */
  lastOutputAt?: number
  /** The last sign of life: anything the provider sent, or the start of a phase. */
  lastEventAt: number
  /** The tool the `tool` phase is running. */
  running?: { name: string; command: boolean }
  /** The session's working directory, passed to tools. */
  cwd: string
  /** The session's folders, frozen when it was created; `[0]` is at `cwd`. */
  folders: ProjectFolder[]
  controller: AbortController
  lease: CapabilityLease
  done: Promise<void>
  resolveDone(): void
  activity?: TaskDetail['activity']
}
/** Streamed, not yet committed output of the current step. */
interface LiveStep {
  id: string
  text: string
  reasoning: string
  usage?: TokenUsage
  /** When the step began (the provider was called), in clock milliseconds. */
  createdAt: number
  reasoningTimer: ReasoningTimer
}
/**
 * `persist` pins the provider on the session. Sessions without a stored provider follow the
 * current default on every input, as they always have.
 */
interface Selection {
  providerId: string
  model?: string
  source: 'request' | 'session' | 'default'
  persist: boolean
}

const MAX_OUTPUT = 2_000_000
const MAX_PREVIEW = 1_000_000
/** What the model receives for a call the person rejected; a note follows it when they said what to do instead. */
const REJECTED = '用户拒绝了本次工具调用，未执行该操作。'

/** The record a decided approval leaves on its call; nobody's answer (the run stopping) is never worded as a choice. */
function decisionRecord(answer: Decision): ToolDecision {
  if (answer.decision === 'cancel') return { outcome: 'cancelled', at: answer.at }
  return { outcome: answer.decision === 'allow' ? 'allowed' : 'rejected', at: answer.at, ...(answer.via ? { via: answer.via } : {}) }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Snapshot once per run, then persist it with the input before making any model call. */
function skillContext(lease: CapabilityLease): string | undefined {
  return lease.skills?.length ? lease.skills.map(skill => `# ${skill.name} (${skill.id})\n${skill.content}`).join('\n\n') : undefined
}
function assertPrompt(prompt: string, requestId: string, attachments?: AttachmentRef[]): void {
  if ((!prompt.trim() && !attachments?.length) || prompt.length > 1_000_000)
    throw new AppError(400, 'invalid-prompt', '请输入不超过 1 MB 的任务内容')
  if (!requestId || requestId.length > 256) throw new AppError(400, 'invalid-request-id', '缺少有效的请求标识')
}
/** Returns a detached copy with only the two known keys, so hashes and records stay stable. */
function modelRef(value: unknown): ModelRef {
  const ref = value as Partial<ModelRef> | null
  if (
    typeof ref !== 'object'
    || ref === null
    || typeof ref.providerId !== 'string'
    || typeof ref.model !== 'string'
    || !ref.providerId
    || ref.providerId.length > 128
    || !ref.model.trim()
    || ref.model.length > 256
  ) {
    throw new AppError(400, 'invalid-model', '模型选择无效')
  }
  return { providerId: ref.providerId, model: ref.model }
}
function safeCall(call: ToolCall): ToolCall {
  if (
    !call
    || typeof call.id !== 'string'
    || !call.id
    || typeof call.name !== 'string'
    || !call.name
    || typeof call.arguments !== 'object'
    || call.arguments === null
    || Array.isArray(call.arguments)
  ) {
    throw new AppError(502, 'invalid-tool-call', '模型返回了无效的工具调用')
  }
  // Detach provider-owned arguments before displaying, approving, or executing them.
  return JSON.parse(JSON.stringify(call)) as ToolCall
}
function tokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}
const PARTS = ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const
type UsageDelta = { inputTokens: unknown; outputTokens: unknown } & { [part in (typeof PARTS)[number]]?: unknown }
/**
 * Adds a step's usage to a total. A part (cache read, cache write, reasoning) stays only while every step added so far
 * reported it, so the part never claims to cover tokens it does not.
 */
function addUsage(total: TokenUsage | undefined, delta: UsageDelta): TokenUsage {
  const sum: TokenUsage = {
    inputTokens: (total?.inputTokens ?? 0) + tokens(delta.inputTokens),
    outputTokens: (total?.outputTokens ?? 0) + tokens(delta.outputTokens),
  }
  for (const part of PARTS) {
    const reported = typeof delta[part] === 'number' && Number.isFinite(delta[part])
    if (reported && (total === undefined || total[part] !== undefined)) sum[part] = (total?.[part] ?? 0) + tokens(delta[part])
  }
  return sum
}
const PREVIOUS: ReadonlySet<unknown> = new Set(['none', 'text', 'unavailable'])
/** Plugin previews are trusted code but still bounded before they are persisted and shown. */
function previewOf(value: unknown): Preview | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { title, diffs } = value as { title?: unknown; diffs?: unknown }
  const preview: Preview = {}
  if (typeof title === 'string' && title.trim()) preview.title = title.trim().slice(0, 200)
  if (Array.isArray(diffs)) {
    const valid = diffs
      .filter(
        (diff): diff is NonNullable<Preview['diffs']>[number] =>
          typeof diff === 'object'
          && diff !== null
          && typeof diff.path === 'string'
          && typeof diff.newText === 'string'
          && (diff.oldText === undefined || typeof diff.oldText === 'string')
          && (diff.previous === undefined || PREVIOUS.has(diff.previous)),
      )
      .slice(0, 20)
    const size = valid.reduce((sum, diff) => sum + diff.path.length + diff.newText.length + (diff.oldText?.length ?? 0), 0)
    if (valid.length && size <= MAX_PREVIEW) {
      preview.diffs = valid.map(diff => ({
        path: diff.path,
        ...(diff.oldText !== undefined ? { oldText: diff.oldText } : {}),
        newText: diff.newText,
        ...(diff.previous ? { previous: diff.previous } : {}),
      }))
    }
  }
  return preview.title || preview.diffs ? preview : undefined
}
/** A tool's declared title as rows show it: trimmed, at most 40 characters, hidden characters made visible. */
function toolTitleOf(tool: ToolDefinition | undefined): string | undefined {
  const title = typeof tool?.title === 'string' ? tool.title.trim() : ''
  return title ? escapeSecurityText([...title].slice(0, 40).join('')) : undefined
}
/** What every record of a call says about the tool itself: its kind and title, when it declares them. */
function toolFacts(tool: ToolDefinition | undefined): Pick<ToolDetail, 'kind' | 'toolTitle'> {
  const toolTitle = toolTitleOf(tool)
  return { ...(tool?.kind ? { kind: tool.kind } : {}), ...(toolTitle ? { toolTitle } : {}) }
}
async function canonical(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path))
}
/** The folders a session works in: the ones it recorded, or its working directory alone. */
function foldersOf(summary: TaskSummary, cwd: string): ProjectFolder[] {
  return summary.folders?.length
    ? summary.folders.map(folder => ({ id: folder.id, path: folder.path }))
    : [{ id: SINGLE_FOLDER_ID, path: cwd }]
}
function toolFolders(run: Run): SessionFolder[] {
  return run.folders.map((folder, index) => ({ id: folder.id, path: folder.path, primary: index === 0 }))
}

function toolMessage(task: StoredTask, call: ToolCall): Message | undefined {
  return task.messages.find(message => message.id === `tool:${call.id}`)
}

function recordResult(task: StoredTask, call: ToolCall, at: string, text: string, isError: boolean, cancelled = false): void {
  task.history.push({ role: 'tool', content: text, toolCallId: call.id, isError })
  const previous = toolMessage(task, call)
  const message: Message = {
    id: `tool:${call.id}`,
    role: 'tool',
    toolName: call.name,
    text,
    state: cancelled ? 'cancelled' : isError ? 'failed' : 'completed',
    tool: { ...(previous?.tool ?? { title: call.name, input: JSON.stringify(call.arguments, null, 2) }), output: text },
    ...(previous?.createdAt ? { createdAt: previous.createdAt } : { createdAt: at }),
    ...(previous?.startedAt ? { startedAt: previous.startedAt } : {}),
    completedAt: at,
  }
  if (previous) Object.assign(previous, message)
  else task.messages.push(message)
  task.batch?.completed.push(call.id)
}

/** Balance unanswered calls without retrying an operation whose side effects are unknown. */
/** Settles the calls a run left open, and names those that started: nobody can say whether they took effect. */
function closeBatch(task: StoredTask, cancelled: boolean, at: string): UnknownResult[] {
  const batch = task.batch
  if (!batch) return []
  const unknownResults: UnknownResult[] = []
  for (const call of batch.calls) {
    if (batch.completed.includes(call.id)) continue
    const unknown = batch.started.includes(call.id)
    if (unknown) unknownResults.push({ messageId: `tool:${call.id}`, name: toolMessage(task, call)?.tool?.toolTitle ?? call.name })
    recordResult(
      task,
      call,
      at,
      unknown
        ? 'TOOL_OUTCOME_UNKNOWN: 执行未取得已确认结果。请先核对实际副作用；系统不会自动重放此操作。'
        : 'TOOL_NOT_STARTED: 本次运行已结束，工具没有开始执行。',
      true,
      cancelled && !unknown,
    )
  }
  delete task.batch
  return unknownResults
}

function workspaceChanged(): AppError {
  return new AppError(409, 'workspace-changed', '这个会话使用的文件夹已不在项目中或找不到了，不能继续。请新建会话。')
}

export function createRuntime(options: RuntimeOptions): Bridge {
  return new HarnessRuntime(options)
}

class HarnessRuntime implements Bridge {
  private readonly fileTracking: RunFileTracking
  private readonly options: RuntimeOptions
  private readonly clock: () => number
  private state = emptyRuntimeState()
  private readonly store: RuntimeStore
  private readonly workspaceRoot: string
  private readonly maxSteps: number
  private readonly runs = new Map<string, Run>()
  private readonly pending = new Map<string, PendingApproval>()
  private readonly live = new Map<string, LiveStep>()
  private readonly listeners = new Set<(sessionId?: string) => void>()
  private queue: Promise<void> = Promise.resolve()
  private starting?: Promise<void>
  private closing?: Promise<void>
  private closed = false
  private storageFailure?: unknown

  constructor(options: RuntimeOptions) {
    this.options = options
    this.fileTracking = new RunFileTracking({
      track: options.trackFiles,
      current: (id, runId) => this.state.tasks[id]?.summary.runId === runId,
      notify: id => this.notify(id),
    })
    this.clock = options.clock ?? Date.now
    this.store = options.store ?? createSnapshotStore(options.dataDir)
    this.workspaceRoot = resolve(options.workspaceRoot)
    this.maxSteps = options.maxSteps ?? 12
    if (!Number.isSafeInteger(this.maxSteps) || this.maxSteps < 1 || this.maxSteps > 100)
      throw new Error('maxSteps must be between 1 and 100')
  }

  private now(): string {
    return isoTime(this.clock())
  }

  /** Records a phase of the run's live projection and when it began. */
  private phase(run: Run, activity: Omit<NonNullable<TaskDetail['activity']>, 'since'>): void {
    run.activity = { ...activity, since: this.now() }
    run.lastEventAt = this.clock()
  }

  /** What a live run is doing, for its summary; the Host adds the silence thresholds. */
  private liveOf(run: Run): RunLive | undefined {
    const activity = run.activity
    if (!activity?.since) return undefined
    const tool = activity.phase === 'tool' ? run.running : undefined
    return {
      runId: run.id,
      activity: activity.phase === 'tool' ? (tool?.command ? 'command' : 'tool') : activity.phase,
      ...(tool ? { commandName: tool.name } : {}),
      since: activity.since,
      ...run.clock.live(),
      lastEventAt: isoTime(run.lastEventAt),
      ...(run.lastOutputAt !== undefined ? { lastOutputAt: isoTime(run.lastOutputAt) } : {}),
    }
  }

  private isActive(summary: TaskSummary): boolean {
    return summary.status === 'running' || summary.status === 'waiting-approval'
  }

  /** The stored summary with what only the live run knows, which is never stored. */
  private projected(task: StoredTask): TaskSummary {
    const run = this.isActive(task.summary) ? this.runs.get(task.summary.id) : undefined
    const live = run && this.liveOf(run)
    return live ? { ...task.summary, live } : task.summary
  }

  liveRuns(): Array<{ sessionId: string; live: RunLive }> {
    const found: Array<{ sessionId: string; live: RunLive }> = []
    for (const [sessionId, run] of this.runs) {
      const task = Object.hasOwn(this.state.tasks, sessionId) ? this.state.tasks[sessionId] : undefined
      const live = task && this.isActive(task.summary) ? this.liveOf(run) : undefined
      if (live) found.push({ sessionId, live })
    }
    return found
  }

  /** Visible output changed: text, reasoning, a tool's state or a new message. */
  private output(run: Run): void {
    run.lastOutputAt = run.lastEventAt = this.clock()
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new AppError(503, 'runtime-closed', '运行节点已关闭'))
    return (this.starting ??= (async () => {
      this.state = await this.store.load()
      const recovered = structuredClone(this.state)
      let changed = false
      for (const task of Object.values(recovered.tasks)) {
        for (const message of task.messages)
          if (message.outputsPending) {
            delete message.outputsPending
            message.outputsTruncated = true
            task.revision++
            changed = true
          }
        if (task.summary.mode === undefined) {
          task.summary.mode = 'agent'
          changed = true
        }
        if (task.summary.status !== 'running' && task.summary.status !== 'waiting-approval' && !task.approval && !task.batch) continue
        const at = this.now()
        // An approval left open by the restart was answered by nobody: the run stopped.
        const asked = task.approval?.toolCallId
          ? task.messages.find(message => message.id === `tool:${task.approval!.toolCallId}`)
          : undefined
        if (asked) asked.tool = { ...asked.tool, decision: { outcome: 'cancelled', at } }
        const unknown = closeBatch(task, false, at)
        delete task.approval
        task.summary.status = 'interrupted'
        task.summary.runEnd = runEndRecord('host-stopped', at, unknown)
        task.summary.updatedAt = at
        task.revision++
        // The turn did not settle, so its user message gets no times: its duration is unknown.
        task.messages.push({
          id: randomUUID(),
          role: 'system',
          text: '上次运行被中断。旧审批已失效；请核对工具副作用后再明确发起后续任务。',
          state: 'failed',
          createdAt: at,
        })
        changed = true
      }
      if (changed) {
        await this.store.commit(recovered)
        this.state = recovered
      }
    })())
  }

  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.closed = true
      await this.starting?.catch(() => {})
      this.fileTracking.dispose()
      for (const run of this.runs.values()) run.controller.abort(new Error('Runtime closed'))
      await Promise.all([...this.runs.values()].map(run => run.done))
      await this.fileTracking.close()
      await this.queue
      await this.store.close()
      this.listeners.clear()
    })())
  }

  private async ready(): Promise<void> {
    await this.start()
    if (this.closed) throw new AppError(503, 'runtime-closed', '运行节点已关闭')
    if (this.storageFailure) throw new AppError(503, 'storage-unavailable', '持久化失败，运行节点已停止接收新操作。请检查数据存储。')
  }

  /** Serializes short state commits, never model calls, tools, or waiting approvals. */
  private commit<T>(operation: (draft: RuntimeState) => T, sessionId?: string): Promise<T> {
    const result = this.queue.then(async () => {
      if (this.storageFailure) throw this.storageFailure
      const draft = structuredClone(this.state)
      const value = operation(draft)
      try {
        await this.store.commit(draft)
      } catch (error) {
        this.storageFailure = error
        this.fileTracking.dispose()
        for (const run of this.runs.values()) run.controller.abort(error)
        throw error
      }
      this.state = draft
      this.notify(sessionId)
      return value
    })
    this.queue = result.then(
      () => {},
      () => {},
    )
    return result
  }

  private task(state: RuntimeState, id: string): StoredTask {
    const task = Object.hasOwn(state.tasks, id) ? state.tasks[id] : undefined
    if (!task) throw new AppError(404, 'task-not-found', '找不到该任务')
    return task
  }

  private change(id: string, operation: (task: StoredTask) => void): Promise<void> {
    return this.commit(draft => {
      const task = this.task(draft, id)
      operation(task)
      task.revision++
      task.summary.updatedAt = this.now()
    }, id)
  }

  /** The listed workspace that `cwd` resolves to, or undefined when it is not an allowed workspace. */
  private async workspaceFor(cwd: string | undefined): Promise<string | undefined> {
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0')) return undefined
    const target = await canonical(cwd)
    for (const candidate of this.options.workspaces?.() ?? [this.workspaceRoot]) {
      if ((await canonical(candidate)) === target) return resolve(candidate)
    }
    return undefined
  }

  /**
   * The project and folders a new session records. `workspaceId` must name a listed project whose primary folder is
   * at `cwd`; `folders[0]` must be that primary folder and every folder one of the project's (same ID and real path).
   * Undefined when the input names no project; null when it names one that does not match, or the Host lists none.
   */
  private async projectOf(
    input: CreateTaskInput,
    cwd: string | undefined,
  ): Promise<{ workspaceId: string; folders: ProjectFolder[] } | null | undefined> {
    if (input.workspaceId === undefined && input.folders === undefined) return undefined
    const requested: unknown = input.folders
    if (cwd === undefined || input.cwd === undefined || typeof input.workspaceId !== 'string') return null
    if (!Array.isArray(requested) || requested.length === 0 || requested.length > 64) return null
    const project = this.options.projects?.().find(item => item.id === input.workspaceId)
    if (!project?.folders.length || (await canonical(project.folders[0]!.path)) !== (await canonical(cwd))) return null
    const folders: ProjectFolder[] = []
    for (const [index, folder] of (requested as unknown[]).entries()) {
      const { id, path } = (folder ?? {}) as { id?: unknown; path?: unknown }
      if (typeof id !== 'string' || typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) return null
      if (folders.some(item => item.id === id)) return null
      const listed = project.folders.find(item => item.id === id)
      if (!listed || (index === 0 && listed !== project.folders[0])) return null
      if ((await canonical(path)) !== (await canonical(listed.path))) return null
      folders.push({ id, path: index === 0 ? cwd : resolve(listed.path) })
    }
    return { workspaceId: project.id, folders }
  }

  /**
   * Whether a session may still work in what it recorded. A session with folders needs its project listed and every
   * one of its folders still a folder of that project (same ID and real path); a different primary folder now does
   * not matter. A session without folders needs its directory to be listed.
   */
  private async stillAllowed(summary: TaskSummary): Promise<boolean> {
    if (summary.folders === undefined) return (await this.workspaceFor(summary.cwd)) !== undefined
    const project = summary.workspaceId === undefined ? undefined : this.options.projects?.().find(item => item.id === summary.workspaceId)
    if (!project) return false
    for (const folder of summary.folders) {
      const listed = project.folders.find(item => item.id === folder.id)
      if (!listed || (await canonical(listed.path)) !== (await canonical(folder.path))) return false
    }
    return true
  }

  /** `stillAllowed` without touching the disk, for decisions that must be claimed synchronously. */
  private stillListed(summary: TaskSummary): boolean {
    if (summary.folders === undefined) return true // Its directory was checked when the run began; tools refuse a vanished one.
    const project = summary.workspaceId === undefined ? undefined : this.options.projects?.().find(item => item.id === summary.workspaceId)
    return (
      project !== undefined
      && summary.folders.every(folder => project.folders.some(item => item.id === folder.id && resolve(item.path) === resolve(folder.path)))
    )
  }

  private defaultSelection(): Selection {
    const model = this.options.defaultModel?.()
    if (model) return { providerId: model.providerId, model: model.model, source: 'default', persist: true }
    const providerId = typeof this.options.providerId === 'function' ? this.options.providerId() : this.options.providerId
    return { providerId, source: 'default', persist: false }
  }

  async listTasks(): Promise<TaskSummary[]> {
    await this.ready()
    return structuredClone(
      Object.values(this.state.tasks)
        .map(task => this.projected(task))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    )
  }

  async detail(sessionId: string): Promise<TaskDetail> {
    await this.ready()
    const task = this.task(this.state, sessionId)
    const active = task.summary.status === 'running' || task.summary.status === 'waiting-approval'
    const live = this.live.get(sessionId)
    const visibleLive = active && live && !task.messages.some(message => message.id === live.id) ? live : undefined
    const run = active ? this.runs.get(sessionId) : undefined
    return structuredClone({
      summary: this.projected(task),
      messages: task.messages,
      approvals: task.approval ? [task.approval] : [],
      liveText: visibleLive?.text ?? '',
      cursor: task.revision,
      ...(this.fileTracking.projection(sessionId, task.summary.runId)
        ? { fileChanges: this.fileTracking.projection(sessionId, task.summary.runId) }
        : {}),
      ...(visibleLive ? { liveMessageId: visibleLive.id } : {}),
      ...(visibleLive?.reasoning ? { liveReasoning: visibleLive.reasoning, ...visibleLive.reasoningTimer.live() } : {}),
      ...(run?.activity ? { activity: run.activity } : {}),
      ...(run ? run.clock.live() : {}),
      ...(run?.lastOutputAt !== undefined ? { lastOutputAt: isoTime(run.lastOutputAt) } : {}),
    })
  }

  async createTask(input: CreateTaskInput): Promise<{ sessionId: string }> {
    await this.ready()
    assertPrompt(input.prompt, input.requestId, input.attachments)
    const attachments = this.attachments(input.attachments)
    const fileRefs = input.fileRefs ?? []
    const personal = privateContext(input.personal)
    const mode = input.mode ?? 'agent'
    if (mode !== 'chat' && mode !== 'agent') throw new AppError(400, 'invalid-mode', '对话模式必须是 chat 或 agent')
    const model = input.model === undefined ? undefined : modelRef(input.model)
    if (input.cwd !== undefined && typeof input.cwd !== 'string') throw new AppError(400, 'workspace-unavailable', '项目目录无效')
    const cwd = input.cwd === undefined ? this.workspaceRoot : await this.workspaceFor(input.cwd)
    const scope = await this.projectOf(input, cwd)
    const key = digest(['create', input.requestId])
    const requestedFolders: unknown = input.folders
    // Selection keys join the hash only when given, and folders only when there are several, so receipts written before
    // they existed still match.
    const payloadHash = digest({
      prompt: input.prompt,
      ...(personal ? { personal: personal.owner, pluginIds: personal.pluginIds } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(fileRefs.length ? { fileRefs } : {}),
      mode,
      ...(model ? { model } : {}),
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(Array.isArray(requestedFolders) && requestedFolders.length > 1
        ? { folders: (requestedFolders as Array<Partial<ProjectFolder> | null>).map(folder => ({ id: folder?.id, path: folder?.path })) }
        : {}),
    })
    let run: Run | undefined
    try {
      const result = await this.commit(draft => {
        const receipt = draft.receipts[key]
        if (receipt) {
          if (draft.tombstones && Object.hasOwn(draft.tombstones, receipt.taskId)) {
            throw new AppError(410, 'task-deleted', '这个请求创建的任务已被删除')
          }
          // Before modes existed, creation receipts hashed the text alone.
          const legacyAgentReceipt =
            !personal
            && mode === 'agent'
            && !attachments.length
            && !fileRefs.length
            && !model
            && input.cwd === undefined
            && this.task(draft, receipt.taskId).summary.mode === 'agent'
            && receipt.payloadHash === digest(input.prompt)
          if (receipt.payloadHash !== payloadHash && !legacyAgentReceipt)
            throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同任务内容或对话模式')
          receipt.payloadHash = payloadHash
          return { sessionId: receipt.taskId }
        }
        if (cwd === undefined) throw new AppError(400, 'workspace-unavailable', '所选项目目录不是此节点允许的工作区')
        if (scope === null) throw new AppError(400, 'workspace-unavailable', '所选项目的文件夹与此节点登记的不一致')
        const selection: Selection = model ? { ...model, source: 'request', persist: true } : this.defaultSelection()
        const folders = scope?.folders ?? [{ id: SINGLE_FOLDER_ID, path: cwd }]
        let context: string
        try {
          context = fileMentionContext(input.prompt, fileRefs, folders)
        } catch {
          throw new AppError(400, 'file-reference-invalid', '文件引用无效。')
        }
        if (fileRefs.length && mode === 'chat') throw new AppError(415, 'file-references-unavailable', '只对话模式不能引用项目文件。')
        run = this.allocateRun(`task-${randomUUID()}`, mode, selection, cwd, folders, personal)
        this.assertAttachments(run, attachments)
        const sessionId = run.sessionId
        const at = isoTime(run.clock.startedAt)
        draft.tasks[sessionId] = {
          summary: {
            id: sessionId,
            ...(personal ? { personal: structuredClone(personal.owner), pluginIds: [...personal.pluginIds] } : {}),
            title: (input.prompt.trim().replace(/\s+/g, ' ') || attachments[0]?.name || '附件').slice(0, 80),
            status: 'running',
            updatedAt: at,
            createdAt: at,
            cwd,
            ...(scope ? { workspaceId: scope.workspaceId, folders: scope.folders } : {}),
            model: run.model,
            mode,
            ...(selection.persist || personal ? { providerId: selection.providerId } : {}),
            runId: run.id,
            ...(run.lease.skills?.length ? { skills: run.lease.skills.map(skill => skill.id) } : {}),
          },
          messages: [
            {
              id: run.userMessageId,
              role: 'user',
              text: input.prompt,
              ...(mode === 'chat' ? {} : { turnId: run.id }),
              requestId: input.requestId,
              createdAt: at,
              ...(attachments.length ? { attachments } : {}),
              ...(fileRefs.length ? { fileRefs } : {}),
            },
          ],
          history: [{ role: 'user', content: context, ...(attachments.length ? { attachmentRefs: attachments } : {}) }],
          ...(skillContext(run.lease) ? { skillContext: skillContext(run.lease) } : {}),
          revision: 1,
        }
        draft.receipts[key] = { taskId: sessionId, payloadHash }
        return { sessionId }
      })
      if (run) this.launch(run)
      return result
    } catch (error) {
      if (run) this.releaseRun(run)
      throw error
    }
  }

  async prompt(sessionId: string, prompt: string, requestId: string, options: PromptOptions = {}): Promise<void> {
    await this.ready()
    assertPrompt(prompt, requestId, options.attachments)
    const personal = privateContext(options.personal)
    const attachments = this.attachments(options.attachments)
    const fileRefs = options.fileRefs ?? []
    const model = options.model === undefined ? undefined : modelRef(options.model)
    const key = digest(['prompt', sessionId, requestId])
    const payloadHash = digest(
      attachments.length || fileRefs.length
        ? { prompt, ...(model ? { model } : {}), ...(attachments.length ? { attachments } : {}), ...(fileRefs.length ? { fileRefs } : {}) }
        : model
          ? { prompt, model }
          : prompt,
    )
    // A session's cwd and folders never change, so the asynchronous check can precede the commit.
    const summary = Object.hasOwn(this.state.tasks, sessionId) ? this.state.tasks[sessionId]!.summary : undefined
    const recorded = summary?.cwd
    const allowed = summary !== undefined && (await this.stillAllowed(summary))
    let run: Run | undefined
    try {
      await this.commit(draft => {
        const task = this.task(draft, sessionId)
        const receipt = draft.receipts[key]
        if (receipt) {
          if (receipt.payloadHash !== payloadHash) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同输入')
          return
        }
        if (
          task.summary.personal?.assistantId !== personal?.owner.assistantId
          || task.summary.personal?.groupId !== personal?.owner.groupId
        )
          throw new AppError(409, 'personal-context-required', '请通过原个人助手继续这个会话。')
        if (!allowed || recorded === undefined) throw workspaceChanged()
        if (this.runs.has(sessionId) || task.summary.status === 'running' || task.summary.status === 'waiting-approval') {
          throw new AppError(409, 'task-running', '任务仍在运行，请等待完成或先取消')
        }
        const selection: Selection = model
          ? { ...model, source: 'request', persist: true }
          : task.summary.providerId
            ? { providerId: task.summary.providerId, model: task.summary.model, source: 'session', persist: true }
            : { ...this.defaultSelection(), persist: false }
        run = this.allocateRun(sessionId, task.summary.mode ?? 'agent', selection, recorded, foldersOf(task.summary, recorded), personal)
        let context: string
        try {
          context = fileMentionContext(prompt, fileRefs, foldersOf(task.summary, recorded))
        } catch {
          throw new AppError(400, 'file-reference-invalid', '文件引用无效。')
        }
        if (fileRefs.length && task.summary.mode === 'chat')
          throw new AppError(415, 'file-references-unavailable', '只对话模式不能引用项目文件。')
        this.assertAttachments(run, [...attachments, ...task.history.flatMap(message => message.attachmentRefs ?? [])])
        const at = isoTime(run.clock.startedAt)
        task.history.push({ role: 'user', content: context, ...(attachments.length ? { attachmentRefs: attachments } : {}) })
        task.messages.push({
          id: run.userMessageId,
          role: 'user',
          text: prompt,
          ...(task.summary.mode === 'chat' ? {} : { turnId: run.id }),
          requestId,
          ...(options.queuedAt ? { queuedAt: options.queuedAt } : {}),
          ...(fileRefs.length ? { fileRefs } : {}),
          createdAt: at,
          ...(attachments.length ? { attachments } : {}),
        })
        if (personal) task.summary.pluginIds = [...personal.pluginIds]
        task.summary.status = 'running'
        task.summary.runId = run.id
        delete task.summary.runOutcome
        delete task.summary.runEnd
        task.skillContext = skillContext(run.lease)
        if (run.lease.skills?.length) task.summary.skills = run.lease.skills.map(skill => skill.id)
        else delete task.summary.skills
        task.summary.model = run.model
        if (selection.persist || personal) task.summary.providerId = selection.providerId
        task.summary.updatedAt = at
        task.revision++
        draft.receipts[key] = { taskId: sessionId, payloadHash }
      }, sessionId)
      if (run) this.launch(run)
    } catch (error) {
      if (run) this.releaseRun(run)
      throw error
    }
  }

  async remove(sessionId: string): Promise<void> {
    await this.ready()
    await this.commit(draft => {
      const task = this.task(draft, sessionId)
      if (this.runs.has(sessionId) || task.summary.status === 'running' || task.summary.status === 'waiting-approval') {
        throw new AppError(409, 'task-running', '任务仍在运行，请先取消或等待完成后再删除')
      }
      delete draft.tasks[sessionId]
      draft.tombstones = { ...draft.tombstones, [sessionId]: { deletedAt: this.now() } }
    })
    this.fileTracking.dispose(sessionId)
    this.live.delete(sessionId)
  }

  private allocateRun(
    sessionId: string,
    mode: TaskMode,
    selection: Selection,
    cwd: string,
    folders: ProjectFolder[],
    personal?: PersonalExecutionContext,
  ): Run {
    if (this.closed) throw new AppError(503, 'runtime-closed', '运行节点已关闭')
    // Chat runs never use tools, so they must not pin tool plugins either.
    const lease = this.options.registry.acquire(selection.providerId, {
      tools: mode === 'agent',
      ...(personal
        ? { pluginIds: personal.pluginIds, ...(personal.expectedRevisions ? { expectedRevisions: personal.expectedRevisions } : {}) }
        : {}),
    })
    const model = selection.model ?? lease.provider.model
    const available = lease.provider.models?.length ? lease.provider.models : [lease.provider.model]
    if (!available.includes(model)) {
      lease.release()
      throw selection.source === 'request'
        ? new AppError(400, 'model-unavailable', `模型服务 ${lease.provider.name} 未启用模型 ${model}`)
        : new AppError(409, 'model-unavailable', `模型 ${model} 已不可用，请切换模型后继续`)
    }
    let resolveDone!: () => void
    const done = new Promise<void>(resolve => {
      resolveDone = resolve
    })
    const clock = new RunClock(this.clock)
    const run: Run = {
      id: randomUUID(),
      sessionId,
      mode,
      model,
      providerId: selection.providerId,
      userMessageId: randomUUID(),
      ...(personal ? { instructions: personal.instructions } : {}),
      ...(personal?.sharedMessages
        ? { sharedMessages: personal.sharedMessages.map(message => ({ role: message.role, content: message.text })) }
        : {}),
      clock,
      cwd,
      folders,
      controller: new AbortController(),
      lease,
      done,
      resolveDone,
      activity: { phase: 'model', since: isoTime(clock.startedAt) },
      lastEventAt: clock.startedAt,
    }
    // Reserve ownership before persistence publishes the new running task.
    this.runs.set(sessionId, run)
    return run
  }

  private releaseRun(run: Run): void {
    if (this.runs.get(run.sessionId) === run) this.runs.delete(run.sessionId)
    try {
      run.lease.release()
    } finally {
      run.resolveDone()
    }
  }

  private launch(run: Run): void {
    if (this.closed) run.controller.abort(new Error('Runtime closed'))
    void this.drive(run)
      .finally(() => {
        this.releaseRun(run)
        this.notify(run.sessionId)
      })
      .catch(() => {}) // drive records execution errors; storage failure remains fail-closed.
  }

  async cancel(sessionId: string, options: CancelOptions = {}): Promise<boolean> {
    await this.ready()
    this.task(this.state, sessionId)
    const run = this.runs.get(sessionId)
    // Checked before anything awaits, so a run that starts after this point is never the one aborted.
    if (!run || (options.runId !== undefined && run.id !== options.runId)) return false
    this.phase(run, { phase: 'cancelling', ...(run.activity?.toolName ? { toolName: run.activity.toolName } : {}) })
    this.notify(sessionId)
    run.controller.abort(new Error('User cancelled'))
    // The result is acknowledged only after the provider/tool actually settles.
    await run.done
    if (this.storageFailure) throw new AppError(503, 'storage-unavailable', '执行已停止，但取消状态未能持久化')
    return true
  }

  approvals(): Approval[] {
    return [...this.pending.values()].filter(item => !item.claimed && !item.signal.aborted).map(item => structuredClone(item.value))
  }

  async decide(approvalId: string, decision: 'allow' | 'reject', options: DecideOptions = {}): Promise<boolean> {
    if (decision !== 'allow' && decision !== 'reject') throw new AppError(400, 'invalid-decision', '无效的审批决定')
    const pending = this.pending.get(approvalId)
    if (!pending || pending.claimed || pending.signal.aborted || this.closed) return false
    const via = options.via === 'this-mac' || options.via === 'other-device' ? options.via : undefined
    let note: string | undefined
    if (options.note !== undefined) {
      if (decision !== 'reject') throw new AppError(400, 'invalid-note', '只有拒绝时可以附上说明')
      const checked = rejectionNote(options.note)
      if (checked === null) throw new AppError(400, 'invalid-note', '说明最多 500 个字，不能包含控制字符、不可见字符或改变文字方向的字符')
      note = checked
    }
    let always = false
    if (options.optionId !== undefined) {
      const option = (pending.value.options ?? APPROVAL_OPTIONS).find(item => item.id === options.optionId)
      if (!option) throw new AppError(400, 'invalid-option', '无效的审批选项')
      const allows = option.kind === 'allow_once' || option.kind === 'allow_always'
      if (allows !== (decision === 'allow')) throw new AppError(400, 'invalid-decision', '审批决定与所选选项不一致')
      always = option.kind === 'allow_always'
    }
    // Allowing a call in folders that left the project would act on a grant the owner withdrew.
    if (decision === 'allow') {
      const task = Object.hasOwn(this.state.tasks, pending.value.sessionId) ? this.state.tasks[pending.value.sessionId] : undefined
      if (!task || !this.stillListed(task.summary)) throw workspaceChanged()
    }
    pending.claimed = true // Claim synchronously, before any awaiting caller can compete.
    pending.resolve({ decision, always, at: this.now(), ...(via ? { via } : {}), ...(note ? { note } : {}) })
    this.notify(pending.value.sessionId)
    return true
  }

  subscribe(listener: (sessionId?: string) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(sessionId?: string): void {
    for (const listener of this.listeners) {
      try {
        listener(sessionId)
      } catch {
        /* One subscriber cannot prevent execution or other updates. */
      }
    }
  }

  /** Side-effect-free description of a call; a failing or missing preview never blocks the call. */
  private async preview(run: Run, call: ToolCall, tool: ToolDefinition): Promise<Preview | undefined> {
    if (!tool.preview) return undefined
    try {
      return previewOf(
        await tool.preview(structuredClone(call.arguments), {
          workspaceRoot: run.cwd,
          workspaceFolders: toolFolders(run),
          signal: run.controller.signal,
        }),
      )
    } catch {
      return undefined
    }
  }

  /** Fails closed: a classifier that throws or returns anything else yields R2. */
  private async risk(run: Run, call: ToolCall, tool: ToolDefinition): Promise<RiskLevel> {
    if (!this.options.classifyToolCall) return tool.requiresApproval ? 'R1' : 'R0'
    let level: unknown
    try {
      level = await this.options.classifyToolCall({
        toolName: call.name,
        arguments: structuredClone(call.arguments),
        cwd: run.cwd,
        sessionId: run.sessionId,
        folders: structuredClone(run.folders),
      })
    } catch {
      level = 'R2'
    }
    return RISK_LEVELS.has(level) ? (level as RiskLevel) : 'R2'
  }

  private async approval(
    run: Run,
    call: ToolCall,
    tool: ToolDefinition,
    preview: Preview | undefined,
    risk: 'R1' | 'R2',
  ): Promise<Decision> {
    const signal = run.controller.signal
    const value: Approval = {
      id: randomUUID(),
      sessionId: run.sessionId,
      toolName: call.name,
      toolCallId: call.id,
      reason:
        risk === 'R2'
          ? '这是高风险操作，每次执行前都需要你确认，不能设为始终允许。'
          : '该工具可能修改工作区或产生外部副作用，需要你确认本次操作。',
      arguments: JSON.stringify(call.arguments, null, 2),
      requestedAt: this.now(),
      options: structuredClone([...(risk === 'R2' ? HIGH_RISK_APPROVAL_OPTIONS : APPROVAL_OPTIONS)]),
      tool: {
        ...toolFacts(tool),
        title: preview?.title ?? call.name,
        ...(preview?.diffs ? { diffs: preview.diffs } : {}),
      },
      risk,
    }
    let settle!: PendingApproval['resolve']
    const decision = new Promise<Decision>(resolve => {
      settle = resolve
    })
    const pending: PendingApproval = { value, claimed: false, resolve: settle, signal }
    const abort = (): void => {
      pending.claimed = true
      settle({ decision: 'cancel', at: this.now() })
    }
    let outcome: Decision | undefined
    this.pending.set(value.id, pending)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    // The wait is measured from the moment the approval is published until it is answered or withdrawn.
    run.clock.openWait(value.id)
    try {
      if (!signal.aborted) this.phase(run, { phase: 'approval', toolName: call.name })
      this.output(run)
      await this.change(run.sessionId, task => {
        task.approval = value
        task.summary.status = 'waiting-approval'
        const message = toolMessage(task, call)
        if (message) {
          message.state = 'awaiting-approval'
          message.tool = { ...message.tool, ...preview }
        }
      })
      outcome = await decision
      return outcome
    } finally {
      signal.removeEventListener('abort', abort)
      this.pending.delete(value.id)
      run.clock.closeWait(value.id)
      await this.change(run.sessionId, task => {
        delete task.approval
        task.summary.status = 'running'
        const message = toolMessage(task, call)
        if (message) message.tool = { ...message.tool, decision: decisionRecord(outcome ?? { decision: 'cancel', at: this.now() }) }
        if (risk === 'R1' && outcome?.decision === 'allow' && outcome.always && !task.allowedTools?.includes(call.name)) {
          task.allowedTools = [...(task.allowedTools ?? []), call.name]
        }
      })
    }
  }

  private async execute(run: Run, call: ToolCall, tool: ToolDefinition | undefined): Promise<void> {
    const signal = run.controller.signal
    signal.throwIfAborted()
    if (!tool) {
      this.output(run)
      await this.change(run.sessionId, task =>
        recordResult(task, call, this.now(), `UNKNOWN_TOOL: 工具 ${call.name} 在本次运行的插件版本中不存在。`, true),
      )
      return
    }
    const risk = await this.risk(run, call, tool)
    signal.throwIfAborted()
    let preview: Preview | undefined
    if (tool.requiresApproval || risk !== 'R0') preview = await this.preview(run, call, tool)
    signal.throwIfAborted()
    if (risk !== 'R0') {
      // An R1 tool the user allowed for this session still shows its preview and result, without asking again.
      // R2 ignores that allowance and asks every time.
      if (risk === 'R2' || !this.task(this.state, run.sessionId).allowedTools?.includes(call.name)) {
        const answer = await this.approval(run, call, tool, preview, risk)
        signal.throwIfAborted()
        if (answer.decision !== 'allow') {
          this.output(run)
          const text = answer.note ? `${REJECTED}用户的说明：${answer.note}` : REJECTED
          await this.change(run.sessionId, task => recordResult(task, call, this.now(), text, true))
          return
        }
      }
    }
    run.running = { name: toolTitleOf(tool) ?? call.name, command: tool.kind === 'execute' }
    this.phase(run, { phase: 'tool', toolName: call.name })
    this.output(run)
    await this.change(run.sessionId, task => {
      task.batch?.started.push(call.id)
      const message = toolMessage(task, call)
      if (message) {
        message.state = 'running'
        message.startedAt = this.now()
        if (preview) message.tool = { ...message.tool, ...preview }
      }
    })
    if (signal.aborted) {
      // The stop came before the tool was called: it did not run, so its result is not unknown.
      await this.change(run.sessionId, task => {
        if (task.batch) task.batch.started = task.batch.started.filter(id => id !== call.id)
      })
      signal.throwIfAborted()
    }
    const waitKey = `tool:${call.id}`
    if (tool.waitsForUser) {
      run.clock.openWait(waitKey)
      this.phase(run, { phase: 'approval', toolName: call.name })
      await this.change(run.sessionId, task => {
        task.summary.status = 'waiting-approval'
      })
    }
    let result: { text: string }
    try {
      result = await tool.execute(structuredClone(call.arguments), {
        sessionId: run.sessionId,
        callId: call.id,
        workspaceRoot: run.cwd,
        workspaceFolders: toolFolders(run),
        signal,
      })
      if (!result || typeof result.text !== 'string') throw new Error('Tool returned an invalid result')
    } catch (error) {
      const text = signal.aborted
        ? 'TOOL_CANCELLED: 工具已响应取消。已经发生的副作用不会自动撤销，请核对工作区。'
        : `TOOL_ERROR: ${error instanceof Error ? error.message : String(error)}`
      this.output(run)
      await this.change(run.sessionId, task => recordResult(task, call, this.now(), text, true, signal.aborted))
      await tool.resultCommitted?.({ sessionId: run.sessionId, callId: call.id, state: signal.aborted ? 'cancelled' : 'failed' })
      signal.throwIfAborted()
      return
    } finally {
      if (tool.waitsForUser) {
        run.clock.closeWait(waitKey)
        await this.change(run.sessionId, task => {
          task.summary.status = 'running'
        })
      }
    }
    // A completed result remains true even if cancellation raced its completion.
    this.output(run)
    await this.change(run.sessionId, task => recordResult(task, call, this.now(), result.text, false))
    await tool.resultCommitted?.({ sessionId: run.sessionId, callId: call.id, state: 'completed' })
  }

  /** The times and model of an assistant step's message. */
  private stepTimes(run: Run, step: LiveStep, completedAt: string, reasoningMs: number | undefined): Partial<Message> {
    return {
      createdAt: isoTime(step.createdAt),
      completedAt,
      ...(reasoningMs !== undefined ? { reasoningMs } : {}),
      model: run.model,
      providerId: run.providerId,
    }
  }

  private attachments(refs: AttachmentRef[] | undefined): AttachmentRef[] {
    if (refs === undefined) return []
    if (!Array.isArray(refs) || refs.length > 8 || !refs.every(isAttachmentRef) || new Set(refs.map(ref => ref.id)).size !== refs.length)
      throw new AppError(400, 'attachment-invalid', '附件引用无效。')
    if (refs.some(ref => ref.kind === 'text' && ref.size > 256 * 1024))
      throw new AppError(415, 'attachment-text-too-large', 'Latch 内置只接受 256 KB 以内的文本附件。')
    return structuredClone(refs)
  }
  private assertAttachments(run: Run, refs: readonly AttachmentRef[]): void {
    if (refs.length && !this.options.readAttachment) throw new AppError(415, 'attachments-unsupported', '当前 Harness 尚未接入附件读取。')
    if (refs.some(ref => ref.kind === 'image') && run.lease.provider.modelCapabilities?.[run.model]?.vision !== true)
      throw new AppError(415, 'model-vision-unsupported', '当前模型不能看图片。')
  }

  private async drive(run: Run): Promise<void> {
    const signal = run.controller.signal
    let status: TaskStatus = 'idle'
    let failure: string | undefined
    try {
      if (run.mode === 'agent') await this.fileTracking.start(run.sessionId, run.id, run.folders)
      signal.throwIfAborted()
      const availableTools = run.mode === 'chat' ? [] : run.lease.tools
      const tools = new Map(availableTools.map(tool => [tool.name, tool]))
      for (let step = 0; step < this.maxSteps; step++) {
        signal.throwIfAborted()
        const live: LiveStep = {
          id: randomUUID(),
          text: '',
          reasoning: '',
          createdAt: this.clock(),
          reasoningTimer: new ReasoningTimer(this.clock),
        }
        this.phase(run, { phase: 'model' })
        this.live.set(run.sessionId, live)
        this.notify(run.sessionId)
        const task = this.task(this.state, run.sessionId)
        const messages: ModelMessage[] = await Promise.all(
          task.history.map(async item => {
            const { attachmentRefs, ...message } = structuredClone(item)
            if (!attachmentRefs?.length) return message
            this.assertAttachments(run, attachmentRefs)
            const attachments = await Promise.all(attachmentRefs.map(ref => this.options.readAttachment!(ref, signal)))
            return { ...message, attachments }
          }),
        )
        if (run.sharedMessages) messages.unshift(...structuredClone(run.sharedMessages))
        if (task.skillContext) messages.unshift({ role: 'system', content: task.skillContext })
        if (run.instructions) messages.unshift({ role: 'system', content: run.instructions })
        const seen = new Set(messages.flatMap(message => message.toolCalls?.map(call => call.id) ?? []))
        const calls: ToolCall[] = []
        let finished = false
        for await (const delta of run.lease.provider.stream({ messages, tools: [...availableTools], signal, model: run.model })) {
          run.lastEventAt = this.clock()
          signal.throwIfAborted()
          if (finished) throw new AppError(502, 'provider-protocol', '模型在结束事件之后继续发送内容')
          if (delta.type === 'text' || delta.type === 'reasoning') {
            live[delta.type === 'text' ? 'text' : 'reasoning'] += delta.text
            if (live.text.length + live.reasoning.length > MAX_OUTPUT)
              throw new AppError(502, 'response-too-large', '模型输出超过本次运行限制')
            if (delta.type === 'reasoning') live.reasoningTimer.reasoning()
            else live.reasoningTimer.text()
            this.output(run)
            this.notify(run.sessionId)
          } else if (delta.type === 'tool-call') {
            if (run.mode === 'chat')
              throw new AppError(502, 'chat-tools-disabled', '普通对话模式不允许调用工具；本次工具请求已拒绝，未执行任何操作。')
            const call = safeCall(delta.call)
            if (seen.has(call.id) || calls.length >= 32) throw new AppError(502, 'provider-protocol', '模型返回重复工具标识或过多工具调用')
            seen.add(call.id)
            calls.push(call)
          } else if (delta.type === 'usage') live.usage = addUsage(live.usage, delta)
          else if (delta.type === 'finish') finished = true
        }
        signal.throwIfAborted()
        if (!finished) throw new AppError(502, 'provider-incomplete', '模型连接结束时未收到完成事件，未派发本次工具调用')
        const { id, text, reasoning, usage } = live
        const completedAt = this.now()
        const reasoningMs = live.reasoningTimer.end()
        this.output(run)
        await this.change(run.sessionId, current => {
          // Reasoning is shown to the user but never replayed to the model.
          current.history.push({ role: 'assistant', content: text, ...(calls.length ? { toolCalls: calls } : {}) })
          if (text || reasoning) {
            current.messages.push({
              id,
              role: 'assistant',
              text,
              state: 'completed',
              ...(reasoning ? { reasoning } : {}),
              ...(usage ? { usage } : {}),
              ...this.stepTimes(run, live, completedAt, reasoningMs),
            })
          }
          if (usage) current.summary.usage = addUsage(current.summary.usage, usage)
          if (calls.length) {
            current.batch = { calls, started: [], completed: [] }
            for (const call of calls) {
              const input = JSON.stringify(call.arguments, null, 2)
              current.messages.push({
                id: `tool:${call.id}`,
                role: 'tool',
                toolName: call.name,
                text: input,
                state: 'queued',
                tool: { ...toolFacts(tools.get(call.name)), title: call.name, input },
                createdAt: completedAt,
              })
            }
          }
        })
        this.live.delete(run.sessionId)
        if (!calls.length) return
        for (const call of calls) await this.execute(run, call, tools.get(call.name))
        await this.change(run.sessionId, current => {
          delete current.batch
        })
      }
      throw new AppError(409, 'step-limit', `已达到 ${this.maxSteps} 步运行上限，请检查结果后发起新的输入`)
    } catch (error) {
      status = signal.aborted ? 'cancelled' : 'failed'
      failure = signal.aborted ? undefined : error instanceof Error ? error.message : String(error)
    } finally {
      // Present only while the step's output is uncommitted; the step commit removes it.
      const partial = this.live.get(run.sessionId)
      let outputMessageId: string | undefined
      try {
        const at = this.now()
        const reasoningMs = partial?.reasoningTimer.end()
        await this.change(run.sessionId, task => {
          const unknown = closeBatch(task, signal.aborted, at)
          if (unknown.length) task.summary.runEnd = runEndRecord(this.closed ? 'host-stopped' : 'turn-ended', at, unknown)
          delete task.approval
          if (partial && (partial.text || partial.reasoning) && !task.messages.some(message => message.id === partial.id)) {
            if (partial.text) task.history.push({ role: 'assistant', content: partial.text })
            task.messages.push({
              id: partial.id,
              role: 'assistant',
              text: partial.text,
              state: signal.aborted ? 'cancelled' : 'failed',
              ...(partial.reasoning ? { reasoning: partial.reasoning } : {}),
              ...(partial.usage ? { usage: partial.usage } : {}),
              ...this.stepTimes(run, partial, at, reasoningMs),
            })
          }
          if (partial?.usage) task.summary.usage = addUsage(task.summary.usage, partial.usage)
          task.summary.status = signal.aborted ? 'cancelled' : status
          task.summary.runOutcome =
            task.summary.status === 'idle' ? 'completed' : task.summary.status === 'cancelled' ? 'cancelled' : 'failed'
          if (failure) task.messages.push({ id: randomUUID(), role: 'system', text: failure, state: 'failed', createdAt: at })
          const prompt = task.messages.find(message => message.id === run.userMessageId)
          if (prompt) prompt.turn = run.clock.turn()
          const result = this.fileTracking.capture(run.id)
          if (result) {
            const turn = task.messages.slice(
              Math.max(
                0,
                task.messages.findIndex(message => message.id === run.userMessageId),
              ),
            )
            const target = turn.findLast(message => message.role === 'assistant') ?? turn.at(-1)
            if (target) {
              recordFileOutputs(target, result, true)
              outputMessageId = target.id
            }
          }
        })
      } finally {
        this.live.delete(run.sessionId)
        delete run.activity
        this.fileTracking.finish(run.id, async result => {
          await this.commit(next => {
            const task = next.tasks[run.sessionId]
            const message = task?.messages.find(item => item.id === outputMessageId)
            if (message && task) {
              recordFileOutputs(message, result)
              task.revision++
            }
          })
          this.notify(run.sessionId)
        })
      }
    }
  }
}
