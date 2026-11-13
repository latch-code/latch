import {
  MAX_TASK_DELTA_BYTES,
  MAX_TASK_TEXT_BYTES,
  scalarUtf8Length,
  TASK_DELTA_PROTOCOL,
  taskDelta,
  type TaskDeltaEvent,
  type TaskStateEvent,
  type TaskStreamStamp,
} from '@latch/protocol'

interface Baseline {
  stateSeq: number
  revision: number
  instanceId: string
  sessionId: string
  runId: string
  liveMessageId: string
  signature: string
  text: string
  reasoning: string | undefined
  textBytes: number
  reasoningBytes: number | undefined
  bytes: number
}

/** One snapshot per retained subscription, with independent count, total-byte and per-entry limits. */
export class TaskDeltaCache {
  private readonly entries = new Map<string, Baseline>()
  private retainedBytes = 0
  constructor(private readonly limits = { maxEntries: 128, maxBytes: 33_554_432, perEntryBytes: 4_194_304 }) {}
  get size(): number {
    return this.entries.size
  }
  get bytes(): number {
    return this.retainedBytes
  }
  get(id: string): Baseline | undefined {
    return this.entries.get(id)
  }
  clear(id: string): void {
    const previous = this.entries.get(id)
    if (previous) this.retainedBytes -= previous.bytes
    this.entries.delete(id)
  }
  put(id: string, value: Baseline | undefined): void {
    this.clear(id)
    if (
      !value
      || value.bytes > this.limits.perEntryBytes
      || this.size >= this.limits.maxEntries
      || value.bytes > this.limits.maxBytes - this.bytes
    )
      return
    this.entries.set(id, value)
    this.retainedBytes += value.bytes
  }
}

/** Unknown fields remain in this immutable signature. Only the documented scalar append/clock fields are removed. */
function capture(event: TaskStateEvent, stateSeq: number): Baseline | undefined {
  const { detail, revision, hostTime: _hostTime, stream: _stream, ...envelope } = event
  const { liveText, liveReasoning, cursor: _cursor, lastOutputAt: _output, sync, summary, ...facts } = detail
  const { updatedAt: _updated, live, ...summaryFacts } = summary
  if (
    summary.status !== 'running'
    || !summary.runId
    || (live !== undefined && live.runId !== summary.runId)
    || !detail.liveMessageId
    || detail.messages.some(message => message.id === detail.liveMessageId)
  )
    return
  const textBytes = scalarUtf8Length(liveText)
  const reasoningBytes = liveReasoning === undefined ? undefined : scalarUtf8Length(liveReasoning)
  if (
    textBytes === undefined
    || textBytes > MAX_TASK_TEXT_BYTES
    || (liveReasoning !== undefined && (reasoningBytes === undefined || reasoningBytes > MAX_TASK_TEXT_BYTES))
  )
    return
  const { lastEventAt: _event, lastOutputAt: _liveOutput, ...liveFacts } = live ?? {}
  const { instanceId: _instance, revision: _revision, hostTime: _time, ...syncFacts } = sync ?? {}
  const signature = JSON.stringify([
    envelope,
    facts,
    summaryFacts,
    live ? liveFacts : null,
    sync ? syncFacts : null,
    liveReasoning !== undefined,
  ])
  return {
    stateSeq,
    revision,
    instanceId: event.instanceId,
    sessionId: event.sessionId,
    runId: summary.runId,
    liveMessageId: detail.liveMessageId,
    signature,
    text: liveText,
    reasoning: liveReasoning,
    textBytes,
    reasoningBytes,
    bytes: 2 * (signature.length + liveText.length + (liveReasoning?.length ?? 0)) + 512,
  }
}

/** Called only after the current device projection is authorized. No shared event is stamped or mutated. */
export class TaskDeltaStream {
  private stateSeq = 0
  constructor(
    readonly subscriptionId: string,
    private readonly cache: TaskDeltaCache,
  ) {}
  clear(): void {
    this.cache.clear(this.subscriptionId)
  }

  encode(event: TaskStateEvent): TaskStateEvent | TaskDeltaEvent {
    // Reaching this bound is not practically possible, but it must never produce an unsafe integer on the wire.
    if (this.stateSeq >= Number.MAX_SAFE_INTEGER) {
      this.clear()
      return event
    }
    const previous = this.cache.get(this.subscriptionId)
    const nextSeq = ++this.stateSeq
    const next = capture(event, nextSeq)
    const stream: TaskStreamStamp = { protocol: TASK_DELTA_PROTOCOL, subscriptionId: this.subscriptionId, stateSeq: nextSeq }
    let incremental: TaskDeltaEvent | undefined
    if (
      previous
      && next
      && next.revision >= previous.revision
      && next.signature === previous.signature
      && next.text.startsWith(previous.text)
      && (next.reasoning === undefined
        ? previous.reasoning === undefined
        : previous.reasoning !== undefined && next.reasoning.startsWith(previous.reasoning))
    ) {
      const text = { offset: previous.textBytes, append: next.text.slice(previous.text.length) }
      const reasoning =
        next.reasoning === undefined ? null : { offset: previous.reasoningBytes!, append: next.reasoning.slice(previous.reasoning!.length) }
      const growth = next.textBytes - previous.textBytes + ((next.reasoningBytes ?? 0) - (previous.reasoningBytes ?? 0))
      if (growth <= MAX_TASK_DELTA_BYTES)
        incremental = taskDelta({
          type: 'task-delta',
          instanceId: event.instanceId,
          sessionId: event.sessionId,
          revision: event.revision,
          hostTime: event.hostTime,
          stream,
          baseSeq: previous.stateSeq,
          runId: next.runId,
          liveMessageId: next.liveMessageId,
          text,
          reasoning,
          cursor: event.detail.cursor,
          updatedAt: event.detail.summary.updatedAt,
          lastOutputAt: event.detail.lastOutputAt ?? null,
          live: event.detail.summary.live
            ? {
                lastEventAt: event.detail.summary.live.lastEventAt,
                lastOutputAt: event.detail.summary.live.lastOutputAt ?? null,
              }
            : null,
        })
    }
    this.cache.put(this.subscriptionId, next)
    return incremental ?? { ...event, stream }
  }
}
