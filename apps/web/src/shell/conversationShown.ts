/**
 * Whether the open session's conversation is in front of the person: 对话 shows it, nothing covers it (the start screen,
 * 看板, 设置, the panel's page, a phone's review), and Code is the entry. Reading markers that only a person's look may
 * set (the failed run 「打开过」) follow this value, so a session left open under 看板 is never marked by it.
 */
export function conversationInFront(state: {
  entry: string
  selectedId: string | null
  start: boolean
  board: boolean
  settings: boolean
  panelPage: boolean
  phoneReview: boolean
}): boolean {
  return (
    state.entry === 'sessions'
    && state.selectedId !== null
    && !state.start
    && !state.board
    && !state.settings
    && !state.panelPage
    && !state.phoneReview
  )
}
