/** Pinyin initials from the platform's Chinese collation; no full-transliteration dictionary. */
const INITIALS = [
  ['a', '阿'],
  ['b', '八'],
  ['c', '嚓'],
  ['d', '哒'],
  ['e', '妸'],
  ['f', '发'],
  ['g', '旮'],
  ['h', '哈'],
  ['j', '讥'],
  ['k', '咔'],
  ['l', '垃'],
  ['m', '妈'],
  ['n', '拿'],
  ['o', '噢'],
  ['p', '啪'],
  ['q', '期'],
  ['r', '然'],
  ['s', '撒'],
  ['t', '塌'],
  ['w', '挖'],
  ['x', '昔'],
  ['y', '压'],
  ['z', '匝'],
] as const
const collator = new Intl.Collator('zh-CN')

export function pinyinInitials(text: string): string {
  if (!collator.resolvedOptions().locale.startsWith('zh')) return ''
  return Array.from(text)
    .map(character => {
      if (!/\p{Unified_Ideograph}/u.test(character)) return character.toLowerCase()
      let lower = 0
      let upper: number = INITIALS.length
      while (lower < upper) {
        const middle = Math.floor((lower + upper) / 2)
        if (collator.compare(character, INITIALS[middle]![1]) >= 0) lower = middle + 1
        else upper = middle
      }
      return INITIALS[Math.max(0, lower - 1)]![0]
    })
    .join('')
}

export interface SlashMatch {
  score: number
  /** UTF-16 positions in the visible name, suitable for slicing React text. */
  positions: number[]
}

function span(start: number, length: number): number[] {
  return Array.from({ length }, (_, index) => start + index)
}

/** Lower scores win; ties retain source/discovery order. Description is a last-resort match. */
export function matchSlash(name: string, query: string, description = ''): SlashMatch | undefined {
  const value = name.toLowerCase()
  const needle = query.toLowerCase()
  if (!needle) return { score: 0, positions: [] }
  if (value === needle) return { score: 0, positions: span(0, needle.length) }
  if (value.startsWith(needle)) return { score: 1, positions: span(0, needle.length) }
  for (const word of value.matchAll(/[^\s\-_:/.]+/gu))
    if (word[0].startsWith(needle)) return { score: 2, positions: span(word.index, needle.length) }
  if (/^[a-z]+$/u.test(needle) && /\p{Unified_Ideograph}/u.test(name) && pinyinInitials(name).startsWith(needle))
    return { score: 3, positions: [] }
  const within = value.indexOf(needle)
  if (within >= 0) return { score: 4, positions: span(within, needle.length) }
  const positions: number[] = []
  let from = 0
  for (const letter of needle) {
    const index = value.indexOf(letter, from)
    if (index < 0) break
    positions.push(...span(index, letter.length))
    from = index + letter.length
  }
  if (positions.length === needle.length) return { score: 5, positions }
  if (description.toLowerCase().includes(needle)) return { score: 6, positions: [] }
  return undefined
}

/** The slash word at the caret; a filesystem path is never a command query. */
export function slashToken(
  draft: string,
  caret = draft.length,
): { query: string; start: number; end: number; initial: boolean } | undefined {
  const before = draft.slice(0, caret)
  const matched = /(?:^|\s)([/／])([^\s/／]*)$/u.exec(before)
  if (!matched) return undefined
  const start = caret - matched[2]!.length - 1
  if (caret < draft.length && /[^\s]/u.test(draft[caret]!)) return undefined
  return { query: matched[2]!.toLowerCase(), start, end: caret, initial: start === 0 }
}
