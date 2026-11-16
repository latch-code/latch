/** The colours a terminal's SGR codes name, as content-palette roles; a 256-colour or true-colour value has none. */
type AnsiColour = 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'grey'
export interface AnsiSegment {
  text: string
  colour?: AnsiColour
  bold?: true
  dim?: true
}

const BASIC: Array<AnsiColour | undefined> = ['grey', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', undefined]
/**
 * SGR (`ESC [ … m`), every other CSI, OSC (window titles, links), and every other escape with its intermediate bytes:
 * a character set (`ESC ( B`, which `tput sgr0` writes), a saved cursor (`ESC 7`).
 */
const ESCAPE = /\u001b\[([0-?]*)([ -/]*)([@-~])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[ -/]*[0-~]?|\u009b[0-?]*[ -/]*[@-~]/gu

/** Whether the text holds any terminal escape at all; most output has none and is drawn as it is. */
export const hasAnsi = (text: string) => text.includes('\u001b') || text.includes('\u009b')

/** A line overwritten with a carriage return shows what was written last, as a terminal would. */
function lastWrite(text: string): string {
  if (!text.includes('\r')) return text
  return text
    .split('\n')
    .map(line => {
      const body = line.endsWith('\r') ? line.slice(0, -1) : line
      const cut = body.lastIndexOf('\r')
      return cut < 0 ? body : body.slice(cut + 1)
    })
    .join('\n')
}

/** The text without any escape: what is copied, searched and shown in a one-line tail. */
export function stripAnsi(text: string): string {
  return hasAnsi(text) || text.includes('\r') ? lastWrite(text).replace(ESCAPE, '') : text
}

/**
 * Output as segments with the colour, bold and dim its SGR codes set. Every other escape is dropped, and the segments'
 * texts joined are `stripAnsi(text)`. Backgrounds, 256-colour and true-colour values are ignored: content colours come
 * only from the palette.
 */
export function parseAnsi(text: string): AnsiSegment[] {
  const source = lastWrite(text)
  const segments: AnsiSegment[] = []
  let style: Omit<AnsiSegment, 'text'> = {}
  let from = 0
  const push = (part: string) => {
    if (!part) return
    const last = segments.at(-1)
    if (last && last.colour === style.colour && last.bold === style.bold && last.dim === style.dim) last.text += part
    else segments.push({ text: part, ...style })
  }
  for (const match of source.matchAll(ESCAPE)) {
    push(source.slice(from, match.index))
    from = match.index + match[0].length
    if (match[3] !== 'm' || match[2]) continue
    const codes = (match[1] ?? '').split(';').map(code => (code === '' ? 0 : Number(code)))
    const next = { ...style }
    for (let index = 0; index < codes.length; index++) {
      const code = codes[index]!
      if (code === 0) {
        delete next.colour
        delete next.bold
        delete next.dim
      } else if (code === 1) next.bold = true
      else if (code === 2) next.dim = true
      else if (code === 22) {
        delete next.bold
        delete next.dim
      } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
        const colour = BASIC[code % 10]
        if (colour) next.colour = colour
        else delete next.colour
      } else if (code === 39) delete next.colour
      else if (code === 38 || code === 48) {
        // 5;n or 2;r;g;b: a 256-colour index below 16 is a basic colour, anything else has no palette role.
        const mode = codes[index + 1]
        if (code === 38 && mode === 5) {
          const n = codes[index + 2] ?? -1
          const colour = n >= 0 && n < 16 ? BASIC[n % 8] : undefined
          if (colour) next.colour = colour
          else delete next.colour
        } else if (code === 38) delete next.colour
        index += mode === 5 ? 2 : mode === 2 ? 4 : 0
      }
    }
    style = next
  }
  push(source.slice(from))
  return segments
}
