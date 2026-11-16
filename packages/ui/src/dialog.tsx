import {
  createContext,
  useContext,
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
import { CloseGlyph } from './glyphs/index.tsx'
import { IconButton } from './button.tsx'
import { motionAllowed } from './changes.ts'
import { cx, firstMeaningful, focusables, PHONE_QUERY, useMediaQuery } from './internal.ts'
import { EASING, MOTION, usePresence } from './motion.tsx'

/**
 * Opens and closes a native modal dialog with `open`. The browser makes the rest of the page inert; this keeps Tab
 * inside the dialog (it wraps from the last control to the first), moves focus in on opening and gives it back to
 * the control that had it on closing. Escape and a press on the scrim close it when `dismissible`. A modal opened while
 * another is open is marked `data-stacked`: only the outermost one dims and blurs the page, so the blur never doubles.
 */
function useModal(
  ref: RefObject<HTMLDialogElement | null>,
  open: boolean,
  onClose: () => void,
  dismissible: boolean,
): {
  closedby: 'none' | undefined
  onCancel: (event: { preventDefault: () => void; target: EventTarget; currentTarget: EventTarget }) => void
  onClose: (event: { currentTarget: HTMLDialogElement }) => void
  onPointerDown: (event: PointerEvent<HTMLDialogElement>) => void
  onClick: (event: MouseEvent<HTMLDialogElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLDialogElement>) => void
} {
  const restore = useRef<HTMLElement | null>(null)
  const pressedScrim = useRef(false)
  const latest = useRef({ open, onClose, dismissible })
  useLayoutEffect(() => {
    latest.current = { open, onClose, dismissible }
  })

  useLayoutEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      markStacked(dialog)
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
    // A repeated Escape reaches the dialog as a `cancel` that cannot be refused, so one that must stay opts out of them.
    closedby: dismissible ? undefined : 'none',
    onCancel: event => {
      // React passes the Escape of a dialog opened inside this one (a picker's sheet in a sheet) up the tree: only this
      // dialog's own closes it.
      if (event.target !== event.currentTarget) return
      // The dialog closes only through `open`, so its state stays with the caller.
      event.preventDefault()
      if (dismissible) latest.current.onClose()
    },
    onClose: event => {
      // The browser can still close it on its own (repeated Escape); report that as a close, or, where it must stay and
      // `closedby` is not supported, open it again. The event arrives a task later, so one from a close this hook made
      // and has since undone (a remount) finds the dialog open again.
      const dialog = event.currentTarget
      if (!latest.current.open || dialog.open) return
      if (latest.current.dismissible) latest.current.onClose()
      else {
        markStacked(dialog)
        dialog.showModal()
        focusInitial(dialog)
      }
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

/** Whether another modal dialog is already open under this one. */
function markStacked(dialog: HTMLDialogElement) {
  const under = Array.from(document.querySelectorAll('dialog')).some(other => other !== dialog && other.matches(':modal'))
  if (under) dialog.dataset.stacked = ''
  else delete dialog.dataset.stacked
}

/**
 * A control marked data-autofocus, else the first input, else the first meaningful control (never the close button,
 * which only ends the dialog), else the dialog itself.
 */
function focusInitial(dialog: HTMLDialogElement) {
  const target =
    dialog.querySelector<HTMLElement>('[data-autofocus]')
    ?? dialog.querySelector<HTMLElement>('input:not([type="hidden"]):not(:disabled), textarea:not(:disabled), select:not(:disabled)')
    ?? firstMeaningful(dialog)
  if (target) target.focus()
  else {
    dialog.tabIndex = -1
    dialog.focus()
  }
}

function giveBack(element: HTMLElement | null) {
  if (element?.isConnected) element.focus({ preventScroll: true })
}

/** What a modal's picture must not carry out of it: a security surface, a secret in a field, a frame that would load again. */
const NO_PICTURE = '[data-secure], input[type="password"], iframe, object, embed'

/** A still picture of a modal about to go, placed where it stands and out of everyone's way; null when it should not have one. */
function modalPicture(dialog: HTMLDialogElement): HTMLElement | null {
  const surface = dialog.querySelector<HTMLElement>(':scope > :is(.ui-modal-surface, .ui-sheet-surface)')
  if (!surface || !dialog.open || dialog.matches(NO_PICTURE) || dialog.querySelector(NO_PICTURE)) return null
  const picture = document.createElement('div')
  if (typeof picture.showPopover !== 'function') return null
  const box = dialog.getBoundingClientRect()
  picture.className = cx(dialog.className, 'ui-modal-ghost')
  picture.popover = 'manual'
  picture.inert = true
  picture.setAttribute('aria-hidden', 'true')
  Object.assign(picture.style, {
    position: 'fixed',
    inset: 'auto',
    margin: '0',
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    maxHeight: 'none',
    pointerEvents: 'none',
  })
  const copy = surface.cloneNode(true)
  if (!(copy instanceof HTMLElement)) return null
  // The source elements and the copies in document order, for what cloning leaves behind.
  const sources = surface.querySelectorAll('*')
  const copies = copy.querySelectorAll('*')
  copies.forEach((element, index) => {
    const source = sources[index]
    if (source && (source.scrollTop || source.scrollLeft)) {
      // Applied once it is in the document.
      element.setAttribute('data-scroll', `${source.scrollLeft} ${source.scrollTop}`)
    }
    // The picture must not answer for the real page: no duplicate ids, and no radio joining a group on the page.
    element.removeAttribute('id')
    element.removeAttribute('name')
  })
  for (const nested of copy.querySelectorAll('dialog, [popover], video, audio')) nested.remove()
  copy.style.animation = 'none'
  copy.style.height = '100%'
  copy.style.maxHeight = 'none'
  picture.append(copy)
  return picture
}

/** Plays the picture's exit: the scrim fades and the surface goes the way it came, each over 70% of --m-sheet. */
function playExit(picture: HTMLElement) {
  document.body.append(picture)
  picture.showPopover()
  for (const element of picture.querySelectorAll('[data-scroll]')) {
    const [left, top] = (element.getAttribute('data-scroll') ?? '').split(' ').map(Number)
    element.scrollTo(left ?? 0, top ?? 0)
  }
  const surface = picture.firstElementChild
  const moving = motionAllowed()
  const timing = { duration: moving ? MOTION.sheetExit : MOTION.microExit, easing: EASING.exit, fill: 'forwards' } as const
  const leaving = moving
    ? picture.classList.contains('ui-sheet')
      ? { translate: ['0 0', '0 100%'] }
      : { opacity: [1, 0], transform: ['scale(1)', 'scale(0.985)'] }
    : { opacity: [1, 0] }
  const animations = [surface?.animate(leaving, timing), picture.animate({ opacity: [1, 0] }, { ...timing, pseudoElement: '::backdrop' })]
  void Promise.allSettled(animations.map(animation => animation?.finished)).then(() => {
    picture.remove()
  })
}

/**
 * A modal goes by being unmounted, which leaves nothing to animate. So a still picture of it, taken just before React
 * removes it, plays the exit in the top layer: inert, hidden from assistive technology and letting the pointer through,
 * while focus is already back where it belongs. Nothing on a security surface or holding a secret leaves a picture; it
 * just goes.
 */
function useLeaveBehind(ref: RefObject<HTMLDialogElement | null>, enabled: boolean) {
  useLayoutEffect(() => {
    const dialog = ref.current
    if (!enabled || !dialog) return undefined
    return () => {
      const picture = modalPicture(dialog)
      // The development build's rehearsal of an unmount leaves the dialog in the document.
      if (picture)
        queueMicrotask(() => {
          if (!dialog.isConnected) playExit(picture)
        })
    }
  }, [ref, enabled])
}

/**
 * The dim layer behind a slide-over that is not a native dialog. It fades in with --m-sheet, and stays to fade out in
 * 70% of that after `open` turns false, taking no presses meanwhile. A press on it dismisses; the caller sets its z-index.
 */
export function Scrim({
  open,
  label,
  onDismiss,
  className,
}: {
  open: boolean
  /** The dismissal's accessible name: 关闭会话列表. */
  label: string
  onDismiss: () => void
  className?: string
}) {
  const { present, leaving } = usePresence(open, MOTION.sheetExit)
  if (!present) return null
  return (
    <button
      type="button"
      className={cx('ui-scrim', className)}
      aria-label={label}
      tabIndex={-1}
      data-leaving={leaving ? '' : undefined}
      onClick={leaving ? undefined : onDismiss}
    />
  )
}

/** A dialog's width, a step of the layer scale: md a confirmation, lg a form, xl two columns. */
export type DialogSize = 'md' | 'lg' | 'xl'

/** Inside a modal drawn as a phone sheet: how its header closes it and follows a drag. */
const InSheet = createContext<{ onClose: () => void; handle: SheetHandle } | null>(null)

/**
 * A content-owned modal, including full-window pages such as settings. Shares dismissal and focus with Dialog. On a
 * phone (`variant="sheet"`) it is the same bottom sheet as Sheet: grabber, drag to close, the close button on the
 * left of the header that ModalHeader draws.
 */
export function Modal({
  label,
  variant = 'dialog',
  size = 'md',
  onClose,
  children,
  className = '',
  secure = false,
  dismissible = true,
}: {
  label: string
  variant?: 'dialog' | 'sheet' | 'page'
  /** A dialog's width. */
  size?: DialogSize
  onClose: () => void
  children: ReactNode
  className?: string
  secure?: boolean
  /** False while only an answer inside it may end it: Escape and the scrim do nothing, however often they are tried. */
  dismissible?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const modal = useModal(ref, true, onClose, dismissible)
  const sheet = useSheetDrag(ref, onClose, dismissible, variant === 'sheet')
  useSheetHistory(variant === 'sheet', onClose, dismissible)
  useLeaveBehind(ref, variant !== 'page')
  if (variant === 'sheet')
    return (
      <dialog
        ref={ref}
        className={cx('ui-sheet', className)}
        data-detent="large"
        aria-label={label}
        data-secure={secure ? '' : undefined}
        {...modal}>
        <div className="ui-sheet-surface">
          <InSheet.Provider value={{ onClose, handle: sheet }}>{children}</InSheet.Provider>
        </div>
      </dialog>
    )
  return (
    <dialog
      ref={ref}
      className={cx('ui-modal', `ui-modal-${variant}`, className)}
      data-size={variant === 'dialog' ? size : undefined}
      aria-label={label}
      data-secure={secure ? '' : undefined}
      {...modal}>
      <div className="ui-modal-surface">{children}</div>
    </dialog>
  )
}

/**
 * A modal's header: the title and a close button; in a phone sheet, the sheet's own header with its grabber. Without
 * `onClose` (while only an answer inside may end it) there is no close button.
 */
export function ModalHeader({
  title,
  onClose,
  leading,
  closeLabel = '关闭',
}: {
  title: ReactNode
  onClose?: () => void
  leading?: ReactNode
  closeLabel?: string
}) {
  const sheet = useContext(InSheet)
  if (sheet)
    return (
      <div className="ui-sheet-top" {...sheet.handle} onPointerCancel={sheet.handle.onPointerUp}>
        <span className="ui-sheet-grabber" aria-hidden="true" />
        <header className="ui-sheet-header">
          {onClose ? <SheetClose label={closeLabel} onClose={onClose} /> : <span aria-hidden="true" />}
          <h2 className="ui-sheet-title">{title}</h2>
          <div className="ui-sheet-action">{leading}</div>
        </header>
      </div>
    )
  return (
    <header className="ui-modal-header">
      {leading}
      <h2>{title}</h2>
      {onClose && <IconButton label={closeLabel} icon={CloseGlyph} data-layer-close="" onClick={onClose} />}
    </header>
  )
}
/**
 * center: in the middle of the window. dock: 400 wide, 24px above the window's bottom edge, rising 12px as it fades
 * in and dropping 8px as it goes; for a short status that follows an action, such as the local confirmation, so it
 * covers as little of what the person was looking at as it can.
 */
export type DialogPlacement = 'center' | 'dock'

interface DialogContent {
  title: ReactNode
  subtitle?: ReactNode
  /** A bare dialog's 36px tile before the title: the state of what it reports. */
  icon?: ReactNode
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
 * A desktop dialog: md (400) for a confirmation, lg (560) for a form, xl (720) for two columns. A 56px header (title,
 * optional subtitle, close), the body with 24px sides, and a 56px footer on the sidebar's grey with up to two md buttons
 * on the right and a note on the left. It fades in from a scale of .985 over --m-sheet on the blurred scrim. A panel
 * whose changes apply at once has no 确定 button.
 */
export function Dialog({
  open,
  onClose,
  size = 'md',
  placement = 'center',
  dismissible = true,
  secure = false,
  className,
  ...content
}: DialogContent & {
  open: boolean
  onClose: () => void
  size?: DialogSize
  placement?: DialogPlacement
  dismissible?: boolean
  /** A security surface: the tokens are locked inside it and its look is pinned (tokens.css, the page's security layer). */
  secure?: boolean
  className?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const modal = useModal(ref, open, onClose, dismissible)
  // On a phone a dialog is the bottom sheet every other layer becomes; a status docked at the bottom stays itself.
  const sheet = useMediaQuery(PHONE_QUERY) && placement === 'center' && !content.bare
  const handle = useSheetDrag(ref, onClose, dismissible, sheet)
  useSheetHistory(open && sheet, onClose, dismissible)
  return (
    <dialog
      ref={ref}
      className={cx(sheet ? 'ui-sheet' : 'ui-dialog', className)}
      data-size={size}
      data-detent={sheet ? 'medium' : undefined}
      data-placement={placement === 'dock' ? 'dock' : undefined}
      data-secure={secure ? '' : undefined}
      aria-labelledby={titleId}
      {...modal}>
      {sheet ? (
        <div className="ui-sheet-surface">
          <div className="ui-sheet-top" {...handle} onPointerCancel={handle.onPointerUp}>
            <span className="ui-sheet-grabber" aria-hidden="true" />
            <header className="ui-sheet-header">
              <SheetClose label={content.closeLabel} onClose={onClose} />
              <h2 id={titleId} className="ui-sheet-title">
                {content.title}
              </h2>
              <div className="ui-sheet-action" />
            </header>
          </div>
          <div className="ui-sheet-body ui-dialog-body">
            {content.subtitle && <p className="ui-dialog-subtitle">{content.subtitle}</p>}
            {content.children}
          </div>
          {(content.footer || content.note) && (
            <footer className="ui-dialog-footer">
              {content.note && <div className="ui-dialog-note">{content.note}</div>}
              {content.footer}
            </footer>
          )}
        </div>
      ) : (
        <DialogSurface {...content} size={size} placement={placement} titleId={titleId} onClose={onClose} />
      )}
    </dialog>
  )
}

/** The dialog's surface on its own, laid out in place: what Dialog shows, for a static sheet of the design system. */
export function DialogSurface({
  title,
  subtitle,
  icon,
  footer,
  note,
  children,
  closeLabel = '关闭',
  bare = false,
  size = 'md',
  placement = 'center',
  titleId,
  onClose,
}: DialogContent & { size?: DialogSize; placement?: DialogPlacement; titleId?: string; onClose?: () => void }) {
  const heading = (
    <>
      <h2 id={titleId} className="ui-dialog-title">
        {title}
      </h2>
      {subtitle && <p className="ui-dialog-subtitle">{subtitle}</p>}
    </>
  )
  return (
    <div
      className="ui-dialog-surface"
      data-size={size}
      data-placement={placement === 'dock' ? 'dock' : undefined}
      data-bare={bare ? '' : undefined}>
      {bare ? (
        <div className="ui-dialog-body">
          {icon ? (
            <div className="ui-dialog-lead">
              <span className="ui-dialog-icon">{icon}</span>
              <div className="ui-dialog-heading">{heading}</div>
            </div>
          ) : (
            heading
          )}
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
            {onClose && <IconButton label={closeLabel} icon={CloseGlyph} data-layer-close="" onClick={onClose} />}
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
export type SheetDetent = 'medium' | 'large'

/**
 * Ties an open sheet to the page's navigation: called with the way to close the sheet when it opens, it returns the
 * call that says the sheet has closed some other way. A page gives its sheets places in the browser's history this way,
 * so the platform's back (the Android back button, the edge swipe, the browser's back) closes the top sheet instead of
 * leaving the page. Without a provider a sheet is only a dialog.
 */
export type OpenLayer = (close: () => void) => () => void
export const LayerHistory = createContext<OpenLayer | null>(null)

interface SheetContent {
  title: ReactNode
  /** Right of the title: a primary button (aria-disabled until it can act). The close button is always on the left. */
  action?: ReactNode
  children?: ReactNode
}

interface SheetHandle {
  onPointerDown: (event: PointerEvent<HTMLElement>) => void
  onPointerMove: (event: PointerEvent<HTMLElement>) => void
  onPointerUp: (event: PointerEvent<HTMLElement>) => void
}

/**
 * The drag of a sheet's top: it follows the finger down, closes past a third of the sheet's height or on a flick, and
 * dragged up takes a medium sheet to its large detent.
 */
function useSheetDrag(ref: RefObject<HTMLDialogElement | null>, onClose: () => void, dismissible: boolean, enabled = true): SheetHandle {
  const drag = useRef<{ y: number; time: number } | null>(null)
  return {
    onPointerDown: event => {
      if (!enabled || (event.target instanceof Element && event.target.closest('button'))) return
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
    onPointerMove: event => {
      if (!drag.current || !ref.current) return
      const dy = Math.max(0, event.clientY - drag.current.y)
      ref.current.style.transform = `translateY(${dy}px)`
    },
    onPointerUp: event => {
      const start = drag.current
      drag.current = null
      const dialog = ref.current
      if (!start || !dialog) return
      const dy = event.clientY - start.y
      const speed = dy / Math.max(1, event.timeStamp - start.time)
      const height = dialog.querySelector<HTMLElement>('.ui-sheet-surface')?.offsetHeight ?? 1
      if (dy < -24) dialog.dataset.detent = 'large' satisfies SheetDetent
      if (dismissible && (dy > height / 3 || speed > 0.5)) {
        // Closes from where the finger left it; the slide-out continues from that offset.
        onClose()
      } else dialog.style.removeProperty('transform')
    },
  }
}

/**
 * While open, a sheet holds a place in the page's navigation; going back there closes it as its close button would.
 */
function useSheetHistory(open: boolean, onClose: () => void, dismissible: boolean) {
  const layers = useContext(LayerHistory)
  const latestClose = useRef({ onClose, dismissible })
  useLayoutEffect(() => {
    latestClose.current = { onClose, dismissible }
  })
  useEffect(() => {
    if (!open || !layers) return undefined
    return layers(() => {
      if (latestClose.current.dismissible) latestClose.current.onClose()
    })
  }, [open, layers])
}

/** The one way a phone sheet closes from its header: an X on the left, named 关闭. */
function SheetClose({ label = '关闭', onClose }: { label?: string | undefined; onClose?: (() => void) | undefined }) {
  return <IconButton className="ui-sheet-close" size="lg" label={label} icon={CloseGlyph} data-layer-close="" onClick={onClose} />
}

/**
 * A phone bottom sheet on the sidebar's grey: a grabber, a 52px header (close · title · action) and the body. It
 * slides up over --m-sheet and follows a drag on its top: dragged down past a third of its height or flicked, it
 * closes; a tall sheet opens at 65% of the window and dragging up takes it to 92%. A form that needs the room (a new
 * session) stands at 92% with `detent="large"`, whatever it holds, so its header never moves as its content changes.
 * Popovers, menus and pickers turn into this sheet on phones, so every sheet closes the same way.
 */
export function Sheet({
  open,
  onClose,
  dismissible = true,
  detent = 'medium',
  className,
  ...content
}: SheetContent & {
  open: boolean
  onClose: () => void
  dismissible?: boolean
  /** Where it opens: up to 65% of the window (medium), or standing at 92% (large). */
  detent?: SheetDetent
  className?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const modal = useModal(ref, open, onClose, dismissible)
  const handle = useSheetDrag(ref, onClose, dismissible)
  useSheetHistory(open, onClose, dismissible)

  // Every opening starts at its own detent, wherever the last drag left the sheet.
  useLayoutEffect(() => {
    const dialog = ref.current
    if (!open || !dialog) return
    dialog.dataset.detent = detent
    dialog.style.removeProperty('transform')
  }, [open, detent])

  return (
    <dialog
      ref={ref}
      className={cx('ui-sheet', className)}
      data-detent={detent}
      data-fill={detent === 'large' ? '' : undefined}
      aria-labelledby={titleId}
      {...modal}>
      <SheetSurface {...content} titleId={titleId} onClose={onClose} handle={handle} />
    </dialog>
  )
}

/** The sheet's surface on its own, laid out in place: what Sheet shows, for a static sheet of the design system. */
export function SheetSurface({
  title,
  action,
  children,
  titleId,
  onClose,
  handle,
}: SheetContent & {
  titleId?: string
  onClose?: () => void
  handle?: SheetHandle
}) {
  return (
    <div className="ui-sheet-surface">
      <div className="ui-sheet-top" {...handle} onPointerCancel={handle?.onPointerUp}>
        <span className="ui-sheet-grabber" aria-hidden="true" />
        <header className="ui-sheet-header">
          <SheetClose onClose={onClose} />
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
