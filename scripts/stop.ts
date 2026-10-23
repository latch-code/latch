import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { processAlive as alive, readDataDirLock, readHostState, readRecordedPid, verifyHostState } from '../src/host/host-state.ts'
import { resolveLatchPaths } from '../src/host/paths.ts'

/**
 * Stops the Host recorded in this data directory, and only after host.sock proves it is that Host:
 * socket directory and socket owned by this user, process alive, and host-info matching pid, hostId and instanceId.
 */
async function main(args: string[]): Promise<number> {
  const index = args.findIndex(arg => arg === '--data-dir' || arg.startsWith('--data-dir='))
  const flag = index < 0 ? undefined : args[index]!.includes('=') ? args[index]!.slice('--data-dir='.length) : args[index + 1]
  if (index >= 0 && (!flag || flag.startsWith('--'))) {
    console.error('--data-dir 需要一个值')
    return 1
  }
  const force = args.includes('--force')
  const { dataDir } = resolveLatchPaths({ dataDir: flag, env: process.env, cwd: process.cwd() })
  const state = await readHostState(dataDir)
  if (!state || !alive(state.pid)) {
    // Neither the lock nor an unrecognised host.json proves which process it is, so they are reported and never signalled.
    const lock = await readDataDirLock(dataDir)
    if (lock && !lock.holder) {
      console.error(
        `数据目录锁 ${lock.path} 无法读取，无法确认是否有 Host 在运行，未发送停止信号。如果确认没有 Host 或 latch 命令在使用这个目录，删除该文件后重试。`,
      )
      return 1
    }
    if (lock?.held && lock.holder?.role === 'host') {
      const pid = lock.holder.pid
      console.error(
        `数据目录锁 ${lock.path} 由进程 ${pid} 持有，Host 可能仍在启动，还不能通过 host.sock 确认，未发送停止信号。请稍后再运行 pnpm stop；如果确认没有 Host 在运行（例如进程 ${pid} 是复用了进程号的其他程序），删除该锁文件后再启动。`,
      )
      return 1
    }
    const recorded = state ? undefined : await readRecordedPid(dataDir)
    const hostJson = join(dataDir, 'host.json')
    if (recorded?.present && recorded.pid === undefined) {
      console.error(`无法识别 ${hostJson}，无法确认是否有 Host 在运行，未发送停止信号。如果确认没有 Host 在运行，删除该文件后再启动。`)
      return 1
    }
    if (recorded?.present && recorded.pid !== undefined && alive(recorded.pid)) {
      console.error(
        `host.json 的格式无法识别（可能来自旧版本），无法通过 host.sock 确认进程 ${recorded.pid}，未发送停止信号。请在运行旧版本 Host 的终端中停止它（Ctrl+C）；如果确认没有 Host 在运行，删除 ${hostJson} 后再启动。`,
      )
      return 1
    }
    console.log(`没有正在运行的 Host（${dataDir}）。`)
    return 0
  }
  const info = await verifyHostState(state)
  if (!info) {
    console.error('无法通过 host.sock 确认 host.json 记录的 Host（套接字缺失、属主不正确或实例不匹配），未发送停止信号。')
    return 1
  }
  if (info.activeSessions > 0 && !force) {
    console.error(`有 ${info.activeSessions} 个会话正在运行。确认后使用 pnpm stop --force。`)
    return 1
  }
  process.kill(state.pid, 'SIGTERM')
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!alive(state.pid)) {
      console.log('Latch 运行节点已停止。')
      return 0
    }
    await delay(100)
  }
  console.error('节点仍在清理任务；请检查日志。未强制终止进程。')
  return 1
}

process.exitCode = await main(process.argv.slice(2))
