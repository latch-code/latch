// This Mac's iOS simulators through Apple's public `xcrun simctl`, and nothing else: no private framework, no shell
// string, no download. Each call is a fixed argument list with a validated UDID, a timeout and a bound on what it may
// print. The Host shuts down only a device it booted itself, and leaves every device as it is when it stops. Pictures
// pass through a private temporary file (simctl will not write one to a pipe) that is read and removed at once; they are
// never logged or kept. See docs/DEVICE-PREVIEW.md.
import { execFile } from 'node:child_process'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
const TIMEOUTS = { list: 20_000, boot: 120_000, shutdown: 60_000, picture: 20_000, action: 20_000 } as const
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

export interface SimulatorOptions {
  /** Left out, as in tests that name no fake, nothing on this Mac is ever run and no device is offered. */
  run?: SimctlRunner
  /** Left out, 「在 Device Hub 中打开」 is refused. */
  openHub?: HubOpener
  now?: () => number
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
export const xcrunSimctl: SimctlRunner = (args, { timeoutMs, maxBytes, signal }) => {
  const env: Record<string, string> = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
  for (const key of ['HOME', 'TMPDIR', 'DEVELOPER_DIR', 'USER', 'LOGNAME'] as const) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  return runFixed('/usr/bin/xcrun', ['simctl', ...args], { timeoutMs, maxBytes, env, ...(signal ? { signal } : {}) })
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

export class Simulators {
  private readonly run: SimctlRunner | undefined
  private readonly hub: HubOpener | undefined
  private readonly now: () => number
  /** Devices this Host booted, and so may shut down. Dropped once a list shows one not running. */
  private readonly booted = new Set<string>()
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
  private count = 0
  private recent: { at: number; value: { xcode: boolean; devices: SimulatorDevice[] } } | undefined

  constructor(options: SimulatorOptions = {}) {
    this.run = options.run
    this.hub = options.openHub
    this.now = options.now ?? Date.now
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

  /** Every child still running ends; the devices stay as they are. */
  stop(): void {
    this.stopped = true
    for (const controller of this.running) controller.abort()
    this.running.clear()
    for (const start of this.queue.splice(0)) start()
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

  private async simctl(args: readonly string[], timeoutMs: number, maxBytes = OUTPUT_LIMIT): Promise<SimctlResult> {
    const run = this.run
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
    const result = await this.simctl(['list', 'devices', '--json', 'available'], TIMEOUTS.list, LIST_LIMIT)
    let parsed: unknown
    try {
      parsed = result.code === 0 ? JSON.parse(result.stdout.toString('utf8')) : undefined
    } catch {
      parsed = undefined
    }
    const groups = parsed && typeof parsed === 'object' ? Reflect.get(parsed, 'devices') : undefined
    if (!groups || typeof groups !== 'object') {
      this.xcode = false
      this.recent = undefined
      return { xcode: false, devices: [] }
    }
    this.xcode = true
    const devices: SimulatorDevice[] = []
    for (const [runtime, entries] of Object.entries(groups as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue
      for (const entry of entries.slice(0, 200)) {
        if (!entry || typeof entry !== 'object') continue
        const udid: unknown = Reflect.get(entry, 'udid')
        const name: unknown = Reflect.get(entry, 'name')
        if (!isSimulatorUdid(udid) || typeof name !== 'string' || Reflect.get(entry, 'isAvailable') === false) continue
        const state = stateOf(Reflect.get(entry, 'state'))
        if (state === 'shutdown') this.booted.delete(udid)
        devices.push({ udid, name: name.slice(0, 120), os: osOf(runtime), state, ours: this.booted.has(udid) })
      }
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

  private async bootedDevice(udid: unknown): Promise<SimulatorDevice> {
    const device = await this.device(udid)
    if (device.state !== 'booted') throw new AppError(409, 'simulator-not-booted', '设备未启动')
    return device
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
      // `boot` returns before the device has finished starting; `bootstatus` waits until it has (or its timeout ends).
      await this.simctl(['bootstatus', device.udid], TIMEOUTS.boot)
      this.recent = undefined
      return { ...device, state: 'booted' as const, ours: true }
    })
  }

  /** Shuts down only a device this Host booted. */
  async shutdown(udid: unknown): Promise<SimulatorDevice> {
    const device = await this.device(udid, { fresh: true })
    if (!this.booted.has(device.udid)) throw new AppError(409, 'simulator-not-ours', '只关闭 Latch 启动的设备')
    return this.exclusive(device.udid, async () => {
      const result = await this.simctl(['shutdown', device.udid], TIMEOUTS.shutdown)
      if (result.code !== 0) throw this.failed(result)
      this.booted.delete(device.udid)
      this.recent = undefined
      return { ...device, state: 'shutdown' as const, ours: false }
    })
  }

  /** Brings the device's own window up in Device Hub, where the person sees it live and taps. */
  async openInHub(udid: unknown): Promise<void> {
    const device = await this.device(udid)
    if (!this.hub || this.stopped) throw new AppError(503, 'simulator-unavailable', '这台电脑上没有 Device Hub')
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
    if (options.frame) this.shownDevice = { udid: device.udid, at: this.now() }
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
}
