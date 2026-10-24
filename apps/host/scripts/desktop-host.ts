import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { constants } from 'node:fs'
import { chmod, mkdir, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { readHostState, verifyHostState, type HostInfo, type HostState } from '../src/host-state.ts'
import { resolveLatchPaths } from '../src/paths.ts'

/** Variables that must never reach the Host or the shell: the shell finds the Host through host.json only. */
const DROPPED_ENV = ['HARNESS_DESKTOP_URL', 'ELECTRON_RUN_AS_NODE']

/** Without it any same-user process can open an inspector in the running Host with SIGUSR1 (`process._debugProcess`). */
const HOST_NODE_ARGS = ['--disable-sigusr1']

export function desktopLaunchOptions(argv: string[], cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env) {
  let directory: string | undefined
  const args: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg !== '--data-dir' && !arg.startsWith('--data-dir=')) {
      args.push(arg)
      continue
    }
    if (directory !== undefined) throw new Error('--data-dir may only be specified once')
    directory = arg === '--data-dir' ? argv[++index] : arg.slice('--data-dir='.length)
    if (!directory || directory.startsWith('--')) throw new Error('--data-dir requires a value')
  }
  const paths = resolveLatchPaths({ dataDir: directory === undefined ? undefined : resolve(cwd, directory), env, cwd })
  const dataDir = resolve(cwd, paths.dataDir)
  const hostEnv: NodeJS.ProcessEnv = { ...env }
  for (const name of DROPPED_ENV) delete hostEnv[name]
  return {
    dataDir,
    hostStatePath: join(dataDir, 'host.json'),
    args: ['--data-dir', dataDir, ...args],
    cwd,
    env: hostEnv,
    warnings: paths.warnings,
  }
}

export type DesktopLaunchOptions = ReturnType<typeof desktopLaunchOptions>
export type DesktopHost = HostState & { info: HostInfo }

/** host.json plus the socket checks of verifyHostState. There is no TCP or /health probing. */
export async function probeDesktopHost(dataDir: string, timeoutMs = 2_000, expectedPid?: number): Promise<DesktopHost | undefined> {
  try {
    const state = await readHostState(dataDir)
    if (!state || (expectedPid !== undefined && state.pid !== expectedPid)) return undefined
    const info = await verifyHostState(state, timeoutMs)
    return info ? { ...state, info } : undefined
  } catch {
    return undefined
  }
}

/** host.log is append-only, 0600, and never followed through a symlink. */
async function openHostLog(path: string) {
  const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  await chmod(path, 0o600)
  return handle
}

export async function ensureDesktopHost(
  options: DesktopLaunchOptions,
  startup: { script?: string; nodeArgs?: string[]; timeoutMs?: number } = {},
): Promise<DesktopHost & { reused: boolean; hostStatePath: string; notice?: string }> {
  await mkdir(options.dataDir, { recursive: true, mode: 0o700 })
  const existing = await probeDesktopHost(options.dataDir)
  if (existing)
    return {
      ...existing,
      reused: true,
      hostStatePath: options.hostStatePath,
      notice: `复用已有节点（${options.dataDir}）。本次 --demo、--harness、--provider、--plugin、--workspace、网络参数和模型环境变量不会重新应用；要更改启动配置，请先停止该目录的节点，或使用其他 --data-dir。`,
    }
  const logPath = join(options.dataDir, 'host.log')
  const log = await openHostLog(logPath)
  const child = spawn(
    process.execPath,
    [...HOST_NODE_ARGS, ...(startup.nodeArgs ?? []), startup.script ?? resolve(options.cwd, 'dist/start.js'), ...options.args],
    {
      cwd: options.cwd,
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      env: options.env,
    },
  )
  try {
    await once(child, 'spawn')
    child.unref()
  } finally {
    await log.close()
  }
  // Startup may build the macOS confirmation helper on first run, so allow more than a plain boot.
  const deadline = Date.now() + (startup.timeoutMs ?? 60_000)
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    const state = await probeDesktopHost(options.dataDir, Math.max(1, Math.min(2_000, deadline - Date.now())), child.pid)
    if (state) return { ...state, reused: false, hostStatePath: options.hostStatePath }
    await delay(100)
  }
  // Only the process created by this launch may be stopped on startup failure.
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  throw new Error(`节点启动失败，请查看 ${logPath}`)
}

/** The shell's environment: no Host settings, model keys or debugging hooks. */
export function desktopShellEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith('HARNESS_') || name === 'NODE_OPTIONS' || DROPPED_ENV.includes(name)) continue
    result[name] = value
  }
  return result
}
