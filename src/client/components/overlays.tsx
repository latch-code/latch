import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { Check, X } from 'lucide-react'
import { useViewport } from '../breakpoints.ts'
import { ICON_STROKE, Spinner, type LucideIcon } from '../icons.tsx'

/**
 * Native modal dialog: the browser makes the rest of the page inert and keeps
 * focus inside; closing restores focus to the control that opened it.
 */
export function Modal({ label, variant = 'dialog', onClose, children, className = '' }: {
  label: string
  variant?: 'dialog' | 'sheet' | 'side' | 'page'
  onClose: () => void
  children: ReactNode
  className?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!dialog.open) dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])
  return <dialog ref={ref} className={`modal modal-${variant} ${className}`} aria-label={label}
    onCancel={event => { event.preventDefault(); onClose() }}
    onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="modal-surface">
      {variant === 'sheet' && <span className="sheet-grabber" aria-hidden="true" />}
      {children}
    </div>
  </dialog>
}

export function ModalHeader({ title, onClose, leading, closeLabel = '关闭' }: { title: ReactNode; onClose: () => void; leading?: ReactNode; closeLabel?: string }) {
  return <header className="modal-header">
    {leading}
    <h2>{title}</h2>
    <button type="button" className="icon-button" aria-label={closeLabel} title={closeLabel} onClick={onClose}><X size={18} strokeWidth={ICON_STROKE} aria-hidden="true" /></button>
  </header>
}

export interface MenuItem {
  id: string
  label: string
  description?: string
  icon?: LucideIcon
  tag?: ReactNode
  checked?: boolean
  disabled?: boolean
  /** Shown instead of the description when the item is disabled. */
  disabledReason?: string
  danger?: boolean
  onSelect: () => void
}
export interface MenuSection { id: string; label?: string; items: MenuItem[] }
export interface MenuTriggerProps {
  ref: Ref<HTMLButtonElement>
  onClick: () => void
  'aria-haspopup': 'menu' | 'dialog'
  'aria-expanded': boolean
}

type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'

/** Only a scroll of the page or of a container holding the trigger moves the popover's anchor. */
export function scrollMovesAnchor(target: EventTarget | null, anchor: Node | null): boolean {
  return anchor !== null && target !== null && 'contains' in target && (target as Node).contains(anchor)
}

function itemsOf(container: HTMLElement | null): HTMLButtonElement[] {
  return container ? Array.from(container.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')) : []
}

/**
 * Anchored popover on wider screens, bottom sheet on phones. The popover is
 * fixed-positioned so scrolling lists and the composer never clip it.
 */
export function Menu({ label, sections, trigger, placement = 'bottom-start', selection = false, footer, className = '' }: {
  label: string
  sections: MenuSection[]
  trigger: (props: MenuTriggerProps) => ReactNode
  placement?: Placement
  /** Radio semantics: items show a check for `checked`. */
  selection?: boolean
  footer?: (close: () => void) => ReactNode
  className?: string
}) {
  const viewport = useViewport()
  const sheet = viewport === 'phone'
  const [open, setOpen] = useState(false)
  const [style, setStyle] = useState<CSSProperties>({ top: -9999, left: -9999, visibility: 'hidden' })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const sheetMenu = useRef<HTMLDivElement>(null)
  const id = useId()

  const close = (restoreFocus = true) => {
    setOpen(false)
    setStyle({ top: -9999, left: -9999, visibility: 'hidden' })
    if (restoreFocus && !sheet) triggerRef.current?.focus({ preventScroll: true })
  }

  useLayoutEffect(() => {
    if (!open || sheet) return
    const place = () => {
      const anchor = triggerRef.current?.getBoundingClientRect()
      const element = popover.current
      if (!anchor || !element) return
      const margin = 8
      const gap = 6
      const height = element.scrollHeight
      const width = element.offsetWidth
      const below = innerHeight - anchor.bottom - gap - margin
      const above = anchor.top - gap - margin
      const enough = Math.min(height, 240)
      const up = placement.startsWith('top') ? !(above < enough && below > above) : below < enough && above > below
      const space = Math.max(120, up ? above : below)
      const top = up ? anchor.top - gap - Math.min(height, space) : anchor.bottom + gap
      const preferred = placement.endsWith('end') ? anchor.right - width : anchor.left
      const left = Math.min(Math.max(margin, preferred), Math.max(margin, innerWidth - width - margin))
      setStyle({ top, left, maxHeight: space })
    }
    place()
    const outside = (event: Event) => {
      const target = event.target as Node
      if (popover.current?.contains(target) || triggerRef.current?.contains(target)) return
      close(false)
    }
    // Programmatic scrolls elsewhere, such as the transcript following a stream, leave the anchor in place.
    const scroll = (event: Event) => { if (scrollMovesAnchor(event.target, triggerRef.current)) close(false) }
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', scroll, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', scroll, true)
    }
    // close() only sets state; binding to its per-render identity would reposition on every render.
  }, [open, sheet, placement])

  useEffect(() => {
    if (!open) return
    const container = sheet ? sheetMenu.current : popover.current
    const items = itemsOf(container)
    const target = items.find(item => item.getAttribute('aria-checked') === 'true') ?? items[0]
    target?.focus({ preventScroll: true })
  }, [open, sheet, style.visibility])

  const keydown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = itemsOf(event.currentTarget)
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const move = (next: number) => { event.preventDefault(); items[(next + items.length) % items.length]?.focus() }
    if (event.key === 'ArrowDown') move(index + 1)
    else if (event.key === 'ArrowUp') move(index - 1)
    else if (event.key === 'Home') move(0)
    else if (event.key === 'End') move(items.length - 1)
    else if (event.key === 'Escape' && !sheet) { event.preventDefault(); event.stopPropagation(); close() }
    else if (event.key === 'Tab' && !sheet) close(false)
  }

  const content = <div className="menu-sections" role="menu" aria-label={label} id={id} onKeyDown={keydown} ref={sheet ? sheetMenu : undefined}>
    {sections.filter(section => section.items.length > 0).map(section => <div className="menu-section" key={section.id} role="group" aria-label={section.label}>
      {section.label && <div className="menu-section-label" aria-hidden="true">{section.label}</div>}
      {section.items.map(item => <button key={item.id} type="button" tabIndex={-1}
        role={selection ? 'menuitemradio' : 'menuitem'} aria-checked={selection ? item.checked === true : undefined}
        className={`menu-item ${item.danger ? 'is-danger' : ''}`} disabled={item.disabled} title={item.disabled ? item.disabledReason : undefined}
        onClick={() => { close(); item.onSelect() }}>
        {item.icon && <item.icon className="menu-item-icon" size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />}
        <span className="menu-item-text">
          <span className="menu-item-label">{item.label}{item.tag}</span>
          {(item.disabled && item.disabledReason ? item.disabledReason : item.description) && <span className="menu-item-description">{item.disabled && item.disabledReason ? item.disabledReason : item.description}</span>}
        </span>
        {selection && item.checked && <Check className="menu-item-check" size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />}
      </button>)}
    </div>)}
  </div>

  return <>
    {trigger({ ref: triggerRef, onClick: () => { if (open) close(); else setOpen(true) }, 'aria-haspopup': sheet ? 'dialog' : 'menu', 'aria-expanded': open })}
    {open && !sheet && <div ref={popover} className={`popover ${className}`} style={{ position: 'fixed', ...style }}>
      {content}
      {footer && <div className="menu-footer">{footer(() => close(false))}</div>}
    </div>}
    {open && sheet && <Modal label={label} variant="sheet" onClose={() => close()} className={className}>
      <ModalHeader title={label} onClose={() => close()} />
      <div className="sheet-body">{content}{footer && <div className="menu-footer">{footer(() => close(false))}</div>}</div>
    </Modal>}
  </>
}

export function ConfirmDialog({ title, message, confirmLabel, danger = false, onConfirm, onClose }: {
  title: string
  message: ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const viewport = useViewport()
  const confirm = async () => {
    setBusy(true); setError('')
    try { await onConfirm(); onClose() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作未完成，请重试。'); setBusy(false) }
  }
  return <Modal label={title} variant={viewport === 'phone' ? 'sheet' : 'dialog'} onClose={() => { if (!busy) onClose() }} className="confirm-dialog">
    <ModalHeader title={title} onClose={onClose} />
    <div className="modal-body"><p className="confirm-message">{message}</p>{error && <p className="inline-alert inline-alert-error" role="alert">{error}</p>}</div>
    <footer className="modal-footer">
      <button type="button" className="button secondary" disabled={busy} onClick={onClose}>取消</button>
      <button type="button" className={`button ${danger ? 'danger' : 'primary'}`} disabled={busy} onClick={() => { void confirm() }}>{busy && <Spinner size={14} />}{confirmLabel}</button>
    </footer>
  </Modal>
}

export function PromptDialog({ title, label, initial, confirmLabel = '保存', maxLength = 200, onSubmit, onClose }: {
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
  const viewport = useViewport()
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.select() }, [])
  const submit = async () => {
    if (!value.trim() || busy) return
    setBusy(true); setError('')
    try { await onSubmit(value.trim()); onClose() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败，请重试。'); setBusy(false) }
  }
  return <Modal label={title} variant={viewport === 'phone' ? 'sheet' : 'dialog'} onClose={() => { if (!busy) onClose() }} className="prompt-dialog">
    <form onSubmit={event => { event.preventDefault(); void submit() }}>
      <ModalHeader title={title} onClose={onClose} />
      <div className="modal-body">
        <label className="field"><span>{label}</span><input ref={input} value={value} maxLength={maxLength} autoComplete="off" onChange={event => { setValue(event.target.value) }} /></label>
        {error && <p className="inline-alert inline-alert-error" role="alert">{error}</p>}
      </div>
      <footer className="modal-footer">
        <button type="button" className="button secondary" disabled={busy} onClick={onClose}>取消</button>
        <button type="submit" className="button primary" disabled={busy || !value.trim()}>{busy && <Spinner size={14} />}{confirmLabel}</button>
      </footer>
    </form>
  </Modal>
}
