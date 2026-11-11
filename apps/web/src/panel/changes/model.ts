// What the 改动 tab draws from the Host's answers: which scope is shown, the file tree, what stands in the scope row, the
// lines above the list and the empty states. Pure, so every state of the table has a test. See docs/CHANGES.md.
import type { ChangedFile, ChangeHunk, ChangeList, ChangeScope, GitOperation, Message, NotRestoredFile, TurnChanges } from '@latch/protocol'
import { turnUndo, type TurnUndo, type UndoRights } from '../../conversation/turnChanges.ts'
import type { DiffHunk, DiffGap, DiffLine, LineDiff } from '../../diff.ts'

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
  return number !== undefined && number < oldestKept(numbers, turns) && turns.length > 0
    ? `这一轮已不在保留的 ${KEPT_TURNS} 轮内`
    : '这一轮没有记录到改动'
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
      ? '运行中'
      : turn.state === 'interrupted'
        ? '已中断'
        : turn.undone
          ? '已撤销'
          : turn.files === undefined
            ? ''
            : `${turn.files} 个文件`
  return { label: number === undefined ? '这一轮' : `第 ${number} 轮`, meta: [clock(turn.startedAt), what].filter(Boolean).join(' · ') }
}

/** Git's main branch is not always named main: a list says so; until one has, the menu does not guess. */
export const baseLabel = (base: string | undefined) => (base ? `与 ${base} 比较` : '与主分支比较')

/** A detached HEAD and the main branch itself have nothing to compare; anything else the answer decides. */
export const offersBase = (branch: string | undefined) =>
  branch === undefined || !(branch === 'main' || branch === 'master' || branch.startsWith('分离于'))

export function scopeLabel(choice: ScopeChoice, numbers: ReadonlyMap<string, number>, base: string | undefined): string {
  switch (choice.kind) {
    case 'latest':
      return '本轮'
    case 'turn': {
      const number = numbers.get(choice.turnId)
      return number === undefined ? '这一轮' : `第 ${number} 轮`
    }
    case 'session':
      return '这个会话'
    case 'uncommitted':
      return '未提交'
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
  const by = file.byCommand ? '由命令修改' : file.byUser ? '两轮之间改动' : undefined
  const absent = file.secret
    ? '可能含密钥，只列路径'
    : file.notRetained
      ? '内容没有留存'
      : file.large
        ? '超过 1 MB，打开文件查看'
        : file.binary
          ? '二进制文件'
          : undefined
  if (absent) return { text: absent, ...(by ? { title: by } : {}) }
  if (!by) return undefined
  return { text: by, ...(file.byUser ? { title: '在两轮之间改动的：可能是你，也可能是别的程序' } : {}) }
}

export const contentHidden = (file: ChangedFile) => Boolean(file.secret || file.notRetained || file.large || file.binary)

// ---- turning hunks into what the renderer draws ----------------------------------------------------------------------

const CONTEXT = 3

/**
 * The review from a file's whole-context hunk: changes with three lines around each, the rest in bands. The Host's own
 * line pairing is kept, so the numbers here and in its patch agree.
 */
export function reviewOf(hunks: readonly ChangeHunk[]): { view: LineDiff; oldText: string; newText: string } {
  const lines: DiffLine[] = hunks.flatMap(hunk => hunk.lines as DiffLine[])
  const near = lines.map(() => false)
  lines.forEach((line, at) => {
    if (line.kind === 'context') return
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
  if (list.scope === 'session' || list.scope === 'base') return { kind: 'why', text: '只读' }
  if (list.scope !== 'uncommitted') return turnUndo(list, turn, rights)
  if (rights.offline) return { kind: 'why', text: '离线时不能撤销' }
  if (list.conflict) return { kind: 'why', text: conflictWhy(list.conflict.operation) }
  if (rights.readOnly) return { kind: 'why', text: '这个会话只能查看' }
  if (!rights.canRun) return { kind: 'why', text: '这台设备只能查看' }
  if (!rights.local) return { kind: 'why', text: '只能在 Mac 的 Latch 中撤销' }
  if (!list.files.length) return { kind: 'none' }
  return rights.active ? { kind: 'why', text: '运行中不能撤销' } : { kind: 'discard' }
}

const OPERATION_WORD: Record<GitOperation, string> = {
  merge: '合并',
  rebase: '变基',
  'cherry-pick': '拣选提交',
  revert: '还原提交',
  unmerged: '解决冲突',
}

function conflictWhy(operation: GitOperation): string {
  return operation === 'unmerged' ? '有冲突时不能撤销' : `${OPERATION_WORD[operation]}中不能撤销`
}

export function conflictLine(conflict: NonNullable<ChangeList['conflict']>): string {
  const files = conflict.files ? `${conflict.files} 个文件有冲突` : '冲突已解决，还没有完成'
  return conflict.operation === 'unmerged' ? `仓库有未解决的冲突 · ${files}` : `仓库正在${OPERATION_WORD[conflict.operation]} · ${files}`
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
  | { kind: 'large' }

/** From this many files the list says it reads each file only when opened. */
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
  if (list.files.length >= LARGE_LIST) lines.push({ kind: 'large' })
  return lines
}

// ---- empty states ----------------------------------------------------------------------------------------------------

export interface EmptyState {
  title: string
  detail?: string
  retry?: true
}

const GIT_SIDE = '本轮和这个会话不受影响。'

export function emptyState(list: ChangeList | undefined): EmptyState | undefined {
  if (!list) return undefined
  switch (list.unavailable) {
    case 'no-turns':
      return { title: '这个会话还没有记录到改动' }
    case 'not-git':
      return { title: '这个文件夹不是 Git 仓库的顶层', detail: '没有未提交和比较可看。本轮和这个会话照常。' }
    case 'git-missing':
      return { title: '找不到 Git', detail: GIT_SIDE }
    case 'git-failed':
      return { title: '读不到 Git 状态', detail: GIT_SIDE, retry: true }
    case 'no-head':
      return { title: '还没有提交' }
    case 'no-base':
      return { title: '没有可比较的主分支', detail: 'HEAD 在主分支上、分离，或者没有 main 和 master。' }
    case undefined:
      break
  }
  if (list.files.length) return undefined
  if (list.scope === 'turn') {
    if (list.running) return { title: '还没有改动文件' }
    return { title: '这一轮没有改动文件' }
  }
  if (list.scope === 'session') return { title: '这个会话没有留下改动' }
  if (list.scope === 'uncommitted') return { title: '没有未提交的改动' }
  return { title: '和分叉点相比没有改动' }
}

// ---- undo: the warning and the receipt ---------------------------------------------------------------------------------

const NOT_RESTORED_WHY: Record<NotRestoredFile['reason'], string> = {
  'not-retained': '内容没有留存',
  secret: '可能含密钥，不写也不删',
  'folder-missing': '文件夹已不在',
}
export const NOT_COVERED_WHY = '在文件夹之外或被忽略'
export const SCOPE_NOTE = '撤销只覆盖会话文件夹内的文件。写到文件夹外的没有痕迹；.git、node_modules、dist、build 不记录。'

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
  for (const path of list.notCovered ?? []) missed.push({ path, why: NOT_COVERED_WHY })
  return { restore, remove, missed }
}

/** The words for what was written, reading the same in the warning and the receipt. */
export function writtenWords(restore: number, remove: number): string {
  const parts = [...(restore ? [`写回 ${restore} 个文件`] : []), ...(remove ? [`删除 ${remove} 个新文件`] : [])]
  return parts.length ? `${parts.join('，')}。` : '没有需要写入的文件。'
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
      ...notCovered.map(path => ({ path, why: NOT_COVERED_WHY })),
    ],
    more: Math.max(0, skipped - notRestored.length),
  }
}
