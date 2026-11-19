import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import type { AttachmentRef, Message } from '@latch/protocol'
import { Backdrop, CloseGlyph, ICON_STROKE, MOTION, Shimmer, usePresence } from '@latch/ui'
import { toolDuration } from '../conversation.ts'
import { hostNow, useTicker } from '../core/hostClock.ts'
import { defineCopy } from '../core/i18n.ts'
import { formatDuration } from '../format.ts'
import { MessageAttachments } from './MessageAttachments.tsx'
import { inlineImageWidth } from './InlineMedia.tsx'

const COPY = defineCopy({ making: '生成图片', failed: '图片生成失败' }, { making: 'Generating image', failed: 'Image generation failed' })

/**
 * The canvas a picture is made on is the shape a square picture is drawn at: Codex's image tool makes 1024 × 1024 unless
 * asked otherwise and reports no size before it finishes, so the usual picture lands exactly on the canvas and any other
 * shape only changes its height.
 */
const SQUARE = { width: 1024, height: 1024 }

/** The box a picture of this shape is drawn in; the canvas takes it so that the picture replaces it in place. */
function shapeOf(picture: AttachmentRef | undefined): CSSProperties {
  const { width, height } = picture?.width && picture.height ? { width: picture.width, height: picture.height } : SQUARE
  return { maxWidth: inlineImageWidth(width, height), aspectRatio: `${width} / ${height}` }
}

/** Whether the element is in the window; true until the browser first says otherwise. */
function useInView(ref: RefObject<Element | null>): boolean {
  const [inView, setInView] = useState(true)
  useEffect(() => {
    const element = ref.current
    if (!element || typeof IntersectionObserver !== 'function') return undefined
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) setInView(entry.isIntersecting)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [ref])
  return inView
}

/**
 * The canvas while the picture is being made: a quiet surface, the page's own particles (粒子) gathered in its middle,
 * and the time it has taken. The particles hold a still frame out of view, while the connection is down, once the call
 * settled, and wherever the page's layer does (reduced motion, a hidden window, a reply streaming in view).
 */
function MakingCanvas({
  message,
  picture,
  frozen,
  leaving,
}: {
  message: Message
  picture?: AttachmentRef
  frozen: boolean
  leaving: boolean
}) {
  const own = useRef<HTMLDivElement>(null)
  const inView = useInView(own)
  const running = message.state === 'running' || message.state === 'queued'
  useTicker(running && !frozen ? 'second' : false)
  const duration = toolDuration(message, hostNow())
  const time = duration ? formatDuration(duration.ms, duration.live) : undefined
  return (
    <div
      ref={own}
      className="generated-image-canvas"
      role="status"
      data-leaving={leaving ? '' : undefined}
      data-backdrop-clear=""
      style={shapeOf(picture)}>
      <span className="generated-image-particles ui-backdrop-host" aria-hidden="true">
        <Backdrop kind="field" level="standard" ambient paused={!inView || frozen || !running} />
      </span>
      <span className="generated-image-label">
        {running && !frozen ? <Shimmer variant="working">{COPY.making}</Shimmer> : <span>{COPY.making}</span>}
        {/* Read on its own, not announced each second it ticks. */}
        {time && (
          <span className="process-time" aria-hidden="true">
            {time}
          </span>
        )}
      </span>
    </div>
  )
}

/** The first line of what the row said when it ended without its picture: the Harness's or Latch's own short line. */
const endLine = (message: Message) => (message.tool?.output ?? '').split('\n')[0]!.trim()

/**
 * The Harness's image tool, where its picture goes. While it runs, a canvas of the shape a square picture is drawn at;
 * when the picture arrives it takes the canvas's place: the canvas takes the picture's shape and stays over it until its
 * bytes are drawn, then the two cross-fade (only for a change seen as it happened; read later, the picture is simply
 * there). Failed, or a picture that was not kept, it is one short line; a turn that stopped first leaves a quiet line.
 */
export function GeneratedImage({ message, frozen }: { message: Message; frozen: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const pictures = message.attachments?.length ? message.attachments : undefined
  const making = !pictures && (message.state === 'running' || message.state === 'queued' || message.state === 'awaiting-approval')
  // The canvas was on screen in this view: the picture that comes now takes its place under it.
  const [sawCanvas, setSawCanvas] = useState(making)
  if (making && !sawCanvas) setSawCanvas(true)
  const [drawn, setDrawn] = useState(false)
  const covering = making || (!!pictures && sawCanvas && !drawn)
  const { present, leaving } = usePresence(covering, MOTION.panelExit)

  useEffect(() => {
    if (!pictures || !sawCanvas || drawn) return undefined
    const element = box.current
    if (!element) return undefined
    // Drawn once its bytes have loaded; one that cannot be drawn shows as its tile, which needs no cover either.
    const check = () => {
      const image = element.querySelector<HTMLImageElement>('.message-attachments img')
      if ((image?.complete && image.naturalWidth > 0) || element.querySelector('.message-attachment')) setDrawn(true)
    }
    const failed = () => {
      setDrawn(true)
    }
    element.addEventListener('load', check, true)
    element.addEventListener('error', failed, true)
    const changes = new MutationObserver(check)
    changes.observe(element, { childList: true, subtree: true })
    check()
    return () => {
      element.removeEventListener('load', check, true)
      element.removeEventListener('error', failed, true)
      changes.disconnect()
    }
  }, [pictures, sawCanvas, drawn])

  if (!pictures && !making) {
    const line = endLine(message)
    const failed = message.state === 'failed' || (message.state === 'completed' && !!line)
    return (
      <p className={`generated-image-line${failed ? ' is-failed' : ''}`} data-message-id={message.id}>
        {failed && (
          <span className="process-slot" aria-hidden="true">
            <CloseGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} />
          </span>
        )}
        <span>{line || (failed ? COPY.failed : COPY.making)}</span>
      </p>
    )
  }
  return (
    <div
      ref={box}
      className="generated-image"
      data-message-id={message.id}
      data-state={pictures ? 'drawn' : 'making'}
      data-covered={covering ? '' : undefined}>
      {pictures && <MessageAttachments attachments={pictures} output inline />}
      {present && <MakingCanvas message={message} picture={pictures?.[0]} frozen={frozen} leaving={leaving} />}
    </div>
  )
}
