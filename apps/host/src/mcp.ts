// Latch's own MCP servers: local commands defined on this Mac, kept in `<data>/mcp/servers.json` (definitions, no secret)
// and `<data>/mcp/secrets.json` (the values of their variables), both 0600 in a 0700 directory, both strict. An agent
// reaches one only through its `latch-mcp` bridge, which takes the launch from the tool gateway. See docs/MCP.md.
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import {
  isMcpServerName,
  isReservedAgentEnvName,
  isUnpinnedRunner,
  type McpFailure,
  type McpReport,
  type McpScope,
  type McpServerView,
  type McpServersResponse,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson, setKnownSecrets, sha256Hex, writeFileAtomic } from '@latch/core/node-kit'

export const MCP_DIRECTORY = 'mcp'
const SERVERS_FILE = 'servers.json'
const SECRETS_FILE = 'secrets.json'
const MAX_SERVERS = 64
const MAX_RECEIPTS = 256
/** A tool's name as MCP spells it; longer ones are not offered to the switch. */
const toolName = z.string().regex(/^[A-Za-z0-9_.:/-]{1,128}$/u)
const stamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
export const MCP_ID = /^mcp_[A-Za-z0-9_-]{22}$/u
const serverId = z.string().regex(MCP_ID)
const envName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u)
  .refine(name => !isReservedAgentEnvName(name) && name.toUpperCase() !== 'PATH', { message: 'reserved' })
/**
 * Names a secret variable may not have: what loads code, points a tool at other packages or files, or moves a home.
 * A value there decides what runs, so it is a plain variable, confirmed with the rest of the definition.
 */
const SECRET_RESERVED = new Set([
  'BASH_ENV',
  'ENV',
  'PYTHONPATH',
  'PYTHONHOME',
  'PYTHONSTARTUP',
  'PERL5OPT',
  'PERL5LIB',
  'RUBYOPT',
  'RUBYLIB',
  'NODE_OPTIONS',
  'NODE_PATH',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'PERLLIB',
  'SHELLOPTS',
  'PS4',
  'LUA_INIT',
  'GOFLAGS',
  'GOPROXY',
  'CLASSPATH',
  'RUSTFLAGS',
  'PATH',
  'HOME',
])
const SECRET_RESERVED_PREFIXES = ['UV_', 'PIP_', 'PIPX_', 'NPM_CONFIG_', 'BUN_', 'DENO_', 'GEM_', 'CARGO_', 'XDG_', 'DYLD_', 'LD_', 'GIT_']

/** Why a variable cannot be secret, or undefined. Names compare case-insensitively (`npm_config_*` is `NPM_CONFIG_*`). */
export function secretRefusal(name: string, value: string): string | undefined {
  const upper = name.toUpperCase()
  if (SECRET_RESERVED.has(upper) || SECRET_RESERVED_PREFIXES.some(prefix => upper.startsWith(prefix)))
    return `${name} 决定加载哪些程序或文件，请作为普通变量填写，它会出现在确认里`
  if (looksLikePathOrUrl(value)) return `${name} 的值像路径或地址，请作为普通变量填写，它会出现在确认里`
  return undefined
}

/** Folders an absolute path on this Mac starts with, so a one-segment `/…` that is one of them reads as a path. */
const ROOTS = new Set([
  'usr',
  'opt',
  'tmp',
  'var',
  'etc',
  'bin',
  'sbin',
  'Users',
  'home',
  'Library',
  'private',
  'Applications',
  'System',
  'Volumes',
  'nix',
])

/**
 * A value that names a file or a place: a path (`~/…`, `./…`, `../…`, `C:\…`, or `/…` shaped like one: path
 * characters only, and a second `/` or a known root, so a base64 secret that starts with `/` stays a secret), a URL or
 * `file:`/`data:`, or `host:port`.
 */
export function looksLikePathOrUrl(value: string): boolean {
  const text = value.trim()
  if (/^(?:~|\.{1,2})[/\\]/u.test(text) || /^[A-Za-z]:[/\\]/u.test(text)) return true
  if (/^\/[A-Za-z0-9._@~ -]+(?:\/[A-Za-z0-9._@~ -]*)*\/?$/u.test(text)) {
    const segments = text.split('/').filter(Boolean)
    if (segments.length > 1 || ROOTS.has(segments[0] ?? '')) return true
  }
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(text) || /^(?:file|data):/iu.test(text) || /^[A-Za-z0-9.-]+:\d{2,5}(?:[/?#]|$)/u.test(text)
}

const envValue = z
  .string()
  .max(16 * 1024)
  .refine(value => !value.includes('\0'))
const arg = z
  .string()
  .max(4096)
  .refine(value => !value.includes('\0'))
const agentRef = z.string().regex(/^agt_[a-f0-9-]{36}$/u)
const projectRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u)
export const scopeSchema = z.strictObject({
  all: z.boolean(),
  agents: z.array(agentRef).max(64),
  projects: z.array(projectRef).max(64),
})
const failure = z.enum(['spawn-failed', 'exited', 'timeout', 'protocol', 'list-failed', 'output-too-large'])
const reportSchema = z.strictObject({
  status: z.enum(['ok', 'failed']),
  tools: z.array(toolName).max(256),
  reason: failure.optional(),
  at: stamp,
  via: z.enum(['test', 'session']),
})
const recordSchema = z.strictObject({
  id: serverId,
  name: z.string().refine(isMcpServerName),
  transport: z.literal('stdio'),
  /** The absolute path found when it was saved. */
  command: z.string().min(1).max(4096),
  args: z.array(arg).max(64),
  /** Plain variables: their values are part of what was confirmed, and devices may read them. */
  env: z.record(envName, envValue),
  /** Secret variables, by name: their values are in secrets.json. */
  secretNames: z.array(envName).max(32),
  projectCwd: z.boolean(),
  scope: scopeSchema,
  enabled: z.boolean(),
  disabledTools: z.array(toolName).max(256),
  revision: z.number().int().min(1),
  /** SHA-256 of what runs now: command, arguments, plain variables, secret names, working directory. */
  specHash: z.string().regex(/^[0-9a-f]{64}$/u),
  /**
   * What the local confirmation approved: the hash of the definition with the secret names it named, and those names.
   * Set only when a confirmation passes; removing a secret variable later keeps it. `isConfirmed` checks a definition
   * against it before anything runs.
   */
  confirmed: z.strictObject({ hash: z.string().regex(/^[0-9a-f]{64}$/u), secretNames: z.array(envName).max(32) }),
  report: reportSchema.optional(),
  createdAt: stamp,
  updatedAt: stamp,
})
export type McpServerRecord = z.infer<typeof recordSchema>
const receiptSchema = z.strictObject({
  key: z.string().regex(/^[0-9a-f]{64}$/u),
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/u),
  serverId: serverId,
})
const serversFile = z.strictObject({
  v: z.literal(1),
  revision: z.number().int().min(0),
  servers: z.array(recordSchema).max(MAX_SERVERS),
  receipts: z.array(receiptSchema).max(MAX_RECEIPTS),
})
const secretsFile = z.strictObject({
  v: z.literal(1),
  servers: z.record(serverId, z.strictObject({ env: z.record(envName, envValue) })),
})
type ServersFile = z.infer<typeof serversFile>
type SecretsFile = z.infer<typeof secretsFile>

/** What a person enters for a local command. */
export const specInput = {
  name: z.string().refine(isMcpServerName, { message: 'name' }),
  command: z.string().min(1).max(4096),
  args: z.array(arg).max(64),
  projectCwd: z.boolean(),
}
export const envInput = z.record(envName, envValue).refine(value => Object.keys(value).length <= 32)
export const envPatch = z.record(envName, envValue.nullable()).refine(value => Object.keys(value).length <= 32)

/** The part of a definition that decides what runs. */
export interface McpSpec {
  command: string
  args: string[]
  /** Plain variables and their values. */
  env: Record<string, string>
  secretNames: string[]
  projectCwd: boolean
}

export function specHash(spec: McpSpec): string {
  return sha256Hex(
    canonicalJson({
      command: spec.command,
      args: spec.args,
      env: spec.env,
      secretNames: spec.secretNames.toSorted(),
      projectCwd: spec.projectCwd,
    }),
  )
}

/** Whether a saved definition is one a confirmation approved: its program as confirmed, and no secret name it did not name. */
export function isConfirmed(record: Pick<McpServerRecord, keyof McpSpec | 'confirmed'>): boolean {
  return (
    specHash({ ...record, secretNames: record.confirmed.secretNames }) === record.confirmed.hash
    && record.secretNames.every(name => record.confirmed.secretNames.includes(name))
  )
}

/** A server's state as far as widening goes. */
export interface McpState extends McpSpec {
  scope: McpScope
  enabled: boolean
  disabledTools: string[]
  /** Each secret variable's value, by its SHA-256. */
  secretHashes: Record<string, string>
}

/**
 * The one rule for what a change widens. `spec`: it runs something not confirmed (another program, arguments, folder or
 * plain variable, or a new secret name), which takes `mcp.server.apply`. `use`: what was confirmed reaches more
 * (「用在」 gains an Agent, a project or every session, a tool comes back on, the server is switched on) or a secret
 * value changes; no confirmation, but on record before it takes effect. `false`: it only narrows or renames.
 */
export function widens(before: McpState, after: McpState): 'spec' | 'use' | false {
  if (
    before.command !== after.command
    || canonicalJson(before.args) !== canonicalJson(after.args)
    || before.projectCwd !== after.projectCwd
    || canonicalJson(before.env) !== canonicalJson(after.env)
    || after.secretNames.some(name => !before.secretNames.includes(name))
  )
    return 'spec'
  // A secret taken away changes what the server is given: on record first, as a rotation is.
  if (before.secretNames.some(name => !after.secretNames.includes(name))) return 'use'
  const gains =
    (after.scope.all && !before.scope.all)
    || (!after.scope.all
      && (after.scope.agents.some(id => !before.scope.agents.includes(id))
        || after.scope.projects.some(id => !before.scope.projects.includes(id))))
  if (
    gains
    || (after.enabled && !before.enabled)
    || before.disabledTools.some(tool => !after.disabledTools.includes(tool))
    || secretRotated(before, after)
  )
    return 'use'
  return false
}

/**
 * Each runner's options: those that name what runs (`target`), those that take a value of their own (`value`), and
 * those that make what runs unclear (`ambiguous`: code given inline). A subcommand is skipped before the first
 * positional argument (`run`).
 */
interface RunnerOptions {
  target?: readonly string[]
  value: readonly string[]
  ambiguous?: readonly string[]
  subcommand?: string
}
const RUNNERS: Readonly<Record<string, RunnerOptions>> = {
  npx: { target: ['--package', '-p'], value: ['--cache', '--userconfig', '--workspace', '-w', '--registry'], ambiguous: ['--call', '-c'] },
  pnpx: { target: ['--package'], value: ['--dir', '-C', '--registry'], ambiguous: ['--shell-mode', '-c'] },
  bunx: { target: ['--package', '-p'], value: ['--registry'] },
  uvx: {
    target: ['--from'],
    value: [
      '--with',
      '--with-requirements',
      '--python',
      '-p',
      '--index',
      '--index-url',
      '--extra-index-url',
      '--find-links',
      '-f',
      '--constraints',
      '-c',
      '--overrides',
    ],
  },
  pipx: { target: ['--spec'], value: ['--python', '--pip-args', '--index-url', '-i'], subcommand: 'run' },
  node: {
    value: ['--require', '-r', '--import', '--loader', '--experimental-loader', '--input-type', '--conditions', '-C', '--env-file'],
    ambiguous: ['--eval', '-e', '--print', '-p'],
  },
  python: { target: ['-m'], value: ['-W', '-X', '-Q'], ambiguous: ['-c'] },
  python3: { target: ['-m'], value: ['-W', '-X', '-Q'], ambiguous: ['-c'] },
  deno: {
    value: ['--config', '-c', '--import-map', '--location', '--cert', '--lock', '--env-file', '--seed', '--v8-flags', '--inspect'],
    ambiguous: ['--eval'],
    subcommand: 'run',
  },
  ruby: { value: ['-r', '-I', '-C', '-E', '-F', '-K', '-T'], ambiguous: ['-e'] },
}

/**
 * What a package runner or interpreter will run, for the system sheet: the package or script its options name
 * (`npx -p <pkg>`, `uvx --from <src>`, `python -m <module>`), or its first positional argument. When the options leave it
 * unclear (inline code, an option it does not know), the raw first argument, marked `ambiguous`. Undefined for any
 * other program, or with no argument at all.
 */
export function runnerTarget(command: string, args: readonly string[]): { target: string; ambiguous: boolean } | undefined {
  const base = command.split('/').pop() ?? command
  const options = Object.hasOwn(RUNNERS, base) ? RUNNERS[base]! : undefined
  if (!options || args.length === 0) return undefined
  const raw = { target: args[0]!, ambiguous: true }
  let skipped = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--') return args[index + 1] ? { target: args[index + 1]!, ambiguous: false } : raw
    if (!arg.startsWith('-')) {
      if (options.subcommand && !skipped && arg === options.subcommand) {
        skipped = true
        continue
      }
      return { target: arg, ambiguous: false }
    }
    const [name, attached] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
    if (options.ambiguous?.includes(name)) return raw
    if (options.target?.includes(name)) {
      const value = attached ?? args[index + 1]
      return value ? { target: value, ambiguous: false } : raw
    }
    if (options.value.includes(name)) {
      if (attached === undefined) index++
      continue
    }
    // A short option with its value attached (`-rlib`, `-mmodule`): `-m` names what runs, the rest take values.
    if (/^-[A-Za-z]./u.test(arg) && !arg.startsWith('--')) {
      const short = arg.slice(0, 2)
      if (options.target?.includes(short)) return { target: arg.slice(2), ambiguous: false }
      if (options.ambiguous?.includes(short)) return raw
      if (options.value.includes(short)) continue
    }
    // Any other `--option=value` is self-contained; an unknown bare option might take the next argument, so what runs
    // is unclear.
    if (attached !== undefined) continue
    if (/^--?[A-Za-z][A-Za-z0-9-]*$/u.test(arg) && KNOWN_FLAGS.has(arg)) continue
    return raw
  }
  return raw
}

/** Options known to take no value, across the runners. */
const KNOWN_FLAGS = new Set([
  '-y',
  '--yes',
  '--no',
  '--quiet',
  '-q',
  '--bun',
  '--silent',
  '-s',
  '-u',
  '-B',
  '-E',
  '-I',
  '-O',
  '-S',
  '-A',
  '--allow-all',
  '--isolated',
  '--offline',
  '--no-cache',
  '--verbose',
  '-v',
  '--no-install',
  '--prefer-offline',
  '--experimental-strip-types',
  '--no-warnings',
  '--enable-source-maps',
  '-w',
  '--disable-gems',
  '-W0',
])

/** Whether a secret variable both states have got another value. */
export function secretRotated(before: Pick<McpState, 'secretHashes'>, after: Pick<McpState, 'secretHashes'>): boolean {
  return Object.entries(after.secretHashes).some(
    ([name, hash]) => before.secretHashes[name] !== undefined && before.secretHashes[name] !== hash,
  )
}

/** Whether 「用在」 lost any session it had. */
export function scopeNarrows(before: McpScope, after: McpScope): boolean {
  if (after.all) return false
  if (before.all) return true
  return before.agents.some(id => !after.agents.includes(id)) || before.projects.some(id => !after.projects.includes(id))
}

const invalid = (code: string, message: string) => new AppError(400, code, message)

/** Whether `path` is `root` or inside it, segment by segment (`/proj/..bin/x` is inside `/proj`). */
export function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel.split(sep)[0] !== '..')
}

/**
 * The absolute path a command runs as, found by the rule Harness commands follow (`resolveCommand`), refused when it is
 * in the data directory, Latch's program directory or a project's folder: a program the repository or the Host's own
 * files hold is never what a person confirms here.
 */
export async function locateCommand(
  command: string,
  resolve: (command: string) => string | undefined,
  forbidden: readonly string[],
): Promise<string> {
  const found = resolve(command)
  if (!found) throw invalid('mcp-command-not-found', `找不到命令 ${command.slice(0, 64)}`)
  let real: string
  try {
    real = await realpath(found)
  } catch {
    throw invalid('mcp-command-not-found', `找不到命令 ${command.slice(0, 64)}`)
  }
  for (const root of forbidden) {
    const roots = [root, await realpath(root).catch(() => root)]
    if (roots.some(item => within(item, found) || within(item, real)))
      throw invalid('mcp-command-forbidden', '命令不能位于 Latch 的数据目录、程序目录或项目文件夹里')
  }
  return found
}

/** A random ID, `mcp_` and 22 base64url characters. */
export const newServerId = () => `mcp_${randomBytes(16).toString('base64url')}`

/** The variables a server's process gets besides its own: enough to find programs and a home, nothing of the Host's. */
const BASE_ENV = ['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL', 'TERM']
const PROXY_ENV = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']

/**
 * A server's whole environment: a PATH that finds its command's neighbours and the person's programs, the few base
 * variables, and its own. Nothing else of the Host's environment or the agent's (a gateway token, a model key).
 */
export function serverEnvironment(
  command: string,
  own: Readonly<Record<string, string>>,
  directories: readonly string[],
  hostEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of [...BASE_ENV, ...PROXY_ENV]) {
    const value = hostEnv[name]
    if (value) env[name] = value
  }
  env.PATH = [...new Set([dirname(command), ...directories.filter(directory => directory && isAbsolute(directory))])].join(delimiter)
  return { ...env, ...own }
}

/** `${workspaceFolder}` in an argument is the session's main folder. */
export function expandArgs(args: readonly string[], workspaceFolder: string | undefined): string[] {
  return args.map(value => value.replaceAll('${workspaceFolder}', workspaceFolder ?? ''))
}

/** Whether a server is used in a session of `agentId` (one of 我的 Agent) in `projectId`. */
export function usedIn(scope: McpScope, session: { agentId?: string; projectId?: string }): boolean {
  if (scope.all) return true
  return (
    (session.agentId !== undefined && scope.agents.includes(session.agentId))
    || (session.projectId !== undefined && scope.projects.includes(session.projectId))
  )
}

export function serverView(record: McpServerRecord, secrets: Readonly<Record<string, string>>): McpServerView {
  return {
    id: record.id,
    name: record.name,
    transport: record.transport,
    command: record.command,
    args: [...record.args],
    env: [
      ...Object.entries(record.env).map(([name, value]) => ({ name, set: true, secret: false, value })),
      ...record.secretNames.map(name => ({ name, set: Object.hasOwn(secrets, name) && secrets[name] !== '', secret: true })),
    ],
    projectCwd: record.projectCwd,
    scope: structuredClone(record.scope),
    enabled: record.enabled,
    disabledTools: [...record.disabledTools],
    revision: record.revision,
    ...(isUnpinnedRunner(record.command, record.args) ? { unpinned: true as const } : {}),
    ...(record.report ? { report: structuredClone(record.report) } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** The two files and their one writer. Every change is written before it is answered. */
export class McpStore {
  private servers: ServersFile
  private secrets: SecretsFile
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(
    private readonly directory: string,
    private readonly now: () => number,
    servers: ServersFile,
    secrets: SecretsFile,
  ) {
    this.servers = servers
    this.secrets = secrets
    this.exposeSecrets()
  }

  static async open(dataDir: string, now: () => number = Date.now): Promise<McpStore> {
    const directory = join(dataDir, MCP_DIRECTORY)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AppError(500, 'mcp-store-insecure', 'MCP 服务器的目录不安全')
    await chmod(directory, 0o700)
    const rawServers = await readJson(join(directory, SERVERS_FILE))
    const rawSecrets = await readJson(join(directory, SECRETS_FILE))
    const servers = rawServers === undefined ? { v: 1 as const, revision: 0, servers: [], receipts: [] } : serversFile.parse(rawServers)
    const secrets = rawSecrets === undefined ? { v: 1 as const, servers: {} } : secretsFile.parse(rawSecrets)
    for (const name of [SERVERS_FILE, SECRETS_FILE]) await chmod(join(directory, name), 0o600).catch(() => {})
    return new McpStore(directory, now, servers, secrets)
  }

  /** Every secret value of 8 characters or more is masked in what the Host sends out (`redactKnownSecrets`). */
  private exposeSecrets(): void {
    setKnownSecrets(
      'mcp',
      Object.values(this.secrets.servers).flatMap(entry => Object.values(entry.env)),
    )
  }

  private stamp(): string {
    return new Date(this.now()).toISOString()
  }

  revision(): number {
    return this.servers.revision
  }

  list(): McpServersResponse {
    return {
      revision: this.servers.revision,
      servers: this.servers.servers.map(record => serverView(record, this.secrets.servers[record.id]?.env ?? {})),
    }
  }

  records(): readonly McpServerRecord[] {
    return this.servers.servers
  }

  get(id: string): McpServerRecord | undefined {
    return this.servers.servers.find(record => record.id === id)
  }

  view(id: string): McpServerView | undefined {
    const record = this.get(id)
    return record && serverView(record, this.secrets.servers[id]?.env ?? {})
  }

  /** The values of a server's variables, for its launch only. */
  secretsOf(id: string): Record<string, string> {
    return { ...this.secrets.servers[id]?.env }
  }

  /** The servers a session gets now: on, and used in it. */
  usedIn(session: { agentId?: string; projectId?: string }): McpServerRecord[] {
    return this.servers.servers.filter(record => record.enabled && usedIn(record.scope, session))
  }

  /** What a request with this ID was answered before, or a conflict when the ID came with another body. */
  receipt(deviceId: string, requestId: string, payload: unknown): { serverId: string } | undefined {
    const key = sha256Hex(canonicalJson([deviceId, requestId]))
    const found = this.servers.receipts.find(item => item.key === key)
    if (!found) return undefined
    if (found.payloadHash !== sha256Hex(canonicalJson(payload)))
      throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同的修改')
    return { serverId: found.serverId }
  }

  /**
   * One change, serialized with the others: `change` edits copies of both files and returns the server it touched;
   * they are written (secrets first) before anything is answered. A request ID names the change for a retry.
   */
  change(
    receipt: { deviceId: string; requestId: string; payload: unknown } | undefined,
    change: (draft: { servers: ServersFile; secrets: SecretsFile; stamp: string }) => string,
  ): Promise<string> {
    const run = this.queue.then(async () => {
      const servers = structuredClone(this.servers)
      const secrets = structuredClone(this.secrets)
      const id = change({ servers, secrets, stamp: this.stamp() })
      servers.revision += 1
      if (receipt) {
        servers.receipts.push({
          key: sha256Hex(canonicalJson([receipt.deviceId, receipt.requestId])),
          payloadHash: sha256Hex(canonicalJson(receipt.payload)),
          serverId: id,
        })
        if (servers.receipts.length > MAX_RECEIPTS) servers.receipts.splice(0, servers.receipts.length - MAX_RECEIPTS)
      }
      if (servers.servers.length > MAX_SERVERS) throw new AppError(409, 'mcp-limit', `最多保存 ${MAX_SERVERS} 个 MCP 服务器`)
      const parsedServers = serversFile.parse(servers)
      const parsedSecrets = secretsFile.parse(secrets)
      const secretsChanged = canonicalJson(parsedSecrets) !== canonicalJson(this.secrets)
      if (secretsChanged) await writeFileAtomic(join(this.directory, SECRETS_FILE), `${JSON.stringify(parsedSecrets)}\n`)
      try {
        await writeFileAtomic(join(this.directory, SERVERS_FILE), `${JSON.stringify(parsedServers, null, 2)}\n`)
      } catch (error) {
        if (secretsChanged) await writeFileAtomic(join(this.directory, SECRETS_FILE), `${JSON.stringify(this.secrets)}\n`).catch(() => {})
        throw error
      }
      this.servers = parsedServers
      this.secrets = parsedSecrets
      this.exposeSecrets()
      return id
    })
    this.queue = run.catch(() => {})
    return run
  }

  /** The latest report on a server, kept only while its definition is the one that was reported on. */
  report(id: string, specAt: string, report: Omit<McpReport, 'at'>): Promise<void> {
    if (this.get(id)?.specHash !== specAt) return Promise.resolve()
    return this.change(undefined, ({ servers, stamp: at }) => {
      const record = servers.servers.find(item => item.id === id)
      if (record && record.specHash === specAt) record.report = { ...report, at }
      return id
    }).then(() => {})
  }
}

// ---- 测试 -------------------------------------------------------------------------------------

export interface McpLaunch {
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
}

/** The longest 测试 may take, start to end; the process group is ended after it. */
export const TEST_TIMEOUT_MS = 20_000
const TEST_OUTPUT_LIMIT = 1024 * 1024
const PROTOCOL_VERSION = '2025-06-18'

/**
 * Runs a confirmed server once, the way 测试 does: in a new empty folder, `initialize` then `tools/list`, within
 * `timeoutMs`, reading at most 1 MiB of its output and nothing of its stderr; then its whole process group is ended and
 * the folder removed. Only ever on the person's press.
 */
export async function testServer(
  launch: Omit<McpLaunch, 'cwd'>,
  options: { tmpRoot: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<{ status: 'ok'; tools: string[] } | { status: 'failed'; reason: McpFailure }> {
  const cwd = await mkdtemp(join(options.tmpRoot, 'mcp-test-'))
  const timeoutMs = options.timeoutMs ?? TEST_TIMEOUT_MS
  try {
    return await new Promise(resolve => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(launch.command, launch.args, { cwd, env: launch.env, stdio: ['pipe', 'pipe', 'ignore'], detached: true })
      } catch {
        resolve({ status: 'failed', reason: 'spawn-failed' })
        return
      }
      let settled = false
      let size = 0
      let buffer = ''
      const end = (result: Awaited<ReturnType<typeof testServer>>) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', aborted)
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* Already gone. */
        }
        resolve(result)
      }
      const aborted = () => end({ status: 'failed', reason: 'timeout' })
      const timer = setTimeout(aborted, timeoutMs)
      options.signal?.addEventListener('abort', aborted, { once: true })
      const send = (message: Record<string, unknown>) => {
        if (!child.stdin?.destroyed) child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
      }
      child.stdin?.on('error', () => {})
      child.once('error', () => end({ status: 'failed', reason: 'spawn-failed' }))
      child.once('exit', () => end({ status: 'failed', reason: 'exited' }))
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        size += Buffer.byteLength(chunk)
        if (size > TEST_OUTPUT_LIMIT) {
          end({ status: 'failed', reason: 'output-too-large' })
          return
        }
        buffer += chunk
        for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
          const line = buffer.slice(0, at)
          buffer = buffer.slice(at + 1)
          let message: { id?: unknown; result?: unknown; error?: unknown; method?: unknown }
          try {
            message = JSON.parse(line) as typeof message
          } catch {
            continue
          }
          // A request of the server's own (sampling, roots, elicitation) is declined.
          if (typeof message.method === 'string' && message.id !== undefined) {
            send({ id: message.id, error: { code: -32601, message: 'Method not found' } })
            continue
          }
          if (message.id === 1) {
            if (!message.result || typeof message.result !== 'object') {
              end({ status: 'failed', reason: 'protocol' })
              return
            }
            send({ method: 'notifications/initialized' })
            send({ id: 2, method: 'tools/list', params: {} })
          } else if (message.id === 2) {
            const parsed = z.object({ tools: z.array(z.object({ name: z.string() }).passthrough()).max(1024) }).safeParse(message.result)
            if (!parsed.success) {
              end({ status: 'failed', reason: 'list-failed' })
              return
            }
            end({
              status: 'ok',
              tools: parsed.data.tools
                .map(tool => tool.name)
                .filter(name => toolName.safeParse(name).success)
                .slice(0, 256),
            })
          }
        }
      })
      send({
        id: 1,
        method: 'initialize',
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'latch', version: '1' } },
      })
    })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

/** The hash an audit record names a tool by: its server and its name, never the name itself. */
export function toolHash(serverIdValue: string, tool: string): string {
  return createHash('sha256').update(`${serverIdValue}\0${tool}`).digest('hex')
}
