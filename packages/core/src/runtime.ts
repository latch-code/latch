import { createHash, randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type {
  Approval,
  ApprovalOption,
  Message,
  ModelRef,
  RiskLevel,
  TaskDetail,
  TaskMode,
  TaskStatus,
  TaskSummary,
  TokenUsage,
  ToolDetail,
} from '@latch/protocol'
import {
  AppError,
  type CapabilityLease,
  type RuntimeRegistry,
  type ToolCall,
  type ToolDefinition,
  type ToolRiskInput,
  type Bridge,
  type CreateTaskInput,
  type DecideOptions,
  type PromptOptions,
} from '@latch/sdk'
import { createSnapshotStore, emptyRuntimeState } from './store.ts'
import type { RuntimeState, RuntimeStore, StoredTask } from './store.ts'

export interface RuntimeOptions {
  dataDir: string
  /** Working directory of sessions created without `cwd`. */
  workspaceRoot: string
  /** Directories a session may use as `cwd`, compared by real path. Defaults to `[workspaceRoot]`. */
  workspaces?: () => string[]
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

type Decision = { decision: 'allow' | 'reject' | 'cancel'; always?: boolean }
type Preview = Pick<ToolDetail, 'title' | 'diffs'>

interface PendingApproval {
  value: Approval
  claimed: boolean
  resolve(decision: Decision): void
  signal: AbortSignal
}
interface Run {
  id: string
  sessionId: string
  mode: TaskMode
  /** Model ID sent to the provider for every step of this run. */
  model: string
  /** The session's working directory, passed to tools. */
  cwd: string
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

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
function now(): string {
  return new Date().toISOString()
}
function assertPrompt(prompt: string, requestId: string): void {
  if (!prompt.trim() || prompt.length > 1_000_000) throw new AppError(400, 'invalid-prompt', '请输入不超过 1 MB 的任务内容')
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
function addUsage(total: TokenUsage | undefined, delta: { inputTokens: unknown; outputTokens: unknown }): TokenUsage {
  return {
    inputTokens: (total?.inputTokens ?? 0) + tokens(delta.inputTokens),
    outputTokens: (total?.outputTokens ?? 0) + tokens(delta.outputTokens),
  }
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
async function canonical(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path))
}

function toolMessage(task: StoredTask, call: ToolCall): Message | undefined {
  return task.messages.find(message => message.id === `tool:${call.id}`)
}

function recordResult(task: StoredTask, call: ToolCall, text: string, isError: boolean, cancelled = false): void {
  task.history.push({ role: 'tool', content: text, toolCallId: call.id, isError })
  const previous = toolMessage(task, call)
  const message: Message = {
    id: `tool:${call.id}`,
    role: 'tool',
    toolName: call.name,
    text,
    state: cancelled ? 'cancelled' : isError ? 'failed' : 'completed',
    tool: { ...(previous?.tool ?? { title: call.name, input: JSON.stringify(call.arguments, null, 2) }), output: text },
  }
  if (previous) Object.assign(previous, message)
  else task.messages.push(message)
  task.batch?.completed.push(call.id)
}

/** Balance unanswered calls without retrying an operation whose side effects are unknown. */
function closeBatch(task: StoredTask, cancelled: boolean): void {
  const batch = task.batch
  if (!batch) return
  for (const call of batch.calls) {
    if (batch.completed.includes(call.id)) continue
    const unknown = batch.started.includes(call.id)
    recordResult(
      task,
      call,
      unknown
        ? 'TOOL_OUTCOME_UNKNOWN: 执行未取得已确认结果。请先核对实际副作用；系统不会自动重放此操作。'
        : 'TOOL_NOT_STARTED: 本次运行已结束，工具没有开始执行。',
      true,
      cancelled && !unknown,
    )
  }
  delete task.batch
}

export function createRuntime(options: RuntimeOptions): Bridge {
  return new HarnessRuntime(options)
}

class HarnessRuntime implements Bridge {
  private readonly options: RuntimeOptions
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
    this.store = options.store ?? createSnapshotStore(options.dataDir)
    this.workspaceRoot = resolve(options.workspaceRoot)
    this.maxSteps = options.maxSteps ?? 12
    if (!Number.isSafeInteger(this.maxSteps) || this.maxSteps < 1 || this.maxSteps > 100)
      throw new Error('maxSteps must be between 1 and 100')
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new AppError(503, 'runtime-closed', '运行节点已关闭'))
    return (this.starting ??= (async () => {
      this.state = await this.store.load()
      const recovered = structuredClone(this.state)
      let changed = false
      for (const task of Object.values(recovered.tasks)) {
        if (task.summary.mode === undefined) {
          task.summary.mode = 'agent'
          changed = true
        }
        if (task.summary.status !== 'running' && task.summary.status !== 'waiting-approval' && !task.approval && !task.batch) continue
        closeBatch(task, false)
        delete task.approval
        task.summary.status = 'interrupted'
        task.summary.updatedAt = now()
        task.revision++
        task.messages.push({
          id: randomUUID(),
          role: 'system',
          text: '上次运行被中断。旧审批已失效；请核对工具副作用后再明确发起后续任务。',
          state: 'failed',
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
      for (const run of this.runs.values()) run.controller.abort(new Error('Runtime closed'))
      await Promise.all([...this.runs.values()].map(run => run.done))
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
      task.summary.updatedAt = now()
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
        .map(task => task.summary)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    )
  }

  async detail(sessionId: string): Promise<TaskDetail> {
    await this.ready()
    const task = this.task(this.state, sessionId)
    const active = task.summary.status === 'running' || task.summary.status === 'waiting-approval'
    const live = this.live.get(sessionId)
    const visibleLive = active && live && !task.messages.some(message => message.id === live.id) ? live : undefined
    return structuredClone({
      summary: task.summary,
      messages: task.messages,
      approvals: task.approval ? [task.approval] : [],
      liveText: visibleLive?.text ?? '',
      cursor: task.revision,
      ...(visibleLive ? { liveMessageId: visibleLive.id } : {}),
      ...(visibleLive?.reasoning ? { liveReasoning: visibleLive.reasoning } : {}),
      ...(active && this.runs.get(sessionId)?.activity ? { activity: this.runs.get(sessionId)!.activity } : {}),
    })
  }

  async createTask(input: CreateTaskInput): Promise<{ sessionId: string }> {
    await this.ready()
    assertPrompt(input.prompt, input.requestId)
    const mode = input.mode ?? 'agent'
    if (mode !== 'chat' && mode !== 'agent') throw new AppError(400, 'invalid-mode', '对话模式必须是 chat 或 agent')
    const model = input.model === undefined ? undefined : modelRef(input.model)
    if (input.cwd !== undefined && typeof input.cwd !== 'string') throw new AppError(400, 'workspace-unavailable', '项目目录无效')
    const cwd = input.cwd === undefined ? this.workspaceRoot : await this.workspaceFor(input.cwd)
    const key = digest(['create', input.requestId])
    // Selection keys join the hash only when given, so receipts written before they existed still match.
    const payloadHash = digest({
      prompt: input.prompt,
      mode,
      ...(model ? { model } : {}),
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
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
            mode === 'agent'
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
        const selection: Selection = model ? { ...model, source: 'request', persist: true } : this.defaultSelection()
        run = this.allocateRun(`task-${randomUUID()}`, mode, selection, cwd)
        const sessionId = run.sessionId
        draft.tasks[sessionId] = {
          summary: {
            id: sessionId,
            title: input.prompt.trim().replace(/\s+/g, ' ').slice(0, 80),
            status: 'running',
            updatedAt: now(),
            cwd,
            model: run.model,
            mode,
            ...(selection.persist ? { providerId: selection.providerId } : {}),
          },
          messages: [{ id: randomUUID(), role: 'user', text: input.prompt }],
          history: [{ role: 'user', content: input.prompt }],
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
    assertPrompt(prompt, requestId)
    const model = options.model === undefined ? undefined : modelRef(options.model)
    const key = digest(['prompt', sessionId, requestId])
    const payloadHash = digest(model ? { prompt, model } : prompt)
    // A session's cwd never changes, so the asynchronous check can precede the commit.
    const recorded = Object.hasOwn(this.state.tasks, sessionId) ? this.state.tasks[sessionId]!.summary.cwd : undefined
    const workspace = await this.workspaceFor(recorded)
    let run: Run | undefined
    try {
      await this.commit(draft => {
        const task = this.task(draft, sessionId)
        const receipt = draft.receipts[key]
        if (receipt) {
          if (receipt.payloadHash !== payloadHash) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同输入')
          return
        }
        if (workspace === undefined || recorded === undefined) {
          throw new AppError(409, 'workspace-changed', '该任务属于另一个工作区。请切回原工作区继续，或在当前工作区创建新任务。')
        }
        if (this.runs.has(sessionId) || task.summary.status === 'running' || task.summary.status === 'waiting-approval') {
          throw new AppError(409, 'task-running', '任务仍在运行，请等待完成或先取消')
        }
        const selection: Selection = model
          ? { ...model, source: 'request', persist: true }
          : task.summary.providerId
            ? { providerId: task.summary.providerId, model: task.summary.model, source: 'session', persist: true }
            : { ...this.defaultSelection(), persist: false }
        run = this.allocateRun(sessionId, task.summary.mode ?? 'agent', selection, recorded)
        task.history.push({ role: 'user', content: prompt })
        task.messages.push({ id: randomUUID(), role: 'user', text: prompt })
        task.summary.status = 'running'
        task.summary.model = run.model
        if (selection.persist) task.summary.providerId = selection.providerId
        task.summary.updatedAt = now()
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
      draft.tombstones = { ...draft.tombstones, [sessionId]: { deletedAt: now() } }
    })
    this.live.delete(sessionId)
  }

  private allocateRun(sessionId: string, mode: TaskMode, selection: Selection, cwd: string): Run {
    if (this.closed) throw new AppError(503, 'runtime-closed', '运行节点已关闭')
    // Chat runs never use tools, so they must not pin tool plugins either.
    const lease = this.options.registry.acquire(selection.providerId, { tools: mode === 'agent' })
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
    const run: Run = {
      id: randomUUID(),
      sessionId,
      mode,
      model,
      cwd,
      controller: new AbortController(),
      lease,
      done,
      resolveDone,
      activity: { phase: 'model' },
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

  async cancel(sessionId: string): Promise<void> {
    await this.ready()
    this.task(this.state, sessionId)
    const run = this.runs.get(sessionId)
    if (!run) return
    run.activity = { phase: 'cancelling', ...(run.activity?.toolName ? { toolName: run.activity.toolName } : {}) }
    this.notify(sessionId)
    run.controller.abort(new Error('User cancelled'))
    // The result is acknowledged only after the provider/tool actually settles.
    await run.done
    if (this.storageFailure) throw new AppError(503, 'storage-unavailable', '执行已停止，但取消状态未能持久化')
  }

  approvals(): Approval[] {
    return [...this.pending.values()].filter(item => !item.claimed && !item.signal.aborted).map(item => structuredClone(item.value))
  }

  async decide(approvalId: string, decision: 'allow' | 'reject', options: DecideOptions = {}): Promise<boolean> {
    if (decision !== 'allow' && decision !== 'reject') throw new AppError(400, 'invalid-decision', '无效的审批决定')
    const pending = this.pending.get(approvalId)
    if (!pending || pending.claimed || pending.signal.aborted || this.closed) return false
    let always = false
    if (options.optionId !== undefined) {
      const option = (pending.value.options ?? APPROVAL_OPTIONS).find(item => item.id === options.optionId)
      if (!option) throw new AppError(400, 'invalid-option', '无效的审批选项')
      const allows = option.kind === 'allow_once' || option.kind === 'allow_always'
      if (allows !== (decision === 'allow')) throw new AppError(400, 'invalid-decision', '审批决定与所选选项不一致')
      always = option.kind === 'allow_always'
    }
    pending.claimed = true // Claim synchronously, before any awaiting caller can compete.
    pending.resolve({ decision, always })
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
      return previewOf(await tool.preview(structuredClone(call.arguments), { workspaceRoot: run.cwd, signal: run.controller.signal }))
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
      requestedAt: now(),
      options: structuredClone([...(risk === 'R2' ? HIGH_RISK_APPROVAL_OPTIONS : APPROVAL_OPTIONS)]),
      tool: {
        ...(tool.kind ? { kind: tool.kind } : {}),
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
      settle({ decision: 'cancel' })
    }
    let outcome: Decision | undefined
    this.pending.set(value.id, pending)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    try {
      if (!signal.aborted) run.activity = { phase: 'approval', toolName: call.name }
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
      await this.change(run.sessionId, task => {
        delete task.approval
        task.summary.status = 'running'
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
      await this.change(run.sessionId, task =>
        recordResult(task, call, `UNKNOWN_TOOL: 工具 ${call.name} 在本次运行的插件版本中不存在。`, true),
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
        const { decision } = await this.approval(run, call, tool, preview, risk)
        signal.throwIfAborted()
        if (decision !== 'allow') {
          await this.change(run.sessionId, task =>
            recordResult(task, call, 'APPROVAL_REJECTED: 用户拒绝了本次工具调用，未执行该操作。', true),
          )
          return
        }
      }
    }
    run.activity = { phase: 'tool', toolName: call.name }
    await this.change(run.sessionId, task => {
      task.batch?.started.push(call.id)
      const message = toolMessage(task, call)
      if (message) {
        message.state = 'running'
        if (preview) message.tool = { ...message.tool, ...preview }
      }
    })
    signal.throwIfAborted()
    let result: { text: string }
    try {
      result = await tool.execute(structuredClone(call.arguments), {
        sessionId: run.sessionId,
        callId: call.id,
        workspaceRoot: run.cwd,
        signal,
      })
      if (!result || typeof result.text !== 'string') throw new Error('Tool returned an invalid result')
    } catch (error) {
      const text = signal.aborted
        ? 'TOOL_CANCELLED: 工具已响应取消。已经发生的副作用不会自动撤销，请核对工作区。'
        : `TOOL_ERROR: ${error instanceof Error ? error.message : String(error)}`
      await this.change(run.sessionId, task => recordResult(task, call, text, true, signal.aborted))
      signal.throwIfAborted()
      return
    }
    // A completed result remains true even if cancellation raced its completion.
    await this.change(run.sessionId, task => recordResult(task, call, result.text, false))
  }

  private async drive(run: Run): Promise<void> {
    const signal = run.controller.signal
    let status: TaskStatus = 'idle'
    let failure: string | undefined
    try {
      const availableTools = run.mode === 'chat' ? [] : run.lease.tools
      const tools = new Map(availableTools.map(tool => [tool.name, tool]))
      for (let step = 0; step < this.maxSteps; step++) {
        signal.throwIfAborted()
        const live: LiveStep = { id: randomUUID(), text: '', reasoning: '' }
        run.activity = { phase: 'model' }
        this.live.set(run.sessionId, live)
        this.notify(run.sessionId)
        const task = this.task(this.state, run.sessionId)
        const messages = structuredClone(task.history)
        const seen = new Set(messages.flatMap(message => message.toolCalls?.map(call => call.id) ?? []))
        const calls: ToolCall[] = []
        let finished = false
        for await (const delta of run.lease.provider.stream({ messages, tools: [...availableTools], signal, model: run.model })) {
          signal.throwIfAborted()
          if (finished) throw new AppError(502, 'provider-protocol', '模型在结束事件之后继续发送内容')
          if (delta.type === 'text' || delta.type === 'reasoning') {
            live[delta.type === 'text' ? 'text' : 'reasoning'] += delta.text
            if (live.text.length + live.reasoning.length > MAX_OUTPUT)
              throw new AppError(502, 'response-too-large', '模型输出超过本次运行限制')
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
            })
          }
          if (usage) current.summary.usage = addUsage(current.summary.usage, usage)
          if (calls.length) {
            current.batch = { calls, started: [], completed: [] }
            for (const call of calls) {
              const input = JSON.stringify(call.arguments, null, 2)
              const kind = tools.get(call.name)?.kind
              current.messages.push({
                id: `tool:${call.id}`,
                role: 'tool',
                toolName: call.name,
                text: input,
                state: 'queued',
                tool: { ...(kind ? { kind } : {}), title: call.name, input },
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
      try {
        await this.change(run.sessionId, task => {
          closeBatch(task, signal.aborted)
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
            })
          }
          if (partial?.usage) task.summary.usage = addUsage(task.summary.usage, partial.usage)
          task.summary.status = signal.aborted ? 'cancelled' : status
          if (failure) task.messages.push({ id: randomUUID(), role: 'system', text: failure, state: 'failed' })
        })
      } finally {
        this.live.delete(run.sessionId)
        delete run.activity
      }
    }
  }
}
