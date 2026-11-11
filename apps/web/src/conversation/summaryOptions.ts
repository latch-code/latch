import { createContext } from 'react'

/** What this device may do with a turn's changes. `read-only`: no way to run anything here. */
export interface TurnSummaryOptionsValue {
  undo: 'open' | 'read-only'
  /** No connection to the Host: nothing can be written, as the 改动 tab says too. */
  offline?: boolean
  /** Reads the session's records and lists again: an undo changes what every turn can do. */
  refresh: () => void
}

export const TurnSummaryOptions = createContext<TurnSummaryOptionsValue>({ undo: 'open', refresh: () => {} })
