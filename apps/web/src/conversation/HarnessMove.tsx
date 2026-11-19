import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { HarnessInfo, TaskDetail, TaskSummary } from '@latch/protocol'
import { ArrowRight, ArrowRightLeft } from 'lucide-react'
import { Icon } from '@latch/ui'
import { api } from '../core/api.ts'
import { defineCopy } from '../core/i18n.ts'
import { HarnessTile } from '../components/BrandTile.tsx'
import { Transcript } from '../components/Transcript.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { harnessName } from '../core/harnessName.ts'

const COPY = defineCopy(
  {
    moved: '换了 Harness',
    pending: '下一条消息起换过去',
    carried: (turns: number) => `带着前 ${turns} 轮的记录`,
    said: (from: string, to: string) => `从 ${from} 换到 ${to}`,
    gone: '之前的记录已不在这台电脑上',
    cancel: '取消',
  },
  {
    moved: 'Harness changed',
    pending: 'Moves with the next message',
    carried: (turns: number) => (turns === 1 ? 'With the record of 1 turn' : `With the record of ${turns} turns`),
    said: (from: string, to: string) => `From ${from} to ${to}`,
    gone: 'The earlier record is no longer on this computer',
    cancel: 'Cancel',
  },
)

const MAX_MOVES = 8

interface Side {
  name: string
  harness?: HarnessInfo | undefined
}

/** The Harness a conversation left, as this computer lists it now; one no longer listed is said by its ID. */
function movedSide(harnesses: readonly HarnessInfo[] | undefined, id: string): Side {
  const harness = harnesses?.find(item => item.id === id)
  return harness ? { name: harnessName(harness), harness } : { name: id }
}

/**
 * Where a conversation went on with another Harness, as a passing from one to the other: the Harness it left on the
 * left, the one that took over on the right, and a short track between them along which three marks travel left to
 * right (the record going across). The marks travel while the move is `pending` (chosen, not sent yet) and once when
 * the line first appears; after that, and with reduced motion, they stand still along the track.
 */
export function MoveLine({
  from,
  to,
  turns,
  pending,
  onCancel,
}: {
  from: Side
  to: Side
  /** How many turns of the conversation went across. */
  turns?: number | undefined
  pending?: boolean
  onCancel?: () => void
}) {
  return (
    <div className="move-line" role="separator" data-pending={pending ? '' : undefined} aria-label={COPY.said(from.name, to.name)}>
      <div className="move-card">
        <span className="move-side">
          {from.harness ? <HarnessTile harness={from.harness} size={20} /> : <Icon icon={ArrowRightLeft} size={14} />}
          <span className="move-name">
            <VisibleText text={from.name} />
          </span>
        </span>
        <span className="move-track" aria-hidden="true">
          <span className="move-dot" />
          <span className="move-dot" />
          <span className="move-dot" />
          <Icon icon={ArrowRight} size={12} className="move-arrow" />
        </span>
        <span className="move-side is-next">
          {to.harness && <HarnessTile harness={to.harness} size={20} />}
          <span className="move-name">
            <VisibleText text={to.name} />
          </span>
        </span>
      </div>
      <p className="move-note">
        {pending ? COPY.pending : turns ? COPY.carried(turns) : COPY.moved}
        {pending && onCancel && (
          <button type="button" className="move-cancel" onClick={onCancel}>
            {COPY.cancel}
          </button>
        )}
      </p>
    </div>
  )
}

/**
 * What was said before the conversation moved, above the line: the session the conversation left, read from the Host and drawn as
 * it stands there, read only (no stop, no retry, no fork from it here). A source that is gone leaves the line and one
 * muted sentence; the new session's first message still carries its record.
 */
export function MoveHistory({
  fork,
  harnesses,
  to,
  depth = 0,
  pending,
  onCancel,
}: {
  fork: Pick<NonNullable<TaskSummary['forkOf']>, 'taskId' | 'moved'> & { turn?: number }
  harnesses: readonly HarnessInfo[] | undefined
  to: Side
  /** Chosen and not sent yet: the line under what was said says so, and offers the way back. */
  pending?: boolean
  onCancel?: () => void
  /** How many moves back this is: a conversation that moved many times shows the last few. */
  depth?: number
}) {
  const from = movedSide(harnesses, fork.moved?.from ?? '')
  const [source, setSource] = useState<{ id: string; detail: TaskDetail | null }>()
  useEffect(() => {
    const controller = new AbortController()
    api<TaskDetail>(`tasks/${encodeURIComponent(fork.taskId)}`, { signal: controller.signal })
      .then(detail => {
        if (!controller.signal.aborted) setSource({ id: fork.taskId, detail })
      })
      .catch(() => {
        if (!controller.signal.aborted) setSource({ id: fork.taskId, detail: null })
      })
    return () => controller.abort()
  }, [fork.taskId])
  const detail = source?.id === fork.taskId ? source.detail : undefined
  const earlier = detail?.summary.forkOf
  return (
    <>
      {detail ? (
        <>
          {earlier?.moved && depth < MAX_MOVES && <MoveHistory fork={earlier} harnesses={harnesses} to={from} depth={depth + 1} />}
          <div className="move-history">
            <Transcript detail={detail} approvals={[]} harnessName={from.name} harness={from.harness} observeStream={false} />
          </div>
        </>
      ) : detail === null ? (
        <p className="move-gone">{COPY.gone}</p>
      ) : null}
      <MoveLine from={from} to={to} turns={fork.turn} {...(pending ? { pending } : {})} {...(onCancel ? { onCancel } : {})} />
    </>
  )
}

/**
 * The page a conversation is in while it waits to go on with another Harness: what was said so far, scrolling, kept at
 * its end as the record loads, so the line that says where the next message goes stands right over the input.
 */
export function MovingThread({ children }: { children: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const box = scroller.current
    const inner = content.current
    if (!box || !inner) return
    const toEnd = () => {
      box.scrollTop = box.scrollHeight
    }
    toEnd()
    const observer = new ResizeObserver(toEnd)
    observer.observe(inner)
    return () => observer.disconnect()
  }, [])
  return (
    <div className="code-home-thread" data-backdrop-clear="" ref={scroller}>
      <div className="code-home-thread-content" ref={content}>
        {children}
      </div>
    </div>
  )
}
