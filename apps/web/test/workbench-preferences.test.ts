import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parsePreferences } from '../src/preferences.ts'
import { LayoutTiles } from '../src/settings/LayoutTiles.tsx'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the workbench layout on this device', () => {
  it('starts at the overview with old, missing or invalid preferences', () => {
    for (const raw of [null, '', '{', '{}', '{"theme":"dark"}', '{"workbenchLayout":null}', '{"workbenchLayout":"other"}']) {
      expect(parsePreferences(raw).workbenchLayout).toBe('overview')
    }
  })

  it('reads either saved layout without changing the other preferences', () => {
    for (const workbenchLayout of ['overview', 'triage']) {
      expect(parsePreferences(JSON.stringify({ workbenchLayout, theme: 'dark', sendKey: 'mod-enter' }))).toMatchObject({
        workbenchLayout,
        theme: 'dark',
        sendKey: 'mod-enter',
      })
    }
  })

  it('saves a layout with the existing local preferences and reads it after reloading the module', async () => {
    const entries = new Map([['latch.preferences', JSON.stringify({ theme: 'dark', sendKey: 'mod-enter' })]])
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
    })
    vi.resetModules()
    const preferences = await import('../src/preferences.ts')
    preferences.setPreference('workbenchLayout', 'triage')
    vi.resetModules()
    const reloaded = await import('../src/preferences.ts')
    expect(reloaded.parsePreferences(reloaded.storageGet('latch.preferences'))).toMatchObject({
      workbenchLayout: 'triage',
      theme: 'dark',
      sendKey: 'mod-enter',
    })
    expect([...entries.keys()]).toEqual(['latch.preferences'])
  })

  it('renders two named choices with one selected keyboard stop', () => {
    for (const value of ['overview', 'triage'] as const) {
      const html = renderToStaticMarkup(createElement(LayoutTiles, { value, onValueChange: () => {} }))
      expect(html).toContain('aria-label="工作台布局"')
      expect(html.match(/role="radio"/gu)).toHaveLength(2)
      expect(html.match(/aria-checked="true"/gu)).toHaveLength(1)
      expect(html.match(/tabindex="0"/gu)).toHaveLength(1)
      // The layouts are named for their shape; 总览 is the home's name in both, never a layout's.
      expect(html).toContain('>侧栏<')
      expect(html).toContain('>顶栏<')
      expect(html).toContain('按项目')
      expect(html).toContain('按状态')
      expect(html).not.toContain('分拣台')
    }
  })

  it('keeps a choice saved before the layouts were renamed', () => {
    // The stored keys did not change with the names, so nobody's choice is lost.
    expect(parsePreferences('{"workbenchLayout":"triage"}').workbenchLayout).toBe('triage')
    expect(parsePreferences('{"workbenchLayout":"overview"}').workbenchLayout).toBe('overview')
  })

  it('switches at once where the window cannot cross-fade, and toggles between the two', async () => {
    const entries = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
    })
    vi.resetModules()
    const preferences = await import('../src/preferences.ts')
    preferences.switchWorkbenchLayout('triage')
    expect(JSON.parse(entries.get('latch.preferences')!).workbenchLayout).toBe('triage')
    preferences.toggleWorkbenchLayout()
    expect(JSON.parse(entries.get('latch.preferences')!).workbenchLayout).toBe('overview')
    preferences.toggleWorkbenchLayout()
    expect(JSON.parse(entries.get('latch.preferences')!).workbenchLayout).toBe('triage')
  })
})
