// What the 改动 tab draws from the Host's answers: which scope is shown, the file tree, what stands in the scope row, the
// lines above the list and the empty states. Pure, so every state of the table has a test. See docs/CHANGES.md.
import type { ChangedFile, ChangeHunk, ChangeList, ChangeScope, GitOperation, Message, NotRestoredFile, TurnChanges } from '@latch/protocol'
import { turnUndo, type TurnUndo, type UndoRights } from '../../conversation/turnChanges.ts'
import type { DiffHunk, DiffGap, DiffLine, LineDiff } from '../../diff.ts'
import { defineCopy, formatList, formatNumber, plural } from '../../core/i18n.ts'

const COPY = defineCopy(
  {
    gitSide: '本轮和这个会话不受影响。',
    written: (parts: string[]) => `${parts.join('，')}。`,
    agedOut: (count: number) => `这一轮已不在保留的 ${formatNumber(count)} 轮内`,
    noRecord: '这一轮没有记录到改动',
    running: '运行中',
    interrupted: '已中断',
    undone: '已撤销',
    fileCount: (count: number) => `${formatNumber(count)} 个文件`,
    thisTurn: '这一轮',
    turnNumber: (number: number) => `第 ${formatNumber(number)} 轮`,
    base: (value1: string | number) => `与 ${value1} 比较`,
    mainBase: '与主分支比较',
    latest: '本轮',
    session: '这个会话',
    uncommitted: '未提交',
    byCommand: '由命令修改',
    byYou: '你的修改',
    between: '两轮之间改动',
    secret: '可能含密钥，只列路径',
    notKept: '内容没有留存',
    tooLarge: '超过 1 MB，打开文件查看',
    binary: '二进制文件',
    savedByYou: '你在 Latch 里编辑并保存的内容',
    changedBetween: '在两轮之间改动的：可能是你，也可能是别的程序',
    readOnly: '只读',
    undoOffline: '离线时不能撤销',
    sessionReadOnly: '这个会话只能查看',
    deviceReadOnly: '这台设备只能查看',
    macOnly: '只能在 Mac 的 Latch 中撤销',
    undoRunning: '运行中不能撤销',
    merge: '合并',
    rebase: '变基',
    cherryPick: '拣选提交',
    revert: '还原提交',
    resolving: '解决冲突',
    undoConflict: '有冲突时不能撤销',
    undoOperation: (value1: string | number) => `${value1}中不能撤销`,
    conflictCount: (count: number) => `${formatNumber(count)} 个文件有冲突`,
    resolved: '冲突已解决，还没有完成',
    unresolved: (value1: string | number) => `仓库有未解决的冲突 · ${value1}`,
    operation: (value1: string | number, value2: string | number) => `仓库正在${value1} · ${value2}`,
    nothingInSession: '这个会话还没有记录到改动',
    notRoot: '这个文件夹不是 Git 仓库的顶层',
    noGit: '找不到 Git',
    gitFailed: '读不到 Git 状态',
    noCommits: '还没有提交',
    noBase: '没有可比较的主分支',
    noFilesYet: '还没有改动文件',
    noFilesInTurn: '这一轮没有改动文件',
    noChangesInSession: '这个会话没有留下改动',
    noUncommitted: '没有未提交的改动',
    noChangesSinceBranch: '和分叉点相比没有改动',
    secretKept: '可能含密钥，不写也不删',
    missingFolder: '文件夹已不在',
    restoreCount: (count: number) => `写回 ${formatNumber(count)} 个文件`,
    removeCount: (count: number) => `删除 ${formatNumber(count)} 个新文件`,
    nothingToWrite: '没有需要写入的文件。',
  },
  {
    gitSide: 'The current turn and session stay available.',
    written: (parts: string[]) => `${formatList(parts)}.`,
    agedOut: (count: number) => `This turn is outside the last ${formatNumber(count)} kept turns`,
    noRecord: 'No changes recorded for this turn',
    running: 'Running',
    interrupted: 'Interrupted',
    undone: 'Undone',
    fileCount: (count: number) => `${plural(count, { one: '{n} file', other: '{n} files' })}`,
    thisTurn: 'This turn',
    turnNumber: (number: number) => `Turn ${formatNumber(number)}`,
    base: (value1: string | number) => `Compare with ${value1}`,
    mainBase: 'Compare with main branch',
    latest: 'Latest turn',
    session: 'This session',
    uncommitted: 'Uncommitted',
    byCommand: 'Changed by a command',
    byYou: 'Your changes',
    between: 'Changed between turns',
    secret: 'May contain secret keys · Path only',
    notKept: 'Contents weren’t kept',
    tooLarge: 'Over 1 MB · Open the file to view it',
    binary: 'Binary file',
    savedByYou: 'You edited and saved this in Latch',
    changedBetween: 'Changed between turns by you or another program',
    readOnly: 'Read only',
    undoOffline: 'Can’t undo while offline',
    sessionReadOnly: 'This session is read only',
    deviceReadOnly: 'This device is read only',
    macOnly: 'Undo is available in Latch on the Mac',
    undoRunning: 'Can’t undo while the agent is running',
    merge: 'Merge',
    rebase: 'Rebase',
    cherryPick: 'Cherry-pick',
    revert: 'Revert',
    resolving: 'Conflict resolution',
    undoConflict: 'Resolve conflicts before undoing',
    undoOperation: (value1: string | number) => `Can’t undo while ${value1} is in progress`,
    conflictCount: (count: number) => `${plural(count, { one: '{n} file', other: '{n} files' })} with conflicts`,
    resolved: 'Conflicts resolved · Operation still in progress',
    unresolved: (value1: string | number) => `Repository has unresolved conflicts · ${value1}`,
    operation: (value1: string | number, value2: string | number) => `${value1} in progress · ${value2}`,
    nothingInSession: 'No changes recorded in this session yet',
    notRoot: 'This folder isn’t the root of a Git repository',
    noGit: 'Git not found',
    gitFailed: 'Couldn’t read Git status',
    noCommits: 'No commits yet',
    noBase: 'No main branch to compare',
    noFilesYet: 'No files changed yet',
    noFilesInTurn: 'No files changed in this turn',
    noChangesInSession: 'No changes left in this session',
    noUncommitted: 'No uncommitted changes',
    noChangesSinceBranch: 'No changes since branching',
    secretKept: 'May contain secret keys · Left alone',
    missingFolder: 'Folder is gone',
    restoreCount: (count: number) => `Restore ${plural(count, { one: '{n} file', other: '{n} files' })}`,
    removeCount: (count: number) => `Delete ${formatNumber(count)} new files`,
    nothingToWrite: 'No files need to be written.',
  },
)

/** `latest` follows the session's newest turn; a picked turn stays until another is picked. */
export type ScopeChoice = { kind: 'latest' } | { kind: 'turn'; turnId: string } | { kind: 'session' | 'uncommitted' | 'base' }

export function queryOf(choice: ScopeChoice): { scope: ChangeScope; turnId?: string } {
  if (choice.kind === 'latest') return { scope: 'turn' }
  if (choice.kind === 'turn') return { scope: 'turn', turnId: choice.turnId }
  return { scope: choice.kind }
}

export const KEPT_TURNS = 20

/**
 * Each turn's number in the conversation, counting every turn it opened. Messages from before `Message.turnId` still
 * count, so a number means the same whether or not an old turn is on record.
 */
export function turnNumbers(messages: readonly Pick<Message, 'role' | 'turnId'>[]): Map<string, number> {
  const numbers = new Map<string, number>()
  let count = 0
  for (const message of messages) {
    if (message.role !== 'user') continue
    if (message.turnId !== undefined && numbers.has(message.turnId)) continue
    count++
    if (message.turnId !== undefined) numbers.set(message.turnId, count)
  }
  return numbers
}

const oldestKept = (numbers: ReadonlyMap<string, number>, turns: readonly Pick<TurnChanges, 'turnId'>[]) =>
  Math.min(...turns.map(turn => numbers.get(turn.turnId) ?? Infinity))

/**
 * Turns aged out of the record, for 「还有 9 轮 · 只保留最近 20 轮」: those before the oldest kept. A later turn missing
 * from the record has not aged: its start is still being recorded, or it never was.
 */
export function droppedTurns(numbers: ReadonlyMap<string, number>, turns: readonly Pick<TurnChanges, 'turnId'>[]): number {
  const oldest = oldestKept(numbers, turns)
  if (oldest === Infinity) return 0
  let dropped = 0
  for (const number of numbers.values()) if (number < oldest) dropped++
  return dropped
}

/** Why a picked turn has no record. */
export function missingTurnTitle(
  choice: ScopeChoice,
  numbers: ReadonlyMap<string, number>,
  turns: readonly Pick<TurnChanges, 'turnId'>[],
): string {
  const number = choice.kind === 'turn' ? numbers.get(choice.turnId) : undefined
  return number !== undefined && number < oldestKept(numbers, turns) && turns.length > 0 ? COPY.agedOut(KEPT_TURNS) : COPY.noRecord
}

const clock = (iso: string) => {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? '' : `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/** A kept turn's row in the scope menu. Only a settled turn has a file count. */
export function turnRow(turn: TurnChanges, numbers: ReadonlyMap<string, number>): { label: string; meta: string } {
  const number = numbers.get(turn.turnId)
  const what =
    turn.state === 'running'
      ? COPY.running
      : turn.state === 'interrupted'
        ? COPY.interrupted
        : turn.undone
          ? COPY.undone
          : turn.files === undefined
            ? ''
            : COPY.fileCount(turn.files)
  return {
    label: number === undefined ? COPY.thisTurn : COPY.turnNumber(number),
    meta: [clock(turn.startedAt), what].filter(Boolean).join(' · '),
  }
}

/** Git's main branch is not always named main: a list says so; until one has, the menu does not guess. */
export const baseLabel = (base: string | undefined) => (base ? COPY.base(base) : COPY.mainBase)

/** A detached HEAD and the main branch itself have nothing to compare; anything else the answer decides. */
export const offersBase = (branch: string | undefined) =>
  branch === undefined || !(branch === 'main' || branch === 'master' || branch.startsWith('分离于'))

export function scopeLabel(choice: ScopeChoice, numbers: ReadonlyMap<string, number>, base: string | undefined): string {
  switch (choice.kind) {
    case 'latest':
      return COPY.latest
    case 'turn': {
      const number = numbers.get(choice.turnId)
      return number === undefined ? COPY.thisTurn : COPY.turnNumber(number)
    }
    case 'session':
      return COPY.session
    case 'uncommitted':
      return COPY.uncommitted
    case 'base':
      return baseLabel(base)
  }
}

// ---- order and tree ------------------------------------------------------------------------------------------------

const segments = (file: Pick<ChangedFile, 'path'>) => file.path.split('/')

/** The tree and the diff read in one order: folders first at every level, then names. */
export function compareFiles(a: Pick<ChangedFile, 'root' | 'path'>, b: Pick<ChangedFile, 'root' | 'path'>): number {
  if (a.root !== b.root) return a.root.localeCompare(b.root)
  const left = segments(a),
    right = segments(b)
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const folderLeft = index < left.length - 1,
      folderRight = index < right.length - 1
    if (folderLeft !== folderRight) return folderLeft ? -1 : 1
    if (left[index] !== right[index]) return left[index]!.localeCompare(right[index]!)
  }
  return left.length - right.length
}

export const fileId = (file: Pick<ChangedFile, 'root' | 'path'>) => `${file.root}\n${file.path}`

export type TreeRow =
  | { kind: 'folder'; id: string; name: string; depth: number; open: boolean }
  | { kind: 'file'; id: string; name: string; depth: number; file: ChangedFile }

interface Folder {
  folders: Map<string, Folder>
  files: ChangedFile[]
}

/**
 * The visible rows, top to bottom. A folder with a single child folder and no file flattens into it; with several
 * session folders each is the first level.
 */
export function treeRows(files: readonly ChangedFile[], closed: ReadonlySet<string>, rootNames?: ReadonlyMap<string, string>): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (folder: Folder, prefix: string, depth: number) => {
    for (const name of [...folder.folders.keys()].toSorted((a, b) => a.localeCompare(b))) {
      let child = folder.folders.get(name)!
      let shown = name,
        id = `${prefix}/${name}`
      while (child.files.length === 0 && child.folders.size === 1) {
        const [next, inner] = [...child.folders][0]!
        shown += `/${next}`
        id += `/${next}`
        child = inner
      }
      const open = !closed.has(id)
      rows.push({ kind: 'folder', id, name: shown, depth, open })
      if (open) walk(child, id, depth + 1)
    }
    for (const file of folder.files.toSorted((a, b) => a.path.localeCompare(b.path)))
      rows.push({ kind: 'file', id: fileId(file), name: file.path.split('/').at(-1)!, depth, file })
  }
  const roots = new Map<string, Folder>()
  for (const file of files) {
    const childOf = (parent: Map<string, Folder>, name: string): Folder => {
      const known = parent.get(name)
      if (known) return known
      const made: Folder = { folders: new Map(), files: [] }
      parent.set(name, made)
      return made
    }
    let folder = childOf(roots, file.root)
    for (const part of segments(file).slice(0, -1)) folder = childOf(folder.folders, part)
    folder.files.push(file)
  }
  if (roots.size === 1) {
    const [root, folder] = [...roots][0]!
    walk(folder, root, 0)
    return rows
  }
  for (const root of [...roots.keys()].toSorted((a, b) => a.localeCompare(b))) {
    const id = `root:${root}`,
      open = !closed.has(id)
    rows.push({ kind: 'folder', id, name: rootNames?.get(root) ?? root, depth: 0, open })
    if (open) walk(roots.get(root)!, id, 1)
  }
  return rows
}

export const TREE_FROM_FILES = 6
const DIFF_KEEPS = 560
export const treeWidth = (panel: number) => Math.min(232, panel * 0.4)
/** The tree opens by itself only from 6 files and when the diff keeps at least 560px. */
export const treeOpensAlone = (files: number, panel: number) => files >= TREE_FROM_FILES && panel - treeWidth(panel) >= DIFF_KEEPS

/** 自动 turns side by side once the diff column reaches 760px. */
const SPLIT_FROM = 760
export function layoutFor(mode: 'auto' | 'stacked' | 'split', diffWidth: number): 'unified' | 'split' {
  if (mode === 'auto') return diffWidth >= SPLIT_FROM ? 'split' : 'unified'
  return mode === 'split' ? 'split' : 'unified'
}

/** The tree's rows draw only near the view from this many; below it plain rows cost nothing to notice. */
export const WINDOW_TREE_FROM = 400
/** The diff lists this many file rows at first; more wait for a press, and the tree can reach any of them. */
export const LIST_PAGE = 150

/** A path that does not fit loses whole leading folders, never half a word. */
export function dropLeading(path: string, folders: number): string {
  if (folders <= 0) return path
  const parts = path.split('/')
  return `…/${parts.slice(Math.min(folders, parts.length - 1)).join('/')}`
}

/** How much of a path fits `room` pixels of a monospaced font in which a CJK character takes two cells. */
export function fitPath(path: string, room: number, characterPx: number): string {
  const cells = (text: string) => {
    let count = 0
    for (const character of text)
      count += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(character) ? 2 : 1
    return count
  }
  if (!(characterPx > 0) || room <= 0) return path
  const folders = path.split('/').length - 1
  let shown = path
  for (let dropped = 1; dropped <= folders && cells(shown) * characterPx > room; dropped++) shown = dropLeading(path, dropped)
  return shown
}

/** The letter at a tree row's right; 「U」 outranks the rest, because it is what the person has to resolve. */
export const statusLetter = (file: Pick<ChangedFile, 'status' | 'conflicted'>) => (file.conflicted ? 'U' : file.status)

/** The one short note on a file's row: why its content is absent if it is, otherwise who changed it. */
export function fileNote(file: ChangedFile): { text: string; title?: string } | undefined {
  const by = file.byCommand ? COPY.byCommand : file.byPerson ? COPY.byYou : file.byUser ? COPY.between : undefined
  const absent = file.secret
    ? COPY.secret
    : file.notRetained
      ? COPY.notKept
      : file.large
        ? COPY.tooLarge
        : file.binary
          ? COPY.binary
          : undefined
  if (absent) return { text: absent, ...(by ? { title: by } : {}) }
  if (!by) return undefined
  return {
    text: by,
    ...(file.byPerson ? { title: COPY.savedByYou } : file.byUser ? { title: COPY.changedBetween } : {}),
  }
}

export const contentHidden = (file: ChangedFile) => Boolean(file.secret || file.notRetained || file.large || file.binary)

// ---- turning hunks into what the renderer draws ----------------------------------------------------------------------

const CONTEXT = 3

/**
 * The review from a file's whole-context hunk: changes with three lines around each, the rest in bands. The Host's own
 * line pairing is kept, so the numbers here and in its patch agree. `keep`: unchanged lines that stay in view like a
 * change, such as those a comment is on.
 */
export function reviewOf(
  hunks: readonly ChangeHunk[],
  keep?: (line: DiffLine) => boolean,
): { view: LineDiff; oldText: string; newText: string } {
  const lines: DiffLine[] = hunks.flatMap(hunk => hunk.lines as DiffLine[])
  const near = lines.map(() => false)
  lines.forEach((line, at) => {
    if (line.kind === 'context' && !keep?.(line)) return
    for (let index = Math.max(0, at - CONTEXT); index <= Math.min(lines.length - 1, at + CONTEXT); index++) near[index] = true
  })
  const out: DiffHunk[] = [],
    gaps: DiffGap[] = []
  let at = 0
  while (at < lines.length) {
    const start = at
    if (!near[at]) {
      while (at < lines.length && !near[at]) at++
      gaps.push({ before: out.length, lines: lines.slice(start, at) })
      continue
    }
    while (at < lines.length && near[at]) at++
    const part = lines.slice(start, at)
    const olds = part.filter(line => line.kind !== 'add'),
      news = part.filter(line => line.kind !== 'remove')
    out.push({
      oldStart: olds[0]?.oldLine ?? 0,
      oldLines: olds.length,
      newStart: news[0]?.newLine ?? 0,
      newLines: news.length,
      lines: part,
    })
  }
  const join = (kept: DiffLine[]) => (kept.length ? `${kept.map(line => line.text).join('\n')}\n` : '')
  return {
    view: {
      added: lines.filter(line => line.kind === 'add').length,
      removed: lines.filter(line => line.kind === 'remove').length,
      hunks: out,
      gaps,
    },
    oldText: join(lines.filter(line => line.kind !== 'add')),
    newText: join(lines.filter(line => line.kind !== 'remove')),
  }
}

// ---- the scope row -------------------------------------------------------------------------------------------------

/** A turn's action or the reason there is none (`turnUndo`), or for uncommitted changes 撤销未提交的改动. */
export type ScopeAction = TurnUndo | { kind: 'discard' }

/** Who may press what on this device, as the Host will check it. */
export interface ScopeRights extends UndoRights {
  /** The connection is `host.sock`: nothing brings discarded files back, so for now the Host takes that only from it. */
  local: boolean
}

/** The action or the reason there is none: always one place, the scope row. A turn reads as on its card. */
export function scopeAction(list: ChangeList | undefined, turn: TurnChanges | undefined, rights: ScopeRights): ScopeAction {
  if (!list || list.unavailable) return { kind: 'none' }
  if (list.scope === 'session' || list.scope === 'base') return { kind: 'why', text: COPY.readOnly }
  if (list.scope !== 'uncommitted') return turnUndo(list, turn, rights)
  if (rights.offline) return { kind: 'why', text: COPY.undoOffline }
  if (list.conflict) return { kind: 'why', text: conflictWhy(list.conflict.operation) }
  if (rights.readOnly) return { kind: 'why', text: COPY.sessionReadOnly }
  if (!rights.canRun) return { kind: 'why', text: COPY.deviceReadOnly }
  if (!rights.local) return { kind: 'why', text: COPY.macOnly }
  if (!list.files.length) return { kind: 'none' }
  return rights.active ? { kind: 'why', text: COPY.undoRunning } : { kind: 'discard' }
}

const OPERATION_WORD: Record<GitOperation, string> = {
  get merge() {
    return COPY.merge
  },
  get rebase() {
    return COPY.rebase
  },
  get 'cherry-pick'() {
    return COPY.cherryPick
  },
  get revert() {
    return COPY.revert
  },
  get unmerged() {
    return COPY.resolving
  },
}

function conflictWhy(operation: GitOperation): string {
  return operation === 'unmerged' ? COPY.undoConflict : COPY.undoOperation(OPERATION_WORD[operation])
}

export function conflictLine(conflict: NonNullable<ChangeList['conflict']>): string {
  const files = conflict.files ? COPY.conflictCount(conflict.files) : COPY.resolved
  return conflict.operation === 'unmerged' ? COPY.unresolved(files) : COPY.operation(OPERATION_WORD[conflict.operation], files)
}

/**
 * 撤销此文件 reaches a row on a turn that can still go back, or that cannot only because some of its files changed since:
 * this is then the one way to take back the rest, and the Host still refuses the files that changed.
 */
export const canUndoFile = (action: ScopeAction, file: ChangedFile) =>
  (action.kind === 'undo' || (action.kind === 'why' && action.someFiles === true)) && !file.secret && !file.notRetained

// ---- the lines above the list ----------------------------------------------------------------------------------------

export type ChangeLine =
  | { kind: 'partial' }
  | { kind: 'conflict'; text: string }
  | { kind: 'other-session'; sessions: string[] }
  | { kind: 'running' }
  | { kind: 'interrupted' }
  | { kind: 'not-git'; names: string[] }
  | { kind: 'base'; branch?: string; base?: string }

/** From this many files the panel reads each file only when it is opened. */
export const LARGE_LIST = 1000

export function changeLines(
  list: ChangeList | undefined,
  turn: TurnChanges | undefined,
  rootName: (id: string) => string,
  branch?: string,
  /** The session runs and this scope moves with it; a past turn picked from the menu does not. */
  moving = false,
): ChangeLine[] {
  if (!list) return []
  const lines: ChangeLine[] = []
  const running = (list.scope === 'turn' && turn?.state === 'running') || (moving && (!list.unavailable || list.unavailable === 'no-turns'))
  if (running) lines.push({ kind: 'running' })
  else if (list.scope === 'turn' && turn?.state === 'interrupted') lines.push({ kind: 'interrupted' })
  if (list.conflict) lines.push({ kind: 'conflict', text: conflictLine(list.conflict) })
  if (list.partial) lines.push({ kind: 'partial' })
  if (list.otherSessions?.length) lines.push({ kind: 'other-session', sessions: list.otherSessions })
  if (list.notGit?.length) lines.push({ kind: 'not-git', names: list.notGit.map(rootName) })
  if (list.scope === 'base' && !list.unavailable)
    lines.push({ kind: 'base', ...(branch ? { branch } : {}), ...(list.base ? { base: list.base } : {}) })
  return lines
}

// ---- empty states ----------------------------------------------------------------------------------------------------

export interface EmptyState {
  title: string
  detail?: string
  retry?: true
}

export function emptyState(list: ChangeList | undefined): EmptyState | undefined {
  if (!list) return undefined
  switch (list.unavailable) {
    case 'no-turns':
      return { title: COPY.nothingInSession }
    case 'not-git':
      return { title: COPY.notRoot }
    case 'git-missing':
      return { title: COPY.noGit, detail: COPY.gitSide }
    case 'git-failed':
      return { title: COPY.gitFailed, detail: COPY.gitSide, retry: true }
    case 'no-head':
      return { title: COPY.noCommits }
    case 'no-base':
      return { title: COPY.noBase }
    case undefined:
      break
  }
  if (list.files.length) return undefined
  if (list.scope === 'turn') {
    if (list.running) return { title: COPY.noFilesYet }
    return { title: COPY.noFilesInTurn }
  }
  if (list.scope === 'session') return { title: COPY.noChangesInSession }
  if (list.scope === 'uncommitted') return { title: COPY.noUncommitted }
  return { title: COPY.noChangesSinceBranch }
}

// ---- undo: the warning and the receipt ---------------------------------------------------------------------------------

const NOT_RESTORED_WHY: Record<NotRestoredFile['reason'], string> = {
  get 'not-retained'() {
    return COPY.notKept
  },
  get secret() {
    return COPY.secretKept
  },
  get 'folder-missing'() {
    return COPY.missingFolder
  },
}
export const UNDO_SCOPE_COPY = defineCopy(
  {
    outside: '在文件夹之外或被忽略',
    notes: '撤销只覆盖会话文件夹内的文件。写到文件夹外的没有痕迹；.git、node_modules、dist、build 不记录。',
  },
  {
    outside: 'Outside the folder or ignored',
    notes:
      'Undo covers files inside the session folders. Writes elsewhere and changes in .git, node_modules, dist or build aren’t recorded.',
  },
)

export interface MissedFile {
  path: string
  why: string
}

/** What 撤销本轮 will leave, known from the list; nothing to warn about means the undo runs at once. */
export function undoWarning(list: ChangeList): { restore: number; remove: number; missed: MissedFile[] } {
  let restore = 0,
    remove = 0
  const missed: MissedFile[] = []
  for (const file of list.files) {
    if (file.secret) missed.push({ path: file.path, why: NOT_RESTORED_WHY.secret })
    else if (file.notRetained) missed.push({ path: file.path, why: NOT_RESTORED_WHY['not-retained'] })
    else if (file.status === 'A') remove++
    else restore++
  }
  for (const path of list.notCovered ?? []) missed.push({ path, why: UNDO_SCOPE_COPY.outside })
  return { restore, remove, missed }
}

/** The words for what was written, reading the same in the warning and the receipt. */
export function writtenWords(restore: number, remove: number): string {
  const parts = [...(restore ? [COPY.restoreCount(restore)] : []), ...(remove ? [COPY.removeCount(remove)] : [])]
  return parts.length ? COPY.written(parts) : COPY.nothingToWrite
}

export function missedFiles(
  notRestored: readonly NotRestoredFile[],
  notCovered: readonly string[],
  skipped = notRestored.length,
): {
  files: MissedFile[]
  /** Files the Host counted beyond the ones it names. */
  more: number
} {
  return {
    files: [
      ...notRestored.map(file => ({ path: file.path, why: NOT_RESTORED_WHY[file.reason] })),
      ...notCovered.map(path => ({ path, why: UNDO_SCOPE_COPY.outside })),
    ],
    more: Math.max(0, skipped - notRestored.length),
  }
}
