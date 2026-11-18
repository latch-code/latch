import type { AppSnapshot } from '@latch/protocol'
import { useEffect, useRef } from 'react'
import { ItemWriteLine } from './WriteLine.tsx'
import type { ProposalWrites } from './proposals.ts'

/** A proposal can disappear from the pending list before this device receives its receipt. */
export function ProposalRecovery({
  snapshot,
  writes,
  sessionId,
  onAccepted,
}: {
  snapshot: AppSnapshot
  writes: ProposalWrites
  sessionId?: string
  onAccepted: (itemIds: string[]) => void
}) {
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  if (!snapshot.device.scopes.includes('run')) return null
  const rows = [...writes.states].filter(
    ([id, state]) =>
      state.state === 'unknown'
      && (sessionId === undefined ? !snapshot.workProposals?.some(proposal => proposal.id === id) : state.sessionId === sessionId)
      && snapshot.tasks.some(task => task.id === state.sessionId),
  )
  if (!rows.length) return null
  return (
    <section className="work-board-proposal-recovery" aria-label="待确认的提议">
      {rows.map(([id, state]) => (
        <div key={id} className="work-board-session-proposal">
          <span>提议</span>
          <ItemWriteLine
            state={state}
            onRetry={() => {
              void writes.retry(id).then(result => {
                if (mounted.current && result.ok && result.itemIds?.length) onAccepted(result.itemIds)
              })
            }}
            onDismiss={() => writes.forget(id)}
          />
        </div>
      ))}
    </section>
  )
}
