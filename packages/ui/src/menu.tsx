import { UI_COPY, useUiLocale } from './locale.ts'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react'
import {
  CheckGlyph,
  ChevronDownGlyph,
  ChevronLeftGlyph,
  ChevronRightGlyph,
  UpDownGlyph,
  BlockedGlyph,
  LockGlyph,
  ShieldAlertGlyph,
} from './glyphs/index.tsx'
import { motionAllowed } from './changes.ts'
import { ChoiceList } from './choice.tsx'
import { SearchField } from './field.tsx'
import { Sheet } from './dialog.tsx'
import { Icon, Spinner, type IconComponent } from './icon.tsx'
import { Kbd } from './pill.tsx'
import {
  cx,
  firstMeaningful,
  HOLD_MS,
  HOLD_SLOP,
  mergeRefs,
  nextIndex,
  onAnchorScrolled,
  PHONE_QUERY,
  pinLayer,
  pointAnchor,
  setPopover,
  useMediaQuery,
  useTypeahead,
} from './internal.ts'
import { Tooltip } from './tooltip.tsx'

// ---- The layer ----------------------------------------------------------------------------------------------------

/** The five widths of a layer (tokens.css --layer-*): a short value list, menus, panels, forms, two columns. */
export type LayerSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

export interface LayerPlacement {
  /** Settings rows and the inspector line the layer's right edge up with the trigger; the composer its left edge. */
  align?: 'start' | 'end'
  /** `auto` opens toward the side with more room, for a picker that can sit anywhere on the page. */
  side?: 'bottom' | 'top' | 'auto'
  /** Scrolls within past this height. */
  maxHeight?: number
  /**
   * The element the layer is placed against instead of its trigger, for two triggers that open the same panel and
   * should open it in one place. Only the placement: pressing the trigger still toggles it.
   */
  anchor?: ((trigger: HTMLElement) => HTMLElement) | undefined
}

/**
 * Open state of a layer pinned to a trigger: it is shown in the top layer (so no scrolling list or dialog clips it),
 * placed 6px from the trigger, and closed by a press outside, a scroll that moves the trigger (not one that only
 * settled it as the layer opened), Escape or Tab.
 * Closing with Escape or by choosing gives focus back to the trigger; a press elsewhere or Tab leaves it where it went.
 * A layer drawn as a bottom sheet (phones) has no popover element; the sheet handles its own dismissal.
 */
function useLayer(
  { align = 'start', side = 'bottom', maxHeight, anchor: placeAt }: LayerPlacement,
  onOpenChange?: (open: boolean) => void,
) {
  const trigger = useRef<HTMLButtonElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  // Opened by the context gesture on a row: the row stands in for the trigger, and the layer sits at the pointer (or
  // under the row, from the keyboard). Focus goes back to what had it in the row.
  const [from, setFrom] = useState<{ row: HTMLElement; point?: { x: number; y: number }; focus: HTMLElement | null } | null>(null)
  // The owner hears every opening and closing, whatever caused it (the trigger, a choice, a press outside, Escape).
  const notify = useRef(onOpenChange)
  useLayoutEffect(() => {
    notify.current = onOpenChange
  })
  const reported = useRef(false)
  useEffect(() => {
    if (reported.current === open) return
    reported.current = open
    notify.current?.(open)
  }, [open])
  // Shown before it is placed: a hidden popover has no size to measure.
  useLayoutEffect(() => {
    const element = layer.current
    setPopover(element, open)
    const anchor = from?.row ?? (trigger.current && placeAt ? placeAt(trigger.current) : trigger.current)
    if (!open || !element || !anchor) return undefined
    if (from?.point)
      return pinLayer(pointAnchor(from.point.x, from.point.y), element, { align: 'start', side: 'bottom', gap: 2, maxHeight })
    return pinLayer(anchor, element, { align: from ? 'start' : align, side, gap: 6, maxHeight, growAway: true })
  }, [open, align, side, maxHeight, from, placeAt])
  useEffect(() => {
    const element = layer.current
    const anchor = from?.row ?? trigger.current
    if (!open || !element || !anchor) return undefined
    const outside = (event: Event) => {
      const target = event.target instanceof Node ? event.target : null
      // A press anywhere in the row closes a menu opened from the row; one on its own trigger is the trigger's to toggle.
      if (element.contains(target) || (!from && anchor.contains(target))) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', outside, true)
    const stopWatching = onAnchorScrolled(anchor, () => {
      setOpen(false)
    })
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      stopWatching()
    }
  }, [open, from])
  const close = (restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) (from ? from.focus : trigger.current)?.focus({ preventScroll: true })
  }
  /** Opens from the trigger; a press on it while a context menu is open closes that one. */
  // Stable, as the state setter they stand in for: owners list them in effects.
  const toggle = useCallback((next: boolean | ((open: boolean) => boolean)) => {
    setFrom(null)
    setOpen(next)
  }, [])
  const openFrom = useCallback((row: HTMLElement, point: { x: number; y: number } | undefined, focus: HTMLElement | null) => {
    setFrom({ row, ...(point ? { point } : {}), focus })
    setOpen(true)
  }, [])
  return { trigger, layer, open, setOpen: toggle, close, openFrom }
}

/**
 * Whether a context gesture on `target` keeps the browser's own menu: text the person may want to copy or edit (a field,
 * an editable region, a link, code) or a selection that reaches it. Exported for its test.
 */
export function keepsNativeMenu(target: EventTarget | null, selection: Selection | null = getSelection()): boolean {
  if (!(target instanceof Element)) return false
  // xterm moves its hidden input under the pointer on a right click; the screen's menu has 复制 instead.
  if (target.closest('.xterm')) return false
  if (target.closest('input, textarea, select, a[href], [contenteditable]:not([contenteditable="false"]), pre, code')) return true
  return !!selection && !selection.isCollapsed && selection.containsNode(target, true)
}

/**
 * The context gesture on `row` opens its menu: a right click at the pointer, a press and hold on touch (the click that
 * ends the hold does not also press the row), and the context-menu key or ⇧F10 under the row. Text keeps the browser's
 * menu (`keepsNativeMenu`).
 */
function useContextGesture(
  resolve: () => HTMLElement | null | undefined,
  openFrom: (row: HTMLElement, point: { x: number; y: number } | undefined, focus: HTMLElement | null) => void,
  enabled: boolean,
) {
  const opener = useRef(openFrom)
  useLayoutEffect(() => {
    opener.current = openFrom
  })
  const find = useRef(resolve)
  find.current = resolve
  useEffect(() => {
    const row = find.current()
    if (!enabled || !row) return undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let start: { x: number; y: number } | null = null
    let held = false
    // A press and hold also fires contextmenu on some touch browsers, and the key fires it after keydown.
    let opened = 0
    const focusIn = () =>
      document.activeElement instanceof HTMLElement && row.contains(document.activeElement) ? document.activeElement : null
    const open = (point: { x: number; y: number } | undefined, focus: HTMLElement | null) => {
      opened = performance.now()
      opener.current(row, point, focus ?? row.querySelector<HTMLElement>('button, [tabindex]'))
    }
    const contextmenu = (event: MouseEvent) => {
      if (keepsNativeMenu(event.target)) return
      event.preventDefault()
      event.stopPropagation()
      if (performance.now() - opened < 600) return
      open({ x: event.clientX, y: event.clientY }, focusIn())
    }
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (!(event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) || keepsNativeMenu(event.target)) return
      event.preventDefault()
      event.stopPropagation()
      open(undefined, event.target instanceof HTMLElement ? event.target : focusIn())
    }
    const cancel = () => {
      clearTimeout(timer)
      start = null
    }
    const down = (event: PointerEvent) => {
      held = false
      if (event.pointerType === 'mouse' || keepsNativeMenu(event.target, null)) return
      start = { x: event.clientX, y: event.clientY }
      clearTimeout(timer)
      timer = setTimeout(() => {
        held = true
        const point = start
        start = null
        open(point ?? undefined, null)
      }, HOLD_MS)
    }
    const move = (event: PointerEvent) => {
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > HOLD_SLOP) cancel()
    }
    const click = (event: MouseEvent) => {
      if (!held) return
      held = false
      event.preventDefault()
      event.stopPropagation()
    }
    // A tooltip inside the row leaves its press and hold to this menu.
    row.dataset.contextGesture = ''
    row.addEventListener('contextmenu', contextmenu)
    row.addEventListener('keydown', keydown)
    row.addEventListener('pointerdown', down)
    row.addEventListener('pointermove', move)
    row.addEventListener('pointerup', cancel)
    row.addEventListener('pointercancel', cancel)
    row.addEventListener('pointerleave', cancel)
    row.addEventListener('click', click, true)
    return () => {
      cancel()
      delete row.dataset.contextGesture
      row.removeEventListener('contextmenu', contextmenu)
      row.removeEventListener('keydown', keydown)
      row.removeEventListener('pointerdown', down)
      row.removeEventListener('pointermove', move)
      row.removeEventListener('pointerup', cancel)
      row.removeEventListener('pointercancel', cancel)
      row.removeEventListener('pointerleave', cancel)
      row.removeEventListener('click', click, true)
    }
  }, [enabled])
}

/** Closes the layer something is shown in, giving focus back to its trigger; outside a layer it does nothing. */
const LayerClose = createContext<() => void>(() => {})

/** Inside a menu's list, where the arrow keys move between items (a footer row is one of them). */
export const InMenu = createContext(false)

/**
 * Whether the layer something is shown in is open; null outside a layer. Content that stays mounted while its layer is
 * shut (a picker's panel, a popover's body) starts over and takes focus when this turns true.
 */
const LayerOpen = createContext<boolean | null>(null)

export function useLayerOpen(): boolean | null {
  return useContext(LayerOpen)
}

/**
 * For content inside a menu's, picker's or popover's layer (a footer action, a small form shown in the menu's place):
 * the function that closes that layer once the content is done, focus going back to the trigger.
 */
export function useLayerClose(): () => void {
  return useContext(LayerClose)
}

// ---- Menu items ---------------------------------------------------------------------------------------------------

export interface MenuItem {
  id: string
  label: string
  /** A visual rendering of the label, for example one that keeps the end in view. The plain label names the row and its tooltip. */
  labelContent?: ReactElement
  /** One line under the label. */
  description?: string | ReactElement
  /** Action menus: a leading 14px glyph. Selection menus put the check in this slot instead. */
  icon?: IconComponent
  /** Right after the label, for example the 默认 small badge. */
  tag?: ReactNode
  /** The one trailing element: meta text, a small badge or a kbd. */
  meta?: ReactNode
  /**
   * One letter (A–Z) that chooses the item while the menu is open, shown at the row's end where `meta` is absent. Without
   * a modifier and outside composition only; it takes precedence over typeahead.
   */
  accelerator?: string
  /** A tile or avatar between the leading slot and the label: the value's own picture (a harness, a model service). */
  media?: ReactNode
  /** Selection menus: the chosen item, with an ink check and its label at 500. */
  checked?: boolean
  /** A destructive action (删除…): red text, placed last after a separator. */
  danger?: boolean
  /** Why it cannot be chosen. It stays focusable, dims, and the reason (read out with it) stays at full strength. */
  disabledReason?: string
  /** More about the item on hover, kept off the row: where a program is, a whole name. */
  hint?: string
  onSelect: () => void
}

/** Opens a single-choice list in the same layer. Options are actions and cannot open another list. */
export interface MenuChoiceItem extends Omit<MenuItem, 'onSelect'> {
  choices: MenuItem[]
  onSelect?: never
}

type MenuEntry = MenuItem | MenuChoiceItem

export interface MenuSection {
  id: string
  /** A group heading inside the menu. */
  label?: string
  /** A 16px tile before the heading, for example the model service a group of models comes from. */
  media?: ReactNode
  /** More about the heading, on hover and read out with the group: where its choices go, not a row of its own. */
  hint?: string
  items: MenuEntry[]
}

export interface MenuHeader {
  /** Whom the menu acts on, for example 「在这台电脑上发起的会话」. */
  title: string
  meta?: string
}

/**
 * The menu's accessible name: its label, followed by whom it acts on unless the header only repeats the label
 * (「权限：在这台电脑上发起的会话」). The header itself is drawn for sight only.
 */
function headedName(label: string, header: MenuHeader | undefined): string {
  return header && header.title !== label ? `${label}：${header.title}` : label
}

interface PanelProps {
  label: string
  header?: MenuHeader
  sections: MenuSection[]
  /** Items are radios (menuitemradio) and the chosen one carries the check. */
  selection?: boolean
  /** A row under a separator: a link to where the setting lives, or a note with a lock. */
  footer?: ReactNode
  /** Called with the item before the owner closes the menu. */
  onChoose?: (item: MenuItem) => void
  /** Escape or Tab inside the menu. */
  onDismiss?: (reason: 'escape' | 'tab') => void
  /** Each opening starts at the main menu, even if the previous exit kept the choices mounted. */
  open?: boolean
  panelRef?: Ref<HTMLDivElement>
  /** A static rendering in place (a design sheet); the live menus render it inside their layer. */
  className?: string
}

/** Items that can take focus in a menu: every item, disabled ones too, so their reasons can be read. */
function itemsOf(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]'))
}

/**
 * The list of a menu, inside the layer that draws its surface (glass, 8px corners and 4px inside, at least 220 wide;
 * the width a caller gives is the layer's outer width). Rows are 28 (44 with a description), radius 6; the
 * hover is instant. The leading slot is there only when something can fill it (a selection's check, an item's glyph);
 * a menu of plain actions starts its text at the menu's padding. ↑/↓ move through every item (a disabled one too,
 * which reads out its reason), Home and End go to the ends, typing jumps to the next label that starts with the typed
 * letters (an item's `accelerator` letter chooses it at once), Enter or Space chooses. Danger items come last, after a
 * separator.
 */
export function MenuPanel({
  label,
  header,
  sections,
  selection = false,
  footer,
  onChoose,
  onDismiss,
  open = true,
  panelRef,
  className,
}: PanelProps) {
  const id = useId()
  const panel = useRef<HTMLDivElement>(null)
  const typeahead = useTypeahead()
  const [view, setView] = useState<{ open: boolean; choiceId?: string; returnTo?: string }>({ open })
  const choice = view.choiceId
    ? sections
        .flatMap(section => section.items)
        .find((item): item is MenuChoiceItem => item.id === view.choiceId && 'choices' in item && item.disabledReason === undefined)
    : undefined
  if (view.open !== open) setView(open ? { open } : { ...view, open })
  else if (open && view.choiceId && !choice) setView({ open, returnTo: view.choiceId })
  const choiceId = choice?.id
  useLayoutEffect(() => {
    const element = panel.current
    if (!open || !element) return
    if (choiceId) {
      focusInto(element, true)
    } else if (view.returnTo) {
      const entry = itemsOf(element).find(item => item.dataset.choice === view.returnTo)
      if (entry) entry.focus()
      else focusInto(element)
    }
  }, [open, choiceId, view.returnTo])

  const shown: MenuSection[] = choice ? [{ id: choice.id, items: choice.choices }] : sections
  const visible = shown.filter(section => section.items.length > 0)
  const ordered = [
    ...visible.map(section => ({ ...section, items: section.items.filter(item => !item.danger) })),
    { id: `${id}-danger`, items: visible.flatMap(section => section.items.filter(item => item.danger)) },
  ].filter(section => section.items.length > 0)
  const asRadios = selection || choice !== undefined
  const leads = asRadios || visible.some(section => section.items.some(item => item.icon !== undefined))
  const back = () => {
    if (choice) setView({ open, returnTo: choice.id })
  }
  const choose = (item: MenuEntry) => {
    if (item.disabledReason !== undefined) return
    if ('choices' in item) setView({ open, choiceId: item.id })
    else onChoose?.(item)
  }

  const keydown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = itemsOf(event.currentTarget)
    const current = items.findIndex(item => item === document.activeElement)
    if (choice && (event.key === 'Escape' || event.key === 'ArrowLeft')) {
      event.preventDefault()
      event.stopPropagation()
      back()
      return
    }
    const choiceFromFocus = items[current]?.dataset.choice
    if (event.key === 'ArrowRight' && choiceFromFocus !== undefined) {
      const entry = visible.flatMap(section => section.items).find(item => item.id === choiceFromFocus)
      if (entry) {
        event.preventDefault()
        choose(entry)
        return
      }
    }
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
      }
      onDismiss?.(event.key === 'Escape' ? 'escape' : 'tab')
      return
    }
    const letter = event.key.length === 1 && /^[a-z]$/iu.test(event.key) ? event.key.toUpperCase() : undefined
    const keyed =
      letter
      && !event.metaKey
      && !event.ctrlKey
      && !event.altKey
      && !event.nativeEvent.isComposing
      && !(event.target instanceof HTMLInputElement)
        ? visible.flatMap(section => section.items).find(item => item.accelerator?.toUpperCase() === letter)
        : undefined
    if (keyed) {
      event.preventDefault()
      choose(keyed)
      return
    }
    const next =
      nextIndex(event.key, current < 0 ? (event.key === 'ArrowUp' ? 0 : -1) : current, items.length, 'vertical', () => true)
      ?? (event.target instanceof HTMLInputElement
        ? undefined
        : typeahead(
            event.key,
            items.map(item => item.dataset.label ?? ''),
            current,
          ))
    if (next === undefined) return
    event.preventDefault()
    items[next]?.focus()
  }

  return (
    <div
      ref={mergeRefs(panelRef, panel)}
      className={cx('ui-menu', className)}
      data-no-lead={leads ? undefined : ''}
      role="menu"
      aria-label={choice?.label ?? headedName(label, header)}
      aria-describedby={!choice && header?.meta ? `${id}-meta` : undefined}
      onKeyDown={keydown}>
      {choice && <MenuChoiceBack title={choice.label} onBack={back} />}
      {header && !choice && (
        <div className="ui-menu-header" aria-hidden="true">
          <span>{header.title}</span>
          {header.meta && (
            <span id={`${id}-meta`} className="ui-menu-header-meta">
              {header.meta}
            </span>
          )}
        </div>
      )}
      {ordered.map((section, index) => (
        <div
          key={section.id}
          className="ui-menu-section"
          role="group"
          aria-label={section.label}
          {...(section.hint ? { 'aria-description': section.hint } : {})}>
          {index > 0 && section.items[0]?.danger && <div className="ui-menu-separator" role="separator" />}
          {section.label && (
            <div className="ui-menu-section-label" aria-hidden="true" {...(section.hint ? { title: section.hint } : {})}>
              {section.media}
              {section.label}
            </div>
          )}
          {section.items.map(item => (
            <MenuRow key={item.id} item={item} selection={asRadios} onChoose={choose} />
          ))}
        </div>
      ))}
      {footer && !choice && (
        <div className="ui-menu-footer">
          <InMenu.Provider value>{footer}</InMenu.Provider>
        </div>
      )}
    </div>
  )
}

function MenuChoiceBack({ title, onBack }: { title: string; onBack: () => void }) {
  useUiLocale()
  return (
    <MenuRow
      item={{ id: 'back', label: UI_COPY.back, icon: ChevronLeftGlyph, meta: title, onSelect: onBack }}
      selection={false}
      onChoose={onBack}
    />
  )
}

function MenuRow({ item, selection, onChoose }: { item: MenuEntry; selection: boolean; onChoose: (item: MenuEntry) => void }) {
  const id = useId()
  const disabled = item.disabledReason !== undefined
  const hasChoices = 'choices' in item
  const value = hasChoices ? item.choices.find(option => option.checked)?.label : undefined
  const described = [item.description ? `${id}-description` : '', disabled ? `${id}-reason` : '', value ? `${id}-value` : '']
    .filter(Boolean)
    .join(' ')
  const lead = selection ? (
    item.checked ? (
      <Icon icon={CheckGlyph} size={14} className="ui-menu-check" />
    ) : null
  ) : item.icon ? (
    <Icon icon={item.icon} size={14} />
  ) : null
  const button = (
    <button
      type="button"
      tabIndex={-1}
      role={selection ? 'menuitemradio' : 'menuitem'}
      className="ui-menu-item"
      title={item.labelContent ? undefined : item.hint}
      data-label={item.label}
      data-choice={hasChoices ? item.id : undefined}
      data-two-line={item.description || disabled ? '' : undefined}
      data-media={item.media ? '' : undefined}
      data-danger={item.danger ? '' : undefined}
      aria-checked={selection ? item.checked === true : undefined}
      aria-disabled={disabled || undefined}
      aria-keyshortcuts={item.accelerator?.toUpperCase()}
      aria-haspopup={hasChoices ? 'menu' : undefined}
      aria-label={item.labelContent ? item.label : undefined}
      aria-labelledby={item.labelContent ? undefined : `${id}-label`}
      aria-describedby={described || undefined}
      onClick={() => {
        if (!disabled) onChoose(item)
      }}>
      <span className="ui-menu-item-lead">{lead}</span>
      {item.media && <span className="ui-menu-item-media">{item.media}</span>}
      <span className="ui-menu-item-text">
        <span id={`${id}-label`} className="ui-menu-item-label">
          <span className="ui-menu-item-title">{item.labelContent ?? item.label}</span>
          {item.tag}
        </span>
        {item.description && (
          <span id={`${id}-description`} className="ui-menu-item-description">
            {item.description}
          </span>
        )}
        {disabled && (
          <span id={`${id}-reason`} className="ui-menu-item-reason">
            <Icon icon={BlockedGlyph} size={12} />
            {item.disabledReason}
          </span>
        )}
      </span>
      {hasChoices ? (
        <span className="ui-menu-item-meta" data-choices>
          {value && <span id={`${id}-value`}>{value}</span>}
          <Icon icon={ChevronRightGlyph} size={12} />
        </span>
      ) : item.meta !== undefined ? (
        <span className="ui-menu-item-meta">{item.meta}</span>
      ) : item.accelerator ? (
        <span className="ui-menu-item-meta" aria-hidden="true">
          <Kbd>{item.accelerator.toUpperCase()}</Kbd>
        </span>
      ) : null}
    </button>
  )
  return item.labelContent ? (
    <Tooltip content={item.hint ?? item.label} describe={item.hint !== undefined}>
      {button}
    </Tooltip>
  ) : (
    button
  )
}

/**
 * A menu footer row that goes to where the setting lives, ending in chevron-right (「管理项目…」). It keeps the
 * items' empty leading slot, so its text starts on their titles' column. An action that stays here (「撤销切换」, 「添加
 * 模型服务…」 that turns the layer into a small form) leaves the chevron out and may put a 14px glyph in the slot.
 * `closes` closes the layer before running the action, as choosing an item does. Outside a menu's list (under a list
 * of buttons in a popover, in a sheet) it is an ordinary button in the Tab order, and without a glyph it has no slot.
 */
export function MenuFooterLink({
  children,
  onClick,
  icon,
  chevron = true,
  closes = false,
}: {
  children: ReactNode
  onClick: () => void
  icon?: IconComponent
  /** Goes elsewhere (the default): ends in chevron-right. */
  chevron?: boolean
  closes?: boolean
}) {
  const close = useLayerClose()
  const inMenu = useContext(InMenu)
  return (
    <button
      type="button"
      role={inMenu ? 'menuitem' : undefined}
      tabIndex={inMenu ? -1 : undefined}
      className="ui-menu-footer-link"
      data-label={inMenu ? '' : undefined}
      data-no-lead={inMenu || icon ? undefined : ''}
      onClick={() => {
        if (closes) close()
        onClick()
      }}>
      {(inMenu || icon) && <span className="ui-menu-item-lead">{icon && <Icon icon={icon} size={14} />}</span>}
      <span className="ui-menu-footer-text">{children}</span>
      {chevron && <Icon icon={ChevronRightGlyph} size={12} />}
    </button>
  )
}

/**
 * A menu footer note for what can only change elsewhere (「在 Mac 上的 Latch 里添加项目」): the lock in the items' leading
 * slot, the note on their titles' column. A note that is no restriction passes its own glyph (`info` for how to get
 * there, `circle-alert` for something that went wrong), so the lock keeps meaning a refusal.
 */
export function MenuFooterNote({ children, icon = LockGlyph }: { children: ReactNode; icon?: IconComponent }) {
  return (
    <p className="ui-menu-footer-note">
      <Icon icon={icon} size={12} />
      <span className="ui-menu-footer-text">{children}</span>
    </p>
  )
}

/**
 * The search row of a long picker stays at the top while the results scroll.
 */
export function MenuSearch({
  label,
  value,
  onValueChange,
  onKeyDown,
}: {
  /** What is searched (模型); the input is named 「搜索模型」. */
  label: string
  value: string
  onValueChange: (value: string) => void
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void
}) {
  useUiLocale()
  return (
    <div className="ui-menu-search">
      <SearchField variant="ghost" label={UI_COPY.searchIn(label)} value={value} onValueChange={onValueChange} onKeyDown={onKeyDown} />
    </div>
  )
}

// ---- Action menu --------------------------------------------------------------------------------------------------

export interface MenuTriggerProps {
  ref: RefObject<HTMLButtonElement | null>
  onClick: () => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
  'aria-haspopup': 'menu' | 'dialog'
  'aria-expanded': boolean
}

/** Focuses the checked item, else the first one, once the layer is shown. */
function focusInto(panel: HTMLElement | null, scrollIntoView = false) {
  if (!panel) return
  const items = itemsOf(panel)
  const search = panel.querySelector<HTMLInputElement>('.ui-menu-search input')
  ;(search ?? items.find(item => item.getAttribute('aria-checked') === 'true') ?? items[0])?.focus({ preventScroll: !scrollIntoView })
}

/**
 * A menu of actions opened by a trigger the caller draws (a ⋯ icon button, a title button with chevron-down). Space,
 * Enter and ↓ on the trigger open it with focus on the first item. On phones it is a bottom sheet. With `context` the
 * same menu also opens from its row's context gesture (right click at the pointer, press and hold, the context-menu
 * key), so a row has one list of actions whichever way it is asked; a row with no ⋯ passes no trigger.
 */
export function Menu({
  label,
  title,
  trigger,
  context,
  sections,
  header,
  footer,
  size = 'xs',
  selection = false,
  frosted = false,
  previewOnHover = false,
  className,
  ...placement
}: Omit<PanelProps, 'onChoose' | 'onDismiss' | 'open' | 'panelRef'>
  & LayerPlacement & {
    trigger?: (props: MenuTriggerProps) => ReactNode
    /** The row whose context gesture opens this menu: the element, or how to find it from the trigger (or from where
     * the menu is written, when it has none). */
    context?: RefObject<HTMLElement | null> | ((trigger: HTMLElement | null) => HTMLElement | null)
    /** The layer's width, a step of the scale. */
    size?: LayerSize
    /** A floating menu may use the device's surface preference. Phone sheets remain solid. */
    frosted?: boolean
    /** An action button can show its alternatives on hover or keyboard focus without taking focus from the editor. */
    previewOnHover?: boolean
    title?: string
  }) {
  const phone = useMediaQuery(previewOnHover ? `${PHONE_QUERY} and (hover: none)` : PHONE_QUERY)
  const panel = useRef<HTMLDivElement>(null)
  const { trigger: triggerRef, layer, open, setOpen, close, openFrom } = useLayer(placement)
  const preview = useRef(false)
  useEffect(() => {
    const button = triggerRef.current
    const menu = layer.current
    if (!previewOnHover || phone || !button || !menu) return undefined
    let timer: ReturnType<typeof setTimeout>
    const stay = () => clearTimeout(timer)
    const show = () => {
      stay()
      if (open || button.getAttribute('aria-disabled') === 'true') return
      preview.current = true
      setOpen(true)
    }
    const enter = (event: PointerEvent) => {
      if (event.pointerType === 'mouse') show()
    }
    const focus = () => {
      if (button.matches(':focus-visible')) show()
    }
    const leave = () => {
      stay()
      // Allow the pointer to cross the gap between the trigger and its menu.
      timer = setTimeout(() => {
        if (preview.current && !button.matches(':focus-visible') && !menu.contains(document.activeElement)) setOpen(false)
      }, 160)
    }
    const escape = (event: globalThis.KeyboardEvent) => {
      if (!open || !preview.current || event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }
    button.addEventListener('pointerenter', enter)
    button.addEventListener('pointerleave', leave)
    button.addEventListener('focus', focus)
    button.addEventListener('blur', leave)
    menu.addEventListener('pointerenter', stay)
    menu.addEventListener('pointerleave', leave)
    document.addEventListener('keydown', escape, true)
    return () => {
      stay()
      button.removeEventListener('pointerenter', enter)
      button.removeEventListener('pointerleave', leave)
      button.removeEventListener('focus', focus)
      button.removeEventListener('blur', leave)
      menu.removeEventListener('pointerenter', stay)
      menu.removeEventListener('pointerleave', leave)
      document.removeEventListener('keydown', escape, true)
    }
  }, [previewOnHover, phone, open, setOpen, triggerRef, layer])
  // Without a trigger, a hidden mark where the menu is written lets `context` find its row the same way.
  const mark = useRef<HTMLSpanElement>(null)
  useContextGesture(
    () => (typeof context === 'function' ? context(triggerRef.current ?? mark.current) : context?.current),
    openFrom,
    context !== undefined && sections.some(section => section.items.length > 0),
  )
  // In a sheet too: its items are out of the Tab order, so the sheet itself does not move focus onto them.
  useEffect(() => {
    if (!open) preview.current = false
    else if (!preview.current) focusInto(panel.current)
  }, [open])
  const choose = (item: MenuItem) => {
    close(!phone)
    item.onSelect()
  }
  const content = (
    <LayerClose.Provider
      value={() => {
        close(!phone)
      }}>
      <MenuPanel
        label={label}
        header={header}
        sections={sections}
        footer={footer}
        selection={selection}
        open={open}
        className={className}
        panelRef={panel}
        onChoose={choose}
        onDismiss={reason => {
          close(reason === 'escape')
        }}
      />
    </LayerClose.Provider>
  )
  return (
    <>
      {!trigger && <span ref={mark} hidden />}
      {trigger?.({
        ref: triggerRef,
        onClick: () => {
          preview.current = false
          setOpen(!open)
        },
        onKeyDown: event => {
          if (event.key === 'ArrowDown' && (!open || preview.current)) {
            event.preventDefault()
            preview.current = false
            if (open) focusInto(panel.current)
            else setOpen(true)
          }
        },
        'aria-haspopup': phone ? 'dialog' : 'menu',
        'aria-expanded': open,
      })}
      {phone ? (
        <Sheet
          open={open}
          title={title ?? label}
          onClose={() => {
            close(true)
          }}>
          {content}
        </Sheet>
      ) : (
        <div ref={layer} popover="manual" className="ui-popover" data-size={size} data-frosted={frosted ? '' : undefined}>
          {content}
        </div>
      )}
    </>
  )
}

// ---- Value picker -------------------------------------------------------------------------------------------------

export interface PickerOption<T extends string> {
  value: T
  label: string
  description?: string | ReactElement
  /** Right after the label, for example the 默认 small badge. */
  tag?: ReactNode
  meta?: ReactNode
  /** A value with real risk (完全访问): once chosen, the trigger leads with an amber shield-alert. */
  risk?: boolean
  disabledReason?: string
  /** The value's own picture in the menu (a 20px tile), after the check slot. */
  media?: ReactNode
  /** More about the value on hover (`MenuItem.hint`). */
  hint?: string
}

export interface PickerGroup<T extends string> {
  id: string
  label?: string
  /** A 16px tile before the group's heading. */
  media?: ReactNode
  /** More about the heading, on hover (`MenuSection.hint`). */
  hint?: string
  options: Array<PickerOption<T>>
}

export interface ValuePickerProps<T extends string> extends LayerPlacement {
  /** What the value is (模型, 权限); read before the value by screen readers and used as the sheet's title. */
  label: string
  value: T | undefined
  options?: Array<PickerOption<T>>
  /** Options in headed groups, instead of `options`. */
  groups?: Array<PickerGroup<T>>
  /** Choosing applies at once. A returned promise (a raise that needs verification) shows 「等待验证…」 until it settles. */
  onValueChange: (value: T) => void | Promise<void>
  /** A 14px glyph that serves as the label where there is no text label (the context row), or a 16px tile or avatar. */
  leading?: IconComponent | ReactNode
  /** After the value and before the arrow, in muted ink: a second value the same panel sets (a model's 思考 level). */
  trailing?: ReactNode
  /**
   * After `trailing`, before the arrow, drawn even while a write is pending: a state the trigger must always show (the
   * session's permission, which the same panel sets).
   */
  mark?: ReactNode
  /** Shown in muted ink when nothing is chosen (「选择模型」), never in a warning colour. */
  placeholder?: string
  /** xs: 24 with 6px corners, for the inspector. */
  size?: 'sm' | 'xs'
  /** Reaches 6px past the column on the end (a settings row) or both sides (the inspector), so text and arrow line up. */
  bleed?: 'end' | 'both'
  /** hover: the arrow appears only on hover or focus, as in the inspector's column of values. */
  chevron?: 'always' | 'hover'
  /** A toolbar control reads as a menu that opens one way, not a value to step through. */
  menuChevron?: boolean
  /** Waiting for verification, set by the caller; a promise from onValueChange sets it as well. */
  pending?: boolean
  pendingLabel?: string
  /**
   * For a start-aligned toolbar picker that can wait for verification: it keeps
   * room for the wider of the value and the pending label, so the arrow and what follows do not shift. The value still
   * starts right after the leading slot. The inspector's xs size and the phone row never reserve.
   */
  reserve?: boolean
  header?: MenuHeader
  /** Rows under a separator: a link to where the values are managed, an action such as undoing a pending switch. */
  footer?: ReactNode
  /**
   * Shown in the layer in the menu's place while set, for adding a value where it is chosen (a model service, from
   * 「添加模型服务…」 in the footer); the layer stays open around it, and on phones the sheet holds it. It closes the
   * layer with useLayerClose when it is done.
   */
  panel?: ReactNode
  /** The layer opened or closed, whatever closed it. */
  onOpenChange?: (open: boolean) => void
  /** Each new value opens the layer, for a page that needs this choice made before it can go on. */
  openRequest?: number
  /**
   * The words the trigger shows instead of the chosen option's label, for a value that differs from the list's (a
   * model switch that applies from the next message, 「下一条：…」). Read after the label as well.
   */
  valueText?: string
  /** The menu layer's width, a step of the scale: sm by default, md for the permission levels. */
  width?: LayerSize
  /** Frost the floating layer used for ordinary choices. Sheets and protected content keep their solid surface. */
  frosted?: boolean
  /** A search row on top of the menu, for long lists such as models. */
  searchable?: boolean
  /** A new request opens this picker with an initial search; subsequent typing stays local to the picker. */
  searchRequest?: { query: string; revision: number }
  /** An explicit choice of the current value is meaningful to the caller. */
  reselect?: boolean
  /** Optional domain-specific match; the default is a literal substring. */
  searchMatch?: (option: PickerOption<T>, query: string) => boolean
  disabled?: boolean
  /** The tooltip of a disabled picker (also read as its description): why it cannot change. */
  disabledReason?: string
  /** The tooltip of an enabled one: a fact about its value that the menu does not spell out (a few lines at most). */
  hint?: ReactNode
  /** row: the phone row of a settings sheet (label, value, arrow) that opens a single-choice sheet. */
  variant?: 'inline' | 'row'
  className?: string
}

/** Inspector values (xs) and settings rows (which bleed) line their menu up with the trigger's end; others its start. */
function pickerAlign(size: ValuePickerProps<string>['size'], bleed: ValuePickerProps<string>['bleed']): 'start' | 'end' {
  return size === 'xs' || bleed !== undefined ? 'end' : 'start'
}

function isGlyph(value: unknown): value is IconComponent {
  return typeof value === 'function' || (typeof value === 'object' && value !== null && '$$typeof' in value && 'render' in value)
}

/**
 * Picks one of a set of values in place and shows only the current one: 13/18 at weight 400 in ink-2, ending in
 * chevrons-up-down (never chevron-down, which belongs to action menus). A ghost 28px control: hover and an open menu
 * lay the hover fill under it and turn the value to ink. With a single possible value it is plain text without an arrow. Space,
 * Enter or ↓ open the menu on the current value; ↑/↓ move, Enter chooses, Escape closes and returns focus, typing
 * jumps to a value. A changed value cross-fades; nothing pops up to confirm it. On phones the menu is a single-choice
 * sheet.
 */
export function ValuePicker<T extends string>({
  label,
  value,
  options,
  groups,
  onValueChange,
  leading,
  trailing,
  mark,
  placeholder = UI_COPY.unselected,
  size = 'sm',
  bleed,
  chevron = 'always',
  menuChevron = false,
  pending: pendingProp = false,
  pendingLabel = UI_COPY.verifying,
  reserve = false,
  header,
  footer,
  panel: form,
  onOpenChange,
  openRequest = 0,
  valueText: shownText,
  width,
  frosted = false,
  searchable = false,
  searchRequest,
  reselect = false,
  searchMatch,
  disabled = false,
  disabledReason,
  hint,
  variant = 'inline',
  align,
  side = 'bottom',
  maxHeight,
  anchor,
  className,
}: ValuePickerProps<T>) {
  useUiLocale()
  const phone = useMediaQuery(PHONE_QUERY)
  const sheet = phone || variant === 'row'
  const panel = useRef<HTMLDivElement>(null)
  const text = useRef<HTMLSpanElement>(null)
  const {
    trigger: triggerRef,
    layer,
    open,
    setOpen,
    close: closeLayer,
  } = useLayer({ align: align ?? pickerAlign(size, bleed), side, maxHeight, anchor }, onOpenChange)
  const [waiting, setWaiting] = useState(false)
  const [query, setQuery] = useState('')
  const pending = pendingProp || waiting
  const all = groups ?? [{ id: 'options', options: options ?? [] }]
  const flat = all.flatMap(group => group.options)
  const current = flat.find(option => option.value === value)

  const close = (restoreFocus: boolean) => {
    closeLayer(restoreFocus)
    setQuery('')
  }

  // Only a change asks: a picker mounted after an earlier request has nothing to open for.
  const seenRequest = useRef(openRequest)
  useEffect(() => {
    if (seenRequest.current === openRequest) return
    seenRequest.current = openRequest
    const trigger = triggerRef.current
    // Retained pages can hear the same request; their native modal would block the visible page.
    if (
      !trigger
      || trigger.closest('[inert], [hidden], [aria-hidden="true"]')
      || trigger.getClientRects().length === 0
      || getComputedStyle(trigger).visibility !== 'visible'
    )
      return
    trigger.focus({ preventScroll: true })
    setOpen(true)
  }, [openRequest, setOpen, triggerRef])

  // The value fades in when it changes (120ms), not when the picker first appears.
  const currentLabel = shownText ?? current?.label
  const shownLabel = useRef(currentLabel)
  useLayoutEffect(() => {
    if (shownLabel.current === currentLabel) return
    shownLabel.current = currentLabel
    if (motionAllowed()) text.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: 'cubic-bezier(0.2, 0, 0, 1)' })
  }, [currentLabel])

  const showingForm = form !== undefined
  const lastMenuFocus = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (!open || sheet || showingForm) {
      lastMenuFocus.current = null
      return
    }
    const previous = lastMenuFocus.current
    if (!previous || previous.isConnected) return
    lastMenuFocus.current = null
    // An asynchronous option refresh can remove the focused row. Repair only that lost focus;
    // ordinary polling must leave a surviving row, search field or another control alone.
    if (document.activeElement === document.body && layer.current?.matches(':popover-open')) focusInto(panel.current)
  })
  useEffect(() => {
    if (!searchRequest) return
    setQuery(searchRequest.query)
    setOpen(true)
  }, [searchRequest, setOpen])
  useEffect(() => {
    if (open && !sheet && !showingForm) focusInto(panel.current)
  }, [open, sheet, showingForm])
  const closeFromContent = () => {
    close(true)
  }

  const choose = (next: T) => {
    close(true)
    if (next === value && !reselect) return
    const result = onValueChange(next)
    if (result instanceof Promise) {
      setWaiting(true)
      void result
        .catch(() => {})
        .finally(() => {
          setWaiting(false)
        })
    }
  }

  const risky = current?.risk === true
  const lead = pending ? (
    <Spinner size={12} className="ui-value-picker-lead" />
  ) : risky ? (
    <Icon icon={ShieldAlertGlyph} size={14} className="ui-value-picker-lead ui-value-picker-risk" />
  ) : isGlyph(leading) ? (
    <Icon icon={leading} size={14} className="ui-value-picker-lead" />
  ) : leading ? (
    <span className="ui-value-picker-lead">{leading}</span>
  ) : null
  const valueText = shownText ?? current?.label ?? placeholder
  const reserving = reserve && variant === 'inline' && size === 'sm'
  const valueLayers = (
    <span className="ui-value-picker-value" data-reserve={reserving ? '' : undefined}>
      <span ref={text} className="ui-value-picker-text" data-shown={!pending || undefined}>
        {valueText}
      </span>
      <span className="ui-value-picker-text" data-pending="" data-shown={pending || undefined}>
        {pendingLabel}
      </span>
    </span>
  )

  // One possible value and nothing else to offer: plain text, no arrow, no hover.
  if (flat.length === 1 && current && !pending && footer === undefined && form === undefined) {
    return (
      <span className={cx('ui-value-picker', className)} data-static="" data-size={size} data-bleed={bleed} data-variant={variant}>
        {variant === 'row' ? <span className="ui-value-row-label">{label}</span> : <span className="sr-only">{label}：</span>}
        {lead}
        <span className="ui-value-picker-value">
          <span className="ui-value-picker-text" data-shown="">
            {valueText}
          </span>
        </span>
      </span>
    )
  }

  const visibleGroups =
    searchable && query
      ? all.map(group => ({
          ...group,
          options: group.options.filter(option =>
            searchMatch ? searchMatch(option, query) : option.label.toLowerCase().includes(query.toLowerCase()),
          ),
        }))
      : all
  const sections: MenuSection[] = visibleGroups.map(group => ({
    id: group.id,
    label: group.label,
    items: group.options.map(option => ({
      id: option.value,
      label: option.label,
      description: option.description,
      tag: option.tag,
      meta: option.meta,
      media: option.media,
      checked: option.value === value,
      disabledReason: option.disabledReason,
      hint: option.hint,
      onSelect: () => {
        choose(option.value)
      },
    })),
    media: group.media,
    ...(group.hint ? { hint: group.hint } : {}),
  }))

  const button = (
    <button
      ref={triggerRef}
      type="button"
      className={cx('ui-value-picker', className)}
      data-size={size}
      data-bleed={bleed}
      data-chevron={chevron}
      data-variant={variant}
      data-leading={lead ? '' : undefined}
      data-placeholder={current ? undefined : ''}
      data-pending={pending ? '' : undefined}
      aria-label={`${label}：${pending ? pendingLabel : valueText}`}
      aria-haspopup={sheet ? 'dialog' : 'menu'}
      aria-expanded={open}
      aria-disabled={disabled || undefined}
      aria-busy={pending || undefined}
      onClick={() => {
        if (!disabled) setOpen(!open)
      }}
      onKeyDown={event => {
        if (!disabled && !open && event.key === 'ArrowDown') {
          event.preventDefault()
          setOpen(true)
        }
      }}>
      {variant === 'row' && <span className="ui-value-row-label">{label}</span>}
      {lead}
      {valueLayers}
      {trailing !== undefined && trailing !== null && !pending && <span className="ui-value-picker-trail">{trailing}</span>}
      {mark !== undefined && mark !== null && mark}
      <Icon icon={menuChevron ? ChevronDownGlyph : UpDownGlyph} size={variant === 'row' ? 16 : 12} className="ui-value-picker-chevron" />
    </button>
  )
  const trigger = <Tooltip content={disabled ? disabledReason : hint}>{button}</Tooltip>

  if (sheet) {
    return (
      <>
        {trigger}
        <Sheet
          open={open}
          title={label}
          onClose={() => {
            close(true)
          }}>
          <LayerClose.Provider value={closeFromContent}>
            <LayerOpen.Provider value={open}>
              {form ?? (
                <>
                  {searchable && <MenuSearch label={label} value={query} onValueChange={setQuery} />}
                  <PickerSheetBody
                    label={label}
                    header={header}
                    groups={visibleGroups}
                    value={value}
                    footer={footer}
                    onValueChange={choose}
                  />
                </>
              )}
            </LayerOpen.Provider>
          </LayerClose.Provider>
        </Sheet>
      </>
    )
  }

  return (
    <>
      {trigger}
      <div
        ref={layer}
        popover="manual"
        className="ui-popover"
        data-panel={form === undefined ? undefined : ''}
        data-size={width ?? 'sm'}
        data-frosted={frosted ? '' : undefined}
        onFocusCapture={event => {
          if (event.target instanceof HTMLElement) lastMenuFocus.current = event.target
        }}
        onKeyDown={event => {
          // The menu handles its own keys; a panel in its place closes on Escape like the menu.
          if (form === undefined || event.key !== 'Escape' || event.defaultPrevented) return
          event.preventDefault()
          event.stopPropagation()
          close(true)
        }}
        onBlur={event => {
          // Tabbing out of a panel closes the layer, as tabbing out of the menu does.
          const next = event.relatedTarget
          if (next instanceof Node && !layer.current?.contains(next)) lastMenuFocus.current = null
          if (form === undefined || !(next instanceof Node)) return
          if (layer.current?.contains(next) || triggerRef.current?.contains(next)) return
          close(false)
        }}>
        <LayerClose.Provider value={closeFromContent}>
          <LayerOpen.Provider value={open}>{form}</LayerOpen.Provider>
          {form === undefined && searchable && (
            <MenuSearch
              label={label}
              value={query}
              onValueChange={setQuery}
              onKeyDown={event => {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  panel.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]')?.focus()
                } else if (event.key === 'Escape' && !query) {
                  event.preventDefault()
                  close(true)
                } else if (event.key === 'Tab') close(false)
              }}
            />
          )}
          {form === undefined && (
            <MenuPanel
              label={label}
              header={header}
              sections={sections}
              selection
              footer={footer}
              panelRef={panel}
              onChoose={item => {
                item.onSelect()
              }}
              onDismiss={reason => {
                close(reason === 'escape')
              }}
            />
          )}
        </LayerClose.Provider>
      </div>
    </>
  )
}

/**
 * What a picker's bottom sheet holds on phones: each group as a single-choice list in a card, under its heading, then
 * the footer note. The menu's header (whom the choice applies to) heads the first list that has no heading of its
 * own and names it; a title that only repeats the sheet's is left out. Exported to draw the sheet in place.
 */
export function PickerSheetBody<T extends string>({
  label,
  header,
  groups,
  value,
  footer,
  onValueChange,
}: {
  /** The picker's label, which is also the sheet's title. */
  label: string
  header?: MenuHeader
  groups: Array<PickerGroup<T>>
  value: T | undefined
  footer?: ReactNode
  onValueChange: (value: T) => void
}) {
  const chosen = groups.some(group => group.options.some(option => option.value === value))
  // Touch has no hover: a heading with more to say shows it while tapped open.
  const [shown, setShown] = useState<string | undefined>(undefined)
  return (
    <>
      {groups.map((group, index) => {
        const headed = index === 0 && group.label === undefined ? header : undefined
        const title = group.label ?? (headed && headed.title !== label ? headed.title : undefined)
        const meta = headed?.meta
        return (
          <div key={group.id} className="ui-sheet-group">
            {(title || meta) && (
              <h3 className="ui-sheet-group-label">
                {title && group.hint ? (
                  <button
                    type="button"
                    className="ui-sheet-group-toggle"
                    aria-expanded={shown === group.id}
                    onClick={() => {
                      setShown(shown === group.id ? undefined : group.id)
                    }}>
                    {title}
                  </button>
                ) : (
                  title && <span>{title}</span>
                )}
                {meta && <span className="ui-sheet-group-meta">{meta}</span>}
              </h3>
            )}
            {group.hint && shown === group.id && <p className="ui-sheet-group-hint">{group.hint}</p>}
            <ChoiceList
              label={[title, meta].filter(Boolean).join(' · ') || label}
              // The sheet opens on the current value, its list's one tab stop (with nothing chosen, the first list's).
              autoFocus={chosen ? group.options.some(option => option.value === value) : index === 0}
              reselect
              value={value}
              options={group.options.map(option => ({
                value: option.value,
                title: option.label,
                description: option.description,
                tag: option.tag,
                risk: option.risk,
                disabledReason: option.disabledReason,
                media: option.media,
              }))}
              onValueChange={onValueChange}
            />
          </div>
        )
      })}
      {footer && <div className="ui-sheet-footer">{footer}</div>}
    </>
  )
}

// ---- Popover ------------------------------------------------------------------------------------------------------

/**
 * A layer of content (a plan, details) pinned to a trigger the caller draws: same surface, placement and dismissal as
 * a menu, with focus moved to its first meaningful control. On phones it is a bottom sheet titled `title` (the label by
 * default), closed like every sheet.
 */
export function Popover({
  label,
  title,
  trigger,
  children,
  size = 'sm',
  frosted = false,
  onOpenChange,
  ...placement
}: LayerPlacement & {
  label: string
  /** The sheet's title on phones, for example the label with a count. */
  title?: ReactNode
  trigger: (props: MenuTriggerProps) => ReactNode
  /** The content; a control in it that is done closes the layer with useLayerClose. */
  children: ReactNode
  /** The layer's width, a step of the scale. */
  size?: LayerSize
  /** Frost the floating layer used for ordinary choices. Sheets and protected content keep their solid surface. */
  frosted?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const phone = useMediaQuery(PHONE_QUERY)
  const { trigger: triggerRef, layer, open, setOpen, close } = useLayer(placement, onOpenChange)
  const content = (
    <LayerClose.Provider
      value={() => {
        close(true)
      }}>
      <LayerOpen.Provider value={open}>{children}</LayerOpen.Provider>
    </LayerClose.Provider>
  )
  useEffect(() => {
    if (!open || phone || !layer.current) return
    ;(firstMeaningful(layer.current) ?? layer.current).focus({ preventScroll: true })
  }, [open, phone, layer])
  return (
    <>
      {trigger({
        ref: triggerRef,
        onClick: () => {
          setOpen(!open)
        },
        onKeyDown: event => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault()
            setOpen(true)
          }
        },
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
      })}
      {phone ? (
        <Sheet
          open={open}
          title={title ?? label}
          onClose={() => {
            close(true)
          }}>
          {content}
        </Sheet>
      ) : (
        <div
          ref={layer}
          popover="manual"
          className="ui-popover"
          role="dialog"
          aria-label={label}
          tabIndex={-1}
          data-size={size}
          data-frosted={frosted ? '' : undefined}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              close(true)
            }
          }}
          onBlur={event => {
            // Tabbing out of the layer closes it; moving between its own controls does not.
            const next = event.relatedTarget
            if (next instanceof Node && (layer.current?.contains(next) || triggerRef.current?.contains(next))) return
            if (next !== null) close(false)
          }}>
          {content}
        </div>
      )}
    </>
  )
}
