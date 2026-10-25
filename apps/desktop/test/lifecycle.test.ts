import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BACKUP_EXCLUSION_ATTRIBUTE as HOST_ATTRIBUTE, BACKUP_EXCLUSION_VALUE as HOST_VALUE } from '@latch/host/backup'

const require = createRequire(import.meta.url)
const run = promisify(execFile)

interface Launch {
  node: string
  nodeArgs: string[]
  script: string
  args: string[]
  cwd: string
}
interface LaunchRecord {
  version: 1
  pid: number
  hostId: string
  launch: Launch | null
}
interface HostState {
  pid: number
  hostId: string
  socketPath: string
}
interface HostView {
  status: string
  supervised: boolean
  reason?: string
  restartInMs?: number
  crashes: number
}
interface KeepAwakeView {
  enabled: boolean
  active: boolean
  cause: 'running' | 'waiting' | null
  power: 'ac' | 'battery'
  batteryLimitReached: boolean
}
type Result = { ok: true } | { ok: false; error: string; message: string }
interface Supervisor {
  check(): Promise<void>
  restartNow(options?: { retry?: boolean }): Promise<Result>
  announce(body: unknown): Promise<void>
  systemShutdown(): Promise<void>
  view(): HostView
  stop(): void
}
interface KeepAwake {
  view(): KeepAwakeView
  setActivity(activity: { running: number; waiting: number }): void
  setEnabled(enabled: boolean): void
  powerChanged(): void
  stop(): void
}
interface LoginItemView {
  available: boolean
  enabled: boolean
  needsApproval: boolean
  reason?: string
}
type Runner = (args: string[]) => Promise<{ stdout: string }>
const lifecycle = require('../src/lifecycle.cjs') as {
  LIFECYCLE_CHANNELS: Record<string, string>
  CRASH_LIMIT: number
  BATTERY_LIMIT_MS: number
  SYSTEM_QUIT_WINDOW_MS: number
  BACKUP_EXCLUSION_ATTRIBUTE: string
  BACKUP_EXCLUSION_VALUE: string
  parseLaunchRecord(value: unknown, options: { dataDir: string; script: string }): LaunchRecord | undefined
  readLaunchRecord(dataDir: string, options: { script: string }): Promise<LaunchRecord | undefined>
  writeLaunchRecord(dataDir: string, record: LaunchRecord): Promise<void>
  readLifecyclePreferences(directory: string): Promise<{ keepAwake: boolean }>
  writeLifecyclePreferences(directory: string, preferences: { keepAwake: boolean }): Promise<void>
  hostEnvironment(env: NodeJS.ProcessEnv): Record<string, string>
  spawnHost(launch: Launch, options: { dataDir: string; env: NodeJS.ProcessEnv }): Promise<{ pid: number; exited: Promise<void> }>
  backoff(crashes: number): number
  createHostSupervisor(options: Record<string, unknown>): Supervisor
  createKeepAwake(options: Record<string, unknown>): KeepAwake
  createLoginItem(options: { app: unknown; platform: string; packaged: boolean }): {
    view(): LoginItemView
    set(enabled: boolean): LoginItemView
    openedAtLogin(): boolean
  }
  excludeFromBackup(paths: string[], options?: { platform?: string; run?: Runner; log?: (text: string) => void }): Promise<string[]>
  createSystemQuit(options?: { now?: () => number }): { noticed(): void; take(): boolean }
}

const HOST_ID = 'fpi3wdcevcl4gct2ucmrzxry3adc7zcb3zinud2gqjjuj5qc5atq'
const SCRIPT = '/repo/dist/start.js'
const DATA = '/data'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'latch-lifecycle-'))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  return path
}

const launch = (extra: Partial<Launch> = {}): Launch => ({
  node: '/usr/local/bin/node',
  nodeArgs: [],
  script: SCRIPT,
  args: ['--data-dir', DATA, '--demo'],
  cwd: '/repo',
  ...extra,
})

describe('desktop launch record', () => {
  it('accepts only a launch of the Host script of this checkout for this data directory', () => {
    const parse = (value: unknown) => lifecycle.parseLaunchRecord(value, { dataDir: DATA, script: SCRIPT })
    const record = { version: 1, pid: 42, hostId: HOST_ID, launch: launch() }
    expect(parse(record)).toEqual(record)
    expect(parse({ ...record, launch: null })).toEqual({ ...record, launch: null })
    for (const changed of [
      { ...record, extra: 1 },
      { ...record, version: 2 },
      { ...record, pid: 0 },
      { ...record, hostId: 'not-a-host' },
      { ...record, launch: { ...launch(), env: {} } },
      { ...record, launch: launch({ node: 'node' }) },
      { ...record, launch: launch({ script: '/elsewhere/start.js' }) },
      { ...record, launch: launch({ args: ['--data-dir', '/other'] }) },
      { ...record, launch: launch({ args: ['--demo', '--data-dir', DATA] }) },
      { ...record, launch: launch({ nodeArgs: ['--inspect=9229'] }) },
      { ...record, launch: launch({ nodeArgs: ['--remote-debugging-port=1'] }) },
      // The launcher records no Node arguments; any would let the record load other code.
      { ...record, launch: launch({ nodeArgs: ['--require', '/tmp/x.cjs'] }) },
      { ...record, launch: launch({ nodeArgs: ['--import=/tmp/x.mjs'] }) },
      { ...record, launch: launch({ nodeArgs: ['--env-file=/tmp/env'] }) },
      { ...record, launch: launch({ nodeArgs: ['--no-warnings'] }) },
      { ...record, launch: launch({ args: ['--data-dir', DATA, 'a\0b'] }) },
      { ...record, launch: launch({ cwd: 'relative' }) },
      [],
      'text',
    ])
      expect(parse(changed), JSON.stringify(changed)).toBeUndefined()
  })

  it('round-trips through a 0600 file, never through a symbolic link, and reads a damaged file as none', async () => {
    const dataDir = await directory()
    const record: LaunchRecord = {
      version: 1,
      pid: 7,
      hostId: HOST_ID,
      launch: launch({ node: process.execPath, args: ['--data-dir', dataDir] }),
    }
    await lifecycle.writeLaunchRecord(dataDir, record)
    expect((await stat(join(dataDir, 'desktop-launch.json'))).mode & 0o777).toBe(0o600)
    expect(await lifecycle.readLaunchRecord(dataDir, { script: SCRIPT })).toEqual(record)
    // The Node executable must be a regular file of this user or root that no one else can write.
    const writable = join(dataDir, 'node')
    await writeFile(writable, '')
    await chmod(writable, 0o775)
    for (const node of [join(dataDir, 'missing-node'), dataDir, writable]) {
      await lifecycle.writeLaunchRecord(dataDir, { ...record, launch: { ...record.launch!, node } })
      expect(await lifecycle.readLaunchRecord(dataDir, { script: SCRIPT }), node).toBeUndefined()
    }
    await lifecycle.writeLaunchRecord(dataDir, record)
    await writeFile(join(dataDir, 'desktop-launch.json'), '{', { mode: 0o600 })
    expect(await lifecycle.readLaunchRecord(dataDir, { script: SCRIPT })).toBeUndefined()
    const elsewhere = await directory()
    await lifecycle.writeLaunchRecord(elsewhere, record)
    await rm(join(dataDir, 'desktop-launch.json'))
    await symlink(join(elsewhere, 'desktop-launch.json'), join(dataDir, 'desktop-launch.json'))
    expect(await lifecycle.readLaunchRecord(dataDir, { script: SCRIPT })).toBeUndefined()
  })

  it('keeps the desktop preference in its own 0600 file and keeps the Mac awake by default', async () => {
    const userData = await directory()
    expect(await lifecycle.readLifecyclePreferences(userData)).toEqual({ keepAwake: true })
    await lifecycle.writeLifecyclePreferences(userData, { keepAwake: false })
    expect((await stat(join(userData, 'lifecycle.json'))).mode & 0o777).toBe(0o600)
    expect(await lifecycle.readLifecyclePreferences(userData)).toEqual({ keepAwake: false })
    await writeFile(join(userData, 'lifecycle.json'), JSON.stringify({ version: 1, keepAwake: false, extra: true }))
    expect(await lifecycle.readLifecyclePreferences(userData)).toEqual({ keepAwake: true })
  })

  it('starts the Host detached with --disable-sigusr1, its output in a 0600 host.log and no Host settings in its environment', async () => {
    const dataDir = await directory()
    const script = join(dataDir, 'host.mjs')
    await writeFile(
      script,
      `import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(join(dataDir, 'seen.json'))}, JSON.stringify({ argv: process.argv.slice(2), execArgv: process.execArgv, env: process.env, cwd: process.cwd() }))
console.log('started')`,
    )
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      HARNESS_API_KEY: 'sk-never',
      HARNESS_DATA_DIR: '/elsewhere',
      NODE_OPTIONS: '--inspect',
      ELECTRON_RUN_AS_NODE: '1',
      LANG: 'zh_CN.UTF-8',
    }
    expect(lifecycle.hostEnvironment(env)).toEqual({ PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'zh_CN.UTF-8' })
    const child = await lifecycle.spawnHost(
      { node: process.execPath, nodeArgs: [], script, args: ['--data-dir', dataDir, '--demo'], cwd: dataDir },
      { dataDir, env },
    )
    await child.exited
    const seen = JSON.parse(await readFile(join(dataDir, 'seen.json'), 'utf8')) as {
      argv: string[]
      execArgv: string[]
      env: Record<string, string>
      cwd: string
    }
    expect(seen.argv).toEqual(['--data-dir', dataDir, '--demo'])
    expect(seen.execArgv).toEqual(['--disable-sigusr1'])
    expect(Object.keys(seen.env).filter(name => /^(HARNESS_|ELECTRON_)|^NODE_OPTIONS$/u.test(name))).toEqual([])
    expect(await readFile(join(dataDir, 'host.log'), 'utf8')).toBe('started\n')
    expect((await stat(join(dataDir, 'host.log'))).mode & 0o777).toBe(0o600)

    const linked = await directory()
    await writeFile(join(linked, 'target.txt'), 'untouched')
    await symlink(join(linked, 'target.txt'), join(linked, 'host.log'))
    await expect(lifecycle.spawnHost(launch({ node: process.execPath, script }), { dataDir: linked, env })).rejects.toThrow()
    expect(await readFile(join(linked, 'target.txt'), 'utf8')).toBe('untouched')
  })
})

/** A pretend Mac: host.json, live processes and the launch record, with a Host that comes up when started. */
function world() {
  let nextPid = 100
  const alive = new Set<number>()
  const reports: Array<{ socketPath: string; body: unknown }> = []
  const lines: string[] = []
  const views: HostView[] = []
  const activity: Array<{ running: number; waiting: number }> = []
  const state = {
    hostJson: undefined as HostState | undefined,
    record: undefined as LaunchRecord | undefined,
    busy: { running: 0, waiting: 0 },
    /** What the next started Host does: come up, exit at once, or never answer. */
    nextStart: 'up' as 'up' | 'exit' | 'hang',
    /** False: live Hosts stop answering over host.sock (hung, or the pid now names another process). */
    answering: true,
    /** The process exits just before it is signalled, so SIGTERM finds no such process. */
    exitBeforeSignal: false,
    starts: 0,
    terminated: [] as number[],
  }
  const exits = new Map<number, () => void>()
  const startHost = vi.fn(async (_launch: Launch) => {
    state.starts++
    const pid = nextPid++
    alive.add(pid)
    const exited = new Promise<void>(done => exits.set(pid, done))
    const mode = state.nextStart
    setTimeout(() => {
      if (mode === 'exit') {
        alive.delete(pid)
        exits.get(pid)?.()
      } else if (mode === 'up') state.hostJson = { pid, hostId: HOST_ID, socketPath: `/run/${pid}.sock` }
    }, 300)
    return { pid, exited }
  })
  const supervisor = lifecycle.createHostSupervisor({
    hostId: HOST_ID,
    readState: async () => state.hostJson,
    inspect: async (host: HostState) =>
      alive.has(host.pid) && state.answering
        ? { ok: true, info: { activeSessions: state.busy.running + state.busy.waiting, activity: state.busy } }
        : { ok: false, reason: 'gone' },
    alive: (pid: number) => alive.has(pid),
    readLaunch: async () => state.record,
    writeLaunch: async (record: LaunchRecord) => {
      state.record = record
    },
    startHost,
    terminate: (pid: number) => {
      alive.delete(pid)
      exits.get(pid)?.()
      if (state.exitBeforeSignal) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
      state.terminated.push(pid)
      // An orderly stop removes host.json.
      if (state.hostJson?.pid === pid) state.hostJson = undefined
    },
    report: async (socketPath: string, body: unknown) => {
      reports.push({ socketPath, body })
    },
    log: (text: string) => lines.push(text),
    onChange: (view: HostView) => views.push(view),
    onActivity: (value: { running: number; waiting: number }) => activity.push(value),
  })
  /** A Host the launcher started: running, with a matching record. */
  function launched(record: Partial<LaunchRecord> = {}) {
    const pid = nextPid++
    alive.add(pid)
    state.hostJson = { pid, hostId: HOST_ID, socketPath: `/run/${pid}.sock` }
    state.record = { version: 1, pid, hostId: HOST_ID, launch: launch(), ...record }
    return pid
  }
  /** The Host process dies without stopping in order: host.json stays behind. */
  function crash() {
    const pid = state.hostJson!.pid
    alive.delete(pid)
    exits.get(pid)?.()
  }
  return { state, supervisor, startHost, reports, lines, views, activity, launched, crash, alive }
}

describe('Host supervision', () => {
  it('starts a crashed Host again from the launch record after a short wait, and records the new process', async () => {
    vi.useFakeTimers()
    const w = world()
    const first = w.launched()
    await w.supervisor.check()
    expect(w.supervisor.view()).toEqual({ status: 'running', supervised: true, crashes: 0 })
    w.state.busy = { running: 1, waiting: 0 }
    await w.supervisor.check()
    expect(w.activity.at(-1)).toEqual({ running: 1, waiting: 0 })

    w.crash()
    await w.supervisor.check()
    expect(w.supervisor.view()).toMatchObject({ status: 'restarting', supervised: true, crashes: 1, restartInMs: 1_000 })
    expect(w.activity.at(-1)).toEqual({ running: 0, waiting: 0 })
    expect(w.lines.at(-1)).toBe('Host 意外退出，1 秒后重新启动（10 分钟内第 1 次）。')
    // The same dead process is counted once, however often it is looked at.
    await w.supervisor.check()
    expect(w.supervisor.view().crashes).toBe(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(w.startHost).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(w.startHost).toHaveBeenCalledWith(launch())
    expect(w.supervisor.view()).toMatchObject({ status: 'running', supervised: true })
    expect(w.state.hostJson!.pid).not.toBe(first)
    expect(w.state.record).toEqual({ version: 1, pid: w.state.hostJson!.pid, hostId: HOST_ID, launch: launch() })
    expect(w.views.map(view => view.status)).toEqual(['running', 'restarting', 'starting', 'running'])
  })

  it('leaves a Host that stopped in order, or that it did not start, as it is', async () => {
    vi.useFakeTimers()
    const w = world()
    const pid = w.launched()
    await w.supervisor.check()
    // pnpm stop: the Host removes host.json as it stops.
    w.alive.delete(pid)
    w.state.hostJson = undefined
    await w.supervisor.check()
    expect(w.supervisor.view()).toMatchObject({ status: 'stopped' })

    // Started elsewhere (pnpm start in a terminal): the record names another process.
    const other = w.launched()
    w.state.record = { ...w.state.record!, pid: other + 1000 }
    await w.supervisor.check()
    expect(w.supervisor.view()).toEqual({ status: 'running', supervised: false, reason: 'external', crashes: 0 })
    w.crash()
    await w.supervisor.check()
    expect(w.supervisor.view()).toMatchObject({ status: 'crashed', supervised: false, reason: 'external' })
    expect(w.lines.at(-1)).toBe('Host 意外退出。它不是由 Latch 桌面端启动的，不会自动重启。')

    // Started with settings from the environment, which the desktop app cannot repeat.
    w.launched({ launch: null })
    await w.supervisor.check()
    expect(w.supervisor.view()).toMatchObject({ status: 'running', supervised: false, reason: 'environment' })
    w.crash()
    await w.supervisor.check()
    expect(w.supervisor.view()).toMatchObject({ status: 'crashed', reason: 'environment' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(w.startHost).not.toHaveBeenCalled()
  })

  it('backs off between restarts and stops at the fifth crash within ten minutes, saying so', async () => {
    vi.useFakeTimers()
    expect([1, 2, 3, 4, 5, 6, 7].map(lifecycle.backoff)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
    const w = world()
    w.launched()
    await w.supervisor.check()
    // Every start comes up and crashes again.
    for (let crash = 1; crash < lifecycle.CRASH_LIMIT; crash++) {
      w.crash()
      await w.supervisor.check()
      expect(w.supervisor.view()).toMatchObject({ status: 'restarting', crashes: crash, restartInMs: lifecycle.backoff(crash) })
      await vi.advanceTimersByTimeAsync(lifecycle.backoff(crash) + 1_000)
      expect(w.supervisor.view().status).toBe('running')
    }
    w.crash()
    await w.supervisor.check()
    expect(w.supervisor.view()).toMatchObject({ status: 'crash-loop', crashes: 5 })
    expect(w.lines.at(-1)).toBe('Host 在 10 分钟内意外退出 5 次，已停止自动重启。请查看数据目录中的 host.log。')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await w.supervisor.check()
    expect(w.startHost).toHaveBeenCalledTimes(4)
    expect(w.supervisor.view().status).toBe('crash-loop')

    // The owner starts it again; the count starts over.
    const again = w.supervisor.restartNow()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await again).toEqual({ ok: true })
    expect(w.supervisor.view()).toMatchObject({ status: 'running', crashes: 0 })
  })

  it('counts a Host that exits at start or never answers as a crash', async () => {
    vi.useFakeTimers()
    const w = world()
    w.launched()
    await w.supervisor.check()
    w.state.nextStart = 'exit'
    w.crash()
    await w.supervisor.check()
    await vi.advanceTimersByTimeAsync(1_000 + 1_000)
    expect(w.lines).toContain('Host 启动后立即退出。')
    expect(w.supervisor.view()).toMatchObject({ status: 'restarting', crashes: 2 })
    expect(w.supervisor.view().restartInMs).toBeLessThanOrEqual(2_000)
    w.state.nextStart = 'hang'
    await vi.advanceTimersByTimeAsync(2_000 + 60_000 + 500)
    expect(w.lines).toContain('Host 没有在 60 秒内启动，已停止它。')
    expect(w.state.terminated).toHaveLength(1)
    expect(w.supervisor.view()).toMatchObject({ status: 'restarting', crashes: 3 })
  })

  it('tries once when the desktop app finds no Host at startup, leaving nothing to start it behind the error page', async () => {
    vi.useFakeTimers()
    const w = world()
    // The record from an earlier launch; that Host is gone and host.json with it.
    w.launched()
    w.alive.clear()
    w.state.hostJson = undefined
    w.state.nextStart = 'exit'
    const started = w.supervisor.restartNow({ retry: false })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await started).toMatchObject({ ok: false, error: 'host-start-failed' })
    expect(w.lines).toContain('Host 启动后立即退出。')
    expect(w.supervisor.view()).toMatchObject({ status: 'stopped', crashes: 0 })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(w.startHost).toHaveBeenCalledTimes(1)

    // When it comes up, the same supervisor goes on watching it.
    w.state.nextStart = 'up'
    const again = w.supervisor.restartNow({ retry: false })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await again).toEqual({ ok: true })
    expect(w.supervisor.view()).toMatchObject({ status: 'running', supervised: true })
  })

  it('keeps its bookkeeping when the Host exits just before it is signalled', async () => {
    vi.useFakeTimers()
    const w = world()
    w.launched()
    await w.supervisor.check()
    w.state.nextStart = 'hang'
    w.state.exitBeforeSignal = true
    w.crash()
    await w.supervisor.check()
    await vi.advanceTimersByTimeAsync(1_000 + 60_000 + 500)
    expect(w.lines).toContain('Host 没有在 60 秒内启动，已停止它。')
    expect(w.supervisor.view()).toMatchObject({ status: 'restarting', crashes: 2 })
    expect(w.lines.some(line => line.includes('ESRCH'))).toBe(false)

    // The owner's restart of a Host that exits as it is signalled goes on to start it.
    await vi.advanceTimersByTimeAsync(2_000 + 60_000 + 500)
    w.state.nextStart = 'up'
    w.state.exitBeforeSignal = false
    await vi.advanceTimersByTimeAsync(4_000 + 1_000)
    expect(w.supervisor.view().status).toBe('running')
    w.state.exitBeforeSignal = true
    const restarting = w.supervisor.restartNow()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await restarting).toEqual({ ok: true })
    expect(w.supervisor.view().status).toBe('running')
  })

  it('stops counting a live Host that no longer answers as running, and releases what it kept awake', async () => {
    vi.useFakeTimers()
    const w = world()
    w.launched()
    w.state.busy = { running: 1, waiting: 0 }
    await w.supervisor.check()
    expect(w.activity.at(-1)).toEqual({ running: 1, waiting: 0 })
    w.state.answering = false
    await w.supervisor.check()
    await w.supervisor.check()
    // Two checks may be a busy moment; the third in a row is not.
    expect(w.supervisor.view().status).toBe('running')
    expect(w.activity.at(-1)).toEqual({ running: 1, waiting: 0 })
    await w.supervisor.check()
    expect(w.supervisor.view()).toMatchObject({ status: 'unresponsive', supervised: true })
    expect(w.activity.at(-1)).toEqual({ running: 0, waiting: 0 })
    expect(await w.supervisor.restartNow()).toMatchObject({ ok: false, error: 'host-unverified' })
    expect(w.state.terminated).toEqual([])
    w.state.answering = true
    await w.supervisor.check()
    expect(w.supervisor.view().status).toBe('running')
    expect(w.activity.at(-1)).toEqual({ running: 1, waiting: 0 })
    // Gone while not answering: a crash like any other.
    w.state.answering = false
    for (let check = 0; check < 3; check++) await w.supervisor.check()
    w.crash()
    await w.supervisor.check()
    expect(w.supervisor.view()).toMatchObject({ status: 'restarting', crashes: 1 })
  })

  it('restarts a running Host on request only when it started it and nothing runs, announcing the restart first', async () => {
    vi.useFakeTimers()
    const w = world()
    const pid = w.launched()
    await w.supervisor.check()
    w.state.busy = { running: 0, waiting: 1 }
    expect(await w.supervisor.restartNow()).toMatchObject({ ok: false, error: 'host-busy' })
    expect(w.state.terminated).toEqual([])
    w.state.busy = { running: 0, waiting: 0 }
    const restarting = w.supervisor.restartNow()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await restarting).toEqual({ ok: true })
    expect(w.reports).toEqual([{ socketPath: `/run/${pid}.sock`, body: { state: 'stopping', reason: 'restart' } }])
    expect(w.state.terminated).toEqual([pid])
    expect(w.supervisor.view().status).toBe('running')

    w.state.record = { ...w.state.record!, pid: 1 }
    expect(await w.supervisor.restartNow()).toMatchObject({ ok: false, error: 'host-external' })
    w.state.record = { ...w.state.record, pid: w.state.hostJson!.pid, launch: null }
    expect(await w.supervisor.restartNow()).toMatchObject({ ok: false, error: 'host-environment' })
  })

  it('tells the running Host about sleep and wake, and stops it with a shutdown reason when the system goes down', async () => {
    vi.useFakeTimers()
    const w = world()
    const pid = w.launched()
    await w.supervisor.announce({ state: 'sleeping' })
    expect(w.reports).toEqual([])
    await w.supervisor.check()
    await w.supervisor.announce({ state: 'sleeping' })
    await w.supervisor.announce({ state: 'awake' })
    await w.supervisor.systemShutdown()
    expect(w.reports.map(report => report.body)).toEqual([
      { state: 'sleeping' },
      { state: 'awake' },
      { state: 'stopping', reason: 'shutdown' },
    ])
    expect(w.state.terminated).toEqual([pid])
  })
})

describe('a logout, restart or shutdown', () => {
  it('stops the Host only for the one quit that follows the notice, so a cancelled logout leaves it running', () => {
    let time = 0
    const quit = lifecycle.createSystemQuit({ now: () => time })
    // The owner quits (⌘Q) with no notice: the Host keeps running.
    expect(quit.take()).toBe(false)
    quit.noticed()
    time += lifecycle.SYSTEM_QUIT_WINDOW_MS
    expect(quit.take()).toBe(true)
    // Once: the quit that follows the Host's stop goes ahead.
    expect(quit.take()).toBe(false)

    // Another app cancelled the logout before this app was asked to quit: a later ⌘Q is the owner's again.
    const cancelled = lifecycle.createSystemQuit({ now: () => time })
    cancelled.noticed()
    time += lifecycle.SYSTEM_QUIT_WINDOW_MS + 1
    expect(cancelled.take()).toBe(false)
  })
})

describe('keeping the Mac awake', () => {
  function blocker() {
    const started = new Set<number>()
    let next = 1
    return {
      started,
      start: vi.fn((type: string) => {
        expect(type).toBe('prevent-app-suspension')
        started.add(next)
        return next++
      }),
      stop: vi.fn((id: number) => started.delete(id)),
    }
  }

  it('holds off idle sleep on power while a session runs or an approval waits', () => {
    const b = blocker()
    const keepAwake = lifecycle.createKeepAwake({ blocker: b, onBattery: () => false })
    expect(keepAwake.view()).toEqual({ enabled: true, active: false, cause: null, power: 'ac', batteryLimitReached: false })
    keepAwake.setActivity({ running: 0, waiting: 1 })
    expect(keepAwake.view()).toMatchObject({ active: true, cause: 'waiting' })
    keepAwake.setActivity({ running: 2, waiting: 1 })
    expect(keepAwake.view()).toMatchObject({ active: true, cause: 'running' })
    expect(b.start).toHaveBeenCalledTimes(1)
    keepAwake.setActivity({ running: 0, waiting: 0 })
    expect(keepAwake.view().active).toBe(false)
    expect(b.started.size).toBe(0)
    // Turned off by the owner: never held.
    keepAwake.setEnabled(false)
    keepAwake.setActivity({ running: 1, waiting: 0 })
    expect(keepAwake.view()).toMatchObject({ enabled: false, active: false })
    keepAwake.setEnabled(true)
    expect(keepAwake.view().active).toBe(true)
    keepAwake.stop()
    expect(b.started.size).toBe(0)
  })

  it('on battery holds it only while a session runs, for at most an hour at a time', async () => {
    vi.useFakeTimers()
    let battery = true
    const b = blocker()
    const views: KeepAwakeView[] = []
    const keepAwake = lifecycle.createKeepAwake({
      blocker: b,
      onBattery: () => battery,
      onChange: (view: KeepAwakeView) => views.push(view),
    })
    keepAwake.setActivity({ running: 0, waiting: 3 })
    expect(keepAwake.view()).toMatchObject({ active: false, power: 'battery' })
    keepAwake.setActivity({ running: 1, waiting: 0 })
    expect(keepAwake.view().active).toBe(true)
    await vi.advanceTimersByTimeAsync(lifecycle.BATTERY_LIMIT_MS - 1)
    expect(keepAwake.view().active).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(keepAwake.view()).toMatchObject({ active: false, batteryLimitReached: true })
    expect(b.started.size).toBe(0)
    // The session keeps running: still released.
    keepAwake.setActivity({ running: 1, waiting: 0 })
    expect(keepAwake.view().active).toBe(false)
    // Power comes back: held again, and the hour starts over on battery.
    battery = false
    keepAwake.powerChanged()
    expect(keepAwake.view()).toMatchObject({ active: true, power: 'ac', batteryLimitReached: false })
    battery = true
    keepAwake.powerChanged()
    expect(keepAwake.view().active).toBe(true)
    await vi.advanceTimersByTimeAsync(lifecycle.BATTERY_LIMIT_MS)
    expect(keepAwake.view().batteryLimitReached).toBe(true)
    // No session running resets it.
    keepAwake.setActivity({ running: 0, waiting: 0 })
    keepAwake.setActivity({ running: 1, waiting: 0 })
    expect(keepAwake.view()).toMatchObject({ active: true, batteryLimitReached: false })
    expect(views.at(-1)).toMatchObject({ active: true })
    keepAwake.stop()
  })
})

describe('login item', () => {
  it('is offered only by a packaged app on macOS and follows what macOS reports', () => {
    const settings = { openAtLogin: false, status: 'not-registered', wasOpenedAtLogin: false }
    const app = {
      getLoginItemSettings: vi.fn(() => ({ ...settings })),
      setLoginItemSettings: vi.fn((next: { openAtLogin: boolean }) => {
        settings.openAtLogin = next.openAtLogin
        settings.status = next.openAtLogin ? 'enabled' : 'not-registered'
      }),
    }
    const development = lifecycle.createLoginItem({ app, platform: 'darwin', packaged: false })
    expect(development.view()).toEqual({ available: false, enabled: false, needsApproval: false, reason: 'development' })
    expect(development.set(true).available).toBe(false)
    expect(lifecycle.createLoginItem({ app, platform: 'linux', packaged: true }).view()).toMatchObject({
      available: false,
      reason: 'platform',
    })
    expect(app.setLoginItemSettings).not.toHaveBeenCalled()

    const packaged = lifecycle.createLoginItem({ app, platform: 'darwin', packaged: true })
    expect(packaged.view()).toEqual({ available: true, enabled: false, needsApproval: false })
    expect(packaged.set(true)).toEqual({ available: true, enabled: true, needsApproval: false })
    expect(app.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: true })
    settings.openAtLogin = false
    settings.status = 'requires-approval'
    expect(packaged.view()).toEqual({ available: true, enabled: true, needsApproval: true })
    expect(packaged.set(false)).toEqual({ available: true, enabled: false, needsApproval: false })
    expect(packaged.openedAtLogin()).toBe(false)
    settings.wasOpenedAtLogin = true
    expect(packaged.openedAtLogin()).toBe(true)
    expect(development.openedAtLogin()).toBe(false)
  })
})

describe('device credentials and Time Machine', () => {
  it('uses the attribute and value the Host writes', () => {
    expect(lifecycle.BACKUP_EXCLUSION_ATTRIBUTE).toBe(HOST_ATTRIBUTE)
    expect(lifecycle.BACKUP_EXCLUSION_VALUE).toBe(HOST_VALUE)
  })

  it('marks the credential directory once and logs a failure without throwing', async () => {
    const userData = await directory()
    const devices = join(userData, 'latch-devices')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(devices)
    const calls: string[][] = []
    let marked = false
    const runner: Runner = async args => {
      calls.push(args)
      if (args[0] === '-p') {
        if (!marked) throw new Error('No such xattr')
        return { stdout: HOST_VALUE }
      }
      marked = true
      return { stdout: '' }
    }
    expect(await lifecycle.excludeFromBackup([devices, join(userData, 'missing')], { platform: 'darwin', run: runner })).toEqual([devices])
    expect(calls.at(-1)).toEqual(['-w', '-s', '-x', HOST_ATTRIBUTE, HOST_VALUE, devices])
    expect(await lifecycle.excludeFromBackup([devices], { platform: 'darwin', run: runner })).toEqual([])
    expect(await lifecycle.excludeFromBackup([devices], { platform: 'linux', run: runner })).toEqual([])
    const lines: string[] = []
    const failing: Runner = async () => {
      throw new Error('denied')
    }
    await lifecycle.excludeFromBackup([devices], { platform: 'darwin', run: failing, log: text => lines.push(text) })
    expect(lines).toEqual([`无法把 ${devices} 排除在时间机器备份之外：denied`])
  })

  it.runIf(process.platform === 'darwin')('sets the exclusion on a real directory with /usr/bin/xattr', async () => {
    const devices = join(await directory(), 'latch-devices')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(devices)
    expect(await lifecycle.excludeFromBackup([devices])).toEqual([devices])
    const { stdout } = await run('/usr/bin/xattr', ['-p', '-x', HOST_ATTRIBUTE, devices])
    expect(stdout.replace(/\s+/gu, '').toLowerCase()).toBe(HOST_VALUE)
    expect(await lifecycle.excludeFromBackup([devices])).toEqual([])
  })
})

describe('lifecycle channels', () => {
  it('are the ones the sandboxed preload names', async () => {
    const preload = await readFile('apps/desktop/src/preload.cjs', 'utf8')
    for (const channel of Object.values(lifecycle.LIFECYCLE_CHANNELS)) expect(preload).toContain(`'${channel}'`)
  })
})
