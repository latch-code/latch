import { useEffect, useState } from 'react'
import type { BlockingTask, WaitingEnrollmentView } from '@latch/protocol'
import { api, ApiError } from '../core/api.ts'
import { PAIRING_WAITING_COPY as COPY } from '../core/securityCopy.ts'
import { VisibleText } from '../components/VisibleText.tsx'

const POLL_MS = 1000

interface Listing {
  enrollments: WaitingEnrollmentView[]
  blockingTasks: BlockingTask[]
}

/**
 * In the desktop's pairing panel: each device waiting to be enrolled, by a pairing invitation or from this computer's
 * browser, with the fingerprint the new device shows from its own key and the system sheet names in its sentence, so
 * the two can be compared side by side before Touch ID; and, while a full-access session runs, which one a new pairing
 * waits for. The Host lists them only to the desktop's admins (`GET /link/api/enrollments`); an older Host without the
 * list shows nothing here.
 */
export function WaitingEnrollments() {
  const [listing, setListing] = useState<Listing | null>(null)
  useEffect(() => {
    let active = true
    let timer: number | undefined
    const load = async () => {
      try {
        const answer = await api<Partial<Listing>>('enrollments')
        if (!active) return
        setListing({
          enrollments: Array.isArray(answer.enrollments) ? answer.enrollments : [],
          blockingTasks: Array.isArray(answer.blockingTasks) ? answer.blockingTasks : [],
        })
      } catch (cause) {
        // An older Host has no list: stop asking. Anything else is retried on the next tick.
        if (cause instanceof ApiError && cause.status === 404) clearInterval(timer)
      }
    }
    void load()
    timer = window.setInterval(() => {
      void load()
    }, POLL_MS)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [])
  if (listing === null) return null
  const waiting = listing.enrollments
  return (
    <>
      {waiting.map(item => (
        <div key={item.id} className="pair-waiting" role="status">
          <p className="pair-waiting-title">
            「<VisibleText text={item.name} />」{COPY.requesting}
          </p>
          <span className="fingerprint-label">{COPY.fingerprint}</span>
          <code className="fingerprint" aria-label={`${COPY.fingerprint} ${item.fingerprint}`}>
            {item.fingerprint
              .split(' ')
              .flatMap((group, index) => (index === 0 ? [<span key={index}>{group}</span>] : [' ', <span key={index}>{group}</span>]))}
          </code>
          <p className="pair-waiting-note">
            {item.status === 'approved'
              ? COPY.signing
              : item.listener === 'native-direct' || item.listener === 'native-relay'
                ? COPY.nativeCompare
                : COPY.compare}
          </p>
        </div>
      ))}
    </>
  )
}
