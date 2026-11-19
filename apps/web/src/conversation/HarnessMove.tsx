import { useEffect, useState } from 'react'
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
    pending: '下一条消息起',
    gone: '之前的记录已不在这台电脑上',
    cancel: '取消',
  },
  {
    moved: 'Harness changed',
    pending: 'From the next message',
    gone: 'The earlier record is no longer on this computer',
    cancel: 'Cancel',
  },
)

interface Side {
  name: string
  harness?: HarnessInfo | undefined
}

/** The Harness a conversation left, as this computer lists it now; one no longer listed is said by its ID. */
export function movedSide(harnesses: readonly HarnessInfo[] | undefined, id: string): Side {
  const harness = harnesses?.find(item => item.id === id)
  return harness ? { name: harnessName(harness), harness } : { name: id }
}

/**
 * The line where a conversation went on with another Harness: which it left and which took over. `pending`: chosen and
 * not sent yet; the next message makes it so.
 */
export function MoveLine({ from, to, pending, onCancel }: { from: Side; to: Side; pending?: boolean; onCancel?: () => void }) {
  return (
    <div className="move-line" role="separator" data-pending={pending ? '' : undefined}>
      <span className="move-line-words">
        <Icon icon={ArrowRightLeft} size={14} />
        <span>{pending ? COPY.pending : COPY.moved}</span>
        <span className="move-side">
          {from.harness && <HarnessTile harness={from.harness} size={16} />}
          <VisibleText text={from.name} />
        </span>
        <Icon icon={ArrowRight} size={12} />
        <span className="move-side is-next">
          {to.harness && <HarnessTile harness={to.harness} size={16} />}
          <VisibleText text={to.name} />
        </span>
        {pending && onCancel && (
          <button type="button" className="move-cancel" onClick={onCancel}>
            {COPY.cancel}
          </button>
        )}
      </span>
    </div>
  )
}

/**
 * What was said before the conversation moved, above the line: the session the conversation left, read from the Host and drawn as
 * it stands there, read only (no stop, no retry, no fork from it here). A source that is gone leaves the line and one
 * muted sentence; the new session's first message still carries its record.
 */
export function MoveHistory({ fork, from, to }: { fork: NonNullable<TaskSummary['forkOf']>; from: Side; to: Side }) {
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
  return (
    <>
      {detail ? (
        <div className="move-history">
          <Transcript detail={detail} approvals={[]} harnessName={from.name} harness={from.harness} observeStream={false} />
        </div>
      ) : detail === null ? (
        <p className="move-gone">{COPY.gone}</p>
      ) : null}
      <MoveLine from={from} to={to} />
    </>
  )
}
