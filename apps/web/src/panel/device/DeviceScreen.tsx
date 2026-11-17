import { useEffect, useRef, useState, type PointerEvent, type WheelEvent } from 'react'
import { SIMULATOR_STREAM, type SimulatorInputEvent, type SimulatorLiveDescription } from '@latch/protocol'
import {
  LiveReader,
  chooseCodec,
  containedBox,
  parseDescription,
  pointerToDevice,
  streamQuery,
  uprightSize,
  uprightTransform,
} from './live.ts'
import { screenSize, type Zoom } from './zoom.ts'

export type LiveState = 'connecting' | 'live' | 'unavailable'

export interface DeviceScreenProps {
  udid: string
  name: string
  zoom: Zoom
  box: { width: number; height: number }
  pixelRatio: number
  /** The stream's state: the panel falls back to screenshots once it is unavailable. */
  onState: (state: LiveState, detail?: { reason?: string; size?: { width: number; height: number }; fps?: number }) => void
  /** A touch, in device points; absent while input is off. */
  onInput?: ((event: SimulatorInputEvent) => void) | undefined
}

/** How long a wheel gesture's finger stays down after the last wheel event. */
const WHEEL_LIFT_MS = 150
/** Reconnects after a stream ends that was not the device's doing, before falling back to screenshots. */
const RECONNECTS = 3

/**
 * The live picture: the Host's binary stream decoded with WebCodecs' `VideoDecoder` (H.264), or JPEG frames through
 * `createImageBitmap`, drawn upright on a canvas. A pointer on it is a finger: press, hold, drag; the wheel scrolls
 * with a short drag. Nothing here is kept: frames go straight to the canvas.
 */
export function DeviceScreen({ udid, name, zoom, box, pixelRatio, onState, onInput }: DeviceScreenProps) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [description, setDescription] = useState<SimulatorLiveDescription>()
  const stateRef = useRef(onState)
  stateRef.current = onState

  useEffect(() => {
    const controller = new AbortController()
    let codec = chooseCodec(globalThis as { VideoDecoder?: unknown })
    let reconnects = 0
    let decoder: VideoDecoder | undefined
    let current: SimulatorLiveDescription | undefined
    let waitingKey = true
    let drawing = false
    const frames: number[] = []
    const draw = (source: CanvasImageSource, sourceWidth: number, sourceHeight: number) => {
      const element = canvas.current
      const shape = current
      if (!element || !shape) return
      const upright = uprightSize(shape).pixels
      if (element.width !== upright.width || element.height !== upright.height) {
        element.width = upright.width
        element.height = upright.height
      }
      const context = element.getContext('2d')
      if (!context) return
      context.setTransform(...uprightTransform(shape))
      context.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, shape.width, shape.height)
      const now = performance.now()
      frames.push(now)
      while (frames.length && now - frames[0]! > 2000) frames.shift()
      element.dataset.fps = String(Math.round(frames.length / 2))
    }
    const closeDecoder = () => {
      if (decoder && decoder.state !== 'closed') decoder.close()
      decoder = undefined
    }
    const configure = async (shape: SimulatorLiveDescription): Promise<boolean> => {
      closeDecoder()
      waitingKey = true
      if (shape.codec !== 'h264') return true
      if (!shape.codecString || !shape.config) return false
      const config: VideoDecoderConfig = {
        codec: shape.codecString,
        description: Uint8Array.from(atob(shape.config), character => character.charCodeAt(0)),
        optimizeForLatency: true,
      }
      const supported = await VideoDecoder.isConfigSupported(config).catch(() => undefined)
      if (!supported?.supported) return false
      decoder = new VideoDecoder({
        output: frame => {
          draw(frame, frame.displayWidth, frame.displayHeight)
          frame.close()
        },
        error: () => controller.abort(new Error('decoder')),
      })
      decoder.configure(config)
      return true
    }

    const run = async (): Promise<'device' | 'retry' | 'jpeg' | 'stop'> => {
      const response = await fetch(`/link/api/simulators/${udid}/stream?${streamQuery(codec)}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/octet-stream' },
        signal: controller.signal,
      })
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => undefined)) as { message?: string } | undefined
        stateRef.current('unavailable', { reason: body?.message ?? `HTTP ${response.status}` })
        return 'stop'
      }
      const reader = response.body.getReader()
      const parser = new LiveReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return 'retry'
        for (const message of parser.push(value)) {
          if (message.type === SIMULATOR_STREAM.description) {
            const shape = parseDescription(message.payload)
            if (!shape) return 'retry'
            current = shape
            setDescription(shape)
            if (!(await configure(shape))) return 'jpeg'
            const upright = uprightSize(shape)
            stateRef.current('live', { size: upright.device })
            reconnects = 0
            continue
          }
          if (message.type === SIMULATOR_STREAM.end) {
            const reason = (() => {
              try {
                return (JSON.parse(new TextDecoder().decode(message.payload)) as { reason?: string }).reason
              } catch {
                return undefined
              }
            })()
            return reason === 'device' || reason === 'host' ? 'device' : 'retry'
          }
          if (message.type === SIMULATOR_STREAM.jpeg) {
            // Only the newest picture is decoded; one still decoding makes the next wait its turn or be skipped.
            if (drawing) continue
            drawing = true
            void createImageBitmap(new Blob([message.payload as BlobPart], { type: 'image/jpeg' }))
              .then(bitmap => {
                draw(bitmap, bitmap.width, bitmap.height)
                bitmap.close()
              })
              .catch(() => undefined)
              .finally(() => (drawing = false))
            continue
          }
          if (!decoder || decoder.state !== 'configured') continue
          const key = message.type === SIMULATOR_STREAM.key
          if (waitingKey && !key) continue
          waitingKey = false
          // A decoder that falls behind skips to the next keyframe rather than holding frames.
          if (decoder.decodeQueueSize > 8) {
            waitingKey = true
            continue
          }
          decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: message.timestamp, data: message.payload }))
        }
      }
    }

    void (async () => {
      stateRef.current('connecting')
      for (;;) {
        let outcome: Awaited<ReturnType<typeof run>>
        try {
          outcome = await run()
        } catch {
          if (controller.signal.aborted && !(controller.signal.reason instanceof Error)) return
          outcome = codec === 'h264' ? 'jpeg' : 'retry'
        }
        closeDecoder()
        if (outcome === 'stop' || outcome === 'device') {
          if (outcome === 'device') stateRef.current('unavailable', { reason: '设备已停止' })
          return
        }
        if (outcome === 'jpeg') codec = 'jpeg'
        else if (++reconnects > RECONNECTS) {
          stateRef.current('unavailable', { reason: '实时画面断开了' })
          return
        }
        await new Promise(resolve => setTimeout(resolve, 500))
        if (controller.signal.aborted) return
      }
    })()
    return () => {
      controller.abort()
      closeDecoder()
    }
  }, [udid])

  // ── Pointer and wheel: one finger ──
  const down = useRef<number | undefined>(undefined)
  /** Where the finger last was, for its lift. */
  const last = useRef({ x: 0, y: 0 })
  const wheel = useRef<{ x: number; y: number; dx: number; dy: number; timer: ReturnType<typeof setTimeout> } | undefined>(undefined)
  /** The picture's own box on screen: inside the canvas's border. */
  const contentBox = (element: HTMLCanvasElement) => {
    const rect = element.getBoundingClientRect()
    return {
      left: rect.left + element.clientLeft,
      top: rect.top + element.clientTop,
      width: element.clientWidth,
      height: element.clientHeight,
    }
  }
  const toDevice = (clientX: number, clientY: number) => {
    const element = canvas.current
    if (!element || !description) return undefined
    const upright = uprightSize(description)
    return pointerToDevice({ x: clientX, y: clientY }, contentBox(element), upright.points, upright.pixels)
  }
  const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value))
  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!onInput || event.button !== 0 || down.current !== undefined) return
    const point = toDevice(event.clientX, event.clientY)
    if (!point) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.focus()
    down.current = event.pointerId
    last.current = point
    onInput({ type: 'touch', phase: 'down', ...point })
  }
  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!onInput || down.current !== event.pointerId || !description) return
    const { points, pixels } = uprightSize(description)
    const shown = containedBox(contentBox(event.currentTarget), pixels)
    if (!shown) return
    // Kept on the screen while the finger is down, even when the pointer leaves the picture.
    last.current = {
      x: Math.round(clamp(((event.clientX - shown.left) / shown.width) * points.width, points.width) * 10) / 10,
      y: Math.round(clamp(((event.clientY - shown.top) / shown.height) * points.height, points.height) * 10) / 10,
    }
    onInput({ type: 'touch', phase: 'move', ...last.current })
  }
  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    if (down.current !== event.pointerId) return
    down.current = undefined
    onInput?.({ type: 'touch', phase: 'up', ...last.current })
  }
  const onWheel = (event: WheelEvent<HTMLCanvasElement>) => {
    if (!onInput || !description || down.current !== undefined) return
    const { points, pixels } = uprightSize(description)
    const shown = containedBox(contentBox(event.currentTarget), pixels)
    if (!shown) return
    const scale = shown.width / points.width
    let gesture = wheel.current
    if (!gesture) {
      const start = toDevice(event.clientX, event.clientY)
      if (!start) return
      gesture = { ...start, dx: 0, dy: 0, timer: setTimeout(() => undefined, 0) }
      wheel.current = gesture
      onInput({ type: 'touch', phase: 'down', x: start.x, y: start.y })
    }
    // The finger moves against the wheel, as a trackpad scrolls content.
    gesture.dx -= event.deltaX / scale
    gesture.dy -= event.deltaY / scale
    const at = { x: clamp(gesture.x + gesture.dx, points.width), y: clamp(gesture.y + gesture.dy, points.height) }
    onInput({ type: 'touch', phase: 'move', ...at })
    clearTimeout(gesture.timer)
    gesture.timer = setTimeout(() => {
      wheel.current = undefined
      onInput({ type: 'touch', phase: 'up', ...at })
    }, WHEEL_LIFT_MS)
  }

  // Zoom is by the device's own pixels (1:1 is one device pixel per screen pixel), whatever size the stream is encoded at.
  const upright = description ? uprightSize(description).device : { width: 0, height: 0 }
  const size = screenSize(zoom, upright, box, pixelRatio)
  return (
    <canvas
      ref={canvas}
      className="sim-screen sim-live"
      role="img"
      aria-label={`${name} 的实时画面`}
      tabIndex={onInput ? 0 : -1}
      data-input={onInput ? '' : undefined}
      data-orientation={description?.orientation}
      style={
        upright.width === 0
          ? { visibility: 'hidden' }
          : zoom === 'fit'
            ? { aspectRatio: `${upright.width} / ${upright.height}`, width: size.width, height: size.height }
            : { width: size.width, height: size.height, maxWidth: 'none', maxHeight: 'none' }
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      onContextMenu={event => event.preventDefault()}
    />
  )
}
