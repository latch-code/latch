import { describe, expect, it } from 'vitest'
import { parsePreferences } from '../src/preferences.ts'
import {
  PAPER_MIN,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  clampSidebar,
  defaultSidebarWidth,
  parseSidebarPreference,
  sidebarAfterDrag,
  sidebarMax,
  widthClassOf,
} from '../src/sidebarLayout.ts'

describe('resizable sidebar', () => {
  it('defaults to 300 from 1440, 264 from 1280 and 248 below, and resizes only from 1024', () => {
    expect([1600, 1440, 1439, 1280, 1279, 1024].map(defaultSidebarWidth)).toEqual([300, 300, 264, 264, 248, 248])
    expect((['phone', 'tablet', 'laptop', 'desktop'] as const).map(widthClassOf)).toEqual([null, null, 'laptop', 'desktop'])
  })

  it('clamps to 220–480 and keeps the paper at least 520 wide beside it and whatever stands on its other side', () => {
    expect(clampSidebar(100, 1440)).toBe(SIDEBAR_MIN)
    expect(clampSidebar(900, 1440)).toBe(SIDEBAR_MAX)
    expect(clampSidebar(301.6, 1440)).toBe(302)
    // A narrow window: 1024 − 520 − 8 leaves 496, so 480 still fits; with a 320 column beside the paper it does not.
    expect(sidebarMax(1024)).toBe(480)
    expect(sidebarMax(1280, 320)).toBe(1280 - PAPER_MIN - 8 - 320)
    expect(clampSidebar(480, 1280, 320)).toBe(432)
    // Never below the minimum, even when the window cannot give the paper its width.
    expect(sidebarMax(900, 320)).toBe(SIDEBAR_MIN)
  })

  it('snaps shut when dragged below 160 and otherwise follows the pointer within its range', () => {
    expect(sidebarAfterDrag(159, 1440)).toEqual({ collapsed: true })
    expect(sidebarAfterDrag(160, 1440)).toEqual({ collapsed: false, width: SIDEBAR_MIN })
    expect(sidebarAfterDrag(333, 1440)).toEqual({ collapsed: false, width: 333 })
    expect(sidebarAfterDrag(2000, 1440)).toEqual({ collapsed: false, width: SIDEBAR_MAX })
  })

  it('remembers a width and a shut sidebar per breakpoint class, and reads anything else as the default', () => {
    const stored = JSON.stringify({
      theme: 'dark',
      sidebar: { width: { laptop: 260, desktop: 360 }, collapsed: { laptop: true, desktop: 'yes' } },
    })
    expect(parsePreferences(stored).sidebar).toEqual({ width: { laptop: 260, desktop: 360 }, collapsed: { laptop: true } })
    expect(parseSidebarPreference({ width: { laptop: 219, desktop: 481 }, collapsed: null })).toEqual({ width: {}, collapsed: {} })
    expect(parseSidebarPreference({ width: { laptop: 250.5, desktop: '300' } })).toEqual({ width: {}, collapsed: {} })
    expect(parseSidebarPreference('wide')).toEqual({ width: {}, collapsed: {} })
    expect(parsePreferences('{').sidebar).toEqual({ width: {}, collapsed: {} })
    expect(parsePreferences(null).sidebar).toEqual({ width: {}, collapsed: {} })
  })
})
