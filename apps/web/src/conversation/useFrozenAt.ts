import { useState } from 'react'
import type { ConnectionStatus } from '../core/useHarness.ts'

/** While the connection is down, when it was last known to be up; undefined while it is up. Nothing live is claimed past it. */
export function useFrozenAt(connection: ConnectionStatus): number | undefined {
  const down = connection === 'reconnecting' || connection === 'offline'
  const [frozenAt, setFrozenAt] = useState<number | undefined>(undefined)
  if (down && frozenAt === undefined) setFrozenAt(Date.now())
  if (!down && frozenAt !== undefined) setFrozenAt(undefined)
  return down ? (frozenAt ?? undefined) : undefined
}
