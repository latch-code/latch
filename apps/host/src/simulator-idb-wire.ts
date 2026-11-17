// The few idb_companion messages the Host sends, encoded by hand: the `hid` client stream's touch, button and key
// presses, and the empty `describe` request. Field numbers are those of idb's public proto (package `idb`, service
// `CompanionService`), checked against the bytes the idb client itself sends (the Host's input tests). Nothing here
// decodes a picture or carries text: text goes to the device's pasteboard through simctl and is pasted with a key chord.

/** idb's `HIDEvent.HIDButtonType`: only the buttons Latch offers (APPLE_PAY fails on this transport; the rest are media). */
export const IDB_BUTTONS = { home: 1, lock: 2, side: 3, siri: 4 } as const
export type IdbButton = keyof typeof IDB_BUTTONS

/** USB HID usage IDs of the keys Latch sends on their own. */
export const IDB_KEYS = {
  return: 40,
  escape: 41,
  delete: 42,
  tab: 43,
  right: 79,
  left: 80,
  down: 81,
  up: 82,
} as const
export type IdbKey = keyof typeof IDB_KEYS
/** The left Command key and V, for paste. */
export const KEY_COMMAND = 227
export const KEY_V = 25

export type HidEvent =
  | { kind: 'touch'; x: number; y: number; direction: 'down' | 'up' }
  | { kind: 'button'; button: IdbButton; direction: 'down' | 'up' }
  | { kind: 'key'; code: number; direction: 'down' | 'up' }

function varint(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Invalid varint')
  const bytes: number[] = []
  let rest = value
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80)
    rest = Math.floor(rest / 0x80)
  }
  bytes.push(rest)
  return Buffer.from(bytes)
}

/** A length-delimited field (wire type 2). */
function message(field: number, body: Buffer): Buffer {
  return Buffer.concat([varint((field << 3) | 2), varint(body.length), body])
}

/** A double field (wire type 1); proto3 leaves out a zero, as idb's own client does. */
function double(field: number, value: number): Buffer {
  if (!Number.isFinite(value)) throw new RangeError('Invalid coordinate')
  if (value === 0) return Buffer.alloc(0)
  const data = Buffer.allocUnsafe(8)
  data.writeDoubleLE(value, 0)
  return Buffer.concat([varint((field << 3) | 1), data])
}

/** A varint field (wire type 0); a zero is left out. */
function number(field: number, value: number): Buffer {
  return value === 0 ? Buffer.alloc(0) : Buffer.concat([varint(field << 3), varint(value)])
}

/**
 * One `HIDEvent { press: HIDPress { action: HIDPressAction, direction } }`. A touch's action is `HIDTouch { Point }`
 * in points; a touch down at a new point while one is down moves it (a live drag).
 */
export function encodeHidEvent(event: HidEvent): Buffer {
  let action: Buffer
  if (event.kind === 'touch') action = message(1, message(1, Buffer.concat([double(1, event.x), double(2, event.y)])))
  else if (event.kind === 'button') action = message(2, number(1, IDB_BUTTONS[event.button]))
  else {
    if (!Number.isInteger(event.code) || event.code < 0 || event.code > 0xffff) throw new RangeError('Invalid key code')
    action = message(3, number(1, event.code))
  }
  const press = Buffer.concat([message(1, action), number(2, event.direction === 'up' ? 1 : 0)])
  return message(1, press)
}

/** The gRPC length prefix: not compressed, then the length, big-endian. */
export function grpcFrame(payload: Buffer): Buffer {
  const head = Buffer.allocUnsafe(5)
  head.writeUInt8(0, 0)
  head.writeUInt32BE(payload.length, 1)
  return Buffer.concat([head, payload])
}

/** Splits gRPC length-prefixed messages; throws on a compressed one or one past `limit`. */
export class GrpcReader {
  private buffer: Buffer = Buffer.alloc(0)
  private readonly limit: number
  constructor(limit: number) {
    this.limit = limit
  }

  push(chunk: Buffer): Buffer[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    const out: Buffer[] = []
    while (this.buffer.length >= 5) {
      if (this.buffer[0] !== 0) throw new RangeError('Compressed gRPC message')
      const size = this.buffer.readUInt32BE(1)
      if (size > this.limit) throw new RangeError('gRPC message too large')
      if (this.buffer.length < 5 + size) break
      out.push(this.buffer.subarray(5, 5 + size))
      this.buffer = this.buffer.subarray(5 + size)
    }
    if (this.buffer.length > 5 + this.limit) throw new RangeError('gRPC message too large')
    return out
  }
}

/** The screen in points from a `TargetDescriptionResponse`, the only fields read; undefined when it has none. */
export function screenPoints(response: Buffer): { width: number; height: number } | undefined {
  const target = field(response, 1)
  const screen = target && field(target, 3)
  if (!screen) return undefined
  const width = varintField(screen, 4)
  const height = varintField(screen, 5)
  return width && height && width <= 10_000 && height <= 10_000 ? { width, height } : undefined
}

/** Walks one message's fields; undefined for bytes that are not a well-formed message. */
function fields(data: Buffer): Array<{ field: number; type: number; value: Buffer | number }> | undefined {
  const out: Array<{ field: number; type: number; value: Buffer | number }> = []
  let at = 0
  const read = (): number | undefined => {
    let value = 0
    let scale = 1
    for (let index = 0; index < 8; index++) {
      if (at >= data.length) return undefined
      const byte = data[at++]!
      value += (byte & 0x7f) * scale
      if ((byte & 0x80) === 0) return Number.isSafeInteger(value) ? value : undefined
      scale *= 0x80
    }
    return undefined
  }
  while (at < data.length) {
    const key = read()
    if (key === undefined) return undefined
    const type = key & 7
    const field = Math.floor(key / 8)
    if (type === 0) {
      const value = read()
      if (value === undefined) return undefined
      out.push({ field, type, value })
    } else if (type === 1 || type === 5) {
      const size = type === 1 ? 8 : 4
      if (at + size > data.length) return undefined
      out.push({ field, type, value: data.subarray(at, at + size) })
      at += size
    } else if (type === 2) {
      const size = read()
      if (size === undefined || at + size > data.length) return undefined
      out.push({ field, type, value: data.subarray(at, at + size) })
      at += size
    } else return undefined
  }
  return out
}

function field(data: Buffer, number: number): Buffer | undefined {
  const found = fields(data)?.find(item => item.field === number && item.type === 2)
  return found && Buffer.isBuffer(found.value) ? found.value : undefined
}

function varintField(data: Buffer, number: number): number | undefined {
  const found = fields(data)?.find(item => item.field === number && item.type === 0)
  return typeof found?.value === 'number' ? found.value : undefined
}
