import type { Message } from '@latch/protocol'
import { shownToolOutput } from '../conversation.ts'
import { textMatches } from '../textSearch.ts'
import { escapeHiddenCharacters } from './VisibleText.tsx'

export interface OutputMatch {
  messageId: string
  outputIndex: number
}

/** Search the authorized output already in memory without mounting every lazy tool body. */
export function lazyOutputMatches(messages: readonly Message[], query: string, limit = 500): OutputMatch[] {
  const found: OutputMatch[] = []
  for (const message of messages) {
    if (found.length >= limit) break
    if (message.role !== 'tool' || message.state === 'awaiting-approval' || message.state === 'queued') continue
    const matches = textMatches(escapeHiddenCharacters(shownToolOutput(message)), query, limit - found.length)
    for (let index = 0; index < matches.length; index++) found.push({ messageId: message.id, outputIndex: index })
  }
  return found
}

/** VisibleText and syntax tokens can split a match across text nodes; offsets still refer to the displayed UTF-16 string. */
function matchRange(element: Element, match: { start: number; end: number }): Range | undefined {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let offset = 0,
    started = false
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0
    if (!started && match.start < offset + length) {
      range.setStart(node, match.start - offset)
      started = true
    }
    if (started && match.end <= offset + length) {
      range.setEnd(node, match.end - offset)
      return range
    }
    offset += length
  }
}

export function outputRange(output: Element, query: string, index: number): Range | undefined {
  const match = textMatches(output.textContent ?? '', query)[index]
  return match && matchRange(output, match)
}

/** Every match in the element's text, whether or not its text is split into tokens yet. */
export function elementRanges(element: Element, query: string, limit: number): Range[] {
  return textMatches(element.textContent ?? '', query, limit).flatMap(match => {
    const range = matchRange(element, match)
    return range ? [range] : []
  })
}

/**
 * Names a match by where it is in its row, so a rescan can tell it from one that moved into its ordinal. Text comes
 * before tool output in a row, and each only ever grows at its end.
 */
export function withMatchKeys<T extends { messageId: string; outputIndex?: number }>(matches: readonly T[]): Array<T & { key: string }> {
  const seen = new Map<string, number>()
  return matches.map(match => {
    if (match.outputIndex !== undefined) return { ...match, key: `${match.messageId}:output:${String(match.outputIndex)}` }
    const occurrence = seen.get(match.messageId) ?? 0
    seen.set(match.messageId, occurrence + 1)
    return { ...match, key: `${match.messageId}:text:${String(occurrence)}` }
  })
}

/** Where the match the reader is on went in a rescan; if it is gone, the nearest place to where it was. */
export function carriedIndex(current: string | undefined, matches: ReadonlyArray<{ key: string }>, index: number): number {
  const at = matches.findIndex(match => match.key === current)
  return at >= 0 ? at : Math.min(index, Math.max(0, matches.length - 1))
}

/** The bar and the composer's edge cover the pane's ends: a match within them is moved to a third of the way down. */
const MATCH_TOP = 60
const MATCH_BOTTOM = 48

/**
 * How far the conversation's content must come down for a match to show: near its top no scrolling can bring the match
 * out from under the bar. `given` is what the content has come down already.
 */
export function findClearance(
  match: Pick<DOMRect, 'top' | 'left' | 'right' | 'height'>,
  bar: Pick<DOMRect, 'left' | 'right'>,
  pane: Pick<DOMRect, 'top'> & { scrollTop: number },
  given: number,
): number {
  if (match.height === 0 || match.right <= bar.left || match.left >= bar.right) return 0
  return Math.max(0, MATCH_TOP - (match.top - pane.top + pane.scrollTop - given))
}

/** Whether a match needs moving to be read, and where its row's top then goes relative to the pane. */
export function matchPlacement(
  match: Pick<DOMRect, 'top' | 'bottom' | 'height'>,
  row: Pick<DOMRect, 'top'>,
  pane: Pick<DOMRect, 'top' | 'bottom' | 'height'>,
): { move: boolean; offset: number } {
  const offset = pane.height / 3 - (match.top - row.top)
  // A match with no box is inside something still opening; its row is what can be shown yet.
  if (match.height === 0) return { move: true, offset: Math.min(offset, pane.height / 3) }
  return { move: match.top < pane.top + MATCH_TOP || match.bottom > pane.bottom - MATCH_BOTTOM, offset }
}
