import { createContext } from 'react'

/**
 * What this device may do with a turn's changes. `mac-only`: an agent's session from another device, whose undo the Host
 * takes only from this computer. `read-only`: no way to run anything here.
 */
export interface TurnSummaryOptionsValue {
  undo: 'open' | 'mac-only' | 'read-only'
  /** Reads the session's records and lists again: an undo changes what every turn can do. */
  refresh: () => void
}

export const TurnSummaryOptions = createContext<TurnSummaryOptionsValue>({ undo: 'open', refresh: () => {} })
