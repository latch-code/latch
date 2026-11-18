import { UI_COPY, useUiLocale } from './locale.ts'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { CircleX } from 'lucide-react'
import { InfoGlyph, WarningGlyph, CloseGlyph } from './glyphs/index.tsx'
import { IconButton } from './button.tsx'
import { Icon } from './icon.tsx'
import { cx } from './internal.ts'
import { Tooltip } from './tooltip.tsx'

export type NoticeTone = 'neutral' | 'warn' | 'error'

const NOTICE_GLYPH = { neutral: InfoGlyph, warn: WarningGlyph, error: CircleX } as const

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
  closeLabel = UI_COPY.close,
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
  useUiLocale()
  return (
    <div
      className={cx('ui-notice', className)}
      data-tone={tone}
      data-secure={secure ? '' : undefined}
      // A warning or an error keeps the product's own tokens under every customisation (tokens.css).
      data-lock={!secure && tone !== 'neutral' ? '' : undefined}
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
      {onClose && <IconButton label={closeLabel} icon={CloseGlyph} size="xs" onClick={onClose} />}
    </div>
  )
}

/**
 * A fact in a few words, with the fine print on hover: an optional glyph or mark, a short label, and the detail as a
 * tooltip (hover, keyboard focus, or a press and hold on touch), so the explanation never takes room or moves anything
 * and is never something to press. The label says what the thing is; the detail is for whoever asks.
 *
 * By default the label itself carries the tooltip. `inline` is for a label that must stay plain words on the surface
 * (an approval, a failure and what to do next, a security surface): the label is followed by an ⓘ, and the detail is
 * that ⓘ's tooltip.
 */
export function Hint({
  label,
  lead,
  children,
  inline = false,
  moreLabel = UI_COPY.more,
  locked = false,
  className,
}: {
  label: ReactNode
  /** A warning that must look the same under every customisation (不先问你): the product's own tokens (tokens.css). */
  locked?: boolean
  /** A mark or glyph before the label; none on hover by default, the info glyph when `inline`. */
  lead?: ReactNode
  /** The detail. Without it the hint is the label alone. */
  children?: ReactNode
  /** The detail is the tooltip of an ⓘ after the label, instead of the label's own. */
  inline?: boolean
  /** What the ⓘ is called to a screen reader. */
  moreLabel?: string
  className?: string
}) {
  useUiLocale()
  if (!inline)
    return (
      <div className={cx('ui-hint', className)} data-tip="" data-lock={locked ? '' : undefined}>
        {lead !== undefined && lead !== false && (
          <span className="ui-hint-lead" aria-hidden="true">
            {lead}
          </span>
        )}
        <Tooltip content={children ?? undefined}>
          <span className="ui-hint-label" tabIndex={children ? 0 : undefined}>
            {label}
          </span>
        </Tooltip>
      </div>
    )
  return (
    <div className={cx('ui-hint', className)} data-lock={locked ? '' : undefined}>
      <span className="ui-hint-lead" aria-hidden="true">
        {lead ?? <Icon icon={InfoGlyph} size={12} />}
      </span>
      <span className="ui-hint-label">{label}</span>
      {children && (
        <Tooltip content={children}>
          <span className="ui-hint-more" tabIndex={0} role="img" aria-label={moreLabel}>
            <Icon icon={InfoGlyph} size={12} />
          </span>
        </Tooltip>
      )}
    </div>
  )
}

export type ToastTone = 'neutral' | 'error'
const TOAST_GLYPH = { neutral: InfoGlyph, error: CircleX } as const

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
