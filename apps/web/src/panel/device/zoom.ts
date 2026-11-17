// How large the 设备 panel draws a device's picture: fit to the panel, 1:1 (one device pixel per screen pixel), or a
// step in between or beyond. Remembered per device in this browser only, as a convenience.
import { readStorage } from '../../core/storageKeys.ts'

export type Zoom = 'fit' | number

/** Steps relative to 1:1. */
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2] as const

const key = (udid: string) => `latch.device-zoom.${udid}`

export function parseZoom(value: unknown): Zoom {
  if (value === 'fit') return 'fit'
  const number = typeof value === 'string' ? Number(value) : value
  return typeof number === 'number' && (ZOOM_STEPS as readonly number[]).includes(number) ? number : 'fit'
}

export function readZoom(udid: string): Zoom {
  return parseZoom(readStorage('localStorage', key(udid)))
}

export function writeZoom(udid: string, zoom: Zoom): void {
  try {
    if (zoom === 'fit') localStorage.removeItem(key(udid))
    else localStorage.setItem(key(udid), String(zoom))
  } catch {
    /* Storage that is missing or full: the zoom is only for this view. */
  }
}

/** The scale (relative to 1:1) at which the picture just fits the box, never above 1:1. */
export function fitScale(natural: { width: number; height: number }, box: { width: number; height: number }, pixelRatio: number): number {
  if (natural.width <= 0 || natural.height <= 0 || box.width <= 0 || box.height <= 0) return 1
  const one = { width: natural.width / pixelRatio, height: natural.height / pixelRatio }
  return Math.min(1, box.width / one.width, box.height / one.height)
}

/** The next step in, from what is drawn now. */
export function zoomIn(zoom: Zoom, fit: number): Zoom {
  const now = zoom === 'fit' ? fit : zoom
  return ZOOM_STEPS.find(step => step > now + 0.001) ?? ZOOM_STEPS.at(-1)!
}

/** The next step out; below the fit it fits again. */
export function zoomOut(zoom: Zoom, fit: number): Zoom {
  const now = zoom === 'fit' ? fit : zoom
  const step = ZOOM_STEPS.toReversed().find(value => value < now - 0.001)
  return step === undefined || step <= fit ? 'fit' : step
}

/** The picture's size in CSS pixels. */
export function screenSize(
  zoom: Zoom,
  natural: { width: number; height: number },
  box: { width: number; height: number },
  pixelRatio: number,
): { width: number; height: number } {
  const scale = zoom === 'fit' ? fitScale(natural, box, pixelRatio) : zoom
  return { width: Math.round((natural.width / pixelRatio) * scale), height: Math.round((natural.height / pixelRatio) * scale) }
}

/** 「适应」 or a percentage. */
export function zoomLabel(zoom: Zoom, fit: number): string {
  return zoom === 'fit' ? `适应 · ${Math.round(fit * 100)}%` : `${Math.round(zoom * 100)}%`
}
