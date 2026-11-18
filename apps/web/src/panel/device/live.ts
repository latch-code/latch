// The 设备 panel's live picture and input, without React: reading the Host's binary stream, which decoder to use, how
// the screen's content is drawn upright, and where a pointer on the picture lands on the device, in points.
import {
  SIMULATOR_INPUT_OWNERS,
  SIMULATOR_STREAM,
  type SimulatorControlView,
  type SimulatorInputEvent,
  type SimulatorInputKind,
  type SimulatorInputOwner,
  type SimulatorKey,
  type SimulatorLiveDescription,
} from '@latch/protocol'
import { defineCopy } from '../../core/i18n.ts'

const COPY = defineCopy(
  {
    noCompanion:
      '没有安装 idb_companion。可运行 brew install meta/fb/idb-companion。若 Homebrew 要求信任此 tap，先运行 brew trust meta/fb。',
    companionFailed: 'idb_companion 没有启动或已退出',
    noAnswer: 'idb_companion 没有回答',
    socketPath: '临时目录的路径太长',
    keyboard: '文字只在设备的 English (US) 键盘上逐键输入可打印的 ASCII；拼音等键盘会改写它',
    singleTouch: 'idb 的触摸只有一个点',
    unsupported: '这台电脑上没有输入',
  },
  {
    noCompanion:
      'idb_companion isn’t installed. Run brew install meta/fb/idb-companion. If Homebrew requires trusting the tap, run brew trust meta/fb first.',
    companionFailed: 'idb_companion didn’t start or has exited',
    noAnswer: 'idb_companion didn’t respond',
    socketPath: 'The temporary directory path is too long',
    keyboard:
      'Key-by-key entry supports printable ASCII on the device’s English (US) keyboard. Other keyboards, such as Pinyin, may change the text.',
    singleTouch: 'idb supports single-touch input only',
    unsupported: 'Input isn’t available on this computer',
  },
)

export interface LiveMessage {
  type: number
  /** Microseconds since the stream began. */
  timestamp: number
  payload: Uint8Array
}

/** The most one message may carry: a frame of the helper's 8 MiB bound, with room. */
const MESSAGE_LIMIT = 9 * 1024 * 1024
const KNOWN = new Set<number>([
  SIMULATOR_STREAM.description,
  SIMULATOR_STREAM.delta,
  SIMULATOR_STREAM.key,
  SIMULATOR_STREAM.jpeg,
  SIMULATOR_STREAM.end,
  SIMULATOR_STREAM.control,
])

/** Splits the stream into messages whatever the chunk boundaries; throws on an unknown type or an oversize length. */
export class LiveReader {
  private buffer = new Uint8Array(0)

  push(chunk: Uint8Array): LiveMessage[] {
    const joined = new Uint8Array(this.buffer.length + chunk.length)
    joined.set(this.buffer)
    joined.set(chunk, this.buffer.length)
    this.buffer = joined
    const messages: LiveMessage[] = []
    const head = SIMULATOR_STREAM.headerBytes
    let at = 0
    while (this.buffer.length - at >= head) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + at, head)
      const type = view.getUint8(0)
      const timestamp = Number(view.getBigUint64(1))
      const length = view.getUint32(9)
      if (!KNOWN.has(type) || length > MESSAGE_LIMIT || (type === SIMULATOR_STREAM.control && length !== 1))
        throw new RangeError('Unknown live message')
      if (this.buffer.length - at < head + length) break
      messages.push({ type, timestamp, payload: this.buffer.slice(at + head, at + head + length) })
      at += head + length
    }
    this.buffer = this.buffer.slice(at)
    return messages
  }
}

/** A description from the Host, checked; undefined for anything malformed. */
export function parseDescription(payload: Uint8Array): SimulatorLiveDescription | undefined {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(payload))
  } catch {
    return undefined
  }
  if (!value || typeof value !== 'object') return undefined
  const get = (key: string): unknown => Reflect.get(value as object, key)
  const dimension = (field: unknown) => typeof field === 'number' && Number.isInteger(field) && field > 0 && field <= 16_384
  const codec = get('codec')
  const points = get('points')
  const orientation = get('orientation')
  if (codec !== 'h264' && codec !== 'jpeg') return undefined
  if (!dimension(get('width')) || !dimension(get('height'))) return undefined
  if (!points || typeof points !== 'object') return undefined
  const pointWidth: unknown = Reflect.get(points, 'width')
  const pointHeight: unknown = Reflect.get(points, 'height')
  if (!dimension(pointWidth) || !dimension(pointHeight)) return undefined
  const source = get('source')
  const sourceWidth: unknown = source && typeof source === 'object' ? Reflect.get(source, 'width') : undefined
  const sourceHeight: unknown = source && typeof source === 'object' ? Reflect.get(source, 'height') : undefined
  if (!dimension(sourceWidth) || !dimension(sourceHeight)) return undefined
  const codecString = get('codecString')
  const config = get('config')
  return {
    codec,
    ...(typeof codecString === 'string' && /^avc1\.[0-9a-f]{6}$/u.test(codecString) ? { codecString } : {}),
    ...(typeof config === 'string' && config.length <= 12_000 ? { config } : {}),
    width: get('width') as number,
    height: get('height') as number,
    points: { width: pointWidth as number, height: pointHeight as number },
    source: { width: sourceWidth as number, height: sourceHeight as number },
    orientation: orientation === 2 || orientation === 3 || orientation === 4 ? orientation : 1,
  }
}

/** Whether the content is turned sideways in the framebuffer. */
const sideways = (orientation: SimulatorLiveDescription['orientation']) => orientation === 3 || orientation === 4

/** The picture as the person sees it, upright: pixels and points. */
export function uprightSize(description: SimulatorLiveDescription): {
  pixels: { width: number; height: number }
  points: { width: number; height: number }
  /** The device's own pixels, for zoom. */
  device: { width: number; height: number }
} {
  const turn = sideways(description.orientation)
  return {
    device: turn
      ? { width: description.source.height, height: description.source.width }
      : { width: description.source.width, height: description.source.height },
    pixels: turn ? { width: description.height, height: description.width } : { width: description.width, height: description.height },
    points: turn
      ? { width: description.points.height, height: description.points.width }
      : { width: description.points.width, height: description.points.height },
  }
}

/**
 * The canvas transform that draws the framebuffer upright (`setTransform(a, b, c, d, e, f)`), in framebuffer pixels.
 * Checked on iOS 27.2: with 3 the content's top is at the framebuffer's left, with 4 at its right.
 */
export function uprightTransform(
  description: Pick<SimulatorLiveDescription, 'orientation' | 'width' | 'height'>,
): [number, number, number, number, number, number] {
  const { width, height } = description
  switch (description.orientation) {
    case 2:
      return [-1, 0, 0, -1, width, height]
    case 3:
      return [0, 1, -1, 0, height, 0]
    case 4:
      return [0, -1, 1, 0, 0, width]
    default:
      return [1, 0, 0, 1, 0, 0]
  }
}

/**
 * Where a pointer lands on the device, in points of the content as shown: the element's box (any zoom), less any
 * letterboxing of the picture inside it (`object-fit: contain`, by the picture's own pixels, which an encoder rounds
 * to even sizes). Undefined outside the picture.
 */
export function pointerToDevice(
  pointer: { x: number; y: number },
  box: { left: number; top: number; width: number; height: number },
  points: { width: number; height: number },
  pixels: { width: number; height: number } = points,
): { x: number; y: number } | undefined {
  const shown = containedBox(box, pixels)
  if (!shown || points.width <= 0 || points.height <= 0) return undefined
  const x = ((pointer.x - shown.left) / shown.width) * points.width
  const y = ((pointer.y - shown.top) / shown.height) * points.height
  if (x < 0 || y < 0 || x > points.width || y > points.height) return undefined
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }
}

/** Where the picture is drawn inside its element: `object-fit: contain`. */
export function containedBox(
  box: { left: number; top: number; width: number; height: number },
  pixels: { width: number; height: number },
): { left: number; top: number; width: number; height: number } | undefined {
  if (box.width <= 0 || box.height <= 0 || pixels.width <= 0 || pixels.height <= 0) return undefined
  const scale = Math.min(box.width / pixels.width, box.height / pixels.height)
  const width = pixels.width * scale
  const height = pixels.height * scale
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height }
}

/** Where a written touch is shown, using the same picture geometry as the outgoing pointer. */
export function deviceToPointer(
  point: { x: number; y: number },
  box: { left: number; top: number; width: number; height: number },
  points: { width: number; height: number },
  pixels: { width: number; height: number },
): { x: number; y: number } | undefined {
  const shown = containedBox(box, pixels)
  if (!shown || points.width <= 0 || points.height <= 0) return undefined
  return { x: shown.left + (point.x / points.width) * shown.width, y: shown.top + (point.y / points.height) * shown.height }
}

export function parseOwner(payload: Uint8Array): SimulatorInputOwner | undefined {
  return payload.length === 1 ? SIMULATOR_INPUT_OWNERS[payload[0]!] : undefined
}

export function writtenTouch(
  receipt: unknown,
  events: readonly SimulatorInputEvent[],
): Extract<SimulatorInputEvent, { type: 'touch' }> | undefined {
  if (!receipt || typeof receipt !== 'object') return undefined
  const written: unknown = Reflect.get(receipt, 'written')
  const touchIndex: unknown = Reflect.get(receipt, 'touchIndex')
  if (
    typeof written !== 'number'
    || !Number.isInteger(written)
    || written < 1
    || written > events.length
    || typeof touchIndex !== 'number'
    || !Number.isInteger(touchIndex)
  )
    return undefined
  const event = events[touchIndex]
  return event?.type === 'touch' ? event : undefined
}

/** The codec to ask for: H.264 where WebCodecs can decode it, else JPEG frames. */
export function chooseCodec(environment: { VideoDecoder?: unknown }): 'h264' | 'jpeg' {
  return typeof environment.VideoDecoder === 'function' ? 'h264' : 'jpeg'
}

/** What the stream asks for: a sharp enough picture for a panel, light on the Host. */
export function streamQuery(codec: 'h264' | 'jpeg'): string {
  return codec === 'h264' ? 'codec=h264&fps=30&size=1280' : 'codec=jpeg&fps=20&size=960'
}

/**
 * What a key press in the panel sends while keys go to the device: a printable ASCII character as text (the Host types
 * it only on the device's English (US) keyboard and says so otherwise), or one of the named keys. Anything else typed
 * (an accented letter, an input method's composition) is `refused`, never dropped without a word.
 */
export function deviceInput(event: {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
}): SimulatorInputEvent | 'refused' | undefined {
  const key = deviceKey(event)
  if (key) return { type: 'key', key }
  if (event.metaKey || event.ctrlKey) return undefined
  if (event.key === 'Process' || event.key === 'Dead') return 'refused'
  if ([...event.key].length !== 1) return undefined
  return /^[\x20-\x7e]$/u.test(event.key) && !event.altKey ? { type: 'text', text: event.key } : 'refused'
}

/** The panel's named single keys. */
export function deviceKey(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): SimulatorKey | undefined {
  if (event.metaKey || event.ctrlKey || event.altKey) return undefined
  switch (event.key) {
    case 'Enter':
      return 'return'
    case 'Backspace':
      return 'delete'
    case 'Tab':
      return 'tab'
    case 'Escape':
      return 'escape'
    case 'ArrowLeft':
      return 'left'
    case 'ArrowRight':
      return 'right'
    case 'ArrowUp':
      return 'up'
    case 'ArrowDown':
      return 'down'
    default:
      return undefined
  }
}

const REASONS: Record<string, string> = {
  get 'idb-missing'() {
    return COPY.noCompanion
  },
  get 'companion-failed'() {
    return COPY.companionFailed
  },
  get 'no-answer'() {
    return COPY.noAnswer
  },
  get 'socket-path'() {
    return COPY.socketPath
  },
  get keyboard() {
    return COPY.keyboard
  },
  get 'single-touch'() {
    return COPY.singleTouch
  },
  get unsupported() {
    return COPY.unsupported
  },
}

/** The hover for an unavailable kind of input. */
export function inputReason(kind: SimulatorInputKind | undefined): string {
  if (!kind || kind.available) return ''
  return REASONS[kind.reason] ?? kind.reason
}

/** The Host's answer to `control`, checked; anything malformed reads as unavailable. */
export function parseControl(value: unknown): SimulatorControlView {
  const kind = (field: unknown): SimulatorInputKind => {
    if (field && typeof field === 'object' && Reflect.get(field, 'available') === true) return { available: true }
    const reason: unknown = field && typeof field === 'object' ? Reflect.get(field, 'reason') : undefined
    return { available: false, reason: typeof reason === 'string' && reason in REASONS ? (reason as never) : 'companion-failed' }
  }
  const view: unknown = value && typeof value === 'object' ? Reflect.get(value, 'control') : undefined
  const get = (key: string) => (view && typeof view === 'object' ? Reflect.get(view, key) : undefined)
  return {
    touch: kind(get('touch')),
    keys: kind(get('keys')),
    buttons: kind(get('buttons')),
    text: kind(get('text')),
    twoFingers: kind(get('twoFingers')),
  }
}

/**
 * Ordered input to the Host: one request at a time, a finger's moves batched per animation frame (only the latest move
 * waits), downs, ups, keys and buttons never dropped. A failed request drops what waits and is reported.
 */
export class InputSender {
  private queue: SimulatorInputEvent[] = []
  private sending = false
  private scheduled = false
  private readonly post: (events: SimulatorInputEvent[]) => Promise<void>
  private readonly failed: (error: unknown) => void
  private readonly schedule: (flush: () => void) => void

  constructor(
    post: (events: SimulatorInputEvent[]) => Promise<void>,
    failed: (error: unknown) => void,
    schedule: (flush: () => void) => void = flush => requestAnimationFrame(flush),
  ) {
    this.post = post
    this.failed = failed
    this.schedule = schedule
  }

  send(event: SimulatorInputEvent): void {
    const last = this.queue.at(-1)
    // Typed characters waiting together go as one text event.
    if (event.type === 'text' && last?.type === 'text' && last.text.length + event.text.length <= 64) {
      last.text += event.text
      void this.drain()
      return
    }
    if (event.type === 'touch' && event.phase === 'move' && last?.type === 'touch' && last.phase === 'move') {
      this.queue[this.queue.length - 1] = event
    } else this.queue.push(event)
    if (event.type === 'touch' && event.phase === 'move') {
      if (!this.scheduled) {
        this.scheduled = true
        this.schedule(() => {
          this.scheduled = false
          void this.drain()
        })
      }
      return
    }
    void this.drain()
  }

  /** Events not yet sent. */
  get waiting(): number {
    return this.queue.length
  }

  private async drain(): Promise<void> {
    if (this.sending) return
    this.sending = true
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, 64)
        try {
          await this.post(batch)
        } catch (error) {
          this.queue = []
          this.failed(error)
          return
        }
      }
    } finally {
      this.sending = false
    }
  }
}
