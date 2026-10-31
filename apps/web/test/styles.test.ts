import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { themeColorFor } from '../src/preferences.ts'

/**
 * The page's stylesheets, its own and the design system's (@latch/ui/ui.css with the element defaults and the
 * primitives), read the design tokens of @latch/ui and keep to its scales.
 */
const stylesDir = new URL('../src/styles/', import.meta.url)
const files = readdirSync(stylesDir).filter(name => name.endsWith('.css'))
const read = (url: URL | string) => readFileSync(url, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
const resolve = createRequire(import.meta.url).resolve
const tokens = read(resolve('@latch/ui/tokens.css'))
const uiEntry = pathToFileURL(resolve('@latch/ui/ui.css'))
const uiFiles = [...read(uiEntry).matchAll(/@import '\.\/([\w/-]+\.css)'/gu)].map(match => match[1])
const sheets = new Map([
  ...files.map(name => [name, read(new URL(name, stylesDir))] as const),
  ...uiFiles.map(name => [`@latch/ui/${name}`, read(new URL(name, uiEntry))] as const),
])

interface Declaration {
  file: string
  selector: string
  property: string
  value: string
}

/** Every declaration of every innermost block (rules inside @media and @supports included). */
function declarations(): Declaration[] {
  const found: Declaration[] = []
  for (const [file, text] of sheets) {
    for (const rule of text.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      const selector = rule[1].trim().replace(/\s+/gu, ' ')
      for (const part of rule[2].split(';')) {
        const colon = part.indexOf(':')
        if (colon < 0) continue
        found.push({
          file,
          selector,
          property: part.slice(0, colon).trim(),
          // The security layer pins some values with !important; the value is what the scales and tokens govern.
          value: part
            .slice(colon + 1)
            .replace(/\s+/gu, ' ')
            .replace(/\s*!important$/u, '')
            .trim(),
        })
      }
    }
  }
  return found
}

const where = ({ file, selector, property, value }: Declaration) => `${file} ${selector} { ${property}: ${value} }`

/** The first hex value a token takes in `text`. */
const hexOf = (text: string, name: string) => new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'iu').exec(text)?.[1]

/** Masks use black for opacity, and a pairing QR code stays dark on white in both themes so scanners can read it. */
const literalAllowed = (item: Declaration) =>
  item.property.endsWith('mask-image') || (item.selector === '.pair-qr' && item.property === 'background' && item.value === '#ffffff')

describe('page stylesheets', () => {
  it('imports every stylesheet into a cascade layer, with the security surfaces last', () => {
    const index = sheets.get('index.css') ?? ''
    expect(index).toMatch(/^\s*@import '@latch\/ui\/tokens\.css';/u)
    const layered = [...index.matchAll(/@import '\.\/([\w-]+\.css)' layer\((\w+)\);/gu)].map(match => [match[1], match[2]])
    expect(layered.map(([name]) => name).toSorted()).toEqual(files.filter(name => name !== 'index.css').toSorted())
    expect(layered.at(-1)).toEqual(['security.css', 'security'])
    expect(index.replace(/@import [^;]+;/gu, '').trim()).toBe('')
  })

  it('reads only tokens that @latch/ui defines', () => {
    // A primitive may also keep its own geometry in a custom property it declares (--tile-size, --track-width).
    const defined = new Set([tokens, ...sheets.values()].flatMap(text => [...text.matchAll(/(--[\w-]+)\s*:/gu)].map(match => match[1])))
    const missing = [...sheets].flatMap(([file, text]) =>
      [...text.matchAll(/var\((--[\w-]+)/gu)].filter(match => !defined.has(match[1])).map(match => `${file} ${match[1]}`),
    )
    expect(missing).toEqual([])
  })

  it('takes every colour from the tokens', () => {
    const literal = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|lab|lch)\(|\b(?:white|black)\b/iu
    expect(
      declarations()
        .filter(item => literal.test(item.value) && !literalAllowed(item))
        .map(where),
    ).toEqual([])
  })

  it('sets type only through the role tokens, with weights 400, 500 and 600', () => {
    const wrong = declarations().filter(item => {
      if (item.property === 'font-size') return !/^(?:var\(--fs-[\w-]+\)|inherit)$/u.test(item.value)
      if (item.property === 'line-height') return !/^(?:var\(--lh-[\w-]+\)|inherit)$/u.test(item.value)
      if (item.property === 'font') return item.value !== 'inherit'
      if (item.property === 'font-weight') return !/^(?:400|500|600)$/u.test(item.value)
      if (item.property === 'letter-spacing') return !/^(?:var\(--ls-[\w-]+\)|0|inherit)$/u.test(item.value)
      return false
    })
    expect(wrong.map(where)).toEqual([])
  })

  it('keeps padding, margins and gaps off the values between the spacing steps', () => {
    const between = /(?:^|[^\d.])(?:14|18|22|26)px/u
    const wrong = declarations().filter(
      item => /^(?:padding|margin|gap|row-gap|column-gap)/u.test(item.property) && between.test(item.value),
    )
    expect(wrong.map(where)).toEqual([])
  })

  it('uses opacity only to hide, to fade in and out, and for the 45% of a disabled control', () => {
    // A keyframe is a step of a fade, such as the breathing of a skeleton.
    const keyframe = /^(?:from|to|\d+%)$/u
    const wrong = declarations().filter(
      item => item.property === 'opacity' && !keyframe.test(item.selector) && !/^(?:0|1|0\.45)$/u.test(item.value),
    )
    expect(wrong.map(where)).toEqual([])
  })

  it('colours the browser bar with the sidebar grey, the colour of the window, at every width, in both themes', () => {
    const dark = tokens.slice(tokens.indexOf(":root[data-theme='dark']"))
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
    const metas = [...html.matchAll(/<meta name="theme-color" content="([^"]+)" media="([^"]+)" \/>/gu)]
    expect(metas.map(match => [match[2], match[1]])).toEqual([
      ['(prefers-color-scheme: light)', hexOf(tokens, '--sidebar')],
      ['(prefers-color-scheme: dark)', hexOf(dark, '--sidebar')],
    ])
    // A chosen theme overrides the scheme of each media query.
    for (const [, content, media] of metas) {
      expect(themeColorFor(media, 'system')).toBe(content)
      const scheme = media.includes('dark') ? 'dark' : 'light'
      const other = scheme === 'dark' ? 'light' : 'dark'
      expect(themeColorFor(media, scheme)).toBe(content)
      expect(themeColorFor(media, other)).toBe(metas.find(item => item[2] === media.replace(scheme, other))?.[1])
    }
  })

  it('draws the keyboard ring outside every control filled in the accent, where it shows', () => {
    const all = declarations()
    const filled = all.filter(
      item =>
        (/^background(-color)?$/u.test(item.property) && /^var\(--accent(-hover)?\)$/u.test(item.value))
        || (item.property === 'box-shadow' && /^inset 0 0 0 \d+px var\(--accent\)$/u.test(item.value) && item.selector.includes('radio'))
        || item.property === 'accent-color',
    )
    const firstClass = (selector: string) => /\.(?!ui-input)[\w-]+/u.exec(selector.replace(/\[data-secure\]\s*/u, ''))?.[0]
    const ringed = all.filter(
      item => item.selector.includes(':focus-visible') && item.property === 'outline-offset' && item.value === '2px',
    )
    const missing = filled.filter(item => {
      const name = firstClass(item.selector)
      return !name || !ringed.some(ring => ring.selector.includes(name))
    })
    expect(filled.length).toBeGreaterThan(5)
    expect(missing.map(where)).toEqual([])
  })

  it('runs every loop only under no-preference, so reduced motion stands still', () => {
    const outsideNoPreference = (text: string) => {
      let rest = text
      for (;;) {
        const start = rest.indexOf('@media (prefers-reduced-motion: no-preference)')
        if (start < 0) return rest
        let depth = 0
        let end = rest.indexOf('{', start)
        do {
          if (rest[end] === '{') depth++
          else if (rest[end] === '}') depth--
          end++
        } while (depth > 0)
        rest = rest.slice(0, start) + rest.slice(end)
      }
    }
    const loops = [...sheets].filter(([, text]) => /\binfinite\b/u.test(outsideNoPreference(text))).map(([name]) => name)
    expect(loops).toEqual([])
  })

  it('fades hover and press fills over --m-micro both ways: no rule snaps them on', () => {
    expect(
      declarations()
        .filter(item => item.property === 'transition-duration' && /^0s/u.test(item.value))
        .map(where),
    ).toEqual([])
  })

  it('balances headings and keeps the sticky search row of a menu opaque, so rows do not show through', () => {
    const all = declarations()
    expect(all.some(item => item.selector.includes('h1') && item.property === 'text-wrap' && item.value === 'balance')).toBe(true)
    expect(all.find(item => item.selector === '.ui-menu-search' && item.property === 'background')?.value).toBe('var(--raised)')
  })

  it('rounds corners only on the radius scale, without a corner shape', () => {
    // The scale (4, 6, 8, 12, 16, full and 2 for bars), circles, and what follows from it: a tile's size × 0.225, a
    // nested radius, a primitive's own radius property and the app icon's ring, which follows its own artwork's corner.
    const allowed = (value: string) => {
      // A value per corner, each a step of the scale or 0, or one value that follows from the scale.
      const steps = value.replace(/var\(--r-(?:2|4|6|8|12|16|full)\)/gu, 'R')
      return (
        /^(?:(?:R|0)(?: |$))+$/u.test(steps)
        || /^(?:inherit|50%|20%|var\(--[\w-]+-radius\)|round\(calc\(.*\* 0\.225\), 1px\)|calc\(.*\))$/u.test(value)
      )
    }
    const wrong = declarations().filter(
      item => (/^border(?:-[a-z]+)*-radius$/u.test(item.property) && !allowed(item.value)) || item.property === 'corner-shape',
    )
    expect(wrong.map(where)).toEqual([])
  })
})
