/**
 * OpenCode's own server (`opencode serve`): HTTP and one event stream on a loopback port the server picks, behind HTTP
 * Basic authentication with a password made for this process. The runtime keeps speaking ACP; this wire answers its
 * methods with the server's API and turns the server's events into ACP session updates the way `opencode acp` does
 * (OpenCode 2.2.6's `packages/cli/src/acp/`, which is itself a client of this API), so modes, option IDs, session IDs and
 * the profile's readings are those of the ACP route. Shapes are checked against the OpenAPI document of a running 2.2.6
 * (`/openapi.json`) and its recorded events.
 */
import { randomBytes, randomInt } from 'node:crypto'
import { chmodSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { isDeepStrictEqual } from 'node:util'
import { isAbsolute, join, resolve } from 'node:path'
import { redactKnownSecrets } from '@latch/core/node-kit'
import { AppError } from '@latch/sdk'
import { clip } from '../mapping.ts'
import { RPC, RpcError } from '../protocol.ts'
import { OPENCODE_DIRECT_MINIMUM, OPENCODE_RULES } from '../profiles/opencode.ts'
import { PERMISSION_FACTS, RELEASE_CLAIM } from '../protocol.ts'
import { compareVersions } from '../semver.ts'
import {
  addTokens,
  canonicalName,
  childMeta,
  childTitle,
  childToolCallId,
  compactionEnded,
  compactionFailed,
  compactionStarted,
  completedToolUpdate,
  errorToolUpdate,
  fileDiffs,
  formAnswer,
  formSchema,
  pendingToolCall,
  permissionLocations,
  permissionTitle,
  preparePrompt,
  projectChild,
  promptUsage,
  readTokens,
  reasoningMessageId,
  replayUpdates,
  runningToolUpdate,
  totalTokens,
  UNSHOWN_QUESTION,
  type Child,
  type Compaction,
  type Json,
  type Tokens,
  type Update,
} from './opencode-events.ts'
import { AgentProcess, ConnectionClosed, ConnectionStopping, isRecord, RequestTimeout, type ExitInfo, type SpawnSpec } from './process.ts'
import type { AgentWire, WireHandlers } from './types.ts'

/**
 * Appended to the definition's arguments: the server, on loopback, on a port it picks itself, in its `--stdio` mode
 * (2.2.6 `server-process.ts`), the one OpenCode's own private servers use: it says where it listens as one JSON line,
 * drops the password from its own environment once read, so no tool, MCP server or language server it starts inherits
 * it, and ends when its standard input closes, so a Host that dies leaves no server behind. Its warnings go to stderr,
 * where a failed start's reasons are read.
 */
export const OPENCODE_SERVE_ARGS: readonly string[] = [
  'serve',
  '--stdio',
  '--hostname',
  '127.0.0.1',
  '--port',
  '0',
  '--print-logs',
  '--log-level',
  'warn',
]
/** The logging flags above, which a definition may set itself. */
const LOG_FLAGS = new Set(['--print-logs', '--log-level'])
/** Server flags that would make it listen elsewhere or serve another way, and global flags that end it: this wire decides them. */
const RESERVED = new Set([
  '--hostname',
  '--port',
  '--stdio',
  '--service',
  '--cors',
  '--server',
  '--standalone',
  '--wizard',
  '--completions',
  '--help',
  '-h',
  '--version',
  '-v',
])
/** Global flags that take the next argument as their value. */
const VALUE_FLAGS = new Set(['--log-level'])

/**
 * `opencode … serve …` after the definition's arguments; refused when they set what this wire must. A word that is no
 * flag's value would be read as the subcommand (`acp`, `run`, …), so only flags are taken.
 */
export function opencodeArgs(args: readonly string[]): string[] {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    const flag = arg.split('=')[0]!
    if (RESERVED.has(flag) || !arg.startsWith('-')) throw new Error(`参数 ${clip(arg, 64)} 由 Latch 设置，不能写在 OpenCode 的定义里`)
    if (VALUE_FLAGS.has(arg)) index++
  }
  const named = new Set(args.map(arg => arg.split('=')[0]!))
  const serve: string[] = []
  for (let index = 0; index < OPENCODE_SERVE_ARGS.length; index++) {
    const arg = OPENCODE_SERVE_ARGS[index]!
    const value = VALUE_FLAGS.has(arg)
    if (LOG_FLAGS.has(arg) && named.has(arg)) {
      if (value) index++
      continue
    }
    serve.push(arg)
  }
  return [...args, ...serve]
}

/** The variables 2.x reads its server password from (`OPENCODE_PASSWORD` first, the documented legacy name after it). */
const PASSWORD_ENV = ['OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD']
/**
 * A plugin of Latch's own that blanks the password in the environment of the commands OpenCode's shell tool runs: 2.2.6
 * passes its whole environment to them, password included, although its own clients' code means to leave it out. A
 * command could otherwise answer the server's permission requests itself. Same mechanism as the gateway's plugin.
 */
const PASSWORD_PLUGIN_DIR = 'latch-opencode-server'
const PASSWORD_PLUGIN = `export default {
  id: 'latch.server-password',
  async setup(context) {
    const registration = await context.shell.hook('create.before', invocation => {
      for (const name of Object.keys(invocation.env)) {
        const upper = name.toUpperCase()
        if (upper === 'OPENCODE_PASSWORD' || upper === 'OPENCODE_SERVER_PASSWORD') invocation.env[name] = ''
      }
    });
    return () => registration.dispose();
  },
};\n`

/**
 * Writes the plugin into the process's own temporary directory, afresh, and names it in the configuration given. Without
 * either the server does not start: its commands would see the password.
 */
function withPasswordPlugin(env: NodeJS.ProcessEnv): void {
  const tmp = env.TMPDIR
  if (!tmp) throw new Error('OpenCode 的进程没有自己的临时目录，Latch 无法让它运行的命令看不到服务口令')
  const config = latchConfig(env.OPENCODE_CONFIG_CONTENT)
  const directory = join(realpathSync(tmp), PASSWORD_PLUGIN_DIR)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, 'index.ts')
  const partial = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(partial, PASSWORD_PLUGIN, { mode: 0o600 })
  chmodSync(partial, 0o600)
  renameSync(partial, path)
  const plugins = Array.isArray(config.plugins) ? config.plugins : []
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...config, plugins: [...plugins, directory] })
}

/**
 * The configuration Latch hands OpenCode, parsed, when it holds Latch's rules exactly as the profile writes them; else
 * the server does not start. OpenCode 2.2.6 starts on content it cannot parse and then asks nothing at all (its own
 * `* allow`), and skips a value it does not take while the rest still loads: only JSON that carries every rule goes.
 */
export function latchConfig(content: string | undefined): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = content === undefined ? undefined : JSON.parse(content)
  } catch {
    parsed = undefined
  }
  if (!isRecord(parsed)) throw new Error('OPENCODE_CONFIG_CONTENT 不是 JSON 对象，Latch 设置的询问规则不会生效，没有启动 OpenCode')
  const agents = isRecord(parsed.agent) ? parsed.agent : {}
  const holds =
    isDeepStrictEqual(parsed.permission, OPENCODE_RULES.permission)
    && Object.entries(OPENCODE_RULES.agent).every(
      ([id, agent]) => isRecord(agents[id]) && isDeepStrictEqual((agents[id] as Record<string, unknown>).permission, agent.permission),
    )
  if (!holds) throw new Error('OPENCODE_CONFIG_CONTENT 缺少 Latch 设置的询问规则，没有启动 OpenCode')
  return parsed
}

/** The user name 2.x's own clients send; 1.x let `OPENCODE_SERVER_USERNAME` change it, which 2.x does not read. */
const USER = 'opencode'
/** `opencode serve --stdio` says where it listens as `{"url": …}`; only the loopback address it was told to use is taken. */
const LISTENING = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/u
const RESPONSE_LIMIT = 64 * 1024 * 1024
const RETRY_META = 'opencode/retry'
const COMPACTION_META = 'opencode/compaction'
const DIRECTORIES_KEY = 'opencode.acp.additionalDirectories'
const AUTH_METHOD = 'opencode-login'
/** OpenCode's built-in `/compact`, which its server runs as a compaction rather than a command. */
const BUILTIN_COMMANDS = new Map([['compact', 'Compact the session']])
const PERMISSION_OPTIONS = [
  { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
  { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
  { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
]
/** A command's prompt is queued by the server after it answers; how long to wait for it to show up. */
const COMMAND_QUEUE_MS = 5_000
/** A location's catalog may be empty while it starts its plugins and providers. */
const CATALOG_POLL_MS = 25
const CATALOG_WAIT_MS = 5_000
const DEFAULT_VARIANT = 'default'
/** How long a stop waits for the server's runs to end after interrupting them, at most. */
const STOP_INTERRUPT_MS = 2_000
/** How long releasing a leftover claim waits for the session to read as idle. */
const CLAIM_RELEASE_MS = 3_000
const SAVED_RULES_MAX = 20
/** The provider the gateway's configuration adds (`profiles/opencode.ts`). */
const GATEWAY_PROVIDER = 'latch'

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const rec = (value: unknown): Json => (isRecord(value) ? value : {})
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** OpenCode's own IDs: 48 bits of time and a counter, then random base62, so they sort by when they were made. */
let idTime = 0
let idCount = 0
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
export function messageId(now = Date.now()): string {
  if (now !== idTime) {
    idTime = now
    idCount = 0
  }
  idCount++
  const value = BigInt(now) * 0x1000n + BigInt(idCount)
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, '0'),
  ).join('')
  return `msg_${time}${Array.from({ length: 14 }, () => BASE62[randomInt(62)]).join('')}`
}

interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

interface ModelInfo {
  providerID: string
  id: string
  name: string
  variants: string[]
  context?: number
}

interface Catalog {
  models: ModelInfo[]
  defaultModel: ModelRef
  modes: Array<{ id: string; name: string; description?: string }>
  defaultModeID: string
  commands: Array<{ name: string; description?: string }>
}

interface Attached {
  id: string
  cwd: string
  selection: { model?: ModelRef; modeID?: string }
  /** The commands and options last told to the runtime, once a turn has made the session known to it. */
  shown?: { commands: string; options: string }
  mcp: Map<string, string>
}

interface Tool {
  sessionID: string
  id: string
  name: string
  input: Json
  metadata: unknown
}

type Terminal = 'succeeded' | 'failed' | 'interrupted'

interface Turn {
  sessionId: string
  cwd: string
  /** The inbox item that starts the run: Latch's own ID, or for a command the one the server queued for it. */
  startId?: string
  started: boolean
  cancelled: boolean
  interrupted: boolean
  /** Settles once the requests that hand the prompt to the server have been answered. */
  submitted: Promise<void>
  tools: Map<string, Tool>
  compactions: Map<string, Compaction>
  retries: Map<string, Json>
  finish?: string
  usage?: { turn: Tokens; last?: Tokens }
  stepError?: Json
  executionError?: Json
  resolve(result: unknown): void
  reject(error: Error): void
}

interface Ask {
  root: string
  sessionID: string
  kind: 'permission' | 'form'
  settled: boolean
}

function modelRef(value: unknown): ModelRef | undefined {
  const model = rec(value)
  if (typeof model.providerID !== 'string' || typeof model.id !== 'string') return undefined
  return { providerID: model.providerID, id: model.id, ...(typeof model.variant === 'string' ? { variant: model.variant } : {}) }
}

const advertised = (model: { providerID: string; id: string }): string => `${model.providerID}/${model.id}`

function sameDirectory(a: string, b: string): boolean {
  const real = (path: string) => {
    try {
      return realpathSync(path)
    } catch {
      return resolve(path)
    }
  }
  return real(a) === real(b)
}

/** Grants for the other folders a session may use, as `opencode acp` stores them, so the routes read each other's. */
function directoryRules(directories: readonly string[]): Json[] {
  const both = directories.flatMap(directory => {
    let real = directory
    try {
      real = realpathSync(directory)
    } catch {
      /* A folder not there yet is granted as written. */
    }
    return [directory, real]
  })
  return [...new Set(both)].map(directory => ({ action: 'external_directory', resource: join(directory, '*'), effect: 'allow' }))
}

function parseDirectories(cwd: string, directories: unknown): string[] {
  if (!isAbsolute(cwd)) throw new RpcError(RPC.invalidParams, 'cwd must be an absolute path')
  const list = Array.isArray(directories) ? directories : []
  const invalid = list.find(directory => typeof directory !== 'string' || !isAbsolute(directory) || /[*?]/u.test(directory))
  if (invalid !== undefined) throw new RpcError(RPC.invalidParams, 'additional directory must be an absolute path without glob characters')
  return [...new Set((list as string[]).map(directory => resolve(directory)))].filter(directory => !sameDirectory(directory, cwd))
}

function storedDirectories(session: Json): string[] {
  const stored = rec(session.metadata)[DIRECTORIES_KEY]
  return Array.isArray(stored) ? stored.filter((item): item is string => typeof item === 'string') : []
}

function mcpConfig(server: Json): Json {
  if (server.type === 'http') {
    const headers = Array.isArray(server.headers) ? server.headers.filter(isRecord) : []
    return {
      type: 'remote',
      url: server.url,
      headers: Object.fromEntries(headers.map(header => [header.name, header.value])),
      oauth: false,
    }
  }
  if (server.type !== undefined) throw new RpcError(RPC.invalidParams, 'Only stdio and HTTP MCP servers are supported')
  const env = Array.isArray(server.env) ? server.env.filter(isRecord) : []
  const args = Array.isArray(server.args) ? server.args : []
  // The server starts these with its own environment underneath: the password is blanked for them too.
  return {
    type: 'local',
    command: [server.command, ...args],
    environment: {
      ...Object.fromEntries(env.map(entry => [entry.name, entry.value])),
      ...Object.fromEntries(PASSWORD_ENV.map(name => [name, ''])),
    },
  }
}

function configOptions(catalog: Catalog, selection: Attached['selection']): Json[] {
  const model = selection.model ?? catalog.defaultModel
  const variants = catalog.models.find(item => item.providerID === model.providerID && item.id === model.id)?.variants ?? []
  const effort =
    !model.variant || model.variant === DEFAULT_VARIANT
      ? DEFAULT_VARIANT
      : variants.includes(model.variant)
        ? model.variant
        : variants.includes(DEFAULT_VARIANT)
          ? DEFAULT_VARIANT
          : (variants[0] ?? DEFAULT_VARIANT)
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: advertised(model),
      options: catalog.models
        .toSorted((a, b) => (a.providerID < b.providerID ? -1 : a.providerID > b.providerID ? 1 : a.name.localeCompare(b.name)))
        .map(item => ({ value: advertised(item), name: `${item.providerID}/${item.name}` })),
    },
    ...(variants.length
      ? [
          {
            id: 'effort',
            name: 'Effort',
            description: 'Available effort levels for this model',
            category: 'thought_level',
            type: 'select',
            currentValue: effort,
            options: [...new Set([...variants, DEFAULT_VARIANT])].map(variant => ({
              value: variant,
              name: variant
                .split(/[_-]/u)
                .map(part => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
                .join(' '),
            })),
          },
        ]
      : []),
    {
      id: 'mode',
      name: 'Session Mode',
      category: 'mode',
      type: 'select',
      currentValue: selection.modeID ?? catalog.defaultModeID,
      options: catalog.modes.map(mode => ({
        value: mode.id,
        name: mode.name,
        ...(mode.description ? { description: mode.description } : {}),
      })),
    },
  ]
}

function availableCommands(catalog: Catalog): Json[] {
  return [
    ...catalog.commands.map(command => ({ name: command.name, description: command.description ?? '' })),
    ...Array.from(BUILTIN_COMMANDS, ([name, description]) => ({ name, description })),
  ]
}

/** A change of one option as the server takes it: a model (with its effort) or an agent. */
function resolveChange(
  catalog: Catalog,
  selection: Attached['selection'],
  configId: string,
  value: string,
): { model: ModelRef } | { modeID: string } {
  const current = selection.model ?? catalog.defaultModel
  const find = (ref: { providerID: string; id: string }) =>
    catalog.models.find(item => item.providerID === ref.providerID && item.id === ref.id)
  switch (configId) {
    case 'model': {
      let picked: ModelRef | undefined
      const exact = catalog.models.find(item => advertised(item) === value)
      if (exact) picked = { providerID: exact.providerID, id: exact.id }
      else {
        const separator = value.lastIndexOf('/')
        const variant = value.slice(separator + 1)
        const base = catalog.models.find(item => advertised(item) === value.slice(0, separator) && item.variants.includes(variant))
        if (base) picked = { providerID: base.providerID, id: base.id, variant }
      }
      const model = picked && find(picked)
      if (!picked || !model) throw new RpcError(RPC.invalidParams, `model not found: ${clip(value, 200)}`)
      const variant =
        picked.variant
        ?? (current.providerID === model.providerID
        && current.id === model.id
        && (current.variant === DEFAULT_VARIANT || (current.variant !== undefined && model.variants.includes(current.variant)))
          ? current.variant
          : undefined)
      return { model: { providerID: model.providerID, id: model.id, ...(variant ? { variant } : {}) } }
    }
    case 'effort': {
      const model = find(current)
      if (!model || (value !== DEFAULT_VARIANT && !model.variants.includes(value)))
        throw new RpcError(RPC.invalidParams, `effort not found: ${clip(value, 64)}`)
      return { model: { ...current, variant: value } }
    }
    case 'mode': {
      const mode = catalog.modes.find(item => item.id === value)
      if (!mode) throw new RpcError(RPC.invalidParams, `mode not found: ${clip(value, 200)}`)
      return { modeID: mode.id }
    }
    default:
      throw new RpcError(RPC.invalidParams, `unknown config option: ${clip(configId, 200)}`)
  }
}

/** An answer of the server that is not a success, as an error the runtime reads like an agent's. */
class ServerAnswer extends RpcError {
  constructor(
    readonly status: number,
    readonly tag: string | undefined,
    code: number,
    message: string,
  ) {
    super(code, message)
  }
}

export class OpencodeWire implements AgentWire {
  readonly exited: Promise<ExitInfo>
  private readonly process: AgentProcess
  private readonly password = randomBytes(32).toString('base64url')
  private readonly authorization: string
  private readonly agent = new http.Agent({ keepAlive: true, maxSockets: 32 })
  private readonly redact: (text: string) => string
  private readonly maxLineBytes: number
  /** On Latch's model service: the configuration adds its provider. */
  private readonly routed: boolean
  private port?: number
  private readonly listening: Promise<number>
  private onListening!: (port: number) => void
  private events?: http.ClientRequest
  private connected?: Promise<void>
  private onConnected?: () => void
  private initialized = false
  private formElicitation = false
  private standardCompaction = false
  private readonly catalogs = new Map<string, Promise<Catalog>>()
  private readonly sessions = new Map<string, Attached>()
  private readonly unprompted = new Set<string>()
  private readonly children = new Map<string, Child>()
  private readonly turns = new Map<string, Turn>()
  private readonly asks = new Map<string, Ask>()
  /** Sessions the server is running, by its execution events. */
  private readonly running = new Set<string>()

  private constructor(
    spec: SpawnSpec,
    private readonly handlers: WireHandlers,
  ) {
    const password = this.password
    this.redact = (text: string) => spec.redact(text.split(password).join('[redacted]'))
    this.maxLineBytes = spec.maxLineBytes
    this.authorization = `Basic ${Buffer.from(`${USER}:${password}`).toString('base64')}`
    this.listening = new Promise(resolve => {
      this.onListening = resolve
    })
    const env: NodeJS.ProcessEnv = {}
    for (const [name, value] of Object.entries(spec.env)) {
      const upper = name.toUpperCase()
      if (PASSWORD_ENV.includes(upper) || upper === 'OPENCODE_SERVER_USERNAME') continue
      env[name] = value
    }
    // Only in the server's environment: never an argument, a file, a URL or a log line; the plugin keeps it from the
    // commands its shell tool runs.
    for (const name of PASSWORD_ENV) env[name] = password
    withPasswordPlugin(env)
    const providers = rec(rec(JSON.parse(env.OPENCODE_CONFIG_CONTENT!) as unknown).providers)
    this.routed = isRecord(providers[GATEWAY_PROVIDER])
    this.process = AgentProcess.spawn(
      { ...spec, args: opencodeArgs(spec.args), env, redact: this.redact },
      {
        record: record => this.onReady(record),
        closed: info => this.onClosed(info),
      },
      // `--stdio` ends with its standard input: a stop closes it first, and SIGTERM only follows the grace.
      { endsWithStdin: true },
    )
    this.exited = this.process.exited
  }

  /** Throws for arguments OpenCode must not get; launch failures such as ENOENT arrive as an exit with `reason: 'spawn'`. */
  static spawn(spec: SpawnSpec, handlers: WireHandlers): OpencodeWire {
    return new OpencodeWire(spec, handlers)
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
    const run = (): Promise<unknown> => {
      const p = rec(params)
      switch (method) {
        case 'initialize':
          return this.initialize(p, timeoutMs)
        case 'authenticate':
          if (p.methodId !== AUTH_METHOD) throw new RpcError(RPC.invalidParams, 'unknown auth method')
          return Promise.resolve({})
        case 'session/new':
          return this.newSession(p)
        case 'session/resume':
          return this.resume(p, false)
        case 'session/load':
          return this.resume(p, true)
        case 'session/list':
          return this.list(p)
        case 'session/close':
          return this.close(p)
        case 'session/delete':
          return this.remove(p)
        case 'session/set_config_option':
          return this.setOption(p)
        case 'session/set_mode':
          return this.setOption({ sessionId: p.sessionId, configId: 'mode', value: p.modeId }).then(() => ({}))
        case 'session/prompt':
          return this.prompt(p)
        default:
          throw new RpcError(RPC.methodNotFound, `Method not found: ${clip(method, 200)}`)
      }
    }
    let operation: Promise<unknown>
    try {
      operation = run()
    } catch (error) {
      return Promise.reject(error)
    }
    // A prompt runs until the server ends its run; the others are bounded by the caller.
    if (!timeoutMs && !signal) return operation
    return new Promise((resolvePromise, rejectPromise) => {
      let timer: NodeJS.Timeout | undefined
      const done = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = () => {
        done()
        rejectPromise(new RpcError(RPC.cancelled, 'Request cancelled'))
      }
      if (timeoutMs) {
        timer = setTimeout(() => {
          done()
          rejectPromise(new RequestTimeout(method))
        }, timeoutMs)
        timer.unref()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      operation.then(
        value => {
          done()
          resolvePromise(value)
        },
        (error: unknown) => {
          done()
          rejectPromise(error)
        },
      )
    })
  }

  notify(method: string, params: unknown): void {
    if (method !== 'session/cancel') return
    const sessionId = str(rec(params).sessionId)
    if (sessionId) void this.cancel(sessionId)
  }

  async stop(reason: 'stop' | 'kill', graceMs: number, cause?: string): Promise<ExitInfo> {
    // A run the server is still in when it shuts down keeps its claim on purpose, and the person's background service
    // (`opencode serve --service`) carries such a run on at its next start, unseen. Interrupted by Latch first, it ends
    // as a person's stop, which lets the claim go.
    if (this.running.size && this.port !== undefined && !this.process.exit) await this.interruptAll(Math.min(graceMs, STOP_INTERRUPT_MS))
    this.events?.destroy()
    const info = await this.process.stop(reason, graceMs, cause)
    this.agent.destroy()
    return info
  }

  stderrTail(limit?: number): string {
    return this.process.stderrTail(limit)
  }

  /** Every session the server runs, interrupted; settled once its events say so, or after `ms`. */
  private async interruptAll(ms: number): Promise<void> {
    const deadline = Date.now() + ms
    await Promise.race([
      Promise.allSettled([...this.running].map(id => this.post(`/api/session/${encodeURIComponent(id)}/interrupt`))),
      sleep(ms),
    ])
    while (this.running.size && Date.now() < deadline && !this.process.exit) await sleep(CATALOG_POLL_MS)
  }

  /**
   * A session of Latch's whose last run never ended (busy after idle: a run cut off by a kill, a timeout or a crash)
   * still holds OpenCode's claim, and the person's background service would carry that run on at its next start. With
   * nothing queued and no revert staged, waking it through OpenCode's own revert route (`DELETE …/revert`, which only
   * wakes the session then) finds nothing to do and ends the run as succeeded, which lets the claim go; no model is
   * asked. Anything else is left as it is.
   */
  private async releaseClaim(session: Json): Promise<void> {
    const id = str(session.id)
    const time = rec(session.time)
    const busy = typeof time.busy === 'number' ? time.busy : undefined
    const idle = typeof time.idle === 'number' ? time.idle : undefined
    if (!id || busy === undefined || (idle !== undefined && idle >= busy) || session.revert != null || this.running.has(id)) return
    const path = `/api/session/${encodeURIComponent(id)}`
    try {
      const inbox = rec(await this.get(`${path}/inbox`)).data
      if (!Array.isArray(inbox) || inbox.length) return
      await this.call('DELETE', `${path}/revert`)
      const deadline = Date.now() + CLAIM_RELEASE_MS
      while (Date.now() < deadline) {
        const now = rec(rec(rec(await this.get(path)).data).time)
        if (typeof now.idle === 'number' && typeof now.busy === 'number' && now.idle >= now.busy) return
        await sleep(CATALOG_POLL_MS)
      }
    } catch {
      /* Left as it was; the session itself still opens. */
    }
  }

  /**
   * On Latch's model service: the agents the person's configuration pins to a model of another provider (2.2.6 lets
   * every agent, the hidden `compaction`, `summary` and `title` among them, name its own), whose requests do not go
   * through Latch. Said, not changed.
   */
  private async pinnedElsewhere(cwd: string): Promise<string[]> {
    const listed = rec(await this.get(`/api/agent?${OpencodeWire.location(cwd)}`).catch(() => undefined)).data
    if (!Array.isArray(listed)) return []
    return listed
      .flatMap(item => {
        const agent = rec(item)
        const model = modelRef(agent.model)
        return typeof agent.id === 'string' && model && model.providerID !== GATEWAY_PROVIDER
          ? [clip(this.redact(`不经 Latch 的模型服务 · ${agent.id} 用 ${advertised(model)}`), 200)]
          : []
      })
      .slice(0, SAVED_RULES_MAX)
  }

  /**
   * The project's 「总是允许」 OpenCode saved (its TUI's Always), which it adds after every rule as allow, so they are
   * not asked here either unless the mode denies them. Read for display only; nothing is changed.
   */
  private async savedRules(cwd: string): Promise<string[]> {
    const listed = rec(await this.get(`/api/permission/saved?${OpencodeWire.location(cwd)}`).catch(() => undefined)).data
    if (!Array.isArray(listed)) return []
    return listed
      .flatMap(item => {
        const rule = rec(item)
        return typeof rule.action === 'string' && typeof rule.resource === 'string'
          ? [clip(this.redact(`总是允许 · ${rule.action} ${rule.resource}`), 200)]
          : []
      })
      .slice(0, SAVED_RULES_MAX)
  }

  // --- The server and its stream ---

  private onReady(record: Record<string, unknown>): void {
    if (this.port !== undefined || typeof record.url !== 'string') return
    const match = LISTENING.exec(record.url)
    const port = match ? Number(match[1]) : NaN
    if (Number.isInteger(port) && port > 0 && port < 65536) {
      this.port = port
      this.onListening(port)
    }
  }

  /** One request to the server; its answer's JSON, or an error that never carries the password. */
  private call(method: string, path: string, body?: unknown): Promise<unknown> {
    const exit = this.process.exit
    if (exit) return Promise.reject(new ConnectionClosed(exit))
    const port = this.port
    if (port === undefined) return Promise.reject(new RpcError(RPC.internal, 'OpenCode server is not listening yet'))
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    return new Promise((resolvePromise, rejectPromise) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          agent: this.agent,
          headers: {
            authorization: this.authorization,
            accept: 'application/json',
            ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
          },
        },
        response => {
          const parts: Buffer[] = []
          let length = 0
          response.on('data', (chunk: Buffer) => {
            length += chunk.length
            if (length > RESPONSE_LIMIT) {
              response.destroy()
              rejectPromise(new RpcError(RPC.internal, 'OpenCode answered with more than Latch reads'))
              return
            }
            parts.push(chunk)
          })
          response.on('error', () => rejectPromise(this.unavailable()))
          response.on('end', () => {
            const text = Buffer.concat(parts).toString('utf8')
            let value: unknown
            try {
              value = text ? JSON.parse(text) : undefined
            } catch {
              value = undefined
            }
            const status = response.statusCode ?? 0
            if (status >= 200 && status < 300) resolvePromise(value)
            else rejectPromise(this.answerError(status, value))
          })
        },
      )
      request.on('error', () => rejectPromise(this.unavailable()))
      request.end(payload)
    })
  }

  private unavailable(): Error {
    const exit = this.process.exit
    return exit ? new ConnectionClosed(exit) : new RpcError(RPC.internal, 'OpenCode server is unavailable')
  }

  private answerError(status: number, value: unknown): ServerAnswer {
    const body = rec(value)
    const tag = str(body._tag)
    const said = clip(this.redact(redactKnownSecrets(str(body.message) ?? '')), 2000)
    if (status === 401) return new ServerAnswer(status, tag, RPC.internal, 'OpenCode refused the password Latch set for this process')
    if (tag === 'SessionNotFoundError') return new ServerAnswer(status, tag, RPC.notFound, 'Session not found')
    if (status === 400) return new ServerAnswer(status, tag, RPC.invalidParams, said || 'OpenCode refused the request')
    return new ServerAnswer(status, tag, RPC.internal, said ? `OpenCode answered ${status}: ${said}` : `OpenCode answered ${status}`)
  }

  private get = (path: string) => this.call('GET', path)
  private post = (path: string, body: unknown = {}) => this.call('POST', path, body)

  private static location(cwd: string): string {
    return `location%5Bdirectory%5D=${encodeURIComponent(cwd)}`
  }

  /** The event stream, open from the handshake on; losing it while the server runs leaves every result unknown. */
  private openEvents(): Promise<void> {
    const connected = new Promise<void>(resolvePromise => {
      this.onConnected = resolvePromise
    })
    const request = http.request(
      {
        host: '127.0.0.1',
        port: this.port,
        method: 'GET',
        path: '/api/event',
        headers: { authorization: this.authorization, accept: 'text/event-stream' },
      },
      response => {
        if (response.statusCode !== 200) {
          response.resume()
          this.streamLost()
          return
        }
        let buffer = ''
        let data: string[] = []
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          buffer += chunk
          if (buffer.length > this.maxLineBytes) {
            buffer = ''
            this.streamLost()
            return
          }
          let newline = buffer.indexOf('\n')
          while (newline >= 0) {
            let line = buffer.slice(0, newline)
            buffer = buffer.slice(newline + 1)
            if (line.endsWith('\r')) line = line.slice(0, -1)
            if (!line) {
              if (data.length) this.onEventText(data.join('\n'))
              data = []
            } else if (line.startsWith('data:')) data.push(line.slice(line.startsWith('data: ') ? 6 : 5))
            newline = buffer.indexOf('\n')
          }
        })
        response.on('end', () => this.streamLost())
        response.on('error', () => this.streamLost())
      },
    )
    request.on('error', () => this.streamLost())
    request.end()
    this.events = request
    return connected
  }

  private streamLost(): void {
    if (this.process.stopping || this.process.closed) return
    // Without its events nothing that runs can be read or answered: the server is ended, and the runtime sees the exit.
    void this.process.stop('kill', 0, undefined)
  }

  private onEventText(text: string): void {
    let event: unknown
    try {
      event = JSON.parse(text)
    } catch {
      return
    }
    if (!isRecord(event) || typeof event.type !== 'string') return
    try {
      this.onEvent(event)
    } catch {
      this.process.noise++
    }
  }

  private async initialize(params: Json, timeoutMs?: number): Promise<unknown> {
    const exit = this.process.exited.then(info => {
      throw new ConnectionClosed(info)
    })
    exit.catch(() => {})
    const timeout = timeoutMs
      ? new Promise<never>((_, rejectPromise) => setTimeout(() => rejectPromise(new RequestTimeout('initialize')), timeoutMs).unref())
      : undefined
    await Promise.race([this.listening, exit, ...(timeout ? [timeout] : [])])
    // 1.x has no `/api` routes: it is answered as a version this wire does not speak.
    const info = rec(
      await this.get('/api/info').catch((error: unknown) => {
        if (error instanceof ServerAnswer && error.status === 404) return {}
        throw error
      }),
    )
    const version = str(info.version) ?? ''
    const compared = compareVersions(version, OPENCODE_DIRECT_MINIMUM)
    if (!/^2\./u.test(version) || compared === undefined || compared < 0)
      throw new AppError(
        409,
        'harness-version-unsupported',
        `OpenCode ${clip(version || '未知版本', 40)} 的服务接口不是 Latch 直接连接核对过的版本（需要 2.x 中的 ${OPENCODE_DIRECT_MINIMUM} 或更高）。升级：npm i -g @opencode/cli@latest；或在设置里改用 opencode acp。`,
      )
    // The server on that port must be the one this wire started.
    if (this.process.pid !== undefined && info.pid !== this.process.pid)
      throw new RpcError(RPC.internal, 'Another program answered on the port OpenCode reported')
    this.connected ??= this.openEvents()
    await Promise.race([this.connected, exit, ...(timeout ? [timeout] : [])])
    const client = rec(params.clientCapabilities)
    this.formElicitation = isRecord(rec(client.elicitation).form)
    this.standardCompaction = isRecord(rec(client.session).compaction)
    this.initialized = true
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: true, sse: false },
        promptCapabilities: { embeddedContext: true, image: true },
        sessionCapabilities: { additionalDirectories: {}, close: {}, delete: {}, list: {}, resume: {} },
      },
      authMethods: [{ id: AUTH_METHOD, name: 'Login with opencode', description: 'Run `opencode auth login` in the terminal' }],
      agentInfo: { name: 'OpenCode', version },
    }
  }

  // --- Catalog ---

  private catalog(cwd: string): Promise<Catalog> {
    const key = resolve(cwd)
    let known = this.catalogs.get(key)
    if (!known) {
      known = this.loadCatalog(cwd)
      this.catalogs.set(key, known)
      known.catch(() => this.catalogs.delete(key))
    }
    return known
  }

  private async loadCatalog(cwd: string): Promise<Catalog> {
    const location = OpencodeWire.location(cwd)
    const deadline = Date.now() + CATALOG_WAIT_MS
    // A location that has just started lists no plugins until they are active; providers may add models after that.
    while (Date.now() < deadline) {
      const plugins = rec(await this.get(`/api/plugin?${location}`).catch(() => undefined)).data
      if (Array.isArray(plugins) && plugins.length) break
      await sleep(CATALOG_POLL_MS)
    }
    for (;;) {
      const [models, preferred, agents, commands] = await Promise.all([
        this.get(`/api/model?${location}`),
        this.get(`/api/model/default?${location}`),
        this.get(`/api/agent?${location}`),
        this.get(`/api/command?${location}`),
      ])
      const list: ModelInfo[] = (Array.isArray(rec(models).data) ? (rec(models).data as unknown[]) : []).flatMap(item => {
        const model = rec(item)
        if (model.enabled !== true || typeof model.providerID !== 'string' || typeof model.id !== 'string') return []
        const variants = (Array.isArray(model.variants) ? model.variants : []).flatMap(variant => {
          const id = rec(variant).id
          return typeof id === 'string' ? [id] : []
        })
        const context = rec(model.limit).context
        return [
          {
            providerID: model.providerID,
            id: model.id,
            name: str(model.name) ?? model.id,
            variants,
            ...(typeof context === 'number' && context > 0 ? { context } : {}),
          },
        ]
      })
      const wanted = modelRef(rec(preferred).data)
      const found = wanted ? list.find(item => item.providerID === wanted.providerID && item.id === wanted.id) : list[0]
      const modes = (Array.isArray(rec(agents).data) ? (rec(agents).data as unknown[]) : []).flatMap(item => {
        const agent = rec(item)
        if (typeof agent.id !== 'string' || agent.mode === 'subagent' || agent.hidden === true) return []
        return [
          {
            id: agent.id,
            name: str(agent.name) ?? agent.id,
            ...(typeof agent.description === 'string' ? { description: agent.description } : {}),
          },
        ]
      })
      if (found && modes[0])
        return {
          models: list,
          defaultModel: {
            providerID: found.providerID,
            id: found.id,
            ...(found.variants.includes(DEFAULT_VARIANT) ? { variant: DEFAULT_VARIANT } : {}),
          },
          modes,
          defaultModeID: modes[0].id,
          commands: (Array.isArray(rec(commands).data) ? (rec(commands).data as unknown[]) : []).flatMap(item => {
            const command = rec(item)
            if (typeof command.name !== 'string' || BUILTIN_COMMANDS.has(command.name)) return []
            return [{ name: command.name, ...(typeof command.description === 'string' ? { description: command.description } : {}) }]
          }),
        }
      if (Date.now() >= deadline)
        throw new RpcError(RPC.internal, found ? 'OpenCode lists no primary agents' : 'OpenCode lists no models it can use')
      await sleep(CATALOG_POLL_MS)
    }
  }

  /** A location's models, agents or commands changed: read again, and tell the sessions there what changed. */
  private reloadCatalog(directory: string | undefined): void {
    const keys = directory === undefined ? [...this.catalogs.keys()] : [resolve(directory)].filter(key => this.catalogs.has(key))
    for (const key of keys) {
      const loading = this.loadCatalog(key)
      this.catalogs.set(key, loading)
      loading.then(
        catalog => {
          for (const attached of this.sessions.values()) if (resolve(attached.cwd) === key) this.showChanges(attached, catalog)
        },
        () => this.catalogs.delete(key),
      )
    }
  }

  /** New options or commands of a session the runtime knows; the first are told with its first turn. */
  private showChanges(attached: Attached, catalog: Catalog): void {
    if (!attached.shown) return
    const options = JSON.stringify(configOptions(catalog, attached.selection))
    const commands = availableCommands(catalog)
    if (options !== attached.shown.options)
      this.send(attached.id, { sessionUpdate: 'config_option_update', configOptions: JSON.parse(options) as unknown[] })
    if (JSON.stringify(commands) !== attached.shown.commands)
      this.send(attached.id, { sessionUpdate: 'available_commands_update', availableCommands: commands })
    attached.shown = { options, commands: JSON.stringify(commands) }
  }

  // --- Sessions ---

  private require(sessionId: unknown): Attached {
    const attached = typeof sessionId === 'string' ? this.sessions.get(sessionId) : undefined
    if (!attached) throw new RpcError(RPC.notFound, 'Session not found')
    return attached
  }

  private async attach(session: Json, cwd: string, mcpServers: unknown): Promise<{ attached: Attached; configOptions: Json[] }> {
    const id = String(session.id)
    const catalog = await this.catalog(cwd)
    const servers = (Array.isArray(mcpServers) ? mcpServers : []).filter(isRecord)
    const configs = servers.map(server => [String(server.name), mcpConfig(server)] as const)
    const previous = this.sessions.get(id)
    const attached: Attached = {
      id,
      cwd,
      selection: {
        ...(modelRef(session.model) ? { model: modelRef(session.model) } : {}),
        ...(typeof session.agent === 'string' ? { modeID: session.agent } : {}),
      },
      mcp: previous?.mcp ?? new Map(),
    }
    this.sessions.set(id, attached)
    for (const [name, config] of configs) {
      const text = JSON.stringify(config)
      if (attached.mcp.get(name) === text) continue
      await this.call('PUT', `/api/experimental/mcp/${encodeURIComponent(name)}?${OpencodeWire.location(cwd)}`, { config })
      attached.mcp.set(name, text)
    }
    return { attached, configOptions: configOptions(catalog, attached.selection) }
  }

  private async newSession(params: Json): Promise<unknown> {
    const cwd = str(params.cwd) ?? ''
    const directories = parseDirectories(cwd, params.additionalDirectories)
    // A catalog that cannot be read leaves no session behind.
    await this.catalog(cwd)
    const created = rec(
      rec(
        await this.post('/api/session', {
          location: { directory: cwd },
          ...(directories.length ? { permissions: directoryRules(directories), metadata: { [DIRECTORIES_KEY]: directories } } : {}),
        }),
      ).data,
    )
    if (typeof created.id !== 'string') throw new RpcError(RPC.internal, 'OpenCode did not name the new session')
    const { attached, configOptions: options } = await this.attach(created, cwd, params.mcpServers)
    this.unprompted.add(attached.id)
    return { sessionId: attached.id, configOptions: options, ...(await this.facts(cwd)) }
  }

  /** What OpenCode's own settings decide beside the mode, for the setup answer (`PERMISSION_FACTS`). */
  private async facts(cwd: string): Promise<{ _meta?: Record<string, unknown> }> {
    const lines = [...(await this.savedRules(cwd)), ...(this.routed ? await this.pinnedElsewhere(cwd) : [])]
    return lines.length ? { _meta: { [PERMISSION_FACTS]: lines } } : {}
  }

  private async session(sessionId: unknown, cwd: string): Promise<Json> {
    if (typeof sessionId !== 'string' || !sessionId.startsWith('ses')) throw new RpcError(RPC.notFound, 'Session not found')
    const session = rec(rec(await this.get(`/api/session/${encodeURIComponent(sessionId)}`)).data)
    const directory = str(rec(session.location).directory)
    if (!directory || !sameDirectory(directory, cwd)) throw new RpcError(RPC.invalidParams, `session ${sessionId} does not belong to cwd`)
    return session
  }

  /** The session's grants for other folders become the ones asked for now, as `opencode acp` keeps them. */
  private async activate(session: Json, directories: string[]): Promise<void> {
    const previous = storedDirectories(session)
    const owned = directoryRules(previous).map(rule => JSON.stringify(rule))
    const current = Array.isArray(session.permissions) ? session.permissions.filter(isRecord) : []
    const permissions = [...directoryRules(directories), ...current.filter(rule => !owned.includes(JSON.stringify(rule)))]
    const metadata = {
      ...Object.fromEntries(Object.entries(rec(session.metadata)).filter(([name]) => name !== DIRECTORIES_KEY)),
      ...(directories.length ? { [DIRECTORIES_KEY]: directories } : {}),
    }
    const permissionsChanged = JSON.stringify(permissions) !== JSON.stringify(current)
    const metadataChanged = JSON.stringify(previous) !== JSON.stringify(directories)
    if (!permissionsChanged && !metadataChanged) return
    await this.call('PATCH', `/api/session/${encodeURIComponent(String(session.id))}`, {
      ...(permissionsChanged ? { permissions } : {}),
      ...(metadataChanged ? { metadata } : {}),
    })
  }

  private async resume(params: Json, replay: boolean): Promise<unknown> {
    const cwd = str(params.cwd) ?? ''
    const directories = parseDirectories(cwd, params.additionalDirectories)
    const session = await this.session(params.sessionId, cwd)
    // Only for a session Latch started (the runtime says so): one brought in, or read for a preview, may be running in
    // the person's own OpenCode right now, and is left as it is.
    if (!replay && params[RELEASE_CLAIM] === true) await this.releaseClaim(session)
    await this.activate(session, directories)
    const directory = str(rec(session.location).directory) ?? cwd
    const { attached, configOptions: options } = await this.attach(session, directory, params.mcpServers)
    if (!replay) return { configOptions: options, ...(await this.facts(directory)) }
    try {
      let cursor: string | undefined
      for (;;) {
        const path = `/api/session/${encodeURIComponent(attached.id)}/message?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : '&order=asc'}`
        const page = rec(await this.get(path))
        for (const message of Array.isArray(page.data) ? page.data : [])
          for (const update of replayUpdates(rec(message), directory)) this.send(attached.id, update)
        cursor = str(rec(page.cursor).next)
        if (!cursor || !Array.isArray(page.data) || !page.data.length) break
      }
    } catch (error) {
      this.sessions.delete(attached.id)
      throw error
    }
    return { configOptions: configOptions(await this.catalog(attached.cwd), attached.selection) }
  }

  private async list(params: Json): Promise<unknown> {
    const cwd = str(params.cwd)
    if (cwd !== undefined && !isAbsolute(cwd)) throw new RpcError(RPC.invalidParams, 'cwd must be an absolute path')
    const query = [
      ...(cwd !== undefined ? [`directory=${encodeURIComponent(cwd)}`] : []),
      'order=desc',
      'limit=100',
      ...(typeof params.cursor === 'string' && params.cursor ? [`cursor=${encodeURIComponent(params.cursor)}`] : []),
    ].join('&')
    const page = rec(await this.get(`/api/session?${query}`))
    const rows = (Array.isArray(page.data) ? page.data : []).filter(isRecord)
    const next = str(rec(page.cursor).next)
    return {
      sessions: rows.flatMap(session => {
        if (typeof session.id !== 'string') return []
        const time = rec(session.time)
        const created = typeof time.created === 'number' ? time.created : 0
        const updated = typeof time.updated === 'number' ? time.updated : created
        const additionalDirectories = storedDirectories(session)
        return [
          {
            sessionId: session.id,
            cwd: str(rec(session.location).directory) ?? '',
            ...(additionalDirectories.length ? { additionalDirectories } : {}),
            title: str(session.title) || `New session - ${new Date(created).toISOString()}`,
            updatedAt: new Date(updated).toISOString(),
          },
        ]
      }),
      // A page that ends the list still names a cursor; an empty page ends it.
      ...(next && rows.length ? { nextCursor: next } : {}),
    }
  }

  private async close(params: Json): Promise<unknown> {
    const sessionId = str(params.sessionId)
    if (!sessionId) return {}
    // Work the server goes on with after a turn, such as a background subagent, stops with the session.
    if (this.turns.has(sessionId)) await this.cancel(sessionId)
    else if (sessionId.startsWith('ses')) await this.post(`/api/session/${encodeURIComponent(sessionId)}/interrupt`).catch(() => {})
    this.sessions.delete(sessionId)
    // Opened and closed without a prompt: removed rather than kept as an empty session, unless another client used it.
    if (this.unprompted.delete(sessionId)) {
      const messages = rec(await this.get(`/api/session/${encodeURIComponent(sessionId)}/message?limit=1`).catch(() => undefined)).data
      if (Array.isArray(messages) && !messages.length)
        await this.call('DELETE', `/api/session/${encodeURIComponent(sessionId)}`).catch(() => {})
    }
    return {}
  }

  private async remove(params: Json): Promise<unknown> {
    const sessionId = str(params.sessionId)
    if (!sessionId) return {}
    this.unprompted.delete(sessionId)
    if (this.turns.has(sessionId)) await this.cancel(sessionId)
    if (sessionId.startsWith('ses'))
      await this.call('DELETE', `/api/session/${encodeURIComponent(sessionId)}`).catch((error: unknown) => {
        if (error instanceof ServerAnswer && (error.status === 404 || error.status === 400)) return
        throw error
      })
    this.sessions.delete(sessionId)
    return {}
  }

  private async setOption(params: Json): Promise<unknown> {
    const attached = this.require(params.sessionId)
    const configId = str(params.configId) ?? ''
    if (typeof params.value !== 'string') throw new RpcError(RPC.invalidParams, `unknown config option: ${clip(configId, 200)}`)
    const value = params.value
    let catalog = await this.catalog(attached.cwd)
    let change: ReturnType<typeof resolveChange>
    try {
      change = resolveChange(catalog, attached.selection, configId, value)
    } catch (error) {
      // A model, agent or effort the cached catalog does not know yet may be in a fresh read.
      if (!(error instanceof RpcError) || !/^(model|effort|mode) not found/u.test(error.message)) throw error
      this.catalogs.delete(resolve(attached.cwd))
      catalog = await this.catalog(attached.cwd)
      change = resolveChange(catalog, attached.selection, configId, value)
    }
    // Recorded before the switch, so the server's echo of it changes nothing.
    attached.selection = { ...attached.selection, ...change }
    if ('model' in change) await this.post(`/api/session/${encodeURIComponent(attached.id)}/model`, { model: change.model })
    else await this.post(`/api/session/${encodeURIComponent(attached.id)}/agent`, { agent: change.modeID })
    const options = configOptions(catalog, attached.selection)
    if (attached.shown) attached.shown.options = JSON.stringify(options)
    return { configOptions: options }
  }

  // --- Turns ---

  private async prompt(params: Json): Promise<unknown> {
    const attached = this.require(params.sessionId)
    if (this.turns.has(attached.id)) throw new RpcError(RPC.internal, `Session already has an active prompt: ${attached.id}`)
    const blocks = (Array.isArray(params.prompt) ? params.prompt : []).filter(isRecord)
    if (blocks.some(block => block.type === 'image' && !block.data && !block.uri))
      throw new RpcError(RPC.invalidParams, 'image content has no data or uri')
    const prepared = preparePrompt(blocks)
    const catalog = await this.catalog(attached.cwd)
    this.unprompted.delete(attached.id)
    // Told once the session has a turn, when the runtime surely knows it: it drops updates for a session it does not.
    if (!attached.shown) {
      const commands = availableCommands(catalog)
      attached.shown = { commands: JSON.stringify(commands), options: JSON.stringify(configOptions(catalog, attached.selection)) }
      this.send(attached.id, { sessionUpdate: 'available_commands_update', availableCommands: commands })
    }
    const compaction = prepared.slash?.name === 'compact'
    const command = !compaction && prepared.slash ? catalog.commands.find(item => item.name === prepared.slash!.name) : undefined
    const startId = command ? undefined : messageId()
    let turn!: Turn
    let submitted!: () => void
    const handed = new Promise<void>(resolvePromise => {
      submitted = resolvePromise
    })
    const done = new Promise<unknown>((resolvePromise, rejectPromise) => {
      turn = {
        submitted: handed,
        sessionId: attached.id,
        cwd: attached.cwd,
        ...(startId ? { startId } : {}),
        started: false,
        cancelled: false,
        interrupted: false,
        tools: new Map(),
        compactions: new Map(),
        retries: new Map(),
        resolve: resolvePromise,
        reject: rejectPromise,
      }
    })
    done.catch(() => {})
    this.turns.set(attached.id, turn)
    const path = `/api/session/${encodeURIComponent(attached.id)}`
    try {
      if (prepared.synthetic.length)
        await this.post(`${path}/synthetic`, {
          text: prepared.synthetic.join('\n\n'),
          description: 'ACP embedded context',
          delivery: 'steer',
          resume: false,
        })
      if (compaction) await this.post(`${path}/compact`, { id: startId, delivery: 'steer' })
      else if (command) {
        await this.post(`${path}/command`, {
          name: command.name,
          text: prepared.slash?.args ?? '',
          files: prepared.files,
          delivery: 'steer',
        })
        // The server queues the command's prompt after it answers; one that queues nothing has nothing to run.
        void this.awaitCommand(turn)
      } else await this.post(`${path}/prompt`, { id: startId, text: prepared.text, files: prepared.files, delivery: 'steer' })
    } catch (error) {
      if (this.turns.get(attached.id) === turn) this.turns.delete(attached.id)
      throw error
    } finally {
      submitted()
    }
    return done
  }

  private async awaitCommand(turn: Turn): Promise<void> {
    await sleep(COMMAND_QUEUE_MS)
    if (turn.startId === undefined && this.turns.get(turn.sessionId) === turn) {
      this.turns.delete(turn.sessionId)
      turn.resolve({ stopReason: turn.cancelled ? 'cancelled' : 'end_turn', _meta: {} })
    }
  }

  /**
   * Stops the session's turn: open asks are refused, a prompt not yet taken is withdrawn, and the run is interrupted. The
   * turn ends only when the server reports that the run ended, or that none runs.
   */
  private async cancel(sessionId: string): Promise<void> {
    const turn = this.turns.get(sessionId)
    if (!turn || turn.cancelled) return
    turn.cancelled = true
    for (const [id, ask] of this.asks)
      if (ask.root === sessionId && !ask.settled) {
        ask.settled = true
        void this.settleAsk(id, ask, undefined)
      }
    // A prompt still being handed over would otherwise be queued after the stop.
    await turn.submitted
    if (this.turns.get(sessionId) !== turn) return
    const path = `/api/session/${encodeURIComponent(sessionId)}`
    if (!turn.started && turn.startId) await this.call('DELETE', `${path}/inbox/${encodeURIComponent(turn.startId)}`).catch(() => {})
    await this.interrupt(turn)
    if (turn.started || this.turns.get(sessionId) !== turn) return
    // Nothing of this turn started: ended once the server says the session runs nothing.
    const active = rec(rec(await this.get('/api/session/active').catch(() => undefined)).data)
    if (!turn.started && this.turns.get(sessionId) === turn && !Object.hasOwn(active, sessionId) && !this.running.has(sessionId)) {
      this.turns.delete(sessionId)
      turn.resolve({ stopReason: 'cancelled', _meta: {} })
    }
  }

  private async interrupt(turn: Turn): Promise<void> {
    turn.interrupted = true
    await this.post(`/api/session/${encodeURIComponent(turn.sessionId)}/interrupt`).catch(() => {})
  }

  private async settle(turn: Turn, terminal: Terminal): Promise<void> {
    if (this.turns.get(turn.sessionId) === turn) this.turns.delete(turn.sessionId)
    const error = turn.stepError ?? turn.executionError
    const type = str(error?.type)
    if (terminal !== 'interrupted' && type === 'provider.auth')
      return turn.reject(new RpcError(RPC.authRequired, 'provider authentication required'))
    if (terminal !== 'interrupted' && error && type !== 'aborted' && type !== 'provider.content-filter') {
      await this.sendUsage(turn).catch(() => {})
      const usage = turn.usage?.turn && totalTokens(turn.usage.turn) > 0 ? promptUsage(turn.usage.turn) : undefined
      return turn.reject(
        new RpcError(
          RPC.internal,
          clip(this.redact(redactKnownSecrets(str(error.message) || 'OpenCode prompt failed')), 4000),
          usage ? { usage } : undefined,
        ),
      )
    }
    await this.sendUsage(turn).catch(() => {})
    const stopReason =
      terminal === 'interrupted' || type === 'aborted'
        ? 'cancelled'
        : turn.finish === 'length'
          ? 'max_tokens'
          : turn.finish === 'content-filter' || type === 'provider.content-filter'
            ? 'refusal'
            : 'end_turn'
    const usage = promptUsage(turn.usage?.turn)
    const retry = turn.retries.get(turn.sessionId)
    turn.resolve({ stopReason, ...(usage ? { usage } : {}), _meta: retry ? { [RETRY_META]: retry } : {} })
  }

  /** The context the last model call used, its window, and the session's cost, as the ACP route reports them. */
  private async sendUsage(turn: Turn): Promise<void> {
    const used = turn.usage?.last ? totalTokens(turn.usage.last) : 0
    const attached = this.sessions.get(turn.sessionId)
    if (!used || !attached) return
    const catalog = await this.catalog(attached.cwd)
    const current = attached.selection.model ?? catalog.defaultModel
    const size = catalog.models.find(item => item.providerID === current.providerID && item.id === current.id)?.context
    if (!size) return
    const info = rec(rec(await this.get(`/api/session/${encodeURIComponent(turn.sessionId)}`)).data)
    const cost = typeof info.cost === 'number' && Number.isFinite(info.cost) && info.cost >= 0 ? info.cost : 0
    this.send(turn.sessionId, { sessionUpdate: 'usage_update', used, size, cost: { amount: cost, currency: 'USD' } })
  }

  // --- Events ---

  private send(sessionId: string, update: Update): void {
    try {
      this.handlers.notification('session/update', { sessionId, update })
    } catch {
      this.process.noise++
    }
  }

  private rootOf(sessionID: string | undefined): { root: string; child?: Child } | undefined {
    if (!sessionID) return undefined
    // A session being closed or removed still has its turn to end.
    if (this.sessions.has(sessionID) || this.turns.has(sessionID)) return { root: sessionID }
    const child = this.children.get(sessionID)
    return child ? { root: child.root, child } : undefined
  }

  private onEvent(event: Json): void {
    const type = String(event.type)
    const data = rec(event.data)
    switch (type) {
      case 'server.connected':
        this.onConnected?.()
        return
      case 'model.updated':
      case 'agent.updated':
      case 'command.updated':
        if (this.initialized) this.reloadCatalog(str(rec(event.location).directory))
        return
      case 'session.model.selected':
      case 'session.agent.selected': {
        const attached = this.sessions.get(str(data.sessionID) ?? '')
        if (!attached) return
        const model = modelRef(data.model)
        if (type === 'session.model.selected' && model) attached.selection = { ...attached.selection, model }
        else if (type === 'session.agent.selected' && typeof data.agent === 'string')
          attached.selection = { ...attached.selection, modeID: data.agent }
        void this.catalog(attached.cwd).then(
          catalog => this.showChanges(attached, catalog),
          () => {},
        )
        return
      }
      case 'session.created': {
        const parentID = str(data.parentID)
        const id = str(data.sessionID)
        const parent = this.rootOf(parentID)
        if (!parent || !id || !parentID) return
        this.children.set(id, {
          id,
          parentID,
          depth: parent.child ? parent.child.depth + 1 : 1,
          ...(typeof data.title === 'string' ? { title: data.title } : {}),
          root: parent.root,
        })
        return
      }
      case 'permission.asked':
        this.onPermission(data)
        return
      case 'form.created':
        this.onForm(rec(data.form))
        return
      case 'permission.replied':
      case 'form.replied':
      case 'form.cancelled': {
        const id = str(type === 'permission.replied' ? data.requestID : data.id) ?? ''
        const ask = this.asks.get(id)
        if (!ask || ask.settled) return
        // Answered elsewhere, or no longer asked: the card the person sees is withdrawn.
        ask.settled = true
        try {
          this.handlers.notification('$/cancel_request', { requestId: `opencode-${id}` })
        } catch {
          this.process.noise++
        }
        return
      }
      default:
        break
    }
    const sessionID = str(data.sessionID)
    if (sessionID && type === 'session.execution.started') this.running.add(sessionID)
    if (sessionID && type.startsWith('session.execution.') && type !== 'session.execution.started') this.running.delete(sessionID)
    const owner = this.rootOf(sessionID)
    if (!owner) return
    const turn = this.turns.get(owner.root)
    if (!turn) return
    if (!owner.child && type === 'session.inbox.enqueued' && turn.startId === undefined && rec(data.item).type === 'user') {
      turn.startId = str(data.inboxID)
      return
    }
    if (!owner.child && type === 'session.inbox.delivered' && turn.startId !== undefined && data.inboxID === turn.startId) {
      turn.started = true
      // A stop asked before the run began reaches it now.
      if (turn.cancelled) void this.interrupt(turn)
      return
    }
    if (!turn.started) return
    if (owner.child) {
      if (type === 'session.step.ended' || type === 'session.step.failed') {
        const tokens = readTokens(data.tokens)
        if (tokens) turn.usage = { turn: addTokens(turn.usage?.turn, tokens), ...(turn.usage?.last ? { last: turn.usage.last } : {}) }
        return
      }
      if (!type.startsWith('session.execution.')) this.sessionEvent(turn, type, event, data, owner.child)
      return
    }
    switch (type) {
      case 'session.step.started':
        turn.stepError = undefined
        this.sessionEvent(turn, type, event, data, undefined)
        return
      case 'session.step.ended': {
        const tokens = readTokens(data.tokens)
        if (tokens) turn.usage = { turn: addTokens(turn.usage?.turn, tokens), last: tokens }
        turn.finish = str(data.finish)
        return
      }
      case 'session.step.failed': {
        const tokens = readTokens(data.tokens)
        if (tokens) turn.usage = { turn: addTokens(turn.usage?.turn, tokens), last: tokens }
        turn.stepError = rec(data.error)
        return
      }
      case 'session.execution.succeeded':
        void this.settle(turn, 'succeeded')
        return
      case 'session.execution.interrupted':
        void this.settle(turn, 'interrupted')
        return
      case 'session.execution.failed':
        turn.executionError = rec(data.error)
        void this.settle(turn, 'failed')
        return
      default:
        this.sessionEvent(turn, type, event, data, undefined)
    }
  }

  private sessionEvent(turn: Turn, type: string, event: Json, data: Json, child: Child | undefined): void {
    const sessionID = child?.id ?? turn.sessionId
    const send = (update: Update) => this.send(turn.sessionId, projectChild(update, child))
    const key = `${sessionID}:${str(data.id) ?? ''}`
    const tool = (name?: string): Tool =>
      turn.tools.get(key) ?? { sessionID, id: str(data.id) ?? '', name: name ?? 'tool', input: {}, metadata: {} }
    switch (type) {
      case 'session.step.started':
        if (!turn.retries.has(sessionID)) return
        turn.retries.delete(sessionID)
        send({ sessionUpdate: 'session_info_update', _meta: { [RETRY_META]: null } })
        return
      case 'session.retry.scheduled': {
        const retry = {
          attempt: data.attempt,
          nextRetryAt: typeof data.at === 'number' ? new Date(data.at).toISOString() : undefined,
          error: data.error,
        }
        turn.retries.set(sessionID, retry)
        send({ sessionUpdate: 'session_info_update', _meta: { [RETRY_META]: retry } })
        return
      }
      case 'session.compaction.started':
      case 'session.compaction.ended':
      case 'session.compaction.failed': {
        const reason = str(data.reason) ?? 'auto'
        const standard = this.standardCompaction && !child
        const opened = (): Compaction => ({ messageId: str(data.inputID) ?? `msg_${String(event.id ?? '').replace(/^evt_/u, '')}`, reason })
        const show = (update: Update, status: string, extra: Json = {}) =>
          send(
            standard
              ? update
              : {
                  sessionUpdate: 'session_info_update',
                  _meta: { [COMPACTION_META]: { status, messageId: update.compactionId, reason, ...extra } },
                },
          )
        if (type === 'session.compaction.started') {
          const started = opened()
          turn.compactions.set(sessionID, started)
          show(compactionStarted(started), 'started')
          return
        }
        const current = turn.compactions.get(sessionID)
        turn.compactions.delete(sessionID)
        if (type === 'session.compaction.ended') {
          if (current) show(compactionEnded(current, str(data.text) ?? ''), 'completed')
          return
        }
        const started = current ?? opened()
        if (!current && standard) show(compactionStarted(started), 'started')
        show(compactionFailed(started, data.error), 'failed', { error: data.error })
        return
      }
      case 'session.compaction.delta': {
        const started = turn.compactions.get(sessionID)
        if (!started || !this.standardCompaction || child) return
        send({
          sessionUpdate: 'compaction_summary_chunk',
          compactionId: started.messageId,
          content: { type: 'text', text: str(data.text) ?? '' },
        })
        return
      }
      case 'session.text.delta':
        send({
          sessionUpdate: 'agent_message_chunk',
          messageId: data.assistantMessageID,
          content: { type: 'text', text: str(data.delta) ?? '' },
        })
        return
      case 'session.reasoning.delta':
        send({
          sessionUpdate: 'agent_thought_chunk',
          messageId: reasoningMessageId(str(data.assistantMessageID) ?? '', typeof data.ordinal === 'number' ? data.ordinal : 0),
          content: { type: 'text', text: str(data.delta) ?? '' },
        })
        return
      case 'session.tool.input.started': {
        const started = { sessionID, id: str(data.id) ?? '', name: str(data.name) ?? 'tool', input: {}, metadata: {} }
        turn.tools.set(key, started)
        send({ sessionUpdate: 'tool_call', ...pendingToolCall(started.id, started.name, {}, turn.cwd) })
        return
      }
      case 'session.tool.called': {
        const called = { ...tool(), input: rec(data.input) }
        turn.tools.set(key, called)
        send({ sessionUpdate: 'tool_call_update', ...runningToolUpdate(called.id, called.name, called.input, turn.cwd) })
        return
      }
      case 'session.tool.progress': {
        const current = turn.tools.get(key)
        if (!current) return
        current.metadata = data.metadata
        send({ sessionUpdate: 'tool_call_update', ...runningToolUpdate(current.id, current.name, current.input, turn.cwd) })
        return
      }
      case 'session.tool.success': {
        const ended = tool()
        turn.tools.delete(key)
        send({
          sessionUpdate: 'tool_call_update',
          ...completedToolUpdate(ended.id, ended.name, ended.input, data.content, data.metadata, turn.cwd),
        })
        return
      }
      case 'session.tool.failed': {
        const ended = tool()
        turn.tools.delete(key)
        send({
          sessionUpdate: 'tool_call_update',
          ...errorToolUpdate(
            ended.id,
            ended.name,
            ended.input,
            data.content ?? [],
            data.metadata ?? ended.metadata,
            clip(this.redact(str(rec(data.error).message) ?? 'Tool failed'), 4000),
            turn.cwd,
          ),
        })
        return
      }
      default:
        return
    }
  }

  /** An approval OpenCode asks for, put to the person on the session it belongs to; the answer goes back as given. */
  private onPermission(data: Json): void {
    const id = str(data.id)
    const sessionID = str(data.sessionID)
    const owner = this.rootOf(sessionID)
    if (!id || !sessionID || !owner || this.asks.has(id)) return
    const ask: Ask = { root: owner.root, sessionID, kind: 'permission', settled: false }
    this.asks.set(id, ask)
    const turn = this.turns.get(owner.root)
    if (turn?.cancelled) {
      ask.settled = true
      void this.settleAsk(id, ask, undefined)
      return
    }
    const attached = this.sessions.get(owner.root)
    const cwd = turn?.cwd ?? attached?.cwd ?? ''
    const source = rec(data.source)
    const tool = typeof source.id === 'string' ? turn?.tools.get(`${sessionID}:${source.id}`) : undefined
    const action = str(data.action) ?? 'permission'
    const toolName = tool?.name ?? action
    const toolInput = tool?.input ?? rec(data.metadata)
    const previews = canonicalName(toolName) === 'patch' ? [] : fileDiffs(data.metadata, cwd)
    const title = permissionTitle(toolName, toolInput, previews.length)
    const call = pendingToolCall(
      childToolCallId(owner.child, tool?.id ?? id),
      toolName,
      toolInput,
      cwd,
      title ? childTitle(owner.child, title) : owner.child?.title,
    )
    const { name: _name, rawInput, ...rest } = call
    const toolCall: Json = {
      ...rest,
      ...(tool ? { name: tool.name, rawInput } : {}),
      locations: permissionLocations(toolName, toolInput, action, data.resources, cwd),
      ...(previews.length ? { content: previews } : {}),
      ...(owner.child ? { _meta: childMeta(owner.child) } : {}),
    }
    let answer: Promise<unknown>
    try {
      answer = this.handlers.request(
        'session/request_permission',
        { sessionId: owner.root, toolCall, options: PERMISSION_OPTIONS },
        `opencode-${id}`,
      )
    } catch (error) {
      answer = Promise.reject(error)
    }
    answer.then(
      result => {
        const outcome = rec(rec(result).outcome)
        const chosen = outcome.outcome === 'selected' ? outcome.optionId : undefined
        if (ask.settled) return
        ask.settled = true
        void this.settleAsk(id, ask, chosen === 'once' || chosen === 'always' ? chosen : 'reject')
      },
      () => {
        if (ask.settled) return
        ask.settled = true
        void this.settleAsk(id, ask, 'reject')
      },
    )
  }

  /** A question OpenCode asks; a form with no card it can be shown on is cancelled, as on the ACP route. */
  private onForm(form: Json): void {
    const id = str(form.id)
    const sessionID = str(form.sessionID)
    const owner = this.rootOf(sessionID)
    if (!id || !sessionID || !owner || this.asks.has(id)) return
    const ask: Ask = { root: owner.root, sessionID, kind: 'form', settled: false }
    this.asks.set(id, ask)
    const schema = this.formElicitation ? formSchema(form) : undefined
    const turn = this.turns.get(owner.root)
    if (!schema || turn?.cancelled) {
      ask.settled = true
      void this.cancelForm(sessionID, id, rec(form.metadata).kind === 'question' && !turn?.cancelled ? UNSHOWN_QUESTION : undefined)
      return
    }
    const toolId = str(rec(rec(form.metadata).tool).id)
    let answer: Promise<unknown>
    try {
      answer = this.handlers.request(
        'elicitation/create',
        {
          mode: 'form',
          sessionId: owner.root,
          ...(toolId && !owner.child ? { toolCallId: toolId } : {}),
          message: childTitle(owner.child, str(form.title) ?? ''),
          requestedSchema: schema,
        },
        `opencode-${id}`,
      )
    } catch (error) {
      answer = Promise.reject(error)
    }
    answer.then(
      result => {
        if (ask.settled) return
        ask.settled = true
        const reply = formAnswer(form, result)
        if (!reply) return void this.cancelForm(sessionID, id)
        void this.post(`/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(id)}/reply`, { answer: reply }).catch(() =>
          this.cancelForm(sessionID, id),
        )
      },
      () => {
        if (ask.settled) return
        ask.settled = true
        void this.cancelForm(sessionID, id)
      },
    )
  }

  private async settleAsk(id: string, ask: Ask, decision: 'once' | 'always' | 'reject' | undefined): Promise<void> {
    if (ask.kind === 'form') return this.cancelForm(ask.sessionID, id)
    await this.post(`/api/session/${encodeURIComponent(ask.sessionID)}/permission/${encodeURIComponent(id)}/reply`, {
      decision: decision ?? 'reject',
    }).catch(() => {})
  }

  private async cancelForm(sessionID: string, formID: string, message?: string): Promise<void> {
    const path = `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}${message ? `?message=${encodeURIComponent(message)}` : ''}`
    await this.call('DELETE', path).catch(async (error: unknown) => {
      // A form that cannot be cancelled would hold the run: it is stopped instead, as the ACP route does.
      if (error instanceof ServerAnswer && error.status === 404) return
      await this.post(`/api/session/${encodeURIComponent(sessionID)}/interrupt`).catch(() => {})
    })
  }

  private onClosed(info: ExitInfo): void {
    this.events?.destroy()
    this.agent.destroy()
    const closed = new ConnectionClosed(info)
    for (const turn of this.turns.values()) turn.reject(closed)
    this.turns.clear()
    this.handlers.exit(info)
  }
}
