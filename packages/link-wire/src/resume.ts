export interface Sequenced<Value> {
  sequence: number
  value: Value
}
/** A bounded history per stream. Snapshot fallback is explicit and never masquerades as a replay. */
export class ResumeLog<Value> {
  private readonly history: Sequenced<Value>[] = []
  private sequence = 0
  private readonly sizes: number[] = []
  private bytes = 0
  private readonly limits?: { measure(value: Value): number; maxBytes: number }
  private readonly capacity: number
  readonly epoch: string
  constructor(epoch: string, capacity = 256, limits?: { measure(value: Value): number; maxBytes: number }) {
    if (!epoch || !Number.isInteger(capacity) || capacity < 1 || capacity > 4096) throw new RangeError('Invalid resume log')
    if (limits && (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1 || limits.maxBytes > 16_777_216))
      throw new RangeError('Invalid resume byte budget')
    this.epoch = epoch
    this.capacity = capacity
    this.limits = limits
  }
  currentSequence(): number {
    return this.sequence
  }
  append(value: Value): Sequenced<Value> {
    if (this.sequence >= Number.MAX_SAFE_INTEGER) throw new RangeError('Sequence exhausted')
    const size = this.limits?.measure(value) ?? 0
    if (!Number.isSafeInteger(size) || size < 0 || (this.limits && size > this.limits.maxBytes))
      throw new RangeError('Resume event too large')
    const event = { sequence: ++this.sequence, value }
    this.history.push(event)
    this.sizes.push(size)
    this.bytes += size
    while (this.history.length > this.capacity || (this.limits && this.bytes > this.limits.maxBytes)) {
      this.history.shift()
      this.bytes -= this.sizes.shift()!
    }
    return event
  }
  resume(
    epoch: string,
    after: number,
    snapshot: () => Value,
  ): { kind: 'events'; epoch: string; events: Sequenced<Value>[] } | { kind: 'snapshot'; epoch: string; sequence: number; value: Value } {
    if (!Number.isSafeInteger(after) || after < 0) throw new RangeError('Invalid resume sequence')
    const oldest = this.history[0]?.sequence ?? this.sequence + 1
    return epoch === this.epoch && after <= this.sequence && after >= oldest - 1
      ? { kind: 'events', epoch: this.epoch, events: this.history.filter(event => event.sequence > after) }
      : { kind: 'snapshot', epoch: this.epoch, sequence: this.sequence, value: snapshot() }
  }
}
export class PathGeneration {
  private race = 0
  private network = 0
  changeNetwork(): void {
    this.network++
    this.race++
  }
  begin(): { race: number; network: number } {
    return { race: ++this.race, network: this.network }
  }
  current(generation: { race: number; network: number }): boolean {
    return generation.race === this.race && generation.network === this.network
  }
}
