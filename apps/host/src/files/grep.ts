// Searching the text of a project's files (`POST …/files/grep`). No index and no background work: each request walks
// the folders with the name search's bounded walk (ignore rules, no symlinks, nothing outside the folder, nothing
// protected), resolves every candidate again as a file read would, opens it through the same descriptor checks and
// matches the query as literal text. The query is never a pattern, an option or a program argument, and nothing of it
// or of the results is logged or audited.
import { realpath, stat } from 'node:fs/promises'
import { containsSecret } from '@latch/core/node-kit'
import { AppError } from '@latch/sdk'
import { openContent } from './read.ts'
import { resolveRecorded, type FileRoot, type ProtectedPaths, type ResolvedFile, type ResolveOptions } from './resolve.ts'
import { freshBudget, walk, type Unchecked } from './search.ts'
import { looksLikeText } from './sniff.ts'
import { beginLoopWork, turnIfDue } from './loop-turn.ts'

const READ_CHUNK = 64 * 1024

/** Every bound of one search. Tests pass smaller ones. */
export interface GrepLimits {
  /** The whole search, walk included. */
  ms: number
  /** Directory entries the walk may visit. */
  entries: number
  /** Files opened and read. */
  files: number
  /** Bytes read across all files. */
  bytes: number
  /** A larger file is skipped, not read. */
  fileBytes: number
  /** Matching lines returned in all. */
  results: number
  /** Matching lines returned from one file. */
  perFile: number
  /** Characters of one returned line, around its first match. */
  lineChars: number
}
export const GREP_LIMITS: GrepLimits = {
  ms: 3000,
  entries: 50_000,
  files: 5000,
  bytes: 64 * 1024 * 1024,
  fileBytes: 1024 * 1024,
  results: 500,
  perFile: 100,
  lineChars: 240,
}
export const GREP_QUERY_MAX = 256

export interface GrepQuery {
  q: string
  caseSensitive: boolean
  wholeWord: boolean
}
export interface GrepLine {
  /** 1-based. */
  line: number
  /** At most `lineChars` characters of the line, around its first match. */
  text: string
  /** Matches inside `text`, as [start, end) in UTF-16 code units. */
  ranges: Array<[number, number]>
  /** `text` starts after, or ends before, the line does. */
  before?: true
  after?: true
}
export interface GrepFile {
  root: string
  path: string
  name: string
  lines: GrepLine[]
  /** More lines matched in this file than were returned. */
  more?: true
}
/** Why a search stopped before the end: too many results, files or bytes, or out of time. */
export type GrepStop = 'results' | 'files' | 'bytes' | 'time' | 'entries'
export interface GrepResult {
  files: GrepFile[]
  /** Matching lines returned. */
  count: number
  /** Files read. */
  scanned: number
  /**
   * Left out: files too large or not text; files and folders (with all they hold) whose ignore check was cut short,
   * which count as ignored.
   */
  skipped: { large: number; binary: number; unchecked: number; uncheckedFolders: number }
  /** Set when not every file was searched or not every match returned. */
  stopped?: GrepStop
}

/** Letters, digits and `_` in any script: what a whole word does not continue into. */
const WORD = '[\\p{L}\\p{N}\\p{M}_]'
/**
 * The query as literal text: every character is escaped, so it can never be a pattern of its own, and the expression
 * is a fixed literal between two fixed one-character lookarounds, which matches in linear time.
 */
export function literalPattern(query: GrepQuery): RegExp {
  // Exactly the syntax characters, the only ones a `u` expression may escape.
  const escaped = query.q.replace(/[\\^$.*+?()[\]{}|/]/gu, '\\$&')
  const body = query.wholeWord ? `(?<!${WORD})${escaped}(?!${WORD})` : escaped
  return new RegExp(body, query.caseSensitive ? 'gu' : 'giu')
}

/** The matches of one line, at most `perLine`, never an empty one. */
function lineMatches(pattern: RegExp, line: string, perLine: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  pattern.lastIndex = 0
  let found: RegExpExecArray | null
  while (ranges.length < perLine && (found = pattern.exec(line)) !== null) {
    if (found[0].length === 0) {
      pattern.lastIndex++
      continue
    }
    ranges.push([found.index, found.index + found[0].length])
  }
  return ranges
}

/**
 * A window of the line around its first match, with the ranges moved into it and cut to it; undefined when every match
 * lies in trailing whitespace the window leaves out. `trimEnd` is linear, unlike a `\s+$` expression, which V8 runs in
 * quadratic time on a long run of whitespace followed by anything else.
 */
export function windowed(line: string, ranges: Array<[number, number]>, chars: number): Omit<GrepLine, 'line'> | undefined {
  const trimmed = line.trimEnd()
  if (trimmed.length <= chars) {
    const kept = ranges.flatMap(([from, to]): Array<[number, number]> =>
      from < trimmed.length ? [[from, Math.min(to, trimmed.length)]] : [],
    )
    return kept.length ? { text: trimmed, ranges: kept } : undefined
  }
  const first = ranges[0]![0]
  if (first >= trimmed.length) return undefined
  let start = Math.max(0, Math.min(first - Math.floor(chars / 4), trimmed.length - chars))
  // Never split a surrogate pair at either edge.
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(trimmed[start]!)) start--
  let end = Math.min(trimmed.length, start + chars)
  if (end < trimmed.length && /[\uD800-\uDBFF]/u.test(trimmed[end - 1]!)) end--
  const kept = ranges
    .filter(([from]) => from >= start && from < end)
    .map(([from, to]): [number, number] => [from - start, Math.min(to, end) - start])
  if (!kept.length) return undefined
  return {
    text: trimmed.slice(start, end),
    ranges: kept,
    ...(start > 0 ? { before: true as const } : {}),
    ...(end < trimmed.length ? { after: true as const } : {}),
  }
}

/** Characters of one line that are searched; the rest of a longer line (minified code, data) is not. */
export const GREP_LINE_SCAN = 8192

/** What a search needs beyond its query, besides the bounds: the read budget, the record of each file it returns. */
export interface GrepHooks {
  /** Charges the bytes about to be read; throws a 429 `AppError` once the caller's budget is spent. */
  consume?(bytes: number): void
  /** Each file whose lines are returned, before the answer is sent (for the audit log). */
  found?(file: ResolvedFile, lines: number): void
  /** The folder's files from a current cached scan, or undefined to walk it now. */
  list?(
    root: FileRoot,
    cancelled: () => boolean,
    check: () => void,
  ): Promise<{ paths: readonly string[]; truncated: boolean; undecided: Unchecked } | undefined>
  /** Test seam: runs after a file was resolved, before it is opened. */
  resolve?: ResolveOptions['hooks']
}

/**
 * Searches the text files of `roots` for the query. `check` throws when the caller lost access; `cancelled` ends the
 * search early (the request went away). Returns what was found within the bounds and why it stopped, if it did. Every
 * synchronous step works on one file of at most `fileBytes` and is linear in it; between files the event loop turns and
 * the deadline and `cancelled` are looked at again.
 */
export async function grepFiles(...args: Parameters<typeof grepFolders>): ReturnType<typeof grepFolders> {
  const end = beginLoopWork()
  try {
    return await grepFolders(...args)
  } finally {
    end()
  }
}

async function grepFolders(
  roots: readonly FileRoot[],
  guard: ProtectedPaths,
  query: GrepQuery,
  cancelled: () => boolean,
  check: () => void,
  limits: GrepLimits = GREP_LIMITS,
  hooks: GrepHooks = {},
): Promise<GrepResult> {
  if (!query.q || query.q.length > GREP_QUERY_MAX || /[\r\n]/u.test(query.q)) throw new AppError(400, 'file-grep-invalid', '搜索内容无效')
  const pattern = literalPattern(query)
  const deadline = performance.now() + limits.ms
  const result: GrepResult = { files: [], count: 0, scanned: 0, skipped: { large: 0, binary: 0, unchecked: 0, uncheckedFolders: 0 } }
  let resolves = 0
  // A file's first bytes are read to classify it even when it is then skipped: they count against the budget too.
  const charge = (bytes: number) => {
    try {
      hooks.consume?.(bytes)
      return true
    } catch (cause) {
      if (!(cause instanceof AppError) || cause.status !== 429) throw cause
      result.stopped ??= 'bytes'
      return false
    }
  }
  let bytes = 0
  const late = () => cancelled() || performance.now() > deadline
  const budget = freshBudget(limits.ms, limits.entries)
  const decoder = new TextDecoder('utf-8', { fatal: false })
  for (const source of roots) {
    if (cancelled()) return result
    if (performance.now() > deadline) {
      result.stopped ??= 'time'
      break
    }
    const path = await realpath(source.path).catch(() => undefined)
    check()
    if (!path) continue
    const info = await stat(path).catch(() => undefined)
    check()
    if (!info?.isDirectory()) continue
    const root = { id: source.id, path }
    // The name search's cached list of the folder when it is current, so a search does not walk again each time.
    const walked =
      (await hooks.list?.(root, late, check))
      ?? (await walk(root, guard, late, check, () => {}, budget, [{ relative: '', depth: 0 }], true))
    check()
    result.skipped.unchecked += walked.undecided.files
    result.skipped.uncheckedFolders += walked.undecided.directories
    if (walked.truncated) result.stopped ??= performance.now() > deadline ? 'time' : 'entries'
    for (const relative of walked.paths) {
      // The event loop turns between files whenever it has been held YIELD_MS, so a long search never holds the Host.
      await turnIfDue()
      check()
      if (cancelled()) return result
      if (performance.now() > deadline) {
        result.stopped ??= 'time'
        break
      }
      if (result.scanned >= limits.files) {
        result.stopped ??= 'files'
        break
      }
      if (result.count >= limits.results) {
        result.stopped ??= 'results'
        break
      }
      // The walk's names are hints only: the file is resolved, classified and opened again as a read would.
      const resolved = await resolveRecorded(root.id, relative, {
        roots: [root],
        protectedPaths: guard,
        home: '',
        ...(hooks.resolve ? { hooks: hooks.resolve } : {}),
      })
      check()
      if (++resolves > limits.files * 2) {
        result.stopped ??= 'files'
        break
      }
      if (resolved.status !== 'ok') continue
      if (!charge(resolved.file.head.byteLength)) break
      if (resolved.file.secret) continue
      const file = resolved.file
      if (file.size > limits.fileBytes) {
        result.skipped.large++
        continue
      }
      // UTF-8 text only: a byte-order mark for UTF-16, a NUL or invalid UTF-8 in the first bytes is not searched.
      if (!looksLikeText(file.head) || file.head[0] === 0xff || file.head[0] === 0xfe) {
        result.skipped.binary++
        continue
      }
      if (bytes + file.size > limits.bytes) {
        result.stopped ??= 'bytes'
        break
      }
      if (!charge(file.size)) break
      let content: Buffer
      try {
        const fd = await openContent(file, false)
        try {
          // In chunks, so a read that never settles (a hung mount) holds one chunk, not the whole file.
          const chunks: Buffer[] = []
          let at = 0
          while (at < file.size) {
            const chunk = Buffer.alloc(Math.min(READ_CHUNK, file.size - at))
            const { bytesRead } = await fd.read(chunk, 0, chunk.length, at)
            if (bytesRead === 0 || cancelled()) break
            chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead))
            at += bytesRead
          }
          content = Buffer.concat(chunks)
        } finally {
          await fd.close()
        }
      } catch (cause) {
        // Changed, replaced or secret since it was resolved: left out, as a read of it would be refused.
        if (cause instanceof AppError) continue
        throw cause
      }
      check()
      bytes += content.length
      result.scanned++
      if (content.includes(0)) {
        result.skipped.binary++
        continue
      }
      if (cancelled()) return result
      const text = decoder.decode(content)
      // A credential anywhere in the file keeps the whole file out of the results, not only its first bytes.
      if (containsSecret(text)) continue
      const lines: GrepLine[] = []
      let more = false
      let number = 0,
        from = 0
      while (from <= text.length) {
        // However many lines, the event loop turns every few milliseconds.
        if ((number & 255) === 0) {
          await turnIfDue()
          if (cancelled()) return result
        }
        const next = text.indexOf('\n', from)
        const raw = text.slice(from, next < 0 ? text.length : next)
        from = next < 0 ? text.length + 1 : next + 1
        number++
        // Only the first GREP_LINE_SCAN characters of a line are searched, so no step on one line costs more than that.
        const line = (raw.length > GREP_LINE_SCAN ? raw.slice(0, GREP_LINE_SCAN) : raw).replace(/\r$/u, '')
        const ranges = lineMatches(pattern, line, 32)
        if (!ranges.length) continue
        if (lines.length >= limits.perFile || result.count + lines.length >= limits.results) {
          more = true
          break
        }
        const shown = windowed(line, ranges, limits.lineChars)
        if (shown) lines.push({ line: number, ...shown })
      }
      if (lines.length) {
        hooks.found?.(file, lines.length)
        result.files.push({ root: root.id, path: file.relativePath, name: file.name, lines, ...(more ? { more: true as const } : {}) })
        result.count += lines.length
        if (more && result.count >= limits.results) result.stopped ??= 'results'
      }
    }
    if (result.stopped && result.stopped !== 'entries') break
  }
  return result
}
