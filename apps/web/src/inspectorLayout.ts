import { PAPER_MIN, type WidthClass } from './sidebarLayout.ts'

/**
 * The session-information column (会话信息): independent blocks on the ground beside the conversation's paper, never a
 * drawer. It is open by default from 1440px and remembered per class of window; from 1024px it stands beside the paper
 * (its edge can be dragged), on tablets beside it when the conversation keeps 440px and in its place otherwise, and on
 * phones it is a page pushed over the conversation.
 */
export const INSPECTOR_MIN = 280
const INSPECTOR_MAX = 480
export const INSPECTOR_DEFAULT = 320
/** The tablet's conversation keeps this much beside the column, or the column takes the conversation's place. */
const TABLET_CONVERSATION_MIN = 440
const RAIL = 56
/** The window inset on the far side of the paper or the column. */
const SHELL_INSET = 8

/** Classes of window whose open state is remembered separately. */
export type InspectorClass = 'wide' | 'laptop' | 'tablet'

export const inspectorClassOf = (windowWidth: number): InspectorClass | null =>
  windowWidth >= 1440 ? 'wide' : windowWidth >= 1024 ? 'laptop' : windowWidth >= 768 ? 'tablet' : null

export interface InspectorPreference {
  /** Opened or closed by the person, per class; absent means the default (open only from 1440px). */
  open: Partial<Record<InspectorClass, boolean>>
  /** The dragged width, per sidebar width class. */
  width: Partial<Record<WidthClass, number>>
  /** Blocks the person folded, by ID. */
  collapsed: string[]
}

const field = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined)
const BLOCK = /^[a-z][a-z-]{0,31}$/u

/** Reads the stored preference; an older page stored only `true` (open beside the paper on wide windows). */
export function parseInspectorPreference(value: unknown): InspectorPreference {
  const result: InspectorPreference = { open: {}, width: {}, collapsed: [] }
  if (value === true) return { ...result, open: { wide: true, laptop: true } }
  for (const key of ['wide', 'laptop', 'tablet'] as const) {
    const open = field(field(value, 'open'), key)
    if (typeof open === 'boolean') result.open[key] = open
  }
  for (const key of ['laptop', 'desktop'] as const) {
    const width = field(field(value, 'width'), key)
    if (typeof width === 'number' && Number.isInteger(width) && width >= INSPECTOR_MIN && width <= INSPECTOR_MAX) result.width[key] = width
  }
  const collapsed = field(value, 'collapsed')
  if (Array.isArray(collapsed))
    result.collapsed = [...new Set(collapsed.filter((item): item is string => typeof item === 'string' && BLOCK.test(item)))].slice(0, 16)
  return result
}

export function inspectorOpen(preference: InspectorPreference, windowWidth: number): boolean {
  const kind = inspectorClassOf(windowWidth)
  if (kind === null) return false
  return preference.open[kind] ?? kind === 'wide'
}

/** The widest the column may be with `beside` (the sidebar's column) next to the paper. */
export function inspectorMax(windowWidth: number, beside: number): number {
  return Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, windowWidth - PAPER_MIN - beside))
}

export function clampInspector(width: number, windowWidth: number, beside: number): number {
  return Math.round(Math.min(Math.max(width, INSPECTOR_MIN), inspectorMax(windowWidth, beside)))
}

export type InspectorPlacement =
  /** Beside the paper, `width` wide; `shutSidebar` when the sidebar must fold away while it is open. */
  | { kind: 'column'; width: number; shutSidebar: boolean }
  /** In the conversation's place, with 返回对话 (tablets too narrow for both, and phones as a pushed page). */
  | { kind: 'page' }

/**
 * Where the open column goes. From 1024px it stands beside the paper, which keeps 520px: when the open sidebar would
 * leave less, the sidebar folds away while the column is open. A tablet keeps the column beside a conversation of at
 * least 440px, else the column takes the conversation's place; a phone always pushes it as a page.
 */
export function placeInspector({
  windowWidth,
  width,
  sidebar,
}: {
  windowWidth: number
  /** The remembered or dragged width; the default when absent. */
  width?: number
  /** The sidebar column's width from 1024px (its inset while shut); absent below. */
  sidebar?: number
}): InspectorPlacement {
  const kind = inspectorClassOf(windowWidth)
  if (kind === null) return { kind: 'page' }
  if (kind === 'tablet')
    return windowWidth - RAIL - INSPECTOR_DEFAULT >= TABLET_CONVERSATION_MIN
      ? { kind: 'column', width: INSPECTOR_DEFAULT, shutSidebar: false }
      : { kind: 'page' }
  const wanted = width ?? INSPECTOR_DEFAULT
  const open = sidebar ?? SHELL_INSET
  if (windowWidth - open - Math.max(INSPECTOR_MIN, wanted) >= PAPER_MIN)
    return { kind: 'column', width: clampInspector(wanted, windowWidth, open), shutSidebar: false }
  return { kind: 'column', width: clampInspector(wanted, windowWidth, SHELL_INSET), shutSidebar: open > SHELL_INSET }
}
