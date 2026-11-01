import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Grid2X2 } from 'lucide-react'
import { Button, IconButton, InlineNotice } from '@latch/ui'
import type { FileMetadata } from '@latch/protocol'

export function ImagePreview({ file, source, local }: { file: FileMetadata; source: string; local: boolean }) {
  const viewport = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: file.width ?? 0, height: file.height ?? 0 })
  const [bounds, setBounds] = useState({ width: 0, height: 0 })
  const [fit, setFit] = useState(true),
    [scale, setScale] = useState(1),
    [dark, setDark] = useState(false),
    [failed, setFailed] = useState(false)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef({ x: 0, y: 0, left: 0, top: 0, distance: 0, scale: 1 })
  const pending = useRef<{ x: number; y: number; imageX: number; imageY: number } | undefined>(undefined)
  const factor =
    fit && size.width > 0 && size.height > 0
      ? Math.min(1, Math.max(1, bounds.width - 16) / size.width, Math.max(1, bounds.height - 16) / size.height)
      : scale
  const current = useRef(factor)
  current.current = factor
  useEffect(() => setFailed(false), [source])
  useEffect(() => {
    if (file.width && file.height) setSize({ width: file.width, height: file.height })
  }, [file.width, file.height])
  const changeZoom = (next: number, x?: number, y?: number) => {
    const node = viewport.current
    if (!node) return
    const pointX = x ?? node.clientWidth / 2,
      pointY = y ?? node.clientHeight / 2
    pending.current = {
      x: pointX,
      y: pointY,
      imageX: (node.scrollLeft + pointX) / current.current,
      imageY: (node.scrollTop + pointY) / current.current,
    }
    setFit(false)
    setScale(Math.max(0.05, Math.min(8, next)))
  }
  const zoom = useRef(changeZoom)
  zoom.current = changeZoom
  useEffect(() => {
    const node = viewport.current
    if (!node) return
    const observer = new ResizeObserver(() => setBounds({ width: node.clientWidth, height: node.clientHeight }))
    observer.observe(node)
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const rect = node.getBoundingClientRect()
      zoom.current(current.current * Math.exp(-event.deltaY / 400), event.clientX - rect.left, event.clientY - rect.top)
    }
    node.addEventListener('wheel', wheel, { passive: false })
    return () => {
      observer.disconnect()
      node.removeEventListener('wheel', wheel)
    }
  }, [file.width, file.height, failed])
  useLayoutEffect(() => {
    const node = viewport.current,
      point = pending.current
    if (!node || !point) return
    node.scrollLeft = point.imageX * factor - point.x
    node.scrollTop = point.imageY * factor - point.y
    pending.current = undefined
  }, [factor])
  if (file.kind === 'image' && (!file.width || !file.height))
    return <InlineNotice>无法确认图片尺寸，已停止解码。可以下载文件后查看。</InlineNotice>
  if (size.width * size.height > (local ? 100_000_000 : 50_000_000)) return <InlineNotice>图片像素过多，无法在这里预览。</InlineNotice>
  return (
    <div className="file-image">
      <div className="file-preview-controls">
        <Button
          size="xs"
          variant="ghost"
          aria-pressed={fit}
          onClick={() => {
            if (fit) {
              setFit(false)
              setScale(1)
            } else setFit(true)
          }}>
          适应
        </Button>
        <span role="status">{Math.round(factor * 100)}%</span>
        <IconButton label="切换图片棋盘底色" icon={Grid2X2} aria-pressed={dark} onClick={() => setDark(!dark)} />
      </div>
      {failed ? (
        <InlineNotice tone="error">无法解码这张图片，可以下载或在 Mac 上查看。</InlineNotice>
      ) : (
        <div
          ref={viewport}
          className="file-image-viewport"
          data-checker={dark ? 'dark' : 'light'}
          tabIndex={0}
          role="region"
          aria-label="图片预览，支持缩放和平移"
          onKeyDown={event => {
            if (['+', '=', '-'].includes(event.key)) {
              event.preventDefault()
              event.stopPropagation()
              changeZoom(current.current * (event.key === '-' ? 1 / 1.25 : 1.25))
            }
            if (event.key === '0') {
              event.preventDefault()
              setFit(false)
              setScale(1)
            }
            if (event.key.toLowerCase() === 'f') {
              event.preventDefault()
              setFit(true)
            }
          }}
          onPointerDown={event => {
            if (event.button !== 0) return
            const node = event.currentTarget
            node.focus({ preventScroll: true })
            node.setPointerCapture(event.pointerId)
            pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
            const values = [...pointers.current.values()]
            gesture.current = {
              x: event.clientX,
              y: event.clientY,
              left: node.scrollLeft,
              top: node.scrollTop,
              distance: values.length === 2 ? Math.hypot(values[1]!.x - values[0]!.x, values[1]!.y - values[0]!.y) : 0,
              scale: current.current,
            }
          }}
          onPointerMove={event => {
            if (!pointers.current.has(event.pointerId)) return
            const node = event.currentTarget,
              start = gesture.current
            pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
            const values = [...pointers.current.values()]
            if (values.length === 2 && start.distance > 0) {
              const rect = node.getBoundingClientRect(),
                a = values[0]!,
                b = values[1]!
              changeZoom(
                (start.scale * Math.hypot(b.x - a.x, b.y - a.y)) / start.distance,
                (a.x + b.x) / 2 - rect.left,
                (a.y + b.y) / 2 - rect.top,
              )
            } else if (values.length === 1) {
              node.scrollLeft = start.left - (event.clientX - start.x)
              node.scrollTop = start.top - (event.clientY - start.y)
            }
          }}
          onLostPointerCapture={event => pointers.current.delete(event.pointerId)}
          onPointerCancel={event => pointers.current.delete(event.pointerId)}
          onPointerUp={event => {
            pointers.current.delete(event.pointerId)
            const node = event.currentTarget,
              remaining = [...pointers.current.values()][0]
            if (remaining)
              gesture.current = {
                x: remaining.x,
                y: remaining.y,
                left: node.scrollLeft,
                top: node.scrollTop,
                distance: 0,
                scale: current.current,
              }
            if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId)
          }}>
          <img
            src={source}
            alt={file.name}
            draggable={false}
            style={size.width && size.height ? { width: size.width * factor, height: size.height * factor } : undefined}
            onError={() => setFailed(true)}
            onLoad={event => {
              if (file.kind === 'svg') setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
            }}
          />
        </div>
      )}
    </div>
  )
}
