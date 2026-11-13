import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react'
import { CheckGlyph, ChevronDownGlyph, ChevronRightGlyph, UpDownGlyph, BlockedGlyph, LockGlyph, ShieldAlertGlyph } from './glyphs/index.tsx'
import { Button } from './button.tsx'
import { ChoiceList } from './choice.tsx'
import { Sheet } from './dialog.tsx'
import { Icon, Spinner, type IconComponent } from './icon.tsx'
import { cx, nextIndex, onAnchorScrolled, PHONE_QUERY, pinLayer, setPopover, useMediaQuery, useTypeahead } from './internal.ts'
import { Badge } from './pill.tsx'
import { Tooltip } from './tooltip.tsx'

// ---- The layer ----------------------------------------------------------------------------------------------------

export interface LayerPlacement {
  /** Settings rows and the inspector line the layer's right edge up with the trigger; the composer its left edge. */
  align?: 'start' | 'end'
  /** `auto` opens toward the side with more room, for a picker that can sit anywhere on the page. */
  side?: 'bottom' | 'top' | 'auto'
  /** Scrolls within past this height. */
  maxHeight?: number
}

/**
 * Open state of a layer pinned to a trigger: it is shown in the top layer (so no scrolling list or dialog clips it),
 * placed 6px from the trigger, and closed by a press outside, a scroll that moves the trigger (not one that only
 * settled it as the layer opened), Escape or Tab.
 * Closing with Escape or by choosing gives focus back to the trigger; a press elsewhere or Tab leaves it where it went.
 * A layer drawn as a bottom sheet (phones) has no popover element; the sheet handles its own dismissal.
 */
function useLayer({ align = 'start', side = 'bottom', maxHeight }: LayerPlacement, onOpenChange?: (open: boolean) => void) {
  const trigger = useRef<HTMLButtonElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
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
    if (!open || !element || !trigger.current) return undefined
    return pinLayer(trigger.current, element, { align, side, gap: 6, maxHeight })
  }, [open, align, side, maxHeight])
  useEffect(() => {
    const element = layer.current
    const anchor = trigger.current
    if (!open || !element || !anchor) return undefined
    const outside = (event: Event) => {
      const target = event.target instanceof Node ? event.target : null
      if (element.contains(target) || anchor.contains(target)) return
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
  }, [open])
  const close = (restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) trigger.current?.focus({ preventScroll: true })
  }
  return { trigger, layer, open, setOpen, close }
}

/** Closes the layer something is shown in, giving focus back to its trigger; outside a layer it does nothing. */
const LayerClose = createContext<() => void>(() => {})

/** Inside a menu's list, where the arrow keys move between items (a footer row is one of them). */
const InMenu = createContext(false)

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
  /** One line under the label. */
  description?: string
  /** Action menus: a leading 14px glyph. Selection menus put the check in this slot instead. */
  icon?: IconComponent
  /** Right after the label, for example the 默认 small badge. */
  tag?: ReactNode
  /** The one trailing element: meta text, a small badge or a kbd. */
  meta?: ReactNode
  /** A tile or avatar between the leading slot and the label: the value's own picture (a harness, a model service). */
  media?: ReactNode
  /** Selection menus: the chosen item, with an ink check and its label at 500. */
  checked?: boolean
  /** A destructive action (删除…): red text, placed last after a separator. */
  danger?: boolean
  /** Why it cannot be chosen. It stays focusable, dims, and the reason (read out with it) stays at full strength. */
  disabledReason?: string
  onSelect: () => void
}

export interface MenuSection {
  id: string
  /** A group heading inside the menu. */
  label?: string
  /** A 16px tile before the heading, for example the model service a group of models comes from. */
  media?: ReactNode
  items: MenuItem[]
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
 * letters, Enter or Space chooses. Danger items come last, after a separator.
 */
export function MenuPanel({ label, header, sections, selection = false, footer, onChoose, onDismiss, panelRef, className }: PanelProps) {
  const id = useId()
  const typeahead = useTypeahead()
  const visible = sections.filter(section => section.items.length > 0)
  const ordered = [
    ...visible.map(section => ({ ...section, items: section.items.filter(item => !item.danger) })),
    { id: `${id}-danger`, items: visible.flatMap(section => section.items.filter(item => item.danger)) },
  ].filter(section => section.items.length > 0)
  const leads = selection || visible.some(section => section.items.some(item => item.icon !== undefined))

  const keydown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = itemsOf(event.currentTarget)
    const current = items.findIndex(item => item === document.activeElement)
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
      }
      onDismiss?.(event.key === 'Escape' ? 'escape' : 'tab')
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
      ref={panelRef}
      className={cx('ui-menu', className)}
      data-no-lead={leads ? undefined : ''}
      role="menu"
      aria-label={headedName(label, header)}
      aria-describedby={header?.meta ? `${id}-meta` : undefined}
      onKeyDown={keydown}>
      {header && (
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
        <div key={section.id} className="ui-menu-section" role="group" aria-label={section.label}>
          {index > 0 && <div className="ui-menu-separator" role="separator" />}
          {section.label && (
            <div className="ui-menu-section-label" aria-hidden="true">
              {section.media}
              {section.label}
            </div>
          )}
          {section.items.map(item => (
            <MenuRow key={item.id} item={item} selection={selection} onChoose={onChoose} />
          ))}
        </div>
      ))}
      {footer && (
        <>
          <div className="ui-menu-separator" role="separator" />
          <div className="ui-menu-footer">
            <InMenu.Provider value>{footer}</InMenu.Provider>
          </div>
        </>
      )}
    </div>
  )
}

function MenuRow({ item, selection, onChoose }: { item: MenuItem; selection: boolean; onChoose?: (item: MenuItem) => void }) {
  const id = useId()
  const disabled = item.disabledReason !== undefined
  const described = [item.description ? `${id}-description` : '', disabled ? `${id}-reason` : ''].filter(Boolean).join(' ')
  const lead = selection ? (
    item.checked ? (
      <Icon icon={CheckGlyph} size={14} className="ui-menu-check" />
    ) : null
  ) : item.icon ? (
    <Icon icon={item.icon} size={14} />
  ) : null
  return (
    <button
      type="button"
      tabIndex={-1}
      role={selection ? 'menuitemradio' : 'menuitem'}
      className="ui-menu-item"
      data-label={item.label}
      data-two-line={item.description || disabled ? '' : undefined}
      data-media={item.media ? '' : undefined}
      data-danger={item.danger ? '' : undefined}
      aria-checked={selection ? item.checked === true : undefined}
      aria-disabled={disabled || undefined}
      aria-labelledby={`${id}-label`}
      aria-describedby={described || undefined}
      onClick={() => {
        if (!disabled) onChoose?.(item)
      }}>
      <span className="ui-menu-item-lead">{lead}</span>
      {item.media && <span className="ui-menu-item-media">{item.media}</span>}
      <span className="ui-menu-item-text">
        <span id={`${id}-label`} className="ui-menu-item-label">
          <span className="ui-menu-item-title">{item.label}</span>
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
      {item.meta !== undefined && <span className="ui-menu-item-meta">{item.meta}</span>}
    </button>
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
 * The search row on top of a long picker's menu (models): 36px, an input without a field of its own, a subtle line
 * under it. The layer that holds it spans it edge to edge and keeps its 4px inside around the list.
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
  return (
    <div className="ui-menu-search">
      <input
        type="search"
        aria-label={`搜索${label}`}
        placeholder="搜索"
        value={value}
        onChange={event => {
          onValueChange(event.target.value)
        }}
        onKeyDown={onKeyDown}
      />
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
function focusInto(panel: HTMLElement | null) {
  if (!panel) return
  const items = itemsOf(panel)
  const search = panel.querySelector<HTMLInputElement>('.ui-menu-search input')
  ;(search ?? items.find(item => item.getAttribute('aria-checked') === 'true') ?? items[0])?.focus({ preventScroll: true })
}

/**
 * A menu of actions opened by a trigger the caller draws (a ⋯ icon button, a title button with chevron-down). Space,
 * Enter and ↓ on the trigger open it with focus on the first item. On phones it is a bottom sheet.
 */
export function Menu({
  label,
  title,
  trigger,
  sections,
  header,
  footer,
  width,
  selection = false,
  className,
  ...placement
}: Omit<PanelProps, 'onChoose' | 'onDismiss' | 'panelRef'>
  & LayerPlacement & {
    trigger: (props: MenuTriggerProps) => ReactNode
    /** The layer's outer width; at least 220. */
    width?: number
    title?: string
  }) {
  const phone = useMediaQuery(PHONE_QUERY)
  const panel = useRef<HTMLDivElement>(null)
  const { trigger: triggerRef, layer, open, setOpen, close } = useLayer(placement)
  // In a sheet too: its items are out of the Tab order, so the sheet itself does not move focus onto them.
  useEffect(() => {
    if (open) focusInto(panel.current)
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
        <div ref={layer} popover="manual" className="ui-popover" style={width ? { width } : undefined}>
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
  description?: string
  /** Right after the label, for example the 默认 small badge. */
  tag?: ReactNode
  meta?: ReactNode
  /** A value with real risk (完全访问): once chosen, the trigger leads with an amber shield-alert. */
  risk?: boolean
  disabledReason?: string
  /** The value's own picture in the menu (a 20px tile), after the check slot. */
  media?: ReactNode
}

export interface PickerGroup<T extends string> {
  id: string
  label?: string
  /** A 16px tile before the group's heading. */
  media?: ReactNode
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
   * For a start-aligned toolbar picker that can wait for verification (PermissionMenu turns it on there): it keeps
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
  /** The menu layer's outer width (320 for permissions, 360 when searchable); at least 220. */
  width?: number
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
  placeholder = '未选择',
  size = 'sm',
  bleed,
  chevron = 'always',
  menuChevron = false,
  pending: pendingProp = false,
  pendingLabel = '等待验证…',
  reserve = false,
  header,
  footer,
  panel: form,
  onOpenChange,
  openRequest = 0,
  valueText: shownText,
  width,
  searchable = false,
  searchRequest,
  reselect = false,
  searchMatch,
  disabled = false,
  disabledReason,
  variant = 'inline',
  align,
  side = 'bottom',
  maxHeight,
  className,
}: ValuePickerProps<T>) {
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
  } = useLayer({ align: align ?? pickerAlign(size, bleed), side, maxHeight }, onOpenChange)
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
    setOpen(true)
  }, [openRequest, setOpen])

  // The value fades in when it changes (120ms), not when the picker first appears.
  const currentLabel = shownText ?? current?.label
  const shownLabel = useRef(currentLabel)
  useLayoutEffect(() => {
    if (shownLabel.current === currentLabel) return
    shownLabel.current = currentLabel
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches)
      text.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: 'cubic-bezier(0.2, 0, 0, 1)' })
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
      onSelect: () => {
        choose(option.value)
      },
    })),
    media: group.media,
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
      <Icon icon={menuChevron ? ChevronDownGlyph : UpDownGlyph} size={variant === 'row' ? 16 : 12} className="ui-value-picker-chevron" />
    </button>
  )
  const trigger = <Tooltip content={disabled ? disabledReason : undefined}>{button}</Tooltip>

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
        style={{ width: width ?? (searchable ? 360 : undefined) }}
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
          {form}
          {form === undefined && searchable && (
            <MenuSearch
              label={label}
              value={query}
              onValueChange={setQuery}
              onKeyDown={event => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  panel.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]')?.focus()
                } else if (event.key === 'Escape') {
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
                {title && <span>{title}</span>}
                {meta && <span className="ui-sheet-group-meta">{meta}</span>}
              </h3>
            )}
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

// ---- Permission menu ----------------------------------------------------------------------------------------------

export interface PermissionLevel<T extends string> {
  value: T
  title: string
  /** One line: what the level lets the agent do. */
  description: string
  /** The level with real risk (完全访问): amber only once it is chosen, and only on the trigger. */
  risk?: boolean
  /** Why this level cannot be chosen here (unsupported by the agent, the device may not touch this session). */
  disabledReason?: string
}

/**
 * The one menu for ordered permission levels, lowest first, in place of a row of segments. Each level is a two-line
 * item with its consequence; the default carries a neutral 默认 badge; levels that cannot be chosen stay readable with
 * their reason. 完全访问 shows no amber in the menu: only once chosen, as the trigger's shield-alert. Lowering applies at
 * once; a raise that needs verification returns a promise, and the trigger shows 「等待验证…」 in place until it settles
 * (a cancelled verification leaves the value as it was). In a start-aligned toolbar it keeps room for that text, so
 * nothing after it moves; at the end of a settings row it grows to the left instead.
 */
export function PermissionMenu<T extends string>({
  levels,
  defaultValue,
  reserve,
  ...props
}: Omit<ValuePickerProps<T>, 'options' | 'groups' | 'searchable' | 'width'> & { levels: Array<PermissionLevel<T>>; defaultValue?: T }) {
  return (
    <ValuePicker
      {...props}
      reserve={reserve ?? (props.align ?? pickerAlign(props.size, props.bleed)) === 'start'}
      width={320}
      options={levels.map(level => ({
        value: level.value,
        label: level.title,
        description: level.description,
        risk: level.risk,
        disabledReason: level.disabledReason,
        tag: level.value === defaultValue ? <Badge>默认</Badge> : undefined,
      }))}
    />
  )
}

// ---- Popover ------------------------------------------------------------------------------------------------------

/**
 * A layer of content (a plan, details) pinned to a trigger the caller draws: same surface, placement and dismissal as
 * a menu, with focus moved to its first control. On phones it is a bottom sheet titled `title` (the label by default)
 * that only shows its content, so its one control is 完成 on the right.
 */
export function Popover({
  label,
  title,
  trigger,
  children,
  width = 320,
  onOpenChange,
  ...placement
}: LayerPlacement & {
  label: string
  /** The sheet's title on phones, for example the label with a count. */
  title?: ReactNode
  trigger: (props: MenuTriggerProps) => ReactNode
  /** The content; a control in it that is done closes the layer with useLayerClose. */
  children: ReactNode
  width?: number
  onOpenChange?: (open: boolean) => void
}) {
  const phone = useMediaQuery(PHONE_QUERY)
  const { trigger: triggerRef, layer, open, setOpen, close } = useLayer(placement, onOpenChange)
  const content = (
    <LayerClose.Provider
      value={() => {
        close(true)
      }}>
      {children}
    </LayerClose.Provider>
  )
  useEffect(() => {
    if (!open || phone || !layer.current) return
    const first = layer.current.querySelector<HTMLElement>('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')
    ;(first ?? layer.current).focus({ preventScroll: true })
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
          cancelLabel={null}
          action={
            <Button
              variant="secondary"
              onClick={() => {
                close(true)
              }}>
              完成
            </Button>
          }
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
          style={{ width }}
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
