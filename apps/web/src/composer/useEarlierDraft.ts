import { useState } from 'react'

interface EarlierDraft {
  ids: readonly string[]
  held: boolean
}

/**
 * Whether the input's text was written before a request arrived. Such text was meant as the next message, so it is never
 * taken as the answer to something that appeared just before Enter. It stays held until the input is empty or the
 * person says otherwise, and paging through requests already waiting is not an arrival.
 */
export function holdEarlierDraft(previous: EarlierDraft, ids: readonly string[], draft: string): EarlierDraft {
  if (!draft.trim() || ids.length === 0) return { ids, held: false }
  return { ids, held: previous.held || ids.some(id => !previous.ids.includes(id)) }
}

export function useEarlierDraft(ids: readonly string[], draft: string): { held: boolean; release: () => void } {
  const [state, setState] = useState<EarlierDraft>({ ids: [], held: false })
  const next = holdEarlierDraft(state, ids, draft)
  if (next.held !== state.held || next.ids.join() !== state.ids.join()) setState(next)
  return {
    held: next.held,
    release: () => {
      setState(previous => ({ ...previous, held: false }))
    },
  }
}
