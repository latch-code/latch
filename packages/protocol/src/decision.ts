import { escapeSecurityText } from './text.ts'

/** The longest note a rejection may carry to the built-in harness, in characters. */
export const REJECTION_NOTE_MAX = 500

/**
 * A rejection's note (「告诉 Agent 改做什么」) as the built-in harness hands it to the model with the rejection: trimmed,
 * line breaks as `\n`, at most 500 characters, and on every line nothing that `escapeSecurityText` would mark
 * (controls, invisible or direction-changing characters). `undefined` for an empty note, `null` for one that breaks the
 * rule. The Host applies it before the decision is recorded; a page can use it to say why before sending.
 */
export function rejectionNote(text: string): string | undefined | null {
  if (typeof text !== 'string') return null
  const note = text.replace(/\r\n?/gu, '\n').trim()
  if (!note) return undefined
  if ([...note].length > REJECTION_NOTE_MAX) return null
  return note.split('\n').every(line => escapeSecurityText(line) === line) ? note : null
}
