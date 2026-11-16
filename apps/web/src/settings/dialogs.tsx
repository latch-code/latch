import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { Button, Dialog, InlineNotice, TextField } from '@latch/ui'
import { InlineConfirm } from '../components/InlineConfirm.tsx'

/**
 * A 560 dialog that changes one value of a settings row (a name, an address, a key). The value applies when the person
 * saves, as every settings value does; a failure stays in the dialog with the Host's words, and a save that needs a
 * local confirmation shows it in the dialog, under the field (a cancelled one closes nothing). `onSubmit` resolves with
 * the text to show, or '' when it worked.
 */
export function FieldDialog({
  open,
  title,
  subtitle,
  note,
  label,
  initial = '',
  type = 'text',
  placeholder,
  hint,
  warning,
  maxLength,
  confirmLabel = '保存',
  onSubmit,
  onClose,
}: {
  open: boolean
  title: string
  subtitle?: ReactNode
  /** The footer's left side, for example that saving takes a local confirmation. */
  note?: ReactNode
  label: string
  initial?: string
  type?: 'text' | 'url' | 'password'
  placeholder?: string
  hint?: string
  /** A consequence of the typed value, shown in amber under the field (an address change that drops the key). */
  warning?: (value: string) => string | undefined
  maxLength?: number
  confirmLabel?: string
  onSubmit: (value: string) => Promise<string>
  onClose: () => void
}) {
  const form = useId()
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Each opening starts from the row's current value; a typed key is dropped as soon as the dialog closes.
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (open) {
      setValue(initial)
      setError('')
    } else if (type === 'password') setValue('')
  }
  const trimmed = type === 'password' ? value : value.trim()
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!trimmed || busy) return
    setBusy(true)
    setError('')
    const failure = await onSubmit(trimmed)
    setBusy(false)
    if (failure) setError(failure)
    else onClose()
  }
  const warned = warning?.(trimmed)
  return (
    <Dialog
      open={open}
      size="lg"
      title={title}
      subtitle={subtitle}
      note={note}
      onClose={() => {
        if (!busy) onClose()
      }}
      footer={
        <>
          <Button size="md" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button size="md" variant="primary" type="submit" form={form} disabled={!trimmed || trimmed === initial} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }>
      <form
        id={form}
        className="settings-form"
        onSubmit={event => {
          void submit(event)
        }}>
        <TextField
          label={label}
          type={type}
          value={value}
          placeholder={placeholder}
          maxLength={maxLength}
          spellCheck={false}
          autoComplete={type === 'password' ? 'new-password' : 'off'}
          hint={hint}
          onChange={event => {
            setValue(event.target.value)
            setError('')
          }}
        />
        {warned && <InlineNotice tone="warn">{warned}</InlineNotice>}
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
      </form>
      <InlineConfirm active={busy} />
    </Dialog>
  )
}
