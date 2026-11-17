'use strict'
// The Host's life on this Mac, as the desktop app's main process runs it: starting the Host again after it crashes,
// keeping the Mac awake while the Host has work, the login item, telling the Host about sleep and shutdown, and keeping
// the device credentials out of Time Machine. The factories take their effects as arguments so they can be unit-tested
// without Electron; main.cjs wires them to Electron and the file system.
const { execFile, spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { constants } = require('node:fs')
const { lstat, open, rename, stat, unlink } = require('node:fs/promises')
const { isAbsolute, join } = require('node:path')

/** Main to renderer: the lifecycle view changed. The other channels are renderer requests (see preload.cjs). */
const LIFECYCLE_CHANNELS = Object.freeze({
  get: 'latch:lifecycle',
  setLoginItem: 'latch:lifecycle:login-item',
  setKeepAwake: 'latch:lifecycle:keep-awake',
  restartHost: 'latch:lifecycle:restart-host',
  changed: 'latch:lifecycle:changed',
})

/** `<data>/desktop-launch.json`, written by apps/host/scripts/desktop-host.ts. */
const LAUNCH_FILE = 'desktop-launch.json'
const LAUNCH_KEYS = ['version', 'pid', 'hostId', 'launch']
const HOST_ID = /^[a-z2-7]{52}$/
const LAUNCH_ENTRY_KEYS = ['node', 'nodeArgs', 'script', 'args', 'cwd']
const ARGUMENT_LIMIT = 4096

/** Crashes inside this window count towards a crash loop. */
const CRASH_WINDOW_MS = 10 * 60 * 1000
/** The fifth crash inside the window stops the automatic restarts. */
const CRASH_LIMIT = 5
const BACKOFF_FIRST_MS = 1_000
const BACKOFF_MAX_MS = 30_000
/** A started Host gets as long to answer over host.sock as the launcher gives it (it may build the presence helper). */
const START_TIMEOUT_MS = 60_000
const STOP_TIMEOUT_MS = 10_000
/**
 * 「重启 Latch」 has already sent SIGTERM when it waits: a Host that ends its sessions' processes slowly still goes, and
 * giving up sooner would leave no Host and nothing starting one.
 */
const RESTART_STOP_TIMEOUT_MS = 60_000
const POLL_MS = 200
/** Checks in a row in which a live Host does not answer over host.sock before it is shown as not responding. */
const UNANSWERED_LIMIT = 3

/** On battery the Mac is kept awake only while a session runs, for at most this long at a time. */
const BATTERY_LIMIT_MS = 60 * 60 * 1000
/**
 * 「到点前后保持唤醒」: from this long before a scheduled time of an Agent that asked for it, until its run settles, but
 * never longer than lead plus hold in one go (the Host's apps/host/src/computer.ts has the same numbers).
 */
const SCHEDULE_LEAD_MS = 2 * 60 * 1000
const SCHEDULE_HOLD_MS = 30 * 60 * 1000
/** The desktop app tells the Host what it keeps awake on every change and at least this often (it shows it in 「电脑」). */
const DESKTOP_REPORT_MS = 25_000
/** A quit within this long of macOS announcing a logout, restart or shutdown is the system's. */
const SYSTEM_QUIT_WINDOW_MS = 30_000

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function argumentList(value, limit) {
  return (
    Array.isArray(value)
    && value.length <= limit
    && value.every(item => typeof item === 'string' && item.length <= ARGUMENT_LIMIT && !item.includes('\0'))
  )
}

/** @typedef {{ node: string, nodeArgs: string[], script: string, args: string[], cwd: string }} HostLaunch */

/**
 * Strict parse of desktop-launch.json. The launch must start `script` (this checkout's Host start script) for
 * `dataDir`, with an absolute Node executable and working directory and no extra Node arguments (the launcher records
 * none; any would be a way to load other code or open a debugger); anything else reads as no record, so the desktop app
 * never starts something it was not given by the launcher.
 * @returns {{ version: 1, pid: number, hostId: string, launch: HostLaunch | null } | undefined}
 */
function parseLaunchRecord(value, { dataDir, script }) {
  if (!plainObject(value) || Object.keys(value).some(key => !LAUNCH_KEYS.includes(key))) return undefined
  if (value.version !== 1 || !Number.isInteger(value.pid) || value.pid <= 0) return undefined
  if (typeof value.hostId !== 'string' || !HOST_ID.test(value.hostId)) return undefined
  if (value.launch === null) return { version: 1, pid: value.pid, hostId: value.hostId, launch: null }
  const launch = value.launch
  if (!plainObject(launch) || Object.keys(launch).some(key => !LAUNCH_ENTRY_KEYS.includes(key))) return undefined
  if (typeof launch.node !== 'string' || !isAbsolute(launch.node) || launch.node.includes('\0')) return undefined
  if (launch.script !== script) return undefined
  if (!Array.isArray(launch.nodeArgs) || launch.nodeArgs.length !== 0 || !argumentList(launch.args, 128)) return undefined
  if (launch.args[0] !== '--data-dir' || launch.args[1] !== dataDir) return undefined
  if (typeof launch.cwd !== 'string' || !isAbsolute(launch.cwd) || launch.cwd.includes('\0')) return undefined
  return {
    version: 1,
    pid: value.pid,
    hostId: value.hostId,
    launch: { node: launch.node, nodeArgs: [], script: launch.script, args: [...launch.args], cwd: launch.cwd },
  }
}

/** The Node executable a record names: a regular file owned by this user or root that no one else can write. */
async function usableNode(path, uid) {
  const stats = await stat(path).catch(() => undefined)
  if (!stats?.isFile()) return false
  return (stats.uid === uid || stats.uid === 0) && (stats.mode & 0o022) === 0
}

/** A regular file this user owns, read without following a symbolic link; undefined when missing or unusable. */
async function readOwnFile(path, uid) {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return undefined
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile() || stats.uid !== uid || stats.size > 64 * 1024) return undefined
    return await handle.readFile('utf8')
  } catch {
    return undefined
  } finally {
    await handle.close()
  }
}

async function readLaunchRecord(dataDir, { script, usePackagedNode = false, uid = /** @type {() => number} */ (process.getuid)() }) {
  const text = await readOwnFile(join(dataDir, LAUNCH_FILE), uid)
  if (text === undefined) return undefined
  let record
  try {
    record = parseLaunchRecord(JSON.parse(text), { dataDir, script })
  } catch {
    return undefined
  }
  // Packaged starts rediscover Node through the native launcher. The last path is only historical in that mode.
  if (record?.launch && !usePackagedNode && !(await usableNode(record.launch.node, uid))) return undefined
  return record
}

/** Atomic 0600 write; the temporary name starts with `.desktop-launch-`, which the Host treats as its own. */
async function writePrivateFile(path, directory, prefix, text) {
  const temporary = join(directory, `${prefix}${randomUUID()}.tmp`)
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    await handle.writeFile(text)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

function writeLaunchRecord(dataDir, record) {
  return writePrivateFile(join(dataDir, LAUNCH_FILE), dataDir, '.desktop-launch-', `${JSON.stringify(record)}\n`)
}

/** The desktop app's own settings (`<userData>/lifecycle.json`); only whether to keep the Mac awake while busy. */
async function readLifecyclePreferences(directory, { uid = /** @type {() => number} */ (process.getuid)() } = {}) {
  const text = await readOwnFile(join(directory, 'lifecycle.json'), uid)
  try {
    const value = text === undefined ? undefined : JSON.parse(text)
    if (plainObject(value) && value.version === 1 && typeof value.keepAwake === 'boolean' && Object.keys(value).length === 2)
      return { keepAwake: value.keepAwake }
  } catch {
    /* default below */
  }
  return { keepAwake: true }
}

function writeLifecyclePreferences(directory, preferences) {
  return writePrivateFile(
    join(directory, 'lifecycle.json'),
    directory,
    '.lifecycle-',
    `${JSON.stringify({ version: 1, keepAwake: preferences.keepAwake === true })}\n`,
  )
}

/**
 * What the Host's environment may not carry from the shell: Host settings (`LATCH_*`), Node options and Electron switches.
 */
function hostEnvironment(env) {
  const result = {}
  const allowed = new Set(['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'LANG', 'SSH_AUTH_SOCK', '__CF_USER_TEXT_ENCODING'])
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || (!allowed.has(name) && !name.startsWith('LC_'))) continue
    result[name] = value
  }
  return result
}

/**
 * Starts the Host as the launcher does: detached, `--disable-sigusr1` first, output appended to the 0600 host.log
 * (never through a symbolic link), and an environment without Host settings.
 * @param {HostLaunch} launch
 * @returns {Promise<{ pid: number, exited: Promise<void>, launch: HostLaunch }>}
 */
async function spawnHost(launch, { dataDir, env }) {
  const log = await open(
    join(dataDir, 'host.log'),
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await log.chmod(0o600)
    const child = spawn(launch.node, ['--disable-sigusr1', ...launch.nodeArgs, launch.script, ...launch.args], {
      cwd: launch.cwd,
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      env: hostEnvironment(env),
    })
    const exited = /** @type {Promise<void>} */ (new Promise(done => child.once('exit', () => done(undefined))))
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    child.unref()
    return { pid: /** @type {number} */ (child.pid), exited, launch }
  } finally {
    await log.close()
  }
}

function backoff(crashes) {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, crashes - 1))
}

/** host-info's `scheduleWake` (host.cjs checked its shape): the next due time and the scheduled runs going on. */
function scheduleOf(info) {
  const wake = info && plainObject(info.scheduleWake) ? info.scheduleWake : undefined
  if (!wake || !Number.isInteger(wake.running) || wake.running < 0) return { running: 0 }
  const next = typeof wake.next === 'string' && Number.isFinite(Date.parse(wake.next)) ? wake.next : undefined
  return { ...(next ? { next } : {}), running: wake.running }
}

function activityOf(info) {
  const schedule = scheduleOf(info)
  if (!info) return { running: 0, waiting: 0, schedule }
  if (plainObject(info.activity) && Number.isInteger(info.activity.running) && Number.isInteger(info.activity.waiting))
    return { running: info.activity.running, waiting: info.activity.waiting, schedule }
  // Older Hosts report one count; it is treated as running sessions.
  return { running: Number.isInteger(info.activeSessions) ? info.activeSessions : 0, waiting: 0, schedule }
}

/**
 * Watches the Host named by host.json and starts it again when it crashes. An orderly stop removes host.json, so a
 * record still naming a process that is gone means the Host ended without stopping. Only a Host started from the
 * launch record (its pid is the record's) is started again: after 1, 2, 4, 8 … seconds (at most 30), until the fifth
 * crash within 10 minutes, which stops the restarts and says so. `restartNow` is the owner's own request: it starts the
 * Host from the record, stopping a running one first (announced as a restart) when no session is running or waiting.
 * A live Host that does not answer over host.sock three checks in a row is shown as not responding and keeps nothing
 * awake; it is not stopped, since it may only be busy.
 */
function createHostSupervisor(options) {
  const {
    hostId,
    readState,
    inspect,
    alive,
    readLaunch,
    writeLaunch,
    startHost,
    terminate,
    report,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    log = /** @type {(text: string) => void} */ (() => {}),
    onChange = /** @type {(view: object) => void} */ (() => {}),
    onActivity = /** @type {(activity: { running: number, waiting: number, schedule: { next?: string, running: number } }) => void} */ (
      () => {}
    ),
  } = options
  /** @type {'running' | 'unresponsive' | 'starting' | 'restarting' | 'stopped' | 'crashed' | 'crash-loop'} */
  let status = 'stopped'
  /** @type {{ pid: number, socketPath: string, instanceId?: string } | undefined} */
  let current
  /**
   * Whether the running (or last) Host came from the launch record, and why not.
   * @type {{ supervised: boolean, reason?: 'external' | 'environment' }}
   */
  let supervision = { supervised: false, reason: 'external' }
  let crashes = []
  let countedPid
  let timer
  let restartAt
  let starting
  let unanswered = 0
  let lastView = ''
  /** This app is stopping the Host on purpose (restart or update); see `transitioning`. */
  let stopping = false

  const sleep = ms => new Promise(done => setTimer(done, ms))

  function view() {
    return {
      status,
      supervised: supervision.supervised,
      ...(supervision.supervised ? {} : { reason: supervision.reason }),
      ...(status === 'restarting' && restartAt !== undefined ? { restartInMs: Math.max(0, restartAt - now()) } : {}),
      crashes: crashes.length,
    }
  }

  function emit() {
    const next = view()
    const key = JSON.stringify({ ...next, restartInMs: undefined })
    if (key === lastView) return
    lastView = key
    onChange(next)
  }

  function setStatus(next) {
    status = next
    emit()
  }

  /** @returns {{ supervised: boolean, reason?: 'external' | 'environment' }} */
  function supervisionFor(record, pid) {
    if (!record || record.pid !== pid || record.hostId !== hostId) return { supervised: false, reason: 'external' }
    if (record.launch === null) return { supervised: false, reason: 'environment' }
    return { supervised: true }
  }

  function pruneCrashes() {
    crashes = crashes.filter(time => now() - time < CRASH_WINDOW_MS)
  }

  /** SIGTERM through `terminate`; a process that exited since the last check (ESRCH) is already where it should be. */
  function signal(pid) {
    try {
      terminate(pid)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
        log(`无法停止 Host（PID ${pid}）：${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  /** A start that did not come up: counts as a crash, or with `retry` false (the desktop app's own start) only ends. */
  function failed(launch, retry) {
    if (retry) {
      afterCrash(launch)
      return
    }
    restartAt = undefined
    setStatus('stopped')
  }

  /** A crash of a Host started from `launch`: schedules the next start, or stops at the crash limit. */
  function afterCrash(launch) {
    pruneCrashes()
    crashes.push(now())
    if (crashes.length >= CRASH_LIMIT) {
      restartAt = undefined
      log(`Host 在 10 分钟内意外退出 ${crashes.length} 次，已停止自动重启。请查看数据目录中的 host.log。`)
      setStatus('crash-loop')
      return
    }
    const wait = backoff(crashes.length)
    restartAt = now() + wait
    log(`Host 意外退出，${Math.round(wait / 1000)} 秒后重新启动（10 分钟内第 ${crashes.length} 次）。`)
    timer = setTimer(() => {
      timer = undefined
      void start(launch)
    }, wait)
    setStatus('restarting')
  }

  /**
   * Starts the Host from `launch` and waits until it answers over host.sock. Resolves true when it does; never rejects.
   * A failed start schedules the next one unless `retry` is false.
   */
  function start(launch, retry = true) {
    starting ??= (async () => {
      try {
        return await attempt(launch, retry)
      } catch (error) {
        log(`无法启动 Host：${error instanceof Error ? error.message : '未知错误'}`)
        if (status === 'starting') failed(launch, retry)
        return false
      }
    })().finally(() => {
      starting = undefined
    })
    return starting
  }

  async function attempt(launch, retry) {
    restartAt = undefined
    unanswered = 0
    setStatus('starting')
    let child
    try {
      child = await startHost(launch)
    } catch (error) {
      log(`无法启动 Host：${error instanceof Error ? error.message : '未知错误'}`)
      failed(launch, retry)
      return false
    }
    supervision = { supervised: true }
    await writeLaunch({ version: 1, pid: child.pid, hostId, launch: child.launch }).catch(error => {
      log(`无法记录 Host 的启动方式：${error instanceof Error ? error.message : '未知错误'}`)
    })
    const outcome = { exited: false }
    void child.exited.then(() => {
      outcome.exited = true
    })
    const deadline = now() + START_TIMEOUT_MS
    while (!outcome.exited && now() < deadline) {
      const state = await readState()
      if (state && state.pid === child.pid && state.hostId === hostId) {
        const result = await inspect(state)
        if (result.ok) {
          current = { pid: state.pid, socketPath: state.socketPath, instanceId: state.instanceId }
          countedPid = undefined
          setStatus('running')
          onActivity(activityOf(result.info))
          return true
        }
      }
      await sleep(POLL_MS)
    }
    if (!outcome.exited) signal(child.pid)
    countedPid = child.pid
    log(outcome.exited ? 'Host 启动后立即退出。' : 'Host 没有在 60 秒内启动，已停止它。')
    failed(child.launch, retry)
    return false
  }

  /** Reads host.json and acts on what it finds; called on an interval and after the Mac wakes. */
  async function check() {
    if (starting) return
    const state = await readState()
    if (state && state.hostId === hostId && alive(state.pid)) {
      const result = await inspect(state)
      if (!result.ok) {
        // Hung, or its pid now names another process: either way nothing it reported earlier still holds.
        if (++unanswered >= UNANSWERED_LIMIT) {
          onActivity(activityOf(undefined))
          if (status === 'running') setStatus('unresponsive')
        }
        return
      }
      unanswered = 0
      current = { pid: state.pid, socketPath: state.socketPath, instanceId: state.instanceId }
      supervision = supervisionFor(await readLaunch(), state.pid)
      if (status !== 'running') {
        clearTimer(timer)
        timer = undefined
      }
      setStatus('running')
      onActivity(activityOf(result.info))
      return
    }
    onActivity(activityOf(undefined))
    if (status === 'restarting' || status === 'crash-loop') return
    if (!state || state.hostId !== hostId) {
      current = undefined
      setStatus('stopped')
      return
    }
    // host.json still names a process that is gone: the Host ended without stopping in order.
    if (countedPid === state.pid) return
    countedPid = state.pid
    current = undefined
    const record = await readLaunch()
    supervision = supervisionFor(record, state.pid)
    if (!supervision.supervised) {
      log(
        supervision.reason === 'environment'
          ? 'Host 意外退出。它的设置来自环境变量，桌面端不能按原样启动，不会自动重启。'
          : 'Host 意外退出。它不是由 Latch 桌面端启动的，不会自动重启。',
      )
      setStatus('crashed')
      return
    }
    afterCrash(record.launch)
  }

  /**
   * For the owner's 「重新启动 Host」 and, with `retry` false, for the desktop app finding no Host at startup: one attempt,
   * since the app then shows that it found no Host rather than starting one behind that page.
   */
  const startFailed = { ok: false, error: 'host-start-failed', message: 'Host 没有启动，请查看数据目录中的 host.log。' }

  async function restartNow({ retry = true } = {}) {
    if (starting) return { ok: false, error: 'host-starting', message: 'Host 正在启动，请稍候。' }
    const record = await readLaunch()
    const state = await readState()
    const live = state && state.hostId === hostId && alive(state.pid) ? state : undefined
    if (!record || record.hostId !== hostId || (live && record.pid !== live.pid))
      return { ok: false, error: 'host-external', message: '这个 Host 不是由 Latch 桌面端启动的，请在启动它的终端中重新启动。' }
    if (record.launch === null)
      return {
        ok: false,
        error: 'host-environment',
        message: '这个 Host 的设置来自环境变量，桌面端无法按原样启动，请在原启动终端重新启动。',
      }
    if (live) {
      const result = await inspect(live)
      if (!result.ok) return { ok: false, error: 'host-unverified', message: '无法通过 host.sock 核对正在运行的 Host，未重新启动。' }
      const activity = activityOf(result.info)
      if (activity.running + activity.waiting > 0)
        return { ok: false, error: 'host-busy', message: '有会话正在运行或等待审批，结束后再重新启动 Host。' }
      stopping = true
      try {
        await report(live.socketPath, { state: 'stopping', reason: 'restart' }).catch(() => {})
        signal(live.pid)
        const deadline = now() + RESTART_STOP_TIMEOUT_MS
        while (alive(live.pid) && now() < deadline) await sleep(POLL_MS)
        if (alive(live.pid)) return { ok: false, error: 'host-stop-timeout', message: 'Host 没有在 60 秒内停止，未重新启动。' }
        clearTimer(timer)
        timer = undefined
        crashes = []
        countedPid = undefined
        // Started before `stopping` clears, so there is no moment between the two in which the outage looks unplanned.
        const started = start(record.launch, retry)
        stopping = false
        return (await started) ? { ok: true } : { ...startFailed }
      } finally {
        stopping = false
      }
    }
    clearTimer(timer)
    timer = undefined
    crashes = []
    countedPid = undefined
    const started = await start(record.launch, retry)
    return started ? { ok: true } : { ...startFailed }
  }

  /** Reports sleep, wake or a coming stop to the running Host; best effort. */
  /** @returns {Promise<boolean>} whether the Host took it */
  async function announce(body) {
    if (!current) return false
    return report(current.socketPath, body).then(
      () => true,
      () => false,
    )
  }

  /**
   * The system is shutting down or logging out: the Host announces it and stops now, while the network is still up,
   * rather than when the system signals it.
   */
  async function systemShutdown() {
    clearTimer(timer)
    timer = undefined
    // Signalled only after host.sock shows it is still the Host this app checked, as `pnpm stop` does.
    const target = await readState()
    if (!target || target.hostId !== hostId || !alive(target.pid) || !(await inspect(target)).ok) return
    await report(target.socketPath, { state: 'stopping', reason: 'shutdown' }).catch(() => {})
    signal(target.pid)
    const deadline = now() + 3_000
    while (alive(target.pid) && now() < deadline) await sleep(POLL_MS)
  }

  /**
   * An update that changes the Host is about to be installed: only a Host this app started from its launch record is
   * stopped (announced as an update), so that the new version starts it from the same record. Any other Host is left
   * alone and the install is refused, since whoever started it has to stop it.
   */
  async function stopForUpdate() {
    const record = await readLaunch()
    const target = await readState()
    const live = target && target.hostId === hostId && alive(target.pid) ? target : undefined
    if (!live) return { ok: true }
    if (!record || record.hostId !== hostId || record.pid !== live.pid || record.launch === null)
      return { ok: false, error: 'host-external' }
    if (!(await inspect(live)).ok) return { ok: false, error: 'host-unverified' }
    clearTimer(timer)
    timer = undefined
    stopping = true
    try {
      await report(live.socketPath, { state: 'stopping', reason: 'update' }).catch(() => {})
      signal(live.pid)
      const deadline = now() + STOP_TIMEOUT_MS
      while (alive(live.pid) && now() < deadline) await sleep(POLL_MS)
      return alive(live.pid) ? { ok: false, error: 'host-stop-timeout' } : { ok: true }
    } finally {
      stopping = false
    }
  }

  return {
    check,
    restartNow,
    announce,
    systemShutdown,
    stopForUpdate,
    view,
    /** The instance of the Host last checked over host.sock; a new one has heard nothing from this app yet. */
    instance: () => current?.instanceId,
    /**
     * Whether this app is stopping or starting the Host, or waiting to start it again after a crash: a Host that does
     * not answer now is expected not to (the proxy stays quiet about it).
     */
    transitioning: () => stopping || starting !== undefined || status === 'restarting',
    stop() {
      clearTimer(timer)
      timer = undefined
    },
  }
}

/**
 * Keeps the Mac from idle sleep while the Host has work: on power while a session runs or an approval waits; on battery
 * only while a session runs, for at most an hour at a time (the hour starts again once no session runs or power
 * returns). The blocker is Electron's powerSaveBlocker with 'prevent-app-suspension', which holds an assertion against
 * idle system sleep and lets the display sleep. Closing the lid still puts a Mac without an external display to sleep.
 *
 * Apart from that switch, an Agent's 「到点前后保持唤醒」 holds the same assertion from two minutes before its scheduled
 * time until the run settles, at most 32 minutes in one go, on power or battery. The Host says only when (host-info's
 * `scheduleWake`); this decides. It cannot wake a Mac that already sleeps, and it changes no system wake schedule.
 */
function createKeepAwake({
  blocker,
  onBattery,
  enabled = true,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onChange = /** @type {(view: unknown) => void} */ (() => {}),
}) {
  let on = enabled
  let activity = { running: 0, waiting: 0 }
  /** @type {{ next?: string, running: number }} */
  let schedule = { running: 0 }
  let blockerId
  let batterySince
  let batteryLimitReached = false
  let scheduleSince
  let scheduleLimitReached = false
  let busy = false
  let timer
  let lastView = ''

  function view() {
    const active = blockerId !== undefined
    return {
      enabled: on,
      active,
      cause: !active ? null : busy ? (activity.running > 0 ? 'running' : 'waiting') : 'schedule',
      power: onBattery() ? 'battery' : 'ac',
      batteryLimitReached,
      scheduleLimitReached,
    }
  }

  function apply(want) {
    if (want && blockerId === undefined) blockerId = blocker.start('prevent-app-suspension')
    if (!want && blockerId !== undefined) {
      blocker.stop(blockerId)
      blockerId = undefined
    }
  }

  /** Whether a scheduled time is near, or a scheduled run goes on; and when that next changes on its own. */
  function scheduleWindow(at) {
    const next = schedule.next === undefined ? Number.NaN : Date.parse(schedule.next)
    const starts = next - SCHEDULE_LEAD_MS
    const near = Number.isFinite(next) && at >= starts && at < next + SCHEDULE_HOLD_MS
    const change = !Number.isFinite(next) ? undefined : at < starts ? starts - at : near ? next + SCHEDULE_HOLD_MS - at : undefined
    return { wanted: near || schedule.running > 0, change }
  }

  function evaluate() {
    clearTimer(timer)
    timer = undefined
    const at = now()
    const waits = []
    const battery = onBattery()
    if (!battery || activity.running === 0) {
      batterySince = undefined
      batteryLimitReached = false
    }
    let want = on && (battery ? activity.running > 0 && !batteryLimitReached : activity.running + activity.waiting > 0)
    if (want && battery) {
      batterySince ??= at
      const left = batterySince + BATTERY_LIMIT_MS - at
      if (left <= 0) {
        batteryLimitReached = true
        want = false
      } else waits.push(left)
    }
    busy = want
    const window = scheduleWindow(at)
    if (window.change !== undefined) waits.push(window.change)
    if (!window.wanted) {
      scheduleSince = undefined
      scheduleLimitReached = false
    } else {
      scheduleSince ??= at
      const left = scheduleSince + SCHEDULE_LEAD_MS + SCHEDULE_HOLD_MS - at
      if (left <= 0) scheduleLimitReached = true
      else waits.push(left)
    }
    const forSchedule = window.wanted && !scheduleLimitReached
    if (waits.length) timer = setTimer(evaluate, Math.max(1, Math.min(...waits)))
    apply(want || forSchedule)
    const next = view()
    const key = JSON.stringify(next)
    if (key !== lastView) {
      lastView = key
      onChange(next)
    }
  }

  evaluate()
  return {
    view,
    /** From host-info over host.sock; zero when the Host is not running. */
    setActivity(next) {
      activity = { running: Math.max(0, next.running), waiting: Math.max(0, next.waiting) }
      if (next.schedule)
        schedule = { ...(next.schedule.next ? { next: next.schedule.next } : {}), running: Math.max(0, next.schedule.running) }
      evaluate()
    },
    setEnabled(value) {
      on = value
      evaluate()
    },
    /** powerMonitor 'on-ac' and 'on-battery'. */
    powerChanged: evaluate,
    stop() {
      clearTimer(timer)
      apply(false)
    },
  }
}

/**
 * What the desktop app tells the Host it keeps awake (`POST /link/api/host/state`, `state: 'desktop'`): on every change,
 * at once to a Host instance that has not heard it, and at least every 25 seconds so the Host can tell the app still
 * runs. Only a report the Host took counts as sent; one that failed goes again on the next update. `send` resolves
 * whether the Host took it.
 */
function createDesktopReports({ send, now = Date.now }) {
  let last = ''
  let sentAt = -Infinity
  let sending = false
  const keepAwakeOf = value => {
    const view = /** @type {{ active?: unknown, cause?: unknown }} */ (value ?? {})
    return view.active !== true ? null : view.cause === 'schedule' ? 'schedule' : 'busy'
  }
  function post(keepAwake, key) {
    sending = true
    return Promise.resolve(send({ state: 'desktop', keepAwake }))
      .then(
        taken => {
          if (taken !== true) return
          last = key
          sentAt = now()
        },
        () => {},
      )
      .finally(() => {
        sending = false
      })
  }
  return {
    /**
     * @param {unknown} value the keep-awake view
     * @param {string | undefined} instance the Host instance it goes to
     */
    update(value, instance) {
      const keepAwake = keepAwakeOf(value)
      const key = JSON.stringify([keepAwake, instance ?? null])
      if (sending || (key === last && now() - sentAt < DESKTOP_REPORT_MS)) return undefined
      return post(keepAwake, key)
    },
    /** The app quits: the Host hears at once that nothing is kept awake, rather than a minute later. */
    stop() {
      return post(null, '')
    },
  }
}

/**
 * macOS posts its power-off notice (Electron's powerMonitor 'shutdown') for a logout as well as a restart or shutdown,
 * and another app can still cancel a logout. So the notice only marks a quit that follows within 30 seconds as the
 * system's: `take` is true once, for that quit, which then stops the Host before the app ends. A logout cancelled before
 * macOS asks this app to quit leaves the app and the Host running.
 */
function createSystemQuit({ now = Date.now } = {}) {
  let noticeAt
  let taken = false
  return {
    noticed() {
      noticeAt = now()
    },
    take() {
      if (taken || noticeAt === undefined || now() - noticeAt > SYSTEM_QUIT_WINDOW_MS) return false
      taken = true
      return true
    },
    /** Whether a quit now would be the system's, without using the notice up (the updater never holds such a quit). */
    active() {
      return noticeAt !== undefined && now() - noticeAt <= SYSTEM_QUIT_WINDOW_MS
    },
  }
}

/**
 * 「让 Latch 在后台运行」: the macOS login item (SMAppService through app.setLoginItemSettings). It registers the running
 * app bundle, so only a packaged Latch.app can use it; a development run is Electron's own bundle, which would open
 * Electron rather than Latch at login.
 */
function createLoginItem({ app, platform, packaged }) {
  function view() {
    if (platform !== 'darwin') return { available: false, enabled: false, needsApproval: false, reason: 'platform' }
    if (!packaged) return { available: false, enabled: false, needsApproval: false, reason: 'development' }
    const settings = app.getLoginItemSettings()
    const needsApproval = settings.status === 'requires-approval'
    return { available: true, enabled: settings.openAtLogin === true || needsApproval, needsApproval }
  }
  return {
    view,
    set(enabled) {
      if (view().available) app.setLoginItemSettings({ openAtLogin: enabled === true })
      return view()
    },
    openedAtLogin() {
      return platform === 'darwin' && packaged && app.getLoginItemSettings().wasOpenedAtLogin === true
    },
  }
}

/**
 * Time Machine's sticky exclusion, as in apps/host/src/backup.ts (the two copies change together): the attribute
 * `tmutil addexclusion` writes, set with /usr/bin/xattr and fixed arguments (`-s`: on the path itself, never through a
 * link). Contents are never read; failures are logged, never thrown.
 */
const BACKUP_EXCLUSION_ATTRIBUTE = 'com.apple.metadata:com_apple_backup_excludeItem'
const BACKUP_EXCLUSION_VALUE =
  '62706c69737430305f1011636f6d2e6170706c652e6261636b75706408000000000000010100000000000000010000000000000000000000000000001c'

/** @returns {Promise<{ stdout: string }>} */
function runXattr(/** @type {string[]} */ args) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/xattr', args, { env: {}, timeout: 5_000, maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout) =>
      error ? reject(error) : resolve({ stdout }),
    )
  })
}

/** @param {(text: string) => void} [log] */
function ignore(log) {
  return log ?? (() => {})
}

async function excludeFromBackup(paths, { platform = process.platform, run = runXattr, log = ignore() } = {}) {
  if (platform !== 'darwin') return []
  const marked = []
  for (const path of paths) {
    const stats = await lstat(path).catch(() => undefined)
    if (!stats || !(stats.isFile() || stats.isDirectory())) continue
    const present = await run(['-p', '-s', '-x', BACKUP_EXCLUSION_ATTRIBUTE, path]).then(
      ({ stdout }) => stdout.replace(/\s+/g, '').toLowerCase() === BACKUP_EXCLUSION_VALUE,
      () => false,
    )
    if (present) continue
    try {
      await run(['-w', '-s', '-x', BACKUP_EXCLUSION_ATTRIBUTE, BACKUP_EXCLUSION_VALUE, path])
      marked.push(path)
    } catch (error) {
      log(`无法把 ${path} 排除在时间机器备份之外：${error instanceof Error ? error.message : '未知错误'}`)
    }
  }
  return marked
}

module.exports = {
  LIFECYCLE_CHANNELS,
  CRASH_LIMIT,
  BATTERY_LIMIT_MS,
  SCHEDULE_LEAD_MS,
  SCHEDULE_HOLD_MS,
  DESKTOP_REPORT_MS,
  SYSTEM_QUIT_WINDOW_MS,
  BACKUP_EXCLUSION_ATTRIBUTE,
  BACKUP_EXCLUSION_VALUE,
  parseLaunchRecord,
  readLaunchRecord,
  writeLaunchRecord,
  readLifecyclePreferences,
  writeLifecyclePreferences,
  hostEnvironment,
  spawnHost,
  backoff,
  createHostSupervisor,
  createKeepAwake,
  createDesktopReports,
  createLoginItem,
  createSystemQuit,
  excludeFromBackup,
  readOwnFile,
  writePrivateFile,
}
