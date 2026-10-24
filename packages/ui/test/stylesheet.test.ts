import { describe, expect, it } from 'vitest'
import entry from '../src/ui.css?raw'

/** The primitives' stylesheets in src/styles, by file name. */
const primitives = Object.keys(import.meta.glob('../src/styles/*.css')).map(path => path.slice(path.lastIndexOf('/') + 1))

/** Every rule of the page's stylesheets with the names of the cascade layers it sits in, outermost first. */
function rules(): Array<{ selector: string; layers: string[] }> {
  const found: Array<{ selector: string; layers: string[] }> = []
  const walk = (list: CSSRuleList, layers: string[]) => {
    for (const rule of Array.from(list)) {
      if (rule instanceof CSSStyleRule) found.push({ selector: rule.selectorText, layers })
      if (rule instanceof CSSLayerBlockRule) walk(rule.cssRules, [...layers, rule.name])
      else if (rule instanceof CSSGroupingRule) walk(rule.cssRules, layers)
    }
  }
  for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules, [])
  return found
}

describe('design system stylesheet', () => {
  it('imports the element defaults into base and every primitive stylesheet into ui', () => {
    const imports = [...entry.matchAll(/@import '\.\/([\w/-]+\.css)' layer\((\w+)\);/gu)].map(match => [match[1], match[2]])
    expect(imports[0]).toEqual(['base.css', 'base'])
    expect(
      imports
        .slice(1)
        .map(([file]) => file?.replace('styles/', ''))
        .toSorted(),
    ).toEqual(primitives.toSorted())
    expect(imports.slice(1).every(([, layer]) => layer === 'ui')).toBe(true)
    expect(
      entry
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/@import [^;]+;/gu, '')
        .trim(),
    ).toBe('')
  })

  it('puts every primitive rule in the ui layer of the page, under the app and security layers', () => {
    const own = rules().filter(rule => /\.ui-/u.test(rule.selector))
    expect(own.length).toBeGreaterThan(100)
    // The element defaults may name a primitive too: reduced motion keeps the spinners turning, the spinner itself and
    // the arc of a tile's indeterminate progress ring.
    expect(own.filter(rule => !['ui', 'base'].includes(rule.layers.join('.'))).map(rule => rule.selector)).toEqual([])
    expect(own.filter(rule => rule.layers.join('.') === 'base').map(rule => rule.selector)).toEqual([
      '.ui-spinner',
      '.ui-tile-progress:not([data-determinate]) .ui-tile-progress-arc',
    ])
    // The order of the layers is the first statement of the tokens: a later layer wins whatever its specificity.
    const order = Array.from(document.styleSheets)
      .flatMap(sheet => Array.from(sheet.cssRules))
      .find(rule => rule instanceof CSSLayerStatementRule)
    expect(order instanceof CSSLayerStatementRule ? order.nameList : []).toEqual(['tokens', 'base', 'ui', 'app', 'security'])
  })
})
