import { CircleCheck, Fingerprint } from 'lucide-react'
import { useViewport } from '../breakpoints.ts'
import { useConfirmationState } from '../core/confirmations.ts'
import { useCountdown } from '../hooks/useCountdown.ts'
import { currentShell } from '../core/shell.ts'
import { Modal, ModalHeader } from './overlays.tsx'
import { Button, ICON_STROKE, InlineNotice, Loading, StatusDot } from '@latch/ui'

const TITLE = '请在本机确认'

/** The page-wide local confirmation dialog; `withConfirmation` drives it. */
export function ConfirmationDialog() {
  const state = useConfirmationState()
  const phone = useViewport() === 'phone'
  const ticket = state?.view.ticket
  const { seconds, fraction } = useCountdown(state?.view.phase === 'waiting' ? ticket?.expiresAt : undefined, 60)
  if (state === null || ticket === undefined) return null
  const { view, actions } = state
  const close = view.phase === 'failed' ? actions.dismiss : actions.cancel
  const hash = ticket.hashDisplay
  const code = <code className="presence-inline">{hash}</code>
  const body = currentShell() ? (
    <>系统将显示确认窗口。请核对其中的内容和核对码 {code}，然后用 Touch ID 或登录密码确认。</>
  ) : (
    <>
      请到运行 Latch 的电脑上核对「{ticket.title}」和核对码 {code}。
    </>
  )
  return (
    <Modal
      key={ticket.id}
      label={TITLE}
      variant={phone ? 'sheet' : 'dialog'}
      className="presence-dialog"
      onClose={() => {
        if (view.phase !== 'sending') close()
      }}>
      <ModalHeader
        title={TITLE}
        onClose={() => {
          if (view.phase !== 'sending') close()
        }}
      />
      <div className="modal-body presence-body" data-confirmation-phase={view.phase}>
        <div className="presence-subject">
          <span className="presence-icon" aria-hidden="true">
            {view.phase === 'sending' ? (
              <CircleCheck size={20} strokeWidth={ICON_STROKE[20]} />
            ) : (
              <Fingerprint size={20} strokeWidth={ICON_STROKE[20]} />
            )}
          </span>
          <strong>{ticket.title}</strong>
        </div>
        <p className="presence-text">{body}</p>
        <div className="presence-code">
          <span>核对码</span>
          <code>{hash}</code>
        </div>
        {view.phase === 'waiting' && (
          <div className="presence-timer">
            <StatusDot tone="warn" />
            <span role="timer">剩余 {seconds} 秒</span>
            <span className="countdown-track" aria-hidden="true">
              <i style={{ width: `${Math.round(fraction * 100)}%` }} />
            </span>
          </div>
        )}
        {view.phase === 'sending' && <Loading label="已确认，正在执行…" />}
        {view.phase === 'failed' && <InlineNotice tone="error">{view.message}</InlineNotice>}
      </div>
      <footer className="modal-footer">
        {view.phase === 'failed' ? (
          <Button size="md" onClick={actions.dismiss}>
            关闭
          </Button>
        ) : (
          <Button size="md" disabled={view.phase === 'sending'} onClick={actions.cancel}>
            取消
          </Button>
        )}
      </footer>
    </Modal>
  )
}
