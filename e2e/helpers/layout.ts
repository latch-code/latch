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

/** The page never scrolls sideways; with `region`, that element does not either. */
export async function noHorizontalOverflow(page: Page, region?: Locator): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  if (region !== undefined) {
    expect(await region.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  }
}

/**
 * Navigation may be persistent (desktop sidebar, tablet rail) or behind a drawer
 * (phones); tests do not select a breakpoint. Returns the opened settings dialog.
 */
export async function openSettings(page: Page, name: '设置' | '设备'): Promise<Locator> {
  // A closing drawer may remain visually visible while becoming inert. Use
  // navigation semantics rather than the transient visibility of its children.
  const rail = page.getByRole('navigation', { name: '快捷导航', exact: true })
  const navigationButton = page.getByRole('button', { name: '打开会话列表', exact: true })
  let button = page.locator('#session-navigation').getByRole('button', { name, exact: true })
  if (await rail.isVisible()) button = rail.getByRole('button', { name, exact: true })
  else if (await navigationButton.isVisible()) {
    await navigationButton.click()
    const drawer = page.getByRole('dialog', { name: '会话导航', exact: true })
    await drawer.waitFor()
    button = drawer.getByRole('button', { name, exact: true })
  }
  await reachable(button)
  await button.click()
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  await dialog.waitFor()
  return dialog
}

/** Phones push into a section; return to the section list before choosing another. */
export async function openSection(settings: Locator, name: string): Promise<void> {
  const tab = settings.getByRole('tab', { name, exact: true })
  if (!(await tab.isVisible())) await settings.getByRole('button', { name: '返回', exact: true }).click()
  await reachable(tab)
  await tab.click()
}
