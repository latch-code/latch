import { isFileMention } from '@latch/protocol'

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
  skipped: { large: number; binary: number; unchecked: number }
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
    skipped: { large: skipped.large, binary: skipped.binary, unchecked: (skipped.unchecked as number | undefined) ?? 0 },
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
const STOP_WORDS: Record<ContentStop, string> = {
  results: '结果较多，只显示前一部分',
  files: '文件较多，只搜索了一部分',
  bytes: '内容较多，只搜索了一部分',
  time: '搜索时间到了，只搜索了一部分',
  entries: '文件夹较大，只搜索了一部分',
}

/** The count line under the field: how many lines in how many files, whether more exist, and what was left out. */
export function resultSummary(results: ContentResults): { text: string; partial?: string; skipped?: string } {
  const { files, count, stopped, skipped } = results
  const more = stopped !== undefined || files.some(file => file.more)
  const text = count === 0 ? '没有找到' : `${count} 处 · ${files.length} 个文件`
  const left = [
    skipped.large ? `${skipped.large} 个大文件` : '',
    skipped.binary ? `${skipped.binary} 个非文本文件` : '',
    skipped.unchecked ? `${skipped.unchecked} 项未按忽略规则核对完` : '',
  ]
    .filter(Boolean)
    .join('、')
  return {
    text,
    ...(more ? { partial: stopped ? STOP_WORDS[stopped] : '有的文件匹配较多，只显示前一部分' } : {}),
    ...(left ? { skipped: `未搜索 ${left}` } : {}),
  }
}

/** The folder part of a relative path, shown dim after the name; empty at the top of a folder. */
export function folderOf(path: string): string {
  const at = path.lastIndexOf('/')
  return at < 0 ? '' : path.slice(0, at)
}
