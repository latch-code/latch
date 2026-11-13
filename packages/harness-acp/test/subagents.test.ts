import { describe, expect, it } from 'vitest'
import { opencodeProfile } from '../src/profiles/opencode.ts'
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

describe("OpenCode 2.x's subagent work on the session that started it", () => {
  const profile = opencodeProfile
  const meta = { 'opencode/child-session': { id: 'ses_child', parentID: 'ses_1', depth: 1, title: 'Run the tests' } }

  it('reads the subagent and takes off the prefixes OpenCode adds', () => {
    expect(
      profile.readProjectedChild!({
        sessionUpdate: 'tool_call',
        toolCallId: 'ses_child:call_1',
        title: 'Run the tests: shell',
        _meta: { ...meta, other: true },
      }),
    ).toEqual({
      child: { sessionId: 'ses_child', parentSessionId: 'ses_1', title: 'Run the tests' },
      value: { sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'shell', _meta: { other: true } },
    })
    // A request with no title of its own carries the subagent's alone; an ID or title without the prefix stays.
    expect(profile.readProjectedChild!({ toolCallId: 'call_9', title: 'Run the tests', _meta: meta })?.value).toEqual({
      toolCallId: 'call_9',
    })
    expect(profile.readProjectedChild!({ toolCallId: 'x', title: 'npm test', _meta: meta })?.value).toEqual({
      toolCallId: 'x',
      title: 'npm test',
    })
  })

  it("leaves the session's own work and a mark it cannot read alone", () => {
    expect(profile.readProjectedChild!({ sessionUpdate: 'tool_call', toolCallId: 'call_1' })).toBeUndefined()
    expect(profile.readProjectedChild!({ toolCallId: 'a', _meta: { 'opencode/child-session': { id: 'ses_child' } } })).toBeUndefined()
    expect(profile.readProjectedChild!({ toolCallId: 'a', _meta: { 'opencode/child-session': 'ses_child' } })).toBeUndefined()
  })

  it("reads how a subagent ended from the session's own call, and nothing from one that goes on in the background", () => {
    const end = (status: string, metadata: unknown) =>
      profile.readChildEnd!({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status, rawOutput: { metadata } })
    expect(end('completed', { sessionID: 'ses_child', status: 'completed' })).toEqual({ sessionId: 'ses_child', outcome: 'done' })
    expect(end('completed', { sessionID: 'ses_child', status: 'running' })).toBeUndefined()
    expect(end('failed', { sessionID: 'ses_child', status: 'running' })).toEqual({ sessionId: 'ses_child', outcome: 'failed' })
    expect(end('completed', { exit: 0 })).toBeUndefined()
    expect(end('in_progress', { sessionID: 'ses_child', status: 'completed' })).toBeUndefined()
  })
})

describe("OpenCode's config read-back", () => {
  it('counts a model read back with its level appended as the model asked for, and nothing else', () => {
    const matches = opencodeProfile.configValueMatches!
    expect(matches('model', 'opencode/beam-free', 'opencode/beam-free/high')).toBe(true)
    expect(matches('model', 'opencode/beam-free', 'opencode/beam-free-2')).toBe(false)
    expect(matches('model', 'opencode/beam-free', 'opencode/beam-free/high/x')).toBe(false)
    expect(matches('effort', 'high', 'high/x')).toBe(false)
  })
})
