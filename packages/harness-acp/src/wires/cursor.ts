/**
 * Cursor through its official TypeScript SDK (`@cursor/sdk`). The SDK runs the agent loop inside the process that loads
 * it, so this wire starts Latch's runner (`cursor-runner.ts`) with the Host's own Node in a process group of its own
 * and translates: the runtime's ACP methods become the runner's requests, and what the SDK streams becomes ACP session
 * updates. The runner holds the key from its environment only; nothing here sees or sends it.
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { AppError } from '@latch/sdk'
import { clip, TOOL_TEXT_LIMIT } from '../mapping.ts'
import { RPC, RpcError, STEER_METHOD, type TurnTokens } from '../protocol.ts'
import { AgentProcess, ConnectionClosed, ConnectionStopping, isRecord, RequestTimeout, type ExitInfo, type SpawnSpec } from './process.ts'
import type { AgentWire, WireHandlers } from './types.ts'

/** The modes the SDK route offers, strictest first; each is what the runner passes to the SDK (`cursor-runner.ts`). */
export const CURSOR_SDK_MODES = ['read-only', 'sandbox', 'full'] as const
const MODE_NAMES: Readonly<Record<string, string>> = { 'read-only': '只读', sandbox: '沙箱', full: '完全访问' }
const MODEL = 'model'
const MODE = 'mode'

/** Where the runner is: next to this file in the package's sources, or `dist/harness/` beside a Host bundle. */
function locateRunner(): string {
  const here = import.meta.url
  if (here.endsWith('.ts')) return fileURLToPath(new URL('../cursor-runner.ts', here))
  const folder = dirname(fileURLToPath(here))
  const candidates = [join(folder, '../harness/cursor-runner.js'), join(folder, 'harness/cursor-runner.js')]
  return candidates.find(path => existsSync(path)) ?? candidates[0]!
}

let testModule: string | undefined
let checked: boolean | undefined

/** Tests only: the module the runner loads in place of `@cursor/sdk` (`undefined` restores the SDK). */
export function setCursorSdkModule(module: string | undefined): void {
  testModule = module
  checked = undefined
}

/**
 * Whether this Host can run the SDK route: the runner is where a build or the sources put it and `@cursor/sdk` resolves
 * from there. Resolving reads the package's manifest only; nothing of the SDK is loaded into the Host.
 */
export function cursorSdkAvailable(): boolean {
  if (checked !== undefined) return checked
  const runner = locateRunner()
  try {
    checked = existsSync(runner) && (testModule !== undefined || Boolean(createRequire(runner).resolve('@cursor/sdk')))
  } catch {
    checked = false
  }
  return checked
}

/** The variable the SDK reads its key from; the only way the key reaches the runner. */
export const CURSOR_KEY_ENV = 'CURSOR_API_KEY'

/** What a launch shows of the runner: the Host's Node and the runner, never a value. */
export function cursorRunnerArgs(): string[] {
  return ['--disable-sigusr1', locateRunner(), ...(testModule ? ['--sdk', testModule] : [])]
}

const text = z.string()
const choice = z.object({ value: text.max(2048), name: text.max(500), description: text.max(1000).optional() })
const opened = z.object({
  agentId: text.min(1).max(512),
  mode: text.max(64),
  model: text.max(2048),
  models: z.array(choice).max(500),
})
const count = z.number().nonnegative().finite()
const tokens = z.object({
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count.optional().catch(undefined),
  cacheWriteTokens: count.optional().catch(undefined),
  reasoningTokens: count.optional().catch(undefined),
})
const ended = z.object({
  status: z.enum(['finished', 'error', 'cancelled']),
  usage: tokens.optional().catch(undefined),
  costCents: count.optional().catch(undefined),
  error: text.optional(),
})
const sessionParams = z.object({
  sessionId: text.optional(),
  cwd: text.optional(),
  mcpServers: z.array(z.unknown()).optional(),
  additionalDirectories: z.array(text).optional(),
})
const optionParams = z.object({ sessionId: text, configId: text, value: text.max(2048) })
const promptParams = z.object({
  sessionId: text,
  prompt: z.array(z.object({ type: text, text: text.optional(), data: text.optional(), mimeType: text.optional() })),
})

/** The SDK's public tool names as ACP kinds. */
const TOOL_KINDS: Readonly<Record<string, string>> = {
  shell: 'execute',
  read: 'read',
  edit: 'edit',
  write: 'edit',
  delete: 'delete',
  grep: 'search',
  glob: 'search',
  ls: 'search',
  semSearch: 'search',
  webFetch: 'fetch',
  webSearch: 'fetch',
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  cleanup(): void
}

function toolTitle(name: string, args: unknown): string {
  const input = isRecord(args) ? args : {}
  const subject = [input.command, input.path, input.pattern, input.query, input.url].find(
    value => typeof value === 'string' && value.trim(),
  )
  return clip(typeof subject === 'string' ? `${name} ${subject}` : name, 500)
}

function outputText(result: unknown): string {
  if (typeof result === 'string') return result
  if (result === undefined || result === null) return ''
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return ''
  }
}

export class CursorWire implements AgentWire {
  readonly exited: Promise<ExitInfo>
  private readonly process: AgentProcess
  private readonly store: string
  private nextId = 0
  private readonly pending = new Map<string, Pending>()
  private sessionId?: string
  private state?: z.infer<typeof opened>
  private turn?: { cancelled: boolean }
  private reply = 0
  private replyOpen = false

  private constructor(
    spec: SpawnSpec,
    private readonly handlers: WireHandlers,
  ) {
    // The session's private temporary directory, kept as long as the session: the SDK's record of the agent lives
    // there, and the transcripts it would otherwise write below `~/.cursor` (`CURSOR_DATA_DIR`, read by the SDK's bundle).
    const tmp = spec.env.TMPDIR
    if (!tmp) throw new Error('The Cursor SDK runner needs the session temporary directory')
    this.store = join(tmp, 'cursor-sdk-store')
    this.process = AgentProcess.spawn(
      {
        ...spec,
        command: process.execPath,
        args: cursorRunnerArgs(),
        env: { ...spec.env, CURSOR_DATA_DIR: join(tmp, 'cursor-data') },
      },
      { record: record => this.onRecord(record), closed: info => this.onClosed(info) },
    )
    this.exited = this.process.exited
  }

  static spawn(spec: SpawnSpec, handlers: WireHandlers): CursorWire {
    return new CursorWire(spec, handlers)
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
      case 'session/set_config_option':
        return this.setOption(params, timeoutMs, signal)
      case 'session/prompt':
        return this.prompt(params)
      case STEER_METHOD:
        return this.steer(params, timeoutMs, signal)
      default:
        return Promise.reject(new RpcError(RPC.methodNotFound, `Method not found: ${clip(method, 200)}`))
    }
  }

  notify(method: string, _params?: unknown): void {
    if (method !== 'session/cancel' || !this.turn) return
    this.turn.cancelled = true
    // Confirmed only by the prompt's own answer, once the SDK reports the run cancelled.
    void this.send({ type: 'cancel' }).catch(() => {})
  }

  stop(reason: 'stop' | 'kill', graceMs: number, cause?: string): Promise<ExitInfo> {
    return this.process.stop(reason, graceMs, cause)
  }

  stderrTail(limit?: number): string {
    return this.process.stderrTail(limit)
  }

  private send(request: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    const exit = this.process.exit
    if (exit) return Promise.reject(new ConnectionClosed(exit))
    const id = `latch-${this.nextId++}`
    const type = String(request.type)
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
      this.process.write({ ...request, id })
    })
  }

  private async initialize(timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    const hello = await this.send({ type: 'hello' }, timeoutMs, signal)
    if (!isRecord(hello) || hello.protocol !== 1)
      throw new RpcError(RPC.internal, 'The Cursor SDK runner answered in a shape Latch does not read')
    if (hello.key !== true) throw missingKey()
    return {
      protocolVersion: 1,
      agentInfo: { name: 'Cursor SDK' },
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: true, embeddedContext: false },
        sessionCapabilities: { resume: {} },
      },
      _meta: { steering: { supported: true } },
    }
  }

  private async open(resume: string | undefined, params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    const parsed = sessionParams.safeParse(params)
    if (!parsed.success) throw new RpcError(RPC.invalidParams, 'Invalid params')
    if (this.sessionId !== undefined) {
      if (resume !== undefined && resume === this.sessionId) return { sessionId: this.sessionId, configOptions: this.options() }
      throw new RpcError(RPC.internal, 'This process already runs a session')
    }
    const servers = (parsed.data.mcpServers ?? []).flatMap(server =>
      isRecord(server) && typeof server.command === 'string' ? [server] : [],
    )
    const answer = await this.send(
      {
        type: 'open',
        cwd: parsed.data.cwd,
        dirs: parsed.data.additionalDirectories ?? [],
        store: this.store,
        mode: CURSOR_SDK_MODES[0],
        ...(resume ? { agentId: resume } : {}),
        mcpServers: servers,
      },
      timeoutMs,
      signal,
    )
    const read = opened.safeParse(answer)
    if (!read.success) throw new RpcError(RPC.internal, 'The Cursor SDK runner answered in a shape Latch does not read')
    if (resume && read.data.agentId !== resume) throw new RpcError(RPC.notFound, 'Session not found')
    this.state = read.data
    this.sessionId = read.data.agentId
    return { sessionId: this.sessionId, configOptions: this.options() }
  }

  private options(): unknown[] {
    const state = this.state
    if (!state) return []
    const models = state.models.some(item => item.value === state.model)
      ? state.models
      : [{ value: state.model, name: state.model }, ...state.models]
    return [
      {
        type: 'select',
        id: MODEL,
        category: 'model',
        name: '模型',
        currentValue: state.model,
        options: models,
      },
      {
        type: 'select',
        id: MODE,
        category: 'mode',
        name: '权限',
        currentValue: state.mode,
        options: CURSOR_SDK_MODES.map(value => ({ value, name: MODE_NAMES[value] ?? value })),
      },
    ]
  }

  private assertSession(sessionId: string): void {
    if (!this.sessionId || sessionId !== this.sessionId) throw new RpcError(RPC.notFound, 'Session not found')
  }

  private async setOption(params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    const parsed = optionParams.safeParse(params)
    if (!parsed.success) throw new RpcError(RPC.invalidParams, 'Invalid params')
    this.assertSession(parsed.data.sessionId)
    const { configId, value } = parsed.data
    if (configId === MODE) {
      if (!(CURSOR_SDK_MODES as readonly string[]).includes(value)) throw askUnavailable()
    } else if (configId !== MODEL) throw new RpcError(RPC.invalidParams, 'Unknown option')
    // Read back from the runner, which reports the options it gave the SDK.
    const read = opened.safeParse(await this.send({ type: 'configure', [configId]: value }, timeoutMs, signal))
    if (!read.success) throw new RpcError(RPC.internal, 'The Cursor SDK runner answered in a shape Latch does not read')
    this.state = read.data
    return { configOptions: this.options() }
  }

  private async prompt(params: unknown): Promise<unknown> {
    const parsed = promptParams.safeParse(params)
    if (!parsed.success) throw new RpcError(RPC.invalidParams, 'Invalid params')
    this.assertSession(parsed.data.sessionId)
    if (this.turn) throw new RpcError(RPC.internal, 'A turn is already running')
    const texts: string[] = []
    const images: Array<{ data: string; mimeType: string }> = []
    for (const block of parsed.data.prompt) {
      if (block.type === 'text' && block.text !== undefined) texts.push(block.text)
      else if (block.type === 'image' && block.data && block.mimeType) images.push({ data: block.data, mimeType: block.mimeType })
      else throw new RpcError(RPC.invalidParams, `Cursor's SDK takes no ${clip(block.type, 64)} content`)
    }
    const turn = { cancelled: false }
    this.turn = turn
    this.replyOpen = false
    try {
      const answer = ended.safeParse(await this.send({ type: 'prompt', text: texts.join('\n\n'), images }))
      if (!answer.success) throw new RpcError(RPC.internal, 'The Cursor SDK runner answered in a shape Latch does not read')
      const { status, usage, costCents, error } = answer.data
      if (costCents !== undefined) this.update({ sessionUpdate: 'usage_update', cost: { amount: costCents / 100, currency: 'USD' } })
      const counted: TurnTokens | undefined = usage && {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(usage.cacheReadTokens !== undefined ? { cachedReadTokens: usage.cacheReadTokens } : {}),
        ...(usage.cacheWriteTokens !== undefined ? { cachedWriteTokens: usage.cacheWriteTokens } : {}),
        ...(usage.reasoningTokens !== undefined ? { thoughtTokens: usage.reasoningTokens } : {}),
      }
      if (status === 'cancelled') return { stopReason: 'cancelled', ...(counted ? { usage: counted } : {}) }
      if (status === 'error') throw new RpcError(RPC.internal, clip(error || 'Cursor 的 SDK 报告这一轮失败', 4000))
      return { stopReason: 'end_turn', ...(counted ? { usage: counted } : {}) }
    } finally {
      if (this.turn === turn) this.turn = undefined
    }
  }

  private async steer(params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    const parsed = promptParams.safeParse(params)
    if (!parsed.success) throw new RpcError(RPC.invalidParams, 'Invalid params')
    this.assertSession(parsed.data.sessionId)
    if (!this.turn || this.turn.cancelled) return { outcome: 'promptRequired' }
    const said = parsed.data.prompt.flatMap(block => (block.type === 'text' && block.text !== undefined ? [block.text] : []))
    const answer = await this.send({ type: 'steer', text: said.join('\n\n') }, timeoutMs, signal)
    return { outcome: isRecord(answer) && answer.outcome === 'injected' ? 'injected' : 'promptRequired' }
  }

  private update(update: Record<string, unknown> & { sessionUpdate: string }): void {
    if (!this.sessionId) return
    try {
      this.handlers.notification('session/update', { sessionId: this.sessionId, update })
    } catch {
      this.process.noise++
    }
  }

  private chunk(kind: 'agent_message_chunk' | 'agent_thought_chunk', piece: string): void {
    if (!this.replyOpen) {
      this.reply++
      this.replyOpen = true
    }
    this.update({ sessionUpdate: kind, messageId: `reply-${this.reply}`, content: { type: 'text', text: piece } })
  }

  private onRecord(record: Record<string, unknown>): void {
    if (typeof record.id === 'string' && ('result' in record || 'error' in record)) {
      const entry = this.pending.get(record.id)
      if (!entry) return
      this.pending.delete(record.id)
      entry.cleanup()
      if ('error' in record) entry.reject(runnerError(record.error))
      else entry.resolve(record.result)
      return
    }
    if (typeof record.event === 'string' && this.turn) this.onEvent(record)
  }

  private onEvent(event: Record<string, unknown>): void {
    switch (event.event) {
      case 'text':
      case 'thinking':
        if (typeof event.text === 'string' && event.text)
          this.chunk(event.event === 'text' ? 'agent_message_chunk' : 'agent_thought_chunk', event.text)
        return
      case 'tool': {
        if (typeof event.callId !== 'string' || !event.callId || typeof event.name !== 'string') return
        this.replyOpen = false
        const toolCallId = clip(event.callId, 256)
        if (event.status === 'running') {
          this.update({
            sessionUpdate: 'tool_call',
            toolCallId,
            name: event.name,
            title: toolTitle(event.name, event.args),
            kind: TOOL_KINDS[event.name] ?? 'other',
            status: 'in_progress',
            ...(event.args !== undefined ? { rawInput: event.args } : {}),
          })
          return
        }
        const output = clip(outputText(event.result), TOOL_TEXT_LIMIT)
        this.update({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: event.status === 'error' ? 'failed' : 'completed',
          ...(output ? { content: [{ type: 'content', content: { type: 'text', text: output } }] } : {}),
        })
        return
      }
      case 'notice':
        if (typeof event.message === 'string' && event.message)
          this.update({ sessionUpdate: 'notice', severity: 'warning', title: clip(event.message, 300) })
        return
      default:
        return
    }
  }

  private onClosed(info: ExitInfo): void {
    const closed = new ConnectionClosed(info)
    for (const entry of this.pending.values()) {
      entry.cleanup()
      entry.reject(closed)
    }
    this.pending.clear()
    this.turn = undefined
    this.handlers.exit(info)
  }
}

function missingKey(): AppError {
  return new AppError(409, 'cursor-key-missing', 'Cursor 的 SDK 路线需要定义里的 CURSOR_API_KEY；请在这台 Mac 上的 Harness 设置里填写。')
}

function askUnavailable(): AppError {
  return new AppError(
    409,
    'permission-ask-unavailable',
    'Cursor 的 SDK 路线不能逐次问你：它只有只读、沙箱与完全访问三档。要逐次询问，请去掉定义里的 CURSOR_API_KEY，改用 cursor-agent acp。',
  )
}

/** The runner's refusal as the runtime reads failures: not found, not logged in, or the SDK's own words. */
function runnerError(error: unknown): Error {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'failed'
  const message = isRecord(error) && typeof error.message === 'string' ? clip(error.message, 2000) : 'Cursor SDK runner error'
  if (code === 'no-key') return missingKey()
  if (code === 'not-found') return new RpcError(RPC.notFound, 'Session not found')
  if (code === 'auth') return new RpcError(RPC.authRequired, message)
  return new RpcError(RPC.internal, message)
}
