/** The environment an agent process starts with: an allowlist of the Host's variables, never the whole of it. */
import { delimiter, dirname, isAbsolute, resolve } from 'node:path'
import { isReservedAgentEnvName } from '../../shared/agent-presets.ts'
import { extraDirectories } from './command.ts'
import type { AcpPermissionProfile } from './profiles/index.ts'

const INHERITED = new Set(['HOME', 'LANG', 'TERM', 'USER', 'SHELL'])
const PROXIES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']
/** Git reads repository hooks and fsmonitor commands from the project; both would run code the agent did not choose. */
const GIT_CONFIG: Array<[string, string]> = [
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', '/dev/null'],
  ['safe.bareRepository', 'explicit'],
]
/** Removed last, whatever set them; compared case-insensitively. */
const REMOVED_PREFIXES = ['NPM_', 'HARNESS_', 'DYLD_', 'LD_']

function removed(name: string): boolean {
  const upper = name.toUpperCase()
  return upper === 'NODE_OPTIONS' || REMOVED_PREFIXES.some(prefix => upper.startsWith(prefix))
}

/**
 * Script shims such as `#!/usr/bin/env node` need the interpreter installed next to them. A command found outside the
 * Host PATH gets its directory first so an older interpreter elsewhere cannot win; one found on PATH keeps the order
 * a terminal would use. Relative entries are dropped because they would resolve against the project directory.
 */
function agentPath(resolvedCommand: string, hostPath: string | undefined): string {
  const path = (hostPath ?? '').split(delimiter).filter(directory => directory && isAbsolute(directory))
  const own = dirname(resolvedCommand)
  const listed = path.some(directory => resolve(directory) === own)
  return [...new Set([...(listed ? [] : [own]), ...path, ...extraDirectories()])].join(delimiter)
}

/**
 * Later steps win: Host allowlist, the definition's variables, the profile's, then values Latch forces. Proxy and CA
 * variables are blanked rather than inherited; `SSL_CERT_FILE`, `SSL_CERT_DIR`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`
 * and `*_BASE_URL` are simply not inherited, because an empty value can break an SDK's own defaults.
 */
export function agentEnvironment(input: {
  resolvedCommand: string
  profile?: AcpPermissionProfile
  /** E.g. GEMINI_CLI_SYSTEM_SETTINGS_PATH. */
  materializedEnv?: Record<string, string>
  definitionEnv: Record<string, string>
  sessionTmpDir: string
  hostEnv?: NodeJS.ProcessEnv
}): Record<string, string> {
  const host = input.hostEnv ?? process.env
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(host)) {
    if (value !== undefined && (INHERITED.has(name) || name.startsWith('LC_'))) env[name] = value
  }
  env.PATH = agentPath(input.resolvedCommand, host.PATH)
  // Definitions are validated when saved; this keeps a reserved name out even if one slipped through.
  for (const [name, value] of Object.entries(input.definitionEnv)) {
    if (!isReservedAgentEnvName(name)) env[name] = value
  }
  Object.assign(env, input.profile?.defaultEnv ?? {}, input.materializedEnv ?? {})
  env.TMPDIR = input.sessionTmpDir
  for (const name of PROXIES) {
    env[name] = ''
    env[name.toLowerCase()] = ''
  }
  env.NODE_TLS_REJECT_UNAUTHORIZED = '1'
  env.NODE_EXTRA_CA_CERTS = ''
  env.GIT_CONFIG_COUNT = String(GIT_CONFIG.length)
  GIT_CONFIG.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key
    env[`GIT_CONFIG_VALUE_${index}`] = value
  })
  for (const name of Object.keys(env)) if (removed(name)) delete env[name]
  return env
}
