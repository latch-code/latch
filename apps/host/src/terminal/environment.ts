// The environment a terminal's shell starts with. Like an agent's (packages/harness-acp/src/environment.ts) it is an
// allowlist of the Host's variables, never the whole of it; the login shell's own profile then sets up the rest, as
// in any terminal.
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { basename, isAbsolute } from 'node:path'
import { RESERVED_ENV_PREFIXES } from '@latch/protocol'

/** Where a login shell's PATH starts on macOS; /etc/zprofile (path_helper) and the user's profile add the rest. */
export const LOGIN_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
const FALLBACK_SHELL = '/bin/zsh'
/**
 * Marks a Latch terminal, whose output devices elsewhere may watch: `TERM_PROGRAM` as other terminals set it, and
 * `LC_TERMINAL`, which ssh forwards to remote shells by default.
 */
const TERMINAL_MARK = 'Latch'

/** The command runs in a Latch terminal: what it prints may be shown on other devices. */
export function isLatchTerminal(env: NodeJS.ProcessEnv): boolean {
  return env.TERM_PROGRAM === TERMINAL_MARK || env.LC_TERMINAL === TERMINAL_MARK
}

/**
 * Taken from the Host as they are: who the user is, home, temporary files, language, and the system's ssh-agent
 * socket, which a terminal opened from the Dock has too.
 */
const INHERITED = new Set(['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'SSH_AUTH_SOCK', '__CF_USER_TEXT_ENCODING'])

/**
 * Removed last, whatever put them there, compared case-insensitively as for agents: the Host's settings (`LATCH_*`, a
 * model key among them), npm's configuration, loader injection, and Node and Electron switches (NODE_OPTIONS and
 * debugger flags in it, ELECTRON_RUN_AS_NODE).
 */
const REMOVED_PREFIXES = [...RESERVED_ENV_PREFIXES, 'NODE_', 'ELECTRON_'].map(prefix => prefix.toUpperCase())

function removed(name: string): boolean {
  const upper = name.toUpperCase()
  return REMOVED_PREFIXES.some(prefix => upper.startsWith(prefix))
}

export interface ShellCommand {
  /** An absolute path. */
  file: string
  /** `argv[0]` first: `-zsh` makes it a login shell. */
  argv: string[]
}

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

async function usableShell(path: string): Promise<boolean> {
  if (!isAbsolute(path) || hasControlCharacter(path)) return false
  try {
    await access(path, constants.X_OK)
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** The user's shell from the account database, started as a login shell; /bin/zsh when that one is unusable. */
export async function loginShell(account: () => { shell: string | null } = userInfo): Promise<ShellCommand> {
  let shell: string | null | undefined
  try {
    shell = account().shell
  } catch {
    shell = undefined
  }
  const file = shell && (await usableShell(shell)) ? shell : FALLBACK_SHELL
  return { file, argv: [`-${basename(file)}`] }
}

export function terminalEnvironment(input: { hostEnv: NodeJS.ProcessEnv; shell: string; folder: string }): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(input.hostEnv)) {
    if (value !== undefined && (INHERITED.has(name) || name.startsWith('LC_'))) env[name] = value
  }
  if (env.HOME === undefined || env.USER === undefined) {
    try {
      const account = userInfo()
      env.HOME ??= account.homedir
      env.USER ??= account.username
    } catch {
      // No account entry: the shell runs without them, as it would under env -i.
    }
  }
  if (env.LOGNAME === undefined && env.USER !== undefined) env.LOGNAME = env.USER
  // Without a UTF-8 locale the line editor treats Chinese input and output as single bytes. An app started from the
  // Dock has none.
  if (env.LANG === undefined && env.LC_ALL === undefined && env.LC_CTYPE === undefined) env.LANG = 'en_US.UTF-8'
  env.PATH = LOGIN_PATH
  env.SHELL = input.shell
  env.PWD = input.folder
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = TERMINAL_MARK
  env.LC_TERMINAL = TERMINAL_MARK
  for (const name of Object.keys(env)) if (removed(name)) delete env[name]
  return env
}
