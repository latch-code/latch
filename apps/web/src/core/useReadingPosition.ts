import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent, TouchEvent, WheelEvent } from 'react'

type Mode = 'follow' | 'read'
export interface ReadingAnchor {
  messageId: string
  offset: number
}
export interface ViewportGeometry {
  top: number
  height: number
  extent: number
}
export interface ReadingViewport {
  measure(): ViewportGeometry
  anchor(): ReadingAnchor | null
  positionFor(anchor: ReadingAnchor): number | null
  write(top: number): void
}
interface Position {
  mode: Mode
  top: number
  anchor: ReadingAnchor | null
}
const bottom = (geometry: ViewportGeometry) => Math.max(0, geometry.extent - geometry.height)
const close = (left: number, right: number) => Math.abs(left - right) < 0.75
/** Space kept above a revealed row so it does not sit under the pane's top edge. */
const REVEAL_MARGIN = 24

/** Input intent and session positions, independent of React and DOM measurement. */
export class ReadingPositionController {
  private readonly positions = new Map<string, Position>()
  private sessionId: string | null = null
  private ready = false
  private previous: ViewportGeometry | null = null
  private writtenTop: number | null = null
  private inputUntil = 0
  private pointerHeld = false
  private touchHeld = false
  private following = true
  private request: { sessionId: string; messageId?: string } | null = null

  constructor(
    private readonly changed: (following: boolean) => void = () => {},
    private readonly now = () => performance.now(),
  ) {}

  get isFollowing(): boolean {
    return this.following
  }
  private get position(): Position | undefined {
    return this.sessionId === null ? undefined : this.positions.get(this.sessionId)
  }
  private get readerActive(): boolean {
    return this.pointerHeld || this.touchHeld || this.now() < this.inputUntil
  }

  sync(sessionId: string | null, ready: boolean, viewport: ReadingViewport | null): void {
    if (sessionId !== this.sessionId) {
      this.sessionId = sessionId
      this.previous = null
      this.writtenTop = null
      this.clearInput()
      if (this.request?.sessionId !== sessionId) this.request = null
      if (sessionId !== null) {
        const saved = this.positions.get(sessionId) ?? { mode: 'follow', top: 0, anchor: null }
        this.positions.delete(sessionId)
        this.positions.set(sessionId, saved)
        if (this.positions.size > 100) this.positions.delete(this.positions.keys().next().value!)
      }
      this.report(this.position?.mode !== 'read')
    }
    this.ready = ready
    if (viewport) this.layout(viewport)
    this.settleRequest(viewport)
  }

  private report(following: boolean): void {
    if (this.following === following) return
    this.following = following
    this.changed(following)
  }

  private capture(viewport: ReadingViewport): void {
    const position = this.position
    if (!position) return
    position.top = viewport.measure().top
    if (position.mode === 'read') position.anchor = viewport.anchor()
  }

  /** The only path that issues a programmatic scroll write. */
  layout(viewport: ReadingViewport): void {
    const position = this.position
    if (!this.ready || !position) return
    if (position.mode === 'read' && this.readerActive) {
      // Do not counteract a drag, touch fling, or wheel sequence during layout.
      // Keep the last accepted scroll measurement until its native event arrives;
      // otherwise a token render can erase the evidence of reaching the bottom.
      this.capture(viewport)
      return
    }
    // Before measuring: finding the anchor can change the extent.
    const anchored = position.mode === 'read' && position.anchor ? viewport.positionFor(position.anchor) : null
    const geometry = viewport.measure()
    const target = position.mode === 'follow' ? bottom(geometry) : (anchored ?? position.top)
    const bounded = Math.max(0, Math.min(target, bottom(geometry)))
    if (!close(geometry.top, bounded)) {
      viewport.write(bounded)
      this.writtenTop = viewport.measure().top
    }
    this.previous = viewport.measure()
    // The anchor stands until the reader moves: what is at the top now may be a turn that has yet to take its height.
    if (anchored === null) this.capture(viewport)
    else position.top = this.previous.top
  }

  input(direction: -1 | 0 | 1, viewport: ReadingViewport): void {
    if (!this.ready || !this.position) return
    this.inputUntil = this.now() + 700
    // With nothing to scroll, upward intent cannot move away from the latest output.
    if (direction < 0 && this.position.mode === 'follow' && bottom(viewport.measure()) > 1) {
      this.position.mode = 'read'
      this.capture(viewport)
      this.report(false)
    }
  }

  pointer(active: boolean): void {
    if (active && (!this.ready || !this.position)) return
    if (active === this.pointerHeld) return
    this.pointerHeld = active
    if (!active) this.inputUntil = this.now() + 100
  }

  touch(active: boolean): void {
    if (active && (!this.ready || !this.position)) return
    if (active === this.touchHeld) return
    this.touchHeld = active
    // Keep the browser's post-touch momentum under reader control.
    if (!active) this.inputUntil = this.now() + 1000
  }

  clearInput(): void {
    this.pointerHeld = false
    this.touchHeld = false
    this.inputUntil = 0
  }

  scroll(viewport: ReadingViewport): void {
    const position = this.position
    if (!this.ready || !position) return
    const geometry = viewport.measure()
    const previous = this.previous
    this.previous = geometry
    if (this.writtenTop !== null && close(geometry.top, this.writtenTop)) {
      this.writtenTop = null
      return
    }
    this.writtenTop = null
    // Keyboard/composer resizing can clamp scrollTop before ResizeObserver runs.
    const clamped =
      previous !== null && bottom(geometry) < bottom(previous) - 0.75 && close(geometry.top, Math.min(previous.top, bottom(geometry)))
    if (clamped || !this.readerActive) return
    const delta = previous === null ? 0 : geometry.top - previous.top
    if (delta < -0.75) position.mode = 'read'
    else if (delta > 0.75 && bottom(geometry) - geometry.top <= 4) position.mode = 'follow'
    this.capture(viewport)
    this.report(position.mode === 'follow')
  }

  jumpToLatest(viewport: ReadingViewport | null): void {
    const position = this.position
    if (position) {
      position.mode = 'follow'
      position.anchor = null
    }
    this.clearInput()
    this.report(true)
    if (viewport) this.layout(viewport)
  }

  /**
   * Shows a row, or the latest output when the row is absent, once `sessionId` is
   * on screen and ready. Displaying any other session first drops the request, so
   * neither a late send nor an abandoned approval jump lands on a later visit.
   */
  show(sessionId: string, messageId: string | undefined, viewport: ReadingViewport | null): void {
    this.request = { sessionId, ...(messageId ? { messageId } : {}) }
    this.settleRequest(viewport)
  }

  private settleRequest(viewport: ReadingViewport | null): void {
    const request = this.request
    if (!request || request.sessionId !== this.sessionId || !this.ready || !viewport) return
    this.request = null
    if (request.messageId && viewport.positionFor({ messageId: request.messageId, offset: REVEAL_MARGIN }) !== null)
      this.reveal(request.messageId, viewport)
    else this.jumpToLatest(viewport)
  }

  /**
   * Brings a row to the top margin of the viewport, e.g. an approval the reader asked to see. `offset` places its top
   * elsewhere, above the viewport for a place inside a tall row.
   */
  reveal(messageId: string, viewport: ReadingViewport | null, offset: number = REVEAL_MARGIN): void {
    const position = this.position
    if (!position) return
    const anchor = { messageId, offset }
    this.clearInput()
    if (this.ready && viewport) {
      const target = viewport.positionFor(anchor)
      if (target === null) return
      // A row already within reach of the bottom is simply the latest content.
      if (target >= bottom(viewport.measure()) - 4) {
        this.jumpToLatest(viewport)
        return
      }
    }
    position.mode = 'read'
    position.anchor = anchor
    this.report(false)
    if (viewport) this.layout(viewport)
  }
}

function nestedScrollerConsumes(target: EventTarget | null, container: HTMLElement, direction: number): boolean {
  let element = target instanceof Element ? target : null
  while (element && element !== container) {
    if (
      element instanceof HTMLElement
      && /(auto|scroll)/.test(getComputedStyle(element).overflowY)
      && element.scrollHeight > element.clientHeight + 1
      && (direction < 0 ? element.scrollTop > 0 : element.scrollTop + element.clientHeight < element.scrollHeight - 1)
    )
      return true
    element = element.parentElement
  }
  return false
}

/** Attach containerRef/handlers to the scroller; contentRef to its content wrapper. */
export function useReadingPosition({
  sessionId,
  ready,
  contentVersion,
}: {
  sessionId: string | null
  ready: boolean
  contentVersion: string | number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [isFollowing, setFollowing] = useState(true)
  const controllerRef = useRef<ReadingPositionController | null>(null)
  if (controllerRef.current === null) controllerRef.current = new ReadingPositionController(setFollowing)
  const controller = controllerRef.current
  const touchY = useRef<number | null>(null)

  const viewport = useMemo<ReadingViewport>(() => {
    let drawn: Element[] = []
    /**
     * A far turn is a placeholder of a guessed height, so nothing measured through it holds. Draws the row's turn and the
     * turns under it that the view would show, which also makes the extent true where the view is about to be.
     */
    const draw = (row: Element, viewBottom: number) => {
      const next: Element[] = []
      for (let turn = row.closest('[data-turn]'); turn; turn = turn.nextElementSibling) {
        if (!turn.hasAttribute('data-drawn')) turn.setAttribute('data-drawn', '')
        next.push(turn)
        if (turn.getBoundingClientRect().bottom >= viewBottom) break
      }
      for (const turn of drawn) if (!next.includes(turn)) turn.removeAttribute('data-drawn')
      drawn = next
    }
    return {
      measure: () => {
        const element = containerRef.current
        return { top: element?.scrollTop ?? 0, height: element?.clientHeight ?? 0, extent: element?.scrollHeight ?? 0 }
      },
      anchor: () => {
        const container = containerRef.current
        const content = contentRef.current
        if (!container || !content) return null
        const top = container.getBoundingClientRect().top + container.clientTop
        for (const message of content.querySelectorAll<HTMLElement>('[data-message-id]')) {
          const rect = message.getBoundingClientRect()
          // A row of a turn not drawn measures in full and overflows its placeholder: it is only where the turn is.
          const end = Math.min(rect.bottom, message.closest('[data-turn]')?.getBoundingClientRect().bottom ?? rect.bottom)
          if (rect.height > 0 && end > top && rect.top < top + container.clientHeight) {
            return { messageId: message.dataset.messageId!, offset: rect.top - top }
          }
        }
        return null
      },
      positionFor: anchor => {
        const container = containerRef.current
        const content = contentRef.current
        if (!container || !content) return null
        for (const message of content.querySelectorAll<HTMLElement>('[data-message-id]')) {
          if (message.dataset.messageId !== anchor.messageId) continue
          if (message.getClientRects().length === 0) return null
          draw(message, message.getBoundingClientRect().top - anchor.offset + container.clientHeight)
          return (
            container.scrollTop
            + message.getBoundingClientRect().top
            - container.getBoundingClientRect().top
            - container.clientTop
            - anchor.offset
          )
        }
        return null
      },
      write: top => {
        if (containerRef.current) containerRef.current.scrollTop = top
      },
    }
  }, [])

  useLayoutEffect(() => {
    controller.sync(sessionId, ready, containerRef.current && contentRef.current ? viewport : null)
  }, [controller, sessionId, ready, contentVersion, viewport])

  useEffect(() => {
    const container = containerRef.current
    const content = contentRef.current
    if (!container || !content || typeof ResizeObserver === 'undefined') return
    let frame: number | null = null
    const observer = new ResizeObserver(() => {
      if (frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        controller.layout(viewport)
      })
    })
    observer.observe(container)
    observer.observe(content)
    return () => {
      observer.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [controller, sessionId, ready, viewport])

  useEffect(() => {
    const releasePointer = () => controller.pointer(false)
    const releaseTouch = () => {
      touchY.current = null
      controller.touch(false)
    }
    const blur = () => {
      touchY.current = null
      controller.clearInput()
    }
    window.addEventListener('pointerup', releasePointer)
    window.addEventListener('pointercancel', releasePointer)
    window.addEventListener('touchend', releaseTouch)
    window.addEventListener('touchcancel', releaseTouch)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('pointerup', releasePointer)
      window.removeEventListener('pointercancel', releasePointer)
      window.removeEventListener('touchend', releaseTouch)
      window.removeEventListener('touchcancel', releaseTouch)
      window.removeEventListener('blur', blur)
    }
  }, [controller])

  const handlers = useMemo(
    () => ({
      onScroll: () => controller.scroll(viewport),
      onWheel: (event: WheelEvent<HTMLDivElement>) => {
        if (event.defaultPrevented || event.deltaY === 0 || event.ctrlKey) return
        if (!nestedScrollerConsumes(event.target, event.currentTarget, event.deltaY)) controller.input(event.deltaY < 0 ? -1 : 1, viewport)
      },
      onTouchStart: (event: TouchEvent<HTMLDivElement>) => {
        touchY.current = event.touches[0]?.clientY ?? null
        controller.touch(true)
      },
      onTouchMove: (event: TouchEvent<HTMLDivElement>) => {
        const next = event.touches[0]?.clientY
        if (next === undefined || touchY.current === null) return
        const direction = touchY.current - next
        touchY.current = next
        if (Math.abs(direction) > 1 && !nestedScrollerConsumes(event.target, event.currentTarget, direction))
          controller.input(direction < 0 ? -1 : 1, viewport)
      },
      onTouchEnd: () => {
        touchY.current = null
        controller.touch(false)
      },
      onTouchCancel: () => {
        touchY.current = null
        controller.touch(false)
      },
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || event.pointerType === 'touch') return
        const container = event.currentTarget
        const rect = container.getBoundingClientRect()
        const onScrollbar = event.clientX >= rect.left + container.clientLeft + container.clientWidth
        if (event.target === container || onScrollbar) controller.pointer(true)
      },
      onPointerUp: () => controller.pointer(false),
      onPointerCancel: () => controller.pointer(false),
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
        const target = event.target
        if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return
        if (event.key === ' ' && target instanceof Element && target.closest('button, a')) return
        const upward = ['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)
        const downward = ['ArrowDown', 'PageDown', 'End'].includes(event.key) || (event.key === ' ' && !event.shiftKey)
        if ((upward || downward) && !nestedScrollerConsumes(target, event.currentTarget, upward ? -1 : 1))
          controller.input(upward ? -1 : 1, viewport)
      },
    }),
    [controller, viewport],
  )

  const jumpToLatest = useCallback(() => controller.jumpToLatest(viewport), [controller, viewport])
  const reveal = useCallback(
    (messageId: string, offset?: number) => {
      controller.reveal(messageId, viewport, offset)
    },
    [controller, viewport],
  )
  const show = useCallback(
    (sessionId: string, messageId?: string) => {
      controller.show(sessionId, messageId, containerRef.current && contentRef.current ? viewport : null)
    },
    [controller, viewport],
  )
  return { containerRef, contentRef, isFollowing, jumpToLatest, reveal, show, handlers }
}
