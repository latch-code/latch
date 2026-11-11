// One file's two sides in any scope (a recorded state, the file now, or a Git blob), their content, and how a pair of
// them is listed, drawn as hunks and written into a patch.
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { isSecretLookingPath } from '../files/ignore.ts'
import type { FileRoot } from '../files/resolve.ts'
import { hasSecretContent, isSecretPath } from '../files/secrets.ts'
import { SNIFF_BYTES } from '../files/sniff.ts'
import { commandLines } from './attribution.ts'
import {
  EMPTY_TEXT,
  TEXT_LIMIT,
  countChanges,
  decodeText,
  diffLines,
  patchHunks,
  splitText,
  toHunks,
  type DiffOp,
  type Text,
} from './diff.ts'
import type { ObjectStore } from './objects.ts'
import type { Change, FileState } from './records.ts'
import type { ChangedFile, ChangeHunk } from '@latch/protocol'

const NOFOLLOW = constants.O_NOFOLLOW ?? 0

export type WorkSide = { from: 'work'; root: FileRoot; path: string; size: number; mode: number; dev: bigint; ino: bigint }
export type Side =
  /** A recorded state; its content is in the project's objects when `kept` is `stored`. */
  | { from: 'record'; state: FileState }
  /** The file in the work tree now, as a walk or lstat found it. */
  | WorkSide
  /** A Git blob; `mode` as Git writes it. */
  | { from: 'blob'; oid: string; mode: string; size: number }

export interface Pair {
  root: string
  path: string
  /** A rename's earlier path; `before` is that file's side. */
  oldPath?: string
  before?: Side
  after?: Side
  byCommand?: true
  byUser?: true
  /** Session scope: the file holds what the person saved with Latch's editor. */
  byPerson?: true
  conflicted?: true
  /** Turn scope: whose change it was, to mark a command's lines. */
  attribution?: Pick<Change, 'by' | 'agentLines'>
}

/** Why a side's content is not shown. */
type Hidden = 'secret' | 'large' | 'binary' | 'not-retained'
export interface Loaded {
  text?: Text
  bytes?: Uint8Array
  hidden?: Hidden
}
export interface Compared {
  before: Loaded
  after: Loaded
  hidden?: Hidden
  ops?: DiffOp[]
}

const PRIORITY: readonly Hidden[] = ['secret', 'large', 'binary', 'not-retained']

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** The file a walk found, read through a handle that must be that same inode; undefined when it changed or went away. */
export async function readWorkFile(side: WorkSide, limit = TEXT_LIMIT): Promise<Uint8Array | undefined> {
  try {
    const handle = await open(join(side.root.path, ...side.path.split('/')), constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await handle.stat({ bigint: true })
      if (!info.isFile() || info.dev !== side.dev || info.ino !== side.ino || info.size > BigInt(limit)) return undefined
      return await handle.readFile()
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

/** Reads sides' content once each, within a byte budget per request. */
export class Contents {
  private readonly cache = new Map<Side, Promise<Loaded>>()

  constructor(
    private readonly sources: { objects?: ObjectStore; blobs?: (oid: string) => Uint8Array | undefined },
    /** Bytes left to read; sides past it are listed without line counts. */
    public budget: number,
  ) {}

  load(side: Side, path: string): Promise<Loaded> {
    let loaded = this.cache.get(side)
    if (!loaded) this.cache.set(side, (loaded = this.read(side, path)))
    return loaded
  }

  private async read(side: Side, path: string): Promise<Loaded> {
    if (isSecretLookingPath(path)) return { hidden: 'secret' }
    let bytes: Uint8Array | undefined
    if (side.from === 'record') {
      const { state } = side
      if (state.kept === 'secret') return { hidden: 'secret' }
      if (state.kept === 'large' || state.size > TEXT_LIMIT) return { hidden: 'large' }
      if (state.kept !== 'stored' || !state.hash || !this.sources.objects) return { hidden: 'not-retained' }
      if (this.budget < state.size) return {}
      this.budget -= state.size
      bytes = await this.sources.objects.read(state.hash, TEXT_LIMIT)
      if (!bytes) return { hidden: 'not-retained' }
    } else if (side.from === 'work') {
      if (side.size > TEXT_LIMIT) return { hidden: 'large' }
      if (this.budget < side.size) return {}
      this.budget -= side.size
      bytes = await readWorkFile(side)
      if (!bytes) return { hidden: 'not-retained' }
    } else {
      if (side.size > TEXT_LIMIT) return { hidden: 'large' }
      bytes = this.sources.blobs?.(side.oid)
      if (!bytes) return {}
    }
    const head = bytes.subarray(0, SNIFF_BYTES)
    if (isSecretPath(path, head) || hasSecretContent(head)) return { hidden: 'secret' }
    const text = decodeText(bytes)
    return text === undefined ? { bytes, hidden: 'binary' } : { bytes, text: splitText(text) }
  }
}

const sideMode = (side: Side) =>
  side.from === 'blob' ? (side.mode === '100755' ? 0o755 : 0o644) : side.from === 'record' ? side.state.mode : side.mode
const executable = (side: Side) => (sideMode(side) & 0o111) !== 0

/** Both sides' content and, when both are text, their line diff; a missing side counts as empty text. */
export async function compareSides(pair: Pair, contents: Contents): Promise<Compared> {
  const [before, after] = await Promise.all([
    pair.before ? contents.load(pair.before, pair.oldPath ?? pair.path) : Promise.resolve<Loaded>({ text: EMPTY_TEXT }),
    pair.after ? contents.load(pair.after, pair.path) : Promise.resolve<Loaded>({ text: EMPTY_TEXT }),
  ])
  const hidden = PRIORITY.find(reason => before.hidden === reason || after.hidden === reason)
  const ops = !hidden && before.text && after.text ? diffLines(before.text, after.text) : undefined
  return { before, after, ...(hidden ? { hidden } : {}), ...(ops ? { ops } : {}) }
}

/** The pair as a row of the change list. */
export function describe(pair: Pair, compared: Compared): ChangedFile {
  const { hidden, ops } = compared
  return {
    root: pair.root,
    path: pair.path,
    ...(pair.oldPath ? { oldPath: pair.oldPath } : {}),
    status: !pair.before ? 'A' : !pair.after ? 'D' : pair.oldPath ? 'R' : 'M',
    ...(ops ? countChanges(ops) : {}),
    ...(pair.byCommand ? { byCommand: true as const } : {}),
    ...(pair.byUser ? { byUser: true as const } : {}),
    ...(pair.byPerson ? { byPerson: true as const } : {}),
    ...(hidden === 'binary' ? { binary: true as const } : {}),
    ...(hidden === 'large' ? { large: true as const } : {}),
    ...(hidden === 'secret' ? { secret: true as const } : {}),
    ...(hidden === 'not-retained' ? { notRetained: true as const } : {}),
    ...(pair.before && pair.after && executable(pair.before) !== executable(pair.after) ? { modeChanged: true as const } : {}),
    ...(pair.conflicted ? { conflicted: true as const } : {}),
  }
}

/** The pair's hunks, a command's lines marked when the turn's attribution says so. */
export function hunksOf(pair: Pair, ops: readonly DiffOp[], context: number): ChangeHunk[] {
  const flags = pair.attribution ? commandLines(ops, pair.attribution) : undefined
  const hunks = toHunks(ops, context)
  if (!flags?.some(Boolean)) return hunks
  // Hunk lines keep each op's line numbers; map them back to the op to carry its flag.
  const byOld = new Map<number, boolean>(),
    byNew = new Map<number, boolean>()
  ops.forEach((op, index) => {
    if (op.kind === 'remove') byOld.set(op.oldLine!, flags[index]!)
    if (op.kind === 'add') byNew.set(op.newLine!, flags[index]!)
  })
  for (const hunk of hunks)
    for (const line of hunk.lines) {
      const command = line.kind === 'remove' ? byOld.get(line.oldLine!) : line.kind === 'add' ? byNew.get(line.newLine!) : false
      if (command) line.byCommand = true
    }
  return hunks
}

const quoted = (name: string) => (/["\\]/u.test(name) ? `"${name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` : name)
const gitMode = (side: Side) => (side.from === 'blob' ? side.mode : executable(side) ? '100755' : '100644')

/** The pair as `git diff` writes it, or undefined when its content is not shown. `prefix` names the folder. */
export function patchOf(pair: Pair, compared: Compared, prefix: string): string | undefined {
  const { before, after, ops, hidden } = compared
  if (hidden || !ops || !before.text || !after.text) return undefined
  const oldName = `${prefix}${pair.oldPath ?? pair.path}`,
    newName = `${prefix}${pair.path}`
  const lines = [`diff --git ${quoted(`a/${oldName}`)} ${quoted(`b/${newName}`)}`]
  if (!pair.before) lines.push(`new file mode ${gitMode(pair.after!)}`)
  else if (!pair.after) lines.push(`deleted file mode ${gitMode(pair.before)}`)
  else {
    if (gitMode(pair.before) !== gitMode(pair.after)) lines.push(`old mode ${gitMode(pair.before)}`, `new mode ${gitMode(pair.after)}`)
    if (pair.oldPath) lines.push('similarity index 100%', `rename from ${quoted(oldName)}`, `rename to ${quoted(newName)}`)
  }
  const hunks = patchHunks(ops, before.text, after.text)
  if (hunks)
    lines.push(
      pair.before ? `--- ${quoted(`a/${oldName}`)}` : '--- /dev/null',
      pair.after ? `+++ ${quoted(`b/${newName}`)}` : '+++ /dev/null',
    )
  return `${lines.join('\n')}\n${hunks}`
}
