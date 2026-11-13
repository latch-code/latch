/** A source slice with an identity that survives appending to the last block. */
export interface StreamBlock {
  start: number
  text: string
}

// Definitions, HTML, quotes, directives and display math may change the meaning of an earlier block.
const DOCUMENT_CONTEXT = /[\r\uFEFF]|\[\^|\]:|<[A-Za-z!?/]|\\\[|^ {0,3}(?:>|:::|\$\$)|^[ \t]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)+>/mu
const FENCE = /^ {0,3}(`{3,}|~{3,})/u
const CONTINUATION = /^(?:[ \t]|(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$))/u

/**
 * Only freeze a prefix after a blank line and the beginning of an independent next block. A trailing blank line alone
 * proves nothing: the next line may continue a list. Uncertain document-wide syntax uses the unchanged full renderer.
 */
export function splitStreamBlocks(source: string): StreamBlock[] | null {
  if (DOCUMENT_CONTEXT.test(source)) return null
  const blocks: StreamBlock[] = []
  let from = 0,
    offset = 0,
    blank = false
  let fence: { marker: string; indent: number } | undefined
  for (const line of source.split('\n')) {
    const marker = FENCE.exec(line)?.[1]
    if (fence) {
      // Dedenting a container can end its code block; that requires the Markdown parser's container state.
      if (/\S/u.test(line.slice(0, fence.indent))) return null
      if (marker?.[0] === fence.marker[0] && marker.length >= fence.marker.length && line.trim() === marker) fence = undefined
    } else if (line.trim() === '') blank = true
    else {
      if (blank && offset > from && !CONTINUATION.test(line)) {
        blocks.push({ start: from, text: source.slice(from, offset) })
        from = offset
      }
      blank = false
      if (marker) fence = { marker, indent: line.indexOf(marker) }
    }
    offset += line.length + 1
  }
  blocks.push({ start: from, text: source.slice(from) })
  return blocks
}
