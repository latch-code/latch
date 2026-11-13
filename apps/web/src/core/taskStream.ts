import {
  MAX_TASK_TEXT_BYTES,
  scalarUtf8Length,
  taskDelta,
  taskStreamStamp,
  type TaskDetail,
  type TaskStateEvent,
  type TaskStreamStamp,
} from '@latch/protocol'
import type { StreamEvent } from './eventStream.ts'
import { parseTaskState } from './projection.ts'

interface Baseline {
  event: TaskStateEvent
  stream: TaskStreamStamp
  textBytes: number | undefined
  reasoningBytes: number | undefined
}
export type TaskStreamResult = { kind: 'detail'; detail: TaskDetail } | { kind: 'ignore' } | { kind: 'repair' }

/** A connection's immutable shadow, separate from HTTP and the currently published ProjectionGuard state. */
export class TaskStreamProjection {
  private baseline: Baseline | undefined
  constructor(
    private readonly instanceId: string,
    private readonly sessionId: string,
  ) {}
  reset(): void {
    this.baseline = undefined
  }

  receive(message: StreamEvent): TaskStreamResult {
    if (message.event === 'task-state') return this.full(message.data)
    if (message.event !== 'task-delta') return { kind: 'ignore' }
    // A valid bounded suffix is far below this bound even if every character needs JSON escaping.
    if (message.data.length > 1_048_576) return { kind: 'repair' }
    let parsed: unknown
    try {
      parsed = JSON.parse(message.data)
    } catch {
      return { kind: 'repair' }
    }
    const delta = taskDelta(parsed)
    if (!delta) return { kind: 'repair' }
    if (delta.instanceId !== this.instanceId || delta.sessionId !== this.sessionId) return { kind: 'ignore' }
    const previous = this.baseline
    if (!previous || delta.stream.subscriptionId !== previous.stream.subscriptionId) return { kind: 'repair' }
    if (delta.stream.stateSeq <= previous.stream.stateSeq) return { kind: 'ignore' }
    const detail = previous.event.detail
    if (
      delta.baseSeq !== previous.stream.stateSeq
      || delta.revision < previous.event.revision
      || detail.summary.status !== 'running'
      || detail.summary.runId !== delta.runId
      || detail.liveMessageId !== delta.liveMessageId
      || previous.textBytes === undefined
      || delta.text.offset !== previous.textBytes
      || (delta.reasoning === null
        ? detail.liveReasoning !== undefined
        : detail.liveReasoning === undefined || previous.reasoningBytes === undefined || delta.reasoning.offset !== previous.reasoningBytes)
      || (delta.live === null
        ? detail.summary.live !== undefined
        : detail.summary.live === undefined || detail.summary.live.runId !== delta.runId)
    )
      return { kind: 'repair' }

    const { lastOutputAt: _oldOutput, ...retained } = detail
    const { lastOutputAt: _oldLiveOutput, ...oldLive } = detail.summary.live ?? {}
    const next: TaskDetail = {
      ...retained,
      summary: {
        ...detail.summary,
        updatedAt: delta.updatedAt,
        ...(delta.live
          ? {
              live: {
                ...(oldLive as NonNullable<TaskDetail['summary']['live']>),
                lastEventAt: delta.live.lastEventAt,
                ...(delta.live.lastOutputAt !== null ? { lastOutputAt: delta.live.lastOutputAt } : {}),
              },
            }
          : {}),
      },
      liveText: detail.liveText + delta.text.append,
      ...(delta.reasoning ? { liveReasoning: detail.liveReasoning! + delta.reasoning.append } : {}),
      cursor: delta.cursor,
      ...(delta.lastOutputAt !== null ? { lastOutputAt: delta.lastOutputAt } : {}),
      sync: { ...detail.sync, instanceId: delta.instanceId, revision: delta.revision, hostTime: delta.hostTime },
    }
    this.baseline = {
      event: {
        type: 'task-state',
        instanceId: delta.instanceId,
        sessionId: delta.sessionId,
        revision: delta.revision,
        hostTime: delta.hostTime,
        stream: delta.stream,
        detail: next,
      },
      stream: delta.stream,
      textBytes: previous.textBytes + scalarUtf8Length(delta.text.append)!,
      reasoningBytes: delta.reasoning === null ? undefined : previous.reasoningBytes! + scalarUtf8Length(delta.reasoning.append)!,
    }
    return { kind: 'detail', detail: next }
  }

  private full(data: string): TaskStreamResult {
    const event = parseTaskState(data)
    if (!event) return { kind: 'repair' }
    if (event.instanceId !== this.instanceId || event.sessionId !== this.sessionId) return { kind: 'ignore' }
    if (event.stream === undefined) {
      // No acknowledgement means the old full-state protocol, not permission to guess a delta baseline.
      this.reset()
      return { kind: 'detail', detail: event.detail }
    }
    const stream = taskStreamStamp(event.stream)
    if (!stream) return { kind: 'repair' }
    if (this.baseline) {
      if (stream.subscriptionId !== this.baseline.stream.subscriptionId) return { kind: 'repair' }
      if (stream.stateSeq <= this.baseline.stream.stateSeq) return { kind: 'ignore' }
      if (event.revision < this.baseline.event.revision) return { kind: 'repair' }
    }
    const textBytes = scalarUtf8Length(event.detail.liveText)
    const reasoningBytes = typeof event.detail.liveReasoning === 'string' ? scalarUtf8Length(event.detail.liveReasoning) : undefined
    this.baseline = {
      event,
      stream,
      textBytes: textBytes !== undefined && textBytes <= MAX_TASK_TEXT_BYTES ? textBytes : undefined,
      reasoningBytes: reasoningBytes !== undefined && reasoningBytes <= MAX_TASK_TEXT_BYTES ? reasoningBytes : undefined,
    }
    return { kind: 'detail', detail: event.detail }
  }
}
