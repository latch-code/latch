import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { EASING, MOTION, motionAllowed } from '@latch/ui'
import { BOARD_GROUPS, type BoardColumnGroup } from './model.ts'
import type { DropAction } from './drag.ts'

/** Movement before a press becomes a drag: below it the press stays a click. */
const THRESHOLD = 6
/** How close to the board body's top or bottom edge the pointer scrolls it, and by how much per move. */
const EDGE = 40
const EDGE_STEP = 16

/** What the columns show while a card is dragged. */
export interface BoardDragView {
  cardId: string
  /** Where the card stands now, by the Host's group. */
  source: BoardColumnGroup
  targets: ReadonlySet<BoardColumnGroup>
  /** The column under the pointer, any column. */
  over: BoardColumnGroup | null
}

export interface BoardDragOptions {
  /** The board's section: the ghost is appended to it while a card is dragged. */
  root: RefObject<HTMLElement | null>
  /** Board view on a wide board with a fine pointer; never the list, the narrow list or a phone. */
  enabled: boolean
  /** The card's current place and targets, read on every move: the Host may move it meanwhile. */
  placeOf: (cardId: string) => { source: BoardColumnGroup; targets: ReadonlyMap<BoardColumnGroup, DropAction> } | undefined
  onDrop: (action: DropAction, point: { x: number; y: number }) => void
}

interface Press {
  cardId: string
  card: HTMLElement
  pointerId: number
  x: number
  y: number
  dragging: boolean
  ghost?: HTMLElement
  /** The pointer's offset inside the card when the drag began. */
  dx: number
  dy: number
  /** Where the ghost stands untransformed: measured, so no containing block is assumed. */
  ox: number
  oy: number
  last: { x: number; y: number }
}

/** The board column under a point, by its `data-group`. */
function columnAt(board: HTMLElement | null, x: number, y: number): BoardColumnGroup | null {
  const column = document.elementFromPoint(x, y)?.closest<HTMLElement>('.work-board-column')
  if (!column || !board?.contains(column)) return null
  return BOARD_GROUPS.find(group => group === column.dataset.group) ?? null
}

const fine = () => typeof matchMedia !== 'function' || matchMedia('(pointer: fine)').matches

const cardIdOf = (card: HTMLElement): string | undefined => card.dataset.workItem ?? card.dataset.workSession

/** The ghost under the pointer: its untransformed place was measured once, so the translation is the whole move. */
function placeGhost(ghost: HTMLElement, current: Press, x: number, y: number): void {
  ghost.style.transform = `translate(${x - current.dx - current.ox}px, ${y - current.dy - current.oy}px)`
}

/** A copy of the card that follows the pointer: inert, unnamed, out of every locator and the accessibility tree. */
function ghostOf(card: HTMLElement, box: DOMRect): HTMLElement {
  const ghost = card.cloneNode(true) as HTMLElement
  ghost.classList.add('work-board-ghost')
  for (const name of ['data-work-item', 'data-work-session', 'data-marked', 'data-drag-source']) ghost.removeAttribute(name)
  for (const node of ghost.querySelectorAll('[id], [data-work-session]')) {
    node.removeAttribute('id')
    node.removeAttribute('data-work-session')
  }
  ghost.setAttribute('aria-hidden', 'true')
  ghost.inert = true
  ghost.style.width = `${box.width}px`
  ghost.style.height = `${box.height}px`
  return ghost
}

/**
 * Dragging a card between the board's columns with a mouse: a press on the card's own button that moves 6px starts it,
 * a ghost follows the pointer, the columns say where it may go, and the drop performs the card's action there. Esc, a
 * drop anywhere else, a lost pointer or the card leaving the snapshot put it back. Nothing else in a card starts it.
 */
export function useBoardDrag({ root, enabled, placeOf, onDrop }: BoardDragOptions) {
  const [view, setView] = useState<BoardDragView | null>(null)
  const press = useRef<Press | null>(null)
  const detach = useRef<(() => void) | null>(null)
  const latest = useRef({ placeOf, onDrop })
  latest.current = { placeOf, onDrop }

  const end = useCallback(
    (how: 'drop' | 'return', released = false) => {
      const current = press.current
      press.current = null
      detach.current?.()
      detach.current = null
      root.current?.removeAttribute('data-dragging')
      setView(null)
      if (!current?.dragging) return
      current.card.removeAttribute('data-drag-source')
      // The click that ends a real drag is not a click on the card, also when Esc ended it before the button came up.
      const swallow = (event: MouseEvent) => {
        event.preventDefault()
        event.stopPropagation()
      }
      window.addEventListener('click', swallow, { capture: true, once: true })
      const release = () => {
        setTimeout(() => {
          window.removeEventListener('click', swallow, { capture: true })
        }, 0)
      }
      if (released) release()
      else {
        const settle = () => {
          document.removeEventListener('pointerup', settle, true)
          document.removeEventListener('pointercancel', settle, true)
          release()
        }
        document.addEventListener('pointerup', settle, true)
        document.addEventListener('pointercancel', settle, true)
      }
      const ghost = current.ghost
      if (!ghost) return
      if (how === 'drop' || !motionAllowed() || !current.card.isConnected) {
        ghost.remove()
        return
      }
      const home = current.card.getBoundingClientRect()
      const to = `translate(${home.left - current.ox}px, ${home.top - current.oy}px)`
      const motion = ghost.animate([{ transform: ghost.style.transform }, { transform: to }], {
        duration: MOTION.panel,
        easing: EASING.panel,
        fill: 'forwards',
      })
      const drop = () => {
        ghost.remove()
      }
      motion.addEventListener('finish', drop)
      motion.addEventListener('cancel', drop)
    },
    [root],
  )

  const update = useCallback(
    (current: Press) => {
      const found = latest.current.placeOf(current.cardId)
      if (!found) {
        end('return')
        return
      }
      const over = columnAt(root.current, current.last.x, current.last.y)
      const targets = new Set(found.targets.keys())
      setView(previous =>
        previous
        && previous.cardId === current.cardId
        && previous.source === found.source
        && previous.over === over
        && previous.targets.size === targets.size
        && [...targets].every(group => previous.targets.has(group))
          ? previous
          : { cardId: current.cardId, source: found.source, targets, over },
      )
    },
    [end, root],
  )

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled || event.button !== 0 || event.pointerType !== 'mouse' || !fine() || press.current) return
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
      const target = event.target instanceof Element ? event.target : null
      // Only the card's own button: its ⋯, its session rows, 要求, 开始 or 完成 and an approval in it stay what they are.
      const main = target?.closest<HTMLElement>('.work-board-card-main')
      const card = main?.closest<HTMLElement>('.work-board-card')
      const cardId = card ? cardIdOf(card) : undefined
      if (!card || !cardId) return
      const current: Press = {
        cardId,
        card,
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        dragging: false,
        dx: 0,
        dy: 0,
        ox: 0,
        oy: 0,
        last: { x: event.clientX, y: event.clientY },
      }
      press.current = current
      const begin = () => {
        const board = root.current
        if (!board || !latest.current.placeOf(current.cardId)) return false
        const box = card.getBoundingClientRect()
        current.dx = current.x - box.left
        current.dy = current.y - box.top
        const ghost = ghostOf(card, box)
        board.append(ghost)
        const origin = ghost.getBoundingClientRect()
        current.ox = origin.left
        current.oy = origin.top
        current.ghost = ghost
        current.dragging = true
        placeGhost(ghost, current, current.x, current.y)
        card.setAttribute('data-drag-source', '')
        board.setAttribute('data-dragging', '')
        getSelection()?.removeAllRanges()
        return true
      }
      const move = (moved: PointerEvent) => {
        if (moved.pointerId !== current.pointerId || press.current !== current) return
        current.last = { x: moved.clientX, y: moved.clientY }
        if (!current.dragging) {
          if (Math.hypot(moved.clientX - current.x, moved.clientY - current.y) < THRESHOLD) return
          if (!begin()) {
            end('return')
            return
          }
        }
        moved.preventDefault()
        if (current.ghost) placeGhost(current.ghost, current, moved.clientX, moved.clientY)
        // In 2 + 2 + 1 the lower row can be below the fold: the board's body scrolls near its edges.
        const body = root.current?.querySelector<HTMLElement>('.work-board-body')
        if (body) {
          const edge = body.getBoundingClientRect()
          if (moved.clientY > edge.bottom - EDGE) body.scrollTop += EDGE_STEP
          else if (moved.clientY < edge.top + EDGE) body.scrollTop -= EDGE_STEP
        }
        update(current)
      }
      const up = (released: PointerEvent) => {
        if (released.pointerId !== current.pointerId || press.current !== current) return
        if (!current.dragging) {
          end('return', true)
          return
        }
        current.last = { x: released.clientX, y: released.clientY }
        const group = columnAt(root.current, released.clientX, released.clientY)
        const action = group ? latest.current.placeOf(current.cardId)?.targets.get(group) : undefined
        end(action ? 'drop' : 'return', true)
        if (action) latest.current.onDrop(action, { x: released.clientX, y: released.clientY })
      }
      const cancel = () => {
        if (press.current === current) end('return', true)
      }
      const key = (pressed: KeyboardEvent) => {
        if (pressed.key !== 'Escape' || press.current !== current) return
        if (current.dragging) {
          pressed.preventDefault()
          pressed.stopPropagation()
        }
        end('return')
      }
      // An image in the card (a Harness mark) would start the browser's own drag and take the pointer away.
      const native = (started: DragEvent) => {
        started.preventDefault()
      }
      document.addEventListener('pointermove', move)
      document.addEventListener('pointerup', up)
      document.addEventListener('pointercancel', cancel)
      document.addEventListener('keydown', key, true)
      document.addEventListener('dragstart', native)
      window.addEventListener('blur', cancel)
      detach.current = () => {
        document.removeEventListener('pointermove', move)
        document.removeEventListener('pointerup', up)
        document.removeEventListener('pointercancel', cancel)
        document.removeEventListener('keydown', key, true)
        document.removeEventListener('dragstart', native)
        window.removeEventListener('blur', cancel)
      }
    },
    [enabled, end, update, root],
  )

  // The board turned into the list, the narrow list or a 待办's page mid-drag: the card goes back.
  useEffect(() => {
    if (!enabled && press.current) end('return')
  }, [enabled, end])
  // Re-read the card's place when the snapshot changes under a held drag.
  useEffect(() => {
    const current = press.current
    if (current?.dragging) update(current)
  })
  useEffect(
    () => () => {
      const current = press.current
      if (current) {
        current.ghost?.remove()
        current.card.removeAttribute('data-drag-source')
      }
      detach.current?.()
    },
    [],
  )

  return { view, onPointerDown }
}
