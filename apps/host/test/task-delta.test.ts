import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { MAX_TASK_DELTA_BYTES, scalarUtf8Length, taskDelta, type TaskStateEvent } from '@latch/protocol'
import { TaskDeltaCache, TaskDeltaStream } from '../src/task-delta.ts'

const first = '2026-11-14T00:00:00.000Z'
function state(text = '正文🙂', revision = 1): TaskStateEvent {
  const at = new Date(Date.parse(first) + revision * 100).toISOString()
  return {
    type: 'task-state',
    instanceId: 'instance-a',
    sessionId: 'session-a',
    revision,
    hostTime: at,
    detail: {
      summary: {
        id: 'session-a',
        harnessId: 'standard',
        title: 'A',
        status: 'running',
        runId: 'run-a',
        updatedAt: at,
        live: { runId: 'run-a', activity: 'model', since: first, lastEventAt: at, lastOutputAt: at },
      },
      messages: [{ id: 'old', role: 'assistant', text: '历史', createdAt: first }],
      approvals: [],
      liveText: text,
      liveReasoning: '思考',
      liveMessageId: 'message-a',
      cursor: revision,
      lastOutputAt: at,
      activity: { phase: 'model', since: first },
      sync: { instanceId: 'instance-a', revision, hostTime: at },
    },
  }
}
const stream = (cache = new TaskDeltaCache()) => new TaskDeltaStream('subscription-a', cache)

describe('scoped text delta encoding', () => {
  it('keeps full states when the live projection cannot confirm the current run identity', () => {
    const encoder = stream()
    const first = state(),
      next = state('正文🙂追加', 2)
    first.detail.summary.live!.runId = 'different-run'
    next.detail.summary.live!.runId = 'different-run'
    expect(encoder.encode(first).type).toBe('task-state')
    expect(encoder.encode(next).type).toBe('task-state')
  })
  it('uses exact UTF-8 offsets and carries all changing clocks without retaining history in the delta', () => {
    const encoder = stream()
    const full = encoder.encode(state())
    expect(full.type).toBe('task-state')
    expect(full.stream?.stateSeq).toBe(1)
    const next = state('正文🙂\r\n续写e\u0301', 8)
    next.detail.liveReasoning = '思考继续'
    const delta = encoder.encode(next)
    expect(taskDelta(delta)).toEqual(delta)
    expect(delta).toMatchObject({
      type: 'task-delta',
      revision: 8,
      baseSeq: 1,
      stream: { stateSeq: 2 },
      text: { offset: 10, append: '\r\n续写e\u0301' },
      reasoning: { offset: 6, append: '继续' },
      live: { lastEventAt: next.hostTime, lastOutputAt: next.hostTime },
    })
    expect(JSON.stringify(delta)).not.toContain('历史')
    expect(encoder.encode(state('正文🙂\r\n续写e\u0301', 9)).type).toBe('task-state') // reasoning regenerated
  })

  it.each([
    [
      'shorter',
      (event: TaskStateEvent) => {
        event.detail.liveText = '正'
      },
    ],
    [
      'same length replacement',
      (event: TaskStateEvent) => {
        event.detail.liveText = '改文🙂'
      },
    ],
    [
      'history in-place edit',
      (event: TaskStateEvent) => {
        event.detail.messages[0]!.text = '不同历史'
      },
    ],
    [
      'history addition',
      (event: TaskStateEvent) => {
        event.detail.messages.push({ id: 'new', role: 'user', text: 'Another' })
      },
    ],
    [
      'approval',
      (event: TaskStateEvent) => {
        event.detail.approvals.push({ id: 'ask', sessionId: 'session-a', toolName: 'write', reason: 'Ask', requestedAt: first })
      },
    ],
    [
      'plan',
      (event: TaskStateEvent) => {
        event.detail.plan = [{ content: 'Next', status: 'pending', priority: 'medium' }]
      },
    ],
    [
      'permission',
      (event: TaskStateEvent) => {
        Reflect.set(event.detail, 'permission', { readback: 'none' })
      },
    ],
    [
      'unknown detail field',
      (event: TaskStateEvent) => {
        Reflect.set(event.detail, 'future', { value: 1 })
      },
    ],
    [
      'unknown summary field',
      (event: TaskStateEvent) => {
        Reflect.set(event.detail.summary, 'future', true)
      },
    ],
    [
      'unknown live field',
      (event: TaskStateEvent) => {
        Reflect.set(event.detail.summary.live!, 'future', true)
      },
    ],
    [
      'unknown sync field',
      (event: TaskStateEvent) => {
        Reflect.set(event.detail.sync!, 'future', true)
      },
    ],
    [
      'unrecognized request',
      (event: TaskStateEvent) => {
        event.detail.summary.live!.unrecognized = { count: 1, at: first }
      },
    ],
    [
      'reasoning disappeared',
      (event: TaskStateEvent) => {
        delete event.detail.liveReasoning
      },
    ],
    [
      'new live identity',
      (event: TaskStateEvent) => {
        event.detail.liveMessageId = 'another-message'
      },
    ],
    [
      'new run',
      (event: TaskStateEvent) => {
        event.detail.summary.runId = 'another-run'
      },
    ],
    [
      'completed',
      (event: TaskStateEvent) => {
        event.detail.summary.status = 'idle'
      },
    ],
    [
      'cancelled',
      (event: TaskStateEvent) => {
        event.detail.summary.status = 'cancelled'
      },
    ],
    [
      'failed',
      (event: TaskStateEvent) => {
        event.detail.summary.status = 'failed'
      },
    ],
    [
      'unpaired surrogate',
      (event: TaskStateEvent) => {
        event.detail.liveText += '\ud800'
      },
    ],
    [
      'large suffix',
      (event: TaskStateEvent) => {
        event.detail.liveText += 'x'.repeat(MAX_TASK_DELTA_BYTES + 1)
      },
    ],
  ])('sends a complete state for %s', (_name, change) => {
    const encoder = stream()
    encoder.encode(state())
    const next = state('正文🙂追加', 2)
    change(next)
    const encoded = encoder.encode(next)
    expect(encoded).toEqual({ ...next, stream: { protocol: 'delta-v1', subscriptionId: 'subscription-a', stateSeq: 2 } })
    expect(next).not.toHaveProperty('stream')
  })

  it('does not compare an aliased mutable Bridge object to itself', () => {
    const encoder = stream()
    const mutable = state()
    encoder.encode(mutable)
    mutable.detail.messages[0]!.text = 'Bridge changed the previous object'
    mutable.detail.liveText += 'added'
    expect(encoder.encode(mutable).type).toBe('task-state')
  })

  it('keeps absent reasoning distinct from an empty present string', () => {
    const encoder = stream()
    const empty = state()
    delete empty.detail.liveReasoning
    encoder.encode(empty)
    const next = structuredClone(empty)
    next.detail.liveText += 'next'
    expect(encoder.encode(next)).toMatchObject({ type: 'task-delta', reasoning: null })
    next.detail.liveReasoning = ''
    expect(encoder.encode(next).type).toBe('task-state')
  })

  it('bounds retained entries and bytes, falls back to full, and releases them synchronously', () => {
    const cache = new TaskDeltaCache({ maxEntries: 1, maxBytes: 10_000, perEntryBytes: 4_000 })
    const a = stream(cache),
      b = new TaskDeltaStream('subscription-b', cache)
    a.encode(state())
    expect(cache.size).toBe(1)
    expect(cache.bytes).toBeGreaterThan(0)
    b.encode(state())
    expect(b.encode(state('正文🙂追加', 2)).type).toBe('task-state')
    expect(cache.size).toBe(1)
    a.clear()
    expect(cache.bytes).toBe(0)
    b.encode(state())
    expect(b.encode(state('正文🙂追加', 3)).type).toBe('task-delta')
    b.encode(state('x'.repeat(4_001)))
    expect(cache.size).toBe(0)
    expect(cache.bytes).toBe(0)
    b.clear()
    expect(cache.bytes).toBe(0)
  })

  it('agrees with the portable Unicode vectors and the platform byte count for scalar strings', async () => {
    const vectors = JSON.parse(await readFile('packages/testkit/vectors/task-delta-v1.json', 'utf8')) as {
      strings: Array<{ text: string; bytes: number | null }>
    }
    for (const vector of vectors.strings) {
      expect(scalarUtf8Length(vector.text)).toBe(vector.bytes ?? undefined)
      if (vector.bytes !== null) expect(Buffer.byteLength(vector.text)).toBe(vector.bytes)
    }
  })
})
