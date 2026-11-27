/** Whether a harness is logged in, and how a person logs in: its own commands, run in its own environment. */
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { AGENT_PRESETS, isReservedAgentEnvName, type AgentRecord, type HarnessLogin } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { redactSecrets } from '@latch/core/node-kit'
import { authFacts, CURSOR_SDK_SIGN_IN, type TerminalLogin } from './auth.ts'
import { redactor, resolveCommand } from './command.ts'
import { accountEnvironment, agentEnvironment } from './environment.ts'
import { ALWAYS_INHERITED } from './login-shell.ts'
import { routeCommand, selectProfile } from './permission.ts'
import type { LoginCheck, QuotaCommand } from './profiles/index.ts'
import { QWEN_ACCOUNT_MINIMUM } from './profiles/qwen.ts'
import type { QuotaReport } from './quota.ts'

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
  if (record.accountDirectory !== undefined && preset?.id === 'antigravity') return undefined
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
  // The adapter's own, or for a harness with no login command (its vendor's own flow), the preset's program.
  if (status.program === 'adapter' || !preset.login) {
    const path = locate(routeCommand(record, preset))
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
  if (!path || !known || (record.accountDirectory !== undefined && record.presetId === 'antigravity')) return undefined
  return {
    path,
    logins: selectProfile(record).preset?.signIn || record.accountDirectory !== undefined ? [] : known.logins,
    logout: known.logout,
  }
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
  const { preset, profile } = selectProfile(record)
  if (profile?.wire === 'cursor') return { note: CURSOR_SDK_SIGN_IN }
  const known = advertised(record)
  const methods = known?.logins ?? []
  const program = methods.length ? undefined : loginProgram(record)
  const note =
    program && record.accountDirectory !== undefined
      ? [preset?.login?.note, '请在 Host 电脑上使用这个账号的配置目录登录。'].filter(Boolean).join(' ')
      : program
        ? preset?.login?.note
        : preset?.signIn
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
  /** A read that is not a status check: its own ceiling for the wait and the output, and variables for this run only. */
  quota?: { timeoutMs: number; maxOutput: number; env: Readonly<Record<string, string>> }
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
  const env = {
    ...agentEnvironment({
      resolvedCommand: path,
      profile: selectProfile(record).profile?.permission,
      definitionEnv: record.env,
      account: record,
      sessionTmpDir: tmpdir(),
    }),
    ...options.quota?.env,
  }
  const ceiling = options.quota?.timeoutMs ?? STATUS_TIMEOUT_MS
  const maxOutput = options.quota?.maxOutput ?? MAX_OUTPUT
  return new Promise(resolve => {
    const cwd = record.presetId === 'qwen' && record.accountDirectory !== undefined ? record.accountDirectory : tmpdir()
    const child = spawn(path, [...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let output = ''
    let stdout = ''
    const keep = (chunk: string) => {
      if (output.length < maxOutput) output += chunk
    }
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* Already gone. */
      }
    }
    // A caller may shorten the wait, never lengthen it.
    const timer = setTimeout(kill, Math.min(options.timeoutMs ?? ceiling, ceiling))
    options.signal?.addEventListener('abort', kill, { once: true })
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      keep(chunk)
      if (stdout.length < maxOutput) stdout += chunk
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
export async function readOwnVersion(
  record: AgentRecord,
  path: string,
  options: RunOptions = {},
  own?: { readonly args: readonly string[]; read(output: string): string | undefined },
): Promise<string | undefined> {
  const gate = own ?? selectProfile(record).profile?.minimumVersion
  if (!gate || !locate) return undefined
  const result = await runProgram(record, path, gate.args, options)
  // Standard output only: a notice on standard error (an update available, a deprecation) may name other versions.
  return result?.code === 0 ? gate.read(result.stdout) : undefined
}

const QUOTA_MAX_OUTPUT = 256 * 1024

/**
 * Runs a profile's limits command, the preset's own program with `command.args`, by the rules a login check follows:
 * only once the start script has let the Host run the person's programs, in the harness's environment, without a shell,
 * a prompt or a secret in the arguments, and killed with its group at `command.timeoutMs`. Standard output of a run that
 * exited 0 goes to `command.read` and nowhere else. Undefined: not allowed, failed, timed out, or a shape it does not know.
 */
export async function readQuotaCommand(
  record: AgentRecord,
  command: QuotaCommand,
  now: number,
  options: { signal?: AbortSignal } = {},
): Promise<QuotaReport | undefined> {
  const preset = selectProfile(record).preset
  const path = preset && locate?.(preset.command)
  if (!path) return undefined
  const result = await runProgram(record, path, command.args, {
    ...(options.signal ? { signal: options.signal } : {}),
    quota: { timeoutMs: command.timeoutMs, maxOutput: QUOTA_MAX_OUTPUT, env: command.env ?? {} },
  })
  return result?.code === 0 ? command.read(result.stdout, now) : undefined
}

/**
 * Runs the preset's own program with a profile's fixed arguments, by the rules a login check follows, and gives back its
 * exit code and standard output. Undefined: not allowed, could not start, timed out or killed.
 */
export async function runPresetProgram(
  record: AgentRecord,
  args: readonly string[],
  limits: { timeoutMs: number; maxOutput: number },
): Promise<{ code: number | null; stdout: string } | undefined> {
  const preset = selectProfile(record).preset
  const path = preset && locate?.(preset.command)
  if (!path) return undefined
  const result = await runProgram(record, path, args, { quota: { ...limits, env: {} } })
  return result ? { code: result.code, stdout: result.stdout } : undefined
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
 *
 * `inLatch`: for a Latch terminal, which shows how the command ended itself. The same command, last in the script so
 * that its exit code is the script's, and no closing words about a window.
 */
export function loginTerminalScript(record: AgentRecord, method?: string, options: { inLatch?: boolean } = {}): string | undefined {
  if (selectProfile(record).profile?.wire === 'cursor') return undefined
  if (method !== undefined) {
    const login = advertised(record)?.logins.find(item => item.id === method)
    if (!login) {
      const before = authFacts(record)?.advertisement()
      if (
        before
        && record.accountDirectory === undefined
        && !selectProfile(record).preset?.signIn
        && before.logins.some(item => item.id === method)
      )
        throw new AppError(409, 'login-program-changed', '这个登录方式来自之前找到的程序，现在找到的不是它。请重新检测后再试。')
      return undefined
    }
    const path = resolveCommand(record.command)!
    const run = [
      ...Object.entries(login.env).map(([name, value]) => `${name}=${shellQuote(value)}`),
      ...[path, ...record.args, ...login.args].map(shellQuote),
    ].join(' ')
    const head = ['#!/bin/sh', 'rm -f -- "$0"', `printf '%s\\n\\n' ${shellQuote(login.name)}`]
    if (options.inLatch) return [...head, run, ''].join('\n')
    const done = shellQuote('完成后回到 Latch。这个窗口可以关闭。')
    const failed = shellQuote('登录没有完成。可以关掉这个窗口，回到 Latch 再试一次。')
    return [...head, `if ${run}; then printf '\\n%s\\n' ${done}; else printf '\\n%s\\n' ${failed}; fi`, ''].join('\n')
  }
  const program = loginProgram(record)
  if (!program) return undefined
  const login = selectProfile(record).preset?.login
  const lines = ['#!/bin/sh', 'rm -f -- "$0"']
  if (login?.note) lines.push(`printf '%s\\n\\n' ${shellQuote(login.note)}`)
  const command = [program.path, ...program.args].map(shellQuote).join(' ')
  if (record.accountDirectory !== undefined) {
    // A person's interactive shell may already name a different API key, credential store, or runtime directory.
    // Keep the terminal, browser and network environment, then apply the account binding.
    const kept = [
      'HOME',
      'USER',
      'PATH',
      'SHELL',
      'LANG',
      'TERM',
      'DISPLAY',
      'WAYLAND_DISPLAY',
      'XDG_RUNTIME_DIR',
      'DBUS_SESSION_BUS_ADDRESS',
      ...ALWAYS_INHERITED,
    ]
    const env = accountEnvironment(record)
    // Proxy URLs can carry passwords. Pass exports through a pipe, and pass the terminal input separately to the CLI.
    const end = '#latch-login-environment-ready'
    const writeEnvironment = String.raw`
      BEGIN {
        quote = sprintf("%c", 39)
        count = split(keep, names, " ")
        for (i = 1; i <= count; i++) {
          name = names[i]
          if (!(name in ENVIRON)) continue
          value = ENVIRON[name]
          printf "export %s=%s", name, quote
          # Write single quotes as a quoted literal between two single-quoted segments.
          while ((position = index(value, quote)) > 0) {
            printf "%s%s\"%s\"%s", substr(value, 1, position - 1), quote, quote, quote
            value = substr(value, position + 1)
          }
          printf "%s%s\n", value, quote
        }
        print "${end}"
      }
    `
    const readEnvironment = [
      'read_login_environment() {',
      // On macOS, sh can source an empty /dev/fd path before its producer writes. Read the existing pipe to EOF.
      '  exports=$(/bin/cat <&3) || return 1',
      `  case "$exports" in ${shellQuote(end)}|*${shellQuote(`\n${end}`)}) ;; *) return 1 ;; esac`,
      '  eval "$exports" 2>/dev/null',
      '}',
      'if ! read_login_environment; then',
      `  printf '%s\\n' ${shellQuote('无法读取登录终端环境，未运行登录命令。')} >&2`,
      '  exit 1',
      'fi',
      'exec 3<&-',
      'unset exports',
      ...Object.entries(env).map(([key, path]) => `export ${key}=${shellQuote(path)}`),
      'exec "$@"',
    ].join('\n')
    lines.push(
      `[ "$(cd -P ${shellQuote(record.accountDirectory)} 2>/dev/null && pwd -P)" = ${shellQuote(record.accountDirectory)} ] || exit 1`,
      'run_login() (',
      '  exec 4<&0',
      `  LC_ALL=C /usr/bin/awk -v keep=${shellQuote(kept.filter(name => !Object.hasOwn(env, name)).join(' '))} ${shellQuote(writeEnvironment)} |`,
      `    /usr/bin/env -i /bin/sh -c ${shellQuote(readEnvironment)} latch-login "$@" 3<&0 0<&4 4<&-`,
      ')',
    )
    if (record.presetId === 'qwen') {
      // Qwen skips project dotenv lookup when its working directory is HOME. Check the actual program the terminal runs.
      const accepts = String.raw`
        /^[[:space:]]*$/ { next }
        /^[[:space:]]*v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?[[:space:]]*$/ {
          sub(/^[[:space:]]*v?/, "")
          split($0, version, /[.-]/)
          split(minimum, need, /[.]/)
          for (i = 1; i <= 3; i++) {
            if (version[i] + 0 != need[i] + 0) {
              valid = version[i] + 0 > need[i] + 0
              exit
            }
          }
          valid = ($0 !~ /-/)
          exit
        }
        { exit }
        END { exit !valid }
      `
      lines.push(
        `cd -P ${shellQuote(record.accountDirectory)} || exit 1`,
        `version=$(run_login ${shellQuote(program.path)} --version 2>/dev/null) && [ -n "$version" ] && printf '%s\\n' "$version" | /usr/bin/awk -v minimum=${shellQuote(QWEN_ACCOUNT_MINIMUM)} ${shellQuote(accepts)} || {`,
        `  printf '%s\\n' ${shellQuote(`Qwen Code 独立账号需要可确认的 ${QWEN_ACCOUNT_MINIMUM} 或更高版本。请更新后重试。`)}`,
        '  exit 1',
        '}',
      )
    }
    lines.push(`run_login ${command}`)
  } else lines.push(command)
  if (!options.inLatch) lines.push(`printf '\\n%s\\n' ${shellQuote('完成后回到 Latch。这个窗口可以关闭。')}`)
  return `${lines.join('\n')}\n`
}

/** A preset as a saved definition would hold it, for a draft that has not saved one. */
export function presetRecord(presetId: string): AgentRecord | undefined {
  const preset = AGENT_PRESETS.find(item => item.id === presetId)
  return preset
    ? { id: preset.id, name: preset.name, presetId: preset.id, command: preset.command, args: preset.args, env: {}, enabled: true }
    : undefined
}
