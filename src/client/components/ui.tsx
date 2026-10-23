import { forwardRef, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import type { TaskStatus } from '../../shared/types.ts'
import { statusLabels } from '../format.ts'
import { ICON_STROKE, type LucideIcon } from '../icons.tsx'

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>

/** Icon-only control; the label is both its accessible name and tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, ButtonProps & { label: string; icon: LucideIcon; size?: number; pressed?: boolean; badge?: number }>(
  function IconButton({ label, icon: Icon, size = 18, pressed, badge, className = '', type = 'button', ...props }, ref) {
    return <button ref={ref} type={type} className={`icon-button ${className}`} aria-label={label} title={label} aria-pressed={pressed} {...props}>
      <Icon size={size} strokeWidth={ICON_STROKE} aria-hidden="true" />
      {badge !== undefined && badge > 0 && <span className="icon-badge" aria-hidden="true">{badge > 99 ? '99+' : badge}</span>}
    </button>
  },
)

export function StatusPill({ status, cancelling = false }: { status: TaskStatus; cancelling?: boolean }) {
  return <span className={`status-pill status-${cancelling ? 'cancelling' : status}`}><i aria-hidden="true" />{cancelling ? '正在取消' : statusLabels[status]}</span>
}

export function Badge({ tone = 'neutral', children, title }: { tone?: 'neutral' | 'warn' | 'accent' | 'ok' | 'err'; children: ReactNode; title?: string }) {
  return <span className={`badge badge-${tone}`} title={title}>{children}</span>
}

/** Clipboard can be unavailable on LAN HTTP; failure is reported instead of a false success. */
export function useCopy(timeout = 1800) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async (text: string) => {
    clearTimeout(timer.current)
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(text)
      setState('copied')
    } catch { setState('failed') }
    timer.current = setTimeout(() => setState('idle'), timeout)
  }
  return { state, copy }
}

export function CopyButton({ text, label = '复制', className = '' }: { text: string; label?: string; className?: string }) {
  const { state, copy } = useCopy()
  const title = state === 'copied' ? '已复制' : state === 'failed' ? '复制不可用，请手动选择' : label
  return <button type="button" className={`icon-button copy-button ${className}`} aria-label={label} title={title} onClick={() => { void copy(text) }}>
    {state === 'copied' ? <Check size={14} strokeWidth={ICON_STROKE} aria-hidden="true" /> : <Copy size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />}
    <span className="sr-only" role="status">{state === 'copied' ? '已复制' : state === 'failed' ? '复制失败' : ''}</span>
  </button>
}

export function Switch({ checked, label, disabled, onChange, title }: { checked: boolean; label: string; disabled?: boolean; title?: string; onChange: (next: boolean) => void }) {
  return <button type="button" role="switch" className="switch" aria-label={label} aria-checked={checked} disabled={disabled} title={title} onClick={() => { onChange(!checked) }}><i aria-hidden="true" /></button>
}

export function Segmented<T extends string>({ label, value, options, onChange, disabled, className = '' }: {
  label: string
  value: T
  options: Array<{ value: T; label: string; icon?: LucideIcon; disabled?: boolean; title?: string }>
  onChange: (value: T) => void
  disabled?: boolean
  className?: string
}) {
  return <div className={`segmented ${className}`} role="group" aria-label={label}>
    {options.map(option => <button key={option.value} type="button" aria-pressed={value === option.value} title={option.title} disabled={disabled || option.disabled} onClick={() => { onChange(option.value) }}>
      {option.icon && <option.icon size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />}{option.label}
    </button>)}
  </div>
}

export function InlineAlert({ tone, children, action }: { tone: 'error' | 'warn' | 'info' | 'ok' | 'neutral'; children: ReactNode; action?: ReactNode }) {
  return <div className={`inline-alert inline-alert-${tone}`} role={tone === 'error' ? 'alert' : 'status'}><div>{children}</div>{action}</div>
}

/** Brand artwork; in dark mode CSS adds a hairline ring so the charcoal tile stays visible. */
export function BrandMark({ size = 24 }: { size?: number }) {
  return <img className="brand-mark" src="/link/icon.png" alt="" width={size} height={size} style={{ width: size, height: size }} />
}
