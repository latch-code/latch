export interface TextMatch {
  start: number
  end: number
}
/** Offsets are UTF-16, matching DOM Range and String.slice. */
export function textMatches(text: string, query: string, limit = 500): TextMatch[] {
  const needle = query.toLocaleLowerCase()
  if (!needle) return []
  const source = text.toLocaleLowerCase(),
    matches: TextMatch[] = []
  let from = 0
  while (matches.length < limit) {
    const start = source.indexOf(needle, from)
    if (start < 0) break
    matches.push({ start, end: start + needle.length })
    from = start + needle.length
  }
  return matches
}
