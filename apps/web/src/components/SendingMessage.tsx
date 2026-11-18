import { useEffect, useState } from 'react'
import { Count } from '@latch/ui'
import type { SendingMessage as SendingView } from '../core/sendingMessage.ts'
import { defineCopy } from '../core/i18n.ts'
import { MessageRow } from './MessageRow.tsx'

const COPY = defineCopy(
  {
    attachments: (count: number) => (
      <>
        已添加 <Count value={count} /> 个附件
      </>
    ),
    unknown: '未确认送达 · 在输入框重试或放弃这次提交',
    sending: '发送中…',
  },
  {
    attachments: (count: number) => (
      <>
        Added <Count value={count} /> {count === 1 ? 'attachment' : 'attachments'}
      </>
    ),
    unknown: 'Delivery unconfirmed · Retry or discard from the input box',
    sending: 'Sending…',
  },
)

/** The text is immediate; the quiet delivery label waits 500ms to avoid flicker on a fast acknowledgement. */
export function SendingMessage({ view, showUnknown = true }: { view: SendingView; showUnknown?: boolean }) {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    setSlow(false)
    const timer = setTimeout(() => setSlow(true), Math.max(0, 500 - (Date.now() - view.startedAt)))
    return () => clearTimeout(timer)
  }, [view.startedAt])
  const attachments = view.submission.attachmentIds?.length ?? 0
  return (
    <div className="sending-message" data-pending-request-id={view.submission.requestId}>
      {view.submission.prompt && (
        <MessageRow
          message={{
            id: `pending:${view.submission.requestId}`,
            requestId: view.submission.requestId,
            role: 'user',
            text: view.submission.prompt,
          }}
        />
      )}
      {attachments > 0 && <p className="sending-attachments">{COPY.attachments(attachments)}</p>}
      {((view.state === 'unknown' && showUnknown) || (view.state === 'sending' && slow)) && (
        <div className="sending-message-status" data-state={view.state} role="status">
          {view.state === 'unknown' ? COPY.unknown : COPY.sending}
        </div>
      )}
    </div>
  )
}
