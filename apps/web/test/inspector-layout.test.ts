import { describe, expect, it } from 'vitest'
import { clampInspector, inspectorOpen, parseInspectorPreference, placeInspector } from '../src/inspectorLayout.ts'
import { placeFileColumn } from '../src/preview/layout.ts'

describe('the session-information column', () => {
  it('gives documents half a window while preserving compact widths for text and images', () => {
    expect(placeFileColumn(1440, 300, undefined, true)).toEqual({ kind: 'column', width: 720, shutSidebar: true })
    expect(placeFileColumn(1440, 300, 320, true)).toEqual({ kind: 'column', width: 480, shutSidebar: false })
    expect(placeFileColumn(1440, 300, 360, false)).toEqual({ kind: 'column', width: 360, shutSidebar: false })
    expect(placeFileColumn(390, 56, 360, false)).toEqual({ kind: 'page' })
  })
  it('opens by default only from 1440px and remembers the choice per class of window', () => {
    const none = parseInspectorPreference(undefined)
    expect([1440, 1280, 1024, 900, 390].map(width => inspectorOpen(none, width))).toEqual([true, false, false, false, false])
    const chosen = parseInspectorPreference({
      open: { wide: false, laptop: true, tablet: 'yes' },
      width: { desktop: 400, laptop: 9 },
      collapsed: ['usage', 'usage', 'Bad!'],
    })
    expect(chosen).toEqual({ open: { wide: false, laptop: true }, width: { desktop: 400 }, collapsed: ['usage'] })
    expect([1440, 1280].map(width => inspectorOpen(chosen, width))).toEqual([false, true])
    // The page before kept one flag for its pane beside the paper.
    expect(parseInspectorPreference(true).open).toEqual({ wide: true, laptop: true })
  })

  it('stands beside the paper, which keeps 520px, folding the sidebar away when both do not fit', () => {
    expect(placeInspector({ windowWidth: 1440, sidebar: 300 })).toEqual({ kind: 'column', width: 320, shutSidebar: false })
    expect(placeInspector({ windowWidth: 1440, sidebar: 300, width: 480 })).toEqual({ kind: 'column', width: 480, shutSidebar: false })
    expect(placeInspector({ windowWidth: 1024, sidebar: 248 })).toEqual({ kind: 'column', width: 320, shutSidebar: true })
    expect(placeInspector({ windowWidth: 1024, sidebar: 8, width: 480 })).toEqual({ kind: 'column', width: 480, shutSidebar: false })
    expect(clampInspector(600, 1280, 264)).toBe(480)
    expect(clampInspector(100, 1280, 264)).toBe(280)
    expect(clampInspector(480, 1100, 248)).toBe(332)
  })

  it('takes the conversation’s place on a tablet too narrow for both and on phones', () => {
    expect(placeInspector({ windowWidth: 768 })).toEqual({ kind: 'page' })
    expect(placeInspector({ windowWidth: 900 })).toEqual({ kind: 'column', width: 320, shutSidebar: false })
    expect(placeInspector({ windowWidth: 390 })).toEqual({ kind: 'page' })
  })
})
