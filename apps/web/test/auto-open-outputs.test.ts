import { describe, expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { AutoOpenOutputs } from '../src/preview/autoOpenOutputs.ts'
import { parsePreferences } from '../src/preferences.ts'
const active: TaskDetail = {
  summary: { harnessId: 'standard', id: 'session', runId: 'run', title: 'title', status: 'running', updatedAt: '' },
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
const options = { enabled: true, available: true, width: 600 }
describe('optional document opening after an observed run', () => {
  it('opens documents by default and preserves an explicit choice to keep them closed', () => {
    expect(parsePreferences(null).autoOpenDocuments).toBe(true)
    expect(parsePreferences('{"autoOpenDocuments":"true"}').autoOpenDocuments).toBe(true)
    expect(parsePreferences('{"autoOpenDocuments":true}').autoOpenDocuments).toBe(true)
    expect(parsePreferences('{"autoOpenDocuments":false}').autoOpenDocuments).toBe(false)
    expect(parsePreferences('{"theme":"dark"}').autoOpenDocuments).toBe(true)
  })
  it('ignores history, waits for settlement, opens once and keeps the explicit root', () => {
    const tracker = new AutoOpenOutputs()
    expect(tracker.observe(result, options)).toBeUndefined()
    tracker.observe(active, options)
    expect(tracker.observe({ ...result, messages: [{ ...result.messages[0]!, outputsPending: true }] }, options)).toBeUndefined()
    expect(tracker.observe(result, options)).toEqual({
      first: { sessionId: 'session', rootId: 'other', reference: 'deck.pptx' },
      offered: [],
    })
    expect(tracker.observe(result, options)).toBeUndefined()
  })
  it('opens the first new document and offers the rest of the turn', () => {
    const tracker = new AutoOpenOutputs()
    tracker.observe(active, options)
    const outputs = [
      { root: 'r', path: 'a.pptx', kind: 'pptx' as const, change: 'created' as const },
      { root: 'r', path: 'edited.xlsx', kind: 'xlsx' as const, change: 'modified' as const },
      { root: 'r', path: 'b.xlsx', kind: 'xlsx' as const, change: 'created' as const },
    ]
    const opened = tracker.observe({ ...result, messages: [{ ...result.messages[0]!, outputs }] }, options)
    expect(opened?.first.reference).toBe('a.pptx')
    expect(opened?.offered.map(target => target.reference)).toEqual(['b.xlsx'])
  })
  it('opens a new document created before guidance in the same turn', () => {
    const tracker = new AutoOpenOutputs()
    tracker.observe(active, options)
    const opened = tracker.observe(
      {
        ...result,
        messages: [
          { id: 'prompt', role: 'user', text: 'Create the deck' },
          ...result.messages,
          { id: 'guidance', role: 'user', text: 'Use the revised title', steered: true },
          { id: 'reply', role: 'assistant', text: 'Updated the title' },
        ],
      },
      options,
    )
    expect(opened?.first.reference).toBe('deck.pptx')
  })
  it.each([
    { ...options, enabled: false },
    { ...options, available: false },
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
