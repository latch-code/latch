/**
 * Codex's own app-server (`codex app-server`): JSON-RPC over stdio, the protocol Codex's own clients use, so Codex runs
 * without an adapter. The runtime keeps speaking ACP; this wire answers its methods with Codex's thread and turn
 * requests and turns Codex's item notifications into ACP session updates, so every check of the runtime applies to it
 * unchanged. Types follow `codex app-server generate-ts` of Codex 0.167.
 */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import {
  escapeSecurityText,
  readSessionSkills,
  boundSessionSkills,
  simulatorInputName,
  type HarnessMcpServer,
  type HarnessMcpState,
  type SessionSkill,
} from '@latch/protocol'
import { isAbsolute } from 'node:path'
import { redactKnownSecrets } from '@latch/core/node-kit'
import {
  CODEX_EFFORT_ID,
  CODEX_MODEL_ID,
  CODEX_TIER_ID,
  codexModel,
  codexOptions,
  fastTierOf,
  speedOption,
  GATEWAY_DEFAULT_EFFORT,
  gatewayEffortOption,
  tierValue,
  type CodexModels,
} from '../codex-models.ts'
import { clip, TOOL_TEXT_LIMIT } from '../mapping.ts'
import { GENERATED_IMAGES_PER_TURN, generatedImage, generatedImageNote, savedImagePath } from './codex-images.ts'
import { CODEX_GATEWAY_PROVIDER, CODEX_MODES, type CodexMode } from '../profiles/codex.ts'
import { codexGatewayEnvironment } from '../profiles/codex-environment.ts'
import {
  CARRY_METHOD,
  FORK_METHOD,
  IMAGE_GENERATION_META,
  MCP_STATUS_METHOD,
  QUOTA_READ_METHOD,
  MCP_STATUS_UPDATE,
  RPC,
  RpcError,
  STEER_METHOD,
  SESSION_SKILLS_UPDATE,
  TOKENS_UPDATE,
  type RpcId,
  type TurnTokens,
} from '../protocol.ts'
import { QUOTA_UPDATE, codexQuota, codexQuotaUpdate } from '../quota.ts'
import {
  AgentProcess,
  ConnectionClosed,
  ConnectionStopping,
  descendants,
  groupAlive,
  isRecord,
  killProcess,
  RequestTimeout,
  type ExitInfo,
  type SpawnSpec,
} from './process.ts'
import { ForkRefused, type AgentWire, type PromptContext, type WireHandlers, type WireModelRoute } from './types.ts'
import {
  CodexTeam,
  codexTeamFeatures,
  codexTeamHistory,
  codexTeamHistoryItems,
  codexTeamItem,
  codexTeamThread,
  codexTeamThreadPage,
  codexTeamTurn,
  teamHistoryResult,
  type CodexTeamItem,
} from './codex-team.ts'

/** Appended to the definition's arguments: the protocol this wire speaks. */
export const CODEX_APP_SERVER_ARGS: readonly string[] = ['app-server']
/** Arguments that would make `codex` something other than its app-server, which this wire decides. */
const RESERVED = new Set([
  'app-server',
  'exec',
  'e',
  'login',
  'logout',
  'resume',
  'fork',
  'review',
  'apply',
  'a',
  '--help',
  '-h',
  '--version',
  '-V',
])
export const CODEX_MODE_ID = 'mode'
const MAX_MODEL_PAGES = 5
const MAX_THREADS = 50
const COMPACT = { name: 'compact', description: '把之前的对话总结成摘要，腾出上下文' }
/** Items that are what a model call wrote, rather than a tool it called. */
const TEXT_ITEMS = new Set(['agentMessage', 'reasoning', 'userMessage', 'contextCompaction'])
/** Context blocks are not command invocations, even when their instructions begin with a slash. */
function nativeCommand(blocks: z.infer<typeof promptParams>['prompt']): string | undefined {
  const texts = blocks.filter(block => block.type === 'text')
  return texts.length === 1 ? /^\/(\S+)(?:\s|$)/u.exec(texts[0]?.text ?? '')?.[1] : undefined
}
const REVIEW_UNAVAILABLE = 'Codex 原生审阅不会先询问；Latch 暂未接入 /review。'

const MODES = CODEX_MODES
type Mode = CodexMode
const isMode = (value: string): value is Mode => Object.hasOwn(MODES, value)
/** Where a subagent's work is marked when it reaches the session that started it (`profiles/codex.ts` reads it). */
export const CODEX_CHILD_META = 'latch/codexChild'
/** Codex's own words for a thread it has no record of; any other refusal keeps its reason. */
const NOT_FOUND = /^(?:no rollout found for thread id|invalid session id)\b/u
/** One-time answers only: Codex's `acceptForSession` and policy amendments would outlive the person's choice. */
const ASK_OPTIONS = [
  { optionId: 'accept', name: '允许', kind: 'allow_once' },
  { optionId: 'decline', name: '拒绝', kind: 'reject_once' },
]

const text = z.string()
/** The first Codex whose turns were checked to keep Latch's message ID (`clientUserMessageId`). */
const MARKED_TURNS = [0, 169, 0]
/** Whether `version` (`x.y.z`, a pre-release suffix ignored) is at least `floor`. */
function atLeast(version: string, floor: readonly number[]): boolean {
  const parts = version.split(/[.-]/u).slice(0, 3).map(Number)
  for (let index = 0; index < floor.length; index++) {
    const part = parts[index] ?? 0
    if (!Number.isFinite(part)) return false
    if (part !== floor[index]) return part > floor[index]!
  }
  return true
}
/** Codex's `item/tool/requestUserInput` (0.169, experimental): questions with labelled options, or free text. */
const userInputParams = z.object({
  questions: z
    .array(
      z.object({
        id: text.min(1).max(256),
        header: text.max(4000).nullish(),
        question: text.max(4000),
        isOther: z.boolean().nullish(),
        isSecret: z.boolean().nullish(),
        options: z
          .array(z.object({ label: text.max(4000), description: text.max(4000).nullish() }))
          .max(20)
          .nullish(),
      }),
    )
    .min(1)
    .max(10),
})
const NO_ANSWERS = { answers: {} }
const thread = z.object({
  id: text.min(1).max(512),
  cwd: text.max(4096).nullish().catch(undefined),
  name: text.nullish().catch(undefined),
  preview: text.nullish().catch(undefined),
  updatedAt: z.number().nullish().catch(undefined),
  turns: z.array(z.unknown()).nullish().catch(undefined),
})
const opened = z.object({
  thread,
  model: text.max(256).nullish().catch(undefined),
  reasoningEffort: text.max(64).nullish().catch(undefined),
  serviceTier: text.max(64).nullish().catch(undefined),
})
const account = z.object({ account: z.unknown().nullish(), requiresOpenaiAuth: z.boolean().nullish() })
const listing = z.object({ data: z.array(z.unknown()), nextCursor: text.max(4096).nullish() })
const modelPage = z.object({ data: z.array(z.unknown()), nextCursor: text.max(1024).nullish() })
const started = z.object({ turn: z.object({ id: text.min(1).max(512) }) })
const promptParams = z.object({
  sessionId: text,
  prompt: z.array(z.object({ type: text, text: text.optional(), data: text.optional(), mimeType: text.optional() })),
})
const optionParams = z.object({ sessionId: text, configId: text, value: text.max(1024) })
const mcpServer = z.object({
  name: text.min(1).max(128),
  command: text.min(1).max(4096),
  // Latch's own servers pass their source to `node -e` as one argument (`latch-skills` about 8 KiB).
  args: z
    .array(text.max(32 * 1024))
    .max(64)
    .default([]),
  env: z
    .array(z.object({ name: text.min(1).max(256), value: text.max(16384) }))
    .max(64)
    .default([]),
})
const forkParams = z.object({
  sessionId: text,
  cwd: text,
  through: text.max(256).optional(),
  mcpServers: z.array(z.unknown()).optional(),
  additionalDirectories: z.array(text.max(4096)).max(64).optional(),
})
const sessionParams = z.object({
  sessionId: text.optional(),
  cwd: text.optional(),
  mcpServers: z.array(z.unknown()).optional(),
  additionalDirectories: z.array(text.max(4096)).max(64).optional(),
})

/** Pages and servers of Codex's own MCP servers Latch reads at most. */
const MCP_PAGES = 4
const MCP_MAX = 200
/** A name `codex mcp login <name>` can be given as one word that no shell, nor Codex, reads as anything else (no leading `-`). */
const LOGIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/u
/** `McpServerStatus.runtimeStatus` (0.156, 0.167) in Latch's words. */
const RUNTIME_STATE: Readonly<Record<string, HarnessMcpState>> = {
  notStarted: 'not-started',
  starting: 'starting',
  connected: 'ready',
  authenticationRequired: 'needs-login',
  failed: 'failed',
  cancelled: 'cancelled',
  disabled: 'disabled',
}
/** `mcpServer/startupStatus/updated`'s `status`. */
const STARTUP_STATE: Readonly<Record<string, HarnessMcpState>> = {
  starting: 'starting',
  ready: 'ready',
  failed: 'failed',
  cancelled: 'cancelled',
}
const mcpStatusEntry = z.object({
  name: text.min(1).max(256),
  runtimeStatus: text.max(64).nullish().catch(undefined),
  httpOrigin: text.max(2048).nullish().catch(undefined),
  tools: z.unknown().optional(),
})
const mcpStatusPage = z.object({ data: z.array(z.unknown()).max(1000), nextCursor: text.max(1024).nullish().catch(undefined) })
/** `thread/backgroundTerminals/list`: the commands Codex still runs, each with its item and, when it has one, its OS process. */
const terminalPage = z.object({
  data: z
    .array(
      z.object({
        itemId: text.max(512),
        processId: text.max(512),
        osPid: z.number().int().positive().nullish().catch(undefined),
      }),
    )
    .max(1000),
})
/**
 * How long a stop waits on Codex to end a command it left running, and then on the command Latch ended itself
 * (`commandMs`); and how long a turn Codex interrupted with no stop of Latch's waits on its commands (`unaskedMs`, the
 * runtime's own cancel limit), after which its process is ended and those commands' results are unknown.
 */
const STOP_LIMITS = { commandMs: 2_000, unaskedMs: 30_000 }
let stopLimits = { ...STOP_LIMITS }

/** Tests only. */
export function setCodexStopLimits(next: Partial<typeof STOP_LIMITS> | undefined): void {
  stopLimits = { ...STOP_LIMITS, ...next }
}
const startupUpdate = z.object({
  name: text.min(1).max(256),
  status: text.max(64),
  failureReason: text.max(64).nullish().catch(undefined),
})

/** A remote server's origin as Codex reports it, kept only when it is one: never a path, a query or credentials. */
function mcpOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const origin = new URL(value).origin
    return origin === 'null' ? undefined : origin
  } catch {
    return undefined
  }
}

/** How many tools Codex lists for it: its `tools` is a map by name (an array in older shapes). */
function toolCount(tools: unknown): number | undefined {
  const count = Array.isArray(tools) ? tools.length : isRecord(tools) ? Object.keys(tools).length : undefined
  return count === undefined ? undefined : Math.min(count, 100_000)
}

function nativeSimulatorInputName(server: unknown, tool: unknown): string | undefined {
  if (server !== 'latch-browser' || typeof tool !== 'string') return undefined
  const name = `${server}.${tool}`
  return simulatorInputName(name) ? name : undefined
}

/**
 * One of Codex's own MCP servers as Latch shows it: its name with hidden characters shown, and Codex's own login command
 * for it only when Codex reports it needs one and the name is one word a shell reads as written.
 */
export function codexMcpServer(
  name: string,
  state: HarnessMcpState,
  facts: { tools?: number | undefined; origin?: string | undefined } = {},
): HarnessMcpServer {
  return {
    name: escapeSecurityText(clip(name, 128)),
    state,
    ...(facts.tools !== undefined ? { tools: facts.tools } : {}),
    ...(facts.origin ? { origin: facts.origin } : {}),
    ...(state === 'needs-login' && LOGIN_NAME.test(name) ? { login: `codex mcp login ${name}` } : {}),
  }
}

/** An MCP elicitation that is Codex asking to run a server's tool, not a question of the server's own. */
function isToolApproval(params: Record<string, unknown>): boolean {
  return isRecord(params._meta) && params._meta.codex_approval_kind === 'mcp_tool_call'
}

/** Codex's refusal as the runtime reads it: its words for an unknown thread are a lost session, the rest keep their reason. */
function notFound(error: unknown): never {
  if (error instanceof RpcError && NOT_FOUND.test(error.message)) throw new RpcError(RPC.notFound, 'Session not found')
  throw error
}

/** The version in Codex's `userAgent` (`<originator>/<version> (...)`). */
export function codexVersion(userAgent: unknown): string | undefined {
  if (typeof userAgent !== 'string') return undefined
  return /^[^/\s]+\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/u.exec(userAgent)?.[1]
}

/** `codex app-server` after the definition's arguments; refused when they set what this wire must. */
export function codexArgs(args: readonly string[]): string[] {
  const reserved = args.find(arg => RESERVED.has(arg.split('=')[0]!))
  if (reserved !== undefined) throw new Error(`参数 ${clip(reserved, 64)} 由 Latch 设置，不能写在 Codex 的定义里`)
  return [...args, ...CODEX_APP_SERVER_ARGS]
}

/** What one turn sends besides its input: the mode's settings, the folders it may write, the model and effort. */
function turnSettings(mode: Mode, cwd: string, folders: readonly string[]): Record<string, unknown> {
  const settings = MODES[mode]
  const sandboxPolicy =
    settings.sandbox === 'read-only'
      ? { type: 'readOnly', networkAccess: false }
      : settings.sandbox === 'workspace-write'
        ? { type: 'workspaceWrite', writableRoots: [...folders], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
        : { type: 'dangerFullAccess' }
  return { cwd, approvalPolicy: settings.approvalPolicy, approvalsReviewer: settings.reviewer, sandboxPolicy }
}

/** What a thread starts or resumes with: the mode's settings in the thread's own words, and MCP servers as Codex config. */
function threadSettings(mode: Mode, cwd: string, servers: Array<z.infer<typeof mcpServer>>): Record<string, unknown> {
  const settings = MODES[mode]
  return {
    cwd,
    approvalPolicy: settings.approvalPolicy,
    approvalsReviewer: settings.reviewer,
    sandbox: settings.sandbox,
    ...(servers.length
      ? {
          config: {
            mcp_servers: Object.fromEntries(
              servers.map(server => [
                server.name,
                {
                  command: server.command,
                  args: server.args,
                  env: Object.fromEntries(server.env.map(item => [item.name, item.value])),
                  // A Latch MCP server's bridge starts the person's command, and `npx` fetching a package often takes
                  // longer than Codex's default 10 s; Latch's own servers start at once.
                  ...(server.name.startsWith('latch-') ? {} : { startup_timeout_sec: 60 }),
                },
              ]),
            ),
          },
        }
      : {}),
  }
}

const said = (value: unknown) => (typeof value === 'string' ? clip(value, 300) : '')

const PLAN_STATUS: Readonly<Record<string, string>> = { pending: 'pending', inProgress: 'in_progress', completed: 'completed' }

function itemStatus(status: unknown, exitCode?: unknown): 'completed' | 'failed' | undefined {
  if (status === 'completed') return typeof exitCode === 'number' && exitCode !== 0 ? 'failed' : 'completed'
  if (status === 'failed' || status === 'declined') return 'failed'
  return undefined
}

/**
 * Codex's own reading of a command (`commandActions`, app-server 0.167): which file it reads, which folder it lists,
 * what it searches for. Passed on only when Codex classified every part: one `unknown` (or a shape this version of
 * Latch does not know) and the command is reported as a command, with nothing derived from its text.
 */
function commandActions(reported: unknown): Array<{ kind: 'read' | 'list' | 'search'; path?: string; query?: string }> | undefined {
  if (!Array.isArray(reported) || reported.length === 0 || reported.length > 16) return undefined
  const actions: Array<{ kind: 'read' | 'list' | 'search'; path?: string; query?: string }> = []
  for (const action of reported) {
    if (!isRecord(action)) return undefined
    const path = typeof action.path === 'string' && action.path ? clip(action.path, 1000) : undefined
    const query = typeof action.query === 'string' && action.query ? clip(action.query, 500) : undefined
    if (action.type === 'read' && path) actions.push({ kind: 'read', path })
    else if (action.type === 'listFiles') actions.push({ kind: 'list', ...(path ? { path } : {}) })
    else if (action.type === 'search' && (query || path))
      actions.push({ kind: 'search', ...(query ? { query } : {}), ...(path ? { path } : {}) })
    else return undefined
  }
  return actions
}

/** A file change as text: each file's unified diff under its path. */
function changesText(changes: unknown): { text: string; paths: string[] } {
  const list = Array.isArray(changes) ? changes.filter(isRecord) : []
  const paths = list.flatMap(change => (typeof change.path === 'string' ? [change.path] : []))
  const body = list
    .map(change => `${typeof change.path === 'string' ? change.path : ''}\n${typeof change.diff === 'string' ? change.diff : ''}`)
    .join('\n')
  return { text: clip(body, TOOL_TEXT_LIMIT), paths }
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  cleanup(): void
}

/**
 * The prompt being run: answered once Codex reports the turn completed, and, when it was stopped, once every command it
 * started has ended too (`ending` holds the answer meanwhile).
 */
function commandKey(threadId: string | undefined, itemId: string): string {
  return JSON.stringify([threadId ?? null, itemId])
}

interface Turn {
  id?: string
  compact?: boolean
  compactions?: Set<string>
  resolve(result: unknown): void
  reject(error: Error): void
  cancelled: boolean
  /** `turn/interrupt` went out: the turn's ID can arrive twice (the `turn/start` answer and `turn/started`) after a stop. */
  interrupted?: true
  error?: string
  usage?: TurnTokens
  /** The current model call's message and reasoning time by Codex's own item times, and whether it also called a tool. */
  call?: { ms: number; tool?: true }
  /**
   * The output of this turn's model calls that only wrote (no tool call, whose arguments stream outside any item's time)
   * and how long it streamed: the turn's speed.
   */
  stream?: { outputTokens: number; ms: number }
  /** Commands Codex has not reported ended, keyed by native thread and item. */
  commands: Set<string>
  /** The subagents' threads that reported calls in this turn: their commands are listed with the session's. */
  threads: Set<string>
  /** The parent's final event, held until owned member turns and their commands have settled. */
  rootResult?: { status: unknown; error: unknown }
  checkingMembers?: number
  delegated?: true
  endingCommands?: true
  memberStops?: Map<string, string>
  /** Those member turns said interrupted. Their public state waits for commands to end. */
  memberInterruptions?: Map<string, string>
  /** Pictures of Codex's image tool passed on in this turn, and those still being read through `fs/readFile`. */
  images?: number
  imageReads?: number
}

interface McpCall {
  thread: string
  turn: string
  id: string
  server: unknown
  tool: unknown
  arguments: unknown
  claimed: boolean
  answered: boolean
  ended: boolean
}

export class CodexWire implements AgentWire {
  readonly exited: Promise<ExitInfo>
  readonly idleCommands = new Set([COMPACT.name])
  readonly carries = true
  readonly forks = true
  /** This Codex keeps `clientUserMessageId` on a turn's user message (checked on 0.169); older ones are not sent it. */
  private marksTurns = false
  readonly commandsWithoutContext = new Set([COMPACT.name, 'review'])
  private listedFor?: string
  private readonly skillPaths = new Map<string, { name: string; path: string }>()
  private readonly ambiguousSkills = new Set<string>()
  private skillCatalogue?: SessionSkill[]
  private skillTruncated = false
  private skillGeneration = 0
  private skillRead?: Promise<void>
  private skillAgain = false
  private readonly process: AgentProcess
  private nextId = 0
  private readonly pending = new Map<number, Pending>()
  /** The thread this process runs, which is the session's ID on this wire. */
  private threadId?: string
  private team?: CodexTeam
  private teamEnabled?: boolean
  private teamResumed = false
  private teamTurnGeneration = 0
  private readonly teamItems: Array<{ turnId: string; item: CodexTeamItem }> = []
  private readonly checkingChildren = new Map<string, Promise<boolean>>()
  private readonly childEvents = new Map<string, Array<{ method: string; params: Record<string, unknown> }>>()
  private cwd = ''
  private folders: string[] = []
  private servers: Array<z.infer<typeof mcpServer>> = []
  // Codex can persist project trust when opening a new thread with write access. Apply a chosen mode to turns after opening.
  private mode: Mode = 'read-only'
  private models: CodexModels = { models: [] }
  private model?: string
  private effort?: string
  /** The tier the thread is on, as Codex last reported it or as the person picked it. */
  private tier?: string
  /** A person picked 速度: from then on each turn names the tier, so the thread follows the pick, not the configuration. */
  private tierPicked = false
  private routeEffort?: string
  private turn?: Turn
  /** Items whose text arrived in pieces, so their completion does not repeat it. */
  private readonly streamed = new Set<string>()
  /** The summary part a reasoning item last streamed: a new part is a new section of the thought. */
  private readonly summaryPart = new Map<string, number>()
  /** Command output so far, per item. */
  private readonly output = new Map<string, string>()
  /** Calls a person answered: what Codex then reports declined was their choice, not Codex's refusal. */
  private readonly answered = new Set<string>()
  /** Commands a person allowed: they run from then on, whether or not they ever print anything. */
  private readonly allowed = new Set<string>()
  /** Commands whose ask was declined or went unanswered: they never run, so a stop does not wait for them. */
  private readonly notRun = new Set<string>()
  /** Native MCP calls, including ended IDs, scoped to this turn; an ambiguous approval keeps its own unknown row. */
  private readonly mcpCalls = new Map<string, McpCall>()
  /** Calls Codex's review model denied, with its reason. */
  private readonly denied = new Map<string, string>()
  /** Codex's own MCP servers on this thread, by the name Codex gives them; Latch's own are never among them. */
  private readonly ownMcp = new Map<string, HarnessMcpServer>()
  /** Names whose start Codex reported while a list was being read: the report is newer than the list. */
  private mcpSeen?: Set<string>

  private constructor(
    spec: SpawnSpec,
    private readonly handlers: WireHandlers,
    /**
     * A session on a route: Codex runs on Latch's provider (`profiles/codex.ts`), whose models are the service's. Codex's
     * `model/list` would give its built-in presets for such a provider, so the wire offers these instead.
     */
    private readonly route?: WireModelRoute,
  ) {
    this.routeEffort = route?.effort ?? undefined
    this.process = AgentProcess.spawn(
      { ...spec, args: codexArgs(spec.args) },
      { record: record => this.onMessage(record), closed: info => this.onClosed(info) },
    )
    this.exited = this.process.exited
  }

  /** Throws for arguments Codex must not get; launch failures such as ENOENT arrive as an exit with `reason: 'spawn'`. */
  static spawn(spec: SpawnSpec, handlers: WireHandlers, route?: WireModelRoute): CodexWire {
    return new CodexWire(spec, handlers, route)
  }

  get closed(): boolean {
    return this.process.closed
  }
  get stopping(): boolean {
    return this.process.stopping
  }

  request(
    method: string,
    params: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
    _onResult?: (result: unknown) => void,
    context?: PromptContext,
  ): Promise<unknown> {
    const exit = this.process.exit
    if (exit) return Promise.reject(new ConnectionClosed(exit))
    if (this.stopping) return Promise.reject(new ConnectionStopping())
    if (signal?.aborted) return Promise.reject(new RpcError(RPC.cancelled, 'Request cancelled'))
    switch (method) {
      case 'initialize':
        return this.initialize(timeoutMs, signal)
      case 'session/new':
        return this.open(undefined, params, timeoutMs, signal)
      case 'session/resume':
        return this.open('resume', params, timeoutMs, signal)
      case 'session/load':
        return this.open('load', params, timeoutMs, signal)
      case CARRY_METHOD:
        return this.open('carry', params, timeoutMs, signal)
      case FORK_METHOD:
        return this.fork(params, timeoutMs, signal)
      case 'session/list':
        return this.list(params, timeoutMs, signal)
      case 'session/prompt':
        return this.prompt(params, timeoutMs, context)
      case 'session/set_config_option':
        return Promise.resolve(this.setOption(params))
      case STEER_METHOD:
        return this.steer(params, timeoutMs, signal, context)
      case 'logout':
        return this.send('account/logout', undefined, timeoutMs, signal)
      case MCP_STATUS_METHOD:
        return this.mcpStatus(params, timeoutMs, signal)
      case QUOTA_READ_METHOD:
        return this.readQuota(timeoutMs, signal)
      default:
        return Promise.reject(new RpcError(RPC.methodNotFound, `Method not found: ${clip(method, 200)}`))
    }
  }

  /** `session/cancel`: interrupts the running turn, which ends once Codex reports it completed and its commands ended. */
  notify(method: string): void {
    const turn = this.turn
    if (method !== 'session/cancel' || !turn || turn.cancelled) return
    turn.cancelled = true
    // A turn whose ID is not known yet is interrupted as soon as `turn/start` answers.
    this.interrupt(turn)
  }

  stop(reason: 'stop' | 'kill', graceMs: number, cause?: string): Promise<ExitInfo> {
    return this.process.stop(reason, graceMs, cause)
  }

  stderrTail(limit?: number): string {
    return this.process.stderrTail(limit)
  }

  private interrupt(turn: Turn): void {
    if (this.threadId && turn.id && !turn.interrupted && !turn.rootResult) {
      turn.interrupted = true
      void this.send('turn/interrupt', { threadId: this.threadId, turnId: turn.id }).catch(() => {})
    }
    for (const { threadId, turnId } of this.team?.activeMembers() ?? []) {
      if (turn.memberStops?.get(threadId) === turnId || turn.memberInterruptions?.get(threadId) === turnId) continue
      turn.memberStops ??= new Map()
      turn.memberStops.set(threadId, turnId)
      void this.send('turn/interrupt', { threadId, turnId }).catch(() => {})
    }
    this.finishWhenSettled(turn)
  }

  private send(method: string, params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    const exit = this.process.exit
    if (exit) return Promise.reject(new ConnectionClosed(exit))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined
      const withdraw = (error: Error): void => {
        if (!this.pending.delete(id)) return
        cleanup()
        reject(error)
      }
      const onAbort = (): void => withdraw(new RpcError(RPC.cancelled, 'Request cancelled'))
      const cleanup = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      if (timeoutMs) {
        timer = setTimeout(() => withdraw(new RequestTimeout(method)), timeoutMs)
        timer.unref()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, { resolve, reject, cleanup })
      this.process.write({ id, method, params })
    })
  }

  private async initialize(timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    const result = await this.send(
      'initialize',
      { clientInfo: { name: 'latch', title: 'Latch', version: '0.1.0' }, capabilities: { experimentalApi: true } },
      timeoutMs,
      signal,
    )
    this.process.write({ method: 'initialized' })
    const version = codexVersion(isRecord(result) ? result.userAgent : undefined)
    this.marksTurns = version !== undefined && atLeast(version, MARKED_TURNS)
    return {
      protocolVersion: 1,
      agentInfo: { name: 'Codex', ...(version ? { version } : {}) },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: false },
        sessionCapabilities: { resume: {}, list: {}, additionalDirectories: {} },
        // `account/logout`, which the runtime asks for as ACP's `logout`.
        auth: { logout: {} },
      },
      authMethods: [],
      _meta: { steering: { supported: true } },
    }
  }

  /** Codex's login, by its own account: none with an OpenAI login required means it cannot answer. */
  private async assertLogin(timeoutMs?: number, signal?: AbortSignal): Promise<void> {
    const read = account.safeParse(await this.send('account/read', {}, timeoutMs, signal))
    if (read.success && read.data.account == null && read.data.requiresOpenaiAuth === true)
      throw new RpcError(RPC.authRequired, 'Codex is not logged in')
  }

  private async readModels(timeoutMs?: number, signal?: AbortSignal): Promise<void> {
    const models: CodexModels['models'] = []
    let cursor: string | null | undefined = null
    for (let pages = 0; pages < MAX_MODEL_PAGES; pages++) {
      const page = modelPage.safeParse(await this.send('model/list', { cursor }, timeoutMs, signal))
      if (!page.success) break
      for (const entry of page.data.data) {
        const item = codexModel.safeParse(entry)
        if (item.success) models.push(item.data)
      }
      cursor = page.data.nextCursor
      if (!cursor) break
    }
    this.models = { models }
  }

  /**
   * A new thread (`kind` undefined), the session's thread resumed, or loaded: its turns replayed as updates, then resumed.
   * One process runs one thread.
   */
  /**
   * Codex's own fork of the source thread, through the turn opened by Latch's message `through` (`FORK_METHOD`): the new
   * thread holds Codex's own record up to that turn. A `ForkRefused` when the source's turns do not name that message
   * (a turn started before Latch marked its turns, or a Codex that does not keep the mark) or the fork does not end
   * there; the session then sends the Host's text record.
   */
  private async fork(params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    const parsed = forkParams.safeParse(params)
    if (!parsed.success) throw new RpcError(RPC.invalidParams, 'Invalid params')
    if (this.threadId) throw new ForkRefused('这个进程已经打开了别的会话')
    if (!parsed.data.through) throw new ForkRefused('来源会话没有这一轮的标识')
    return this.open('fork', params, timeoutMs, signal)
  }

  /** The source thread's turn that Latch's message opened, read from Codex's record of the thread. */
  private async markedTurn(threadId: string, messageId: string, timeoutMs?: number, signal?: AbortSignal): Promise<string> {
    const answer = await this.send('thread/read', { threadId, includeTurns: true }, timeoutMs, signal).catch((error: unknown) => {
      if (error instanceof RpcError && error.code !== RPC.cancelled)
        throw new ForkRefused(`它读不到来源的记录（${clip(error.message, 160)}）`)
      throw error
    })
    const read = z.object({ thread }).safeParse(answer)
    if (!read.success) throw new ForkRefused('它的记录读不懂')
    const turn = (read.data.thread.turns ?? []).find(
      item =>
        isRecord(item)
        && Array.isArray(item.items)
        && item.items.some(entry => isRecord(entry) && entry.type === 'userMessage' && entry.clientId === messageId),
    )
    if (!isRecord(turn) || typeof turn.id !== 'string') throw new ForkRefused('它的记录里找不到这一轮')
    if (turn.status === 'inProgress') throw new ForkRefused('这一轮在它那里还没有结束')
    return turn.id
  }

  /** Whether the thread's last turn is the one Latch's message opened. */
  private async endsWith(threadId: string, messageId: string, timeoutMs?: number, signal?: AbortSignal): Promise<boolean> {
    const answer = await this.send('thread/read', { threadId, includeTurns: true }, timeoutMs, signal).catch(() => undefined)
    const read = z.object({ thread }).safeParse(answer)
    const last = read.success ? (read.data.thread.turns ?? []).at(-1) : undefined
    return (
      isRecord(last)
      && Array.isArray(last.items)
      && last.items.some(entry => isRecord(entry) && entry.type === 'userMessage' && entry.clientId === messageId)
    )
  }

  private async open(
    kind: 'resume' | 'load' | 'carry' | 'fork' | undefined,
    params: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const parsed = sessionParams.safeParse(params)
    if (!parsed.success || !parsed.data.cwd) throw new RpcError(RPC.invalidParams, 'Invalid params')
    if (this.threadId && (kind === undefined || parsed.data.sessionId !== this.threadId))
      throw new RpcError(RPC.internal, 'This Codex process already runs another session')
    const servers = (parsed.data.mcpServers ?? []).map(server => mcpServer.safeParse(server))
    if (servers.some(server => !server.success)) throw new RpcError(RPC.invalidParams, 'Codex takes stdio MCP servers only')
    this.servers = servers.flatMap(server => (server.success ? [server.data] : []))
    this.cwd = parsed.data.cwd
    this.folders = parsed.data.additionalDirectories ?? []
    // A session on a route runs on Latch's provider with the gateway's token: Codex's own account is not what answers,
    // so its absence refuses nothing.
    if (!this.route) await this.assertLogin(timeoutMs, signal)
    if (this.route) {
      this.models = { models: this.route.models.slice(0, 500).map(id => ({ id, displayName: id })) }
      this.model ??= this.route.model
      this.route.setThinking?.(this.route.model, this.routeEffort ?? null)
    } else await this.readModels(timeoutMs, signal)
    const settings = threadSettings(this.mode, this.cwd, this.servers)
    if (this.route) {
      let environment: Record<string, unknown> | undefined
      try {
        environment = codexGatewayEnvironment(await this.send('config/read', { cwd: this.cwd, includeLayers: false }, timeoutMs, signal))
      } catch {
        // A configuration error may quote private values. Only the fact that no safe policy was read leaves this wire.
      }
      if (!environment) throw new RpcError(RPC.internal, '无法读取 Codex 的命令环境规则，未打开会话。')
      // `model_context_window`: the window Codex assumes for the thread's model, which it knows nothing of on Latch's
      // provider; without it Codex takes a default far larger than many services' models and compacts only after the
      // service refuses a turn. Its automatic compaction keeps its own default relative to this window.
      const contextTokens = this.route.modelCapabilities?.[this.route.model]?.contextTokens
      settings.config = {
        ...(isRecord(settings.config) ? settings.config : {}),
        shell_environment_policy: environment,
        ...(contextTokens ? { model_context_window: contextTokens } : {}),
      }
      // A model chosen in Latch is durable even before the next turn records it in Codex's own thread.
      settings.model = this.route.model
    }
    let answer: unknown
    // A new thread on a route starts on the route's model; every turn names its model after that.
    if (kind === undefined) answer = await this.send('thread/start', settings, timeoutMs, signal)
    else if (kind === 'fork') {
      const source = parsed.data.sessionId ?? ''
      const through = forkParams.parse(params).through!
      const lastTurnId = await this.markedTurn(source, through, timeoutMs, signal)
      answer = await this.send(
        'thread/fork',
        { threadId: source, lastTurnId, ...settings, ...(this.route ? { modelProvider: CODEX_GATEWAY_PROVIDER } : {}), excludeTurns: true },
        timeoutMs,
        signal,
      ).catch((error: unknown) => {
        if (error instanceof RpcError && error.code !== RPC.cancelled) throw new ForkRefused(`它回答「${clip(error.message, 200)}」`)
        throw error
      })
      const forked = opened.safeParse(answer)
      if (!forked.success || forked.data.thread.id === source) throw new ForkRefused('它没有为分叉新建线程')
      // A Codex that does not know `lastTurnId` forks the whole thread: the copy must end at the turn asked for.
      if (!(await this.endsWith(forked.data.thread.id, through, timeoutMs, signal))) {
        const archived = await this.send('thread/archive', { threadId: forked.data.thread.id }, timeoutMs).then(
          () => true,
          () => false,
        )
        throw new ForkRefused(
          archived ? '分叉出的线程没有停在这一轮' : '分叉出的线程没有停在这一轮，而且没能归档，它留在 Codex 自己的会话列表里',
        )
      }
    } else if (kind === 'carry') {
      // Codex 0.169 resumes a thread only on the provider it began on, but forks one onto another: a new thread with the
      // same turns, on this process's provider (Latch's on a route, else the one the person configured).
      const threadId = parsed.data.sessionId ?? ''
      answer = await this.send(
        'thread/fork',
        { threadId, ...settings, ...(this.route ? { modelProvider: CODEX_GATEWAY_PROVIDER } : {}), excludeTurns: true },
        timeoutMs,
        signal,
      ).catch(notFound)
    } else {
      const threadId = parsed.data.sessionId ?? ''
      // Loaded first: Codex reads only a thread it has loaded. Its replay then comes before the answer, as ACP's does.
      answer = await this.send('thread/resume', { threadId, ...settings, excludeTurns: true }, timeoutMs, signal).catch(notFound)
      if (kind === 'load') await this.replay(threadId, timeoutMs, signal)
    }
    const read = opened.safeParse(answer)
    if (!read.success) throw new RpcError(RPC.internal, 'Codex answered a thread request in a shape Latch does not read')
    if (
      kind === 'carry' || kind === 'fork'
        ? read.data.thread.id === parsed.data.sessionId
        : kind !== undefined && read.data.thread.id !== parsed.data.sessionId
    )
      throw new RpcError(RPC.internal, 'Codex 恢复的线程与所选会话不一致。')
    this.threadId = read.data.thread.id
    if (this.team?.rootId !== this.threadId) {
      const rootThreadId = this.threadId
      this.team = new CodexTeam(rootThreadId, (id, { parentTurnId, childTurnId, result, failure, recovered, ...update }) => {
        if (this.threadId !== rootThreadId || this.stopping) return
        this.update({
          sessionUpdate: 'subagent_update',
          sessionId: id,
          ...update,
          team: {
            rootThreadId,
            ...(parentTurnId ? { parentTurnId } : {}),
            ...(childTurnId ? { childTurnId } : {}),
            ...(result ? { result } : {}),
            ...(failure ? { failure } : {}),
            ...(recovered ? { recovered } : {}),
          },
        })
      })
      this.teamResumed = kind === 'resume'
    }
    // On a route, only a model of the service: a resumed thread that last ran another goes on with the route's.
    const reported = read.data.model ?? undefined
    if (this.route && reported !== this.route.model) throw new RpcError(RPC.internal, 'Codex 没有采用所选模型，未发送本轮输入。')
    this.model = this.route ? (reported && this.route.models.includes(reported) ? reported : this.model) : (reported ?? this.model)
    this.effort = this.route?.setThinking && this.routeEffort !== undefined ? this.routeEffort : (read.data.reasoningEffort ?? this.effort)
    // A route's turns run on a model service, which has no tier of Codex's plan.
    if (!this.route && !this.tierPicked) this.tier = tierValue(read.data.serviceTier)
    await this.readSkills(timeoutMs, signal)
    this.reportMcp(timeoutMs)
    this.reportQuota(timeoutMs)
    return { sessionId: this.threadId, configOptions: this.options() }
  }

  get codexTeam(): AgentWire['codexTeam'] {
    if (this.teamEnabled !== undefined) return this.teamEnabled ? 'available' : 'disabled'
  }

  hasActiveCodexMember(threadId?: string): boolean {
    return !this.stopping && this.team?.hasActiveMember(threadId) === true
  }

  reconcileCodexTeam(savedMember?: (rootThreadId: string, childThreadId: string, childTurnId?: string) => boolean): void {
    const team = this.team
    if (!team || this.stopping) return
    void this.readCodexTeamFeatures(team)
    if (savedMember && this.teamResumed) void this.readCodexTeamHistory(team, savedMember)
    this.teamResumed = false
  }

  private async readCodexTeamFeatures(team: CodexTeam): Promise<void> {
    let cursor: string | undefined
    for (let page = 0; page < 4; page++) {
      const raw = await this.send(
        'experimentalFeature/list',
        { threadId: team.rootId, limit: 100, ...(cursor ? { cursor } : {}) },
        2500,
      ).catch(() => undefined)
      const parsed = codexTeamFeatures.safeParse(raw)
      if (!parsed.success || this.team !== team || this.stopping) return
      const feature = parsed.data.data.find(entry => entry.name === 'multi_agent')
      if (feature) {
        this.teamEnabled = feature.enabled
        this.update({ sessionUpdate: 'latch/codex-team-availability' })
        return
      }
      if (!parsed.data.nextCursor || parsed.data.nextCursor === cursor) return
      cursor = parsed.data.nextCursor
    }
  }

  private async readCodexTeamHistory(team: CodexTeam, savedMember: (root: string, child: string, turn?: string) => boolean): Promise<void> {
    let cursor: string | undefined
    let reads = 0
    for (let index = 0; index < 4; index++) {
      const raw = await this.send('thread/list', { parentThreadId: team.rootId, limit: 64, ...(cursor ? { cursor } : {}) }, 2500).catch(
        () => undefined,
      )
      const list = codexTeamThreadPage.safeParse(raw)
      if (!list.success || this.team !== team || this.stopping) return
      for (const value of list.data.data) {
        const thread = codexTeamThread.safeParse(value)
        if (!thread.success || thread.data.parentThreadId !== team.rootId || !savedMember(team.rootId, thread.data.id)) continue
        if (!team.restoreMember(thread.data)) continue
        const child = thread.data.id
        const page = await this.send('thread/turns/list', { threadId: child, limit: 8, itemsView: 'notLoaded' }, 750).catch(() => undefined)
        if (this.team !== team || this.stopping) return
        const read = codexTeamHistory.safeParse(page)
        const turn = read.success ? read.data.data.find(record => savedMember(team.rootId, child, record.id)) : undefined
        // Readback can synthesize interruption. Only fetch output for the exact prior work and a proved terminal state.
        if (turn?.status === 'completed' || turn?.status === 'failed') {
          const rawItems = await this.send(
            'thread/items/list',
            { threadId: child, turnId: turn.id, limit: 24, sortDirection: 'desc' },
            750,
          ).catch(() => undefined)
          if (this.team !== team || this.stopping || !savedMember(team.rootId, child, turn.id)) return
          const items = codexTeamHistoryItems.safeParse(rawItems)
          team.recover(
            child,
            turn.id,
            turn.status,
            items.success ? teamHistoryResult(items.data.data.toReversed()) : undefined,
            turn.error?.message,
          )
        }
        if (++reads >= 24) return
      }
      if (!list.data.nextCursor || cursor === list.data.nextCursor) return
      cursor = list.data.nextCursor
    }
  }

  private codexChild(id: string): Promise<boolean> {
    const team = this.team
    if (!team || id.length > 512 || this.stopping) return Promise.resolve(false)
    if (team.owns(id)) return Promise.resolve(true)
    const current = this.checkingChildren.get(id)
    if (current) return current
    if (this.checkingChildren.size >= 8) return Promise.resolve(false)
    const check = this.send('thread/read', { threadId: id, includeTurns: false }, 2000)
      .then(raw => {
        const parsed = codexTeamThread.safeParse(isRecord(raw) ? raw.thread : undefined)
        return parsed.success && parsed.data.id === id && this.team === team && !this.stopping && team.acceptThread(parsed.data)
      })
      .catch(() => false)
      .finally(() => {
        this.checkingChildren.delete(id)
      })
    this.checkingChildren.set(id, check)
    return check
  }

  private observeTeamItem(params: Record<string, unknown>): void {
    const turn = this.turn
    if (!turn || !this.team || params.threadId !== this.team.rootId || typeof params.turnId !== 'string') return
    const item = codexTeamItem.safeParse(params.item)
    if (!item.success) return
    if (turn.id === params.turnId) this.applyTeamItem(this.team, params.turnId, item.data)
    else if (!turn.id && this.teamItems.length < 32) this.teamItems.push({ turnId: params.turnId, item: item.data })
  }

  private flushTeamItems(turnId: string): void {
    const team = this.team
    if (!team) return
    for (const { turnId: observed, item } of this.teamItems.splice(0)) if (observed === turnId) this.applyTeamItem(team, turnId, item)
  }

  private applyTeamItem(team: CodexTeam, turnId: string, item: CodexTeamItem): void {
    team.observeItem(team.rootId, turnId, item)
    const turn = this.turn
    if (!turn) return
    if (team.hasActiveMember()) turn.delegated = true
    // A parent item names a candidate. The native thread must independently report its parent before we show it.
    const missing = team.spawnTargets(item).filter(id => !team.owns(id))
    if (!missing.length) {
      if (turn.cancelled) this.interrupt(turn)
      return
    }
    const generation = this.teamTurnGeneration
    turn.checkingMembers = (turn.checkingMembers ?? 0) + 1
    void Promise.all(missing.map(id => this.codexChild(id))).then(() => {
      if (this.team !== team || this.teamTurnGeneration !== generation || this.turn !== turn || this.stopping) return
      team.observeItem(team.rootId, turnId, item)
      if (team.hasActiveMember()) turn.delegated = true
      turn.checkingMembers = (turn.checkingMembers ?? 1) - 1
      if (turn.cancelled) this.interrupt(turn)
      else this.finishWhenSettled(turn)
    })
  }

  /** Only the official directory supplies skill paths. Invalidation clears them before any asynchronous re-read. */
  private readSkills(timeoutMs?: number, signal?: AbortSignal): Promise<void> {
    const threadId = this.threadId
    const cwd = this.cwd
    const generation = ++this.skillGeneration
    this.skillPaths.clear()
    this.ambiguousSkills.clear()
    this.skillCatalogue = undefined
    this.skillTruncated = false
    this.reportSkills()
    if (!threadId || signal?.aborted || this.stopping) return Promise.resolve()
    if (this.skillRead) {
      this.skillAgain = true
      return this.skillRead
    }
    const reading = this.send('skills/list', { cwds: [cwd], forceReload: true }, Math.min(timeoutMs ?? 5_000, 5_000), signal)
      .then(answer => {
        if (this.threadId !== threadId || this.cwd !== cwd || this.skillGeneration !== generation || this.stopping) return
        if (!isRecord(answer) || !Array.isArray(answer.data) || answer.data.length !== 1) return
        const entry = answer.data[0]
        if (!isRecord(entry) || entry.cwd !== cwd || !Array.isArray(entry.skills) || !Array.isArray(entry.errors) || entry.errors.length)
          return
        const candidates: Array<{ name: string; path: string; skill?: SessionSkill }> = []
        const counts = new Map<string, number>()
        for (const row of entry.skills) {
          if (!isRecord(row) || row.enabled !== true || typeof row.name !== 'string') continue
          counts.set(row.name, (counts.get(row.name) ?? 0) + 1)
          if (
            !row.name.length
            || row.name.length > 4096
            || /[\s\u0000-\u001f\u007f]/u.test(row.name)
            || typeof row.path !== 'string'
            || !['repo', 'user', 'system', 'admin'].includes(String(row.scope))
            || !isAbsolute(row.path)
            || row.path.length > 16_384
            || /[\u0000-\u001f\u007f]/u.test(row.path)
          ) {
            this.skillTruncated = true
            continue
          }
          const scope = row.scope === 'repo' ? 'project' : row.scope
          const parsed = readSessionSkills([
            {
              name: row.name,
              invocation: `$${row.name}`,
              scope,
              ...(typeof row.description === 'string' && row.description.length <= 1000 ? { description: row.description } : {}),
            },
          ])
          candidates.push({ name: row.name, path: row.path, ...(parsed?.[0] ? { skill: parsed[0] } : {}) })
        }
        for (const [name, count] of counts) if (count > 1) this.ambiguousSkills.add(`$${name}`)
        const publicSkills: SessionSkill[] = []
        for (const { name, skill, path } of candidates) {
          if (counts.get(name) !== 1) {
            this.skillTruncated = true
            continue
          }
          this.skillPaths.set(`$${name}`, { name, path })
          if (skill) publicSkills.push(skill)
          else this.skillTruncated = true
        }
        const bounded = boundSessionSkills(publicSkills)
        this.skillCatalogue = bounded.skills
        this.skillTruncated ||= bounded.skillsTruncated === true
      })
      .catch(() => {
        // Directory failures can quote private paths. Only the absence of a current catalogue leaves this wire.
      })
      .finally(() => {
        if (this.skillRead === reading) this.skillRead = undefined
        if (this.skillGeneration === generation) this.reportSkills()
        if (this.skillAgain && !signal?.aborted && !this.stopping && this.threadId === threadId) {
          this.skillAgain = false
          void this.readSkills()
        }
      })
    this.skillRead = reading
    return reading
  }

  private reportSkills(): void {
    if (this.threadId && this.listedFor === this.threadId)
      this.update({
        sessionUpdate: SESSION_SKILLS_UPDATE,
        skills: this.skillCatalogue ?? null,
        ...(this.skillCatalogue && this.skillTruncated ? { skillsTruncated: true } : {}),
      })
  }

  /**
   * Codex's own MCP servers, as `mcpServerStatus/list` reports them: for the thread, reusing its connections and starting
   * nothing. Without a thread Codex 0.167 lists only the names it has configured, with no state (and none a plugin adds
   * in a thread): `namesOnly`. Latch's own servers on the thread are left out: they are Latch's to show.
   */
  private async readMcp(
    threadId: string | undefined,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ servers: Map<string, HarnessMcpServer>; truncated?: true; namesOnly?: true }> {
    const latch = new Set(this.servers.map(server => server.name))
    const servers = new Map<string, HarnessMcpServer>()
    // One deadline for every page: a slow Codex cannot stretch the read by answering each page just in time.
    const deadline = timeoutMs ? Date.now() + timeoutMs : undefined
    let truncated = false
    let stated = false
    let cursor: string | null | undefined = null
    for (let pages = 0; ; pages++) {
      if (pages >= MCP_PAGES) {
        truncated = true
        break
      }
      const left = deadline === undefined ? undefined : deadline - Date.now()
      if (left !== undefined && left <= 0) throw new RequestTimeout('mcpServerStatus/list')
      const page = mcpStatusPage.safeParse(
        await this.send(
          'mcpServerStatus/list',
          { cursor, limit: 100, detail: 'toolsAndAuthOnly', ...(threadId ? { threadId } : {}) },
          left,
          signal,
        ),
      )
      if (!page.success) throw new RpcError(RPC.internal, 'Codex answered mcpServerStatus/list in a shape Latch does not read')
      for (const entry of page.data.data) {
        const item = mcpStatusEntry.safeParse(entry)
        if (!item.success || latch.has(item.data.name) || servers.has(item.data.name)) continue
        if (servers.size >= MCP_MAX) {
          truncated = true
          break
        }
        const state = RUNTIME_STATE[item.data.runtimeStatus ?? ''] ?? 'unknown'
        if (item.data.runtimeStatus) stated = true
        servers.set(
          item.data.name,
          codexMcpServer(item.data.name, state, { tools: toolCount(item.data.tools), origin: mcpOrigin(item.data.httpOrigin) }),
        )
      }
      cursor = page.data.nextCursor
      if (!cursor || truncated) break
    }
    if (threadId || stated) return { servers, ...(truncated ? { truncated: true as const } : {}) }
    // Names only: with no connection, the tools it lists are no count of what the server offers.
    for (const [name, server] of servers) servers.set(name, codexMcpServer(name, 'unknown', { origin: server.origin }))
    return { servers, namesOnly: true, ...(truncated ? { truncated: true as const } : {}) }
  }

  /** `_latch/mcp/status`: the session's servers when it names one, or, in a process with no thread, the names Codex has. */
  private async mcpStatus(params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    const sessionId = isRecord(params) && typeof params.sessionId === 'string' ? params.sessionId : undefined
    if (sessionId !== undefined) this.assertSession(sessionId)
    else if (this.threadId) throw new RpcError(RPC.invalidParams, 'This process runs a session')
    const read = await this.readMcp(sessionId, timeoutMs, signal)
    return {
      servers: [...read.servers.values()],
      ...(read.truncated ? { truncated: true } : {}),
      ...(read.namesOnly ? { namesOnly: true } : {}),
    }
  }

  /** Once a thread is open: its servers as Codex lists them, then as each start is reported. Never fails the thread. */
  private reportMcp(timeoutMs?: number): void {
    const threadId = this.threadId
    if (!threadId) return
    const seen = new Set<string>()
    this.mcpSeen = seen
    void this.readMcp(threadId, timeoutMs)
      .then(read => {
        if (this.threadId !== threadId) return
        for (const [name, server] of read.servers) {
          const newer = seen.has(name) ? this.ownMcp.get(name) : undefined
          this.ownMcp.set(name, newer ? codexMcpServer(name, newer.state, { tools: server.tools, origin: server.origin }) : server)
        }
        this.sendMcp(read.truncated)
      })
      .catch(() => {})
      .finally(() => {
        if (this.mcpSeen === seen) this.mcpSeen = undefined
      })
  }

  private sendMcp(truncated?: true): void {
    this.update({ sessionUpdate: MCP_STATUS_UPDATE, servers: [...this.ownMcp.values()], ...(truncated ? { truncated } : {}) })
  }

  /**
   * Once a thread is open on Codex's own login: the plan's limits as Codex reads them for its own status line, then as
   * each turn updates them. It starts nothing and runs no turn, and never fails the thread. The account's address is
   * masked before it leaves this method.
   */
  private reportQuota(timeoutMs?: number): void {
    if (this.route || !this.threadId) return
    void Promise.all([
      this.send('account/rateLimits/read', { excludeResetCreditDetails: true }, timeoutMs),
      this.send('account/read', {}, timeoutMs).catch(() => undefined),
    ])
      .then(([limits, who]) => {
        const report = codexQuota(limits, who, Date.now())
        if (report) this.update({ sessionUpdate: QUOTA_UPDATE, ...report })
      })
      .catch(() => {})
  }

  /**
   * The plan's limits asked for by someone looking, with or without a thread: the same two account reads, starting
   * nothing and running no turn. Codex's own word that it is not logged in is `RPC.authRequired`.
   */
  private async readQuota(timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    if (this.route) return null
    const who = await this.send('account/read', {}, timeoutMs, signal)
    const read = account.safeParse(who)
    if (read.success && read.data.account == null && read.data.requiresOpenaiAuth === true)
      throw new RpcError(RPC.authRequired, 'Codex is not logged in')
    const limits = await this.send('account/rateLimits/read', { excludeResetCreditDetails: true }, timeoutMs, signal)
    return codexQuota(limits, who, Date.now()) ?? null
  }

  /** A thread's turns as the updates a session would have had: what the person said, Codex's replies and its calls. */
  private async replay(threadId: string, timeoutMs?: number, signal?: AbortSignal): Promise<void> {
    const answer = await this.send('thread/read', { threadId, includeTurns: true }, timeoutMs, signal).catch(notFound)
    const read = z.object({ thread }).safeParse(answer)
    if (!read.success) throw new RpcError(RPC.internal, 'Codex answered thread/read in a shape Latch does not read')
    for (const turn of read.data.thread.turns ?? []) {
      const items = isRecord(turn) && Array.isArray(turn.items) ? turn.items.filter(isRecord) : []
      for (const item of items) {
        if (item.type === 'userMessage') {
          const said = (Array.isArray(item.content) ? item.content : [])
            .flatMap(part => (isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
            .join('\n')
          if (said) this.emit(threadId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: said } })
        } else this.item(threadId, item, 'completed')
      }
    }
  }

  private async list(params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    const cursor = isRecord(params) && typeof params.cursor === 'string' ? params.cursor : undefined
    // Every provider's threads: Codex lists only the process's provider's by default, so those started through Latch
    // and those on the person's own login both show.
    const read = listing.safeParse(
      await this.send('thread/list', { ...(cursor ? { cursor } : {}), limit: MAX_THREADS, modelProviders: [] }, timeoutMs, signal),
    )
    if (!read.success) throw new RpcError(RPC.internal, 'Codex answered thread/list in a shape Latch does not read')
    const sessions = read.data.data.flatMap(row => {
      const parsed = thread.safeParse(row)
      if (!parsed.success || !parsed.data.cwd) return []
      const { id, cwd, name, preview, updatedAt } = parsed.data
      const title = (name || preview || '').trim()
      // Codex counts seconds since the epoch.
      const at = typeof updatedAt === 'number' ? new Date(updatedAt < 1e12 ? updatedAt * 1000 : updatedAt) : undefined
      return [
        {
          sessionId: id,
          cwd,
          ...(title ? { title: clip(title, 200) } : {}),
          ...(at && Number.isFinite(at.getTime()) ? { updatedAt: at.toISOString() } : {}),
        },
      ]
    })
    return { sessions, ...(read.data.nextCursor ? { nextCursor: read.data.nextCursor } : {}) }
  }

  private options(): unknown[] {
    const listed = codexOptions(
      {
        models: this.models.models,
        ...(this.model ? { model: this.model } : {}),
        ...(this.effort ? { effort: this.effort } : {}),
        ...(this.tier ? { tier: this.tier } : {}),
      },
      !this.route,
    ).options
    if (this.route?.setThinking && this.model) {
      const thinking = gatewayEffortOption(this.route.modelCapabilities?.[this.model]?.thinking, this.routeEffort)
      if (thinking) listed.push(thinking)
    }
    return [
      {
        type: 'select',
        id: CODEX_MODE_ID,
        category: 'mode',
        name: 'Mode',
        currentValue: this.mode,
        options: Object.entries(MODES).map(([value, mode]) => ({ value, name: mode.name })),
      },
      ...listed.map(option => ({ type: 'select', ...option })),
    ]
  }

  /** Model, effort and mode are sent with every turn, so a change is held here and applies from the next one. */
  private setOption(params: unknown): unknown {
    const parsed = optionParams.safeParse(params)
    if (!parsed.success) throw new RpcError(RPC.invalidParams, 'Invalid params')
    this.assertSession(parsed.data.sessionId)
    const { configId, value } = parsed.data
    if (configId === CODEX_MODE_ID) {
      if (!isMode(value)) throw new RpcError(RPC.invalidParams, 'Unknown mode')
      this.mode = value
    } else if (configId === CODEX_MODEL_ID) {
      if (!this.models.models.some(entry => entry.id === value) && value !== this.model)
        throw new RpcError(RPC.invalidParams, 'Codex does not offer this model')
      if (this.route?.setThinking) {
        this.routeEffort = undefined
      }
      this.model = value
      const entry = this.models.models.find(item => item.id === value)
      const efforts = entry?.supportedReasoningEfforts?.map(item => item.reasoningEffort) ?? []
      if (this.effort && efforts.length && !efforts.includes(this.effort)) this.effort = entry?.defaultReasoningEffort ?? efforts[0]
    } else if (configId === CODEX_TIER_ID) {
      const entry = this.route ? undefined : this.models.models.find(item => item.id === this.model)
      const offered = entry && speedOption(entry, this.tier)
      if (!offered?.options.some(item => item.value === value))
        throw new RpcError(RPC.invalidParams, 'Codex does not offer this speed for the model')
      this.tier = value
      this.tierPicked = true
    } else if (configId === CODEX_EFFORT_ID) {
      if (this.route?.setThinking) {
        if (!this.model) throw new RpcError(RPC.invalidParams, 'No selected gateway model')
        const effort = value === GATEWAY_DEFAULT_EFFORT ? null : value
        if (effort !== null && !this.route.modelCapabilities?.[this.model]?.thinking?.includes(effort))
          throw new RpcError(RPC.invalidParams, '这个模型服务没有声明所请求的思考档位')
        this.routeEffort = effort ?? undefined
        if (effort !== null) this.effort = effort
      } else this.effort = value
    } else throw new RpcError(RPC.invalidParams, 'Unknown option')
    return { configOptions: this.options() }
  }

  /**
   * The tier a turn names: only once a person picked 速度, only on Codex's own login and only for a model that takes the
   * Fast tier. Otherwise the turn inherits the thread's tier, which is the person's own configuration.
   */
  private tierSetting(): { serviceTier?: string } {
    if (this.route || !this.tierPicked || !this.tier) return {}
    if (!fastTierOf(this.models.models.find(item => item.id === this.model))) return {}
    return { serviceTier: this.tier }
  }

  private assertSession(sessionId: string): void {
    if (!this.threadId || sessionId !== this.threadId) throw new RpcError(RPC.notFound, 'Session not found')
  }

  private input(blocks: z.infer<typeof promptParams>['prompt'], context?: PromptContext): unknown[] {
    const input: unknown[] = blocks.map(block => {
      if (block.type === 'text' && block.text !== undefined) return { type: 'text', text: block.text, text_elements: [] }
      if (block.type === 'image' && block.data && block.mimeType)
        return { type: 'image', url: `data:${block.mimeType};base64,${block.data}` }
      throw new RpcError(RPC.invalidParams, `Codex takes no ${clip(block.type, 64)} content here`)
    })
    const added = new Set<string>()
    for (const match of context?.userText?.matchAll(/(?:^|\s)(\$\S+)/gu) ?? []) {
      const invocation = match[1]!
      if (this.ambiguousSkills.has(invocation)) throw new RpcError(RPC.invalidParams, '技能名称不唯一，请先在 Codex 中消除重复名称。')
      const skill = this.skillPaths.get(invocation)
      if (!skill || added.has(invocation)) continue
      added.add(invocation)
      input.push({ type: 'skill', name: skill.name, path: skill.path })
    }
    return input
  }

  private async prompt(params: unknown, timeoutMs?: number, context?: PromptContext): Promise<unknown> {
    const parsed = promptParams.safeParse(params)
    if (!parsed.success) throw new RpcError(RPC.invalidParams, 'Invalid params')
    this.assertSession(parsed.data.sessionId)
    if (this.turn) throw new RpcError(RPC.internal, 'A turn is already running')
    if (this.listedFor !== this.threadId) {
      this.listedFor = this.threadId
      this.update({ sessionUpdate: 'available_commands_update', availableCommands: [COMPACT] })
      this.reportSkills()
    }
    const command = nativeCommand(parsed.data.prompt)
    if (command === 'review') throw new RpcError(RPC.invalidParams, REVIEW_UNAVAILABLE)
    const compact = command === 'compact'
    if (compact && (parsed.data.prompt.length !== 1 || parsed.data.prompt[0]?.text?.trim() !== '/compact'))
      throw new RpcError(RPC.invalidParams, 'Codex 的 /compact 不接受参数或附件。')
    const input = this.input(parsed.data.prompt, context)
    let turn!: Turn
    const done = new Promise<unknown>((resolve, reject) => {
      turn = { resolve, reject, cancelled: false, commands: new Set(), threads: new Set(), ...(compact ? { compact: true } : {}) }
    })
    this.teamItems.length = 0
    this.teamTurnGeneration++
    this.turn = turn
    done.catch(() => {})
    let answer: unknown
    try {
      // Changes selected during a run belong to its successor, never to the current tool loop's requests.
      if (this.route?.setThinking && this.model) this.route.setThinking(this.model, this.routeEffort ?? null)
      if (compact) {
        await this.assertCommandContext(timeoutMs)
        if (this.turn !== turn) return done
        // A cancellation while reading settings never starts a native operation.
        if (turn.cancelled) {
          this.finish(turn, () => turn.resolve({ stopReason: 'cancelled' }))
          return done
        }
        await this.send('thread/compact/start', { threadId: this.threadId }, timeoutMs)
        return done
      }
      answer = await this.send(
        'turn/start',
        {
          threadId: this.threadId,
          input,
          // Codex keeps it on the turn's user message: a later fork finds the turn by Latch's message.
          ...(context?.messageId && this.marksTurns ? { clientUserMessageId: context.messageId } : {}),
          ...turnSettings(this.mode, this.cwd, this.folders),
          ...(this.model ? { model: this.model } : {}),
          ...(this.effort ? { effort: this.effort } : {}),
          ...this.tierSetting(),
          summary: 'auto',
        },
        timeoutMs,
      )
    } catch (error) {
      if (this.turn === turn) this.turn = undefined
      throw error
    }
    const read = started.safeParse(answer)
    if (!read.success) {
      if (this.turn === turn) this.turn = undefined
      throw new RpcError(RPC.internal, 'Codex answered turn/start in a shape Latch does not read')
    }
    // A completion may have arrived before this answer was read; it named the turn then.
    if (this.turn === turn) {
      turn.id ??= read.data.turn.id
      this.flushTeamItems(turn.id)
      if (turn.cancelled) this.interrupt(turn)
    }
    return done
  }

  /** Native operations have no per-turn overrides. Rejoining only reads the loaded thread's effective context. */
  private async assertCommandContext(timeoutMs?: number): Promise<void> {
    const actual = await this.send('thread/resume', { threadId: this.threadId, excludeTurns: true }, timeoutMs)
    const expected = turnSettings(this.mode, this.cwd, this.folders)
    if (
      !isRecord(actual)
      || !isRecord(actual.thread)
      || actual.thread.id !== this.threadId
      || actual.cwd !== this.cwd
      || typeof actual.model !== 'string'
      || actual.model !== this.model
      || !Object.hasOwn(actual, 'reasoningEffort')
      || actual.activePermissionProfile != null
      || (actual.reasoningEffort ?? null) !== (this.effort ?? null)
      || actual.approvalPolicy !== expected.approvalPolicy
      || actual.approvalsReviewer !== expected.approvalsReviewer
      || !isDeepStrictEqual(actual.sandbox, expected.sandboxPolicy)
    )
      throw new RpcError(RPC.invalidParams, 'Codex 当前上下文的模型、思考或权限与选择不一致。请先发送普通消息应用设置，再运行 /compact。')
  }

  private async steer(params: unknown, timeoutMs?: number, signal?: AbortSignal, context?: PromptContext): Promise<unknown> {
    const parsed = promptParams.safeParse(params)
    if (!parsed.success) throw new RpcError(RPC.invalidParams, 'Invalid params')
    this.assertSession(parsed.data.sessionId)
    const command = nativeCommand(parsed.data.prompt)
    if (command === 'review') throw new RpcError(RPC.invalidParams, REVIEW_UNAVAILABLE)
    if (command === 'compact') throw new RpcError(RPC.invalidParams, '/compact 只能在本轮结束后运行。')
    const turn = this.turn
    if (!turn?.id || turn.cancelled || turn.rootResult) return { outcome: 'promptRequired' }
    const input = this.input(parsed.data.prompt, context)
    try {
      await this.send('turn/steer', { threadId: this.threadId, expectedTurnId: turn.id, input }, timeoutMs, signal)
    } catch (error) {
      // The turn ended meanwhile: the addition becomes the next prompt.
      if (error instanceof RpcError && error.code !== RPC.cancelled) return { outcome: 'promptRequired' }
      throw error
    }
    return { outcome: 'injected' }
  }

  /** The turn is over for Codex: its answer, kept back while a command a stop left running has not ended. */
  private settle(status: unknown, error: unknown): void {
    const turn = this.turn
    if (!turn || turn.rootResult) return
    turn.rootResult = { status, error }
    for (const id of turn.compactions ?? [])
      this.update({
        sessionUpdate: 'compaction_update',
        compactionId: id,
        // Only a dedicated manual compaction owns the whole turn's outcome.
        status: !turn.compact
          ? 'unknown'
          : turn.cancelled || status === 'interrupted'
            ? 'cancelled'
            : status === 'completed'
              ? 'completed'
              : 'failed',
        ...(isRecord(error) && typeof error.message === 'string' ? { error: error.message } : {}),
      })
    if (this.team?.hasActiveMember()) turn.delegated = true
    if (status === 'completed' && (turn.delegated || turn.checkingMembers))
      this.update({ sessionUpdate: 'latch/codex-team-root-completed' })
    if (turn.cancelled) this.interrupt(turn)
    else this.finishWhenSettled(turn)
  }

  private finishWhenSettled(turn: Turn): void {
    const root = turn.rootResult
    // A picture still being read is shown in this turn, not dropped after it.
    if (this.turn !== turn || !root || turn.checkingMembers || turn.imageReads) return
    const active = this.team?.activeMembers() ?? []
    if (active.length) turn.delegated = true
    if (active.some(({ threadId, turnId }) => turn.memberInterruptions?.get(threadId) !== turnId)) return
    const stopping = turn.cancelled || root.status === 'interrupted'
    if (turn.commands.size && (stopping || turn.delegated)) {
      if (stopping && !turn.endingCommands) {
        turn.endingCommands = true
        void this.endCommands(turn)
      }
      return
    }
    const usage = turn.usage ? { usage: turn.usage } : {}
    this.finish(turn, () => {
      if (root.status === 'interrupted' || (turn.cancelled && root.status !== 'failed')) turn.resolve({ stopReason: 'cancelled', ...usage })
      else this.answer(turn, root.status, root.error)
    })
  }

  private finish(turn: Turn, answer: () => void): void {
    if (this.turn !== turn) return
    if (!turn.commands.size && turn.memberInterruptions)
      for (const [child, childTurnId] of turn.memberInterruptions) this.team?.finish(child, childTurnId, 'interrupted')
    this.turn = undefined
    this.teamItems.length = 0
    this.streamed.clear()
    this.summaryPart.clear()
    this.output.clear()
    this.answered.clear()
    this.allowed.clear()
    this.notRun.clear()
    this.mcpCalls.clear()
    this.denied.clear()
    answer()
  }

  /** A command of the turn ended; a stopped turn that waited only on it is answered now. */
  private commandEnded(id: string): void {
    const turn = this.turn
    if (!turn?.commands.delete(id)) return
    this.finishWhenSettled(turn)
  }

  /**
   * Codex answers a stop once its turn is interrupted, but a command it started keeps running (an allowed one outside
   * the sandbox among them). The stop is answered only once each has ended: Latch asks Codex to end the ones it lists
   * for the session's thread and its subagents', then ends any it still runs itself, by the process Codex named, while
   * that is still one of this process's and leads its own group, and answers once each group is gone. Anything less
   * (the process list unreadable, a process that is not this one's, a group whose leader exited) is left to the
   * runtime's cancel limit, which ends the whole process and what it started; a turn Codex interrupted with no stop of
   * Latch's has no such limit, so it gets one of its own (`unaskedMs`).
   */
  private async endCommands(turn: Turn): Promise<void> {
    const threadId = this.threadId
    const pids = new Map<string, number>()
    for (const thread of threadId ? [threadId, ...turn.threads] : [])
      try {
        const listed = terminalPage.safeParse(
          await this.send('thread/backgroundTerminals/list', { threadId: thread, limit: 100 }, stopLimits.commandMs),
        )
        for (const entry of listed.success ? listed.data.data : []) {
          const key = commandKey(thread, entry.itemId)
          if (!turn.commands.has(key)) continue
          if (entry.osPid) pids.set(key, entry.osPid)
          await this.send(
            'thread/backgroundTerminals/terminate',
            { threadId: thread, processId: entry.processId },
            stopLimits.commandMs,
          ).catch(() => {})
        }
      } catch {
        /* An older Codex without the request: the command is found below or left to the limit. */
      }
    if (await this.ended(turn, stopLimits.commandMs)) return
    const leader = this.process.pid
    const below = leader === undefined ? undefined : await descendants(leader)
    if (this.turn !== turn || this.process.stopping) return
    if (below) {
      let all = true
      const ended = new Map<string, number>()
      for (const id of turn.commands) {
        const pid = pids.get(id)
        const group = pid === undefined ? undefined : below.get(pid)
        if (pid === undefined || group === undefined) {
          all = false
          continue
        }
        killProcess(pid, group)
        // Only a command that leads its own group can be seen to be gone with everything it started.
        if (group === pid) ended.set(id, pid)
        else all = false
      }
      if (await this.ended(turn, stopLimits.commandMs)) return
      // Each command Latch ended is gone with its group, though Codex never said how it went: its result is unknown.
      if (all && [...ended.values()].every(pid => !groupAlive(pid))) {
        for (const id of ended.keys()) turn.commands.delete(id)
        this.finishWhenSettled(turn)
        if (this.turn !== turn) return
      }
    }
    if (turn.cancelled || (await this.ended(turn, stopLimits.unaskedMs)) || turn.cancelled) return
    // An interrupted notification alone cannot end a command. Without a runtime cancel timer, stop the process here
    // so the runtime records an interrupted turn and unknown tool results instead of claiming a completed stop.
    if (this.turn === turn) await this.process.stop('kill', stopLimits.commandMs)
  }

  /** Whether the stopped turn was answered within `ms`. */
  private async ended(turn: Turn, ms: number): Promise<boolean> {
    for (const until = Date.now() + ms; Date.now() < until;) {
      if (this.turn !== turn) return true
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return this.turn !== turn
  }

  private answer(turn: Turn, status: unknown, error: unknown): void {
    const usage = turn.usage ? { usage: turn.usage } : {}
    if (status === 'failed') {
      // Codex's own word for a login the service no longer takes: the session asks for a login, as ACP's refusal does.
      if (isRecord(error) && error.codexErrorInfo === 'unauthorized')
        return turn.reject(new RpcError(RPC.authRequired, 'Codex is not logged in'))
      const said = isRecord(error) && typeof error.message === 'string' ? error.message : turn.error
      return turn.reject(new RpcError(RPC.internal, clip(redactKnownSecrets(said || 'Codex stopped with an error'), 4000)))
    }
    turn.resolve({ stopReason: 'end_turn', ...usage })
  }

  private emit(sessionId: string, update: Record<string, unknown> & { sessionUpdate: string }): void {
    try {
      this.handlers.notification('session/update', { sessionId, update })
    } catch {
      this.process.noise++
    }
  }

  private update(update: Record<string, unknown> & { sessionUpdate: string }): void {
    if (this.threadId) this.emit(this.threadId, update)
  }

  /** A subagent's update or ask, marked so that the runtime shows it as the subagent's (`profiles/codex.ts`). */
  private marked<T extends Record<string, unknown>>(value: T, child: string | undefined): T {
    if (!child || !this.threadId) return value
    const meta = isRecord(value._meta) ? value._meta : {}
    return { ...value, _meta: { ...meta, [CODEX_CHILD_META]: { id: child, parentID: this.threadId } } }
  }

  /**
   * One of Codex's items as ACP tool calls: started, or completed (with what it produced). Messages are text; a
   * subagent's (`child`) are left out, its calls shown as its. A command is pending until it is seen running or a person
   * allows it: one Codex refuses first (its review model, its rules) never ran, and its refusal says so
   * (`latch/codexDenied`). Every command started in a turn is waited for when the turn is stopped (`endCommands`).
   */
  private item(sessionId: string, item: Record<string, unknown>, phase: 'started' | 'completed', child?: string, mcp?: McpCall): void {
    const id = typeof item.id === 'string' ? clip(item.id, 512) : undefined
    if (!id) return
    const done = phase === 'completed'
    const call = commandKey(child ?? sessionId, id)
    const emit = (update: Record<string, unknown> & { sessionUpdate: string }) => this.emit(sessionId, this.marked(update, child))
    if (!child && this.turn && !done && !TEXT_ITEMS.has(String(item.type)))
      this.turn.call = { ...this.turn.call, ms: this.turn.call?.ms ?? 0, tool: true }
    switch (item.type) {
      case 'contextCompaction': {
        if (child || !this.turn) return
        const compactionId = clip(id, 256)
        this.turn.compactions ??= new Set()
        this.turn.compactions.add(compactionId)
        // Manual compaction is one operation: its turn, not its item's lifecycle, supplies the outcome.
        if (!done || !this.turn.compact)
          emit({ sessionUpdate: 'compaction_update', compactionId, status: done ? 'completed' : 'in_progress' })
        if (done && !this.turn.compact) this.turn.compactions.delete(compactionId)
        return
      }
      case 'agentMessage':
      case 'reasoning': {
        // Codex's own times for the item: how long its output streamed, for the turn's speed.
        if (done && !child && this.turn && typeof item.startedAtMs === 'number' && typeof item.completedAtMs === 'number') {
          const ms = item.completedAtMs - item.startedAtMs
          if (Number.isFinite(ms) && ms > 0 && ms < 86_400_000) this.turn.call = { ...this.turn.call, ms: (this.turn.call?.ms ?? 0) + ms }
        }
        if (child || !done || this.streamed.has(id)) return
        const text =
          item.type === 'agentMessage'
            ? typeof item.text === 'string'
              ? item.text
              : ''
            : // Each part of a summary is a section of its own: a title line and what was thought under it.
              (Array.isArray(item.summary) ? item.summary : []).filter(part => typeof part === 'string').join('\n\n')
        if (text)
          emit({
            sessionUpdate: item.type === 'agentMessage' ? 'agent_message_chunk' : 'agent_thought_chunk',
            messageId: id,
            content: { type: 'text', text },
          })
        return
      }
      case 'commandExecution': {
        const command = typeof item.command === 'string' ? item.command : 'command'
        const actions = commandActions(item.commandActions)
        if (!done && item.status === 'inProgress' && !this.notRun.has(call)) this.turn?.commands.add(call)
        if (child) this.turn?.threads.add(child)
        if (!done || !this.output.has(call))
          emit({
            sessionUpdate: 'tool_call',
            toolCallId: id,
            title: clip(command, 500),
            kind: 'execute',
            status: this.allowed.has(call) ? 'in_progress' : 'pending',
            rawInput: { command, ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}) },
            ...(actions ? { actions } : {}),
          })
        if (!done) {
          this.output.set(call, '')
          return
        }
        const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : (this.output.get(call) ?? '')
        const status = itemStatus(item.status, item.exitCode) ?? 'completed'
        if (item.status === 'completed' || (item.status === 'failed' && (output || typeof item.exitCode === 'number')))
          emit({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress' })
        emit({
          sessionUpdate: 'tool_call_update',
          toolCallId: id,
          status,
          content: output ? [{ type: 'content', content: { type: 'text', text: clip(output, TOOL_TEXT_LIMIT) } }] : [],
          // The finished item's parse is the last word: an empty list clears what its start reported.
          actions: actions ?? [],
          ...this.refusal(call, item.status),
        })
        this.commandEnded(call)
        return
      }
      case 'fileChange': {
        const { text: diff, paths } = changesText(item.changes)
        const content = diff ? [{ type: 'content', content: { type: 'text', text: diff } }] : []
        if (!done)
          return emit({
            sessionUpdate: 'tool_call',
            toolCallId: id,
            title: clip(paths.length ? `edit ${paths.join(', ')}` : 'edit', 500),
            kind: 'edit',
            status: 'pending',
            locations: paths.slice(0, 32).map(path => ({ path })),
            content,
            outputWithoutFiles: '',
          })
        if (item.status === 'completed') emit({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress' })
        return emit({
          sessionUpdate: 'tool_call_update',
          toolCallId: id,
          status: itemStatus(item.status) ?? 'completed',
          ...(content.length ? { content } : {}),
          ...(content.length ? { outputWithoutFiles: '' } : {}),
          ...this.refusal(call, item.status),
        })
      }
      case 'mcpToolCall':
      case 'webSearch': {
        const title =
          item.type === 'webSearch'
            ? `search ${typeof item.query === 'string' ? item.query : ''}`.trim()
            : `${typeof item.server === 'string' ? item.server : 'mcp'}.${typeof item.tool === 'string' ? item.tool : 'tool'}`
        // Codex starts an MCP call before it asks about it: pending until it is seen to have run.
        const input = item.type === 'mcpToolCall' ? nativeSimulatorInputName(item.server, item.tool) : undefined
        if (!done)
          return emit({
            sessionUpdate: 'tool_call',
            toolCallId: id,
            title: clip(title, 500),
            ...(input ? { name: input } : {}),
            kind: item.type === 'webSearch' ? 'fetch' : 'other',
            status: 'pending',
            ...(item.arguments !== undefined ? { rawInput: item.arguments } : {}),
          })
        const ran = item.type === 'webSearch' || item.result != null || (item.error != null && item.status !== 'declined')
        if (ran && item.status !== 'declined') emit({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress' })
        const asked = item.type === 'mcpToolCall' && mcp?.answered
        return emit({
          sessionUpdate: 'tool_call_update',
          toolCallId: id,
          status: item.error ? 'failed' : (itemStatus(item.status) ?? 'completed'),
          ...(asked ? {} : this.refusal(id, item.status)),
        })
      }
      case 'imageGeneration':
        return this.imageItem(item, id, done, child, emit)
      default:
        return
    }
  }

  /**
   * Codex's image tool: a row marked as the picture's place while it runs, which settles with the picture as an image
   * block in its content; the runtime keeps that as the row's attachment, so the picture is where the row was in any
   * order of the turn's updates. The bytes come from the item (`result`), else from Codex itself (`fs/readFile` on the
   * path it reported), which finds it wherever CODEX_HOME points. A failure, or a picture that is not passed on, is a
   * short line on the row.
   */
  private imageItem(
    item: Record<string, unknown>,
    id: string,
    done: boolean,
    child: string | undefined,
    emit: (update: Record<string, unknown> & { sessionUpdate: string }) => void,
  ): void {
    if (child) return
    const row = { toolCallId: id, title: '生成图片', kind: 'other', _meta: { [IMAGE_GENERATION_META]: true } }
    if (!done) return emit({ sessionUpdate: 'tool_call', ...row, status: 'in_progress' })
    const settled = (status: 'completed' | 'failed', note?: string) =>
      emit({
        sessionUpdate: 'tool_call_update',
        ...row,
        status,
        content: note ? [{ type: 'content', content: { type: 'text', text: note } }] : [],
      })
    if (item.failure != null || item.status === 'failed')
      return settled(
        'failed',
        generatedImageNote(isRecord(item.failure) && item.failure.type === 'usageLimitExceeded' ? 'usage-limit' : 'failed'),
      )
    // A thread read back (`replay`) has no turn: its pictures were shown when it ran, or never.
    const turn = this.turn
    if (!turn) return settled('completed')
    if ((turn.images ?? 0) >= GENERATED_IMAGES_PER_TURN) return settled('completed', generatedImageNote('count'))
    turn.images = (turn.images ?? 0) + 1
    const pass = (base64: string) => {
      const image = generatedImage(base64)
      if ('refused' in image) return settled('completed', generatedImageNote(image.refused))
      emit({
        sessionUpdate: 'tool_call_update',
        ...row,
        status: 'completed',
        content: [{ type: 'content', content: { type: 'image', data: image.data, mimeType: image.mimeType } }],
      })
    }
    if (typeof item.result === 'string' && item.result) return pass(item.result)
    const path = savedImagePath(item.savedPath)
    if (!path) return settled('completed', generatedImageNote('unread'))
    turn.imageReads = (turn.imageReads ?? 0) + 1
    void this.send('fs/readFile', { path }, 30_000)
      .then(
        answer => {
          if (this.turn !== turn) return
          const data = isRecord(answer) && typeof answer.dataBase64 === 'string' ? answer.dataBase64 : undefined
          if (data) pass(data)
          else settled('completed', generatedImageNote('unread'))
        },
        () => {
          if (this.turn === turn) settled('completed', generatedImageNote('unread'))
        },
      )
      .finally(() => {
        turn.imageReads = Math.max(0, (turn.imageReads ?? 1) - 1)
        this.finishWhenSettled(turn)
      })
  }

  /**
   * Why a call Codex reports declined never ran, when no person declined it: its review model's verdict, else its own
   * rules. A call the person was asked about carries their answer instead.
   */
  private refusal(id: string, status: unknown): Record<string, unknown> {
    if (status !== 'declined' || this.answered.has(id)) return {}
    const review = this.denied.get(id)
    return {
      _meta: {
        'latch/codexDenied': this.denied.has(id)
          ? { source: 'model', ...(review ? { reason: clip(review, 1000) } : {}) }
          : { source: 'rule', reason: 'Codex 自己的规则或沙箱没有放行' },
      },
    }
  }

  /** Codex's review model deciding a request in `agent` mode: a row of its own, with its verdict as Latch records it. */
  private review(params: Record<string, unknown>, done: boolean, child?: string): void {
    if (typeof params.reviewId !== 'string') return
    const id = `guardian_assessment:${clip(params.reviewId, 400)}`
    const review = isRecord(params.review) ? params.review : {}
    const action = isRecord(params.action) ? params.action : {}
    const input = action.type === 'mcpToolCall' ? nativeSimulatorInputName(action.server, action.toolName) : undefined
    const subject =
      action.type === 'command'
        ? `运行 ${said(action.command)}`
        : action.type === 'execve'
          ? `运行 ${said(action.program)}`
          : action.type === 'applyPatch'
            ? `修改 ${
                Array.isArray(action.files)
                  ? action.files
                      .filter(file => typeof file === 'string')
                      .slice(0, 3)
                      .join('、')
                  : '文件'
              }`
            : action.type === 'networkAccess'
              ? `联网访问 ${said(action.host)}`
              : action.type === 'mcpToolCall'
                ? `调用 ${said(action.server)}.${said(action.toolName)}`
                : '一项请求'
    const update = (value: Record<string, unknown> & { sessionUpdate: string }) => this.update(this.marked(value, child))
    if (!done) {
      update({
        sessionUpdate: 'tool_call',
        toolCallId: id,
        title: clip(subject, 500),
        ...(input ? { name: input } : {}),
        kind: 'think',
        status: 'in_progress',
      })
      return
    }
    const status = typeof review.status === 'string' ? review.status : 'aborted'
    const rationale = typeof review.rationale === 'string' ? review.rationale : undefined
    if (status === 'denied' && typeof params.targetItemId === 'string')
      this.denied.set(commandKey(child ?? this.threadId, params.targetItemId), rationale ?? '')
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: id,
      status: status === 'approved' ? 'completed' : 'failed',
      rawOutput: { review: { status, ...(rationale ? { rationale: clip(rationale, 1000) } : {}) } },
    })
  }

  private trackMcp(method: string, params: Record<string, unknown>): McpCall | undefined {
    if (!this.turn || (method !== 'item/started' && method !== 'item/completed')) return undefined
    const item = params.item
    if (!isRecord(item) || item.type !== 'mcpToolCall') return undefined
    if (typeof item.server !== 'string' || !item.server || typeof item.tool !== 'string' || !item.tool || !isRecord(item.arguments))
      return undefined
    const thread = params.threadId,
      turn = params.turnId,
      id = item.id
    if ([thread, turn, id].some(value => typeof value !== 'string' || !value || value.length > 512)) return undefined
    if (thread === this.threadId && turn !== this.turn.id) return undefined
    const key = JSON.stringify([thread, turn, id])
    const known = this.mcpCalls.get(key)
    if (method === 'item/started') {
      if (known) known.ended = true
      if (!known && this.mcpCalls.size < 1024)
        this.mcpCalls.set(key, {
          thread: thread as string,
          turn: turn as string,
          id: id as string,
          server: item.server,
          tool: item.tool,
          arguments: item.arguments,
          claimed: false,
          answered: false,
          ended: false,
        })
      return undefined
    }
    if (!known || known.ended) return undefined
    known.ended = true
    return known.server === item.server && known.tool === item.tool && isDeepStrictEqual(known.arguments, item.arguments)
      ? known
      : undefined
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    if (method === 'skills/changed') {
      void this.readSkills()
      return
    }
    if (method === 'thread/started') {
      const parsed = codexTeamThread.safeParse(params.thread)
      if (parsed.success) this.team?.acceptThread(parsed.data)
      return
    }
    if (method === 'item/completed') this.observeTeamItem(params)
    const source = typeof params.threadId === 'string' ? params.threadId : undefined
    if (source && source !== this.threadId && this.team && !this.team.owns(source)) {
      if (method !== 'item/started' && method !== 'item/completed' && method !== 'turn/started' && method !== 'turn/completed') return
      const queued = this.childEvents.get(source)
      if (queued) {
        if (queued.length < 12) queued.push({ method, params })
      } else if (this.childEvents.size < 8) {
        const events = [{ method, params }]
        this.childEvents.set(source, events)
        void this.codexChild(source).then(accepted => {
          this.childEvents.delete(source)
          if (accepted && !this.stopping) for (const event of events) this.onNotification(event.method, event.params)
        })
      }
      return
    }
    const mcp = this.trackMcp(method, params)
    // Codex may run its subagents' threads in this process: their calls reach the session marked as theirs.
    const thread = typeof params.threadId === 'string' ? params.threadId : undefined
    const child = thread !== undefined && thread !== this.threadId ? thread : undefined
    if (child) {
      if (!this.threadId) return
      if (method === 'turn/started' && isRecord(params.turn) && typeof params.turn.id === 'string') {
        this.team?.start(child, params.turn.id)
        if (this.turn && this.team?.hasActiveMember(child)) this.turn.delegated = true
        if (this.turn?.cancelled) this.interrupt(this.turn)
      }
      if (method === 'turn/completed') {
        const parsed = codexTeamTurn.safeParse(params.turn)
        if (parsed.success) {
          const result = isRecord(params.turn) && Array.isArray(params.turn.items) ? teamHistoryResult(params.turn.items) : undefined
          if (result) this.team?.output(child, parsed.data.id, result)
          const { id, status, error } = parsed.data
          if (status !== 'interrupted') this.team?.finish(child, id, status, error?.message)
          else if (this.turn) {
            if (!this.turn.commands.size) this.team?.finish(child, id, status)
            else {
              this.turn.memberInterruptions ??= new Map()
              this.turn.memberInterruptions.set(child, id)
            }
          } else this.team?.finish(child, id, 'unknown')
          if (this.turn) this.finishWhenSettled(this.turn)
        }
      }
      if (
        method === 'item/completed'
        && typeof params.turnId === 'string'
        && isRecord(params.item)
        && params.item.type === 'agentMessage'
        && params.item.phase !== 'commentary'
        && typeof params.item.text === 'string'
      )
        this.team?.output(child, params.turnId, params.item.text)
      if ((method === 'item/started' || method === 'item/completed') && isRecord(params.item))
        this.item(this.threadId, params.item, method === 'item/started' ? 'started' : 'completed', child, mcp)
      // Its review model's decisions on the subagent's calls are rows of the subagent's, recorded as any review is.
      if (method === 'item/autoApprovalReview/started' || method === 'item/autoApprovalReview/completed')
        this.review(params, method.endsWith('completed'), child)
      return
    }
    const turn = this.turn
    switch (method) {
      case 'turn/started':
        if (turn && isRecord(params.turn) && typeof params.turn.id === 'string') {
          turn.id ??= params.turn.id
          this.flushTeamItems(turn.id)
          if (turn.cancelled) this.interrupt(turn)
        }
        return
      case 'turn/completed': {
        const done = isRecord(params.turn) ? params.turn : {}
        if (turn && (turn.id === undefined || turn.id === done.id)) this.settle(done.status, done.error)
        return
      }
      case 'item/agentMessage/delta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        if (typeof params.delta !== 'string' || !params.delta || typeof params.itemId !== 'string') return
        this.streamed.add(params.itemId)
        let text = params.delta
        if (method === 'item/reasoning/summaryTextDelta' && typeof params.summaryIndex === 'number') {
          // Codex streams a summary part by part without a break between them; a blank line keeps the sections apart.
          const part = this.summaryPart.get(params.itemId)
          if (part !== undefined && part !== params.summaryIndex) text = `\n\n${text}`
          this.summaryPart.set(params.itemId, params.summaryIndex)
        }
        this.update({
          sessionUpdate: method === 'item/agentMessage/delta' ? 'agent_message_chunk' : 'agent_thought_chunk',
          messageId: clip(params.itemId, 512),
          content: { type: 'text', text },
        })
        return
      }
      case 'item/commandExecution/outputDelta': {
        if (typeof params.delta !== 'string' || typeof params.itemId !== 'string') return
        const call = commandKey(this.threadId, clip(params.itemId, 512))
        const so = clip((this.output.get(call) ?? '') + params.delta, TOOL_TEXT_LIMIT)
        this.output.set(call, so)
        // Output is the first sign it runs.
        this.update({
          sessionUpdate: 'tool_call_update',
          toolCallId: clip(params.itemId, 512),
          status: 'in_progress',
          content: [{ type: 'content', content: { type: 'text', text: so } }],
        })
        return
      }
      case 'item/started':
      case 'item/completed':
        if (isRecord(params.item) && params.item.type === 'contextCompaction' && (!turn?.id || params.turnId !== turn.id)) return
        if (isRecord(params.item) && this.threadId)
          this.item(this.threadId, params.item, method === 'item/started' ? 'started' : 'completed', undefined, mcp)
        return
      case 'item/autoApprovalReview/started':
      case 'item/autoApprovalReview/completed':
        this.review(params, method.endsWith('completed'))
        return
      case 'turn/plan/updated': {
        const plan = Array.isArray(params.plan) ? params.plan.filter(isRecord) : []
        this.update({
          sessionUpdate: 'plan',
          entries: plan.slice(0, 64).map(step => ({
            content: clip(typeof step.step === 'string' ? step.step : '', 1000),
            status: PLAN_STATUS[typeof step.status === 'string' ? step.status : ''] ?? 'pending',
            priority: 'medium',
          })),
        })
        return
      }
      case 'thread/tokenUsage/updated': {
        const usage = isRecord(params.tokenUsage) ? params.tokenUsage : {}
        const last = isRecord(usage.last) ? usage.last : {}
        const total = isRecord(usage.total) ? usage.total : {}
        const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined)
        const input = count(total.inputTokens)
        const output = count(total.outputTokens)
        // The thread's whole count, cached input included in the input: what the session used so far, said as it grows.
        if (input !== undefined && output !== undefined && !this.route) {
          const cached = count(total.cachedInputTokens)
          const written = count(total.cacheWriteInputTokens)
          const thought = count(total.reasoningOutputTokens)
          const usage: TurnTokens = {
            inputTokens: input,
            outputTokens: output,
            ...(cached !== undefined ? { cachedReadTokens: cached } : {}),
            ...(written !== undefined ? { cachedWriteTokens: written } : {}),
            ...(thought !== undefined ? { thoughtTokens: thought } : {}),
          }
          if (turn) {
            turn.usage = usage
            // One model call ended: its output counts toward the speed only when nothing but text and reasoning streamed.
            const written = count(last.outputTokens)
            if (turn.call && !turn.call.tool && turn.call.ms > 0 && written)
              turn.stream = { outputTokens: (turn.stream?.outputTokens ?? 0) + written, ms: (turn.stream?.ms ?? 0) + turn.call.ms }
            turn.call = undefined
          }
          this.update({ sessionUpdate: TOKENS_UPDATE, scope: 'session', ...usage, ...(turn?.stream ? { stream: turn.stream } : {}) })
        } else if (turn && input !== undefined && output !== undefined) {
          // On a route the session's count is the gateway's; the turn still says what Codex read from cache and thought.
          const cached = count(total.cachedInputTokens)
          const thought = count(total.reasoningOutputTokens)
          turn.usage = {
            inputTokens: input,
            outputTokens: output,
            ...(cached !== undefined ? { cachedReadTokens: cached } : {}),
            ...(thought !== undefined ? { thoughtTokens: thought } : {}),
          }
        }
        const used = count(last.totalTokens)
        const size = count(usage.modelContextWindow)
        if (used !== undefined || size)
          this.update({ sessionUpdate: 'usage_update', ...(used !== undefined ? { used } : {}), ...(size ? { size } : {}) })
        return
      }
      case 'mcpServer/startupStatus/updated': {
        const read = startupUpdate.safeParse(params)
        if (!read.success || !this.threadId || this.servers.some(server => server.name === read.data.name)) return
        const before = this.ownMcp.get(read.data.name)
        if (!before && this.ownMcp.size >= MCP_MAX) return
        const state =
          read.data.failureReason === 'reauthenticationRequired' ? 'needs-login' : (STARTUP_STATE[read.data.status] ?? 'unknown')
        this.ownMcp.set(read.data.name, codexMcpServer(read.data.name, state, { tools: before?.tools, origin: before?.origin }))
        this.mcpSeen?.add(read.data.name)
        this.sendMcp()
        return
      }
      case 'account/rateLimits/updated': {
        // On a route the turns run on a model service, and the plan's limits are not theirs.
        const report = this.route ? undefined : codexQuotaUpdate(params, Date.now())
        if (report) this.update({ sessionUpdate: QUOTA_UPDATE, ...report })
        return
      }
      case 'error': {
        const message = isRecord(params.error) && typeof params.error.message === 'string' ? params.error.message : ''
        if (params.willRetry === true) {
          if (message)
            this.update({
              sessionUpdate: 'notice',
              severity: 'warning',
              title: clip(redactKnownSecrets(message), 300),
              description: 'Codex 正在重试',
            })
        } else if (turn) turn.error = message
        return
      }
      default:
        return
    }
  }

  /**
   * What an approval asks and what 允许 grants, in the person's words: network access to a host, writing below a folder,
   * or a command run outside the sandbox the mode gives.
   */
  private asked(command: boolean, params: Record<string, unknown>): { title: string; rawInput: Record<string, unknown> } {
    // What the agent wrote reaches every client's card: hidden and direction-changing characters are shown, not obeyed.
    const safe = (value: unknown, limit: number) =>
      typeof value === 'string' && value ? escapeSecurityText(clip(value, limit)) : undefined
    const network = isRecord(params.networkApprovalContext) ? params.networkApprovalContext : undefined
    const host = network ? safe(network.host, 300) : undefined
    const protocol = network ? safe(network.protocol, 40) : undefined
    const shown = command ? safe(params.command, 4000) : undefined
    const reason = safe(params.reason, 2000)
    const root = safe(params.grantRoot, 2000)
    const grants: string[] = []
    let title: string
    if (host) {
      title = `联网：${host}`
      grants.push(`允许后，${shown ? '这条命令' : 'Codex'}可以访问 ${host}${protocol ? `（${protocol}）` : ''}`)
    } else if (command && params.kind === 'writeStdin') {
      title = '向运行中的命令输入'
      grants.push('允许后，Codex 向这个正在运行的命令写入内容')
    } else if (command) {
      title = shown ?? '运行命令'
      grants.push(MODES[this.mode].sandbox === 'danger-full-access' ? '允许后运行这条命令' : '允许后，这条命令在沙箱之外运行')
    } else {
      title = root ? `修改 ${root} 下的文件` : '修改文件'
      grants.push(root ? `允许后，Codex 可以写入 ${root}` : '允许后，Codex 改这些文件')
    }
    return {
      title: clip(title, 500),
      rawInput: {
        grants,
        ...(shown ? { command: shown } : {}),
        ...(safe(params.cwd, 2000) ? { cwd: safe(params.cwd, 2000) } : {}),
        ...(host ? { network: { host, ...(protocol ? { protocol } : {}) } } : {}),
        ...(reason ? { reason } : {}),
        ...(root ? { grantRoot: root } : {}),
      },
    }
  }

  /**
   * Codex's requests. An approval is put to the person with one-time answers: accept, or decline (Codex goes on without
   * it); no answer, as on a stop, is cancel, which ends the turn. A subagent's approval is marked as its, so the runtime
   * asks the person only within the session's own mode. Every other request goes to the runtime, whose profile answers
   * the ones it knows (`profiles/codex.ts`) and says so in the session; the rest are unknown there, and said so too.
   */
  /**
   * Codex's questions to the person, put as ACP's form elicitation so they reach the same question card: each question a
   * field, its options the choices (the card's 其他 is the free answer). Answered by question ID with the chosen label or
   * the words written. A question marked secret is never asked through Latch, whose answers stay in the session's record:
   * Codex gets no answers and the session says why. No answer (stopped, or a card Latch cannot show) is no answers.
   */
  private async userInput(params: Record<string, unknown>, id: RpcId): Promise<unknown> {
    // Read before the shape is checked: a request Latch cannot read is written into the session as an unknown one, and a
    // secret question's words must never be.
    const secret = Array.isArray(params.questions) && params.questions.some(item => isRecord(item) && item.isSecret === true)
    const parsed = userInputParams.safeParse(params)
    if (!secret && !parsed.success)
      return this.handlers.request('item/tool/requestUserInput', { ...params, ...(this.threadId ? { sessionId: this.threadId } : {}) }, id)
    if (secret || !parsed.success) {
      this.update({
        sessionUpdate: 'notice',
        severity: 'warning',
        title: 'Codex 要的回答可能是密码或密钥。Latch 不代收这类回答，已告诉它没有回答；需要时在终端里直接交给 Codex。',
      })
      return NO_ANSWERS
    }
    const { questions } = parsed.data
    const title = (item: (typeof questions)[number]) => (item.header?.trim() ? `${item.header.trim()}：${item.question}` : item.question)
    const properties = Object.fromEntries(
      questions.map((item, index) => [
        `q${index}`,
        {
          type: 'string',
          title: title(item),
          ...(item.options?.length
            ? {
                oneOf: item.options.map(option => ({
                  const: option.label,
                  title: option.label,
                  ...(option.description ? { description: option.description } : {}),
                })),
              }
            : {}),
        },
      ]),
    )
    const answer = await this.handlers
      .request(
        'elicitation/create',
        {
          ...(this.threadId ? { sessionId: this.threadId } : {}),
          mode: 'form',
          message: questions.length === 1 ? title(questions[0]!) : 'Codex 有几个问题',
          requestedSchema: { type: 'object', properties, required: Object.keys(properties) },
        },
        id,
      )
      .catch(() => undefined)
    if (!isRecord(answer) || answer.action !== 'accept' || !isRecord(answer.content)) return NO_ANSWERS
    const content = answer.content
    return {
      answers: Object.fromEntries(
        questions.flatMap((item, index) => {
          const value = content[`q${index}`]
          return typeof value === 'string' && value ? [[item.id, { answers: [value] }]] : []
        }),
      ),
    }
  }

  private async onRequest(method: string, params: Record<string, unknown>, id: RpcId): Promise<unknown> {
    if (method === 'mcpServer/elicitation/request' && isToolApproval(params)) return this.toolApproval(params, id)
    const active = this.turn
    const thread = typeof params.threadId === 'string' ? params.threadId : undefined
    const child = thread !== undefined && thread !== this.threadId ? thread : undefined
    const permission = method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval'
    if (child && (!(await this.codexChild(child)) || this.turn !== active || !this.team?.acceptsTurn(child, params.turnId))) {
      if (permission) return { decision: 'cancel' }
      throw new RpcError(RPC.invalidParams, 'Codex 请求没有可确认的会话来源。')
    }
    if (method === 'item/tool/requestUserInput') return this.userInput(params, id)
    if (!permission) return this.handlers.request(method, { ...params, ...(this.threadId ? { sessionId: this.threadId } : {}) }, id)
    const command = method === 'item/commandExecution/requestApproval'
    const itemId = typeof params.itemId === 'string' ? clip(params.itemId, 512) : `ask-${String(id)}`
    const { title, rawInput } = this.asked(command, params)
    const answer = await this.handlers
      .request(
        'session/request_permission',
        {
          sessionId: this.threadId,
          toolCall: this.marked({ toolCallId: itemId, title, kind: command ? 'execute' : 'edit', status: 'pending', rawInput }, child),
          options: ASK_OPTIONS,
        },
        id,
      )
      .catch(() => undefined)
    const outcome = isRecord(answer) && isRecord(answer.outcome) ? answer.outcome : {}
    const chosen = outcome.outcome === 'selected' ? outcome.optionId : undefined
    const call = commandKey(thread ?? this.threadId, itemId)
    if (chosen === 'accept' || chosen === 'decline') this.answered.add(call)
    if (chosen === 'accept' && command && params.kind !== 'writeStdin') {
      this.allowed.add(call)
      this.notRun.delete(call)
      // An accepted quiet command can run without item/started or any output. It belongs to the turn's stop either way.
      this.turn?.commands.add(call)
      if (child) this.turn?.threads.add(child)
      this.update(this.marked({ sessionUpdate: 'tool_call_update', toolCallId: itemId, status: 'in_progress' }, child))
    } else if (command && params.kind !== 'writeStdin') {
      // Declined or unanswered, it never runs, whether or not Codex reports it ended.
      this.notRun.add(call)
      this.commandEnded(call)
    }
    return { decision: chosen === 'accept' ? 'accept' : chosen === 'decline' ? 'decline' : 'cancel' }
  }

  /**
   * Codex asking whether to run an MCP server's tool, which it sends as that server's elicitation marked
   * `codex_approval_kind: mcp_tool_call`: a card like any approval, answered `accept`, `decline` or, with no answer, `cancel`.
   */
  private async toolApproval(params: Record<string, unknown>, id: RpcId): Promise<unknown> {
    const active = this.turn
    const meta = isRecord(params._meta) ? params._meta : {}
    const thread = typeof params.threadId === 'string' ? params.threadId : undefined
    const child = thread !== undefined && thread !== this.threadId ? thread : undefined
    if (child && (!(await this.codexChild(child)) || this.turn !== active || !this.team?.acceptsTurn(child, params.turnId)))
      return { action: 'cancel' }
    // App-server 0.167 omits the native call ID here. Reuse only one complete, unclaimed in-flight match;
    // neither server/tool alone nor the end of a model turn proves which parallel call the person answered.
    const matches =
      meta.tool_params === undefined
        ? []
        : [...this.mcpCalls.values()].filter(
            call =>
              !call.ended
              && !call.claimed
              && call.thread === thread
              && call.turn === params.turnId
              && call.server === params.serverName
              && call.tool === meta.tool_name
              && isDeepStrictEqual(call.arguments, meta.tool_params),
          )
    const call = matches.length === 1 ? matches[0] : undefined
    if (call) call.claimed = true
    const safe = (value: unknown, limit: number) =>
      typeof value === 'string' && value ? escapeSecurityText(clip(value, limit)) : undefined
    const server = safe(params.serverName, 200) ?? 'MCP'
    const tool = safe(meta.tool_name, 200) ?? '工具'
    const input = nativeSimulatorInputName(params.serverName, meta.tool_name)
    const args = meta.tool_params === undefined ? undefined : escapeSecurityText(clip(JSON.stringify(meta.tool_params), 2000))
    const answer = await this.handlers
      .request(
        'session/request_permission',
        {
          sessionId: this.threadId,
          toolCall: this.marked(
            {
              toolCallId: call?.id ?? `mcp-approval-${String(id)}`,
              title: clip(`调用 ${server}.${tool}`, 500),
              ...(input ? { name: input } : {}),
              kind: 'other',
              status: 'pending',
              rawInput: {
                grants: [`允许后，Codex 调用 MCP 服务器「${server}」的工具「${tool}」一次`],
                server,
                tool,
                ...(args ? { arguments: args } : {}),
                ...(safe(params.message, 1000) ? { reason: safe(params.message, 1000) } : {}),
              },
            },
            child,
          ),
          options: ASK_OPTIONS,
        },
        id,
      )
      .catch(() => undefined)
    if (!active || active.cancelled || this.turn !== active) return { action: 'cancel' }
    const outcome = isRecord(answer) && isRecord(answer.outcome) ? answer.outcome : {}
    const chosen = outcome.outcome === 'selected' ? outcome.optionId : undefined
    if (call && (chosen === 'accept' || chosen === 'decline')) call.answered = true
    return chosen === 'accept' ? { action: 'accept', content: {} } : { action: chosen === 'decline' ? 'decline' : 'cancel' }
  }

  private onMessage(message: Record<string, unknown>): void {
    const id = message.id
    if (typeof message.method === 'string') {
      const params = isRecord(message.params) ? message.params : {}
      if (id === undefined || id === null) {
        try {
          this.onNotification(message.method, params)
        } catch {
          this.process.noise++
        }
        return
      }
      if (typeof id !== 'string' && typeof id !== 'number') {
        this.process.noise++
        return
      }
      this.onRequest(message.method, params, id).then(
        result => this.process.write({ id, result: result ?? {} }),
        error =>
          this.process.write({
            id,
            error:
              error instanceof RpcError ? { code: error.code, message: error.message } : { code: RPC.internal, message: 'Internal error' },
          }),
      )
      return
    }
    if (typeof id !== 'number') {
      this.process.noise++
      return
    }
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    entry.cleanup()
    if (isRecord(message.error)) {
      const code = typeof message.error.code === 'number' ? message.error.code : RPC.internal
      const said = typeof message.error.message === 'string' ? message.error.message : 'Codex error'
      entry.reject(new RpcError(code, clip(said, 4000)))
    } else entry.resolve(message.result)
  }

  private onClosed(info: ExitInfo): void {
    this.skillGeneration++
    this.skillPaths.clear()
    this.ambiguousSkills.clear()
    this.skillCatalogue = undefined
    const closed = new ConnectionClosed(info)
    for (const entry of this.pending.values()) {
      entry.cleanup()
      entry.reject(closed)
    }
    this.pending.clear()
    const turn = this.turn
    this.turn = undefined
    turn?.reject(closed)
    this.handlers.exit(info)
  }
}
