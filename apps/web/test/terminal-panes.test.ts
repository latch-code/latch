import { describe, expect, it } from 'vitest'
import type { TerminalSummary } from '@latch/protocol'
import { fillTab } from '../src/panel/terminal/fill.ts'
import { keepActive, type TerminalTab } from '../src/panel/terminal/model.ts'
import {
  evenPanes,
  paneMinShare,
  paneStorageKey,
  paneTabs,
  parseLayout,
  reconcile,
  removePane,
  replacePane,
  resizePanes,
  siblingPane,
  splitFits,
  splitKind,
  splitPane,
  stepPane,
  tabOf,
  type PaneArea,
  type PaneLayout,
} from '../src/panel/terminal/panes.ts'

const summary = (id: string, patch: Partial<TerminalSummary & { sessionId: string }> = {}): TerminalSummary => ({
  id,
  sessionId: 's',
  shell: 'zsh',
  folder: 'latch',
  cols: 80,
  rows: 24,
  status: 'running',
  busy: false,
  services: [],
  sizeOwner: true,
  createdAt: '2026-11-16T00:00:00.000Z',
  ...patch,
})
const tabsOf = (...ids: string[]): TerminalTab[] => ids.map((id, index) => ({ id, number: index + 1, summary: summary(id) }))
const fitsAll = () => true

describe('terminal split panes', () => {
  it('splits a terminal into a group of two, then adds beside the focused pane with half its share', () => {
    let layout: PaneLayout = splitPane([], 'a', 'b', 'row')
    expect(layout).toEqual([{ direction: 'row', panes: ['a', 'b'], sizes: [0.5, 0.5] }])
    layout = splitPane(layout, 'a', 'c', 'row')
    expect(layout[0]).toEqual({ direction: 'row', panes: ['a', 'c', 'b'], sizes: [0.25, 0.25, 0.5] })
    // The same terminal is never placed twice.
    expect(splitPane(layout, 'b', 'c', 'row')).toBe(layout)
  })

  it('holds four panes at most in one direction; a fifth gets its own tab, the other direction is refused', () => {
    let layout: PaneLayout = splitPane([], 'a', 'b', 'column')
    layout = splitPane(layout, 'b', 'c', 'column')
    layout = splitPane(layout, 'c', 'd', 'column')
    expect(layout[0]!.panes).toEqual(['a', 'b', 'c', 'd'])
    expect(splitKind(layout, 'd', 'column')).toBe('full')
    expect(splitPane(layout, 'd', 'e', 'column')).toBe(layout)
    expect(splitKind(layout, 'a', 'row')).toBe('crossed')
    expect(splitKind(layout, 'e', 'row')).toBe('split')
  })

  it('gives a closed pane’s share to its siblings and makes a group of one a plain tab again', () => {
    const layout: PaneLayout = [{ direction: 'row', panes: ['a', 'b', 'c'], sizes: [0.5, 0.25, 0.25] }]
    const closed = removePane(layout, 'a')
    expect(closed[0]!.panes).toEqual(['b', 'c'])
    expect(closed[0]!.sizes).toEqual([0.5, 0.5])
    expect(removePane(closed, 'b')).toEqual([])
    expect(removePane(layout, 'x')).toBe(layout)
  })

  it('puts a reopened terminal in the old one’s place and keeps it there while the Host list catches up', () => {
    const layout: PaneLayout = [{ direction: 'row', panes: ['a', 'b'], sizes: [0.3, 0.7] }]
    expect(reconcile(layout, new Set(['b']), new Set(['a']))).toBe(layout)
    expect(replacePane(layout, 'a', 'n')).toEqual([{ direction: 'row', panes: ['n', 'b'], sizes: [0.3, 0.7] }])
    expect(reconcile(layout, new Set(['b']))).toEqual([])
    expect(reconcile(layout, new Set(['a', 'b']))).toBe(layout)
  })

  it('moves a hairline between its two panes only, never below the least share, and evens them out', () => {
    const layout: PaneLayout = [{ direction: 'row', panes: ['a', 'b', 'c'], sizes: [0.4, 0.3, 0.3] }]
    const moved = resizePanes(layout, 'a', 0, 0.6, 0.1)
    expect(moved[0]!.sizes.map(size => Number(size.toFixed(3)))).toEqual([0.6, 0.1, 0.3])
    const floored = resizePanes(layout, 'a', 1, 0.01, 0.1)
    expect(floored[0]!.sizes.map(size => Number(size.toFixed(3)))).toEqual([0.4, 0.1, 0.5])
    expect(evenPanes(moved, 'b')[0]!.sizes).toEqual([1 / 3, 1 / 3, 1 / 3])
  })

  it('draws a group as one tab where its lowest-numbered pane stands, and steps focus round its panes', () => {
    const tabs = tabsOf('a', 'b', 'c', 'd')
    const layout: PaneLayout = [{ direction: 'row', panes: ['d', 'b'], sizes: [0.5, 0.5] }]
    const strip = paneTabs(tabs, layout, fitsAll)
    expect(strip.map(tab => tab.panes)).toEqual([['a'], ['d', 'b'], ['c']])
    expect(tabOf(strip, 'b')?.key).toBe('d')
    expect(stepPane(strip, 'd', 1)).toBe('b')
    expect(stepPane(strip, 'b', 1)).toBe('d')
    expect(stepPane(strip, 'd', -1)).toBe('b')
    expect(stepPane(strip, 'a', 1)).toBe('a')
    // Closing the focused pane focuses its sibling in the same tab, not the neighbour by number.
    expect(siblingPane(strip, 'd')).toBe('b')
    expect(keepActive(tabsOf('a', 'b', 'c'), 'd', tabs, id => siblingPane(strip, id))).toBe('b')
    expect(keepActive(tabsOf('a', 'b', 'c'), 'd', tabs)).toBe('c')
  })

  it('shows panes one at a time where two cannot have 40 columns, and keeps the layout for a wider area', () => {
    const cell = { width: 7.5, height: 18 }
    const area = (width: number, height = 400): PaneArea => ({ width, height, cell, pad: { x: 24, y: 16 } })
    // Two panes of 40 columns: 2 × (300 + 24).
    expect(splitFits(area(647), 'row', 2)).toBe(false)
    expect(splitFits(area(648), 'row', 2)).toBe(true)
    expect(splitFits(area(647), 'column', 2)).toBe(false)
    // Four side by side need 20 columns each; stacked, four rows each.
    expect(splitFits(area(700), 'row', 4)).toBe(true)
    expect(splitFits(area(1200, 360), 'column', 4)).toBe(true)
    expect(splitFits(area(1200, 200), 'column', 3)).toBe(false)
    const tabs = tabsOf('a', 'b')
    const layout: PaneLayout = [{ direction: 'row', panes: ['a', 'b'], sizes: [0.5, 0.5] }]
    const narrow = paneTabs(tabs, layout, group => splitFits(area(500), group.direction, group.panes.length))
    expect(narrow.map(tab => tab.panes)).toEqual([['a'], ['b']])
    const wide = paneTabs(tabs, layout, group => splitFits(area(900), group.direction, group.panes.length))
    expect(wide.map(tab => tab.panes)).toEqual([['a', 'b']])
    expect(paneMinShare(area(900), 'row')).toBeCloseTo((20 * 7.5 + 24) / 900)
  })

  it('fills the focused pane: the terminal the panel keeps active', () => {
    const tabs = tabsOf('a', 'b').map(tab => ({ ...tab, summary: { ...tab.summary, prompt: 1 } }))
    expect(fillTab(tabs, 'b')?.id).toBe('b')
    expect(fillTab(tabs, 'a')?.id).toBe('a')
  })

  it('reads only a well-formed stored layout, per device and target', () => {
    expect(paneStorageKey('dev', 'tasks/s/terminals')).toBe('latch.terminal-panes.dev.tasks/s/terminals')
    const stored = JSON.stringify([
      { direction: 'row', panes: ['a', 'b'], sizes: [1, 3] },
      { direction: 'diagonal', panes: ['c', 'd'] },
      { direction: 'column', panes: ['a', 'e'] },
      { direction: 'column', panes: ['f', 'g', 'h', 'i', 'j'] },
      { direction: 'column', panes: ['k', 'l'], sizes: 'x' },
    ])
    expect(parseLayout(stored)).toEqual([
      { direction: 'row', panes: ['a', 'b'], sizes: [0.25, 0.75] },
      { direction: 'column', panes: ['k', 'l'], sizes: [0.5, 0.5] },
    ])
    expect(parseLayout('{')).toEqual([])
    expect(parseLayout(null)).toEqual([])
  })
})
