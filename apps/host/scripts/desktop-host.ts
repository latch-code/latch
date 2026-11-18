import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { constants } from 'node:fs'
import { chmod, mkdir, open, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { writeFileAtomic } from '@latch/core/node-kit'
import { z } from 'zod'
import { HOST_ENV_NAMES, latchEnv } from '../src/env.ts'
import { processAlive, readHostState, unixRequest, verifyHostState, type HostInfo, type HostState } from '../src/host-state.ts'
import { settleDataHome } from '../src/data-home.ts'
import { resolveLatchPaths } from '../src/paths.ts'
import { readCodeBuild } from '../src/ui-build.ts'

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
    /** Named by `--data-dir` or `LATCH_DATA_DIR`: such a directory is used where it is (data-home.ts). */
    dataDirExplicit: paths.dataDirSource === 'flag' || paths.dataDirSource === 'env',
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

const launchRecordSchema = z
  .object({
    version: z.literal(1),
    pid: z.number().int().positive(),
    hostId: z.string(),
    launch: z.object({ script: z.string() }).passthrough().nullable(),
  })
  .strict()

async function readLaunchRecord(dataDir: string) {
  try {
    return launchRecordSchema.parse(JSON.parse(await readFile(join(dataDir, DESKTOP_LAUNCH_FILE), 'utf8')))
  } catch {
    return undefined
  }
}

export const REBUILT_NOTICE = '检测到新的构建，已重启 Host。'
/** How long a Host asked to stop for a rebuild may take to exit (it ends its sessions' processes first). */
const STOP_TIMEOUT_MS = 30_000

/**
 * What to do with a running Host started from an older build than the one on disk: restart it (`stop`), or keep it and
 * say why in one line. Only a Host this launcher or the desktop app started from this checkout (desktop-launch.json
 * names its pid and hostId) with no session running or waiting for an approval is restarted, as the desktop app's own
 * 「重启 Latch」 does; a Host whose settings came from the environment is restarted only by a launch that has its own.
 * Any other Host (`pnpm start`, another checkout) is reused as before: its build is not this launcher's to compare.
 */
async function rebuildDecision(
  host: DesktopHost,
  options: DesktopLaunchOptions,
  script: string,
): Promise<{ action: 'reuse' } | { action: 'stop' } | { action: 'keep'; reason: string }> {
  const record = await readLaunchRecord(options.dataDir)
  if (!record || record.pid !== host.pid || record.hostId !== host.hostId || (record.launch && record.launch.script !== script))
    return { action: 'reuse' }
  const build = await readCodeBuild(script, join(dirname(script), 'web'))
  if (build === undefined || host.info.build === build) return { action: 'reuse' }
  if (record.launch === null && options.repeatable)
    return {
      action: 'keep',
      reason: '检测到新的构建，但这个 Host 的设置来自环境变量，未重启；请先 pnpm stop，再带上这些环境变量运行 pnpm desktop。',
    }
  const activity = host.info.activity ?? { running: host.info.activeSessions, waiting: 0 }
  if (activity.running + activity.waiting > 0)
    return { action: 'keep', reason: '检测到新的构建，但有会话正在运行或等待审批，未重启 Host；结束后在 Latch 中点「重启 Latch」。' }
  return { action: 'stop' }
}

/** Announces a restart, then SIGTERM to the Host just verified over host.sock, and waits for it to exit; never SIGKILL. */
async function stopForRebuild(host: DesktopHost, timeoutMs = STOP_TIMEOUT_MS): Promise<void> {
  await unixRequest(host.socketPath, '/link/api/host/state', { method: 'POST', body: { state: 'stopping', reason: 'restart' } }).catch(
    () => undefined,
  )
  try {
    process.kill(host.pid, 'SIGTERM')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
  }
  const deadline = Date.now() + timeoutMs
  while (processAlive(host.pid)) {
    if (Date.now() > deadline)
      throw new Error(`旧的 Host（PID ${host.pid}）没有在 ${Math.round(timeoutMs / 1000)} 秒内停止，请查看 host.log 后重试。`)
    await delay(100)
  }
}

/** The same launch against another data directory: where the Host's data is after its one-time move (data-home.ts). */
function atDataDir(options: DesktopLaunchOptions, dataDir: string): DesktopLaunchOptions {
  const at = options.args.indexOf('--data-dir')
  return {
    ...options,
    dataDir,
    hostStatePath: join(dataDir, 'host.json'),
    args: options.args.map((arg, index) => (index === at + 1 ? dataDir : arg)),
  }
}

export async function ensureDesktopHost(
  requested: DesktopLaunchOptions,
  startup: { script?: string; nodeArgs?: string[]; timeoutMs?: number; stopTimeoutMs?: number; home?: string } = {},
): Promise<DesktopHost & { reused: boolean; hostStatePath: string; notice?: string }> {
  let options = requested
  let existing = await probeDesktopHost(options.dataDir)
  let movedNote: string | undefined
  // A default location that has not moved yet is moved before anything is created, never shadowed by an empty one.
  // Only with no Host running there: one that answers is reused where it is.
  const settle = async () => {
    const home = await settleDataHome({
      dataDir: options.dataDir,
      explicit: options.dataDirExplicit,
      env: options.env,
      ...(startup.home ? { home: startup.home } : {}),
    })
    movedNote = home.note
    if (home.dataDir !== options.dataDir) options = atDataDir(options, home.dataDir)
  }
  if (!existing) {
    const asked = options.dataDir
    await settle()
    if (options.dataDir !== asked) existing = await probeDesktopHost(options.dataDir)
  }
  const script = startup.script ?? resolve(options.cwd, 'dist/start.js')
  let restarted = false
  if (existing) {
    const decision = await rebuildDecision(existing, options, script)
    if (decision.action !== 'stop') {
      const reuse = `复用已有节点（${options.dataDir}）。本次 --demo、--harness、--provider、--plugin、--workspace、网络参数和模型环境变量不会重新应用；要更改启动配置，请先停止该目录的节点，或使用其他 --data-dir。`
      return {
        ...existing,
        reused: true,
        hostStatePath: options.hostStatePath,
        notice: [movedNote, decision.action === 'keep' ? `${decision.reason}\n${reuse}` : reuse].filter(Boolean).join('\n'),
      }
    }
    await stopForRebuild(existing, startup.stopTimeoutMs)
    restarted = true
    // The Host that was running from the old place has stopped: this is the start that moves it.
    await settle()
  }
  await mkdir(options.dataDir, { recursive: true, mode: 0o700 })
  const logPath = join(options.dataDir, 'host.log')
  const log = await openHostLog(logPath)
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
      const notice = [movedNote, restarted ? REBUILT_NOTICE : undefined, await recordLaunch(options.dataDir, record)]
        .filter(Boolean)
        .join('\n')
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
