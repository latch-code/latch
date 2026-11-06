import { describe, expect, it } from 'vitest'
import { reportedStatus } from '../src/subagents.ts'

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
