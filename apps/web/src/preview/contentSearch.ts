import { isFileMention } from '@latch/protocol'
import { defineCopy, formatList, plural } from '../core/i18n.ts'

/** What the Host answers for `POST …/files/grep` (apps/host/src/files/grep.ts), checked before it is shown. */
interface ContentLine {
  line: number
  text: string
  ranges: Array<[number, number]>
  before?: true
  after?: true
}
export interface ContentFile {
  root: string
  path: string
  name: string
  lines: ContentLine[]
  more?: true
}
type ContentStop = 'results' | 'files' | 'bytes' | 'time' | 'entries'
export interface ContentResults {
  files: ContentFile[]
  count: number
  scanned: number
  skipped: { large: number; binary: number; unchecked: number; uncheckedFolders: number }
  stopped?: ContentStop
}
export interface ContentQuery {
  q: string
  caseSensitive: boolean
  wholeWord: boolean
}

const STOPS = new Set<ContentStop>(['results', 'files', 'bytes', 'time', 'entries'])
const RESULT_LIMIT = 500
const LINE_CHARS = 240
const count = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max

function line(value: unknown): ContentLine | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Record<string, unknown>
  if (!count(item.line) || item.line < 1 || typeof item.text !== 'string' || item.text.length > LINE_CHARS) return undefined
  if (!Array.isArray(item.ranges) || item.ranges.length > 32) return undefined
  const ranges: Array<[number, number]> = []
  let last = 0
  for (const range of item.ranges) {
    if (!Array.isArray(range) || range.length !== 2 || !count(range[0]) || !count(range[1])) return undefined
    const [start, end] = range as [number, number]
    // In order, not overlapping, inside the text: anything else is not drawn as the Host meant it.
    if (start < last || end <= start || end > item.text.length) return undefined
    ranges.push([start, end])
    last = end
  }
  if ((item.before !== undefined && item.before !== true) || (item.after !== undefined && item.after !== true)) return undefined
  return {
    line: item.line,
    text: item.text,
    ranges,
    ...(item.before ? { before: true as const } : {}),
    ...(item.after ? { after: true as const } : {}),
  }
}

/** The Host's answer, or undefined when any part of it is not the shape this page draws. */
export function parseContentResults(value: unknown): ContentResults | undefined {
  if (!value || typeof value !== 'object') return undefined
  const reply = value as Record<string, unknown>
  if (!Array.isArray(reply.files) || reply.files.length > RESULT_LIMIT || !count(reply.count, RESULT_LIMIT) || !count(reply.scanned))
    return undefined
  const skipped = reply.skipped as Record<string, unknown> | undefined
  if (!skipped || typeof skipped !== 'object' || !count(skipped.large) || !count(skipped.binary)) return undefined
  if (skipped.unchecked !== undefined && !count(skipped.unchecked)) return undefined
  if (skipped.uncheckedFolders !== undefined && !count(skipped.uncheckedFolders)) return undefined
  if (reply.stopped !== undefined && !STOPS.has(reply.stopped as ContentStop)) return undefined
  const files: ContentFile[] = []
  let total = 0
  for (const entry of reply.files) {
    if (!entry || typeof entry !== 'object') return undefined
    const file = entry as Record<string, unknown>
    if (typeof file.name !== 'string' || !isFileMention({ root: file.root, path: file.path })) return undefined
    if (!Array.isArray(file.lines) || file.lines.length === 0 || (file.more !== undefined && file.more !== true)) return undefined
    const lines = file.lines.map(line)
    if (lines.some(item => item === undefined)) return undefined
    total += lines.length
    files.push({
      root: file.root as string,
      path: file.path as string,
      name: file.name,
      lines: lines as ContentLine[],
      ...(file.more ? { more: true as const } : {}),
    })
  }
  if (total !== reply.count) return undefined
  return {
    files,
    count: total,
    scanned: reply.scanned,
    skipped: {
      large: skipped.large,
      binary: skipped.binary,
      unchecked: (skipped.unchecked as number | undefined) ?? 0,
      uncheckedFolders: (skipped.uncheckedFolders as number | undefined) ?? 0,
    },
    ...(reply.stopped ? { stopped: reply.stopped as ContentStop } : {}),
  }
}

/** A line cut into plain and matched parts, in order, for drawing the matches marked. */
export function highlightParts(text: string, ranges: ReadonlyArray<readonly [number, number]>): Array<{ text: string; match: boolean }> {
  const parts: Array<{ text: string; match: boolean }> = []
  let at = 0
  for (const [start, end] of ranges) {
    if (start > at) parts.push({ text: text.slice(at, start), match: false })
    parts.push({ text: text.slice(start, end), match: true })
    at = end
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false })
  return parts
}

/** Why the list is not everything, for the hover beside the count. */
const STOP_WORDS = defineCopy<Record<ContentStop, string>>(
  {
    results: '结果较多，只显示前一部分',
    files: '文件较多，只搜索了一部分',
    bytes: '内容较多，只搜索了一部分',
    time: '搜索时间到了，只搜索了一部分',
    entries: '文件夹较大，只搜索了一部分',
  },
  {
    results: 'Only the first matches are shown.',
    files: 'There are too many files to search them all.',
    bytes: 'There is too much content to search it all.',
    time: 'The search reached its time limit.',
    entries: 'The folder is too large to search it all.',
  },
)

const COPY = defineCopy(
  {
    folders: (count: number) => plural(count, { other: '{n} 个文件夹（连同其中内容）' }),
    files: (count: number) => plural(count, { other: '{n} 个文件' }),
    unchecked: (count: number) => plural(count, { other: '{n} 项未核对' }),
    ignored: (parts: string[]) => `${parts.join('和 ')}的忽略规则没有核对完，按已忽略处理，没有搜索。`,
    noResults: '没有找到',
    matches: (count: number) => plural(count, { other: '{n} 处' }),
    large: (count: number) => plural(count, { other: '{n} 个大文件' }),
    binary: (count: number) => plural(count, { other: '{n} 个非文本文件' }),
    skipped: (parts: string[]) => `未搜索 ${parts.join('、')}`,
    someMatches: '有的文件匹配较多，只显示前一部分',
  },
  {
    folders: (count: number) => plural(count, { one: '{n} folder and its contents', other: '{n} folders and their contents' }),
    files: (count: number) => plural(count, { one: '{n} file', other: '{n} files' }),
    unchecked: (count: number) => plural(count, { one: '{n} item unchecked', other: '{n} items unchecked' }),
    ignored: (parts: string[]) => `Ignore rules could not be fully checked for ${formatList(parts)}. The search skipped them.`,
    noResults: 'No matches',
    matches: (count: number) => plural(count, { one: '{n} match', other: '{n} matches' }),
    large: (count: number) => plural(count, { one: '{n} large file', other: '{n} large files' }),
    binary: (count: number) => plural(count, { one: '{n} non-text file', other: '{n} non-text files' }),
    skipped: (parts: string[]) => `Skipped ${formatList(parts)}`,
    someMatches: 'Only the first matches in some files are shown.',
  },
)

/**
 * Files and folders whose ignore check the Host cut short, as content search and ⌘P both show them: a short label, and
 * the reason on hover. A folder counts as one folder, with everything in it.
 */
export function uncheckedNote(files: number, folders: number): { label: string; detail: string } | undefined {
  if (!files && !folders) return undefined
  const parts = [folders ? COPY.folders(folders) : '', files ? COPY.files(files) : ''].filter(Boolean)
  return { label: COPY.unchecked(files + folders), detail: COPY.ignored(parts) }
}

/** The count line under the field: how many lines in how many files, whether more exist, and what was left out. */
export function resultSummary(results: ContentResults): {
  text: string
  partial?: string
  skipped?: string
  unchecked?: { label: string; detail: string }
} {
  const { files, count, stopped, skipped } = results
  const more = stopped !== undefined || files.some(file => file.more)
  const text = count === 0 ? COPY.noResults : `${COPY.matches(count)} · ${COPY.files(files.length)}`
  const unchecked = uncheckedNote(skipped.unchecked, skipped.uncheckedFolders)
  const left = [skipped.large ? COPY.large(skipped.large) : '', skipped.binary ? COPY.binary(skipped.binary) : ''].filter(Boolean)
  return {
    text,
    ...(more ? { partial: stopped ? STOP_WORDS[stopped] : COPY.someMatches } : {}),
    ...(left.length ? { skipped: COPY.skipped(left) } : {}),
    ...(unchecked ? { unchecked } : {}),
  }
}

/** The folder part of a relative path, shown dim after the name; empty at the top of a folder. */
export function folderOf(path: string): string {
  const at = path.lastIndexOf('/')
  return at < 0 ? '' : path.slice(0, at)
}
