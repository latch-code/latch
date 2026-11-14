/** New text is shown within this long of arriving: between the 120 ms that reads as instant and the 300 ms that reads as slow. */
export const REVEAL_MS = 180
/** Further behind than this (about a screen of text), the page shows everything at once instead of pacing it. */
export const CATCH_UP_CHARS = 1200
/** A frame that came late (a busy page, a throttled tab) counts as this long at most, so the reveal never lurches. */
const MAX_FRAME_MS = 50

/** How fast to show what is waiting, in characters per millisecond; `undefined` when it should all show now. */
export function revealRate(shown: number, target: number): number | undefined {
  const waiting = target - shown
  return waiting <= 0 || waiting > CATCH_UP_CHARS ? undefined : waiting / REVEAL_MS
}

/** How many characters are shown after a frame `elapsed` milliseconds long: at least one more, never past the target. */
export function revealStep(shown: number, target: number, rate: number, elapsed: number): number {
  return Math.min(target, shown + Math.max(1, Math.round(rate * Math.min(Math.max(elapsed, 0), MAX_FRAME_MS))))
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/u

/**
 * Whether each prefix of a growing text ends inside an unfinished code fence, read line by line as the text arrives and
 * never from its start again. Approximate on purpose: a fence inside a list or a quote is not seen, and such code is
 * then revealed by character like prose.
 */
export class FenceTracker {
  private scanned = 0
  private open: string | undefined
  private text = ''

  /** Whether `text.slice(0, upTo)` ends inside a fence; `upTo` only grows while `text` only grows. */
  inside(text: string, upTo: number): boolean {
    if (text.length < this.text.length || upTo < this.scanned || (this.scanned > 0 && text.charCodeAt(this.scanned - 1) !== 10)) {
      this.scanned = 0
      this.open = undefined
    }
    this.text = text
    for (;;) {
      const end = text.indexOf('\n', this.scanned)
      if (end < 0 || end >= upTo) break
      const marker = FENCE.exec(text.slice(this.scanned, end))?.[1]
      if (marker) {
        if (this.open === undefined) this.open = marker
        else if (marker[0] === this.open[0] && marker.length >= this.open.length && text.slice(this.scanned, end).trim() === marker)
          this.open = undefined
      }
      this.scanned = end + 1
    }
    return this.open !== undefined
  }
}

/**
 * Where a reveal of `shown` characters stops: never between the halves of a surrogate pair, and inside an unfinished
 * code fence at the end of the last whole line, so code appears a line at a time.
 */
export function revealCut(text: string, shown: number, fence: FenceTracker): number {
  if (shown >= text.length) return text.length
  let cut = shown
  const last = text.charCodeAt(cut - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut++
  if (cut < text.length && fence.inside(text, cut)) {
    const line = text.lastIndexOf('\n', cut - 1) + 1
    if (line > 0) cut = line
  }
  return cut
}
