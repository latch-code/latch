const whitespace = (value: string | undefined) => value === undefined || /\s/u.test(value)
const punctuation = (value: string | undefined) => value !== undefined && /[\p{P}\p{S}]/u.test(value)
const FENCE = /(?:^|\n)[ \t]*(?:(?:[-+*>]|\d{1,9}[.)])[ \t]+)?(?:`{3,}|~{3,})/u

function tableHeader(source: string): string {
  const lines = source.split('\n')
  if (lines.length > 2 || !/^ {0,3}\|/u.test(lines[0]!)) return source
  const separator = lines[1]
  if (separator !== undefined && !/^[|:\-\t ]*$/u.test(separator)) return source
  let result = '',
    code = 0,
    pipes = 0,
    lastPipe = -1
  const header = lines[0]!
  for (let index = 0; index < header.length; index++) {
    const char = header[index]!
    if (char === '\\') {
      result += header.slice(index, index + 2)
      index++
      continue
    }
    if (char === '`') {
      let end = index + 1
      while (header[end] === '`') end++
      const size = end - index
      if (code === size) code = 0
      else if (!code) code = size
      result += header.slice(index, end)
      index = end - 1
    } else if (char === '|' && !code) {
      result += ' '
      pipes++
      lastPipe = index
    } else result += char
  }
  const columns = pipes - (lastPipe === header.trimEnd().length - 1 ? 1 : 0)
  if (
    separator !== undefined
    && /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/u.test(separator)
    && separator
      .trim()
      .replace(/^\||\|$/gu, '')
      .split('|').length === columns
  )
    return source
  return result.trim()
}

function inCode(source: string): boolean {
  let code = 0
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\\' && !code) {
      index++
      continue
    }
    if (source[index] !== '`') continue
    let end = index + 1
    while (source[end] === '`') end++
    const size = end - index
    if (code === size) code = 0
    else if (!code) code = size
    index = end - 1
  }
  return code > 0
}

/**
 * A display-only recovery for the current tail, never the stored or copied source. It does not repair HTML, images,
 * math or fences. Escapes, code spans and link destinations keep their literal characters. Ambiguous delimiters stay
 * literal; the final render always uses the author's unmodified Markdown.
 */
export function closeInline(source: string): string {
  if (FENCE.test(source)) return source
  let text = tableHeader(source)
  // An unfinished URL never becomes a live partial link. Images remain under the existing image policy.
  const destination = text.lastIndexOf('](')
  const opening = destination < 0 ? -1 : text.lastIndexOf('[', destination)
  if (
    opening >= 0
    && !/[!\\]/u.test(text[opening - 1] ?? '')
    && !/[)\n]/u.test(text.slice(destination + 2))
    && !/[\]\n]/u.test(text.slice(opening + 1, destination))
  ) {
    const before = text.slice(0, opening)
    if (!inCode(before)) text = before + text.slice(opening + 1, destination)
  }
  const open: Array<{ char: string; size: number; at: number }> = []
  let code = 0,
    codeAt = -1
  for (let index = 0; index < text.length;) {
    const char = text[index]!
    if (char === '\\' && !code) {
      index += 2
      continue
    }
    if (char === '`') {
      let end = index + 1
      while (text[end] === char) end++
      const size = end - index
      if (code === size) code = 0
      else if (!code) {
        code = size
        codeAt = end
      }
      index = end
      continue
    }
    if (code) {
      index++
      continue
    }
    if (text.slice(index, index + 2) === '](') {
      let depth = 1
      index += 2
      while (index < text.length && depth) {
        if (text[index] === '\\') {
          index += 2
          continue
        }
        if (text[index] === '(') depth++
        if (text[index] === ')') depth--
        index++
      }
      continue
    }
    if (char !== '*' && char !== '_' && char !== '~') {
      index++
      continue
    }
    let end = index + 1
    while (text[end] === char) end++
    let size = end - index
    if (size > 3 || (char === '~' && size !== 2)) {
      index = end
      continue
    }
    const before = text[index - 1],
      after = text[end]
    const left = !whitespace(after) && (!punctuation(after) || whitespace(before) || punctuation(before))
    const right = !whitespace(before) && (!punctuation(before) || whitespace(after) || punctuation(after))
    const canOpen = left && (char !== '_' || !right || punctuation(before))
    const canClose = right && (char !== '_' || !left || punctuation(after))
    if (canClose) {
      while (size && open.at(-1)?.char === char) {
        const last = open.at(-1)!
        const used = Math.min(size, last.size)
        last.size -= used
        size -= used
        if (!last.size) open.pop()
      }
    }
    if (size && canOpen && open.length < 32) open.push({ char, size, at: end })
    // A marker that has just arrived has no content yet; don't flash it before its first word.
    else if (size && end === text.length && (size > 1 || whitespace(before) || punctuation(before))) text = text.slice(0, index)
    index = end
  }
  if (code) {
    const content = text.slice(codeAt)
    if (!content.trim()) return text.slice(0, codeAt - code)
    const trailing = /`+$/u.exec(text)?.[0].length ?? 0
    if (trailing < code) text += '`'.repeat(code - trailing)
  }
  for (const entry of open.toReversed()) if (/[^\s*_~`]/u.test(text.slice(entry.at))) text += entry.char.repeat(entry.size)
  return text
}
