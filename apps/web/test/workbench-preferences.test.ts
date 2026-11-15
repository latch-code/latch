import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyAppearance, backdropLevel, parsePreferences } from '../src/preferences.ts'

it('restores only a valid dock height and an explicit open flag', () => {
  expect(parsePreferences(null)).toMatchObject({ dockOpen: false })
  expect(parsePreferences('{"dockOpen":true,"dockHeight":310}')).toMatchObject({ dockOpen: true, dockHeight: 310 })
  expect(parsePreferences('{"dockOpen":"true","dockHeight":680.5}').dockOpen).toBe(false)
  expect(parsePreferences('{"dockOpen":true,"dockHeight":139}').dockHeight).toBeUndefined()
})
import { BackdropTiles, DensityTiles, MotionChoice } from '../src/settings/AppearanceTiles.tsx'
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

  it('reads 背景效果, 动效 and 密度 from this device, with their defaults for old or invalid values', () => {
    for (const raw of [null, '{}', '{"backdrop":"heavy","motion":"fast","density":3}']) {
      const parsed = parsePreferences(raw)
      expect([parsed.backdrop, parsed.motion, parsed.density]).toEqual([undefined, 'system', 'standard'])
    }
    expect(parsePreferences('{"backdrop":"off","motion":"reduce","density":"compact"}')).toMatchObject({
      backdrop: 'off',
      motion: 'reduce',
      density: 'compact',
    })
    // Forcing motion on is not offered yet: such a value follows the system.
    expect(parsePreferences('{"backdrop":"light","motion":"full"}')).toMatchObject({ backdrop: 'light', motion: 'system' })
  })

  it('starts 背景效果 at 标准 on a desktop and at 轻 on a phone until the person chooses', () => {
    expect(backdropLevel({}, false)).toBe('standard')
    expect(backdropLevel({}, true)).toBe('light')
    for (const backdrop of ['off', 'light', 'standard'] as const) {
      expect(backdropLevel({ backdrop }, false)).toBe(backdrop)
      expect(backdropLevel({ backdrop }, true)).toBe(backdrop)
    }
  })

  it('puts 动效 and 密度 on the root for the stylesheets, and leaves every other attribute of the root alone', () => {
    // A page frozen for a capture carries data-capture; the page applying its preferences must not unfreeze it.
    const dataset: Record<string, string> = { capture: 'still', theme: 'dark' }
    vi.stubGlobal('document', { documentElement: { dataset } })
    applyAppearance('reduce', 'compact')
    expect(dataset).toEqual({ capture: 'still', theme: 'dark', motion: 'reduce', density: 'compact' })
    applyAppearance('system', 'standard')
    expect(dataset).toEqual({ capture: 'still', theme: 'dark' })
  })

  it('draws the choices as named controls: three strengths, two densities, and 动效 as 跟随系统 or 减弱', () => {
    const backdrop = renderToStaticMarkup(createElement(BackdropTiles, { value: 'standard', onValueChange: () => {} }))
    expect(backdrop).toContain('aria-label="背景效果"')
    expect(['>关<', '>轻<', '>标准<'].every(label => backdrop.includes(label))).toBe(true)
    expect(backdrop.match(/role="radio"/gu)).toHaveLength(3)
    // Each tile holds the real layer; 关 holds none.
    expect(backdrop.match(/class="ui-backdrop"/gu)).toHaveLength(2)
    const density = renderToStaticMarkup(createElement(DensityTiles, { value: 'compact', onValueChange: () => {} }))
    expect(density).toContain('aria-label="密度"')
    expect(density.match(/data-density="(?:standard|compact)"/gu)).toEqual(['data-density="standard"', 'data-density="compact"'])
    const motion = renderToStaticMarkup(createElement(MotionChoice, { value: 'system', onValueChange: () => {} }))
    expect(['跟随系统', '减弱'].every(label => motion.includes(label))).toBe(true)
    // No choice that only partly works: motion cannot be forced on against the system yet.
    expect(motion.match(/role="radio"/gu)).toHaveLength(2)
    expect(motion).not.toContain('>开<')
    expect(motion.match(/aria-checked="true"/gu)).toHaveLength(1)
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
