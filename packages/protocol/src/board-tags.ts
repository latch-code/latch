import { containsSecret } from './secrets.ts'
import { BOARD_TAG_CHARS, BOARD_TAG_LIMIT } from './board.ts'

export type BoardTagProblem = 'tag-invalid' | 'tag-secret' | 'tag-limit'

// Controls and line breaks are refused; other invisible characters are dropped.
const TAG_REFUSED = /[\p{Cc}\p{Zl}\p{Zp}]/u
const TAG_INVISIBLE = /[\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}]/gu

/**
 * Free tags as the Host keeps them: each trimmed, NFKC, invisible characters dropped, 1–24 code points, no control
 * characters or line breaks and nothing shaped like a credential; duplicates once; at most eight. Shown only as text.
 */
export function normalizeBoardTags(input: readonly string[]): { tags: string[] } | { problem: BoardTagProblem } {
  const tags: string[] = []
  for (const raw of input) {
    if (TAG_REFUSED.test(raw)) return { problem: 'tag-invalid' }
    const tag = raw.normalize('NFKC').replace(TAG_INVISIBLE, '').trim()
    const length = [...tag].length
    if (!length || length > BOARD_TAG_CHARS || TAG_REFUSED.test(tag)) return { problem: 'tag-invalid' }
    if (containsSecret(tag)) return { problem: 'tag-secret' }
    if (!tags.includes(tag)) tags.push(tag)
  }
  return tags.length > BOARD_TAG_LIMIT ? { problem: 'tag-limit' } : { tags }
}
