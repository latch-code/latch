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
import {
  AccentTiles,
  BackdropStyleTiles,
  BackdropTiles,
  DensityTiles,
  FloatingMaterialChoice,
  MotionChoice,
  PaletteTiles,
} from '../src/settings/AppearanceTiles.tsx'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('对话 or 看板 on this device', () => {
  it('opens on 对话 with missing, invalid or old 侧栏 preferences', () => {
    for (const raw of [
      null,
      '',
      '{',
      '{}',
      '{"theme":"dark"}',
      '{"workView":null}',
      '{"workView":"other"}',
      '{"workbenchLayout":"overview"}',
      '{"workbenchLayout":"other"}',
    ]) {
      expect(parsePreferences(raw).workView).toBe('chat')
    }
  })

  it('opens on 看板 where the device had chosen the old 顶栏 layout, until it chooses a view', () => {
    expect(parsePreferences('{"workbenchLayout":"triage"}').workView).toBe('board')
    expect(parsePreferences('{"workbenchLayout":"triage","workView":"chat"}').workView).toBe('chat')
    expect(parsePreferences('{"workbenchLayout":"overview","workView":"board"}').workView).toBe('board')
  })

  it('keeps the right panel shut by default where the old 顶栏 layout kept it so, and open elsewhere', () => {
    expect(parsePreferences('{"workbenchLayout":"triage"}').rightPanel.open).toBe(false)
    expect(parsePreferences('{"workbenchLayout":"overview"}').rightPanel.open).toBe(true)
    expect(parsePreferences('{}').rightPanel.open).toBe(true)
    expect(parsePreferences('{"workView":"board"}').rightPanel.open).toBe(true)
  })

  it('reads either saved view without changing the other preferences', () => {
    for (const workView of ['chat', 'board']) {
      expect(parsePreferences(JSON.stringify({ workView, theme: 'dark', sendKey: 'mod-enter' }))).toMatchObject({
        workView,
        theme: 'dark',
        sendKey: 'mod-enter',
      })
    }
  })

  it('saves a view with the existing local preferences, drops the old layout key and reads it after reloading the module', async () => {
    const entries = new Map([['latch.preferences', JSON.stringify({ theme: 'dark', sendKey: 'mod-enter', workbenchLayout: 'triage' })]])
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
    })
    vi.resetModules()
    const preferences = await import('../src/preferences.ts')
    preferences.setPreference('workView', 'chat')
    vi.resetModules()
    const reloaded = await import('../src/preferences.ts')
    expect(reloaded.parsePreferences(reloaded.storageGet('latch.preferences'))).toMatchObject({
      workView: 'chat',
      theme: 'dark',
      sendKey: 'mod-enter',
    })
    expect(JSON.parse(entries.get('latch.preferences')!)).not.toHaveProperty('workbenchLayout')
    expect([...entries.keys()]).toEqual(['latch.preferences'])
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

  it('starts black and white with the backdrop off and preserves a saved choice across palettes and widths', () => {
    const defaults = parsePreferences(null)
    expect(backdropLevel(defaults, false)).toBe('off')
    expect(backdropLevel(defaults, true)).toBe('off')
    for (const palette of ['graphite', 'cool', 'warm'] as const) {
      expect(backdropLevel({ palette }, false)).toBe('standard')
      expect(backdropLevel({ palette }, true)).toBe('light')
    }
    for (const palette of ['mono', 'graphite', 'cool', 'warm'] as const) {
      for (const backdrop of ['off', 'light', 'standard'] as const) {
        const preferences = parsePreferences(JSON.stringify({ palette, backdrop }))
        expect(backdropLevel(preferences, false)).toBe(backdrop)
        expect(backdropLevel(preferences, true)).toBe(backdrop)
      }
    }
  })

  it('reads the workbench palettes and defaults an old or unknown preference to monochrome', () => {
    for (const raw of [null, '{}', '{"palette":null}', '{"palette":"bright"}', '{"theme":"dark","density":"compact"}'])
      expect(parsePreferences(raw).palette).toBe('mono')
    for (const palette of ['mono', 'graphite', 'cool', 'warm'])
      expect(parsePreferences(JSON.stringify({ palette, theme: 'dark', density: 'compact' }))).toMatchObject({
        palette,
        theme: 'dark',
        density: 'compact',
      })
    const tiles = renderToStaticMarkup(createElement(PaletteTiles, { value: 'cool', onValueChange: () => {} }))
    expect(tiles).toContain('aria-label="工作台配色"')
    expect(tiles).toContain('仅此设备')
    expect(tiles.match(/data-palette="(?:mono|graphite|cool|warm)"/gu)).toEqual([
      'data-palette="mono"',
      'data-palette="graphite"',
      'data-palette="cool"',
      'data-palette="warm"',
    ])
    expect(tiles.match(/aria-checked="true"/gu)).toHaveLength(1)
  })

  it('puts the device appearance on the root while preserving other attributes', () => {
    // A page frozen for a capture carries data-capture; the page applying its preferences must not unfreeze it.
    const dataset: Record<string, string> = { capture: 'still', theme: 'dark' }
    vi.stubGlobal('document', { documentElement: { dataset } })
    applyAppearance({ motion: 'reduce', density: 'compact', palette: 'warm', accent: 'teal', floatingMaterial: 'clear' })
    expect(dataset).toEqual({
      capture: 'still',
      theme: 'dark',
      motion: 'reduce',
      density: 'compact',
      palette: 'warm',
      deviceAccent: 'teal',
      floatingMaterial: 'clear',
    })
    applyAppearance({ motion: 'system', density: 'standard', palette: 'graphite', accent: 'workbench', floatingMaterial: 'frosted' })
    expect(dataset).toEqual({
      capture: 'still',
      theme: 'dark',
      palette: 'graphite',
      deviceAccent: 'workbench',
      floatingMaterial: 'frosted',
    })
  })

  it('defaults the material to frosted and keeps a valid choice for this device', () => {
    for (const raw of [null, '{}', '{"floatingMaterial":false}', '{"floatingMaterial":"blurred"}'])
      expect(parsePreferences(raw).floatingMaterial).toBe('frosted')
    for (const floatingMaterial of ['solid', 'frosted', 'clear'])
      expect(parsePreferences(JSON.stringify({ floatingMaterial })).floatingMaterial).toBe(floatingMaterial)
    const choice = renderToStaticMarkup(createElement(FloatingMaterialChoice, { value: 'clear', onValueChange: () => {} }))
    expect(choice).toContain('aria-label="浮层材质"')
    expect(['实色', '磨砂', '通透'].every(name => choice.includes(name))).toBe(true)
    expect(choice.match(/aria-checked="true"/gu)).toHaveLength(1)
  })

  it('keeps a valid device accent and uses the workbench for old or invalid settings', () => {
    for (const raw of [null, '{}', '{"accent":255}', '{"accent":"unknown"}']) expect(parsePreferences(raw).accent).toBe('workbench')
    for (const accent of ['workbench', 'navy', 'teal', 'iris'])
      expect(parsePreferences(JSON.stringify({ theme: 'dark', palette: 'warm', accent }))).toMatchObject({
        theme: 'dark',
        palette: 'warm',
        accent,
      })
    const tiles = renderToStaticMarkup(createElement(AccentTiles, { value: 'iris', onValueChange: () => {} }))
    expect(tiles).toContain('aria-label="设备主色"')
    expect(tiles.match(/data-accent-sample="(?:workbench|navy|teal|iris)"/gu)).toEqual([
      'data-accent-sample="workbench"',
      'data-accent-sample="navy"',
      'data-accent-sample="teal"',
      'data-accent-sample="iris"',
    ])
  })

  it('draws the choices as named controls: three strengths, two densities, and 动效 as 跟随系统 or 减弱', () => {
    const backdrop = renderToStaticMarkup(createElement(BackdropTiles, { value: 'standard', kind: 'field', onValueChange: () => {} }))
    expect(backdrop).toContain('aria-label="背景效果"')
    expect(['>关<', '>轻<', '>标准<'].every(label => backdrop.includes(label))).toBe(true)
    const style = renderToStaticMarkup(createElement(BackdropStyleTiles, { value: 'digits', onValueChange: () => {} }))
    expect(style).toContain('aria-label="背景样式"')
    expect(['>粒子<', '>01<'].every(label => style.includes(label))).toBe(true)
    expect(parsePreferences('{"backdropStyle":"digits"}').backdropStyle).toBe('digits')
    expect(parsePreferences('{"backdropStyle":"rain"}').backdropStyle).toBe('field')
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

  it('switches at once where the window cannot cross-fade, and toggles between the two', async () => {
    const entries = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
    })
    vi.resetModules()
    const preferences = await import('../src/preferences.ts')
    preferences.switchWorkView('board')
    expect(JSON.parse(entries.get('latch.preferences')!).workView).toBe('board')
    preferences.toggleWorkView()
    expect(JSON.parse(entries.get('latch.preferences')!).workView).toBe('chat')
    preferences.toggleWorkView()
    expect(JSON.parse(entries.get('latch.preferences')!).workView).toBe('board')
  })
})
