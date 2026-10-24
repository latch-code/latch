import type { Viewport } from './breakpoints.ts'

/**
 * The resizable sidebar from 1024px. Its default width follows the window (300 from 1440, 264 from 1280, 248 below);
 * dragged widths are remembered per breakpoint class, so a narrow window does not inherit a wide window's width. The
 * conversation paper always keeps at least PAPER_MIN: widths clamp while dragging and when the window shrinks.
 */
export const SIDEBAR_MIN = 220
export const SIDEBAR_MAX = 480
/** Dragged narrower than this, the sidebar snaps shut, as the collapse button closes it. */
export const SIDEBAR_SNAP = 160
/**
 * How long a drag that snaps the column shut or open lets the track slide instead of following the pointer: the base
 * duration (180ms) and a frame, so the slide is not cut short.
 */
export const SIDEBAR_SNAP_MS = 200
export const PAPER_MIN = 520
/** The window inset on the paper's far side (and the inline column's, when one is open). */
const SHELL_INSET = 8
export const SIDEBAR_STEP = 8
export const SIDEBAR_STEP_LARGE = 32

/** The breakpoint classes that have a resizable sidebar; tablets show the rail and phones the drawer. */
export type WidthClass = 'laptop' | 'desktop'
export const widthClassOf = (viewport: Viewport): WidthClass | null => (viewport === 'laptop' || viewport === 'desktop' ? viewport : null)

export function defaultSidebarWidth(windowWidth: number): number {
  return windowWidth >= 1440 ? 300 : windowWidth >= 1280 ? 264 : 248
}

/** The widest the sidebar may be: the paper keeps PAPER_MIN beside it and whatever stands on its other side (`beside`). */
export function sidebarMax(windowWidth: number, beside = 0): number {
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, windowWidth - PAPER_MIN - SHELL_INSET - beside))
}

export function clampSidebar(width: number, windowWidth: number, beside = 0): number {
  return Math.round(Math.min(Math.max(width, SIDEBAR_MIN), sidebarMax(windowWidth, beside)))
}

/** A remembered width is a whole number of pixels in range; anything else reads as no preference (the default). */
export function storedWidth(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= SIDEBAR_MIN && value <= SIDEBAR_MAX ? value : undefined
}

export interface SidebarPreference {
  /** The dragged width, per class; absent means the default for the window. */
  width: Partial<Record<WidthClass, number>>
  collapsed: Partial<Record<WidthClass, boolean>>
}

/** A field of a stored object, or undefined when the value is not an object. */
const field = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined)

export function parseSidebarPreference(value: unknown): SidebarPreference {
  const result: SidebarPreference = { width: {}, collapsed: {} }
  for (const key of ['laptop', 'desktop'] as const) {
    const width = storedWidth(field(field(value, 'width'), key))
    if (width !== undefined) result.width[key] = width
    if (field(field(value, 'collapsed'), key) === true) result.collapsed[key] = true
  }
  return result
}

/** What the next drag position or key means for the sidebar: a width, or shut when dragged past the snap point. */
export function sidebarAfterDrag(raw: number, windowWidth: number, beside = 0): { collapsed: true } | { collapsed: false; width: number } {
  return raw < SIDEBAR_SNAP ? { collapsed: true } : { collapsed: false, width: clampSidebar(raw, windowWidth, beside) }
}
