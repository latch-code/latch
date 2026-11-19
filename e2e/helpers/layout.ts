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

/** Goes back to a phone's session list, Code's root page, from a session or the start screen pushed over it. */
export async function backToPhoneSessions(page: Page): Promise<void> {
  if ((await page.locator('.phone-tabs').count()) === 0) return
  if ((await page.locator('.app-shell').getAttribute('data-entry')) !== 'sessions') return
  const back = page
    .locator('.topbar, .workbench-phone-heading')
    .getByRole('button', { name: '返回会话列表', exact: true })
    .filter({ visible: true })
  if ((await back.count()) > 0) await back.click()
  await page.locator('.phone-list:not([inert])').waitFor()
  await settleShell(page)
}

/** A phone opens on its session list; its 新建会话 pushes the start screen, where the new session's input is. Elsewhere a no-op. */
export async function phoneStartScreen(page: Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 1024) >= 768) return
  await page.locator('.phone-list:not([inert])').getByRole('button', { name: '新建会话', exact: true }).first().click()
  await page.locator('.workbench-home').getByRole('textbox', { name: '新会话消息', exact: true }).waitFor()
}

/** Opens an exact Host session through the visible history, project tree or tablet drawer. */
export async function openSession(page: Page, sessionId: string): Promise<void> {
  if ((await page.locator('.phone-tabs').count()) > 0) {
    if ((await page.locator('.app-shell').getAttribute('data-entry')) !== 'sessions')
      await page.locator('.phone-tabs').getByRole('button', { name: 'Code', exact: true }).click()
    await backToPhoneSessions(page)
    await page.locator('.phone-list:not([inert])').locator(`[data-task-id="${sessionId}"]`).click()
  } else {
    const row = page.locator(`[data-task-id="${sessionId}"]`).filter({ visible: true })
    if ((await row.count()) === 0) {
      const drawer = page.getByRole('button', { name: '打开会话列表', exact: true })
      const shut = page.getByRole('button', { name: '展开侧栏', exact: true })
      if (await drawer.isVisible()) {
        await drawer.click()
        await page.getByRole('dialog', { name: '会话导航', exact: true }).waitFor()
      } else if (await shut.isVisible()) await shut.click()
      await settleShell(page)
    }
    await row.click()
  }
  await page.locator('main.workspace:not([inert]) .transcript-content').waitFor()
  await settleShell(page)
}

/** The sidebar's foot, or a phone's tab bar. */
const mainNavigation = (page: Page) => page.getByRole('navigation', { name: '主导航', exact: true })
// Persistent desktop / tablet chrome precedes the drawer in DOM order; a closing drawer can still be painted for a frame.
const entryButton = (page: Page, name: string) =>
  page
    .locator('.titlebar, .workbench-tablet-rail, .workbench-phone-heading')
    .getByRole('button', { name, exact: true })
    .or(mainNavigation(page).getByRole('button', { name, exact: true }))
    .filter({ visible: true })
    .first()

const isPhone = async (page: Page) => (await page.locator('.phone-tabs').count()) > 0
const settingsPage = (page: Page) => page.locator('.settings-overlay .settings-page')

/** The foot stands in the sidebar: away from a page, and on a tablet inside its drawer. */
async function footInReach(page: Page): Promise<void> {
  const drawer = page.getByRole('button', { name: '打开会话列表', exact: true })
  if (await drawer.isVisible()) await drawer.click()
  const shut = page.getByRole('button', { name: '展开侧栏', exact: true })
  if (await shut.isVisible()) await shut.click()
  await settleShell(page)
}

/**
 * Opens 设置 from the sidebar's foot, or a section of it by its name; on a phone, the tab (from its session list when a
 * session's page is pushed over it). Tests do not select a breakpoint.
 */
export async function openEntry(page: Page, name: string): Promise<void> {
  if (name !== '设置') {
    await openEntry(page, '设置')
    await openSection(settingsPage(page), name)
    return
  }
  if (await settingsPage(page).isVisible()) return
  await settleShell(page)
  if (!(await entryButton(page, name).isVisible())) {
    if (await isPhone(page)) await backToPhoneSessions(page)
    else await footInReach(page)
  }
  const button = entryButton(page, name)
  await reachable(button)
  await button.click()
}

/** Back to the workbench from the settings panel. */
export async function openSessions(page: Page): Promise<void> {
  await closeSettings(settingsPage(page))
}

/** Returns the opened 设置 page, on its 设备 section when `section` names it. */
export async function openSettings(page: Page, section: '设置' | '设备' = '设置'): Promise<Locator> {
  await openEntry(page, '设置')
  const settings = settingsPage(page)
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

/** Opens a section of 设置, opening the page first when it is not showing; on a phone, from the section list. */
export async function openSection(settings: Locator, name: string): Promise<void> {
  const tab = settings.getByRole('tab', { name, exact: true })
  await backToSections(settings)
  if ((await tab.count()) === 0) {
    await openEntry(settings.page(), '设置')
    await tab.waitFor()
  }
  await reachable(tab)
  await tab.click()
}

/** Closes the whole panel from any settings level. */
export async function closeSettings(settings: Locator): Promise<void> {
  const panel = settings.and(settingsPage(settings.page()))
  await panel.getByTestId('close-settings').click()
  await panel.waitFor({ state: 'detached' })
}

/** A tab of the session panel: selected where it stands, else opened from the empty panel's choices or the strip's 「+」. */
export async function openPanelTab(page: Page, name: string): Promise<void> {
  const tab = page
    .getByRole('tablist', { name: '会话面板', exact: true })
    .getByRole('tab', { name: new RegExp(`^${name}`, 'u') })
    .filter({ visible: true })
  if (await tab.count()) {
    await tab.first().click()
    return
  }
  // A tab the strip has no room for is in its 「其余 N 个标签」 menu.
  const more = page
    .getByRole('tablist', { name: '会话面板', exact: true })
    .locator('xpath=..')
    .getByRole('button', { name: /^其余 \d+ 个标签$/u })
  if (await more.filter({ visible: true }).count()) {
    await more.filter({ visible: true }).first().click()
    const item = page.getByRole('menuitem', { name: new RegExp(`^${name}`, 'u') })
    if (await item.count()) {
      await item.first().click()
      return
    }
    await page.keyboard.press('Escape')
  }
  const choice = page.locator('.panel-empty-choice', { hasText: name }).filter({ visible: true })
  if (await choice.count()) {
    await choice.first().click()
    return
  }
  await page.getByRole('button', { name: '打开面板', exact: true }).filter({ visible: true }).first().click()
  await page.getByRole('menuitem', { name, exact: true }).click()
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

/**
 * Opens the tooltip that explains `trigger` the way its device would (a hover with a pointer, a press and hold by touch,
 * which has no hover) and leaves it open for a check or a screenshot; `close` puts it away again.
 */
export async function showTooltip(page: Page, trigger: Locator, touch = false): Promise<{ tip: Locator; close: () => Promise<void> }> {
  await trigger.scrollIntoViewIfNeeded()
  const tip = page.locator('.ui-tooltip:popover-open')
  if (touch) {
    const box = (await trigger.boundingBox())!
    const at = { pointerType: 'touch', isPrimary: true, bubbles: true, clientX: box.x + 4, clientY: box.y + box.height / 2 }
    await trigger.dispatchEvent('pointerdown', at)
    await tip.waitFor()
    await trigger.dispatchEvent('pointerup', at)
    await trigger.dispatchEvent('pointerleave', at)
  } else await trigger.hover()
  await tip.waitFor()
  return {
    tip,
    close: async () => {
      if (touch) await page.locator('body').dispatchEvent('pointerdown', { pointerType: 'touch', bubbles: true })
      else await page.mouse.move(0, 0)
      await tip.waitFor({ state: 'hidden' })
    },
  }
}

/** The tooltip's text, read as {@link showTooltip} opens it; it closes again before this returns. */
export async function tooltipText(page: Page, trigger: Locator, touch = false): Promise<string> {
  const { tip, close } = await showTooltip(page, trigger, touch)
  const text = (await tip.textContent()) ?? ''
  await close()
  return text
}

/**
 * The input's one entry in `scope`: the model, its thinking and the permission on one trigger, at the end of the input's
 * line. Its panel sets all three.
 */
export function composerEntry(scope: Page | Locator): Locator {
  return scope.locator('[data-composer-control="model"] button.entry-picker').filter({ visible: true }).first()
}

/** What the entry says of the permission, 「权限：先问你」, as its description (the hover) reads it to a screen reader. */
export async function entryPermission(scope: Page | Locator): Promise<string> {
  return composerEntry(scope).evaluate(element => {
    const ids = element.getAttribute('aria-describedby')?.split(' ') ?? []
    const text = ids.map(id => document.getElementById(id)?.textContent ?? '').join(' ')
    return /权限：[^。]*/u.exec(text)?.[0] ?? ''
  })
}
