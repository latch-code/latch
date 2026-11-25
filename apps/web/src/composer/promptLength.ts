import { SESSION_PROMPT_CHARS } from '@latch/protocol'
import { defineCopy, formatNumber } from '../core/i18n.ts'

const COPY = defineCopy(
  { tooLong: (limit: string) => `消息过长（最多 ${limit} 个字符），请缩短正文或引用。` },
  { tooLong: (limit: string) => `This message is too long (limit ${limit} characters). Shorten the text or a reference.` },
)

export function promptLengthError(draft: string): string | undefined {
  if (draft.trim().length > SESSION_PROMPT_CHARS) return COPY.tooLong(formatNumber(SESSION_PROMPT_CHARS))
}
