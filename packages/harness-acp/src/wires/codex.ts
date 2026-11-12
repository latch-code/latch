/**
 * Codex's own app-server (`codex app-server`): JSON-RPC over stdio, the protocol Codex's own clients use, so Codex runs
 * without an adapter. The runtime keeps speaking ACP; this wire answers its methods with Codex's thread and turn
 * requests and turns Codex's item notifications into ACP session updates, so every check of the runtime applies to it
 * unchanged. Types follow `codex app-server generate-ts` of Codex 0.167.
 */
import { z } from 'zod'
import { escapeSecurityText } from '@latch/protocol'
import { redactKnownSecrets } from '@latch/core/node-kit'
import { CODEX_EFFORT_ID, CODEX_MODEL_ID, codexModel, codexOptions, type CodexModels } from '../codex-models.ts'
import { clip, TOOL_TEXT_LIMIT } from '../mapping.ts'
import { CODEX_MODES, type CodexMode } from '../profiles/codex.ts'
import { RPC, RpcError, STEER_METHOD, type RpcId } from '../protocol.ts'
import { AgentProcess, ConnectionClosed, ConnectionStopping, isRecord, RequestTimeout, type ExitInfo, type SpawnSpec } from './process.ts'
import type { AgentWire, WireHandlers } from './types.ts'

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

/** The prompt being run: answered once Codex reports the turn completed. */
interface Turn {
  id?: string
  resolve(result: unknown): void
  reject(error: Error): void
  cancelled: boolean
  error?: string
  usage?: { inputTokens: number; outputTokens: number }
}

export class CodexWire implements AgentWire {
  readonly exited: Promise<ExitInfo>
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
  private turn?: Turn
  /** Items whose text arrived in pieces, so their completion does not repeat it. */
  private readonly streamed = new Set<string>()
  /** Command output so far, per item. */
  private readonly output = new Map<string, string>()
  /** Calls a person answered: what Codex then reports declined was their choice, not Codex's refusal. */
  private readonly answered = new Set<string>()
  /** MCP tools (`server\0tool`) a person answered about this turn: such a call reported declined was their choice. */
  private readonly toolAnswers = new Set<string>()
  /** Calls Codex's review model denied, with its reason. */
  private readonly denied = new Map<string, string>()

  private constructor(
    spec: SpawnSpec,
    private readonly handlers: WireHandlers,
  ) {
    this.process = AgentProcess.spawn(
      { ...spec, args: codexArgs(spec.args) },
      { record: record => this.onMessage(record), closed: info => this.onClosed(info) },
    )
    this.exited = this.process.exited
  }

  /** Throws for arguments Codex must not get; launch failures such as ENOENT arrive as an exit with `reason: 'spawn'`. */
  static spawn(spec: SpawnSpec, handlers: WireHandlers): CodexWire {
    return new CodexWire(spec, handlers)
  }

  get closed(): boolean {
    return this.process.closed
  }
  get stopping(): boolean {
    return this.process.stopping
  }

  request(method: string, params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
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
        return this.prompt(params, timeoutMs)
      case 'session/set_config_option':
        return Promise.resolve(this.setOption(params))
      case STEER_METHOD:
        return this.steer(params, timeoutMs, signal)
      case 'logout':
        return this.send('account/logout', undefined, timeoutMs, signal)
      default:
        return Promise.reject(new RpcError(RPC.methodNotFound, `Method not found: ${clip(method, 200)}`))
    }
  }

  /** `session/cancel`: interrupts the running turn, which ends once Codex reports it completed. */
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
    await this.readModels(timeoutMs, signal)
    const settings = threadSettings(this.mode, this.cwd, this.servers)
    let answer: unknown
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
    this.model = read.data.model ?? this.model
    this.effort = read.data.reasoningEffort ?? this.effort
    return { sessionId: this.threadId, configOptions: this.options() }
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
    const read = listing.safeParse(await this.send('thread/list', { ...(cursor ? { cursor } : {}), limit: MAX_THREADS }, timeoutMs, signal))
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
      this.model = value
      const entry = this.models.models.find(item => item.id === value)
      const efforts = entry?.supportedReasoningEfforts?.map(item => item.reasoningEffort) ?? []
      if (this.effort && efforts.length && !efforts.includes(this.effort)) this.effort = entry?.defaultReasoningEffort ?? efforts[0]
    } else if (configId === CODEX_EFFORT_ID) {
      this.effort = value
    } else throw new RpcError(RPC.invalidParams, 'Unknown option')
    return { configOptions: this.options() }
  }

  private assertSession(sessionId: string): void {
    if (!this.threadId || sessionId !== this.threadId) throw new RpcError(RPC.notFound, 'Session not found')
  }

  private input(blocks: z.infer<typeof promptParams>['prompt']): unknown[] {
    return blocks.map(block => {
      if (block.type === 'text' && block.text !== undefined) return { type: 'text', text: block.text, text_elements: [] }
      if (block.type === 'image' && block.data && block.mimeType)
        return { type: 'image', url: `data:${block.mimeType};base64,${block.data}` }
      throw new RpcError(RPC.invalidParams, `Codex takes no ${clip(block.type, 64)} content here`)
    })
  }

  private async prompt(params: unknown, timeoutMs?: number): Promise<unknown> {
    const parsed = promptParams.safeParse(params)
    if (!parsed.success) throw new RpcError(RPC.invalidParams, 'Invalid params')
    this.assertSession(parsed.data.sessionId)
    if (this.turn) throw new RpcError(RPC.internal, 'A turn is already running')
    const input = this.input(parsed.data.prompt)
    let turn!: Turn
    const done = new Promise<unknown>((resolve, reject) => {
      turn = { resolve, reject, cancelled: false }
    })
    this.turn = turn
    done.catch(() => {})
    let answer: unknown
    try {
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

  private async steer(params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    const parsed = promptParams.safeParse(params)
    if (!parsed.success) throw new RpcError(RPC.invalidParams, 'Invalid params')
    this.assertSession(parsed.data.sessionId)
    const turn = this.turn
    if (!turn?.id || turn.cancelled) return { outcome: 'promptRequired' }
    try {
      await this.send(
        'turn/steer',
        { threadId: this.threadId, expectedTurnId: turn.id, input: this.input(parsed.data.prompt) },
        timeoutMs,
        signal,
      )
    } catch (error) {
      // The turn ended meanwhile: the addition becomes the next prompt.
      if (error instanceof RpcError && error.code !== RPC.cancelled) return { outcome: 'promptRequired' }
      throw error
    }
    return { outcome: 'injected' }
  }

  private settle(status: unknown, error: unknown): void {
    const turn = this.turn
    if (!turn) return
    this.turn = undefined
    this.streamed.clear()
    this.output.clear()
    this.answered.clear()
    this.toolAnswers.clear()
    this.denied.clear()
    const usage = turn.usage ? { usage: turn.usage } : {}
    if (status === 'interrupted' || (turn.cancelled && status !== 'failed')) return turn.resolve({ stopReason: 'cancelled', ...usage })
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
   * subagent's (`child`) are left out, its calls shown as its. A command is pending until it is seen running: one Codex
   * refuses first (its review model, its rules) never ran, and its refusal says so (`latch/codexDenied`).
   */
  private item(sessionId: string, item: Record<string, unknown>, phase: 'started' | 'completed', child?: string): void {
    const id = typeof item.id === 'string' ? clip(item.id, 512) : undefined
    if (!id) return
    const done = phase === 'completed'
    const emit = (update: Record<string, unknown> & { sessionUpdate: string }) => this.emit(sessionId, this.marked(update, child))
    switch (item.type) {
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
        if (!done || !this.output.has(id))
          emit({
            sessionUpdate: 'tool_call',
            toolCallId: id,
            title: clip(command, 500),
            kind: 'execute',
            status: 'pending',
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
          })
        if (item.status === 'completed') emit({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress' })
        return emit({
          sessionUpdate: 'tool_call_update',
          toolCallId: id,
          status: itemStatus(item.status) ?? 'completed',
          ...(content.length ? { content } : {}),
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
        const asked = item.type === 'mcpToolCall' && this.toolAnswers.has(`${String(item.server)}\0${String(item.tool)}`)
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

  private onNotification(method: string, params: Record<string, unknown>): void {
    // Codex may run its subagents' threads in this process: their calls reach the session marked as theirs.
    const thread = typeof params.threadId === 'string' ? params.threadId : undefined
    const child = thread !== undefined && thread !== this.threadId ? thread : undefined
    if (child) {
      if (!this.threadId) return
      if ((method === 'item/started' || method === 'item/completed') && isRecord(params.item))
        this.item(this.threadId, params.item, method === 'item/started' ? 'started' : 'completed', child)
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
        if (isRecord(params.item) && this.threadId)
          this.item(this.threadId, params.item, method === 'item/started' ? 'started' : 'completed')
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
    return { decision: chosen === 'accept' ? 'accept' : chosen === 'decline' ? 'decline' : 'cancel' }
  }

  /**
   * Codex asking whether to run an MCP server's tool, which it sends as that server's elicitation marked
   * `codex_approval_kind: mcp_tool_call`: a card like any approval, answered `accept`, `decline` or, with no answer, `cancel`.
   */
  private async toolApproval(params: Record<string, unknown>, id: RpcId): Promise<unknown> {
    const meta = isRecord(params._meta) ? params._meta : {}
    const thread = typeof params.threadId === 'string' ? params.threadId : undefined
    const child = thread !== undefined && thread !== this.threadId ? thread : undefined
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
              toolCallId: `mcp-approval-${String(id)}`,
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
    const outcome = isRecord(answer) && isRecord(answer.outcome) ? answer.outcome : {}
    const chosen = outcome.outcome === 'selected' ? outcome.optionId : undefined
    if (chosen === 'accept' || chosen === 'decline')
      this.toolAnswers.add(
        `${typeof params.serverName === 'string' ? params.serverName : ''}\0${typeof meta.tool_name === 'string' ? meta.tool_name : ''}`,
      )
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
