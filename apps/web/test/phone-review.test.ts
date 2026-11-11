import { describe, expect, it } from 'vitest'
import type { ReviewNoteCounts, TaskSummary, TurnChanges } from '@latch/protocol'
import type { DiffLine } from '../src/diff.ts'
import { footAction, reviewShortcut, shortcutCandidates, stepFile, tapLine } from '../src/phone-review/model.ts'

const task = (extra: Partial<TaskSummary> = {}): TaskSummary => ({
  id: 's1',
  title: 'Rates',
  status: 'idle',
  updatedAt: '2026-11-12T10:00:00.000Z',
  mode: 'agent',
  harnessId: 'fake',
  ...extra,
})
const turn = (extra: Partial<TurnChanges> = {}): TurnChanges => ({
  turnId: 't1',
  startedAt: '2026-11-12T09:59:00.000Z',
  state: 'settled',
  files: 2,
  ...extra,
})
const counts = (extra: Partial<ReviewNoteCounts> = {}): ReviewNoteCounts => ({
  sessionId: 's1',
  pending: 0,
  sent: 0,
  claimed: 0,
  reviewed: 0,
  revision: 1,
  ...extra,
})
const add = (newLine: number): DiffLine => ({ kind: 'add', text: `line ${newLine}`, newLine })
const remove = (oldLine: number): DiffLine => ({ kind: 'remove', text: `old ${oldLine}`, oldLine })

describe('the phone list’s 复核 shortcut', () => {
  it('offers a settled turn’s files only while they are new to this device', () => {
    expect(reviewShortcut(task(), { unread: true, turns: [turn()] })).toEqual({ label: '复核 2 处改动', files: 2 })
    expect(reviewShortcut(task(), { unread: false, turns: [turn()] })).toBeUndefined()
    // The latest turn decides: an earlier one with files does not count once a later one changed nothing.
    expect(reviewShortcut(task(), { unread: true, turns: [turn(), turn({ turnId: 't2', files: 0 })] })).toBeUndefined()
  })

  it('says nothing for a turn still being recorded, one undone, a running session, a chat or a read-only one', () => {
    expect(reviewShortcut(task(), { unread: true, turns: [turn({ state: 'running', files: undefined })] })).toBeUndefined()
    expect(reviewShortcut(task(), { unread: true, turns: [turn({ undone: true })] })).toBeUndefined()
    expect(reviewShortcut(task({ status: 'running' }), { unread: true, turns: [turn()] })).toBeUndefined()
    expect(reviewShortcut(task({ status: 'waiting-approval' }), { unread: true, turns: [turn()] })).toBeUndefined()
    expect(reviewShortcut(task({ mode: 'chat' }), { unread: true, turns: [turn()] })).toBeUndefined()
    expect(reviewShortcut(task({ personal: { assistantId: 'a' } }), { unread: true, turns: [turn()] })).toBeUndefined()
    expect(reviewShortcut(task({ archived: true }), { unread: true, turns: [turn()] })).toBeUndefined()
  })

  it('goes by the notes alone where the turns cannot be read, without a count', () => {
    // Notes the person wrote and has not sent wait on them whether or not the session moved.
    expect(reviewShortcut(task(), { unread: false, notes: counts({ pending: 1 }) })).toEqual({ label: '复核改动' })
    // Notes sent and back from the Agent wait until the person marks them reviewed.
    expect(reviewShortcut(task(), { unread: false, notes: counts({ sent: 2, claimed: 1 }) })).toEqual({ label: '复核改动' })
    expect(reviewShortcut(task(), { unread: true, notes: counts({ reviewed: 3 }) })).toBeUndefined()
    // With the turns read, the count still comes from the latest turn.
    expect(reviewShortcut(task(), { unread: false, turns: [turn()], notes: counts({ sent: 1 }) })).toEqual({
      label: '复核 2 处改动',
      files: 2,
    })
  })

  it('asks the Host only about settled sessions with something new or notes waiting, newest first and bounded', () => {
    const tasks = [
      task({ id: 'old', updatedAt: '2026-11-12T08:00:00.000Z' }),
      task({ id: 'new', updatedAt: '2026-11-12T11:00:00.000Z' }),
      task({ id: 'running', status: 'running' }),
      task({ id: 'read' }),
      task({ id: 'notes' }),
      task({ id: 'sent', updatedAt: '2026-11-12T07:00:00.000Z' }),
    ]
    const unread = new Set(['old', 'new', 'running'])
    const picked = shortcutCandidates(tasks, {
      isUnread: item => unread.has(item.id),
      notes: [
        counts({ sessionId: 'notes', pending: 1 }),
        counts({ sessionId: 'sent', sent: 1 }),
        counts({ sessionId: 'read', reviewed: 2 }),
      ],
    })
    expect(picked.map(item => item.id)).toEqual(['new', 'notes', 'old', 'sent'])
    expect(shortcutCandidates(tasks, { isUnread: item => unread.has(item.id), limit: 1 }).map(item => item.id)).toEqual(['new'])
  })
})

describe('picking lines by touch', () => {
  it('starts on a tap, stretches on the next, and lets a single line go when tapped again', () => {
    const first = tapLine(undefined, add(42))
    expect(first).toEqual({ side: 'new', start: 42, end: 42, anchor: 42 })
    const stretched = tapLine(first, add(45))
    expect(stretched).toEqual({ side: 'new', start: 42, end: 45, anchor: 42 })
    // Upwards from the same start.
    expect(tapLine(stretched, add(40))).toEqual({ side: 'new', start: 40, end: 42, anchor: 42 })
    expect(tapLine(first, add(42))).toBeUndefined()
  })

  it('starts again on the other side: a removed line has no number among the new ones', () => {
    const first = tapLine(undefined, add(10))
    expect(tapLine(first, remove(7))).toEqual({ side: 'old', start: 7, end: 7, anchor: 7 })
  })

  it('steps through the files without wrapping', () => {
    expect(stepFile(0, 3, 1)).toBe(1)
    expect(stepFile(2, 3, 1)).toBeUndefined()
    expect(stepFile(0, 3, -1)).toBeUndefined()
  })
})

describe('the bottom bar’s one action', () => {
  const base = {
    tally: { ready: 0, sending: 0, queued: 0, sent: 0, toReview: 0 },
    running: false,
    canQueue: true,
    offline: false,
    unknownSend: false,
    canWrite: true,
    canDeliver: true,
  }

  it('sends pending notes now, queues them while a turn runs, or waits where the Host cannot queue', () => {
    const tally = { ...base.tally, ready: 2 }
    expect(footAction({ ...base, tally })).toEqual({ kind: 'send', label: '发给 Agent (2)', count: 2, disabled: false })
    expect(footAction({ ...base, tally, running: true })).toMatchObject({ label: '排到下一轮', disabled: false })
    expect(footAction({ ...base, tally, running: true, canQueue: false })).toMatchObject({ label: '本轮结束后发', disabled: true })
    expect(footAction({ ...base, tally, offline: true })).toMatchObject({ kind: 'send', disabled: true })
  })

  it('puts picked lines first, then a send whose answer never came', () => {
    const tally = { ...base.tally, ready: 1, sending: 1 }
    expect(footAction({ ...base, tally, selection: { start: 3, end: 5 } })).toEqual({ kind: 'note', label: '第 3–5 行' })
    expect(footAction({ ...base, tally, selection: { start: 3, end: 3 } })).toEqual({ kind: 'note', label: '第 3 行' })
    expect(footAction({ ...base, tally, unknownSend: true })).toEqual({ kind: 'unknown', sending: 1 })
  })

  it('goes on to 提交 with what the notes are doing, or holds nothing a device cannot do', () => {
    expect(footAction(base)).toEqual({ kind: 'deliver' })
    expect(footAction({ ...base, running: true, tally: { ...base.tally, sent: 2, toReview: 2 } })).toEqual({
      kind: 'deliver',
      status: { text: 'Agent 在修订 2 条反馈', running: true },
    })
    expect(footAction({ ...base, tally: { ...base.tally, sent: 2, toReview: 2 } })).toEqual({
      kind: 'deliver',
      status: { text: '2 条待你复核', running: false },
    })
    expect(footAction({ ...base, canDeliver: false })).toEqual({ kind: 'none' })
    // A device that reads but cannot write sees no send, and never picks lines to write about.
    expect(footAction({ ...base, canWrite: false, tally: { ...base.tally, ready: 1 }, selection: { start: 1, end: 1 } })).toEqual({
      kind: 'deliver',
    })
  })
})
