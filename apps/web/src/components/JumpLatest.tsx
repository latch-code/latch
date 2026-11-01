import { useRef } from 'react'
import { ArrowDown } from 'lucide-react'
import { ICON_STROKE, MOTION, usePresence } from '@latch/ui'

/**
 * Back to the latest output: a 32px round button while the reader is away from it, with how many blocks have arrived since
 * they left. When something waits for the person and no card of it is in view, the same button takes them to it and
 * says so, because nothing else on the screen would.
 */
export function JumpLatest({
  show,
  onJump,
  blocks = 0,
  waiting,
  onRevealWaiting,
}: {
  show: boolean
  onJump: () => void
  /** Blocks in the conversation now. */
  blocks?: number
  /** What waits for the person while its card is out of view, in words. */
  waiting?: string | undefined
  onRevealWaiting?: () => void
}) {
  const asks = waiting !== undefined && onRevealWaiting !== undefined
  const { present, leaving } = usePresence(show || asks, MOTION.enterExit)
  // How many blocks there were when the reader left, until they come back.
  const left = useRef(blocks)
  if (!show) left.current = blocks
  const fresh = Math.max(0, blocks - left.current)
  if (!present) return null
  if (asks) {
    return (
      <button type="button" className="jump-latest is-waiting" data-leaving={leaving ? '' : undefined} onClick={onRevealWaiting}>
        {waiting}
        <ArrowDown size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
      </button>
    )
  }
  return (
    <button
      type="button"
      className={`jump-latest ${fresh > 0 ? 'has-count' : ''}`}
      data-leaving={leaving ? '' : undefined}
      aria-label={fresh > 0 ? `回到最新，${fresh} 条新内容` : '回到最新'}
      title="回到最新"
      onClick={onJump}>
      <ArrowDown size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
      {fresh > 0 && <span className="jump-latest-count">{fresh}</span>}
    </button>
  )
}
