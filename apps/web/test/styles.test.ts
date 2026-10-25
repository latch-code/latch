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
    const between = /(?:^|[^\d.])(?:10|14|18|22|26)px/u
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

  it('colours the browser bar with the ground from 768px and with the pane on phones, in both themes', () => {
    const dark = tokens.slice(tokens.indexOf(":root[data-theme='dark']"))
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
    const metas = [...html.matchAll(/<meta name="theme-color" content="([^"]+)" media="([^"]+)" \/>/gu)]
    expect(metas.map(match => [match[2], match[1]])).toEqual([
      ['(max-width: 767.98px) and (prefers-color-scheme: light)', hexOf(tokens, '--bg-pane')],
      ['(max-width: 767.98px) and (prefers-color-scheme: dark)', hexOf(dark, '--bg-pane')],
      ['(min-width: 768px) and (prefers-color-scheme: light)', hexOf(tokens, '--bg-app')],
      ['(min-width: 768px) and (prefers-color-scheme: dark)', hexOf(dark, '--bg-app')],
    ])
    // A chosen theme overrides the scheme in each media query; the width still picks ground or pane.
    for (const [, content, media] of metas) {
      expect(themeColorFor(media, 'system')).toBe(content)
      const scheme = media.includes('dark') ? 'dark' : 'light'
      const other = scheme === 'dark' ? 'light' : 'dark'
      expect(themeColorFor(media, scheme)).toBe(content)
      expect(themeColorFor(media, other)).toBe(metas.find(item => item[2] === media.replace(scheme, other))?.[1])
    }
  })

  it('gives rounded rectangles the corner shape and keeps pills and circles round', () => {
    const rules = new Map<string, Declaration[]>()
    for (const item of declarations())
      rules.set(`${item.file} ${item.selector}`, [...(rules.get(`${item.file} ${item.selector}`) ?? []), item])
    const wrong: string[] = []
    for (const [rule, items] of rules) {
      const radii = items.filter(item => /^border(?:-[a-z]+)*-radius$/u.test(item.property)).map(item => item.value)
      const shaped = items.some(item => item.property === 'corner-shape')
      if (radii.length === 0) continue
      const round = radii.some(value => /--r-pill|50%/u.test(value))
      // 4px bars (radius 2) are pills in effect; the app icon's ring follows its own artwork's corner.
      const rectangle = radii.some(value => !/^(?:0|inherit|var\(--r-2\)|20%|var\(--r-pill\)|50%)$/u.test(value))
      if (round && shaped) wrong.push(`${rule}: a pill or circle with a corner shape`)
      if (rectangle && !round && !shaped) wrong.push(`${rule}: a rounded rectangle without the corner shape`)
    }
    expect(wrong).toEqual([])
  })
})
