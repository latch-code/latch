import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChangeHunk, ChangeLine, GitDeliveryState } from '@latch/protocol'
import {
  changedLines,
  commitRow,
  EMPTY_PICK,
  extendTo,
  historyTitle,
  keepPick,
  keyStep,
  lineRefusal,
  retryEnds,
  pickAll,
  selectionOf,
  STALE_CODES,
  stagingRows,
  toggleBlock,
  toggleLine,
  viewCounts,
  wholeNote,
  type LineKey,
  type LinePick,
} from '../src/panel/changes/staging.ts'
import { PickableDiff } from '../src/panel/changes/StagingView.tsx'

const context = (line: number): ChangeLine => ({ kind: 'context', text: 'c', oldLine: line, newLine: line })
const remove = (oldLine: number): ChangeLine => ({ kind: 'remove', text: 'r', oldLine })
const add = (newLine: number): ChangeLine => ({ kind: 'add', text: 'a', newLine })
/** Two blocks: lines 2–3 replaced by 2–4, then one line added at the end. */
const hunks: ChangeHunk[] = [
  {
    oldStart: 1,
    oldLines: 5,
    newStart: 1,
    newLines: 7,
    lines: [context(1), remove(2), remove(3), add(2), add(3), add(4), context(4), context(5), add(7)],
  },
]
const order = changedLines(hunks)
const keys = (pick: LinePick) => [...pick.lines].toSorted()
const press = (key: string, shiftKey = false) => ({ key, shiftKey })

describe('picking lines to stage', () => {
  it('names each changed line by its side and number, in blocks', () => {
    expect(order.map(line => line.key)).toEqual(['old:2', 'old:3', 'new:2', 'new:3', 'new:4', 'new:7'])
    expect(order.map(line => line.block)).toEqual([0, 0, 0, 0, 0, 1])
  })

  it('flips a line on a press or Space, and Shift extends from where the pick started', () => {
    let pick = toggleLine(EMPTY_PICK, 'old:3')
    expect(keys(pick)).toEqual(['old:3'])
    // Shift with a press: every changed line from there to here, across both sides, context skipped.
    pick = extendTo(pick, order, 'new:7')
    expect(keys(pick)).toEqual(['new:2', 'new:3', 'new:4', 'new:7', 'old:3'])
    // Pressing a picked line again takes it out.
    expect(keys(toggleLine(pick, 'new:3'))).toEqual(['new:2', 'new:4', 'new:7', 'old:3'])
    // Space is a press; Shift Space extends like Shift with a press.
    const spaced = keyStep(EMPTY_PICK, order, 'new:2', press(' '))!
    expect(keys(spaced.pick)).toEqual(['new:2'])
    expect(spaced.focus).toBe('new:2')
    expect(keys(keyStep(spaced.pick, order, 'new:2', press(' '))!.pick)).toEqual([])
    expect(keys(keyStep(spaced.pick, order, 'new:4', press(' ', true))!.pick)).toEqual(['new:2', 'new:3', 'new:4'])
    // Shift with nothing to extend from is a plain press.
    expect(keys(extendTo(EMPTY_PICK, order, 'new:4'))).toEqual(['new:4'])
  })

  it('moves with the arrows and grows or shrinks the stretch with Shift and an arrow', () => {
    const start = toggleLine(EMPTY_PICK, 'new:2')
    const moved = keyStep(start, order, 'new:2', press('ArrowDown'))!
    expect(moved.focus).toBe('new:3')
    expect(keys(moved.pick)).toEqual(['new:2'])
    const down = keyStep(start, order, 'new:2', press('ArrowDown', true))!
    const further = keyStep(down.pick, order, down.focus, press('ArrowDown', true))!
    expect(keys(further.pick)).toEqual(['new:2', 'new:3', 'new:4'])
    // Back up one: the far end comes back, the anchor stays.
    const back = keyStep(further.pick, order, further.focus, press('ArrowUp', true))!
    expect(keys(back.pick)).toEqual(['new:2', 'new:3'])
    expect(back.focus).toBe('new:3')
    // From an unpicked line, Shift and an arrow start there.
    expect(keys(keyStep(EMPTY_PICK, order, 'old:2', press('ArrowDown', true))!.pick)).toEqual(['old:2', 'old:3'])
    // The ends stop; other keys are left to the page.
    expect(keyStep(start, order, 'new:7', press('ArrowDown'))!.focus).toBe('new:7')
    expect(keyStep(start, order, 'new:2', press('Enter'))).toBeUndefined()
  })

  it('takes a whole block, everything, and only what is still a change after a new read', () => {
    const block = toggleBlock(EMPTY_PICK, order, 'new:3')
    expect(keys(block)).toEqual(['new:2', 'new:3', 'new:4', 'old:2', 'old:3'])
    expect(keys(toggleBlock(block, order, 'old:2'))).toEqual([])
    expect(pickAll(order).lines.size).toBe(6)
    const fewer = changedLines([{ ...hunks[0]!, lines: [context(1), add(2), context(3)] }])
    expect(keys(keepPick(block, fewer))).toEqual(['new:2'])
    expect(keepPick(EMPTY_PICK, fewer)).toBe(EMPTY_PICK)
  })

  it('sends line numbers as ranges on each side and nothing else', () => {
    const pick: LinePick = { lines: new Set<LineKey>(['new:4', 'new:2', 'new:3', 'new:7', 'old:3']) }
    expect(selectionOf(pick)).toEqual({
      old: [[3, 3]],
      new: [
        [2, 4],
        [7, 7],
      ],
    })
    expect(selectionOf(EMPTY_PICK)).toEqual({})
    expect(selectionOf({ lines: new Set<LineKey>(['old:1']) })).toEqual({ old: [[1, 1]] })
  })
})

describe('the staged and unstaged views', () => {
  const state: Pick<GitDeliveryState, 'staged' | 'unstaged' | 'untracked' | 'conflicted'> = {
    staged: [{ path: 'b.ts', status: 'M' }],
    unstaged: [
      { path: 'b.ts', status: 'M' },
      { path: 'gone.ts', status: 'D' },
    ],
    untracked: ['a-new.ts'],
    conflicted: ['z.ts'],
  }

  it('keeps them apart: a partly staged file is a row in each, counted in each', () => {
    expect(stagingRows(state, 'staged')).toEqual([{ path: 'b.ts', status: 'M' }])
    expect(stagingRows(state, 'unstaged')).toEqual([
      { path: 'a-new.ts', status: 'A', untracked: true },
      { path: 'b.ts', status: 'M' },
      { path: 'gone.ts', status: 'D' },
      { path: 'z.ts', status: 'M', conflicted: true },
    ])
    expect(viewCounts(state)).toEqual({ unstaged: 4, staged: 1 })
  })

  it('says in a few words why a file goes whole, and what a refusal means', () => {
    expect(wholeNote('binary', 'unstaged')).toBe('二进制 · 只能整个暂存')
    expect(wholeNote('new', 'staged')).toBe('新文件 · 只能整个取消暂存')
    expect(wholeNote('large', 'unstaged')).toBe('文件太大 · 只能整个暂存')
    expect(wholeNote('mode', 'unstaged')).toBe('执行位变化 · 只能整个暂存')
    expect(wholeNote('filtered', 'unstaged')).toBe('经过滤器 · 只能整个暂存')
    expect(wholeNote('conflicted', 'unstaged')).toBe('有冲突 · 在终端里解决')
    expect(lineRefusal('git-file-changed', { changed: 'worktree' })).toBe('文件已变 · 已重新读取')
    expect(lineRefusal('git-file-changed', { changed: 'index' })).toBe('暂存区已变 · 已重新读取')
    expect(lineRefusal('git-file-whole', { whole: 'submodule' })).toBe('子模块 · 只能整个文件')
    expect(lineRefusal('git-file-whole', { whole: 'nonsense' })).toBe('只能整个文件')
    expect(lineRefusal('git-turn-running')).toBe('Agent 正在改这个文件夹')
    expect(lineRefusal('something-else')).toBeUndefined()
    expect([...STALE_CODES].toSorted()).toEqual(['git-file-changed', 'git-file-whole', 'git-selection-invalid'])
  })

  it('ends 「结果未知」 on a retry only when the Host knows what the first attempt did', () => {
    // Its receipt's answer, or a refusal made after looking at the file and the index.
    expect(retryEnds('git-stage-failed', { replay: true })).toBe(true)
    expect(retryEnds('git-file-changed', { changed: 'worktree' })).toBe(true)
    expect(retryEnds('git-selection-invalid')).toBe(true)
    // Refusals made before that look say nothing about the first attempt.
    for (const code of [
      'git-busy',
      'git-turn-running',
      'git-operation-in-progress',
      'host-updating',
      'file-scope',
      'rate-limited',
      'git-failed',
    ])
      expect(retryEnds(code), code).toBe(false)
  })
})

describe('history rows', () => {
  it('titles a list by what it is of, and a commit by its subject or, without one, its short ID', () => {
    expect(historyTitle({ range: 'base', base: 'main' })).toBe('离开 main 之后的提交')
    expect(historyTitle({ range: 'upstream' })).toBe('还没推送的提交')
    expect(historyTitle({ range: 'recent' })).toBe('最近的提交')
    const sha = 'abcdef0123456789abcdef0123456789abcdef01'
    const full = commitRow({ sha, at: '2026-11-01T08:20:00.000Z', subject: 'fix parser', author: 'Ann', merge: true })
    expect(full.label).toBe('fix parser')
    expect(full.meta).toMatch(/^abcdef0 · Ann · \d+-\d\d \d\d:\d\d · 合并$/u)
    const bare = commitRow({ sha, at: '2026-11-01T08:20:00.000Z' })
    expect(bare.label).toBe('abcdef0')
    expect(bare.meta).not.toContain('abcdef0')
  })
})

describe('the pickable diff', () => {
  const diff = {
    path: 'a.ts',
    base: { worktree: 'a'.repeat(64), index: 'b'.repeat(40) },
    hunks: [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        lines: [
          { kind: 'context' as const, text: 'keep', oldLine: 1, newLine: 1 },
          { kind: 'remove' as const, text: 'old <b>', oldLine: 2 },
          { kind: 'add' as const, text: 'new', newLine: 2 },
        ],
      },
    ],
    add: 1,
    del: 1,
  }
  const html = (view: 'unstaged' | 'staged', canWrite = true) =>
    renderToStaticMarkup(
      createElement(PickableDiff, { diff: { ...diff, view }, view, busy: false, canWrite, onWrite: async () => 'done' as const }),
    )

  it('puts one unchecked box on each changed line and none on an unchanged one, with the text escaped', () => {
    const out = html('unstaged')
    expect(out.match(/role="checkbox"/gu)).toHaveLength(2)
    expect(out).toContain('data-stage-key="old:2"')
    expect(out).toContain('data-stage-key="new:2"')
    expect(out).toContain('aria-label="删除的第 2 行"')
    expect(out).toContain('aria-label="新增的第 2 行"')
    expect(out).not.toContain('aria-checked="true"')
    expect(out).not.toContain('<b>')
    expect(out).toContain('2 行改动')
  })

  it('names its one action by the view, and keeps it off until lines are picked', () => {
    expect(html('unstaged')).toContain('暂存所选')
    expect(html('unstaged')).not.toContain('取消暂存所选')
    expect(html('staged')).toContain('取消暂存所选')
    // One blue button, and nothing picked yet: it cannot be pressed.
    const primary = html('unstaged').match(/<button[^>]*data-variant="primary"[^>]*>/gu) ?? []
    expect(primary).toHaveLength(1)
    expect(primary[0]).toContain('disabled')
  })
})
