/**
 * Claude Code driven through the official Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), with the person's own
 * `claude` as the executable. The runtime keeps speaking ACP; this wire answers its methods with one streaming `query()`
 * per session and turns the SDK's messages into ACP session updates. Mode, option, permission and session IDs, tool
 * titles, diffs, plans, questions and subagents are what `claude-agent-acp` sends, so a session looks and goes on alike
 * on either route.
 *
 * The SDK spawns `claude` through this wire's `spawnClaudeCodeProcess`: Latch's own process handling (`process.ts`), its
 * own process group, the environment the runtime built and nothing of the Host's. Claude's login is never read. When the
 * Host lets it (`store`, from `cliStore`), the wire reads Claude's own store through `claude-store.ts`, in a process with
 * the session's environment: the settings that shape the mode menu, its sessions to list, replay and delete, and the
 * forks of Latch's own sessions; without it, nothing of Claude's is read.
 */
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { redactKnownSecrets } from '@latch/core/node-kit'
import { clip, TOOL_TEXT_LIMIT, truncateUnits } from '../mapping.ts'
import { ClaudeStore, type ClaudeSettings } from '../claude-store.ts'
import { CAPTURE_BYTES } from '../history.ts'
import { claudeCompactionMetrics, claudeContextBreakdown } from '../context-telemetry.ts'
import {
  AUTH_STATUS_METHOD,
  availableCommand,
  type AvailableCommand,
  SESSION_COMMAND_LIMIT,
  FORK_METHOD,
  MCP_STATUS_METHOD,
  MCP_STATUS_UPDATE,
  QUOTA_READ_METHOD,
  RPC,
  RpcError,
  STEER_METHOD,
  addTurnTokens,
  type TurnTokens,
} from '../protocol.ts'
import { ELICITATION_METHOD } from '../questions.ts'
import { decide, normalizeChangeSet, OPTION, permissionOptions, type AskContext } from './claude-permissions.ts'
import {
  answeredInput,
  applyTaskResult,
  askedQuestions,
  changeFromResult,
  PLAN_TOOLS,
  questionForm,
  resultText,
  shellOutput,
  taskPlan,
  todoPlan,
  toolFacts,
  type TaskList,
} from './claude-tools.ts'
import { replayUpdates } from './claude-history.ts'
import { AgentProcess, ConnectionClosed, ConnectionStopping, isRecord, RequestTimeout, type ExitInfo, type SpawnSpec } from './process.ts'
import { ForkRefused, type AgentWire, type PromptContext, type WireHandlers, type WireModelRoute } from './types.ts'

/** The parts of the SDK this wire uses, so tests can drive it without the CLI. */
export interface ClaudeQuery extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>
  setPermissionMode(mode: string): Promise<void>
  setModel(model?: string): Promise<void>
  applyFlagSettings(settings: Record<string, unknown>): Promise<void>
  initializationResult(): Promise<unknown>
  supportedCommands(): Promise<unknown[]>
  getContextUsage(): Promise<unknown>
  stopTask(taskId: string): Promise<void>
  /** Each MCP server of the session and its state. */
  mcpServerStatus?(): Promise<unknown[]>
  /** Claude Code's experimental `get_usage` (SDK 0.3.322, not in its types): the plan's windows, asked of Claude itself. */
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(options: { skipBehaviors?: boolean }): Promise<unknown>
  close(): void
}

/** What `spawnClaudeCodeProcess` receives (the SDK's `SpawnOptions`). */
export interface ClaudeSpawnOptions {
  command: string
  args: string[]
  cwd?: string
  env: Record<string, string | undefined>
  signal: AbortSignal
}

export type ClaudeQueryFunction = (input: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => ClaudeQuery

let replaced: ClaudeQueryFunction | undefined

/** Tests only: the `query` every wire the runtime opens uses (`undefined` restores the SDK's). */
export function setClaudeQuery(next: ClaudeQueryFunction | undefined): void {
  replaced = next
}

/** The SDK's `query`, loaded on first use: a Host that never runs Claude directly never loads it. */
async function sdkQuery(): Promise<ClaudeQueryFunction> {
  if (replaced) return replaced
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  return sdk.query as unknown as ClaudeQueryFunction
}

/** Mode, model and effort options, by the adapter's IDs (`session-config-ids.js`, `session-mode.js`). */
const MODE = 'mode'
const MODEL = 'model'
const EFFORT = 'effort'
const DEFAULT_MODEL = 'default'
const DEFAULT_EFFORT = 'default'
/** Claude Code's permission modes as the adapter offers them, `auto` only for a model that supports it. */
const MODES = [
  { id: 'default', name: 'Manual', description: 'Always ask before making changes' },
  { id: 'acceptEdits', name: 'Accept edits', description: 'Automatically accept all file edits' },
  { id: 'plan', name: 'Plan', description: 'Create a plan before making changes' },
  { id: 'auto', name: 'Auto', description: 'Claude handles permission decisions' },
  { id: 'bypassPermissions', name: 'Bypass permissions', description: 'Accepts all permissions' },
] as const
const MODE_IDS = new Set<string>(MODES.map(mode => mode.id))
/** Read after each turn; a slow answer leaves the context use unknown rather than holding the turn open. */
const CONTEXT_TIMEOUT_MS = 2_000
const MAX_MODELS = 200
/** Tool uses and subagents one session remembers; the oldest are forgotten past this. */
const MAX_REMEMBERED = 2_000
/** What the SDK adds to the environment it is given, kept on the child; anything else not in the runtime's is dropped. */
const SDK_ENV = /^CLAUDE_(?:AGENT_SDK_|CODE_)/u
/** The tools that start a subagent. */
const AGENT_TOOLS = new Set(['Agent', 'Task'])
/** How long a session's start waits for Claude's settings; past it the session starts as if none were read. */
const SETTINGS_TIMEOUT_MS = 5_000
const SETTINGS_TTL_MS = 30_000
/** One page of `session/list`. */
const LIST_PAGE = 100
/** Claude Code's effort levels, lowest first: a cap in its settings (`maxEffortLevel`) leaves out those above it. */
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max']
/** Claude's MCP states, as Latch names them (`ownMcpStatus`). */
const MCP_STATES: Readonly<Record<string, string>> = {
  connected: 'ready',
  failed: 'failed',
  'needs-auth': 'needs-login',
  pending: 'starting',
  disabled: 'disabled',
}
/** The settings layers, as a person reads them. */
const LAYERS: Readonly<Record<string, string>> = {
  user: '用户设置',
  project: '项目设置',
  local: '项目本地设置',
  managed: '组织托管设置',
  flag: '启动参数',
}
/** The adapter's labels for a non-firstParty backend (`auth-status.js`). */
const EXTERNAL_PROVIDERS: Readonly<Record<string, string>> = {
  bedrock: 'AWS Bedrock',
  vertex: 'Google Vertex AI',
  foundry: 'Azure AI Foundry',
  anthropicAws: 'Anthropic on AWS',
  anthropicGoogleCloud: 'Anthropic on Google Cloud',
  mantle: 'Mantle',
}

const text = z.string()
const modelInfo = z.object({
  value: text.min(1).max(512),
  resolvedModel: text.max(512).optional().catch(undefined),
  displayName: text.max(1000).optional().catch(undefined),
  description: text.max(2000).optional().catch(undefined),
  supportsEffort: z.boolean().optional().catch(undefined),
  supportedEffortLevels: z.array(text.max(64)).max(16).optional().catch(undefined),
  supportsAutoMode: z.boolean().optional().catch(undefined),
})
type ModelInfo = z.infer<typeof modelInfo>
const initResult = z.object({
  models: z.array(z.unknown()).catch([]),
  commands: z.array(z.unknown()).catch([]),
  account: z.unknown().optional(),
})
const slashCommand = z.object({ name: text, description: text.optional().catch(undefined), argumentHint: text.optional().catch(undefined) })
type Commands = AvailableCommand[]
const count = z.number().nonnegative().finite()
const resultUsage = z.object({
  input_tokens: count.catch(0),
  output_tokens: count.catch(0),
  cache_read_input_tokens: count.nullish().catch(undefined),
  cache_creation_input_tokens: count.nullish().catch(undefined),
})
const contextUsage = z.object({
  totalTokens: count,
  maxTokens: count.optional().catch(undefined),
  model: text.max(512).optional().catch(undefined),
})
const promptParams = z.object({
  sessionId: text,
  prompt: z.array(
    z.object({
      type: text,
      text: text.optional(),
      data: text.optional(),
      mimeType: text.optional(),
      uri: text.optional(),
      resource: z.object({ uri: text.optional(), text: text.optional() }).optional(),
    }),
  ),
})
const steerParams = promptParams.extend({
  _meta: z
    .object({
      steering: z.object({ idleBehavior: z.literal('promptRequired').optional() }).optional(),
    })
    .passthrough()
    .optional(),
})
const optionParams = z.object({ sessionId: text, configId: text, value: text.max(1024) })
const forkParams = z.object({ sessionId: text, cwd: text, through: text.optional() })
const listParams = z.object({ cursor: text.max(64).nullish(), cwd: text.nullish() })
const mcpStatus = z.object({
  name: text.min(1).max(1024),
  status: text.max(64),
  scope: text.max(64).optional().catch(undefined),
  tools: z.array(z.unknown()).optional().catch(undefined),
})
const nameValue = z.array(z.object({ name: text, value: text }))
const mcpServer = z.union([
  z.object({ type: z.enum(['http', 'sse']), name: text.min(1), url: text, headers: nameValue.optional() }),
  z.object({
    type: z.literal('stdio').optional(),
    name: text.min(1),
    command: text,
    args: z.array(text).default([]),
    env: nameValue.optional(),
  }),
])
const sessionParams = z.object({
  sessionId: text.optional(),
  cwd: text,
  mcpServers: z.array(mcpServer).default([]),
  additionalDirectories: z.array(text).optional(),
  _meta: z.unknown().optional(),
})
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/** The definition's arguments: none, since the SDK writes every argument `claude` gets. */
export function claudeArgs(args: readonly string[]): string[] {
  if (args.length) throw new Error('经 Claude Agent SDK 直接连接时，参数由 Latch 与 SDK 设置，不能写在定义里')
  return []
}

/** The model row a model ID the CLI reports stands for: `default` when that is what it resolves to, else the row named. */
function rowFor(models: readonly ModelInfo[], reported: string | undefined): string | undefined {
  if (!reported) return undefined
  const plain = (value: string) => value.trim().toLowerCase()
  const fallback = models.find(item => item.value === DEFAULT_MODEL)
  if (fallback?.resolvedModel && plain(fallback.resolvedModel) === plain(reported)) return DEFAULT_MODEL
  return models.find(item => plain(item.value) === plain(reported) || (item.resolvedModel && plain(item.resolvedModel) === plain(reported)))
    ?.value
}

/** The login Claude reports at the start, as the adapter's `fromAccountInfo` names it: never the address or organization. */
function loginOf(account: unknown): { kind: string; label: string } | undefined {
  if (!isRecord(account)) return undefined
  const provider = typeof account.apiProvider === 'string' ? account.apiProvider : undefined
  const keySource = typeof account.apiKeySource === 'string' && account.apiKeySource ? account.apiKeySource : undefined
  const plan = typeof account.subscriptionType === 'string' && account.subscriptionType ? account.subscriptionType : undefined
  if (!keySource && !plan && (!provider || provider === 'firstParty')) return undefined
  if (provider === 'gateway') return { kind: 'gateway', label: 'Custom model gateway' }
  if (provider && provider !== 'firstParty') return { kind: 'external', label: EXTERNAL_PROVIDERS[provider] ?? clip(provider, 64) }
  if (keySource) return { kind: 'api_key', label: 'Anthropic API key' }
  const titled = plan!.replace(/\S+/gu, word => word.charAt(0).toUpperCase() + word.slice(1))
  return { kind: 'account', label: clip(/^claude(\s|$)/iu.test(plan!) ? titled : `Claude ${titled}`, 80) }
}

/**
 * What Claude's own settings do to a session that Latch cannot see in its approvals, as display-only notes: the rules
 * that let calls through without asking and where each is written, hooks, an organization's policy, and the mode the
 * settings name, which Latch never starts in (it starts every session asking).
 */
function settingsNotes(settings: ClaudeSettings | undefined): string[] {
  if (!settings) return []
  const notes: string[] = []
  if (settings.allow.length) {
    const shown = settings.allow.slice(0, 8).map(item => `${item.rule}（${LAYERS[item.source] ?? item.source}）`)
    const more = settings.allow.length > shown.length ? ` 等 ${settings.allow.length} 条` : ''
    notes.push(`Claude 设置里自动允许：${shown.join('、')}${more}`)
  }
  if (settings.hooks) notes.push('Claude 设置里有 hooks，它们先于 Latch 运行')
  if (settings.managed) notes.push('这台电脑有 Claude 的组织托管设置，优先于你的设置')
  if (settings.startMode && settings.startMode !== 'default')
    notes.push(`Claude 设置的默认模式是 ${settings.startMode}；Latch 仍从「询问」开始`)
  if (settings.disableBypass) notes.push('Claude 设置禁用了「不再询问」模式')
  if (settings.disableAuto) notes.push('Claude 设置禁用了自动模式')
  return notes
}

/**
 * What in Claude's settings may keep a session on Latch's model service from working as it should, said before its
 * first turn: an organization's key helper or model list (they rank above the settings Latch passes), and an effort cap.
 */
export function routeWarnings(settings: ClaudeSettings | undefined, route: WireModelRoute | undefined): string[] {
  if (!settings) return []
  const warnings: string[] = []
  if (route) {
    if (settings.managedKeyHelper) warnings.push('组织托管设置指定了密钥脚本（apiKeyHelper），经 Latch 的模型服务可能不生效')
    if (settings.managedModels && !settings.managedModels.includes(route.model))
      warnings.push(`组织托管设置限定了可用模型，${clip(route.model, 200)} 不在其中，Claude 可能拒绝`)
  } else if (settings.ownEndpoint) warnings.push('Claude 设置里配置了自己的模型端点（ANTHROPIC_BASE_URL），这个会话的请求发往那里')
  if (settings.configDirInSettings) warnings.push('Claude 设置里写了 CLAUDE_CONFIG_DIR，Latch 读到的记录可能不是 Claude 正在用的那份')
  return warnings
}

/** Input the SDK reads as the session's prompts; `end` lets `claude` finish once it has read the last one. */
class Inbox implements AsyncIterable<unknown> {
  private items: unknown[] = []
  private waiting?: (result: IteratorResult<unknown>) => void
  private ended = false

  push(item: unknown): void {
    if (this.ended) return
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = undefined
      resolve({ value: item, done: false })
    } else this.items.push(item)
  }

  end(): void {
    this.ended = true
    this.waiting?.({ value: undefined, done: true })
    this.waiting = undefined
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false })
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise(resolve => {
          this.waiting = resolve
        })
      },
      return: () => {
        this.end()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}

/** The prompt being run, answered once its result came and, after a cancel, once `claude` acknowledged the interrupt. */
interface Turn {
  uuid: string
  uuids: Set<string>
  pendingSteers?: Set<string>
  usage?: TurnTokens
  messageId?: string
  resolve(result: unknown): void
  reject(error: Error): void
  cancelled: boolean
  /** The interrupt was acknowledged, or failed: either way nothing more waits on it. */
  interrupted?: boolean
  /** The turn's result, held until an interrupt sent for it was acknowledged, or until an unstamped steered turn goes idle. */
  ended?: Record<string, unknown>
  /** The error Claude reported for the cycle `ended` came from, on an unstamped steered turn. */
  endedErrorKind?: string
  /** A choice that stops the turn (keep planning) was made: it ends as cancelled, as on the adapter. */
  stopped?: boolean
  /** What the last reply said went wrong (`SDKAssistantMessageError`). */
  errorKind?: string
}

function promptContent(blocks: z.infer<typeof promptParams>['prompt']): unknown[] {
  const content: unknown[] = []
  for (const block of blocks) {
    if (block.type === 'text' && block.text !== undefined) content.push({ type: 'text', text: block.text })
    else if (block.type === 'image' && block.data && block.mimeType)
      content.push({ type: 'image', source: { type: 'base64', media_type: block.mimeType, data: block.data } })
    else if (block.type === 'resource' && block.resource?.text !== undefined)
      content.push({ type: 'text', text: `<context ref="${block.resource.uri ?? ''}">\n${block.resource.text}\n</context>` })
    else if (block.type === 'resource_link' && block.uri) content.push({ type: 'text', text: block.uri })
    else throw new RpcError(RPC.invalidParams, `Claude takes no ${clip(block.type, 64)} content here`)
  }
  return content
}

function readTurnTokens(raw: unknown): TurnTokens | undefined {
  const read = resultUsage.safeParse(raw)
  if (!read.success) return undefined
  return {
    // Claude's input leaves out the cache reads and writes it counts beside it (`inputExcludesCache`).
    inputTokens: read.data.input_tokens,
    outputTokens: read.data.output_tokens,
    ...(read.data.cache_read_input_tokens != null ? { cachedReadTokens: read.data.cache_read_input_tokens } : {}),
    ...(read.data.cache_creation_input_tokens != null ? { cachedWriteTokens: read.data.cache_creation_input_tokens } : {}),
  }
}

/** A subagent Claude started with an Agent call, shown as a child session the way the adapter's RFD form shows it. */
interface Child {
  sessionId: string
  /** The session whose Agent call started it: the root, or another child. */
  parentSessionId: string
  /** Claude's task ID (`task_started`), which `stopTask` takes. */
  taskId?: string
  ended?: boolean
}

/** A tool use as Claude reported it, kept until its result: what it is, and which session shows it. */
interface ToolUse {
  name: string
  input: unknown
  sessionId: string
}

/** A session opened only to read something (`mcp`: its MCP servers; `usage`: the plan's limits), saved nowhere. */
type Probe = 'mcp' | 'usage'

function askUsage(session: Session): Promise<unknown> {
  const ask = session.query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
  if (!ask) return Promise.reject(new RpcError(RPC.methodNotFound, 'Method not found'))
  return ask.call(session.query, { skipBehaviors: true })
}

/** One session's `query()` and the process the SDK started for it. */
interface Session {
  id: string
  cwd: string
  query: ClaudeQuery
  inbox: Inbox
  abort: AbortController
  process?: AgentProcess
  models: ModelInfo[]
  model: string
  mode: string
  /** The mode before Claude entered plan mode, which its plan offers to go back to. */
  prePlanMode?: string
  effort: string
  commands?: Commands
  terminalCommands: Set<string>
  probe?: Probe
  prompted: boolean
  /** Message IDs whose text or thinking arrived in pieces, so the whole message adds nothing. */
  streamed: Map<string, { text: boolean; thinking: boolean }>
  /** The top-level message `claude` is streaming. */
  replying?: string
  /** Tool calls already reported, by ID. */
  toolUses: Map<string, ToolUse>
  /** Subagents by the Agent call that started them, and by Claude's task ID. */
  children: Map<string, Child>
  tasksById: Map<string, Child>
  /** Claude's task list (Task* tools), sent whole as the session's plan. */
  tasks: TaskList
  /** The last rate limit Claude reported, which a turn refused for the limit carries. */
  rateLimit?: unknown
  /** `claude` answered the start; before that its end is the opening's failure, not the wire's. */
  opened: boolean
  /** Closed by Latch (`session/close`, another session): its process ending is not the wire's. */
  closing: boolean
  /** What Claude's settings said as the session started; undefined when they were not read. */
  settings?: ClaudeSettings
  /** Warnings said before the first turn, once. */
  warnings: string[]
  /** The MCP servers Latch gave the session, which are not Claude's own. */
  given: Set<string>
  /** Prompt IDs sent on this session: one is never sent twice. */
  sent: Map<string, true>
  /** Permission or question callbacks currently awaiting the person's answer. */
  openAsks: number
  contextReads?: number
  contextReported?: number
  /** A query spanning a compaction cannot be attributed to either side of that boundary. */
  contextGeneration?: number
}

const remember = <K, V>(map: Map<K, V>, key: K, value: V) => {
  map.delete(key)
  map.set(key, value)
  if (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value as K)
}

/** The SDK's view of a process Latch started (`SpawnedProcess`): its streams, its end, and signals to its whole group. */
class SpawnedClaude extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  readonly stdin
  readonly stdout

  constructor(private readonly child: AgentProcess) {
    super()
    ;({ stdin: this.stdin, stdout: this.stdout } = child.streams)
    void child.exited.then(info => {
      this.exitCode = info.code
      this.signalCode = info.signal
      if (info.reason === 'spawn') this.emit('error', new Error(info.error ?? 'spawn failed'))
      else this.emit('exit', info.code, info.signal)
    })
  }

  kill(signal: NodeJS.Signals): boolean {
    this.killed = true
    this.child.signal(signal)
    return true
  }
}

export interface ClaudeWireDeps {
  query?: ClaudeQueryFunction
  /**
   * The Host lets this wire read Claude's own store (`ServerOptions.cliStore`): its settings, its sessions and their
   * forks and deletion. Without it the wire advertises none of that and reads nothing of Claude's.
   */
  store?: boolean
}

export class ClaudeWire implements AgentWire {
  readonly exited: Promise<ExitInfo>
  private resolveExited!: (info: ExitInfo) => void
  private info?: ExitInfo
  private stopReason?: 'stop' | 'kill'
  private session?: Session
  private turn?: Turn
  private lastStderr = ''
  /** The client shows form questions (`clientCapabilities.elicitation.form`): Claude's questions are put to the person. */
  private asks = false
  private lastLogin?: string
  /** Claude's own store, when the Host lets this wire read it. */
  private readonly store?: ClaudeStore
  private settingsRead?: { cwd: string; at: number; read: Promise<ClaudeSettings | undefined> }

  private constructor(
    private readonly spec: SpawnSpec,
    private readonly handlers: WireHandlers,
    private readonly route: WireModelRoute | undefined,
    private readonly deps: ClaudeWireDeps,
  ) {
    claudeArgs(spec.args)
    if (deps.store) this.store = new ClaudeStore(spec.env)
    this.exited = new Promise(resolve => {
      this.resolveExited = resolve
    })
  }

  /** Throws for arguments the definition must not set; `claude` itself starts with the first session. */
  static spawn(spec: SpawnSpec, handlers: WireHandlers, route?: WireModelRoute, deps: ClaudeWireDeps = {}): ClaudeWire {
    return new ClaudeWire(spec, handlers, route, deps)
  }

  get closed(): boolean {
    return this.info !== undefined
  }
  get stopping(): boolean {
    return this.info !== undefined || this.stopReason !== undefined
  }

  /** It forks Claude's own record of a session (`FORK_METHOD`), only when it may read and write Claude's store. */
  get forks(): true | undefined {
    return this.store ? true : undefined
  }

  async request(
    method: string,
    params: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
    onResult?: (result: unknown) => void,
    context?: PromptContext,
  ): Promise<unknown> {
    if (this.info) throw new ConnectionClosed(this.info)
    if (this.stopping) throw new ConnectionStopping()
    if (signal?.aborted) throw new RpcError(RPC.cancelled, 'Request cancelled')
    switch (method) {
      case 'initialize': {
        const client = isRecord(params) && isRecord(params.clientCapabilities) ? params.clientCapabilities : {}
        this.asks = isRecord(client.elicitation) && client.elicitation.form != null
        const store = this.store !== undefined
        return {
          protocolVersion: 1,
          agentInfo: { name: 'claude-code' },
          agentCapabilities: {
            loadSession: store,
            promptCapabilities: { image: true, embeddedContext: true },
            sessionCapabilities: { resume: {}, close: {}, ...(store ? { list: {}, delete: {} } : {}) },
            _meta: { authStatus: {} },
          },
          _meta: { steering: { supported: true, attachments: true } },
        }
      }
      case 'session/new':
        return this.bounded(this.open(undefined, params), method, timeoutMs, signal)
      case 'session/resume': {
        const id = sessionParams.safeParse(params).data?.sessionId
        if (!id || !UUID.test(id)) throw new RpcError(RPC.notFound, 'Session not found')
        return this.bounded(this.open(id, params), method, timeoutMs, signal)
      }
      case 'session/load':
        return this.bounded(this.load(params, signal), method, timeoutMs, signal)
      case 'session/list':
        return this.bounded(this.list(params, signal), method, timeoutMs, signal)
      case 'session/delete':
        return this.bounded(this.remove(params, signal), method, timeoutMs, signal)
      case FORK_METHOD:
        return this.bounded(this.fork(params, signal), method, timeoutMs, signal)
      case QUOTA_READ_METHOD:
        return this.bounded(this.usage(), method, timeoutMs, signal)
      case MCP_STATUS_METHOD:
        return this.bounded(this.mcpStatus(params), method, timeoutMs, signal)
      case 'session/close': {
        const id = isRecord(params) ? params.sessionId : undefined
        if (this.session && this.session.id === id) await this.closeSession(this.session)
        return {}
      }
      case 'session/prompt':
        return this.prompt(params, context)
      case STEER_METHOD:
        return this.bounded(this.steer(params, onResult), method, timeoutMs, signal)
      case 'session/set_config_option':
        return this.bounded(this.setOption(params), method, timeoutMs, signal)
      default:
        throw new RpcError(RPC.methodNotFound, `Method not found: ${clip(method, 200)}`)
    }
  }

  notify(method: string, params: unknown): void {
    const session = this.session
    if (method !== 'session/cancel' || !session) return
    const target = isRecord(params) ? params.sessionId : undefined
    if (target !== session.id) {
      // A subagent stopped alone: Claude's own `stopTask`; its Agent call's result then says it ended.
      const child = [...session.children.values()].find(item => item.sessionId === target)
      if (child?.taskId && !child.ended) void session.query.stopTask(child.taskId).catch(() => {})
      return
    }
    const turn = this.turn
    if (!turn || turn.cancelled) return
    turn.cancelled = true
    // Settled only once `claude` has acknowledged the interrupt and ended the turn: until then it may still be working.
    session.query.interrupt().then(
      () => this.interrupted(turn),
      () => this.interrupted(turn),
    )
  }

  async stop(reason: 'stop' | 'kill', graceMs: number, cause?: string): Promise<ExitInfo> {
    if (this.info) return this.info
    this.stopReason ??= reason
    const session = this.session
    if (session?.process) {
      session.inbox.end()
      const info = await session.process.stop(reason, graceMs, cause)
      session.query.close()
      return this.finish(info)
    }
    session?.query.close()
    return this.finish({ code: null, signal: null, reason, ...(cause ? { cause } : {}), stderr: this.lastStderr })
  }

  stderrTail(limit?: number): string {
    return this.session?.process?.stderrTail(limit) ?? clip(this.lastStderr, limit ?? 600)
  }

  /** A request the runtime may give up on: a timeout or its signal withdraws it, and what it started goes on. */
  private bounded<T>(work: Promise<T>, method: string, timeoutMs?: number, signal?: AbortSignal): Promise<T> {
    if (!timeoutMs && !signal) return work
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined
      const done = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = () => {
        done()
        reject(new RpcError(RPC.cancelled, 'Request cancelled'))
      }
      if (timeoutMs) {
        timer = setTimeout(() => {
          done()
          reject(new RequestTimeout(method))
        }, timeoutMs)
        timer.unref()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      work.then(
        value => {
          done()
          resolve(value)
        },
        (error: unknown) => {
          done()
          reject(error)
        },
      )
    })
  }

  private finish(info: ExitInfo): ExitInfo {
    if (this.info) return this.info
    this.info = info
    const closed = new ConnectionClosed(info)
    const turn = this.turn
    this.turn = undefined
    turn?.reject(closed)
    this.resolveExited(info)
    this.handlers.exit(info)
    return info
  }

  /** The environment `claude` gets: the runtime's, plus only the markers the SDK adds of its own. */
  private childEnv(given: Record<string, string | undefined>): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [name, value] of Object.entries(given)) {
      const own = this.spec.env[name]
      if (own !== undefined) env[name] = own
      else if (SDK_ENV.test(name) && typeof value === 'string') env[name] = value
    }
    return env
  }

  /** The SDK's `spawnClaudeCodeProcess`: `claude` as Latch starts every agent, in its own process group. */
  private spawnFor(session: { process?: AgentProcess }, closed: (info: ExitInfo) => void) {
    return (options: ClaudeSpawnOptions) => {
      if (this.stopping) throw new ConnectionStopping()
      const child = AgentProcess.spawn(
        { ...this.spec, command: options.command, args: options.args, cwd: this.spec.cwd, env: this.childEnv(options.env) },
        { closed },
      )
      session.process = child
      // The SDK aborts this once it has closed stdin and waited; whatever is left of the group ends then.
      options.signal.addEventListener('abort', () => void child.stop('kill', 0), { once: true })
      return new SpawnedClaude(child)
    }
  }

  /** The options of every `query()`: what `claude-agent-acp` passes, less what only the adapter itself uses. */
  private queryOptions(
    resume: string | undefined,
    id: string,
    parsed: z.infer<typeof sessionParams>,
    session: Partial<Session>,
    abort: AbortController,
    claudeSettings: ClaudeSettings | undefined,
    probe: Probe | undefined,
  ) {
    const mcpServers: Record<string, unknown> = {}
    for (const server of parsed.mcpServers) {
      mcpServers[server.name] =
        'url' in server
          ? {
              type: server.type,
              url: server.url,
              ...(server.headers?.length ? { headers: Object.fromEntries(server.headers.map(item => [item.name, item.value])) } : {}),
            }
          : {
              type: 'stdio',
              command: server.command,
              args: server.args,
              ...(server.env?.length ? { env: Object.fromEntries(server.env.map(item => [item.name, item.value])) } : {}),
            }
    }
    // Only the gateway's settings ride a session's `_meta`: the models a route offers, as the adapter receives them.
    const meta =
      isRecord(parsed._meta) && isRecord(parsed._meta.claudeCode) && isRecord(parsed._meta.claudeCode.options)
        ? parsed._meta.claudeCode.options
        : {}
    const settings = isRecord(meta.settings) ? meta.settings : undefined
    return {
      cwd: parsed.cwd,
      // The runtime's environment, never the Host's: the SDK otherwise starts from `process.env`. Claude says when a turn
      // is over (`session_state_changed`), as it does for the adapter.
      env: { ...this.spec.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
      // The person's own; no `executableArgs`, which the SDK puts before the native binary's own arguments too.
      pathToClaudeCodeExecutable: this.spec.command,
      spawnClaudeCodeProcess: this.spawnFor(session, info => this.onProcessExit(session as Session, info)),
      abortController: abort,
      // The person's settings, CLAUDE.md, skills, hooks, plugins and MCP servers, as in a terminal (and the adapter).
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      tools: { type: 'preset', preset: 'claude_code' },
      // As the adapter: Claude's questions only to a client that shows forms; without one the tool is off.
      ...(this.asks ? { onElicitation: this.onElicitation(session as Session) } : { disallowedTools: ['AskUserQuestion'] }),
      mcpServers,
      // A session opened only for the plan's limits starts none of the person's hooks or MCP servers.
      ...(probe === 'usage' ? { settings: { ...settings, disableAllHooks: true }, strictMcpConfig: true } : settings ? { settings } : {}),
      includePartialMessages: true,
      // Claude Code's own default; the runtime sets the mode it recorded for the session before each turn.
      permissionMode: 'default',
      // As the adapter: switching to it later needs the flag at start; root outside a sandbox is refused by the CLI, and
      // settings that disable the mode leave it off.
      allowDangerouslySkipPermissions: process.getuid?.() !== 0 && claudeSettings?.disableBypass !== true,
      canUseTool: (tool: string, input: Record<string, unknown>, context: AskOptions) =>
        this.canUseTool(session as Session, tool, input, context),
      ...(parsed.additionalDirectories?.length ? { additionalDirectories: parsed.additionalDirectories } : {}),
      // A session opened only to read what it offers leaves no transcript behind.
      ...(probe ? { persistSession: false } : {}),
      ...(resume ? { resume } : { sessionId: id }),
    }
  }

  /**
   * Claude's settings for a session in `cwd`, when the wire may read them, read again after a short while; a read that
   * fails or is slow says nothing.
   */
  private readSettings(cwd: string): Promise<ClaudeSettings | undefined> {
    if (!this.store || !cwd.startsWith('/')) return Promise.resolve(undefined)
    const held = this.settingsRead
    if (held && held.cwd === cwd && Date.now() - held.at < SETTINGS_TTL_MS) return held.read
    const read = this.withTimeout(this.store.settings(cwd), SETTINGS_TIMEOUT_MS).catch(() => undefined)
    this.settingsRead = { cwd, at: Date.now(), read }
    return read
  }

  /**
   * Before a session is resumed: whether Claude still has its record. Claude deletes a session's transcript once it has
   * been idle longer than `cleanupPeriodDays` (30 by default), so a long-idle session says that, instead of starting
   * `claude` to be told it found nothing. A read that fails says nothing either way.
   */
  private async assertRecord(id: string, cwd: string, settings: ClaudeSettings | undefined): Promise<void> {
    if (!this.store) return
    const found = await this.withTimeout(this.store.info(id, cwd), SETTINGS_TIMEOUT_MS).catch(() => undefined)
    if (found?.exists !== false) return
    const days = settings?.cleanupPeriodDays ?? 30
    throw new RpcError(RPC.notFound, 'Session not found', {
      lostReason: `Claude 的记录里已经没有这个会话（Claude 会删除超过 ${days} 天未用的会话）`,
    })
  }

  private async open(resume: string | undefined, params: unknown, probe?: Probe): Promise<unknown> {
    const parsed = sessionParams.safeParse(params)
    if (!parsed.success) throw new RpcError(RPC.invalidParams, 'Invalid params')
    if (this.turn) throw new RpcError(RPC.internal, 'A turn is already running')
    // One `claude` per session: another session's ends first.
    if (this.session) await this.closeSession(this.session)
    const settings = await this.readSettings(parsed.data.cwd)
    if (resume) await this.assertRecord(resume, parsed.data.cwd, settings)
    const id = resume ?? randomUUID()
    const inbox = new Inbox()
    const abort = new AbortController()
    const partial: Partial<Session> = {}
    const start = this.deps.query ?? (await sdkQuery())
    // The SDK writes its version into the Host's own environment when a query starts (0.3.322); put back what was there.
    const marker = process.env.CLAUDE_AGENT_SDK_VERSION
    let query: ClaudeQuery
    try {
      query = start({
        prompt: inbox,
        options: this.queryOptions(resume, id, parsed.data, partial, abort, settings, probe),
      })
    } finally {
      if (marker === undefined) delete process.env.CLAUDE_AGENT_SDK_VERSION
      else process.env.CLAUDE_AGENT_SDK_VERSION = marker
    }
    const session: Session = Object.assign(partial, {
      id,
      cwd: parsed.data.cwd,
      query,
      inbox,
      abort,
      models: [] as ModelInfo[],
      model: DEFAULT_MODEL,
      mode: 'default',
      effort: DEFAULT_EFFORT,
      terminalCommands: new Set<string>(),
      ...(probe ? { probe } : {}),
      prompted: false,
      streamed: new Map<string, { text: boolean; thinking: boolean }>(),
      toolUses: new Map<string, ToolUse>(),
      children: new Map<string, Child>(),
      tasksById: new Map<string, Child>(),
      tasks: new Map() as TaskList,
      closing: false,
      opened: false,
      ...(settings ? { settings } : {}),
      warnings: routeWarnings(settings, this.route),
      given: new Set(parsed.data.mcpServers.map(server => server.name)),
      sent: new Map<string, true>(),
      openAsks: 0,
    })
    this.session = session
    void this.consume(session)
    let init: z.infer<typeof initResult>
    try {
      init = initResult.parse(await query.initializationResult())
    } catch (error) {
      await this.closeSession(session)
      const said = error instanceof Error ? error.message : String(error)
      if (resume && /No conversation found|Query closed before response/u.test(said)) throw new RpcError(RPC.notFound, 'Session not found')
      if (this.info) throw new ConnectionClosed(this.info)
      const tail = this.lastStderr ? `\n${this.lastStderr}` : ''
      throw new RpcError(RPC.internal, clip(redactKnownSecrets(this.spec.redact(`${said}${tail}`)), 2000))
    }
    session.opened = true
    session.models = init.models
      .flatMap(item => {
        const read = modelInfo.safeParse(item)
        return read.success ? [read.data] : []
      })
      .slice(0, MAX_MODELS)
    // A push from the SDK stream can arrive before its older initialize response.
    if (session.commands === undefined) this.reportCommands(session, init.commands)
    this.reportLogin(this.route ? { kind: 'gateway', label: 'Custom model gateway' } : loginOf(init.account))
    // What the session runs now: the route's model, or what the CLI reports (a resumed session keeps its own).
    const used = this.route?.model ?? (await this.contextModel(session))
    session.model =
      rowFor(session.models, used)
      ?? (this.route?.model && session.models.some(item => item.value === this.route!.model) ? this.route.model : DEFAULT_MODEL)
    const notes = settingsNotes(settings)
    const perModel = this.perModelOptions(session)
    return {
      sessionId: id,
      configOptions: this.options(session),
      ...(notes.length || perModel.length
        ? {
            _meta: {
              latch: {
                ...(notes.length ? { permissionNotes: notes } : {}),
                ...(perModel.length ? { perModel } : {}),
              },
            },
          }
        : {}),
    }
  }

  /** The login, pushed as the adapter pushes it (`_auth/status_update`), only when it changed. */
  private reportLogin(login: { kind: string; label: string } | undefined): void {
    if (!login) return
    const key = JSON.stringify(login)
    if (key === this.lastLogin) return
    this.lastLogin = key
    try {
      this.handlers.notification(AUTH_STATUS_METHOD, { authStatus: login })
    } catch {
      // A report the runtime cannot take changes nothing here.
    }
  }

  private async contextModel(session: Session): Promise<string | undefined> {
    const read = await this.withTimeout(session.query.getContextUsage(), CONTEXT_TIMEOUT_MS).catch(() => undefined)
    return contextUsage.safeParse(read).data?.model
  }

  private withTimeout<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
    let timer: NodeJS.Timeout | undefined
    return Promise.race([
      work.finally(() => clearTimeout(timer)),
      new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), ms)
        timer.unref()
      }),
    ])
  }

  private reportCommands(session: Session, listed: readonly unknown[], namesOnly = false): void {
    if (session.probe || this.session !== session) return
    const commands: Commands = []
    // system/init lists names only. Keep descriptions and argument hints from the SDK's detailed list.
    const previous = namesOnly ? new Map(session.commands?.map(command => [command.name, command])) : undefined
    for (const item of listed) {
      const read = slashCommand.safeParse(namesOnly ? { name: item } : item)
      if (!read.success) continue
      const name = read.data.name.replace(/^\//u, '')
      if (session.terminalCommands.has(name)) continue
      const parsed = availableCommand.safeParse({
        name,
        // Redacted before the cut: a credential split at the boundary no longer matches its pattern.
        ...(read.data.description ? { description: truncateUnits(redactKnownSecrets(read.data.description), 1000) } : {}),
        ...(read.data.argumentHint ? { input: { hint: truncateUnits(redactKnownSecrets(read.data.argumentHint), 500) } } : {}),
      })
      if (parsed.success) commands.push(previous?.get(name) ?? parsed.data)
      if (commands.length === SESSION_COMMAND_LIMIT) break
    }
    if (isDeepStrictEqual(session.commands, commands)) return
    session.commands = commands
    this.update(session, { sessionUpdate: 'available_commands_update', availableCommands: commands })
  }

  /** Ends a session's `query()` and waits for its process; its end is Latch's, not a crash. */
  private async closeSession(session: Session): Promise<void> {
    session.closing = true
    if (this.session === session) this.session = undefined
    session.inbox.end()
    session.query.close()
    await session.process?.stop('stop', 2_000)
  }

  /**
   * The modes Claude would take now: `auto` only for a model that supports it, and neither `auto` nor
   * `bypassPermissions` where Claude's settings disable them (as the adapter offers them). The mode in force stays listed.
   */
  private availableModes(session: Session): string[] {
    const current = session.models.find(item => item.value === session.model)
    const off = (id: string) =>
      (id === 'auto' && (current?.supportsAutoMode !== true || session.settings?.disableAuto === true))
      || (id === 'bypassPermissions' && session.settings?.disableBypass === true)
    return MODES.filter(mode => !off(mode.id) || session.mode === mode.id).map(mode => mode.id)
  }

  /** The effort levels a model offers, less those above a cap in Claude's settings (`maxEffortLevel`). */
  private effortLevels(session: Session, model: ModelInfo | undefined): string[] {
    const levels = model?.supportsEffort ? (model.supportedEffortLevels ?? []) : []
    const cap = session.settings?.maxEffortLevel ? EFFORT_ORDER.indexOf(session.settings.maxEffortLevel) : -1
    return cap < 0 ? levels : levels.filter(level => EFFORT_ORDER.indexOf(level) <= cap)
  }

  private effortOption(session: Session, model: ModelInfo | undefined): Record<string, unknown> | undefined {
    const levels = this.effortLevels(session, model)
    if (!levels.length) return undefined
    return {
      type: 'select',
      id: EFFORT,
      category: 'thought_level',
      name: 'Effort',
      currentValue: levels.includes(session.effort) ? session.effort : DEFAULT_EFFORT,
      options: [
        { value: DEFAULT_EFFORT, name: 'Default' },
        ...levels.map(level => ({ value: level, name: level.charAt(0).toUpperCase() + level.slice(1) })),
      ],
    }
  }

  private perModelOptions(session: Session): Array<{ model: string; options: unknown[] }> {
    return session.models.map(model => {
      const effort = this.effortOption(session, model)
      return { model: model.value, options: effort ? [effort] : [] }
    })
  }

  private options(session: Session): unknown[] {
    const current = session.models.find(item => item.value === session.model)
    const options: unknown[] = []
    const available = new Set(this.availableModes(session))
    options.push({
      type: 'select',
      id: MODE,
      category: 'mode',
      name: 'Mode',
      currentValue: session.mode,
      options: MODES.filter(mode => available.has(mode.id)).map(mode => ({
        value: mode.id,
        name: mode.name,
        description: mode.description,
      })),
    })
    const models = session.models.map(item => ({
      value: item.value,
      name: item.displayName || item.value,
      ...(item.description ? { description: item.description } : {}),
    }))
    if (!models.some(item => item.value === session.model)) models.push({ value: session.model, name: session.model })
    options.push({ type: 'select', id: MODEL, category: 'model', name: 'Model', currentValue: session.model, options: models })
    const effort = this.effortOption(session, current)
    if (effort) options.push(effort)
    return options
  }

  /** The mode Claude is in now, reported to the runtime when it differs from what was last said. */
  private modeIs(session: Session, mode: string): void {
    if (!MODE_IDS.has(mode) || mode === session.mode) return
    if (mode === 'plan') session.prePlanMode = session.mode
    else session.prePlanMode = undefined
    session.mode = mode
    this.update(session, { sessionUpdate: 'config_option_update', configOptions: this.options(session) })
  }

  private assertSession(sessionId: string): Session {
    const session = this.session
    if (!session || session.id !== sessionId) throw new RpcError(RPC.notFound, 'Session not found')
    return session
  }

  private async setOption(params: unknown): Promise<unknown> {
    const parsed = optionParams.safeParse(params)
    if (!parsed.success) throw new RpcError(RPC.invalidParams, 'Invalid params')
    const session = this.assertSession(parsed.data.sessionId)
    const { configId, value } = parsed.data
    if (configId === MODE) {
      if (!MODE_IDS.has(value)) throw new RpcError(RPC.invalidParams, 'Unknown mode')
      if (!this.availableModes(session).includes(value)) throw new RpcError(RPC.invalidParams, 'Claude 的设置不允许这个模式')
      // Claude Code answers the control request once the mode is in force; a mode it refuses fails here.
      await session.query.setPermissionMode(value)
      session.prePlanMode = value === 'plan' && session.mode !== 'plan' ? session.mode : undefined
      session.mode = value
    } else if (configId === MODEL) {
      if (this.route && !this.route.models.includes(value)) throw new RpcError(RPC.invalidParams, 'Unknown model')
      await session.query.setModel(value === DEFAULT_MODEL ? undefined : value)
      session.model = value
      // Effort is the model's own: what one model takes another may not.
      const levels = session.models.find(item => item.value === value)?.supportedEffortLevels ?? []
      if (session.effort !== DEFAULT_EFFORT && !levels.includes(session.effort)) session.effort = DEFAULT_EFFORT
    } else if (configId === EFFORT) {
      // As the adapter: the flag layer's `effortLevel`, cleared with null.
      await session.query.applyFlagSettings({ effortLevel: value === DEFAULT_EFFORT ? null : value })
      session.effort = value
    } else throw new RpcError(RPC.invalidParams, 'Unknown option')
    return { configOptions: this.options(session) }
  }

  private async prompt(params: unknown, context?: PromptContext): Promise<unknown> {
    const parsed = promptParams.safeParse(params)
    if (!parsed.success) throw new RpcError(RPC.invalidParams, 'Invalid params')
    const session = this.assertSession(parsed.data.sessionId)
    if (this.turn) throw new RpcError(RPC.internal, 'A turn is already running')
    const content = promptContent(parsed.data.prompt)
    if (!session.prompted) {
      session.prompted = true
      for (const title of session.warnings.splice(0)) this.update(session, { sessionUpdate: 'notice', severity: 'warning', title })
      void this.reportMcp(session)
    }
    // Latch's own message ID marks the turn in Claude's transcript, so a later fork finds it (`forkSession`'s
    // `upToMessageId`). Never the same ID twice on one session: a second send gets one of its own.
    const mine = context?.messageId
    const uuid = mine && UUID.test(mine) && !session.sent.has(mine) ? mine : randomUUID()
    remember(session.sent, uuid, true)
    const done = new Promise<unknown>((resolve, reject) => {
      this.turn = { uuid, uuids: new Set([uuid]), messageId: mine, resolve, reject, cancelled: false }
    })
    done.catch(() => {})
    session.inbox.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, uuid })
    return done
  }

  /**
   * Adds a message to the running turn, as `claude-agent-acp` does: `priority: 'now'` interrupts the current model cycle
   * to take it, except while a permission or question waits on the person (`priority: 'later'`), where `now` would abort
   * the open callback in the SDK. When no turn is running, returns `promptRequired` without pushing input.
   */
  private steer(params: unknown, onResult?: (result: unknown) => void): Promise<unknown> {
    const parsed = steerParams.safeParse(params)
    if (!parsed.success) throw new RpcError(RPC.invalidParams, 'Invalid params')
    const session = this.assertSession(parsed.data.sessionId)
    const content = promptContent(parsed.data.prompt)
    const turn = this.turn
    if (!turn || turn.cancelled || turn.stopped) return Promise.resolve({ outcome: 'promptRequired' })
    const uuid = randomUUID()
    remember(session.sent, uuid, true)
    turn.uuids.add(uuid)
    ;(turn.pendingSteers ??= new Set()).add(uuid)
    turn.ended = undefined
    const answer = { outcome: 'injected' as const }
    onResult?.(answer)
    session.inbox.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      uuid,
      priority: session.openAsks > 0 ? 'later' : 'now',
    })
    return Promise.resolve(answer)
  }

  private interrupted(turn: Turn): void {
    turn.interrupted = true
    if (turn.ended && this.turn === turn) void this.settle(turn, turn.ended)
  }

  /** An update on the session or one of its subagents' sessions, while the session is the wire's. */
  private emit(session: Session, sessionId: string, update: Record<string, unknown> & { sessionUpdate: string }): void {
    if (this.session !== session) return
    try {
      this.handlers.notification('session/update', { sessionId, update })
    } catch {
      // A notification the runtime cannot take changes nothing here.
    }
  }

  private update(session: Session, update: Record<string, unknown> & { sessionUpdate: string }): void {
    this.emit(session, session.id, update)
  }

  private async consume(session: Session): Promise<void> {
    try {
      for await (const message of session.query) {
        if (isRecord(message)) {
          try {
            this.onMessage(session, message)
          } catch {
            // One message Latch cannot read leaves the session going.
          }
        }
      }
    } catch {
      // The query ends with its process; that exit says how.
    }
  }

  private onProcessExit(session: Session, info: ExitInfo): void {
    this.lastStderr = info.stderr
    // A session Latch ended (closed, or replaced by another) leaves the wire as it was.
    if ((session.closing || !session.opened) && !this.stopReason) return
    this.finish(info)
  }

  private onMessage(session: Session, message: Record<string, unknown>): void {
    switch (message.type) {
      case 'stream_event':
        return this.onStream(session, message)
      case 'assistant':
        return this.onAssistant(session, message)
      case 'user':
        return this.onToolResults(session, message)
      case 'result':
        return this.onResult(session, message)
      case 'rate_limit_event':
        session.rateLimit = message.rate_limit_info
        this.update(session, { sessionUpdate: 'usage_update', _meta: { '_claude/rateLimit': message.rate_limit_info } })
        return
      case 'system':
        return this.onSystem(session, message)
      default:
        return
    }
  }

  /** The session that shows what a message of this Agent call's subagent says: the root's own for none. */
  private ownerOf(session: Session, parentToolUseId: unknown): string {
    if (typeof parentToolUseId !== 'string') return session.id
    return session.children.get(parentToolUseId)?.sessionId ?? session.id
  }

  private onStream(session: Session, message: Record<string, unknown>): void {
    // A subagent's words reach its own session whole, from its complete messages.
    if (message.parent_tool_use_id != null || !isRecord(message.event)) return
    const event = message.event
    if (event.type === 'message_start' && isRecord(event.message) && typeof event.message.id === 'string') {
      // Kept until the next message: `claude` may send one whole message per content block, all with this ID.
      session.streamed.clear()
      session.streamed.set(event.message.id, { text: false, thinking: false })
      session.replying = event.message.id
      return
    }
    if (event.type !== 'content_block_delta' || !isRecord(event.delta)) return
    const id = session.replying
    const seen = id ? session.streamed.get(id) : undefined
    if (event.delta.type === 'text_delta' && typeof event.delta.text === 'string' && event.delta.text) {
      if (seen) seen.text = true
      this.update(session, {
        sessionUpdate: 'agent_message_chunk',
        ...(id ? { messageId: id } : {}),
        content: { type: 'text', text: event.delta.text },
      })
    } else if (event.delta.type === 'thinking_delta' && typeof event.delta.thinking === 'string' && event.delta.thinking) {
      if (seen) seen.thinking = true
      this.update(session, {
        sessionUpdate: 'agent_thought_chunk',
        ...(id ? { messageId: id } : {}),
        content: { type: 'text', text: event.delta.thinking },
      })
    }
  }

  private onAssistant(session: Session, message: Record<string, unknown>): void {
    const top = message.parent_tool_use_id == null
    if (top && typeof message.error === 'string' && this.turn) this.turn.errorKind = message.error
    const said = isRecord(message.message) ? message.message : {}
    const blocks = Array.isArray(said.content) ? said.content : []
    const owner = this.ownerOf(session, message.parent_tool_use_id)
    const id = typeof said.id === 'string' ? said.id : undefined
    const seen = id ? session.streamed.get(id) : undefined
    for (const block of blocks) {
      if (!isRecord(block)) continue
      if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        this.reportCall(session, owner, block.id, block.name, block.input)
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text && (!top || !seen?.text)) {
        this.emit(session, owner, {
          sessionUpdate: 'agent_message_chunk',
          ...(id ? { messageId: id } : {}),
          content: { type: 'text', text: block.text },
        })
      } else if (top && block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking && !seen?.thinking) {
        this.update(session, {
          sessionUpdate: 'agent_thought_chunk',
          ...(id ? { messageId: id } : {}),
          content: { type: 'text', text: block.thinking },
        })
      }
    }
  }

  /**
   * A tool use, once, on the session that shows it. TodoWrite is the session's plan, and the Task* tools change it when
   * their result comes, so neither is a row of its own (as on the adapter). An Agent call announces its subagent.
   */
  private reportCall(session: Session, owner: string, toolCallId: string, tool: string, input: unknown): void {
    if (session.toolUses.has(toolCallId)) return
    remember(session.toolUses, toolCallId, { name: tool, input, sessionId: owner })
    if (PLAN_TOOLS.has(tool)) {
      const entries = tool === 'TodoWrite' && owner === session.id ? todoPlan(input) : undefined
      if (entries) this.update(session, { sessionUpdate: 'plan', entries })
      return
    }
    const facts = toolFacts(tool, input, session.cwd)
    this.emit(session, owner, {
      sessionUpdate: 'tool_call',
      toolCallId,
      name: tool,
      title: clip(facts.title, 500),
      kind: facts.kind,
      status: 'pending',
      rawInput: input,
      content: facts.content ?? [],
      ...(facts.locations ? { locations: facts.locations } : {}),
      _meta: { claudeCode: { toolName: tool } },
    })
    if (AGENT_TOOLS.has(tool)) {
      const fields = isRecord(input) ? input : {}
      const child: Child = { sessionId: `${session.id}/subagent/${toolCallId}`, parentSessionId: owner }
      remember(session.children, toolCallId, child)
      this.emit(session, owner, {
        sessionUpdate: 'subagent_update',
        sessionId: child.sessionId,
        title: clip(typeof fields.subagent_type === 'string' && fields.subagent_type ? fields.subagent_type : 'Agent', 200),
        ...(typeof fields.description === 'string' ? { description: clip(fields.description, 2000) } : {}),
        state: { state: 'running' },
      })
    }
  }

  private onToolResults(session: Session, message: Record<string, unknown>): void {
    const said = isRecord(message.message) ? message.message : {}
    if (!Array.isArray(said.content)) return
    for (const block of said.content) {
      if (!isRecord(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      this.onToolResult(session, block, message.tool_use_result)
    }
  }

  private onToolResult(session: Session, block: Record<string, unknown>, output: unknown): void {
    const id = block.tool_use_id as string
    const use = session.toolUses.get(id)
    const failed = block.is_error === true
    if (use && PLAN_TOOLS.has(use.name)) {
      if (!failed && use.sessionId === session.id && applyTaskResult(session.tasks, use.name, use.input, output, block.content))
        this.update(session, { sessionUpdate: 'plan', entries: taskPlan(session.tasks) })
      return
    }
    const owner = use?.sessionId ?? session.id
    const said = resultText(block.content)
    let fields: Record<string, unknown> = {}
    if (failed) {
      if (said) fields = { content: [{ type: 'content', content: { type: 'text', text: clip(said, TOOL_TEXT_LIMIT) } }] }
    } else if (use?.name === 'Edit' || use?.name === 'Write') {
      // What the file looks like now, from Claude's own patch; the result text only confirms it.
      const change = changeFromResult(output)
      if (change) fields = change
    } else if (use?.name === 'Bash' || use?.name === 'PowerShell') {
      const shown = (shellOutput(output) ?? said).trimEnd()
      if (shown)
        fields = {
          content: [{ type: 'content', content: { type: 'text', text: clip(`\`\`\`console\n${shown}\n\`\`\``, TOOL_TEXT_LIMIT) } }],
        }
    } else if (said) fields = { content: [{ type: 'content', content: { type: 'text', text: clip(said, TOOL_TEXT_LIMIT) } }] }
    this.emit(session, owner, {
      sessionUpdate: 'tool_call_update',
      toolCallId: id,
      status: failed ? 'failed' : 'completed',
      ...fields,
      ...(use ? { _meta: { claudeCode: { toolName: use.name } } } : {}),
    })
    const child = use && AGENT_TOOLS.has(use.name) ? session.children.get(id) : undefined
    if (child && !child.ended) {
      child.ended = true
      const stopped = this.turn?.cancelled === true
      this.emit(session, child.parentSessionId, {
        sessionUpdate: 'subagent_update',
        sessionId: child.sessionId,
        state: failed
          ? stopped
            ? { state: 'idle', stopReason: 'cancelled' }
            : { state: 'idle', stopReason: 'end_turn', error: { message: clip(said, 1000) } }
          : { state: 'idle', stopReason: 'end_turn' },
        capabilities: null,
      })
    }
  }

  private onSystem(session: Session, message: Record<string, unknown>): void {
    if (message.session_id === session.id && message.parent_tool_use_id == null) {
      if (message.subtype === 'commands_changed' && Array.isArray(message.commands)) {
        this.reportCommands(session, message.commands)
        return
      }
      if (message.subtype === 'init' && Array.isArray(message.slash_commands)) {
        const terminal = z.array(text).optional().safeParse(message.terminal_slash_commands)
        if (terminal.success) {
          session.terminalCommands = new Set(terminal.data?.map(name => name.replace(/^\//u, '')))
          this.reportCommands(session, message.slash_commands, true)
        }
      }
    }
    if (message.subtype === 'compact_boundary') {
      if (message.parent_tool_use_id != null || typeof message.uuid !== 'string' || !UUID.test(message.uuid)) return
      session.contextGeneration = (session.contextGeneration ?? 0) + 1
      this.update(session, {
        sessionUpdate: 'compaction_update',
        compactionId: message.uuid,
        status: 'completed',
        latchClaudeCompaction: { ...claudeCompactionMetrics(message.compact_metadata), turnId: this.turn?.messageId },
      })
      return
    }
    if (message.subtype === 'permission_denied' && typeof message.tool_use_id === 'string') {
      // Refused by Claude's own rules, mode or classifier before it ran: said the way the adapter says it (`readDenial`).
      const owner = session.toolUses.get(message.tool_use_id)?.sessionId ?? session.id
      this.emit(session, owner, {
        sessionUpdate: 'tool_call_update',
        toolCallId: message.tool_use_id,
        status: 'failed',
        _meta: {
          claudeCode: {
            toolResponse: {
              ...(typeof message.decision_reason_type === 'string' ? { decisionReasonType: message.decision_reason_type } : {}),
              ...(typeof message.decision_reason === 'string' ? { decisionReason: clip(message.decision_reason, 1000) } : {}),
              ...(typeof message.message === 'string' ? { message: clip(message.message, 1000) } : {}),
            },
          },
        },
      })
      return
    }
    if (message.subtype === 'task_started' && typeof message.task_id === 'string' && typeof message.tool_use_id === 'string') {
      // Claude's ID for the subagent, which stops it alone: from now on its row can be stopped.
      const child = session.children.get(message.tool_use_id)
      if (!child || child.ended) return
      child.taskId = message.task_id
      remember(session.tasksById, message.task_id, child)
      this.emit(session, child.parentSessionId, {
        sessionUpdate: 'subagent_update',
        sessionId: child.sessionId,
        capabilities: { cancel: {} },
      })
      return
    }
    if (message.subtype === 'session_state_changed') return this.onState(session, message.state)
    // The mode Claude Code is in, as it reports it: a change it made itself (EnterPlanMode, an accepted plan) is read back.
    const reported =
      (message.subtype === 'init' || message.subtype === 'status') && typeof message.permissionMode === 'string'
        ? message.permissionMode
        : undefined
    if (reported) this.modeIs(session, reported)
  }

  /**
   * Claude's own word on whether it is working (`session_state_changed`), its authoritative signal that a turn is over:
   * `idle` comes after the turn's result. A cancelled turn whose own result already came is settled by it, without
   * waiting longer for the interrupt to be acknowledged. An `idle` alone settles nothing: it may be owed to an earlier
   * result (the adapter counts such idles), so a turn without its result is not ended by it.
   */
  private onState(session: Session, state: unknown): void {
    const turn = this.turn
    if (!turn || this.session !== session || state !== 'idle' || !turn.ended) return
    if (turn.errorKind !== 'authentication_failed' && !turn.cancelled) turn.errorKind = turn.endedErrorKind
    turn.interrupted = true
    void this.settle(turn, turn.ended)
  }

  private onResult(session: Session, message: Record<string, unknown>): void {
    const turn = this.turn
    const consumed = Array.isArray(message.user_message_uuids)
      ? message.user_message_uuids.filter((id): id is string => typeof id === 'string')
      : typeof message.user_message_uuid === 'string'
        ? [message.user_message_uuid]
        : []
    const owner = consumed.length > 0
    const ours = turn !== undefined && (!owner || consumed.some(id => turn.uuids.has(id)))
    if (!ours || !turn) {
      // A turn Claude Code started on its own: its cost is real, and only its usage is reported.
      void this.reportUsage(session, message)
      return
    }
    turn.usage = addTurnTokens(turn.usage, readTurnTokens(message.usage))
    if (turn.cancelled && !turn.interrupted) {
      turn.ended = message
      return
    }
    if (!turn.cancelled && turn.pendingSteers?.size) {
      if (!owner) {
        // A result that names no message: which cycle it ends is unknown, so the turn settles at `idle` on the latest one,
        // with that cycle's error. Nothing is rewritten: a cycle that really failed still fails the turn.
        turn.ended = message
        turn.endedErrorKind = turn.errorKind
        if (turn.errorKind !== 'authentication_failed') turn.errorKind = undefined
        return
      }
      let answeredSteer = false
      for (const id of consumed) {
        if (turn.pendingSteers.delete(id)) answeredSteer = true
      }
      if (turn.pendingSteers.size > 0 || !answeredSteer) {
        // A cycle before the latest addition (interrupted to take it): the turn goes on, and its error is not the turn's.
        if (turn.errorKind !== 'authentication_failed') turn.errorKind = undefined
        return
      }
      turn.ended = undefined
    }
    void this.settle(turn, message)
  }

  /** What the turn used: its tokens for the answer, the context in use and the session's cost as an update. */
  private async reportUsage(
    session: Session,
    message: Record<string, unknown>,
    turnId?: string,
    accumulated?: TurnTokens,
  ): Promise<TurnTokens | undefined> {
    const tokens = accumulated ?? readTurnTokens(message.usage)
    const generation = session.contextGeneration
    const readNumber = (session.contextReads = (session.contextReads ?? 0) + 1)
    const sample = await this.withTimeout(session.query.getContextUsage(), CONTEXT_TIMEOUT_MS).catch(() => undefined)
    if (readNumber <= (session.contextReported ?? 0)) return tokens
    const context = generation === session.contextGeneration ? contextUsage.safeParse(sample).data : undefined
    const cost =
      typeof message.total_cost_usd === 'number' && Number.isFinite(message.total_cost_usd) && !this.route
        ? message.total_cost_usd
        : undefined
    if (context || cost !== undefined) {
      session.contextReported = readNumber
      this.update(session, {
        sessionUpdate: 'usage_update',
        ...(context
          ? { used: context.totalTokens, _meta: { latchClaudeContext: { turnId, breakdown: claudeContextBreakdown(sample) } } }
          : {}),
        ...(context?.maxTokens ? { size: context.maxTokens } : {}),
        ...(cost !== undefined ? { cost: { amount: cost, currency: 'USD' } } : {}),
      })
    }
    return tokens
  }

  private async settle(turn: Turn, message: Record<string, unknown>): Promise<void> {
    if (this.turn !== turn) return
    this.turn = undefined
    const session = this.session
    const usage = session ? await this.reportUsage(session, message, turn.messageId, turn.usage) : turn.usage
    const withUsage = usage ? { usage } : {}
    // A cancel, or a choice that stops the turn (keep planning), ends it as cancelled, as on the adapter.
    if (turn.cancelled || turn.stopped) return turn.resolve({ stopReason: 'cancelled', ...withUsage })
    if (turn.errorKind === 'authentication_failed') return turn.reject(new RpcError(RPC.authRequired, 'Claude Code is not logged in'))
    const failed = message.subtype !== 'success' || message.is_error === true
    if (failed) {
      const errors = Array.isArray(message.errors) ? message.errors.filter((item): item is string => typeof item === 'string') : []
      const said =
        errors.join('\n') || (typeof message.result === 'string' ? message.result : '') || `Claude Code stopped: ${String(message.subtype)}`
      // As the adapter: the error says what kind of failure it was; a refusal for the limit carries the limit Claude reported.
      const counted =
        usage
        && (usage.inputTokens > 0 || usage.outputTokens > 0 || (usage.cachedReadTokens ?? 0) > 0 || (usage.cachedWriteTokens ?? 0) > 0)
      const data =
        turn.errorKind || counted
          ? {
              ...(turn.errorKind ? { errorKind: turn.errorKind } : {}),
              ...(turn.errorKind === 'rate_limit' && session?.rateLimit !== undefined ? { rateLimit: session.rateLimit } : {}),
              ...(counted ? { usage } : {}),
            }
          : undefined
      return turn.reject(new RpcError(RPC.internal, clip(redactKnownSecrets(this.spec.redact(said)), 4000), data))
    }
    const stop = message.stop_reason
    turn.resolve({ stopReason: stop === 'max_tokens' ? 'max_tokens' : stop === 'refusal' ? 'refusal' : 'end_turn', ...withUsage })
  }

  // ---- Claude's own store (`store`) --------------------------------------------------------------------------------

  private assertStore(): ClaudeStore {
    if (!this.store) throw new RpcError(RPC.methodNotFound, 'Method not found')
    return this.store
  }

  /** Claude's sessions, newest first, as its terminal `/resume` lists them: none an SDK started (Latch's among them). */
  private async list(params: unknown, signal?: AbortSignal): Promise<unknown> {
    const store = this.assertStore()
    const parsed = listParams.safeParse(params ?? {})
    if (!parsed.success) throw new RpcError(RPC.invalidParams, 'Invalid params')
    const offset = Number(/^offset:(\d{1,9})$/u.exec(parsed.data.cursor ?? '')?.[1] ?? 0)
    const page = await store.list(offset, LIST_PAGE, signal).catch(storeFailure)
    return {
      sessions: page.sessions
        .filter(row => UUID.test(row.sessionId))
        .map(row => ({ ...row, ...(row.title ? { title: clip(row.title, 400) } : {}) })),
      nextCursor: page.more ? `offset:${offset + page.sessions.length}` : null,
    }
  }

  /**
   * A session of Claude's own, replayed and then resumed as this wire's: refused while another `claude` holds it (its
   * registry), since both would write to the one transcript.
   */
  private async load(params: unknown, signal?: AbortSignal): Promise<unknown> {
    const store = this.assertStore()
    const parsed = sessionParams.safeParse(params)
    const id = parsed.data?.sessionId
    if (!parsed.success || !id || !UUID.test(id)) throw new RpcError(RPC.notFound, 'Session not found')
    if (this.turn) throw new RpcError(RPC.internal, 'A turn is already running')
    if (this.session) await this.closeSession(this.session)
    if ((await store.busy(id, signal).catch(storeFailure)).busy)
      throw new RpcError(RPC.internal, 'The session is already open in another Claude Code process (busy)')
    const read = await store.messages(id, parsed.data.cwd, CAPTURE_BYTES, signal).catch(storeFailure)
    if (!read.messages.length) throw new RpcError(RPC.notFound, 'Session not found')
    // Before the answer, as ACP replays: the session is not this wire's yet, so the replay goes out as it is.
    for (const update of replayUpdates(read.messages, parsed.data.cwd)) {
      try {
        this.handlers.notification('session/update', { sessionId: id, update })
      } catch {
        // A replay the runtime does not take changes nothing here.
      }
    }
    return this.open(id, params)
  }

  /**
   * Deletes Claude's record of a session (`deleteSession`): its transcript and its folder of subagents and large tool
   * output, never Claude's other per-session leftovers, which Claude itself cleans up. No `claude` starts for it. Its own
   * session is closed first, so a query still writing cannot put the file back; one another `claude` holds is refused.
   */
  private async remove(params: unknown, signal?: AbortSignal): Promise<unknown> {
    const store = this.assertStore()
    const id = isRecord(params) && typeof params.sessionId === 'string' ? params.sessionId : undefined
    if (!id || !UUID.test(id)) return {}
    if (this.session?.id === id) {
      if (this.turn) throw new RpcError(RPC.internal, 'A turn is already running')
      await this.closeSession(this.session)
    }
    if ((await store.busy(id, signal).catch(storeFailure)).busy)
      throw new RpcError(RPC.internal, 'The session is open in another Claude Code process (busy)')
    await store.delete(id, this.spec.cwd, signal).catch(storeFailure)
    return {}
  }

  /**
   * Claude's own fork of the source session through the turn Latch's message `through` opened (`FORK_METHOD`), opened
   * as this wire's session. A `ForkRefused` when the transcript does not hold that message (a session begun before Latch
   * marked its turns, or on the adapter), or the copy does not end there; a copy that cannot be opened is deleted again.
   */
  private async fork(params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.store) throw new ForkRefused('它不能读写 Claude 自己的记录')
    const parsed = forkParams.safeParse(params)
    if (!parsed.success) throw new RpcError(RPC.invalidParams, 'Invalid params')
    const { sessionId: source, cwd, through } = parsed.data
    if (this.turn) throw new ForkRefused('这个进程有一轮正在运行')
    if (!UUID.test(source)) throw new ForkRefused('来源会话不是 Claude 的会话')
    if (!through || !UUID.test(through)) throw new ForkRefused('来源会话没有这一轮的标识')
    let forked: Awaited<ReturnType<ClaudeStore['fork']>>
    try {
      forked = await this.store.fork(source, through, cwd, signal)
    } catch (error) {
      throw new ForkRefused(`它读不到来源的记录（${clip(redactKnownSecrets(this.spec.redact(message(error))), 160)}）`)
    }
    if ('refused' in forked) throw new ForkRefused(forked.refused === 'missing' ? '它的记录里找不到这一轮' : '分叉出的记录没有停在这一轮')
    try {
      return await this.open(forked.sessionId, params)
    } catch (error) {
      await this.store.delete(forked.sessionId, cwd).catch(() => {})
      if (error instanceof ConnectionClosed || error instanceof ConnectionStopping) throw error
      throw new ForkRefused(`分叉出的会话没有打开（${clip(redactKnownSecrets(this.spec.redact(message(error))), 160)}）`)
    }
  }

  /**
   * The plan's limits, asked of Claude itself (its experimental `get_usage`, told to skip the scan of recent transcripts
   * it would otherwise make): on the session's process, or, with no session open, on one opened just to ask, which leaves
   * no transcript and runs none of the person's hooks or MCP servers. A Claude without it answers `methodNotFound`.
   */
  private async usage(): Promise<unknown> {
    if (this.session) return askUsage(this.session)
    if (this.turn) throw new RpcError(RPC.internal, 'This process runs another session')
    await this.open(undefined, { cwd: this.spec.cwd, mcpServers: [] }, 'usage')
    const session = this.session as Session | undefined
    if (!session) throw new RpcError(RPC.internal, 'No session opened')
    try {
      return await askUsage(session)
    } finally {
      await this.closeSession(session)
    }
  }

  /** Claude's own MCP servers and their states (`mcpServerStatus`), without those Latch gave the session. */
  private async readMcp(session: Session): Promise<{ servers: unknown[]; truncated?: true }> {
    const listed = (await session.query.mcpServerStatus?.()) ?? []
    const servers: unknown[] = []
    for (const item of listed) {
      const read = mcpStatus.safeParse(item)
      if (!read.success || session.given.has(read.data.name)) continue
      servers.push({
        name: read.data.name,
        state: MCP_STATES[read.data.status] ?? 'unknown',
        ...(read.data.tools ? { tools: read.data.tools.length } : {}),
        ...(read.data.scope ? { origin: read.data.scope } : {}),
      })
      if (servers.length >= 200) return { servers, truncated: true }
    }
    return { servers }
  }

  /** The session's own MCP servers, once it has had a turn and they have started. */
  private async reportMcp(session: Session): Promise<void> {
    try {
      const read = await this.withTimeout(this.readMcp(session), CONTEXT_TIMEOUT_MS * 5)
      if (read) this.update(session, { sessionUpdate: MCP_STATUS_UPDATE, ...read })
    } catch {
      // Not reported this time; the next session says it.
    }
  }

  /**
   * `MCP_STATUS_METHOD`: the session's servers, or, with no session open, those of one opened just to read them in the
   * process's folder, which leaves no transcript.
   */
  private async mcpStatus(params: unknown): Promise<unknown> {
    const id = isRecord(params) && typeof params.sessionId === 'string' ? params.sessionId : undefined
    if (this.session && (!id || this.session.id === id)) return this.readMcp(this.session)
    if (this.session || this.turn) throw new RpcError(RPC.internal, 'This process runs another session')
    await this.open(undefined, { cwd: this.spec.cwd, mcpServers: [] }, 'mcp')
    const session = this.session as Session | undefined
    try {
      return session ? await this.readMcp(session) : { servers: [] }
    } finally {
      if (session) await this.closeSession(session)
    }
  }

  /** An MCP server's form question to the person; anything else (a URL to open) is cancelled, as Latch shows no such form. */
  private onElicitation(session: Session) {
    return async (request: Record<string, unknown>, options: { signal: AbortSignal }): Promise<Record<string, unknown>> => {
      if (this.session !== session || request.mode === 'url') return { action: 'cancel' }
      const schema = isRecord(request.requestedSchema) ? request.requestedSchema : {}
      session.openAsks++
      try {
        const answer = await this.handlers.request(
          ELICITATION_METHOD,
          {
            mode: 'form',
            sessionId: session.id,
            message: typeof request.message === 'string' ? request.message : '',
            requestedSchema: { ...schema, type: 'object', properties: isRecord(schema.properties) ? schema.properties : {} },
          },
          `elicit-${randomUUID()}`,
        )
        if (options.signal.aborted || !isRecord(answer)) return { action: 'cancel' }
        if (answer.action === 'accept') return { action: 'accept', content: isRecord(answer.content) ? answer.content : {} }
        return { action: answer.action === 'decline' ? 'decline' : 'cancel' }
      } catch {
        return { action: 'cancel' }
      } finally {
        session.openAsks--
      }
    }
  }

  /** Claude's own question (AskUserQuestion), as the adapter asks it: a form, answered into the tool's input. */
  private async askQuestion(session: Session, owner: string, input: Record<string, unknown>, toolCallId: string, signal: AbortSignal) {
    const questions = askedQuestions(input)
    if (!questions) return { behavior: 'deny', message: 'AskUserQuestion called with no valid questions.' }
    let answer: unknown
    session.openAsks++
    try {
      answer = await this.handlers.request(ELICITATION_METHOD, questionForm(questions, owner, toolCallId), `ask-${toolCallId}`)
    } catch {
      if (signal.aborted) throw new Error('Tool use aborted')
      return { behavior: 'deny', message: 'Could not present the question to the user.' }
    } finally {
      session.openAsks--
    }
    if (signal.aborted) throw new Error('Tool use aborted')
    const updatedInput = answeredInput(answer, input, questions)
    if (!updatedInput) throw new Error('Tool use aborted')
    return { behavior: 'allow', updatedInput }
  }

  /**
   * Claude Code asks before a call: the runtime's permission request on that call, with the adapter's options for the
   * tool. The result of the chosen option goes back to the SDK as it is.
   */
  private async canUseTool(
    session: Session,
    tool: string,
    input: Record<string, unknown>,
    context: AskOptions,
  ): Promise<Record<string, unknown>> {
    const toolCallId = context.toolUseID ?? `ask-${randomUUID()}`
    const refused = (message = 'User refused permission to run tool') => ({
      behavior: 'deny',
      message,
      toolUseID: toolCallId,
      decisionClassification: 'user_reject',
    })
    if (this.session !== session || context.signal.aborted) return refused('The user cancelled this prompt.')
    // A subagent asks on its own session: by Claude's task ID, else by the session that reported the call.
    const owner =
      (context.agentID ? session.tasksById.get(context.agentID)?.sessionId : undefined)
      ?? session.toolUses.get(toolCallId)?.sessionId
      ?? session.id
    this.reportCall(session, owner, toolCallId, tool, input)
    if (tool === 'AskUserQuestion') return this.askQuestion(session, owner, input, toolCallId, context.signal)
    const ask: AskContext = {
      toolName: tool,
      input,
      toolUseID: toolCallId,
      cwd: session.cwd,
      ...((): { changeSet?: AskContext['changeSet'] } => {
        const changeSet = normalizeChangeSet(
          context.suggestions,
          context.matchedAskRule !== undefined || context.suppressAlwaysAllowRule === true,
        )
        return changeSet ? { changeSet } : {}
      })(),
      allowPersistent: context.matchedAskRule === undefined && context.suppressAlwaysAllowRule !== true,
      ...(typeof context.displayName === 'string' ? { displayName: context.displayName } : {}),
      ...(context.defaultToNo === true ? { defaultToNo: true } : {}),
      availableModes: this.availableModes(session),
      ...(session.prePlanMode ? { prePlanMode: session.prePlanMode } : {}),
    }
    const options = permissionOptions(ask)
    const facts = toolFacts(tool, input, session.cwd)
    const blocked = typeof context.blockedPath === 'string' && context.blockedPath ? context.blockedPath : undefined
    const locations = [
      ...(facts.locations ?? []),
      ...(blocked && !facts.locations?.some(item => item.path === blocked) ? [{ path: blocked }] : []),
    ]
    let answer: unknown
    session.openAsks++
    try {
      answer = await this.handlers.request(
        'session/request_permission',
        {
          sessionId: owner,
          toolCall: {
            toolCallId,
            name: tool,
            status: 'pending',
            rawInput: input,
            title: clip(facts.title, 500),
            kind: facts.kind,
            content: facts.content ?? [],
            ...(facts.locations !== undefined || locations.length ? { locations } : {}),
          },
          options,
        },
        `ask-${toolCallId}`,
      )
    } catch {
      return refused()
    } finally {
      session.openAsks--
    }
    if (context.signal.aborted) return refused('The user cancelled this prompt.')
    const outcome = isRecord(answer) && isRecord(answer.outcome) ? answer.outcome : {}
    // A request the person dismissed is the person refusing the tool, as the adapter answers it.
    if (outcome.outcome !== 'selected' || typeof outcome.optionId !== 'string') return refused()
    const decision = decide(ask, options, outcome.optionId)
    if (!decision) return refused()
    if (decision.interrupts && this.turn && owner === session.id) this.turn.stopped = true
    // An accepted plan moves Claude to the mode it names; the runtime reads it back as Claude's own change.
    const update = (decision.result.updatedPermissions as Array<Record<string, unknown>> | undefined)?.find(
      item => item.type === 'setMode' && item.destination === 'session',
    )
    if (tool === 'ExitPlanMode' && typeof update?.mode === 'string' && outcome.optionId !== OPTION.reject) this.modeIs(session, update.mode)
    return decision.result
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A read of Claude's store that failed: an internal error that says why, never what it read. */
function storeFailure(error: unknown): never {
  throw new RpcError(RPC.internal, `读取 Claude 的记录失败：${clip(message(error), 300)}`)
}

/** What `canUseTool` is told beside the tool and its input (the SDK's `CanUseTool` options this wire reads). */
interface AskOptions {
  signal: AbortSignal
  toolUseID?: string
  agentID?: string
  suggestions?: unknown
  blockedPath?: string
  matchedAskRule?: unknown
  suppressAlwaysAllowRule?: boolean
  displayName?: string
  defaultToNo?: boolean
}
