import type { TerminalTab } from './model.ts'

/**
 * Split panes: a terminal tab may show 2–4 of the target's terminals in one direction, side by side (`row`) or stacked
 * (`column`). Each pane is an ordinary Host terminal; the grouping is this device's layout only, so the Host and other
 * devices still see separate terminals.
 */

export type SplitDirection = 'row' | 'column'

export const PANES_PER_TAB = 4
/** Two side-by-side panes need this many columns each; a narrower area shows panes one at a time. */
export const SPLIT_MIN_COLS = 40
/** The least a pane may be dragged to, and what each pane of a split needs before the split shows at all. */
export const PANE_MIN_COLS = 20
export const PANE_MIN_ROWS = 4

export interface PaneGroup {
  direction: SplitDirection
  /** Terminal IDs in order, left to right or top to bottom; at least two. */
  panes: string[]
  /** Each pane's share of the tab, summing to 1. */
  sizes: number[]
}

export type PaneLayout = readonly PaneGroup[]

/** A tab as the strip shows it: one terminal, or a group of panes. `key` is its first pane's terminal. */
export interface PaneTab {
  key: string
  panes: string[]
  direction: SplitDirection
  sizes: number[]
}

export const groupOf = (layout: PaneLayout, id: string | undefined) =>
  id === undefined ? undefined : layout.find(group => group.panes.includes(id))

const even = (count: number) => Array.from({ length: count }, () => 1 / count)

/** Shares that sum to 1, each above zero; anything else becomes even. */
function normal(sizes: readonly number[], count: number): number[] {
  if (sizes.length !== count || sizes.some(size => !(size > 0) || !Number.isFinite(size))) return even(count)
  const total = sizes.reduce((sum, size) => sum + size, 0)
  return sizes.map(size => size / total)
}

/**
 * What splitting `at` in `direction` does: `split` adds a pane beside it; `full` means the tab already holds four, so
 * the new terminal gets a tab of its own; `crossed` means the tab's panes run the other way (no nested splits yet).
 */
export function splitKind(layout: PaneLayout, at: string, direction: SplitDirection): 'split' | 'full' | 'crossed' {
  const group = groupOf(layout, at)
  if (!group) return 'split'
  if (group.direction !== direction) return 'crossed'
  return group.panes.length >= PANES_PER_TAB ? 'full' : 'split'
}

/** `added` goes right after `at` and takes half of `at`'s share; a terminal on its own becomes a group of two. */
export function splitPane(layout: PaneLayout, at: string, added: string, direction: SplitDirection): PaneLayout {
  if (at === added || groupOf(layout, added)) return layout
  const group = groupOf(layout, at)
  if (!group) return [...layout, { direction, panes: [at, added], sizes: [0.5, 0.5] }]
  if (splitKind(layout, at, direction) !== 'split') return layout
  const index = group.panes.indexOf(at)
  const half = group.sizes[index]! / 2
  const next: PaneGroup = {
    direction,
    panes: group.panes.toSpliced(index + 1, 0, added),
    sizes: group.sizes.toSpliced(index, 1, half, half),
  }
  return layout.map(item => (item === group ? next : item))
}

/** A closed pane gives its share to its siblings in proportion; a group left with one pane is a plain tab again. */
export function removePane(layout: PaneLayout, id: string): PaneLayout {
  const group = groupOf(layout, id)
  if (!group) return layout
  const index = group.panes.indexOf(id)
  const panes = group.panes.toSpliced(index, 1)
  if (panes.length < 2) return layout.filter(item => item !== group)
  const next: PaneGroup = { ...group, panes, sizes: normal(group.sizes.toSpliced(index, 1), panes.length) }
  return layout.map(item => (item === group ? next : item))
}

/** 重新打开 puts the new terminal in the old one's place, with its share. */
export function replacePane(layout: PaneLayout, previous: string, next: string): PaneLayout {
  const group = groupOf(layout, previous)
  if (!group || groupOf(layout, next)) return layout
  return layout.map(item => (item === group ? { ...item, panes: item.panes.map(id => (id === previous ? next : id)) } : item))
}

/**
 * The layout against the Host's list: panes whose terminal is gone leave, as if closed (the same object when nothing
 * left). `keep` holds terminals being replaced, whose place waits for the new one.
 */
export function reconcile(layout: PaneLayout, live: ReadonlySet<string>, keep: ReadonlySet<string> = new Set()): PaneLayout {
  let next = layout
  for (const group of layout) for (const id of group.panes) if (!live.has(id) && !keep.has(id)) next = removePane(next, id)
  return next
}

/**
 * The hairline after pane `index` moved: that pane takes `share` of the tab, the next pane the rest of the two; neither
 * goes below `min` (a share). The others keep theirs.
 */
export function resizePanes(layout: PaneLayout, key: string, index: number, share: number, min: number): PaneLayout {
  const group = groupOf(layout, key)
  if (!group || index < 0 || index >= group.panes.length - 1) return layout
  const pair = group.sizes[index]! + group.sizes[index + 1]!
  const floor = Math.min(min, pair / 2)
  const first = Math.min(pair - floor, Math.max(floor, share))
  const sizes = group.sizes.toSpliced(index, 2, first, pair - first)
  return layout.map(item => (item === group ? { ...item, sizes } : item))
}

/** A double click on a hairline: every pane of the tab the same size. */
export function evenPanes(layout: PaneLayout, key: string): PaneLayout {
  const group = groupOf(layout, key)
  if (!group) return layout
  return layout.map(item => (item === group ? { ...item, sizes: even(item.panes.length) } : item))
}

/**
 * The strip's tabs in the order of the terminals' numbers; a group stands where its lowest-numbered pane would. A group
 * that `fits` refuses (too narrow, too low) shows each of its terminals as a tab of its own: the layout is kept, so
 * widening the dock brings the split back. `keep` are terminals being replaced, whose pane stays in place meanwhile.
 */
export function paneTabs(
  tabs: readonly TerminalTab[],
  layout: PaneLayout,
  fits: (group: PaneGroup) => boolean,
  keep: ReadonlySet<string> = new Set(),
): PaneTab[] {
  const live = new Set(tabs.map(tab => tab.id))
  const shown = new Map<PaneGroup, PaneTab>()
  const result: PaneTab[] = []
  const single = (id: string): PaneTab => ({ key: id, panes: [id], direction: 'row', sizes: [1] })
  for (const tab of tabs) {
    const group = groupOf(layout, tab.id)
    const panes = group?.panes.filter(id => live.has(id) || keep.has(id))
    if (!group || !panes || panes.length < 2 || !fits(group)) {
      result.push(single(tab.id))
      continue
    }
    if (shown.has(group)) continue
    const sizes = normal(
      group.panes.flatMap((id, index) => (panes.includes(id) ? [group.sizes[index]!] : [])),
      panes.length,
    )
    const entry: PaneTab = { key: panes[0]!, panes, direction: group.direction, sizes }
    shown.set(group, entry)
    result.push(entry)
  }
  return result
}

export const tabOf = (tabs: readonly PaneTab[], id: string | undefined) =>
  id === undefined ? undefined : tabs.find(tab => tab.panes.includes(id))

/** The next or previous pane of the tab that holds `active`, round the ends; the same one when it is alone. */
export function stepPane(tabs: readonly PaneTab[], active: string | undefined, step: 1 | -1): string | undefined {
  const tab = tabOf(tabs, active)
  if (!tab || active === undefined) return active
  const index = tab.panes.indexOf(active)
  return tab.panes[(index + step + tab.panes.length) % tab.panes.length]
}

/** Where focus goes when `id` leaves its tab: the pane after it, else the one before; undefined when it was alone. */
export function siblingPane(tabs: readonly PaneTab[], id: string): string | undefined {
  const tab = tabOf(tabs, id)
  if (!tab || tab.panes.length < 2) return undefined
  const index = tab.panes.indexOf(id)
  return tab.panes[index + 1] ?? tab.panes[index - 1]
}

/** The area's size in px and the terminal font's cell, with the room each screen keeps around its text. */
export interface PaneArea {
  width: number
  height: number
  cell: { width: number; height: number }
  pad: { x: number; y: number }
}

/** The narrowest area that shows any split: two panes of `SPLIT_MIN_COLS` columns. */
export const splitWidth = (area: PaneArea) => 2 * (SPLIT_MIN_COLS * area.cell.width + area.pad.x)

/**
 * Whether a group shows as a split in this area: wide enough for two panes of 40 columns, and each of its panes gets at
 * least `PANE_MIN_COLS` columns side by side or `PANE_MIN_ROWS` rows stacked at even sizes.
 */
export function splitFits(area: PaneArea, direction: SplitDirection, count: number): boolean {
  if (area.width <= 0 || area.height <= 0) return true
  if (area.width < splitWidth(area)) return false
  return direction === 'row'
    ? area.width >= count * (PANE_MIN_COLS * area.cell.width + area.pad.x)
    : area.height >= count * (PANE_MIN_ROWS * area.cell.height + area.pad.y)
}

/** A pane's least share of the tab while dragging. */
export function paneMinShare(area: PaneArea, direction: SplitDirection): number {
  const total = direction === 'row' ? area.width : area.height
  if (total <= 0) return 0.1
  const least = direction === 'row' ? PANE_MIN_COLS * area.cell.width + area.pad.x : PANE_MIN_ROWS * area.cell.height + area.pad.y
  return Math.min(0.5, least / total)
}

/** This device's layout for one target, in the page's storage. */
export const paneStorageKey = (deviceId: string, target: string) => `latch.terminal-panes.${deviceId}.${target}`

/** A stored layout, or an empty one for anything that is not one (another version, hand edits, a full storage). */
export function parseLayout(text: string | null): PaneLayout {
  if (!text) return []
  try {
    const value = JSON.parse(text) as unknown
    if (!Array.isArray(value)) return []
    const seen = new Set<string>()
    const layout: PaneGroup[] = []
    for (const item of value.slice(0, 32)) {
      if (typeof item !== 'object' || item === null) continue
      const { direction, panes, sizes } = item as Record<string, unknown>
      if (direction !== 'row' && direction !== 'column') continue
      if (!Array.isArray(panes) || panes.length < 2 || panes.length > PANES_PER_TAB) continue
      if (!panes.every((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128 && !seen.has(id))) continue
      if (new Set(panes).size !== panes.length) continue
      for (const id of panes) seen.add(id)
      const shares = Array.isArray(sizes) && sizes.every(size => typeof size === 'number') ? (sizes as number[]) : []
      layout.push({ direction, panes: [...panes], sizes: normal(shares, panes.length) })
    }
    return layout
  } catch {
    return []
  }
}
