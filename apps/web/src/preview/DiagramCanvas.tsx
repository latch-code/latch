import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@latch/ui'
import { fitScale, type Room } from '../components/pictureViewer.ts'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  { diagram: 'Mermaid 图表', canvas: '图表画布', out: '缩小', zoom: '缩放比例', in: '放大', fit: '适应全图' },
  { diagram: 'Mermaid diagram', canvas: 'Diagram canvas', out: 'Zoom out', zoom: 'Zoom level', in: 'Zoom in', fit: 'Fit diagram' },
)
const STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const
const MAX_SCALE = STEPS[STEPS.length - 1]

export function DiagramCanvas({ url, expanded = false, onError }: { url: string; expanded?: boolean; onError: () => void }) {
  const viewport = useRef<HTMLDivElement>(null)
  const image = useRef<HTMLImageElement>(null)
  const [size, setSize] = useState<Room>()
  const [room, setRoom] = useState<Room>()
  const [zoom, setZoom] = useState<number>()
  const fit = size && room ? fitScale(size, room) : 1
  const scale = zoom ?? fit
  const minimum = Math.min(fit, STEPS[0])
  const canPan = !!(size && room && (size.width * scale > room.width + 1 || size.height * scale > room.height + 1))
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null)
  const anchor = useRef<{ x: number; y: number; fx: number; fy: number } | null>(null)

  useLayoutEffect(() => {
    const node = viewport.current!
    const measure = () => setRoom({ width: node.clientWidth, height: node.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  // Keep the same point in the diagram under the cursor, or in the middle when a button changes the scale.
  const changeZoom = (requested: number, clientX?: number, clientY?: number) => {
    if (!size || !room) return
    const next = Math.max(minimum, Math.min(requested, MAX_SCALE))
    if (next === scale) return
    const box = image.current!.getBoundingClientRect()
    const view = viewport.current!.getBoundingClientRect()
    const x = clientX ?? view.left + view.width / 2
    const y = clientY ?? view.top + view.height / 2
    anchor.current = { x, y, fx: (x - box.left) / box.width, fy: (y - box.top) / box.height }
    setZoom(next)
  }
  useLayoutEffect(() => {
    const at = anchor.current
    if (!at) return
    const box = image.current!.getBoundingClientRect()
    viewport.current!.scrollLeft += box.left + at.fx * box.width - at.x
    viewport.current!.scrollTop += box.top + at.fy * box.height - at.y
    anchor.current = null
  })

  const latest = useRef({ changeZoom, scale })
  useLayoutEffect(() => {
    latest.current = { changeZoom, scale }
  })
  useEffect(() => {
    const node = viewport.current!
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      latest.current.changeZoom(latest.current.scale * Math.exp(-event.deltaY / 200), event.clientX, event.clientY)
    }
    // Single-finger scrolling stays native. Only an expanded diagram takes a two-finger pinch.
    let pinch: { distance: number; scale: number } | undefined
    const distance = (touches: TouchList) => Math.hypot(touches[1].clientX - touches[0].clientX, touches[1].clientY - touches[0].clientY)
    const start = (event: TouchEvent) => {
      pinch = event.touches.length === 2 ? { distance: distance(event.touches), scale: latest.current.scale } : undefined
    }
    const move = (event: TouchEvent) => {
      if (!pinch || !pinch.distance || event.touches.length !== 2) return
      event.preventDefault()
      const [a, b] = event.touches
      latest.current.changeZoom(
        (pinch.scale * distance(event.touches)) / pinch.distance,
        (a.clientX + b.clientX) / 2,
        (a.clientY + b.clientY) / 2,
      )
    }
    node.addEventListener('wheel', wheel, { passive: false })
    if (expanded) {
      node.addEventListener('touchstart', start, { passive: true })
      node.addEventListener('touchmove', move, { passive: false })
    }
    return () => {
      node.removeEventListener('wheel', wheel)
      node.removeEventListener('touchstart', start)
      node.removeEventListener('touchmove', move)
    }
  }, [expanded])

  const smaller = STEPS.findLast(step => step < scale - 0.001) ?? minimum
  const larger = STEPS.find(step => step > scale + 0.001) ?? MAX_SCALE
  const fitDiagram = () => {
    anchor.current = null
    setZoom(undefined)
    viewport.current?.scrollTo(0, 0)
  }
  return (
    <div className={`diagram-canvas${expanded ? ' expanded' : ''}`} data-compact={(!expanded && room && room.height < 120) || undefined}>
      <div
        className="diagram-surface"
        style={
          size && !expanded
            ? {
                aspectRatio: `${size.width} / ${size.height}`,
                maxHeight: `min(${size.height}px, calc(min(480px, 58svh) - 2 * var(--sp-12)))`,
              }
            : undefined
        }>
        <div
          ref={viewport}
          className="diagram-viewport"
          data-pannable={canPan || undefined}
          tabIndex={0}
          role="region"
          aria-label={COPY.canvas}
          onKeyDown={event => {
            if (event.altKey || event.metaKey || event.ctrlKey) return
            if (event.key === '+' || event.key === '=') changeZoom(larger)
            else if (event.key === '-') changeZoom(smaller)
            else if (event.key === '0') changeZoom(1)
            else if (event.key.toLowerCase() === 'f') fitDiagram()
            else return
            event.preventDefault()
            event.stopPropagation()
          }}
          onPointerDown={event => {
            if (!canPan || event.pointerType === 'touch' || event.button !== 0) return
            const node = event.currentTarget
            node.focus({ preventScroll: true })
            node.setPointerCapture(event.pointerId)
            drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: node.scrollLeft, top: node.scrollTop }
          }}
          onPointerMove={event => {
            const from = drag.current
            if (from?.id !== event.pointerId) return
            event.currentTarget.scrollTo(from.left + from.x - event.clientX, from.top + from.y - event.clientY)
          }}
          onLostPointerCapture={() => {
            drag.current = null
          }}>
          <div className="diagram-sheet">
            <img
              ref={image}
              src={url}
              alt={COPY.diagram}
              draggable={false}
              style={size && room ? { width: size.width * scale, height: size.height * scale } : { visibility: 'hidden' }}
              onLoad={event => {
                const { naturalWidth: width, naturalHeight: height } = event.currentTarget
                if (width > 0 && height > 0) setSize({ width, height })
                else onError()
              }}
              onError={onError}
            />
          </div>
        </div>
      </div>
      {size && room && (
        <div className="diagram-zoom-controls">
          <Button
            variant="ghost"
            className="diagram-step"
            aria-label={COPY.out}
            tooltip={COPY.out}
            disabled={scale <= minimum}
            onClick={() => changeZoom(smaller)}>
            −
          </Button>
          <span role="status" aria-label={COPY.zoom}>
            {Math.max(0.1, Math.round(scale * 1000) / 10)}%
          </span>
          <Button
            variant="ghost"
            className="diagram-step"
            aria-label={COPY.in}
            tooltip={COPY.in}
            disabled={scale >= MAX_SCALE}
            onClick={() => changeZoom(larger)}>
            +
          </Button>
          <Button variant="ghost" className="diagram-fit" onClick={fitDiagram}>
            {COPY.fit}
          </Button>
        </div>
      )}
    </div>
  )
}
