// The changes engine: a snapshot of a session's folders when each turn starts and settles, the scopes 本轮, 这个会话,
// 未提交 and 与 main 比较, 撤销本轮 and 恢复, discards and patches. Routes and the session lifecycle call it; see
// docs/CHANGES.md.
import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { constants } from 'node:fs'
import { lstat, open, readdir, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CHANGE_NOTE_PREFIX,
  CHANGE_SCOPES,
  type Availability,
  type ChangedFile,
  type ChangeList,
  type ChangePatch,
  type ChangeReceipt,
  type ChangeScope,
  type DiscardPreview,
  type DiscardResult,
  type FileChangeDetail,
  type FileDiff,
  type FileMention,
  type NotRestoredFile,
  type RewindBlock,
  type RewindPreview,
  type RewindReceipt,
  type TurnChanges,
  type UndoBlock,
} from '@latch/protocol'
import { AppError, type ProjectFolder } from '@latch/sdk'
import { canonicalJson } from '@latch/core/node-kit'
import { excludeFromBackup } from '../backup.ts'
import type { FileRoot } from '../files/resolve.ts'
import { RUN_ID } from '../session-meta.ts'
import { attributeChange, editsByFile, uncoveredEdits, type FolderSpellings } from './attribution.ts'
import { capture, compare, sameState, stateOf } from './capture.ts'
import { EMPTY_TEXT, TEXT_LIMIT } from './diff.ts'
import { BlobIdCache, gitPairs, type GitScope } from './git-scope.ts'
import { GitReader, blobId, findGit } from './git.ts'
import { ObjectStore, hashHandle, type CloneFile } from './objects.ts'
import {
  NAMED_FILE_LIMIT,
  OTHER_SESSION_LIMIT,
  SNAPSHOTS_DIR,
  SessionFiles,
  directoryKey,
  privateDirectory,
  type Change,
  type FileState,
  type Manifest,
  type PersonEdit,
  PERSON_EDIT_LIMIT,
  type Receipt,
  type TurnNote,
  type TurnRecord,
} from './records.ts'
import { removeFrom, writeInto, type Source } from './restore.ts'
import { Contents, compareSides, describe, hunksOf, patchOf, readWorkFile, sha256, type Pair, type Side } from './sides.ts'
import type { ChangeWritePlan, DiscardTarget } from './types.ts'
import { ProtectedIndex, fileKey, realRoots, signature, splitKey, walkFolders } from './walk.ts'

const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/u
const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/u

/** A session as the engine needs it: its ID, its project, and its folders as frozen when it was created. */
export interface ChangesSession {
  id: string
  projectId: string
  folders: readonly ProjectFolder[]
}

export interface ChangeLimits {
  /** Turns kept per session, oldest dropped first. */
  turnsPerSession: number
  /** Logical bytes of kept content per project; past it the oldest turns go first. */
  projectBytes: number
  /** Files up to this size are copied into a snapshot; larger ones are cloned (APFS), or not kept on another volume. */
  copyLimit: number
  /** Larger files are never kept. */
  cloneLimit: number
  walkEntries: number
  walkDepth: number
  /** Time a snapshot may take; files left after it are recorded without content. */
  captureMs: number
  /** Content a list, file or patch request reads to count and draw lines. */
  readBytes: number
  patchBytes: number
  /** Tree entries and index paths per Git folder. */
  gitEntries: number
  /** Content one discard may restore from Git. */
  discardBytes: number
}
export const DEFAULT_LIMITS: ChangeLimits = {
  turnsPerSession: 20,
  projectBytes: 2 * 1024 ** 3,
  copyLimit: 1024 ** 2,
  cloneLimit: 128 * 1024 ** 2,
  walkEntries: 50_000,
  walkDepth: 32,
  captureMs: 10_000,
  readBytes: 32 * 1024 ** 2,
  patchBytes: 8 * 1024 ** 2,
  gitEntries: 100_000,
  discardBytes: 512 * 1024 ** 2,
}

export interface ChangesEngineOptions {
  /** The Host's data directory; snapshots live in its private `snapshots` entry. */
  dataDir: string
  /** Paths never recorded, read or written: the Host's guarded paths. */
  protectedPaths: readonly string[]
  now?: () => number
  log?: (text: string) => void
  limits?: Partial<ChangeLimits>
  /** Test seam: how larger files are cloned (default `/bin/cp -c` on macOS). */
  clone?: CloneFile
  /** The Git executable, or false for none; by default the first of the usual install paths. */
  git?: string | false
  /** Default: Time Machine's per-item exclusion (backup.ts). */
  excludeFromBackup?: (paths: string[]) => Promise<unknown>
}

/** Records a write in the audit log before it happens; the engine writes nothing when it throws. */
export type BeforeWrite = (plan: ChangeWritePlan) => Promise<void>

interface SessionState {
  id: string
  files: SessionFiles
  head?: Manifest
  turns: TurnRecord[]
  /** A note owed while the session had no turn to hold it. */
  note?: TurnNote
  /** Files the person saved with Latch's editor, oldest first. */
  edits: PersonEdit[]
  /** The turn this process saw start and not yet settle. */
  running?: string
}

interface SessionIndex {
  /** Every kept content the session's records refer to, with its size. */
  refs: Map<string, number>
  /** The part no pruning can drop: the head's and the running turn's. */
  pinned: Map<string, number>
  /** Start of the oldest turn that may be dropped. */
  oldest?: string
  /** No turns and none running: its head may be dropped too. */
  idle: boolean
}

interface ProjectState {
  id: string
  directory: string
  objects: ObjectStore
  storeDev: bigint
  sessions: Map<string, Promise<SessionState>>
  /** Kept content each session refers to, by session ID; read from disk on first need. */
  index?: Map<string, SessionIndex>
  queue: Promise<unknown>
}

interface Step {
  root: FileRoot
  path: string
  /** Write this content; absent: remove the file. */
  to?: { mode: number; hash: string; source: Source }
  /** Recognises the file to remove. */
  expect?: (handle: FileHandle, info: BigIntStats) => Promise<boolean>
  /** The content the plan saw there, so a plan confirmed earlier no longer matches once the file changes. */
  seen?: string
}

/** What a plan leaves as it is. */
interface Plan {
  steps: Step[]
  skipped: number
  notRestored: NotRestoredFile[]
}

interface Scoped {
  project: ProjectState
  state: SessionState
  turn?: TurnRecord
  pairs: Pair[]
  git?: GitScope
  list: Partial<ChangeList>
  contents: Contents
}

type Current = { mode: number; sig: string; hash?: string } | null | undefined

const codeOf = (error: unknown) => (error instanceof Error && 'code' in error ? error.code : undefined)
const iso = (ms: number) => new Date(ms).toISOString()
const BLOCKS: Record<UndoBlock, [string, string]> = {
  running: ['change-running', '会话运行中，结束后才能撤销。'],
  'not-settled': ['change-not-settled', '这一轮还没有记录完，暂时不能撤销。'],
  'changed-since': ['change-files-changed', '之后又改过这些文件。'],
  'no-changes': ['change-nothing', '这一轮没有改动文件。'],
  undone: ['change-undone', '这一轮的改动已经撤销。'],
  'not-undone': ['change-not-undone', '这一轮的改动没有撤销，无需恢复。'],
  'not-retained': ['change-not-retained', '这一轮改动的文件没有留存或可能含密钥，无法撤销。'],
}
const blocked = (reason: UndoBlock) => new AppError(409, BLOCKS[reason][0], BLOCKS[reason][1])
const REWIND_BLOCKS: Record<RewindBlock, [string, string]> = {
  running: ['change-running', '会话运行中，结束后才能退回文件。'],
  'not-recorded': ['change-not-recorded', '这一条之后有的轮次没有改动记录，文件退不回这一条之前。'],
  'not-settled': ['change-not-settled', '这一条之后有的轮次还没有记录完，暂时不能退回文件。'],
  partial: ['change-partial', '这一条之后有的轮次记录不完整，文件退不回这一条之前。'],
  'changed-since': ['change-files-changed', '之后又改过这些文件。'],
  'no-changes': ['change-nothing', '这一条之后没有改动文件。'],
  'not-retained': ['change-not-retained', '这一条之后改动的文件没有留存或可能含密钥，无法退回。'],
}
const rewindBlocked = (reason: RewindBlock) => new AppError(409, REWIND_BLOCKS[reason][0], REWIND_BLOCKS[reason][1])

function checkSession(session: ChangesSession): void {
  if (
    typeof session?.id !== 'string'
    || !session.id
    || session.id.length > 256
    || /[\u0000-\u001f\u007f]/u.test(session.id)
    || !PROJECT_ID.test(session.projectId)
    || !Array.isArray(session.folders)
    || session.folders.length > 8
  )
    throw new AppError(400, 'change-session-invalid', '会话信息无效。')
}

function checkScope(scope: string): asserts scope is ChangeScope {
  if (!CHANGE_SCOPES.includes(scope as ChangeScope)) throw new AppError(400, 'change-scope-invalid', '改动范围无效。')
}

const sameFolders = (a: readonly FileRoot[], b: readonly FileRoot[]) =>
  a.length === b.length && a.every((folder, index) => folder.id === b[index]!.id && folder.path === b[index]!.path)

const notesOf = (state: Pick<SessionState, 'turns' | 'note'>): TurnNote[] => [
  ...state.turns.flatMap(turn => (turn.note ? [turn.note] : [])),
  ...(state.note ? [state.note] : []),
]

const reasonOf = (state: FileState): NotRestoredFile['reason'] => (state.kept === 'secret' ? 'secret' : 'not-retained')

/** How many edited files a note names; the rest are counted. */
const NAMED_EDITS = 5

/** The note's words, from the notes of the turns it covers and the files the person edited. */
function noteText(notes: readonly TurnNote[], edits: readonly PersonEdit[] = []): string {
  const of = (kind: TurnNote['kind']) => notes.filter(note => note.kind === kind)
  const edited = [...new Set(edits.map(edit => edit.display))]
  const undone = of('undo').length,
    redone = of('redo').length,
    files = notes.reduce((sum, note) => sum + (note.kind === 'files' ? note.files : (note.discarded ?? 0)), 0),
    skipped = notes.reduce((sum, note) => sum + note.skipped, 0)
  const parts = [
    ...(undone ? [`用户撤销了 ${undone} 轮改动，相关文件已回到${undone > 1 ? '那些轮次' : '那一轮'}开始时的内容`] : []),
    ...(redone ? [`用户恢复了之前撤销的 ${redone} 轮改动，相关文件已回到${redone > 1 ? '那些轮次' : '那一轮'}结束时的内容`] : []),
    ...(files ? [`用户撤销了 ${files} 个文件的改动`] : []),
    ...(skipped ? [`有 ${skipped} 个文件没有留存或可能含密钥，没有改动`] : []),
    ...(edited.length
      ? [`用户编辑了 ${edited.slice(0, NAMED_EDITS).join('、')}${edited.length > NAMED_EDITS ? ` 等 ${edited.length} 个文件` : ''}`]
      : []),
  ]
  return `${CHANGE_NOTE_PREFIX}在这条消息之前，${parts.join('；')}。不要假定文件还是你上次看到的样子，需要时重新读取。`
}

/**
 * A note after files were written for this turn. An undo and its redo cancel out while nothing has been told yet; what a
 * discard wrote stays owed through both.
 */
function nextNote(current: TurnNote | undefined, kind: TurnNote['kind'], files: number, skipped: number): TurnNote | undefined {
  const pending = current?.told ? undefined : current
  if (kind === 'files') {
    // A discard that wrote nothing changed nothing the engine knows about.
    if (!files) return pending
    if (!pending) return { kind, files, skipped }
    return pending.kind === 'files'
      ? { kind, files: pending.files + files, skipped: pending.skipped + skipped }
      : { kind: pending.kind, files: pending.files, discarded: (pending.discarded ?? 0) + files, skipped: pending.skipped + skipped }
  }
  const discarded = pending?.kind === 'files' ? pending.files : (pending?.discarded ?? 0)
  if (pending && pending.kind !== 'files' && pending.kind !== kind)
    return discarded ? { kind: 'files', files: discarded, skipped: 0 } : undefined
  return files || skipped ? { kind, files, skipped, ...(discarded ? { discarded } : {}) } : pending
}

/** A deleted file whose recorded content reappears at a new path in the same folder was renamed. */
function renames(pairs: Pair[]): Pair[] {
  const added = new Map<string, Pair>()
  for (const pair of pairs)
    if (!pair.before && pair.after?.from === 'record' && pair.after.state.hash) added.set(`${pair.root}\n${pair.after.state.hash}`, pair)
  const result: Pair[] = []
  for (const pair of pairs) {
    const match =
      pair.before?.from === 'record' && !pair.after && pair.before.state.hash
        ? added.get(`${pair.root}\n${pair.before.state.hash}`)
        : undefined
    if (match && !match.oldPath) {
      match.oldPath = pair.path
      match.before = pair.before
    } else result.push(pair)
  }
  return result
}

export class ChangesEngine {
  private readonly root: string
  private readonly limits: ChangeLimits
  private readonly now: () => number
  private readonly log: (text: string) => void
  private readonly git: GitReader | undefined
  private readonly blobIds = new BlobIdCache()
  private readonly projects = new Map<string, Promise<ProjectState>>()
  private readonly busy = new Set<Promise<unknown>>()
  private closed = false

  private constructor(private readonly options: ChangesEngineOptions) {
    this.root = join(options.dataDir, SNAPSHOTS_DIR)
    this.limits = { ...DEFAULT_LIMITS, ...options.limits }
    this.now = options.now ?? Date.now
    this.log = options.log ?? (() => {})
    const binary = options.git === false ? undefined : (options.git ?? findGit())
    this.git = binary ? new GitReader({ binary }) : undefined
  }

  /** Opens the snapshots directory: private (0700) and kept out of Time Machine backups. */
  static async open(options: ChangesEngineOptions): Promise<ChangesEngine> {
    const engine = new ChangesEngine(options)
    await privateDirectory(engine.root)
    await (options.excludeFromBackup ?? (paths => excludeFromBackup(paths, { log: engine.log })))([engine.root])
    return engine
  }

  // ---- state -------------------------------------------------------------------------------------------------------

  private track<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new AppError(503, 'change-closed', '改动记录已关闭。'))
    const running = work()
    this.busy.add(running)
    void running.then(
      () => this.busy.delete(running),
      () => this.busy.delete(running),
    )
    return running
  }

  private project(projectId: string): Promise<ProjectState> {
    let project = this.projects.get(projectId)
    if (!project) {
      project = (async (): Promise<ProjectState> => {
        const directory = join(this.root, directoryKey(projectId))
        await privateDirectory(directory)
        await privateDirectory(join(directory, 'objects'))
        await privateDirectory(join(directory, 'sessions'))
        return {
          id: projectId,
          directory,
          objects: new ObjectStore(join(directory, 'objects'), this.options.clone),
          storeDev: (await lstat(join(directory, 'objects'), { bigint: true })).dev,
          sessions: new Map(),
          queue: Promise.resolve(),
        }
      })()
      project.catch(() => this.projects.delete(projectId))
      this.projects.set(projectId, project)
    }
    return project
  }

  private session(project: ProjectState, sessionId: string): Promise<SessionState> {
    let state = project.sessions.get(sessionId)
    if (!state) {
      state = (async (): Promise<SessionState> => {
        const files = new SessionFiles(join(project.directory, 'sessions', directoryKey(sessionId)), sessionId, project.id)
        const [head, turns, note, edits] = await Promise.all([files.readHead(), files.readTurns(), files.readNote(), files.readEdits()])
        return { id: sessionId, files, ...(head ? { head } : {}), turns, ...(note ? { note } : {}), edits }
      })()
      state.catch(() => project.sessions.delete(sessionId))
      project.sessions.set(sessionId, state)
    }
    return state
  }

  /** One mutation of a project at a time: snapshots, undo, discards and pruning. */
  private locked<T>(project: ProjectState, work: () => Promise<T>): Promise<T> {
    const next = project.queue.then(work, work)
    project.queue = next.catch(() => {})
    return next
  }

  private mutate<T>(projectId: string, work: (project: ProjectState) => Promise<T>): Promise<T> {
    return this.track(async () => {
      const project = await this.project(projectId)
      return this.locked(project, () => work(project))
    })
  }

  private async save(project: ProjectState, state: SessionState): Promise<void> {
    await privateDirectory(state.files.directory)
    await state.files.writeHead(state.head)
    await state.files.writeTurns(state.turns, state.note, state.edits)
    project.index?.set(state.id, this.indexOf(state))
  }

  // ---- retention ---------------------------------------------------------------------------------------------------

  private indexOf(state: { head?: Manifest; turns: readonly TurnRecord[]; running?: string }): SessionIndex {
    const refs = new Map<string, number>(),
      pinned = new Map<string, number>()
    const add = (file: FileState | undefined, fixed: boolean) => {
      if (file?.kept !== 'stored' || !file.hash) return
      refs.set(file.hash, file.size)
      if (fixed) pinned.set(file.hash, file.size)
    }
    for (const entry of Object.values(state.head?.files ?? {})) add(entry, true)
    for (const turn of state.turns)
      for (const change of [...turn.between, ...turn.changes]) {
        add(change.before, turn.state === 'running')
        add(change.after, turn.state === 'running')
      }
    const oldest = state.turns.find(turn => turn.state === 'settled' && turn.turnId !== state.running)
    return { refs, pinned, ...(oldest ? { oldest: oldest.startedAt } : {}), idle: !state.turns.length && !state.running }
  }

  /** What every session of the project refers to, read from disk for sessions this process has not loaded. */
  private async projectIndex(project: ProjectState): Promise<Map<string, SessionIndex>> {
    if (project.index) return project.index
    const index = new Map<string, SessionIndex>()
    const directory = join(project.directory, 'sessions')
    for (const name of await readdir(directory).catch(() => [])) {
      if (!/^[0-9a-f]{32}$/u.test(name)) continue
      const scanned = await SessionFiles.scan(join(directory, name))
      if (scanned && scanned.projectId === project.id && directoryKey(scanned.sessionId) === name)
        index.set(scanned.sessionId, this.indexOf(scanned))
    }
    for (const [id, state] of project.sessions) {
      const loaded = await state.catch(() => undefined)
      if (loaded) index.set(id, this.indexOf(loaded))
    }
    project.index = index
    return index
  }

  /** Logical bytes of the project's kept content: all of it, or only what pruning cannot drop. */
  private async retained(project: ProjectState, part: 'refs' | 'pinned' = 'refs'): Promise<number> {
    const sizes = new Map<string, number>()
    for (const session of (await this.projectIndex(project)).values()) for (const [hash, size] of session[part]) sizes.set(hash, size)
    let total = 0
    for (const size of sizes.values()) total += size
    return total
  }

  /**
   * Drops the session's oldest settled turn. The changes recorded before the new oldest turn started go with it: no
   * scope starts earlier than that turn.
   */
  private dropOldest(state: SessionState): boolean {
    const victim = state.turns.find(turn => turn.state === 'settled' && turn.turnId !== state.running)
    if (!victim) return false
    state.turns = state.turns.filter(turn => turn !== victim)
    if (state.turns[0]?.between.length) state.turns[0] = { ...state.turns[0], between: [] }
    return true
  }

  /** Drops the session's oldest turns past the per-session limit. */
  private trimSession(state: SessionState): boolean {
    let dropped = false
    while (state.turns.length > this.limits.turnsPerSession && this.dropOldest(state)) dropped = true
    return dropped
  }

  /** Drops the project's oldest turns, then the heads of sessions left without turns, until it fits its cap. */
  private async enforceCap(project: ProjectState): Promise<boolean> {
    let dropped = false
    while ((await this.retained(project)) > this.limits.projectBytes) {
      const index = await this.projectIndex(project)
      const oldest = [...index]
        .filter(([, session]) => session.oldest)
        .toSorted(([, a], [, b]) => a.oldest!.localeCompare(b.oldest!))[0]?.[0]
      const target = oldest ?? [...index].find(([, session]) => session.idle && session.refs.size)?.[0]
      if (!target) break
      const state = await this.session(project, target)
      const hadHead = Boolean(state.head)
      const victim = this.dropOldest(state)
      if (!state.turns.length && !state.running) delete state.head
      if (!victim && hadHead === Boolean(state.head)) {
        // The index was older than the session's records; refreshed, this session is no longer a candidate.
        index.set(target, this.indexOf(state))
        continue
      }
      await this.save(project, state)
      dropped = true
    }
    return dropped
  }

  /** Removes content no session refers to, and temporary files a stopped write left behind. */
  private async collect(project: ProjectState): Promise<void> {
    const referenced = new Set<string>()
    for (const session of (await this.projectIndex(project)).values()) for (const hash of session.refs.keys()) referenced.add(hash)
    const { objects, leftovers } = await project.objects.list()
    for (const hash of objects) if (!referenced.has(hash)) await project.objects.remove(hash)
    for (const path of leftovers) await unlink(path).catch(() => {})
  }

  // ---- snapshots ---------------------------------------------------------------------------------------------------

  private async snapshot(project: ProjectState, roots: readonly FileRoot[], guard: ProtectedIndex, previous: Manifest | undefined) {
    const deadline = this.now() + this.limits.captureMs
    const walk = await walkFolders(roots, guard, { entries: this.limits.walkEntries, depth: this.limits.walkDepth, deadline })
    return capture(roots, walk, previous, {
      objects: project.objects,
      storeDev: project.storeDev,
      copyLimit: this.limits.copyLimit,
      cloneLimit: this.limits.cloneLimit,
      deadline,
      // Older turns make way afterwards (enforceCap); only the content no pruning can drop limits a snapshot.
      room: { bytes: Math.max(0, this.limits.projectBytes - (await this.retained(project, 'pinned'))) },
      now: this.now,
    })
  }

  /**
   * Records the session's folders as a turn starts. Resolves once the snapshot is on disk, so the caller can hold the
   * turn's first prompt until then. A turn already recorded is left as it is.
   */
  async beginTurn(input: { session: ChangesSession; turnId: string }): Promise<void> {
    const { session, turnId } = input
    checkSession(session)
    if (!RUN_ID.test(turnId)) throw new AppError(400, 'change-turn-invalid', '轮次标识无效。')
    await this.mutate(session.projectId, async project => {
      const state = await this.session(project, session.id)
      await this.settleStale(project, state, turnId)
      if (state.turns.some(turn => turn.turnId === turnId)) return
      const guard = await ProtectedIndex.of(this.options.protectedPaths)
      const roots = await realRoots(session.folders, guard)
      if (!roots.length) return
      const startedAt = this.now()
      const previous = state.head && sameFolders(state.head.folders, roots) ? state.head : undefined
      const head = await this.snapshot(project, roots, guard, previous)
      const between = previous ? compare(previous, head) : { changes: [], partial: false }
      state.head = head
      // The message that carried a note has reached the engine with this turn; what no message carried stays due.
      const told = <T extends { note?: TurnNote }>(holder: T): T =>
        holder.note?.requestId && !holder.note.told ? { ...holder, note: { ...holder.note, told: true as const } } : holder
      if (state.note) state.note = told({ note: state.note }).note!
      state.edits = state.edits.map(edit => (edit.requestId && !edit.told ? { ...edit, told: true as const } : edit))
      state.turns = [
        ...state.turns.map(told),
        {
          turnId,
          startedAt: iso(startedAt),
          state: 'running',
          attributed: false,
          between: between.changes,
          changes: [],
          receipts: [],
          ...(between.partial || head.complete.length < roots.length ? { partial: true as const } : {}),
        },
      ]
      state.running = turnId
      const trimmed = this.trimSession(state)
      await this.save(project, state)
      if ((await this.enforceCap(project)) || trimmed) await this.collect(project)
    })
  }

  /**
   * Records the session's folders as a turn settles and compares them with its start. `edits` are the turn's own file
   * edits (`ToolDetail.diffs` of its tool calls); without them its changes carry no attribution.
   */
  async settleTurn(input: {
    session: ChangesSession
    turnId: string
    outcome: NonNullable<TurnRecord['outcome']>
    edits?: readonly FileDiff[]
  }): Promise<void> {
    const { session, turnId } = input
    checkSession(session)
    await this.mutate(session.projectId, async project => {
      const state = await this.session(project, session.id)
      const turn = state.turns.find(item => item.turnId === turnId)
      if (turn?.state === 'running') await this.settle(project, state, turn, input.outcome, input.edits, session.folders)
    })
  }

  private async settle(
    project: ProjectState,
    state: SessionState,
    turn: TurnRecord,
    outcome: NonNullable<TurnRecord['outcome']>,
    edits: readonly FileDiff[] | undefined,
    folders: readonly ProjectFolder[],
  ): Promise<void> {
    const start = state.head
    let changes: Change[] = [],
      partial = turn.partial ?? false,
      notCovered: string[] = []
    if (start && state.turns.at(-1) === turn) {
      const guard = await ProtectedIndex.of(this.options.protectedPaths)
      const end = await this.snapshot(project, await realRoots(start.folders, guard), guard, start)
      const compared = compare(start, end)
      changes = compared.changes
      partial ||= compared.partial
      if (edits) {
        const spellings = this.spellings(start, folders)
        await this.attribute(project, changes, edits, spellings)
        notCovered = uncoveredEdits(edits, spellings)
      }
      state.head = end
    } else partial = true
    const settled: TurnRecord = {
      ...turn,
      state: 'settled',
      settledAt: iso(this.now()),
      outcome,
      changes,
      attributed: edits !== undefined,
      ...(partial ? { partial: true as const } : {}),
      ...(notCovered.length ? { notCovered } : {}),
    }
    state.turns = state.turns.map(item => (item === turn ? settled : item))
    if (state.running === turn.turnId) delete state.running
    await this.save(project, state)
    if (await this.enforceCap(project)) await this.collect(project)
  }

  private spellings(start: Manifest, folders: readonly ProjectFolder[]): FolderSpellings[] {
    return start.folders.map(folder => ({
      id: folder.id,
      paths: [folder.path, ...folders.filter(item => item.id === folder.id).map(item => item.path)],
    }))
  }

  private async attribute(project: ProjectState, changes: Change[], edits: readonly FileDiff[], spellings: readonly FolderSpellings[]) {
    const byFile = editsByFile(edits, spellings)
    const contents = new Contents({ objects: project.objects }, this.limits.readBytes)
    for (const change of changes) {
      const text = (state: FileState | undefined) =>
        state ? contents.load({ from: 'record', state }, change.path).then(loaded => loaded.text) : Promise.resolve(EMPTY_TEXT)
      const [before, after] = await Promise.all([text(change.before), text(change.after)])
      Object.assign(change, attributeChange(byFile.get(fileKey(change.root, change.path)) ?? [], before, after))
    }
  }

  /**
   * Settles, as interrupted and without attribution, a turn left running: by an earlier Host process, or, when `next`
   * starts, any other turn still running (its settlement never came).
   */
  private async settleStale(project: ProjectState, state: SessionState, next?: string): Promise<void> {
    const last = state.turns.at(-1)
    if (last?.state !== 'running' || last.turnId === next) return
    if (next === undefined && state.running === last.turnId) return
    await this.settle(project, state, last, 'interrupted', undefined, [])
  }

  /** Settles the turns a stopped Host left running and removes leftover temporary files. Call once at startup. */
  async recover(): Promise<void> {
    for (const name of await readdir(this.root).catch(() => [])) {
      if (!/^[0-9a-f]{32}$/u.test(name)) continue
      const directory = join(this.root, name, 'sessions')
      let projectId: string | undefined
      for (const entry of await readdir(directory).catch(() => [])) {
        const scanned = await SessionFiles.scan(join(directory, entry))
        if (!scanned || directoryKey(scanned.projectId) !== name || directoryKey(scanned.sessionId) !== entry) continue
        projectId = scanned.projectId
        if (scanned.turns.at(-1)?.state === 'running')
          await this.mutate(projectId, async project => this.settleStale(project, await this.session(project, scanned.sessionId)))
      }
      if (projectId) await this.mutate(projectId, project => this.collect(project))
    }
  }

  /** Records that other sessions ran in this turn's folder meanwhile; a turn no longer kept is left alone. */
  async noteOtherSessions(input: { session: ChangesSession; turnId: string; others: readonly string[] }): Promise<void> {
    const { session, turnId, others } = input
    checkSession(session)
    await this.mutate(session.projectId, async project => {
      const state = await this.session(project, session.id)
      const turn = state.turns.find(item => item.turnId === turnId)
      if (!turn) return
      const otherSessions = [...new Set([...(turn.otherSessions ?? []), ...others])].slice(0, OTHER_SESSION_LIMIT)
      state.turns = state.turns.map(item => (item === turn ? { ...turn, otherSessions } : item))
      await this.save(project, state)
    })
  }

  /** Forgets a deleted session's snapshots. */
  async deleteSession(input: { id: string; projectId: string }): Promise<void> {
    if (!PROJECT_ID.test(input.projectId)) throw new AppError(400, 'change-session-invalid', '会话信息无效。')
    await this.mutate(input.projectId, async project => {
      const state = await this.session(project, input.id)
      await state.files.remove()
      project.sessions.delete(input.id)
      ;(await this.projectIndex(project)).delete(input.id)
      await this.collect(project)
    })
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.busy])
  }

  // ---- scopes ------------------------------------------------------------------------------------------------------

  /** The work tree now against a record; `after` sides are read from disk. */
  private async livePairs(record: Manifest): Promise<{ pairs: Pair[]; partial: boolean }> {
    const guard = await ProtectedIndex.of(this.options.protectedPaths)
    const roots = await realRoots(record.folders, guard)
    const walk = await walkFolders(roots, guard, {
      entries: this.limits.walkEntries,
      depth: this.limits.walkDepth,
      deadline: this.now() + this.limits.captureMs,
    })
    const recorded = new Set(record.complete)
    const pairs: Pair[] = []
    let partial = roots.length < record.folders.length
    for (const key of [...new Set([...Object.keys(record.files), ...walk.files.keys()])].toSorted()) {
      const before = record.files[key],
        now = walk.files.get(key)
      const { root, path } = splitKey(key)
      if (before && now && before.sig === now.sig) continue
      if ((before && !now && !walk.complete.has(root)) || (!before && now && !recorded.has(root))) {
        partial = true
        continue
      }
      const folder = roots.find(item => item.id === root)
      const after: Side | undefined =
        now && folder ? { from: 'work', root: folder, path, size: now.size, mode: now.mode, dev: now.dev, ino: now.ino } : undefined
      // Touched but not changed: same content and mode as recorded.
      if (before?.hash && after?.from === 'work' && after.size <= TEXT_LIMIT && before.mode === after.mode) {
        const bytes = await readWorkFile(after)
        if (bytes && sha256(bytes) === before.hash) continue
      }
      pairs.push({ root, path, ...(before ? { before: { from: 'record', state: stateOf(before) } } : {}), ...(after ? { after } : {}) })
    }
    return { pairs, partial }
  }

  private turnOf(state: SessionState, turnId: string | undefined): TurnRecord | undefined {
    if (turnId === undefined) return state.turns.at(-1)
    const turn = state.turns.find(item => item.turnId === turnId)
    if (!turn) throw new AppError(404, 'change-turn-missing', '没有这一轮的改动记录。')
    return turn
  }

  private async turnPairs(state: SessionState, turn: TurnRecord): Promise<{ pairs: Pair[]; partial: boolean }> {
    if (turn.state === 'running')
      return state.head && state.turns.at(-1) === turn ? this.livePairs(state.head) : { pairs: [], partial: true }
    const pairs = turn.changes.map((change): Pair => ({
      root: change.root,
      path: change.path,
      ...(change.before ? { before: { from: 'record', state: change.before } } : {}),
      ...(change.after ? { after: { from: 'record', state: change.after } } : {}),
      ...(change.by === 'command' || change.by === 'mixed' ? { byCommand: true as const } : {}),
      ...(change.by ? { attribution: { by: change.by, ...(change.agentLines ? { agentLines: change.agentLines } : {}) } } : {}),
    }))
    return { pairs: renames(pairs), partial: turn.partial ?? false }
  }

  /** The oldest retained turn's start against now: every recorded change since, then the work tree now. */
  private async sessionPairs(state: SessionState): Promise<{ pairs: Pair[]; partial: boolean }> {
    const merged = new Map<string, Pair>()
    let partial = false
    const apply = (change: { root: string; path: string; before?: Side; after?: Side }, flag?: 'byCommand' | 'byUser') => {
      const key = fileKey(change.root, change.path)
      const pair = merged.get(key) ?? { root: change.root, path: change.path, ...(change.before ? { before: change.before } : {}) }
      if (change.after) pair.after = change.after
      else delete pair.after
      if (flag) pair[flag] = true
      merged.set(key, pair)
    }
    const side = (file: FileState | undefined): Side | undefined => (file ? { from: 'record', state: file } : undefined)
    state.turns.forEach((turn, index) => {
      partial ||= turn.partial ?? false
      if (index > 0)
        for (const change of turn.between) apply({ ...change, before: side(change.before), after: side(change.after) }, 'byUser')
      for (const change of turn.changes)
        apply(
          { ...change, before: side(change.before), after: side(change.after) },
          change.by === 'command' || change.by === 'mixed' ? 'byCommand' : undefined,
        )
    })
    if (state.head) {
      const live = await this.livePairs(state.head)
      partial ||= live.partial
      // After a settled turn, what changed since is the person's; while a turn runs it is that turn's.
      const flag = state.turns.at(-1)?.state === 'settled' ? 'byUser' : undefined
      for (const pair of live.pairs) apply(pair, flag)
    }
    const pairs: Pair[] = []
    for (const pair of merged.values()) {
      if (!pair.before && !pair.after) continue
      if (pair.before?.from === 'record' && pair.after?.from === 'record' && sameState(pair.before.state, pair.after.state)) continue
      if (pair.before?.from === 'record' && pair.before.state.hash && pair.after?.from === 'work' && pair.after.size <= TEXT_LIMIT) {
        const bytes = await readWorkFile(pair.after)
        if (bytes && sha256(bytes) === pair.before.state.hash && pair.before.state.mode === pair.after.mode) continue
      }
      if (pair.byUser && pair.after && (await this.personMade(state, pair.root, pair.path, pair.after))) pair.byPerson = true
      pairs.push(pair)
    }
    return { pairs: renames(pairs), partial }
  }

  /** The file holds what the person last saved with Latch's editor. */
  private async personMade(state: SessionState, root: string, path: string, after: Side): Promise<boolean> {
    const edit = state.edits.findLast(item => item.root === root && item.path === path)
    if (!edit) return false
    if (after.from === 'record') return after.state.hash === edit.hash
    if (after.from !== 'work' || after.size > TEXT_LIMIT) return false
    const bytes = await readWorkFile(after)
    return !!bytes && sha256(bytes) === edit.hash
  }

  private async scoped(session: ChangesSession, scope: ChangeScope, turnId: string | undefined): Promise<Scoped> {
    const project = await this.project(session.projectId)
    const state = await this.session(project, session.id)
    if (scope === 'turn' || scope === 'session') {
      const contents = new Contents({ objects: project.objects }, this.limits.readBytes)
      const turn = scope === 'turn' ? this.turnOf(state, turnId) : state.turns[0]
      if (!turn) return { project, state, pairs: [], list: { unavailable: 'no-turns' }, contents }
      const { pairs, partial } = scope === 'turn' ? await this.turnPairs(state, turn) : await this.sessionPairs(state)
      return {
        project,
        state,
        ...(scope === 'turn' ? { turn } : {}),
        pairs,
        list: {
          ...(scope === 'turn' ? { turnId: turn.turnId } : {}),
          ...(scope === 'turn' && turn.state === 'running' ? { running: true as const } : {}),
          ...(partial ? { partial: true as const } : {}),
        },
        contents,
      }
    }
    const git = await this.gitScope(session, scope)
    const blobs = await this.blobsFor(git, this.limits.readBytes)
    return {
      project,
      state,
      pairs: git.pairs,
      git,
      list: {
        ...(git.base ? { base: git.base } : {}),
        ...(git.notGit.length && !git.unavailable ? { notGit: git.notGit } : {}),
        ...(git.partial ? { partial: true as const } : {}),
        ...(git.unavailable ? { unavailable: git.unavailable } : {}),
        ...(git.conflict ? { conflict: git.conflict } : {}),
      },
      contents: new Contents({ objects: project.objects, blobs: oid => blobs.get(oid) }, this.limits.readBytes),
    }
  }

  private async gitScope(session: ChangesSession, scope: 'uncommitted' | 'base'): Promise<GitScope> {
    if (!this.git) return { pairs: [], repositories: new Map(), workIds: new Map(), notGit: [], partial: false, unavailable: 'git-missing' }
    const roots = await realRoots(session.folders, await ProtectedIndex.of(this.options.protectedPaths))
    return gitPairs(roots, scope, {
      reader: this.git,
      ids: this.blobIds,
      entryLimit: this.limits.gitEntries,
      hashLimit: this.limits.cloneLimit,
    })
  }

  /** The blobs of the scope's earlier sides, as many as fit `budget`. */
  private async blobsFor(git: GitScope, budget: number, maxSize = TEXT_LIMIT): Promise<Map<string, Buffer>> {
    const blobs = new Map<string, Buffer>()
    if (!this.git) return blobs
    for (const [root, layout] of git.repositories) {
      const oids: string[] = []
      for (const pair of git.pairs) {
        if (pair.root !== root || pair.before?.from !== 'blob' || pair.before.size > maxSize || budget < pair.before.size) continue
        budget -= pair.before.size
        oids.push(pair.before.oid)
      }
      try {
        for (const [oid, bytes] of await this.git.blobs(layout, oids, maxSize)) blobs.set(oid, bytes)
      } catch {
        // Listed without line counts.
      }
    }
    return blobs
  }

  /** A scope's changed files; `turnId` picks the turn for `turn` (default: the latest). */
  async list(input: { session: ChangesSession; scope: ChangeScope; turnId?: string }): Promise<ChangeList> {
    checkSession(input.session)
    checkScope(input.scope)
    return this.track(async () => {
      const scoped = await this.scoped(input.session, input.scope, input.turnId)
      const files: ChangedFile[] = []
      for (const pair of scoped.pairs) files.push(describe(pair, await compareSides(pair, scoped.contents)))
      files.sort((a, b) => a.root.localeCompare(b.root) || a.path.localeCompare(b.path))
      const totals = { files: files.length, add: 0, del: 0 }
      for (const file of files) {
        totals.add += file.add ?? 0
        totals.del += file.del ?? 0
      }
      const list: ChangeList = { scope: input.scope, files, totals, ...scoped.list }
      if (input.scope === 'turn' && scoped.turn) {
        if (scoped.turn.undone) list.undone = true
        if (scoped.turn.notCovered?.length) list.notCovered = scoped.turn.notCovered
        list.undo = await this.availability(scoped, input.session, 'undo')
        list.redo = await this.availability(scoped, input.session, 'redo')
      }
      const others =
        input.scope === 'turn'
          ? (scoped.turn?.otherSessions ?? [])
          : input.scope === 'session'
            ? scoped.state.turns.flatMap(turn => turn.otherSessions ?? [])
            : []
      if (others.length) list.otherSessions = [...new Set(others)]
      return list
    })
  }

  /** One file's hunks in a scope, with `context` lines around each change (Infinity: the whole file). */
  async file(input: {
    session: ChangesSession
    scope: ChangeScope
    turnId?: string
    file: FileMention
    context?: number
  }): Promise<FileChangeDetail> {
    checkSession(input.session)
    checkScope(input.scope)
    return this.track(async () => {
      const scoped = await this.scoped(input.session, input.scope, input.turnId)
      const pair = scoped.pairs.find(
        item => item.root === input.file.root && (item.path === input.file.path || item.oldPath === input.file.path),
      )
      if (!pair) throw new AppError(404, 'change-file-missing', '这个文件在这个范围里没有改动。')
      let contents = new Contents({ objects: scoped.project.objects }, TEXT_LIMIT * 2)
      if (scoped.git) {
        const blobs = await this.blobsFor({ ...scoped.git, pairs: [pair] }, TEXT_LIMIT)
        contents = new Contents({ blobs: oid => blobs.get(oid) }, TEXT_LIMIT * 2)
      }
      const compared = await compareSides(pair, contents)
      const context = typeof input.context === 'number' && !Number.isNaN(input.context) ? Math.max(0, Math.floor(input.context)) : 3
      return {
        scope: input.scope,
        ...(scoped.turn ? { turnId: scoped.turn.turnId } : {}),
        file: describe(pair, compared),
        ...(compared.ops ? { hunks: hunksOf(pair, compared.ops, context) } : {}),
      }
    })
  }

  /** A scope as one patch (复制补丁), leaving out files whose content is not shown. */
  async patch(input: { session: ChangesSession; scope: ChangeScope; turnId?: string }): Promise<ChangePatch> {
    checkSession(input.session)
    checkScope(input.scope)
    return this.track(async () => {
      const scoped = await this.scoped(input.session, input.scope, input.turnId)
      let contents = new Contents({ objects: scoped.project.objects }, this.limits.patchBytes * 2)
      if (scoped.git) {
        const blobs = await this.blobsFor(scoped.git, this.limits.patchBytes)
        contents = new Contents({ blobs: oid => blobs.get(oid) }, this.limits.patchBytes * 2)
      }
      const prefix = (root: string) => (input.session.folders.length > 1 ? `${root}/` : '')
      let text = '',
        files = 0,
        omitted = 0,
        truncated = false
      for (const pair of scoped.pairs.toSorted((a, b) => a.root.localeCompare(b.root) || a.path.localeCompare(b.path))) {
        const section = patchOf(pair, await compareSides(pair, contents), prefix(pair.root))
        if (section === undefined) omitted++
        else if (text.length + section.length > this.limits.patchBytes) {
          truncated = true
          break
        } else {
          text += section
          files++
        }
      }
      return {
        scope: input.scope,
        ...(scoped.turn ? { turnId: scoped.turn.turnId } : {}),
        text,
        files,
        omitted,
        ...(truncated ? { truncated: true as const } : {}),
      }
    })
  }

  /** The session's retained turns, oldest first. */
  async turns(input: { session: ChangesSession }): Promise<TurnChanges[]> {
    checkSession(input.session)
    return this.track(async () => {
      const project = await this.project(input.session.projectId)
      const state = await this.session(project, input.session.id)
      return state.turns.map(turn => ({
        turnId: turn.turnId,
        startedAt: turn.startedAt,
        ...(turn.settledAt ? { settledAt: turn.settledAt } : {}),
        state: turn.state === 'settled' ? 'settled' : state.running === turn.turnId ? 'running' : 'interrupted',
        ...(turn.state === 'settled' ? { files: turn.changes.length } : {}),
        ...(turn.undone ? { undone: true as const } : {}),
        ...(turn.note && !turn.note.told ? { notePending: true as const } : {}),
        ...(turn.otherSessions?.length ? { otherSessions: turn.otherSessions } : {}),
      }))
    })
  }

  /**
   * Saves the person's edit of one file through `write`, under the project's lock so no snapshot, undo or discard runs
   * meanwhile, then records it: 「你的修改」 in the session scope and a note for the Agent's next turn. `write` answers
   * the content's hash, or undefined when it wrote nothing.
   */
  async personEdit(input: {
    session: Pick<ChangesSession, 'id' | 'projectId'>
    file: { root: string; path: string; display: string }
    write: () => Promise<string | undefined>
  }): Promise<{ noteNextTurn: boolean }> {
    const { session, file, write } = input
    if (!PROJECT_ID.test(session.projectId)) throw new AppError(400, 'change-session-invalid', '会话信息无效。')
    return this.mutate(session.projectId, async project => {
      const state = await this.session(project, session.id)
      const hash = await write()
      if (hash === undefined) return { noteNextTurn: false }
      const key = fileKey(file.root, file.path)
      // An earlier edit of the file no message has carried yet is the same news; one a message carries keeps its words.
      const edits = state.edits.filter(edit => !(fileKey(edit.root, edit.path) === key && !edit.told && !edit.requestId))
      edits.push({ root: file.root, path: file.path, display: file.display, hash, at: iso(this.now()) })
      while (edits.length > PERSON_EDIT_LIMIT) {
        const told = edits.findIndex(edit => edit.told)
        edits.splice(told < 0 ? 0 : told, 1)
      }
      state.edits = edits
      await this.save(project, state)
      return { noteNextTurn: true }
    })
  }

  /**
   * The note for this message (`requestId`), when files were written back behind the engine's memory since it last
   * heard. A retry of the message gets the same words, because a driver refuses a request ID with different text; the
   * note counts as told once a turn begins.
   */
  async noteFor(input: {
    session: Pick<ChangesSession, 'id' | 'projectId'>
    requestId: string
    /** The message left without the note: it stays due for the next one. */
    signal?: AbortSignal
  }): Promise<string | undefined> {
    const { session, requestId, signal } = input
    const due = (state: SessionState) => [...notesOf(state), ...state.edits].some(note => !note.told || note.requestId === requestId)
    return this.track(async () => {
      const project = await this.project(session.projectId)
      // Every message asks, so one with no note due does not queue behind a snapshot of the project.
      if (!due(await this.session(project, session.id))) return undefined
      return this.locked(project, async () => {
        if (signal?.aborted) return undefined
        const state = await this.session(project, session.id)
        const carried = notesOf(state).filter(note => note.requestId === requestId),
          carriedEdits = state.edits.filter(edit => edit.requestId === requestId)
        if (carried.length || carriedEdits.length) return noteText(carried, carriedEdits)
        if (!due(state)) return undefined
        const carrying = <T extends { note?: TurnNote }>(holder: T): T =>
          holder.note && !holder.note.told ? { ...holder, note: { ...holder.note, requestId } } : holder
        state.turns = state.turns.map(carrying)
        if (state.note) state.note = carrying({ note: state.note }).note!
        state.edits = state.edits.map(edit => (edit.told ? edit : { ...edit, requestId }))
        await this.save(project, state)
        return noteText(
          notesOf(state).filter(note => note.requestId === requestId),
          state.edits.filter(edit => edit.requestId === requestId),
        )
      })
    })
  }

  // ---- undo --------------------------------------------------------------------------------------------------------

  /** The session's folders now, kept only where they are still the folders the snapshots recorded. */
  private async writableRoots(state: SessionState, session: ChangesSession, guard: ProtectedIndex): Promise<FileRoot[]> {
    const recorded = state.head?.folders ?? []
    return (await realRoots(session.folders, guard)).filter(root =>
      recorded.some(folder => folder.id === root.id && folder.path === root.path),
    )
  }

  /** The file at a path now: null when absent, undefined when not a regular file; its hash up to the clone limit. */
  private async current(root: FileRoot, path: string): Promise<Current> {
    let handle: FileHandle
    try {
      handle = await open(join(root.path, ...path.split('/')), constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK)
    } catch (error) {
      return codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR' ? null : undefined
    }
    try {
      const info = await handle.stat({ bigint: true })
      if (!info.isFile()) return undefined
      const now = { mode: Number(info.mode & 0o777n), sig: signature(info) }
      return info.size > BigInt(this.limits.cloneLimit) ? now : { ...now, hash: await hashHandle(handle) }
    } finally {
      await handle.close()
    }
  }

  private matches(current: Current, state: FileState | undefined): boolean {
    if (!state) return current === null
    if (!current || current.mode !== state.mode) return false
    return state.hash && current.hash ? state.hash === current.hash : state.sig !== undefined && state.sig === current.sig
  }

  /**
   * What undo (back to the turn's start) or redo (forward to its end) would write. A file already in the target state is
   * left alone and one in neither state blocks the whole change. A file with either side not kept is skipped: writing
   * over or removing it could not be reversed, and redo must find what undo left.
   */
  private async plan(
    scoped: { project: ProjectState; state: SessionState },
    turn: TurnRecord,
    session: ChangesSession,
    direction: 'undo' | 'redo',
    only?: ReadonlySet<string>,
  ): Promise<Plan | { block: UndoBlock }> {
    const { project, state } = scoped
    if (state.running) return { block: 'running' }
    if (turn.state !== 'settled') return { block: 'not-settled' }
    if (!only && direction === 'undo' && turn.undone) return { block: 'undone' }
    if (!only && direction === 'redo' && !turn.undone) return { block: 'not-undone' }
    const changes = turn.changes.filter(change => !only || only.has(fileKey(change.root, change.path)))
    if (!changes.length) return { block: 'no-changes' }
    const roots = await this.writableRoots(state, session, await ProtectedIndex.of(this.options.protectedPaths))
    const steps: Step[] = [],
      notRestored: NotRestoredFile[] = []
    let skipped = 0
    for (const change of changes) {
      const from = direction === 'undo' ? change.after : change.before,
        to = direction === 'undo' ? change.before : change.after
      const lost = [to, from].find(side => side && (side.kept !== 'stored' || !side.hash))
      if (lost) {
        skipped++
        if (notRestored.length < NAMED_FILE_LIMIT) notRestored.push({ root: change.root, path: change.path, reason: reasonOf(lost) })
        continue
      }
      const root = roots.find(item => item.id === change.root)
      if (!root) return { block: 'changed-since' }
      const current = await this.current(root, change.path)
      if (this.matches(current, to)) continue
      if (!this.matches(current, from)) return { block: 'changed-since' }
      if (to) {
        const hash = to.hash!
        steps.push({
          root,
          path: change.path,
          to: {
            mode: to.mode,
            hash,
            source: async () => {
              const handle = await project.objects.openChecked(hash)
              if (!handle) throw new AppError(409, 'change-not-retained', '这一轮的内容没有留存，无法写回。')
              return handle
            },
          },
        })
      } else
        steps.push({
          root,
          path: change.path,
          expect: async (handle, info) =>
            this.matches({ mode: Number(info.mode & 0o777n), sig: signature(info), hash: await hashHandle(handle) }, from),
        })
    }
    // A whole-turn change that may touch nothing is not an undo; 撤销此文件 still answers with the file it left.
    if (!only && skipped === changes.length) return { block: 'not-retained' }
    return { steps, skipped, notRestored }
  }

  private async availability(scoped: Scoped, session: ChangesSession, direction: 'undo' | 'redo'): Promise<Availability> {
    const plan = await this.plan(scoped, scoped.turn!, session, direction).catch((): { block: UndoBlock } => ({ block: 'changed-since' }))
    return 'block' in plan ? { available: false, reason: plan.block } : { available: true }
  }

  private writePlan(
    action: ChangeWritePlan['action'],
    session: ChangesSession,
    steps: readonly Step[],
    skipped: number,
    extra: Partial<ChangeWritePlan>,
  ): ChangeWritePlan {
    const listed = steps.map(step => [step.root.id, step.path, step.to?.hash ?? null, step.to?.mode ?? null, step.seen ?? null])
    return {
      action,
      sessionId: session.id,
      ...extra,
      restore: steps.filter(step => step.to).length,
      remove: steps.filter(step => !step.to).length,
      skipped,
      planHash: createHash('sha256').update(canonicalJson(listed)).digest('hex'),
    }
  }

  private async write(
    steps: readonly Step[],
    plan: ChangeWritePlan,
    beforeWrite: BeforeWrite,
  ): Promise<{ restored: number; removed: number }> {
    await beforeWrite(plan)
    const guard = await ProtectedIndex.of(this.options.protectedPaths)
    let restored = 0,
      removed = 0
    for (const step of steps) {
      if (step.to) {
        await writeInto(step.root, step.path, step.to.source, step.to.mode, guard)
        restored++
      } else {
        await removeFrom(step.root, step.path, guard, (handle, info) => step.expect?.(handle, info) ?? Promise.resolve(false))
        removed++
      }
    }
    return { restored, removed }
  }

  private async undoOrRedo(
    direction: 'undo' | 'redo',
    input: { session: ChangesSession; turnId: string; requestId: string; beforeWrite: BeforeWrite },
  ): Promise<ChangeReceipt> {
    const { session, turnId, requestId } = input
    checkSession(session)
    if (!REQUEST_ID.test(requestId)) throw new AppError(400, 'change-request-invalid', '请求标识无效。')
    return this.mutate(session.projectId, async project => {
      const state = await this.session(project, session.id)
      const turn = state.turns.find(item => item.turnId === turnId)
      if (!turn) throw new AppError(404, 'change-turn-missing', '没有这一轮的改动记录。')
      const answered = turn.receipts.find(receipt => receipt.requestId === requestId && receipt.action === direction)
      if (answered) return { ...answered, action: direction, replay: true as const }
      const plan = await this.plan({ project, state }, turn, session, direction)
      if ('block' in plan) throw blocked(plan.block)
      const done = await this.write(
        plan.steps,
        this.writePlan(direction, session, plan.steps, plan.skipped, { turnId, scope: 'turn' }),
        input.beforeWrite,
      )
      const note = nextNote(turn.note, direction, done.restored + done.removed, plan.skipped)
      const receipt: Receipt = {
        sessionId: session.id,
        turnId,
        requestId,
        action: direction,
        ...done,
        skipped: plan.skipped,
        notRestored: plan.notRestored,
        notCovered: turn.notCovered ?? [],
        noteNextTurn: note !== undefined,
        at: iso(this.now()),
      }
      const updated: TurnRecord = { ...turn, receipts: [...turn.receipts, receipt].slice(-8) }
      if (note) updated.note = note
      else delete updated.note
      if (direction === 'undo') updated.undone = { at: receipt.at, requestId }
      else delete updated.undone
      state.turns = state.turns.map(item => (item === turn ? updated : item))
      await this.save(project, state)
      return { ...receipt, action: direction }
    })
  }

  /** 撤销本轮: puts the files the turn changed back as they were when it started. */
  undoTurn(input: { session: ChangesSession; turnId: string; requestId: string; beforeWrite: BeforeWrite }): Promise<ChangeReceipt> {
    return this.undoOrRedo('undo', input)
  }

  /** 恢复: puts back what 撤销本轮 took away. */
  redoTurn(input: { session: ChangesSession; turnId: string; requestId: string; beforeWrite: BeforeWrite }): Promise<ChangeReceipt> {
    return this.undoOrRedo('redo', input)
  }

  /**
   * What putting the files back to before a message (从这里编辑 with 同时把文件退回) would write: 撤销本轮 over every turn
   * from that message on (`turnIds`, oldest first), as one plan. Each file goes back to how it was when the first of these
   * turns that changed it began; it must still be as the last of them left it, and unchanged between them, or nothing is
   * written. A turn already undone left its files as they were before it. A file with a side not kept is skipped, as
   * 撤销本轮 skips it.
   */
  private async rewindPlan(
    scoped: { project: ProjectState; state: SessionState },
    turnIds: readonly string[],
    session: ChangesSession,
  ): Promise<
    | (Plan & { turns: TurnRecord[]; notCovered: string[]; perTurn: Map<string, { written: number; skipped: number; kept: number }> })
    | { block: RewindBlock }
  > {
    const { project, state } = scoped
    if (state.running) return { block: 'running' }
    // The record's own turns from the first of them on, which must be exactly the turns the messages opened: a turn the
    // record holds that no message names would otherwise keep its files where it left them.
    const from = state.turns.findIndex(item => item.turnId === turnIds[0])
    if (from < 0) return { block: 'not-recorded' }
    const turns = state.turns.slice(from)
    if (turns.length !== turnIds.length || turns.some((turn, index) => turn.turnId !== turnIds[index])) return { block: 'not-recorded' }
    for (const turn of turns) {
      if (turn.state !== 'settled') return { block: 'not-settled' }
      if (turn.partial) return { block: 'partial' }
    }
    // What happens to each turn's files: written back, skipped (a side not kept), or kept in reach (written or already so).
    const perTurn = new Map(turns.map(turn => [turn.turnId, { written: 0, skipped: 0, kept: 0 }]))
    const count = (entries: Array<{ turn: TurnRecord }>, field: 'written' | 'skipped' | 'kept') => {
      for (const id of new Set(entries.map(entry => entry.turn.turnId))) perTurn.get(id)![field]++
    }
    // Each file's history over these turns, in order.
    const history = new Map<string, Array<{ turn: TurnRecord; change: Change }>>()
    for (const turn of turns)
      for (const change of turn.changes) {
        const key = fileKey(change.root, change.path)
        const list = history.get(key) ?? []
        list.push({ turn, change })
        history.set(key, list)
      }
    if (!history.size) return { block: 'no-changes' }
    const left = (entry: { turn: TurnRecord; change: Change }) => (entry.turn.undone ? entry.change.before : entry.change.after)
    const roots = await this.writableRoots(state, session, await ProtectedIndex.of(this.options.protectedPaths))
    const steps: Step[] = [],
      notRestored: NotRestoredFile[] = []
    let skipped = 0
    for (const entries of history.values()) {
      const { root: rootId, path } = entries[0]!.change
      const sides = entries.flatMap(entry => [entry.change.before, entry.change.after])
      const lost = sides.find(side => side && (side.kept !== 'stored' || !side.hash))
      if (lost) {
        skipped++
        count(entries, 'skipped')
        if (notRestored.length < NAMED_FILE_LIMIT) notRestored.push({ root: rootId, path, reason: reasonOf(lost) })
        continue
      }
      count(entries, 'kept')
      // Changed between two of these turns, by anyone: the start of the first is no longer what came before the rest.
      for (let index = 1; index < entries.length; index++)
        if (!sameState(left(entries[index - 1]!), entries[index]!.change.before)) return { block: 'changed-since' }
      const from = left(entries.at(-1)!),
        to = entries[0]!.change.before
      const root = roots.find(item => item.id === rootId)
      if (!root) return { block: 'changed-since' }
      const current = await this.current(root, path)
      if (this.matches(current, to)) continue
      if (!this.matches(current, from)) return { block: 'changed-since' }
      count(entries, 'written')
      if (to) {
        const hash = to.hash!
        steps.push({
          root,
          path,
          to: {
            mode: to.mode,
            hash,
            source: async () => {
              const handle = await project.objects.openChecked(hash)
              if (!handle) throw new AppError(409, 'change-not-retained', '这一轮的内容没有留存，无法写回。')
              return handle
            },
          },
        })
      } else
        steps.push({
          root,
          path,
          expect: async (handle, info) =>
            this.matches({ mode: Number(info.mode & 0o777n), sig: signature(info), hash: await hashHandle(handle) }, from),
        })
    }
    if (skipped === history.size) return { block: 'not-retained' }
    const notCovered = [...new Set(turns.flatMap(turn => turn.notCovered ?? []))].slice(0, NAMED_FILE_LIMIT)
    return { steps, skipped, notRestored, turns, notCovered, perTurn }
  }

  /** What putting the files back to before the first of `turnIds` would do, for its confirmation. Writes nothing. */
  async previewRewind(input: { session: ChangesSession; turnIds: readonly string[] }): Promise<RewindPreview> {
    const { session } = input
    checkSession(session)
    return this.mutate(session.projectId, async project => {
      const plan = await this.rewindPlan({ project, state: await this.session(project, session.id) }, input.turnIds, session)
      if ('block' in plan) return { available: false, reason: plan.block }
      const written = this.writePlan('rewind', session, plan.steps, plan.skipped, { turnId: input.turnIds[0] })
      return {
        available: true,
        restore: written.restore,
        remove: written.remove,
        skipped: written.skipped,
        planHash: written.planHash,
        files: plan.steps
          .slice(0, NAMED_FILE_LIMIT)
          .map(step => ({ root: step.root.id, path: step.path, ...(step.to ? {} : { remove: true as const }) })),
        notRestored: plan.notRestored,
        notCovered: plan.notCovered,
      }
    })
  }

  /**
   * Puts the files back to before the first of `turnIds`, as `previewRewind` showed (`beforeWrite` checks its hash). Each
   * of the turns that changed files is then undone, as 撤销本轮 leaves one: 恢复 brings it back, and the session's next
   * message says so. A retry with the same `requestId` gets the first answer.
   */
  async rewind(input: {
    session: ChangesSession
    messageId: string
    turnIds: readonly string[]
    requestId: string
    beforeWrite: BeforeWrite
  }): Promise<RewindReceipt> {
    const { session, requestId } = input
    checkSession(session)
    if (!REQUEST_ID.test(requestId)) throw new AppError(400, 'change-request-invalid', '请求标识无效。')
    return this.mutate(session.projectId, async project => {
      const state = await this.session(project, session.id)
      for (const turn of state.turns) {
        const answered = turn.receipts.find(receipt => receipt.requestId === requestId && receipt.action === 'rewind')
        if (answered) {
          const { turnId: _turn, action: _action, noteNextTurn: _note, ...rest } = answered
          return { ...rest, messageId: input.messageId, replay: true as const }
        }
      }
      const plan = await this.rewindPlan({ project, state }, input.turnIds, session)
      if ('block' in plan) throw rewindBlocked(plan.block)
      const done = await this.write(
        plan.steps,
        this.writePlan('rewind', session, plan.steps, plan.skipped, { turnId: input.turnIds[0] }),
        input.beforeWrite,
      )
      const at = iso(this.now())
      const receipt: RewindReceipt = {
        sessionId: session.id,
        messageId: input.messageId,
        requestId,
        ...done,
        skipped: plan.skipped,
        notRestored: plan.notRestored,
        notCovered: plan.notCovered,
        at,
      }
      // Undone: a turn with a file in reach. One whose files were all skipped stays as it was, as 撤销本轮 leaves it.
      const touched = new Set(
        plan.turns.filter(turn => !turn.undone && (plan.perTurn.get(turn.turnId)?.kept ?? 0) > 0).map(turn => turn.turnId),
      )
      const first = plan.turns.find(turn => touched.has(turn.turnId))
      state.turns = state.turns.map(turn => {
        if (!touched.has(turn.turnId)) return turn
        const counts = plan.perTurn.get(turn.turnId)!
        const note = nextNote(turn.note, 'undo', counts.written, counts.skipped)
        const updated: TurnRecord = {
          ...turn,
          undone: { at, requestId },
          // The whole answer is kept on the first turn, for a retry.
          ...(turn === first
            ? {
                receipts: [
                  ...turn.receipts,
                  {
                    sessionId: session.id,
                    turnId: turn.turnId,
                    requestId,
                    action: 'rewind' as const,
                    restored: done.restored,
                    removed: done.removed,
                    skipped: plan.skipped,
                    notRestored: plan.notRestored,
                    notCovered: plan.notCovered,
                    noteNextTurn: note !== undefined,
                    at,
                  },
                ].slice(-8),
              }
            : {}),
        }
        if (note) updated.note = note
        else delete updated.note
        return updated
      })
      await this.save(project, state)
      return receipt
    })
  }

  /**
   * 撤销此文件 and 撤销全部改动…: a turn's files back to the turn's start, or uncommitted files back to HEAD (every
   * uncommitted change without `files`). Irreversible, so the caller asks first; Git's index is left as it is.
   */
  async discard(input: { session: ChangesSession; target: DiscardTarget; beforeWrite: BeforeWrite }): Promise<DiscardResult> {
    const { session, target } = input
    checkSession(session)
    return this.mutate(session.projectId, async project => {
      const state = await this.session(project, session.id)
      if (target.scope === 'turn') {
        const turn = state.turns.find(item => item.turnId === target.turnId)
        if (!turn) throw new AppError(404, 'change-turn-missing', '没有这一轮的改动记录。')
        const plan = await this.plan(
          { project, state },
          turn,
          session,
          'undo',
          new Set(target.files.map(file => fileKey(file.root, file.path))),
        )
        if ('block' in plan) throw blocked(plan.block)
        const done = await this.write(
          plan.steps,
          this.writePlan('discard', session, plan.steps, plan.skipped, { turnId: turn.turnId, scope: 'turn' }),
          input.beforeWrite,
        )
        return {
          ...done,
          skipped: plan.skipped,
          notRestored: plan.notRestored,
          noteNextTurn: await this.noteFiles(project, state, turn, done, plan.skipped),
        }
      }
      if (state.running) throw blocked('running')
      const plan = await this.planUncommitted(session, target.files)
      const done = await this.write(
        plan.steps,
        this.writePlan('discard', session, plan.steps, plan.skipped, { scope: 'uncommitted' }),
        input.beforeWrite,
      )
      const last = state.turns.at(-1)
      return {
        ...done,
        skipped: plan.skipped,
        notRestored: plan.notRestored,
        noteNextTurn: await this.noteFiles(project, state, last, done, plan.skipped),
      }
    })
  }

  /** What discarding uncommitted changes would do, for the confirmation it needs. Writes nothing. */
  async previewDiscard(input: { session: ChangesSession; files?: readonly FileMention[] }): Promise<Omit<DiscardPreview, 'warning'>> {
    const { session } = input
    checkSession(session)
    return this.mutate(session.projectId, async project => {
      if ((await this.session(project, session.id)).running) throw blocked('running')
      const plan = await this.planUncommitted(session, input.files)
      const written = this.writePlan('discard', session, plan.steps, plan.skipped, { scope: 'uncommitted' })
      return {
        restore: written.restore,
        remove: written.remove,
        skipped: written.skipped,
        planHash: written.planHash,
        removes: plan.steps
          .filter(step => !step.to)
          .slice(0, NAMED_FILE_LIMIT)
          .map(step => ({ root: step.root.id, path: step.path })),
        notRestored: plan.notRestored,
      }
    })
  }

  /** Records that files changed behind the engine's memory, on the turn the discard concerns or else the session; true when a note is due. */
  private async noteFiles(
    project: ProjectState,
    state: SessionState,
    turn: TurnRecord | undefined,
    done: { restored: number; removed: number },
    skipped: number,
  ): Promise<boolean> {
    const current = turn ? turn.note : state.note
    const note = nextNote(current, 'files', done.restored + done.removed, skipped)
    if (!note) return false
    if (note === current) return true
    if (turn) state.turns = state.turns.map(item => (item === turn ? { ...turn, note } : item))
    else state.note = note
    await this.save(project, state)
    return true
  }

  private async planUncommitted(session: ChangesSession, files: readonly FileMention[] | undefined): Promise<Plan> {
    const git = await this.gitScope(session, 'uncommitted')
    if (git.unavailable) throw new AppError(409, 'change-not-git', '这些文件夹没有可以撤销的未提交改动。')
    // Writing HEAD's content over a file mid-merge would drop what the merge brought in and the person's resolutions.
    if (git.conflict) throw new AppError(409, 'change-git-conflict', '仓库正在合并或有未解决的冲突，不能撤销未提交的改动。')
    const wanted = files ? new Set(files.map(file => fileKey(file.root, file.path))) : undefined
    const pairs = git.pairs.filter(
      pair =>
        !wanted
        || wanted.has(fileKey(pair.root, pair.path))
        || (pair.oldPath !== undefined && wanted.has(fileKey(pair.root, pair.oldPath))),
    )
    const blobs = await this.blobsFor({ ...git, pairs }, this.limits.discardBytes, this.limits.cloneLimit)
    const contents = new Contents({ blobs: oid => blobs.get(oid) }, this.limits.discardBytes)
    const roots = await realRoots(session.folders, await ProtectedIndex.of(this.options.protectedPaths))
    const steps: Step[] = [],
      notRestored: NotRestoredFile[] = []
    let skipped = 0
    const skip = (pair: Pair, reason: NotRestoredFile['reason'], path = pair.path) => {
      skipped++
      if (notRestored.length < NAMED_FILE_LIMIT) notRestored.push({ root: pair.root, path, reason })
    }
    for (const pair of pairs) {
      const root = roots.find(item => item.id === pair.root)
      if (!root) {
        skip(pair, 'folder-missing')
        continue
      }
      // Content that may hold a secret is neither written nor removed here.
      if ((await compareSides(pair, contents)).hidden === 'secret') {
        skip(pair, 'secret')
        continue
      }
      const id = pair.after ? git.workIds.get(pair.after) : undefined
      if (pair.after && (!pair.before || pair.oldPath)) {
        if (!id) {
          skip(pair, 'not-retained')
          continue
        }
        const format = id.length === 64 ? 'sha256' : 'sha1'
        steps.push({ root, path: pair.path, seen: id, expect: async handle => blobId(await handle.readFile(), format) === id })
      }
      // A file too large to hash is still bound to what the plan saw, by its signature.
      const seen =
        id
        ?? (pair.after
          ? await lstat(join(root.path, ...pair.path.split('/')), { bigint: true }).then(signature, () => undefined)
          : undefined)
      if (pair.before?.from === 'blob') {
        const bytes = blobs.get(pair.before.oid)
        if (!bytes) skip(pair, 'not-retained', pair.oldPath ?? pair.path)
        else
          steps.push({
            root,
            path: pair.oldPath ?? pair.path,
            ...(seen ? { seen } : {}),
            to: { mode: pair.before.mode === '100755' ? 0o755 : 0o644, hash: sha256(bytes), source: bytes },
          })
      }
    }
    return { steps, skipped, notRestored }
  }
}
