import { describe, expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { AutoOpenOutputs } from '../src/preview/autoOpenOutputs.ts'
import { parsePreferences } from '../src/preferences.ts'
const active: TaskDetail = {
  summary: { id: 'session', runId: 'run', title: 'title', status: 'running', updatedAt: '' },
  messages: [],
  approvals: [],
  liveText: '',
  cursor: 0,
}
const result: TaskDetail = {
  ...active,
  summary: { ...active.summary, status: 'idle' },
  messages: [
    { id: 'answer', role: 'assistant', text: 'done', outputs: [{ root: 'other', path: 'deck.pptx', kind: 'pptx', change: 'created' }] },
  ],
}
const options = { enabled: true, visible: true, width: 600 }
describe('optional document opening after an observed run', () => {
  it('defaults off and accepts only a boolean preference', () => {
    expect(parsePreferences(null).autoOpenDocuments).toBe(false)
    expect(parsePreferences('{"autoOpenDocuments":"true"}').autoOpenDocuments).toBe(false)
    expect(parsePreferences('{"autoOpenDocuments":true}').autoOpenDocuments).toBe(true)
  })
  it('ignores history, waits for settlement, opens once and keeps the explicit root', () => {
    const tracker = new AutoOpenOutputs()
    expect(tracker.observe(result, options)).toBeUndefined()
    tracker.observe(active, options)
    expect(tracker.observe({ ...result, messages: [{ ...result.messages[0]!, outputsPending: true }] }, options)).toBeUndefined()
    expect(tracker.observe(result, options)).toEqual({ sessionId: 'session', rootId: 'other', reference: 'deck.pptx' })
    expect(tracker.observe(result, options)).toBeUndefined()
  })
  it.each([
    { ...options, enabled: false },
    { ...options, visible: false },
    { ...options, width: 479 },
  ])('does not open later when the completion was ineligible', gate => {
    const tracker = new AutoOpenOutputs()
    tracker.observe(active, gate)
    expect(tracker.observe(result, gate)).toBeUndefined()
    expect(tracker.observe(result, options)).toBeUndefined()
  })
  it('ignores failure, modified files and runs that finished while another session was selected', () => {
    const tracker = new AutoOpenOutputs()
    tracker.observe(active, options)
    expect(tracker.observe({ ...result, summary: { ...result.summary, status: 'failed' } }, options)).toBeUndefined()
    tracker.observe({ ...active, summary: { ...active.summary, runId: 'second' } }, options)
    expect(
      tracker.observe(
        {
          ...result,
          summary: { ...result.summary, runId: 'second' },
          messages: [{ ...result.messages[0]!, outputs: [{ ...result.messages[0]!.outputs![0]!, change: 'modified' }] }],
        },
        options,
      ),
    ).toBeUndefined()
    tracker.observe(active, options)
    tracker.observe(null, options)
    expect(tracker.observe(result, options)).toBeUndefined()
  })
})
