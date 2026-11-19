import type { FileMention } from '@latch/protocol'
export const mentionMarker = (ref: FileMention) => `@${ref.root}:${ref.path}`
/** Where the file's marker stands on its own in the text, between whitespace or the text's ends. */
export function mentionRanges(text: string, ref: FileMention): Array<{ start: number; end: number }> {
  const marker = mentionMarker(ref)
  const ranges: Array<{ start: number; end: number }> = []
  for (let start = text.indexOf(marker); start >= 0; start = text.indexOf(marker, start + 1)) {
    const end = start + marker.length
    if ((start === 0 || /\s/u.test(text[start - 1]!)) && (end === text.length || /\s/u.test(text[end]!))) ranges.push({ start, end })
  }
  return ranges
}
export const mentionRange = (text: string, ref: FileMention) => mentionRanges(text, ref)[0]
export const hasFileMention = (text: string, ref: FileMention) => mentionRange(text, ref) !== undefined
