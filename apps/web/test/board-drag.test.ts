import { describe, expect, it } from 'vitest'
import type { TaskSummary, WorkItemSummary } from '@latch/protocol'
import { dropAction, dropTargets, type DropFacts } from '../src/board/drag.ts'
import type { BoardCard } from '../src/board/model.ts'

const ALL: DropFacts = { canStart: true, canMark: true, unconfirmed: false, stopping: false }
const AT = '2026-11-17T08:00:00.000Z'

const item = (board: WorkItemSummary['board'], extra: Partial<WorkItemSummary> = {}): BoardCard => {
  const value: WorkItemSummary = {
    id: 'itm_AAAAAAAAAAAAAAAAAAAAAA',
    title: '整理发布说明',
    sessionIds: board.group === 'todo' ? [] : ['s1'],
    createdAt: AT,
    updatedAt: AT,
    revision: 4,
    board,
    ...extra,
  }
  return { kind: 'item', id: value.id, item: value, sessions: [] }
}
const session = (extra: Partial<TaskSummary>): BoardCard => {
  const task = { id: 's1', title: '重写设置页', status: 'idle', updatedAt: AT, ...extra } as TaskSummary
  return { kind: 'session', id: task.id, task }
}
const targets = (card: BoardCard, facts: DropFacts = ALL) => Object.fromEntries([...dropTargets(card, facts)].map(([g, a]) => [g, a.kind]))

describe('dragging a card on the board', () => {
  it('starts an unstarted 待办 only by dropping it on 进行中', () => {
    const card = item({ group: 'todo' })
    expect(targets(card)).toEqual({ running: 'start' })
    expect(dropAction(card, 'done', ALL)).toBeNull()
    // Without the open new-session input there is nowhere to drop it.
    expect(targets(card, { ...ALL, canStart: false })).toEqual({})
  })

  it('finishes a started 待办 from any column, and reopens only one the person marked done', () => {
    for (const board of [{ group: 'attention', reason: 'failed' }, { group: 'running' }, { group: 'deliver', reason: 'settled' }] as const)
      expect(targets(item(board))).toEqual({ done: 'finish' })
    expect(targets(item({ group: 'done' }, { closedAt: AT }))).toEqual({ running: 'reopen' })
    // 已结束 by its merged pull request: nothing to undo.
    expect(targets(item({ group: 'done' }))).toEqual({})
    expect(targets(item({ group: 'running' }), { ...ALL, canMark: false })).toEqual({})
  })

  it('stops a running session after its confirm, never one already stopping', () => {
    const card = session({ status: 'running', board: { group: 'running', card: true } })
    expect(targets(card)).toEqual({ done: 'stop' })
    expect(targets(card, { ...ALL, stopping: true })).toEqual({})
    expect(targets(card, { ...ALL, canMark: false })).toEqual({})
  })

  it('lets go of a failed run as opened and of unknown results as checked, through attend', () => {
    const failed = session({ status: 'failed', board: { group: 'attention', reason: 'failed', settle: 'run-1', card: true } })
    expect(dropAction(failed, 'done', ALL)).toMatchObject({ kind: 'attend', input: { settle: 'run-1', opened: true } })
    // Opening is reading: a device without the run scope may still say it opened it.
    expect(dropAction(failed, 'done', { ...ALL, canMark: false })).toMatchObject({ input: { settle: 'run-1', opened: true } })
    const unknown = session({ status: 'idle', board: { group: 'attention', reason: 'unknown', settle: 'run-2', card: true } })
    expect(dropAction(unknown, 'done', ALL)).toMatchObject({ kind: 'attend', input: { settle: 'run-2', checked: true } })
    expect(dropAction(unknown, 'done', ALL)).not.toHaveProperty('input.opened')
    expect(dropAction(unknown, 'done', { ...ALL, canMark: false })).toBeNull()
    // A failed run with unknown results leaves in one drop: both markers for the same settlement.
    const both = session({ status: 'failed', board: { group: 'attention', reason: 'unknown', settle: 'run-3', card: true } })
    expect(dropAction(both, 'done', ALL)).toMatchObject({ input: { settle: 'run-3', opened: true, checked: true } })
    // Without the run scope it cannot be checked, and opening alone would leave it where it is.
    expect(dropAction(both, 'done', { ...ALL, canMark: false })).toBeNull()
    // Waiting on an approval or a question, still running, or with no settlement to name: it stays.
    for (const reason of ['approval', 'question', 'silent'] as const)
      expect(targets(session({ status: 'running', board: { group: 'attention', reason, settle: 'r', card: true } }))).toEqual({})
    expect(targets(session({ status: 'failed', board: { group: 'attention', reason: 'failed', card: true } }))).toEqual({})
  })

  it('never takes a drop on 等你处理, 可交付 or 未开始, nor while the card has a write unanswered', () => {
    const cards = [
      item({ group: 'todo' }),
      item({ group: 'running' }),
      item({ group: 'done' }, { closedAt: AT }),
      session({ status: 'running', board: { group: 'running', card: true } }),
      session({ status: 'idle', board: { group: 'deliver', card: true } }),
      session({ status: 'idle', board: { group: 'done', card: true } }),
    ]
    for (const card of cards) {
      for (const group of ['attention', 'deliver', 'todo'] as const) expect(dropAction(card, group, ALL)).toBeNull()
      expect(targets(card, { ...ALL, unconfirmed: true })).toEqual({})
    }
    // A session that has ended or waits to be delivered has nowhere to go.
    expect(targets(cards[4]!)).toEqual({})
    expect(targets(cards[5]!)).toEqual({})
  })
})
