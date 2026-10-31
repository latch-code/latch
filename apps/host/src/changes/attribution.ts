// Tells a turn's changes made by the agent's own edits (`ToolDetail.diffs`) from the ones a command made: a line the
// turn added or removed counts as the agent's when one of its edits added or removed the same line.
import { createHash } from 'node:crypto'
import { isAbsolute, posix, relative, sep } from 'node:path'
import { redactSecrets } from '@latch/core/node-kit'
import { isFileMention, type FileDiff } from '@latch/protocol'
import { isIgnoredPath } from '../files/ignore.ts'
import { diffLines, splitText, type DiffOp, type Text } from './diff.ts'
import { AGENT_LINE_LIMIT, NAMED_FILE_LIMIT, type Change } from './records.ts'
import { fileKey } from './walk.ts'

export const lineHash = (line: string) => createHash('sha256').update(line).digest('hex').slice(0, 16)

/** A session folder under every spelling an agent may use for it: the path it was given, and the real path. */
export interface FolderSpellings {
  id: string
  paths: readonly string[]
}

/**
 * The edits that name each file, by `fileKey`, in the order they were made. An absolute path names the folder it is
 * in; a relative one (Latch's own tools write relative to a folder) may name a file in any folder.
 */
export function editsByFile(edits: readonly FileDiff[], folders: readonly FolderSpellings[]): Map<string, FileDiff[]> {
  const byFile = new Map<string, FileDiff[]>()
  const add = (key: string, edit: FileDiff) => byFile.set(key, [...(byFile.get(key) ?? []), edit])
  for (const edit of edits) {
    if (typeof edit.path !== 'string' || typeof edit.newText !== 'string') continue
    if (isAbsolute(edit.path)) {
      for (const folder of folders) {
        const inside = folder.paths.map(path => relative(path, edit.path)).find(path => path && !path.startsWith('..') && !isAbsolute(path))
        const path = inside?.split(sep).join('/')
        if (path && isFileMention({ root: folder.id, path })) {
          add(fileKey(folder.id, path), edit)
          break
        }
      }
    } else {
      const path = posix.normalize(edit.path.replaceAll('\\', '/')).replace(/^\.\//u, '')
      for (const folder of folders) if (isFileMention({ root: folder.id, path })) add(fileKey(folder.id, path), edit)
    }
  }
  return byFile
}

/**
 * What the turn's edits name that no snapshot records, so no undo reaches it: a path outside every folder, or inside
 * one under a name the snapshots ignore. Commands leave no such trace, so this cannot name what they wrote elsewhere.
 */
export function uncoveredEdits(edits: readonly FileDiff[], folders: readonly FolderSpellings[]): string[] {
  const uncovered = new Set<string>()
  for (const edit of edits) {
    if (typeof edit.path !== 'string' || !edit.path) continue
    const inside = isAbsolute(edit.path)
      ? folders
          .flatMap(folder => folder.paths)
          .map(path => relative(path, edit.path))
          .find(path => path && !path.startsWith('..') && !isAbsolute(path))
      : posix.normalize(edit.path.replaceAll('\\', '/')).replace(/^\.\//u, '')
    const path = inside?.split(sep).join('/')
    if (path === undefined || path.startsWith('..') || isIgnoredPath(path)) uncovered.add(redactSecrets(edit.path).slice(0, 4096))
  }
  return [...uncovered].slice(0, NAMED_FILE_LIMIT)
}

type Lines = Map<string, number>
const take = (lines: Lines, line: string) => {
  const key = lineHash(line),
    left = lines.get(key) ?? 0
  if (left > 0) lines.set(key, left - 1)
  return left > 0
}
const counted = (hashes: readonly string[]): Lines => {
  const lines: Lines = new Map()
  for (const hash of hashes) lines.set(hash, (lines.get(hash) ?? 0) + 1)
  return lines
}

/** The lines the agent's edits added and removed, as hashes; an edit without its old text added all its lines. */
function agentLines(edits: readonly FileDiff[]): { added: string[]; removed: string[] } {
  const added: string[] = [],
    removed: string[] = []
  for (const edit of edits) {
    const before = edit.oldText ?? (edit.previous === 'none' ? '' : undefined)
    if (before === undefined) {
      for (const line of splitText(edit.newText).lines) added.push(lineHash(line))
      continue
    }
    for (const op of diffLines(splitText(before), splitText(edit.newText))) {
      if (op.kind === 'add') added.push(lineHash(op.text))
      else if (op.kind === 'remove') removed.push(lineHash(op.text))
    }
  }
  return { added, removed }
}

/** Which of `ops` (the turn's diff of one file) a command made, given the change's attribution. */
export function commandLines(ops: readonly DiffOp[], change: Pick<Change, 'by' | 'agentLines'>): boolean[] {
  if (change.by === 'command') return ops.map(op => op.kind !== 'context')
  if (change.by !== 'mixed' || !change.agentLines) return ops.map(() => false)
  const added = counted(change.agentLines.added),
    removed = counted(change.agentLines.removed)
  return ops.map(op => (op.kind === 'add' ? !take(added, op.text) : op.kind === 'remove' ? !take(removed, op.text) : false))
}

/**
 * Who made one change of a turn. `before` and `after` are the file's text on each side when both are text that was
 * kept; without them, only whether an edit named the file decides.
 */
export function attributeChange(
  edits: readonly FileDiff[],
  before: Text | undefined,
  after: Text | undefined,
): Pick<Change, 'by' | 'agentLines'> {
  if (!edits.length) return { by: 'command' }
  if (!before || !after) return { by: 'agent' }
  // The agent wrote the whole file last: every line it ends with is the agent's.
  const last = splitText(edits.at(-1)!.newText)
  if (
    last.newline === after.newline
    && last.lines.length === after.lines.length
    && last.lines.every((line, index) => line === after.lines[index])
  )
    return { by: 'agent' }
  const lines = agentLines(edits)
  const ops = diffLines(before, after)
  const flags = commandLines(ops, { by: 'mixed', agentLines: lines })
  const changed = ops.filter(op => op.kind !== 'context').length,
    byCommand = flags.filter(Boolean).length
  if (byCommand === 0) return { by: 'agent' }
  if (byCommand === changed) return { by: 'command' }
  return lines.added.length <= AGENT_LINE_LIMIT && lines.removed.length <= AGENT_LINE_LIMIT
    ? { by: 'mixed', agentLines: lines }
    : { by: 'mixed' }
}
