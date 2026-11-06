/** Whether a harness is logged in, and how a person logs in: its own commands, run in its own environment. */
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { AGENT_PRESETS, isReservedAgentEnvName, type AgentRecord, type HarnessLogin } from '@latch/protocol'
import { agentEnvironment } from './environment.ts'
import { selectProfile } from './permission.ts'
import type { LoginStatus } from './profiles/index.ts'

const STATUS_TIMEOUT_MS = 10_000
const MAX_OUTPUT = 16 * 1024

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

/** What a client shows; Host-only details stay behind. Absent: Latch knows no login command for this harness. */
export function harnessLogin(record: AgentRecord): HarnessLogin | undefined {
  const selection = selectProfile(record)
  const program = loginProgram(record)
  if (!program) return undefined
  const note = selection.preset?.login?.note
  return {
    command: [program.command, ...program.args].join(' '),
    ...(note ? { note } : {}),
    ...(selection.profile?.loginStatus ? { checkable: true as const } : {}),
  }
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
): Promise<{ code: number | null; output: string } | undefined> {
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
    child.stdout.setEncoding('utf8').on('data', keep)
    child.stderr.setEncoding('utf8').on('data', keep)
    const done = (result: { code: number | null; output: string } | undefined) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', kill)
      resolve(result)
    }
    child.once('error', () => {
      done(undefined)
    })
    child.once('close', (code, signal) => {
      done(signal ? undefined : { code, output })
    })
  })
}

/**
 * Runs the profile's status command and reads only its verdict. Three states, like the rest of the page: a command that
 * times out, crashes or says anything else is `unknown`, which no client presents as logged out.
 */
export async function checkLogin(record: AgentRecord, options: RunOptions = {}): Promise<LoginStatus> {
  const status = selectProfile(record).profile?.loginStatus
  const program = loginProgram(record)
  if (!status || !program) return 'unknown'
  const args = program.bundled ? status.bundledArgs : status.args
  if (!args) return 'unknown'
  const result = await runProgram(record, program.path, args, options)
  return result ? status.read(result) : 'unknown'
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
  const command = preset?.agentCommand
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

const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`

/**
 * A `.command` file that runs the harness's own login in the person's terminal, with the environment that terminal has.
 * It removes itself first, holds no secret, and ends by saying what to do next. Undefined: no login command.
 */
export function loginTerminalScript(record: AgentRecord): string | undefined {
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
