import { expect } from 'vitest'
import type { Page } from '@playwright/test'

/**
 * Styles a page could pick up after its own: overrides of the shared tokens (on the root, on every element and on the
 * security surfaces themselves) and generic selectors that hide, recolour, shrink, blur or clip, both outside the
 * page's cascade layers (important or not) and as normal rules inside its own layers.
 */
const INJECTED_STYLES = `
:root, body, *, [data-secure], [data-secure] * {
  --accent: rgb(0, 160, 0) !important; --on-accent: rgb(0, 0, 0) !important; --accent-hover: rgb(0, 160, 0) !important;
  --accent-ink: rgb(0, 160, 0) !important; --amber-icon: transparent !important; --red-solid: rgb(0, 160, 0) !important;
  --green: rgb(255, 0, 0) !important; --diff-add: rgb(255, 0, 0) !important; --diff-del: rgb(0, 160, 0) !important;
  --press: rgb(0, 160, 0) !important; --sh-accent: none !important; --sh-1: none !important;
  --fs-code: 1px !important; --fs-input: 1px !important; --fs-mono: 1px !important; --fs-meta: 1px !important;
  --lh-caption: 1px !important; --lh-caption-para: 1px !important; --lh-code: 1px !important; --lh-heading: 1px !important;
  --lh-input: 1px !important; --lh-meta: 1px !important; --lh-mono: 1px !important; --lh-ui-para: 1px !important;
  --red-soft: transparent !important; --red-line: transparent !important; --red: rgb(68, 68, 66) !important;
  --amber-soft: transparent !important; --amber-line: transparent !important; --amber: rgb(68, 68, 66) !important;
  --ink: transparent !important; --ink-2: transparent !important; --muted: transparent !important;
  --canvas: rgb(255, 0, 0) !important; --raised: rgb(255, 0, 0) !important; --sunken: rgb(255, 0, 0) !important;
  --hover: rgb(0, 160, 0) !important; --line: transparent !important; --line-strong: transparent !important;
  --card: rgb(255, 0, 0) !important; --pop: rgb(255, 0, 0) !important; --key: rgb(255, 0, 0) !important;
  --sh-key: none !important; --sh-lift: none !important; --sh-panel: none !important; --sh-well: none !important;
  --joint: rgb(255, 0, 0) !important; --tag: rgb(255, 0, 0) !important;
  --fs-ui: 1px !important; --fs-caption: 1px !important; --fs-heading: 1px !important; --fs-prose: 1px !important;
  --fs-title: 1px !important; --fs-hero: 1px !important; --fs-mono-display: 1px !important; --lh-ui: 1px !important;
  --mono: serif !important; --font: cursive !important;
}
* {
  visibility: hidden !important; color: transparent !important; font-size: 1px !important; line-height: 1px !important;
  background-image: none !important; box-shadow: none !important;
}
svg, .ui-spinner { color: rgb(0, 160, 0) !important }
p, span, div, code, strong, pre, dt, dd, time, label, legend, h1, h2, h3, h4, section, article, dialog, main, button, input {
  display: none !important; opacity: 0 !important; filter: blur(8px) !important; transform: scale(0) !important;
  scale: 0 !important; clip-path: inset(50%) !important; text-indent: -9999px !important;
}
[class], [data-secure] { filter: opacity(0) !important; clip-path: inset(50%) !important; mix-blend-mode: difference !important }
.ui-button, .ui-status-word, .ui-notice { background: rgb(0, 160, 0) !important; display: none !important }
@layer app { button, p { display: none; color: rgb(255, 0, 0) } }
@layer security { * { color: rgb(255, 0, 0); background: rgb(255, 0, 0) } }
`

const PROPERTIES = [
  'display',
  'visibility',
  'opacity',
  'color',
  'background-color',
  'background-image',
  'box-shadow',
  'border-top-color',
  'font-size',
  'line-height',
  'font-family',
  'filter',
  'transform',
  'scale',
  'clip-path',
  'text-indent',
] as const

/** The computed look of every element `selector` matches, in document order. */
async function look(page: Page, selector: string): Promise<Array<Record<string, string>>> {
  return page.locator(selector).evaluateAll(
    (elements, properties) =>
      elements.map(element => {
        const style = getComputedStyle(element)
        return Object.fromEntries(properties.map(name => [name, style.getPropertyValue(name)]))
      }),
    [...PROPERTIES],
  )
}

/**
 * Adds INJECTED_STYLES to the page and checks that every element of `selectors` (each must match at least one) keeps
 * its computed display, visibility, opacity, colours, tints, rings, type, filter, transform and clipping; then removes them.
 */
export async function expectUnmovedByInjectedStyles(page: Page, selectors: readonly string[]): Promise<void> {
  // Injected styles can move the layout: keep the pointer away so the comparison does not also change hover.
  await page.mouse.move(0, 0)
  // Colours fade between states (a theme switch, a hover); compare the settled values, not a frame of a transition.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(animation => animation instanceof CSSTransition)
        .map(animation => animation.finished.catch(() => undefined)),
    ),
  )
  const before = new Map<string, Array<Record<string, string>>>()
  for (const selector of selectors) {
    const found = await look(page, selector)
    expect(found.length, selector).toBeGreaterThan(0)
    before.set(selector, found)
  }
  await page.evaluate(css => {
    const style = document.createElement('style')
    style.id = 'injected-overrides'
    style.textContent = css
    document.head.append(style)
  }, INJECTED_STYLES)
  try {
    // The injection does reach the rest of the page.
    expect(await page.evaluate(() => getComputedStyle(document.body).visibility)).toBe('hidden')
    for (const selector of selectors) expect(await look(page, selector), selector).toEqual(before.get(selector))
  } finally {
    await page.evaluate(() => document.getElementById('injected-overrides')?.remove())
  }
}
