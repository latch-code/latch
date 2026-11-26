import type { Locator, Page } from '@playwright/test'
import { expect } from 'vitest'
import { settleShell } from './layout.ts'

/** The names the interface gives the two views. */
export const VIEW_NAMES = { chat: '对话', board: '看板' } as const
export type WorkView = keyof typeof VIEW_NAMES

/** The view switch in sight: the shell's control at the start of the top row, the tablet rail's, or a phone list's. */
export function viewSwitch(page: Page): Locator {
  return page.getByRole('radiogroup', { name: '视图', exact: true }).locator('visible=true').first()
}

/** Chooses a view through the switch and waits for the shell to draw it; the control keeps the focus. */
export async function switchView(page: Page, view: WorkView): Promise<void> {
  const control = viewSwitch(page)
  await control.getByRole('radio', { name: new RegExp(`^${VIEW_NAMES[view]}`, 'u') }).click()
  await expect.poll(() => page.locator('.app-shell').getAttribute('data-view')).toBe(view)
  await settleShell(page)
}

/** The start screen's input, which starts a session: 新会话 and ⌘N lead here on every width. */
export function homeInput(page: Page): Locator {
  return page.locator('.workbench-home').getByRole('textbox', { name: '新会话消息', exact: true })
}
