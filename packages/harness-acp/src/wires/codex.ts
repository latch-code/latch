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
  type HarnessMcpServer,
  type HarnessMcpState,
  type SessionSkill,
} from '@latch/protocol'
import { isAbsolute } from 'node:path'
import { redactKnownSecrets } from '@latch/core/node-kit'
import { CODEX_EFFORT_ID, CODEX_MODEL_ID, codexModel, codexOptions, type CodexModels } from '../codex-models.ts'
import { clip, TOOL_TEXT_LIMIT } from '../mapping.ts'
import { CODEX_MODES, type CodexMode } from '../profiles/codex.ts'
import { codexGatewayEnvironment } from '../profiles/codex-environment.ts'
import { MCP_STATUS_METHOD, MCP_STATUS_UPDATE, RPC, RpcError, STEER_METHOD, SESSION_SKILLS_UPDATE, type RpcId } from '../protocol.ts'
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
import type { AgentWire, WireHandlers, WireModelRoute } from './types.ts'

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
const DEFAULT_GATEWAY_EFFORT = '~default'
const COMPACT = { name: 'compact', description: '把之前的对话总结成摘要，腾出上下文' }
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
interface Turn {
  id?: string
  compact?: boolean
  compactions?: Set<string>
  resolve(result: unknown): void
  reject(error: Error): void
  cancelled: boolean
  error?: string
  usage?: { inputTokens: number; outputTokens: number }
  /** Commands started in this turn that Codex has not reported ended, by item ID. */
  commands: Set<string>
  /** The subagents' threads that reported calls in this turn: their commands are listed with the session's. */
  threads: Set<string>
  /** The turn's answer, held while its commands run. */
  ending?: () => void
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
  private cwd = ''
  private folders: string[] = []
  private servers: Array<z.infer<typeof mcpServer>> = []
  private mode: Mode = 'read-only'
  private models: CodexModels = { models: [] }
  private model?: string
  private effort?: string
  private routeEffort?: string
  private turn?: Turn
  /** Items whose text arrived in pieces, so their completion does not repeat it. */
  private readonly streamed = new Set<string>()
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
    context?: { userText: string },
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
    if (turn.id) this.interrupt(turn.id)
  }

  stop(reason: 'stop' | 'kill', graceMs: number, cause?: string): Promise<ExitInfo> {
    return this.process.stop(reason, graceMs, cause)
  }

  stderrTail(limit?: number): string {
    return this.process.stderrTail(limit)
  }

  private interrupt(turnId: string): void {
    if (!this.threadId) return
    void this.send('turn/interrupt', { threadId: this.threadId, turnId }).catch(() => {})
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
  private async open(kind: 'resume' | 'load' | undefined, params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    const parsed = sessionParams.safeParse(params)
    if (!parsed.success || !parsed.data.cwd) throw new RpcError(RPC.invalidParams, 'Invalid params')
    if (this.threadId && (kind === undefined || parsed.data.sessionId !== this.threadId))
      throw new RpcError(RPC.internal, 'This Codex process already runs another session')
    const servers = (parsed.data.mcpServers ?? []).map(server => mcpServer.safeParse(server))
    if (servers.some(server => !server.success)) throw new RpcError(RPC.invalidParams, 'Codex takes stdio MCP servers only')
    this.servers = servers.flatMap(server => (server.success ? [server.data] : []))
    this.cwd = parsed.data.cwd
    this.folders = parsed.data.additionalDirectories ?? []
    await this.assertLogin(timeoutMs, signal)
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
      settings.config = { ...(isRecord(settings.config) ? settings.config : {}), shell_environment_policy: environment }
      // A model chosen in Latch is durable even before the next turn records it in Codex's own thread.
      settings.model = this.route.model
    }
    let answer: unknown
    // A new thread on a route starts on the route's model; every turn names its model after that.
    if (kind === undefined) answer = await this.send('thread/start', settings, timeoutMs, signal)
    else {
      const threadId = parsed.data.sessionId ?? ''
      // Loaded first: Codex reads only a thread it has loaded. Its replay then comes before the answer, as ACP's does.
      answer = await this.send('thread/resume', { threadId, ...settings, excludeTurns: true }, timeoutMs, signal).catch(notFound)
      if (kind === 'load') await this.replay(threadId, timeoutMs, signal)
    }
    const read = opened.safeParse(answer)
    if (!read.success) throw new RpcError(RPC.internal, 'Codex answered a thread request in a shape Latch does not read')
    this.threadId = read.data.thread.id
    // On a route, only a model of the service: a resumed thread that last ran another goes on with the route's.
    const reported = read.data.model ?? undefined
    if (this.route && reported !== this.route.model) throw new RpcError(RPC.internal, 'Codex 没有采用所选模型，未发送本轮输入。')
    this.model = this.route ? (reported && this.route.models.includes(reported) ? reported : this.model) : (reported ?? this.model)
    this.effort = this.route?.setThinking && this.routeEffort !== undefined ? this.routeEffort : (read.data.reasoningEffort ?? this.effort)
    await this.readSkills(timeoutMs, signal)
    this.reportMcp(timeoutMs)
    return { sessionId: this.threadId, configOptions: this.options() }
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
    const listed = codexOptions({
      models: this.models.models,
      ...(this.model ? { model: this.model } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
    }).options
    if (this.route?.setThinking && this.model) {
      const efforts = this.route.modelCapabilities?.[this.model]?.thinking ?? []
      if (efforts.length)
        listed.push({
          id: CODEX_EFFORT_ID,
          name: '思考',
          category: 'thought_level',
          currentValue: this.routeEffort ?? DEFAULT_GATEWAY_EFFORT,
          options: [
            { value: DEFAULT_GATEWAY_EFFORT, name: '默认' },
            ...efforts.map(value => ({ value, name: value.charAt(0).toUpperCase() + value.slice(1) })),
          ],
        })
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
    } else if (configId === CODEX_EFFORT_ID) {
      if (this.route?.setThinking) {
        if (!this.model) throw new RpcError(RPC.invalidParams, 'No selected gateway model')
        const effort = value === DEFAULT_GATEWAY_EFFORT ? null : value
        if (effort !== null && !this.route.modelCapabilities?.[this.model]?.thinking?.includes(effort))
          throw new RpcError(RPC.invalidParams, '这个模型服务没有声明所请求的思考档位')
        this.routeEffort = effort ?? undefined
        if (effort !== null) this.effort = effort
      } else this.effort = value
    } else throw new RpcError(RPC.invalidParams, 'Unknown option')
    return { configOptions: this.options() }
  }

  private assertSession(sessionId: string): void {
    if (!this.threadId || sessionId !== this.threadId) throw new RpcError(RPC.notFound, 'Session not found')
  }

  private input(blocks: z.infer<typeof promptParams>['prompt'], context?: { userText: string }): unknown[] {
    const input: unknown[] = blocks.map(block => {
      if (block.type === 'text' && block.text !== undefined) return { type: 'text', text: block.text, text_elements: [] }
      if (block.type === 'image' && block.data && block.mimeType)
        return { type: 'image', url: `data:${block.mimeType};base64,${block.data}` }
      throw new RpcError(RPC.invalidParams, `Codex takes no ${clip(block.type, 64)} content here`)
    })
    const added = new Set<string>()
    for (const match of context?.userText.matchAll(/(?:^|\s)(\$\S+)/gu) ?? []) {
      const invocation = match[1]!
      if (this.ambiguousSkills.has(invocation)) throw new RpcError(RPC.invalidParams, '技能名称不唯一，请先在 Codex 中消除重复名称。')
      const skill = this.skillPaths.get(invocation)
      if (!skill || added.has(invocation)) continue
      added.add(invocation)
      input.push({ type: 'skill', name: skill.name, path: skill.path })
    }
    return input
  }

  private async prompt(params: unknown, timeoutMs?: number, context?: { userText: string }): Promise<unknown> {
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
          ...turnSettings(this.mode, this.cwd, this.folders),
          ...(this.model ? { model: this.model } : {}),
          ...(this.effort ? { effort: this.effort } : {}),
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
      if (turn.cancelled) this.interrupt(turn.id)
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

  private async steer(params: unknown, timeoutMs?: number, signal?: AbortSignal, context?: { userText: string }): Promise<unknown> {
    const parsed = promptParams.safeParse(params)
    if (!parsed.success) throw new RpcError(RPC.invalidParams, 'Invalid params')
    this.assertSession(parsed.data.sessionId)
    const command = nativeCommand(parsed.data.prompt)
    if (command === 'review') throw new RpcError(RPC.invalidParams, REVIEW_UNAVAILABLE)
    if (command === 'compact') throw new RpcError(RPC.invalidParams, '/compact 只能在本轮结束后运行。')
    const turn = this.turn
    if (!turn?.id || turn.cancelled) return { outcome: 'promptRequired' }
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
    if (!turn || turn.ending) return
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
    const usage = turn.usage ? { usage: turn.usage } : {}
    const answer =
      status === 'interrupted' || (turn.cancelled && status !== 'failed')
        ? () => turn.resolve({ stopReason: 'cancelled', ...usage })
        : () => this.answer(turn, status, error)
    // A stopped turn, however Codex ends it, and one Codex interrupted itself are over once their commands have ended.
    if (!(turn.cancelled || status === 'interrupted') || !turn.commands.size) return this.finish(turn, answer)
    turn.ending = answer
    void this.endCommands(turn)
  }

  private finish(turn: Turn, answer: () => void): void {
    if (this.turn !== turn) return
    this.turn = undefined
    this.streamed.clear()
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
    const ending = turn.ending
    if (ending && !turn.commands.size) this.finish(turn, ending)
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
          if (!turn.commands.has(entry.itemId)) continue
          if (entry.osPid) pids.set(entry.itemId, entry.osPid)
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
      const ended: number[] = []
      for (const id of turn.commands) {
        const pid = pids.get(id)
        const group = pid === undefined ? undefined : below.get(pid)
        if (pid === undefined || group === undefined) {
          all = false
          continue
        }
        killProcess(pid, group)
        // Only a command that leads its own group can be seen to be gone with everything it started.
        if (group === pid) ended.push(pid)
        else all = false
      }
      if (await this.ended(turn, stopLimits.commandMs)) return
      // Each command Latch ended is gone with its group, though Codex never said how it went: its result is unknown.
      const ending = turn.ending
      if (all && ending && ended.every(pid => !groupAlive(pid))) return this.finish(turn, ending)
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
    const emit = (update: Record<string, unknown> & { sessionUpdate: string }) => this.emit(sessionId, this.marked(update, child))
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
        if (child || !done || this.streamed.has(id)) return
        const text =
          item.type === 'agentMessage'
            ? typeof item.text === 'string'
              ? item.text
              : ''
            : (Array.isArray(item.summary) ? item.summary : []).filter(part => typeof part === 'string').join('\n')
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
        if (!done && item.status === 'inProgress' && !this.notRun.has(id)) this.turn?.commands.add(id)
        if (child) this.turn?.threads.add(child)
        if (!done || !this.output.has(id))
          emit({
            sessionUpdate: 'tool_call',
            toolCallId: id,
            title: clip(command, 500),
            kind: 'execute',
            status: this.allowed.has(id) ? 'in_progress' : 'pending',
            rawInput: { command, ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}) },
          })
        if (!done) {
          this.output.set(id, '')
          return
        }
        const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : (this.output.get(id) ?? '')
        const status = itemStatus(item.status, item.exitCode) ?? 'completed'
        if (item.status === 'completed' || (item.status === 'failed' && (output || typeof item.exitCode === 'number')))
          emit({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress' })
        emit({
          sessionUpdate: 'tool_call_update',
          toolCallId: id,
          status,
          content: output ? [{ type: 'content', content: { type: 'text', text: clip(output, TOOL_TEXT_LIMIT) } }] : [],
          ...this.refusal(id, item.status),
        })
        this.commandEnded(id)
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
          ...this.refusal(id, item.status),
        })
      }
      case 'mcpToolCall':
      case 'webSearch': {
        const title =
          item.type === 'webSearch'
            ? `search ${typeof item.query === 'string' ? item.query : ''}`.trim()
            : `${typeof item.server === 'string' ? item.server : 'mcp'}.${typeof item.tool === 'string' ? item.tool : 'tool'}`
        // Codex starts an MCP call before it asks about it: pending until it is seen to have run.
        if (!done)
          return emit({
            sessionUpdate: 'tool_call',
            toolCallId: id,
            title: clip(title, 500),
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
      default:
        return
    }
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
      update({ sessionUpdate: 'tool_call', toolCallId: id, title: clip(subject, 500), kind: 'think', status: 'in_progress' })
      return
    }
    const status = typeof review.status === 'string' ? review.status : 'aborted'
    const rationale = typeof review.rationale === 'string' ? review.rationale : undefined
    if (status === 'denied' && typeof params.targetItemId === 'string') this.denied.set(params.targetItemId, rationale ?? '')
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
    const mcp = this.trackMcp(method, params)
    // Codex may run its subagents' threads in this process: their calls reach the session marked as theirs.
    const thread = typeof params.threadId === 'string' ? params.threadId : undefined
    const child = thread !== undefined && thread !== this.threadId ? thread : undefined
    if (child) {
      if (!this.threadId) return
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
          if (turn.cancelled) this.interrupt(turn.id)
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
        this.update({
          sessionUpdate: method === 'item/agentMessage/delta' ? 'agent_message_chunk' : 'agent_thought_chunk',
          messageId: clip(params.itemId, 512),
          content: { type: 'text', text: params.delta },
        })
        return
      }
      case 'item/commandExecution/outputDelta': {
        if (typeof params.delta !== 'string' || typeof params.itemId !== 'string') return
        const so = clip((this.output.get(params.itemId) ?? '') + params.delta, TOOL_TEXT_LIMIT)
        this.output.set(params.itemId, so)
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
        if (turn && count(total.inputTokens) !== undefined && count(total.outputTokens) !== undefined)
          turn.usage = { inputTokens: count(total.inputTokens)!, outputTokens: count(total.outputTokens)! }
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
  private async onRequest(method: string, params: Record<string, unknown>, id: RpcId): Promise<unknown> {
    if (method === 'mcpServer/elicitation/request' && isToolApproval(params)) return this.toolApproval(params, id)
    if (method !== 'item/commandExecution/requestApproval' && method !== 'item/fileChange/requestApproval')
      return this.handlers.request(method, { ...params, ...(this.threadId ? { sessionId: this.threadId } : {}) }, id)
    const command = method === 'item/commandExecution/requestApproval'
    const thread = typeof params.threadId === 'string' ? params.threadId : undefined
    const child = thread !== undefined && thread !== this.threadId ? thread : undefined
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
    if (chosen === 'accept' || chosen === 'decline') this.answered.add(itemId)
    if (chosen === 'accept' && command && params.kind !== 'writeStdin') {
      this.allowed.add(itemId)
      this.notRun.delete(itemId)
      // An accepted quiet command can run without item/started or any output. It belongs to the turn's stop either way.
      this.turn?.commands.add(itemId)
      if (child) this.turn?.threads.add(child)
      this.update(this.marked({ sessionUpdate: 'tool_call_update', toolCallId: itemId, status: 'in_progress' }, child))
    } else if (command && params.kind !== 'writeStdin') {
      // Declined or unanswered, it never runs, whether or not Codex reports it ended.
      this.notRun.add(itemId)
      this.commandEnded(itemId)
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
