import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { CircleX, Info, TriangleAlert, X } from 'lucide-react'
import { IconButton } from './button.tsx'
import { Icon } from './icon.tsx'
import { cx } from './internal.ts'

export type NoticeTone = 'neutral' | 'warn' | 'error'

const NOTICE_GLYPH = { neutral: Info, warn: TriangleAlert, error: CircleX } as const

/**
 * An inline notice, also used as a banner at the top of the message area: the raised surface with a 1px line (an error
 * tints it red with a red edge), the tone's glyph, a title in the tone's colour and the text in ink-2.
 * Write what was kept first, then the reason, then the action. At most one xs action; in a warning or an error it is an
 * outlined button (the notice marks itself `data-tint`). Never a full-width coloured strip.
 */
export function InlineNotice({
  tone = 'neutral',
  title,
  children,
  action,
  onClose,
  closeLabel = '关闭',
  secure = false,
  className,
}: {
  tone?: NoticeTone
  title?: ReactNode
  children?: ReactNode
  action?: ReactNode
  onClose?: () => void
  closeLabel?: string
  /** A security banner: the tokens are locked inside it and its look is pinned (tokens.css, the page's security layer). */
  secure?: boolean
  className?: string
}) {
  return (
    <div
      className={cx('ui-notice', className)}
      data-tone={tone}
      data-secure={secure ? '' : undefined}
      data-tint={tone === 'warn' ? 'warn' : tone === 'error' ? 'err' : undefined}
      role={tone === 'error' ? 'alert' : 'status'}>
      <div className="ui-notice-body">
        <Icon icon={NOTICE_GLYPH[tone]} size={14} className="ui-notice-glyph" />
        <div className="ui-notice-text">
          {title && <strong className="ui-notice-title">{title}</strong>}
          {children}
        </div>
      </div>
      {action && <div className="ui-notice-action">{action}</div>}
      {onClose && <IconButton label={closeLabel} icon={X} size="xs" onClick={onClose} />}
    </div>
  )
}

/**
 * A fact in a few words, with the rest one press away: a glyph or mark, a short label, and an ⓘ that unfolds the detail
 * under it in place (so it works by touch and keyboard, and inside a menu). Use it where a surface would otherwise
 * carry a sentence of explanation: the label says what the thing is, the detail says the fine print for whoever asks.
 */
export function Hint({
  label,
  lead,
  children,
  moreLabel = '说明',
  defaultOpen = false,
  className,
}: {
  label: ReactNode
  /** A mark or glyph before the label; the info glyph by default. */
  lead?: ReactNode
  /** The detail. Without it the hint is the label alone. */
  children?: ReactNode
  moreLabel?: string
  /** Starts unfolded, as a static sheet of the design system shows it. */
  defaultOpen?: boolean
  className?: string
}) {
  const id = useId()
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={cx('ui-hint', className)} data-open={open ? '' : undefined}>
      <span className="ui-hint-lead" aria-hidden="true">
        {lead ?? <Icon icon={Info} size={12} />}
      </span>
      <span className="ui-hint-label">{label}</span>
      {children && (
        <IconButton
          label={moreLabel}
          icon={Info}
          size="xs"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => {
            setOpen(!open)
          }}
        />
      )}
      {children && open && (
        <p id={id} className="ui-hint-detail">
          {children}
        </p>
      )}
    </div>
  )
}

export type ToastTone = 'neutral' | 'error'
const TOAST_GLYPH = { neutral: Info, error: CircleX } as const

/**
 * A toast: a 36px floating pill, 13/18 text after a 14px glyph in its tone. Only for what happened elsewhere (「已由
 * 「iPhone」处理」) or failed; a local action that succeeded shows its result in place instead. It goes after 2.2 seconds
 * unless `duration` is null. `placement="bottom"` puts it at the bottom centre of the window; otherwise the caller does.
 */
export function Toast({
  tone = 'neutral',
  children,
  onDismiss,
  duration = 2200,
  placement,
  className,
}: {
  tone?: ToastTone
  children: ReactNode
  onDismiss?: () => void
  duration?: number | null
  placement?: 'bottom'
  className?: string
}) {
  const dismiss = useRef(onDismiss)
  useEffect(() => {
    dismiss.current = onDismiss
  })
  useEffect(() => {
    if (duration === null) return undefined
    const timer = setTimeout(() => dismiss.current?.(), duration)
    return () => {
      clearTimeout(timer)
    }
  }, [duration])
  return (
    <div className={cx('ui-toast', className)} data-tone={tone} data-placement={placement} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon icon={TOAST_GLYPH[tone]} size={14} className="ui-toast-glyph" />
      <span>{children}</span>
    </div>
  )
}
