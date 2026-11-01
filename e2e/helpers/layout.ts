import type { Locator, Page } from '@playwright/test'
import { expect } from 'vitest'

/** Child-frame coordinates do not reflect the parent shell's changing grid tracks during a transition. */
export async function settleShell(page: Page): Promise<void> {
  await page.locator('.app-shell').evaluate(async element => {
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))
    await Promise.allSettled(element.getAnimations().map(animation => animation.finished))
  })
}

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
  await page.locator('.phone-list:not([data-covered])').waitFor({ state: 'attached' })
  // The list has slid back into place.
  await page.locator('.phone-list').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)))
}

/** The rail, or a phone's tab bar. */
const mainNavigation = (page: Page) => page.getByRole('navigation', { name: '主导航', exact: true })

/**
 * Opens an entry of the rail, or the tab of a phone (from its session list when a session's page is pushed over it).
 * Tests do not select a breakpoint.
 */
export async function openEntry(page: Page, name: string): Promise<void> {
  await settleShell(page)
  await backToPhoneSessions(page)
  const button = mainNavigation(page).getByRole('button', { name, exact: true })
  await reachable(button)
  await button.click()
}

/** Back to the session list or conversation through the rail or the tab bar. */
export async function openSessions(page: Page): Promise<void> {
  await mainNavigation(page).getByRole('button', { name: '会话', exact: true }).click()
  await page.locator('.settings-page').waitFor({ state: 'detached' })
}

/** Opens 个人助手, a section of the Agent entry. */
export async function openPersonal(page: Page): Promise<Locator> {
  await openEntry(page, 'Agent')
  await page.locator('.settings-page').getByRole('tab', { name: '个人助手', exact: true }).click()
  const personal = page.getByRole('region', { name: '个人助手', exact: true })
  await personal.waitFor()
  return personal
}

/**
 * Returns the opened page of the 设置 entry, on the devices section when `section` is 设备 (the 手机 entry; on a phone,
 * inside 设置).
 */
export async function openSettings(page: Page, section: '设置' | '设备' = '设置'): Promise<Locator> {
  await openEntry(page, '设置')
  const settings = page.locator('.settings-page')
  await settings.waitFor()
  if (section === '设备') await openSection(settings, '设备')
  return settings
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

/** Where a section lives when it is not on the page shown: the rail's entry on wide windows, the tab on a phone. */
const SECTION_ENTRIES: Record<string, { wide: string; phone: string }> = {
  插件: { wide: '插件', phone: '设置' },
  设备: { wide: '手机', phone: '设置' },
  个人助手: { wide: 'Agent', phone: 'Agent' },
  例行任务: { wide: '自动化', phone: 'Agent' },
}

/** Opens a section, through its entry when another entry's page is showing; on a phone, from the section list. */
export async function openSection(settings: Locator, name: string): Promise<void> {
  const page = settings.page()
  const tab = settings.getByRole('tab', { name, exact: true })
  // A phone's 个人助手 page lies over the section list.
  const personalBack = page.locator('.personal-page .personal-bar').getByRole('button').first()
  if ((await page.locator('.phone-tabs').count()) > 0)
    while (await personalBack.isVisible()) {
      await personalBack.click()
      await page.waitForTimeout(50)
    }
  await backToSections(settings)
  if ((await tab.count()) === 0) {
    const entry = SECTION_ENTRIES[name] ?? { wide: '设置', phone: '设置' }
    const phone = (await page.locator('.phone-tabs').count()) > 0
    await mainNavigation(page)
      .getByRole('button', { name: phone ? entry.phone : entry.wide, exact: true })
      .click()
    // 插件 lists its plugins beside the rail on wide windows, in place of a section list.
    if (name === '插件' && !phone) return
    await tab.waitFor()
  }
  await reachable(tab)
  await tab.click()
}

/** Leaves a page entry for the conversation through 会话 in the rail or the tab bar. */
export async function closeSettings(settings: Locator): Promise<void> {
  await backToSections(settings)
  await openSessions(settings.page())
}

/** 只聊天 on a new session: a row of the sheet on phones, in the input's 「⋯」 elsewhere. */
export async function setChatOnly(page: Page, value: boolean): Promise<void> {
  const name = '只聊天，不读写文件'
  const sheet = page.locator('.new-session-sheet')
  if (await sheet.isVisible()) {
    await sheet.getByRole('switch', { name, exact: true }).setChecked(value)
    return
  }
  await page.locator('.composer-more').getByRole('button', { name: '更多选项', exact: true }).click()
  await page.getByRole('switch', { name, exact: true }).setChecked(value)
  await page.keyboard.press('Escape')
}

/** The selected file tab goes the way a keyboard closes it: its × only shows under the pointer. */
export async function closeActiveFile(page: Page): Promise<void> {
  const tab = page.getByRole('tablist', { name: '会话面板', exact: true }).getByRole('tab', { selected: true })
  await tab.focus()
  await page.keyboard.press('Delete')
}

/** The text renderer's find row, which stays out of the way until asked for. */
export async function openFileFind(page: Page): Promise<void> {
  await page.getByRole('region', { name: '文件预览', exact: true }).getByRole('button', { name: '文件操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '查找', exact: true }).click()
  await page.getByRole('searchbox', { name: '查找文件内容' }).waitFor()
}
