import { MOTION } from '@latch/ui'

/** The icon rail at the window's left edge. */
export const RAIL_WIDTH = 52
/** The panel next to the rail: 248 by default, 220 to 400, snapping shut when dragged narrower than 160. */
export const SIDEBAR_DEFAULT = 248
export const SIDEBAR_MIN = 220
export const SIDEBAR_MAX = 400
const SIDEBAR_SNAP = 160
/** How long a drag that snaps the panel shut or open lets its track slide: --m-panel and a frame. */
export const SIDEBAR_SNAP_MS = MOTION.panel + 20
/** The right panel: 520 by default, from 360 up to 70% of the window. */
export const RIGHT_PANEL_DEFAULT = 520
export const RIGHT_PANEL_MIN = 360
/** 变更 asks for more, unless the person chose a width: 660, or 860 when its file tree is wanted, down to what the conversation leaves. */
const CHANGES_PANEL = 660
const CHANGES_PANEL_TREE = 860
const CHANGES_SHEET = 420
const RIGHT_PANEL_MAX_SHARE = 0.7
/** The conversation stays at least this wide; below that the right panel overlays it as a sheet. */
const CONVERSATION_MIN = 480
const TABLET_FROM = 768

export interface SidebarPreference {
  /** The dragged width; absent means the default. */
  width?: number
  collapsed: boolean
}

export interface RightPanelPreference {
  /** Opened by the person; it starts closed. */
  open: boolean
  /** The dragged width; absent means the default. */
  width?: number
}

const field = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined)
const wholeBetween = (value: unknown, min: number, max: number): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined

export function parseSidebarPreference(value: unknown): SidebarPreference {
  const width = wholeBetween(field(value, 'width'), SIDEBAR_MIN, SIDEBAR_MAX)
  return { ...(width !== undefined ? { width } : {}), collapsed: field(value, 'collapsed') === true }
}

export function parseRightPanelPreference(value: unknown): RightPanelPreference {
  const width = wholeBetween(field(value, 'width'), RIGHT_PANEL_MIN, 4096)
  return { open: field(value, 'open') === true, ...(width !== undefined ? { width } : {}) }
}

/** The widest the panel may be: the conversation keeps its minimum beside the rail and whatever stands on its far side. */
export function sidebarMax(windowWidth: number, beside = 0): number {
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, windowWidth - RAIL_WIDTH - CONVERSATION_MIN - beside))
}

export function clampSidebar(width: number, windowWidth: number, beside = 0): number {
  return Math.round(Math.min(Math.max(width, SIDEBAR_MIN), sidebarMax(windowWidth, beside)))
}

/** What a drag position or key means for the panel: a width, or shut when dragged past the snap point. */
export function sidebarAfterDrag(raw: number, windowWidth: number, beside = 0): { collapsed: true } | { collapsed: false; width: number } {
  return raw < SIDEBAR_SNAP ? { collapsed: true } : { collapsed: false, width: clampSidebar(raw, windowWidth, beside) }
}

export function rightPanelMax(windowWidth: number): number {
  return Math.max(RIGHT_PANEL_MIN, Math.round(windowWidth * RIGHT_PANEL_MAX_SHARE))
}

export function clampRightPanel(width: number, windowWidth: number): number {
  return Math.round(Math.min(Math.max(width, RIGHT_PANEL_MIN), rightPanelMax(windowWidth)))
}

export type RightPanelPlacement =
  /** Beside the conversation, `width` wide. */
  | { kind: 'column'; width: number }
  /** Over the conversation, which would otherwise go under its minimum. */
  | { kind: 'sheet'; width: number }
  /** In the conversation's place: a phone's pushed page, or the panel maximised. */
  | { kind: 'page' }

/** How wide 变更 opens beside a conversation, or over one that cannot keep its minimum. */
export function changesPanelWidth(windowWidth: number, left: number, tree = false): number {
  const room = windowWidth - left - CONVERSATION_MIN
  return room >= RIGHT_PANEL_MIN ? Math.min(tree ? CHANGES_PANEL_TREE : CHANGES_PANEL, room) : CHANGES_SHEET
}

/** Where the open right panel goes; `left` is what stands beside the conversation on its other side (rail and panel). */
export function placeRightPanel({ windowWidth, width, left }: { windowWidth: number; width?: number; left: number }): RightPanelPlacement {
  if (windowWidth < TABLET_FROM) return { kind: 'page' }
  const wanted = clampRightPanel(width ?? RIGHT_PANEL_DEFAULT, windowWidth)
  if (windowWidth - left - wanted >= CONVERSATION_MIN) return { kind: 'column', width: wanted }
  return { kind: 'sheet', width: Math.min(wanted, windowWidth - RAIL_WIDTH) }
}
