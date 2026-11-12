// Terminal output as plain text: for 「加入对话」, which hands an agent the selection or the last lines, and for finding
// local services in the output. Escape sequences go, carriage returns and line erases are applied as a terminal shows
// them, and the result passes through redactLineSecrets and redactKnownSecrets before it leaves the Host.
import type { TerminalText } from '@latch/protocol'
import { redactKnownSecrets } from '@latch/core/node-kit'
import { redactLineSecrets } from './line-secrets.ts'

/** The most lines one 「加入对话」 takes, from the selection or the end of the output. */
export const ATTACH_LINE_LIMIT = 200
/** And the most characters, keeping the newest. */
export const ATTACH_CHARACTER_LIMIT = 32_000
/** The cursor model wraps here, as a terminal this wide would, so no cursor column grows past it. */
export const LINE_CHARACTER_LIMIT = 4096
/** Cells one rendering may spend on gaps from cursor movements and on erasing inside a line; past it they shrink to one. */
const GAP_BUDGET = 256 * 1024

const ESC = 0x1b
/** C1 introducers: CSI, OSC, and the string controls DCS, SOS, PM and APC. */
const C1_CSI = 0x9b
const C1_OSC = 0x9d
const C1_STRINGS = new Set([0x90, 0x98, 0x9e, 0x9f])
const C1_ST = 0x9c
const BEL = 0x07
/** Format characters (bidirectional controls, zero-width characters) and line separators hide or reorder text; the zero-width joiner of emoji stays. */
/** The start of a key by its documented prefix, of a Latch credential or code, or a piece of a private key's armour. */
const SECRET_FRAGMENT =
  /\b(?:sk-[A-Za-z0-9_-]{3}|gh[pousr]_|github_pat_|(?:AKIA|ASIA)[0-9A-Z]{4}|xox[abprs]-|AIza|ldc1\.|ln[wpd]1\.|lr[ts]1\.|lp[io]1-|LATCH(?:PAIR|BOOK)1\.)|-----(?:BEGIN|END)\b|PRIVATE KEY/u
const LONG_RUN = /[A-Za-z0-9+/=_-]{32,}/gu
const RANDOM_RUN_DIGITS = 2
const RANDOM_RUN_ENTROPY = 4
const INVISIBLE = /(?!\u200d)[\p{Cf}\u2028\u2029]/gu

interface Escape {
  /** Index just past the sequence. */
  end: number
  /** A control sequence's final character and parameters; undefined for strings and other escapes. */
  final?: string
  params?: string
  /** The character of a two-character escape such as ESC E. */
  short?: string
}

/** The escape sequence starting at `index` (ESC, or a C1 introducer). An unterminated one runs to the end of the text. */
function escapeAt(text: string, index: number): Escape {
  const first = text.charCodeAt(index)
  let kind: 'csi' | 'osc' | 'string' | 'other'
  let cursor = index + 1
  if (first === C1_CSI) kind = 'csi'
  else if (first === C1_OSC) kind = 'osc'
  else if (C1_STRINGS.has(first)) kind = 'string'
  else {
    const next = text[cursor]
    cursor++
    kind = next === '[' ? 'csi' : next === ']' ? 'osc' : next === 'P' || next === 'X' || next === '^' || next === '_' ? 'string' : 'other'
    if (kind === 'other') {
      // Intermediate bytes, then one final byte (ESC ( B selects a character set).
      cursor--
      while (cursor < text.length && text.charCodeAt(cursor) >= 0x20 && text.charCodeAt(cursor) <= 0x2f) cursor++
      return { end: Math.min(text.length, cursor + 1), ...(cursor === index + 1 ? { short: next } : {}) }
    }
  }
  if (kind === 'csi') {
    const start = cursor
    while (cursor < text.length && text.charCodeAt(cursor) >= 0x20 && text.charCodeAt(cursor) <= 0x3f) cursor++
    if (cursor >= text.length) return { end: text.length }
    return { end: cursor + 1, final: text[cursor], params: text.slice(start, cursor) }
  }
  // OSC ends with BEL or ST; the other strings with ST (ESC \ or the C1 ST).
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor)
    if (code === C1_ST || (kind === 'osc' && code === BEL)) return { end: cursor + 1 }
    if (code === ESC && text[cursor + 1] === '\\') return { end: cursor + 2 }
    cursor++
  }
  return { end: text.length }
}

function introducesEscape(code: number): boolean {
  return code === ESC || code === C1_CSI || code === C1_OSC || C1_STRINGS.has(code)
}

/** The text without escape sequences; everything else stays. */
export function stripEscapes(text: string): string {
  let result = ''
  let from = 0
  for (let index = 0; index < text.length; index++) {
    if (!introducesEscape(text.charCodeAt(index))) continue
    result += text.slice(from, index)
    index = escapeAt(text, index).end - 1
    from = index + 1
  }
  return result + text.slice(from)
}

/**
 * The lines a terminal would show for this output, without its colours and cursor movements. Linear in the input,
 * whatever it contains: cells left blank are holes filled in once, when the line ends; erasing to the start of the line
 * skips cells already known to be blank. The cursor model wraps every LINE_CHARACTER_LIMIT cells to stay bounded, but the
 * wrapped parts stay one line, so a secret across a wrap is still redacted whole. A cursor movement leaves the gap or the
 * line break it leaves on screen (rows are not modelled: any move to another row starts a line), so text on either side
 * rarely joins into one word, which would hide a key from redaction.
 */
export function plainLines(text: string): string[] {
  const lines: string[] = []
  /** The parts of the current line that the cursor model has already wrapped past. */
  let wrapped = ''
  let line: Array<string | undefined> = []
  let column = 0
  /** Every cell up to here is blank, so erasing them again costs nothing. */
  let blankThrough = Number.MAX_SAFE_INTEGER
  let budget = GAP_BUDGET
  const cells = () => Array.from(line, cell => cell ?? ' ').join('')
  const restart = () => {
    line = []
    column = 0
    blankThrough = Number.MAX_SAFE_INTEGER
  }
  const commit = () => {
    lines.push(wrapped + cells())
    wrapped = ''
    restart()
  }
  const put = (character: string) => {
    if (column >= LINE_CHARACTER_LIMIT) {
      wrapped += cells()
      restart()
    }
    if (column > line.length) {
      const gap = column - line.length
      if (gap > budget) column = line.length + 1
      else budget -= gap
    }
    line[column] = character
    if (column <= blankThrough) blankThrough = column - 1
    column++
  }
  /** To another row: what was written stays on its own line. */
  const breakLine = (nextColumn: number) => {
    if (line.length > 0 || wrapped !== '') commit()
    column = Math.min(nextColumn, LINE_CHARACTER_LIMIT - 1)
  }
  const moveCursor = (final: string | undefined, params: string) => {
    if (!/^[\d;]*$/u.test(params)) return
    const [first, second] = params.split(';').map(value => Math.min(Number(value) || 1, LINE_CHARACTER_LIMIT))
    const count = first ?? 1
    if (final === 'C' || final === 'a') column = Math.min(LINE_CHARACTER_LIMIT - 1, column + count)
    else if (final === 'D') column = Math.max(0, column - count)
    else if (final === 'G' || final === '`') column = count - 1
    else if (final === 'A' || final === 'B' || final === 'e' || final === 'd' || final === 'J') breakLine(column)
    else if (final === 'E' || final === 'F' || final === 'u') breakLine(0)
    else if (final === 'H' || final === 'f') breakLine((second ?? 1) - 1)
    else if (final === 'X' && column < line.length) {
      if (column + count >= line.length) line.length = column
      else if (count <= budget) {
        budget -= count
        line.fill(undefined, column, column + count)
      }
    }
  }
  let index = 0
  while (index < text.length) {
    const code = text.charCodeAt(index)
    if (introducesEscape(code)) {
      const escape = escapeAt(text, index)
      if (escape.short === 'D' || escape.short === 'M' || escape.short === '8') breakLine(column)
      else if (escape.short === 'E' || escape.short === 'c') breakLine(0)
      else if (escape.final !== 'K') moveCursor(escape.final, escape.params ?? '')
      if (escape.final === 'K') {
        const mode = escape.params === '' ? '0' : escape.params
        if (mode === '0') line.length = Math.min(line.length, column)
        else if (mode === '1') {
          for (let cell = blankThrough + 1; cell <= column && cell < line.length; cell++) line[cell] = undefined
          blankThrough = Math.max(blankThrough, column)
        } else if (mode === '2') {
          line = []
          blankThrough = Number.MAX_SAFE_INTEGER
        }
      }
      index = escape.end
      continue
    }
    index++
    if (code === 0x0a) commit()
    else if (code === 0x0b || code === 0x0c || code === 0x84 || code === 0x8d) breakLine(column)
    else if (code === 0x85) breakLine(0)
    else if (code === 0x0d) column = 0
    else if (code === 0x08) column = Math.max(0, column - 1)
    else if (code === 0x09) put('\t')
    else if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) continue
    else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(index) >= 0xdc00 && text.charCodeAt(index) <= 0xdfff) {
      put(text.slice(index - 1, index + 1))
      index++
    } else put(text[index - 1])
  }
  if (line.length > 0 || wrapped !== '') commit()
  return lines
}

/** A long unbroken run of mixed characters with little repetition, as a key's body is; not a hash, path or identifier. */
function isRandomLooking(run: string): boolean {
  const counts = new Map<string, number>()
  let digits = 0
  for (const character of run) {
    counts.set(character, (counts.get(character) ?? 0) + 1)
    if (/[\d+=]/u.test(character)) digits++
  }
  if (digits < RANDOM_RUN_DIGITS || !/[a-z]/u.test(run) || !/[A-Z]/u.test(run)) return false
  let entropy = 0
  for (const count of counts.values()) entropy -= (count / run.length) * Math.log2(count / run.length)
  return entropy >= RANDOM_RUN_ENTROPY
}

function looksRisky(text: string): boolean {
  if (SECRET_FRAGMENT.test(text)) return true
  for (const [run] of text.matchAll(LONG_RUN)) if (isRandomLooking(run)) return true
  return false
}

/** What 「加入对话」 attaches: at most `maxLines` lines and ATTACH_CHARACTER_LIMIT characters, the newest kept. */
export function attachmentText(raw: string, maxLines = ATTACH_LINE_LIMIT): TerminalText {
  // Over every line, before the window to return: a key's armour may lie outside it.
  const { lines: all, redacted: multiline } = redactLineSecrets(plainLines(raw).map(line => line.replace(INVISIBLE, '').trimEnd()))
  let first = 0
  let last = all.length
  while (first < last && all[first] === '') first++
  while (last > first && all[last - 1] === '') last--
  const lines = all.slice(Math.max(first, last - maxLines), last)
  let truncated = last - first > lines.length
  const plain = lines.join('\n')
  // Redacted before the cut to the character limit, so a cut never leaves a secret without the prefix that marks it.
  let text = redactKnownSecrets(plain)
  const redacted = multiline || text !== plain
  if (text.length > ATTACH_CHARACTER_LIMIT) {
    text = text.slice(text.length - ATTACH_CHARACTER_LIMIT)
    const lineStart = text.indexOf('\n')
    if (lineStart >= 0) text = text.slice(lineStart + 1)
    truncated = true
  }
  return {
    text,
    lines: text === '' ? 0 : text.split('\n').length,
    truncated,
    redacted,
    mayContainSecret: redacted || looksRisky(text),
  }
}

/**
 * Raw output that starts mid-stream, from its first whole line. What comes before the first line break may be the tail
 * of a secret whose marking prefix was left behind, and redaction could not recognise it. With no line break: nothing.
 */
export function fromFirstWholeLine(raw: Buffer): Buffer {
  const breaks = [raw.indexOf(0x0a), raw.indexOf(0x0d)].filter(index => index >= 0)
  if (breaks.length === 0) return raw.subarray(raw.length)
  const first = Math.min(...breaks)
  return raw.subarray(raw[first] === 0x0d && raw[first + 1] === 0x0a ? first + 2 : first + 1)
}
