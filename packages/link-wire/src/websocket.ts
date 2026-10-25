import { concat, Reader, uint } from './bytes.ts'

export type WebSocketFrame = { opcode: 2 | 8 | 9 | 10; payload: Uint8Array }

export function encodeFrame(frame: WebSocketFrame, mask?: Uint8Array): Uint8Array {
  const length = frame.payload.length
  if (length > 65_536 || (frame.opcode !== 2 && length > 125) || (mask && mask.length !== 4))
    throw new RangeError('Invalid WebSocket frame')
  const header = concat(
    uint(0x80 | frame.opcode, 1),
    uint((mask ? 0x80 : 0) | (length < 126 ? length : length < 65_536 ? 126 : 127), 1),
    length < 126 ? new Uint8Array() : uint(length, length < 65_536 ? 2 : 8),
    mask ?? new Uint8Array(),
  )
  const payload = frame.payload.slice()
  if (mask) for (let index = 0; index < length; index++) payload[index] = payload[index]! ^ mask[index % 4]!
  return concat(header, payload)
}

/** A bounded incremental parser: no fragments, extensions or text are accepted. */
export class WebSocketParser {
  private pending: Uint8Array = new Uint8Array()
  private readonly masked: boolean
  constructor(masked: boolean) {
    this.masked = masked
  }
  feed(chunk: Uint8Array): WebSocketFrame[] {
    const output: WebSocketFrame[] = []
    let offset = 0
    while (offset < chunk.length) {
      const room = 65_550 - this.pending.length
      if (room <= 0) throw new RangeError('WebSocket receive buffer full')
      const size = Math.min(room, chunk.length - offset)
      this.pending = concat(this.pending, chunk.slice(offset, offset + size))
      offset += size
      for (;;) {
        if (this.pending.length < 2) break
        const head = this.pending[0]!,
          second = this.pending[1]!
        if ((head & 0xf0) !== 0x80 || ![2, 8, 9, 10].includes(head & 0x0f) || Boolean(second & 0x80) !== this.masked)
          throw new RangeError('Invalid WebSocket header')
        const code = second & 0x7f,
          extra = code === 127 ? 8 : code === 126 ? 2 : 0
        if (this.pending.length < 2 + extra) break
        const reader = new Reader(this.pending.slice(2, 2 + extra))
        const length = extra ? reader.number(extra as 2 | 8) : code
        if (length > 65_536 || (code === 126 && length < 126) || (code === 127 && length < 65_536) || ((head & 0xf) !== 2 && length > 125))
          throw new RangeError('Invalid WebSocket length')
        const header = 2 + extra + (this.masked ? 4 : 0)
        if (this.pending.length < header + length) break
        const payload = this.pending.slice(header, header + length)
        if (this.masked)
          for (let index = 0; index < length; index++) payload[index] = payload[index]! ^ this.pending[2 + extra + (index % 4)]!
        if ((head & 0xf) === 8 && length === 1) throw new RangeError('Invalid close frame')
        output.push({ opcode: (head & 0xf) as 2 | 8 | 9 | 10, payload })
        this.pending = this.pending.slice(header + length)
      }
    }
    return output
  }
}
