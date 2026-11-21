// Secrets that redactSecrets, made for single log lines, cannot see in terminal text: a private key's body and a key a
// program wrapped across lines. Lines that hold one are replaced whole. Best effort, by shape: the client shows the exact
// text before it is attached.
import { redactSecrets } from '@latch/core/node-kit'

const REPLACEMENT = '[redacted]'
const BEGIN_ARMOUR = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/u
const END_ARMOUR = /-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/u
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u
/** The headers of an encrypted key or a PGP block, before its body. */
const KEY_HEADER = /^[A-Za-z][A-Za-z-]*: /u
/** How many wrapped rows are joined to look for a key. Once one is found, its remaining rows go too. */
const ROWS_JOINED = 8
/** A key's tail after a whole key is told from a word by these. */
const TAIL_WIDTH = 8
/** Box-drawing borders around a row, besides white space. */
const FRAME = new Set(['│', '┃', '║', '╎', '┆', '|'])

function isFrame(character: string | undefined): boolean {
  return character !== undefined && (character.trim() === '' || FRAME.has(character))
}

/** The row without its borders. A loop, since a trimming regex is quadratic on long runs of spaces. */
function content(line: string): string {
  let start = 0
  let end = line.length
  while (start < end && isFrame(line[start])) start++
  while (end > start && isFrame(line[end - 1])) end--
  return line.slice(start, end)
}

function isKeyCharacter(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39)
    || (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || code === 0x2d
    || code === 0x2e
    || code === 0x5f
  )
}

function trailingToken(text: string): string {
  let start = text.length
  while (start > 0 && isKeyCharacter(text.charCodeAt(start - 1))) start--
  return text.slice(start)
}

function leadingToken(text: string): string {
  let end = 0
  while (end < text.length && isKeyCharacter(text.charCodeAt(end))) end++
  return text.slice(0, end)
}

function holdsSecret(text: string): boolean {
  return redactSecrets(text) !== text
}

/** A row of a key's body, however narrow a pane wrapped it. A word in lower case is left alone. */
function isBodyRow(text: string): boolean {
  return text.length >= 4 && BASE64.test(text) && /[A-Z\d+/=]/u.test(text)
}

/**
 * A key from BEGIN through END. A block ends early at the first row no key would hold, so one mention of the armour
 * costs that line and not the output after it. From END back over the body when a cut took BEGIN.
 */
function markPrivateKeys(lines: readonly string[], marks: boolean[]): void {
  for (let index = 0; index < lines.length; index++) {
    if (BEGIN_ARMOUR.test(lines[index])) {
      marks[index] = true
      let body = false
      for (let row = index + 1; row < lines.length; row++) {
        const text = content(lines[row])
        const header: boolean = !body && (text === '' || KEY_HEADER.test(text))
        if (!header && !END_ARMOUR.test(lines[row]) && !isBodyRow(text)) break
        marks[row] = true
        index = row
        if (END_ARMOUR.test(lines[row])) break
        body ||= !header
      }
    } else if (END_ARMOUR.test(lines[index])) {
      marks[index] = true
      for (let row = index - 1; row >= 0 && !marks[row] && isBodyRow(content(lines[row])); row--) marks[row] = true
    }
  }
}

/**
 * The rows after `index` that may continue its last token. Wrapped rows are as wide as the second one, but for the last;
 * the first may be indented or share its line.
 */
function continuation(rows: readonly string[], index: number, limit: number): number[] {
  const first = rows[index + 1]?.length ?? 0
  const found: number[] = []
  for (let row = index + 1; row < rows.length && found.length < limit; row++) {
    if (leadingToken(rows[row]) === '') break
    found.push(row)
    if (rows[row].length !== first) break
  }
  return found
}

/** What starts a row could be a key's tail, as opposed to a word. */
function isTail(row: string, width: number): boolean {
  const token = leadingToken(row)
  return token.length >= width && /[A-Z\d]/u.test(token)
}

/** Keys that appear once line breaks are gone. A key already whole on its first row still loses the rows of its tail. */
function markWrappedKeys(rows: readonly string[], marks: boolean[]): void {
  for (let index = 0; index < rows.length; index++) {
    const token = marks[index] ? '' : trailingToken(rows[index])
    if (token === '') continue
    const joined = continuation(rows, index, ROWS_JOINED)
    if (joined.length === 0) continue
    if (!holdsSecret(token + joined.map(row => leadingToken(rows[row])).join(''))) continue
    const all = continuation(rows, index, rows.length)
    if (holdsSecret(token)) {
      for (const row of all) {
        if (!isTail(rows[row], TAIL_WIDTH)) break
        marks[row] = true
      }
    } else {
      marks[index] = true
      const width = rows[index + 1].length
      for (const row of all) if (row === index + 1 || rows[row].length === width || isTail(rows[row], 1)) marks[row] = true
    }
    // These rows are done with, so a long run of them costs one pass.
    index = (all.at(-1) ?? index + 1) - 1
  }
}

/** `lines` with those holding a multi-line secret replaced, one replacement per run. */
export function redactLineSecrets(lines: readonly string[]): { lines: string[]; redacted: boolean } {
  const marks = lines.map(() => false)
  const rows = lines.map(content)
  markPrivateKeys(lines, marks)
  markWrappedKeys(rows, marks)
  const kept = lines.flatMap((line, index) => (!marks[index] ? [line] : marks[index - 1] ? [] : [REPLACEMENT]))
  return { lines: kept, redacted: marks.includes(true) }
}
