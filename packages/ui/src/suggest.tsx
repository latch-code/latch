import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import { PHONE_QUERY, pinLayer, setPopover, useMediaQuery } from './internal.ts'

export interface SuggestItem {
  id: string
  label: ReactNode
  description?: ReactNode
  hint?: ReactNode
  source?: ReactNode
  media?: ReactNode
  disabled?: boolean
}

export interface SuggestGroup {
  id: string
  label?: string
  media?: ReactNode
  items: SuggestItem[]
  empty?: ReactNode
}

export interface SuggestProps {
  id: string
  label: string
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  groups: SuggestGroup[]
  activeId?: string
  onActiveChange(id: string): void
  onChoose(id: string): void
  onDismiss(): void
  empty?: ReactNode
  footer?: ReactNode
  /** Frost the floating list when it shows ordinary suggestions. */
  frosted?: boolean
}

/**
 * Suggestions (slash commands, @ files) keep focus in their input: the list is a combobox's popup, the one layer that
 * does not take focus on opening. It is placed by the same routine as every pinned layer, preferring above the input and
 * as wide as it; on a phone it is drawn as a sheet across the visible window, docked above the input and the keyboard,
 * and stays non-modal so typing goes on.
 */
export function Suggest({
  id,
  label,
  open,
  anchorRef,
  groups,
  activeId,
  onActiveChange,
  onChoose,
  onDismiss,
  empty,
  footer,
  frosted,
}: SuggestProps) {
  const layer = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const phone = useMediaQuery(PHONE_QUERY)
  const dismiss = useRef(onDismiss)
  useLayoutEffect(() => {
    dismiss.current = onDismiss
  })

  useLayoutEffect(() => {
    const element = layer.current
    const anchor = anchorRef.current
    setPopover(element, open)
    if (!open || !element || !anchor) return undefined
    // An input that is hidden or covered has nothing to suggest for.
    const gone = () => {
      const box = anchor.getBoundingClientRect()
      return !box.width || !box.height || anchor.closest('[inert], [hidden], [aria-hidden="true"]') !== null
    }
    const leave = () => {
      setPopover(element, false)
      dismiss.current()
    }
    if (gone()) {
      leave()
      return undefined
    }
    const unpin = pinLayer(anchor, element, {
      align: 'start',
      side: 'top',
      gap: phone ? 0 : 6,
      maxHeight: phone ? 260 : 304,
      width: phone ? 'window' : 'anchor',
      growAway: true,
    })
    const ancestors = new MutationObserver(() => {
      if (gone()) leave()
    })
    for (let parent: HTMLElement | null = anchor; parent; parent = parent.parentElement)
      ancestors.observe(parent, { attributes: true, attributeFilter: ['hidden', 'inert', 'aria-hidden', 'class'] })
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !element.contains(event.target) && !anchor.contains(event.target)) dismiss.current()
    }
    document.addEventListener('pointerdown', outside, true)
    return () => {
      unpin()
      ancestors.disconnect()
      document.removeEventListener('pointerdown', outside, true)
      setPopover(element, false)
    }
  }, [open, anchorRef, phone])

  useEffect(() => {
    const current = list.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    const container = list.current
    if (!open || !current || !container) return
    const row = current.getBoundingClientRect()
    const bounds = container.getBoundingClientRect()
    // Only move this list: scrollIntoView can also move the conversation behind the top-layer popup.
    if (row.top < bounds.top) container.scrollTop -= bounds.top - row.top
    else if (row.bottom > bounds.bottom) container.scrollTop += row.bottom - bounds.bottom
  }, [activeId, open])

  return (
    <SuggestPanel
      id={id}
      label={label}
      groups={groups}
      activeId={activeId}
      onActiveChange={onActiveChange}
      onChoose={onChoose}
      empty={empty}
      footer={footer}
      layerRef={layer}
      listRef={list}
      popover="manual"
      sheet={phone}
      frosted={frosted === true}
    />
  )
}

export interface SuggestPanelProps extends Pick<
  SuggestProps,
  'id' | 'label' | 'groups' | 'activeId' | 'onActiveChange' | 'onChoose' | 'empty' | 'footer' | 'frosted'
> {
  layerRef?: RefObject<HTMLDivElement | null>
  listRef?: RefObject<HTMLDivElement | null>
  popover?: 'manual'
  /** Drawn as a phone sheet: edge to edge, the modal radius on top. */
  sheet?: boolean
}

/** The suggestion surface on its own, for an embedded list or a design sheet. */
export function SuggestPanel({
  id,
  label,
  groups,
  activeId,
  onActiveChange,
  onChoose,
  empty,
  footer,
  layerRef,
  listRef,
  popover,
  sheet = false,
  frosted = false,
}: SuggestPanelProps) {
  const visible = groups.filter(group => group.items.length || group.empty)
  return (
    <div
      ref={layerRef}
      popover={popover}
      className="ui-suggest"
      data-sheet={sheet ? '' : undefined}
      data-frosted={popover && frosted && !sheet ? '' : undefined}>
      <div ref={listRef} id={id} role="listbox" aria-label={label} className="ui-suggest-list">
        {visible.map(group => (
          <div key={group.id} role="group" aria-label={group.label}>
            {group.label && (
              <div className="ui-suggest-heading" aria-hidden="true">
                {group.media}
                {group.label}
              </div>
            )}
            {group.items.map(item => (
              <div
                key={item.id}
                id={item.id}
                role="option"
                aria-selected={item.id === activeId}
                aria-disabled={item.disabled || undefined}
                className="ui-suggest-option"
                onMouseDown={event => event.preventDefault()}
                onPointerDown={event => {
                  if (event.pointerType === 'mouse') event.preventDefault()
                }}
                onPointerMove={event => {
                  if (event.pointerType === 'mouse' && !item.disabled) onActiveChange(item.id)
                }}
                onClick={() => {
                  if (!item.disabled) onChoose(item.id)
                }}>
                {item.media && <span className="ui-suggest-media">{item.media}</span>}
                <span className="ui-suggest-label">{item.label}</span>
                {item.hint && <span className="ui-suggest-hint">{item.hint}</span>}
                <span className="ui-suggest-description">{item.description}</span>
                {item.source && <span className="ui-suggest-source">{item.source}</span>}
              </div>
            ))}
            {!group.items.length && group.empty && <div className="ui-suggest-empty">{group.empty}</div>}
          </div>
        ))}
        {!visible.length && (
          <div role="status" className="ui-suggest-empty">
            {empty}
          </div>
        )}
      </div>
      {footer && (
        <div className="ui-suggest-footer" aria-hidden="true">
          {footer}
        </div>
      )}
    </div>
  )
}
