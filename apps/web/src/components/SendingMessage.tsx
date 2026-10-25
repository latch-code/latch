import { useEffect, useState } from 'react'
import { Count } from '@latch/ui'
import type { SendingMessage as SendingView } from '../core/sendingMessage.ts'
import { MessageRow } from './MessageRow.tsx'

/** The text is immediate; the quiet delivery label waits 500ms to avoid flicker on a fast acknowledgement. */
export function SendingMessage({ view }: { view: SendingView }) {
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
      {attachments > 0 && (
        <p className="sending-attachments">
          已添加 <Count value={attachments} /> 个附件
        </p>
      )}
      {(view.state === 'unknown' || (view.state === 'sending' && slow)) && (
        <div className="sending-message-status" data-state={view.state} role="status">
          {view.state === 'unknown' ? '未确认送达 · 在输入框重试这次提交' : '发送中…'}
        </div>
      )}
    </div>
  )
}
