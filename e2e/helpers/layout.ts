import type { Locator, Page } from '@playwright/test'
import { expect } from 'vitest'

/** Checks the actual visible hit target inside the viewport, allowing normal vertical scrolling. */
export async function reachable(locator: Locator, options: { allowDisabled?: boolean } = {}): Promise<void> {
  await locator.waitFor({ state: 'visible' })
  await locator.scrollIntoViewIfNeeded()
  const disabled = await locator.isDisabled()
  if (!options.allowDisabled) expect(disabled).toBe(false)
  if (!disabled) await locator.click({ trial: true })
  const geometry = await locator.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      hit: hit !== null && element.contains(hit),
    }
  })
  expect(geometry.width).toBeGreaterThan(0)
  expect(geometry.height).toBeGreaterThan(0)
  expect(geometry.left).toBeGreaterThanOrEqual(-1)
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1)
  expect(geometry.top).toBeGreaterThanOrEqual(-1)
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight + 1)
  if (!disabled) expect(geometry.hit).toBe(true)
}

/**
 * Every layer open on the page (a menu, a picker, a popover, the panel one turns into) lies inside the window, 8px from
 * its edges, and its last control can be reached: scrolled into view within the layer, it is what a press there hits.
 * The layer's own scroll position is put back afterwards.
 */
export async function layersInWindow(page: Page): Promise<void> {
  const layers = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('.ui-popover:popover-open')).map(layer => {
      const box = layer.getBoundingClientRect()
      const controls = Array.from(
        layer.querySelectorAll<HTMLElement>(
          'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [role^="menuitem"]',
        ),
      ).filter(control => control.getClientRects().length > 0)
      const last = controls.at(-1)
      let reached = true
      if (last) {
        const scrolled = layer.scrollTop
        last.scrollIntoView({ block: 'nearest' })
        const rect = last.getBoundingClientRect()
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        reached = hit !== null && last.contains(hit)
        layer.scrollTop = scrolled
      }
      const inside = box.top >= 7 && box.left >= 7 && box.bottom <= innerHeight - 7 && box.right <= innerWidth - 7
      return { layer: layer.getAttribute('aria-label') ?? layer.textContent?.slice(0, 24) ?? '', inside, reached }
    }),
  )
  for (const layer of layers) expect(layer).toEqual({ layer: layer.layer, inside: true, reached: true })
}

/** The page never scrolls sideways; with `region`, that element does not either. */
export async function noHorizontalOverflow(page: Page, region?: Locator): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  if (region !== undefined) {
    expect(await region.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  }
}

/**
 * Back to a phone's session list when a session's page is pushed over it; elsewhere, and on the list, nothing happens.
 */
export async function backToPhoneSessions(page: Page): Promise<void> {
  if ((await page.locator('.phone-list').count()) === 0) return
  const back = page.locator('.topbar').getByRole('button', { name: '返回会话列表', exact: true })
  if (await back.isVisible()) {
    await back.click()
    await page.locator('main.workspace').waitFor({ state: 'detached' })
  }
  await page.locator('.phone-list:not([data-covered])').waitFor()
  // The list has slid back into place.
  await page.locator('.phone-list').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)))
}

/**
 * Navigation may be persistent (desktop sidebar, tablet rail), behind a drawer, or a phone's root page (the session
 * list, reached back from an open session); tests do not select a breakpoint. Returns the opened settings page (a
 * modal page named 设置), on its 设备 section when `section` is 设备 (devices are reached through settings).
 */
export async function openSettings(page: Page, section: '设置' | '设备' = '设置'): Promise<Locator> {
  // A closing drawer may remain visually visible while becoming inert. Use
  // navigation semantics rather than the transient visibility of its children.
  const rail = page.getByRole('navigation', { name: '快捷导航', exact: true })
  const navigationButton = page.getByRole('button', { name: '打开会话列表', exact: true })
  let button = page.locator('#session-navigation').getByRole('button', { name: '设置', exact: true })
  if ((await page.locator('.phone-list').count()) > 0) await backToPhoneSessions(page)
  else if (await rail.isVisible()) button = rail.getByRole('button', { name: '设置', exact: true })
  else if (await navigationButton.isVisible()) {
    await navigationButton.click()
    const drawer = page.getByRole('dialog', { name: '会话导航', exact: true })
    await drawer.waitFor()
    button = drawer.getByRole('button', { name: '设置', exact: true })
  }
  await reachable(button)
  await button.click()
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  await dialog.waitFor()
  if (section === '设备') await openSection(dialog, '设备')
  return dialog
}

/**
 * Phones push a section over the section list and each page inside a section over the section: goes back, one level at
 * a time with each level's own back button, until the section list shows.
 */
async function backToSections(settings: Locator): Promise<void> {
  const layout = settings.locator('.settings-layout')
  await backToSection(settings)
  if ((await layout.getAttribute('data-level')) === 'section') await settings.getByRole('button', { name: '返回', exact: true }).click()
}

/**
 * Leaves the pages open inside a section for the section itself: on a phone with each page's own back button, elsewhere
 * with the way back above the page.
 */
export async function backToSection(settings: Locator): Promise<void> {
  const layout = settings.locator('.settings-layout')
  const open = settings.locator('.settings-level:not([data-state="leaving"])')
  while ((await layout.getAttribute('data-level')) === 'page') {
    const before = await open.count()
    await settings.locator('.settings-level[data-state="top"] .settings-bar').getByRole('button').first().click()
    await expect.poll(() => open.count()).toBeLessThan(before)
  }
  const back = settings.locator('.settings-back')
  while ((await back.count()) > 0) {
    const label = await back.textContent()
    await back.click()
    await expect.poll(async () => (await back.count()) === 0 || (await back.textContent()) !== label).toBe(true)
  }
}

/** Opens a section; on a phone, from the section list. */
export async function openSection(settings: Locator, name: string): Promise<void> {
  const tab = settings.getByRole('tab', { name, exact: true })
  await backToSections(settings)
  await reachable(tab)
  await tab.click()
}

/**
 * Leaves settings for the conversation through 「返回会话」 (its name also says how many approvals wait there), which
 * a phone shows on the section list. The page fades out before it goes.
 */
export async function closeSettings(settings: Locator): Promise<void> {
  await backToSections(settings)
  const button = settings.getByRole('button', { name: /^返回会话/ })
  await reachable(button)
  await button.click()
  await settings.waitFor({ state: 'detached' })
}
