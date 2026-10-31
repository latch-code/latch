import { useId } from 'react'
import { ArrowDown } from 'lucide-react'
import type { TaskDetail } from '@latch/protocol'
import { livePhase, phaseText, runElapsed } from '../conversation.ts'
import { hostNow, useTicker } from '../core/hostClock.ts'
import { formatDuration } from '../format.ts'
import { ICON_STROKE, MOTION, Spinner, usePresence } from '@latch/ui'

export interface JumpLive {
  detail: TaskDetail
  harness: string
  cancelling: boolean
  approvals: number
  fallbackElapsed?: number
}

/** While the reader is away from the latest output of a running turn, the pill carries what the turn is doing. */
function LiveStatus({ live, describedBy }: { live: JumpLive; describedBy: string }) {
  useTicker('second')
  const now = hostNow()
  const phase = livePhase(live.detail, { cancelling: live.cancelling, approvals: live.approvals, hostNow: now })
  const elapsedMs = runElapsed(live.detail, now) ?? live.fallbackElapsed
  const elapsed = elapsedMs === undefined ? undefined : formatDuration(elapsedMs, true)
  const words = phaseText(phase, live.harness)
  return (
    <>
      <Spinner size={12} />
      <span className="jump-latest-phase" aria-hidden="true">
        {words}
      </span>
      {elapsed && (
        <span className="jump-latest-time" aria-hidden="true">
          · {elapsed}
        </span>
      )}
      <span id={describedBy} className="sr-only">
        {words}
      </span>
    </>
  )
}

/**
 * 「回到最新」: shown while the reader has scrolled away from the latest output, it rises in (--m-enter) and fades out
 * as the reader arrives. While a turn runs it shows the spinner, the phase and the time so far; waiting for you it
 * is the plain pill, since the bar above the input says so in amber. Its name stays 「回到最新」; the phase describes it.
 */
export function JumpLatest({ show, onJump, live }: { show: boolean; onJump: () => void; live?: JumpLive }) {
  const { present, leaving } = usePresence(show, MOTION.enterExit)
  const statusId = useId()
  if (!present) return null
  const phase = live ? livePhase(live.detail, { cancelling: live.cancelling, approvals: live.approvals, hostNow: hostNow() }) : undefined
  const proxy = live !== undefined && phase?.kind !== 'approval'
  return (
    <button
      type="button"
      className={`jump-latest ${proxy ? 'is-live' : ''}`}
      data-leaving={leaving ? '' : undefined}
      aria-label="回到最新"
      aria-describedby={proxy ? statusId : undefined}
      onClick={onJump}>
      {proxy && live ? (
        <>
          <LiveStatus live={live} describedBy={statusId} />
          <ArrowDown size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
        </>
      ) : (
        <>
          <ArrowDown size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          回到最新
        </>
      )}
    </button>
  )
}
