import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { FocusEvent, KeyboardEvent, PointerEvent } from 'react'
import { splitChangeNote, type Message } from '@latch/protocol'
import { ownTextStart, type Turn } from '../conversation.ts'
import { overlayDismissed } from '../escapeGrace.ts'
import { escapeHiddenCharacters } from './VisibleText.tsx'

const MIN_TURNS = 6
const PREVIEW_LIMIT = 240

interface Marker {
  id: string
  excerpt: string
}

function excerptFor(message: Message): string {
  const text = splitChangeNote(message.text.slice(ownTextStart(message))).text.trim()
  if (!text) return message.attachments?.length ? '附件' : '用户消息'
  const prefix = text
    .slice(0, PREVIEW_LIMIT)
    .replace(/[\uD800-\uDBFF]$/u, '')
    .trimEnd()
  return escapeHiddenCharacters(prefix) + (prefix.length < text.length ? '…' : '')
}

function projectMarkers(turns: readonly Turn[]) {
  const markers: Marker[] = []
  const byMessage = new Map<string, number>()
  for (const turn of turns) {
    const target = turn.user ?? turn.replies.find(message => message.role === 'assistant' && message.text.trim())
    if (!target) continue
    const index = markers.length
    markers.push({ id: target.id, excerpt: excerptFor(target) })
    byMessage.set(target.id, index)
    for (const reply of turn.replies) byMessage.set(reply.id, index)
  }
  return { markers, byMessage }
}

/** Only this scroller moves when changing which marks are in view. */
function keepMarkerInView(track: HTMLElement, button: HTMLElement | null) {
  if (!button) return
  const marker = button.getBoundingClientRect()
  const viewport = track.getBoundingClientRect()
  if (marker.top < viewport.top) track.scrollTop += marker.top - viewport.top
  else if (marker.bottom > viewport.bottom) track.scrollTop += marker.bottom - viewport.bottom
}

const markerButton = (target: EventTarget | null) =>
  target instanceof Element ? target.closest<HTMLButtonElement>('[data-turn-index]') : null

export const ConversationRail = memo(function ConversationRail({
  turns,
  liveId,
  getReadingMessageId,
  subscribeToReadingAnchor,
  onReveal,
}: {
  turns: readonly Turn[]
  liveId?: string | undefined
  getReadingMessageId: () => string | null
  subscribeToReadingAnchor: (listener: () => void) => () => void
  onReveal: (messageId: string) => void
}) {
  const { markers, byMessage } = useMemo(() => projectMarkers(turns), [turns])
  const visible = markers.length >= MIN_TURNS
  const readCurrentIndex = useCallback(() => {
    const anchor = getReadingMessageId()
    if (anchor === null) return markers.length - 1
    return byMessage.get(anchor) ?? (anchor === liveId ? markers.length - 1 : undefined)
  }, [byMessage, getReadingMessageId, liveId, markers.length])
  const currentIndex = useSyncExternalStore(subscribeToReadingAnchor, readCurrentIndex)
  const rail = useRef<HTMLElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const preview = useRef<HTMLDivElement>(null)
  const pointerInside = useRef(false)
  const resumeHoverOnMovement = useRef(false)
  const touchBrowsing = useRef(false)
  const [hovered, setHovered] = useState<HTMLButtonElement | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const [focusPreview, setFocusPreview] = useState<HTMLButtonElement | null>(null)
  const trigger = hovered ?? focusPreview
  const excerpt = trigger ? markers[byMessage.get(trigger.value) ?? -1]?.excerpt : undefined

  const keepCurrentInView = useCallback(() => {
    const scroller = track.current
    if (scroller && !pointerInside.current && !touchBrowsing.current && !scroller.querySelector(':focus-visible')) {
      const current = scroller.querySelector<HTMLElement>('[aria-current="true"]') ?? scroller.querySelector<HTMLElement>('[tabindex="0"]')
      keepMarkerInView(scroller, current)
    }
  }, [])
  useLayoutEffect(keepCurrentInView, [keepCurrentInView, currentIndex, markers])
  useEffect(() => {
    const scroller = track.current
    if (!visible || !scroller) return
    const observer = new ResizeObserver(keepCurrentInView)
    observer.observe(scroller)
    const pointerDown = (event: globalThis.PointerEvent) => {
      if (event.pointerType !== 'touch' || !(event.target instanceof Node)) return
      touchBrowsing.current = scroller.contains(event.target)
      if (!touchBrowsing.current) keepCurrentInView()
    }
    window.addEventListener('pointerdown', pointerDown, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('pointerdown', pointerDown, true)
    }
  }, [keepCurrentInView, visible])

  useLayoutEffect(() => {
    const container = rail.current
    const surface = preview.current
    if (!trigger || !container || !surface) return
    const place = () => {
      const bounds = container.getBoundingClientRect()
      const marker = trigger.getBoundingClientRect()
      const trackTop = track.current ? track.current.getBoundingClientRect().top - bounds.top : 0
      const height = surface.offsetHeight
      const top = (marker.top + marker.bottom - height) / 2 - bounds.top
      surface.style.top = `${Math.min(Math.max(trackTop, top), Math.max(0, bounds.height - height))}px`
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(container)
    observer.observe(surface)
    return () => observer.disconnect()
  }, [trigger, excerpt])

  const dismiss = useCallback(() => {
    setHovered(null)
    setFocusPreview(null)
  }, [])
  useLayoutEffect(() => {
    if (!visible) return
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      const surface = preview.current
      const upperLayer = document.querySelector('dialog[open], :popover-open:not([role="tooltip"]):not([aria-hidden="true"])')
      if (!surface && !upperLayer) return
      // Closing a dialog can deliver pointerover to the rail again without moving the pointer.
      resumeHoverOnMovement.current = true
      if (!surface) return
      dismiss()
      if (
        upperLayer
        || !surface.checkVisibility({ visibilityProperty: true })
        || rail.current?.closest('[inert], [hidden], [aria-hidden="true"]')
      ) {
        pointerInside.current = false
        return
      }
      event.preventDefault()
      event.stopPropagation()
      overlayDismissed()
    }
    window.addEventListener('keydown', onEscape, true)
    return () => window.removeEventListener('keydown', onEscape, true)
  }, [dismiss, visible])

  const pointerOver = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === 'touch' || !(event.target instanceof Element) || preview.current?.contains(event.target)) return
    pointerInside.current = true
    touchBrowsing.current = false
    if (!resumeHoverOnMovement.current) setHovered(markerButton(event.target))
  }
  const pointerMove = (event: PointerEvent<HTMLElement>) => {
    if (
      !resumeHoverOnMovement.current
      || event.pointerType === 'touch'
      || !event.nativeEvent.isTrusted
      || (!event.movementX && !event.movementY)
    )
      return
    resumeHoverOnMovement.current = false
    pointerOver(event)
  }
  const focus = (event: FocusEvent<HTMLElement>) => {
    const button = markerButton(event.target)
    if (!button?.matches(':focus-visible')) return
    setFocused(button.value)
    setFocusPreview(button)
  }
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    const button = markerButton(event.target)
    const scroller = track.current
    if (!button || !scroller || event.altKey || event.ctrlKey || event.metaKey) return
    const index = Number(button.dataset.turnIndex)
    const last = markers.length - 1
    let next: number
    switch (event.key) {
      case 'ArrowUp':
        next = Math.max(0, index - 1)
        break
      case 'ArrowDown':
        next = Math.min(last, index + 1)
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = last
        break
      default:
        return
    }
    event.preventDefault()
    setHovered(null)
    const target = scroller.children.item(next)
    if (!(target instanceof HTMLButtonElement)) return
    keepMarkerInView(scroller, target)
    target.focus({ preventScroll: true })
  }

  if (!visible) return null
  const tabIndex = (focused === null ? undefined : byMessage.get(focused)) ?? currentIndex ?? 0
  return (
    <nav
      className="conversation-rail"
      ref={rail}
      aria-label="会话定位"
      onPointerOver={pointerOver}
      onPointerMove={pointerMove}
      onPointerLeave={event => {
        if (event.pointerType === 'touch') return
        pointerInside.current = false
        setHovered(null)
        keepCurrentInView()
      }}
      onPointerDown={dismiss}
      onFocus={focus}
      onBlur={event => {
        if (event.currentTarget.contains(event.relatedTarget)) return
        setFocused(null)
        setFocusPreview(null)
        keepCurrentInView()
      }}
      onKeyDown={keyDown}>
      <div className="conversation-rail-track" ref={track} onWheel={dismiss}>
        {markers.map((marker, index) => (
          <button
            type="button"
            key={marker.id}
            value={marker.id}
            data-turn-index={index}
            data-preview={trigger?.value === marker.id ? '' : undefined}
            tabIndex={index === tabIndex ? 0 : -1}
            aria-current={index === currentIndex ? true : undefined}
            aria-label={`${index + 1} · ${marker.excerpt}`}
            onClick={() => {
              touchBrowsing.current = false
              dismiss()
              onReveal(marker.id)
            }}
          />
        ))}
      </div>
      {excerpt && (
        <div className="conversation-rail-preview" ref={preview} aria-hidden="true">
          <span>{excerpt}</span>
        </div>
      )}
    </nav>
  )
})
