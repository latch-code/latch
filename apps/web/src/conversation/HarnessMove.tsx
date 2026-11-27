import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { HarnessInfo, TaskDetail, TaskSummary } from '@latch/protocol'
import { ArrowRight, ArrowRightLeft } from 'lucide-react'
import { Button, Icon, SegmentedControl, Spinner } from '@latch/ui'
import { api, errorMessage, newRequestId } from '../core/api.ts'
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
    briefed: (from: string) => `带着 ${from} 写的交接说明`,
    resumed: (to: string) => `${to} 接上它之前的会话`,
    carry: '带过去',
    record: '全文记录',
    brief: '交接说明',
    recordSize: (turns: number, size: string) => `${turns} 轮 · 约 ${size}`,
    writeBrief: (from: string) => `让 ${from} 写交接说明`,
    writing: (from: string) => `${from} 正在写…`,
    written: '已写好，就是上面最后一条回复',
    rewrite: '重写',
    briefCost: '会在原会话里多跑一轮',
    noFiles: '附件与图片不会跟过去',
    thousand: (value: string) => `${value} 千字`,
    chars: (value: number) => `${value} 字`,
    said: (from: string, to: string) => `从 ${from} 换到 ${to}`,
    gone: '之前的记录已不在这台电脑上',
    cancel: '取消',
  },
  {
    moved: 'Harness changed',
    pending: 'Moves with the next message',
    carried: (turns: number) => (turns === 1 ? 'With the record of 1 turn' : `With the record of ${turns} turns`),
    briefed: (from: string) => `With the handoff note ${from} wrote`,
    resumed: (to: string) => `${to} goes on from its earlier session`,
    carry: 'Goes across',
    record: 'Full record',
    brief: 'Handoff note',
    recordSize: (turns: number, size: string) => `${turns} ${turns === 1 ? 'turn' : 'turns'} · about ${size}`,
    writeBrief: (from: string) => `Have ${from} write a handoff note`,
    writing: (from: string) => `${from} is writing…`,
    written: 'Written: it is the last reply above',
    rewrite: 'Rewrite',
    briefCost: 'Runs one more turn in the session being left',
    noFiles: 'Attachments and pictures do not go across',
    thousand: (value: string) => `${value}k characters`,
    chars: (value: number) => `${value} characters`,
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
  brief,
  resumed,
  pending,
  onCancel,
}: {
  from: Side
  to: Side
  /** It came back to a Harness it had left, which went on from its own record of its earlier session. */
  resumed?: boolean | undefined
  /** Only the note the one it left wrote went across. */
  brief?: boolean | undefined
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
        {pending
          ? COPY.pending
          : resumed
            ? COPY.resumed(to.name)
            : brief
              ? COPY.briefed(from.name)
              : turns
                ? COPY.carried(turns)
                : COPY.moved}
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
  resumed,
  pending,
  onCancel,
}: {
  /** The session this line leads to forked its own earlier session instead of reading the record. */
  resumed?: boolean | undefined
  fork: Pick<NonNullable<TaskSummary['forkOf']>, 'taskId' | 'moved' | 'brief'> & { turn?: number }
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
          {earlier?.moved && depth < MAX_MOVES && (
            <MoveHistory
              fork={earlier}
              harnesses={harnesses}
              to={from}
              depth={depth + 1}
              resumed={detail.messages.find(message => message.role === 'user')?.nativeFork === true}
            />
          )}
          <div className="move-history">
            <Transcript detail={detail} approvals={[]} harnessName={from.name} harness={from.harness} observeStream={false} />
          </div>
        </>
      ) : detail === null ? (
        <p className="move-gone">{COPY.gone}</p>
      ) : null}
      <MoveLine
        from={from}
        to={to}
        turns={fork.turn}
        brief={fork.brief}
        resumed={resumed}
        {...(pending ? { pending } : {})}
        {...(onCancel ? { onCancel } : {})}
      />
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

/** What the Harness being left is asked for when the person wants a note instead of the record. */
const BRIEF_PROMPT =
  '请为接手这件事的另一个 Agent 写一份交接说明。写清：目标；已经完成的；关键决定和原因；相关的文件与位置；还没解决的问题；建议的下一步。只写说明本身，不要调用工具，不要改动任何文件。'

const sizeText = (chars: number) => (chars < 1000 ? COPY.chars(chars) : COPY.thousand((chars / 1000).toFixed(chars < 10_000 ? 1 : 0)))

/**
 * Under the waiting line: what goes across with the next message. The whole record (how many turns, about how long), or
 * a note the Harness being left writes now, in its own session, where the person reads it before sending. Writing it is
 * one more turn there, said plainly; the note is then the session's last reply and the only thing that goes across.
 */
export function MoveCarry({
  sourceId,
  from,
  brief,
  canWrite,
  onRecord,
  onBrief,
}: {
  sourceId: string
  from: string
  brief: boolean
  /** This device may run a turn in the session being left. */
  canWrite: boolean
  /** Back to the whole record, up to this message. */
  onRecord: (upToMessageId: string) => void
  /** The note is written: this reply alone goes across. */
  onBrief: (messageId: string) => void
}) {
  const [detail, setDetail] = useState<TaskDetail>()
  const [mode, setMode] = useState<'record' | 'brief'>(brief ? 'brief' : 'record')
  const [writing, setWriting] = useState(false)
  const [failed, setFailed] = useState<string>()
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    api<TaskDetail>(`tasks/${encodeURIComponent(sourceId)}`)
      .then(next => {
        if (alive.current) setDetail(next)
      })
      .catch(() => {})
    return () => {
      alive.current = false
    }
  }, [sourceId])
  const turns = detail?.messages.filter(message => message.role === 'user' && !message.steered).length ?? 0
  const chars = detail?.messages.reduce((sum, message) => sum + message.text.length, 0) ?? 0
  const lastId = detail?.messages.at(-1)?.id
  async function write() {
    setWriting(true)
    setFailed(undefined)
    try {
      const before = detail?.messages.length ?? 0
      await api(`tasks/${encodeURIComponent(sourceId)}/prompt`, {
        method: 'POST',
        body: { prompt: BRIEF_PROMPT, requestId: newRequestId() },
      })
      // The Host is the authority on when the turn ended: its record is read until it rests with a new reply.
      for (let tries = 0; tries < 600 && alive.current; tries++) {
        await new Promise(done => setTimeout(done, 1000))
        const next = await api<TaskDetail>(`tasks/${encodeURIComponent(sourceId)}`)
        if (next.summary.status === 'running' || next.summary.status === 'waiting-approval') continue
        const reply = next.messages.at(-1)
        if (!alive.current) return
        setDetail(next)
        if (next.messages.length > before && reply?.role === 'assistant' && reply.text.trim()) onBrief(reply.id)
        else setFailed(COPY.gone)
        return
      }
    } catch (error) {
      if (alive.current) setFailed(errorMessage(error))
    } finally {
      if (alive.current) setWriting(false)
    }
  }
  return (
    <div className="move-carry">
      <span className="move-carry-label">{COPY.carry}</span>
      <SegmentedControl
        label={COPY.carry}
        size="xs"
        value={mode}
        disabled={writing}
        options={[
          { value: 'record', label: COPY.record },
          { value: 'brief', label: COPY.brief },
        ]}
        onValueChange={next => {
          setMode(next)
          if (next === 'record' && lastId) onRecord(lastId)
        }}
      />
      {mode === 'record' ? (
        <span className="move-carry-note">{detail ? COPY.recordSize(turns, sizeText(chars)) : null}</span>
      ) : writing ? (
        <span className="move-carry-note">
          <Spinner size={12} />
          {COPY.writing(from)}
        </span>
      ) : brief ? (
        <span className="move-carry-note">
          {COPY.written}
          {canWrite && (
            <Button size="xs" variant="ghost" onClick={() => void write()}>
              {COPY.rewrite}
            </Button>
          )}
        </span>
      ) : (
        <span className="move-carry-note">
          <Button size="xs" variant="outline" disabled={!canWrite} onClick={() => void write()}>
            {COPY.writeBrief(from)}
          </Button>
          {COPY.briefCost}
        </span>
      )}
      {failed && <span className="move-carry-note is-failed">{failed}</span>}
      <span className="move-carry-note is-aside">{COPY.noFiles}</span>
    </div>
  )
}
