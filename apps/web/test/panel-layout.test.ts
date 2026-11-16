import { describe, expect, it } from 'vitest'
import {
  changesPanelWidth,
  CONVERSATION_MIN,
  RIGHT_PANEL_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  clampRightPanel,
  clampDockHeight,
  clampSidebar,
  dockMax,
  parseRightPanelPreference,
  parseSidebarPreference,
  placeRightPanel,
  rightPanelMax,
  sidebarAfterDrag,
  sidebarMax,
} from '../src/shell/panelLayout.ts'

describe('the terminal dock', () => {
  it('clamps the saved height to the room the conversation leaves', () => {
    expect(clampDockHeight(380, 900)).toBe(380)
    expect(clampDockHeight(380, 550)).toBe(300)
    expect(clampDockHeight(380, 360)).toBe(110)
    expect(clampDockHeight(90, 900)).toBe(140)
    expect(dockMax(2000)).toBe(680)
  })
})

describe('the panel next to the rail', () => {
  it('stays between 220 and 400, and leaves the conversation its minimum', () => {
    expect(clampSidebar(100, 1440)).toBe(SIDEBAR_MIN)
    expect(clampSidebar(900, 1440)).toBe(SIDEBAR_MAX)
    expect(sidebarMax(800)).toBe(800 - CONVERSATION_MIN)
    expect(sidebarMax(1024, 400)).toBe(SIDEBAR_MIN)
  })

  it('snaps shut when dragged past the snap point', () => {
    expect(sidebarAfterDrag(159, 1440)).toEqual({ collapsed: true })
    expect(sidebarAfterDrag(160, 1440)).toEqual({ collapsed: false, width: SIDEBAR_MIN })
    expect(sidebarAfterDrag(300, 1440)).toEqual({ collapsed: false, width: 300 })
  })

  it('reads only a whole width in range', () => {
    expect(parseSidebarPreference({ width: 300, collapsed: true })).toEqual({ width: 300, collapsed: true })
    expect(parseSidebarPreference({ width: 900 })).toEqual({ collapsed: false })
    expect(parseSidebarPreference({ width: 300.5, collapsed: 'yes' })).toEqual({ collapsed: false })
    expect(parseSidebarPreference(null)).toEqual({ collapsed: false })
  })
})

describe('the right panel', () => {
  it('starts closed and reads only what it wrote', () => {
    expect(parseRightPanelPreference(undefined)).toEqual({ open: false })
    expect(parseRightPanelPreference({ open: true, width: 600 })).toEqual({ open: true, width: 600 })
    expect(parseRightPanelPreference({ width: 100 })).toEqual({ open: false })
  })

  it('stays between 360 and 70% of the window', () => {
    expect(clampRightPanel(100, 1440)).toBe(360)
    expect(clampRightPanel(5000, 1440)).toBe(rightPanelMax(1440))
    expect(rightPanelMax(1440)).toBe(1008)
  })

  it('narrows to leave the conversation its minimum, and overlays it once it would go under 360', () => {
    expect(placeRightPanel({ windowWidth: 1440, left: 300 })).toEqual({ kind: 'column', width: RIGHT_PANEL_DEFAULT })
    expect(placeRightPanel({ windowWidth: 1300, left: 300 })).toEqual({ kind: 'column', width: RIGHT_PANEL_DEFAULT })
    expect(placeRightPanel({ windowWidth: 1100, left: 264 })).toEqual({ kind: 'column', width: 1100 - 264 - CONVERSATION_MIN })
    expect(placeRightPanel({ windowWidth: 1100, left: 300 })).toEqual({ kind: 'column', width: 360 })
    expect(placeRightPanel({ windowWidth: 1099, left: 300 })).toEqual({ kind: 'sheet', width: RIGHT_PANEL_DEFAULT })
    expect(placeRightPanel({ windowWidth: 1100, left: 0 })).toEqual({ kind: 'column', width: RIGHT_PANEL_DEFAULT })
    expect(placeRightPanel({ windowWidth: 768, left: 60 })).toEqual({ kind: 'sheet', width: RIGHT_PANEL_DEFAULT })
  })

  it('is a pushed page on phones', () => {
    expect(placeRightPanel({ windowWidth: 767, left: 0 })).toEqual({ kind: 'page' })
  })
})

describe('how wide 改动 opens', () => {
  it('asks for 660 where the conversation keeps its minimum, what is left below that, and a 420 sheet when that is too little', () => {
    expect(changesPanelWidth(1440, 300)).toBe(660)
    expect(changesPanelWidth(1280, 300)).toBe(1280 - 300 - CONVERSATION_MIN)
    expect(changesPanelWidth(1024, 300)).toBe(420)
    expect(changesPanelWidth(1024, 0)).toBe(1024 - CONVERSATION_MIN)
    expect(changesPanelWidth(1440, 0, true)).toBe(860)
    expect(changesPanelWidth(1440, 300, true)).toBe(1440 - 300 - CONVERSATION_MIN)
  })
})
