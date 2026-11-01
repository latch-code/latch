/**
 * What a person's terminal knows and a Host started from the Dock does not: PATH and a few named variables, read once from
 * their login shell. Only named variables are kept; the shell's other output and its whole environment are never read.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { userInfo } from 'node:os'
import { HARNESS_PROFILES } from './profiles/index.ts'

const PROXIES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']
/** A proxy that re-signs TLS is useless without its CA file; these name a file, never its content. */
const CERTIFICATES = ['SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE']
/** mise's record of what it added to PATH; without it, a wrapper that runs `mise x` can re-run itself forever. */
const MISE = ['__MISE_DIFF']

export const PROXY_NAMES: readonly string[] = PROXIES.flatMap(name => [name, name.toLowerCase()])
/** Every agent receives these whenever the person set them. They are constant, so they do not enter a launch fingerprint. */
export const ALWAYS_INHERITED: readonly string[] = [...PROXY_NAMES, ...CERTIFICATES, ...MISE]

const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u
const READ_TIMEOUT_MS = 8_000
const MAX_OUTPUT = 512 * 1024
/** The Host's own settings hold a model key, and the Node options would attach to whatever the profile runs. */
const NOT_FOR_THE_SHELL = /^(?:LATCH_|NODE_OPTIONS$)/iu

let values: Readonly<Record<string, string>> = {}

/** The values read at startup; empty until `loadLoginShell`, and for good in tests that never call it. */
export function loginShellValues(): Readonly<Record<string, string>> {
  return values
}

/** Tests only. */
export function setLoginShellValues(next: Record<string, string>): void {
  values = next
}

function namesToRead(): string[] {
  const names = new Set(['PATH', ...ALWAYS_INHERITED])
  for (const profile of HARNESS_PROFILES.values()) for (const name of profile.permission.inheritEnv ?? []) names.add(name)
  return [...names]
}

function captured(output: string, nonce: string, name: string): string | undefined {
  const start = `__LATCH_${nonce}_${name}_START__\n`
  const from = output.indexOf(start)
  if (from < 0) return undefined
  const end = output.indexOf(`__LATCH_${nonce}_${name}_END__`, from + start.length)
  if (end < 0) return undefined
  const value = output.slice(from + start.length, end).replace(/\r?\n$/u, '')
  return value.length ? value : undefined
}

/**
 * `-ilc`, since many people set PATH in the rc file an interactive shell reads. The shell runs without a terminal and in
 * its own process group, so nothing in a profile can wait for input past the timeout or outlive it.
 */
export async function readLoginShell(
  names: readonly string[],
  options: { shell: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<Record<string, string>> {
  const safe = names.filter(name => SAFE_NAME.test(name))
  const nonce = randomBytes(8).toString('hex')
  const script = safe
    .map(
      name =>
        `printf '%s\\n' '__LATCH_${nonce}_${name}_START__'; printenv ${name} || true; printf '%s\\n' '__LATCH_${nonce}_${name}_END__'`,
    )
    .join('; ')
  const env = Object.fromEntries(Object.entries(options.env ?? process.env).filter(([name]) => !NOT_FOR_THE_SHELL.test(name)))
  const output = await new Promise<string | undefined>(resolve => {
    const child = spawn(options.shell, ['-ilc', script], { env, stdio: ['ignore', 'pipe', 'ignore'], detached: true })
    let text = ''
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* Already gone. */
      }
    }
    const timer = setTimeout(() => {
      kill()
      resolve(undefined)
    }, options.timeoutMs ?? READ_TIMEOUT_MS)
    // A daemon a profile starts can hold stdout open long after the shell is done, so the last marker ends the wait.
    const last = `__LATCH_${nonce}_${safe.at(-1) ?? ''}_END__`
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (text.length < MAX_OUTPUT) text += chunk
      if (text.includes(last)) {
        clearTimeout(timer)
        kill()
        resolve(text)
      }
    })
    child.once('error', () => {
      clearTimeout(timer)
      resolve(undefined)
    })
    child.once('close', () => {
      clearTimeout(timer)
      // Something a profile left running in the background shares the group and has no reason to stay.
      kill()
      resolve(text)
    })
  })
  const result: Record<string, string> = {}
  if (output === undefined) return result
  for (const name of safe) {
    const value = captured(output, nonce, name)
    if (value !== undefined) result[name] = value
  }
  return result
}

/**
 * Reads the login shell before the Host listens, because a launch fingerprint holds the path found through it. A shell
 * that fails or takes too long leaves the install directories Latch knows, and says so only as a count: never a value.
 */
export async function loadLoginShell(options: { shell?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<number> {
  if (process.platform === 'win32') return 0
  const env = options.env ?? process.env
  let shell = options.shell
  if (!shell) {
    try {
      shell = userInfo().shell ?? undefined
    } catch {
      shell = undefined
    }
  }
  values = await readLoginShell(namesToRead(), {
    shell: shell || env.SHELL || '/bin/zsh',
    env,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  })
  return Object.keys(values).length
}
