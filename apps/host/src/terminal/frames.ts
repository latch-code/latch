// Frames between the Host and latch-pty (native/macos/LatchTerminal.swift): one type byte, the payload's length as a
// 4-byte big-endian integer, then the payload. Control frames carry JSON; input and output carry raw bytes.

/** Frames the Host writes: start and input on stdin, resize and signal on fd 3. The end of either pipe closes the terminal. */
export const TO_HELPER = { start: 1, input: 2, resize: 3, signal: 4 } as const
/** Frames the helper writes. */
export const FROM_HELPER = { started: 1, output: 2, foreground: 3, exit: 4, error: 5 } as const
const FRAME_HEADER_BYTES = 5
/** The largest payload either side writes; a longer one is a protocol error. */
export const FRAME_PAYLOAD_LIMIT = 65_536

export interface Frame {
  type: number
  /** A view into the bytes pushed to the reader: copy it to keep it. */
  payload: Buffer
}

export function encodeFrame(type: number, payload: Uint8Array = new Uint8Array(0)): Buffer {
  if (!Number.isInteger(type) || type < 0 || type > 255) throw new RangeError('Invalid terminal frame type')
  if (payload.length > FRAME_PAYLOAD_LIMIT) throw new RangeError('Terminal frame payload too large')
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.length)
  frame.writeUInt8(type, 0)
  frame.writeUInt32BE(payload.length, 1)
  frame.set(payload, FRAME_HEADER_BYTES)
  return frame
}

/** Columns and rows, two big-endian bytes each. */
export function encodeSize(cols: number, rows: number): Buffer {
  const payload = Buffer.allocUnsafe(4)
  payload.writeUInt16BE(cols, 0)
  payload.writeUInt16BE(rows, 2)
  return payload
}

/** Splits a byte stream into frames, whatever the chunk boundaries; throws on a length over the limit. */
export class FrameReader {
  private pending = Buffer.alloc(0)

  push(chunk: Buffer): Frame[] {
    const data = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
    const frames: Frame[] = []
    let offset = 0
    while (data.length - offset >= FRAME_HEADER_BYTES) {
      const length = data.readUInt32BE(offset + 1)
      if (length > FRAME_PAYLOAD_LIMIT) throw new RangeError('Terminal frame payload too large')
      const end = offset + FRAME_HEADER_BYTES + length
      if (end > data.length) break
      frames.push({ type: data.readUInt8(offset), payload: data.subarray(offset + FRAME_HEADER_BYTES, end) })
      offset = end
    }
    this.pending = offset === data.length ? Buffer.alloc(0) : Buffer.from(data.subarray(offset))
    return frames
  }

  /** Bytes of a frame that has not arrived in full. */
  get buffered(): number {
    return this.pending.length
  }
}
