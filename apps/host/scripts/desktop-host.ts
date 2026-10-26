import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { constants } from 'node:fs'
import { chmod, mkdir, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { writeFileAtomic } from '@latch/core/node-kit'
import { HOST_ENV_NAMES, latchEnv } from '../src/env.ts'
import { readHostState, verifyHostState, type HostInfo, type HostState } from '../src/host-state.ts'
import { resolveLatchPaths } from '../src/paths.ts'

/** Variables that must never reach the Host or the shell: the shell finds the Host through host.json only. */
const DROPPED_ENV = ['LATCH_DESKTOP_URL', 'ELECTRON_RUN_AS_NODE']

/** Without it any same-user process can open an inspector in the running Host with SIGUSR1 (`process._debugProcess`). */
const HOST_NODE_ARGS = ['--disable-sigusr1']

/**
 * `<data>/desktop-launch.json`: how this launcher started the Host, so the desktop app can start the same Host again
 * after a crash (apps/desktop/src/lifecycle.cjs reads it and checks every field). It holds no secret: `launch` lists the
 * Node executable, extra Node arguments, start script, arguments and working directory, and is null when the Host took
 * settings from the environment that the desktop app, which runs without them, could not repeat.
 */
export const DESKTOP_LAUNCH_FILE = 'desktop-launch.json'
export interface DesktopLaunchRecord {
  version: 1
  pid: number
  hostId: string
  launch: { node: string; nodeArgs: string[]; script: string; args: string[]; cwd: string } | null
}
/**
 * Whether the environment carries Host settings (a model, its key, HTTPS, ports, paths) that only this launch has. The
 * data directory is not one: the launcher resolves it into an
 * argument. Other `LATCH_*` variables (a build's Go toolchain, the test runner's switches) are not Host settings.
 */
export function hostSettingsInEnvironment(env: NodeJS.ProcessEnv): boolean {
  return HOST_ENV_NAMES.some(name => name !== 'DATA_DIR' && latchEnv(env, name) !== undefined)
}

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
    /** The desktop app may start this Host again after a crash: no Host settings come from the environment. */
    repeatable: !hostSettingsInEnvironment(env),
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

/**
 * Writes desktop-launch.json. The record is optional: when it cannot be written (a full disk, permissions) the Host this
 * launch started keeps running, and the returned notice says the desktop app will not start it again after a crash.
 */
async function recordLaunch(dataDir: string, record: DesktopLaunchRecord): Promise<string | undefined> {
  const path = join(dataDir, DESKTOP_LAUNCH_FILE)
  try {
    await writeFileAtomic(path, `${JSON.stringify(record)}\n`, { prefix: '.desktop-launch-' })
    return undefined
  } catch (error) {
    const reason = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : '写入失败'
    return `无法写入 ${path}（${reason}）。Host 已启动，但它意外退出后桌面端不会自动重新启动它。`
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
  const script = startup.script ?? resolve(options.cwd, 'dist/start.js')
  const child = spawn(process.execPath, [...HOST_NODE_ARGS, ...(startup.nodeArgs ?? []), script, ...options.args], {
    cwd: options.cwd,
    detached: true,
    stdio: ['ignore', log.fd, log.fd],
    env: options.env,
  })
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
    if (state) {
      const record: DesktopLaunchRecord = {
        version: 1,
        pid: state.pid,
        hostId: state.hostId,
        launch: options.repeatable
          ? { node: process.execPath, nodeArgs: [...(startup.nodeArgs ?? [])], script, args: options.args, cwd: options.cwd }
          : null,
      }
      const notice = await recordLaunch(options.dataDir, record)
      return { ...state, reused: false, hostStatePath: options.hostStatePath, ...(notice ? { notice } : {}) }
    }
    await delay(100)
  }
  // Only the process created by this launch may be stopped on startup failure.
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  throw new Error(`节点启动失败，请查看 ${logPath}`)
}

/** The shell's environment: no Host settings (`LATCH_*`), model keys or debugging hooks. */
export function desktopShellEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) {
    if (/^LATCH_/u.test(name) || name === 'NODE_OPTIONS' || DROPPED_ENV.includes(name)) continue
    result[name] = value
  }
  return result
}
