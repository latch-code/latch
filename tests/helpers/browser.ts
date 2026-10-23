import type { Page } from '@playwright/test'
import type { DeviceScope } from '../../src/shared/types.ts'
import type { TestHost } from './host.ts'

const ADMIN_LABEL = '管理此 Host（模型服务、插件、项目和设备）'

/**
 * Enrolls the browser behind `page` through the real enrollment page on the
 * Host's loopback origin and waits for the synchronized workspace. `scopes`
 * decides only the admin checkbox (the rest are fixed on that page); without
 * it the page default stays (admin for the Host's first device). With a manual
 * test presence the local confirmation is approved here.
 */
export async function enrollBrowser(page: Page, testHost: TestHost, options: { name?: string; scopes?: DeviceScope[]; url?: string } = {}): Promise<void> {
  await page.goto(options.url ?? `${testHost.host.loopbackOrigin}/link/`)
  const name = page.getByLabel('设备名称', { exact: true })
  await name.waitFor()
  if (options.name !== undefined) await name.fill(options.name)
  if (options.scopes !== undefined) {
    const admin = page.getByRole('checkbox', { name: ADMIN_LABEL, exact: true })
    const wanted = options.scopes.includes('admin')
    if (await admin.isChecked() !== wanted) await admin.setChecked(wanted)
  }
  await page.getByRole('button', { name: '请求本机确认', exact: true }).click()
  if (testHost.presence.mode === 'manual') {
    await testHost.presence.waitForRequest()
    testHost.presence.approveNext()
  }
  await page.locator('.app-shell[data-connection="connected"]').waitFor()
}

/** Browser options shared by the e2e files: an installed Chrome when HARNESS_BROWSER_PATH is set. */
export const browserLaunchOptions = () => ({ headless: true, ...(process.env.HARNESS_BROWSER_PATH ? { executablePath: process.env.HARNESS_BROWSER_PATH } : {}) })
