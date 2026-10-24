import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

/** Install locations that a GUI-launched Host often lacks on PATH. */
const EXTRA_DIRECTORIES = ['/opt/homebrew/bin', '/usr/local/bin', '~/.npm-global/bin', '~/.local/bin', '~/.bun/bin']

/** Absolute install directories searched after PATH; the agent's PATH lists them too. */
export function extraDirectories(): string[] {
  if (process.platform === 'win32') return []
  const home = homedir()
  return EXTRA_DIRECTORIES.map(directory => (directory.startsWith('~/') ? join(home, directory.slice(2)) : directory))
}

function searchDirectories(): string[] {
  const fromPath = (process.env.PATH ?? '').split(delimiter).filter(directory => directory && isAbsolute(directory))
  return [...new Set([...fromPath, ...extraDirectories()])]
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

/** Finds `command` on PATH and the usual install directories without spawning a shell. Returns an absolute path. */
export function resolveCommand(command: string): string | undefined {
  if (typeof command !== 'string' || !command || command.length > 4096 || command.includes('\0')) return undefined
  if (isAbsolute(command)) return executable(command) ? command : undefined
  // A relative path would depend on the Host's working directory.
  if (command.includes('/') || command.includes('\\')) return undefined
  const extensions =
    process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : ['']
  for (const directory of searchDirectories()) {
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
  const secrets = [...values].sort((a, b) => b.length - a.length)
  return text => secrets.reduce((current, secret) => current.split(secret).join('[redacted]'), text)
}
