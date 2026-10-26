import { ResumeLog } from '@latch/link-wire'
import type { ChangeEvent, TaskStateEvent } from '@latch/protocol'

type Event = ChangeEvent | TaskStateEvent
/** One bounded Host-run history, before per-reader selection. Never stores credentials or request bodies. */
export class NativeReplay {
  private readonly log: ResumeLog<{ event: Event; frame: string }>
  private readonly entries = new WeakMap<Event, { sequence: number; frame: string }>()
  constructor(readonly epoch: string) {
    this.log = new ResumeLog(epoch, 256, { maxBytes: 2_097_152, measure: value => Buffer.byteLength(value.frame) })
  }
  publish(event: Event): Event {
    let payload = JSON.stringify(event)
    if (Buffer.byteLength(payload) > 1_048_000)
      payload = JSON.stringify({ type: 'refresh', instanceId: event.instanceId, revision: event.revision })
    // Keep an immutable serialization, so a driver cannot mutate retained history after the size check.
    const value = JSON.parse(payload) as Event
    const sequence = this.log.currentSequence() + 1,
      frame = `id: ${this.epoch}:${sequence}\nevent: ${value.type}\ndata: ${payload}\n\n`
    const entry = this.log.append({ event: value, frame })
    this.entries.set(value, { sequence: entry.sequence, frame })
    return value
  }
  cursor(): string {
    return `${this.epoch}:${this.log.currentSequence()}`
  }
  frame(event: Event): string | undefined {
    return this.entries.get(event)?.frame
  }
  resume(epoch: string, after: number, sessionId: string | undefined): { kind: 'events'; events: Event[] } | { kind: 'checkpoint' } {
    const result = this.log.resume(epoch, after, () => ({
      event: { type: 'refresh' as const, instanceId: this.epoch, revision: 0 },
      frame: '',
    }))
    if (result.kind !== 'events') return { kind: 'checkpoint' }
    return {
      kind: 'events',
      events: result.events
        .map(item => item.value.event)
        .filter(event =>
          event.type === 'task-state' ? event.sessionId === sessionId : event.type !== 'tasks-invalidated' || event.sessionId !== sessionId,
        ),
    }
  }
}
