import { describe, expect, it } from 'vitest'
import type { AppSnapshot, TaskSummary } from '@latch/protocol'
import { checkSettle, openedSettle, unknownChecked } from '../src/core/attend.ts'
import { sessionSource } from '../src/sessionSource.ts'
import { knownTags } from '../src/components/SessionTagsDialog.tsx'

const task = (fields: Partial<TaskSummary> = {}): TaskSummary => ({
  harnessId: 'standard',
  id: 's',
  title: '会话',
  status: 'idle',
  updatedAt: '2026-11-17T00:00:00.000Z',
  ...fields,
})
const held = (reason: 'failed' | 'unknown') => ({ group: 'attention' as const, reason, settle: 'run-1', card: true as const })

describe('打开过', () => {
  it('names the settlement of a failed run the Host still holds, whatever reason comes first', () => {
    expect(openedSettle(task({ status: 'failed', board: held('failed') }))).toBe('run-1')
    expect(openedSettle(task({ status: 'idle', runOutcome: 'failed', board: held('failed') }))).toBe('run-1')
    // Unknown results come first on the Host; opening still marks the failure so 已核对 does not turn it into 失败.
    expect(openedSettle(task({ status: 'failed', board: held('unknown') }))).toBe('run-1')
  })

  it('names nothing for a run that did not fail, one already opened, a live one or an older Host', () => {
    expect(openedSettle(task({ status: 'idle', board: { group: 'attention', reason: 'unknown', settle: 'run-1' } }))).toBeUndefined()
    expect(openedSettle(task({ status: 'failed', board: { group: 'done', settle: 'run-1' } }))).toBeUndefined()
    expect(openedSettle(task({ status: 'running', runOutcome: 'failed', board: held('failed') }))).toBeUndefined()
    expect(openedSettle(task({ status: 'failed' }))).toBeUndefined()
    expect(openedSettle(task({ status: 'failed', board: { group: 'attention', reason: 'failed' } }))).toBeUndefined()
  })
})

describe('已核对', () => {
  it('is offered only while the Host holds the session for unknown results', () => {
    expect(checkSettle(task({ status: 'failed', board: held('unknown') }))).toBe('run-1')
    expect(checkSettle(task({ status: 'failed', board: held('failed') }))).toBeUndefined()
    expect(
      checkSettle(task({ status: 'waiting-approval', board: { group: 'attention', reason: 'approval', settle: 'run-2' } })),
    ).toBeUndefined()
  })

  it('reads as checked once the Host no longer holds it for them, never on an older Host', () => {
    const runEnd = { reason: 'host-stopped' as const, at: '2026-11-17T00:00:00.000Z', unknownResultCount: 1 }
    expect(unknownChecked(task({ status: 'failed', runEnd, board: held('failed') }))).toBe(true)
    expect(unknownChecked(task({ status: 'failed', runEnd, board: held('unknown') }))).toBe(false)
    expect(unknownChecked(task({ status: 'failed', runEnd }))).toBe(false)
    expect(unknownChecked(task({ status: 'failed', runEnd: { ...runEnd, unknownResultCount: 0 }, board: held('failed') }))).toBe(false)
  })
})

type Listed = Pick<AppSnapshot, 'handoffs' | 'tasks' | 'automations' | 'catalog'>
const snapshot = (fields: Partial<Listed>): Listed => ({ tasks: [], ...fields })

describe('来自', () => {
  const forkOf = { taskId: 'src', upToMessageId: 'm', title: '原来的名字', turn: 2, prefixLength: 4 }

  it('names a handoff first, then a fork, then a schedule', () => {
    const handoff = { id: 'h', sourceSessionId: 'from', targetSessionId: 's', status: 'started', updatedAt: '2026-11-17T00:00:00.000Z' }
    const all = snapshot({
      catalog: { features: { handoffs: true } } as AppSnapshot['catalog'],
      handoffs: [handoff] as unknown as AppSnapshot['handoffs'],
      tasks: [task({ id: 'from', title: '交出的会话' })],
      automations: [{ id: 'auto', name: '每日汇总' }] as AppSnapshot['automations'],
    })
    const both = task({ forkOf, automationId: 'auto' })
    expect(sessionSource(all, both)).toEqual({ kind: 'handoff', sessionId: 'from', title: '交出的会话', listed: true })
    expect(sessionSource({ ...all, handoffs: [] }, both)).toMatchObject({ kind: 'fork', sessionId: 'src', listed: false })
    expect(sessionSource({ ...all, handoffs: [] }, task({ automationId: 'auto' }))).toEqual({
      kind: 'schedule',
      automationId: 'auto',
      title: '每日汇总',
      owner: 'general',
    })
  })

  it('links a fork only to a listed source, by its current name, and never names a schedule it is not given', () => {
    expect(sessionSource(snapshot({}), task({ forkOf }))).toEqual({ kind: 'fork', sessionId: 'src', title: '原来的名字', listed: false })
    expect(sessionSource(snapshot({ tasks: [task({ id: 'src', title: '改过的名字' })] }), task({ forkOf }))).toMatchObject({
      title: '改过的名字',
      listed: true,
    })
    expect(sessionSource(snapshot({}), task({ automationId: 'auto' }))).toBeUndefined()
    expect(sessionSource(snapshot({}), task())).toBeUndefined()
  })
})

describe('标签', () => {
  it('offers the tags other sessions carry, most used first', () => {
    expect(knownTags([task({ tags: ['发布', '后端'] }), task({ tags: ['后端'] }), task()])).toEqual(['后端', '发布'])
  })
})
