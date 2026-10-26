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

/** VisibleText can split a match across text nodes; offsets still refer to the displayed UTF-16 string. */
export function outputRange(output: Element, query: string, index: number): Range | undefined {
  const match = textMatches(output.textContent ?? '', query)[index]
  if (!match) return
  const walker = document.createTreeWalker(output, NodeFilter.SHOW_TEXT)
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
