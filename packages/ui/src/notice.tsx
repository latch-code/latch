import { useEffect, useRef, type ReactNode } from 'react'
import { CircleX, Info, TriangleAlert, X } from 'lucide-react'
import { IconButton } from './button.tsx'
import { Icon } from './icon.tsx'
import { cx } from './internal.ts'

export type NoticeTone = 'neutral' | 'warn' | 'error'

const NOTICE_GLYPH = { neutral: Info, warn: TriangleAlert, error: CircleX } as const

/**
 * An inline notice, also used as a banner at the top of the message area: a tint with a 1px ring in the same tone
 * (neutral is a tray), the tone's glyph, a title in the tone's text colour and the text in text-2. Write what was kept
 * first, then the reason, then the action. At most one xs action; inside amber and red it is a raised white secondary
 * button (the notice marks itself `data-tint`). Never a full-width coloured strip.
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

export type ToastTone = 'neutral' | 'error'
const TOAST_GLYPH = { neutral: Info, error: CircleX } as const

/**
 * A toast: a 36px floating pill, 13/18 text after a 14px glyph in its tone. Only for what happened elsewhere (「已由
 * 「iPhone」处理」) or failed; a local action that succeeded shows its result in place instead. It goes after 3 seconds
 * unless `duration` is null. The caller places it (bottom centre, 12px above the composer).
 */
export function Toast({
  tone = 'neutral',
  children,
  onDismiss,
  duration = 3000,
  className,
}: {
  tone?: ToastTone
  children: ReactNode
  onDismiss?: () => void
  duration?: number | null
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
    <div className={cx('ui-toast', className)} data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon icon={TOAST_GLYPH[tone]} size={14} className="ui-toast-glyph" />
      <span>{children}</span>
    </div>
  )
}
