// Input to this Mac's simulators through the person's idb_companion: the person's taps, drags, keys and buttons from
// the 设备 panel, and an agent's `device_*` input tools, on one path. Inputs to one device are serialised per gesture:
// an agent's gesture waits for the person's finger to lift and the other way round; nobody is locked out. A delivery
// that fails is an error, never a success. Text is not typed through the device keyboard (a Pinyin keyboard drops
// spaces, CJK has no key codes) and pasting text from outside the device arrives empty on iOS 27.2, so text input is
// reported unavailable. See docs/DEVICE-PREVIEW.md.
import {
  SIMULATOR_BUTTONS,
  SIMULATOR_KEYS,
  type SimulatorButton,
  type SimulatorControlView,
  type SimulatorInputEvent,
  type SimulatorInputKind,
  type SimulatorKey,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { z } from 'zod'
import { HidStream, IdbCompanion, IdbUnavailable, type IdbOptions } from './simulator-idb.ts'
import { IDB_KEYS, type HidEvent } from './simulator-idb-wire.ts'

/** How long one gesture waits for another's to end. */
const GESTURE_WAIT_MS = 10_000
/** Events per device per second, and the burst; a live drag sends about sixty a second. */
const RATE_PER_SECOND = 240
const RATE_BURST = 480
/** A companion nobody holds and no agent used this long is ended (it also exits by itself after two minutes). */
const IDLE_MS = 60_000
/** The longest an agent's long press or swipe may take. */
export const AGENT_GESTURE_MS = 5_000
const SWIPE_STEP_MS = 16

const udidField = z.string().regex(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/u)
const point = z.number().min(0).max(10_000)
const inputArgs = z.discriminatedUnion('tool', [
  z.strictObject({
    tool: z.literal('device_tap'),
    udid: udidField,
    x: point,
    y: point,
    holdMs: z.number().int().min(0).max(AGENT_GESTURE_MS).optional(),
  }),
  z.strictObject({
    tool: z.literal('device_swipe'),
    udid: udidField,
    fromX: point,
    fromY: point,
    toX: point,
    toY: point,
    durationMs: z.number().int().min(50).max(AGENT_GESTURE_MS).optional(),
  }),
  z.strictObject({ tool: z.literal('device_type_text'), udid: udidField, text: z.string().max(1000) }),
  z.strictObject({ tool: z.literal('device_press_key'), udid: udidField, key: z.enum(SIMULATOR_KEYS) }),
  z.strictObject({ tool: z.literal('device_press_button'), udid: udidField, button: z.enum(SIMULATOR_BUTTONS) }),
])
export type DeviceInputArgs = z.infer<typeof inputArgs>

/** An agent's input call, checked; undefined for anything malformed. */
export function parseDeviceInput(tool: string, args: Record<string, unknown>): DeviceInputArgs | undefined {
  const parsed = inputArgs.safeParse({ ...args, tool })
  return parsed.success ? parsed.data : undefined
}

/** What the audit keeps of an input call: counts and enums, never where, never the text. */
export function deviceInputFacts(args: DeviceInputArgs): {
  points?: number
  held?: boolean
  textLength?: number
  key?: SimulatorKey
  button?: SimulatorButton
} {
  if (args.tool === 'device_tap') return { points: 1, held: (args.holdMs ?? 0) > 500 }
  if (args.tool === 'device_swipe') return { points: 2 }
  if (args.tool === 'device_type_text') return { textLength: args.text.length }
  if (args.tool === 'device_press_key') return { key: args.key }
  return { button: args.button }
}

const NOT_TEXT: SimulatorInputKind = { available: false, reason: 'paste-refused' }
const NOT_TWO: SimulatorInputKind = { available: false, reason: 'single-touch' }

export function unavailableView(reason: Extract<SimulatorInputKind, { available: false }>['reason']): SimulatorControlView {
  const kind: SimulatorInputKind = { available: false, reason }
  return { touch: kind, keys: kind, buttons: kind, text: NOT_TEXT, twoFingers: NOT_TWO }
}
const READY: SimulatorControlView = {
  touch: { available: true },
  keys: { available: true },
  buttons: { available: true },
  text: NOT_TEXT,
  twoFingers: NOT_TWO,
}

type Owner = 'person' | 'agent'

class Device {
  readonly udid: string
  companion: IdbCompanion | undefined
  starting: Promise<IdbCompanion> | undefined
  /** The screen in points, portrait. */
  size: { width: number; height: number } | undefined
  /** The devices (of people) that took control of it. */
  readonly holders = new Set<string>()
  /** The person's long-lived stream, shared by every holder. */
  person: HidStream | undefined
  /** Whose gesture holds the device now, and who waits. */
  owner: Owner | undefined
  readonly waiting: Array<{ owner: Owner; grant: () => void }> = []
  /** Where the person's finger is down, if it is. */
  down: { x: number; y: number } | undefined
  /** Agent calls under way. */
  agents = 0
  lastUsed = 0
  tokens = RATE_BURST
  refilled = 0
  view: SimulatorControlView | undefined

  constructor(udid: string) {
    this.udid = udid
  }
}

export interface SimulatorControlOptions {
  /** How idb_companion is found and started; left out (tests, not macOS) there is no input at all. */
  idb?: IdbOptions
  now?: () => number
}

export class SimulatorControl {
  private readonly devices = new Map<string, Device>()
  private readonly idb: IdbOptions | undefined
  private readonly now: () => number
  private stopped = false
  private readonly timer: ReturnType<typeof setInterval>

  constructor(options: SimulatorControlOptions = {}) {
    this.idb = options.idb
    this.now = options.now ?? Date.now
    this.timer = setInterval(() => this.sweep(), 15_000)
    this.timer.unref()
  }

  /** Whether this Host may look for idb at all. */
  get offered(): boolean {
    return this.idb !== undefined
  }

  /** The device's input as last probed, without starting anything. */
  viewOf(udid: string): SimulatorControlView {
    if (!this.idb) return unavailableView('unsupported')
    return this.devices.get(udid)?.view ?? unavailableView('companion-failed')
  }

  /** Whether `holder` already controls the device. */
  holds(udid: string, holder: string): boolean {
    return this.devices.get(udid)?.holders.has(holder) === true
  }

  /**
   * The person (`holder`, their device's ID) takes control: the companion is started if needed and probed with a
   * harmless call, and the person's stream opened. Answers what each kind of input can do; never throws for idb itself.
   */
  async take(udid: string, holder: string): Promise<SimulatorControlView> {
    if (!this.idb || this.stopped) return unavailableView('unsupported')
    const device = this.device(udid)
    try {
      await this.companionOf(device)
      if (!device.person?.open) device.person = device.companion!.hid()
      device.holders.add(holder)
      device.lastUsed = this.now()
      device.view = READY
    } catch (error) {
      device.view = unavailableView(error instanceof IdbUnavailable ? error.reason : 'companion-failed')
    }
    return device.view
  }

  /** The person lets go: a finger still down is lifted; the companion ends once nobody holds or uses it. */
  async release(udid: string, holder: string): Promise<void> {
    const device = this.devices.get(udid)
    if (!device || !device.holders.delete(holder)) return
    if (device.holders.size > 0) return
    await this.liftPerson(device)
    const stream = device.person
    device.person = undefined
    await stream?.end().catch(() => stream.cancel())
    if (device.agents === 0) await this.end(device)
  }

  /** The person's events, in order. Fails, and says so, when they did not reach the companion. */
  async input(udid: string, holder: string, events: readonly SimulatorInputEvent[]): Promise<void> {
    const device = this.devices.get(udid)
    if (!device?.holders.has(holder)) throw new AppError(409, 'simulator-control-required', '先在面板里接管这台设备')
    this.spend(device, events.length)
    if (!device.companion?.alive || !device.size) {
      device.view = unavailableView('companion-failed')
      throw new IdbUnavailable('companion-failed', 'idb_companion 已退出')
    }
    for (const event of events) if (event.type === 'touch') this.checkPoint(device, event.x, event.y)
    device.lastUsed = this.now()
    for (const event of events) await this.personEvent(device, event)
  }

  // ── An agent's discrete actions: one short stream each, answered only once the companion said status 0 ──

  async tap(udid: string, x: number, y: number, holdMs = 0): Promise<void> {
    await this.agent(udid, async (device, stream) => {
      this.checkPoint(device, x, y)
      stream.write([{ kind: 'touch', x, y, direction: 'down' }])
      await pause(Math.min(AGENT_GESTURE_MS, Math.max(30, holdMs)))
      stream.write([{ kind: 'touch', x, y, direction: 'up' }])
    })
  }

  async swipe(udid: string, from: { x: number; y: number }, to: { x: number; y: number }, durationMs = 300): Promise<void> {
    await this.agent(udid, async (device, stream) => {
      this.checkPoint(device, from.x, from.y)
      this.checkPoint(device, to.x, to.y)
      const duration = Math.min(AGENT_GESTURE_MS, Math.max(50, durationMs))
      const steps = Math.max(2, Math.round(duration / SWIPE_STEP_MS))
      stream.write([{ kind: 'touch', x: from.x, y: from.y, direction: 'down' }])
      for (let step = 1; step <= steps; step++) {
        await pause(SWIPE_STEP_MS)
        const at = step / steps
        stream.write([{ kind: 'touch', x: from.x + (to.x - from.x) * at, y: from.y + (to.y - from.y) * at, direction: 'down' }])
      }
      stream.write([{ kind: 'touch', x: to.x, y: to.y, direction: 'up' }])
    })
  }

  async key(udid: string, key: SimulatorKey): Promise<void> {
    await this.agent(udid, async (_device, stream) => stream.write(keyPress(key)))
  }

  async button(udid: string, button: SimulatorButton): Promise<void> {
    await this.agent(udid, async (_device, stream) => stream.write(buttonPress(button)))
  }

  /** The device shut down or went away: everything on it ends. */
  deviceEnded(udid: string): void {
    const device = this.devices.get(udid)
    if (!device) return
    this.devices.delete(udid)
    device.person?.cancel()
    for (const waiter of device.waiting.splice(0)) waiter.grant()
    void this.end(device)
  }

  /** As the Host stops: fingers are lifted where a stream is still open, and every companion ends. */
  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    const devices = [...this.devices.values()]
    this.devices.clear()
    await Promise.allSettled(
      devices.map(async device => {
        await this.liftPerson(device).catch(() => undefined)
        device.person?.cancel()
        await this.end(device)
      }),
    )
  }

  private device(udid: string): Device {
    let device = this.devices.get(udid)
    if (!device) {
      device = new Device(udid)
      this.devices.set(udid, device)
    }
    return device
  }

  private async companionOf(device: Device): Promise<IdbCompanion> {
    if (device.companion?.alive && device.size) return device.companion
    if (device.starting) return device.starting
    device.starting = (async () => {
      const previous = device.companion
      device.companion = undefined
      device.person = undefined
      await previous?.close().catch(() => undefined)
      const companion = await IdbCompanion.start(device.udid, this.idb)
      if (this.stopped || this.devices.get(device.udid) !== device) {
        await companion.close()
        throw new IdbUnavailable('companion-failed', 'idb_companion 已停止')
      }
      try {
        device.size = await companion.describe()
      } catch (error) {
        await companion.close()
        throw error
      }
      device.companion = companion
      companion.onExit(() => {
        if (device.companion !== companion) return
        device.companion = undefined
        device.person = undefined
        device.down = undefined
        device.view = unavailableView('companion-failed')
      })
      return companion
    })().finally(() => {
      device.starting = undefined
    })
    return device.starting
  }

  /** Every point is checked against the screen, upright or turned. */
  private checkPoint(device: Device, x: number, y: number): void {
    const size = device.size
    const inside = (width: number, height: number) => x >= 0 && y >= 0 && x <= width && y <= height
    if (!size || !Number.isFinite(x) || !Number.isFinite(y) || !(inside(size.width, size.height) || inside(size.height, size.width)))
      throw new AppError(400, 'invalid-input', '坐标不在屏幕内')
  }

  private spend(device: Device, count: number): void {
    const now = this.now()
    device.tokens = Math.min(RATE_BURST, device.tokens + ((now - device.refilled) / 1000) * RATE_PER_SECOND)
    device.refilled = now
    if (device.tokens < count) throw new AppError(429, 'simulator-input-rate', '输入太快了')
    device.tokens -= count
  }

  private async personEvent(device: Device, event: SimulatorInputEvent): Promise<void> {
    if (event.type === 'touch') {
      if (event.phase === 'down' || (event.phase === 'move' && device.down)) {
        if (!device.down) await this.acquire(device, 'person')
        this.personWrite(device, [{ kind: 'touch', x: event.x, y: event.y, direction: 'down' }])
        device.down = { x: event.x, y: event.y }
        return
      }
      if (event.phase === 'up' && device.down) {
        device.down = undefined
        try {
          this.personWrite(device, [{ kind: 'touch', x: event.x, y: event.y, direction: 'up' }])
        } finally {
          this.releaseOwner(device, 'person')
        }
      }
      // A move or an up without a finger down (it was already lifted) changes nothing.
      return
    }
    const presses = event.type === 'key' ? keyPress(event.key) : buttonPress(event.button)
    if (device.down) {
      this.personWrite(device, presses)
      return
    }
    await this.acquire(device, 'person')
    try {
      this.personWrite(device, presses)
    } finally {
      this.releaseOwner(device, 'person')
    }
  }

  private personWrite(device: Device, events: HidEvent[]): void {
    if (!device.person?.open) {
      if (!device.companion?.alive) throw new IdbUnavailable('companion-failed', 'idb_companion 已退出')
      device.person = device.companion.hid()
    }
    try {
      device.person.write(events)
    } catch {
      device.person = undefined
      throw new AppError(502, 'simulator-input-failed', '输入没有送到设备')
    }
  }

  private async liftPerson(device: Device): Promise<void> {
    const down = device.down
    if (!down) return
    device.down = undefined
    try {
      device.person?.write([{ kind: 'touch', x: down.x, y: down.y, direction: 'up' }])
    } finally {
      this.releaseOwner(device, 'person')
    }
  }

  private async agent(udid: string, act: (device: Device, stream: HidStream) => Promise<void>): Promise<void> {
    if (!this.idb || this.stopped) throw new IdbUnavailable('unsupported', '这台电脑上不能向模拟器输入')
    const device = this.device(udid)
    device.agents++
    try {
      const companion = await this.companionOf(device)
      device.view ??= READY
      this.spend(device, 1)
      await this.acquire(device, 'agent')
      try {
        const stream = companion.hid()
        try {
          await act(device, stream)
        } catch (error) {
          stream.cancel()
          throw error
        }
        try {
          await stream.end()
        } catch {
          throw new AppError(502, 'simulator-input-failed', '输入没有送到设备')
        }
      } finally {
        this.releaseOwner(device, 'agent')
      }
    } finally {
      device.agents--
      device.lastUsed = this.now()
    }
  }

  /** Waits until no other gesture holds the device; at most ten seconds. */
  private acquire(device: Device, owner: Owner): Promise<void> {
    if (device.owner === undefined) {
      device.owner = owner
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const entry = {
        owner,
        grant: () => {
          clearTimeout(timer)
          device.owner = owner
          resolve()
        },
      }
      const timer = setTimeout(() => {
        const index = device.waiting.indexOf(entry)
        if (index >= 0) device.waiting.splice(index, 1)
        reject(new AppError(409, 'simulator-busy', '设备上正有另一个手势'))
      }, GESTURE_WAIT_MS)
      device.waiting.push(entry)
    })
  }

  private releaseOwner(device: Device, owner: Owner): void {
    if (device.owner !== owner) return
    device.owner = undefined
    device.waiting.shift()?.grant()
  }

  private async end(device: Device): Promise<void> {
    const companion = device.companion
    device.companion = undefined
    device.person = undefined
    device.size = undefined
    if (this.devices.get(device.udid) === device && device.holders.size === 0) this.devices.delete(device.udid)
    await companion?.close().catch(() => undefined)
  }

  /** Companions nobody holds and no agent used for a minute end. */
  private sweep(): void {
    const now = this.now()
    for (const device of this.devices.values())
      if (device.holders.size === 0 && device.agents === 0 && now - device.lastUsed >= IDLE_MS) void this.end(device)
  }
}

function keyPress(key: SimulatorKey): HidEvent[] {
  const code = IDB_KEYS[key]
  return [
    { kind: 'key', code, direction: 'down' },
    { kind: 'key', code, direction: 'up' },
  ]
}

function buttonPress(button: SimulatorButton): HidEvent[] {
  return [
    { kind: 'button', button, direction: 'down' },
    { kind: 'button', button, direction: 'up' },
  ]
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
