import { describe, expect, it } from 'vitest'
import type { TaskDeltaEvent, TaskDetail, TaskStateEvent } from '@latch/protocol'
import { TaskStreamProjection } from '../src/core/taskStream.ts'
import { ProjectionGuard } from '../src/core/projection.ts'

const time = '2026-11-14T00:00:00.000Z'
function full(revision = 10, stateSeq = 1): TaskStateEvent {
  return {
    type: 'task-state',
    instanceId: 'host-a',
    sessionId: 'session-a',
    revision,
    hostTime: time,
    stream: { protocol: 'delta-v1', subscriptionId: 'subscription-a', stateSeq },
    detail: {
      summary: {
        harnessId: 'standard',
        id: 'session-a',
        title: 'A',
        status: 'running',
        runId: 'run-a',
        updatedAt: time,
        live: { runId: 'run-a', activity: 'model', since: time, lastEventAt: time, lastOutputAt: time },
      },
      messages: [{ id: 'history', role: 'assistant', text: 'Already done' }],
      approvals: [],
      liveText: '中🙂',
      liveMessageId: 'live-a',
      liveReasoning: '想',
      cursor: 2,
      lastOutputAt: time,
    },
  }
}
function delta(revision = 11, baseSeq = 1, offset = 7, append = '文', reasoningOffset = 3): TaskDeltaEvent {
  return {
    type: 'task-delta',
    instanceId: 'host-a',
    sessionId: 'session-a',
    revision,
    hostTime: time,
    stream: { protocol: 'delta-v1', subscriptionId: 'subscription-a', stateSeq: baseSeq + 1 },
    baseSeq,
    runId: 'run-a',
    liveMessageId: 'live-a',
    text: { offset, append },
    reasoning: { offset: reasoningOffset, append: '' },
    cursor: 3,
    updatedAt: time,
    lastOutputAt: time,
    live: { lastEventAt: time, lastOutputAt: time },
  }
}
const message = (value: TaskStateEvent | TaskDeltaEvent) => ({ event: value.type, data: JSON.stringify(value) })
const shadow = () => new TaskStreamProjection('host-a', 'session-a')
function detail(value: ReturnType<TaskStreamProjection['receive']>): TaskDetail {
  expect(value.kind).toBe('detail')
  if (value.kind !== 'detail') throw new Error('Missing test detail')
  return value.detail
}

describe('the SSE shadow separate from published HTTP state', () => {
  it('appends scalars with stable history references and new detail, summary, live and sync objects', () => {
    const stream = shadow()
    const initial = detail(stream.receive(message(full())))
    const before = structuredClone(initial)
    Object.freeze(initial)
    Object.freeze(initial.summary)
    Object.freeze(initial.summary.live)
    Object.freeze(initial.sync)
    const next = detail(stream.receive(message(delta())))
    expect(initial).toEqual(before)
    expect(next).not.toBe(initial)
    expect(next.summary).not.toBe(initial.summary)
    expect(next.summary.live).not.toBe(initial.summary.live)
    expect(next.sync).not.toBe(initial.sync)
    expect(next.messages).toBe(initial.messages)
    expect(next.messages[0]).toBe(initial.messages[0])
    expect(next.liveText).toBe('中🙂文')
    expect(next.liveReasoning).toBe('想')
    expect(next.sync).toMatchObject({ revision: 11, instanceId: 'host-a' })
  })

  it('advances behind newer HTTP without publishing it, preserves equal-revision source priority, then catches up', () => {
    const stream = shadow(),
      guard = new ProjectionGuard()
    guard.bind('host-a')
    guard.select('session-a')
    const ticket = guard.capture()
    const initial = detail(stream.receive(message(full())))
    const http = { ...initial, liveText: 'newer HTTP', sync: { instanceId: 'host-a', revision: 20 } }
    expect(guard.accept(ticket, http, 'http')).toBe(true)
    expect(guard.accept(ticket, initial, 'stream')).toBe(false)
    const behind = detail(stream.receive(message(delta(15))))
    expect(guard.accept(ticket, behind, 'stream')).toBe(false)
    const ties = detail(stream.receive(message(delta(20, 2, 10, '字'))))
    expect(ties.liveText).toBe('中🙂文字')
    expect(guard.accept(ticket, ties, 'stream')).toBe(true)
    expect(guard.accept(ticket, http, 'http')).toBe(false)
    const duplicateRevision = detail(stream.receive(message(delta(20, 3, 13, '!'))))
    expect(guard.accept(ticket, duplicateRevision, 'stream')).toBe(false)
    const ahead = detail(stream.receive(message(delta(21, 4, 14, '?'))))
    expect(ahead.liveText).toBe('中🙂文字!?')
    expect(guard.accept(ticket, ahead, 'stream')).toBe(true)
    guard.select('session-b')
    guard.select('session-a')
    expect(guard.accept(ticket, ahead, 'stream')).toBe(false)
  })

  it.each([
    [
      'missing baseline sequence',
      (event: TaskDeltaEvent) => {
        event.baseSeq = 2
        event.stream.stateSeq = 3
      },
    ],
    [
      'wrong UTF-8 offset',
      (event: TaskDeltaEvent) => {
        event.text.offset = 3
      },
    ],
    [
      'wrong reasoning offset',
      (event: TaskDeltaEvent) => {
        event.reasoning!.offset = 1
      },
    ],
    [
      'different subscription',
      (event: TaskDeltaEvent) => {
        event.stream.subscriptionId = 'subscription-b'
      },
    ],
    [
      'different run',
      (event: TaskDeltaEvent) => {
        event.runId = 'run-b'
      },
    ],
    [
      'different live ID',
      (event: TaskDeltaEvent) => {
        event.liveMessageId = 'live-b'
      },
    ],
    [
      'old revision',
      (event: TaskDeltaEvent) => {
        event.revision = 9
      },
    ],
    [
      'invalid sequence',
      (event: TaskDeltaEvent) => {
        event.stream.stateSeq = Number.MAX_SAFE_INTEGER + 1
      },
    ],
    [
      'negative offset',
      (event: TaskDeltaEvent) => {
        event.text.offset = -1
      },
    ],
    [
      'non-scalar suffix',
      (event: TaskDeltaEvent) => {
        event.text.append = '\ud800'
      },
    ],
    [
      'unknown operation field',
      (event: TaskDeltaEvent) => {
        Reflect.set(event, 'path', '/messages/0/text')
      },
    ],
    [
      'unknown nested field',
      (event: TaskDeltaEvent) => {
        Reflect.set(event.text, 'replace', true)
      },
    ],
    [
      'missing reasoning',
      (event: TaskDeltaEvent) => {
        event.reasoning = null
      },
    ],
    [
      'missing live',
      (event: TaskDeltaEvent) => {
        event.live = null
      },
    ],
    [
      'invalid clock',
      (event: TaskDeltaEvent) => {
        event.updatedAt = 'not-time'
      },
    ],
  ])('refuses %s without touching the last published detail', (_name, mutate) => {
    const stream = shadow()
    const initial = detail(stream.receive(message(full())))
    const before = structuredClone(initial)
    const invalid = delta()
    mutate(invalid)
    expect(stream.receive(message(invalid))).toEqual({ kind: 'repair' })
    expect(initial).toEqual(before)
  })

  it('does not append a repeated event, nor events belonging to another Host or selection', () => {
    const stream = shadow()
    stream.receive(message(full()))
    const appended = detail(stream.receive(message(delta())))
    expect(stream.receive(message(delta()))).toEqual({ kind: 'ignore' })
    expect(stream.receive(message({ ...delta(), instanceId: 'another-host' }))).toEqual({ kind: 'ignore' })
    expect(stream.receive(message({ ...delta(), sessionId: 'session-b' }))).toEqual({ kind: 'ignore' })
    expect(appended.liveText).toBe('中🙂文')
  })

  it('requires an acknowledged baseline after reset and accepts full terminal evidence with the same message ID once', () => {
    const stream = shadow()
    expect(stream.receive(message(delta()))).toEqual({ kind: 'repair' })
    stream.receive(message(full()))
    stream.receive(message(delta()))
    stream.reset()
    expect(stream.receive(message(delta(12, 2, 10)))).toEqual({ kind: 'repair' })
    const next = full(12)
    next.stream!.subscriptionId = 'subscription-b'
    stream.receive(message(next))
    const final = full(13, 2)
    final.stream!.subscriptionId = 'subscription-b'
    final.detail.summary.status = 'idle'
    final.detail.messages.push({ id: 'live-a', role: 'assistant', text: '中🙂文' })
    final.detail.liveText = ''
    delete final.detail.liveMessageId
    delete final.detail.liveReasoning
    const ended = detail(stream.receive(message(final)))
    expect(ended.messages.filter(item => item.id === 'live-a')).toHaveLength(1)
    expect(stream.receive(message(final))).toEqual({ kind: 'ignore' })
  })

  it('accepts legacy full-only servers, but never invents a baseline acknowledgement or repairs an invalid scalar', () => {
    const stream = shadow()
    const legacy = full()
    delete legacy.stream
    expect(detail(stream.receive(message(legacy))).liveText).toBe('中🙂')
    expect(stream.receive(message(delta()))).toEqual({ kind: 'repair' })
    const invalidScalar = full()
    invalidScalar.detail.liveText = '\ud800'
    expect(detail(stream.receive(message(invalidScalar))).liveText).toBe('\ud800')
    expect(stream.receive(message(delta()))).toEqual({ kind: 'repair' })
  })
})
