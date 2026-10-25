import type { FileMention } from '@latch/protocol'
export const mentionMarker = (ref: FileMention) => `@${ref.root}:${ref.path}`
export function mentionRange(text: string, ref: FileMention): { start: number; end: number } | undefined {
  const marker = mentionMarker(ref)
  let start = text.indexOf(marker)
  while (start >= 0) {
    const end = start + marker.length
    if ((start === 0 || /\s/u.test(text[start - 1]!)) && (end === text.length || /\s/u.test(text[end]!))) return { start, end }
    start = text.indexOf(marker, start + 1)
  }
  return
}
export const hasFileMention = (text: string, ref: FileMention) => mentionRange(text, ref) !== undefined
