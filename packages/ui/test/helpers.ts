import type { CDPSession } from '@vitest/browser-playwright'
import { cdp, type Locator } from 'vitest/browser'

/** The DevTools protocol of the test's page, typed by the Playwright provider. */
export const protocol = (): CDPSession => cdp()

/** The located HTML element (a locator may also find SVG). */
function html(locator: Locator): HTMLElement {
  const element = locator.element()
  if (!(element instanceof HTMLElement)) throw new Error('Expected an HTML element')
  return element
}

/**
 * Clicks through the DOM, as a script or an assistive technology can, without the pointer's checks: a control that is
 * aria-disabled stays clickable this way, and must ignore it itself.
 */
export function press(locator: Locator): void {
  html(locator).click()
}

/** Emulates a touch screen, which makes `(pointer: coarse)` match, for the duration of `run`. */
export async function onTouchScreen(run: () => Promise<void>): Promise<void> {
  await protocol().send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  try {
    await run()
  } finally {
    await protocol().send('Emulation.setTouchEmulationEnabled', { enabled: false })
  }
}
