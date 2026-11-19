/** The environment an agent process starts with: an allowlist of the Host's variables, never the whole of it. */
import { delimiter, dirname, isAbsolute, resolve } from 'node:path'
import { isReservedAgentEnvName } from '@latch/protocol'
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
  for (const name of [...ALWAYS_INHERITED, ...(input.profile?.inheritEnv ?? [])]) {
    const value = host[name] || shell[name]
    if (value) env[name] = value
  }
  Object.assign(env, programPaths(input.profile))
  // Definitions are validated when saved; this keeps a reserved name out even if one slipped through.
  for (const [name, value] of Object.entries(input.definitionEnv)) {
    if (!isReservedAgentEnvName(name)) env[name] = value
  }
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
