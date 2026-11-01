import { describe, expect, it } from 'vitest'
import type { ChangeList, ChangedFile, FileChange, Message, TurnChanges } from '@latch/protocol'
import {
  changedOutputs,
  firstOpenable,
  matchTurnChanges,
  notRestoredLine,
  producedFiles,
  turnSummary,
  redoBlockWords,
  undoBlockWords,
  undoExceptions,
} from '../src/conversation/turnChanges.ts'
import { turnsOf } from '../src/conversation.ts'

const T0 = Date.parse('2026-10-26T14:00:00.000Z')
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()
const prompt = (id: string, seconds: number): Message => ({ id, role: 'user', text: id, createdAt: at(seconds) })
const record = (turnId: string, seconds: number, extra: Partial<TurnChanges> = {}): TurnChanges => ({
  turnId,
  startedAt: at(seconds),
  state: 'settled',
  files: 1,
  ...extra,
})

describe('matching a turn to its record', () => {
  const turns = turnsOf([prompt('u1', 0), prompt('u2', 100), prompt('u3', 200)])

  it('gives each prompt the run that started at it, whichever came first by a moment', () => {
    const matched = matchTurnChanges(turns, [record('r1', 1), record('r2', 99), record('r3', 203)])
    expect(matched.get('u1')?.turnId).toBe('r1')
    expect(matched.get('u2')?.turnId).toBe('r2')
    expect(matched.get('u3')?.turnId).toBe('r3')
  })

  it('gives a turn no record when two runs fall in it, because an undo must not guess', () => {
    const matched = matchTurnChanges(turns, [record('r1', 1), record('r1b', 50)])
    expect(matched.has('u1')).toBe(false)
  })

  it('leaves a record out when it started before any prompt, and a history without times matches nothing', () => {
    expect(matchTurnChanges(turns, [record('old', -100)]).size).toBe(0)
    expect(matchTurnChanges(turnsOf([{ id: 'u', role: 'user', text: 'u' }]), [record('r', 0)]).size).toBe(0)
  })

  it('takes the latest turn from the run the session names, whatever the times say', () => {
    const matched = matchTurnChanges(turns, [record('r1', 1), record('now', 150)], 'now')
    expect(matched.get('u3')?.turnId).toBe('now')
    expect(matched.has('u2')).toBe(false)
  })
})

const changed = (path: string, extra: Partial<ChangedFile> = {}): ChangedFile => ({ root: 'main', path, status: 'M', ...extra })
const list = (files: ChangedFile[], extra: Partial<ChangeList> = {}): ChangeList => ({
  scope: 'turn',
  files,
  totals: { files: files.length, add: 64, del: 8 },
  ...extra,
})

describe("a turn's summary", () => {
  const turn = turnsOf([
    prompt('u', 0),
    {
      id: 't1',
      role: 'tool',
      text: '',
      state: 'completed',
      tool: { kind: 'edit', diffs: [{ path: 'a.ts', oldText: 'x\n', newText: 'y\n' }] },
    },
    {
      id: 't2',
      role: 'tool',
      text: '',
      state: 'completed',
      tool: { kind: 'edit', diffs: [{ path: 'a.ts', oldText: 'y\n', newText: 'z\nw\n' }] },
    },
    {
      id: 't3',
      role: 'tool',
      text: '',
      state: 'failed',
      tool: { kind: 'edit', diffs: [{ path: 'rejected.ts', newText: 'n' }], decision: { outcome: 'rejected', at: at(1) } },
    },
  ])[0]!

  it("takes the Host's record over anything the turn says about itself", () => {
    const summary = turnSummary(turn, list([changed('b.ts', { add: 3, del: 1, byCommand: true })]), [])
    expect(summary).toEqual({ files: [{ root: 'main', path: 'b.ts', add: 3, del: 1, byCommand: true }], add: 64, del: 8 })
  })

  it('without a record sums what its edits applied, and never a call its approval kept from running', () => {
    expect(turnSummary(turn, undefined, [])).toEqual({ files: [{ path: 'a.ts', add: 3, del: 2 }], add: 3, del: 2 })
  })

  it('adds the files seen to change, and then has no total to claim', () => {
    const summary = turnSummary(turn, undefined, [{ root: 'main', path: 'seen.txt', change: 'modified' }])
    expect(summary.files.map(file => file.path)).toEqual(['a.ts', 'seen.txt'])
    expect(summary.add).toBeUndefined()
  })

  it("leaves out what was seen once the Host's record says the turn changed nothing, but not its own edits", () => {
    const seen: FileChange[] = [{ root: 'main', path: 'other-session.ts', change: 'modified' }]
    const nothing = record('r1', 0, { state: 'settled', files: 0 })
    expect(turnSummary(turn, undefined, changedOutputs(nothing, seen)).files.map(file => file.path)).toEqual(['a.ts'])
    expect(changedOutputs(record('r1', 0, { state: 'settled', files: 2 }), seen)).toEqual(seen)
    expect(changedOutputs(record('r1', 0, { state: 'running' }), seen)).toEqual(seen)
    expect(changedOutputs(undefined, seen)).toEqual(seen)
  })

  it('offers only new documents to open', () => {
    expect(
      producedFiles([
        { root: 'm', path: 'a.pptx', change: 'created', kind: 'pptx' },
        { root: 'm', path: 'b.pptx', change: 'modified', kind: 'pptx' },
        { root: 'm', path: 'c.ts', change: 'created', kind: 'code' },
        { root: 'm', path: 'd', change: 'created' },
      ]).map(file => file.path),
    ).toEqual(['a.pptx'])
  })
})

describe('undo', () => {
  it('says beforehand what it will not restore, and nothing when it can restore everything', () => {
    expect(undoExceptions(list([changed('a.ts')]))).toEqual([])
    expect(
      undoExceptions(list([changed('a.bin', { notRetained: true }), changed('.env', { secret: true })], { notCovered: ['/tmp/x'] })),
    ).toEqual(['a.bin · 内容没有留存', '.env · 可能含密钥，不写也不删', '/tmp/x · 在文件夹之外或被忽略'])
  })

  it('counts every file left as it was, though a receipt names only the first of them', () => {
    const named = Array.from({ length: 200 }, (_, index) => ({ root: 'main', path: `f${index}`, reason: 'not-retained' as const }))
    expect(notRestoredLine({ skipped: 0, notRestored: [] })).toBeUndefined()
    expect(notRestoredLine({ skipped: 2, notRestored: named.slice(0, 2) })).toBe('这 2 个文件没有恢复')
    expect(notRestoredLine({ skipped: 950, notRestored: named })).toBe('这 950 个文件没有恢复（列出前 200 个）')
  })

  it('opens a file that is still there', () => {
    expect(firstOpenable([{ path: 'gone', deleted: true }, { path: 'here' }])?.path).toBe('here')
    expect(firstOpenable([{ path: 'gone', deleted: true }])).toBeUndefined()
  })

  it('has words for the reasons that leave a card standing', () => {
    expect(undoBlockWords('running')).toBe('运行中不能撤销')
    expect(undoBlockWords('changed-since')).toBe('之后又改过这些文件，不能撤销')
    expect(undoBlockWords('no-changes')).toBeUndefined()
    expect(redoBlockWords('changed-since')).toBe('之后又改过这些文件，不能恢复')
  })
})
