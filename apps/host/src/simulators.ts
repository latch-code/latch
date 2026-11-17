// This Mac's iOS simulators through Apple's public `xcrun simctl` and `xcrun devicectl`, and nothing else: no private
// framework, no shell string, no download. Each call is a fixed argument list with a validated UDID (and a name, bundle
// id, service or identifier checked against what simctl itself listed), a timeout and a bound on what it may print. The
// two long-running children (a recording, a log stream) have their own caps and end with the panel, the device or the
// Host. The Host shuts down only a device it booted itself: on the person's word, after the panel has left it for ten
// minutes, and when the Host stops. Pictures and recordings pass through a private temporary directory (simctl will not
// write one to a pipe) that is removed once read; pictures, recordings and log lines are never logged, recorded or
// kept. See docs/DEVICE-PREVIEW.md.
import { execFile, spawn } from 'node:child_process'
import { lstat, mkdtemp, open, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SIMULATOR_BUNDLE_ID,
  SIMULATOR_LOG_LIMITS,
  SIMULATOR_NAME,
  SIMULATOR_PRIVACY_ACTIONS,
  SIMULATOR_PRIVACY_SERVICES,
  SIMULATOR_RECORD_LIMITS,
  type SimulatorAppView,
  type SimulatorCatalogView,
  type SimulatorOrientation,
  type SimulatorOrientationView,
  type SimulatorPrivacyAction,
  type SimulatorPrivacyService,
  type SimulatorRecordingView,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'

/** simctl's own UDIDs: an upper-case UUID; anything else (`booted`, `all`, an option) is refused before simctl runs. */
export const SIMULATOR_UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/u
/** The attachments' bound for a picture, which the panel's frames share. */
export const PICTURE_LIMIT = 5 * 1024 * 1024
const LIST_LIMIT = 4 * 1024 * 1024
const OUTPUT_LIMIT = 64 * 1024
const URL_LIMIT = 2048
/** simctl processes at once, for every device together. */
const MAX_RUNNING = 4
const TIMEOUTS = { list: 20_000, boot: 120_000, shutdown: 60_000, picture: 20_000, action: 20_000, create: 60_000 } as const
/** `listapps` of a device with a few apps of the person's is some 60 KB; the catalog some 70 KB. */
const APPS_LIMIT = 4 * 1024 * 1024
const CATALOG_LIMIT = 1024 * 1024
/** How long a device the panel no longer shows stays up, when this Host booted it. */
const IDLE_SHUTDOWN_MS = 10 * 60_000
const IDLE_EVERY_MS = 60_000
/** A recording whose panel stopped asking for frames this long ago has no one to hand it to. */
const RECORDING_ORPHAN_MS = 20_000
/** How long a finished recording waits to be taken. */
const RECORDING_KEPT_MS = 60_000
/** Long-running children: one recording per device and two in all; two log streams per device and four in all. */
const RECORDINGS_MAX = 2
const LOGS_PER_DEVICE = 2
const LOGS_MAX = 4
/** How long the Host's stop waits for the devices it booted to shut down (its listeners have three seconds in all). */
const STOP_SHUTDOWN_MS = 2_500
/** A process name in a log predicate: the listed app's executable, in a strict set with no quote or backslash. */
const PROCESS_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,63}$/u
/** Apple's own identifiers for device types and runtimes, as `simctl list --json` gives them. */
export const SIMULATOR_TYPE_ID = /^com\.apple\.CoreSimulator\.SimDeviceType\.[A-Za-z0-9.-]{1,80}$/u
export const SIMULATOR_RUNTIME_ID = /^com\.apple\.CoreSimulator\.SimRuntime\.[A-Za-z0-9.-]{1,80}$/u
const ORIENTATIONS = new Set<SimulatorOrientation>(['portrait', 'portraitUpsideDown', 'landscapeLeft', 'landscapeRight'])
/** Schemes simctl may open: never one that reads this Mac's files or runs script in the page that opens it. */
const REFUSED_SCHEMES = new Set(['file', 'javascript', 'data', 'blob', 'about', 'vbscript'])
/** How long after its last frame the panel is still said to show a device. */
const SHOWN_FOR_MS = 15_000
/** How long a list stands for a frame or a change. */
const LIST_FRESH_MS = 2_000

export type SimulatorState = 'booted' | 'shutdown' | 'booting' | 'shutting-down' | 'unknown'
export type SimulatorAppearance = 'light' | 'dark'
export type SimulatorPicture = 'png' | 'jpeg'

export interface SimulatorDevice {
  udid: string
  name: string
  /** The runtime as people say it, such as 「iOS 27.2」. */
  os: string
  state: SimulatorState
  /** Booted by this Host, so its 关机 is offered. */
  ours: boolean
}

export interface SimctlResult {
  code: number
  stdout: Buffer
  stderr: string
}

/** Runs `xcrun simctl <args>`; the test seam. */
export type SimctlRunner = (
  args: readonly string[],
  options: { timeoutMs: number; maxBytes: number; signal?: AbortSignal },
) => Promise<SimctlResult>

/** Brings one device's window up in Apple's Device Hub; the test seam. */
export type HubOpener = (udid: string) => Promise<SimctlResult>

/** A simctl child that runs until it is told to stop: `io recordVideo` and `spawn … log stream`. */
export interface SimctlChild {
  onStdout(listener: (chunk: Buffer) => void): void
  onStderr(listener: (chunk: Buffer) => void): void
  /** SIGINT: simctl finishes the movie, `log` ends. */
  interrupt(): void
  /** SIGKILL. */
  kill(): void
  /** The exit code, -1 for a signal or a failure to start. */
  exited: Promise<number>
}

/**
 * Starts `xcrun simctl <args>` and leaves it running; the test seam. `limitSeconds` bounds it even if the Host is gone:
 * the real spawner's watcher interrupts it after that long (0: no time bound), or as soon as the Host process has ended.
 */
export type SimctlSpawner = (args: readonly string[], options?: { limitSeconds?: number }) => SimctlChild

export interface SimulatorOptions {
  /** Left out, as in tests that name no fake, nothing on this Mac is ever run and no device is offered. */
  run?: SimctlRunner
  /** `xcrun devicectl <args>`, for rotation. Left out, no device can be rotated. */
  devicectl?: SimctlRunner
  /** Long-running simctl children. Left out, there is no recording and no logs pane. */
  spawn?: SimctlSpawner
  /** Left out, 「在 Device Hub 中打开」 is refused. */
  openHub?: HubOpener
  /**
   * Shut down a device this Host booted once the panel has left it this long; 0 never. The default is ten minutes. The
   * timer runs only with a runner.
   */
  idleMs?: number
  /** Told before the Host shuts a device down by itself (idle, or the Host stopping), for the audit record. */
  onAutoShutdown?: (udid: string, reason: 'idle' | 'host-stop') => Promise<void>
  /** A recording's bounds; a minute and 25 MB unless a test names smaller ones. */
  recordLimits?: { ms: number; bytes: number }
  now?: () => number
}

/** A child's environment: the same few variables as the runners. */
function childEnvironment(): Record<string, string> {
  const env: Record<string, string> = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
  for (const key of ['HOME', 'TMPDIR', 'DEVELOPER_DIR', 'USER', 'LOGNAME'] as const) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  return env
}

/**
 * One program with a fixed argument list, no shell, a small environment and `/` as its working directory, so nothing it
 * writes by a relative name (`simctl io screenshot -` writes a file named `-`) lands in the Host's or anyone's folder.
 */
export function runFixed(
  file: string,
  args: readonly string[],
  options: { timeoutMs: number; maxBytes?: number; signal?: AbortSignal; env?: Record<string, string> },
): Promise<SimctlResult> {
  return new Promise(resolve => {
    execFile(
      file,
      [...args],
      {
        cwd: '/',
        env: options.env ?? { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ...(process.env.HOME ? { HOME: process.env.HOME } : {}) },
        timeout: options.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: options.maxBytes ?? OUTPUT_LIMIT,
        encoding: 'buffer',
        windowsHide: true,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) =>
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
          stdout: Buffer.from(stdout ?? []),
          stderr: Buffer.from(stderr ?? []).toString('utf8'),
        }),
    )
  })
}

/** The real runner: an absolute `xcrun`, a fixed argument list, a small environment, killed at its timeout. */
export const xcrunSimctl: SimctlRunner = (args, { timeoutMs, maxBytes, signal }) =>
  runFixed('/usr/bin/xcrun', ['simctl', ...args], { timeoutMs, maxBytes, env: childEnvironment(), ...(signal ? { signal } : {}) })

/** The real devicectl runner, the same way: `devicectl device orientation …` addresses a simulator by its UDID. */
export const xcrunDevicectl: SimctlRunner = (args, { timeoutMs, maxBytes, signal }) =>
  runFixed('/usr/bin/xcrun', ['devicectl', ...args], { timeoutMs, maxBytes, env: childEnvironment(), ...(signal ? { signal } : {}) })

/**
 * A fixed script, never built from input; its arguments arrive as `$1`… A watcher checks every second that the child
 * still runs; once the Host process (`$1`) has gone or `$2` seconds have passed (0: never), it sends the child SIGINT,
 * which lets simctl finish a movie and end `log` inside the device, and exits. Never SIGKILL: a killed `simctl spawn`
 * leaves a quiet `log stream` running in the device until it shuts down (checked on Xcode 27.2). Then `exec` makes the
 * child this very process, so its PID, signals and exit stay simctl's; the watcher holds none of its pipes.
 */
const CHILD_WATCHER = [
  'h=$1; s=$2; shift 2; p=$$',
  '( exec </dev/null >/dev/null 2>&1; i=0',
  '  while kill -0 "$p"; do',
  '    if ! kill -0 "$h" || { [ "$s" -gt 0 ] && [ "$i" -ge "$s" ]; }; then kill -INT "$p"; exit 0; fi',
  '    sleep 1; i=$((i+1))',
  '  done ) &',
  'exec "$@"',
].join('\n')

/** The real spawner: no shell string from input, `/` as its working directory, the small environment, no input. */
export const spawnSimctl: SimctlSpawner = (args, options = {}) => {
  const limit = String(Math.max(0, Math.floor(options.limitSeconds ?? 0)))
  const command = ['-c', CHILD_WATCHER, 'latch-simctl', String(process.pid), limit, '/usr/bin/xcrun', 'simctl', ...args]
  const child = spawn('/bin/sh', command, {
    cwd: '/',
    env: childEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const exited = new Promise<number>(resolve => {
    child.once('error', () => resolve(-1))
    child.once('close', code => resolve(typeof code === 'number' ? code : -1))
  })
  return {
    onStdout: listener => void child.stdout?.on('data', listener),
    onStderr: listener => void child.stderr?.on('data', listener),
    interrupt: () => void child.kill('SIGINT'),
    kill: () => void child.kill('SIGKILL'),
    exited,
  }
}

const runFile = (file: string, args: readonly string[], timeoutMs: number) => runFixed(file, args, { timeoutMs })

/**
 * The real opener: Device Hub of the Xcode that `xcode-select` names, given the device's `devices://device/open?id=`
 * address (checked on Xcode 27.2: the device's own window comes up). A fixed argument list through `/usr/bin/open`.
 */
export const openInDeviceHub: HubOpener = async udid => {
  if (!SIMULATOR_UDID.test(udid)) return { code: 1, stdout: Buffer.alloc(0), stderr: 'invalid device' }
  const selected = await runFile('/usr/bin/xcode-select', ['-p'], 10_000)
  const developer = selected.stdout.toString('utf8').trim()
  const app = /^\/[^\0\n]+\/Contents\/Developer$/u.test(developer)
    ? `${developer.slice(0, -'/Developer'.length)}/Applications/DeviceHub.app`
    : undefined
  const address = `devices://device/open?id=${udid}`
  return app
    ? runFile('/usr/bin/open', ['-a', app, address], 20_000)
    : runFile('/usr/bin/open', ['-b', 'com.apple.dt.Devices', address], 20_000)
}

/** `mkdtemp`'s names for a picture's and a recording's directory: the prefix and six characters. */
const TEMP_NAME = /^latch-(?:sim|rec)-[A-Za-z0-9]{6}$/u
/** Longer than any of them lives: a picture for seconds, a recording for a minute and then a minute waiting to be taken. */
const TEMP_STALE_MS = 10 * 60_000

/**
 * Removes what a Host that ended without stopping (a crash, SIGKILL) left in `dir`: only this user's own directories
 * by those exact names, never a symbolic link, and only when nothing in one has changed for ten minutes, so another
 * Host of this user (another data directory, a test) that is recording now keeps its file. Errors are ignored.
 */
export async function removeStaleSimulatorTemp(dir: string, now = Date.now()): Promise<string[]> {
  const removed: string[] = []
  const uid = process.getuid?.()
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return removed
  }
  for (const name of names) {
    if (!TEMP_NAME.test(name)) continue
    const path = join(dir, name)
    try {
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid)) continue
      let newest = info.mtimeMs
      for (const entry of (await readdir(path)).slice(0, 64)) newest = Math.max(newest, (await lstat(join(path, entry))).mtimeMs)
      if (now - newest < TEMP_STALE_MS) continue
      // `rm` removes a link inside, never what it points to.
      await rm(path, { recursive: true, force: true })
      removed.push(name)
    } catch {
      // Gone already, or not this user's to read.
    }
  }
  return removed
}

interface ListedDevice {
  udid: string
  name: string
  runtime: string
  state: SimulatorState
  /**
   * simctl's `lastUsedAt` (Xcode 27.2): unset before a device's first boot, the same while it runs, new on each boot. It
   * tells the device this Host booted from the same device shut down and booted again by the person since.
   */
  mark?: string
}

/** `simctl list devices --json available` as entries; undefined when simctl failed or printed something else. */
function parseDeviceList(result: SimctlResult): ListedDevice[] | undefined
function parseDeviceList(result: SimctlResult, strict: false): ListedDevice[]
function parseDeviceList(result: SimctlResult, strict = true): ListedDevice[] | undefined {
  let parsed: unknown
  try {
    parsed = result.code === 0 ? JSON.parse(result.stdout.toString('utf8')) : undefined
  } catch {
    parsed = undefined
  }
  const groups = parsed && typeof parsed === 'object' ? Reflect.get(parsed, 'devices') : undefined
  if (!groups || typeof groups !== 'object') return strict ? undefined : []
  const devices: ListedDevice[] = []
  for (const [runtime, entries] of Object.entries(groups as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries.slice(0, 200)) {
      if (!entry || typeof entry !== 'object') continue
      const udid: unknown = Reflect.get(entry, 'udid')
      const name: unknown = Reflect.get(entry, 'name')
      if (!isSimulatorUdid(udid) || typeof name !== 'string' || Reflect.get(entry, 'isAvailable') === false) continue
      const mark: unknown = Reflect.get(entry, 'lastUsedAt')
      devices.push({
        udid,
        name: name.slice(0, 120),
        runtime,
        state: stateOf(Reflect.get(entry, 'state')),
        ...(typeof mark === 'string' && mark.length <= 64 ? { mark } : {}),
      })
    }
  }
  return devices
}

export function isSimulatorUdid(value: unknown): value is string {
  return typeof value === 'string' && SIMULATOR_UDID.test(value)
}

/** An address simctl may open in a device: a real URL with a scheme, no blanks or controls, none that reads files. */
export function simulatorUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > URL_LIMIT || /[\s\p{Cc}]/u.test(value))
    throw new AppError(400, 'invalid-url', '地址无效')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new AppError(400, 'invalid-url', '地址无效')
  }
  const scheme = url.protocol.slice(0, -1).toLowerCase()
  if (!/^[a-z][a-z0-9+.-]{0,31}$/u.test(scheme) || REFUSED_SCHEMES.has(scheme)) throw new AppError(400, 'invalid-url', '不能打开这种地址')
  if ((scheme === 'http' || scheme === 'https') && !url.hostname) throw new AppError(400, 'invalid-url', '地址无效')
  return value
}

/** What simctl said when it failed, short and plain, for the hover text; never a picture or a path of ours. */
function reason(result: SimctlResult): string {
  const line = result.stderr
    .split('\n')
    .map(text => text.trim())
    .find(text => text && !text.startsWith('Note:') && !text.startsWith('Underlying error'))
  const plain = (line ?? `simctl 退出码 ${result.code}`).replace(/[\p{Cc}\u200b-\u200f\u202a-\u202e\u2066-\u2069]/gu, '')
  return plain.length > 200 ? `${plain.slice(0, 199)}…` : plain
}

function stateOf(value: unknown): SimulatorState {
  switch (value) {
    case 'Booted':
      return 'booted'
    case 'Shutdown':
      return 'shutdown'
    case 'Booting':
      return 'booting'
    case 'Shutting Down':
      return 'shutting-down'
    default:
      return 'unknown'
  }
}

/** 「com.apple.CoreSimulator.SimRuntime.iOS-27-2」 → 「iOS 27.2」 */
function osOf(runtime: string): string {
  const tail = runtime.split('.').at(-1) ?? ''
  const match = /^([A-Za-z]+)-(\d+(?:-\d+)*)/u.exec(tail)
  return match ? `${match[1]} ${match[2]!.replaceAll('-', '.')}` : tail.slice(0, 40)
}

type Plist = string | Plist[] | { [key: string]: Plist }

/**
 * The old-style (OpenStep) property list `simctl listapps` prints: dictionaries, arrays and strings, quoted or bare.
 * Parsed here rather than by a second program; anything else, or nesting past 8, is refused.
 */
export function parseOldPlist(text: string): Plist {
  let at = 0
  const fail = (): never => {
    throw new AppError(502, 'simulator-failed', '没有读懂 App 列表')
  }
  const space = () => {
    for (;;) {
      while (at < text.length && /\s/u.test(text[at]!)) at++
      if (text.startsWith('/*', at)) {
        const end = text.indexOf('*/', at + 2)
        at = end === -1 ? fail() : end + 2
      } else if (text.startsWith('//', at)) {
        const end = text.indexOf('\n', at)
        at = end === -1 ? text.length : end + 1
      } else return
    }
  }
  const quoted = (): string => {
    at++
    let out = ''
    while (at < text.length && text[at] !== '"') {
      const character = text[at++]!
      if (character !== '\\') {
        out += character
        continue
      }
      const next = text[at++] ?? fail()
      if (next === 'n') out += '\n'
      else if (next === 't') out += '\t'
      else if (next === 'r') out += '\r'
      else if (next === 'U' && /^[0-9a-fA-F]{4}$/u.test(text.slice(at, at + 4))) {
        out += String.fromCharCode(Number.parseInt(text.slice(at, at + 4), 16))
        at += 4
      } else if (/[0-7]/u.test(next)) {
        let digits = next
        while (digits.length < 3 && /[0-7]/u.test(text[at] ?? '')) digits += text[at++]
        out += String.fromCharCode(Number.parseInt(digits, 8))
      } else out += next
    }
    if (text[at] !== '"') fail()
    at++
    return out
  }
  const value = (depth: number): Plist => {
    if (depth > 8) fail()
    space()
    const character = text[at]
    if (character === '{') {
      at++
      const dict: Record<string, Plist> = Object.create(null)
      for (;;) {
        space()
        if (text[at] === '}') {
          at++
          return dict
        }
        const key = value(depth + 1)
        if (typeof key !== 'string') fail()
        space()
        if (text[at++] !== '=') fail()
        dict[key as string] = value(depth + 1)
        space()
        if (text[at++] !== ';') fail()
      }
    }
    if (character === '(') {
      at++
      const list: Plist[] = []
      for (;;) {
        space()
        if (text[at] === ')') {
          at++
          return list
        }
        list.push(value(depth + 1))
        space()
        if (text[at] === ',') at++
        else if (text[at] !== ')') fail()
      }
    }
    if (character === '"') return quoted()
    if (character === '<') {
      const end = text.indexOf('>', at)
      if (end === -1) fail()
      const data = text.slice(at, end + 1)
      at = end + 1
      return data
    }
    const bare = /^[A-Za-z0-9_$+/:.-]+/u.exec(text.slice(at, at + 4096))
    if (!bare) fail()
    at += bare![0].length
    return bare![0]
  }
  const parsed = value(0)
  space()
  if (at !== text.length) fail()
  return parsed
}

/** A bundle id as simctl lists one; refused before simctl runs otherwise. */
export function isBundleId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 155 && SIMULATOR_BUNDLE_ID.test(value)
}

/** A new device's name: what the person typed, trimmed, in a small set that can never read as an option. */
export function simulatorName(value: unknown): string {
  const name = typeof value === 'string' ? value.normalize('NFC').trim() : ''
  if (!SIMULATOR_NAME.test(name)) throw new AppError(400, 'invalid-name', "名字只能用字母、数字、空格和 . _ ( ) ' -，不超过 64 个字符")
  return name
}

interface ListedApp extends SimulatorAppView {
  /** The process name, for the logs pane's filter; never sent to a page. */
  executable?: string
}

interface Recording {
  udid: string
  /** The device (of the person) whose panel started it: only that one stops, takes or sees it. */
  owner: string
  dir: string
  file: string
  child: SimctlChild
  started: number
  state: 'recording' | 'stopping' | 'ready'
  ended?: 'time' | 'size'
  /** Settles once the child has exited. */
  exited: Promise<number>
  /** Settles once a stop (the person's, or a bound's) has left it ready or thrown it away. */
  finishing?: Promise<void>
  timers: Array<ReturnType<typeof setTimeout>>
}

/** One log stream: what the route writes to. `lines` answers false while the page is behind. */
export interface SimulatorLogSink {
  lines(lines: string[]): boolean
  dropped(count: number): void
  closed(reason: 'device' | 'host' | 'exited'): void
}

interface LogStream {
  udid: string
  child: SimctlChild
  close(reason: 'device' | 'host' | 'exited'): void
}

/** A log line as the pane shows it: no control or bidi characters, at most the pane's bound. */
function plainLine(line: string): string {
  const plain = line.replace(/[\p{Cc}​-‏‪-‮⁦-⁩]/gu, '')
  return plain.length > SIMULATOR_LOG_LIMITS.lineChars ? `${plain.slice(0, SIMULATOR_LOG_LIMITS.lineChars - 1)}…` : plain
}

/** The few lines `log stream` prints before the log itself. */
const LOG_PREAMBLE = /^(Filtering the log data|Timestamp\s+Ty\s|getpwuid_r did not find)/u

export class Simulators {
  private readonly run: SimctlRunner | undefined
  private readonly hub: HubOpener | undefined
  private readonly now: () => number
  /** Devices this Host booted, and so may shut down. Dropped once a list shows one not running or booted again. */
  private readonly booted = new Set<string>()
  /** Each of those devices' boot time as simctl listed it right after this Host booted it; absent when simctl gave none. */
  private readonly bootMarks = new Map<string, string>()
  /** One picture at a time per device and kind: a second ask shares the first one's answer. */
  private readonly pictures = new Map<string, Promise<Buffer>>()
  /** One boot, shutdown or change at a time per device. */
  private readonly acting = new Set<string>()
  private readonly running = new Set<AbortController>()
  private queue: Array<() => void> = []
  private shownDevice: { udid: string; at: number } | undefined
  private readonly agents = new Map<string, { udid?: string }>()
  /** `undefined` until the first list: whether simctl answered at all. */
  private xcode: boolean | undefined
  private stopped = false
  private stopping: Promise<void> | undefined
  private count = 0
  private recent: { at: number; value: { xcode: boolean; devices: SimulatorDevice[] } } | undefined
  private readonly devicectl: SimctlRunner | undefined
  private readonly spawner: SimctlSpawner | undefined
  private readonly idleMs: number
  private readonly onAutoShutdown: SimulatorOptions['onAutoShutdown']
  /** When each device was last looked at or acted on, through the panel or an agent: what idle is measured from. */
  private readonly lastSeen = new Map<string, number>()
  /** When the panel last asked for a frame of each device: a recording whose panel stopped asking has no one to go to. */
  private readonly lastFrame = new Map<string, number>()
  private readonly recordings = new Map<string, Recording>()
  /** Recordings being set up: they hold their place in the bounds before the first await. */
  private readonly recordingSlots = new Set<string>()
  private readonly logStreams = new Set<LogStream>()
  private readonly apps = new Map<string, { at: number; apps: ListedApp[] }>()
  private catalogCache: { at: number; value: SimulatorCatalogView } | undefined
  private readonly idleTimer: ReturnType<typeof setInterval> | undefined
  private readonly recordLimits: { ms: number; bytes: number }

  constructor(options: SimulatorOptions = {}) {
    this.run = options.run
    this.hub = options.openHub
    this.now = options.now ?? Date.now
    this.devicectl = options.devicectl
    this.spawner = options.spawn
    this.idleMs = options.idleMs ?? IDLE_SHUTDOWN_MS
    this.onAutoShutdown = options.onAutoShutdown
    this.recordLimits = {
      ms: Math.min(options.recordLimits?.ms ?? Infinity, SIMULATOR_RECORD_LIMITS.seconds * 1000),
      bytes: Math.min(options.recordLimits?.bytes ?? Infinity, SIMULATOR_RECORD_LIMITS.bytes),
    }
    if (this.run && this.idleMs > 0) {
      this.idleTimer = setInterval(() => void this.idleCheck().catch(() => undefined), Math.min(IDLE_EVERY_MS, this.idleMs))
      this.idleTimer.unref()
    }
  }

  /** What the panel offers beyond simctl's own commands. */
  get abilities(): { rotate: boolean; record: boolean; logs: boolean } {
    return { rotate: this.devicectl !== undefined, record: this.spawner !== undefined, logs: this.spawner !== undefined }
  }

  /** Whether this Host may run simctl at all: on macOS with the start script's runner. */
  get supported(): boolean {
    return this.run !== undefined
  }

  /**
   * Whether the 设备 panel is offered: simctl runs here, and the last list did not find Xcode with no device at all (a
   * missing Xcode is said inside the panel).
   */
  get offered(): boolean {
    return this.run !== undefined && !(this.xcode === true && this.count === 0)
  }

  /** Whether the last list found simctl (so Xcode); undefined before the first. For a synchronous tool listing. */
  get ready(): boolean {
    return this.xcode === true
  }

  /**
   * Every child still running ends, recordings are thrown away, log streams close, and each device this Host booted
   * is shut down (waited for a little over two seconds; a slower one finishes on its own). Devices the person started
   * stay as they are. Once only, however often it is called.
   */
  stop(): Promise<void> {
    return (this.stopping ??= this.stopNow())
  }

  private async stopNow(): Promise<void> {
    this.stopped = true
    if (this.idleTimer) clearInterval(this.idleTimer)
    // Each recording's directory is removed within the wait below, whether or not this Host booted any device.
    const discards = [...this.recordings.values()].map(recording => this.discard(recording, { stopping: true }))
    for (const stream of [...this.logStreams]) stream.close('host')
    for (const controller of this.running) controller.abort()
    this.running.clear()
    for (const start of this.queue.splice(0)) start()
    const run = this.run
    const ours = new Map([...this.booted].map(udid => [udid, this.bootMarks.get(udid)]))
    this.booted.clear()
    const shutdowns = async () => {
      if (!run || ours.size === 0) return
      // Listed again first (not through `simctl()`, which refuses once stopped): only a device still running since this
      // Host booted it, by simctl's own boot time, is shut down. A device the person shut down and booted again is not.
      const listed = parseDeviceList(
        await run(['list', 'devices', '--json', 'available'], { timeoutMs: TIMEOUTS.list, maxBytes: LIST_LIMIT }),
        false,
      )
      await Promise.allSettled(
        [...ours]
          .filter(
            ([udid, mark]) =>
              mark !== undefined && listed.some(entry => entry.udid === udid && entry.state === 'booted' && entry.mark === mark),
          )
          .map(async ([udid]) => {
            await this.onAutoShutdown?.(udid, 'host-stop').catch(() => undefined)
            // With no signal, so the Host's own stop does not kill it.
            await run(['shutdown', udid], { timeoutMs: TIMEOUTS.shutdown, maxBytes: OUTPUT_LIMIT })
          }),
      )
    }
    await Promise.race([
      Promise.allSettled([...discards, shutdowns()]),
      new Promise(resolve => setTimeout(resolve, STOP_SHUTDOWN_MS).unref()),
    ])
  }

  private disown(udid: string): void {
    this.booted.delete(udid)
    this.bootMarks.delete(udid)
  }

  /** The device was looked at or acted on now: its idle time starts again. */
  touch(udid: string): void {
    if (isSimulatorUdid(udid)) this.lastSeen.set(udid, this.now())
  }

  /**
   * Shuts down each device this Host booted that nobody has looked at or acted on for the idle time: no frame, panel
   * action or agent call, no recording or log stream, and no agent's Xcode session holding it. Lists again first, so a
   * device shut down or started elsewhere in the meantime is left alone. The timer calls it; tests call it directly.
   */
  async idleCheck(): Promise<string[]> {
    if (this.stopped || this.idleMs <= 0 || this.booted.size === 0) return []
    const now = this.now()
    const held = new Set(this.agentsUsing().map(agent => agent.udid))
    const unnamed = this.agentsUsing().some(agent => !agent.udid)
    const idle = [...this.booted].filter(
      udid =>
        // Without a boot time this Host cannot tell its boot from the person's: never shut down by itself.
        this.bootMarks.has(udid)
        && !this.recordings.has(udid)
        && ![...this.logStreams].some(stream => stream.udid === udid)
        && !held.has(udid)
        && !unnamed
        && now - (this.lastSeen.get(udid) ?? 0) >= this.idleMs,
    )
    if (idle.length === 0) return []
    const { devices } = await this.list()
    const done: string[] = []
    for (const udid of idle) {
      const device = devices.find(item => item.udid === udid)
      if (!device || device.state !== 'booted' || !this.booted.has(udid) || this.acting.has(udid)) continue
      // A frame or an action may have come while the list was read.
      if (this.now() - (this.lastSeen.get(udid) ?? 0) < this.idleMs) continue
      await this.onAutoShutdown?.(udid, 'idle').catch(() => undefined)
      try {
        await this.shutdown(udid)
        done.push(udid)
      } catch {
        // Tried again at the next check.
      }
    }
    return done
  }

  /**
   * An agent's device session through Xcode's tools began (`start`), went on, or ended (`end`), as its calls passed
   * Latch's bridge: what the panel shows as 「Agent 正在使用」. Only the session and the UDID a call named.
   */
  agentCall(sessionId: string, phase: 'start' | 'call' | 'end', udid?: string): void {
    if (phase === 'end') {
      this.agents.delete(sessionId)
      return
    }
    const held = this.agents.get(sessionId)
    if (phase === 'start' || held) this.agents.set(sessionId, { ...((udid ?? held?.udid) ? { udid: udid ?? held!.udid } : {}) })
  }

  /** The agent's session ended, its run settled or its bridge closed: it no longer holds a device. */
  agentEnded(sessionId: string): void {
    this.agents.delete(sessionId)
  }

  /** Which sessions' agents hold a device now, and which device when a call named one. */
  agentsUsing(): Array<{ sessionId: string; udid?: string }> {
    return [...this.agents].map(([sessionId, held]) => ({ sessionId, ...held }))
  }

  /** The device the panel showed a frame of in the last few seconds. */
  shown(): string | undefined {
    const shown = this.shownDevice
    return shown && this.now() - shown.at <= SHOWN_FOR_MS ? shown.udid : undefined
  }

  private simctl(args: readonly string[], timeoutMs: number, maxBytes = OUTPUT_LIMIT): Promise<SimctlResult> {
    return this.exec(this.run, args, timeoutMs, maxBytes)
  }

  /** One run-to-completion child of either runner, in the shared queue of four. */
  private async exec(run: SimctlRunner | undefined, args: readonly string[], timeoutMs: number, maxBytes: number): Promise<SimctlResult> {
    if (!run || this.stopped) throw new AppError(503, 'simulator-unavailable', '这台电脑上没有可用的模拟器')
    if (this.running.size >= MAX_RUNNING) await new Promise<void>(resolve => this.queue.push(resolve))
    if (this.stopped) throw new AppError(503, 'simulator-unavailable', '这台电脑上没有可用的模拟器')
    const controller = new AbortController()
    this.running.add(controller)
    try {
      return await run(args, { timeoutMs, maxBytes, signal: controller.signal })
    } finally {
      this.running.delete(controller)
      this.queue.shift()?.()
    }
  }

  /** Every device simctl knows that can run, in its order; `xcode: false` when simctl is missing or fails to list. */
  async list(): Promise<{ xcode: boolean; devices: SimulatorDevice[] }> {
    if (!this.run) return { xcode: false, devices: [] }
    const listed = parseDeviceList(await this.simctl(['list', 'devices', '--json', 'available'], TIMEOUTS.list, LIST_LIMIT))
    if (!listed) {
      this.xcode = false
      this.recent = undefined
      return { xcode: false, devices: [] }
    }
    this.xcode = true
    const devices: SimulatorDevice[] = []
    for (const { udid, name, runtime, state, mark } of listed) {
      // Shut down, or booted again since this Host booted it (a new boot time): no longer this Host's.
      const known = this.bootMarks.get(udid)
      if (state === 'shutdown' || (this.booted.has(udid) && mark !== undefined && known !== undefined && mark !== known)) this.disown(udid)
      // Shut down elsewhere: what ran on it ends with it.
      if (state === 'shutdown' || state === 'shutting-down') this.endChildren(udid)
      devices.push({ udid, name, os: osOf(runtime), state, ours: this.booted.has(udid) })
    }
    this.count = devices.length
    const value = { xcode: true, devices: devices.slice(0, 200) }
    this.recent = { at: this.now(), value }
    return value
  }

  /**
   * One device as simctl lists it; 404 when there is none. A frame or a change may use a list from the last two seconds;
   * booting and shutting down always list again.
   */
  async device(udid: unknown, options: { fresh?: boolean } = {}): Promise<SimulatorDevice> {
    if (!isSimulatorUdid(udid)) throw new AppError(400, 'invalid-input', '设备标识无效')
    const recent = this.recent
    const { xcode, devices } = !options.fresh && recent && this.now() - recent.at < LIST_FRESH_MS ? recent.value : await this.list()
    if (!xcode) throw new AppError(503, 'simulator-unavailable', '未安装 Xcode')
    const found = devices.find(device => device.udid === udid)
    if (!found) throw new AppError(404, 'simulator-not-found', '没有这台模拟器')
    return found
  }

  /** A running device, which counts as looked at or acted on now. */
  private async bootedDevice(udid: unknown): Promise<SimulatorDevice> {
    const device = await this.device(udid)
    if (device.state !== 'booted') throw new AppError(409, 'simulator-not-booted', '设备未启动')
    this.touch(device.udid)
    return device
  }

  /** The recording and the log streams of one device end: it was shut down. */
  private endChildren(udid: string): void {
    const recording = this.recordings.get(udid)
    if (recording) void this.discard(recording)
    for (const stream of [...this.logStreams]) if (stream.udid === udid) stream.close('device')
    this.apps.delete(udid)
  }

  private async exclusive<T>(udid: string, work: () => Promise<T>): Promise<T> {
    if (this.acting.has(udid)) throw new AppError(409, 'simulator-busy', '这台设备正在处理上一个操作')
    this.acting.add(udid)
    try {
      return await work()
    } finally {
      this.acting.delete(udid)
    }
  }

  private failed(result: SimctlResult): AppError {
    return new AppError(502, 'simulator-failed', reason(result))
  }

  /** Boots a device that is shut down; one already running is left as it is and stays the person's. */
  async boot(udid: unknown): Promise<SimulatorDevice> {
    const device = await this.device(udid, { fresh: true })
    if (device.state === 'booted' || device.state === 'booting') return device
    if (device.state !== 'shutdown') throw new AppError(409, 'simulator-busy', '这台设备正在关机')
    return this.exclusive(device.udid, async () => {
      const result = await this.simctl(['boot', device.udid], TIMEOUTS.boot)
      if (result.code !== 0) throw this.failed(result)
      this.booted.add(device.udid)
      this.touch(device.udid)
      // `boot` returns before the device has finished starting; `bootstatus` waits until it has (or its timeout ends).
      await this.simctl(['bootstatus', device.udid], TIMEOUTS.boot)
      this.recent = undefined
      // Its boot time, to tell it later from the same device booted again by the person. Without one, this Host never
      // shuts it down by itself (only on the person's word).
      const listed = parseDeviceList(await this.simctl(['list', 'devices', '--json', 'available'], TIMEOUTS.list, LIST_LIMIT), false)
      const mark = listed.find(entry => entry.udid === device.udid)?.mark
      if (mark !== undefined && this.booted.has(device.udid)) this.bootMarks.set(device.udid, mark)
      return { ...device, state: 'booted' as const, ours: true }
    })
  }

  /** Shuts down only a device this Host booted. */
  async shutdown(udid: unknown): Promise<SimulatorDevice> {
    const device = await this.device(udid, { fresh: true })
    if (!this.booted.has(device.udid)) throw new AppError(409, 'simulator-not-ours', '只关闭 Latch 启动的设备')
    return this.exclusive(device.udid, async () => {
      this.endChildren(device.udid)
      const result = await this.simctl(['shutdown', device.udid], TIMEOUTS.shutdown)
      if (result.code !== 0) throw this.failed(result)
      this.disown(device.udid)
      this.recent = undefined
      return { ...device, state: 'shutdown' as const, ours: false }
    })
  }

  /** Brings the device's own window up in Device Hub, where the person sees it live and taps. */
  async openInHub(udid: unknown): Promise<void> {
    const device = await this.device(udid)
    if (!this.hub || this.stopped) throw new AppError(503, 'simulator-unavailable', '这台电脑上没有 Device Hub')
    // The person is about to use it there, where Latch sees nothing: that counts as use now.
    this.touch(device.udid)
    const result = await this.hub(device.udid)
    if (result.code !== 0) throw this.failed(result)
  }

  async openUrl(udid: unknown, url: unknown): Promise<void> {
    const address = simulatorUrl(url)
    const device = await this.bootedDevice(udid)
    const result = await this.simctl(['openurl', device.udid, address], TIMEOUTS.action)
    if (result.code !== 0) throw this.failed(result)
  }

  async setAppearance(udid: unknown, appearance: unknown): Promise<void> {
    if (appearance !== 'light' && appearance !== 'dark') throw new AppError(400, 'invalid-input', '外观只能是浅色或深色')
    const device = await this.bootedDevice(udid)
    const result = await this.simctl(['ui', device.udid, 'appearance', appearance], TIMEOUTS.action)
    if (result.code !== 0) throw this.failed(result)
  }

  async appearance(udid: unknown): Promise<SimulatorAppearance | undefined> {
    const device = await this.bootedDevice(udid)
    const result = await this.simctl(['ui', device.udid, 'appearance'], TIMEOUTS.action)
    const text = result.stdout.toString('utf8').trim()
    return result.code === 0 && (text === 'light' || text === 'dark') ? text : undefined
  }

  /**
   * A picture of a running device's screen, at most 5 MiB: PNG for the session, JPEG for the panel's frames. A frame
   * also marks the device as the one the panel shows.
   */
  async picture(udid: unknown, kind: SimulatorPicture, options: { frame?: boolean } = {}): Promise<Buffer> {
    const device = await this.bootedDevice(udid)
    if (options.frame) {
      this.shownDevice = { udid: device.udid, at: this.now() }
      this.lastFrame.set(device.udid, this.now())
    }
    const key = `${device.udid}:${kind}`
    const pending = this.pictures.get(key)
    if (pending) return pending
    const taking = this.take(device.udid, kind).finally(() => this.pictures.delete(key))
    this.pictures.set(key, taking)
    return taking
  }

  private async take(udid: string, kind: SimulatorPicture): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), 'latch-sim-'))
    try {
      const file = join(dir, `screen.${kind === 'png' ? 'png' : 'jpg'}`)
      const result = await this.simctl(['io', udid, 'screenshot', `--type=${kind}`, file], TIMEOUTS.picture)
      if (result.code !== 0) throw this.failed(result)
      const handle = await open(file, 'r')
      try {
        const { size } = await handle.stat()
        if (size > PICTURE_LIMIT) throw new AppError(413, 'simulator-picture-too-large', '画面超过 5 MB')
        if (size === 0) throw new AppError(502, 'simulator-failed', '没有取到画面')
        const data = Buffer.alloc(size)
        await handle.read(data, 0, size, 0)
        return data
      } finally {
        await handle.close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  // ── Rotation: `devicectl device orientation`, which addresses a simulator by its UDID once it is running ──

  /** devicectl's orientation answer: its `result`, or undefined when it failed or did not say. */
  private async orientationCall(args: readonly string[]): Promise<SimulatorOrientation | undefined> {
    const result = await this.exec(this.devicectl, args, TIMEOUTS.action + 5_000, OUTPUT_LIMIT)
    if (result.code !== 0) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(result.stdout.toString('utf8'))
    } catch {
      return undefined
    }
    const answer = parsed && typeof parsed === 'object' ? Reflect.get(parsed, 'result') : undefined
    // `deviceOrientation` reads `unknown` on a fresh device; the non-flat one is what the screen follows.
    const value: unknown = answer && typeof answer === 'object' ? Reflect.get(answer, 'deviceOrientationNonFlat') : undefined
    return typeof value === 'string' && ORIENTATIONS.has(value as SimulatorOrientation) ? (value as SimulatorOrientation) : undefined
  }

  /**
   * Whether a running device can be rotated, and how it is turned. Asked each time (never kept as「no」): right after
   * a boot devicectl may not yet see the capability.
   */
  async orientation(udid: unknown): Promise<SimulatorOrientationView> {
    const device = await this.bootedDevice(udid)
    if (!this.devicectl) return { supported: false, orientation: null }
    const orientation = await this.orientationCall(['device', 'orientation', 'get', '--device', device.udid, '-t', '20', '-j', '-'])
    return { supported: orientation !== undefined, orientation: orientation ?? null }
  }

  /** A quarter turn; refused unless devicectl reads back a different orientation afterwards. */
  async rotate(udid: unknown, direction: unknown): Promise<SimulatorOrientation> {
    if (direction !== 'left' && direction !== 'right') throw new AppError(400, 'invalid-input', '只能向左或向右转')
    const device = await this.bootedDevice(udid)
    if (!this.devicectl) throw new AppError(409, 'simulator-rotate-unsupported', '这台设备不能旋转')
    return this.exclusive(device.udid, async () => {
      const before = await this.orientationCall(['device', 'orientation', 'get', '--device', device.udid, '-t', '20', '-j', '-'])
      if (!before) throw new AppError(409, 'simulator-rotate-unsupported', '这台设备不能旋转')
      const after = await this.orientationCall([
        'device',
        'orientation',
        'rotate',
        '--device',
        device.udid,
        direction,
        '-t',
        '20',
        '-j',
        '-',
      ])
      if (!after || after === before) throw new AppError(502, 'simulator-rotate-failed', '设备没有转动')
      return after
    })
  }

  // ── Apps: `listapps`, `launch`, `terminate`, `privacy`, each naming only an app the device lists ──

  /** The device's apps that are not hidden, the person's own first; kept five seconds. */
  async appList(udid: unknown): Promise<SimulatorAppView[]> {
    const device = await this.bootedDevice(udid)
    return (await this.listedApps(device.udid)).map(({ bundleId, name, kind }) => ({ bundleId, name, kind }))
  }

  private async listedApps(udid: string, options: { fresh?: boolean } = {}): Promise<ListedApp[]> {
    const kept = this.apps.get(udid)
    if (kept && !options.fresh && this.now() - kept.at < 5_000) return kept.apps
    const result = await this.simctl(['listapps', udid], TIMEOUTS.action, APPS_LIMIT)
    if (result.code !== 0) throw this.failed(result)
    const parsed = parseOldPlist(result.stdout.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AppError(502, 'simulator-failed', '没有读懂 App 列表')
    const apps: ListedApp[] = []
    for (const [bundleId, entry] of Object.entries(parsed)) {
      if (apps.length >= 500) break
      if (!isBundleId(bundleId) || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      if (entry.IsHidden === '1') continue
      const display = typeof entry.CFBundleDisplayName === 'string' ? entry.CFBundleDisplayName : entry.CFBundleName
      const executable =
        typeof entry.CFBundleExecutable === 'string' && PROCESS_NAME.test(entry.CFBundleExecutable) ? entry.CFBundleExecutable : undefined
      apps.push({
        bundleId,
        name: (typeof display === 'string' && display.trim() ? display : bundleId).slice(0, 80),
        kind: entry.ApplicationType === 'User' ? 'user' : 'system',
        ...(executable ? { executable } : {}),
      })
    }
    apps.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'user' ? -1 : 1))
    this.apps.set(udid, { at: this.now(), apps })
    return apps
  }

  /** The listed app with this bundle id: a form checked first, then the device's own list (read again if not there). */
  private async listedApp(udid: string, bundleId: unknown): Promise<ListedApp> {
    if (!isBundleId(bundleId)) throw new AppError(400, 'invalid-input', 'App 标识无效')
    const find = (apps: ListedApp[]) => apps.find(app => app.bundleId === bundleId)
    const app = find(await this.listedApps(udid)) ?? find(await this.listedApps(udid, { fresh: true }))
    if (!app) throw new AppError(404, 'simulator-app-not-found', '这台设备上没有这个 App')
    return app
  }

  /** Starts a listed app by its bundle id alone: no arguments, no console, no output files. */
  async launch(udid: unknown, bundleId: unknown): Promise<void> {
    const device = await this.bootedDevice(udid)
    const app = await this.listedApp(device.udid, bundleId)
    const result = await this.simctl(['launch', device.udid, app.bundleId], TIMEOUTS.action)
    if (result.code !== 0) throw this.failed(result)
  }

  async terminate(udid: unknown, bundleId: unknown): Promise<void> {
    const device = await this.bootedDevice(udid)
    const app = await this.listedApp(device.udid, bundleId)
    const result = await this.simctl(['terminate', device.udid, app.bundleId], TIMEOUTS.action)
    if (result.code !== 0) throw this.failed(result)
  }

  /** Grants, revokes or resets one service for one listed app. */
  async privacy(udid: unknown, action: unknown, service: unknown, bundleId: unknown): Promise<void> {
    if (!(SIMULATOR_PRIVACY_ACTIONS as readonly unknown[]).includes(action)) throw new AppError(400, 'invalid-input', '权限操作无效')
    if (!(SIMULATOR_PRIVACY_SERVICES as readonly unknown[]).includes(service)) throw new AppError(400, 'invalid-input', '权限无效')
    const device = await this.bootedDevice(udid)
    const app = await this.listedApp(device.udid, bundleId)
    const result = await this.simctl(
      ['privacy', device.udid, action as SimulatorPrivacyAction, service as SimulatorPrivacyService, app.bundleId],
      TIMEOUTS.action,
    )
    if (result.code !== 0) throw this.failed(result)
  }

  // ── New devices: `simctl create` from a listed device type and runtime ──

  /** The device types and the runtimes that can run now, with which types each takes; kept a minute. */
  async catalog(options: { fresh?: boolean } = {}): Promise<SimulatorCatalogView> {
    const kept = this.catalogCache
    if (kept && !options.fresh && this.now() - kept.at < 60_000) return kept.value
    const [types, runtimes] = [
      await this.simctl(['list', 'devicetypes', '--json'], TIMEOUTS.list, CATALOG_LIMIT),
      await this.simctl(['list', 'runtimes', '--json'], TIMEOUTS.list, CATALOG_LIMIT),
    ]
    const json = (result: SimctlResult, key: string): unknown[] => {
      if (result.code !== 0) throw this.failed(result)
      try {
        const value: unknown = Reflect.get(JSON.parse(result.stdout.toString('utf8')) as object, key)
        return Array.isArray(value) ? value.slice(0, 300) : []
      } catch {
        throw new AppError(502, 'simulator-failed', '没有读懂设备类型')
      }
    }
    const text = (entry: unknown, key: string): string | undefined => {
      const value: unknown = entry && typeof entry === 'object' ? Reflect.get(entry, key) : undefined
      return typeof value === 'string' ? value : undefined
    }
    const deviceTypes = json(types, 'devicetypes').flatMap(entry => {
      const id = text(entry, 'identifier')
      const name = text(entry, 'name')
      return id && SIMULATOR_TYPE_ID.test(id) && name
        ? [{ id, name: name.slice(0, 80), family: (text(entry, 'productFamily') ?? '').slice(0, 40) }]
        : []
    })
    const known = new Set(deviceTypes.map(type => type.id))
    const runtimeList = json(runtimes, 'runtimes').flatMap(entry => {
      const id = text(entry, 'identifier')
      const name = text(entry, 'name')
      if (!id || !SIMULATOR_RUNTIME_ID.test(id) || !name || Reflect.get(entry as object, 'isAvailable') !== true) return []
      const supported: unknown = Reflect.get(entry as object, 'supportedDeviceTypes')
      const ids = Array.isArray(supported) ? supported.map(type => text(type, 'identifier')).filter(type => type && known.has(type)) : []
      return [{ id, name: name.slice(0, 80), deviceTypes: ids as string[] }]
    })
    const value = { deviceTypes, runtimes: runtimeList }
    this.catalogCache = { at: this.now(), value }
    return value
  }

  /** Makes a device of a listed type and runtime with the person's name for it; its UDID. It is not started. */
  async create(name: unknown, deviceType: unknown, runtime: unknown): Promise<string> {
    const named = simulatorName(name)
    const { runtimes } = await this.catalog({ fresh: true })
    const found = runtimes.find(item => item.id === runtime)
    if (typeof deviceType !== 'string' || !found || !found.deviceTypes.includes(deviceType))
      throw new AppError(400, 'invalid-input', '这个系统版本不支持这种设备')
    const result = await this.simctl(['create', named, deviceType, found.id], TIMEOUTS.create)
    if (result.code !== 0) throw this.failed(result)
    const udid = result.stdout.toString('utf8').trim()
    if (!isSimulatorUdid(udid)) throw new AppError(502, 'simulator-failed', '没有得到新设备的标识')
    this.recent = undefined
    return udid
  }

  // ── Recording: `io recordVideo` to a private file, ended with SIGINT, handed over once and removed ──

  /** The recording of this device that the given device (of the person) started, if any. */
  recordingOf(udid: unknown, owner: string): SimulatorRecordingView {
    const recording = isSimulatorUdid(udid) ? this.recordings.get(udid) : undefined
    if (!recording || recording.owner !== owner) return { state: 'none' }
    return {
      state: recording.state === 'ready' ? 'ready' : 'recording',
      seconds: Math.round((this.now() - recording.started) / 1000),
      ...(recording.ended ? { ended: recording.ended } : {}),
    }
  }

  /**
   * Starts recording a running device, for at most a minute and the draft's 25 MB. It ends by itself at either bound,
   * and is thrown away when the panel stops asking for frames, the device shuts down or the Host stops.
   */
  async startRecording(udid: unknown, owner: string): Promise<SimulatorRecordingView> {
    const spawner = this.spawner
    if (!spawner || this.stopped) throw new AppError(503, 'simulator-unavailable', '这台电脑上不能录屏')
    const device = await this.bootedDevice(udid)
    if (this.stopped) throw new AppError(503, 'simulator-unavailable', '这台电脑上不能录屏')
    // Checked and taken in one step, before any await: two starts at once cannot both pass the bounds.
    if (this.recordings.has(device.udid) || this.recordingSlots.has(device.udid))
      throw new AppError(409, 'simulator-recording', '这台设备正在录屏')
    if (this.recordings.size + this.recordingSlots.size >= RECORDINGS_MAX)
      throw new AppError(429, 'simulator-recording', '同时最多录两台设备')
    this.recordingSlots.add(device.udid)
    let dir: string
    let child: SimctlChild
    let file: string
    try {
      dir = await mkdtemp(join(tmpdir(), 'latch-rec-'))
      file = join(dir, 'recording.mp4')
      if (this.stopped) {
        await rm(dir, { recursive: true, force: true })
        throw new AppError(503, 'simulator-unavailable', '这台电脑上不能录屏')
      }
      // Bounded even if this Host is gone: the spawner's watcher interrupts it half a minute past the time limit.
      child = spawner(['io', device.udid, 'recordVideo', '--codec=h264', '--force', file], {
        limitSeconds: Math.ceil(this.recordLimits.ms / 1000) + 30,
      })
    } finally {
      this.recordingSlots.delete(device.udid)
    }
    let errorText = ''
    const started = new Promise<boolean>(resolve => {
      child.onStderr(chunk => {
        if (errorText.length < 4096) errorText += chunk.toString('utf8')
        if (errorText.includes('Recording started')) resolve(true)
      })
      void child.exited.then(() => resolve(false))
      setTimeout(() => resolve(false), TIMEOUTS.action).unref()
    })
    child.onStdout(() => {})
    const recording: Recording = {
      udid: device.udid,
      owner,
      dir,
      file,
      child,
      started: this.now(),
      state: 'recording',
      exited: child.exited,
      timers: [],
    }
    this.recordings.set(device.udid, recording)
    if (!(await started) || this.recordings.get(device.udid) !== recording) {
      await this.discard(recording)
      throw this.failed({ code: -1, stdout: Buffer.alloc(0), stderr: errorText || '录屏没有开始' })
    }
    recording.started = this.now()
    recording.timers.push(setTimeout(() => void this.finish(recording, 'time'), this.recordLimits.ms))
    // The size, and the panel still asking for frames, checked every second.
    const watch = setInterval(() => {
      if (recording.state !== 'recording') return
      const framed = this.lastFrame.get(recording.udid)
      if (framed === undefined || this.now() - framed > RECORDING_ORPHAN_MS) {
        void this.discard(recording)
        return
      }
      void stat(recording.file).then(
        // Headroom for the movie's index, written as it ends.
        info =>
          info.size >= this.recordLimits.bytes - Math.min(1024 * 1024, this.recordLimits.bytes / 8) && void this.finish(recording, 'size'),
        () => undefined,
      )
    }, 1_000)
    recording.timers.push(watch)
    for (const timer of recording.timers) timer.unref?.()
    // Ended by simctl itself (the device went away): nothing to hand over.
    void child.exited.then(() => {
      if (recording.state === 'recording') void this.discard(recording)
    })
    return this.recordingOf(device.udid, owner)
  }

  /** SIGINT, so simctl writes the movie out; a child that does not exit in ten seconds is killed. */
  private finish(recording: Recording, ended?: 'time' | 'size'): Promise<void> {
    if (recording.state !== 'recording') return recording.finishing ?? Promise.resolve()
    recording.finishing = this.finishNow(recording, ended)
    return recording.finishing
  }

  private async finishNow(recording: Recording, ended?: 'time' | 'size'): Promise<void> {
    recording.state = 'stopping'
    if (ended) recording.ended = ended
    recording.child.interrupt()
    const code = await Promise.race([recording.exited, new Promise<number>(resolve => setTimeout(() => resolve(-2), 10_000).unref())])
    if (code === -2) recording.child.kill()
    if (this.recordings.get(recording.udid) !== recording) return
    if (code !== 0) {
      await this.discard(recording)
      return
    }
    recording.state = 'ready'
    for (const timer of recording.timers) clearTimeout(timer)
    recording.timers = [setTimeout(() => void this.discard(recording), RECORDING_KEPT_MS)]
    recording.timers[0]!.unref?.()
  }

  /**
   * Ends the child and removes the file and its directory. SIGINT, never SIGKILL first: a killed `recordVideo` leaves the
   * device's recorder busy until it reboots (checked on Xcode 27.2). As the Host stops, the directory goes at once,
   * without waiting for simctl to finish a movie no one will take; otherwise a child that ignores SIGINT for ten
   * seconds is killed as a last resort.
   */
  private async discard(recording: Recording, options: { stopping?: boolean } = {}): Promise<void> {
    if (this.recordings.get(recording.udid) === recording) this.recordings.delete(recording.udid)
    for (const timer of recording.timers) clearTimeout(timer)
    if (recording.state === 'recording' || recording.state === 'stopping') {
      recording.child.interrupt()
      if (!options.stopping) {
        const code = await Promise.race([recording.exited, new Promise<number>(resolve => setTimeout(() => resolve(-2), 10_000).unref())])
        if (code === -2) recording.child.kill()
      }
    }
    await rm(recording.dir, { recursive: true, force: true })
  }

  /** Stops the recording (if it still runs) and hands over the movie once; the file is removed as it is read. */
  async takeRecording(udid: unknown, owner: string): Promise<Buffer> {
    const recording = isSimulatorUdid(udid) ? this.recordings.get(udid) : undefined
    if (!recording || recording.owner !== owner) throw new AppError(404, 'simulator-no-recording', '没有录屏')
    await this.finish(recording)
    if (this.recordings.get(recording.udid) !== recording || recording.state !== 'ready')
      throw new AppError(502, 'simulator-failed', '录屏没有完成')
    this.recordings.delete(recording.udid)
    for (const timer of recording.timers) clearTimeout(timer)
    try {
      const handle = await open(recording.file, 'r')
      try {
        const { size } = await handle.stat()
        if (size > this.recordLimits.bytes) throw new AppError(413, 'simulator-recording-too-large', '录屏超过 25 MB')
        if (size === 0) throw new AppError(502, 'simulator-failed', '录屏是空的')
        const data = Buffer.alloc(size)
        await handle.read(data, 0, size, 0)
        return data
      } finally {
        await handle.close()
      }
    } finally {
      await rm(recording.dir, { recursive: true, force: true })
    }
  }

  /** Throws away the recording this device started, running or finished. */
  async discardRecording(udid: unknown, owner: string): Promise<boolean> {
    const recording = isSimulatorUdid(udid) ? this.recordings.get(udid) : undefined
    if (!recording || recording.owner !== owner) return false
    await this.discard(recording)
    return true
  }

  // ── Logs: `spawn <udid> log stream --style compact`, optionally one listed app's process, for the page alone ──

  /**
   * Streams a running device's log to `sink` until `close` is called, the device shuts down, the Host stops or `log`
   * exits. Lines come in batches; while the page is behind, lines are dropped and counted, never kept.
   */
  async logs(
    udid: unknown,
    bundleId: unknown,
    sink: SimulatorLogSink,
    signal?: AbortSignal,
  ): Promise<{ close: () => void; resume: () => void }> {
    const spawner = this.spawner
    if (!spawner || this.stopped) throw new AppError(503, 'simulator-unavailable', '这台电脑上不能看日志')
    const device = await this.bootedDevice(udid)
    let predicate: string[] = []
    if (bundleId !== undefined) {
      const app = await this.listedApp(device.udid, bundleId)
      if (!app.executable) throw new AppError(400, 'invalid-input', '这个 App 的进程名不能用来过滤')
      predicate = ['--predicate', `process == "${app.executable}"`]
    }
    // The page may have gone, or the Host begun to stop, while the device or its apps were read: then nothing starts.
    if (this.stopped) throw new AppError(503, 'simulator-unavailable', '这台电脑上不能看日志')
    if (signal?.aborted) throw new AppError(499, 'simulator-logs-gone', '日志窗口已关闭')
    const streams = [...this.logStreams]
    if (streams.filter(stream => stream.udid === device.udid).length >= LOGS_PER_DEVICE || streams.length >= LOGS_MAX)
      throw new AppError(429, 'simulator-logs-busy', '日志窗口开得太多了')
    const child = spawner(['spawn', device.udid, 'log', 'stream', '--style', 'compact', ...predicate], { limitSeconds: 0 })
    let partial = ''
    let batch: string[] = []
    let dropped = 0
    let ended = false
    /** The page has not taken the last batch yet. */
    let behind = false
    const flush = () => {
      if (ended) return
      if (dropped > 0) {
        sink.dropped(dropped)
        dropped = 0
      }
      if (batch.length === 0) return
      const lines = batch
      batch = []
      if (!sink.lines(lines)) behind = true
    }
    // Until the route's writes drain (`resume`), each line is counted, not kept.
    const timer = setInterval(flush, 200)
    timer.unref()
    child.onStdout(chunk => {
      if (ended) return
      partial += chunk.toString('utf8')
      const parts = partial.split('\n')
      partial = (parts.pop() ?? '').slice(0, SIMULATOR_LOG_LIMITS.lineChars * 4)
      for (const raw of parts) {
        const line = plainLine(raw)
        if (!line || LOG_PREAMBLE.test(line)) continue
        if (behind || batch.length >= SIMULATOR_LOG_LIMITS.lines) dropped++
        else batch.push(line)
      }
    })
    child.onStderr(() => {})
    const stream: LogStream = {
      udid: device.udid,
      child,
      close: reason => {
        if (ended) return
        flush()
        ended = true
        clearInterval(timer)
        this.logStreams.delete(stream)
        // SIGINT ends `log` inside the device; SIGKILL would leave a quiet one running there until the device shuts
        // down (checked on Xcode 27.2), so it is only the last resort for a child that ignored SIGINT for ten seconds.
        child.interrupt()
        const last = setTimeout(() => child.kill(), 10_000)
        last.unref()
        void child.exited.then(() => clearTimeout(last))
        sink.closed(reason)
      },
    }
    this.logStreams.add(stream)
    void child.exited.then(() => stream.close('exited'))
    return {
      close: () => stream.close('exited'),
      resume: () => {
        behind = false
      },
    }
  }
}
