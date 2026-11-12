/** Whether a harness is logged in, and how a person logs in: its own commands, run in its own environment. */
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { AGENT_PRESETS, isReservedAgentEnvName, type AgentRecord, type HarnessLogin } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { redactSecrets } from '@latch/core/node-kit'
import { authFacts, type TerminalLogin } from './auth.ts'
import { redactor, resolveCommand } from './command.ts'
import { agentEnvironment } from './environment.ts'
import { selectProfile } from './permission.ts'
import type { LoginCheck } from './profiles/index.ts'

const STATUS_TIMEOUT_MS = 10_000
const MAX_OUTPUT = 16 * 1024
/** How long output may stay open after the program exited. */
const EXIT_CLOSE_MS = 500

let locate: ((command: string) => string | undefined) | undefined

/**
 * How login commands and version reads find the person's programs. Off until the start script turns it on, so that a
 * test Host, which may hold a preset's definition around a fake adapter, can never reach a real program installed on the
 * same computer.
 */
export function setLoginPrograms(locator: ((command: string) => string | undefined) | undefined): void {
  locate = locator
}

/** The preset's program when installed; otherwise the adapter's own copy, or nothing to run. */
function loginProgram(record: AgentRecord): { command: string; args: readonly string[]; path: string; bundled: boolean } | undefined {
  const preset = selectProfile(record).preset
  const login = preset?.login
  if (!login || !locate) return undefined
  const path = locate(login.command)
  if (path) return { command: login.command, args: login.args, path, bundled: false }
  const adapter = login.bundled && locate(login.bundled.command)
  return adapter ? { command: login.bundled!.command, args: login.bundled!.args, path: adapter, bundled: true } : undefined
}

/** The program and arguments a profile's status command runs, when the Host may run it. */
function statusProgram(record: AgentRecord): { path: string; args: readonly string[] } | undefined {
  const { preset, profile } = selectProfile(record)
  const status = profile?.loginStatus
  if (!status || !preset || !locate) return undefined
  if (status.program === 'adapter') {
    const path = locate(preset.command)
    return path ? { path, args: status.args } : undefined
  }
  const program = loginProgram(record)
  const args = program?.bundled ? status.bundledArgs : status.args
  return program && args ? { path: program.path, args } : undefined
}

/**
 * The logins the harness advertised, by the program it runs now. None for a harness whose vendor leaves signing in to
 * its own flow: Latch does not ask it for them, and does not run one it lists anyway.
 */
function advertised(record: AgentRecord): { path: string; logins: TerminalLogin[]; logout: boolean } | undefined {
  const path = resolveCommand(record.command)
  const known = path === undefined ? undefined : authFacts(record)?.advertisedBy(path)
  if (!path || !known) return undefined
  return { path, logins: selectProfile(record).preset?.signIn ? [] : known.logins, logout: known.logout }
}

const PLAIN_WORD = /^[\w./:=@%+,-]+$/u
const typed = (part: string) => (PLAIN_WORD.test(part) ? part : shellQuote(part))

/** A terminal login as a person would type it, with values that look like secrets masked. */
function loginLine(record: AgentRecord, login: TerminalLogin): string {
  const line = [
    ...Object.entries(login.env).map(([name, value]) => `${name}=${typed(value)}`),
    ...[record.command, ...record.args, ...login.args].map(typed),
  ].join(' ')
  return redactSecrets(redactor(record.env)(line))
}

/** What a client shows; Host-only details stay behind. Absent: Latch knows nothing about logging in to this harness. */
export function harnessLogin(record: AgentRecord): HarnessLogin | undefined {
  const preset = selectProfile(record).preset
  const known = advertised(record)
  const methods = known?.logins ?? []
  const program = methods.length ? undefined : loginProgram(record)
  const note = program ? preset?.login?.note : preset?.signIn
  const checkable = statusProgram(record) !== undefined
  const reported = authFacts(record)?.reported()
  const login: HarnessLogin = {
    ...(program ? { command: [program.command, ...program.args].join(' ') } : {}),
    ...(note ? { note } : {}),
    ...(checkable ? { checkable: true as const } : {}),
    ...(methods.length
      ? {
          methods: methods.map(method => ({
            id: method.id,
            name: method.name,
            ...(method.description ? { description: method.description } : {}),
            command: loginLine(record, method),
          })),
        }
      : {}),
    ...(known?.logout ? { logout: true as const } : {}),
    ...(reported ? { reported } : {}),
  }
  return login.command || login.methods || login.checkable || login.logout || login.reported ? login : undefined
}

interface RunOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

/**
 * Runs one of the person's programs in the harness's environment, without a shell or a prompt, and gives back how it
 * ended and what it printed, cut short. Undefined: it could not start, was killed or timed out. The output never leaves
 * the caller, since it may hold an account or part of a key.
 */
function runProgram(
  record: AgentRecord,
  path: string,
  args: readonly string[],
  options: RunOptions,
): Promise<{ code: number | null; output: string; stdout: string } | undefined> {
  if (options.signal?.aborted) return Promise.resolve(undefined)
  const env = agentEnvironment({
    resolvedCommand: path,
    profile: selectProfile(record).profile?.permission,
    definitionEnv: record.env,
    sessionTmpDir: tmpdir(),
  })
  return new Promise(resolve => {
    const child = spawn(path, [...args], { cwd: tmpdir(), env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let output = ''
    let stdout = ''
    const keep = (chunk: string) => {
      if (output.length < MAX_OUTPUT) output += chunk
    }
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* Already gone. */
      }
    }
    // A caller may shorten the wait, never lengthen it.
    const timer = setTimeout(kill, Math.min(options.timeoutMs ?? STATUS_TIMEOUT_MS, STATUS_TIMEOUT_MS))
    options.signal?.addEventListener('abort', kill, { once: true })
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      keep(chunk)
      if (stdout.length < MAX_OUTPUT) stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', keep)
    let fallback: NodeJS.Timeout | undefined
    let settled = false
    const done = (result: { code: number | null; output: string; stdout: string } | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(fallback)
      options.signal?.removeEventListener('abort', kill)
      resolve(result)
    }
    child.once('error', () => {
      done(undefined)
    })
    // A helper the program left behind may hold its output open: once the program itself exited, what it printed by
    // then is its answer, and the rest of its group is stopped.
    child.once('exit', (code, signal) => {
      kill()
      fallback = setTimeout(() => {
        child.stdout.destroy()
        child.stderr.destroy()
        done(signal ? undefined : { code, output, stdout })
      }, EXIT_CLOSE_MS)
      fallback.unref()
    })
    child.once('close', (code, signal) => {
      done(signal ? undefined : { code, output, stdout })
    })
  })
}

/**
 * Whether the status command says something a harness's own report does not, so it runs although there is one: a date,
 * and for a harness that reads its login again only when a turn starts, a verdict newer than an idle process's report.
 */
export function loginCheckAddsDate(record: AgentRecord): boolean {
  return selectProfile(record).profile?.loginStatus?.expires === true && statusProgram(record) !== undefined
}

/**
 * Runs the profile's status command and reads only its verdict. Three states, like the rest of the page: a command that
 * times out, crashes or says anything else is `unknown`, which no client presents as logged out.
 */
export async function checkLogin(record: AgentRecord, options: RunOptions = {}): Promise<LoginCheck> {
  const status = selectProfile(record).profile?.loginStatus
  const program = statusProgram(record)
  if (!status || !program) return { status: 'unknown' }
  const result = await runProgram(record, program.path, program.args, options)
  const read = result ? status.read(result) : 'unknown'
  return typeof read === 'string' ? { status: read } : read
}

/**
 * The version of the program the adapter drives, by the profile's own command; the same rules as a login check. That
 * program is the one the definition names in the profile's variable, which wins in the agent's environment, else the
 * one installed. `found: false`: neither, so the adapter runs the copy it ships. No `version`: the command failed or
 * printed none, or the definition names a path relative to the project, which a test start does not run in.
 */
export async function readProgramVersion(record: AgentRecord, options: RunOptions = {}): Promise<{ found: boolean; version?: string }> {
  const { preset, profile } = selectProfile(record)
  const read = profile?.programVersion
  const command = preset?.agentCommand ?? preset?.fallback?.drives
  if (!read || !command || !locate) return { found: false }
  const variable = Object.entries(profile.permission.programEnv ?? {}).find(([, program]) => program === command)?.[0]
  const own = variable && !isReservedAgentEnvName(variable) && Object.hasOwn(record.env, variable) ? record.env[variable] : undefined
  // The adapter treats an empty value as unset and runs its own copy.
  if (own === '') return { found: false }
  const path = locate(own ?? command)
  if (!path) return { found: own !== undefined }
  const result = await runProgram(record, path, read.args, options)
  const version = result?.code === 0 ? read.read(result.output) : undefined
  return { found: true, ...(version ? { version } : {}) }
}

/**
 * The version the agent's own command prints with the profile's `minimumVersion.args`, by the rules a login check
 * follows: only once the start script has let the Host run the person's programs, never through a shell. Undefined: not
 * allowed, failed, timed out or printed none.
 */
export async function readOwnVersion(record: AgentRecord, path: string, options: RunOptions = {}): Promise<string | undefined> {
  const gate = selectProfile(record).profile?.minimumVersion
  if (!gate || !locate) return undefined
  const result = await runProgram(record, path, gate.args, options)
  // Standard output only: a notice on standard error (an update available, a deprecation) may name other versions.
  return result?.code === 0 ? gate.read(result.stdout) : undefined
}

/** Where the Host finds one of the person's programs for version and login reads; undefined while it may not run them. */
export const locateProgram = (command: string): string | undefined => locate?.(command)

const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`

/**
 * A `.command` file that runs the harness's own login in the person's terminal, with the environment that terminal has.
 * It removes itself first, holds no secret, and ends by saying what to do next. Undefined: no login command.
 *
 * `method`: one of the logins the harness advertised, run as the program the sessions run now with the definition's
 * arguments, then the method's own arguments and variables. The definition's variables are not written into the file,
 * since they may hold a key. A method is refused once the program found is no longer the one that advertised it.
 */
export function loginTerminalScript(record: AgentRecord, method?: string): string | undefined {
  if (method !== undefined) {
    const login = advertised(record)?.logins.find(item => item.id === method)
    if (!login) {
      const before = authFacts(record)?.advertisement()
      if (before && !selectProfile(record).preset?.signIn && before.logins.some(item => item.id === method))
        throw new AppError(409, 'login-program-changed', '这个登录方式来自之前找到的程序，现在找到的不是它。请重新检测后再试。')
      return undefined
    }
    const path = resolveCommand(record.command)!
    const run = [
      ...Object.entries(login.env).map(([name, value]) => `${name}=${shellQuote(value)}`),
      ...[path, ...record.args, ...login.args].map(shellQuote),
    ].join(' ')
    const done = shellQuote('完成后回到 Latch。这个窗口可以关闭。')
    const failed = shellQuote('登录没有完成。可以关掉这个窗口，回到 Latch 再试一次。')
    return [
      '#!/bin/sh',
      'rm -f -- "$0"',
      `printf '%s\\n\\n' ${shellQuote(login.name)}`,
      `if ${run}; then printf '\\n%s\\n' ${done}; else printf '\\n%s\\n' ${failed}; fi`,
      '',
    ].join('\n')
  }
  const program = loginProgram(record)
  if (!program) return undefined
  const login = selectProfile(record).preset?.login
  const lines = ['#!/bin/sh', 'rm -f -- "$0"']
  if (login?.note) lines.push(`printf '%s\\n\\n' ${shellQuote(login.note)}`)
  lines.push(
    [program.path, ...program.args].map(shellQuote).join(' '),
    `printf '\\n%s\\n' ${shellQuote('完成后回到 Latch。这个窗口可以关闭。')}`,
  )
  return `${lines.join('\n')}\n`
}

/** A preset as a saved definition would hold it, for a draft that has not saved one. */
export function presetRecord(presetId: string): AgentRecord | undefined {
  const preset = AGENT_PRESETS.find(item => item.id === presetId)
  return preset
    ? { id: preset.id, name: preset.name, presetId: preset.id, command: preset.command, args: preset.args, env: {}, enabled: true }
    : undefined
}
