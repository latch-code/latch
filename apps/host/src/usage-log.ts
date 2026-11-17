// The file mechanics the usage records share: one append-only 0600 JSONL file per month of the Host computer's own time,
// strict lines read one at a time, and months removed once they end more than 90 days back. The gateway's ledger and the
// record of own-login turns both keep their lines this way.
import { createReadStream } from 'node:fs'
import { open, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { z } from 'zod'

export const DAY_MS = 86_400_000
/** How long a use stays on record. */
export const USAGE_KEEP_DAYS = 90
/** Lines read for one summary; a period with more says so. */
const MAX_READ_LINES = 400_000
const MAX_LINE_CHARS = 4096

/** `YYYY-MM` of a time, in the Host computer's own time: where a month begins and ends for the records and for budgets. */
export function monthOf(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

/** The first instant of a month, and of the month after it, in the Host computer's own time. */
function monthBounds(month: string): { start: number; end: number } {
  const [year, index] = month.split('-').map(Number) as [number, number]
  return { start: new Date(year, index - 1, 1).getTime(), end: new Date(year, index, 1).getTime() }
}

export const hostTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

const missing = (error: unknown): boolean => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'

/** The months from `start`'s to `to`'s, oldest first. */
function monthsBetween(start: number, to: number): string[] {
  const months: string[] = []
  for (let month = monthOf(start); month <= monthOf(to);) {
    months.push(month)
    month = monthOf(monthBounds(month).end)
  }
  return months
}

/**
 * A file whose last line a crash cut short gets its newline, so the next line is a line of its own. `ended` holds the
 * files already looked at by this process.
 */
export async function closeLastLine(path: string, ended: Set<string>): Promise<void> {
  if (ended.has(path)) return
  let handle
  try {
    handle = await open(path, 'r+')
  } catch (error) {
    if (missing(error)) ended.add(path)
    return
  }
  try {
    // A file from before, or one somebody copied in: the record's own mode again before it is read or added to.
    await handle.chmod(0o600)
    const { size } = await handle.stat()
    if (size > 0) {
      const last = Buffer.alloc(1)
      await handle.read(last, 0, 1, size - 1)
      if (last[0] !== 0x0a) await handle.write('\n', size)
    }
    ended.add(path)
  } finally {
    await handle.close()
  }
}

/** Appends one line to a 0600 file; resolves with the file's size after it. */
export async function appendLine(path: string, value: unknown): Promise<number> {
  const handle = await open(path, 'a', 0o600)
  try {
    await handle.appendFile(`${JSON.stringify(value)}\n`)
    return (await handle.stat()).size
  } finally {
    await handle.close()
  }
}

/**
 * Every line of a file that `schema` accepts, one at a time, until `each` returns false; resolves with how many could
 * not be read. A missing file has none.
 */
export async function scanLines<T>(path: string, schema: z.ZodType<T>, each: (line: T) => boolean | void): Promise<number> {
  let skipped = 0
  const stream = createReadStream(path, { encoding: 'utf8' })
  try {
    for await (const text of createInterface({ input: stream, crlfDelay: Infinity })) {
      if (!text) continue
      let parsed: unknown
      try {
        parsed = text.length > MAX_LINE_CHARS ? undefined : JSON.parse(text)
      } catch {
        parsed = undefined
      }
      const line = schema.safeParse(parsed)
      if (!line.success) skipped++
      else if (each(line.data) === false) break
    }
  } catch (error) {
    if (!missing(error)) skipped++
  } finally {
    stream.destroy()
  }
  return skipped
}

/**
 * The lines dated in `[from, to]` (never older than 90 days) of the monthly files `path` names, at most
 * `MAX_READ_LINES`, with how many could not be read.
 */
export async function readMonths<T extends { at: string }>(
  path: (month: string) => string,
  schema: z.ZodType<T>,
  from: number,
  to: number,
  now: number,
): Promise<{ lines: T[]; skipped: number; truncated: boolean }> {
  const start = Math.max(from, now - USAGE_KEEP_DAYS * DAY_MS)
  const result = { lines: [] as T[], skipped: 0, truncated: false }
  for (const month of monthsBetween(start, to)) {
    result.skipped += await scanLines(path(month), schema, line => {
      const at = Date.parse(line.at)
      if (at < start || at > to) return true
      if (result.lines.length >= MAX_READ_LINES) {
        result.truncated = true
        return false
      }
      result.lines.push(line)
      return true
    })
  }
  return result
}

/**
 * Removes the files of `directory` whose month `monthOfName` reads ended more than 90 days before `now`; a file it
 * reads no month from is left alone. Resolves with the months removed.
 */
export async function pruneMonths(directory: string, monthOfName: (name: string) => string | undefined, now: number): Promise<string[]> {
  const oldest = now - USAGE_KEEP_DAYS * DAY_MS
  const removed: string[] = []
  for (const name of await readdir(directory).catch(() => [])) {
    const month = monthOfName(name)
    if (!month || monthBounds(month).end > oldest) continue
    await unlink(join(directory, name)).catch(() => {})
    removed.push(month)
  }
  return removed
}
