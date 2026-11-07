import { describe, expect, it } from 'vitest'
import { childCall, reportedStatus, type Child } from '../src/subagents.ts'

describe('a subagent reporting how it is doing', () => {
  it('reads each reported state, and an unknown one as saying nothing', () => {
    expect(reportedStatus({ state: 'running' })).toBe('running')
    expect(reportedStatus({ state: 'requires_action' })).toBe('waiting')
    expect(reportedStatus({ state: 'unknown' })).toBe('unknown')
    expect(reportedStatus({ state: 'idle', stopReason: 'end_turn' })).toBe('done')
    expect(reportedStatus({ state: 'idle' })).toBe('done')
    expect(reportedStatus({ state: 'idle', stopReason: 'cancelled' })).toBe('cancelled')
    expect(reportedStatus({ state: 'idle', stopReason: 'error' })).toBe('failed')
    expect(reportedStatus({ state: 'idle', stopReason: 'refusal' })).toBe('failed')
    // Failed work ended with end_turn and the error beside it is still a failure.
    expect(reportedStatus({ state: 'idle', stopReason: 'end_turn', error: { code: -32603, message: 'Subagent work failed' } })).toBe(
      'failed',
    )
    expect(reportedStatus({ state: '_vendor_paused' })).toBeUndefined()
  })
})

describe('the calls of a subagent with no step', () => {
  it('keeps each one across its updates, and makes room by forgetting one that ended before one that was asked about', () => {
    const child: Child = { acpSessionId: 'child', taskId: 'task', title: 'Helper', depth: 1, tools: new Map(), loose: new Map() }
    const call = (toolCallId: string, status: string) => childCall(child, undefined, { toolCallId, status }, '2026-01-01T00:00:00.000Z')
    const asked = call('asked', 'pending')
    asked.awaiting = 1
    expect(call('asked', 'in_progress')).toBe(asked)
    call('done', 'completed')
    for (let index = 0; index < 198; index++) call(`running_${index}`, 'in_progress')
    expect(child.loose.size).toBe(200)
    call('next', 'in_progress')
    expect(child.loose.has('done')).toBe(false)
    call('after', 'in_progress')
    expect([child.loose.has('asked'), child.loose.has('running_0'), child.loose.size]).toEqual([true, false, 200])
  })
})
