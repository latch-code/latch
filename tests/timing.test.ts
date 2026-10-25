import { describe, expect, it } from 'vitest'
import { ReasoningTimer, RunClock } from '@latch/core/node-kit'

describe('run timing shared by the drivers', () => {
  it('counts overlapping approval waits once and leaves them out of the working time', () => {
    let time = 0
    const clock = new RunClock(() => time)
    time = 1000
    clock.openWait('a')
    time = 2000
    clock.openWait('b')
    clock.openWait('b')
    time = 3000
    clock.closeWait('a')
    expect(clock.waitMs()).toBe(2000)
    expect(clock.live()).toEqual({ runStartedAt: new Date(0).toISOString(), runWaitMs: 0, runWaitingSince: new Date(1000).toISOString() })
    time = 5000
    clock.closeWait('b')
    clock.closeWait('unknown')
    time = 9000
    expect(clock.live()).toEqual({ runStartedAt: new Date(0).toISOString(), runWaitMs: 4000 })
    expect(clock.turn()).toEqual({ endedAt: new Date(9000).toISOString(), activeMs: 5000, waitMs: 4000 })
  })

  it('measures reasoning from its first chunk to the first text after it, across resumed spans', () => {
    let time = 100
    const timer = new ReasoningTimer(() => time)
    expect(timer.live()).toEqual({})
    timer.reasoning()
    time = 1100
    timer.reasoning()
    expect(timer.live()).toEqual({ liveReasoningStartedAt: new Date(100).toISOString() })
    time = 2100
    timer.text()
    expect(timer.live()).toEqual({ liveReasoningStartedAt: new Date(100).toISOString(), liveReasoningMs: 2000 })
    time = 3000
    timer.reasoning()
    time = 3500
    expect(timer.end()).toBe(2500)
    expect(new ReasoningTimer(() => 0).end()).toBeUndefined()
  })
})
