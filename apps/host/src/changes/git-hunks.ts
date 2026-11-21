// Staging by hunk and by line. The Host never takes patch text from a client: it
// reads the file and its index entry itself, diffs them with its own line diff, and builds the content the index
// should hold from the lines a request picks. That content goes in as a blob (`hash-object --no-filters`) and an index
// entry (`update-index --index-info`) through the restricted Git, so no filter, hook or `git apply` setting is involved.
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { GitHunkBase, GitHunkDiff, GitLineRange, GitStagingView, GitWholeReason } from '@latch/protocol'
import type { GitLayout } from '../branch-reader.ts'
import { hasSecretContent, isSecretPath } from '../files/secrets.ts'
import { codeOf } from '../http-util.ts'
import { TEXT_LIMIT, countChanges, decodeText, diffLines, splitText, toHunks, type DiffOp, type Text } from './diff.ts'
import { GitError, blobId, type GitReader } from './git.ts'
import { OID } from './git-status.ts'

const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const LITERAL = { GIT_LITERAL_PATHSPECS: '1' }
const REGULAR = new Set(['100644', '100755'])
/** Ranges one request may carry on a side, and how many lines they may name on it. */
export const RANGE_LIMIT = 500
/**
 * Lines a side may have for its lines to be picked or shown with the whole file as context; a longer file is `large`
 * like one over the size limit. Also the most lines a request may pick on a side.
 */
export const LINE_LIMIT = 20_000
const HEAD_BYTES = 8192

/** A file on one side: what kind of entry it is and, for a regular file within the size limit, its bytes. */
interface FileSide {
  /** `100644`, `100755`, `120000` (a link) or `160000` (a submodule). */
  mode: string
  /** Git's object ID of the entry; a work-tree file has none. */
  oid?: string
  /** Absent when the file is over the text limit or is not a regular file. */
  bytes?: Buffer
}

export interface FileVersions {
  /** Absent before the first commit and for a path HEAD does not have. */
  head?: FileSide
  /** Stage 0 of the index; absent for an untracked or conflicted path. */
  index?: FileSide
  /** The file in the work tree now. */
  worktree?: FileSide
  /** The index holds the path at a stage above 0: a conflict. */
  conflicted: boolean
  /**
   * What Git would do to the file's bytes on the way into the index. `eol`: line endings are converted whatever the
   * content; `auto`: only when Git takes the content for text.
   */
  conversion: 'none' | 'filtered' | 'converted' | 'eol' | 'auto'
  /** The index entry is only a promise to add the file later (`git add -N`): there is nothing staged to tell lines from. */
  intentToAdd?: true
}

export class SelectionError extends Error {
  constructor(readonly reason: 'empty' | 'not-a-change' | 'out-of-range') {
    super(`git-selection-${reason}`)
  }
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/**
 * The file as it is in the work tree now, or undefined when there is none. Read without following a link, and only
 * when the file that was opened is the one at that place under the repository's real folder: a folder along the way
 * swapped for a link reads as no file (for Git too the path is then beyond a link). At most `TEXT_LIMIT` bytes are
 * read, however large the file has grown since it was measured.
 */
export async function readWorktreeFile(root: string, path: string): Promise<FileSide | undefined> {
  const parts = path.split('/')
  const absolute = join(root, ...parts)
  let info
  try {
    info = await lstat(absolute)
  } catch (error) {
    if (codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR') return undefined
    throw new GitError('failed')
  }
  if (info.isSymbolicLink()) return { mode: '120000' }
  // A folder or a device where the file was: for Git the file is gone.
  if (!info.isFile()) return undefined
  const mode = info.mode & 0o111 ? '100755' : '100644'
  if (info.size > TEXT_LIMIT) return { mode }
  try {
    const handle = await open(absolute, constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK)
    try {
      const opened = await handle.stat({ bigint: true })
      if (!opened.isFile()) return undefined
      // Where the path really leads, and whether what is there is the file that was opened.
      const [realRoot, real] = await Promise.all([realpath(root), realpath(absolute)])
      if (real !== join(realRoot, ...parts)) return undefined
      const there = await lstat(real, { bigint: true })
      if (there.dev !== opened.dev || there.ino !== opened.ino) return undefined
      if (opened.size > BigInt(TEXT_LIMIT)) return { mode }
      const bytes = Buffer.alloc(TEXT_LIMIT + 1)
      let length = 0
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
        if (!bytesRead) break
        length += bytesRead
      }
      return length > TEXT_LIMIT ? { mode } : { mode, bytes: bytes.subarray(0, length) }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR' || codeOf(error) === 'ELOOP') return undefined
    throw new GitError('failed')
  }
}

interface IndexEntry {
  mode: string
  oid: string
  stage: number
  intentToAdd: boolean
}

/** `CE_INTENT_TO_ADD` in the flags `ls-files --debug` prints. */
const INTENT_TO_ADD = 0x20000000

/**
 * The path's index entries by stage: `ls-files -s --debug` with the path read literally (`GIT_LITERAL_PATHSPECS`: no
 * glob, no `:(magic)`), and only the exact path kept.
 */
export async function indexEntries(git: GitReader, layout: GitLayout, path: string): Promise<IndexEntry[]> {
  const out = await git.run(layout, ['ls-files', '-s', '--debug', '-z', '--', path], { maxBytes: 64 * 1024, env: LITERAL })
  const entries: IndexEntry[] = []
  // Each entry: `mode oid stage\tpath\0`, then its debug lines, the last of which ends with `flags: <hex>`.
  const fields = out.toString('utf8').split('\0')
  for (let at = 0; at + 1 < fields.length; at++) {
    const record = fields[at]!.slice(fields[at]!.lastIndexOf('\n') + 1)
    const tab = record.indexOf('\t')
    if (tab < 0 || record.slice(tab + 1) !== path) continue
    const [mode, oid, stage] = record.slice(0, tab).split(' ')
    const flags = /flags: ([0-9a-f]+)/u.exec(fields[at + 1]!)?.[1]
    // Flags that cannot be read count as set: the file then goes whole.
    const intentToAdd = flags === undefined || (Number.parseInt(flags, 16) & INTENT_TO_ADD) !== 0
    if (mode && oid && OID.test(oid) && stage !== undefined) entries.push({ mode, oid, stage: Number(stage), intentToAdd })
  }
  return entries
}

async function headEntry(
  git: GitReader,
  layout: GitLayout,
  head: string | undefined,
  path: string,
): Promise<{ mode: string; oid: string } | undefined> {
  if (!head) return undefined
  const out = await git.run(layout, ['ls-tree', '-z', '--full-tree', head, '--', path], { maxBytes: 64 * 1024, env: LITERAL })
  for (const record of out.toString('utf8').split('\0')) {
    const tab = record.indexOf('\t')
    if (tab < 0 || record.slice(tab + 1) !== path) continue
    const [mode, , oid] = record.slice(0, tab).split(' ')
    if (mode && oid && OID.test(oid)) return { mode, oid }
  }
  return undefined
}

/**
 * What Git would do to this file's bytes when it is added, from its attributes and `core.autocrlf` (both only read):
 * a filter driver, a rewrite the Host does not reproduce (`ident`, an encoding), or line-ending conversion.
 */
async function conversionOf(git: GitReader, layout: GitLayout, path: string): Promise<FileVersions['conversion']> {
  const out = await git.run(layout, ['check-attr', '-z', 'filter', 'text', 'eol', 'crlf', 'ident', 'working-tree-encoding', '--', path], {
    maxBytes: 64 * 1024,
  })
  const fields = out.toString('utf8').split('\0')
  const attrs = new Map<string, string>()
  for (let at = 0; at + 2 < fields.length; at += 3) attrs.set(fields[at + 1]!, fields[at + 2]!)
  const given = (name: string) => {
    const value = attrs.get(name)
    return value !== undefined && value !== 'unspecified' && value !== 'unset'
  }
  if (given('filter')) return 'filtered'
  if (given('ident') || given('working-tree-encoding')) return 'converted'
  // `-text` (or the old `-crlf`): never converted, whatever the configuration says.
  if (attrs.get('text') === 'unset' || attrs.get('crlf') === 'unset') return 'none'
  // `text=auto` converts only what Git takes for text; `text`, `eol` or `crlf` set converts whatever the content.
  if (attrs.get('text') === 'auto') return 'auto'
  if (given('text') || given('eol') || given('crlf')) return 'eol'
  const autocrlf = (await configValue(git, layout, 'core.autocrlf')).toLowerCase()
  return autocrlf === 'true' || autocrlf === 'input' ? 'auto' : 'none'
}

async function configValue(git: GitReader, layout: GitLayout, key: string): Promise<string> {
  return (await git.run(layout, ['config', '--get', key], { maxBytes: 256, exitCodes: [0, 1] })).toString('utf8').trim()
}

/**
 * Whether Git's own guess (`text=auto`, `core.autocrlf`) takes these bytes for binary, as `convert.c` counts them: a
 * NUL or a CR that is not half of a CRLF, a trailing end-of-file character, or more than one unprintable in 128.
 */
export function gitGuessesBinary(bytes: Uint8Array): boolean {
  let printable = 0,
    unprintable = 0
  for (let at = 0; at < bytes.length; at++) {
    const byte = bytes[at]!
    if (byte === 0x0d) {
      if (bytes[at + 1] !== 0x0a) return true
    } else if (byte === 0x0a) continue
    else if (byte === 0x7f) unprintable++
    else if (byte < 0x20) {
      // Backspace, tab, escape and form feed are text.
      if (byte === 0x08 || byte === 0x09 || byte === 0x1b || byte === 0x0c) printable++
      else if (byte === 0) return true
      else unprintable++
    } else printable++
  }
  if (bytes.length && bytes[bytes.length - 1] === 0x1a) unprintable--
  return printable >> 7 < unprintable
}

/** The three versions of one path, read without running anything the repository names. */
export async function readVersions(git: GitReader, layout: GitLayout, path: string, view: GitStagingView): Promise<FileVersions> {
  const head = await git.commit(layout, 'HEAD')
  const [entries, inHead, worktree] = await Promise.all([
    indexEntries(git, layout, path),
    headEntry(git, layout, head, path),
    view === 'unstaged' ? readWorktreeFile(layout.root, path) : undefined,
  ])
  const staged = entries.find(entry => entry.stage === 0)
  // Without `core.fileMode` the work tree's executable bit means nothing: Git keeps the index's.
  if (worktree && staged && REGULAR.has(worktree.mode) && REGULAR.has(staged.mode) && worktree.mode !== staged.mode) {
    if ((await configValue(git, layout, 'core.filemode')).toLowerCase() === 'false') worktree.mode = staged.mode
  }
  const wanted = [staged, view === 'staged' ? inHead : undefined].flatMap(entry => (entry && REGULAR.has(entry.mode) ? [entry.oid] : []))
  const blobs = await git.blobs(layout, wanted, TEXT_LIMIT)
  const side = (entry: { mode: string; oid: string } | undefined): FileSide | undefined => {
    if (!entry) return undefined
    const bytes = REGULAR.has(entry.mode) ? blobs.get(entry.oid) : undefined
    return { mode: entry.mode, oid: entry.oid, ...(bytes ? { bytes } : {}) }
  }
  return {
    ...(inHead ? { head: side(inHead)! } : {}),
    ...(staged ? { index: side(staged)! } : {}),
    ...(worktree ? { worktree } : {}),
    conflicted: entries.some(entry => entry.stage > 0),
    conversion: view === 'unstaged' && staged && worktree ? await conversionOf(git, layout, path) : 'none',
    ...(staged?.intentToAdd ? { intentToAdd: true as const } : {}),
  }
}

export function baseOf(versions: FileVersions): GitHunkBase {
  return {
    ...(versions.worktree?.bytes ? { worktree: sha256(versions.worktree.bytes) } : {}),
    ...(versions.index?.oid ? { index: versions.index.oid } : {}),
    ...(versions.head?.oid ? { head: versions.head.oid } : {}),
  }
}

export interface Comparable {
  before: Text
  after: Text
  /** The index entry the write replaces. */
  mode: string
  format: 'sha1' | 'sha256'
}

const secret = (path: string, bytes: Buffer) => {
  const head = bytes.subarray(0, HEAD_BYTES)
  return isSecretPath(path, head) || hasSecretContent(head)
}

/**
 * The two texts a view compares (`before` is the older: the index for 未暂存, HEAD for 已暂存), or why the file's lines
 * cannot be picked. A file Git converts line endings for is compared as Git would store it, when that is certain: the
 * index holds no CRLF and the file is CRLF throughout its changed endings; anything else is whole.
 */
export function comparable(path: string, versions: FileVersions, view: GitStagingView): Comparable | GitWholeReason {
  if (versions.conflicted) return 'conflicted'
  const older = view === 'unstaged' ? versions.index : versions.head
  const newer = view === 'unstaged' ? versions.worktree : versions.index
  const sides = [older, newer]
  if (sides.some(side => side?.mode === '160000')) return 'submodule'
  if (sides.some(side => side?.mode === '120000')) return 'link'
  if (!older) return 'new'
  if (!newer) return 'deleted'
  // Promised with `git add -N`: the index holds no content yet, so the file is new on both views.
  if (versions.intentToAdd) return 'new'
  if (!REGULAR.has(older.mode) || !REGULAR.has(newer.mode)) return 'link'
  if (!older.bytes || !newer.bytes) return 'large'
  if (secret(path, older.bytes) || secret(path, newer.bytes)) return 'secret'
  if (older.mode !== newer.mode) return 'mode'
  const beforeText = decodeText(older.bytes)
  let afterText = decodeText(newer.bytes)
  if (beforeText === undefined || afterText === undefined) return 'binary'
  if (view === 'unstaged') {
    if (versions.conversion === 'filtered') return 'filtered'
    if (versions.conversion === 'converted') return 'converted'
    // What Git's guess takes for binary it stores as it is; the Host does not second-guess the guess line by line.
    if (versions.conversion === 'auto' && gitGuessesBinary(newer.bytes)) return 'binary'
    if (versions.conversion !== 'none' && afterText.includes('\r')) {
      // Git stores this file with LF: certain only when the index has no CR and every CR here is half of a CRLF.
      if (beforeText.includes('\r') || /\r(?!\n)/u.test(afterText)) return 'converted'
      afterText = afterText.replaceAll('\r\n', '\n')
    }
  }
  if (beforeText === afterText) return 'unchanged'
  const entry = versions.index!
  const before = splitText(beforeText),
    after = splitText(afterText)
  if (before.lines.length > LINE_LIMIT || after.lines.length > LINE_LIMIT) return 'large'
  return {
    before,
    after,
    mode: entry.mode,
    format: entry.oid!.length === 64 ? 'sha256' : 'sha1',
  }
}

/** `GET …/git/diff`: the file's lines with the whole file as context, or why it is staged whole. */
export function hunkDiff(path: string, view: GitStagingView, versions: FileVersions): GitHunkDiff {
  const compared = comparable(path, versions, view)
  // A file that goes whole is not read against anything: no hash of its content leaves, whatever the reason.
  if (typeof compared === 'string') return { view, path, whole: compared }
  const ops = diffLines(compared.before, compared.after)
  const { add, del } = countChanges(ops)
  return { view, path, base: baseOf(versions), hunks: toHunks(ops, Infinity), add, del }
}

/**
 * Whether ranges are what a request may carry on one side: at most `RANGE_LIMIT` of them, each `[from, to]` with
 * `1 <= from <= to`, in rising order with no line named twice, and at most `LINE_LIMIT` lines in all. Checked on the
 * numbers alone, before any range is walked.
 */
export function validRanges(ranges: readonly GitLineRange[] | undefined): boolean {
  if (!ranges) return true
  if (ranges.length > RANGE_LIMIT) return false
  let last = 0,
    total = 0
  for (const range of ranges) {
    if (!Array.isArray(range) || range.length !== 2) return false
    const [from, to] = range
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from <= last || to < from) return false
    total += to - from + 1
    if (total > LINE_LIMIT) return false
    last = to
  }
  return true
}

/** The line numbers a request's ranges name, or undefined when they are not valid ranges within `1..max`. */
export function expandRanges(ranges: readonly GitLineRange[] | undefined, max: number): Set<number> | undefined {
  if (!validRanges(ranges)) return undefined
  const lines = new Set<number>()
  for (const [from, to] of ranges ?? []) {
    if (to > max) return undefined
    for (let line = from; line <= to; line++) lines.add(line)
  }
  return lines
}

interface Emitted {
  text: string
  /** The line ended with a newline where it came from. */
  ended: boolean
}

/**
 * The content the index should hold once the picked lines are staged (`stage`: from the index towards the file) or
 * unstaged (`unstage`: from the index back towards HEAD). `ops` is the diff from `before` to `after`; every picked
 * number must be a changed line of it. A line that had no newline and is no longer the last one gets the file's.
 */
export function applySelection(
  ops: readonly DiffOp[],
  before: Text,
  after: Text,
  picked: { old: ReadonlySet<number>; new: ReadonlySet<number> },
  direction: 'stage' | 'unstage',
): { text: string; lines: number } {
  if (!picked.old.size && !picked.new.size) throw new SelectionError('empty')
  const removed = new Set<number>(),
    added = new Set<number>()
  for (const op of ops) {
    if (op.kind === 'remove') removed.add(op.oldLine!)
    else if (op.kind === 'add') added.add(op.newLine!)
  }
  for (const line of picked.old) if (!removed.has(line)) throw new SelectionError('not-a-change')
  for (const line of picked.new) if (!added.has(line)) throw new SelectionError('not-a-change')
  const fromBefore = (line: number): Emitted => ({ text: before.lines[line - 1]!, ended: before.newline || line < before.lines.length })
  const fromAfter = (line: number): Emitted => ({ text: after.lines[line - 1]!, ended: after.newline || line < after.lines.length })
  const out: Emitted[] = []
  for (let at = 0; at < ops.length;) {
    const op = ops[at]!
    if (op.kind === 'context') {
      out.push(direction === 'stage' ? fromBefore(op.oldLine!) : fromAfter(op.newLine!))
      at++
      continue
    }
    // One changed block: its removals, then its additions. They are taken pairwise, so a picked replacement lands
    // where the line it replaces was, and a line left alone keeps its place among the others.
    const removes: DiffOp[] = [],
      adds: DiffOp[] = []
    while (ops[at]?.kind === 'remove') removes.push(ops[at++]!)
    while (ops[at]?.kind === 'add') adds.push(ops[at++]!)
    for (let index = 0; index < Math.max(removes.length, adds.length); index++) {
      const remove = removes[index],
        add = adds[index]
      // Staging a removal drops the line from the index; unstaging one puts HEAD's line back.
      if (remove && picked.old.has(remove.oldLine!) !== (direction === 'stage')) out.push(fromBefore(remove.oldLine!))
      if (add && picked.new.has(add.newLine!) === (direction === 'stage')) out.push(fromAfter(add.newLine!))
    }
  }
  const crlf = out.some(line => line.ended && line.text.endsWith('\r'))
  const text = out
    .map((line, index) => {
      if (line.ended) return `${line.text}\n`
      return index === out.length - 1 ? line.text : `${line.text}${crlf ? '\r' : ''}\n`
    })
    .join('')
  return { text, lines: picked.old.size + picked.new.size }
}

/** The index's new content for a selection, with the object ID Git will give it. */
export function selectionResult(
  compared: Comparable,
  selection: { old?: readonly GitLineRange[]; new?: readonly GitLineRange[] },
  direction: 'stage' | 'unstage',
): { text: string; oid: string; lines: number } {
  const old = expandRanges(selection.old, compared.before.lines.length),
    fresh = expandRanges(selection.new, compared.after.lines.length)
  if (!old || !fresh) throw new SelectionError('out-of-range')
  const ops = diffLines(compared.before, compared.after)
  const { text, lines } = applySelection(ops, compared.before, compared.after, { old, new: fresh }, direction)
  return { text, lines, oid: blobId(Buffer.from(text, 'utf8'), compared.format) }
}
