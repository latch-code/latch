import { UI_COPY, useUiLocale } from './locale.ts'
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { CheckGlyph, BlockedGlyph, SearchGlyph } from './glyphs/index.tsx'
import { FoldHeader } from './fold.tsx'
import { Icon, Spinner, type IconComponent } from './icon.tsx'
import { cx, nextIndex, PHONE_QUERY, useMediaQuery } from './internal.ts'
import { InMenu, useLayerClose, useLayerOpen } from './menu.tsx'
import { Collapse } from './motion.tsx'
import { Kbd } from './pill.tsx'
import { Tooltip } from './tooltip.tsx'

// ---- Mode strip ---------------------------------------------------------------------------------------------------

export interface ModeStripOption<T extends string> {
  value: T
  /** The mode's name, shown under the strip while it is chosen or previewed, and the segment's accessible name. */
  label: string
  /** One short line on what it does, from the mode's own description. */
  line?: string
  icon: IconComponent
  /** The loosest mode: amber while it is chosen or previewed, never at rest. */
  risk?: boolean
  /** Why it cannot be chosen: the segment's tooltip, and it stays focusable. */
  disabledReason?: string
}

/** The most segments in one row of a mode strip. */
const STRIP_ROW = 5

/**
 * An ordered set of modes as one row of icon segments (five to a row, more wrapping onto the next), tightest first, with the chosen (or previewed) mode's name and
 * its one line under it in a block of fixed height, so the layer never changes size. ←/→, Home and End move without
 * choosing, and hover or focus previews; Enter, Space or a click chooses. A radio group with one tab stop. Every mode
 * needs an icon of its own: the name under the strip says which one is shown.
 */
export function ModeStrip<T extends string>({
  label,
  keys,
  value,
  options,
  onChoose,
  className,
  compact = false,
  pending = false,
}: {
  /** The heading over the strip, also the group's name. */
  label: string
  /**
   * One row for the foot of a larger panel: the heading and the segments side by side, the shown mode's name and its line
   * after a dot on one line under them, of fixed height.
   */
  compact?: boolean
  /** A write of the mode is under way: a small turn after the heading; the strip shows the mode the Host confirmed. */
  pending?: boolean
  /** The shortcut that opens it, drawn at the heading's end. */
  keys?: string | undefined
  value: T | undefined
  options: ReadonlyArray<ModeStripOption<T>>
  onChoose: (value: T) => void
  className?: string
}) {
  const id = useId()
  const open = useLayerOpen()
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const selected = options.findIndex(option => option.value === value)
  const [focused, setFocused] = useState(Math.max(0, selected))
  const [hovered, setHovered] = useState<number | null>(null)
  const [focusIn, setFocusIn] = useState(false)
  // Each opening starts on the chosen mode.
  const [opened, setOpened] = useState(open)
  if (open !== opened) {
    setOpened(open)
    if (open) {
      setHovered(null)
      setFocused(Math.max(0, selected))
    }
  }
  const shownIndex = hovered ?? (focusIn ? focused : selected)
  const shown = shownIndex >= 0 ? options[shownIndex] : undefined
  const choose = (index: number) => {
    const option = options[index]
    if (!option || option.disabledReason !== undefined) return
    onChoose(option.value)
  }
  const keydown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      choose(focused)
      return
    }
    const index = nextIndex(
      event.key === 'ArrowUp' ? 'ArrowLeft' : event.key === 'ArrowDown' ? 'ArrowRight' : event.key,
      focused,
      options.length,
      'horizontal',
      () => true,
    )
    if (index === undefined) return
    event.preventDefault()
    setFocused(index)
    setHovered(null)
    buttons.current[index]?.focus()
  }
  return (
    <div className={cx('ui-mode-strip', className)} data-compact={compact ? '' : undefined} aria-busy={pending || undefined}>
      <p className="ui-mode-strip-head" id={`${id}-label`}>
        <span>{label}</span>
        {pending && <Spinner size={12} />}
        {keys && <Kbd>{keys}</Kbd>}
      </p>
      <div
        className="ui-mode-strip-track"
        // Five to a row: more modes wrap onto a second row of the same segments.
        style={{ '--mode-columns': Math.min(options.length, STRIP_ROW) } as CSSProperties}
        role="radiogroup"
        aria-labelledby={`${id}-label`}
        onKeyDown={keydown}
        onFocus={() => {
          setFocusIn(true)
        }}
        onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocusIn(false)
        }}
        onPointerLeave={() => {
          setHovered(null)
        }}>
        {options.map((option, index) => (
          <Tooltip key={option.value} content={option.disabledReason}>
            <button
              ref={element => {
                buttons.current[index] = element
              }}
              type="button"
              role="radio"
              className="ui-mode-strip-option"
              aria-label={option.label}
              aria-describedby={option.line ? `${id}-${index}` : undefined}
              aria-checked={index === selected}
              aria-disabled={option.disabledReason !== undefined || undefined}
              data-risk={option.risk ? '' : undefined}
              data-preview={index === shownIndex && index !== selected ? '' : undefined}
              data-autofocus={index === Math.max(0, selected) ? '' : undefined}
              tabIndex={index === focused ? 0 : -1}
              onFocus={() => {
                setFocused(index)
              }}
              onPointerEnter={() => {
                setHovered(index)
              }}
              onClick={() => {
                choose(index)
              }}>
              <Icon icon={option.icon} size={16} />
              {option.line && (
                <span id={`${id}-${index}`} hidden>
                  {option.line}
                </span>
              )}
            </button>
          </Tooltip>
        ))}
      </div>
      <div className="ui-mode-strip-shown" data-risk={shown?.risk ? '' : undefined} aria-hidden="true">
        <span className="ui-mode-strip-name">{shown?.label}</span>
        {compact && shown?.line && <span className="ui-mode-strip-dot">·</span>}
        <span className="ui-mode-strip-line">{shown?.line}</span>
      </div>
    </div>
  )
}

// ---- Picker board -------------------------------------------------------------------------------------------------

export interface BoardItem<T extends string> {
  value: T
  label: string
  /** The value's own 16px picture (its service's tile). */
  media?: ReactNode
  /** Right after the label, for example the 默认 badge. */
  tag?: ReactNode
  disabledReason?: string
}

/**
 * A group's note as a phone shows it once its heading is tapped, for a note too long to read as one paragraph: a short
 * lead, a list folded behind one line, then any short lines. The hover keeps `hint`, the whole note in one.
 */
export interface BoardNote {
  lead: string
  fold?: { label: string; items: string[] } | undefined
  after?: string[] | undefined
}

/** A phone's tapped note: the lead, the folded list and the lines after it. */
function BoardNoteView({ note }: { note: BoardNote }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <div className="ui-board-hint">
      <p>{note.lead}</p>
      {note.fold && (
        <>
          <FoldHeader open={open} onOpenChange={setOpen} aria-controls={id} meta={note.fold.items.length} className="ui-board-hint-fold">
            {note.fold.label}
          </FoldHeader>
          <Collapse open={open} id={id}>
            <ul>
              {note.fold.items.map(item => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </Collapse>
        </>
      )}
      {note.after?.map(line => (
        <p key={line}>{line}</p>
      ))}
    </div>
  )
}

/** A headed group of a source's items, for a source that holds several (a gateway, each service it forwards to). */
export interface BoardGroup<T extends string> {
  id: string
  label: string
  /** A 16px tile before the heading. */
  media?: ReactNode
  /** Right after the heading's name: a short mark such as 实验性. */
  tag?: ReactNode
  /** More about the group: on hover of its heading; on a phone, tapping the heading shows it. Never a row. */
  hint?: string | undefined
  /** The same note in parts, for a phone's tap: see `BoardNote`. Without it the phone shows `hint` as one paragraph. */
  note?: BoardNote | undefined
  items: Array<BoardItem<T>>
}

export interface BoardSource<T extends string> {
  id: string
  /** Its name: the rail entry's accessible name, and the list's heading while it has no groups. */
  label: string
  /** The rail entry's tooltip when it says a few words more than the name (「Latch 网关 · 实验性」). */
  tip?: string | undefined
  /** A 16px tile or glyph for the rail. */
  icon: ReactNode
  /** More about the source, on its heading as a group's `hint` is; never on the rail. */
  hint?: string | undefined
  /** The same in parts, for a phone's tap, as a group's `note`. */
  note?: BoardNote | undefined
  /** Its items under one heading, its name; or `groups`, each under its own. */
  items?: Array<BoardItem<T>>
  groups?: Array<BoardGroup<T>>
}

/** A source's items as headed groups: its own groups, or its items under its name. */
function groupsOf<T extends string>(source: BoardSource<T>): Array<BoardGroup<T>> {
  if (source.groups) return source.groups
  return [
    {
      id: source.id,
      label: source.label,
      ...(source.hint ? { hint: source.hint } : {}),
      ...(source.note ? { note: source.note } : {}),
      items: source.items ?? [],
    },
  ]
}
const itemsOf = <T extends string>(source: BoardSource<T>) => groupsOf(source).flatMap(group => group.items)

export interface BoardLevel<L extends string> {
  value: L
  label: string
  disabledReason?: string
  /** What the value means, on hover of its row (默认: whose default it is). */
  hint?: string | undefined
}

/** The second choice of the highlighted item (思考 for a model): its values, the chosen one, and a short state. */
export interface BoardLevels<L extends string> {
  value: L | undefined
  options: Array<BoardLevel<L>>
  /** A write for it, or for the item it belongs to, is under way. */
  pending?: boolean
  /** At the column's foot: a short state or the one note it has. */
  note?: ReactNode
}

export function hasOtherBoardLevels<L extends string>({ value, options }: BoardLevels<L>): boolean {
  return options.some(option => option.value !== value)
}

export interface PickerBoardProps<T extends string, L extends string> {
  /** What the list picks (模型): the list's name, and its search field's. */
  label: string
  /** What the second column picks (思考). */
  levelsLabel: string
  /** A 14px glyph before that word, in the column's head. */
  levelsIcon?: ReactNode
  sources: Array<BoardSource<T>>
  /** The chosen item. */
  value: T | undefined
  /** The second column for an item: it follows the highlighted one. */
  levels: (item: T | undefined) => BoardLevels<L>
  onItem: (value: T) => void
  onLevel: (item: T | undefined, level: L) => void
  /** Whether choosing this item keeps the board open on its levels; by default when it has more than one. */
  staysOn?: ((value: T) => boolean) | undefined
  /** Where focus lands when the layer opens: the list, the levels, or the foot's first choice. */
  focus?: 'list' | 'levels' | 'foot'
  /** The keys printed on the Nth row of the list (from 0), for the first nine. */
  keyCaps?: ((index: number) => string | undefined) | undefined
  /** The row a key press picks (from 0), or undefined when it is no such key. */
  pickIndex?: ((event: KeyboardEvent) => number | undefined) | undefined
  searchMatch?: ((item: BoardItem<T>, query: string) => boolean) | undefined
  /** A request to open on a search: each new revision fills the field. */
  query?: { query: string; revision: number } | undefined
  /** The item's other settings, as compact rows at the second column's foot. */
  settings?: ReactNode
  /** Rows under the list: where the values are managed, notes on them. */
  footer?: ReactNode
  /**
   * A row across the whole board, under its columns: choices that go with the item but are not levels (the session's
   * speed and permission). On phones it comes last, its parts stacked.
   */
  foot?: ReactNode
  /** Choosing an item or a level keeps the board open: it closes on Escape or a click outside, for a board that sets several things at once. */
  keepOpen?: boolean
  /** Fit a short list within a shorter panel. */
  compact?: boolean
  /** Show a fixed level in read-only text. Use inline placement only when no listed item has a level choice. */
  fixedLevelPlacement?: 'column' | 'inline'
  /** sheet: the phone's column, wherever it is drawn; by default it follows the width. */
  layout?: 'auto' | 'sheet'
  className?: string
}

const ROW = '[role^="menuitem"]'

function focusRow(container: HTMLElement | null, which: 'checked' | 'first' | 'last' | HTMLElement | null) {
  if (!container) return false
  const rows = Array.from(container.querySelectorAll<HTMLElement>(ROW))
  const row =
    which instanceof HTMLElement
      ? which
      : which === 'checked'
        ? (rows.find(item => item.getAttribute('aria-checked') === 'true') ?? rows[0])
        : which === 'last'
          ? rows.at(-1)
          : rows[0]
  row?.focus({ preventScroll: false })
  return row !== undefined
}

/** ↑/↓, Home and End over a column's rows. */
function moveInColumn(event: KeyboardEvent<HTMLElement>): boolean {
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(ROW))
  const current = rows.findIndex(row => row === document.activeElement)
  const next = nextIndex(event.key, current < 0 ? -1 : current, rows.length, 'vertical', () => true)
  if (next === undefined) return false
  event.preventDefault()
  rows[next]?.focus()
  return true
}

/**
 * Two linked choices in one layer of fixed size: a rail of sources (hidden with one), a search field and the chosen
 * source's items, and a column of the highlighted item's levels. Moving through the list changes the levels without
 * resizing anything; choosing an item keeps the board open on its levels when it has any, choosing a level closes it.
 * ↑/↓ move in a column, ←/→ and Tab go between the rail, the list and the levels, typing searches every source, and the
 * first nine rows take the keys `keyCaps` prints. On phones the sources and the levels are rows of segments around the
 * list.
 */
export function PickerBoard<T extends string, L extends string>({
  label,
  levelsLabel,
  levelsIcon,
  sources,
  value,
  levels,
  onItem,
  onLevel,
  staysOn,
  focus = 'list',
  keyCaps,
  pickIndex,
  searchMatch,
  query: request,
  settings,
  footer,
  foot,
  keepOpen = false,
  compact = false,
  fixedLevelPlacement,
  layout = 'auto',
  className,
}: PickerBoardProps<T, L>) {
  useUiLocale()
  const id = useId()
  const phone = useMediaQuery(PHONE_QUERY) || layout === 'sheet'
  const open = useLayerOpen()
  const close = useLayerClose()
  const home = sources.find(source => itemsOf(source).some(item => item.value === value))?.id ?? sources[0]?.id
  const [viewed, setViewed] = useState(home)
  const [query, setQuery] = useState(request?.query ?? '')
  const [highlighted, setHighlighted] = useState<T | undefined>(value)
  // Where focus goes after the next render: each request a new object, so asking twice for the same place still moves it.
  const [target, setTarget] = useState<{ to: 'list' | 'levels' | 'search' | 'foot' } | null>(null)
  const rail = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const column = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const footBox = useRef<HTMLDivElement>(null)

  // A search asked for (a slash argument) fills the field, now if the board is open, or when it next opens.
  const [seenRequest, setSeenRequest] = useState(request)
  const [asked, setAsked] = useState<string | undefined>(undefined)
  // The search the board was opened on (a slash argument): Escape closes over it, as over an empty field; only what the
  // person typed is cleared first.
  const [given, setGiven] = useState('')
  let waiting = asked
  if (request !== seenRequest) {
    setSeenRequest(request)
    if (request && open) {
      setQuery(request.query)
      setGiven(request.query)
      setTarget({ to: request.query ? 'search' : 'list' })
    } else if (request) {
      waiting = request.query
      setAsked(waiting)
    }
  }
  // Each opening starts on the chosen item, in its source, with no search (or the one asked for); focus where the
  // trigger asked. Only the opening resets: a value that changes while open is followed by `highlighted` on choice.
  const [opened, setOpened] = useState(open)
  if (open !== opened) {
    setOpened(open)
    if (open) {
      setViewed(home)
      setQuery(waiting ?? '')
      setGiven(waiting ?? '')
      setAsked(undefined)
      setHighlighted(value)
      setTarget({ to: waiting ? 'search' : focus })
    }
  }
  // Asked for another part while open (a key for 权限 after one for 思考): focus moves there, nothing closes.
  const [askedFocus, setAskedFocus] = useState(focus)
  if (focus !== askedFocus) {
    setAskedFocus(focus)
    if (open) setTarget({ to: focus })
  }
  useEffect(() => {
    if (target === null) return
    if (target.to === 'foot') {
      const first = footBox.current?.querySelector<HTMLElement>(
        '[role="radio"][tabindex="0"], [role="radio"][aria-checked="true"], button:not([tabindex="-1"]), [tabindex="0"]',
      )
      if (first) {
        first.focus()
        return
      }
    }
    if (target.to === 'levels') {
      if (!focusRow(column.current, 'checked') && !focusRow(list.current, 'checked')) search.current?.focus()
    } else if (target.to === 'search' || !focusRow(list.current, 'checked')) search.current?.focus()
  }, [target])
  // A list that changes while the board is open (a Harness's models read in, a session's switch regrouping them) can
  // remove the focused row, and focus falls to the page, where Escape and the arrows no longer reach the board. Put it
  // back on the same value if it is still listed, else where the board would open; a surviving focus is left alone.
  const lastFocus = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const previous = lastFocus.current
    if (!open || !previous || previous.isConnected) return
    lastFocus.current = null
    const active = document.activeElement
    if (active !== null && active !== document.body) return
    const inLevels = previous.classList.contains('ui-board-level')
    const value = previous.dataset.value
    const same = value === undefined ? null : list.current?.querySelector<HTMLElement>(`[data-value="${CSS.escape(value)}"]`)
    if (same) same.focus({ preventScroll: true })
    else if (inLevels && focusRow(column.current, 'checked')) return
    else if (!focusRow(list.current, 'checked')) search.current?.focus({ preventScroll: true })
  })

  const shownSource = sources.find(source => source.id === viewed) ?? sources[0]
  const match = (item: BoardItem<T>) =>
    searchMatch ? searchMatch(item, query) : item.label.toLowerCase().includes(query.trim().toLowerCase())
  // A heading per group: while searching, every source's groups that match, each with its source's mark.
  const sections = query.trim()
    ? sources
        .flatMap(source =>
          groupsOf(source).map(group => ({ key: `${source.id}\u0000${group.id}`, source, group, items: group.items.filter(match) })),
        )
        .filter(section => section.items.length)
    : shownSource
      ? groupsOf(shownSource).map(group => ({ key: `${shownSource.id}\u0000${group.id}`, source: shownSource, group, items: group.items }))
      : []
  // On a phone, which has no hover: the heading whose note is shown, tapped open.
  const [noted, setNoted] = useState<string | undefined>(undefined)
  const visible = sections.flatMap(section => section.items)
  const now = highlighted !== undefined && visible.some(item => item.value === highlighted) ? highlighted : value
  const shownLevels = levels(now)
  const fixed = fixedLevelPlacement !== undefined && !hasOtherBoardLevels(shownLevels)
  const inlineLevel = fixedLevelPlacement === 'inline' && fixed
  const fixedLevel = fixed ? shownLevels.options.find(level => level.value === shownLevels.value) : undefined
  // The list's one tab stop: the highlighted row, or the first one shown.
  const stop = visible.some(item => item.value === now) ? now : visible[0]?.value
  const levelStop = shownLevels.options.some(level => level.value === shownLevels.value) ? shownLevels.value : shownLevels.options[0]?.value
  const withRail = sources.length > 1

  const chooseItem = (item: BoardItem<T>) => {
    if (item.disabledReason !== undefined) return
    setHighlighted(item.value)
    const stays = staysOn ? staysOn(item.value) : levels(item.value).options.length > 1
    onItem(item.value)
    if (stays) setTarget({ to: 'levels' })
    else if (!keepOpen) close()
  }
  const chooseLevel = (level: BoardLevel<L>) => {
    if (level.disabledReason !== undefined) return
    onLevel(now, level.value)
    if (!keepOpen) close()
  }
  const showSource = (sourceId: string) => {
    setViewed(sourceId)
    setQuery('')
    // The levels stay the chosen item's: a source without it highlights nothing until a row is focused.
    const source = sources.find(item => item.id === sourceId)
    setHighlighted(source && itemsOf(source).some(item => item.value === value) ? value : undefined)
  }

  const noteFocus = (event: FocusEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLElement) lastFocus.current = event.target
  }
  const boardKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = pickIndex?.(event)
    if (index === undefined) return
    const item = visible[index]
    // Held in the board, the key is the board's even where there is no such row: it never reaches the page.
    event.preventDefault()
    event.stopPropagation()
    if (item) chooseItem(item)
  }
  const railKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    if (event.key === 'ArrowRight' || event.key === 'Enter') {
      event.preventDefault()
      focusRow(list.current, 'checked')
      return
    }
    const current = buttons.findIndex(button => button === document.activeElement)
    const next = nextIndex(event.key, current, buttons.length, 'vertical', () => true)
    if (next === undefined) return
    event.preventDefault()
    buttons[next]?.focus()
    const sourceId = sources[next]?.id
    if (sourceId) showSource(sourceId)
  }
  const listKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (moveInColumn(event)) return
    if (event.key === 'ArrowRight' && !fixed) {
      event.preventDefault()
      focusRow(column.current, 'checked')
    } else if (event.key === 'ArrowLeft' && withRail) {
      event.preventDefault()
      rail.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()
    } else if (event.key.length === 1 && event.key !== ' ' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      // Typing in the list searches: the key lands in the field.
      search.current?.focus()
    }
  }
  const searchKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusRow(list.current, 'first')
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const first = visible.find(item => item.disabledReason === undefined)
      if (first) chooseItem(first)
    } else if (event.key === 'Escape' && query) {
      // Handled here either way: left alone, Chromium's own Escape in a search field clears it, and a sheet (a dialog,
      // which no layer key handler closes) would stay open over the search it was given.
      event.preventDefault()
      event.stopPropagation()
      if (query !== given) setQuery('')
      else close()
    }
  }
  const levelKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (moveInColumn(event)) return
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      const row = list.current?.querySelector<HTMLElement>(`[data-value="${CSS.escape(now ?? '')}"]`)
      focusRow(list.current, row ?? 'checked')
    }
  }

  // Each row's place in the whole list, for the keys printed on the first nine.
  const offsets = sections.map((_, index) => sections.slice(0, index).reduce((sum, section) => sum + section.items.length, 0))
  const items = sections.map((section, sectionIndex) => {
    const { group } = section
    const mark = group.media ?? (query.trim() ? section.source.icon : undefined)
    const heading = (
      <>
        {mark}
        <span>{group.label}</span>
        {group.tag}
      </>
    )
    return (
      <div
        key={section.key}
        className="ui-board-section"
        role="group"
        aria-label={group.label}
        {...(group.hint ? { 'aria-description': group.hint } : {})}>
        {phone && group.hint ? (
          <>
            <button
              type="button"
              className="ui-board-heading ui-board-heading-toggle"
              aria-expanded={noted === section.key}
              onClick={() => {
                setNoted(noted === section.key ? undefined : section.key)
              }}>
              {heading}
            </button>
            {noted === section.key && (group.note ? <BoardNoteView note={group.note} /> : <p className="ui-board-hint">{group.hint}</p>)}
          </>
        ) : (
          <Tooltip content={group.hint}>
            <div className="ui-board-heading" aria-hidden="true">
              {heading}
            </div>
          </Tooltip>
        )}
        {section.items.map((item, itemIndex) => {
          const row = (offsets[sectionIndex] ?? 0) + itemIndex
          const caps = row < 9 ? keyCaps?.(row) : undefined
          const disabled = item.disabledReason !== undefined
          return (
            <Tooltip key={item.value} content={item.disabledReason}>
              <button
                type="button"
                role="menuitemradio"
                tabIndex={item.value === stop ? 0 : -1}
                className="ui-menu-item ui-board-item"
                data-value={item.value}
                data-label={item.label}
                data-media={item.media ? '' : undefined}
                data-highlight={item.value === now ? '' : undefined}
                aria-checked={item.value === value}
                aria-disabled={disabled || undefined}
                aria-labelledby={`${id}-item-${row}`}
                onFocus={() => {
                  setHighlighted(item.value)
                }}
                onMouseDown={
                  phone
                    ? event => {
                        // Previewing another model can resize the bottom-aligned sheet and move the pressed row.
                        if (event.button === 0) event.preventDefault()
                      }
                    : undefined
                }
                onClick={event => {
                  if (phone) event.currentTarget.focus({ preventScroll: true })
                  chooseItem(item)
                }}>
                <span className="ui-menu-item-lead">
                  {item.value === value && <Icon icon={CheckGlyph} size={14} className="ui-menu-check" />}
                </span>
                {item.media && <span className="ui-menu-item-media">{item.media}</span>}
                <span className="ui-menu-item-text">
                  <span id={`${id}-item-${row}`} className="ui-menu-item-label">
                    <span className="ui-menu-item-title">{item.label}</span>
                    {item.tag}
                  </span>
                </span>
                <span className="ui-menu-item-meta">{disabled ? <Icon icon={BlockedGlyph} size={12} /> : caps && <Kbd>{caps}</Kbd>}</span>
              </button>
            </Tooltip>
          )
        })}
      </div>
    )
  })

  const levelRows =
    !fixed
    && shownLevels.options.map(level => (
      <Tooltip key={level.value} content={level.disabledReason ?? level.hint}>
        <button
          type="button"
          role="menuitemradio"
          tabIndex={level.value === levelStop ? 0 : -1}
          className="ui-menu-item ui-board-level"
          data-label={level.label}
          aria-checked={level.value === shownLevels.value}
          aria-disabled={level.disabledReason !== undefined || undefined}
          aria-label={level.label}
          onClick={() => {
            chooseLevel(level)
          }}>
          <span className="ui-menu-item-lead">
            {level.value === shownLevels.value && <Icon icon={CheckGlyph} size={14} className="ui-menu-check" />}
          </span>
          <span className="ui-menu-item-text">
            <span className="ui-menu-item-label">
              <span className="ui-menu-item-title">{level.label}</span>
            </span>
          </span>
        </button>
      </Tooltip>
    ))

  const fixedValue = fixedLevel && (
    <Tooltip content={fixedLevel.hint ?? fixedLevel.disabledReason}>
      <span className="ui-board-level-value">{fixedLevel.label}</span>
    </Tooltip>
  )
  const levelState = (
    <>
      {shownLevels.note && <div className="ui-board-note">{shownLevels.note}</div>}
      {settings && <div className="ui-board-settings">{settings}</div>}
    </>
  )
  const inlineState = inlineLevel && (
    <div className="ui-board-level-summary" role="group" aria-label={levelsLabel} aria-busy={shownLevels.pending || undefined}>
      <div className="ui-board-heading">
        {levelsIcon}
        <span>{levelsLabel}</span>
        {shownLevels.pending && <Spinner size={12} />}
        {fixedValue}
      </div>
      {levelState}
    </div>
  )

  const searchField = (
    <div className="ui-board-search">
      <Icon icon={SearchGlyph} size={14} />
      <input
        ref={search}
        type="search"
        aria-label={UI_COPY.searchIn(label)}
        placeholder={UI_COPY.search}
        value={query}
        onChange={event => {
          setQuery(event.target.value)
        }}
        onKeyDown={searchKeys}
      />
    </div>
  )

  const listColumn = (withFooter: boolean) => (
    <div ref={list} className="ui-board-list" role="menu" aria-label={label} onKeyDown={listKeys}>
      <div className="ui-board-rows">
        {items}
        {visible.length === 0 && (
          <p className="ui-board-empty" role="none">
            {query.trim() ? UI_COPY.noMatches : UI_COPY.noChoices}
          </p>
        )}
      </div>
      {withFooter && inlineState}
      {withFooter && footer && (
        <div className="ui-board-footer">
          <InMenu.Provider value>{footer}</InMenu.Provider>
        </div>
      )}
    </div>
  )

  if (phone)
    return (
      <div className={cx('ui-board', className)} data-phone="" onKeyDown={boardKeys} onFocusCapture={noteFocus}>
        {withRail && (
          <div className="ui-board-tabs" role="tablist" aria-label={UI_COPY.sources}>
            {sources.map(source => (
              <button
                key={source.id}
                type="button"
                role="tab"
                className="ui-board-tab"
                aria-label={source.label}
                aria-selected={source.id === shownSource?.id && !query.trim()}
                onClick={() => {
                  showSource(source.id)
                }}>
                {source.icon}
                <span>{source.label}</span>
              </button>
            ))}
          </div>
        )}
        {searchField}
        {listColumn(false)}
        {inlineState || (
          <div
            className="ui-board-phone-levels"
            role={fixed ? 'group' : 'menu'}
            aria-label={levelsLabel}
            aria-busy={shownLevels.pending || undefined}
            ref={column}
            onKeyDown={levelKeys}>
            <span className="ui-board-heading" aria-hidden={fixed ? undefined : true}>
              {levelsIcon}
              {levelsLabel}
              {shownLevels.pending && <Spinner size={12} />}
              {fixedValue}
            </span>
            {!fixed && <div className="ui-board-chips">{levelRows}</div>}
            {levelState}
          </div>
        )}
        {foot && (
          <div ref={footBox} className="ui-board-foot">
            {foot}
          </div>
        )}
        {/* Under the levels on a phone, so the choice of the model and its thinking stay in one view. */}
        {footer && <div className="ui-board-footer">{footer}</div>}
      </div>
    )

  return (
    <div
      className={cx('ui-board', className)}
      data-rail={withRail ? '' : undefined}
      data-foot={foot ? '' : undefined}
      data-compact={compact ? '' : undefined}
      data-inline-level={inlineLevel ? '' : undefined}
      onKeyDown={boardKeys}
      onFocusCapture={noteFocus}>
      {withRail && (
        <div
          ref={rail}
          className="ui-board-rail"
          role="tablist"
          aria-orientation="vertical"
          aria-label={UI_COPY.sources}
          onKeyDown={railKeys}>
          {sources.map(source => {
            const selectedTab = source.id === shownSource?.id && !query.trim()
            return (
              <Tooltip key={source.id} content={source.tip ?? source.label} describe={source.tip !== undefined}>
                <button
                  type="button"
                  role="tab"
                  className="ui-board-source"
                  aria-label={source.label}
                  aria-selected={selectedTab}
                  data-current={source.id === home ? '' : undefined}
                  tabIndex={selectedTab || (query.trim() && source.id === shownSource?.id) ? 0 : -1}
                  onClick={() => {
                    showSource(source.id)
                  }}>
                  {source.icon}
                </button>
              </Tooltip>
            )
          })}
        </div>
      )}
      <div className="ui-board-middle">
        {searchField}
        {listColumn(true)}
      </div>
      {!inlineLevel && (
        <div
          ref={column}
          className="ui-board-levels"
          role={fixed ? 'group' : 'menu'}
          aria-label={levelsLabel}
          aria-busy={shownLevels.pending || undefined}
          onKeyDown={levelKeys}>
          <div className="ui-board-heading ui-board-levels-head" aria-hidden="true" id={`${id}-levels`}>
            <span className="ui-board-levels-name">
              {levelsIcon}
              {levelsLabel}
            </span>
            {shownLevels.pending && <Spinner size={12} />}
          </div>
          <div className="ui-board-rows">{fixed ? fixedValue : levelRows}</div>
          {levelState}
        </div>
      )}
      {foot && (
        <div ref={footBox} className="ui-board-foot">
          {foot}
        </div>
      )}
    </div>
  )
}
