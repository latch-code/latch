import { describe, expect, it } from 'vitest'
import { commands } from 'vitest/browser'
import { CUSTOM_TOKENS } from '../src/custom.ts'

// The test runs in the browser; the test server reads the file for it, from the repository root.
const tokens = (await commands.readFile('packages/ui/src/tokens.css')).replace(/\/\*[\s\S]*?\*\//gu, '')

/** The declarations of the first `<selector> { … }` block that contains no nested block. */
function block(selector: string, from = 0): Map<string, string> {
  const start = tokens.indexOf(`${selector} {`, from)
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

/** Both themes' colours: the light tokens with the dark block over them. */
const themes = () => {
  const light = block(':root')
  return { light, dark: new Map([...light, ...block(":root[data-theme='dark']")]) }
}

// Chromium's linear-RGB vision filters, based on Machado et al. (2009):
// https://chromium.googlesource.com/chromium/src/+/HEAD/third_party/blink/renderer/core/css/vision_deficiency.cc
const VISION = {
  protanopia: [
    [0.152, 1.053, -0.205],
    [0.115, 0.786, 0.099],
    [-0.004, -0.048, 1.052],
  ],
  deuteranopia: [
    [0.367, 0.861, -0.228],
    [0.28, 0.673, 0.047],
    [-0.012, 0.043, 0.969],
  ],
  tritanopia: [
    [1.256, -0.077, -0.179],
    [-0.078, 0.931, 0.148],
    [0.005, 0.691, 0.304],
  ],
}
function simulatedLab(rgb: Rgba, matrix: number[][]): number[] {
  const source = rgb.slice(0, 3).map(linear)
  const [r = 0, g = 0, b = 0] = matrix.map(row =>
    Math.max(
      0,
      Math.min(
        1,
        row.reduce((sum, value, index) => sum + value * source[index]!, 0),
      ),
    ),
  )
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

/** The colour tokens, light and dark. */
const TOKENS: Record<string, [string, string]> = {
  '--sunken': ['#f3f3f6', '#0b0b0d'],
  '--sidebar': ['#ebebef', '#09090b'],
  '--canvas': ['#ffffff', '#131316'],
  '--raised': ['#ffffff', '#1b1b1f'],
  '--card': ['#ffffff', '#212126'],
  '--pop': ['#ffffff', '#27272c'],
  '--hover': ['rgba(18, 18, 28, 0.05)', 'rgba(255, 255, 255, 0.05)'],
  '--press': ['rgba(18, 18, 28, 0.09)', 'rgba(255, 255, 255, 0.09)'],
  '--selected': ['#ffffff', 'rgba(255, 255, 255, 0.075)'],
  '--line': ['rgba(18, 18, 28, 0.075)', 'rgba(255, 255, 255, 0.06)'],
  '--line-strong': ['rgba(18, 18, 28, 0.14)', 'rgba(255, 255, 255, 0.11)'],
  '--joint': ['rgba(18, 18, 28, 0.1)', 'rgba(0, 0, 0, 0.55)'],
  '--ink': ['#17171a', '#ececef'],
  '--ink-2': ['#34343b', '#c9c9d0'],
  '--muted': ['#56565f', '#a3a3ad'],
  '--faint': ['#66666f', '#8b8b95'],
  '--bubble': ['#e9edf3', '#242831'],
  '--key': ['#fbfbfc', '#2e2e34'],
  '--tag': ['rgba(18, 18, 28, 0.065)', 'rgba(255, 255, 255, 0.08)'],
  '--track': ['rgba(18, 18, 28, 0.11)', 'rgba(255, 255, 255, 0.11)'],
  '--meter': ['#45454e', '#b6b6bf'],
  '--band': ['rgba(18, 18, 28, 0.025)', 'rgba(0, 0, 0, 0.2)'],
  '--accent': ['#2461e0', '#2f6be6'],
  '--accent-hover': ['#1d55cc', '#2a62d6'],
  '--accent-ink': ['#1d52c4', '#6b9bfa'],
  '--accent-soft': ['rgba(36, 97, 224, 0.1)', 'rgba(59, 118, 246, 0.18)'],
  '--amber': ['#884a06', '#f0aa45'],
  '--amber-icon': ['#c46f06', '#e89a2c'],
  '--amber-soft': ['rgba(217, 130, 9, 0.08)', 'rgba(240, 170, 69, 0.08)'],
  '--red': ['#b4231f', '#f47c75'],
  '--red-soft': ['rgba(213, 67, 61, 0.09)', 'rgba(244, 124, 117, 0.1)'],
  '--green': ['#166f3b', '#5ccc8e'],
  '--diff-add': ['rgba(25, 135, 70, 0.1)', 'rgba(86, 196, 135, 0.12)'],
  '--diff-del': ['rgba(213, 67, 61, 0.09)', 'rgba(244, 124, 117, 0.1)'],
  '--diff-add-edge': ['rgba(25, 135, 70, 0.55)', 'rgba(86, 196, 135, 0.6)'],
  '--diff-del-edge': ['rgba(213, 67, 61, 0.55)', 'rgba(244, 124, 117, 0.6)'],
  '--scrim': ['rgba(18, 18, 28, 0.14)', 'rgba(0, 0, 0, 0.44)'],
}

describe('design tokens', () => {
  it('declares the cascade layers first, lowest to highest, with security on top', () => {
    expect(tokens.trimStart().startsWith('@layer tokens, custom, base, ui, app, security;')).toBe(true)
  })

  it('holds the colour tokens in both themes', () => {
    const { light, dark } = themes()
    const found = Object.fromEntries(Object.keys(TOKENS).map(name => [name, [light.get(name), dark.get(name)]]))
    expect(found).toEqual(TOKENS)
  })

  it('keeps none of the retired tokens', () => {
    const retired =
      /--(?:text-[123]|text-disabled|icon|bg-[a-z-]+|well|fill(?:-[a-z]+)?|track-off|bubble-user|tile-plate|tile-ring|comet[a-z-]*|sweep|ripple-ink|kbd-ring|brand-ring|line-subtle|sh-(?:raised|float|composer|composer-focus|modal)|accent-(?:press|text|text-hover)|focus(?:-halo)?|warn-[a-z]+|on-warn-fill|err-[a-z]+|ok-[a-z]+|ring-[a-z-]+|corner-shape|r-pill|d-[a-z-]+|ease(?:-exit)?|delay-hint|font-sans|font-mono)\s*:/u
    expect(tokens.match(retired)).toBeNull()
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

  it('times motion with the five tokens and their curves, the v9 ones beside them, and shortens them for reduced motion', () => {
    const light = block(':root')
    const motion = Object.fromEntries([...light].filter(([name]) => /^--[me]-/u.test(name)))
    const base = [
      '--m-micro',
      '--m-enter',
      '--m-panel',
      '--m-sheet',
      '--m-push',
      '--e-micro',
      '--e-enter',
      '--e-panel',
      '--e-sheet',
      '--e-push',
      '--e-exit',
    ]
    expect(Object.fromEntries(base.map(name => [name, motion[name]]))).toEqual({
      '--m-micro': '120ms',
      '--m-enter': '160ms',
      '--m-panel': '200ms',
      '--m-sheet': '260ms',
      '--m-push': '320ms',
      '--e-micro': 'cubic-bezier(0.2, 0, 0, 1)',
      '--e-enter': 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      '--e-panel': 'cubic-bezier(0.32, 0.72, 0, 1)',
      '--e-sheet': 'cubic-bezier(0.32, 0.72, 0, 1)',
      '--e-push': 'cubic-bezier(0.32, 0.72, 0, 1)',
      '--e-exit': 'cubic-bezier(0.4, 0, 1, 1)',
    })
    // Every other motion token is a duration in milliseconds or one of the two springs, which start at 0 and end at 1.
    const rest = Object.entries(motion).filter(([name]) => !base.includes(name))
    const springs = rest.filter(([name]) => name.startsWith('--e-'))
    expect(springs.map(([name]) => name)).toEqual(['--e-spring', '--e-settle'])
    for (const [name, value] of springs) expect(value, name).toMatch(/^linear\(\s*0,[\d.,\s]+,\s*1\s*\)$/u)
    for (const [name, value] of rest.filter(([key]) => key.startsWith('--m-'))) expect(value, name).toMatch(/^\d+ms$/u)
    // The spring passes its target by a few percent and the settle by less than one: it lands, it does not bounce.
    const peak = (value: string) => Math.max(...value.slice(7, -1).split(',').map(Number))
    expect(peak(motion['--e-spring']!)).toBeGreaterThan(peak(motion['--e-settle']!))
    expect(peak(motion['--e-spring']!)).toBeLessThan(1.05)
    expect(peak(motion['--e-settle']!)).toBeLessThan(1.01)
    // Reduced by the system or by 减弱 on this device: the same block twice, nothing longer than 120ms, no spring.
    const system = block(':root', tokens.indexOf('@media (prefers-reduced-motion: reduce)'))
    const chosen = block(":root[data-motion='reduce']")
    expect([...chosen]).toEqual([...system])
    expect(base.filter(name => name.startsWith('--m-')).every(name => system.has(name))).toBe(true)
    for (const [name, value] of system) {
      if (name.startsWith('--m-')) expect(parseFloat(value), name).toBeLessThanOrEqual(120)
      else expect(value, name).toBe('linear')
    }
    expect([...system.keys()].filter(name => !light.has(name))).toEqual([])
    // No rule anywhere forces motion on against the system: no setting produces that state.
    expect(tokens).not.toContain("data-motion='full'")
  })

  it('reduces motion for 减弱 on this device, whatever the system says', () => {
    const root = document.documentElement
    const panel = () => getComputedStyle(root).getPropertyValue('--m-panel').trim()
    const before = panel()
    try {
      root.dataset.motion = 'reduce'
      expect(parseFloat(panel())).toBeLessThan(parseFloat(before))
      expect(parseFloat(panel())).toBeLessThanOrEqual(120)
    } finally {
      delete root.dataset.motion
    }
    expect(panel()).toBe(before)
  })

  it('gives the shared workbench and v9 roles in both themes', () => {
    const { light, dark } = themes()
    for (const name of ['--work-canvas', '--work-raised', '--work-sunken']) {
      const [darkRed, , darkBlue] = colour(dark.get(name))
      expect(darkBlue, name).toBeGreaterThan(darkRed)
      const paper = colour(light.get(name))
      expect(paper[2], name).toBeGreaterThanOrEqual(paper[0])
      expect(luminance(paper), name).toBeGreaterThan(0.75)
    }
    // Lines and ticks are built from the surface's own roles, so they follow whatever surface they sit on.
    expect(['--hairline', '--rule', '--tick'].map(name => light.get(name))).toEqual(['var(--line)', 'var(--line-strong)', 'var(--muted)'])
    // The background ink is a blue-grey of its own, never one of the four state colours, in both themes.
    for (const theme of [light, dark]) {
      const ink = /^rgb\((\d+), (\d+), (\d+)\)$/u.exec(theme.get('--fx-ink') ?? '')
      expect(ink).not.toBeNull()
      const [red, , blue] = ink!.slice(1).map(Number)
      expect(blue).toBeGreaterThan(red!)
      for (const state of ['--accent', '--amber', '--red', '--green']) expect(theme.get('--fx-ink')).not.toBe(theme.get(state))
    }
    // Every v9 role has a reader: none is declared for a later batch.
    for (const gone of [
      '--fx-glow',
      '--s-recede',
      '--fs-work-focus',
      '--lh-work-focus',
      '--density-card',
      '--density-gap',
      '--density-section',
    ])
      expect(light.has(gone), gone).toBe(false)
    // 紧凑 tightens the density roles and nothing else; a part of the page can keep the standard ones inside it.
    const density = [...light.keys()].filter(name => name.startsWith('--density-'))
    expect(density.length).toBeGreaterThan(0)
    const compact = block("[data-density='compact']")
    expect([...compact.keys()]).toEqual(density)
    expect([...block("[data-density='standard']")]).toEqual(density.map(name => [name, light.get(name)]))
    const px = (value: string | undefined) => parseFloat(light.get(/var\((--sp-\d+)\)/u.exec(value ?? '')?.[1] ?? '') ?? '')
    for (const name of density) expect(px(compact.get(name)), name).toBeLessThan(px(light.get(name)))
  })

  it('keeps a security surface on the standard density when the page is compact', () => {
    const root = document.documentElement
    const surface = document.createElement('div')
    surface.dataset.secure = ''
    document.body.append(surface)
    root.dataset.density = 'compact'
    try {
      expect(getComputedStyle(root).getPropertyValue('--density-row').trim()).toBe('8px')
      expect(getComputedStyle(surface).getPropertyValue('--density-row').trim()).toBe('12px')
    } finally {
      delete root.dataset.density
      surface.remove()
    }
  })

  it('paints flat: no gradient anywhere in the tokens, and the page shows the sidebar grey alone', () => {
    expect(tokens).not.toMatch(/gradient\(/u)
    const previous = document.documentElement.dataset.theme
    document.documentElement.dataset.theme = 'light'
    try {
      for (const element of [document.documentElement, document.body]) {
        const style = getComputedStyle(element)
        expect([style.backgroundImage, style.backgroundColor]).toEqual(['none', 'rgb(235, 235, 239)'])
      }
    } finally {
      if (previous === undefined) delete document.documentElement.dataset.theme
      else document.documentElement.dataset.theme = previous
    }
  })

  it('keeps the inks readable on every surface: ink, ink-2, accent-ink and red at 4.5:1, muted and the accent at 3:1', () => {
    const all = themes()
    for (const name of ['light', 'dark'] as const) {
      const theme = all[name]
      const get = (token: string) => colour(theme.get(token))
      const solid: Array<[string, Rgba]> = [
        ['--canvas', get('--canvas')],
        ['--sidebar', get('--sidebar')],
        ['--raised', get('--raised')],
        ['--sunken', get('--sunken')],
        ['--card', get('--card')],
        ['--pop', get('--pop')],
        ['--bubble', get('--bubble')],
        ['--selected on --sidebar', over(get('--selected'), get('--sidebar'))],
      ]
      // A hover or a press laid over the sidebar and over the canvas.
      const tinted = ['--hover', '--press'].flatMap(tint =>
        (['--sidebar', '--canvas'] as const).map(base => [`${tint} on ${base}`, over(get(tint), get(base))] as [string, Rgba]),
      )
      const surfaces = [...solid, ...tinted]
      const floors = { '--ink': 4.5, '--ink-2': 4.5, '--accent-ink': 4.5, '--red': 4.5, '--muted': 3, '--accent': 3 }
      const failing = Object.entries(floors).flatMap(([ink, floor]) =>
        surfaces
          .filter(([, fill]) => contrast(get(ink), fill) < floor)
          .map(([surface, fill]) => `${name} ${ink} on ${surface}: ${contrast(get(ink), fill).toFixed(2)}`),
      )
      expect(failing).toEqual([])
    }
  })

  it('keeps the words of a high-risk card at 4.5:1 on its red tint over the canvas', () => {
    const all = themes()
    for (const name of ['light', 'dark'] as const) {
      const get = (token: string) => colour(all[name].get(token))
      const ground = over(get('--red-soft'), get('--canvas'))
      for (const ink of ['--ink', '--ink-2', '--red', '--amber'])
        expect(contrast(get(ink), ground), `${name} ${ink}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps white words at 4.5:1 on the accent and on its hover, in both themes', () => {
    const all = themes()
    for (const name of ['light', 'dark'] as const) {
      const get = (token: string) => colour(all[name].get(token))
      for (const fill of ['--accent', '--accent-hover'])
        expect(contrast(get('--on-accent'), get(fill)), `${name} --on-accent on ${fill}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps secondary words and 等你处理 at 4.5:1 where they rest, secondary words on a hovered row, and 等你处理 on its hover fill', () => {
    const all = themes()
    for (const name of ['light', 'dark'] as const) {
      const theme = all[name]
      const get = (token: string) => colour(theme.get(token))
      const rests: Array<[string, Rgba]> = [
        ['--canvas', get('--canvas')],
        ['--raised', get('--raised')],
        ['--card', get('--card')],
        ['--sidebar', get('--sidebar')],
      ]
      const tint: [string, Rgba] = ['--amber-soft on --raised', over(get('--amber-soft'), get('--raised'))]
      const hovered: Array<[string, Rgba]> = [
        ['--hover on --sidebar', over(get('--hover'), get('--sidebar'))],
        ['--hover on --raised', over(get('--hover'), get('--raised'))],
      ]
      const failing = [
        ...[...rests, ...hovered]
          .filter(([, fill]) => contrast(get('--muted'), fill) < 4.5)
          .map(([surface]) => `${name} --muted on ${surface}`),
        ...[...rests, tint].filter(([, fill]) => contrast(get('--amber'), fill) < 4.5).map(([surface]) => `${name} --amber on ${surface}`),
      ]
      expect(failing).toEqual([])
    }
  })

  it('keeps the amber of icons at 3:1 on the surfaces under it', () => {
    const all = themes()
    for (const name of ['light', 'dark'] as const) {
      const get = (token: string) => colour(all[name].get(token))
      for (const surface of ['--canvas', '--raised', '--card', '--sidebar'])
        expect(contrast(get('--amber-icon'), get(surface)), `${name} --amber-icon on ${surface}`).toBeGreaterThanOrEqual(3)
    }
  })

  it('lays the hover fill of an amber chip to the two approved composites on the raised surface', () => {
    const { light, dark } = themes()
    const hex = (theme: Map<string, string>) =>
      `#${over(colour(theme.get('--amber-soft')), colour(theme.get('--raised')))
        .slice(0, 3)
        .map(channel => Math.round(channel).toString(16).padStart(2, '0'))
        .join('')}`
    expect([hex(light), hex(dark)]).toEqual(['#fcf5eb', '#2c2622'])
  })

  it('keeps the semantic inks distinct under Chromium vision-deficiency simulations', () => {
    const colours = ['--accent', '--amber', '--red', '--green']
    const measurements: Array<{ theme: string; vision: string; pair: string; deltaE: number }> = []
    for (const [theme, values] of Object.entries(themes()))
      for (const [vision, matrix] of Object.entries(VISION)) {
        for (let a = 0; a < colours.length; a++)
          for (let b = a + 1; b < colours.length; b++) {
            const first = simulatedLab(colour(values.get(colours[a]!)), matrix)
            const second = simulatedLab(colour(values.get(colours[b]!)), matrix)
            const deltaE = 100 * Math.hypot(...first.map((value, index) => value - second[index]!))
            measurements.push({ theme, vision, pair: `${colours[a]} / ${colours[b]}`, deltaE: Math.round(deltaE * 100) / 100 })
          }
      }
    // A 3-unit OKLab floor prevents near-identical state inks. Words and glyphs carry every meaning.
    expect(measurements.filter(item => item.deltaE < 3)).toEqual([])
  })

  it('steps the surfaces up from the well: sunken, sidebar, canvas, raised, card, pop, each a step lighter in the dark theme', () => {
    const order = ['--sidebar', '--sunken', '--canvas', '--raised', '--card', '--pop']
    for (const [name, theme] of Object.entries(themes())) {
      const light = order.map(token => luminance(colour(theme.get(token))))
      // The light theme paints every layer above the ground white and tells them apart by shadow; the dark one steps up.
      const steps = light.slice(1).map((value, index) => value - light[index]!)
      if (name === 'dark')
        expect(
          steps.every(step => step > 0),
          `${name} ${order.join(' < ')}`,
        ).toBe(true)
      else
        expect(
          steps.every(step => step >= 0),
          `${name} ${order.join(' ≤ ')}`,
        ).toBe(true)
    }
  })

  it('lifts the work panel and the floating layers and sinks the wells with their own shadows in both themes', () => {
    const { light, dark } = themes()
    for (const theme of [light, dark])
      for (const token of ['--sh-panel', '--sh-lift', '--sh-well', '--sh-key']) expect(theme.get(token), token).toMatch(COLOUR)
    // A well is inset; a panel and a float lie on top; the lip of a key is an inset line 2px high at its bottom.
    expect(light.get('--sh-well')).toMatch(/^inset /u)
    expect(dark.get('--sh-well')).toMatch(/^inset /u)
    expect(light.get('--sh-key')).toContain('inset 0 -2px 0')
    expect(dark.get('--sh-key')).toContain('inset 0 -2px 0')
    // In the dark theme a lifted layer catches a light line at its top.
    for (const token of ['--sh-panel', '--sh-lift']) expect(dark.get(token)).toMatch(/^inset 0 1px 0 rgba\(255, 255, 255, /u)
    expect([light.get('--sh-panel'), light.get('--sh-lift')].some(value => value?.includes('inset'))).toBe(false)
  })

  it('keeps a key cap legible: muted words on the key face at 4.5:1, and a filled meter cell at 3:1 on the composer', () => {
    const all = themes()
    for (const name of ['light', 'dark'] as const) {
      const get = (token: string) => colour(all[name].get(token))
      expect(contrast(get('--muted'), get('--key')), `${name} --muted on --key`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(get('--meter'), get('--raised')), `${name} --meter on --raised`).toBeGreaterThanOrEqual(3)
    }
  })

  it('keeps the shared workbench surfaces readable in either theme', () => {
    for (const [theme, values] of Object.entries(themes())) {
      const get = (token: string) => colour(values.get(token))
      for (const background of ['canvas', 'raised', 'sunken'])
        for (const text of ['ink', 'ink-2', 'muted', 'faint']) {
          const foreground = `--work-${text}`,
            surface = `--work-${background}`
          expect(contrast(get(foreground), get(surface)), `${theme} ${foreground} on ${surface}`).toBeGreaterThanOrEqual(4.5)
        }
    }
  })

  it('locks every themed token inside security surfaces to the value of its theme', () => {
    /** The declarations of every block whose selector is exactly `selector`, in order. */
    const blocks = (selector: string) =>
      [...tokens.matchAll(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} \\{([^{}]*)\\}`, 'gu'))].map(
        match =>
          new Map(
            [...match[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu)].map(item => [
              item[1],
              item[2]
                .replace(/\s+/gu, ' ')
                .replace(/ ?!important$/u, '')
                .trim(),
            ]),
          ),
      )
    const scope = ':where([data-secure], [data-secure] *, [data-lock], [data-lock] *)'
    const [lockLight, lockPhone] = blocks(scope)
    const [lockSystem] = blocks(`:root:not([data-theme='light']) ${scope}`)
    const [lockChosen] = blocks(`:root[data-theme='dark'] ${scope}`)
    // Layout, motion and the surface under an element stay free; every other token is locked.
    const free =
      /^--(?:sidebar-width|sidebar-open-width|inspector-width|inspector-open-width|content-width|gutter|topbar-height|shell-inset|touch|layer-(?:xs|sm|md|lg|xl)|z-[a-z]+|scrim-blur|m-[a-z]+|e-[a-z]+|surface)$/u
    const expected = (theme: Map<string, string>) => [...theme].filter(([name]) => !free.test(name))
    expect([...(lockLight ?? [])]).toEqual(expected(block(':root')))
    expect([...(lockSystem ?? [])]).toEqual(expected(block(":root[data-theme='dark']")))
    expect([...(lockChosen ?? [])]).toEqual([...(lockSystem ?? [])])
    // The phone sizes: the :root block of the 767.98px query.
    const phone = block(':root', tokens.indexOf('@media (max-width: 767.98px)'))
    expect(phone.get('--fs-input')).toBe('16px')
    expect([...(lockPhone ?? [])]).toEqual(expected(phone))
    // Every lock is important, so it holds against later layers and against styles outside the layers.
    const scoped = tokens.slice(tokens.indexOf(scope))
    expect(scoped.match(/--[\w-]+\s*:[^;]+;/gu)?.every(item => item.includes('!important'))).toBe(true)
  })

  it('lets a customisation set only tokens the lock pins: in the light theme, both dark blocks and at the phone sizes', () => {
    const scope = ':where([data-secure], [data-secure] *, [data-lock], [data-lock] *)'
    const lockLight = block(scope)
    const lockPhone = block(scope, tokens.indexOf('@media (max-width: 767.98px)', tokens.indexOf(scope)))
    const lockSystem = block(`:root:not([data-theme='light']) ${scope}`)
    const lockChosen = block(`:root[data-theme='dark'] ${scope}`)
    expect(new Set(CUSTOM_TOKENS).size).toBe(CUSTOM_TOKENS.length)
    // Every one is a token the theme defines, and the lock pins it wherever the theme gives it a value.
    const light = block(':root')
    expect(CUSTOM_TOKENS.filter(name => !light.has(name))).toEqual([])
    expect(CUSTOM_TOKENS.filter(name => !lockLight.has(name))).toEqual([])
    const dark = block(":root[data-theme='dark']")
    expect(CUSTOM_TOKENS.filter(name => dark.has(name) && !(lockSystem.has(name) && lockChosen.has(name)))).toEqual([])
    const phone = block(':root', tokens.indexOf('@media (max-width: 767.98px)'))
    expect(CUSTOM_TOKENS.filter(name => phone.has(name) && !lockPhone.has(name))).toEqual([])
    expect(CUSTOM_TOKENS.some(name => phone.has(name)) && CUSTOM_TOKENS.some(name => dark.has(name))).toBe(true)
    // The state colours, and anything that could hide or empty a part of the page, are not customisable.
    expect(CUSTOM_TOKENS.filter(name => /amber|red|green|diff|scrim|opacity|ink$|^--(?:sp|touch|m|e)-/u.test(name))).toEqual([
      '--accent-ink',
    ])
  })

  it('keeps the locked tokens when a later style declares them, outside the layers and on the element', () => {
    // The light theme, whatever another test emulates for the page meanwhile.
    const previous = document.documentElement.dataset.theme
    document.documentElement.dataset.theme = 'light'
    const surface = document.createElement('div')
    surface.dataset.secure = ''
    const inner = document.createElement('span')
    surface.append(inner)
    document.body.append(surface)
    const names = ['--accent', '--red-soft', '--ink', '--fs-ui', '--mono']
    const before = names.map(name => getComputedStyle(inner).getPropertyValue(name))
    const injected = document.createElement('style')
    injected.textContent = `
      :root { --accent: rgb(0, 200, 0) !important; --red-soft: transparent !important; --ink: transparent; --fs-ui: 1px }
      * { --mono: serif !important; --ink: transparent !important }
      [data-secure], [data-secure] span { --accent: rgb(0, 200, 0) !important; --fs-ui: 1px !important }
      @layer app { span { --red-soft: transparent !important } }`
    document.head.append(injected)
    try {
      const after = names.map(name => getComputedStyle(inner).getPropertyValue(name))
      expect(after).toEqual(before)
      expect(before[0]?.trim()).toBe('#2461e0')
      // Outside a security surface the same injection does take effect: the lock is only where it is needed.
      expect(getComputedStyle(document.body).getPropertyValue('--accent').trim()).toBe('rgb(0, 200, 0)')
    } finally {
      injected.remove()
      surface.remove()
      if (previous === undefined) delete document.documentElement.dataset.theme
      else document.documentElement.dataset.theme = previous
    }
  })

  it('keeps one table for every overlay: five widths, a radius per kind on the scale, a stacking order, one blur', () => {
    const light = block(':root')
    const widths = [...light].filter(([name]) => /^--layer-(?!radius)/u.test(name))
    expect(widths.map(([name]) => name)).toEqual(['--layer-xs', '--layer-sm', '--layer-md', '--layer-lg', '--layer-xl'])
    const px = widths.map(([, value]) => parseFloat(value))
    expect(px.every((value, index) => index === 0 || value > px[index - 1]!)).toBe(true)
    expect(Object.fromEntries(['--tip-radius', '--layer-radius', '--modal-radius'].map(name => [name, light.get(name)]))).toEqual({
      '--tip-radius': 'var(--r-6)',
      '--layer-radius': 'var(--r-12)',
      '--modal-radius': 'var(--r-16)',
    })
    const order = [...light].filter(([name]) => name.startsWith('--z-'))
    expect(order.map(([name]) => name)).toEqual(['--z-float', '--z-scrim', '--z-slide', '--z-focus', '--z-page', '--z-toast'])
    const levels = order.map(([, value]) => Number(value))
    expect(levels.every((value, index) => index === 0 || value > levels[index - 1]!)).toBe(true)
    expect(light.get('--scrim-blur')).toBe('4px')
  })

  it('draws no corner shape: rounded rectangles take their radius from the scale alone', () => {
    expect(tokens).not.toMatch(/corner-shape/u)
    expect(Object.fromEntries([...block(':root')].filter(([name]) => name.startsWith('--r-')))).toEqual({
      '--r-2': '2px',
      '--r-4': '4px',
      '--r-6': '6px',
      '--r-8': '8px',
      '--r-12': '12px',
      '--r-16': '16px',
      '--r-full': '999px',
    })
  })
})

it('keeps syntax ink readable on the canvas and on sunken code, and comments quieter but legible', () => {
  for (const [name, theme] of Object.entries(themes())) {
    const get = (token: string) => {
      const value = theme.get(token) ?? ''
      // The plain roles are the code ink itself.
      return colour(value.startsWith('var(') ? theme.get(value.slice(4, -1)) : value)
    }
    for (const role of ['plain', 'keyword', 'string', 'comment', 'number', 'function', 'constant', 'punctuation']) {
      const floor = role === 'comment' ? 3 : 4.5
      for (const background of ['--canvas', '--sunken'])
        expect(contrast(get(`--syn-${role}`), get(background)), `${name} ${role} on ${background}`).toBeGreaterThanOrEqual(floor)
    }
  }
})
