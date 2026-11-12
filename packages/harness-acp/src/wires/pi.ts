/**
 * pi's own RPC mode (`pi --mode rpc`): JSONL commands with an `id`, a `response` for each, and session events with none.
 * The runtime keeps speaking ACP; this wire answers its methods with pi's commands and turns pi's events into ACP
 * session updates, so pi runs without an adapter and every check of the runtime applies to it unchanged.
 */
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { redactKnownSecrets } from '@latch/core/node-kit'
import { AppError } from '@latch/sdk'
import { clip, TOOL_TEXT_LIMIT } from '../mapping.ts'
import { FORK_METHOD, RPC, RpcError, STEER_METHOD } from '../protocol.ts'
import { AgentProcess, ConnectionClosed, ConnectionStopping, isRecord, RequestTimeout, type ExitInfo, type SpawnSpec } from './process.ts'
import { ForkRefused, type AgentWire, type WireHandlers } from './types.ts'

/** The oldest pi this wire works with: its turns end on `agent_settled`, `message_update` carries deltas and a stop clears the queue. */
const PI_MINIMUM = '0.84.4'
/** Appended to the definition's arguments: the protocol this wire speaks. */
export const PI_RPC_ARGS: readonly string[] = ['--mode', 'rpc']
/** Arguments that would change the protocol, the session it runs or make pi exit, which this wire decides. */
const RESERVED = new Set([
  '--mode',
  '--print',
  '-p',
  '--session',
  '--session-id',
  '--no-session',
  '--continue',
  '-c',
  '--resume',
  '-r',
  '--fork',
  '--export',
  '--list-models',
  '--help',
  '-h',
  '--version',
  '-v',
])
const MODEL = 'model'
const THOUGHT_LEVEL = 'thought_level'
const MAX_MODELS = 500
/** Usage is read after each turn; a slow answer leaves the turn's usage unknown rather than holding the turn open. */
const STATS_TIMEOUT_MS = 2_000
const CONFIRM_OPTIONS = [
  { optionId: 'yes', name: '允许', kind: 'allow_once' },
  { optionId: 'no', name: '拒绝', kind: 'reject_once' },
]
/** pi's levels have no names of their own beyond their IDs; these are the words the composer uses for thinking. */
const LEVEL_NAMES: Readonly<Record<string, string>> = {
  off: '不思考',
  minimal: '最少',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最高',
}
/** Dialogs a pi extension opens that need an answer; the rest of its interface asks nothing. */
const DIALOGS = new Set(['select', 'input', 'editor'])
/**
 * pi's own `/compact`, which its RPC runs as the `compact` command and does not list: sent as a prompt, the text would go
 * to the model. pi aborts what it is doing before it compacts, so it is offered only between turns.
 */
const COMPACT = {
  name: 'compact',
  description: '把之前的对话总结成摘要，腾出上下文；可以在命令后写总结时要注意什么',
  input: { hint: '总结时要注意什么（可选）' },
}

/** `/compact`, alone or followed by what the summary should keep, as pi's own interface reads it; anything else is a prompt. */
function compactCommand(text: string): { customInstructions?: string } | undefined {
  const match = /^\/compact(?:\s+([\s\S]*))?$/u.exec(text.trim())
  if (!match) return undefined
  const instructions = match[1]?.trim()
  return instructions ? { customInstructions: instructions } : {}
}

const text = z.string()
const model = z.object({ provider: text.min(1).max(256), id: text.min(1).max(512), name: text.max(1000).optional().catch(undefined) })
type PiModel = z.infer<typeof model>
const state = z.object({
  sessionFile: text.optional().catch(undefined),
  model: model.nullish().catch(undefined),
  thinkingLevel: text.max(64).optional().catch(undefined),
})
const models = z.object({ models: z.array(z.unknown()) })
const levels = z.object({ levels: z.array(text.max(64)).max(32) })
const disposition = z.object({ disposition: text.optional() }).nullish().catch(undefined)
const count = z.number().nonnegative().finite()
const stats = z.object({
  tokens: z.object({ input: count, output: count }).optional().catch(undefined),
  cost: count.optional().catch(undefined),
  contextUsage: z.object({ tokens: count.nullish(), contextWindow: count.nullish() }).nullish().catch(undefined),
})
const promptParams = z.object({
  sessionId: text,
  prompt: z.array(z.object({ type: text, text: text.optional(), data: text.optional(), mimeType: text.optional() })),
})
const optionParams = z.object({ sessionId: text, configId: text, value: text.max(1024) })
const steerParams = z.object({ sessionId: text, prompt: z.array(z.object({ type: text, text: text.optional() })) })
const sessionParams = z.object({ sessionId: text.optional(), mcpServers: z.array(z.unknown()).optional() })
const forkParams = z.object({ sessionId: text, before: text, mcpServers: z.array(z.unknown()).optional() })
const entry = z.object({
  type: text,
  id: text,
  parentId: text.nullable(),
  timestamp: text,
  message: z.object({ role: text.optional() }).optional().catch(undefined),
})
type Entry = z.infer<typeof entry>
const listing = z.object({ entries: z.array(z.unknown()), leafId: text.nullable() })
/** Entries that are not part of what the model sees: settings, labels, usage and an extension's own data. */
const OUTSIDE_CONTEXT = new Set(['model_change', 'thinking_level_change', 'label', 'session_info', 'custom', 'usage'])

/**
 * How to fork pi's record (`get_entries`) so that the new session holds what pi wrote before `before`, the time the
 * source's next turn began: `fork` before the first user message written since then on the branch pi is on, or, when
 * there is none, `clone` of the whole branch. `keep` is the entry the new session must end at. Or why it cannot.
 */
export function forkPlan(data: unknown, before: string): { command: Record<string, unknown>; keep: string } | string {
  const cut = Date.parse(before)
  const read = listing.safeParse(data)
  if (!Number.isFinite(cut) || !read.success) return '它的会话记录读不懂'
  const byId = new Map<string, Entry>()
  for (const raw of read.data.entries) {
    const parsed = entry.safeParse(raw)
    if (!parsed.success || byId.has(parsed.data.id)) return '它的会话记录读不懂'
    byId.set(parsed.data.id, parsed.data)
  }
  // Only the branch pi is on is what the model saw; other branches of its tree stay out.
  const branch: Entry[] = []
  for (let id = read.data.leafId; id !== null;) {
    const found = byId.get(id)
    if (!found || branch.length >= byId.size) return '它的会话记录不完整'
    branch.push(found)
    id = found.parentId
  }
  branch.reverse()
  const time = (item: Entry) => Date.parse(item.timestamp)
  if (branch.some(item => !Number.isFinite(time(item)))) return '它的会话记录缺少时间'
  const next = branch.findIndex(item => item.type === 'message' && item.message?.role === 'user' && time(item) >= cut)
  const kept = next < 0 ? branch : branch.slice(0, next)
  if (!kept.length) return '找不到来源会话在这一轮之前的记录'
  // A later turn that wrote no message of its own, such as a /compact, would otherwise come along.
  if (kept.some(item => !OUTSIDE_CONTEXT.has(item.type) && time(item) > cut)) return '它的记录在这一轮之后还有别的内容，例如压缩'
  return { command: next < 0 ? { type: 'clone' } : { type: 'fork', entryId: branch[next]!.id }, keep: kept.at(-1)!.id }
}

/** pi's entries after `keep` in the new session: none, or only ones outside what the model sees. */
function endsAt(data: unknown, keep: string): boolean {
  const read = listing.safeParse(data)
  if (!read.success) return false
  const added = read.data.entries.map(raw => entry.safeParse(raw))
  return (
    added.every(item => item.success && OUTSIDE_CONTEXT.has(item.data.type))
    && (read.data.leafId === keep || added.some(item => item.success && item.data.id === read.data.leafId))
  )
}

interface Pending {
  resolve(data: unknown): void
  reject(error: Error): void
  cleanup(): void
}

/** The prompt being run: answered once pi has settled it. */
interface Turn {
  resolve(result: unknown): void
  reject(error: Error): void
  cancelled: boolean
  /** A turn that is a `/compact`; `reported` once pi has shown its compaction, which then says how it went. */
  compaction?: { reported: boolean }
  /** How pi ended the last reply of the turn, and what it said when that was an error. */
  stopReason?: string
  errorMessage?: string
}

/** The reply pi is writing, and whether its text and thinking arrived in pieces or only at its end. */
interface Reply {
  id: string
  text: boolean
  thinking: boolean
}

/** One answer of pi's, or a refusal that says pi did not answer as its RPC mode does. */
function readAs<T>(schema: z.ZodType<T>, data: unknown, command: string): T {
  const parsed = schema.safeParse(data)
  if (!parsed.success) throw new RpcError(RPC.internal, `pi answered ${command} in a shape Latch does not read`)
  return parsed.data
}

/** What pi's tools report, as text: the edit tool's diff, the output a command printed, or the result's own text. */
function resultText(result: unknown): string {
  if (!isRecord(result)) return typeof result === 'string' ? result : ''
  const details = isRecord(result.details) ? result.details : {}
  if (typeof details.diff === 'string' && details.diff.trim()) return details.diff
  const content = Array.isArray(result.content) ? result.content : []
  return content.flatMap(item => (isRecord(item) && item.type === 'text' && typeof item.text === 'string' ? [item.text] : [])).join('')
}

const TOOL_KINDS: Readonly<Record<string, string>> = {
  read: 'read',
  edit: 'edit',
  write: 'edit',
  bash: 'execute',
  grep: 'search',
  find: 'search',
  ls: 'search',
}

/** A call named the way pi's own tools are: the tool, then what it was given. */
function toolTitle(tool: string, args: unknown): string {
  const input = isRecord(args) ? args : {}
  const subject = [input.command, input.path, input.pattern].find(value => typeof value === 'string' && value.trim())
  return clip(typeof subject === 'string' ? `${tool} ${subject}` : tool, 500)
}

function blocksText(content: unknown, type: 'text' | 'thinking'): string {
  if (!Array.isArray(content)) return ''
  const field = type === 'text' ? 'text' : 'thinking'
  return content
    .flatMap(item => (isRecord(item) && item.type === type && typeof item[field] === 'string' ? [item[field] as string] : []))
    .join('')
}

/** `pi --mode rpc` after the definition's arguments; refused when they set what this wire must. */
export function piArgs(args: readonly string[]): string[] {
  const reserved = args.find(arg => RESERVED.has(arg.split('=')[0]!))
  if (reserved !== undefined) throw new Error(`参数 ${clip(reserved, 64)} 由 Latch 设置，不能写在 pi 的定义里`)
  return [...args, ...PI_RPC_ARGS]
}

export class PiWire implements AgentWire {
  readonly exited: Promise<ExitInfo>
  readonly idleCommands: ReadonlySet<string> = new Set([COMPACT.name])
  readonly forks = true
  private readonly process: AgentProcess
  private nextId = 0
  private readonly pending = new Map<string, Pending>()
  /** The session file pi runs, which is the session's ID on this wire: pi resumes a session from its file. */
  private sessionId?: string
  /** pi may be on another session's file, or a copy of it that is not the fork asked for: Latch's must not go on there. */
  private foreign = false
  private turn?: Turn
  /** pi is running a turn's model calls and tools; an addition is taken only meanwhile. */
  private running = false
  private reply?: Reply
  private replies = 0
  private compactions = 0
  /** The session pi's own commands were listed for; a new session lists them again. */
  private listedFor?: string
  private models: PiModel[] = []
  private levels: string[] = []
  private current: { model?: PiModel; thinkingLevel?: string } = {}
  /** Records that came after an answer, kept until the code waiting on that answer has acted on it. */
  private held?: Array<Record<string, unknown>>

  private constructor(
    spec: SpawnSpec,
    private readonly handlers: WireHandlers,
  ) {
    this.process = AgentProcess.spawn(
      { ...spec, args: piArgs(spec.args) },
      { record: record => this.onRecord(record), closed: info => this.onClosed(info) },
    )
    this.exited = this.process.exited
  }

  /** Throws for arguments pi must not get; launch failures such as ENOENT arrive as an exit with `reason: 'spawn'`. */
  static spawn(spec: SpawnSpec, handlers: WireHandlers): PiWire {
    return new PiWire(spec, handlers)
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
        return this.open(sessionParams.safeParse(params).data?.sessionId ?? '', params, timeoutMs, signal)
      case FORK_METHOD:
        return this.fork(params, timeoutMs, signal)
      case 'session/prompt':
        return this.prompt(params)
      case 'session/set_config_option':
        return this.setOption(params, timeoutMs, signal)
      case STEER_METHOD:
        return this.steer(params, timeoutMs, signal)
      default:
        return Promise.reject(new RpcError(RPC.methodNotFound, `Method not found: ${clip(method, 200)}`))
    }
  }

  notify(method: string): void {
    if (method !== 'session/cancel' || !this.turn) return
    this.turn.cancelled = true
    // Without clearing it first, abort goes on with text queued by an addition to the turn. pi handles the clear before
    // it reads the abort.
    void this.send({ type: 'clear_queue' }).then(
      cleared => {
        const steering =
          isRecord(cleared) && Array.isArray(cleared.steering) ? cleared.steering.filter(item => typeof item === 'string') : []
        if (steering.length)
          this.update({
            sessionUpdate: 'notice',
            severity: 'info',
            title: '停止前追加的内容还没送到 pi，已撤回',
            description: clip(steering.join('\n'), 2000),
          })
      },
      () => {},
    )
    void this.send({ type: 'abort' }).catch(() => {})
  }

  stop(reason: 'stop' | 'kill', graceMs: number, cause?: string): Promise<ExitInfo> {
    return this.process.stop(reason, graceMs, cause)
  }

  stderrTail(limit?: number): string {
    return this.process.stderrTail(limit)
  }

  /** One pi command and its response's data. pi cannot withdraw a command, so a timeout only stops waiting. */
  private send(command: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    const exit = this.process.exit
    if (exit) return Promise.reject(new ConnectionClosed(exit))
    const id = `latch-${this.nextId++}`
    const type = String(command.type)
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
        timer = setTimeout(() => withdraw(new RequestTimeout(type)), timeoutMs)
        timer.unref()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, { resolve, reject, cleanup })
      this.process.write({ ...command, id })
    })
  }

  /**
   * pi has no handshake: its state answers that it speaks RPC, and the rest is what this wire does. pi reports no version
   * over RPC, so the newest command this wire relies on stands in for one: `clear_queue` (0.84.4) comes after
   * `agent_settled` (0.80.4), without which a turn never ends. Nothing is queued yet in a process that just started.
   */
  private async initialize(timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    readAs(state, await this.send({ type: 'get_state' }, timeoutMs, signal), 'get_state')
    await this.send({ type: 'clear_queue' }, timeoutMs, signal).catch((error: unknown) => {
      if (error instanceof RpcError && /^Unknown command\b/u.test(error.message))
        throw new AppError(
          409,
          'harness-version-unsupported',
          `pi 的版本低于 ${PI_MINIMUM}（它不认识 clear_queue），已拒绝启动。升级到 ${PI_MINIMUM} 或更高版本后再试。`,
        )
      throw error
    })
    return {
      protocolVersion: 1,
      agentInfo: { name: 'pi' },
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: true, embeddedContext: false },
        sessionCapabilities: { resume: {} },
      },
      _meta: { steering: { supported: true } },
    }
  }

  /** The session pi started with (`resume` undefined), or the one in that file; then what it offers. */
  private async open(resume: string | undefined, params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    if (sessionParams.safeParse(params).data?.mcpServers?.length) throw new RpcError(RPC.invalidParams, 'pi takes no MCP servers')
    // One process runs one session; a second new one must not share the file of the first, or of a fork's source.
    if (resume === undefined && (this.sessionId || this.foreign)) {
      const started = await this.send({ type: 'new_session' }, timeoutMs, signal)
      if (isRecord(started) && started.cancelled === true) throw new RpcError(RPC.internal, 'A pi extension cancelled the new session')
      this.foreign = false
    }
    if (resume !== undefined && resume !== this.sessionId) {
      if (!isAbsolute(resume) || !resume.endsWith('.jsonl')) throw new RpcError(RPC.notFound, 'Session not found')
      const switched = await this.send({ type: 'switch_session', sessionPath: resume }, timeoutMs, signal)
      if (isRecord(switched) && switched.cancelled === true)
        throw new RpcError(RPC.internal, 'A pi extension cancelled resuming the session')
      this.foreign = false
    }
    const read = readAs(state, await this.send({ type: 'get_state' }, timeoutMs, signal), 'get_state')
    if (!read.sessionFile) throw new RpcError(RPC.internal, 'pi did not say which file keeps the session')
    if (resume !== undefined && read.sessionFile !== resume) throw new RpcError(RPC.notFound, 'Session not found')
    const listed = readAs(models, await this.send({ type: 'get_available_models' }, timeoutMs, signal), 'get_available_models')
    this.models = listed.models.flatMap(entry => {
      const parsed = model.safeParse(entry)
      return parsed.success ? [parsed.data] : []
    })
    this.models = this.models.slice(0, MAX_MODELS)
    // pi with no model to use has no login or key for any provider: it cannot answer anything.
    if (!this.models.length) throw new RpcError(RPC.authRequired, 'pi has no model it can use')
    this.sessionId = read.sessionFile
    this.current = { ...(read.model ? { model: read.model } : {}), ...(read.thinkingLevel ? { thinkingLevel: read.thinkingLevel } : {}) }
    await this.readLevels(timeoutMs, signal)
    return { sessionId: this.sessionId, configOptions: this.options() }
  }

  /**
   * pi's own fork of the source session's file (`FORK_METHOD`): switched to the source, forked at the plan's point, and
   * opened as this process's session. When pi cannot, or its copy does not end where asked, a `ForkRefused` after pi
   * has left for a new session of its own; a pi that cannot leave is stopped, so nothing goes on in the source.
   */
  private async fork(params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    const parsed = forkParams.safeParse(params)
    if (!parsed.success) throw new RpcError(RPC.invalidParams, 'Invalid params')
    if (parsed.data.mcpServers?.length) throw new RpcError(RPC.invalidParams, 'pi takes no MCP servers')
    if (this.sessionId) throw new ForkRefused('这个进程已经打开了别的会话')
    const source = parsed.data.sessionId
    if (!isAbsolute(source) || !source.endsWith('.jsonl')) throw new ForkRefused('来源会话不是它的会话文件')
    this.foreign = true
    try {
      const switched = await this.send({ type: 'switch_session', sessionPath: source }, timeoutMs, signal)
      if (isRecord(switched) && switched.cancelled === true) throw new ForkRefused('它的扩展取消了打开来源会话')
      const plan = forkPlan(await this.send({ type: 'get_entries' }, timeoutMs, signal), parsed.data.before)
      if (typeof plan === 'string') throw new ForkRefused(plan)
      const forked = await this.send(plan.command, timeoutMs, signal)
      if (isRecord(forked) && forked.cancelled === true) throw new ForkRefused('它的扩展取消了分叉')
      const read = readAs(state, await this.send({ type: 'get_state' }, timeoutMs, signal), 'get_state')
      if (!read.sessionFile || read.sessionFile === source) throw new ForkRefused('它没有为分叉新建会话文件')
      // pi copies the branch with its entry IDs, so the copy is read from where it was asked to end.
      const copied = await this.send({ type: 'get_entries', since: plan.keep }, timeoutMs, signal).catch((error: unknown) => {
        if (error instanceof RpcError && error.code === RPC.internal) return undefined
        throw error
      })
      if (!endsAt(copied, plan.keep)) throw new ForkRefused('分叉出的记录没有停在这一轮')
    } catch (error) {
      if (!(error instanceof ConnectionClosed)) await this.leave(timeoutMs, signal)
      // pi's own refusal of a command, such as an entry it does not know.
      if (error instanceof RpcError && error.code === RPC.internal) throw new ForkRefused(`它回答「${clip(error.message, 200)}」`)
      throw error
    }
    this.foreign = false
    return this.open(undefined, { mcpServers: [] }, timeoutMs, signal)
  }

  /** From the source, or a copy that is not the fork, to a new session of pi's own; a pi that cannot is stopped. */
  private async leave(timeoutMs?: number, signal?: AbortSignal): Promise<void> {
    const left = await this.send({ type: 'new_session' }, timeoutMs, signal).catch(() => undefined)
    if (isRecord(left) && left.cancelled !== true) {
      this.foreign = false
      return
    }
    void this.process.stop('kill', 0)
    throw new ConnectionStopping()
  }

  /** The levels the current model takes; a pi too old to list them offers the one it runs at. */
  private async readLevels(timeoutMs?: number, signal?: AbortSignal): Promise<void> {
    try {
      const data = await this.send({ type: 'get_available_thinking_levels' }, timeoutMs, signal)
      this.levels = readAs(levels, data, 'get_available_thinking_levels').levels
    } catch (error) {
      if (
        error instanceof ConnectionClosed
        || error instanceof RequestTimeout
        || (error instanceof RpcError && error.code === RPC.cancelled)
      )
        throw error
      this.levels = this.current.thinkingLevel ? [this.current.thinkingLevel] : []
    }
  }

  private options(): unknown[] {
    const shown = this.current.model
    const options: unknown[] = []
    if (shown)
      options.push({
        type: 'select',
        id: MODEL,
        category: 'model',
        name: '模型',
        currentValue: `${shown.provider}/${shown.id}`,
        options: this.models.map(entry => ({
          value: `${entry.provider}/${entry.id}`,
          name: entry.name ?? entry.id,
          description: entry.provider,
        })),
      })
    const level = this.current.thinkingLevel
    if (level && this.levels.length)
      options.push({
        type: 'select',
        id: THOUGHT_LEVEL,
        category: 'thought_level',
        name: '思考',
        currentValue: level,
        options: (this.levels.includes(level) ? this.levels : [level, ...this.levels]).map(value => ({
          value,
          name: LEVEL_NAMES[value] ?? value,
        })),
      })
    return options
  }

  private assertSession(sessionId: string): void {
    if (!this.sessionId || sessionId !== this.sessionId) throw new RpcError(RPC.notFound, 'Session not found')
  }

  private async setOption(params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    const parsed = optionParams.safeParse(params)
    if (!parsed.success) throw new RpcError(RPC.invalidParams, 'Invalid params')
    this.assertSession(parsed.data.sessionId)
    const { configId, value } = parsed.data
    if (configId === MODEL) {
      const slash = value.indexOf('/')
      if (slash <= 0 || slash === value.length - 1) throw new RpcError(RPC.invalidParams, 'A pi model is provider/model')
      await this.send({ type: 'set_model', provider: value.slice(0, slash), modelId: value.slice(slash + 1) }, timeoutMs, signal)
    } else if (configId === THOUGHT_LEVEL) {
      await this.send({ type: 'set_thinking_level', level: value }, timeoutMs, signal)
    } else throw new RpcError(RPC.invalidParams, 'Unknown option')
    // Read back rather than assumed: a model change can move the thinking level, and pi may not take a value.
    const read = readAs(state, await this.send({ type: 'get_state' }, timeoutMs, signal), 'get_state')
    this.current = { ...(read.model ? { model: read.model } : {}), ...(read.thinkingLevel ? { thinkingLevel: read.thinkingLevel } : {}) }
    if (configId === MODEL) await this.readLevels(timeoutMs, signal)
    return { configOptions: this.options() }
  }

  private async prompt(params: unknown): Promise<unknown> {
    const parsed = promptParams.safeParse(params)
    if (!parsed.success) throw new RpcError(RPC.invalidParams, 'Invalid params')
    this.assertSession(parsed.data.sessionId)
    if (this.turn) throw new RpcError(RPC.internal, 'A turn is already running')
    const texts: string[] = []
    const images: Array<{ type: 'image'; data: string; mimeType: string }> = []
    for (const block of parsed.data.prompt) {
      if (block.type === 'text' && block.text !== undefined) texts.push(block.text)
      else if (block.type === 'image' && block.data && block.mimeType)
        images.push({ type: 'image', data: block.data, mimeType: block.mimeType })
      else throw new RpcError(RPC.invalidParams, `pi takes no ${clip(block.type, 64)} content`)
    }
    // Listed once the session has a turn, when the runtime surely knows it: it drops updates for a session it does not.
    if (this.listedFor !== this.sessionId) {
      this.listedFor = this.sessionId
      this.update({ sessionUpdate: 'available_commands_update', availableCommands: [COMPACT] })
    }
    const compact = images.length ? undefined : compactCommand(texts.join('\n\n'))
    const done = new Promise<unknown>((resolve, reject) => {
      this.turn = { resolve, reject, cancelled: false, ...(compact ? { compaction: { reported: false } } : {}) }
    })
    const turn = this.turn!
    // A process that exits before pi answers the prompt rejects the turn too, and nobody waits on it then.
    done.catch(() => {})
    if (compact) {
      // Answered once pi has compacted, failed or been stopped; there is no run to settle.
      const answered = (error?: unknown): void => {
        // An exit has already failed the turn.
        if (this.turn !== turn) return
        // A compaction pi reported says itself how it ended; a refusal before one is the turn's failure.
        if (error !== undefined && !turn.compaction!.reported && !turn.cancelled) {
          turn.stopReason = 'error'
          turn.errorMessage = error instanceof Error ? error.message : undefined
        }
        void this.settle(false)
      }
      this.send({ type: 'compact', ...compact }).then(() => answered(), answered)
      return done
    }
    let accepted: z.infer<typeof disposition>
    try {
      accepted = disposition.parse(await this.send({ type: 'prompt', message: texts.join('\n\n'), ...(images.length ? { images } : {}) }))
    } catch (error) {
      if (this.turn === turn) this.turn = undefined
      throw error
    }
    // An extension took the prompt as its own command: no run starts, so nothing will settle it.
    if (accepted?.disposition === 'handled') void this.settle(false)
    return done
  }

  private async steer(params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    const parsed = steerParams.safeParse(params)
    if (!parsed.success) throw new RpcError(RPC.invalidParams, 'Invalid params')
    this.assertSession(parsed.data.sessionId)
    const textOf = parsed.data.prompt.flatMap(block => (block.type === 'text' && block.text !== undefined ? [block.text] : []))
    // pi would abort the running turn to compact; it runs only between turns, never as text added to one.
    if (compactCommand(textOf.join('\n\n'))) throw new RpcError(RPC.invalidParams, '/compact runs only between turns')
    if (!this.turn || this.turn.cancelled || !this.running) return { outcome: 'promptRequired' }
    // pi queues it into the running turn, after the calls in flight and before the model's next request.
    await this.send({ type: 'steer', message: textOf.join('\n\n') }, timeoutMs, signal)
    return { outcome: 'injected' }
  }

  /** The turn's answer once pi has nothing left to do for it, with the session's usage read first. */
  private async settle(aborted: boolean): Promise<void> {
    const turn = this.turn
    if (!turn) return
    this.turn = undefined
    this.reply = undefined
    this.running = false
    let usage: { inputTokens: number; outputTokens: number } | undefined
    try {
      const read = readAs(stats, await this.send({ type: 'get_session_stats' }, STATS_TIMEOUT_MS), 'get_session_stats')
      if (read.tokens) usage = { inputTokens: read.tokens.input, outputTokens: read.tokens.output }
      const used = read.contextUsage?.tokens ?? undefined
      const size = read.contextUsage?.contextWindow ?? undefined
      if (used !== undefined || size || read.cost !== undefined)
        this.update({
          sessionUpdate: 'usage_update',
          ...(used !== undefined ? { used } : {}),
          ...(size ? { size } : {}),
          ...(read.cost !== undefined ? { cost: { amount: read.cost, currency: 'USD' } } : {}),
        })
    } catch {
      // The turn is over either way; its usage stays unknown.
    }
    if (turn.cancelled || aborted || turn.stopReason === 'aborted')
      return turn.resolve({ stopReason: 'cancelled', ...(usage ? { usage } : {}) })
    if (turn.stopReason === 'error')
      return turn.reject(new RpcError(RPC.internal, clip(redactKnownSecrets(turn.errorMessage || 'pi stopped with an error'), 4000)))
    turn.resolve({ stopReason: turn.stopReason === 'length' ? 'max_tokens' : 'end_turn', ...(usage ? { usage } : {}) })
  }

  private update(update: Record<string, unknown> & { sessionUpdate: string }): void {
    if (!this.sessionId) return
    try {
      this.handlers.notification('session/update', { sessionId: this.sessionId, update })
    } catch {
      this.process.noise++
    }
  }

  private onRecord(record: Record<string, unknown>): void {
    if (this.held) {
      this.held.push(record)
      return
    }
    if (record.type === 'response') {
      const id = record.id
      const entry = typeof id === 'string' ? this.pending.get(id) : undefined
      if (!entry) return
      this.pending.delete(id as string)
      entry.cleanup()
      if (record.success === true) entry.resolve(record.data)
      else entry.reject(new RpcError(RPC.internal, clip(typeof record.error === 'string' ? record.error : 'pi error', 4000)))
      // What pi wrote after an answer happened after it, so the answer is acted on first: an addition pi took is in the
      // session before the reply it led to, even when both arrive in one read.
      this.held = []
      setImmediate(() => this.release())
      return
    }
    try {
      this.onEvent(record)
    } catch {
      this.process.noise++
    }
  }

  private onEvent(event: Record<string, unknown>): void {
    switch (event.type) {
      case 'message_start': {
        const said = isRecord(event.message) ? event.message : {}
        if (said.role === 'assistant') this.reply = { id: `reply-${++this.replies}`, text: false, thinking: false }
        return
      }
      case 'message_update': {
        const piece = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : {}
        if (typeof piece.delta !== 'string' || !piece.delta || !this.reply) return
        if (piece.type === 'text_delta') {
          this.reply.text = true
          this.chunk('agent_message_chunk', piece.delta)
        } else if (piece.type === 'thinking_delta') {
          this.reply.thinking = true
          this.chunk('agent_thought_chunk', piece.delta)
        }
        return
      }
      case 'message_end':
        return this.endReply(event.message)
      case 'tool_execution_start': {
        if (typeof event.toolCallId !== 'string' || typeof event.toolName !== 'string') return
        this.reply = undefined
        this.update({
          sessionUpdate: 'tool_call',
          toolCallId: event.toolCallId,
          name: event.toolName,
          title: toolTitle(event.toolName, event.args),
          kind: TOOL_KINDS[event.toolName] ?? 'other',
          status: 'in_progress',
          rawInput: event.args,
        })
        return
      }
      case 'tool_execution_update':
      case 'tool_execution_end': {
        if (typeof event.toolCallId !== 'string') return
        const end = event.type === 'tool_execution_end'
        const output = clip(resultText(end ? event.result : event.partialResult), TOOL_TEXT_LIMIT)
        this.update({
          sessionUpdate: 'tool_call_update',
          toolCallId: event.toolCallId,
          ...(end ? { status: event.isError === true ? 'failed' : 'completed' } : {}),
          ...(output ? { content: [{ type: 'content', content: { type: 'text', text: output } }] } : {}),
        })
        return
      }
      case 'compaction_start':
        this.reply = undefined
        if (this.turn?.compaction) this.turn.compaction.reported = true
        this.update({ sessionUpdate: 'compaction_update', compactionId: `compaction-${++this.compactions}`, status: 'in_progress' })
        return
      case 'compaction_end': {
        const result = isRecord(event.result) ? event.result : undefined
        // pi puts its own "Compaction failed: " before the reason, which the row already says.
        const failed = typeof event.errorMessage === 'string' ? event.errorMessage.replace(/^Compaction failed: /u, '') : undefined
        this.update({
          sessionUpdate: 'compaction_update',
          compactionId: `compaction-${this.compactions}`,
          status: event.aborted === true ? 'cancelled' : failed !== undefined ? 'failed' : 'completed',
          ...(typeof result?.summary === 'string' ? { summary: [{ type: 'text', text: result.summary }] } : {}),
          // The summary request goes to the model service, whose error can echo part of a key.
          ...(failed !== undefined ? { error: clip(redactKnownSecrets(failed), 2000) } : {}),
        })
        return
      }
      case 'auto_retry_start':
        if (typeof event.errorMessage !== 'string' || !event.errorMessage) return
        this.reply = undefined
        this.update({
          sessionUpdate: 'notice',
          severity: 'warning',
          // A model service's error can echo part of a key.
          title: clip(redactKnownSecrets(event.errorMessage), 300),
          ...(typeof event.attempt === 'number' && typeof event.maxAttempts === 'number'
            ? { description: `第 ${event.attempt} 次重试，最多 ${event.maxAttempts} 次` }
            : {}),
        })
        return
      case 'extension_error':
        if (typeof event.error !== 'string' || !event.error) return
        this.update({
          sessionUpdate: 'notice',
          severity: 'error',
          title: clip(redactKnownSecrets(event.error), 300),
          ...(typeof event.extensionPath === 'string' ? { description: `扩展 ${clip(event.extensionPath, 500)}` } : {}),
        })
        return
      case 'thinking_level_changed':
        if (typeof event.level !== 'string' || !this.sessionId) return
        this.current.thinkingLevel = clip(event.level, 64)
        this.update({ sessionUpdate: 'config_option_update', configOptions: this.options() })
        return
      case 'session_info_changed':
        if (typeof event.name === 'string') this.update({ sessionUpdate: 'session_info_update', title: event.name })
        return
      case 'extension_ui_request':
        return this.onInterface(event)
      case 'agent_start':
        this.running = true
        return
      case 'agent_end':
        this.running = false
        return
      case 'agent_settled':
        // A `/compact` ends with pi's answer to it: there is no run of its own to settle.
        if (!this.turn?.compaction) void this.settle(event.aborted === true)
        return
      default:
        // Runs, turns, queues and the rest say nothing a session shows.
        return
    }
  }

  private chunk(kind: 'agent_message_chunk' | 'agent_thought_chunk', piece: string): void {
    this.update({ sessionUpdate: kind, messageId: this.reply?.id, content: { type: 'text', text: piece } })
  }

  /** The reply as pi finished it: how it ended, and its text when pi sent none of it in pieces. */
  private endReply(said: unknown): void {
    const reply = this.reply
    if (!isRecord(said) || said.role !== 'assistant') return
    if (this.turn) {
      this.turn.stopReason = typeof said.stopReason === 'string' ? said.stopReason : undefined
      this.turn.errorMessage = typeof said.errorMessage === 'string' ? said.errorMessage : undefined
    }
    if (reply && !reply.thinking) {
      const thinking = blocksText(said.content, 'thinking')
      if (thinking) this.chunk('agent_thought_chunk', thinking)
    }
    if (reply && !reply.text) {
      const written = blocksText(said.content, 'text')
      if (written) this.chunk('agent_message_chunk', written)
    }
    this.reply = undefined
  }

  /**
   * What a pi extension asks of the person. A confirmation is put to them like a permission request; any other dialog
   * goes to the runtime as a request it does not know, which it shows and refuses, and pi is told it was cancelled.
   */
  private onInterface(event: Record<string, unknown>): void {
    const id = event.id
    const method = event.method
    if (typeof id !== 'string' || typeof method !== 'string') return
    const answer = (reply: Record<string, unknown>) => this.process.write({ type: 'extension_ui_response', id, ...reply })
    if (method === 'notify') {
      if (typeof event.message === 'string' && event.message)
        this.update({
          sessionUpdate: 'notice',
          severity: typeof event.notifyType === 'string' ? event.notifyType : 'info',
          title: clip(event.message, 300),
        })
      return
    }
    if (!this.sessionId) {
      if (method === 'confirm' || DIALOGS.has(method)) answer({ cancelled: true })
      return
    }
    if (method === 'confirm') {
      const toolCallId = `confirm-${clip(id, 200)}`
      const title = clip(typeof event.title === 'string' && event.title ? event.title : 'pi 扩展请求确认', 500)
      this.handlers
        .request(
          'session/request_permission',
          {
            sessionId: this.sessionId,
            toolCall: {
              toolCallId,
              title,
              kind: 'other',
              status: 'pending',
              ...(typeof event.message === 'string' ? { rawInput: { message: event.message } } : {}),
            },
            options: CONFIRM_OPTIONS,
          },
          `ui-${id}`,
        )
        .then(
          result => {
            const outcome = isRecord(result) && isRecord(result.outcome) ? result.outcome : {}
            const chosen = outcome.outcome === 'selected' ? outcome.optionId : undefined
            answer(chosen === undefined ? { cancelled: true } : { confirmed: chosen === 'yes' })
            this.update({
              sessionUpdate: 'tool_call_update',
              toolCallId,
              status: chosen === 'yes' ? 'completed' : 'failed',
            })
          },
          () => answer({ cancelled: true }),
        )
      return
    }
    if (!DIALOGS.has(method)) return
    const { type: _type, id: _id, method: _method, ...asked } = event
    this.handlers
      .request(`extension_ui/${method}`, asked, `ui-${id}`)
      .catch(() => undefined)
      .finally(() => answer({ cancelled: true }))
  }

  private release(): void {
    const held = this.held ?? []
    this.held = undefined
    for (const record of held) this.onRecord(record)
  }

  private onClosed(info: ExitInfo): void {
    // Everything pi wrote before it exited is read before the exit is.
    while (this.held) this.release()
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
