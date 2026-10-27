/** Where the first allocation stops; a quiet terminal never grows to its capacity. */
const INITIAL_BYTES = 16_384
/** How far into the kept output a replay looks for a line break to start on. */
const LINE_SEARCH_BYTES = 4096

/**
 * A terminal's recent output in memory: at most `capacity` bytes, the oldest dropped first. Positions are offsets into
 * everything the terminal ever printed, so a reader that falls behind can tell what it missed.
 */
export class Scrollback {
  private buffer: Buffer
  /** Index of the oldest kept byte in `buffer`. */
  private head = 0
  private length = 0
  private total = 0

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new RangeError('Invalid scrollback capacity')
    this.buffer = Buffer.alloc(Math.min(capacity, INITIAL_BYTES))
  }

  /** Offset of the oldest byte still kept. */
  get start(): number {
    return this.total - this.length
  }

  /** Offset just past the newest byte. */
  get end(): number {
    return this.total
  }

  append(data: Uint8Array): void {
    if (data.length === 0) return
    this.total += data.length
    if (data.length >= this.capacity) {
      this.grow(this.capacity)
      this.buffer.set(data.subarray(data.length - this.capacity))
      this.head = 0
      this.length = this.capacity
      return
    }
    this.grow(Math.min(this.capacity, this.length + data.length))
    const size = this.buffer.length
    const overflow = this.length + data.length - size
    if (overflow > 0) {
      this.head = (this.head + overflow) % size
      this.length -= overflow
    }
    const tail = (this.head + this.length) % size
    const first = Math.min(data.length, size - tail)
    this.buffer.set(data.subarray(0, first), tail)
    if (first < data.length) this.buffer.set(data.subarray(first), 0)
    this.length += data.length
  }

  /** A copy of at most `max` bytes from `offset`, which must lie between `start` and `end`. */
  read(offset: number, max: number): Buffer {
    if (!Number.isSafeInteger(offset) || offset < this.start || offset > this.end) throw new RangeError('Offset outside the scrollback')
    const count = Math.min(Math.max(0, max), this.end - offset)
    const size = this.buffer.length
    const from = (this.head + (offset - this.start)) % size
    const first = Math.min(count, size - from)
    const result = Buffer.allocUnsafe(count)
    this.buffer.copy(result, 0, from, from + first)
    if (first < count) this.buffer.copy(result, first, 0, count - first)
    return result
  }

  /** Everything kept, oldest first. */
  contents(): Buffer {
    return this.read(this.start, this.length)
  }

  /**
   * Where a replay starts: the beginning, or once older output was dropped, just after the first line break, so the
   * replay does not open in the middle of a character or an escape sequence.
   */
  replayStart(): number {
    if (this.start === 0) return 0
    const index = this.read(this.start, LINE_SEARCH_BYTES).indexOf(0x0a)
    return index < 0 ? this.start : this.start + index + 1
  }

  private grow(size: number): void {
    if (this.buffer.length >= size) return
    const next = Buffer.alloc(Math.min(this.capacity, Math.max(size, this.buffer.length * 2)))
    const kept = this.length === 0 ? Buffer.alloc(0) : this.read(this.start, this.length)
    next.set(kept)
    this.buffer = next
    this.head = 0
  }
}
