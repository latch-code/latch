import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { ArrowUpRight, PenLine, Square, Undo2 } from 'lucide-react'
import { Button, IconButton, SegmentedControl } from '@latch/ui'
import {
  ANNOTATED_LIMIT,
  annotatedName,
  begin,
  draw,
  extend,
  kept,
  lineWidth,
  toImagePoint,
  type AnnotateTool,
  type Shape,
} from './annotate.ts'

export interface AnnotateImage {
  url: string
  width: number
  height: number
  name: string
}

/** The accent colour as the page draws it, read from the token so a custom theme's accent is the one used. */
function accent(element: Element): string {
  return getComputedStyle(element).getPropertyValue('--accent').trim() || '#2563eb'
}

function encode(canvas: HTMLCanvasElement, type: 'image/png' | 'image/jpeg'): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, type, type === 'image/jpeg' ? 0.9 : undefined))
}

/**
 * A screenshot with a pen, an arrow and a box over it, one colour, undo. 「放进草稿」 encodes the marked picture (PNG,
 * or JPEG when PNG passes the draft's 5 MB) and hands it to the draft; nothing leaves the page before that.
 */
export function DeviceAnnotate({
  image,
  onDone,
  onCancel,
  onFailure,
}: {
  image: AnnotateImage
  onDone: (file: File) => void
  onCancel: () => void
  onFailure: (text: string) => void
}) {
  const [tool, setTool] = useState<AnnotateTool>('arrow')
  const [shapes, setShapes] = useState<Shape[]>([])
  const [drawing, setDrawing] = useState<Shape>()
  const [saving, setSaving] = useState(false)
  const canvas = useRef<HTMLCanvasElement>(null)
  const picture = useRef<HTMLImageElement | null>(null)
  const natural = { width: image.width, height: image.height }

  useEffect(() => {
    const element = new Image()
    element.onload = () => {
      picture.current = element
      setShapes(current => [...current])
    }
    element.src = image.url
    return () => {
      picture.current = null
    }
  }, [image.url])

  useEffect(() => {
    const element = canvas.current
    const context = element?.getContext('2d')
    if (!element || !context) return
    context.clearRect(0, 0, element.width, element.height)
    if (picture.current) context.drawImage(picture.current, 0, 0, element.width, element.height)
    draw(context, drawing ? [...shapes, drawing] : shapes, accent(element), lineWidth(natural))
  })

  const point = (event: PointerEvent<HTMLCanvasElement>) =>
    toImagePoint({ x: event.clientX, y: event.clientY }, event.currentTarget.getBoundingClientRect(), natural)

  const save = async () => {
    const element = canvas.current
    if (!element) return
    setSaving(true)
    try {
      let type: 'image/png' | 'image/jpeg' = 'image/png'
      let blob = await encode(element, type)
      if (blob && blob.size > ANNOTATED_LIMIT) {
        type = 'image/jpeg'
        blob = await encode(element, type)
      }
      if (!blob) onFailure('没有生成图片')
      else if (blob.size > ANNOTATED_LIMIT) onFailure('标注后的图片超过 5 MB')
      else onDone(new File([blob], annotatedName(image.name, type), { type }))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="sim-annotate" aria-label="标注截图" role="group">
      <div className="sim-annotate-bar">
        <SegmentedControl
          label="标注工具"
          size="xs"
          value={tool}
          options={[
            { value: 'arrow', label: '箭头', title: '拖动画箭头' },
            { value: 'box', label: '方框', title: '拖动画方框' },
            { value: 'pen', label: '画笔', title: '按住画线' },
          ]}
          onValueChange={setTool}
        />
        <span className="sim-annotate-glyph" aria-hidden="true">
          {tool === 'arrow' ? <ArrowUpRight size={14} /> : tool === 'box' ? <Square size={14} /> : <PenLine size={14} />}
        </span>
        <IconButton
          size="xs"
          icon={Undo2}
          label="撤销"
          shortcut="⌘Z"
          disabled={shapes.length === 0}
          onClick={() => setShapes(current => current.slice(0, -1))}
        />
        <span className="sim-spacer" />
        <Button size="xs" variant="ghost" onClick={onCancel}>
          取消
        </Button>
        <Button size="xs" variant="primary" loading={saving} onClick={() => void save()}>
          放进草稿
        </Button>
      </div>
      <div
        className="sim-annotate-stage"
        onKeyDown={event => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'z') {
            event.preventDefault()
            setShapes(current => current.slice(0, -1))
          } else if (event.key === 'Escape') onCancel()
        }}>
        <canvas
          ref={canvas}
          className="sim-annotate-canvas"
          width={image.width}
          height={image.height}
          tabIndex={0}
          aria-label="在截图上标注"
          style={{ aspectRatio: `${image.width} / ${image.height}` }}
          onPointerDown={event => {
            if (event.button !== 0) return
            event.currentTarget.setPointerCapture(event.pointerId)
            setDrawing(begin(tool, point(event)))
          }}
          onPointerMove={event => {
            if (drawing) setDrawing(extend(drawing, point(event)))
          }}
          onPointerUp={() => {
            if (drawing && kept(drawing)) setShapes(current => [...current, drawing])
            setDrawing(undefined)
          }}
          onPointerCancel={() => setDrawing(undefined)}
        />
      </div>
    </div>
  )
}
