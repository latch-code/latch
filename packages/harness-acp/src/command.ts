import { accessSync, constants, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { loginShellValues, PROXY_NAMES } from './login-shell.ts'
import { AppError } from '@latch/sdk'

/** Install locations that a GUI-launched Host often lacks on PATH. */
const EXTRA_DIRECTORIES = ['/opt/homebrew/bin', '/usr/local/bin', '~/.npm-global/bin', '~/.local/bin', '~/.bun/bin', '~/.grok/bin']

/** An nvm alias names a version or another alias; only these characters, and never a parent directory. */
const NVM_ALIAS = /^(?!.*\.\.)[\w*./-]{1,64}$/u

/** A version as nvm writes it (v24, 24.1, v24.1.0); `node` and `stable` mean the newest installed. */
function nvmVersion(installed: string[], wanted: string): string | undefined {
  // Numeric collation orders v22.12.0 after v22.3.0.
  const newest = installed.filter(name => /^v\d+\.\d+\.\d+$/u.test(name)).toSorted((a, b) => b.localeCompare(a, 'en', { numeric: true }))
  if (wanted === 'node' || wanted === 'stable') return newest[0]
  const prefix = `v${wanted.replace(/^v/u, '')}`
  return newest.find(name => name === prefix || name.startsWith(`${prefix}.`))
}

/** nvm's default: `~/.nvm/alias/default`, followed through aliases such as lts/*, to `versions/node/<v>/bin`. */
function nvmDefault(home: string): string[] {
  const root = join(home, '.nvm')
  let name = 'default'
  for (let depth = 0; depth < 4 && NVM_ALIAS.test(name); depth++) {
    let value: string
    try {
      value = readFileSync(join(root, 'alias', name), 'utf8').trim()
    } catch {
      value = name
    }
    if (/^v?\d+(?:\.\d+){0,2}$/u.test(value) || value === 'node' || value === 'stable') {
      let installed: string[]
      try {
        installed = readdirSync(join(root, 'versions', 'node'))
      } catch {
        return []
      }
      const version = nvmVersion(installed, value)
      return version ? [join(root, 'versions', 'node', version, 'bin')] : []
    }
    if (value === name) return []
    name = value
  }
  return []
}

/** A directory named by a variable, only as an absolute path. */
const absolute = (value: string | undefined) => (value && isAbsolute(value) ? [value] : [])

/**
 * The global bin directories of the Node version and package managers in the person's home (fnm, nvm, Volta, asdf,
 * mise, pnpm and Yarn), which a Host started from the desktop does not have on PATH. A directory named by a variable
 * counts only when the variable holds an absolute path.
 */
function managerDirectories(home: string, env: NodeJS.ProcessEnv): string[] {
  const fnm = absolute(env.FNM_DIR)[0] ?? join(home, '.local', 'share', 'fnm')
  return [
    join(fnm, 'aliases', 'default', 'bin'),
    ...nvmDefault(home),
    join(home, '.volta', 'bin'),
    join(home, '.asdf', 'shims'),
    join(home, '.local', 'share', 'mise', 'shims'),
    ...absolute(env.PNPM_HOME),
    join(home, 'Library', 'pnpm'),
    join(home, '.yarn', 'bin'),
  ]
}

/** Absolute install directories searched after PATH; the agent's PATH lists them too. */
export function extraDirectories(): string[] {
  if (process.platform === 'win32') return []
  const home = homedir()
  return [
    ...EXTRA_DIRECTORIES.map(directory => (directory.startsWith('~/') ? join(home, directory.slice(2)) : directory)),
    ...managerDirectories(home, process.env),
  ]
}

/** Where a person's programs are: PATH, the login shell's PATH, then the usual install directories. */
export function personCommandDirectories(): string[] {
  const paths = [loginShellValues().PATH, process.env.PATH].flatMap(path => (path ?? '').split(delimiter))
  return [...new Set([...paths.filter(directory => directory && isAbsolute(directory)), ...extraDirectories()])]
}

let searched: (() => readonly string[]) | undefined

/**
 * Where bare command names are looked for. Off until the start script turns it on, so that a test Host, which may hold a
 * preset's definition around a fake adapter, can never find, describe or start a real agent installed on the same
 * computer; a test names its own directories.
 */
export function setCommandSearch(directories: (() => readonly string[]) | undefined): void {
  searched = directories
}

function executable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (process.platform !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Finds `command` where `setCommandSearch` says, without spawning a shell. Returns an absolute path. */
export function resolveCommand(command: string): string | undefined {
  if (typeof command !== 'string' || !command || command.length > 4096 || command.includes('\0')) return undefined
  if (isAbsolute(command)) return executable(command) ? command : undefined
  // A relative path would depend on the Host's working directory.
  if (command.includes('/') || command.includes('\\')) return undefined
  if (!searched) return undefined
  const extensions =
    process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : ['']
  for (const directory of new Set(searched().filter(directory => directory && isAbsolute(directory)))) {
    for (const extension of extensions) {
      const candidate = join(directory, command + extension)
      if (executable(candidate)) return candidate
    }
  }
  return undefined
}

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i

/** Masks configured agent variables and secret-looking Host variables in diagnostic text. */
export function redactor(extra: Record<string, string>): (text: string) => string {
  const values = new Set<string>()
  for (const [key, value] of Object.entries(extra)) {
    if (value.length >= (SECRET_NAME.test(key) ? 4 : 6)) values.add(value)
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value && value.length >= 8 && SECRET_NAME.test(key)) values.add(value)
  }
  // A proxy address may carry a password, and without a scheme the URL rule in `redactSecrets` does not see it.
  for (const name of PROXY_NAMES) {
    for (const source of [process.env[name], loginShellValues()[name]]) if (source?.includes('@')) values.add(source)
  }
  const secrets = [...values].sort((a, b) => b.length - a.length)
  return text => secrets.reduce((current, secret) => current.split(secret).join('[redacted]'), text)
}

/** A definition saved before confirmations: it starts once this Mac has confirmed it. */
export function commandUnconfirmed(name: string): AppError {
  return new AppError(
    409,
    'harness-unconfirmed',
    `${name} 还没有在这台 Mac 上确认过：在这台 Mac 上用它开始一个会话，或在「设置 → Harness」里保存一次它的命令，确认后才能启动`,
  )
}

/** A confirmed Harness whose command now resolves to another program: it waits for the Mac to confirm it again. */
export function commandMoved(name: string): AppError {
  return new AppError(409, 'harness-command-moved', `${name} 的命令现在指向另一个程序，在这台 Mac 的「设置 → Harness」里重新确认后才能启动`)
}
