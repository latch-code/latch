import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { X } from 'lucide-react'
import { Button, IconButton } from './button.tsx'
import { cx, focusables } from './internal.ts'

/**
 * Opens and closes a native modal dialog with `open`. The browser makes the rest of the page inert; this keeps Tab
 * inside the dialog (it wraps from the last control to the first), moves focus in on opening and gives it back to
 * the control that had it on closing. Escape and a press on the scrim close it when `dismissible`.
 */
function useModal(
  ref: RefObject<HTMLDialogElement | null>,
  open: boolean,
  onClose: () => void,
  dismissible: boolean,
): {
  onCancel: (event: { preventDefault: () => void }) => void
  onClose: (event: { currentTarget: HTMLDialogElement }) => void
  onPointerDown: (event: PointerEvent<HTMLDialogElement>) => void
  onClick: (event: MouseEvent<HTMLDialogElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLDialogElement>) => void
} {
  const restore = useRef<HTMLElement | null>(null)
  const pressedScrim = useRef(false)
  const latest = useRef({ open, onClose })
  useLayoutEffect(() => {
    latest.current = { open, onClose }
  })

  useLayoutEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      dialog.showModal()
      focusInitial(dialog)
    } else if (!open && dialog.open) {
      dialog.close()
      giveBack(restore.current)
    }
  }, [open, ref])

  useEffect(() => {
    const dialog = ref.current
    return () => {
      if (dialog?.open) {
        dialog.close()
        giveBack(restore.current)
      }
    }
  }, [ref])

  return {
    onCancel: event => {
      // The dialog closes only through `open`, so its state stays with the caller.
      event.preventDefault()
      if (dismissible) latest.current.onClose()
    },
    onClose: event => {
      // The browser can still close it on its own (repeated Escape); report that as a close. The event arrives a task
      // later, so one from a close this hook made and has since undone (a remount) finds the dialog open again.
      if (latest.current.open && !event.currentTarget.open) latest.current.onClose()
    },
    onPointerDown: event => {
      pressedScrim.current = event.target === event.currentTarget
    },
    onClick: event => {
      // Only a press that starts and ends on the scrim closes it, never a text selection dragged out of the dialog.
      if (dismissible && pressedScrim.current && event.target === event.currentTarget) latest.current.onClose()
      pressedScrim.current = false
    },
    onKeyDown: event => {
      if (event.key !== 'Tab') return
      const items = focusables(event.currentTarget)
      const first = items[0]
      const last = items.at(-1)
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    },
  }
}

/** The first input (or a control marked data-autofocus), else the first control of the body, else the dialog itself. */
function focusInitial(dialog: HTMLDialogElement) {
  const target =
    dialog.querySelector<HTMLElement>('[data-autofocus]')
    ?? dialog.querySelector<HTMLElement>('input:not([type="hidden"]):not(:disabled), textarea:not(:disabled), select:not(:disabled)')
    ?? focusables(dialog.querySelector<HTMLElement>('.ui-dialog-body, .ui-sheet-body') ?? dialog)[0]
  if (target) target.focus()
  else {
    dialog.tabIndex = -1
    dialog.focus()
  }
}

function giveBack(element: HTMLElement | null) {
  if (element?.isConnected) element.focus({ preventScroll: true })
}

export type DialogSize = 'confirm' | 'form' | 'wide'

interface DialogContent {
  title: ReactNode
  subtitle?: ReactNode
  /** At most two md buttons: the secondary first, the primary last. */
  footer?: ReactNode
  /** The footer's left side: a note, a link or a ghost button. */
  note?: ReactNode
  children?: ReactNode
  closeLabel?: string
  /** No header or footer bars: a confirmation with 24px on every side. */
  bare?: boolean
}

/**
 * A desktop dialog: 480 for a confirmation, 560 for a form, 720 for two columns. A 56px header (title, optional
 * subtitle, close), a 24px body, a 64px footer with up to two md buttons on the right and a note on the left. It fades
 * in from 98% over 240ms on the scrim. A panel whose changes apply at once has no 确定 button.
 */
export function Dialog({
  open,
  onClose,
  size = 'confirm',
  dismissible = true,
  className,
  ...content
}: DialogContent & { open: boolean; onClose: () => void; size?: DialogSize; dismissible?: boolean; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const modal = useModal(ref, open, onClose, dismissible)
  return (
    <dialog ref={ref} className={cx('ui-dialog', className)} data-size={size} aria-labelledby={titleId} {...modal}>
      <DialogSurface {...content} size={size} titleId={titleId} onClose={onClose} />
    </dialog>
  )
}

/** The dialog's surface on its own, laid out in place: what Dialog shows, for a static sheet of the design system. */
export function DialogSurface({
  title,
  subtitle,
  footer,
  note,
  children,
  closeLabel = '关闭',
  bare = false,
  size = 'confirm',
  titleId,
  onClose,
}: DialogContent & { size?: DialogSize; titleId?: string; onClose?: () => void }) {
  return (
    <div className="ui-dialog-surface" data-size={size} data-bare={bare ? '' : undefined}>
      {bare ? (
        <div className="ui-dialog-body">
          <h2 id={titleId} className="ui-dialog-title">
            {title}
          </h2>
          {subtitle && <p className="ui-dialog-subtitle">{subtitle}</p>}
          {children}
          {footer && <div className="ui-dialog-actions">{footer}</div>}
        </div>
      ) : (
        <>
          <header className="ui-dialog-header">
            <div className="ui-dialog-heading">
              <h2 id={titleId} className="ui-dialog-title">
                {title}
              </h2>
              {subtitle && <p className="ui-dialog-subtitle">{subtitle}</p>}
            </div>
            {onClose && <IconButton label={closeLabel} icon={X} onClick={onClose} />}
          </header>
          {children !== undefined && <div className="ui-dialog-body">{children}</div>}
          {(footer || note) && (
            <footer className="ui-dialog-footer">
              {note && <div className="ui-dialog-note">{note}</div>}
              {footer}
            </footer>
          )}
        </>
      )}
    </div>
  )
}

/** Share of the window the sheet may take before it scrolls, and how far it opens when dragged up. */
type Detent = 'medium' | 'large'

interface SheetContent {
  title: ReactNode
  /** Left of the title: closes the sheet. */
  cancelLabel?: string
  /** Right of the title: a primary button (aria-disabled until it can act), or a secondary 完成 that only closes. */
  action?: ReactNode
  children?: ReactNode
}

/**
 * A phone bottom sheet on the ground colour: a grabber, a 52px header (取消 · title · action) and the body. It slides
 * up over 240ms and follows a drag on its top: dragged down past a third of its height or flicked, it closes; a tall
 * sheet opens at 65% of the window and dragging up takes it to 92%.
 */
export function Sheet({
  open,
  onClose,
  dismissible = true,
  className,
  ...content
}: SheetContent & { open: boolean; onClose: () => void; dismissible?: boolean; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const modal = useModal(ref, open, onClose, dismissible)
  const drag = useRef<{ y: number; time: number } | null>(null)

  // Every opening starts at the medium detent, wherever the last drag left the sheet.
  useLayoutEffect(() => {
    const dialog = ref.current
    if (!open || !dialog) return
    dialog.dataset.detent = 'medium' satisfies Detent
    dialog.style.removeProperty('transform')
  }, [open])

  const surface = () => ref.current?.querySelector<HTMLElement>('.ui-sheet-surface') ?? null
  const handle = {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.target instanceof Element && event.target.closest('button')) return
      // Keeps the drag when the finger leaves the header; a pointer the browser no longer tracks cannot be captured.
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          // The drag still works while the pointer stays over the header.
        }
      }
      drag.current = { y: event.clientY, time: event.timeStamp }
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      if (!drag.current || !ref.current) return
      const dy = Math.max(0, event.clientY - drag.current.y)
      ref.current.style.transform = `translateY(${dy}px)`
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      const start = drag.current
      drag.current = null
      const dialog = ref.current
      if (!start || !dialog) return
      const dy = event.clientY - start.y
      const speed = dy / Math.max(1, event.timeStamp - start.time)
      const height = surface()?.offsetHeight ?? 1
      if (dy < -24) dialog.dataset.detent = 'large' satisfies Detent
      if (dismissible && (dy > height / 3 || speed > 0.5)) {
        // Closes from where the finger left it; the slide-out continues from that offset.
        onClose()
      } else dialog.style.removeProperty('transform')
    },
  }

  return (
    <dialog ref={ref} className={cx('ui-sheet', className)} data-detent="medium" aria-labelledby={titleId} {...modal}>
      <SheetSurface {...content} titleId={titleId} onClose={onClose} handle={handle} />
    </dialog>
  )
}

/** The sheet's surface on its own, laid out in place: what Sheet shows, for a static sheet of the design system. */
export function SheetSurface({
  title,
  cancelLabel = '取消',
  action,
  children,
  titleId,
  onClose,
  handle,
}: SheetContent & {
  titleId?: string
  onClose?: () => void
  handle?: {
    onPointerDown: (event: PointerEvent<HTMLElement>) => void
    onPointerMove: (event: PointerEvent<HTMLElement>) => void
    onPointerUp: (event: PointerEvent<HTMLElement>) => void
  }
}) {
  return (
    <div className="ui-sheet-surface">
      <div className="ui-sheet-top" {...handle} onPointerCancel={handle?.onPointerUp}>
        <span className="ui-sheet-grabber" aria-hidden="true" />
        <header className="ui-sheet-header">
          <Button variant="ghost" className="ui-sheet-cancel" onClick={onClose}>
            {cancelLabel}
          </Button>
          <h2 id={titleId} className="ui-sheet-title">
            {title}
          </h2>
          <div className="ui-sheet-action">{action}</div>
        </header>
      </div>
      {children !== undefined && <div className="ui-sheet-body">{children}</div>}
    </div>
  )
}
