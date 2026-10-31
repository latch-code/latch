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
