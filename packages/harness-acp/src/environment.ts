/** The environment an agent process starts with: an allowlist of the Host's variables, never the whole of it. */
import { lstatSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { harnessAccountDirectories, isReservedAgentEnvName, type AgentRecord } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { extraDirectories, resolveCommand } from './command.ts'
import { ALWAYS_INHERITED, loginShellValues } from './login-shell.ts'
import type { AcpPermissionProfile } from './profiles/index.ts'

const INHERITED = new Set(['HOME', 'LANG', 'TERM', 'USER', 'SHELL'])
/** Git reads repository hooks and fsmonitor commands from the project; both would run code the agent did not choose. */
const GIT_CONFIG: Array<[string, string]> = [
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', '/dev/null'],
  ['safe.bareRepository', 'explicit'],
]
/**
 * Removed last, whatever set them; compared case-insensitively. `LATCH_*` are the Host's own settings, a model key among
 * them.
 */
const REMOVED_PREFIXES = ['NPM_', 'LATCH_', 'DYLD_', 'LD_']

function removed(name: string): boolean {
  const upper = name.toUpperCase()
  return upper === 'NODE_OPTIONS' || REMOVED_PREFIXES.some(prefix => upper.startsWith(prefix))
}

/**
 * Script shims such as `#!/usr/bin/env node` need the interpreter installed next to them. A command found outside the
 * Host PATH gets its directory first so an older interpreter elsewhere cannot win; one found on PATH keeps the order
 * a terminal would use. Relative entries are dropped because they would resolve against the project directory.
 */
function agentPath(resolvedCommand: string, hostPaths: Array<string | undefined>): string {
  const path = hostPaths.flatMap(hostPath => (hostPath ?? '').split(delimiter)).filter(directory => directory && isAbsolute(directory))
  const own = dirname(resolvedCommand)
  const listed = path.some(directory => resolve(directory) === own)
  return [...new Set([...(listed ? [] : [own]), ...path, ...extraDirectories()])].join(delimiter)
}

/**
 * The programs a profile points its adapter at, by the path the Host finds, when the person has installed them. Absent
 * from the result, the adapter runs what it ships with. Part of the launch fingerprint: the path is what runs.
 */
export function programPaths(profile: AcpPermissionProfile | undefined): Record<string, string> {
  const paths: Record<string, string> = {}
  for (const [name, command] of Object.entries(profile?.programEnv ?? {})) {
    const found = resolveCommand(command)
    if (found) paths[name] = found
  }
  return paths
}

/** Requests to the gateway stay on this computer even where the person's proxy would take every other one. */
const LOOPBACK = ['127.0.0.1', 'localhost', '::1']

function withLoopback(value: string): string {
  const listed = value
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
  return [...new Set([...listed, ...LOOPBACK])].join(',')
}

type AccountBinding = Pick<AgentRecord, 'presetId' | 'accountDirectory'>

/** The CLI's native directories for a binding confirmed by this Host. A missing or redirected root never opens a default home. */
export function accountEnvironment(record: AccountBinding): Record<string, string> {
  const root = record.accountDirectory
  if (root === undefined) return {}
  const directories = record.presetId && harnessAccountDirectories(record.presetId)
  if (!directories) throw new AppError(409, 'harness-account-unsupported', '这个 Harness 不支持绑定账号目录。')
  const env: Record<string, string> = {}
  try {
    if (!isAbsolute(root) || realpathSync(root) !== root || !statSync(root).isDirectory()) throw new Error()
    for (const [key, child] of Object.entries(directories)) {
      const path = child ? join(root, child) : root
      // XDG trees may be absent until the CLI needs them. A link could redirect its login or history to another account.
      if (child && key.startsWith('XDG_')) {
        const entry = lstatSync(path, { throwIfNoEntry: false })
        if (entry && !entry.isDirectory()) throw new Error()
      }
      env[key] = path
    }
    if (record.presetId === 'qwen') assertLocalDotenv(root)
  } catch {
    throw new AppError(409, 'harness-account-unavailable', '绑定的账号目录不可用，请在 Host 电脑检查原来的目录。')
  }
  if (record.presetId === 'antigravity') {
    // Google resolves ADC through this file. Do not read it, or start agy on another credential source if it disappears.
    try {
      const file = lstatSync(env.GOOGLE_APPLICATION_CREDENTIALS!)
      if (!file.isFile() || (process.getuid && file.uid !== process.getuid())) throw new Error()
    } catch {
      throw new AppError(409, 'harness-account-unavailable', '这个账号目录缺少属于当前用户的 ADC 凭据文件。')
    }
    env.AGY_ADC_AUTH = 'true'
  }
  // goose's system keyring is shared by every configuration directory. Named accounts use their own file-based secrets.
  if (record.presetId === 'goose') env.GOOSE_DISABLE_KEYRING = '1'
  // QWEN_HOME alone still lets Qwen load both dotenv files under the person's normal HOME.
  if (record.presetId === 'qwen') {
    env.HOME = root
    if (process.platform === 'win32') env.USERPROFILE = root
  }
  return env
}

const QWEN_ENV_FILES = ['.env', join('.qwen', '.env')]

function envFileInfo(path: string) {
  try {
    return lstatSync(path, { throwIfNoEntry: false })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOTDIR') return undefined
    throw error
  }
}

function assertLocalDotenv(directory: string): void {
  for (const file of QWEN_ENV_FILES) {
    const path = join(directory, file)
    if (!envFileInfo(path)) continue
    const target = realpathSync(path)
    const fromDirectory = relative(directory, target)
    if (isAbsolute(fromDirectory) || fromDirectory === '..' || fromDirectory.startsWith(`..${sep}`) || !statSync(target).isFile())
      throw new Error()
  }
}

/** Qwen walks upward for the first project dotenv file. Allow the project itself, and fail closed on ancestor candidates. */
export function assertAccountWorkspace(record: AccountBinding, cwd: string, additional: readonly string[] = []): void {
  if (record.presetId !== 'qwen' || record.accountDirectory === undefined) return
  try {
    const personal = realpathSync(homedir())
    for (const directory of [cwd, ...additional]) {
      const workspace = realpathSync(directory)
      if (workspace === personal) throw new Error()
      assertLocalDotenv(workspace)
      if (workspace === record.accountDirectory) continue
      for (let ancestor = dirname(workspace); ; ancestor = dirname(ancestor)) {
        if (QWEN_ENV_FILES.some(file => envFileInfo(join(ancestor, file)))) throw new Error()
        if (ancestor === dirname(ancestor)) break
      }
    }
  } catch {
    throw new AppError(409, 'harness-account-unavailable', 'Qwen Code 可能从项目外加载 .env，无法确认会使用所选账号。请选择其他项目目录。')
  }
}

/** The values of the profile's `inheritEnv` the agent gets, as `agentEnvironment` takes them: the Host's before the login shell's. */
export function inheritedValues(
  profile: AcpPermissionProfile | undefined,
  hostEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const shell = loginShellValues()
  const values: Record<string, string> = {}
  for (const name of profile?.inheritEnv ?? []) {
    const value = hostEnv[name] || shell[name]
    if (value) values[name] = value
  }
  return values
}

/**
 * Later steps win: Host allowlist, what the person's own environment names for this agent, the programs it finds, the
 * definition's variables, the profile's, then values Latch forces, the gateway's last. A Host started from a terminal
 * already holds its variables, and those beat the login shell's. `*_BASE_URL` is never inherited, and neither is a name
 * ending in KEY or TOKEN: the agent reads its own login from its own home.
 */
export function agentEnvironment(input: {
  resolvedCommand: string
  profile?: AcpPermissionProfile
  /** What the profile's `materialize` returned: paths of Host-only files. */
  materializedEnv?: Record<string, string>
  definitionEnv: Record<string, string>
  account?: AccountBinding
  sessionTmpDir: string
  /** A session on a gateway route: the variables that point the harness at it. Its token is among the values. */
  gatewayEnv?: Record<string, string>
  hostEnv?: NodeJS.ProcessEnv
  shellEnv?: Readonly<Record<string, string>>
}): Record<string, string> {
  const host = input.hostEnv ?? process.env
  const shell = input.shellEnv ?? loginShellValues()
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(host)) {
    if (value !== undefined && (INHERITED.has(name) || name.startsWith('LC_'))) env[name] = value
  }
  env.PATH = agentPath(input.resolvedCommand, [shell.PATH, host.PATH])
  for (const name of [...ALWAYS_INHERITED, ...(input.account?.accountDirectory === undefined ? (input.profile?.inheritEnv ?? []) : [])]) {
    const value = host[name] || shell[name]
    if (value) env[name] = value
  }
  Object.assign(env, programPaths(input.profile))
  // Definitions are validated when saved; this keeps a reserved name out even if one slipped through.
  for (const [name, value] of Object.entries(input.definitionEnv)) {
    if (!isReservedAgentEnvName(name)) env[name] = value
  }
  if (input.account) Object.assign(env, accountEnvironment(input.account))
  Object.assign(env, input.profile?.defaultEnv ?? {}, input.materializedEnv ?? {})
  env.TMPDIR = input.sessionTmpDir
  env.NODE_TLS_REJECT_UNAUTHORIZED = '1'
  env.GIT_CONFIG_COUNT = String(GIT_CONFIG.length)
  GIT_CONFIG.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key
    env[`GIT_CONFIG_VALUE_${index}`] = value
  })
  if (input.gatewayEnv) {
    Object.assign(env, input.gatewayEnv)
    const bypass = withLoopback([env.NO_PROXY, env.no_proxy].filter(Boolean).join(','))
    env.NO_PROXY = bypass
    env.no_proxy = bypass
  }
  for (const name of Object.keys(env)) if (removed(name)) delete env[name]
  return env
}
