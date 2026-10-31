import { describe, expect, it } from 'vitest'
import { commands } from 'vitest/browser'

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
  '--canvas': ['#ffffff', '#111113'],
  '--sidebar': ['#f7f7f8', '#0a0a0b'],
  '--raised': ['#ffffff', '#18181b'],
  '--sunken': ['#f7f7f8', '#0e0e10'],
  '--hover': ['rgba(0, 0, 0, 0.04)', 'rgba(255, 255, 255, 0.05)'],
  '--press': ['rgba(0, 0, 0, 0.07)', 'rgba(255, 255, 255, 0.09)'],
  '--selected': ['#ffffff', 'rgba(255, 255, 255, 0.08)'],
  '--line': ['#ebebed', 'rgba(255, 255, 255, 0.08)'],
  '--line-strong': ['#dcdce0', 'rgba(255, 255, 255, 0.14)'],
  '--ink': ['#18181b', '#f4f4f5'],
  '--ink-2': ['#3f3f46', '#d4d4d8'],
  '--muted': ['#71717a', '#a1a1aa'],
  '--faint': ['#a1a1aa', '#71717a'],
  '--bubble': ['#f1f1f3', '#1e1e21'],
  '--accent': ['#2461e0', '#2f6feb'],
  '--accent-hover': ['#1d53c8', '#2a63d4'],
  '--accent-ink': ['#215bd5', '#6b9bfa'],
  '--accent-soft': ['rgba(36, 97, 224, 0.1)', 'rgba(59, 118, 246, 0.18)'],
  '--amber': ['#b45309', '#fbbf24'],
  '--amber-icon': ['#f59e0b', '#fbbf24'],
  '--amber-soft': ['rgba(245, 158, 11, 0.1)', 'rgba(251, 191, 36, 0.12)'],
  '--red': ['#b91c1c', '#f87171'],
  '--red-soft': ['rgba(220, 38, 38, 0.07)', 'rgba(248, 113, 113, 0.12)'],
  '--green': ['#15803d', '#4ade80'],
  '--diff-add': ['rgba(22, 163, 74, 0.09)', 'rgba(74, 222, 128, 0.1)'],
  '--diff-del': ['rgba(220, 38, 38, 0.07)', 'rgba(248, 113, 113, 0.1)'],
  '--scrim': ['rgba(0, 0, 0, 0.24)', 'rgba(0, 0, 0, 0.56)'],
}

describe('design tokens', () => {
  it('declares the cascade layers first, lowest to highest, with security on top', () => {
    expect(tokens.trimStart().startsWith('@layer tokens, base, ui, app, security;')).toBe(true)
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

  it('times motion with the five tokens and their curves, and shortens them to 120ms or less for reduced motion', () => {
    const light = block(':root')
    const motion = Object.fromEntries([...light].filter(([name]) => /^--[me]-/u.test(name)))
    expect(motion).toEqual({
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
    const reduced = block(':root', tokens.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect([...reduced.keys()]).toEqual(['--m-micro', '--m-enter', '--m-panel', '--m-sheet', '--m-push'])
    expect([...reduced.values()].every(value => parseFloat(value) <= 120)).toBe(true)
  })

  it('paints flat: no gradient anywhere in the tokens, and the page shows the sidebar grey alone', () => {
    expect(tokens).not.toMatch(/gradient\(/u)
    const previous = document.documentElement.dataset.theme
    document.documentElement.dataset.theme = 'light'
    try {
      for (const element of [document.documentElement, document.body]) {
        const style = getComputedStyle(element)
        expect([style.backgroundImage, style.backgroundColor]).toEqual(['none', 'rgb(247, 247, 248)'])
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

  it('keeps secondary words and 等你处理 at 4.5:1 where they rest: the canvas, the raised surface and the sidebar, and 等你处理 on its tint', () => {
    const all = themes()
    for (const name of ['light', 'dark'] as const) {
      const theme = all[name]
      const get = (token: string) => colour(theme.get(token))
      const rests: Array<[string, Rgba]> = [
        ['--canvas', get('--canvas')],
        ['--raised', get('--raised')],
        ['--sidebar', get('--sidebar')],
      ]
      const tint: [string, Rgba] = ['--amber-soft on --raised', over(get('--amber-soft'), get('--raised'))]
      const failing = [
        ...rests.filter(([, fill]) => contrast(get('--muted'), fill) < 4.5).map(([surface]) => `${name} --muted on ${surface}`),
        ...[...rests, tint].filter(([, fill]) => contrast(get('--amber'), fill) < 4.5).map(([surface]) => `${name} --amber on ${surface}`),
      ]
      expect(failing).toEqual([])
    }
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
    const scope = ':where([data-secure], [data-secure] *)'
    const [lockLight, lockPhone] = blocks(scope)
    const [lockSystem] = blocks(`:root:not([data-theme='light']) ${scope}`)
    const [lockChosen] = blocks(`:root[data-theme='dark'] ${scope}`)
    // Layout, motion and the surface under an element stay free; every other token is locked.
    const free =
      /^--(?:sidebar-width|sidebar-open-width|inspector-width|inspector-open-width|content-width|gutter|topbar-height|shell-inset|touch|m-[a-z]+|e-[a-z]+|surface)$/u
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
