import { useRef } from 'react'
import { ArrowDown } from 'lucide-react'
import { ICON_STROKE, MOTION, usePresence } from '@latch/ui'
import { defineCopy, plural } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    latest: '回到最新',
    fresh: (count: number) => plural(count, { other: '{n} 条新内容' }),
    latestWithFresh: (fresh: string) => `回到最新，${fresh}`,
  },
  {
    latest: 'Jump to latest',
    fresh: (count: number) => plural(count, { one: '{n} new item', other: '{n} new items' }),
    latestWithFresh: (fresh: string) => `Jump to latest, ${fresh}`,
  },
)

/**
 * Back to the latest output, while the reader is away from it: a pill centred in a strip of its own right above the
 * input, where the conversation fades out under it. It says what pressing it does, 「回到最新」, or what arrived since the
 * reader left, 「3 条新内容」. When something waits for the person and no card of it is in view, the same pill takes them
 * to it and says so, because nothing else on the screen would.
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
        <ArrowDown size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
      </button>
    )
  }
  const freshCopy = fresh > 0 ? COPY.fresh(fresh) : undefined
  return (
    <button
      type="button"
      className="jump-latest"
      data-leaving={leaving ? '' : undefined}
      aria-label={freshCopy ? COPY.latestWithFresh(freshCopy) : COPY.latest}
      onClick={onJump}>
      <ArrowDown size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
      {freshCopy ?? COPY.latest}
    </button>
  )
}
