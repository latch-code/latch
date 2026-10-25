import { useState } from 'react'
import type { AppSnapshot } from '@latch/protocol'
import { Button, InlineNotice } from '@latch/ui'
import { errorMessage, isUncertain } from '../core/api.ts'
import { activeFullAccess, namedSession } from '../core/blocking.ts'
import { useSessionLinks } from '../core/sessionLinks.ts'
import { BLOCKED_COPY } from '../core/securityCopy.ts'

type Stop =
  | { phase: 'idle' }
  | { phase: 'stopping'; id: string }
  | { phase: 'requested'; id: string }
  | { phase: 'failed'; message: string; uncertain: boolean }

/**
 * Above the pairing invitation while a full-access session runs or waits for an answer: the Host will refuse the phone's
 * enrollment until it ends, and the phone is only told in general. This names the session here, where pairing starts,
 * in one sentence with 查看会话 (it leaves settings for the session) and 停止会话, the shortest way to pair now. A
 * refused enrollment does not spend the invitation, so the QR below stays valid. The Host decides; this reads the
 * page's snapshot.
 */
export function PairingBlocked({ snapshot }: { snapshot: AppSnapshot }) {
  const links = useSessionLinks()
  const [stop, setStop] = useState<Stop>({ phase: 'idle' })
  const holding = activeFullAccess(snapshot)
  const first = holding[0]
  if (first === undefined) return null
  const requested = stop.phase === 'requested' && stop.id === first.id
  const halt = async () => {
    setStop({ phase: 'stopping', id: first.id })
    try {
      await links?.stop(first.id)
      setStop({ phase: 'requested', id: first.id })
    } catch (cause) {
      setStop({ phase: 'failed', message: errorMessage(cause), uncertain: isUncertain(cause) })
    }
  }
  const view = links ? (
    <Button
      size="xs"
      onClick={() => {
        links.open(first.id)
      }}>
      {BLOCKED_COPY.view}
    </Button>
  ) : null
  return (
    <>
      <InlineNotice
        tone="warn"
        secure
        action={
          <>
            {view}
            {!requested && (
              <Button
                size="xs"
                loading={stop.phase === 'stopping' && stop.id === first.id}
                loadingLabel={BLOCKED_COPY.stopping}
                onClick={() => {
                  void halt()
                }}>
                {BLOCKED_COPY.stop}
              </Button>
            )}
          </>
        }>
        {requested
          ? BLOCKED_COPY.stopRequestedPairing(namedSession(first, snapshot))
          : BLOCKED_COPY.line(
              holding.map(task => namedSession(task, snapshot)),
              'device.enroll',
            )}
      </InlineNotice>
      {stop.phase === 'failed' && <InlineNotice tone={stop.uncertain ? 'neutral' : 'error'}>{stop.message}</InlineNotice>}
    </>
  )
}
