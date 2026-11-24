interface TextPart {
  kind: 'text' | 'code'
  text: string
  /** UTF-16 offset in the original message. */
  from: number
}

/** A line of at least three backticks opens a fence. Only a line of at least as many backticks closes it. */
export function fencedParts(text: string): TextPart[] {
  const lines = text.split('\n')
  let offset = 0
  const starts = lines.map(line => {
    const from = offset
    offset += line.length + 1
    return from
  })
  const parts: TextPart[] = []
  let plainStart = 0
  for (let index = 0; index < lines.length; index++) {
    const fence = /^(`{3,})[^`]*$/u.exec(lines[index]!)?.[1]
    if (!fence) continue
    let close = index + 1
    for (; close < lines.length; close++) {
      const end = lines[close]!.trimEnd()
      if (end.length >= fence.length && /^`+$/u.test(end)) break
    }
    if (close === lines.length) continue
    if (plainStart < index) parts.push({ kind: 'text', text: lines.slice(plainStart, index).join('\n'), from: starts[plainStart]! })
    parts.push({ kind: 'code', text: lines.slice(index + 1, close).join('\n'), from: starts[index + 1]! })
    plainStart = close + 1
    index = close
  }
  if (plainStart < lines.length) parts.push({ kind: 'text', text: lines.slice(plainStart).join('\n'), from: starts[plainStart]! })
  return parts
}
