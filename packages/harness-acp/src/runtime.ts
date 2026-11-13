import { RunFileTracking, recordFileOutputs } from '@latch/core/file-tracking'
import { fileMentionContext, modelIdKey, promptTitle, type FileMention } from '@latch/protocol'
import { checkedAttachments, promptBlocks } from './attachments.ts'
import {
  clearTakenProposals,
  readProposals,
  removeSessionSkills,
  skillsDirectory,
  skillsServer,
  writeSessionSkills,
} from './skills-server.ts'
import { browserServer } from './browser-server.ts'
import { mcpBridgeServer } from './mcp-bridge.ts'
import type { AttachmentRef, QuestionResult } from '@latch/protocol'
import {
  CURSOR_DECLINE_REPLY,
  CURSOR_QUESTION_METHOD,
  ELICITATION_METHOD,
  cursorAsk,
  cursorDeclineNote,
  elicitationAsk,
  type AgentAsk,
} from './questions.ts'
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type {
  AgentBrief,
  AgentExecutionContext,
  Approval,
  ApprovalOptionKind,
  Message,
  SessionConfigOption,
  RunEnd,
  RunLive,
  RoutedTurn,
  SessionPermission,
  DriverTaskDetail,
  TaskStatus,
  DriverTaskSummary,
  HarnessCatalogue,
  HarnessMcpReport,
  HarnessOwnMcp,
  CatalogueRead,
  ToolDecision,
  UnknownResult,
  UnrecognizedRequests,
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
  type ExternalSessionAdopt,
  type ExternalSessionList,
  type ExternalSessionLoad,
  type ExternalSessionPlace,
  type LaunchPreview,
  type ModelGatewayLease,
  type ToolGatewayCallContext,
  type ToolGatewayLease,
  type McpServerLease,
  type McpStartFailure,
  type ModelRoute,
  type ProjectFolder,
  type PromptOptions,
  type SetConfigOptions,
  type SteerOutcome,
} from '@latch/sdk'
import { canonicalJson, isoTime, maskKnownSecretsIn, ReasoningTimer, redactKnownSecrets, RunClock, sha256Hex } from '@latch/core/node-kit'
import { errorCodeOf, interruptedNote, runEndRecord } from '@latch/core/run-end'
import {
  catalogueReadOf,
  MAX_START_CHOICES,
  modelListCatalogue,
  shownCatalogue,
  START_ORDER,
  startCatalogue,
  startChoices,
  withModelOptions,
} from './catalogue.ts'
import { authFacts, reportedLogin, terminalLogins, type AuthFacts } from './auth.ts'
import { codexOptions, readCodexModels } from './codex-models.ts'
import { commandMoved, commandUnconfirmed, redactor, resolveCommand } from './command.ts'
import { openWire, wireArgs } from './wires/index.ts'
import { ConnectionClosed, ConnectionStopping, RequestTimeout, type ExitInfo } from './wires/process.ts'
import { ForkRefused, type AgentWire } from './wires/types.ts'
import { agentEnvironment, programPaths } from './environment.ts'
import {
  append,
  blockText,
  clip,
  configFromOptions,
  foldConfig,
  mergeTool,
  modelName,
  thinkingName,
  planEntries,
  pretty,
  settleAskedTool,
  settleTool,
  settleToolMessage,
  TOOL_TEXT_LIMIT,
  toolDetail,
  commandName,
  toolKind,
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
  type LaunchRoute,
  type ProfileSelection,
} from './permission.ts'
import type { AcpPermissionProfile, ExtensionRequest, ProjectedChild, RetryReport, ToolDenial } from './profiles/index.ts'
import { fingerprintProjectConfig, type ProjectConfig } from './project-config.ts'
import {
  AUTH_STATUS_METHOD,
  cancelRequest,
  chunkUpdate,
  clientCapabilities,
  compactionChunk,
  compactionUpdate,
  configUpdate,
  contentBlock,
  commandsUpdate,
  infoUpdate,
  initializeResult,
  modeUpdate,
  noticeUpdate,
  usageUpdate,
  permissionRequest,
  planUpdate,
  promptResult,
  providersList,
  PROTOCOL_VERSION,
  sessionList,
  RPC,
  RpcError,
  sessionState,
  FORK_METHOD,
  MCP_STATUS_METHOD,
  MCP_STATUS_UPDATE,
  ownMcpStatus,
  STEER_METHOD,
  steerResult,
  toolFields,
  updateEnvelope,
  type ContentBlock,
  type PermissionOption,
  type RpcId,
  type ToolFields,
} from './protocol.ts'
import {
  childText,
  childCall,
  MAX_CHILDREN,
  MAX_DEPTH,
  MAX_TRACKED,
  patchSubagent,
  settleSubagent,
  subagentRow,
  subagentTitle,
  subagentUpdate,
  upsertStep,
  type Child,
  type SubagentUpdate,
} from './subagents.ts'
import {
  adoptedMessages,
  captured,
  captureUpdate,
  historyNotSupported,
  isBusy,
  LIST_MAX,
  LIST_MS,
  LOAD_MS,
  newCapture,
  sessionBusy,
  type Capture,
} from './history.ts'
import { createAcpStore, emptyAcpState, type AcpRecord, type AcpState, type AcpStore, type AcpTask, type StartChoice } from './store.ts'
import type { AgentHealth, AgentRecord, ResolvedOptions } from './types.ts'
import { assertVersion } from './version.ts'

export const CLIENT_VERSION = '0.1.0'
const CANCELLED_OUTCOME = { outcome: { outcome: 'cancelled' } }
/** A read of the catalogue says nothing worth a long wait: it fails as 「没查到」 and the draft can still start. */
const READ_TIMEOUT_MS = 20_000
/** Adding to a turn is answered at once or not at all: past this its result is unknown. */
const STEER_TIMEOUT_MS = 30_000
const MAX_CUSTOM_MODELS = 32
const MAX_CUSTOM_MODEL = 256
const COMMAND_NAME_LIMIT = 200
const UNRECOGNIZED_METHOD_LIMIT = 200
const UNRECOGNIZED_METHODS = 8
const UNRECOGNIZED_PARAMS_LIMIT = 2000

/** The agent process of one session (or of a removed session being deleted) and what `initialize` reported. */
interface Live {
  /** Latch task this process serves; also names its private temporary directory. */
  key: string
  wire: AgentWire
  initialized: boolean
  capabilities: {
    resume: boolean
    /** `session/list`, which only bringing in an earlier session uses. */
    list: boolean
    load: boolean
    delete: boolean
    close: boolean
    additionalDirectories: boolean
    images: boolean
    embeddedContext: boolean
    /** `_session/steering` adds text to a running turn. */
    steer: boolean
    /** The agent logs out when asked. */
    logout: boolean
  }
  authMethods: Array<{ name: string; description?: string }>
  agentVersion?: string
  /**
   * ACP session → Latch task. Updates for unbound sessions, including the replay of a session's own load, are discarded,
   * except the replay of an earlier session being brought in (`capture`).
   */
  sessions: Map<string, string>
  /** The `session/load` of an agent's earlier session, whose replay is kept while it runs. */
  capture?: Capture
  /** Subagent sessions the agent announced on a bound session, by their ACP session. */
  children: Map<string, Child>
  idleTimer?: NodeJS.Timeout
  /** For choosing which idle process to stop when the process limit is reached. */
  lastUsed: number
  /** Methods already recorded in the transcript while no turn was running. */
  unrecognizedMethods?: Set<string>
  /** Lines of requests the profile answered before the process's session was recorded, written in once it is. */
  heldNotes?: string[]
  /** The process's token to the Host's gateway, for a session on a route; revoked when the process ends. */
  gateway?: ModelGatewayLease
  /**
   * The token of the session's `latch-browser` server to the Host's tool gateway: a fresh one each time the session is
   * opened, resumed, loaded or forked on a process; revoked when the next is issued, when the process ends and when the
   * turn is stopped its calls end.
   */
  tools?: ToolGatewayLease
  /** The tokens of the session's own MCP servers' `latch-mcp` bridges on this process, renewed as `tools` is. */
  mcp?: McpServerLease[]
}

/** How long 读取 of a harness's own MCP servers waits: the harness starts each one, `npx` downloads included. */
const MCP_READ_MS = 60_000

/** Why a Latch MCP server did not start, as the session says it. */
const MCP_FAILURE_TEXT: Readonly<Record<McpStartFailure, string>> = {
  'spawn-failed': '命令无法启动',
  exited: '进程已退出',
  timeout: '30 秒内没有完成初始化',
  protocol: '它的回答不是 MCP',
  'list-failed': '没有列出工具',
  'output-too-large': '输出过大',
  'auth-required': '需要登录（尚未实现）',
  unreachable: '无法连接',
  refused: 'Latch 没有连接这个地址',
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
  attachments?: AttachmentRef[]
  sensitiveOutput?: boolean
  imageCount?: number
  imageChain?: Promise<void>
  live?: Live
  acpSessionId?: string
  /** session/prompt was written; updates from now on belong to this turn. */
  sent: boolean
  cancelRequested: boolean
  activity: NonNullable<DriverTaskDetail['activity']>
  /** From the prompt to the turn's end, with the approval wait. */
  clock: RunClock
  /** The user message of this turn, once recorded; it carries the turn's times when the turn ends. */
  userMessageId?: string
  /** The last change of visible output, in clock milliseconds. */
  lastOutputAt?: number
  /** The last sign of life: anything the agent sent about this session, or the start of a phase. */
  lastEventAt: number
  /** The call the `tool` phase names. */
  runningTool?: ToolState
  /** Why the turn ended, when its process did. */
  end?: RunEnd['reason']
  /** Questions this turn has put to the person and still waits on: a stop or the turn's end withdraws them. */
  asking?: Set<AbortController>
  /** The note that says why the turn failed, and the error's code, so a client offers the next step that fits. */
  failure?: { note: string; code: string }
  unrecognized?: UnrecognizedRequests
  /** Methods already recorded in the transcript for this turn. */
  unrecognizedMethods?: Set<string>
  segment?: Segment
  graceTimer?: NodeJS.Timeout
  /** System notes appended once the turn settles, after its last reply. */
  notes: string[]
  /** A subagent of this turn got no row, and the turn's notes say so. */
  hiddenSubagents?: boolean
  /** Text added to this turn while it ran (`steer`), in flight or taken, and when the latest was sent. */
  steers?: number
  steeredAt?: number
  /** Gateway requests of the process when the prompt was sent, for a session on a route. */
  gatewayMark?: number
  /**
   * The row that reports the agent retrying a model call, and what it says. `pending` while the reply it cut off is still
   * live: the row goes after that reply, once the agent drops it to generate it again or it settles.
   */
  retry?: { id: string; interrupted: boolean; pending?: boolean; reason?: string; attempt?: { attempt: number; of: number } }
  done: Promise<void>
  resolveDone(): void
}

interface Permission {
  approval: Approval
  live: Live
  rpcId: RpcId
  taskId: string
  tool: ToolState
  /** Asked by this subagent: its call is a step of the subagent's row. */
  child?: Child
  /** Asked after its turn ended: the session's status once nothing waits. */
  statusAfter?: TaskStatus
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

/** The launch on record for a session, stored with it when it started. */
interface Confirmed {
  launchHash?: string
  definitionHash?: string
  /** The other folders the agent receives, which the launch covers. */
  folders?: LaunchFolders
  /** The gateway route the launch covers. */
  route?: ModelRoute
}

/** A previewed launch: its definition part, and the folders it passes (`''` for none). */
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

/** An earlier session of the agent, loaded on a process of its own for a preview or an adoption. */
interface ExternalLoad {
  /** The process's key. */
  key: string
  place: ExternalSessionPlace
  scope: Scope
  launch: Launch
  load: ExternalSessionLoad
}

interface Adopted {
  sessionId: string
  launchHash: string
  messageCount: number
  droppedBefore: number
}

const TASK_ID = /^task-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/** Recorded, and shown, as the observed mode when the agent stops reporting a mode it reported before. */
const UNREPORTED_MODE = '未报告'
/**
 * The ACP tool kinds that only look: in 只看不改 these are all a subagent may be allowed. Any other kind, `other`, a
 * missing one or one Latch does not know may change something, so it is refused as edits and commands are.
 */
const LOOKING_KINDS = new Set(['read', 'search', 'think', 'fetch'])

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
/** How long a turn waits for its browser calls to settle: the broker's 5 s for the desktop app, and a margin. */
const TOOL_SETTLE_MS = 7_000

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
function codeOf(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

const REVIEW_STATUS: Record<string, 'approved' | 'denied' | 'timed-out' | 'aborted'> = {
  approved: 'approved',
  denied: 'denied',
  timedOut: 'timed-out',
  aborted: 'aborted',
}

/**
 * The verdict of a review the harness reported: the status in the event it attached, else what a completed report says
 * (failed says only that it was not approved). Undefined while it runs.
 */
function reviewVerdict(state: ToolState): 'approved' | 'denied' | 'timed-out' | 'aborted' | 'unknown' | undefined {
  for (const raw of [state.rawOutput, state.rawInput]) {
    const review = typeof raw === 'object' && raw !== null ? (raw as { review?: unknown }).review : undefined
    const status = typeof review === 'object' && review !== null ? (review as { status?: unknown }).status : undefined
    if (typeof status === 'string' && Object.hasOwn(REVIEW_STATUS, status)) return REVIEW_STATUS[status]
  }
  if (state.status === 'completed') return 'approved'
  return state.status === 'failed' ? 'unknown' : undefined
}

/** A draft's choices as a start may carry them: each option once, IDs and values as a session's `config` bounds them. */
function checkedStartConfig(config: unknown): Array<{ configId: string; value: string }> {
  if (config === undefined) return []
  const invalid = () => new AppError(400, 'config-value-invalid', '开始前选的设置无效')
  if (!Array.isArray(config) || config.length > MAX_START_CHOICES) throw invalid()
  const seen = new Set<string>()
  return config.map((entry: unknown) => {
    const { configId, value } = (entry ?? {}) as Record<string, unknown>
    if (typeof configId !== 'string' || !configId || configId.length > 128 || typeof value !== 'string' || value.length > 1024)
      throw invalid()
    if (seen.has(configId)) throw invalid()
    seen.add(configId)
    return { configId, value }
  })
}

const WIRES = new Set<unknown>(['chat-completions', 'responses', 'anthropic-messages', 'gemini'])

/** The value of `option` that is `model`: the same ID, else the same model under the agent's spelling of it. */
function listedModel(option: SessionConfigOption, model: string): string | undefined {
  return (
    option.options.find(item => item.value === model)?.value
    ?? option.options.find(item => modelIdKey(item.value) === modelIdKey(model) || modelIdKey(item.name) === modelIdKey(model))?.value
  )
}

/**
 * The model choices of a session on a route: only models the gateway forwards. An agent given its model by name (`env`)
 * takes any of the service's models, whatever it lists itself; one that narrows its own list to the gateway's
 * (`providers`) keeps those of its options the service has, under its own values.
 */
function routedOptions(options: SessionConfigOption[], served: readonly string[], via: 'env' | 'providers'): SessionConfigOption[] {
  const keys = new Set(served.map(modelIdKey))
  return options.map(option => {
    if (option.category !== 'model') return option
    const kept =
      via === 'env'
        ? served.slice(0, 500).map(id => option.options.find(item => item.value === id) ?? { value: id, name: clip(id, 200) })
        : option.options.filter(item => keys.has(modelIdKey(item.value)) || keys.has(modelIdKey(item.name)))
    return { ...option, options: kept }
  })
}

/** The Host's route as a driver keeps it: only its four fields, each bounded. */
function checkedRoute(route: unknown): ModelRoute | undefined {
  if (route === undefined) return undefined
  const { providerId, model, wire, origin } = (route ?? {}) as Record<string, unknown>
  const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
  if (!text(providerId, 128) || !text(model, 200) || !WIRES.has(wire) || !text(origin, 300))
    throw new AppError(400, 'model-route-invalid', '模型服务的转发设置无效')
  return { providerId, model, wire: wire as ModelRoute['wire'], origin }
}

/** A fork's position, as a creation's payload names it. */
function forkKey(fork: unknown): { taskId: unknown; upToMessageId: unknown } {
  const { taskId, upToMessageId } = (fork ?? {}) as Record<string, unknown>
  return { taskId, upToMessageId }
}

/** The Host's fork as a driver keeps it: the source and position bounded, the text record a part of the prompt. */
function checkedFork(fork: unknown, prompt: string): NonNullable<AcpRecord['fork']> {
  const { taskId, upToMessageId, prefixLength } = (fork ?? {}) as Record<string, unknown>
  const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128
  if (
    !id(taskId)
    || !id(upToMessageId)
    || !Number.isSafeInteger(prefixLength)
    || (prefixLength as number) < 0
    || (prefixLength as number) > prompt.length
  )
    throw new AppError(400, 'fork-invalid', '分叉的位置无效')
  return { taskId, upToMessageId, prefixLength: prefixLength as number }
}

/** A choice made in the session replaces what the draft chose for that option. True when there was one. */
function forgetStartChoice(task: AcpTask, configId: string): boolean {
  const chosen = task.acp.startConfig
  if (!chosen?.some(choice => choice.configId === configId)) return false
  const left = chosen.filter(choice => choice.configId !== configId)
  if (left.length) task.acp.startConfig = left
  else delete task.acp.startConfig
  return true
}

function assertPrompt(prompt: unknown, requestId: unknown, attachments?: AttachmentRef[]): void {
  if (typeof prompt !== 'string' || (!prompt.trim() && !attachments?.length) || prompt.length > 1_000_000)
    throw new AppError(400, 'invalid-prompt', '请输入不超过 1 MB 的任务内容')
  if (typeof requestId !== 'string' || !requestId || requestId.length > 256)
    throw new AppError(400, 'invalid-request-id', '缺少有效的请求标识')
}

/** A start's prompt, or with a seed an empty one: the seed waits for the first message. */
function assertStart(input: CreateTaskInput): void {
  if (input.seed !== undefined) {
    if (
      typeof input.seed !== 'string'
      || !input.seed.trim()
      || input.seed.length > 1_000_000
      || input.prompt !== ''
      || input.attachments?.length
      || input.fork
    )
      throw new AppError(400, 'invalid-prompt', '请输入不超过 1 MB 的任务内容')
    assertPrompt(input.seed, input.requestId)
    return
  }
  assertPrompt(input.prompt, input.requestId, input.attachments)
}

function steerUnknown(): AppError {
  return new AppError(409, 'steer-unknown', '这条追加是否送达无法确认，没有重发；本轮结束后看回复再决定是否重发')
}

function cancelledBeforeSend(): AppError {
  return new AppError(409, 'cancelled-before-send', '已在发送给 Harness 之前取消')
}

function definitionChanged(): AppError {
  return new AppError(409, 'agent-definition-changed', 'Agent 定义已变化，该会话不能继续。请新建会话。')
}

function permissionDrift(): AppError {
  return new AppError(409, 'permission-drift', '该会话检测到权限模式漂移，已停止接收输入。请新建会话。')
}

function outsideProject(): AppError {
  return new AppError(409, 'history-outside-project', '这个会话不在所选项目的主文件夹里。')
}

function workspaceChanged(): AppError {
  return new AppError(409, 'workspace-changed', '这个会话使用的文件夹已不在项目中或找不到了，不能继续。请新建会话。')
}

function scopeUnavailable(): AppError {
  return new AppError(400, 'workspace-unavailable', '所选项目的文件夹与这台电脑记录的不一致')
}

/** How the folders a launch passes are compared: in order, with how they are passed. */
function foldersKey(folders: LaunchFolders | undefined): string {
  return folders?.paths.length ? JSON.stringify([folders.via, folders.paths]) : ''
}

/** The folders a session's stored launch passes, as `Confirmed` carries them. */
function storedFolders(acp: AcpRecord): LaunchFolders | undefined {
  return acp.folderVia && acp.folders?.length ? { via: acp.folderVia, paths: [...acp.folders] } : undefined
}

/** The launch on record for a session, from its stored record. */
function confirmedOf(acp: AcpRecord): Confirmed {
  const folders = storedFolders(acp)
  return {
    launchHash: acp.launchHash,
    definitionHash: acp.definitionHash,
    ...(folders ? { folders } : {}),
    ...(acp.route ? { route: acp.route } : {}),
  }
}

function isActive(summary: DriverTaskSummary): boolean {
  return summary.status === 'running' || summary.status === 'waiting-approval'
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

/** Recently previewed launch fingerprints kept to tell, at start, which part of a refused one changed. */
const PREVIEWS = 64
const DEFINITION_LOOKUP_MS = 5_000

function selected(optionId: string): unknown {
  return { outcome: { outcome: 'selected', optionId } }
}

/** The option a permission answer selected; undefined when it was cancelled. */
function chosenOption(result: unknown): string | undefined {
  const outcome = isObject(result) ? (result as { outcome?: unknown }).outcome : undefined
  if (!isObject(outcome)) return undefined
  const { outcome: kind, optionId } = outcome as { outcome?: unknown; optionId?: unknown }
  return kind === 'selected' && typeof optionId === 'string' ? optionId : undefined
}

/**
 * One agent process per Latch task, each with its own working directory, environment and temporary directory;
 * Latch task ↔ ACP session is 1:1. Every session is full access (L3): the agent's own permission mode and questions
 * are advisory, and Latch only refuses to continue when it cannot confirm that mode.
 */
/** The process went away or stopped answering while the session was being reattached, before a turn existed. */
const START_ERRORS = new Set(['agent-exited', 'agent-timeout'])
/** The agent answered with an error then (a thread in use elsewhere, a malformed answer). */
const REFUSED_ERRORS = new Set(['agent-error', 'agent-protocol'])

/**
 * A prompt refused while its session was being reattached: nothing was recorded, so the answer says so with a code of
 * `NOT_ACCEPTED_5XX` (`agent-start-failed`, `agent-refused`) instead of a 5xx a client must treat as result unknown.
 */
function notAccepted(error: unknown): unknown {
  if (!(error instanceof AppError)) return error
  if (START_ERRORS.has(error.code)) return new AppError(503, 'agent-start-failed', error.message)
  return REFUSED_ERRORS.has(error.code) ? new AppError(502, 'agent-refused', error.message) : error
}

export class AgentRuntime implements Bridge {
  private state: AcpState = emptyAcpState()
  private readonly fileTracking: RunFileTracking
  private readonly store: AcpStore
  private readonly workspaceRoot: string
  private readonly redact: (text: string) => string
  /** Every gateway token a process of this runtime was given, so that none is repeated in what it says. */
  private readonly tokens = new Set<string>()
  private readonly selection: ProfileSelection
  /** What this definition's processes say about logging in, shared with the driver that shows it. */
  private readonly auth: AuthFacts
  private readonly profile?: AcpPermissionProfile
  private readonly clock: () => number
  private readonly runs = new Map<string, Run>()
  private readonly permissions = new Map<string, Permission>()
  private readonly tools = new Map<string, { seq: number; calls: Map<string, ToolState> }>()
  /** Each session's read of its proposals file, one at a time. */
  private readonly proposalReads = new Map<string, Promise<void>>()
  /** Assistant text that arrived outside a turn and is being appended to a settled message. */
  private readonly stray = new Map<string, { id: string; acpMessageId?: string }>()
  /** What each compaction row says so far, by session and compaction ID; the row itself is the record. */
  private readonly compactions = new Map<string, { status: string; summary: string; error?: string }>()
  /** Setup of a task's ACP session; a cancel before session/prompt aborts it instead of killing the process. */
  private readonly attaching = new Map<string, { promise: Promise<Binding>; controller: AbortController }>()
  /** Earlier agent sessions loaded for a preview, by load ID, each on a process held for it. */
  private readonly external = new Map<string, ExternalLoad>()
  /** Adoptions in progress, by the session ID the Host chose. */
  private readonly adopting = new Map<string, { agentSessionId: string; promise: Promise<Adopted> }>()
  /** Background cleanup of removed tasks: session/delete, process stop, temporary directory. */
  private readonly forgetting = new Map<string, Promise<void>>()
  private readonly inflight = new Map<string, { payloadHash: string; promise: Promise<void> }>()
  private readonly steering = new Map<string, { payloadHash: string; promise: Promise<SteerOutcome> }>()
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
  /** Launch fingerprint → its definition part and folders, for launches recently previewed. */
  private readonly previews = new Map<string, Previewed>()
  /** New sessions whose agent is started, to learn whether it takes their folders, before they are recorded. */
  private readonly creating = new Map<string, { payloadHash: string; promise: Promise<{ sessionId: string }> }>()
  private definitionLookup?: { at: number; hash: string | undefined }
  /** The catalogue read in progress; every request while it runs shares it. */
  private reading?: Promise<{ ran: boolean }>
  private readingNow = false
  /** The harness's own MCP servers as it last reported them, for the definition it reported them under. Memory only. */
  private ownMcpState?: { definitionHash: string; last?: HarnessMcpReport; failed?: { at: string; message: string } }
  /** 读取 of the harness's own MCP servers in progress; a second request shares it. */
  private mcpReading?: Promise<void>
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
    this.fileTracking = new RunFileTracking({
      track: options.trackFiles,
      current: (id, runId) => this.state.tasks[id]?.summary.runId === runId,
      notify: id => this.notify(id),
    })
    this.workspaceRoot = resolve(options.workspaceRoot)
    const own = redactor(agent.env)
    // An agent's error may echo the gateway token it was given, or part of a key from its own configuration.
    this.redact = text =>
      redactKnownSecrets([...this.tokens].reduce((current, token) => current.split(token).join('[redacted]'), own(text)))
    this.selection = selectProfile(agent)
    this.auth = authFacts(agent, true)
    this.profile = this.selection.profile?.permission
    this.clock = options.clock ?? Date.now
  }

  private now(): string {
    return isoTime(this.clock())
  }

  /** Moves a turn to a phase; `since` changes only when the phase or its tool does. */
  private phase(run: Run, phase: NonNullable<DriverTaskDetail['activity']>['phase'], toolName?: string, since?: string): void {
    if (run.activity.phase === phase && run.activity.toolName === toolName && run.activity.since) return
    run.activity = { phase, ...(toolName !== undefined ? { toolName } : {}), since: since ?? this.now() }
    run.lastEventAt = this.clock()
  }

  /** Back to work after a call, a reply or an answer: a call still running is what the turn is doing. */
  private working(run: Run): void {
    const calls = this.tools.get(run.taskId)
    const running =
      calls?.seq === run.seq ? [...calls.calls.values()].findLast(state => state.status === 'in_progress' && !state.final) : undefined
    run.runningTool = running
    if (running) this.phase(run, 'tool', toolLabel(running))
    else this.phase(run, 'model')
  }

  /** What a live turn is doing, for its summary; the Host adds the silence thresholds. */
  private liveOf(run: Run): RunLive {
    const { phase, since } = run.activity
    const tool = phase === 'tool' ? run.runningTool : undefined
    return {
      runId: run.id,
      activity: phase === 'tool' ? (tool?.kind === 'execute' ? 'command' : 'tool') : phase,
      ...(tool ? { commandName: clip(this.redact(commandName(tool)), COMMAND_NAME_LIMIT) } : {}),
      since: since ?? isoTime(run.clock.startedAt),
      ...run.clock.live(),
      lastEventAt: isoTime(Math.max(run.lastEventAt, run.lastOutputAt ?? 0)),
      ...(run.lastOutputAt !== undefined ? { lastOutputAt: isoTime(run.lastOutputAt) } : {}),
      ...(run.unrecognized ? { unrecognized: run.unrecognized } : {}),
    }
  }

  /** The stored summary with what only the live turn knows, which is never stored. */
  private projected(task: AcpTask): DriverTaskSummary {
    const run = this.runs.get(task.summary.id)
    return run && isActive(task.summary) ? { ...task.summary, live: this.liveOf(run) } : task.summary
  }

  liveRuns(): Array<{ sessionId: string; live: RunLive }> {
    const found: Array<{ sessionId: string; live: RunLive }> = []
    for (const [sessionId, run] of this.runs) {
      const task = this.state.tasks[sessionId]
      if (task && isActive(task.summary)) found.push({ sessionId, live: this.liveOf(run) })
    }
    return found
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new AppError(503, 'runtime-closed', '运行节点已关闭'))
    return (this.started ??= (async () => {
      this.state = await this.store.load()
      this.loaded = true
      let changed = false
      for (const task of Object.values(this.state.tasks)) {
        for (const message of task.messages)
          if (message.outputsPending) {
            delete message.outputsPending
            message.outputsTruncated = true
            task.revision++
            changed = true
          }
        if (task.summary.status !== 'running' && task.summary.status !== 'waiting-approval') continue
        const at = this.now()
        const unknown = task.messages.flatMap(item =>
          item.role === 'tool' && item.state === 'running' && !item.subagent
            ? [{ messageId: item.id, name: item.tool?.title ?? item.toolName ?? 'tool' }]
            : [],
        )
        for (const item of task.messages) {
          if (item.subagent) settleSubagent(item, at, true)
          else if (settleToolMessage(item, at)) item.interrupted = true
        }
        task.summary.status = 'interrupted'
        task.summary.runOutcome = 'interrupted'
        task.summary.runEnd = runEndRecord('host-stopped', at, unknown)
        // The turn did not settle, so its user message gets no times: its duration is unknown.
        task.messages.push(interruptedNote(this.now()))
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
      this.fileTracking.dispose()
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
      await this.fileTracking.close()
      if (this.loaded) await this.flush().catch(() => {})
      try {
        await this.store.close()
      } finally {
        this.listeners.clear()
        this.onClosed?.()
      }
    })())
  }

  async listTasks(): Promise<DriverTaskSummary[]> {
    await this.ready()
    return structuredClone(
      Object.values(this.state.tasks)
        .map(task => this.projected(task))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    )
  }

  async detail(sessionId: string): Promise<DriverTaskDetail> {
    await this.ready()
    const task = this.task(sessionId)
    const run = this.runs.get(sessionId)
    const active = task.summary.status === 'running' || task.summary.status === 'waiting-approval'
    const segment = active ? run?.segment : undefined
    const detail: DriverTaskDetail = structuredClone({
      summary: this.projected(task),
      messages: task.messages,
      approvals: this.openApprovals(sessionId),
      liveText: segment?.text ?? '',
      cursor: task.revision,
      ...(this.fileTracking.projection(sessionId, task.summary.runId)
        ? { fileChanges: this.fileTracking.projection(sessionId, task.summary.runId) }
        : {}),
      ...(segment ? { liveMessageId: segment.id } : {}),
      ...(segment?.reasoning ? { liveReasoning: segment.reasoning, ...segment.reasoningTimer.live() } : {}),
      ...(active && run ? { activity: run.activity, ...run.clock.live() } : {}),
      ...(active && run?.lastOutputAt !== undefined ? { lastOutputAt: isoTime(run.lastOutputAt) } : {}),
      ...(task.usageReport ? { usageReport: task.usageReport } : {}),
      ...(task.commands ? { commands: task.commands } : {}),
      ...(task.plan ? { plan: task.plan } : {}),
      ...(task.config?.length ? { config: task.config } : {}),
      permission: this.permissionView(task),
      ...(active && run && this.steerable(run) ? { steer: true as const } : {}),
      clearContext: true,
      ...(task.acp.contextCleared ? { contextCleared: true as const } : {}),
    })
    this.markStops(sessionId, detail.messages)
    return detail
  }

  /**
   * Lets go of the agent's session so that the next bind opens a new one: what the person chose for the model, thinking
   * and the rest is set on it again, the mode is set and read back as for any session, and an agent's instructions go
   * with its first turn as they did with the session's first. Until a user message is recorded on the new session, the
   * task says its context was cleared, so the message that is (whether or not it asked) shows the boundary.
   */
  private clearContext(task: AcpTask): void {
    // A seed is for the first message of the session's context: a new context starts without it.
    delete task.acp.seed
    if (task.acp.contextCleared) return
    task.acp.contextCleared = true
    const prior = task.acp.acpSessionId
    if (prior !== undefined) {
      const chosen = task.acp.startConfig ?? []
      const carried = (task.config ?? [])
        .filter(option => !this.isModeOption(task, option) && !chosen.some(choice => choice.configId === option.id))
        .map(option => ({
          configId: option.id,
          value: option.currentValue,
          ...(option.category ? { category: option.category } : {}),
          label: option.options.find(item => item.value === option.currentValue)?.name ?? option.currentValue,
        }))
      if (carried.length) task.acp.startConfig = [...chosen, ...carried]
      delete task.acp.acpSessionId
      task.acp.earlierSessionIds = [...(task.acp.earlierSessionIds ?? []), prior]
      // The old session's context window and cost say nothing about the new one.
      delete task.usageReport
      delete task.plan
      const brief = task.messages.find(message => message.role === 'user' && message.agentBrief)?.agentBrief
      if (brief && !task.acp.brief) task.acp.brief = brief
      const live = this.lives.get(task.summary.id)
      if (live?.sessions.get(prior) === task.summary.id) {
        live.sessions.delete(prior)
        if (live.capabilities.close && !live.wire.stopping)
          void live.wire.request('session/close', { sessionId: prior }, this.limits.requestTimeoutMs).catch(() => {})
      }
    }
    this.touch(task)
    this.mark()
  }

  async launchPreview(input: {
    cwd: string
    workspaceId?: string
    folders?: ReadonlyArray<ProjectFolder>
    modelRoute?: ModelRoute
  }): Promise<LaunchPreview> {
    await this.ready()
    // The agent is given the registered path; configuration is looked up along it and along its real path.
    const given = await this.workspace(input.cwd)
    const cwd = await realpath(given)
    const passed = (await this.scopeOf(input, given))?.passed
    const project = await this.projectConfig(given, passed)
    const launch = this.currentLaunch(project, passed, input.modelRoute)
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
      ...(input.modelRoute ? { gatewayEnv: this.gatewayNames() } : {}),
    })
    return {
      launchHash: launch.hash,
      definitionHash: launch.definitionHash,
      command: launch.command,
      args: [...this.agent.args, ...wireArgs(this.selection.profile?.wire)],
      envNames: Object.keys(env).sort(),
      definitionEnvNames: Object.keys(this.agent.env).sort(),
      cwd,
      ...(passed ? { folders: [...passed.paths] } : {}),
      ...(this.selection.preset ? { presetId: this.selection.preset.id } : {}),
      // Looked up again for every start: whether the command is the preset's own depends on where the Host finds it now.
      verified: selectProfile(this.agent).verified,
      approvals: this.profile?.approvals ?? 'prompts',
      readback: this.profile?.readback ?? 'none',
    }
  }

  catalogue(): HarnessCatalogue | undefined {
    const stored = this.state.catalogue
    if (!this.loaded || !stored || this.definitionNow() !== stored.definitionHash) return undefined
    return shownCatalogue(stored)
  }

  promptCapabilities(): { images: boolean; text: boolean } | undefined {
    const known = this.state.promptCapabilities
    if (!this.loaded || !known || known.definitionHash !== this.definitionNow()) return undefined
    return { images: known.images, text: known.embeddedContext }
  }

  catalogueRead(): CatalogueRead | undefined {
    if (!this.loaded) return undefined
    const last = this.state.catalogueRead
    const current = last && last.definitionHash === this.definitionNow() ? last : undefined
    return {
      ...catalogueReadOf(this.selection.profile),
      ...(this.readingNow ? { running: true as const } : {}),
      ...(current ? { last: { at: current.at, ok: current.ok, ...(current.message ? { message: current.message } : {}) } } : {}),
    }
  }

  /**
   * Reads what a new session would offer without running a turn, and keeps it as the catalogue. Never on a timer: a
   * draft's selection asks with `auto`, which reads only a `select` harness that nothing is known of for this definition,
   * once; a person asks without it. A failure is kept as the last read, so a selection does not try again.
   */
  readCatalogue(options: { auto: boolean; before?: () => Promise<void> }): Promise<{ ran: boolean }> {
    if (this.reading) return this.reading
    const reading = (async () => {
      await this.ready()
      this.assertOpen()
      const { definitionHash } = this.currentLaunch()
      if (options.auto) {
        const read = this.catalogueRead()
        if (read?.when !== 'select' || read.last || this.catalogue()) return { ran: false }
      }
      await options.before?.()
      this.readingNow = true
      this.notify()
      let failure: string | undefined
      try {
        await this.readOnce(definitionHash)
      } catch (error) {
        failure = clip(this.publicError(error, undefined).message, 300)
      }
      if (this.definitionNow(true) === definitionHash) {
        this.state.catalogueRead = { definitionHash, at: this.now(), ok: !failure, ...(failure ? { message: failure } : {}) }
        this.mark()
        await this.flush()
      }
      return { ran: true }
    })().finally(() => {
      if (this.reading === reading) this.reading = undefined
      this.readingNow = false
      this.notify()
    })
    this.reading = reading
    return reading
  }

  /** Whether this harness reports its own MCP servers over its protocol: Codex's app-server does; ACP does not. */
  private reportsOwnMcp(): boolean {
    return this.selection.profile?.wire === 'codex'
  }

  /** Its own MCP servers as it last reported them for its current definition; undefined when it never reports them. */
  ownMcp(): HarnessOwnMcp | undefined {
    if (!this.reportsOwnMcp()) return undefined
    const known = this.ownMcpState && this.ownMcpState.definitionHash === this.definitionNow() ? this.ownMcpState : undefined
    return {
      ...(this.mcpReading ? { running: true as const } : {}),
      ...(known?.last ? { last: structuredClone(known.last) } : {}),
      ...(known?.failed ? { failed: { ...known.failed } } : {}),
    }
  }

  private noteOwnMcp(reported: unknown, via: HarnessMcpReport['via']): void {
    const parsed = ownMcpStatus.safeParse(reported)
    const definitionHash = this.definitionNow()
    if (!parsed.success || !definitionHash) return
    this.ownMcpState = {
      definitionHash,
      last: {
        servers: parsed.data.servers.map(server => ({ ...server, name: clip(this.redact(server.name), 128) })),
        at: this.now(),
        via,
        ...(parsed.data.truncated ? { truncated: true as const } : {}),
      },
    }
    this.notify()
  }

  /**
   * 读取: the harness's own MCP servers from a process with no session, in a private empty folder, so that no project's
   * configuration is read. The harness then starts the servers it has configured, which is why only a person asks.
   */
  readOwnMcp(options: { before?: () => Promise<void> } = {}): Promise<void> {
    if (this.mcpReading) return this.mcpReading
    const reading = (async () => {
      await this.ready()
      this.assertOpen()
      if (!this.reportsOwnMcp()) throw new AppError(409, 'mcp-not-reported', `${this.agent.name} 不报告自己的 MCP`)
      const { definitionHash } = this.currentLaunch()
      await options.before?.()
      // One deadline for the whole read, the process's start included.
      const deadline = Date.now() + MCP_READ_MS
      this.notify()
      const key = `mcp-read-${randomUUID()}`
      await mkdir(this.tmpRoot(), { recursive: true, mode: 0o700 })
      const cwd = await realpath(await mkdtemp(join(this.tmpRoot(), 'mcp-')))
      let answer: unknown
      try {
        const launch = this.currentLaunch(await this.projectConfig(cwd))
        const live = await this.ensureProcess(key, cwd, { launchHash: launch.hash, definitionHash: launch.definitionHash })
        this.enter(this.holds, key)
        try {
          const left = deadline - Date.now()
          if (left <= 0) throw new RequestTimeout(MCP_STATUS_METHOD)
          answer = await live.wire.request(MCP_STATUS_METHOD, {}, left, this.lifetime.signal)
        } catch (error) {
          throw this.publicError(error, live)
        } finally {
          this.leave(this.holds, key)
        }
      } catch (error) {
        if (this.definitionNow(true) === definitionHash)
          this.ownMcpState = {
            ...(this.ownMcpState?.definitionHash === definitionHash ? this.ownMcpState : {}),
            definitionHash,
            failed: { at: this.now(), message: clip(this.publicError(error, undefined).message, 300) },
          }
        throw error
      } finally {
        await this.discardProcess(key)
        await rm(cwd, { recursive: true, force: true }).catch(() => {})
      }
      if (this.definitionNow(true) !== definitionHash) return
      this.noteOwnMcp(answer, 'read')
      if (this.ownMcpState?.definitionHash !== definitionHash || this.ownMcpState.last?.via !== 'read')
        throw new AppError(502, 'agent-protocol', `${this.agent.name} 的 MCP 状态无效`)
    })().finally(() => {
      if (this.mcpReading === reading) this.mcpReading = undefined
      this.notify()
    })
    this.mcpReading = reading
    return reading
  }

  /**
   * Asks the agent to log out, in a process started for it in a private empty folder, when the agent says it can. Refused
   * while a session runs, since what logging out does to a running turn is the agent's choice. Afterwards idle processes
   * stop, so that the next turn starts one that reads the login as it is now.
   */
  async logout(): Promise<void> {
    await this.ready()
    this.assertOpen()
    const name = this.agent.name
    const running = () => [...this.runs.keys(), ...this.attaching.keys()].some(key => this.state.tasks[key] !== undefined)
    if (running()) throw new AppError(409, 'harness-busy', `${name} 有会话正在运行，等它结束后再退出登录。`)
    const key = `logout-${randomUUID()}`
    await mkdir(this.tmpRoot(), { recursive: true, mode: 0o700 })
    const cwd = await realpath(await mkdtemp(join(this.tmpRoot(), 'logout-')))
    try {
      const launch = this.currentLaunch(await this.projectConfig(cwd))
      const live = await this.ensureProcess(key, cwd, { launchHash: launch.hash, definitionHash: launch.definitionHash })
      this.enter(this.holds, key)
      try {
        if (!live.capabilities.logout) throw new AppError(409, 'logout-unsupported', `${name} 不支持从 Latch 退出登录。`)
        if (running()) throw new AppError(409, 'harness-busy', `${name} 有会话正在运行，等它结束后再退出登录。`)
        await live.wire.request('logout', {}, Math.min(this.limits.requestTimeoutMs, 30_000), this.lifetime.signal)
      } catch (error) {
        throw this.publicError(error, undefined)
      } finally {
        this.leave(this.holds, key)
      }
    } finally {
      await this.discardProcess(key)
      await rm(cwd, { recursive: true, force: true }).catch(() => {})
    }
    this.auth.forgetReports()
    // Only processes whose sessions can be restored; another keeps its session, with the login it read when it started.
    for (const live of [...this.lives.values()])
      if (live.initialized && (live.capabilities.resume || live.capabilities.load) && !this.busy(live.key) && !live.wire.stopping)
        void live.wire.stop('stop', this.limits.stopGraceMs).catch(() => {})
    this.notify()
  }

  // ---- earlier sessions of the agent ------------------------------------------------------------------------------

  private assertHistoryImport(): void {
    const profile = this.selection.profile
    // pi's wire answers no session/list or session/load; ACP and Codex's app-server do.
    if (!profile?.historyImport || profile.wire === 'pi') throw historyNotSupported(this.agent.name)
  }

  /** The agent's sessions with what it reports of them, from a process in a private empty folder that only lists. */
  async listExternalSessions(): Promise<ExternalSessionList> {
    await this.ready()
    this.assertOpen()
    this.assertHistoryImport()
    const key = `history-list-${randomUUID()}`
    await mkdir(this.tmpRoot(), { recursive: true, mode: 0o700 })
    const cwd = await realpath(await mkdtemp(join(this.tmpRoot(), 'history-')))
    try {
      const launch = this.currentLaunch(await this.projectConfig(cwd))
      const live = await this.ensureProcess(key, cwd, { launchHash: launch.hash, definitionHash: launch.definitionHash })
      this.enter(this.holds, key)
      try {
        if (!live.capabilities.list || !live.capabilities.load) throw historyNotSupported(this.agent.name)
        const deadline = Date.now() + LIST_MS
        const sessions: ExternalSessionList['sessions'] = []
        let cursor: string | undefined
        let truncated = false
        for (;;) {
          const left = deadline - Date.now()
          if (left <= 0) {
            truncated = true
            break
          }
          let result: unknown
          try {
            // No `cwd`: an agent may match it exactly, and the Host filters by the project's folders itself.
            result = await live.wire.request(
              'session/list',
              cursor ? { cursor } : {},
              Math.min(left, this.limits.requestTimeoutMs),
              this.lifetime.signal,
            )
          } catch (error) {
            if (error instanceof RequestTimeout && sessions.length) {
              truncated = true
              break
            }
            throw error
          }
          const page = sessionList.safeParse(result)
          if (!page.success) throw new AppError(502, 'agent-protocol', `${this.agent.name} 的会话列表无效`)
          for (const row of page.data.sessions) {
            if (sessions.length >= LIST_MAX) break
            sessions.push({
              agentSessionId: row.sessionId,
              cwd: row.cwd,
              ...(row.title ? { title: clip(this.redact(row.title), 200) } : {}),
              ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
            })
          }
          cursor = page.data.nextCursor ?? undefined
          if (!cursor) break
          if (sessions.length >= LIST_MAX) {
            truncated = true
            break
          }
        }
        return { sessions, truncated }
      } catch (error) {
        throw this.publicError(error, live)
      } finally {
        this.leave(this.holds, key)
      }
    } finally {
      await this.discardProcess(key)
      await rm(cwd, { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * Where an earlier session may be loaded: its directory at or below the primary folder of a project the Host lists,
   * with the project's other folders as a new session of that project would pass them.
   */
  private async externalScope(place: ExternalSessionPlace): Promise<{ cwd: string; real: string; scope: Scope }> {
    if (typeof place.cwd !== 'string' || !isAbsolute(place.cwd) || place.cwd.includes('\0')) throw outsideProject()
    const project = this.options.projects?.().find(item => item.id === place.workspaceId)
    const primary = project?.folders[0]
    if (!project || !primary) throw scopeUnavailable()
    const scope = (await this.scopeOf(place, primary.path)) ?? {
      workspaceId: project.id,
      folders: [{ id: primary.id, path: primary.path }],
    }
    const root = await realpath(primary.path).catch(() => undefined)
    const real = await realpath(place.cwd).catch(() => undefined)
    if (!root || !real || (real !== root && !real.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))) throw outsideProject()
    return { cwd: place.cwd, real, scope }
  }

  /**
   * Loads an earlier session of the agent and keeps its replay, on a process of its own in the session's directory. The
   * project configuration there is checked as for any start; nothing is prompted, so no tool runs. A refusal because the
   * session is open elsewhere is `history-session-busy`, never retried and never taken over.
   */
  async loadExternalSession(place: ExternalSessionPlace): Promise<ExternalSessionLoad> {
    await this.ready()
    this.assertOpen()
    this.assertHistoryImport()
    // The checked real path, never one through a link: the agent works where the check looked.
    const { real: cwd, scope } = await this.externalScope(place)
    const launch = this.currentLaunch(await this.projectConfig(cwd, scope.passed), scope.passed)
    const loadId = `load-${randomUUID()}`
    const key = `history-${loadId}`
    this.enter(this.holds, key)
    try {
      const live = await this.ensureProcess(key, cwd, {
        launchHash: launch.hash,
        definitionHash: launch.definitionHash,
        ...(scope.passed ? { folders: scope.passed } : {}),
      })
      if (!live.capabilities.list || !live.capabilities.load) throw historyNotSupported(this.agent.name)
      if (scope.passed?.via === 'acp' && !live.capabilities.additionalDirectories) throw this.foldersUnsupported(true)
      const capture = newCapture(place.agentSessionId)
      live.capture = capture
      let result: unknown
      try {
        result = await live.wire.request(
          'session/load',
          {
            sessionId: place.agentSessionId,
            cwd,
            mcpServers: [],
            ...(scope.passed?.via === 'acp' ? { additionalDirectories: [...scope.passed.paths] } : {}),
          },
          LOAD_MS,
          this.lifetime.signal,
        )
      } catch (error) {
        if (error instanceof RpcError && error.code !== RPC.authRequired && error.code !== RPC.notFound && isBusy(error.message))
          throw sessionBusy(this.harnessName())
        throw this.publicError(error, live)
      } finally {
        live.capture = undefined
      }
      const state = sessionState.safeParse(result)
      const folded = state.success ? foldConfig(state.data) : undefined
      const model = modelName(folded?.options)
      const load: ExternalSessionLoad = {
        loadId,
        ...captured(capture, this.now(), this.redact),
        ...(model ? { model: clip(this.redact(model), 200) } : {}),
      }
      this.external.set(loadId, { key, place: structuredClone(place), scope, launch, load })
      return structuredClone(load)
    } catch (error) {
      this.leave(this.holds, key)
      await this.discardProcess(key)
      throw error
    }
  }

  /** Closes a load: `session/close` when the agent offers it, then its process stops. */
  async closeExternalSession(loadId: string): Promise<void> {
    const entry = this.external.get(loadId)
    if (!entry) return
    this.external.delete(loadId)
    const live = this.lives.get(entry.key)
    if (live?.initialized && !live.wire.stopping && live.capabilities.close)
      await live.wire
        .request('session/close', { sessionId: entry.place.agentSessionId }, Math.min(this.limits.requestTimeoutMs, 10_000))
        .catch(() => {})
    this.leave(this.holds, entry.key)
    await this.discardProcess(entry.key)
  }

  /**
   * The store the adapter lists from. ACP does not name it, so definitions running the same command (by its real path,
   * through links) count as one: they read the same store unless their environment points elsewhere, and then a second
   * import is refused, never doubled. A reinstall to another path is another key.
   */
  historyStore(): string {
    const command = resolveCommand(this.agent.command) ?? this.agent.command
    let resolved = command
    try {
      resolved = realpathSync(command)
    } catch {
      /* A command not found now keeps its name. */
    }
    return `acp-command:${sha256Hex(resolved)}`
  }

  /** The agent's sessions behind this driver's own sessions, past and present; not those brought in. */
  agentSessionIds(): string[] {
    return Object.values(this.state.tasks).flatMap(task =>
      [...(task.acp.earlierSessionIds ?? []), ...(task.acp.acpSessionId ? [task.acp.acpSessionId] : [])].filter(
        id => id !== task.acp.imported?.agentSessionId,
      ),
    )
  }

  /**
   * Records a session bound to the agent's earlier session, with the replay as its history. Its next turn resumes that
   * session (or loads it, discarding the replay) as for any session whose process ended, and sets Latch's expected mode
   * and reads it back before the prompt: the session's own mode is not carried over.
   */
  async adoptExternalSession(input: ExternalSessionAdopt): Promise<Adopted> {
    await this.ready()
    this.assertHistoryImport()
    if (typeof input.sessionId !== 'string' || !TASK_ID.test(input.sessionId)) throw new AppError(400, 'invalid-input', '会话标识无效。')
    const existing = this.state.tasks[input.sessionId]
    if (existing) {
      if (existing.acp.imported?.agentSessionId !== input.agentSessionId)
        throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同任务内容')
      return {
        sessionId: input.sessionId,
        launchHash: existing.acp.launchHash!,
        messageCount: existing.messages.filter(message => message.imported).length,
        droppedBefore: 0,
      }
    }
    const pending = this.adopting.get(input.sessionId)
    if (pending) {
      if (pending.agentSessionId !== input.agentSessionId) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同任务内容')
      return pending.promise
    }
    const promise = this.adoptOnce(input).finally(() => this.adopting.delete(input.sessionId))
    this.adopting.set(input.sessionId, { agentSessionId: input.agentSessionId, promise })
    return promise
  }

  private async adoptOnce(input: ExternalSessionAdopt): Promise<Adopted> {
    this.assertOpen()
    let entry = input.loadId ? this.external.get(input.loadId) : undefined
    if (entry && (entry.place.agentSessionId !== input.agentSessionId || entry.place.cwd !== input.cwd)) entry = undefined
    if (!entry) {
      const load = await this.loadExternalSession(input)
      entry = this.external.get(load.loadId)!
    }
    try {
      // Checked again now: a preview's folders and configuration say nothing about this moment.
      // The session works in the checked real path from now on, so a link swapped later cannot move it.
      const { real, scope } = await this.externalScope(input)
      const cwd = real
      const launch = this.currentLaunch(await this.projectConfig(cwd, scope.passed), scope.passed)
      if (launch.hash !== entry.launch.hash) throw this.projectConfigChanged()
      this.assertOpen()
      if (this.state.tasks[input.sessionId]) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同任务内容')
      // One Latch session per agent session: neither one Latch started nor one brought in already.
      if (
        Object.values(this.state.tasks).some(
          task =>
            task.acp.acpSessionId === input.agentSessionId
            || task.acp.earlierSessionIds?.includes(input.agentSessionId)
            || task.acp.imported?.agentSessionId === input.agentSessionId,
        )
      )
        throw new AppError(409, 'history-already-imported', '这个会话已经在 Latch 里了。')
      const kept = adoptedMessages(entry.load.messages, entry.load.droppedBefore)
      const at = this.now()
      const messages: Message[] = [
        ...(kept.droppedBefore
          ? [
              {
                id: randomUUID(),
                role: 'system' as const,
                text: `更早的 ${kept.droppedBefore} 条消息只在 ${this.harnessName()} 里。`,
                imported: true as const,
                createdAt: at,
              },
            ]
          : []),
        ...kept.messages,
      ]
      // The agent holds the session while a load has it open: its own process lets go before the session is recorded.
      await this.closeExternalSession(entry.load.loadId)
      this.state.tasks[input.sessionId] = {
        summary: {
          id: input.sessionId,
          title: clip(input.title.replace(/\s+/gu, ' ').trim() || this.harnessName(), 80),
          status: 'idle',
          updatedAt: at,
          createdAt: at,
          cwd,
          mode: 'agent',
          workspaceId: scope.workspaceId,
          folders: scope.folders.map(({ id, path }) => ({ id, path })),
          ...(scope.passed ? { folderAccess: 'all' as const } : {}),
        },
        messages,
        revision: 1,
        acp: {
          acpSessionId: input.agentSessionId,
          cwd,
          turnSeq: 0,
          launchHash: launch.hash,
          definitionHash: launch.definitionHash,
          deletable: false,
          ...(this.selection.profile ? { profilePresetId: this.selection.profile.presetId } : {}),
          ...(scope.passed ? { folders: [...scope.passed.paths], folderVia: scope.passed.via } : {}),
          imported: { agentSessionId: input.agentSessionId, cwd: real },
        },
      }
      this.tools.set(input.sessionId, { seq: 0, calls: new Map() })
      this.mark()
      this.notify(input.sessionId)
      try {
        await this.flush()
      } catch (error) {
        delete this.state.tasks[input.sessionId]
        this.tools.delete(input.sessionId)
        this.mark()
        throw error
      }
      return { sessionId: input.sessionId, launchHash: launch.hash, messageCount: kept.messages.length, droppedBefore: kept.droppedBefore }
    } finally {
      await this.closeExternalSession(entry.load.loadId)
    }
  }

  /** One read in a private empty folder that is removed afterwards, with the process started for it. */
  private async readOnce(definitionHash: string): Promise<void> {
    const key = `catalogue-${randomUUID()}`
    await mkdir(this.tmpRoot(), { recursive: true, mode: 0o700 })
    const cwd = await realpath(await mkdtemp(join(this.tmpRoot(), 'catalogue-')))
    try {
      const configured = this.selection.profile?.catalogueRead
      if (configured && 'codexModels' in configured) {
        const listed = await this.readCodexModels(key, cwd, configured.codexModels)
        if (!listed.options.length) throw new AppError(502, 'catalogue-empty', `${this.agent.name} 没有列出可选的模型。`)
        this.state.catalogue = modelListCatalogue(this.state.catalogue, { ...listed, definitionHash, at: this.now() })
        return
      }
      const launch = this.currentLaunch(await this.projectConfig(cwd))
      const live = await this.ensureProcess(key, cwd, { launchHash: launch.hash, definitionHash: launch.definitionHash })
      this.enter(this.holds, key)
      let result: unknown
      try {
        // No MCP servers and no prompt: the session exists only to say what it offers.
        result = await live.wire.request('session/new', { cwd, mcpServers: [] }, this.readTimeout(), this.lifetime.signal)
        const sessionId = sessionState.safeParse(result).data?.sessionId
        const end = live.capabilities.delete ? 'session/delete' : live.capabilities.close ? 'session/close' : undefined
        if (sessionId && end) await live.wire.request(end, { sessionId }, Math.min(this.readTimeout(), 10_000)).catch(() => {})
      } catch (error) {
        throw this.publicError(error, live)
      } finally {
        this.leave(this.holds, key)
      }
      const parsed = sessionState.safeParse(result)
      const folded = parsed.success ? foldConfig(parsed.data) : undefined
      if (!folded?.options.length) throw new AppError(502, 'catalogue-empty', `${this.agent.name} 没有报告可选的模型和设置。`)
      this.state.catalogue = startCatalogue(this.state.catalogue, {
        options: folded.options,
        isMode: option => option.category === 'mode' || (folded.source === 'legacy' && option.id === 'mode'),
        startMode: this.profile?.expectedMode,
        definitionHash: launch.definitionHash,
        launchHash: launch.hash,
        ...(live.agentVersion ? { agentVersion: live.agentVersion } : {}),
        at: this.now(),
        source: 'check',
      })
    } finally {
      await this.discardProcess(key)
      await rm(cwd, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** Codex's list from its app-server, with the environment and program its sessions get. */
  private async readCodexModels(key: string, cwd: string, args: readonly string[]): Promise<ReturnType<typeof codexOptions>> {
    const { command } = this.currentLaunch()
    const materializedEnv = await this.selection.profile?.materialize?.({ dataDir: this.options.dataDir })
    const env = agentEnvironment({
      resolvedCommand: command,
      profile: this.profile,
      materializedEnv,
      definitionEnv: this.agent.env,
      sessionTmpDir: await this.prepareTmpDir(key),
    })
    this.assertOpen()
    const listed = await readCodexModels(
      { command, args: [...this.agent.args, ...args], cwd, env, redact: this.redact },
      { timeoutMs: this.readTimeout(), signal: this.lifetime.signal },
    ).catch((error: unknown) => {
      throw this.publicError(error, undefined)
    })
    return codexOptions(listed)
  }

  private readTimeout(): number {
    return Math.min(this.limits.requestTimeoutMs, READ_TIMEOUT_MS)
  }

  customModels(): string[] {
    return this.loaded ? [...(this.state.customModels ?? [])] : []
  }

  async setCustomModels(models: readonly string[]): Promise<void> {
    await this.ready()
    const kept: string[] = []
    for (const entry of models) {
      const model = typeof entry === 'string' ? entry.trim() : ''
      if (!model || model.length > MAX_CUSTOM_MODEL || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(model))
        throw new AppError(400, 'model-id-invalid', `模型 ID 不能为空，不能换行，最多 ${MAX_CUSTOM_MODEL} 个字符。`)
      if (!kept.includes(model)) kept.push(model)
    }
    if (kept.length > MAX_CUSTOM_MODELS) throw new AppError(400, 'model-id-invalid', `最多填写 ${MAX_CUSTOM_MODELS} 个模型 ID。`)
    if (kept.length) this.state.customModels = kept
    else delete this.state.customModels
    this.mark()
    await this.flush()
    this.notify()
  }

  /** A model ID typed for the harness's own login; never one for a session on a route, whose gateway would refuse it. */
  private isCustomModel(task: AcpTask, option: SessionConfigOption, value: string): boolean {
    return !task.acp.route && option.category === 'model' && (this.state.customModels ?? []).includes(value)
  }

  /** The current definition's fingerprint, looked up at most every few seconds: every catalog asks. */
  private definitionNow(fresh = false): string | undefined {
    const at = Date.now()
    if (!fresh && this.definitionLookup && at - this.definitionLookup.at < DEFINITION_LOOKUP_MS) return this.definitionLookup.hash
    let hash: string | undefined
    try {
      hash = this.currentLaunch().definitionHash
    } catch {
      hash = undefined
    }
    this.definitionLookup = { at, hash }
    return hash
  }

  async createTask(input: CreateTaskInput): Promise<{ sessionId: string }> {
    await this.ready()
    assertStart(input)
    const attachments = checkedAttachments(input.attachments)
    const fileRefs = input.fileRefs ?? []
    const config = checkedStartConfig(input.config)
    const key = digest(['create', input.requestId])
    const payloadHash = digest({
      prompt: input.prompt,
      ...(attachments.length ? { attachments } : {}),
      ...(fileRefs.length ? { fileRefs } : {}),
      mode: input.mode ?? 'agent',
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.modelRoute ? { modelRoute: input.modelRoute } : {}),
      ...(config.length ? { config } : {}),
      ...(Array.isArray(input.folders) && input.folders.length > 1 ? { folders: input.folders.map(({ id, path }) => ({ id, path })) } : {}),
      ...(input.fork ? { fork: forkKey(input.fork) } : {}),
      ...(input.seed ? { seed: digest(input.seed) } : {}),
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
    assertStart(input)
    const mode = input.mode ?? 'agent'
    if (mode === 'chat') throw new AppError(400, 'mode-unsupported', `${this.agent.name} 只支持 Agent 模式`)
    if (mode !== 'agent') throw new AppError(400, 'invalid-mode', '对话模式必须是 chat 或 agent')
    if (typeof input.expectedLaunchHash !== 'string' || !input.expectedLaunchHash) {
      throw new AppError(409, 'l3-confirmation-missing', '此会话缺少启动记录，不能启动。')
    }
    const cwd = await this.workspace(input.cwd)
    const scope = await this.scopeOf(input, cwd)
    // Read before the receipt check: nothing may wait between that check and the reservation below, except for a start
    // that `creating` keeps to one per request.
    const project = await this.projectConfig(cwd, scope?.passed)
    this.assertOpen()
    const attachments = checkedAttachments(input.attachments)
    const fileRefs = input.fileRefs ?? []
    const config = checkedStartConfig(input.config)
    const key = digest(['create', input.requestId])
    // Folders join the hash only when there are several, so receipts written before they existed still match.
    const payloadHash = digest({
      prompt: input.prompt,
      ...(attachments.length ? { attachments } : {}),
      ...(fileRefs.length ? { fileRefs } : {}),
      mode,
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.modelRoute ? { modelRoute: input.modelRoute } : {}),
      ...(config.length ? { config } : {}),
      ...(scope && scope.folders.length > 1 ? { folders: (input.folders ?? []).map(({ id, path }) => ({ id, path })) } : {}),
      ...(input.fork ? { fork: forkKey(input.fork) } : {}),
      ...(input.seed ? { seed: digest(input.seed) } : {}),
    })
    const receipt = this.state.receipts[key]
    if (receipt) {
      if (receipt.payloadHash !== payloadHash) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同任务内容')
      if (receipt.deleted) throw new AppError(410, 'task-deleted', '该任务已删除')
      await this.flush()
      return { sessionId: receipt.taskId }
    }
    const route = checkedRoute(input.modelRoute)
    const launch = this.currentLaunch(project, scope?.passed, route)
    if (launch.hash !== input.expectedLaunchHash) throw this.launchRefusal(input.expectedLaunchHash, launch, scope?.passed)
    const sessionId = `task-${randomUUID()}`
    const create = {
      sessionId,
      prompt: input.prompt,
      attachments,
      fileRefs,
      requestId: input.requestId,
      key,
      payloadHash,
      cwd,
      launch,
      ...(scope ? { scope } : {}),
      ...(input.agentContext ? { agentContext: input.agentContext } : {}),
      ...(config.length ? { startConfig: startChoices(config, this.state.catalogue) } : {}),
      ...(route ? { route } : {}),
      ...(input.fork ? { fork: checkedFork(input.fork, input.prompt) } : {}),
      ...(input.seed ? { seed: input.seed } : {}),
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
          ...(route ? { route } : {}),
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
    attachments?: AttachmentRef[]
    fileRefs?: FileMention[]
    key: string
    payloadHash: string
    requestId: string
    cwd: string
    launch: Launch
    scope?: Scope
    agentContext?: AgentExecutionContext
    startConfig?: StartChoice[]
    route?: ModelRoute
    fork?: NonNullable<AcpRecord['fork']>
    seed?: string
  }): Promise<{ sessionId: string }> {
    const { sessionId, prompt, cwd, launch, scope, attachments, fileRefs = [], agentContext, startConfig, route, fork } = create
    this.assertOpen()
    if (create.seed !== undefined) return this.recordSeeded({ ...create, seed: create.seed })
    let context: string
    try {
      context = fileMentionContext(prompt, fileRefs, scope?.folders ?? [{ id: 'default', path: cwd }])
    } catch {
      throw new AppError(400, 'file-reference-invalid', '文件引用无效。')
    }
    if (agentContext?.skillBodies?.length || this.proposing(agentContext))
      await writeSessionSkills(skillsDirectory(this.options.dataDir, sessionId), agentContext?.skillBodies ?? [])
    const run = this.reserve(sessionId, 1, context)
    run.attachments = attachments
    const at = isoTime(run.clock.startedAt)
    run.userMessageId = randomUUID()
    this.state.tasks[sessionId] = {
      summary: {
        id: sessionId,
        title: (promptTitle(prompt) || attachments?.[0]?.name || '附件').slice(0, 80),
        status: 'running',
        updatedAt: at,
        createdAt: at,
        cwd,
        mode: 'agent',
        ...(scope
          ? { workspaceId: scope.workspaceId, folders: scope.folders.map(({ id, path }) => ({ id, path })), folderAccess: 'all' as const }
          : {}),
        runId: run.id,
        ...(agentContext?.agent ? { agent: agentContext.agent } : {}),
        ...(agentContext && !agentContext.agent ? { agentPrivate: true as const } : {}),
        ...(route ? { modelRoute: { providerId: route.providerId, model: route.model } } : {}),
      },
      messages: [
        {
          id: run.userMessageId,
          role: 'user',
          text: prompt,
          turnId: run.id,
          requestId: create.requestId,
          createdAt: at,
          ...(attachments?.length ? { attachments } : {}),
          ...(fileRefs.length ? { fileRefs } : {}),
        },
      ],
      revision: 1,
      acp: {
        cwd,
        turnSeq: 1,
        launchHash: launch.hash,
        definitionHash: launch.definitionHash,
        ...(this.selection.profile ? { profilePresetId: this.selection.profile.presetId } : {}),
        ...(scope?.passed ? { folders: [...scope.passed.paths], folderVia: scope.passed.via } : {}),
        ...(agentContext?.skillBodies?.length ? { skills: true as const } : {}),
        ...(this.proposing(agentContext) ? { proposals: true as const } : {}),
        ...(this.proposing(agentContext) && agentContext?.unattended ? { unattended: true as const } : {}),
        ...(agentContext?.brief ? { brief: agentContext.brief } : {}),
        ...(startConfig ? { startConfig } : {}),
        ...(route ? { route } : {}),
        ...(fork ? { fork } : {}),
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

  /** A session recorded with no turn: its seed waits for the first message, so nothing is sent until the person sends. */
  private async recordSeeded(create: Parameters<AgentRuntime['record']>[0] & { seed: string }): Promise<{ sessionId: string }> {
    const { sessionId, cwd, launch, scope, agentContext, startConfig, route } = create
    if (agentContext?.skillBodies?.length || this.proposing(agentContext))
      await writeSessionSkills(skillsDirectory(this.options.dataDir, sessionId), agentContext?.skillBodies ?? [])
    const at = this.now()
    this.state.tasks[sessionId] = {
      summary: {
        id: sessionId,
        title: (promptTitle(create.seed) || this.agent.name).slice(0, 80),
        status: 'idle',
        updatedAt: at,
        createdAt: at,
        cwd,
        mode: 'agent',
        ...(scope
          ? { workspaceId: scope.workspaceId, folders: scope.folders.map(({ id, path }) => ({ id, path })), folderAccess: 'all' as const }
          : {}),
        ...(agentContext?.agent ? { agent: agentContext.agent } : {}),
        ...(agentContext && !agentContext.agent ? { agentPrivate: true as const } : {}),
        ...(route ? { modelRoute: { providerId: route.providerId, model: route.model } } : {}),
      },
      messages: [],
      revision: 1,
      acp: {
        cwd,
        turnSeq: 0,
        launchHash: launch.hash,
        definitionHash: launch.definitionHash,
        ...(this.selection.profile ? { profilePresetId: this.selection.profile.presetId } : {}),
        ...(scope?.passed ? { folders: [...scope.passed.paths], folderVia: scope.passed.via } : {}),
        ...(agentContext?.skillBodies?.length ? { skills: true as const } : {}),
        ...(this.proposing(agentContext) ? { proposals: true as const } : {}),
        ...(this.proposing(agentContext) && agentContext?.unattended ? { unattended: true as const } : {}),
        ...(agentContext?.brief ? { brief: agentContext.brief } : {}),
        ...(startConfig ? { startConfig } : {}),
        ...(route ? { route } : {}),
        seed: create.seed,
      },
    }
    this.state.receipts[create.key] = { taskId: sessionId, payloadHash: create.payloadHash, kind: 'create' }
    this.tools.set(sessionId, { seq: 0, calls: new Map() })
    this.mark()
    this.notify(sessionId)
    try {
      await this.flush()
    } catch (error) {
      delete this.state.tasks[sessionId]
      delete this.state.receipts[create.key]
      this.tools.delete(sessionId)
      this.mark()
      throw error
    }
    // A process started to learn whether it takes the folders is let go while the session waits.
    this.scheduleIdle(sessionId)
    return { sessionId }
  }

  async prompt(sessionId: string, prompt: string, requestId: string, options: PromptOptions = {}): Promise<void> {
    await this.ready()
    assertPrompt(prompt, requestId, options.attachments)
    const key = digest(['prompt', sessionId, requestId])
    const attachments = checkedAttachments(options.attachments)
    const fileRefs = options.fileRefs ?? []
    const fresh = options.freshContext === true
    // The new context joins the hash only when asked, so receipts written before it existed still match.
    const payloadHash = digest(
      attachments.length || fileRefs.length || fresh
        ? {
            prompt,
            ...(options.model ? { model: options.model } : {}),
            ...(attachments.length ? { attachments } : {}),
            ...(fileRefs.length ? { fileRefs } : {}),
            ...(fresh ? { freshContext: true } : {}),
          }
        : options.model
          ? { prompt, model: options.model }
          : prompt,
    )
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
    let context: string
    try {
      context = fileMentionContext(prompt, fileRefs, task.summary.folders ?? [{ id: 'default', path: task.acp.cwd }])
    } catch {
      throw new AppError(400, 'file-reference-invalid', '文件引用无效。')
    }
    // A seeded session's first message carries its seed: sending it is what sends the seed.
    const seed = fresh ? '' : (task.acp.seed ?? '')
    context = seed + context
    const run = this.reserve(sessionId, task.acp.turnSeq + 1, context)
    run.attachments = attachments
    const promise = (async () => {
      try {
        if (fresh) {
          // A bind already under way (a setting changed a moment ago) would put the old session back once it finished.
          for (let binding = this.attaching.get(sessionId); binding; binding = this.attaching.get(sessionId))
            await binding.promise.catch(() => {})
          this.clearContext(this.task(sessionId))
        }
        // Reattach and confirm the mode before recording, so a refused turn leaves no side effects.
        await this.attach(sessionId)
        this.assertOpen()
        if (run.cancelRequested) throw cancelledBeforeSend()
        const current = this.task(sessionId)
        this.assertUsable(current)
        current.acp.turnSeq = run.seq
        run.userMessageId = randomUUID()
        const freshContext = current.acp.contextCleared === true
        delete current.acp.contextCleared
        delete current.acp.seed
        current.messages.push({
          id: run.userMessageId,
          role: 'user',
          text: seed + prompt,
          ...(freshContext ? { freshContext: true as const } : {}),
          turnId: run.id,
          requestId,
          ...(options.queuedAt ? { queuedAt: options.queuedAt } : {}),
          ...(fileRefs.length ? { fileRefs } : {}),
          createdAt: isoTime(run.clock.startedAt),
          ...(attachments.length ? { attachments } : {}),
        })
        current.summary.status = 'running'
        current.summary.runId = run.id
        delete current.summary.runOutcome
        delete current.summary.runEnd
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
        throw run.userMessageId === undefined ? notAccepted(error) : error
      }
      this.begin(run)
    })().finally(() => this.inflight.delete(key))
    this.inflight.set(key, { payloadHash, promise })
    return promise
  }

  async cancel(sessionId: string, options: CancelOptions = {}): Promise<boolean> {
    await this.ready()
    const task = this.task(sessionId)
    const run = this.runs.get(sessionId)
    if (!run) {
      // Subagents that went on after the turn: their open requests are what stopping can still answer.
      const asked = [...this.permissions.values()].filter(permission => permission.taskId === sessionId && permission.statusAfter)
      if (!asked.length || (options.runId !== undefined && task.summary.runId !== options.runId)) return false
      for (const permission of asked) this.closePermission(permission, CANCELLED_OUTCOME, this.unanswered())
      await this.flush().catch(() => {})
      if (this.storageFailure) throw new AppError(503, 'storage-unavailable', '执行已停止，但取消状态未能持久化')
      return true
    }
    // Checked before anything awaits, so a turn that starts after this point is never the one cancelled.
    if (options.runId !== undefined && run.id !== options.runId) return false
    this.requestCancel(run, true)
    // Acknowledged only once the agent settled the turn, or its process was stopped.
    await run.done
    if (this.storageFailure) throw new AppError(503, 'storage-unavailable', '执行已停止，但取消状态未能持久化')
    return true
  }

  /**
   * Stops one subagent that said it can be stopped alone (ACP subagents draft: `session/cancel` with its session), while it
   * works; the session's turn goes on. Its own open requests are answered as cancelled, as a stop of the session answers
   * the session's. Its row says it is stopping until it reports how it ended: a stop sent is not a stop that took effect.
   */
  async cancelSubagent(sessionId: string, subagentId: string): Promise<boolean> {
    await this.ready()
    const task = this.task(sessionId)
    const live = this.lives.get(sessionId)
    if (!live || live.wire.stopping || this.closed) return false
    const child = [...live.children.values()].find(item => item.taskId === sessionId && item.messageId === subagentId)
    if (!child) return false
    if (child.stopping) return true
    const status = this.childRow(task, child)?.subagent?.status
    if (!child.cancellable || (status !== 'running' && status !== 'waiting')) return false
    child.stopping = true
    live.wire.notify('session/cancel', { sessionId: child.acpSessionId })
    for (const permission of [...this.permissions.values()])
      if (permission.child === child) this.closePermission(permission, CANCELLED_OUTCOME, { ...this.unanswered(), subagentStopped: true })
    this.touch(task)
    this.mark()
    this.notify(sessionId)
    return true
  }

  /** Which subagent rows of this process can be stopped alone now, or are being stopped: live facts, never stored. */
  private markStops(sessionId: string, messages: Message[]): void {
    const live = this.lives.get(sessionId)
    if (!live || live.wire.stopping) return
    const rows = new Map<string, Child>()
    for (const child of live.children.values())
      if (child.taskId === sessionId && child.messageId && (child.cancellable || child.stopping)) rows.set(child.messageId, child)
    if (!rows.size) return
    const visit = (items: Message[]): void => {
      for (const item of items) {
        if (!item.subagent) continue
        const child = rows.get(item.id)
        if (child?.stopping) item.subagent.stopping = true
        else if (child && (item.subagent.status === 'running' || item.subagent.status === 'waiting')) item.subagent.stoppable = true
        visit(item.subagent.steps)
      }
    }
    visit(messages)
  }

  /**
   * Text added to the running turn, never a turn of its own: `idleBehavior: "promptRequired"` keeps an agent from starting
   * one, so completion and failure stay with the turn the prompt began. The receipt is written before the request, so a
   * retry after a lost answer is refused instead of sending the text twice; the agent mints its own message for each
   * request and cannot tell a resend from a new one.
   */
  async steer(sessionId: string, prompt: string, requestId: string): Promise<SteerOutcome> {
    await this.ready()
    assertPrompt(prompt, requestId)
    const key = digest(['steer', sessionId, requestId])
    const payloadHash = digest(prompt)
    const receipt = this.state.receipts[key]
    const pending = this.steering.get(key)
    if (receipt || pending) {
      if ((receipt ?? pending)!.payloadHash !== payloadHash) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同输入')
      if (pending) return pending.promise
      if (receipt!.steer === 'injected' || receipt!.steer === 'prompt-required') return receipt!.steer
      throw steerUnknown()
    }
    const task = this.task(sessionId)
    this.assertUsable(task)
    const run = this.runs.get(sessionId)
    if (!run || !this.steerable(run)) {
      // The caller now sends or queues the text as a turn; a retry must get that answer, not steer it into the turn.
      this.state.receipts[key] = { taskId: sessionId, payloadHash, kind: 'steer', steer: 'prompt-required' }
      this.mark()
      await this.flush()
      return 'prompt-required'
    }
    const promise = this.steerOnce(run, key, payloadHash, prompt, requestId).finally(() => this.steering.delete(key))
    this.steering.set(key, { payloadHash, promise })
    return promise
  }

  private steerable(run: Run): boolean {
    return run.sent && !run.cancelRequested && run.live?.initialized === true && run.live.capabilities.steer && !!run.acpSessionId
  }

  private async steerOnce(run: Run, key: string, payloadHash: string, prompt: string, requestId: string): Promise<SteerOutcome> {
    const live = run.live!
    this.state.receipts[key] = { taskId: run.taskId, payloadHash, kind: 'steer', steer: 'sending' }
    run.steers = (run.steers ?? 0) + 1
    run.steeredAt = this.clock()
    this.mark()
    await this.flush()
    // The turn may have ended, or been stopped, while the receipt was written.
    if (this.runs.get(run.taskId) !== run || !this.steerable(run)) {
      this.state.receipts[key] = { taskId: run.taskId, payloadHash, kind: 'steer', steer: 'prompt-required' }
      run.steers--
      this.mark()
      await this.flush()
      return 'prompt-required'
    }
    let outcome: string
    let added = false
    // The agent may stream its reply to the text right behind its answer, in the same read: the turn splits before it.
    const add = (result: unknown): void => {
      if (added || steerResult.safeParse(result).data?.outcome !== 'injected') return
      added = true
      const task = this.state.tasks[run.taskId]
      if (!task) return
      if (this.runs.get(run.taskId) === run && run.segment) this.settleSegment(run, task, 'completed')
      task.messages.push({ id: randomUUID(), role: 'user', text: prompt, requestId, steered: true, createdAt: this.now() })
      this.state.receipts[key] = { taskId: run.taskId, payloadHash, kind: 'steer', steer: 'injected' }
      this.touch(task)
      this.mark()
    }
    try {
      const result = await live.wire.request(
        STEER_METHOD,
        {
          sessionId: run.acpSessionId,
          prompt: [{ type: 'text', text: prompt }],
          _meta: { steering: { idleBehavior: 'promptRequired' } },
        },
        Math.min(this.limits.requestTimeoutMs, STEER_TIMEOUT_MS),
        undefined,
        add,
      )
      const answer = steerResult.safeParse(result)
      outcome = answer.success ? answer.data.outcome : 'invalid'
      if (outcome === 'injected') add(result)
    } catch (error) {
      // No answer, or the process went away: the agent may have taken it. The receipt stays `sending`.
      if (error instanceof RequestTimeout || error instanceof ConnectionClosed || error instanceof ConnectionStopping) throw steerUnknown()
      outcome = 'failed'
      this.limits.log(`${this.agent.name} 没有接受追加：${clip(this.redact(message(error)), 300)}`)
    }
    if (outcome !== 'injected') {
      run.steers--
      if (outcome === 'promptRequired')
        this.state.receipts[key] = { taskId: run.taskId, payloadHash, kind: 'steer', steer: 'prompt-required' }
      else delete this.state.receipts[key]
    }
    this.mark()
    await this.flush()
    this.notify(run.taskId)
    if (outcome === 'injected') return 'injected'
    if (outcome === 'promptRequired') return 'prompt-required'
    throw new AppError(409, 'steer-failed', `${this.agent.name} 没有接受这条追加，内容没有发出；可以等本轮结束后再发送`)
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
    if (option && decision === 'allow' && !permission.child) this.answerMovesMode(permission, option.optionId)
    // Claimed synchronously, before any concurrent decision can compete. A note has nowhere to go: a permission answer
    // carries no text, so the page sends it as the next message instead.
    this.closePermission(permission, option ? selected(option.optionId) : CANCELLED_OUTCOME, {
      outcome: decision === 'allow' ? 'allowed' : 'rejected',
      at: this.now(),
      ...(via ? { via } : {}),
    })
    return true
  }

  /**
   * An answer that switches the harness's mode is the person choosing that mode: it becomes the session's expected mode
   * before the answer reaches the harness, so the switch it reports next is not taken as the agent widening its own.
   */
  private answerMovesMode(permission: Permission, optionId: string): void {
    const kind = permission.tool.kind
    const mode = this.profile?.modeAnswers?.find(
      entry => entry.optionId === optionId && (entry.toolKind === undefined || entry.toolKind === kind),
    )?.mode
    const task = this.state.tasks[permission.taskId]
    if (!mode || !task || task.acp.drift || !this.profile?.modeLadder?.includes(mode)) return
    if (this.expectedMode(task) === mode) return
    task.acp.expectedMode = mode
    this.touch(task)
    this.mark()
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
    const { acpSessionId, earlierSessionIds = [], cwd, deletable } = task.acp
    const recorded = structuredClone(task)
    this.fileTracking.dispose(sessionId)
    if (task.acp.skills || task.acp.proposals) await removeSessionSkills(skillsDirectory(this.options.dataDir, sessionId))
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
    // A session brought in from the agent's own record stays the agent's: only those Latch opened after it go.
    const kept = task.acp.imported?.agentSessionId
    const agentSessionIds = (acpSessionId === undefined ? earlierSessionIds : [...earlierSessionIds, acpSessionId]).filter(
      id => id !== kept,
    )
    this.forget(sessionId, agentSessionIds, cwd, deletable === true, confirmedOf(recorded.acp), () => this.stillListed(recorded))
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
    if (typeof value !== 'string' || !(option.options.some(item => item.value === value) || this.isCustomModel(task, option, value)))
      throw new AppError(400, 'config-value-invalid', '设置值不在可选范围内')
    this.assertUsable(task)
    await this.assertLaunch(task.acp.cwd, confirmedOf(task.acp))
    const mode = this.isModeOption(task, option)
    if (option.currentValue === value) {
      const replaced = forgetStartChoice(task, configId)
      if ((mode && task.acp.expectedMode !== value) || replaced) {
        if (mode) task.acp.expectedMode = value
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
      options.authorize?.()
      // Before the session is opened, which would set the draft's choice for this option first, or refuse on it.
      forgetStartChoice(task, configId)
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
          options.authorize?.()
          result = await binding.live.wire.request(method, params, this.limits.requestTimeoutMs)
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
        if (answered === 'wider') this.unverifiedChange(current, value)
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

  /** Whether a session started with this context gets `propose_memory`: only where the Host takes proposals. */
  private proposing(agentContext: AgentExecutionContext | undefined): boolean {
    return agentContext?.proposals === true && this.options.proposeMemory !== undefined
  }

  /**
   * Hands the Host what the session's server has written since the last read, one proposal per line, in order. The
   * session is the directory's; only `content` and `reason` come from the file. A refused line is still read.
   */
  private collectProposals(taskId: string): void {
    const previous = this.proposalReads.get(taskId) ?? Promise.resolve()
    const next = previous.then(async () => {
      const task = this.state.tasks[taskId]
      const propose = this.options.proposeMemory
      if (!task?.acp.proposals || !propose) return
      // What the session had done when the lines were written, taken before anything else can change it.
      const turn = proposalTurn(task)
      const from = { line: task.acp.proposalsRead ?? 0, offset: task.acp.proposalsOffset ?? 0 }
      const { lines, next, skipped } = await readProposals(skillsDirectory(this.options.dataDir, taskId), from)
      for (const reason of skipped) this.limits.log(`${this.agent.name} 会话 ${taskId} 的一条提议无效，已跳过：${reason}`)
      if (next.line === from.line && next.offset === from.offset) return
      for (const line of lines) {
        const common = {
          sessionId: taskId,
          ...(turn.messageId ? { messageId: turn.messageId } : {}),
          external: turn.external || task.acp.unattended === true,
          key: `line:${line.index}`,
        }
        const schedule = this.options.proposeSchedule
        const handed =
          line.kind === 'schedule'
            ? schedule
              ? schedule({ ...common, name: line.name, plan: line.plan, prompt: line.prompt })
              : Promise.reject(new Error('Schedules cannot be proposed here.'))
            : propose({ ...common, content: line.content, ...(line.reason ? { reason: line.reason } : {}) })
        await handed.catch((error: unknown) => {
          // The Host's reasons never quote the proposal.
          this.limits.log(`${this.agent.name} 会话 ${taskId} 的提议没有收下：${clip(this.redact(message(error)), 200)}`)
        })
      }
      const current = this.state.tasks[taskId]
      if (!current) return
      current.acp.proposalsRead = next.line
      current.acp.proposalsOffset = next.offset
      this.mark()
    })
    const settled = next.catch(() => {})
    this.proposalReads.set(taskId, settled)
    void settled.then(() => {
      if (this.proposalReads.get(taskId) === settled) this.proposalReads.delete(taskId)
    })
  }

  /**
   * Before the session's servers start, nothing writes the proposals file: once the Host has taken every line, empty it,
   * so their text stays only in the Host's own records. The lines taken still count toward the session's limit.
   */
  private async clearProposals(taskId: string): Promise<void> {
    await this.proposalReads.get(taskId)
    const task = this.state.tasks[taskId]
    const offset = task?.acp.proposalsOffset ?? 0
    if (!task || offset === 0 || !(await clearTakenProposals(skillsDirectory(this.options.dataDir, taskId), offset))) return
    task.acp.proposalsCleared = task.acp.proposalsRead ?? 0
    task.acp.proposalsOffset = 0
    this.mark()
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
      throw new AppError(400, 'workspace-unavailable', '工作目录必须是 已添加的项目目录')
    const real = await realpath(target).catch(() => undefined)
    const roots = (this.options.workspaces?.() ?? [this.workspaceRoot]).map(root => resolve(root))
    if (real) for (const root of roots) if ((await realpath(root).catch(() => undefined)) === real) return root
    throw new AppError(400, 'workspace-unavailable', '工作目录不是 已添加的项目目录，或目录已不存在')
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
    // A session brought in works in a directory at or below the primary folder: it must still be the one it was then.
    const imported = task.acp.imported
    if (imported) {
      const real = await realpath(task.acp.cwd).catch(() => undefined)
      const root = folders?.[0] && (await realpath(folders[0].path).catch(() => undefined))
      if (!real || !root || real !== imported.cwd || (real !== root && !real.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)))
        return false
    }
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
    return new AppError(409, 'project-config-changed', `项目中的 ${this.harnessName()} 配置与会话启动时不同，该会话不能继续。请新建会话。`)
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

  /** Why a new session's launch is not the previewed one: its definition, the folders it passes, or the project configuration. */
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

  /**
   * What a new process would launch now. The resolved path is part of the fingerprint, and so is the digest of
   * `project`; without project configuration both hashes are the definition's.
   */
  private currentLaunch(project?: ProjectConfig, passed?: LaunchFolders, route?: ModelRoute): Launch {
    const command = resolveCommand(this.agent.command)
    if (!command)
      throw new AppError(
        503,
        'agent-not-found',
        `未找到命令 ${this.agent.command}。请先安装 ${this.agent.name}，或在设置中填写可执行文件的绝对路径。`,
      )
    // The program confirmed on this Mac, and no other: a command that now resolves elsewhere waits for a new confirmation.
    if (this.agent.confirmedCommand !== undefined && command !== this.agent.confirmedCommand) throw commandMoved(this.agent.name)
    if (this.agent.confirmedCommand === undefined && this.limits.requireConfirmedCommand) throw commandUnconfirmed(this.agent.name)
    const definition = {
      resolvedCommand: command,
      args: this.agent.args,
      definitionEnv: this.agent.env,
      ...(this.selection.profile ? { presetId: this.selection.profile.presetId } : {}),
      profileVersion: this.selection.profile?.version ?? 1,
      ...(this.profile?.inheritEnv ? { inheritEnv: this.profile.inheritEnv } : {}),
      programs: programPaths(this.profile),
    }
    const definitionHash = launchHash(definition)
    const routed = this.launchRoute(route)
    const hash =
      project?.digest || passed || routed
        ? launchHash({
            ...definition,
            ...(project?.digest ? { projectConfig: project.digest } : {}),
            ...(passed ? { folders: passed } : {}),
            ...(routed ? { route: routed } : {}),
          })
        : definitionHash
    return { command, hash, definitionHash }
  }

  /** A token for one process of the session `key`, kept so that nothing the process says repeats it. */
  private openGateway(key: string, route: ModelRoute): ModelGatewayLease {
    const gateway = this.options.modelGateway
    if (!gateway) throw new AppError(503, 'model-gateway-unavailable', `Latch 现在不能转发模型请求，${this.agent.name} 没有启动。`)
    const lease = gateway.open({ sessionId: key, route })
    this.tokens.add(lease.token)
    return lease
  }

  /** The variables of an `env` route with their values, the token among them. */
  private gatewayEnv(lease: ModelGatewayLease, route: ModelRoute): Record<string, string> {
    const gateway = this.selection.profile?.gateway
    return gateway?.via === 'env' ? gateway.env({ baseURL: lease.baseURL, token: lease.token }, route) : {}
  }

  /**
   * Points an agent that takes ACP `providers/*` at the gateway, the token in a header that goes nowhere else. One that
   * does not advertise it, or lists no such provider, is refused rather than left on its own login.
   */
  private async setProvider(wire: AgentWire, advertised: boolean, lease: ModelGatewayLease): Promise<void> {
    const gateway = this.selection.profile?.gateway
    if (gateway?.via !== 'providers') return
    const refuse = (why: string) => new AppError(409, 'model-route-refused', `${this.agent.name} ${why}，不能经 Latch 使用这个模型服务。`)
    if (!advertised) throw refuse('这个版本不接受 Latch 设置模型服务')
    const listed = providersList.safeParse(await wire.request('providers/list', {}, this.limits.requestTimeoutMs))
    const slot = listed.success ? listed.data.providers.find(item => item.providerId === gateway.providerId) : undefined
    if (!slot?.supported.includes(gateway.apiType)) throw refuse('没有可以设置的模型服务')
    await wire.request(
      'providers/set',
      {
        providerId: gateway.providerId,
        apiType: gateway.apiType,
        baseUrl: lease.baseURL,
        headers: { authorization: `Bearer ${lease.token}` },
      },
      this.limits.requestTimeoutMs,
    )
  }

  /**
   * The model a session on a `providers` route started with, chosen on its first bind from what the agent lists once it
   * is pointed at the gateway. A model it does not list refuses the turn: the agent offers only models it knows.
   */
  private routeModel(taskId: string): AppError | undefined {
    const task = this.task(taskId)
    const route = task.acp.route
    if (!route || task.acp.routeModelSet || this.selection.profile?.gateway?.via !== 'providers') return undefined
    const option = task.config?.find(item => item.category === 'model')
    const value = option && listedModel(option, route.model)
    if (!option || value === undefined)
      return new AppError(
        409,
        'model-unavailable',
        `${this.agent.name} 没有列出模型「${clip(route.model, 64)}」：经 Latch 时它只用自己认识的模型。这条消息没有发出。`,
      )
    task.acp.routeModelSet = true
    const others = (task.acp.startConfig ?? []).filter(choice => choice.configId !== option.id)
    task.acp.startConfig =
      option.currentValue === value ? others : [...others, { configId: option.id, value, category: 'model', label: route.model }]
    if (!task.acp.startConfig.length) delete task.acp.startConfig
    this.mark()
    return undefined
  }

  /**
   * A turn of a session on a route that replied without one request reaching the gateway went elsewhere: the harness used
   * its own login or configuration. It is said in the session and recorded; the session goes on.
   */
  private checkRoute(run: Run, live: Live, notes: string[]): void {
    const task = this.state.tasks[run.taskId]
    if (!task?.summary.modelRoute || !live.gateway || run.gatewayMark === undefined) return
    if (live.gateway.requests() > run.gatewayMark) return
    const from = task.messages.findIndex(message => message.id === run.userMessageId)
    if (!task.messages.slice(from + 1).some(message => message.role === 'assistant' && message.text.trim())) return
    notes.push(`这一轮没有经过 Latch：${this.agent.name} 可能用了它自己的登录或配置，这一轮的内容可能发给了别的服务。`)
    task.summary.modelRoute = { ...task.summary.modelRoute, bypassed: true }
    this.mark()
    void Promise.resolve(this.options.securityEvent?.({ type: 'model-route-bypassed', sessionId: run.taskId })).catch(() => {})
  }

  /**
   * What a turn on a route sent through Latch, as the gateway counted it, with the model the session had chosen named
   * the way the service names it: the option's value or name matched to the token's models, else the route's model.
   */
  private routedTurn(run: Run, task: AcpTask): RoutedTurn | undefined {
    const lease = run.live?.gateway
    if (!lease || run.gatewayMark === undefined || !task.acp.route) return undefined
    const turn = lease.takeTurn()
    if (!turn.requests) return undefined
    const option = task.config?.find(item => item.category === 'model')
    const current = option?.options.find(item => item.value === option.currentValue)
    const keys = [option?.currentValue, current?.name].flatMap(value => (value ? [modelIdKey(value)] : []))
    const chosen = lease.models.find(model => keys.includes(modelIdKey(model))) ?? option?.currentValue ?? task.acp.route.model
    // Cut, not clipped with a note: the store reads back at most 200 characters.
    return { ...turn, chosen: chosen.slice(0, 200) }
  }

  /** The options an agent reported, as its session offers them: on a route, only models its process's token may use. */
  private offered(task: AcpTask, options: SessionConfigOption[], lease = this.lives.get(task.summary.id)?.gateway): SessionConfigOption[] {
    const gateway = this.selection.profile?.gateway
    return task.acp.route && gateway && lease ? routedOptions(options, lease.models, gateway.via) : options
  }

  /** The variables an `env` route sets, without their values, for what a launch shows. */
  private gatewayNames(): Record<string, string> {
    const gateway = this.selection.profile?.gateway
    return gateway?.via === 'env' ? Object.fromEntries(gateway.envNames.map(name => [name, ''])) : {}
  }

  /** What a launch on `route` records of it, or a refusal when this harness cannot be pointed at the gateway that way. */
  private launchRoute(route: ModelRoute | undefined): LaunchRoute | undefined {
    if (!route) return undefined
    const gateway = this.selection.profile?.gateway
    if (!gateway?.wires.includes(route.wire))
      throw new AppError(400, 'model-route-unsupported', `${this.agent.name} 不能经 Latch 使用这个模型服务`)
    return {
      providerId: route.providerId,
      origin: route.origin,
      wire: route.wire,
      via: gateway.via,
      names: gateway.via === 'env' ? [...gateway.envNames].sort() : [gateway.providerId, gateway.apiType],
    }
  }

  private assertConfirmed(confirmed: Confirmed): asserts confirmed is Confirmed & { launchHash: string } {
    if (!confirmed.launchHash) throw new AppError(409, 'l3-confirmation-missing', '此会话创建于安全升级之前，不能继续。请新建会话。')
  }

  /** The launch of a session in `cwd` with the folders it passes, unless it is no longer the one on record. */
  private async assertLaunch(cwd: string, confirmed: Confirmed): Promise<Launch> {
    this.assertConfirmed(confirmed)
    const launch = this.currentLaunch(await this.projectConfig(cwd, confirmed.folders), confirmed.folders, confirmed.route)
    if (launch.hash === confirmed.launchHash) return launch
    // A session confirmed before project configuration counted stored only the definition's fingerprint.
    throw launch.definitionHash === (confirmed.definitionHash ?? confirmed.launchHash) ? this.projectConfigChanged() : definitionChanged()
  }

  /**
   * Input to an existing session: refused after drift, without a launch on record, or once the definition changed.
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
      ...(this.profile?.expectedMode !== undefined ? { defaultMode: this.profile.expectedMode } : {}),
      ...(this.profile?.modeTiers ? { modeTiers: structuredClone(this.profile.modeTiers) } : {}),
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
      const result = await binding.live.wire.request(
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
   * A mode the agent reported. Wider than the expected one, or while Latch changes the mode wider than
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
    task.config = this.offered(task, configFromOptions(items))
    task.acp.configSource = 'options'
    this.noteModelOptions(task, task.config)
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

  /** `subagent`: the name of the subagent that reported the mode, when it was not the session's own agent. */
  private drift(task: AcpTask, expected: string | undefined, observed: string, subagent?: string): void {
    const taskId = task.summary.id
    task.acp.drift = { at: this.now(), observed: clip(observed, 64) }
    task.summary.permissionDrift = true
    // Rejected before the cancel, which would answer them as cancelled.
    for (const permission of [...this.permissions.values()]) {
      if (permission.taskId === taskId) this.closePermission(permission, this.rejection(permission.visible), this.unanswered())
    }
    const change = `${clip(expected ?? '未知', 64)} → ${clip(observed, 64)}`
    const note = subagent
      ? `子 Agent「${subagent}」报告的权限模式比这个会话宽（${change}），已取消本轮并拒绝挂起的询问。该会话不再接受输入，请新建会话。`
      : `检测到权限模式变化（${change}），已取消本轮并拒绝挂起的询问。该会话不再接受输入，请新建会话。`
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
        if (this.lives.get(taskId) === live) void live.wire.stop('stop', this.limits.stopGraceMs)
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
      // `visible` is also what the subagent ceiling left, so an option it dropped is refused here too.
      if (!permission.visible.some(item => item.optionId === optionId))
        throw new AppError(400, 'approval-option-hidden', '该选项超出会话的权限模式，Latch 不提供')
      if (!option.kind.startsWith(decision)) throw new AppError(400, 'approval-option-mismatch', '审批选项与决定不一致')
      return option
    }
    const option = permission.visible.find(item => item.kind === `${decision}_once`)
    if (option) return option
    // Rejecting always works: without a one-time reject the request is answered as cancelled.
    if (decision === 'reject') return undefined
    throw new AppError(400, 'approval-option-required', '请选择具体的审批选项')
  }

  /** Kept for the attach button: a session's start answers what only 测试启动 answered before. */
  private learnPromptCapabilities(capabilities: { images: boolean; embeddedContext: boolean }): void {
    const definitionHash = this.definitionNow(true)
    if (!definitionHash) return
    const known = this.state.promptCapabilities
    if (
      known?.definitionHash === definitionHash
      && known.images === capabilities.images
      && known.embeddedContext === capabilities.embeddedContext
    )
      return
    this.state.promptCapabilities = {
      definitionHash,
      images: capabilities.images,
      embeddedContext: capabilities.embeddedContext,
      at: this.now(),
    }
    this.mark()
    this.notify()
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
        // A change marked after the last write but before this ran found a write still under way and left it to that one.
        this.pump()
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
      lastEventAt: clock.startedAt,
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
      const task = this.task(run.taskId)
      if (task.summary.mode !== 'chat')
        await this.fileTracking.start(
          run.taskId,
          run.id,
          task.summary.folders?.length ? task.summary.folders : [{ id: 'default', path: task.acp.cwd }],
        )
      if (run.cancelRequested) {
        status = 'cancelled'
        return
      }
      // A process whose gateway token stopped working, because the service's settings changed, is replaced before the
      // next turn: its successor gets a token for the service as it is now, or the turn says why it cannot.
      const stale = this.lives.get(run.taskId)
      if (stale?.gateway && !stale.gateway.active() && !stale.wire.stopping) await stale.wire.stop('stop', this.limits.stopGraceMs)
      // Binding also confirms the permission mode, right before the prompt is written.
      const binding = await this.attach(run.taskId)
      if (run.cancelRequested) {
        status = 'cancelled'
        return
      }
      run.live = binding.live
      run.acpSessionId = binding.acpSessionId
      this.holdIdle(binding.live)
      const fork = this.state.tasks[run.taskId]?.acp.fork
      // The agent forked its own record of the source: the Host's text record of it is not sent as well.
      if (fork?.native && run.seq === 1) run.prompt = run.prompt.slice(fork.prefixLength)
      const content = await promptBlocks(run.prompt, run.attachments ?? [], binding.live.capabilities, this.options.readAttachment)
      const brief = this.state.tasks[run.taskId]?.acp.brief
      const blocks = brief ? [{ type: 'text', text: brief.segments.map(segment => segment.text).join('\n') }, ...content] : content
      if (run.cancelRequested) {
        status = 'cancelled'
        return
      }
      run.sent = true
      if (binding.live.gateway) {
        run.gatewayMark = binding.live.gateway.requests()
        // Requests between turns belong to none; this turn counts from here.
        binding.live.gateway.takeTurn()
      }
      this.phase(run, 'model')
      this.notify(run.taskId)
      const answer = binding.live.wire.request('session/prompt', {
        sessionId: binding.acpSessionId,
        prompt: blocks,
      })
      if (brief) this.briefSent(run, brief)
      const result = await answer
      status = this.outcome(run, result, notes)
    } catch (error) {
      status = this.failure(run, error, notes)
    } finally {
      await run.imageChain
      await this.toolsSettled(run, notes)
      this.finishTurn(run, status, [...run.notes, ...notes])
    }
  }

  /**
   * Recorded on the turn that carried it, and no sooner: a first turn that never reached the engine leaves it pending for
   * the next. A crash before this reaches the disk sends it twice, which an agent survives better than never getting it.
   */
  private briefSent(run: Run, brief: AgentBrief): void {
    const task = this.state.tasks[run.taskId]
    if (!task) return
    delete task.acp.brief
    const message = task.messages.find(item => item.id === run.userMessageId)
    if (message?.role === 'user') message.agentBrief = brief
    this.mark()
    this.notify(run.taskId)
  }

  private outcome(run: Run, result: unknown, notes: string[]): TaskStatus {
    const parsed = promptResult.safeParse(result)
    const task = this.state.tasks[run.taskId]
    if (parsed.success && parsed.data.usage && task) {
      // Agents disagree on whether this is per turn or per session, so it replaces rather than adds.
      task.summary.usage = { inputTokens: parsed.data.usage.inputTokens, outputTokens: parsed.data.usage.outputTokens }
    }
    const stopReason = parsed.success ? parsed.data.stopReason : undefined
    // The Host's own stop is no cancel by anyone: the turn was interrupted, whatever the agent answered.
    if (run.cancelRequested && this.closed && run.sent) {
      run.end = 'host-stopped'
      return 'interrupted'
    }
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
      run.end = this.endOf(run, error.info)
      // A stop the user asked for did not fail, and only a process that went away unasked is a failure of the turn.
      const status = run.sent && (run.cancelRequested || run.end !== 'process-exited') ? 'interrupted' : 'failed'
      notes.push(this.exitNote(run, error.info, status))
      return status
    }
    if (run.cancelRequested) {
      if (this.closed && run.sent) {
        run.end = 'host-stopped'
        return 'interrupted'
      }
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
        run.end = 'login-required'
        this.forgetProcessAfterAuth(run.live)
        notes.push(this.authMessage())
        return 'failed'
      }
      if (error.code === RPC.notFound) {
        if (run.live && run.acpSessionId) run.live.sessions.delete(run.acpSessionId)
        notes.push(`${this.agent.name} 找不到这个会话，请新建会话。`)
        return 'failed'
      }
      notes.push(
        run.attachments?.length || run.sensitiveOutput
          ? `${this.agent.name} 未能处理本轮附件请求。`
          : `${this.agent.name} 返回错误：${clip(this.redact(error.message), 1000)}`,
      )
      return 'failed'
    }
    // The same refusal as above, already turned into words on its way out of `session`.
    if (error instanceof AppError && error.code === 'agent-auth-required') run.end = 'login-required'
    const note =
      error instanceof AppError ? this.redact(error.message) : `${this.agent.name} 运行失败：${clip(this.redact(message(error)), 1000)}`
    const code = errorCodeOf(error)
    if (code) run.failure = { note, code }
    notes.push(note)
    return 'failed'
  }

  private endOf(run: Run, info: ExitInfo): RunEnd['reason'] | undefined {
    // A process that never started did not end anything; the turn's note says why it could not start.
    if (info.reason === 'spawn') return undefined
    if (info.reason === 'stop') return 'host-stopped'
    return info.reason === 'kill' && info.cause === run.taskId ? 'forced-stop' : 'process-exited'
  }

  private exitNote(run: Run, info: ExitInfo, status: TaskStatus): string {
    const name = this.agent.name
    const turn = status === 'interrupted' ? '本轮已中断' : '本轮失败'
    if (info.reason === 'kill') {
      if (info.cause === run.taskId)
        return `取消未在 ${Math.ceil(this.limits.cancelGraceMs / 1000)} 秒内完成，已强制结束 ${name} 进程；${turn}。请核对工具副作用。`
      return `${name} 进程已被强制结束；${turn}。请核对工具副作用。`
    }
    if (info.reason === 'stop') return status === 'interrupted' ? '' : `${name} 进程已随 Latch 关闭而结束；${turn}。请核对工具副作用。`
    if (info.reason === 'overflow') return `${name} 输出了超过限制的单行消息，进程已被结束；${turn}。请核对工具副作用。`
    return `${name} 进程意外退出（${describeExit(info)}）；${turn}。正在执行的工具结果未知，请核对实际副作用。${info.stderr ? '错误输出已记入日志。' : ''}`
  }

  /**
   * A turn ends only once the browser calls its agent's server has in flight are settled: a stop waits for the desktop
   * app to report each, as the built-in harness's does, so a click cannot land after the stop is confirmed. Bounded by
   * the broker's own wait for the desktop app and a margin; past it, or when a call may have acted, the turn says so.
   */
  private async toolsSettled(run: Run, notes: string[]): Promise<void> {
    const tools = run.live?.tools
    if (!tools) return
    // A call still out when the turn ends belongs to no turn any more.
    tools.cancel()
    const answer = await Promise.race([
      tools.settled(),
      sleep(TOOL_SETTLE_MS, undefined, { ref: false }).then(() => ({ resultUnknown: true, late: true })),
    ])
    if (answer.resultUnknown)
      notes.push(
        'late' in answer
          ? `停止时 ${this.agent.name} 的浏览器调用没有在 ${TOOL_SETTLE_MS / 1000} 秒内结算，结果未知：动作可能已经执行，请在「浏览器」里核对页面。`
          : `停止时 ${this.agent.name} 的浏览器调用结果未知：动作可能已经执行，请在「浏览器」里核对页面。`,
      )
  }

  private finishTurn(run: Run, status: TaskStatus, notes: string[]): void {
    clearTimeout(run.graceTimer)
    for (const asking of run.asking ?? []) asking.abort()
    // A subagent that outlives a turn that ended by itself still waits on its answer; any other end answers everything.
    const kept: Permission[] = []
    for (const permission of [...this.permissions.values()]) {
      if (permission.taskId !== run.taskId) continue
      if (status === 'idle' && permission.child && permission.live === run.live && this.lives.get(run.taskId) === permission.live) {
        run.clock.closeWait(permission.approval.id)
        kept.push(permission)
      } else this.closePermission(permission, CANCELLED_OUTCOME, this.unanswered())
    }
    const task = this.state.tasks[run.taskId]
    let outputMessageId: string | undefined
    if (task?.acp.proposals) this.collectProposals(run.taskId)
    if (task) {
      const at = this.now()
      if (run.segment) this.settleSegment(run, task, status === 'idle' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed')
      if (status === 'idle' && run.live) this.checkRoute(run, run.live, notes)
      const tools = this.tools.get(run.taskId)
      const unknown: UnknownResult[] = []
      // A call the Host's stop cut off says so, on its own row and in every client.
      const stopped = status === 'interrupted' && run.end === 'host-stopped'
      if (tools?.seq === run.seq) {
        for (const state of tools.calls.values()) {
          if (state.status === 'in_progress' && !state.final)
            unknown.push({ messageId: state.id, name: clip(this.redact(commandName(state)), COMMAND_NAME_LIMIT) })
          if (settleTool(state, at)) this.upsert(task, stopped ? { ...toolMessage(state), interrupted: true } : toolMessage(state))
        }
      }
      for (const child of run.live?.children.values() ?? []) {
        if (child.taskId !== run.taskId) continue
        const row = this.childRow(task, child)
        if (!row) continue
        for (const state of child.tools.values())
          if (!kept.some(permission => permission.tool === state) && settleTool(state, at)) upsertStep(row, toolMessage(state))
      }
      for (const item of task.messages) settleSubagent(item, at)
      // The limit on rows counts only subagents that may still report, so a long session keeps showing new ones.
      for (const child of run.live?.children.values() ?? []) {
        if (child.taskId !== run.taskId) continue
        // A stop it never answered is over with the turn: its row now says its state is unknown.
        delete child.stopping
        const row = this.childRow(task, child)
        const status = row ? row.subagent?.status : child.status
        if (status === 'done' || status === 'failed' || status === 'cancelled') child.ended = true
      }
      // Output after the latest addition is the only sign the agent went on with it; without one, the person is told.
      if (status !== 'idle' && run.steers && (run.lastOutputAt ?? 0) <= run.steeredAt!)
        notes.push(`本轮在结束前收到了追加的内容；${this.agent.name} 可能没有读到，需要的话请重新发送。`)
      task.summary.status = status
      for (const permission of kept) permission.statusAfter = status
      if (kept.length) task.summary.status = 'waiting-approval'
      // What ran when the process died took effect or not, nobody can say: automations treat it as unknown, not as a failure to retry.
      task.summary.runOutcome =
        status === 'idle'
          ? 'completed'
          : status === 'cancelled'
            ? 'cancelled'
            : status === 'interrupted' || (run.sent && run.end === 'process-exited')
              ? 'interrupted'
              : 'failed'
      if (run.end || unknown.length) task.summary.runEnd = runEndRecord(run.end ?? 'turn-ended', at, unknown)
      if (stopped) task.messages.push(interruptedNote(at))
      for (const note of notes) {
        if (!note) continue
        task.messages.push({
          id: randomUUID(),
          role: 'system',
          text: note,
          ...(status === 'failed' || status === 'interrupted' ? { state: 'failed' as const } : {}),
          ...(status === 'failed' && run.failure?.note === note ? { errorCode: run.failure.code } : {}),
          createdAt: at,
        })
      }
      const prompt = run.userMessageId === undefined ? undefined : task.messages.find(item => item.id === run.userMessageId)
      if (prompt) {
        const routed = this.routedTurn(run, task)
        prompt.turn = { ...run.clock.turn(), ...(routed ? { routed } : {}) }
      }
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
      this.touch(task)
      this.mark()
    }
    if (this.runs.get(run.taskId) === run) this.runs.delete(run.taskId)
    this.notify(run.taskId)
    this.scheduleIdle(run.taskId)
    this.fileTracking.finish(run.id, async result => {
      const current = this.state.tasks[run.taskId]
      const message = current?.messages.find(item => item.id === outputMessageId)
      if (!current || !message) return
      recordFileOutputs(message, result)
      current.revision++
      this.mark()
      await this.flush()
      this.notify(run.taskId)
    })
    void this.flush()
      .catch(() => {})
      .finally(() => run.resolveDone())
  }

  private requestCancel(run: Run, withGrace: boolean): void {
    if (!run.cancelRequested) {
      run.cancelRequested = true
      this.phase(run, 'cancelling', run.activity.toolName)
      if (run.sent && run.live && run.acpSessionId) run.live.wire.notify('session/cancel', { sessionId: run.acpSessionId })
      // Nothing reached the agent yet: withdraw the session setup instead of waiting for it.
      else if (!run.sent)
        this.attaching
          .get(run.taskId)
          ?.controller.abort(this.closed ? new AppError(503, 'runtime-closed', '运行节点已关闭') : cancelledBeforeSend())
      for (const permission of [...this.permissions.values()]) {
        if (permission.taskId === run.taskId) this.closePermission(permission, CANCELLED_OUTCOME, this.unanswered())
      }
      for (const asking of run.asking ?? []) asking.abort()
      // The browser calls its server has in flight stop too; the Host settles each with the desktop app.
      run.live?.tools?.cancel()
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
    void run.live.wire.stop('kill', this.limits.stopGraceMs, run.taskId)
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
    await Promise.all([...this.lives.values()].map(live => live.wire.stop('stop', this.limits.stopGraceMs)))
  }

  private async ensureProcess(key: string, cwd: string, confirmed: Confirmed): Promise<Live> {
    for (;;) {
      const pending = this.spawning.get(key)
      if (pending) return pending
      const live = this.lives.get(key)
      if (live?.initialized && !live.wire.stopping) return live
      // A process being stopped would drop new requests; start its successor only once it is gone.
      if (live) {
        await live.wire.exited
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
    const running = [...this.lives.values()].filter(live => !live.wire.stopping)
    if (running.length < this.limits.maxProcesses) return
    const victim = running
      .filter(live => live.initialized && (live.capabilities.resume || live.capabilities.load) && !this.busy(live.key))
      .sort((a, b) => a.lastUsed - b.lastUsed)[0]
    if (!victim) throw new AppError(503, 'agent-busy', `同时运行的 ${this.agent.name} 会话过多，请先结束一些会话`)
    this.holdIdle(victim)
    void victim.wire.stop('stop', this.limits.stopGraceMs)
  }

  private async spawnProcess(key: string, cwd: string, confirmed: Confirmed): Promise<Live> {
    const name = this.agent.name
    const paused = this.health.pausedUntil()
    if (paused) throw new AppError(503, 'agent-paused', `${name} 在一分钟内连续崩溃 3 次，已暂停自动重启。请检查安装与登录状态，稍后再试。`)
    // Every start reads the project configuration again: the agent loads it now, not when the session was confirmed.
    const first = await this.assertLaunch(cwd, confirmed)
    // A command older than its profile supports would not start, or would start and never answer: refused before it
    // runs. Not recorded as the harness's last error: it says so itself, and an upgrade ends it. Before the re-check
    // below, which stays the last await before the spawn.
    await assertVersion(this.agent, first.command)
    const wait = this.health.restartDelay(this.limits.restartDelayMs)
    if (wait) await sleep(wait, undefined, { signal: this.lifetime.signal, ref: false }).catch(() => {})
    this.assertOpen()
    const sessionTmpDir = await this.prepareTmpDir(key)
    const { route } = confirmed
    const materializedEnv = await this.selection.profile?.materialize?.({
      dataDir: this.options.dataDir,
      ...(route ? { route: { route, directory: sessionTmpDir } } : {}),
    })
    this.assertOpen()
    // Checked again after the awaits: the command found on PATH or the project configuration may have changed meanwhile.
    const { command } = await this.assertLaunch(cwd, confirmed)
    this.assertOpen()
    this.makeRoom()
    // Opened last, so that nothing before the spawn can fail while a token is out.
    const gateway = route ? this.openGateway(key, route) : undefined
    let live!: Live
    let wire: AgentWire
    try {
      wire = openWire(
        this.selection.profile?.wire,
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
            ...(gateway ? { gatewayEnv: this.gatewayEnv(gateway, route!) } : {}),
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
      gateway?.close()
      const detail = clip(this.redact(message(error)), 1000)
      this.health.lastError = `无法启动：${clip(detail, 300)}`
      throw new AppError(503, 'agent-start-failed', `${name} 启动失败：${detail}`)
    }
    if (gateway) {
      // A token outlives neither its process nor a change to the service it names.
      void wire.exited.then(() => gateway.close())
    }
    live = {
      key,
      wire,
      ...(gateway ? { gateway } : {}),
      initialized: false,
      capabilities: {
        resume: false,
        list: false,
        load: false,
        delete: false,
        close: false,
        additionalDirectories: false,
        images: false,
        embeddedContext: false,
        steer: false,
        logout: false,
      },
      authMethods: [],
      sessions: new Map(),
      children: new Map(),
      lastUsed: Date.now(),
    }
    this.lives.set(key, live)
    try {
      const result = initializeResult.safeParse(
        await wire.request(
          'initialize',
          {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: clientCapabilities(this.selection.preset?.signIn === undefined, this.options.askUser !== undefined),
            clientInfo: { name: 'latch', title: 'Latch', version: CLIENT_VERSION },
          },
          Math.min(this.limits.handshakeTimeoutMs, this.limits.requestTimeoutMs),
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
        list: capabilities?.sessionCapabilities?.list != null,
        load: capabilities?.loadSession === true,
        delete: capabilities?.sessionCapabilities?.delete != null,
        close: capabilities?.sessionCapabilities?.close != null,
        additionalDirectories: isObject(capabilities?.sessionCapabilities?.additionalDirectories),
        images: capabilities?.promptCapabilities?.image === true,
        embeddedContext: capabilities?.promptCapabilities?.embeddedContext === true,
        steer: result.data._meta?.steering?.supported === true,
        logout: capabilities?.auth?.logout != null,
      }
      this.learnPromptCapabilities(live.capabilities)
      this.auth.learn(command, terminalLogins(result.data.authMethods), live.capabilities.logout)
      live.authMethods = (result.data.authMethods ?? []).slice(0, 16).map(method => ({
        name: clip(this.redact(method.name), 200),
        ...(method.description ? { description: clip(this.redact(method.description), 500) } : {}),
      }))
      if (reported) live.agentVersion = clip(reported, 100)
      if (gateway && this.selection.profile?.gateway?.via === 'providers')
        await this.setProvider(wire, capabilities?.providers !== undefined, gateway)
      live.initialized = true
      this.health.lastError = undefined
      return live
    } catch (error) {
      const info = error instanceof ConnectionClosed ? error.info : await wire.stop('kill', this.limits.stopGraceMs)
      if (error instanceof AppError) {
        this.health.lastError = clip(error.message, 300)
        throw error
      }
      const exited = error instanceof ConnectionClosed || error instanceof ConnectionStopping ? info : undefined
      if (this.closed) throw new AppError(503, 'runtime-closed', '运行节点已关闭')
      if (error instanceof RequestTimeout) {
        // The step that timed out: `initialize`, or a setup request after it (the gateway's `providers/*`).
        const refused =
          error.method === 'initialize'
            ? this.handshakeTimeout('initialize', Math.min(this.limits.handshakeTimeoutMs, this.limits.requestTimeoutMs))
            : this.handshakeTimeout(error.method, this.limits.requestTimeoutMs)
        this.health.lastError = clip(refused.message, 300)
        throw refused
      }
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
      throw new AppError(503, 'agent-start-failed', `${name} 启动失败：${detail}${info.stderr ? '。错误输出已记入日志。' : ''}`)
    }
  }

  private onExit(live: Live, info: ExitInfo): void {
    if (this.lives.get(live.key) === live) this.lives.delete(live.key)
    live.tools?.close()
    this.auth.forget(live)
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
        const sensitive =
          this.runs.get(live.key)?.attachments?.length
          || this.runs.get(live.key)?.sensitiveOutput
          || this.state.tasks[live.key]?.messages.some(message => message.attachments?.length)
        this.limits.log(
          sensitive
            ? `Harness ${this.agent.id} 进程结束（${describeExit(info)}）；含附件会话的错误输出未写入日志。`
            : `Harness ${this.agent.id} 进程结束（${describeExit(info)}），stderr 末尾（已脱敏）：\n${info.stderr}`,
        )
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
      const unrouted = this.routeModel(taskId)
      const refused = unrouted ?? (await this.applyStart(taskId, binding, signal))
      await this.verifyMode(taskId, binding, signal)
      if (refused) throw refused
      return binding
    } catch (error) {
      if (signal.aborted) throw signal.reason
      throw this.publicError(error, live)
    } finally {
      if (quiet) this.leave(this.quiet, taskId)
    }
  }

  /**
   * Whether this harness takes MCP servers in `session/new`: every ACP agent does, except where its preset says it does
   * not (pi, whose RPC mode takes none).
   */
  private takesMcpServers(): boolean {
    return this.selection.profile?.wire !== 'pi' && this.selection.preset?.skillServer !== false
  }

  /**
   * A fresh token of the Host's tool gateway for the session's browser tools on this process, revoking the one before it;
   * none for a harness that takes no MCP servers, for a session without a project (of 我的 Agent, or a conversation with
   * 通用), when the Host has no gateway, or when the Host declines (no browser provider registered now): the next open,
   * resume, load or fork asks again. The Host checks the session again on every call.
   */
  private openTools(taskId: string, live: Live): ToolGatewayLease | undefined {
    live.tools?.close()
    delete live.tools
    const gateway = this.options.toolGateway
    const task = this.task(taskId)
    if (!gateway || !this.takesMcpServers() || task.acp.proposals || task.summary.agent || task.summary.agentPrivate) return undefined
    let lease: ToolGatewayLease | undefined
    try {
      lease = gateway.open({ sessionId: taskId, describe: (tool, args) => this.describeToolCall(taskId, tool, args) })
    } catch (error) {
      this.limits.log(`${this.agent.name} 会话 ${taskId} 没有拿到浏览器工具：${clip(this.redact(message(error)), 200)}`)
      return undefined
    }
    if (!lease) return undefined
    this.tokens.add(lease.token)
    live.tools = lease
    // A token outlives neither its process nor the next one issued for the session.
    void live.wire.exited.then(() => lease.close())
    return lease
  }

  /**
   * Fresh tokens for the session's own MCP servers (Latch's, as the Host defines them now) on this process, revoking the
   * ones before: none for a harness that takes no MCP servers or a Host without a gateway. A server that fails to start
   * is said in the session, which goes on without it.
   */
  private async openMcp(taskId: string, live: Live): Promise<McpServerLease[]> {
    for (const lease of live.mcp ?? []) lease.close()
    delete live.mcp
    const gateway = this.options.toolGateway
    if (!gateway?.openMcp || !this.takesMcpServers()) return []
    const task = this.task(taskId)
    let leases: McpServerLease[]
    try {
      leases = await gateway.openMcp({
        sessionId: taskId,
        ...(task.summary.agent ? { agentId: task.summary.agent.customAgentId } : {}),
        projectId: task.summary.workspaceId ?? 'default',
        cwd: task.acp.cwd,
        onFailed: (name, reason) => this.noteMcpFailure(taskId, name, reason),
      })
    } catch (error) {
      this.limits.log(`${this.agent.name} 会话 ${taskId} 没有拿到 MCP 服务器：${clip(this.redact(message(error)), 200)}`)
      return []
    }
    for (const lease of leases) this.tokens.add(lease.token)
    live.mcp = leases
    void live.wire.exited.then(() => {
      for (const lease of leases) lease.close()
    })
    return leases
  }

  private noteMcpFailure(taskId: string, name: string, reason: McpStartFailure): void {
    const task = this.state.tasks[taskId]
    if (!task) return
    task.messages.push({
      id: randomUUID(),
      role: 'system',
      text: `MCP 服务器「${name}」没有启动：${MCP_FAILURE_TEXT[reason]}`,
      createdAt: this.now(),
    })
    this.touch(task)
    this.mark()
    this.notify(taskId)
  }

  /**
   * The session's own row of a call that reached the tool gateway: the oldest unmatched call of this turn whose name or
   * title is exactly `tool` of the `latch-browser` server (as `mcp__latch-browser__<tool>`, Codex's
   * `latch-browser.<tool>`, or `latch-browser: <tool>`) and whose input is `args`. Its approval is named only when that row
   * is the only such call, since two identical calls cannot be told apart. Nothing when the agent reports no such row (it
   * need not); the records then carry the gateway's call alone. And whether the session's turn runs, so the Host refuses
   * a call between turns or while a stop settles.
   */
  private describeToolCall(taskId: string, tool: string, args: Record<string, unknown>): ToolGatewayCallContext {
    const run = this.runs.get(taskId)
    const context: ToolGatewayCallContext = { turn: !run?.sent ? 'none' : run.cancelRequested ? 'stopping' : 'running' }
    if (run) {
      const key = `tools:${randomUUID()}`
      context.waitForUser = () => {
        run.clock.openWait(key)
        return () => run.clock.closeWait(key)
      }
    }
    const calls = this.tools.get(taskId)?.calls
    if (!calls) return context
    let wanted: string
    try {
      wanted = canonicalJson(args)
    } catch {
      return context
    }
    const sameInput = (input: unknown) => {
      try {
        return canonicalJson(input) === wanted
      } catch {
        return false
      }
    }
    const names = new Set([`mcp__latch-browser__${tool}`, `latch-browser.${tool}`, `latch-browser: ${tool}`])
    const matches = [...calls.values()].filter(
      state =>
        !state.gatewayMatched
        && !state.final
        && state.status !== 'completed'
        && state.status !== 'failed'
        && [state.name, state.title].some(value => typeof value === 'string' && names.has(value.trim()))
        && sameInput(state.rawInput),
    )
    const [oldest] = matches
    if (!oldest) return context
    oldest.gatewayMatched = true
    context.toolCallId = oldest.id.slice('tool:'.length)
    if (matches.length === 1 && oldest.decision?.outcome === 'allowed' && oldest.approvalId) context.approvalId = oldest.approvalId
    return context
  }

  private async session(taskId: string, live: Live, signal: AbortSignal): Promise<Binding> {
    const wire = live.wire
    // Opening a session is bounded more tightly than other requests: an agent that never answers is stopped and the
    // start refused, so the session fails with a reason instead of running until the general timeout.
    const setupMs = Math.min(this.limits.sessionSetupTimeoutMs, this.limits.requestTimeoutMs)
    const setup = (method: string, params: unknown): Promise<unknown> =>
      wire.request(method, params, setupMs, signal).catch(async (error: unknown) => {
        if (!(error instanceof RequestTimeout)) throw error
        // The turn fails once the process is gone, as after an initialize that timed out: stdin closed, then signals.
        await wire.stop('stop', this.limits.stopGraceMs)
        throw this.handshakeTimeout(method, setupMs)
      })
    const task = this.task(taskId)
    const cwd = task.acp.cwd
    const current = task.acp.acpSessionId
    if (current && live.sessions.get(current) === taskId) return { live, acpSessionId: current }
    // ACP wants the whole list again for every new, resumed or loaded session: omitting it would drop the folders.
    const passed = storedFolders(task.acp)
    const directories = passed?.via === 'acp' ? { additionalDirectories: [...passed.paths] } : {}
    if (task.acp.proposals) await this.clearProposals(taskId)
    const mcpServers: unknown[] =
      task.acp.skills || task.acp.proposals
        ? [skillsServer(skillsDirectory(this.options.dataDir, taskId), task.acp.proposals === true, task.acp.proposalsCleared ?? 0)]
        : []
    const tools = this.openTools(taskId, live)
    if (tools) mcpServers.push(browserServer(tools))
    for (const lease of await this.openMcp(taskId, live)) mcpServers.push(mcpBridgeServer(lease))
    if (passed?.via === 'acp' && !live.capabilities.additionalDirectories) {
      void live.wire.stop('stop', this.limits.stopGraceMs)
      throw this.foldersUnsupported(false)
    }
    let acpSessionId: string
    let result: unknown
    if (!current) {
      result = (await this.ownFork(taskId, live, setup, mcpServers)) ?? (await setup('session/new', { cwd, mcpServers, ...directories }))
      const id = sessionState.safeParse(result)
      if (!id.success || !id.data.sessionId) throw new AppError(502, 'agent-protocol', `${this.agent.name} 未返回有效的会话标识`)
      acpSessionId = id.data.sessionId
    } else if (live.capabilities.resume) {
      result = await setup('session/resume', { sessionId: current, cwd, mcpServers, ...directories })
      acpSessionId = current
    } else if (live.capabilities.load) {
      // The replay arrives before the response while the session is still unbound, so it is discarded.
      result = await setup('session/load', { sessionId: current, cwd, mcpServers, ...directories })
      acpSessionId = current
    } else {
      throw new AppError(409, 'harness-session-lost', '该 Harness 不支持恢复会话，请新建会话')
    }
    const target = this.state.tasks[taskId]
    if (!target) throw new AppError(404, 'task-not-found', '找不到该任务')
    live.sessions.set(acpSessionId, taskId)
    // What the process was answered for before this session was on record goes into it now.
    for (const note of live.heldNotes?.splice(0) ?? [])
      target.messages.push({ id: randomUUID(), role: 'system', text: clip(this.redact(note), 4000), createdAt: this.now() })
    target.acp.acpSessionId = acpSessionId
    target.acp.deletable = live.capabilities.delete
    if (live.agentVersion) target.acp.agentVersion = live.agentVersion
    const parsed = sessionState.safeParse(result)
    const folded = parsed.success ? foldConfig(parsed.data) : undefined
    if (folded) {
      target.config = this.offered(target, folded.options, live.gateway)
      target.acp.configSource = folded.source
      this.applyModel(target)
      // What a session on a route offers is what the gateway's service has, not the harness's own list.
      if (!target.acp.route) {
        if (!current) this.noteStartCatalogue(target, folded.options)
        else this.noteModelOptions(target, folded.options)
      }
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
      if (wire.stopping || live.sessions.get(acpSessionId) !== taskId)
        throw new AppError(503, 'agent-exited', `${this.agent.name} 进程已退出，请重试`)
    }
    return { live, acpSessionId }
  }

  /**
   * A session forked from another of this driver's, opened as the agent's own fork of the source's record: the answer,
   * like `session/new`'s. Undefined when it is no such fork, or when the agent cannot fork there, which the session then
   * says, so that its first prompt sends the Host's text record instead.
   */
  private async ownFork(
    taskId: string,
    live: Live,
    setup: (method: string, params: unknown) => Promise<unknown>,
    mcpServers: unknown[],
  ): Promise<unknown> {
    const task = this.task(taskId)
    const fork = task.acp.fork
    if (!fork || fork.native) return undefined
    // Only the first turn's prompt carries the text record that a fork replaces or falls back to. A first turn that
    // ended before the session opened leaves a later one to open it as any new session would.
    if (this.runs.get(taskId)?.seq !== 1) {
      delete task.acp.fork
      this.mark()
      return undefined
    }
    const point = this.forkPoint(task, fork, live)
    let reason: string
    if (typeof point === 'string') reason = point
    else
      try {
        const result = await setup(FORK_METHOD, { sessionId: point.source, cwd: task.acp.cwd, before: point.before, mcpServers })
        const forked = this.state.tasks[taskId]
        if (forked?.acp.fork) {
          forked.acp.fork.native = true
          const first = forked.messages.find(message => message.role === 'user')
          if (first) first.nativeFork = true
        }
        return result
      } catch (error) {
        if (!(error instanceof ForkRefused)) throw error
        reason = error.message
      }
    const target = this.state.tasks[taskId]
    if (target) {
      delete target.acp.fork
      target.messages.push({
        id: randomUUID(),
        role: 'system',
        text: `${this.agent.name} 没有用它自己的记录分叉：${clip(this.redact(reason), 300)}。这次以文字带上来源会话到这一轮为止的记录。`,
        createdAt: this.now(),
      })
      this.touch(target)
      this.mark()
      this.notify(taskId)
    }
    return undefined
  }

  /**
   * Where the agent's own record of the source session is to be forked: the session to fork and the time its next turn
   * began, before which everything it wrote belongs to the turns up to the fork. Or why it cannot be forked there.
   */
  private forkPoint(task: AcpTask, fork: NonNullable<AcpRecord['fork']>, live: Live): { source: string; before: string } | string {
    if (!live.wire.forks) return '它不能分叉自己的会话'
    const source = this.state.tasks[fork.taskId]
    if (!source) return '找不到来源会话'
    if (source.acp.cwd !== task.acp.cwd) return '新会话不在来源会话的文件夹里'
    const end = source.messages.findIndex(message => message.id === fork.upToMessageId)
    if (end < 0) return '找不到分叉的位置'
    const later = source.messages.slice(end + 1)
    // Its record of an earlier context is another session, and a pending new context has none yet.
    if (source.acp.contextCleared || later.some(message => message.role === 'user' && message.freshContext))
      return '来源会话在这一轮之后清空过上下文'
    if (!source.acp.acpSessionId) return '来源会话还没有它自己的记录'
    const next = later.find(message => message.role === 'user' && !message.steered)
    if (next && !next.createdAt) return '来源会话没有记下下一轮开始的时间'
    return { source: source.acp.acpSessionId, before: next?.createdAt ?? this.now() }
  }

  /**
   * What the draft chose, set once the session exists and before its first prompt: the model, then what it offers for
   * that model, then the mode, which `verifyMode` sets and reads back. Each answer is read back. A model or mode no longer
   * offered, or a model the agent does not take, refuses the turn: the refusal is returned once the rest of the draft is
   * set too, and the mode after it, so that nothing of the draft is left for later and the session shows what the next
   * send runs on. Anything else no longer offered is left at the agent's default, and the session says so.
   */
  private async applyStart(taskId: string, binding: Binding, signal: AbortSignal): Promise<AppError | undefined> {
    const task = this.task(taskId)
    const chosen = task.acp.startConfig
    if (!chosen?.length) return undefined
    const name = this.agent.name
    const live = (configId: string) => this.state.tasks[taskId]?.config?.find(item => item.id === configId)
    const role = (choice: StartChoice): keyof typeof START_ORDER => {
      const option = live(choice.configId)
      const category = option ? (this.isModeOption(task, option) ? 'mode' : option.category) : choice.category
      return category === 'model' || category === 'mode' ? category : 'other'
    }
    const named = (choice: StartChoice) => clip(choice.label ?? choice.value, 64)
    const left: string[] = []
    // The first refusal is the one the turn reports.
    let refused: AppError | undefined
    for (const choice of chosen.toSorted((a, b) => START_ORDER[role(a)] - START_ORDER[role(b)])) {
      const kind = role(choice)
      const option = live(choice.configId)
      if (!option || !(option.options.some(item => item.value === choice.value) || this.isCustomModel(task, option, choice.value))) {
        if (kind === 'model' || kind === 'mode') await this.dropStartChoice(taskId, choice)
        if (kind === 'model')
          refused ??= new AppError(
            409,
            'model-unavailable',
            `${name} 现在没有模型「${named(choice)}」，这条消息没有发出。${this.nowUsing(taskId, option, '模型')}`,
          )
        else if (kind === 'mode')
          refused ??= new AppError(
            409,
            'mode-unavailable',
            `${name} 现在没有「${named(choice)}」这个权限模式，这条消息没有发出。${this.nowUsing(taskId, this.modeOption(task), '权限')}`,
          )
        else left.push(named(choice))
        continue
      }
      if (kind === 'mode') {
        task.acp.expectedMode = choice.value
        continue
      }
      if (option.currentValue !== choice.value) {
        try {
          await this.writeStart(taskId, binding, option, choice.value, signal)
        } catch (error) {
          // A refusal of the value is the agent's answer; anything else, such as a login or a lost process, is its own.
          if (!(error instanceof RpcError) || error.code === RPC.authRequired) throw error
        }
      }
      const now = live(choice.configId)
      if (now?.currentValue === choice.value) continue
      if (kind === 'model') {
        await this.dropStartChoice(taskId, choice)
        refused ??= new AppError(
          409,
          'model-unverified',
          `${name} 没有换到模型「${named(choice)}」，这条消息没有发出。${this.nowUsing(taskId, now, '模型')}`,
        )
        continue
      }
      left.push(named(choice))
    }
    const current = this.task(taskId)
    delete current.acp.startConfig
    if (left.length)
      current.messages.push({
        id: randomUUID(),
        role: 'system',
        text: `${name} 这次没有提供${left.map(item => `「${item}」`).join('、')}，用它自己的默认值。`,
      })
    this.touch(current)
    this.mark()
    this.notify(taskId)
    await this.flush()
    return refused
  }

  /**
   * A model or mode the agent no longer offers, or a model it does not take, refuses the turn once and is dropped at once,
   * so that it is not tried again even when setting the rest of the draft fails; the session then shows what it runs on.
   */
  private async dropStartChoice(taskId: string, choice: StartChoice): Promise<void> {
    const task = this.task(taskId)
    if (!forgetStartChoice(task, choice.configId)) return
    this.touch(task)
    this.mark()
    this.notify(taskId)
    await this.flush()
  }

  /** The sentence after a refused start: what the next send will use instead, and that it can be changed first. */
  private nowUsing(taskId: string, option: SessionConfigOption | undefined, control: '模型' | '权限'): string {
    const value = control === '权限' ? (this.expectedMode(this.task(taskId)) ?? option?.currentValue) : option?.currentValue
    const shown = option?.options.find(item => item.value === value)?.name ?? value
    return shown === undefined ? `在${control}里换一个后重试。` : `再发送会用「${clip(shown, 64)}」，也可以先在${control}里换一个。`
  }

  /** One choice of a start, written the way the session's configuration style takes it, and its answer recorded. */
  private async writeStart(
    taskId: string,
    binding: Binding,
    option: SessionConfigOption,
    value: string,
    signal: AbortSignal,
  ): Promise<void> {
    const legacy = this.task(taskId).acp.configSource === 'legacy'
    // A legacy agent has a method for its model and its mode only.
    if (legacy && option.category !== 'model') return
    const result = await binding.live.wire.request(
      legacy ? 'session/set_model' : 'session/set_config_option',
      legacy ? { sessionId: binding.acpSessionId, modelId: value } : { sessionId: binding.acpSessionId, configId: option.id, value },
      this.limits.requestTimeoutMs,
      signal,
    )
    const task = this.state.tasks[taskId]
    if (!task) return
    const parsed = configUpdate.safeParse(result)
    if (!legacy && parsed.success) this.reportConfig(task, parsed.data.configOptions)
    // A legacy agent answers set_model with nothing to read back but its own success.
    else if (legacy) {
      const target = task.config?.find(item => item.id === option.id)
      if (target) target.currentValue = value
      this.applyModel(task)
    }
  }

  private publicError(error: unknown, live: Live | undefined): AppError {
    const name = this.agent.name
    if (error instanceof AppError) return error
    if (error instanceof ConnectionClosed)
      return new AppError(503, 'agent-exited', `${name} 进程已退出（${this.redact(describeExit(error.info))}）。`)
    if (error instanceof ConnectionStopping) return new AppError(503, 'agent-exited', `${name} 进程正在停止，请稍后重试。`)
    if (error instanceof RequestTimeout) return new AppError(504, 'agent-timeout', `${name} 长时间没有响应，请稍后重试`)
    if (error instanceof RpcError) {
      if (error.code === RPC.authRequired) {
        this.forgetProcessAfterAuth(live)
        return new AppError(409, 'agent-auth-required', this.authMessage())
      }
      if (error.code === RPC.notFound) return new AppError(409, 'harness-session-lost', '该 Harness 已找不到这个会话，请新建会话')
      return new AppError(502, 'agent-error', `${name} 返回错误：${clip(this.redact(error.message), 1000)}`)
    }
    return new AppError(500, 'agent-error', `${name} 运行失败：${clip(this.redact(message(error)), 1000)}`)
  }

  /**
   * The refusal for an agent that did not answer `initialize` or opening a session in time; its process is already
   * being stopped. Often a version too old for the arguments the preset passes, so the line says where to look.
   */
  private handshakeTimeout(method: string, ms: number): AppError {
    const seconds = Math.max(1, Math.round(ms / 1000))
    const step =
      method === 'initialize' ? '启动握手' : method.startsWith('session/') || method.startsWith('_latch/') ? '建立会话' : '启动设置'
    const minimum = this.selection.profile?.minimumVersion?.minimum
    const hint = minimum ? `确认它是 ${minimum} 或更高版本、能在终端里正常运行后重试。` : '确认它能在终端里正常运行后重试。'
    return new AppError(504, 'agent-handshake-timeout', `${this.agent.name} ${seconds} 秒内没有完成${step}（${method}），已停止它。${hint}`)
  }

  /** An agent may read its login once at startup, so a retry after logging in has to reach a new process. */
  private forgetProcessAfterAuth(live: Live | undefined): void {
    if (live) void live.wire.stop('stop', this.limits.stopGraceMs).catch(() => {})
  }

  private authMessage(): string {
    return `${this.agent.name} 还没登录。${this.selection.preset?.signIn ?? '按它自己的方式登录后重试。'}`
  }

  private holdIdle(live: Live): void {
    clearTimeout(live.idleTimer)
    live.idleTimer = undefined
    live.lastUsed = Date.now()
  }

  /** Stops a task's idle process only when its session can be restored later. */
  private scheduleIdle(key: string): void {
    const live = this.lives.get(key)
    if (!live?.initialized || live.wire.stopping || this.closed) return
    this.holdIdle(live)
    if (!live.capabilities.resume && !live.capabilities.load) return
    if (this.busy(key)) return
    live.idleTimer = setTimeout(() => {
      live.idleTimer = undefined
      // stop() marks the wire as stopping at once, so ensureProcess hands no new work to it.
      if (this.lives.get(key) !== live || this.busy(key)) return
      // A stop sent after the turn that the subagent never answered is over with its process.
      for (const child of live.children.values()) delete child.stopping
      void live.wire.stop('stop', this.limits.stopGraceMs)
    }, this.limits.idleMs)
    live.idleTimer.unref()
  }

  private busy(key: string): boolean {
    if (this.runs.has(key) || this.attaching.has(key) || this.forgetting.has(key) || this.spawning.has(key) || this.holds.has(key))
      return true
    // A request that came after its turn waits on the person, and stopping the process would answer it.
    for (const permission of this.permissions.values()) if (permission.taskId === key) return true
    return false
  }

  /**
   * Cleans up after a removed task in the background: asks the agent to delete its sessions when it offers that,
   * starting a process only for the launch on record and only in a project the Host still lists, then stops
   * the process and removes its TMPDIR. Otherwise, or after a failure, only the agent's own copy is left behind.
   */
  private forget(
    key: string,
    acpSessionIds: readonly string[],
    cwd: string,
    deletable: boolean,
    confirmed: Confirmed,
    listed: () => Promise<boolean>,
  ): void {
    const work: Promise<void> = (async () => {
      try {
        await this.spawning.get(key)?.catch(() => undefined)
        let live = this.lives.get(key)
        if (live && (!live.initialized || live.wire.stopping)) {
          await live.wire.exited
          live = undefined
        }
        if (!acpSessionIds.length) return
        for (const id of acpSessionIds) live?.sessions.delete(id)
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
        for (const id of acpSessionIds) target.sessions.delete(id)
        if (!target.capabilities.delete) return
        this.holdIdle(target)
        for (const id of acpSessionIds)
          await target.wire.request('session/delete', { sessionId: id }, Math.min(this.limits.requestTimeoutMs, 10_000)).catch(() => {})
      } catch {
        /* Best effort. */
      } finally {
        const live = this.lives.get(key)
        if (live) await live.wire.stop('stop', this.limits.stopGraceMs).catch(() => {})
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
    if (live) await live.wire.stop('stop', this.limits.stopGraceMs).catch(() => {})
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
    if (method === ELICITATION_METHOD && this.options.askUser) {
      const ask = elicitationAsk(params)
      if (ask) return this.askPerson(live, ask)
      // URL mode, or a field or length Latch cannot ask: invalid params, as ACP answers a mode the client did not offer.
      // A URL-mode request's link is never written into the session.
      const url = isObject(params) && ((params as { mode?: unknown }).mode !== 'form' || 'url' in (params as object))
      this.noteUnrecognized(live, method, url ? undefined : params, '这个提问的形式 Latch 还不能显示')
      return Promise.reject(new RpcError(RPC.invalidParams, 'Invalid params'))
    }
    // Cursor's own question, from whichever agent sends it.
    if (method === CURSOR_QUESTION_METHOD) {
      const read = cursorAsk(params)
      if (read?.tooLong) {
        this.noteUnrecognized(live, method, params, '这个提问超出 Latch 能显示的长度')
        return Promise.reject(new RpcError(RPC.invalidParams, 'Invalid params'))
      }
      if (read?.ask && this.options.askUser) return this.askPerson(live, read.ask)
      if (read) return Promise.resolve(this.declineQuestion(live, cursorDeclineNote(read.parsed, this.agent.name)))
    }
    const requests = this.selection.profile?.extensions?.requests
    const extension = requests && Object.hasOwn(requests, method) ? requests[method] : undefined
    const answered = extension && this.onExtension(live, extension, params, id)
    if (answered) return answered
    // File system and terminal are not advertised, so agents must not call them.
    this.noteUnrecognized(live, method, params)
    return Promise.reject(new RpcError(RPC.methodNotFound, `Method not found: ${clip(method, 200)}`))
  }

  /**
   * A request outside ACP that this harness's profile reads. These carry no session ID, and a process runs one session,
   * so they belong to the session the process was started for. Undefined: params it cannot read.
   */
  private onExtension(live: Live, extension: ExtensionRequest, params: unknown, rpcId: RpcId): Promise<unknown> | undefined {
    const task = this.state.tasks[live.key]
    if ('decline' in extension) {
      const declined = extension.decline(params, this.agent.name)
      if (!declined) return undefined
      // Recorded whether or not the session is yet: the answer was given either way.
      if (declined.rejected) this.securityEvent({ type: 'approval-auto-rejected', sessionId: live.key, reason: 'harness-declined' })
      if (!task) (live.heldNotes ??= []).push(declined.note)
      if (task) {
        const run = this.runs.get(live.key)
        if (run?.segment && run.live === live) this.settleSegment(run, task, 'completed')
        task.messages.push({ id: randomUUID(), role: 'system', text: clip(this.redact(declined.note), 4000), createdAt: this.now() })
        this.touch(task)
        this.mark()
        this.notify(live.key)
      }
      return Promise.resolve(declined.reply)
    }
    const ask = extension.ask(params)
    if (!ask) return undefined
    const sessionId = task?.acp.acpSessionId
    if (!sessionId) return Promise.resolve(extension.answer(undefined))
    return this.onPermission(live, { sessionId, toolCall: { ...ask.toolCall, status: 'pending' }, options: ask.options }, rpcId).then(
      result => {
        const chosen = chosenOption(result)
        // The call is the ask itself, so the answer settles it; the harness sends no update for it.
        const current = this.state.tasks[live.key]
        const kind = ask.options.find(option => option.optionId === chosen)?.kind
        if (current && kind && this.runs.get(live.key)?.live === live) {
          const state = this.toolState(current, ask.toolCall.toolCallId)
          mergeTool(state, { toolCallId: ask.toolCall.toolCallId, status: kind === 'allow_once' ? 'completed' : 'failed' }, this.now())
          this.upsert(current, toolMessage(state))
          this.touch(current)
          this.mark()
          this.notify(live.key)
        }
        return extension.answer(chosen)
      },
    )
  }

  /** A question Latch cannot put to the person: written in the session, so they can answer in their next message. */
  private declineQuestion(live: Live, note: string): unknown {
    const task = this.state.tasks[live.key]
    if (task) {
      const run = this.runs.get(live.key)
      if (run?.segment && run.live === live) this.settleSegment(run, task, 'completed')
      task.messages.push({ id: randomUUID(), role: 'system', text: clip(this.redact(note), 4000), createdAt: this.now() })
      this.touch(task)
      this.mark()
      this.notify(live.key)
    }
    return CURSOR_DECLINE_REPLY
  }

  /**
   * Puts an agent's question to the person on a row of its own, as the built-in harness's 向你提问 does, and answers the
   * agent once the answer is in the session's record. Outside a turn that is still going, or once it stops, the agent
   * is answered that nobody did.
   */
  private async askPerson(live: Live, ask: AgentAsk): Promise<unknown> {
    const taskId = live.key
    const task = this.state.tasks[taskId]
    const run = this.runs.get(taskId)
    const askUser = this.options.askUser
    if (!task || !run || !askUser || run.live !== live || !run.sent || run.cancelRequested || this.closed) return ask.reply(undefined)
    if (run.segment) this.settleSegment(run, task, 'completed')
    // A row of its own, never the agent's call of the same ID: that call may still be running, and two asks may share it.
    const callId = `ask-${randomUUID()}`
    const state = this.toolState(task, callId)
    const prompt = clip(this.redact(ask.prompt), 2000) || `${this.agent.name} 的提问`
    const questions = ask.questions.map(item => ({
      ...item,
      label: clip(this.redact(item.label), 1000),
      options: item.options.map(option => ({ ...option, label: clip(this.redact(option.label), 500) })),
    }))
    mergeTool(
      state,
      {
        toolCallId: callId,
        title: prompt,
        name: 'ask_user',
        kind: 'other',
        status: 'in_progress',
        // The agent's own call, only as a link.
        ...(ask.toolCallId ? { rawInput: { forCall: clip(this.redact(ask.toolCallId), 256) } } : {}),
      },
      this.now(),
    )
    this.upsert(task, toolMessage(state))
    const controller = new AbortController()
    ;(run.asking ??= new Set()).add(controller)
    task.summary.status = 'waiting-approval'
    run.clock.openWait(state.id)
    this.phase(run, 'approval', 'ask_user', run.clock.live().runWaitingSince)
    this.touch(task)
    this.mark()
    this.notify(taskId)
    const sessionId = taskId
    const questionId = state.id.slice('tool:'.length)
    let answer: string | undefined
    try {
      answer = (await askUser({ sessionId, callId: questionId, prompt, questions, signal: controller.signal })).text
    } catch {
      answer = undefined
    } finally {
      run.asking.delete(controller)
    }
    const current = this.state.tasks[taskId]
    let result: QuestionResult | undefined
    try {
      const parsed = answer === undefined ? undefined : (JSON.parse(answer) as QuestionResult)
      result = parsed?.kind === 'latch.question-result' ? parsed : undefined
    } catch {
      result = undefined
    }
    // The turn's end or the Host's stop already settled the row (unknown, interrupted): that record stands.
    if (state.final) result = undefined
    let durable = false
    if (current && !state.final) {
      if (result)
        mergeTool(
          state,
          { toolCallId: callId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: answer } }] },
          this.now(),
        )
      else {
        // Nobody answered: the question is withdrawn, which is no failure. The Host's stop says so on the row.
        state.awaiting = 0
        state.final = { state: 'cancelled', note: `QUESTION_CLOSED: ${this.closed ? 'Latch 重启时中断，' : '提问已结束，'}没有回答。` }
        state.completedAt ??= this.now()
      }
      this.upsert(current, this.closed && !result ? { ...toolMessage(state), interrupted: true } : toolMessage(state))
      if (this.runs.get(taskId) === run) {
        run.clock.closeWait(state.id)
        if (current.summary.status === 'waiting-approval' && !this.openApprovals(taskId).length) current.summary.status = 'running'
        this.working(run)
      }
      this.touch(current)
      this.mark()
      durable = await this.flush().then(
        () => true,
        () => false,
      )
    }
    // Only a row on disk confirms the answer to the device that gave it; a failed write is reported as unknown.
    await this.options
      .questionSettled?.({ sessionId, callId: questionId, state: !result ? 'cancelled' : durable ? 'completed' : 'unknown' })
      .catch(() => {})
    this.notify(taskId)
    return ask.reply(result)
  }

  /**
   * A request Latch cannot act on gets an answer at once, so the agent is not left waiting for one, and stays visible: on
   * the live turn, and as a system message that says what it asked. Agents repeat themselves, so each method is
   * written once per turn and the number of methods is bounded.
   */
  private noteUnrecognized(live: Live, method: string, params: unknown, why = 'Latch 不支持这个请求'): void {
    const shown = clip(this.redact(method), UNRECOGNIZED_METHOD_LIMIT)
    const asked = isObject(params) ? (params as { sessionId?: unknown }).sessionId : undefined
    const named = typeof asked === 'string' ? live.sessions.get(asked) : undefined
    const taskId = named ?? live.key
    const task = this.state.tasks[taskId]
    if (!task) {
      // Before a session is recorded there is no transcript to write it in.
      this.limits.log(`${this.agent.name} 在会话建立前发来 Latch 不认识的请求：${shown}`)
      return
    }
    const candidate = this.runs.get(taskId)
    const run = candidate && (!candidate.live || candidate.live === live) ? candidate : undefined
    const seen = ((run ?? live).unrecognizedMethods ??= new Set())
    // One reading for both: `at` equal to `lastEventAt` is how a client knows nothing has happened since.
    const nowMs = this.clock()
    const at = isoTime(nowMs)
    let messageId: string | undefined
    if (!seen.has(shown) && seen.size < UNRECOGNIZED_METHODS) {
      seen.add(shown)
      messageId = randomUUID()
      const content =
        run?.sensitiveOutput || run?.attachments?.length || task.messages.some(item => item.attachments?.length) || params === undefined
          ? ''
          : `\n\n${clip(this.redact(pretty(params)), UNRECOGNIZED_PARAMS_LIMIT)}`
      if (run?.segment) this.settleSegment(run, task, 'completed')
      task.messages.push({
        id: messageId,
        role: 'system',
        text: `${this.agent.name} 发来请求 ${shown}：${why}，已回复不支持；它可能因此停住，也可能换一种做法。${content}`,
        createdAt: at,
      })
    }
    if (run) {
      run.lastEventAt = nowMs
      const lastMessage = messageId ?? run.unrecognized?.messageId
      run.unrecognized = {
        count: (run.unrecognized?.count ?? 0) + 1,
        // Not before `lastEventAt`: a request counts as what the run is stuck on until a later sign of life.
        at: this.now(),
        method: shown,
        ...(lastMessage ? { messageId: lastMessage } : {}),
      }
    }
    this.touch(task)
    this.mark()
    this.notify(taskId)
  }

  private onNotification(live: Live, method: string, params: unknown): void {
    if (method === 'session/update') return this.onUpdate(live, params)
    if (method === AUTH_STATUS_METHOD) {
      const report = reportedLogin(params)
      if (!report) return
      // A kind Latch cannot read says nothing, so it does not stand in for one it could.
      if (report.status === 'unknown') {
        if (this.auth.forget(live)) this.notify()
        return
      }
      this.auth.report(live, report)
      this.notify()
      return
    }
    const notifications = this.selection.profile?.extensions?.notifications
    if (notifications && Object.hasOwn(notifications, method)) {
      const sessionId = this.state.tasks[live.key]?.acp.acpSessionId
      const update = sessionId ? notifications[method]!(params, live.key) : undefined
      if (update) this.onUpdate(live, { sessionId, update })
      return
    }
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
    if (live.capture && live.capture.acpSessionId === envelope.data.sessionId && !live.sessions.has(envelope.data.sessionId)) {
      const update = this.selection.profile?.normalizeUpdate?.(envelope.data.update) ?? envelope.data.update
      captureUpdate(live.capture, update, this.now(), this.redact)
      return
    }
    const taskId = live.sessions.get(envelope.data.sessionId)
    const task = taskId ? this.state.tasks[taskId] : undefined
    if (!taskId || !task) {
      const child = live.children.get(envelope.data.sessionId)
      if (child) this.onChildUpdate(live, child, envelope.data.update)
      return
    }
    const projected = this.selection.profile?.readProjectedChild?.(envelope.data.update)
    if (projected && !live.sessions.has(projected.child.sessionId)) {
      const child = this.projectedChild(live, task, envelope.data.sessionId, projected.child)
      if (child && typeof projected.value.sessionUpdate === 'string')
        this.onChildUpdate(live, child, projected.value as { sessionUpdate: string })
      return
    }
    // What the agent says and its tools print may hold a Latch MCP server's secret (a server echoing its environment):
    // masked before anything is stored or sent to a device.
    const update = maskKnownSecretsIn(this.selection.profile?.normalizeUpdate?.(envelope.data.update) ?? envelope.data.update)
    // The harness's own MCP servers starting: a report about the harness, not output of the session.
    if (update.sessionUpdate === MCP_STATUS_UPDATE) {
      if (this.reportsOwnMcp()) this.noteOwnMcp(update, 'session')
      return
    }
    const candidate = this.runs.get(taskId)
    const run = candidate?.sent && candidate.live === live ? candidate : undefined
    if (run) run.lastEventAt = this.clock()
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const retry = this.selection.profile?.readRetry?.(update)
        if (retry && retry.kind !== 'restart') {
          this.showRetry(task, run, retry)
          break
        }
        if (run && update.content && typeof update.content === 'object' && Reflect.get(update.content, 'type') === 'image')
          run.sensitiveOutput = true
        const parsed = chunkUpdate.safeParse(update)
        if (!parsed.success) return
        if (retry && run?.segment?.text) {
          run.segment.text = ''
          this.notify(taskId)
        }
        if (parsed.data.content.type === 'image' && update.sessionUpdate === 'agent_message_chunk') {
          if (!run || !this.options.saveAttachment) return
          const data = parsed.data.content.data,
            mime = parsed.data.content.mimeType
          if (!data || !mime || (run.imageCount ?? 0) >= 8) {
            run.notes.push('一张 Agent 图片未保存：内容无效或超过每轮 8 张上限。')
            return
          }
          run.imageCount = (run.imageCount ?? 0) + 1
          const createdAt = this.now(),
            id = randomUUID()
          run.imageChain = (run.imageChain ?? Promise.resolve()).then(async () => {
            try {
              const ref = await this.options.saveAttachment!({ sessionId: taskId, mime, data })
              if (this.state.tasks[taskId] !== task) return
              task.messages.push({
                id,
                role: 'assistant',
                text: '',
                state: run.cancelRequested ? 'cancelled' : 'completed',
                createdAt,
                attachments: [ref],
              })
              this.touch(task)
              this.mark()
              this.notify(taskId)
            } catch {
              run.notes.push('一张 Agent 图片未保存：图片类型、大小或附件存储不可用。')
            }
          })
          return
        }
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
        if (parsed.success)
          this.applyTool(task, run, parsed.data, update.sessionUpdate === 'tool_call', this.selection.profile?.readDenial?.(update))
        const ended = this.selection.profile?.readChildEnd?.(update)
        if (ended) this.endChild(live, task, run, ended)
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
          ...(live.wire.idleCommands?.has(command.name) ? { idleOnly: true as const } : {}),
        }))
        break
      }
      case 'notice': {
        const parsed = noticeUpdate.safeParse(update)
        if (!parsed.success) return
        if (run?.segment) this.settleSegment(run, task, 'completed')
        const { severity, title, description } = parsed.data
        const said = severity === 'error' ? '报告错误' : severity === 'warning' ? '警告' : '提示'
        task.messages.push({
          id: randomUUID(),
          role: 'system',
          text: `${this.agent.name} ${said}：${clip(this.redact(title), 300)}${description ? `\n${clip(this.redact(description), 2000)}` : ''}`,
          createdAt: this.now(),
        })
        break
      }
      case 'subagent_update': {
        const parsed = subagentUpdate.safeParse(update)
        if (!parsed.success) return
        this.announceChild(live, task, run, undefined, parsed.data)
        break
      }
      case 'compaction_update':
      case 'compaction_summary_chunk': {
        const parsed = update.sessionUpdate === 'compaction_update' ? compactionUpdate.safeParse(update) : compactionChunk.safeParse(update)
        if (!parsed.success) return
        this.applyCompaction(task, run, parsed.data)
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

  /**
   * One row for a run of retries, patched in place while nothing follows it. A reply that broke off loses the text that
   * arrived of it, since it is generated again from the start under the same ID; its thinking stays, as it happened.
   */
  private showRetry(task: AcpTask, run: Run | undefined, report: Exclude<RetryReport, { kind: 'restart' }>): void {
    const last = task.messages.at(-1)
    const state: NonNullable<Run['retry']> =
      run?.retry && (run.retry.pending || last?.id === run.retry.id)
        ? run.retry
        : { id: randomUUID(), interrupted: false, ...(run?.segment?.text ? { pending: true } : {}) }
    if (report.kind === 'interrupted') {
      state.interrupted = true
      state.pending = false
      if (run?.segment) run.segment.text = ''
    } else {
      state.interrupted = false
      // The service's error can echo part of a key.
      state.reason = clip(this.redact(report.reason).replace(/\s+/gu, ' ').trim(), 300) || undefined
      state.attempt = { attempt: report.attempt, of: report.of }
    }
    if (run) run.retry = state
    if (state.pending) return
    const text = this.retryText(state)
    if (last?.id === state.id) last.text = text
    else task.messages.push({ id: state.id, role: 'system', text, createdAt: this.now() })
  }

  private retryText(state: NonNullable<Run['retry']>): string {
    const title = state.interrupted
      ? `回复中途中断${state.reason ? `（${state.reason}）` : ''}，从头重新生成`
      : (state.reason ?? '请求失败')
    // A record that stays true after the turn: the agent never says whether a retry worked, and output that follows may
    // come after a retry of one of its own helper calls.
    return `${this.agent.name} 重试：${title}${state.attempt ? `\n第 ${state.attempt.attempt} 次重试，最多 ${state.attempt.of} 次` : ''}`
  }

  /**
   * One row per compaction, placed where its first report arrived and patched in place by later ones: its state, and the
   * summary the agent keeps, sent whole or in pieces. Not a failure of the turn when it fails.
   */
  private applyCompaction(
    task: AcpTask,
    run: Run | undefined,
    report: { compactionId: string; status?: string; summary?: unknown[] | null; error?: string | null; content?: ContentBlock },
  ): void {
    const id = `compaction:${report.compactionId}`
    let message = task.messages.find(item => item.id === id)
    if (!message) {
      if (run?.segment) this.settleSegment(run, task, 'completed')
      message = { id, role: 'system', text: '', createdAt: this.now() }
      task.messages.push(message)
    }
    const key = `${task.summary.id}\0${id}`
    const state = this.compactions.get(key) ?? { status: 'in_progress', summary: '' }
    this.compactions.set(key, state)
    if (report.status !== undefined) state.status = report.status
    if (report.error !== undefined) state.error = report.error ?? undefined
    if (report.summary === null) state.summary = ''
    else if (report.summary)
      state.summary = report.summary
        .flatMap(item => {
          const block = contentBlock.safeParse(item)
          return block.success ? [blockText(block.data)] : []
        })
        .join('')
    if (report.content) state.summary = append(state.summary, blockText(report.content), TOOL_TEXT_LIMIT)
    const name = this.agent.name
    const head =
      state.status === 'completed'
        ? `${name} 已压缩上下文`
        : state.status === 'failed'
          ? `${name} 压缩上下文失败${state.error ? `：${clip(this.redact(state.error), 500)}` : ''}`
          : state.status === 'cancelled'
            ? `${name} 已取消压缩上下文`
            : state.status === 'in_progress'
              ? `${name} 正在压缩上下文…`
              : `${name} 压缩上下文：${clip(this.redact(state.status), 64)}`
    // What a failed compaction sends may be the service's error rather than a summary.
    const summary = state.status === 'failed' ? this.redact(state.summary) : state.summary
    message.text = summary ? `${head}\n${clip(summary, TOOL_TEXT_LIMIT)}` : head
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
    // A new message, or output after a retry that left the reply before it standing: that reply settles, the retry after it.
    if (segment && (run.retry?.pending || (acpMessageId && segment.acpMessageId && segment.acpMessageId !== acpMessageId))) {
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
      // A retry after this text is another one, with its own row.
      run.retry = undefined
      segment.text = append(segment.text, piece)
      segment.reasoningTimer.text()
    } else {
      segment.reasoning = append(segment.reasoning, piece)
      segment.reasoningTimer.reasoning()
    }
    run.lastOutputAt = this.clock()
    if (!run.cancelRequested && run.activity.phase !== 'approval') this.working(run)
    this.notify(task.summary.id)
  }

  private settleSegment(run: Run, task: AcpTask, state: NonNullable<Message['state']>): void {
    const segment = run.segment
    run.segment = undefined
    if (segment && (segment.text || segment.reasoning)) {
      const reasoningMs = segment.reasoningTimer.end()
      const model = modelName(task.config)
      const thinking = thinkingName(task.config)
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
        ...(thinking ? { thinking: clip(thinking, 200) } : {}),
      })
    } else if (!run.retry?.pending) return
    if (run.retry?.pending) {
      run.retry.pending = false
      task.messages.push({ id: run.retry.id, role: 'system', text: this.retryText(run.retry), createdAt: this.now() })
    }
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

  private applyTool(task: AcpTask, run: Run | undefined, fields: ToolFields, created: boolean, denial?: ToolDenial): void {
    if (created && run?.segment) this.settleSegment(run, task, 'completed')
    const state = this.toolState(task, fields.toolCallId)
    mergeTool(state, fields, this.now())
    this.judge(task, state, fields.toolCallId, denial)
    this.upsert(task, toolMessage(state))
    if (task.acp.proposals && (state.status === 'completed' || state.status === 'failed')) this.collectProposals(task.summary.id)
    if (run) run.lastOutputAt = this.clock()
    if (run && !run.cancelRequested && !this.openApprovals(task.summary.id).length) {
      if (state.status === 'in_progress') {
        run.runningTool = state
        this.phase(run, 'tool', toolLabel(state))
      } else if (state.status === 'completed' || state.status === 'failed') this.working(run)
    }
    this.touch(task)
    this.mark()
    this.notify(task.summary.id)
  }

  /**
   * Marks and records a call no person was asked about while the session's mode leaves decisions to the harness's own
   * model: each review the harness reports, with its verdict, each call its model denied, or, for a harness that reports
   * no verdicts, each call that ran in such a mode with no ask. One audit row per call, once it settled. A call the
   * harness says it refused itself is marked so in any mode; only its model's refusals in such a mode are recorded.
   */
  private judge(task: AcpTask, state: ToolState, toolCallId: string, denial?: ToolDenial): void {
    const by = this.agent.name
    // A call a person was asked about is theirs, and one that started ran: what the harness says after either is no
    // refusal of its own.
    if (denial && !state.blocked && state.awaiting === 0 && !state.decision && state.startedAt === undefined)
      // Its reason may quote the command it refused, with a key expanded into it.
      state.blocked = { by, source: denial.source, ...(denial.reason ? { reason: clip(this.redact(denial.reason), 1000) } : {}) }
    if (state.judged?.recorded) return
    const prefix = this.profile?.reviewCallPrefix
    const settled = state.status === 'completed' || state.status === 'failed'
    if (prefix !== undefined && toolCallId.startsWith(prefix)) {
      const verdict = reviewVerdict(state)
      state.judged = { by, outcome: verdict === 'approved' || verdict === 'denied' ? verdict : 'none' }
      if (settled) this.recordJudgement(task, state, verdict ?? 'unknown', 'agent-report')
      return
    }
    if (prefix !== undefined || state.judged || state.awaiting > 0 || state.decision) return
    if (state.blocked) {
      if (state.blocked.source !== 'model' || this.modeTier(task)?.tier !== 'model') return
      state.judged = { by, outcome: 'denied' }
      this.recordJudgement(task, state, 'denied', 'agent-report')
      return
    }
    const ran = state.status === 'completed' || (state.status === 'failed' && state.startedAt !== undefined)
    if (!ran || this.modeTier(task)?.tier !== 'model') return
    state.judged = { by, outcome: 'unasked' }
    this.recordJudgement(task, state, 'ran-unasked', 'no-ask-seen')
  }

  /** The tier of the mode the session is in now, when Latch knows it. */
  private modeTier(task: AcpTask) {
    const mode = this.modeOption(task)?.currentValue ?? this.expectedMode(task)
    return mode === undefined ? undefined : this.profile?.modeTiers?.[mode]
  }

  /** The record of one judged call. The turn stops when it cannot be written: such a call never goes unrecorded. */
  private recordJudgement(
    task: AcpTask,
    state: ToolState,
    outcome: Extract<HarnessSecurityEvent, { type: 'tool-judged' }>['outcome'],
    source: 'agent-report' | 'no-ask-seen',
  ): void {
    state.judged = { ...state.judged!, recorded: true }
    const taskId = task.summary.id
    const event: HarnessSecurityEvent = {
      type: 'tool-judged',
      sessionId: taskId,
      callHash: sha256Hex(state.id),
      modeHash: sha256Hex(this.modeOption(task)?.currentValue ?? this.expectedMode(task) ?? ''),
      kind: toolKind(state.kind) ?? 'other',
      outcome,
      source,
    }
    let written: void | Promise<void>
    try {
      written = this.options.securityEvent?.(event)
    } catch (error) {
      written = Promise.reject(error)
    }
    void Promise.resolve(written).catch(() => {
      this.unrecorded(taskId)
    })
  }

  private unrecorded(taskId: string): void {
    const task = this.state.tasks[taskId]
    if (!task) return
    const note = `Latch 没能记下一次由 ${this.agent.name} 的模型代你决定的调用，已取消本轮。`
    const run = this.runs.get(taskId)
    if (run && !run.cancelRequested) {
      run.notes.push(note)
      this.requestCancel(run, true)
    } else if (!run) {
      task.messages.push({ id: randomUUID(), role: 'system', text: note, state: 'failed', createdAt: this.now() })
      this.touch(task)
      this.mark()
    }
    this.notify(taskId)
  }

  /**
   * A subagent the agent announced, or a later report about it: its row is placed where the announcement arrived, in the
   * session's own messages or, for a subagent's own subagent, among that subagent's steps.
   */
  private announceChild(live: Live, task: AcpTask, run: Run | undefined, parent: Child | undefined, update: SubagentUpdate): void {
    let child = live.children.get(update.sessionId)
    if (child) {
      // A session is never re-parented, and one Latch already serves is no subagent.
      if (child.parent !== parent || child.taskId !== task.summary.id) return
      delete child.ended
      if (update.capabilities !== undefined) child.cancellable = !!update.capabilities?.cancel
      if (child.stopping && (update.state?.state === 'idle' || update.state?.state === 'unknown'))
        this.childStopped(task, child, update.state.state === 'idle')
      const shown = this.childRow(task, child)
      if (shown) {
        patchSubagent(shown, update, this.redact)
        child.title = shown.subagent!.title
        return
      }
    } else {
      if (live.sessions.has(update.sessionId) || update.sessionId === parent?.acpSessionId) return
      if (live.children.size >= MAX_TRACKED) {
        // Room is made only by forgetting the oldest one that said it stopped in an earlier turn.
        const ended = [...live.children].find(([, item]) => item.ended)
        if (!ended) return
        live.children.delete(ended[0])
      }
      child = {
        acpSessionId: update.sessionId,
        taskId: task.summary.id,
        title: subagentTitle(update.title, this.redact),
        depth: (parent?.depth ?? 0) + 1,
        tools: new Map(),
        loose: new Map(),
        ...(parent ? { parent } : {}),
        ...(update.capabilities?.cancel ? { cancellable: true } : {}),
      }
      live.children.set(update.sessionId, child)
    }
    // It has no row yet: one is placed if there is room, else only its requests reach the person.
    const row = subagentRow(`subagent:${randomUUID()}`, update, this.redact, this.now(), child)
    child.title = row.subagent!.title
    if (row.subagent!.status) child.status = row.subagent!.status
    else delete child.status
    const holder = parent ? this.childRow(task, parent) : undefined
    const rows = [...live.children.values()].filter(item => item.messageId && !item.ended).length
    if (rows >= MAX_CHILDREN || child.depth > MAX_DEPTH || (parent && !holder)) {
      if (run && !run.hiddenSubagents) {
        run.hiddenSubagents = true
        run.notes.push(
          `本轮的子 Agent 超过 ${MAX_CHILDREN} 个或嵌套超过 ${MAX_DEPTH} 层，多出的没有单独显示；它们请求的审批照常出现在这个会话里。`,
        )
      }
      return
    }
    child.messageId = row.id
    if (holder) {
      parent!.textStep = undefined
      upsertStep(holder, row)
    } else {
      if (run?.segment) this.settleSegment(run, task, 'completed')
      task.messages.push(row)
    }
    if (run) run.lastOutputAt = this.clock()
  }

  /**
   * A subagent whose work arrives on the session's own session, marked as its (`readProjectedChild`): announced when first
   * seen, as working when that is during a turn, since it sends work. One whose parent never reported is shown where the
   * session's own subagents are.
   */
  private projectedChild(live: Live, task: AcpTask, acpSessionId: string, ref: ProjectedChild): Child | undefined {
    const candidate = this.runs.get(task.summary.id)
    const run = candidate?.sent && candidate.live === live ? candidate : undefined
    const known = live.children.get(ref.sessionId)
    if (known) {
      if (known.taskId !== task.summary.id) return undefined
      if (ref.title !== undefined && subagentTitle(ref.title, this.redact) !== known.title)
        this.announceChild(live, task, run, known.parent, { sessionId: ref.sessionId, title: ref.title })
      return known
    }
    const parent = ref.parentSessionId === acpSessionId ? undefined : live.children.get(ref.parentSessionId)
    if (parent && parent.taskId !== task.summary.id) return undefined
    this.announceChild(live, task, run, parent, {
      sessionId: ref.sessionId,
      ...(ref.title !== undefined ? { title: ref.title } : {}),
      ...(run ? { state: { state: 'running' } } : {}),
    })
    return live.children.get(ref.sessionId)
  }

  /**
   * How a subagent the session started ended, as the session's own call reports it. A call that failed while the person
   * stopped the turn failed because of the stop.
   */
  private endChild(live: Live, task: AcpTask, run: Run | undefined, ended: { sessionId: string; outcome: 'done' | 'failed' }): void {
    const child = live.children.get(ended.sessionId)
    if (!child || child.parent || child.taskId !== task.summary.id) return
    const cancelled = ended.outcome === 'failed' && this.runs.get(task.summary.id)?.cancelRequested === true
    this.announceChild(live, task, run, undefined, {
      sessionId: ended.sessionId,
      state:
        ended.outcome === 'done'
          ? { state: 'idle', stopReason: 'end_turn' }
          : cancelled
            ? { state: 'idle', stopReason: 'cancelled' }
            : { state: 'idle', error: 'failed' },
    })
  }

  /**
   * A subagent that was sent a stop said it is no longer working, or that it cannot tell: the stop is over. When it went
   * idle, the calls it left unfinished are settled as a stopped turn's are; a report it sends later still wins.
   */
  private childStopped(task: AcpTask, child: Child, idle = true): void {
    delete child.stopping
    if (!idle) return
    const at = this.now()
    const row = this.childRow(task, child)
    for (const state of child.tools.values()) if (!state.awaiting && settleTool(state, at) && row) upsertStep(row, toolMessage(state))
    for (const state of child.loose.values()) if (!state.awaiting) settleTool(state, at)
  }

  /**
   * A subagent's own mode, when its harness reports one: wider than the session's is the session widening, since the
   * subagent works for it, and is handled as the session's own widening is.
   */
  private childMode(task: AcpTask, child: Child, value: string): void {
    const taskId = task.summary.id
    if (task.acp.drift || this.quiet.has(taskId)) return
    const expected = this.expectedMode(task) ?? this.modeOption(task)?.currentValue
    const changes = this.changes.get(taskId)
    const allowed = changes?.size ? [expected, ...[...changes].flatMap(change => change.allowed)] : [expected]
    if (allowed.some(mode => ['neutral', 'stricter'].includes(classifyMode(this.profile, mode, value)))) return
    this.drift(task, expected, value, child.title)
  }

  /**
   * In 只看不改, the session's own agent changes nothing; a subagent asking for anything but a look is asking for more
   * than the session has. A mode switch is judged by the mode it switches to (`childOffer`).
   */
  private childBlockedByPlan(task: AcpTask, kind: string | undefined): boolean {
    const expected = this.expectedMode(task)
    if (expected === undefined || this.profile?.modeTiers?.[expected]?.tier !== 'plan') return false
    return kind !== 'switch_mode' && !LOOKING_KINDS.has(kind ?? '')
  }

  /**
   * What a subagent's request may offer the person: never more than the session's own mode. Latch cannot set or read a
   * subagent's mode, so an answer that would switch it is offered only when the profile names the mode it switches to
   * and that mode is not wider than the session's.
   */
  private childOffer(task: AcpTask, kind: string | undefined, visible: PermissionOption[]): PermissionOption[] {
    const blocked = this.childBlockedByPlan(task, kind)
    const expected = this.expectedMode(task)
    return visible.filter(option => {
      if (option.kind !== 'allow_once') return true
      if (blocked) return false
      const mode = this.profile?.modeAnswers?.find(
        entry => entry.optionId === option.optionId && (entry.toolKind === undefined || entry.toolKind === kind),
      )?.mode
      if (mode !== undefined) return classifyMode(this.profile, expected, mode) !== 'wider'
      return kind !== 'switch_mode'
    })
  }

  /** The row of a subagent, found through the subagents that started it. */
  private childRow(task: AcpTask, child: Child): Message | undefined {
    if (!child.messageId) return undefined
    if (!child.parent) return task.messages.find(item => item.id === child.messageId)
    return this.childRow(task, child.parent)?.subagent?.steps.find(item => item.id === child.messageId)
  }

  /** What a subagent reports on its own session: its reply, its calls and its own subagents. Its reasoning is not kept. */
  private onChildUpdate(live: Live, child: Child, raw: { sessionUpdate: string }): void {
    const task = this.state.tasks[child.taskId]
    if (!task) return
    const row = this.childRow(task, child)
    const update = this.selection.profile?.normalizeUpdate?.(raw) ?? raw
    const candidate = this.runs.get(child.taskId)
    const run = candidate?.sent && candidate.live === live ? candidate : undefined
    if (run) run.lastEventAt = this.clock()
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const parsed = chunkUpdate.safeParse(update)
        const piece = parsed.success && parsed.data.content.type === 'text' ? (parsed.data.content.text ?? '') : ''
        if (!piece || !row) return
        childText(child, row, piece, this.now())
        break
      }
      case 'tool_call':
      case 'tool_call_update': {
        const parsed = toolFields.safeParse(update)
        if (!parsed.success) return
        const state = childCall(child, row, parsed.data, this.now())
        // Latch knows no mode of a subagent's own, so its calls are judged by the mode of the session that started it.
        this.judge(task, state, parsed.data.toolCallId, this.selection.profile?.readDenial?.(update))
        if (!row || !upsertStep(row, toolMessage(state))) return
        break
      }
      case 'subagent_update': {
        // Followed even with no row: the subagents it starts may ask the person too.
        const parsed = subagentUpdate.safeParse(update)
        if (!parsed.success) return
        this.announceChild(live, task, run, child, parsed.data)
        break
      }
      case 'current_mode_update': {
        const parsed = modeUpdate.safeParse(update)
        if (parsed.success) this.childMode(task, child, parsed.data.currentModeId)
        return
      }
      case 'config_option_update': {
        const parsed = configUpdate.safeParse(update)
        const mode = parsed.success ? configFromOptions(parsed.data.configOptions).find(option => option.category === 'mode') : undefined
        if (mode) this.childMode(task, child, mode.currentValue)
        return
      }
      default:
        return
    }
    if (run) run.lastOutputAt = this.clock()
    this.touch(task)
    this.mark()
    this.notify(task.summary.id)
  }

  private onPermission(live: Live, params: unknown, rpcId: RpcId): Promise<unknown> {
    const parsed = permissionRequest.safeParse(params)
    if (!parsed.success) {
      // A shape Latch cannot read would otherwise leave an agent waiting on a question nobody was shown.
      this.noteUnrecognized(live, 'session/request_permission', params)
      return Promise.reject(new RpcError(RPC.invalidParams, 'Invalid params'))
    }
    // A subagent asks on its own session, or on the session that started it marked as its; that session is where a
    // person answers.
    let child = live.sessions.has(parsed.data.sessionId) ? undefined : live.children.get(parsed.data.sessionId)
    const taskId = child?.taskId ?? live.sessions.get(parsed.data.sessionId)
    const task = taskId ? this.state.tasks[taskId] : undefined
    let toolCall = parsed.data.toolCall
    let unresolved = false
    if (!child && task) {
      const asked: unknown = Reflect.get(params as object, 'toolCall')
      const projected = isObject(asked) ? this.selection.profile?.readProjectedChild?.(asked as Record<string, unknown>) : undefined
      const own = projected && !live.sessions.has(projected.child.sessionId) ? toolFields.safeParse(projected.value) : undefined
      if (projected && own?.success) {
        child = this.projectedChild(live, task, parsed.data.sessionId, projected.child)
        if (child) toolCall = own.data
      }
      unresolved = !!projected && !child
    }
    const run = taskId ? this.runs.get(taskId) : undefined
    const row = child && task ? this.childRow(task, child) : undefined
    const filtered = filterPermissionOptions(this.profile, parsed.data.options)
    // Marked as a subagent's but no subagent of this session can be named: never asked as the session's own.
    if (task?.acp.drift || unresolved) return Promise.resolve(this.rejection(filtered.visible))
    // A subagent that goes on after its turn ended still asks: the person answers it as during a turn.
    const afterTurn = !!child && !run && this.lives.get(child.taskId) === live && !live.wire.stopping
    if (!taskId || !task || this.closed || (!afterTurn && (!run?.sent || run.live !== live || run.cancelRequested)))
      return Promise.resolve(CANCELLED_OUTCOME)
    // A subagent that was told to stop asks nothing more of the person, as a stopped turn does not.
    if (child?.stopping) return Promise.resolve(CANCELLED_OUTCOME)
    if (run) {
      run.lastEventAt = this.clock()
      if (run.segment) this.settleSegment(run, task, 'completed')
    }
    const now = this.now()
    // Past the limits a subagent's call has no step, but the request needs none.
    const state = child ? childCall(child, row, toolCall, now) : this.toolState(task, toolCall.toolCallId)
    if (!child) mergeTool(state, toolCall, now)
    const record = (item: Message) => {
      if (!child) this.upsert(task, item)
      else if (row) upsertStep(row, item)
    }
    if (child && !filtered.autoReject) {
      const offered = this.childOffer(task, state.kind, filtered.visible)
      if (!offered.some(option => option.kind === 'allow_once')) {
        // Wider than the session's own mode: the person is not asked to let a subagent past it.
        record(toolMessage(state))
        task.messages.push({
          id: randomUUID(),
          role: 'system',
          text: `已拒绝：子 Agent「${child.title}」请求「${clip(this.redact(state.title || toolLabel(state)), 200)}」，${
            this.childBlockedByPlan(task, state.kind) ? '这个会话是「只看不改」' : '会把权限换得比这个会话宽，或换到 Latch 认不出的模式'
          }，Latch 没有交给你。`,
          createdAt: this.now(),
        })
        this.touch(task)
        this.mark()
        this.notify(taskId)
        this.securityEvent({ type: 'approval-auto-rejected', sessionId: taskId, reason: 'subagent-wider' })
        const reject = offered.find(option => option.kind === 'reject_once')
        return Promise.resolve(reject ? selected(reject.optionId) : CANCELLED_OUTCOME)
      }
      filtered.visible = offered
    }
    if (filtered.autoReject) {
      // Persistent or unknown choices only: nothing Latch could offer, so the request is refused at once.
      record(toolMessage(state))
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
      // A subagent's call is no row of the session's own, so nothing links to it there.
      ...(child ? { subagent: row?.subagent?.title ?? child.title } : { toolCallId: state.id.slice('tool:'.length) }),
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
      const statusAfter = run ? undefined : this.statusAfterTurn(task)
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
        ...(child ? { child } : {}),
        ...(statusAfter ? { statusAfter } : {}),
      })
      record(toolMessage(state))
      task.summary.status = 'waiting-approval'
      if (run) {
        run.clock.openWait(approval.id)
        run.lastOutputAt = this.clock()
        this.phase(run, 'approval', approval.toolName, run.clock.live().runWaitingSince)
      } else this.holdIdle(live)
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
    if (decision && permission.tool.decision?.outcome !== 'allowed') {
      permission.tool.decision = decision
      if (decision.outcome === 'allowed') permission.tool.approvalId = permission.approval.id
    }
    if (permission.statusAfter && !this.runs.has(permission.taskId)) settleAskedTool(permission.tool, decision?.outcome === 'allowed')
    if (result instanceof Error) permission.fail(result)
    else permission.answer(result)
    const task = this.state.tasks[permission.taskId]
    this.runs.get(permission.taskId)?.clock.closeWait(permission.approval.id)
    if (task) {
      const row = permission.child ? this.childRow(task, permission.child) : undefined
      if (row) upsertStep(row, toolMessage(permission.tool))
      else if (!permission.child) this.upsert(task, toolMessage(permission.tool))
      const run = this.runs.get(permission.taskId)
      if (!this.openApprovals(permission.taskId).length) {
        if (task.summary.status === 'waiting-approval') task.summary.status = run ? 'running' : (permission.statusAfter ?? 'idle')
        if (run && !run.cancelRequested) this.working(run)
        if (!run) this.scheduleIdle(permission.taskId)
      }
      this.touch(task)
      this.mark()
    }
    this.notify(permission.taskId)
  }

  /** What a session that is waiting only on requests that came after its turn returns to once they are answered. */
  private statusAfterTurn(task: AcpTask): TaskStatus {
    if (task.summary.status !== 'waiting-approval') return task.summary.status
    for (const permission of this.permissions.values())
      if (permission.taskId === task.summary.id && permission.statusAfter) return permission.statusAfter
    return 'idle'
  }

  /** What a new session of this definition offered, for drafts; the definition it ran is the one it is kept under. */
  private noteStartCatalogue(task: AcpTask, options: SessionConfigOption[]): void {
    const definitionHash = task.acp.definitionHash ?? task.acp.launchHash
    if (!definitionHash || !task.acp.launchHash) return
    this.state.catalogue = startCatalogue(this.state.catalogue, {
      options,
      isMode: option => this.isModeOption(task, option),
      startMode: this.profile?.expectedMode,
      definitionHash,
      launchHash: task.acp.launchHash,
      ...(task.acp.agentVersion ? { agentVersion: task.acp.agentVersion } : {}),
      at: this.now(),
      source: 'session',
    })
  }

  /** Thinking and the like as offered for the model a session runs on, so a draft that picks that model can show them. */
  private noteModelOptions(task: AcpTask, options: SessionConfigOption[]): void {
    const stored = this.state.catalogue
    if (!stored || stored.definitionHash !== (task.acp.definitionHash ?? task.acp.launchHash)) return
    stored.perModel = withModelOptions(stored.perModel, options)
  }

  private applyModel(task: AcpTask): void {
    const model = modelName(task.config)
    if (model) task.summary.model = clip(model, 200)
  }
}

/** The server's own tools: calling them reads nothing from outside. Compared by exact name, after the server's prefix. */
const OWN_TOOLS: ReadonlySet<string> = new Set(['propose_memory', 'propose_schedule', 'list_skills', 'read_skill'])
/** How agents name an MCP tool of `latch-skills`: Claude Code's `mcp__latch-skills__x`, others' `latch-skills: x` and similar. */
const SERVER_PREFIX = /^(?:mcp__latch[-_]skills__|latch[-_]skills(?:\s*[:/.]\s*|__))/u
/** Kinds that name what they touch in `locations`; any other kind (fetch, search, execute, think, other) may read anything. */
const LOCAL_KINDS: ReadonlySet<string> = new Set(['read', 'edit', 'delete', 'move'])

/**
 * Whether a tool row is one of the skills server's own tools. Only a row of no particular kind can be (an MCP tool is
 * `other`), and only by its name field (`toolName`, which falls back to the title when an agent sends none), compared
 * exactly after the server's prefix. A title that merely mentions the name, or a fetch titled like it, is not.
 */
export function ownTool(message: Pick<Message, 'toolName' | 'tool'>): boolean {
  const kind = message.tool?.kind
  if (kind !== undefined && kind !== 'other') return false
  const name = message.toolName ?? message.tool?.title
  return name !== undefined && OWN_TOOLS.has(name.trim().replace(SERVER_PREFIX, ''))
}

/** A path as the file system resolves it: `..` collapsed, and symlinks followed as far as the path exists. */
function canonical(path: string): string {
  let head = resolve(path)
  const rest: string[] = []
  for (;;) {
    try {
      return join(realpathSync.native(head), ...rest.toReversed())
    } catch {
      const parent = dirname(head)
      if (parent === head) return resolve(path)
      rest.push(basename(head))
      head = parent
    }
  }
}

/**
 * The turn a proposal came from (its user message) and whether, since the context last started over, a tool may have read
 * outside content: a fetch, search, command, thought or tool of unknown kind, a subagent, or a read or edit whose
 * locations are absent or outside the session's folders after resolving them. The context keeps what it read until it
 * starts over, so the mark holds for every later turn. An agent reports its calls in its own words, so this errs toward
 * external.
 */
export function proposalTurn(task: { messages: Message[]; acp: { cwd: string; folders?: string[] } }): {
  messageId?: string
  external: boolean
} {
  const start = task.messages.findLastIndex(message => message.role === 'user')
  const fresh = task.messages.findLastIndex(message => message.role === 'user' && message.freshContext === true)
  const roots = [task.acp.cwd, ...(task.acp.folders ?? [])].map(root => canonical(root))
  const inside = (path: string) =>
    isAbsolute(path) && roots.some(root => (canonical(path) + sep).startsWith(root.endsWith(sep) ? root : root + sep))
  const external = task.messages.slice(Math.max(fresh, 0)).some(message => {
    if (message.subagent) return true
    if (message.role !== 'tool') return false
    const tool = message.tool
    if (ownTool(message)) return false
    if (!tool?.kind || !LOCAL_KINDS.has(tool.kind)) return true
    return !tool.locations?.length || !tool.locations.every(inside)
  })
  return { ...(start >= 0 ? { messageId: task.messages[start]!.id } : {}), external }
}
