import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { processAlive as alive, readDataDirLock, readHostState, readRecordedPid, unixRequest, verifyHostState } from '../src/host-state.ts'
import { resolveLatchPaths } from '../src/paths.ts'
import { CLI_PROGRAM, cliStopCommand } from '../src/distribution.ts'

const REASONS = ['restart', 'update', 'shutdown'] as const

/** `--name value` or `--name=value`; null when the flag is present without a value. */
function option(args: string[], name: string): string | undefined | null {
  const index = args.findIndex(arg => arg === name || arg.startsWith(`${name}=`))
  if (index < 0) return undefined
  const value = args[index]!.includes('=') ? args[index]!.slice(name.length + 1) : args[index + 1]
  return !value || value.startsWith('--') ? null : value
}

/**
 * Stops the Host recorded in this data directory, and only after host.sock proves it is that Host:
 * socket directory and socket owned by this user, process alive, and host-info matching pid, hostId and instanceId.
 * `--reason restart|update|shutdown` tells the Host first, so the clients it announces the stop to know when to come back.
 */
export async function runStop(
  args: string[],
  io = {
    env: process.env,
    cwd: process.cwd(),
    program: CLI_PROGRAM,
    out: (text: string) => console.log(text),
    error: (text: string) => console.error(text),
  },
): Promise<number> {
  const out = io.out
  const error = io.error
  const command = cliStopCommand(io.program)
  const flag = option(args, '--data-dir')
  if (flag === null) {
    error('--data-dir 需要一个值')
    return 1
  }
  const reason = option(args, '--reason')
  if (reason === null || (reason !== undefined && !(REASONS as readonly string[]).includes(reason))) {
    error(`--reason 只能是 ${REASONS.join('、')}`)
    return 1
  }
  const force = args.includes('--force')
  let dataDir: string
  try {
    ;({ dataDir } = resolveLatchPaths({ dataDir: flag, env: io.env, cwd: io.cwd, legacyRuntime: io.program !== 'latch' }))
  } catch (error) {
    // A setting under both its name and the one from before the rename, with different values: nothing is signalled.
    io.error(error instanceof Error ? error.message : String(error))
    return 1
  }
  const state = await readHostState(dataDir)
  if (!state || !alive(state.pid)) {
    // Neither the lock nor an unrecognised host.json proves which process it is, so they are reported and never signalled.
    const lock = await readDataDirLock(dataDir)
    if (lock && !lock.holder) {
      error(
        `数据目录锁 ${lock.path} 无法读取，无法确认是否有 Host 在运行，未发送停止信号。如果确认没有 Host 或 latch 命令在使用这个目录，删除该文件后重试。`,
      )
      return 1
    }
    if (lock?.held && lock.holder?.role === 'host') {
      const pid = lock.holder.pid
      error(
        `数据目录锁 ${lock.path} 由进程 ${pid} 持有，Host 可能仍在启动，还不能通过 host.sock 确认，未发送停止信号。请稍后再运行 ${command}；如果确认没有 Host 在运行（例如进程 ${pid} 是复用了进程号的其他程序），删除该锁文件后再启动。`,
      )
      return 1
    }
    const recorded = state ? undefined : await readRecordedPid(dataDir)
    const hostJson = join(dataDir, 'host.json')
    if (recorded?.present && recorded.pid === undefined) {
      error(`无法识别 ${hostJson}，无法确认是否有 Host 在运行，未发送停止信号。如果确认没有 Host 在运行，删除该文件后再启动。`)
      return 1
    }
    if (recorded?.present && recorded.pid !== undefined && alive(recorded.pid)) {
      error(
        `host.json 的格式无法识别（可能来自旧版本），无法通过 host.sock 确认进程 ${recorded.pid}，未发送停止信号。请在运行旧版本 Host 的终端中停止它（Ctrl+C）；如果确认没有 Host 在运行，删除 ${hostJson} 后再启动。`,
      )
      return 1
    }
    out(`没有正在运行的 Host（${dataDir}）。`)
    return 0
  }
  const info = await verifyHostState(state)
  if (!info) {
    error('无法通过 host.sock 确认 host.json 记录的 Host（套接字缺失、属主不正确或实例不匹配），未发送停止信号。')
    return 1
  }
  const active = info.activity ? info.activity.running + info.activity.waiting : info.activeSessions
  if (active > 0 && !force) {
    error(`有 ${active} 个会话正在运行或等待审批。确认要停止时，在原停止命令的末尾加上 --force，沿用同一数据目录。`)
    return 1
  }
  if (reason !== undefined) {
    // Best effort: without it the Host announces a plain shutdown.
    await unixRequest(state.socketPath, '/link/api/host/state', { method: 'POST', body: { state: 'stopping', reason } }).catch(
      () => undefined,
    )
  }
  process.kill(state.pid, 'SIGTERM')
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!alive(state.pid)) {
      out('Latch 运行节点已停止。')
      return 0
    }
    await delay(100)
  }
  error('节点仍在清理任务；请检查日志。未强制终止进程。')
  return 1
}
