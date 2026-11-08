import { describe, expect, it } from 'vitest'
import type { ChangedFile, ChangeList, TurnChanges } from '@latch/protocol'
import {
  baseLabel,
  canUndoFile,
  changeLines,
  compareFiles,
  conflictLine,
  dropLeading,
  droppedTurns,
  emptyState,
  fileNote,
  missingTurnTitle,
  fitPath,
  layoutFor,
  missedFiles,
  offersBase,
  reviewOf,
  scopeAction,
  scopeLabel,
  statusLetter,
  treeOpensAlone,
  treeRows,
  turnNumbers,
  turnRow,
  undoWarning,
  writtenWords,
  type TreeRow,
} from '../src/panel/changes/model.ts'

const file = (path: string, extra: Partial<ChangedFile> = {}): ChangedFile => ({
  root: 'default',
  path,
  status: 'M',
  add: 1,
  del: 1,
  ...extra,
})
const list = (extra: Partial<ChangeList> = {}): ChangeList => ({
  scope: 'turn',
  turnId: 't',
  files: [file('a.ts')],
  totals: { files: 1, add: 1, del: 1 },
  undo: { available: true },
  redo: { available: false, reason: 'not-undone' },
  ...extra,
})
const settled: TurnChanges = { turnId: 't', startedAt: '2026-11-01T08:20:00.000Z', state: 'settled', files: 1 }
const rights = { canRun: true, local: true, active: false, offline: false }
const remote = { ...rights, local: false }
const blocked = (reason: NonNullable<ChangeList['undo']> extends infer A ? (A extends { reason: infer R } ? R : never) : never) =>
  ({ available: false, reason }) as const

describe('the scope row', () => {
  it('says one thing per state: the action, or why there is none', () => {
    expect(scopeAction(list(), settled, rights)).toEqual({ kind: 'undo' })
    expect(scopeAction(list({ running: true, undo: blocked('running') }), { ...settled, state: 'running' }, rights)).toEqual({
      kind: 'why',
      text: '运行中不能撤销',
    })
    expect(scopeAction(list({ undo: blocked('changed-since') }), settled, rights)).toEqual({
      kind: 'why',
      text: '之后又改过这些文件，不能撤销',
      someFiles: true,
    })
    expect(scopeAction(list({ undo: blocked('not-settled') }), settled, rights)).toEqual({
      kind: 'why',
      text: '这一轮没有正常结束，不能撤销',
    })
    expect(scopeAction(list({ undo: blocked('not-retained') }), settled, rights)).toEqual({
      kind: 'why',
      text: '这些文件的内容没有留存，不能撤销',
    })
    expect(scopeAction(list({ undo: blocked('no-changes') }), settled, rights)).toEqual({ kind: 'none' })
  })

  it('switches on the turn state, because an interrupted turn also reads as running in the list', () => {
    expect(scopeAction(list({ running: true }), { ...settled, state: 'interrupted' }, rights)).toEqual({
      kind: 'why',
      text: '没有结算，不能撤销',
    })
  })

  it('offers 恢复 after an undo, or says what blocks it', () => {
    const undone = { undone: true as const, undo: blocked('undone') }
    expect(scopeAction(list({ ...undone, redo: { available: true } }), settled, rights)).toEqual({ kind: 'redo' })
    expect(scopeAction(list({ ...undone, redo: blocked('changed-since') }), settled, rights)).toEqual({
      kind: 'why',
      text: '之后又改过这些文件，不能恢复',
    })
    expect(scopeAction(list({ ...undone, redo: blocked('running') }), settled, rights)).toEqual({ kind: 'why', text: '运行中不能恢复' })
  })

  it('offers nothing in a session that only opens to be read, and says it is the session', () => {
    const readOnly = { ...rights, readOnly: true }
    const why = { kind: 'why', text: '这个会话只能查看' }
    expect(scopeAction(list(), settled, readOnly)).toEqual(why)
    expect(scopeAction(list({ undone: true, undo: blocked('undone'), redo: { available: true } }), settled, readOnly)).toEqual(why)
    expect(scopeAction(list({ scope: 'uncommitted' }), undefined, readOnly)).toEqual(why)
  })

  it('leaves the session and base scopes read-only', () => {
    expect(scopeAction(list({ scope: 'session' }), undefined, rights)).toEqual({ kind: 'why', text: '只读' })
    expect(scopeAction(list({ scope: 'base' }), undefined, rights)).toEqual({ kind: 'why', text: '只读' })
  })

  it('offers discarding uncommitted changes only on this computer, and never mid-merge', () => {
    const uncommitted = list({ scope: 'uncommitted' })
    expect(scopeAction(uncommitted, undefined, rights)).toEqual({ kind: 'discard' })
    expect(scopeAction(uncommitted, undefined, remote)).toEqual({ kind: 'why', text: '只能在 Mac 的 Latch 中撤销' })
    expect(scopeAction({ ...uncommitted, conflict: { operation: 'merge', files: 2 } }, undefined, rights)).toEqual({
      kind: 'why',
      text: '合并中不能撤销',
    })
    expect(scopeAction({ ...uncommitted, conflict: { operation: 'rebase', files: 0 } }, undefined, rights)).toEqual({
      kind: 'why',
      text: '变基中不能撤销',
    })
    expect(scopeAction({ ...uncommitted, conflict: { operation: 'unmerged', files: 1 } }, undefined, rights)).toEqual({
      kind: 'why',
      text: '有冲突时不能撤销',
    })
    expect(scopeAction({ ...uncommitted, files: [] }, undefined, rights)).toEqual({ kind: 'none' })
  })

  it('undoes a turn from another device, and says so for a device that only reads', () => {
    expect(scopeAction(list(), settled, remote)).toEqual({ kind: 'undo' })
    expect(scopeAction(list(), settled, { ...rights, canRun: false })).toEqual({ kind: 'why', text: '这台设备只能查看' })
  })

  it('refuses while the session runs even when the list and the turn record have not caught up', () => {
    const active = { ...rights, active: true }
    expect(scopeAction(list(), settled, active)).toEqual({ kind: 'why', text: '运行中不能撤销' })
    expect(scopeAction(list({ undone: true, redo: { available: true } }), settled, active)).toEqual({ kind: 'why', text: '运行中不能恢复' })
    expect(scopeAction(list({ scope: 'uncommitted' }), undefined, active)).toEqual({ kind: 'why', text: '运行中不能撤销' })
    expect(scopeAction(list({ scope: 'uncommitted', files: [] }), undefined, active)).toEqual({ kind: 'none' })
    expect(scopeAction(list({ scope: 'session' }), undefined, active)).toEqual({ kind: 'why', text: '只读' })
  })

  it('refuses offline, in the words of what the button would have done', () => {
    const offline = { ...rights, offline: true }
    expect(scopeAction(list(), settled, offline)).toEqual({ kind: 'why', text: '离线时不能撤销' })
    expect(scopeAction(list({ undone: true, redo: { available: true } }), settled, offline)).toEqual({
      kind: 'why',
      text: '离线时不能恢复',
    })
    expect(scopeAction(list({ scope: 'uncommitted' }), undefined, offline)).toEqual({ kind: 'why', text: '离线时不能撤销' })
    expect(scopeAction(list({ scope: 'base' }), undefined, offline)).toEqual({ kind: 'why', text: '只读' })
  })

  it('keeps 撤销此文件 on a turn only some of whose files changed since', () => {
    const changed = scopeAction(list({ undo: blocked('changed-since') }), settled, rights)
    expect(canUndoFile(changed, file('a'))).toBe(true)
    expect(canUndoFile(changed, file('a', { notRetained: true }))).toBe(false)
    expect(canUndoFile(scopeAction(list({ undo: blocked('not-settled') }), settled, rights), file('a'))).toBe(false)
    expect(canUndoFile(scopeAction(list({ undo: blocked('changed-since') }), settled, { ...rights, active: true }), file('a'))).toBe(false)
    expect(canUndoFile(scopeAction(list({ undo: blocked('changed-since') }), settled, { ...rights, canRun: false }), file('a'))).toBe(false)
  })

  it('offers 撤销此文件 only where the whole turn can still go back and the file was kept', () => {
    expect(canUndoFile({ kind: 'undo' }, file('a'))).toBe(true)
    expect(canUndoFile({ kind: 'undo' }, file('a', { secret: true }))).toBe(false)
    expect(canUndoFile({ kind: 'undo' }, file('a', { notRetained: true }))).toBe(false)
    expect(canUndoFile({ kind: 'redo' }, file('a'))).toBe(false)
  })
})

describe('the lines above the list', () => {
  const kinds = (input: Partial<ChangeList>, turn?: TurnChanges) =>
    changeLines(list(input), turn, id => id, 'deps/x').map(line => line.kind)

  it('never hides an incomplete record', () => {
    expect(kinds({ partial: true })).toEqual(['partial'])
  })

  it('draws running and interrupted from the turn state alone', () => {
    expect(kinds({ running: true }, { ...settled, state: 'running' })).toEqual(['running'])
    expect(kinds({ running: true }, { ...settled, state: 'interrupted' })).toEqual(['interrupted'])
    expect(kinds({ running: true })).toEqual([])
  })

  it('says a moving scope is stale before the record says the turn runs, and leaves a past turn alone', () => {
    const moving = (input: Partial<ChangeList>, turn?: TurnChanges, flag = true) =>
      changeLines(list(input), turn, id => id, undefined, flag).map(line => line.kind)
    expect(moving({}, settled)).toEqual(['running'])
    expect(moving({}, { ...settled, state: 'interrupted' })).toEqual(['running'])
    expect(moving({ scope: 'session' })).toEqual(['running'])
    expect(moving({ scope: 'uncommitted' })).toEqual(['running'])
    expect(moving({ scope: 'uncommitted', files: [], unavailable: 'not-git' })).toEqual([])
    expect(moving({ scope: 'turn', files: [], unavailable: 'no-turns' })).toEqual(['running'])
    expect(moving({}, settled, false)).toEqual([])
  })

  it('names conflicts, parallel sessions and folders outside Git', () => {
    expect(kinds({ conflict: { operation: 'merge', files: 2 } })).toEqual(['conflict'])
    expect(conflictLine({ operation: 'merge', files: 2 })).toBe('仓库正在合并 · 2 个文件有冲突')
    expect(conflictLine({ operation: 'cherry-pick', files: 1 })).toBe('仓库正在拣选提交 · 1 个文件有冲突')
    expect(conflictLine({ operation: 'unmerged', files: 3 })).toBe('仓库有未解决的冲突 · 3 个文件有冲突')
    expect(conflictLine({ operation: 'rebase', files: 0 })).toBe('仓库正在变基 · 冲突已解决，还没有完成')
    expect(kinds({ otherSessions: ['s2'] })).toEqual(['other-session'])
    expect(kinds({ notGit: ['notes'] })).toEqual(['not-git'])
    expect(changeLines(list({ scope: 'base', base: 'master' }), undefined, id => id, 'deps/x')).toEqual([
      { kind: 'base', branch: 'deps/x', base: 'master' },
    ])
  })

  it('says a very long list reads files only on demand', () => {
    expect(kinds({ files: Array.from({ length: 1000 }, (_, at) => file(`f${at}`)) })).toEqual(['large'])
  })
})

describe('the empty states', () => {
  const title = (input: Partial<ChangeList>) => emptyState(list({ files: [], ...input }))?.title
  it('gives every unavailable answer its own words', () => {
    expect(title({})).toBe('这一轮没有改动文件')
    expect(title({ unavailable: 'no-turns' })).toBe('这个会话还没有记录到改动')
    expect(title({ scope: 'uncommitted', unavailable: 'not-git' })).toBe('这个文件夹不是 Git 仓库的顶层')
    expect(title({ scope: 'uncommitted', unavailable: 'git-missing' })).toBe('找不到 Git')
    expect(title({ scope: 'uncommitted', unavailable: 'git-failed' })).toBe('读不到 Git 状态')
    expect(title({ scope: 'uncommitted', unavailable: 'no-head' })).toBe('还没有提交')
    expect(title({ scope: 'base', unavailable: 'no-base' })).toBe('没有可比较的主分支')
    expect(emptyState(list({ scope: 'uncommitted', files: [], unavailable: 'git-failed' }))?.retry).toBe(true)
  })
  it('stays out of the way while there are files', () => {
    expect(emptyState(list())).toBeUndefined()
  })
})

describe('the scope menu', () => {
  const messages = [
    { role: 'user' as const },
    { role: 'assistant' as const },
    { role: 'user' as const, turnId: 'a' },
    { role: 'user' as const, turnId: 'b' },
    { role: 'user' as const, turnId: 'c' },
  ]
  it('numbers turns as the conversation does, and counts what is no longer kept', () => {
    const numbers = turnNumbers(messages)
    expect([...numbers]).toEqual([
      ['a', 2],
      ['b', 3],
      ['c', 4],
    ])
    expect(droppedTurns(numbers, [{ turnId: 'b' }, { turnId: 'c' }])).toBe(1)
  })
  it('does not call a turn aged out because its start is not on record yet', () => {
    const numbers = turnNumbers(messages)
    expect(droppedTurns(numbers, [{ turnId: 'a' }, { turnId: 'b' }])).toBe(0)
    expect(droppedTurns(numbers, [])).toBe(0)
    const picked = (turnId: string) => ({ kind: 'turn' as const, turnId })
    expect(missingTurnTitle(picked('c'), numbers, [{ turnId: 'a' }, { turnId: 'b' }])).toBe('这一轮没有记录到改动')
    expect(missingTurnTitle(picked('c'), numbers, [])).toBe('这一轮没有记录到改动')
    expect(missingTurnTitle(picked('a'), numbers, [{ turnId: 'b' }, { turnId: 'c' }])).toBe('这一轮已不在保留的 20 轮内')
  })
  it('shows files only for a settled turn', () => {
    const numbers = new Map([['t', 14]])
    expect(turnRow({ ...settled, files: 8 }, numbers).meta).toMatch(/ · 8 个文件$/u)
    expect(turnRow({ ...settled, undone: true }, numbers).meta).toMatch(/已撤销$/u)
    expect(turnRow({ ...settled, state: 'running' }, numbers).meta).toMatch(/运行中$/u)
    expect(turnRow({ ...settled, state: 'interrupted' }, numbers).meta).toMatch(/已中断$/u)
    expect(turnRow(settled, numbers).label).toBe('第 14 轮')
    expect(turnRow(settled, new Map()).label).toBe('这一轮')
  })
  it('takes the base name from the answer, and does not offer it on main or a detached HEAD', () => {
    expect(baseLabel(undefined)).toBe('与主分支比较')
    expect(baseLabel('master')).toBe('与 master 比较')
    expect(scopeLabel({ kind: 'base' }, new Map(), 'master')).toBe('与 master 比较')
    expect(offersBase('main')).toBe(false)
    expect(offersBase('master')).toBe(false)
    expect(offersBase('分离于 3f2a1c9')).toBe(false)
    expect(offersBase('deps/x')).toBe(true)
    expect(offersBase(undefined)).toBe(true)
  })
})

describe('the tree and the list', () => {
  const names = (rows: TreeRow[]) => rows.map(row => `${' '.repeat(row.depth)}${row.name}`)
  const files = [
    'package.json',
    'apps/desktop/src/main.cjs',
    'apps/desktop/.env',
    'apps/desktop/src/preload.cjs',
    'pnpm-lock.yaml',
    'apps/desktop/test/w.ts',
  ].map(path => file(path))

  it('reads in one order, folders first at every level, flattening single-child folders', () => {
    expect(names(treeRows(files, new Set()))).toEqual([
      'apps/desktop',
      ' src',
      '  main.cjs',
      '  preload.cjs',
      ' test',
      '  w.ts',
      ' .env',
      'package.json',
      'pnpm-lock.yaml',
    ])
    expect(files.toSorted(compareFiles).map(item => item.path)).toEqual([
      'apps/desktop/src/main.cjs',
      'apps/desktop/src/preload.cjs',
      'apps/desktop/test/w.ts',
      'apps/desktop/.env',
      'package.json',
      'pnpm-lock.yaml',
    ])
  })

  it('makes each session folder the first level when there are several, and folds what is closed', () => {
    const rows = treeRows([file('a.ts'), file('b.ts', { root: 'notes' })], new Set(['root:notes']), new Map([['notes', '笔记']]))
    expect(names(rows)).toEqual(['default', ' a.ts', '笔记'])
  })

  it('opens the tree only from 6 files and when the diff keeps 560px', () => {
    expect(treeOpensAlone(8, 660)).toBe(false)
    expect(treeOpensAlone(8, 860)).toBe(true)
    expect(treeOpensAlone(5, 860)).toBe(false)
  })

  it('turns side by side at 760px, and keeps the choice otherwise', () => {
    expect(layoutFor('auto', 759)).toBe('unified')
    expect(layoutFor('auto', 760)).toBe('split')
    expect(layoutFor('stacked', 2000)).toBe('unified')
    expect(layoutFor('split', 300)).toBe('split')
  })

  it('cuts a path at whole folders, never inside a word', () => {
    expect(dropLeading('apps/desktop/assets/dmg.tiff', 0)).toBe('apps/desktop/assets/dmg.tiff')
    expect(dropLeading('apps/desktop/assets/dmg.tiff', 2)).toBe('…/assets/dmg.tiff')
    expect(dropLeading('apps/dmg.tiff', 9)).toBe('…/dmg.tiff')
    expect(fitPath('apps/desktop/assets/dmg.tiff', 1000, 7)).toBe('apps/desktop/assets/dmg.tiff')
    expect(fitPath('apps/desktop/assets/dmg.tiff', 120, 7)).toBe('…/assets/dmg.tiff')
    expect(fitPath('apps/desktop/assets/dmg.tiff', 10, 7)).toBe('…/dmg.tiff')
    expect(fitPath('文档/说明书.md', 50, 7)).toBe('…/说明书.md')
  })

  it('says who changed a file once, and why content is absent first', () => {
    expect(fileNote(file('a'))).toBeUndefined()
    expect(fileNote(file('a', { byCommand: true }))?.text).toBe('由命令修改')
    expect(fileNote(file('a', { byUser: true }))).toEqual({ text: '两轮之间改动', title: '在两轮之间改动的：可能是你，也可能是别的程序' })
    expect(fileNote(file('a', { secret: true, byCommand: true }))).toEqual({ text: '可能含密钥，只列路径', title: '由命令修改' })
    expect(fileNote(file('a', { notRetained: true }))?.text).toBe('内容没有留存')
    expect(fileNote(file('a', { large: true }))?.text).toBe('超过 1 MB，打开文件查看')
    expect(fileNote(file('a', { binary: true }))?.text).toBe('二进制文件')
    expect(statusLetter(file('a', { conflicted: true }))).toBe('U')
    expect(statusLetter(file('a', { status: 'R' }))).toBe('R')
  })
})

describe('the review of a file', () => {
  const line = (kind: 'context' | 'add' | 'remove', at: number, text = `l${at}`) => ({
    kind,
    text,
    ...(kind === 'add' ? {} : { oldLine: at }),
    ...(kind === 'remove' ? {} : { newLine: at }),
  })
  it('folds what is far from a change into bands, keeping the Host’s line numbers and both texts', () => {
    const lines = [
      ...Array.from({ length: 10 }, (_, at) => line('context', at + 1)),
      line('remove', 11),
      line('add', 11, 'new'),
      ...Array.from({ length: 12 }, (_, at) => line('context', at + 12)),
    ]
    const { view, oldText, newText } = reviewOf([{ oldStart: 1, oldLines: 23, newStart: 1, newLines: 23, lines }])
    expect(view.added).toBe(1)
    expect(view.removed).toBe(1)
    expect(view.hunks).toHaveLength(1)
    expect(view.hunks[0]!.lines[0]!.newLine).toBe(8)
    expect(view.gaps.map(gap => [gap.before, gap.lines.length])).toEqual([
      [0, 7],
      [1, 9],
    ])
    expect(oldText.split('\n')[10]).toBe('l11')
    expect(newText.split('\n')[10]).toBe('new')
  })
})

describe('the warning and the receipt', () => {
  it('counts what will be written and names what will be left', () => {
    const warning = undoWarning(
      list({
        files: [file('m.ts'), file('new.ts', { status: 'A' }), file('.env', { secret: true }), file('big.tiff', { notRetained: true })],
        notCovered: ['~/x.json'],
      }),
    )
    expect(warning).toEqual({
      restore: 1,
      remove: 1,
      missed: [
        { path: '.env', why: '可能含密钥，不写也不删' },
        { path: 'big.tiff', why: '内容没有留存' },
        { path: '~/x.json', why: '在文件夹之外或被忽略' },
      ],
    })
    expect(undoWarning(list()).missed).toEqual([])
  })
  it('reads the same in the warning and the receipt', () => {
    expect(writtenWords(5, 1)).toBe('写回 5 个文件，删除 1 个新文件。')
    expect(writtenWords(0, 2)).toBe('删除 2 个新文件。')
    expect(writtenWords(0, 0)).toBe('没有需要写入的文件。')
  })
  it('lists each file left with its reason, and counts those the Host did not name', () => {
    expect(
      missedFiles(
        [
          { root: 'default', path: 'a.tiff', reason: 'not-retained' },
          { root: 'default', path: '.env', reason: 'secret' },
          { root: 'x', path: 'b', reason: 'folder-missing' },
        ],
        ['~/c'],
        300,
      ),
    ).toEqual({
      files: [
        { path: 'a.tiff', why: '内容没有留存' },
        { path: '.env', why: '可能含密钥，不写也不删' },
        { path: 'b', why: '文件夹已不在' },
        { path: '~/c', why: '在文件夹之外或被忽略' },
      ],
      more: 297,
    })
  })
})
