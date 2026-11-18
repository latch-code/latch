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
import { BackdropStyleTiles, BackdropTiles, DensityTiles, MotionChoice } from '../src/settings/AppearanceTiles.tsx'

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
