import { escapeSecurityText } from '../../shared/text.ts'

/**
 * Text in approvals and tool views follows the same rule as the Host's local confirmation preview
 * (`escapeSecurityText`): controls, format and bidirectional characters, line and paragraph separators,
 * default-ignorable code points and combining marks beyond four in a row are shown as `\u{XXXX}`, while emoji
 * joiners inside an emoji stay. Rendered as they are those characters can hide text or reorder what is shown, so the
 * text reviewed would differ from the bytes used. Tab, LF and CRLF stay as layout.
 */
const LAYOUT = /\r\n|\n|\t/g

type Segment = { text: string; hidden: boolean }

const codePoint = (character: string) => character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')
const marker = (character: string) => `\\u{${codePoint(character)}}`

/** Each hidden code point becomes its own segment; escapeSecurityText decides which ones are hidden. */
function escapedSegments(text: string, out: Segment[]): void {
  const plain = (value: string) => {
    const last = out.at(-1)
    if (last && !last.hidden) last.text += value
    else out.push({ text: value, hidden: false })
  }
  if (text === '') return
  const escaped = escapeSecurityText(text)
  if (escaped === text) { plain(text); return }
  let at = 0
  for (const point of text) {
    // An escaped code point never starts with itself: its marker begins with a backslash, which is never escaped.
    if (escaped.startsWith(point, at)) { plain(point); at += point.length; continue }
    const shown = marker(point)
    if (!escaped.startsWith(shown, at)) {
      // Not expected; the escaped text still holds no raw hidden character, only without per-character marks.
      plain(escaped.slice(at))
      return
    }
    out.push({ text: point, hidden: true })
    at += shown.length
  }
}

function segments(text: string): Segment[] {
  const out: Segment[] = []
  let last = 0
  for (const match of text.matchAll(LAYOUT)) {
    escapedSegments(text.slice(last, match.index), out)
    out.push({ text: match[0], hidden: false })
    last = match.index + match[0].length
  }
  escapedSegments(text.slice(last), out)
  return out
}

/** Whether the text contains a character that `VisibleText` marks. */
export function hasHiddenCharacters(text: string | undefined): boolean {
  return text ? text.split(LAYOUT).some(piece => escapeSecurityText(piece) !== piece) : false
}

/** Plain-string form for attributes such as `title`, with the Host preview's `\u{XXXX}`. */
export function escapeHiddenCharacters(text: string): string {
  return text.split(/(\r\n|\n|\t)/).map((piece, index) => index % 2 === 1 ? piece : escapeSecurityText(piece)).join('')
}

/** Text with every hidden character shown as a highlighted `\u{XXXX}`; the raw character never reaches the DOM. */
export function VisibleText({ text }: { text: string }) {
  const parts = segments(text)
  if (!parts.some(segment => segment.hidden)) return <>{parts.map(segment => segment.text).join('')}</>
  return <>{parts.map((segment, index) => {
    if (!segment.hidden) return segment.text
    const code = codePoint(segment.text)
    return <span key={index} className="hidden-char" title={`不可见或改变显示方向的字符 U+${code}`}>{`\\u{${code}}`}</span>
  })}</>
}
