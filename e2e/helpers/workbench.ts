import type { Locator, Page } from '@playwright/test'
import { expect } from 'vitest'
import { settleShell } from './layout.ts'

/** The stored keys of the two workbench layouts and the names the interface gives them. */
export const LAYOUT_NAMES = { overview: '侧栏', triage: '顶栏' } as const
export type WorkbenchLayout = keyof typeof LAYOUT_NAMES

/** The layout switch in sight: the shell's one control at the end of the top row, or a phone heading's. */
export function layoutSwitch(page: Page): Locator {
  return page.getByRole('radiogroup', { name: '布局', exact: true }).locator('visible=true').first()
}

/** Chooses a layout through the switch and waits for the shell to draw it; the control keeps the focus. */
export async function switchLayout(page: Page, layout: WorkbenchLayout): Promise<void> {
  const control = layoutSwitch(page)
  await control.getByRole('radio', { name: LAYOUT_NAMES[layout], exact: true }).click()
  await expect.poll(() => page.locator('.app-shell').getAttribute('data-workbench-layout')).toBe(layout)
  await settleShell(page)
  await expect
    .poll(() =>
      control.getByRole('radio', { name: LAYOUT_NAMES[layout], exact: true }).evaluate(element => element === document.activeElement),
    )
    .toBe(true)
}

/** The home's input, which starts a session: 新会话 and ⌘N lead here on every width. */
export function homeInput(page: Page): Locator {
  return page.locator('.workbench-home').getByRole('textbox', { name: '新会话消息', exact: true })
}
