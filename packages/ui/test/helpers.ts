import type { CDPSession } from '@vitest/browser-playwright'
import { cdp, server, type Locator } from 'vitest/browser'

/** The DevTools protocol of the test's page, typed by the Playwright provider. */
const protocol = (): CDPSession => cdp()

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

/**
 * Emulates a touch screen, which makes `(pointer: coarse)` match, for the duration of `run`. Only in the
 * `@latch/ui-touch` browser: turning the emulation off leaves a headless Chrome without a pointer on Linux, and every
 * later hover in that browser would fail (TOUCH_FILES in vitest.config.ts).
 */
export async function onTouchScreen(run: () => Promise<void>): Promise<void> {
  if (server.config.name !== '@latch/ui-touch')
    throw new Error(`onTouchScreen runs only in the @latch/ui-touch browser; list this file in TOUCH_FILES (${server.config.name})`)
  await protocol().send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  try {
    await run()
  } finally {
    await protocol().send('Emulation.setTouchEmulationEnabled', { enabled: false })
  }
}

/**
 * The media the page is emulated with between checks: the colour scheme of the Playwright context in vitest.config.ts,
 * and Playwright's defaults for the rest. A DevTools call replaces every emulated feature, and a feature it leaves out
 * falls back to the system's preference, so each call names them all.
 */
const CONTEXT_MEDIA = {
  'prefers-color-scheme': 'light',
  'prefers-reduced-motion': 'no-preference',
  'forced-colors': 'none',
  'prefers-contrast': 'no-preference',
}

type MediaFeatures = { 'prefers-color-scheme'?: 'light' | 'dark'; 'prefers-reduced-motion'?: 'reduce' | 'no-preference' }

async function setMedia(features: Record<string, string>): Promise<void> {
  await protocol().send('Emulation.setEmulatedMedia', {
    features: Object.entries(features).map(([name, value]) => ({ name, value })),
  })
}

/** Emulates media features for the duration of `run`, keeping the others, then returns to the context's media. */
export async function emulateMedia(features: MediaFeatures, run: () => unknown): Promise<void> {
  await setMedia({ ...CONTEXT_MEDIA, ...features })
  try {
    await run()
  } finally {
    await setMedia(CONTEXT_MEDIA)
  }
}
