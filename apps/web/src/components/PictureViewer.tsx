import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeftGlyph, ChevronRightGlyph, CloseGlyph, DownloadGlyph, FolderOpenGlyph, IconButton, Modal } from '@latch/ui'
import { defineCopy } from '../core/i18n.ts'
import { mediaBytes } from '../preview/fileImages.ts'
import {
  fitScale,
  inReadingOrder,
  openViewer,
  returnTarget,
  stepViewer,
  swipeOutcome,
  toggleZoom,
  zoomable,
  type Room,
  type ViewerPicture,
  type ViewerState,
} from './pictureViewer.ts'

const COPY = defineCopy(
  {
    openInFiles: '在文件中打开',
    download: '下载',
    downloadFailed: '下载失败',
    close: '关闭',
    previous: '上一张',
    next: '下一张',
  },
  {
    openInFiles: 'Open in Files',
    download: 'Download',
    downloadFailed: 'Download failed',
    close: 'Close',
    previous: 'Previous',
    next: 'Next',
  },
)

interface PictureRegistry {
  register: (id: string, get: () => ViewerPicture | undefined) => () => void
  open: (id: string) => void
  /** A picture's handle was renewed: the open viewer draws from the new one. */
  changed: () => void
}

const Registry = createContext<PictureRegistry | null>(null)

/**
 * The pictures of one turn or message, and the one viewer they share: pressing any of them opens it on that picture,
 * with ← → stepping through the others in reading order.
 */
function useViewerGroup(): { registry: PictureRegistry; viewer: ReactNode } {
  const entries = useRef(new Map<string, () => ViewerPicture | undefined>())
  const [state, setState] = useState<ViewerState>()
  const [revision, setRevision] = useState(0)
  const latest = useRef(state)
  useLayoutEffect(() => {
    latest.current = state
  })
  const pressed = useRef<HTMLElement | null>(null)
  const focusBack = useRef<HTMLElement | null>(null)
  const registry = useMemo<PictureRegistry>(
    () => ({
      register: (id, get) => {
        entries.current.set(id, get)
        return () => {
          entries.current.delete(id)
        }
      },
      open: id => {
        const pictures = [...entries.current.values()].flatMap(get => get() ?? [])
        const next = openViewer(inReadingOrder(pictures), id)
        if (!next) return
        pressed.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        setState(next)
      },
      changed: () => {
        if (latest.current) setRevision(value => value + 1)
      },
    }),
    [],
  )
  const close = useCallback((then?: () => void) => {
    const current = latest.current
    if (!current) return
    // A picture redrawn while the viewer was open (its handle renewed) is a new element for the same file.
    const shown = current.pictures[current.index]
    const redrawn = [...entries.current.values()]
      .map(get => get())
      .find(picture => picture?.url === shown?.url && picture.element()?.isConnected)
      ?.element()
    focusBack.current = shown?.element()?.isConnected ? shown.element() : (redrawn ?? returnTarget(current, pressed.current))
    setState(undefined)
    then?.()
  }, [])
  // After the dialog gave focus back to what opened it: the picture last shown, which may be another one.
  useEffect(() => {
    if (state || !focusBack.current) return
    const target = focusBack.current
    focusBack.current = null
    if (target.isConnected) target.focus({ preventScroll: true })
  }, [state])
  // The pictures as they are now: a handle renewed while the viewer is open replaces the one it opened with.
  const live = useCallback((picture: ViewerPicture) => entries.current.get(picture.id)?.() ?? picture, [])
  const viewer = state
    ? createPortal(<Viewer state={state} live={live} revision={revision} onChange={setState} onClose={close} />, document.body)
    : null
  return { registry, viewer }
}

/** The pictures inside share one viewer; a group inside another takes its own pictures out of the outer one. */
export function PictureGroup({ children }: { children: ReactNode }) {
  const { registry, viewer } = useViewerGroup()
  return (
    <Registry.Provider value={registry}>
      {children}
      {viewer}
    </Registry.Provider>
  )
}

/** Whether a picture here already has a group to join. */
export function useInPictureGroup(): boolean {
  return useContext(Registry) !== null
}

/**
 * A picture's place in its group's viewer: `open` shows it large. Without a group around it the picture has a viewer
 * of its own, which the caller renders (`viewer`, beside the picture, never inside its button).
 */
export function usePictureViewer(picture: Omit<ViewerPicture, 'id'> | undefined): { open: () => void; viewer: ReactNode } {
  const id = useId()
  const outer = useContext(Registry)
  const own = useViewerGroup()
  const registry = outer ?? own.registry
  const latest = useRef(picture)
  useLayoutEffect(() => {
    const before = latest.current?.url
    latest.current = picture
    if (before !== undefined && picture && before !== picture.url) registry.changed()
  })
  const present = picture !== undefined
  useEffect(() => {
    if (!present) return undefined
    return registry.register(id, () => (latest.current ? { ...latest.current, id } : undefined))
  }, [registry, id, present])
  const open = useCallback(() => registry.open(id), [registry, id])
  return { open, viewer: outer ? null : own.viewer }
}

/** The room the picture has inside the stage, less its padding. */
function roomOf(stage: HTMLElement): Room {
  const style = getComputedStyle(stage)
  return {
    width: stage.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight),
    height: stage.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom),
  }
}

interface Gesture {
  id: number
  touch: boolean
  onImage: boolean
  x: number
  y: number
  time: number
  left: number
  top: number
  moved: boolean
}

/**
 * The picture large over the dimmed page: fitted to the window, never cropped and never drawn past its own size. A press
 * on the picture shows it at 100% where it was pressed (drag or scroll to look around) and another fits it again; on
 * touch that is a double tap, a swipe steps, and a drag down closes. Esc, the close button or a press beside the
 * picture closes it.
 */
function Viewer({
  state,
  live,
  revision,
  onChange,
  onClose,
}: {
  state: ViewerState
  live: (picture: ViewerPicture) => ViewerPicture
  /** Bumped when a picture's handle was renewed. */
  revision: number
  onChange: (next: ViewerState) => void
  onClose: (then?: () => void) => void
}) {
  const picture = live(state.pictures[state.index]!)
  // A lapsed handle: the picture in the message is asked to renew it once, then the viewer loads again.
  const [renewed, setRenewed] = useState<{ id: string; again: boolean }>()
  const again = renewed?.id === picture.id && renewed.again
  const count = state.pictures.length
  const stage = useRef<HTMLDivElement>(null)
  const image = useRef<HTMLImageElement>(null)
  const [room, setRoom] = useState<Room>()
  const [natural, setNatural] = useState<{ url: string; width: number; height: number }>()
  const [download, setDownload] = useState<{ url: string; state: 'running' | 'failed' }>()
  const gesture = useRef<Gesture | null>(null)
  const lastTap = useRef<{ time: number; x: number; y: number } | null>(null)
  const lastTouch = useRef(false)
  const dragged = useRef(false)
  // Where the press began: with the pointer captured, the click that follows is aimed at the stage, wherever it was.
  const pressedImage = useRef(false)
  const anchor = useRef<{ fx: number; fy: number; cx: number; cy: number } | null>(null)
  const controller = useRef<AbortController | null>(null)

  const size =
    natural?.url === picture.url ? natural : picture.width && picture.height ? { width: picture.width, height: picture.height } : undefined
  const scale = size && room ? fitScale(size, room) : undefined
  const canZoom = !!size && !!room && zoomable(size, room)

  useLayoutEffect(() => {
    const element = stage.current
    if (!element) return undefined
    const measure = () => setRoom(roomOf(element))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => () => controller.current?.abort(), [])

  // At 100% the point that was pressed stays under the pointer; without one, the middle of the picture.
  useLayoutEffect(() => {
    const element = stage.current
    if (!element || !state.zoomed || !size) return
    const at = anchor.current
    anchor.current = null
    const box = element.getBoundingClientRect()
    const x = at ? at.fx * size.width - (at.cx - box.left) : (size.width - element.clientWidth) / 2
    const y = at ? at.fy * size.height - (at.cy - box.top) : (size.height - element.clientHeight) / 2
    element.scrollTo(Math.max(0, x), Math.max(0, y))
  }, [state.zoomed, state.index, size?.width, size?.height])

  const step = (delta: 1 | -1) => {
    const next = stepViewer(state, delta)
    if (next !== state) onChange(next)
  }
  const zoomAt = (clientX: number, clientY: number) => {
    if (!size || !room) return
    const box = image.current?.getBoundingClientRect()
    if (!state.zoomed && box && box.width > 0 && box.height > 0)
      anchor.current = { fx: (clientX - box.left) / box.width, fy: (clientY - box.top) / box.height, cx: clientX, cy: clientY }
    const next = toggleZoom(state, size, room)
    if (next !== state) onChange(next)
  }
  const settle = () => {
    const element = image.current
    if (!element) return
    element.dataset.settling = ''
    element.style.removeProperty('transform')
    element.style.removeProperty('opacity')
    window.setTimeout(() => delete element.dataset.settling, 200)
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest('button'))) return
    const touch = event.pointerType !== 'mouse'
    lastTouch.current = touch
    dragged.current = false
    pressedImage.current = event.target === image.current
    const element = stage.current!
    gesture.current = {
      id: event.pointerId,
      touch,
      onImage: event.target === image.current,
      x: event.clientX,
      y: event.clientY,
      time: event.timeStamp,
      left: element.scrollLeft,
      top: element.scrollTop,
      moved: false,
    }
    // A mouse drags the zoomed picture; a finger at fit swipes. A finger at 100% pans natively.
    if ((state.zoomed && !touch) || (!state.zoomed && touch)) {
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // The gesture still works while the pointer stays over the stage.
      }
    }
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current
    if (!current || current.id !== event.pointerId) return
    const dx = event.clientX - current.x,
      dy = event.clientY - current.y
    if (!current.moved && Math.hypot(dx, dy) > 6) current.moved = true
    if (!current.moved) return
    if (state.zoomed && !current.touch) {
      stage.current!.scrollTo(current.left - dx, current.top - dy)
    } else if (!state.zoomed && current.touch && image.current) {
      const across = Math.abs(dx) > Math.abs(dy)
      const down = Math.max(0, dy)
      image.current.style.transform = across ? `translateX(${dx}px)` : `translateY(${down}px)`
      if (!across) image.current.style.opacity = String(Math.max(0.4, 1 - down / 400))
    }
  }
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current
    gesture.current = null
    if (!current || current.id !== event.pointerId) return
    if (!current.touch) {
      dragged.current = current.moved
      return
    }
    if (current.moved) {
      if (state.zoomed) return
      const outcome = swipeOutcome(event.clientX - current.x, event.clientY - current.y, event.timeStamp - current.time)
      if (outcome === 'close') onClose()
      else if ((outcome === 'next' && state.index < count - 1) || (outcome === 'previous' && state.index > 0)) {
        image.current?.style.removeProperty('transform')
        image.current?.style.removeProperty('opacity')
        step(outcome === 'next' ? 1 : -1)
      } else settle()
      return
    }
    // A tap: twice on the picture toggles 100%, once beside it closes.
    if (!current.onImage) {
      onClose()
      return
    }
    const previous = lastTap.current
    if (previous && event.timeStamp - previous.time < 320 && Math.hypot(event.clientX - previous.x, event.clientY - previous.y) < 32) {
      lastTap.current = null
      zoomAt(event.clientX, event.clientY)
    } else lastTap.current = { time: event.timeStamp, x: event.clientX, y: event.clientY }
  }
  const onPointerCancel = () => {
    gesture.current = null
    if (!state.zoomed) settle()
  }
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    // A touch was handled when it ended; a mouse drag is not a press.
    if (lastTouch.current || dragged.current) {
      dragged.current = false
      return
    }
    const onImage = pressedImage.current || event.target === image.current
    pressedImage.current = false
    if (onImage) zoomAt(event.clientX, event.clientY)
    else if (event.target === event.currentTarget) onClose()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The viewer's keys are its own: nothing behind it (a running turn, a side panel) hears them.
    if (event.key === 'Escape') event.stopPropagation()
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !state.zoomed && !event.altKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault()
      event.stopPropagation()
      step(event.key === 'ArrowRight' ? 1 : -1)
    }
  }
  const save = async () => {
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    setDownload({ url: picture.url, state: 'running' })
    try {
      const bytes = await mediaBytes(picture.url, location.href, current.signal)
      if (current.signal.aborted) return
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
      const link = document.createElement('a')
      link.href = url
      link.download = picture.fileName ?? picture.name
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      setDownload(undefined)
    } catch {
      if (!current.signal.aborted) setDownload({ url: picture.url, state: 'failed' })
    }
  }
  const saving = download?.url === picture.url ? download.state : undefined
  const shown =
    state.zoomed && size ? size : size && scale !== undefined ? { width: size.width * scale, height: size.height * scale } : undefined

  return (
    <Modal label={picture.name} variant="dialog" onClose={() => onClose()} className="picture-viewer">
      {/* Clicks and keys stop here: the turn behind the viewer must not take them as its own. */}
      <div className="picture-viewer-frame" onClick={event => event.stopPropagation()} onKeyDown={onKeyDown}>
        <header className="picture-viewer-bar">
          <p className="picture-viewer-name">
            <span className="picture-viewer-title">{picture.name}</span>
            {count > 1 && (
              <span className="picture-viewer-count">
                {state.index + 1} / {count}
              </span>
            )}
          </p>
          <div className="picture-viewer-actions">
            {picture.openInFiles && (
              <IconButton label={COPY.openInFiles} icon={FolderOpenGlyph} size="md" onClick={() => onClose(picture.openInFiles)} />
            )}
            {picture.download && (
              <IconButton
                label={COPY.download}
                icon={DownloadGlyph}
                size="md"
                busy={saving === 'running'}
                {...(saving === 'failed' ? { tooltip: COPY.downloadFailed } : {})}
                onClick={() => void save()}
              />
            )}
            <IconButton label={COPY.close} icon={CloseGlyph} size="md" data-layer-close="" onClick={() => onClose()} />
          </div>
        </header>
        <div
          ref={stage}
          className="picture-viewer-stage"
          tabIndex={-1}
          data-autofocus=""
          data-zoom={state.zoomed ? 'actual' : canZoom ? 'fit' : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onClick={onClick}>
          <img
            key={`${picture.url}\n${revision}\n${again}`}
            ref={image}
            className="picture-viewer-image"
            src={picture.url}
            alt={picture.name}
            draggable={false}
            decoding="async"
            style={shown ? { width: shown.width, height: shown.height } : undefined}
            onError={() => {
              if (renewed?.id === picture.id || !picture.renew) return
              picture.renew()
              setRenewed({ id: picture.id, again: false })
              window.setTimeout(() => setRenewed(current => (current?.id === picture.id ? { ...current, again: true } : current)), 1500)
            }}
            onLoad={event => {
              const { naturalWidth, naturalHeight } = event.currentTarget
              if (naturalWidth > 0 && naturalHeight > 0) setNatural({ url: picture.url, width: naturalWidth, height: naturalHeight })
            }}
          />
        </div>
        {count > 1 && (
          <>
            <IconButton
              className="picture-viewer-step"
              data-side="previous"
              label={COPY.previous}
              icon={ChevronLeftGlyph}
              size="lg"
              disabled={state.index === 0}
              onClick={() => step(-1)}
            />
            <IconButton
              className="picture-viewer-step"
              data-side="next"
              label={COPY.next}
              icon={ChevronRightGlyph}
              size="lg"
              disabled={state.index === count - 1}
              onClick={() => step(1)}
            />
          </>
        )}
      </div>
    </Modal>
  )
}
