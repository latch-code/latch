import { useState } from 'react'
import { escapeSecurityText } from '@latch/protocol'
import { Button, InlineNotice, Modal, ModalHeader } from '@latch/ui'
import { MarkTile } from '../components/BrandTile.tsx'

export interface PickOption {
  id: string
  title: string
  /** A Harness's mark, drawn before the title. */
  mark?: string | undefined
  meta?: string | undefined
}

/**
 * Pick one: a session to add to a 待办 (its page), or a 待办 for a session (加入待办… in the session menu). The choice
 * is made at once; the Host's refusal stays in the dialog.
 */
export function ItemPagePick({
  title,
  options,
  empty,
  phone,
  onPick,
  onClose,
}: {
  title: string
  options: readonly PickOption[]
  empty: string
  phone: boolean
  /** Rejects with the Host's words. */
  onPick: (id: string) => Promise<void>
  onClose: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const close = () => {
    if (busy === null) onClose()
  }
  const pick = async (id: string) => {
    if (busy !== null) return
    setBusy(id)
    setError('')
    try {
      await onPick(id)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '没有完成，请重试。')
      setBusy(null)
    }
  }
  return (
    <Modal label={title} variant={phone ? 'sheet' : 'dialog'} dismissible={busy === null} onClose={close} className="item-pick-dialog">
      <ModalHeader title={title} onClose={close} />
      <div className="ui-modal-body">
        {options.length ? (
          <ul className="item-pick-list" aria-label={title}>
            {options.map(option => (
              <li key={option.id}>
                <button
                  type="button"
                  className="item-pick-option"
                  disabled={busy !== null}
                  aria-busy={busy === option.id ? 'true' : undefined}
                  onClick={() => void pick(option.id)}>
                  {option.mark !== undefined && <MarkTile mark={option.mark} size={14} />}
                  <span className="item-pick-title">{escapeSecurityText(option.title)}</span>
                  {option.meta && <span className="item-pick-meta">{option.meta}</span>}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="item-pick-empty">{empty}</p>
        )}
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
      </div>
      <footer className="ui-modal-footer">
        <Button size="md" disabled={busy !== null} onClick={close}>
          取消
        </Button>
      </footer>
    </Modal>
  )
}
