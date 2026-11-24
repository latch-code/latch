export function featuredCover(id: string) {
  switch (id) {
    case 'shift-handoff':
      return 'document'
    case 'release-review':
      return 'checklist'
    case 'release-check':
      return 'history'
    case 'context-insights':
      return 'context'
  }
}

export const checklistSample = { complete: 2, total: 3 } as const

export const historySample = [
  { key: 'version', state: 'passed' },
  { key: 'changelog', state: 'pending' },
] as const

/** A fixed example from a test session, used in the marketplace without opening a conversation. */
export const contextSample = { request: 4, shares: [55, 42, 2, 1] } as const
