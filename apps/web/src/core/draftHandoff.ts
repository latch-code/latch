/**
 * Text another surface hands to a session's composer draft (交回 Agent from 设置 › 插件): kept in this tab's memory until
 * that session is opened, then appended to its draft. Nothing is ever sent from here.
 */
const handed = new Map<string, string>()
const MAX_CHARACTERS = 64_000

export function handDraft(sessionId: string, text: string): void {
  const previous = handed.get(sessionId)
  handed.set(sessionId, (previous ? `${previous}\n\n${text}` : text).slice(0, MAX_CHARACTERS))
  while (handed.size > 8) handed.delete(handed.keys().next().value!)
}

/** The text handed to this session, once; undefined when there is none. */
export function takeHandedDraft(sessionId: string): string | undefined {
  const text = handed.get(sessionId)
  handed.delete(sessionId)
  return text
}

export function joinDraft(draft: string, text: string | undefined): string {
  if (!text) return draft
  return draft.trim() ? `${draft}\n\n${text}` : text
}
