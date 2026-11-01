import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { TaskDetail } from '@latch/protocol'
import { FindBar } from '../src/components/FindBar.tsx'
import { JumpLatest } from '../src/components/JumpLatest.tsx'
import { Transcript } from '../src/components/Transcript.tsx'
import { useReadingPosition } from '../src/core/useReadingPosition.ts'
import '../src/styles/index.css'

declare global {
  interface Window {
    /** A frame of the event stream: every message parsed again, as a full SSE frame does. */
    showDetail: (detail: TaskDetail) => void
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

/** The real transcript, reading position and find bar in the page's own layout, with no Host behind them. */
function Harness() {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [find, setFind] = useState(false)
  const reading = useReadingPosition({
    sessionId: detail?.summary.id ?? null,
    ready: detail !== null,
    contentVersion: `${detail?.cursor ?? 0}:${detail?.liveText.length ?? 0}`,
  })
  window.showDetail = next => {
    setDetail(JSON.parse(JSON.stringify(next)) as TaskDetail)
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
      <div className="transcript" ref={reading.containerRef} {...reading.handlers} tabIndex={0} aria-label="会话记录">
        <div className="transcript-content" ref={reading.contentRef}>
          {detail && (
            <Transcript
              detail={detail}
              approvals={detail.approvals ?? none}
              harnessName="夹具"
              active={detail.summary.status === 'running' || detail.summary.status === 'waiting-approval'}
            />
          )}
        </div>
      </div>
      <JumpLatest show={!reading.isFollowing} onJump={reading.jumpToLatest} />
    </div>
  )
}
createRoot(document.querySelector('#root')!).render(<Harness />)
