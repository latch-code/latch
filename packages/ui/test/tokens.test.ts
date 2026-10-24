import { describe, expect, it } from 'vitest'
import { commands } from 'vitest/browser'

// The test runs in the browser; the test server reads the file for it, from the repository root.
const tokens = (await commands.readFile('packages/ui/src/tokens.css')).replace(/\/\*[\s\S]*?\*\//gu, '')

/** The declarations of the first `<selector> { … }` block that contains no nested block. */
function block(selector: string): Map<string, string> {
  const start = tokens.indexOf(`${selector} {`)
  expect(start, `${selector} 不在 tokens.css 中`).toBeGreaterThanOrEqual(0)
  const body = tokens.slice(tokens.indexOf('{', start) + 1, tokens.indexOf('}', start))
  return new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu)].map(match => [match[1], match[2].replace(/\s+/gu, ' ').trim()]))
}

const COLOUR = /#[0-9a-f]{3,8}\b|rgba?\(/iu

type Rgba = [number, number, number, number]
/** A token's colour: #rrggbb or rgba(r, g, b, a). */
function colour(value: string | undefined): Rgba {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(value ?? '')
  if (hex) return [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16), 1]
  const rgba = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/u.exec(value ?? '')
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), Number(rgba[4])]
  throw new Error(`Not a colour: ${value}`)
}
/** A translucent colour laid over an opaque one. */
const over = ([r, g, b, a]: Rgba, base: Rgba): Rgba => [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a), 1]
/** WCAG 2 relative luminance and contrast ratio. */
const linear = (channel: number) => (channel / 255 <= 0.04045 ? channel / 255 / 12.92 : ((channel / 255 + 0.055) / 1.055) ** 2.4)
const luminance = ([r, g, b]: Rgba) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
const contrast = (a: Rgba, b: Rgba) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05)
/** OKLCH chroma of an opaque colour (Björn Ottosson's OKLab, from linear sRGB). */
function chroma([r, g, b]: Rgba): number {
  const l = Math.cbrt(0.4122214708 * linear(r) + 0.5363325363 * linear(g) + 0.0514459929 * linear(b))
  const m = Math.cbrt(0.2119034982 * linear(r) + 0.6806995451 * linear(g) + 0.1073969566 * linear(b))
  const s = Math.cbrt(0.0883024619 * linear(r) + 0.2817188376 * linear(g) + 0.6299787005 * linear(b))
  return Math.hypot(1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s)
}
/** The red, green and blue of a colour token, as text. */
const ink = (theme: Map<string, string>, name: string) => colour(theme.get(name)).slice(0, 3).join(', ')

/** Both themes' colours: the light tokens with the dark block over them. */
const themes = () => {
  const light = block(':root')
  return { light, dark: new Map([...light, ...block(":root[data-theme='dark']")]) }
}

describe('design tokens', () => {
  it('declares the cascade layers first, lowest to highest, with security on top', () => {
    expect(tokens.trimStart().startsWith('@layer tokens, base, ui, app, security;')).toBe(true)
  })

  it('gives every colour token a dark value, identical under the system preference and under data-theme', () => {
    const light = block(':root')
    const system = block(":root:not([data-theme='light'])")
    const chosen = block(":root[data-theme='dark']")
    expect([...system]).toEqual([...chosen])
    const coloured = [...light].filter(([, value]) => COLOUR.test(value)).map(([name]) => name)
    expect(coloured.length).toBeGreaterThan(50)
    expect(coloured.filter(name => !system.has(name))).toEqual([])
    // The dark theme only changes colours; sizes, type and motion are the same in both themes.
    expect([...system.keys()].filter(name => !light.has(name))).toEqual([])
  })

  it('tints every translucent neutral with the ink of its theme, and the comet with text-2', () => {
    const { light, dark } = themes()
    const neutrals = ['--well', '--bg-hover', '--bg-press', '--fill', '--fill-hover', '--fill-press', '--track-off', '--bubble-user']
    const lines = ['--line', '--line-subtle', '--line-strong', '--tile-ring', '--comet-track', '--kbd-ring']
    expect(new Set([...neutrals, ...lines].map(name => ink(light, name)))).toEqual(new Set(['29, 28, 26']))
    // The dark well sinks into black; every other neutral is the light ink of the dark theme.
    expect(new Set([...neutrals.filter(name => name !== '--well'), ...lines].map(name => ink(dark, name)))).toEqual(
      new Set(['234, 233, 231']),
    )
    expect(ink(dark, '--well')).toBe('0, 0, 0')
    // Shadows ring and fall in the ink; in the dark theme they ring in its light ink and still fall black.
    for (const name of ['--sh-raised', '--sh-float', '--sh-composer', '--sh-composer-focus', '--sh-modal']) {
      expect(new Set(light.get(name)?.match(/rgba\(\d+, \d+, \d+/gu))).toEqual(new Set(['rgba(29, 28, 26']))
      const darkInks = new Set(dark.get(name)?.match(/rgba\(\d+, \d+, \d+/gu))
      expect([...darkInks].filter(value => value !== 'rgba(234, 233, 231' && value !== 'rgba(0, 0, 0')).toEqual([])
    }
    expect(light.get('--comet')).toBe('var(--text-2)')
  })

  it('paints the ground flat: no gradient anywhere in the tokens, and the page shows bg-app alone', () => {
    expect(tokens).not.toMatch(/gradient\(|--ground/u)
    for (const element of [document.documentElement, document.body]) {
      const style = getComputedStyle(element)
      expect([style.backgroundImage, style.backgroundColor]).toEqual(['none', 'rgb(242, 241, 238)'])
    }
  })

  it('keeps the surfaces and inks near-neutral, layered by lightness with the ground the darkest', () => {
    const surfaces = ['--bg-app', '--bg-sunken', '--bg-pane', '--bg-raised']
    const inks = ['--text-1', '--text-2', '--text-3', '--icon', '--text-disabled']
    for (const [name, theme] of Object.entries(themes())) {
      // Grey that reads neither beige nor blue-grey: an OKLCH chroma within 8-bit rounding of zero.
      const tinted = [...surfaces, ...inks, '--bg-selected-solid', '--tile-plate']
        .map(token => [token, chroma(colour(theme.get(token)))] as const)
        .filter(([, value]) => value > 0.005)
      expect(tinted, name).toEqual([])
      // Ground, then the tray, the paper and the raised layer, each lighter; the selected row sits below the ground.
      const steps = surfaces.map(token => luminance(colour(theme.get(token))))
      expect(
        steps.toSorted((a, b) => a - b),
        name,
      ).toEqual(steps)
      const [ground = 0] = steps
      expect(luminance(colour(theme.get('--bg-selected-solid'))) < ground).toBe(name === 'light')
    }
  })

  it('keeps text-1, text-2 and text-3 at 4.5:1 and the icon ink at 3:1 on every surface, lowest on the selected row', () => {
    // The measured minima, on the selected row in both themes.
    const minima = {
      light: { '--text-1': 12.67, '--text-2': 7.26, '--text-3': 4.74, '--icon': 3.11 },
      dark: { '--text-1': 11.2, '--text-2': 7.56, '--text-3': 4.72, '--icon': 3.5 },
    }
    const all = themes()
    for (const name of ['light', 'dark'] as const) {
      const theme = all[name]
      const solid = ['--bg-app', '--bg-pane', '--bg-raised', '--bg-sunken', '--bg-selected-solid'].map(
        token => [token, colour(theme.get(token))] as const,
      )
      // A hover or a press laid over the ground and over the paper.
      const tinted = ['--bg-hover', '--bg-press'].flatMap(tint =>
        solid.slice(0, 2).map(([token, base]) => [`${tint} on ${token}`, over(colour(theme.get(tint)), base)] as const),
      )
      const surfaces = [...solid, ...tinted]
      const least = (text: string) =>
        surfaces
          .map(([surface, fill]) => [surface, contrast(colour(theme.get(text)), fill)] as const)
          .reduce((lowest, item) => (item[1] < lowest[1] ? item : lowest))
      const failing = Object.entries({ '--text-1': 4.5, '--text-2': 4.5, '--text-3': 4.5, '--err-text': 4.5, '--icon': 3 }).flatMap(
        ([text, floor]) => {
          const [surface, ratio] = least(text)
          return ratio < floor ? [`${name} ${text} on ${surface}: ${ratio.toFixed(2)}`] : []
        },
      )
      expect(failing).toEqual([])
      for (const [text, measured] of Object.entries(minima[name])) {
        const [surface, ratio] = least(text)
        expect([surface, Math.round(ratio * 100) / 100], `${name} ${text}`).toEqual(['--bg-selected-solid', measured])
      }
    }
  })

  it('builds the focus rings from the themed colours, so they follow the theme', () => {
    const light = block(':root')
    for (const ring of ['--ring-focus-inset', '--ring-field-focus']) {
      expect(light.get(ring)).toMatch(/var\(--focus\)/u)
      expect(COLOUR.test(light.get(ring) ?? '')).toBe(false)
    }
  })

  it('sets the rounded-rectangle corner shape only where the browser supports it', () => {
    const outside = tokens.replace(/@supports \(corner-shape: superellipse\(1\.2\)\) \{[^{}]*\{[^{}]*\}\s*\}/u, '')
    expect(outside).not.toBe(tokens)
    expect(outside).not.toMatch(/--corner-shape\s*:/u)
  })
})
