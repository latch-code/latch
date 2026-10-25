import type { Page } from '@playwright/test'
import type { Device, DeviceScope } from '@latch/protocol'
import type { TestHost } from './host.ts'

const ADMIN_LABEL = '管理此 Host（模型服务、插件、项目和设备）'
/** What the desktop app's invitation for a browser on this computer allows. */
const ADMIN_CEILING: readonly DeviceScope[] = ['view', 'run', 'approve:standard', 'admin']

/** The shell reports its synchronized connection; the visible indicator differs per breakpoint. */
export const connected = (page: Page) => page.locator('.app-shell[data-connection="connected"]').waitFor()

/** Whether no active device can manage the Host yet, read anonymously over host.sock as the command line would. */
async function noAdminYet(testHost: TestHost): Promise<boolean> {
  const { devices } = (await (await testHost.raw('unix', 'api/devices')).json()) as { devices: Device[] }
  return !devices.some(device => device.status === 'active' && device.scopes.includes('admin'))
}

/**
 * Enrolls the browser behind `page` through the real enrollment page and waits for the synchronized workspace. Loopback
 * takes a one-time invitation, so the page opens with one in its fragment, as the desktop app's 「在这台电脑的浏览器中打开」
 * does (or at `url`). `scopes` decides only the admin checkbox (the rest are fixed on that page); without it admin is
 * asked for while no device can manage the Host yet. With a manual test presence the local confirmation is approved here.
 */
export async function enrollBrowser(
  page: Page,
  testHost: TestHost,
  options: { name?: string; scopes?: DeviceScope[]; url?: string } = {},
): Promise<void> {
  await page.goto(options.url ?? (await testHost.invite([...ADMIN_CEILING], 'loopback-tcp')).url)
  const name = page.getByLabel('设备名称', { exact: true })
  await name.waitFor()
  if (options.name !== undefined) await name.fill(options.name)
  const admin = page.getByRole('checkbox', { name: ADMIN_LABEL, exact: true })
  const wanted = options.scopes === undefined ? await noAdminYet(testHost) : options.scopes.includes('admin')
  if ((await admin.isChecked()) !== wanted) await admin.setChecked(wanted)
  await page.getByRole('button', { name: '请求本机确认', exact: true }).click()
  if (testHost.presence.mode === 'manual') {
    await testHost.presence.waitForRequest()
    testHost.presence.approveNext()
  }
  await connected(page)
}

/** Browser options shared by the e2e files: an installed Chrome when HARNESS_BROWSER_PATH is set. */
export const browserLaunchOptions = () => ({
  headless: true,
  ...(process.env.HARNESS_BROWSER_PATH ? { executablePath: process.env.HARNESS_BROWSER_PATH } : {}),
})
