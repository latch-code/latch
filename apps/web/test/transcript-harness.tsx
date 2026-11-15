import { useState, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import type { TaskDetail } from '@latch/protocol'
import { FindBar } from '../src/components/FindBar.tsx'
import { ConversationRail } from '../src/components/ConversationRail.tsx'
import { isLive, liveMessageId } from '../src/conversation.ts'
import { JumpLatest } from '../src/components/JumpLatest.tsx'
import { Transcript } from '../src/components/Transcript.tsx'
import { useReadingPosition } from '../src/core/useReadingPosition.ts'
import { announceChangesWrite } from '../src/conversation/useTurnChanges.ts'
import { useTranscriptProjection } from '../src/conversation/useTranscriptProjection.ts'
import '../src/styles/index.css'

declare global {
  interface Window {
    /** A frame of the event stream: every message parsed again, as a full SSE frame does. */
    showDetail: (detail: TaskDetail) => void
    /** Measures actual history reads while append frames retain immutable messages, as delta-v1 does. */
    watchHistory: (detail: TaskDetail, committed: number) => void
    appendLive: (text: string) => void
    takeHistoryReads: () => number
    showTranscriptOptions: (options: Partial<Omit<ComponentProps<typeof Transcript>, 'detail' | 'projection'>>) => void
    patchDetail: (patch: Partial<Omit<TaskDetail, 'messages'>>) => void
    refreshTurnRecords: () => void
    openFind: () => void
    revealMessage: (id: string) => void
  }
}
const noApprovals = new Map<string, string>()
const none: never[] = []
const onDecide = () => {}
const onReveal = (id: string) => {
  window.revealMessage(id)
}
let historyReads = 0

/** The real transcript, reading position and find bar in the page's own layout, with no Host behind them. */
function Harness() {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [options, setOptions] = useState<Partial<Omit<ComponentProps<typeof Transcript>, 'detail' | 'projection'>>>({})
  const [find, setFind] = useState(false)
  const projection = useTranscriptProjection(detail)
  const reading = useReadingPosition({
    sessionId: detail?.summary.id ?? null,
    ready: detail !== null,
    contentVersion: `${detail?.cursor ?? 0}:${detail?.liveText.length ?? 0}`,
  })
  window.showDetail = next => {
    setDetail(JSON.parse(JSON.stringify(next)) as TaskDetail)
  }
  window.watchHistory = (next, committed) => {
    historyReads = 0
    const messages = next.messages.map((message, index) =>
      index >= committed
        ? message
        : new Proxy(message, {
            get(target, key, receiver) {
              if (Object.hasOwn(target, key)) historyReads++
              return Reflect.get(target, key, receiver)
            },
          }),
    )
    setDetail({ ...next, messages })
  }
  window.appendLive = text => {
    setDetail(current => (current ? { ...current, liveText: current.liveText + text } : current))
  }
  window.takeHistoryReads = () => {
    const reads = historyReads
    historyReads = 0
    return reads
  }
  window.showTranscriptOptions = setOptions
  window.patchDetail = patch => setDetail(current => (current ? { ...current, ...patch } : current))
  window.refreshTurnRecords = () => {
    if (detail) announceChangesWrite(detail.summary.id, 'panel')
  }
  window.openFind = () => {
    setFind(true)
  }
  window.revealMessage = reading.reveal
  return (
    <div className="transcript-shell" style={{ height: '100dvh' }}>
      {find && detail && (
        <FindBar
          sessionId={detail.summary.id}
          revision={0}
          messages={detail.messages}
          onReveal={onReveal}
          onClose={() => {
            setFind(false)
          }}
        />
      )}
      {detail && (
        <ConversationRail
          key={`rail:${detail.summary.id}`}
          turns={projection.turns}
          liveId={isLive(detail) ? liveMessageId(detail) : undefined}
          getReadingMessageId={reading.getReadingMessageId}
          subscribeToReadingAnchor={reading.subscribeToReadingAnchor}
          onReveal={reading.reveal}
        />
      )}
      <div className="transcript" ref={reading.containerRef} {...reading.handlers} tabIndex={0} aria-label="会话记录">
        <div className="transcript-content" ref={reading.contentRef}>
          {detail && (
            <Transcript
              detail={detail}
              projection={projection}
              approvals={detail.approvals ?? none}
              harnessName="夹具"
              active={detail.summary.status === 'running' || detail.summary.status === 'waiting-approval'}
              {...options}
            />
          )}
        </div>
      </div>
      <JumpLatest key={`latest:${detail?.summary.id}`} show={!reading.isFollowing} onJump={reading.jumpToLatest} />
    </div>
  )
}
createRoot(document.querySelector('#root')!).render(<Harness />)
