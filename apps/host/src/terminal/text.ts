// Terminal output as plain text: for 「加入对话」, which hands an agent the selection or the last lines, and for finding
// local services in the output. Escape sequences go, carriage returns and line erases are applied as a terminal shows
// them, and the result passes through redactSecrets before it leaves the Host.
import { redactSecrets } from '@latch/core/node-kit'

/** The most lines one 「加入对话」 takes, from the selection or the end of the output. */
export const ATTACH_LINE_LIMIT = 200
/** And the most characters, keeping the newest. */
export const ATTACH_CHARACTER_LIMIT = 32_000
/** A line wraps here, as a terminal this wide would wrap it: no line, and no cursor column, grows past it. */
export const LINE_CHARACTER_LIMIT = 4096

const ESC = 0x1b
/** C1 introducers: CSI, OSC, and the string controls DCS, SOS, PM and APC. */
const C1_CSI = 0x9b
const C1_OSC = 0x9d
const C1_STRINGS = new Set([0x90, 0x98, 0x9e, 0x9f])
const C1_ST = 0x9c
const BEL = 0x07
/** Format characters (bidirectional controls, zero-width characters) and line separators hide or reorder text; the zero-width joiner of emoji stays. */
const INVISIBLE = /(?!\u200d)[\p{Cf}\u2028\u2029]/gu

interface Escape {
  /** Index just past the sequence. */
  end: number
  /** A control sequence's final character and parameters; undefined for strings and other escapes. */
  final?: string
  params?: string
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
      return { end: Math.min(text.length, cursor + 1) }
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
 * wrapped parts stay one line, so a secret across a wrap is still redacted whole.
 */
export function plainLines(text: string): string[] {
  const lines: string[] = []
  /** The parts of the current line that the cursor model has already wrapped past. */
  let wrapped = ''
  let line: Array<string | undefined> = []
  let column = 0
  /** Every cell up to here is blank, so erasing them again costs nothing. */
  let blankThrough = Number.MAX_SAFE_INTEGER
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
    line[column] = character
    if (column <= blankThrough) blankThrough = column - 1
    column++
  }
  let index = 0
  while (index < text.length) {
    const code = text.charCodeAt(index)
    if (introducesEscape(code)) {
      const escape = escapeAt(text, index)
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

export interface TerminalText {
  text: string
  lines: number
  /** Older lines or characters were left out to stay within the limits. */
  truncated: boolean
  /** redactSecrets replaced something. */
  redacted: boolean
}

/** What 「加入对话」 attaches: at most `maxLines` lines and ATTACH_CHARACTER_LIMIT characters, the newest kept. */
export function attachmentText(raw: string, maxLines = ATTACH_LINE_LIMIT): TerminalText {
  const all = plainLines(raw).map(line => line.replace(INVISIBLE, '').trimEnd())
  let first = 0
  let last = all.length
  while (first < last && all[first] === '') first++
  while (last > first && all[last - 1] === '') last--
  const lines = all.slice(Math.max(first, last - maxLines), last)
  let truncated = last - first > lines.length
  const plain = lines.join('\n')
  // Redacted before the cut to the character limit, so a cut never leaves a secret without the prefix that marks it.
  let text = redactSecrets(plain)
  const redacted = text !== plain
  if (text.length > ATTACH_CHARACTER_LIMIT) {
    text = text.slice(text.length - ATTACH_CHARACTER_LIMIT)
    const lineStart = text.indexOf('\n')
    if (lineStart >= 0) text = text.slice(lineStart + 1)
    truncated = true
  }
  return { text, lines: text === '' ? 0 : text.split('\n').length, truncated, redacted }
}

/** The start of the last `count` lines of raw output, so only those are decoded. */
export function tailOfLines(raw: Buffer, count: number): Buffer {
  let index = raw.length
  // A final line break ends the last line rather than starting an empty one.
  if (raw[index - 1] === 0x0a) index--
  for (let found = 0; found < count; found++) {
    index = raw.lastIndexOf(0x0a, index - 1)
    if (index < 0) return raw
  }
  return raw.subarray(index + 1)
}
