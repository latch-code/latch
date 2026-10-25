import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button } from './button.tsx'
import { InlineNotice } from './notice.tsx'
import { Modal, ModalHeader, Sheet } from './dialog.tsx'
import { PHONE_QUERY, useMediaQuery } from './internal.ts'
import { TextField } from './field.tsx'

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger = false,
  onConfirm,
  onClose,
}: {
  title: string
  message: ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const phone = useMediaQuery(PHONE_QUERY)
  const confirm = async () => {
    setBusy(true)
    setError('')
    try {
      await onConfirm()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作未完成，请重试。')
      setBusy(false)
    }
  }
  const close = () => {
    if (!busy) onClose()
  }
  // A phone asks in the design system's sheet: 取消 · the question · the action, with what it does in the body.
  if (phone)
    return (
      <Sheet
        open
        title={title}
        className="confirm-dialog"
        onClose={close}
        action={
          <Button
            variant={danger ? 'destroy' : 'primary'}
            disabled={busy}
            loading={busy}
            onClick={() => {
              void confirm()
            }}>
            {confirmLabel}
          </Button>
        }>
        <div className="ui-sheet-dialog-body">
          <p className="ui-confirm-message">{message}</p>
          {error && <InlineNotice tone="error">{error}</InlineNotice>}
        </div>
      </Sheet>
    )
  return (
    <Modal label={title} variant="dialog" onClose={close} className="confirm-dialog">
      <ModalHeader title={title} onClose={close} />
      <div className="ui-modal-body">
        <p className="ui-confirm-message">{message}</p>
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
      </div>
      <footer className="ui-modal-footer">
        <Button size="md" disabled={busy} onClick={onClose}>
          取消
        </Button>
        <Button
          size="md"
          variant={danger ? 'destroy' : 'primary'}
          disabled={busy}
          onClick={() => {
            void confirm()
          }}
          loading={busy}>
          {confirmLabel}
        </Button>
      </footer>
    </Modal>
  )
}

export function PromptDialog({
  title,
  label,
  initial,
  confirmLabel = '保存',
  maxLength = 200,
  onSubmit,
  onClose,
}: {
  title: string
  label: string
  initial: string
  confirmLabel?: string
  maxLength?: number
  onSubmit: (value: string) => Promise<void>
  onClose: () => void
}) {
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const phone = useMediaQuery(PHONE_QUERY)
  const input = useRef<HTMLInputElement>(null)
  const formId = useId()
  useEffect(() => {
    input.current?.select()
  }, [])
  const submit = async () => {
    if (!value.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      await onSubmit(value.trim())
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请重试。')
      setBusy(false)
    }
  }
  const field = (
    <>
      <TextField
        label={label}
        ref={input}
        value={value}
        maxLength={maxLength}
        autoComplete="off"
        onChange={event => {
          setValue(event.target.value)
        }}
      />
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
    </>
  )
  if (phone)
    return (
      <Sheet
        open
        title={title}
        className="prompt-dialog"
        onClose={() => {
          if (!busy) onClose()
        }}
        action={
          <Button type="submit" form={formId} variant="primary" disabled={busy || !value.trim()} loading={busy}>
            {confirmLabel}
          </Button>
        }>
        <form
          id={formId}
          className="ui-sheet-dialog-body"
          onSubmit={event => {
            event.preventDefault()
            void submit()
          }}>
          {field}
        </form>
      </Sheet>
    )
  return (
    <Modal
      label={title}
      variant="dialog"
      onClose={() => {
        if (!busy) onClose()
      }}
      className="prompt-dialog">
      <form
        onSubmit={event => {
          event.preventDefault()
          void submit()
        }}>
        <ModalHeader
          title={title}
          onClose={() => {
            if (!busy) onClose()
          }}
        />
        <div className="ui-modal-body">{field}</div>
        <footer className="ui-modal-footer">
          <Button size="md" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button size="md" type="submit" variant="primary" disabled={busy || !value.trim()} loading={busy}>
            {confirmLabel}
          </Button>
        </footer>
      </form>
    </Modal>
  )
}
