// The 设备 panel's live picture: one latch-simulator helper per device, shared by the panels watching it and ended
// when the last one leaves, the device shuts down or the Host stops. Each watcher has its own small queue drained as
// its socket takes bytes; one that falls behind loses frames (and, for H.264, waits for the next keyframe), never
// memory. Frames go only to the watching panel's response: never to a log, the audit, the Host's SSE or disk.
import {
  SIMULATOR_INPUT_OWNERS,
  SIMULATOR_STREAM,
  type SimulatorInputOwner,
  type SimulatorLiveDescription,
  type SimulatorLiveEnd,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { SimulatorHelper, type SimulatorStreamEvent, type StreamSettings } from './simulator-helper.ts'

/** What the live picture needs of a helper: the real wrapper in production, a stand-in in tests. */
export interface LiveSource {
  readonly capabilities: { frames: { available: true } | { available: false; reason: string } } | undefined
  frames(settings: StreamSettings): AsyncGenerator<SimulatorStreamEvent, void, undefined>
  keyframe(): Promise<void>
  close(): Promise<void>
}
export type LiveAttach = (udid: string) => Promise<LiveSource>

/** The real helper, from `dist/native`. */
export const attachSimulatorHelper: LiveAttach = udid => SimulatorHelper.attach(udid)

/** Panels per device, and devices with a picture at once. */
const WATCHERS_PER_DEVICE = 2
const FEEDS_MAX = 4
/** What one watcher may hold unread: frames and bytes. */
const WATCHER_FRAMES = 4
const WATCHER_BYTES = 8 * 1024 * 1024

export function liveMessage(type: number, timestamp: number, payload: Buffer): Buffer {
  const head = Buffer.allocUnsafe(SIMULATOR_STREAM.headerBytes)
  head.writeUInt8(type, 0)
  head.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(timestamp))), 1)
  head.writeUInt32BE(payload.length, 9)
  return Buffer.concat([head, payload])
}

/** The helper's description as the page reads it. */
export function liveDescription(event: Extract<SimulatorStreamEvent, { type: 'description' }>['description']): SimulatorLiveDescription {
  const orientation = event.orientation >= 1 && event.orientation <= 4 ? (event.orientation as 1 | 2 | 3 | 4) : 1
  return {
    codec: event.codec,
    ...(event.codecString ? { codecString: event.codecString } : {}),
    ...(event.config ? { config: event.config } : {}),
    width: event.width,
    height: event.height,
    points: { width: Math.round(event.sourceWidth / event.scale), height: Math.round(event.sourceHeight / event.scale) },
    source: { width: event.sourceWidth, height: event.sourceHeight },
    orientation,
  }
}

/** One panel's view of a feed: what it has not read yet. */
class Watcher {
  readonly frames: Buffer[] = []
  bytes = 0
  description: Buffer | undefined
  inputOwner: Buffer | undefined
  /** Frames are dropped until the next keyframe. */
  skipping = false
  ended: SimulatorLiveEnd | undefined
  endSent = false
  waiter: (() => void) | undefined

  wake(): void {
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.()
  }
}

class Feed {
  readonly udid: string
  readonly settings: StreamSettings
  readonly watchers = new Set<Watcher>()
  source: LiveSource | undefined
  starting: Promise<void> | undefined
  iterator: AsyncGenerator<SimulatorStreamEvent, void, undefined> | undefined
  description: Buffer | undefined
  ending = false
  keyframeAsked = false

  constructor(udid: string, settings: StreamSettings) {
    this.udid = udid
    this.settings = settings
  }
}

export interface LiveWatch {
  /** The next message to write, or undefined once the stream has ended. */
  next(): Promise<Buffer | undefined>
  inputOwner(owner: SimulatorInputOwner): void
  close(): void
}

export class SimulatorLive {
  private readonly attach: LiveAttach | undefined
  private readonly feeds = new Map<string, Feed>()
  private stopped = false

  private readonly displayChanged: ((udid: string) => void) | undefined

  /** `displayChanged`: told when a device's picture changes form (it turned), for input to follow. */
  constructor(options: { attach?: LiveAttach; displayChanged?: (udid: string) => void } = {}) {
    this.attach = options.attach
    this.displayChanged = options.displayChanged
  }

  get offered(): boolean {
    return this.attach !== undefined
  }

  /** Devices with a live picture now. */
  watched(): string[] {
    return [...this.feeds.keys()]
  }

  /**
   * Starts watching a running, listed device. A second panel on the same device shares its stream when it asks for the
   * same settings; different settings are refused rather than silently ignored.
   */
  async watch(udid: string, settings: StreamSettings): Promise<LiveWatch> {
    if (!this.attach || this.stopped) throw new AppError(503, 'simulator-live-unavailable', '这台电脑上没有实时画面')
    let feed = this.feeds.get(udid)
    if (feed) {
      const same = feed.settings
      if (same.codec !== settings.codec || same.maxFps !== settings.maxFps || same.maxDimension !== settings.maxDimension)
        throw new AppError(409, 'simulator-live-busy', '这台设备的画面已按别的设置在播放')
      if (feed.watchers.size >= WATCHERS_PER_DEVICE) throw new AppError(429, 'simulator-live-busy', '这台设备的画面开得太多了')
    } else {
      if (this.feeds.size >= FEEDS_MAX) throw new AppError(429, 'simulator-live-busy', '同时播放的设备太多了')
      feed = new Feed(udid, settings)
      this.feeds.set(udid, feed)
    }
    const watcher = new Watcher()
    feed.watchers.add(watcher)
    if (feed.description) {
      watcher.description = feed.description
      watcher.skipping = settings.codec === 'h264'
      this.askKeyframe(feed)
    }
    if (!feed.source && !feed.ending) {
      try {
        await (feed.starting ??= this.start(feed))
      } catch (error) {
        feed.watchers.delete(watcher)
        throw error
      }
    }
    const current = feed
    return {
      next: () => this.read(watcher),
      inputOwner: owner => {
        if (watcher.ended) return
        // One slot per panel; a slow reader only needs the latest ownership and never holds old changes.
        watcher.inputOwner = liveMessage(SIMULATOR_STREAM.control, 0, Buffer.from([SIMULATOR_INPUT_OWNERS.indexOf(owner)]))
        watcher.wake()
      },
      close: () => this.leave(current, watcher),
    }
  }

  /**
   * A panel's decoder needs a keyframe (it flushed on a still screen, or fell behind): the helper is asked once, for
   * every watcher of the device.
   */
  keyframe(udid: string): boolean {
    const feed = this.feeds.get(udid)
    if (!feed) return false
    this.askKeyframe(feed)
    return true
  }

  /** The device shut down: its feed ends. */
  deviceEnded(udid: string): void {
    const feed = this.feeds.get(udid)
    if (feed) void this.end(feed, 'device')
  }

  async stop(): Promise<void> {
    this.stopped = true
    await Promise.allSettled([...this.feeds.values()].map(feed => this.end(feed, 'host')))
  }

  private async start(feed: Feed): Promise<void> {
    let source: LiveSource
    try {
      source = await this.attach!(feed.udid)
    } catch {
      this.feeds.delete(feed.udid)
      throw new AppError(503, 'simulator-live-unavailable', '实时画面组件没有启动')
    }
    const frames = source.capabilities?.frames
    if (!frames?.available || this.stopped || feed.ending || feed.watchers.size === 0) {
      await source.close().catch(() => undefined)
      this.feeds.delete(feed.udid)
      if (frames && !frames.available)
        throw new AppError(409, 'simulator-live-unsupported', `这台设备没有实时画面：${frames.reason.slice(0, 128)}`)
      throw new AppError(503, 'simulator-live-unavailable', '实时画面已关闭')
    }
    feed.source = source
    feed.iterator = source.frames(feed.settings)
    void this.pump(feed)
  }

  private async pump(feed: Feed): Promise<void> {
    let reason: SimulatorLiveEnd = 'device'
    try {
      for (;;) {
        const step = await feed.iterator!.next()
        if (step.done || feed.ending) break
        this.dispatch(feed, step.value)
      }
    } catch {
      reason = 'failed'
    }
    await this.end(feed, feed.ending ? 'closed' : reason)
  }

  private dispatch(feed: Feed, event: SimulatorStreamEvent): void {
    if (event.type === 'description') {
      const message = liveMessage(SIMULATOR_STREAM.description, 0, Buffer.from(JSON.stringify(liveDescription(event.description))))
      if (feed.description && !feed.description.equals(message)) this.displayChanged?.(feed.udid)
      feed.description = message
      // A newer form makes everything unread before it stale; the helper sends one only before a keyframe.
      for (const watcher of feed.watchers) {
        watcher.frames.length = 0
        watcher.bytes = 0
        watcher.description = message
        watcher.skipping = false
        watcher.wake()
      }
      return
    }
    const jpeg = feed.settings.codec === 'jpeg'
    if (event.keyframe) feed.keyframeAsked = false
    const type = jpeg ? SIMULATOR_STREAM.jpeg : event.keyframe ? SIMULATOR_STREAM.key : SIMULATOR_STREAM.delta
    const message = liveMessage(type, event.timestamp, event.data)
    for (const watcher of feed.watchers) {
      if (watcher.skipping && !event.keyframe && !jpeg) continue
      watcher.skipping = false
      if (watcher.frames.length >= WATCHER_FRAMES || watcher.bytes + message.length > WATCHER_BYTES) {
        // Behind: what is queued goes. A JPEG stands alone; H.264 waits for the next keyframe.
        watcher.frames.length = 0
        watcher.bytes = 0
        if (!jpeg && !event.keyframe) {
          watcher.skipping = true
          this.askKeyframe(feed)
          continue
        }
      }
      watcher.frames.push(message)
      watcher.bytes += message.length
      watcher.wake()
    }
  }

  private askKeyframe(feed: Feed): void {
    if (feed.keyframeAsked || !feed.source || feed.settings.codec !== 'h264') return
    feed.keyframeAsked = true
    void feed.source.keyframe().catch(() => {
      feed.keyframeAsked = false
    })
  }

  private async read(watcher: Watcher): Promise<Buffer | undefined> {
    for (;;) {
      if (watcher.description) {
        const description = watcher.description
        watcher.description = undefined
        return description
      }
      if (watcher.inputOwner) {
        const owner = watcher.inputOwner
        watcher.inputOwner = undefined
        return owner
      }
      const frame = watcher.frames.shift()
      if (frame) {
        watcher.bytes -= frame.length
        return frame
      }
      if (watcher.ended) {
        if (watcher.endSent) return undefined
        watcher.endSent = true
        return liveMessage(SIMULATOR_STREAM.end, 0, Buffer.from(JSON.stringify({ reason: watcher.ended })))
      }
      await new Promise<void>(resolve => (watcher.waiter = resolve))
    }
  }

  private leave(feed: Feed, watcher: Watcher): void {
    watcher.ended ??= 'closed'
    watcher.endSent = true
    watcher.wake()
    feed.watchers.delete(watcher)
    if (feed.watchers.size === 0) void this.end(feed, 'closed')
  }

  /** The generator is returned and the helper closed, so it never streams to nobody. */
  private async end(feed: Feed, reason: SimulatorLiveEnd): Promise<void> {
    if (this.feeds.get(feed.udid) === feed) this.feeds.delete(feed.udid)
    for (const watcher of feed.watchers) {
      watcher.ended ??= reason
      watcher.wake()
    }
    if (feed.ending) return
    feed.ending = true
    const iterator = feed.iterator
    const source = feed.source
    // close() wakes a generator waiting for a frame, so its return() can finish.
    const returned = iterator?.return(undefined).catch(() => undefined)
    await source?.close().catch(() => undefined)
    await returned
  }
}
