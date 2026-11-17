// Input to this Mac's simulators through the person's idb_companion: the person's taps, drags, keys and buttons from
// the 设备 panel, and an agent's `device_*` input tools, on one path. Inputs to one device are serialised per gesture:
// an agent waits for the person's finger to lift, and yields to a person who presses. Input failure is reported.
// Printable ASCII is typed key by key on the device's English (US) keyboard. See docs/DEVICE-PREVIEW.md.
import {
  SIMULATOR_BUTTONS,
  SIMULATOR_KEYS,
  type SimulatorButton,
  type SimulatorControlView,
  type SimulatorInputEvent,
  type SimulatorInputKind,
  type SimulatorInputOwner,
  type SimulatorInputReceipt,
  type SimulatorKey,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { z } from 'zod'
import { HidStream, IdbCompanion, IdbUnavailable, waitForIdb, type IdbOptions } from './simulator-idb.ts'
import { IDB_KEYS, asciiKeys, type HidEvent } from './simulator-idb-wire.ts'

/** How long one gesture waits for another's to end. */
const GESTURE_WAIT_MS = 10_000
/** Events per device per second, and the burst; a live drag sends about sixty a second. */
const RATE_PER_SECOND = 240
const RATE_BURST = 480
/** A companion nobody holds and no agent used this long is ended (it also exits by itself after two minutes). */
const IDLE_MS = 60_000
/** A person's control lapses after this long without input (a window closed without letting go); the page takes it again. */
const HOLD_MS = 120_000
/** A finger with no event this long is lifted, so a lost lift never holds the device. */
const FINGER_MS = 10_000
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

/** Input details recorded for audit are point or character counts. */
export function deviceInputFacts(args: DeviceInputArgs): { points?: number; textLength?: number } {
  if (args.tool === 'device_tap') return { points: 1 }
  if (args.tool === 'device_swipe') return { points: 2 }
  if (args.tool === 'device_type_text') return { textLength: args.text.length }
  return {}
}

const NOT_TWO: SimulatorInputKind = { available: false, reason: 'single-touch' }

export function unavailableView(reason: Extract<SimulatorInputKind, { available: false }>['reason']): SimulatorControlView {
  const kind: SimulatorInputKind = { available: false, reason }
  return { touch: kind, keys: kind, buttons: kind, text: kind, twoFingers: NOT_TWO }
}

/**
 * The only keyboard text is typed on: English (US) QWERTY, with the hardware layout automatic or US. HID keys are
 * positions, so on another layout they mean other characters, and Pinyin composes them (spaces vanish, checked).
 */
const LATIN_KEYBOARD = /^en_US@sw=QWERTY(?:;hw=(?:Automatic|US))?$/u
/** How long a person's typing trusts one reading of the keyboard; an agent's call always reads it again. */
const KEYBOARD_FRESH_MS = 1_000

/** Text refused: a keyboard that would change it, or one not known yet. Never typed in part. */
function textRefusal(keyboard: string | undefined): AppError {
  if (keyboard === undefined)
    return new AppError(
      409,
      'simulator-text-unavailable',
      '还不知道设备用的是哪个键盘：先在设备上点输入框，让键盘出现一次（文字只在 English (US) 键盘上逐键输入）',
    )
  return new AppError(
    409,
    'simulator-text-unavailable',
    `设备当前的键盘是 ${keyboard.split('@')[0]}，逐键输入会被它改写；请在设备上切到 English (US) 键盘，中文请在 Device Hub 里输入`,
  )
}

type Owner = 'person' | 'agent'

class Device {
  readonly udid: string
  companion: IdbCompanion | undefined
  starting: { abort: AbortController; result: Promise<IdbCompanion> } | undefined
  /** The screen in points, portrait. */
  size: { width: number; height: number } | undefined
  /** The devices (of people) that took control of it, and when each last sent input. */
  readonly holders = new Map<string, number>()
  /** A release invalidates every take already issued by that holder. */
  readonly takes = new Map<string, { pending: number }>()
  /** The person's long-lived stream, shared by every holder. */
  person: HidStream | undefined
  /** Whose gesture holds the device now, and who waits. */
  owner: Owner | undefined
  readonly waiting: Array<{ owner: Owner; grant: () => void }> = []
  /** Where the person's finger is down and the window whose touch last wrote that position. */
  down: { x: number; y: number; holder: string } | undefined
  downAt = 0
  /** Agent calls under way, and the gesture of the one holding the device, which the person's press stops. */
  agents = 0
  agentGesture: AbortController | undefined
  /** The keyboard last read for the person's typing. */
  keyboard: { at: number; value: string | undefined } | undefined
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
  /** The device's active keyboard (`Simulators.activeKeyboard`); left out, text is unavailable. */
  keyboard?: (udid: string, signal?: AbortSignal) => Promise<string | undefined>
  now?: () => number
}

export class SimulatorControl {
  private readonly devices = new Map<string, Device>()
  private readonly endings = new Map<string, Promise<unknown>>()
  private readonly watchers = new Map<string, Set<() => void>>()
  private readonly idb: IdbOptions | undefined
  private readonly now: () => number
  private stopped = false
  private readonly timer: ReturnType<typeof setInterval>

  private readonly keyboard: SimulatorControlOptions['keyboard']

  constructor(options: SimulatorControlOptions = {}) {
    this.idb = options.idb
    this.keyboard = options.keyboard
    this.now = options.now ?? Date.now
    this.timer = setInterval(() => void this.sweep(), 5_000)
    this.timer.unref()
  }

  /** Touch, keys and buttons; text when the keyboard can be read (each call then checks it is English (US)). */
  private ready(): SimulatorControlView {
    return {
      touch: { available: true },
      keys: { available: true },
      buttons: { available: true },
      text: this.keyboard ? { available: true } : { available: false, reason: 'unsupported' },
      twoFingers: NOT_TWO,
    }
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

  ownerOf(udid: string, viewer: string): SimulatorInputOwner {
    const device = this.devices.get(udid)
    if (device?.owner === 'agent') return 'agent'
    if (!device?.companion?.alive || device.holders.size === 0) return 'none'
    if (device.down) return device.down.holder === viewer ? 'you' : 'other'
    return device.holders.has(viewer) ? 'you' : 'other'
  }

  /** The current ownership and changes, projected for this panel without any other device or session IDs. */
  watchOwner(udid: string, viewer: string, publish: (owner: SimulatorInputOwner) => void): () => void {
    const watchers = this.watchers.get(udid) ?? new Set<() => void>()
    this.watchers.set(udid, watchers)
    let last: SimulatorInputOwner | undefined
    const update = () => {
      const owner = this.ownerOf(udid, viewer)
      if (owner === last) return
      last = owner
      publish(owner)
    }
    watchers.add(update)
    update()
    return () => {
      watchers.delete(update)
      if (watchers.size === 0) this.watchers.delete(udid)
    }
  }

  private ownerChanged(udid: string): void {
    for (const update of this.watchers.get(udid) ?? []) update()
  }

  /**
   * The person (`holder`, their device's ID) takes control: the companion is started if needed and probed with a
   * harmless call. A stream is opened on the next input. Answers what each kind of input can do.
   */
  async take(udid: string, holder: string, authorize?: () => void, beforeStart?: () => Promise<void>): Promise<SimulatorControlView> {
    if (!this.idb || this.stopped) return unavailableView('unsupported')
    authorize?.()
    const device = this.device(udid)
    const take = device.takes.get(holder) ?? { pending: 0 }
    take.pending++
    device.takes.set(holder, take)
    device.lastUsed = this.now()
    const check = () => {
      authorize?.()
      if (this.devices.get(udid) !== device || device.takes.get(holder) !== take)
        throw new AppError(409, 'simulator-control-required', '接管请求已经结束，请在面板里重新接管这台设备')
    }
    try {
      if (beforeStart) await beforeStart()
      check()
      const view = await this.companionOf(device).then(
        () => this.ready(),
        error => unavailableView(error instanceof IdbUnavailable ? error.reason : 'companion-failed'),
      )
      check()
      if (view.touch.available) {
        device.holders.set(holder, this.now())
        device.lastUsed = this.now()
      }
      device.view = view
      this.ownerChanged(udid)
      return device.view
    } finally {
      take.pending--
      if (take.pending === 0 && device.takes.get(holder) === take) device.takes.delete(holder)
      // An authority check can fail after the companion has already answered.
      if (device.companion && this.devices.get(udid) === device && !this.inUse(device)) await this.end(device)
    }
  }

  /** The person lets go: a finger still down is lifted; the companion ends once nobody holds or uses it. */
  async release(udid: string, holder: string): Promise<void> {
    const device = this.devices.get(udid)
    if (!device) return
    const taking = device.takes.delete(holder)
    const held = device.holders.delete(holder)
    if (!taking && !held) return
    if (!held) {
      if (!this.inUse(device)) await this.end(device)
      return
    }
    if (device.down?.holder === holder || device.holders.size === 0) await this.liftPerson(device).catch(() => undefined)
    this.ownerChanged(udid)
    if (device.holders.size > 0) return
    const stream = device.person
    device.person = undefined
    await stream?.end().catch(() => stream.cancelAndWait())
    if (this.devices.get(udid) === device && !this.inUse(device)) await this.end(device)
  }

  releaseDisallowedHolders(allowed: (holder: string) => boolean): void {
    for (const device of this.devices.values())
      for (const holder of new Set([...device.holders.keys(), ...device.takes.keys()]))
        if (!allowed(holder)) void this.release(device.udid, holder).catch(() => undefined)
  }

  /** The person's events, in order. Fails, and says so, when they did not reach the companion. */
  async input(
    udid: string,
    holder: string,
    events: readonly SimulatorInputEvent[],
    authorize?: () => void,
  ): Promise<SimulatorInputReceipt> {
    const device = this.devices.get(udid)
    if (!device?.holders.has(holder)) throw new AppError(409, 'simulator-control-required', '先在面板里接管这台设备')
    const allowed = () => {
      authorize?.()
      if (!device.holders.has(holder) || this.devices.get(udid) !== device)
        throw new AppError(409, 'simulator-control-required', '先在面板里接管这台设备')
    }
    this.spend(device, events.length)
    if (!device.companion?.alive || !device.size) {
      device.view = unavailableView('companion-failed')
      throw new IdbUnavailable('companion-failed', 'idb_companion 已退出')
    }
    for (const event of events) if (event.type === 'touch') this.checkPoint(device, event.x, event.y)
    device.lastUsed = this.now()
    device.holders.set(holder, this.now())
    const receipt: SimulatorInputReceipt = { written: 0 }
    for (const [index, event] of events.entries()) {
      if (!(await this.personEvent(device, holder, event, allowed))) continue
      receipt.written++
      if (event.type === 'touch') receipt.touchIndex = index
    }
    return receipt
  }

  // ── An agent's discrete actions: one short stream each, answered only once the companion said status 0 ──

  async tap(udid: string, x: number, y: number, holdMs = 0, signal?: AbortSignal): Promise<void> {
    await this.agent(udid, signal, async (device, stream, gesture) => {
      this.checkPoint(device, x, y)
      stream.write([{ kind: 'touch', x, y, direction: 'down' }])
      await pause(Math.min(AGENT_GESTURE_MS, Math.max(30, holdMs)), gesture)
      stream.write([{ kind: 'touch', x, y, direction: 'up' }])
    })
  }

  async swipe(
    udid: string,
    from: { x: number; y: number },
    to: { x: number; y: number },
    durationMs = 300,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.agent(udid, signal, async (device, stream, gesture) => {
      this.checkPoint(device, from.x, from.y)
      this.checkPoint(device, to.x, to.y)
      const duration = Math.min(AGENT_GESTURE_MS, Math.max(50, durationMs))
      const steps = Math.max(2, Math.round(duration / SWIPE_STEP_MS))
      stream.write([{ kind: 'touch', x: from.x, y: from.y, direction: 'down' }])
      for (let step = 1; step <= steps; step++) {
        await pause(SWIPE_STEP_MS, gesture)
        const at = step / steps
        stream.write([{ kind: 'touch', x: from.x + (to.x - from.x) * at, y: from.y + (to.y - from.y) * at, direction: 'down' }])
      }
      stream.write([{ kind: 'touch', x: to.x, y: to.y, direction: 'up' }])
    })
  }

  /** Printable ASCII, key by key, only on the English (US) QWERTY keyboard; anything else is refused whole. */
  async typeText(udid: string, text: string, signal?: AbortSignal): Promise<void> {
    await this.agent(udid, signal, async (device, stream, gesture) => {
      const keys = await this.textKeys(device, text, false, gesture)
      gesture.throwIfAborted()
      stream.write(keys)
    })
  }

  /** The key presses for `text`, after checking every character and the device's keyboard. */
  private async textKeys(device: Device, text: string, person: boolean, signal?: AbortSignal): Promise<HidEvent[]> {
    const keys = asciiKeys(text)
    if (!keys)
      throw new AppError(
        400,
        'simulator-text-unsupported',
        '只能逐键输入可打印的 ASCII 字符（字母、数字、常用标点与空格）；中文等请在 Device Hub 里输入',
      )
    if (!this.keyboard) throw new IdbUnavailable('unsupported', '这台电脑上不能向模拟器输入文字')
    const now = this.now()
    let keyboard = person && device.keyboard && now - device.keyboard.at < KEYBOARD_FRESH_MS ? device.keyboard.value : undefined
    if (keyboard === undefined) {
      keyboard = await this.keyboard(device.udid, signal)
      device.keyboard = { at: this.now(), value: keyboard }
    }
    if (!keyboard || !LATIN_KEYBOARD.test(keyboard)) throw textRefusal(keyboard)
    return keys
  }

  async key(udid: string, key: SimulatorKey, signal?: AbortSignal): Promise<void> {
    await this.agent(udid, signal, async (_device, stream) => stream.write(keyPress(key)))
  }

  async button(udid: string, button: SimulatorButton, signal?: AbortSignal): Promise<void> {
    await this.agent(udid, signal, async (_device, stream) => stream.write(buttonPress(button)))
  }

  /**
   * The device's display changed (it turned). idb_companion ends an open hid stream then without telling the client
   * (checked on iOS 27.2:「Simulator display changed during the operation」), so the person's stream is dropped and a
   * new one opened with the next input; a finger that was down is forgotten, as the device has.
   */
  displayChanged(udid: string): void {
    const device = this.devices.get(udid)
    if (!device) return
    device.person?.cancel()
    device.person = undefined
    if (device.down) {
      device.down = undefined
      this.releaseOwner(device, 'person')
    }
  }

  /** The device shut down or went away: everything on it ends. */
  deviceEnded(udid: string): void {
    const device = this.devices.get(udid)
    if (!device) return
    this.devices.delete(udid)
    this.ownerChanged(udid)
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
    for (const device of devices) this.ownerChanged(device.udid)
    await Promise.allSettled([
      ...this.endings.values(),
      ...devices.map(async device => {
        await this.liftPerson(device).catch(() => undefined)
        device.person?.cancel()
        await this.end(device)
      }),
    ])
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
    if (device.starting) return device.starting.result
    const abort = new AbortController()
    const { signal } = abort
    const result = (async () => {
      await this.endings.get(device.udid)
      signal.throwIfAborted()
      const previous = device.companion
      device.companion = undefined
      device.person = undefined
      await previous?.close().catch(() => undefined)
      const companion = await IdbCompanion.start(device.udid, this.idb, signal)
      try {
        device.size = await companion.describe(undefined, signal)
        signal.throwIfAborted()
        if (this.stopped || this.devices.get(device.udid) !== device) throw new IdbUnavailable('companion-failed', 'idb_companion 已停止')
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
        this.releaseOwner(device, 'person')
        this.ownerChanged(device.udid)
      })
      return companion
    })().finally(() => {
      device.starting = undefined
    })
    device.starting = { abort, result }
    return result
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

  private async personEvent(device: Device, holder: string, event: SimulatorInputEvent, authorize: () => void): Promise<boolean> {
    if (event.type === 'touch') {
      if (event.phase === 'down' || (event.phase === 'move' && device.down)) {
        const previous = device.down
        if (!previous) await this.acquire(device, 'person')
        try {
          authorize()
          this.personWrite(device, [{ kind: 'touch', x: event.x, y: event.y, direction: 'down' }])
        } catch (error) {
          if (!previous) this.releaseOwner(device, 'person')
          throw error
        }
        device.down = { x: event.x, y: event.y, holder }
        device.downAt = this.now()
        if (previous?.holder !== holder) this.ownerChanged(device.udid)
        return true
      }
      if (event.phase === 'up' && device.down) {
        authorize()
        device.down = undefined
        try {
          this.personWrite(device, [{ kind: 'touch', x: event.x, y: event.y, direction: 'up' }])
        } finally {
          this.releaseOwner(device, 'person')
        }
        return true
      }
      // A move or an up without a finger down (it was already lifted) changes nothing.
      return false
    }
    const presses =
      event.type === 'key'
        ? keyPress(event.key)
        : event.type === 'button'
          ? buttonPress(event.button)
          : await this.textKeys(device, event.text, true)
    if (device.down) {
      authorize()
      this.personWrite(device, presses)
      return true
    }
    await this.acquire(device, 'person')
    try {
      authorize()
      this.personWrite(device, presses)
    } finally {
      this.releaseOwner(device, 'person')
    }
    return true
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
      device.down = undefined
      this.releaseOwner(device, 'person')
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

  /**
   * One agent gesture. It stops (the finger lifted by cancelling its stream) when the turn is aborted or the person
   * presses: the person always wins, and that call answers `simulator-input-failed`.
   */
  private async agent(
    udid: string,
    signal: AbortSignal | undefined,
    act: (device: Device, stream: HidStream, gesture: AbortSignal) => Promise<void>,
  ): Promise<void> {
    if (!this.idb || this.stopped) throw new IdbUnavailable('unsupported', '这台电脑上不能向模拟器输入')
    if (signal?.aborted) throw new AppError(499, 'cancelled', '调用已取消')
    const device = this.device(udid)
    device.lastUsed = this.now()
    device.agents++
    try {
      const companion = await waitForIdb(this.companionOf(device), signal).catch(error => {
        if (signal?.aborted) throw new AppError(499, 'cancelled', '调用已取消')
        throw error
      })
      device.view ??= this.ready()
      this.spend(device, 1)
      const yielded = new AbortController()
      await this.acquire(device, 'agent', yielded)
      const gesture = signal ? AbortSignal.any([signal, yielded.signal]) : yielded.signal
      let stream: HidStream | undefined
      try {
        gesture.throwIfAborted()
        // The companion takes one hid stream at a time (checked on iOS 27.2: a second beside an open one is refused), so
        // the person's is ended first (no finger is down: the agent holds the device); their next input opens a new one.
        const held = device.person
        device.person = undefined
        if (held) await held.end(undefined, gesture).catch(() => held.cancelAndWait())
        gesture.throwIfAborted()
        stream = companion.hid()
        await act(device, stream, gesture)
        gesture.throwIfAborted()
        try {
          await stream.end(undefined, gesture)
        } catch {
          throw new AppError(502, 'simulator-input-failed', '输入没有送到设备')
        }
      } catch (error) {
        await stream?.cancelAndWait()
        if (yielded.signal.aborted) throw new AppError(502, 'simulator-input-failed', '人在操作这台设备，Agent 的手势让给了人')
        if (signal?.aborted) throw new AppError(499, 'cancelled', '调用已取消')
        throw error
      } finally {
        if (device.agentGesture === yielded) device.agentGesture = undefined
        this.releaseOwner(device, 'agent')
      }
    } finally {
      device.agents--
      device.lastUsed = this.now()
      if (signal?.aborted && this.devices.get(udid) === device && !this.inUse(device)) await this.end(device)
    }
  }

  /**
   * Waits until no other gesture holds the device; at most ten seconds. The person always wins: their press stops an
   * agent's gesture in progress and goes ahead of every agent waiting.
   */
  private acquire(device: Device, owner: Owner, yielded?: AbortController): Promise<void> {
    const grant = () => {
      device.owner = owner
      device.agentGesture = yielded
      this.ownerChanged(device.udid)
    }
    if (device.owner === undefined) {
      grant()
      return Promise.resolve()
    }
    if (owner === 'person' && device.owner === 'agent') device.agentGesture?.abort()
    return new Promise((resolve, reject) => {
      const entry = {
        owner,
        grant: () => {
          clearTimeout(timer)
          grant()
          resolve()
        },
      }
      const timer = setTimeout(() => {
        const index = device.waiting.indexOf(entry)
        if (index >= 0) device.waiting.splice(index, 1)
        reject(new AppError(409, 'simulator-busy', '设备上正有另一个手势'))
      }, GESTURE_WAIT_MS)
      if (owner === 'person') {
        // Behind other people (several local windows may hold control), ahead of every agent.
        const firstAgent = device.waiting.findIndex(waiting => waiting.owner === 'agent')
        device.waiting.splice(firstAgent < 0 ? device.waiting.length : firstAgent, 0, entry)
      } else device.waiting.push(entry)
    })
  }

  private releaseOwner(device: Device, owner: Owner): void {
    if (device.owner !== owner) return
    device.owner = undefined
    const next = device.waiting.shift()
    if (next) next.grant()
    else this.ownerChanged(device.udid)
  }

  private inUse(device: Device): boolean {
    return device.holders.size > 0 || device.takes.size > 0 || device.agents > 0
  }

  private async end(device: Device): Promise<void> {
    const companion = device.companion
    const starting = device.starting
    device.companion = undefined
    device.person = undefined
    device.size = undefined
    device.takes.clear()
    if (this.devices.get(device.udid) === device) this.devices.delete(device.udid)
    const ending = Promise.allSettled([this.endings.get(device.udid), starting?.result, companion?.close()])
    this.endings.set(device.udid, ending)
    starting?.abort.abort()
    this.ownerChanged(device.udid)
    await ending
    if (this.endings.get(device.udid) === ending) this.endings.delete(device.udid)
  }

  /**
   * Every few seconds: a finger with no event for ten seconds is lifted; a person's control with no input for two
   * minutes lapses (released as if they let go); companions nobody holds and no agent used for a minute end. Tests call
   * it directly.
   */
  async sweep(): Promise<void> {
    const now = this.now()
    for (const device of [...this.devices.values()]) {
      if (device.down && now - device.downAt >= FINGER_MS) await this.liftPerson(device).catch(() => undefined)
      for (const [holder, at] of [...device.holders]) {
        if (this.devices.get(device.udid) !== device) break
        if (now - at >= HOLD_MS) await this.release(device.udid, holder).catch(() => undefined)
      }
      if (this.devices.get(device.udid) === device && !this.inUse(device) && now - device.lastUsed >= IDLE_MS) await this.end(device)
    }
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

/** A wait an aborted signal ends early, by throwing. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop)
      resolve()
    }, ms)
    const stop = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', stop, { once: true })
  })
}
