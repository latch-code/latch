// Whether the shell's line editor takes a bracketed paste (DECSET 2004), read from what the terminal printed. zsh,
// bash 5.1+ and fish turn it on while they wait at the prompt and off before they run the line, so it also says the
// shell is the one reading input. A command typed in for the person is only ever sent as a bracketed paste, and only
// while this is on: a line break inside it is then text, never Enter.

/** A mode change or a reset, as far as this reads them; anything else leaves the mode as it was. */
const SEQUENCE = /\x1b(?:\[\?([0-9;]*)([hl])|c)/gu
/** The start of a sequence cut at the chunk's end: kept for the next chunk. */
const PARTIAL = /\x1b(?:\[(?:\?[0-9;]*)?)?$/u
/** A cut sequence longer than this is not one this reads; it also bounds the work at each chunk's end. */
const CARRY_LIMIT = 32

export class PasteMode {
  on = false
  /** How many times it came on: each time the shell reached its prompt again. */
  count = 0
  private carry = ''

  /** Reads a chunk of output; true when the mode changed or the shell reached its prompt again. */
  push(chunk: Buffer): boolean {
    // latin1 keeps one character per byte, so a split UTF-8 sequence never hides an escape.
    const text = this.carry + chunk.toString('latin1')
    const before = { on: this.on, count: this.count }
    let end = 0
    for (const match of text.matchAll(SEQUENCE)) {
      end = match.index + match[0].length
      const on = match[0] === '\x1bc' ? false : match[1]!.split(';').includes('2004') ? match[2] === 'h' : this.on
      // Off and on again within one chunk (a quick command) is a new prompt all the same.
      if (on && !this.on) this.count++
      this.on = on
    }
    this.carry = PARTIAL.exec(text.slice(Math.max(end, text.length - CARRY_LIMIT)))?.[0] ?? ''
    return this.on !== before.on || this.count !== before.count
  }

  /** The shell ended. */
  clear(): void {
    this.on = false
    this.carry = ''
  }
}
