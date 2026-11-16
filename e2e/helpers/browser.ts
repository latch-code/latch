import type { Page } from '@playwright/test'
import type { DataScope, Device, DeviceScope } from '@latch/protocol'
import { latchEnv } from '@latch/host/env'
import type { TestHost } from './host.ts'

/** What the command line's invitation for a browser on this computer allows. */
const ADMIN_CEILING: readonly DeviceScope[] = ['view', 'run', 'approve:standard', 'approve:elevated', 'admin']
const BASE_CEILING: readonly DeviceScope[] = ['view', 'run', 'approve:standard', 'approve:elevated']
const ENROLLMENTS_API = '**/link/api/enrollments'

/** The shell reports its synchronized connection; the visible indicator differs per breakpoint. */
export const connected = (page: Page) => page.locator('.app-shell[data-connection="connected"]').waitFor()

/** Whether no active device can manage the Host yet, read anonymously over host.sock as the command line would. */
async function noAdminYet(testHost: TestHost): Promise<boolean> {
  const { devices } = (await (await testHost.raw('unix', 'api/devices')).json()) as { devices: Device[] }
  return !devices.some(device => device.status === 'active' && device.scopes.includes('admin'))
}

/**
 * The enrollment page asks a browser for no name and sends its own, so a test that wants a name gives it the way a device
 * does: in its request. Everything else about the request stays the page's.
 */
export async function nameNextEnrollment(page: Page, name: string): Promise<void> {
  await shapeNextEnrollment(page, { name })
}

async function shapeNextEnrollment(page: Page, extra: { name?: string; dataScope?: DataScope }): Promise<void> {
  await page.route(
    ENROLLMENTS_API,
    route => route.continue({ postData: JSON.stringify({ ...(route.request().postDataJSON() as object), ...extra }) }),
    { times: 1 },
  )
}

/**
 * Enrolls the browser behind `page` through the real enrollment page and waits for the synchronized workspace. Loopback
 * takes a one-time invitation, so the page opens with one in its fragment, as the desktop app's 「在浏览器中打开」 does (or at
 * `url`). A browser asks for what its invitation allows, so `scopes` decides only whether the invitation includes admin;
 * without it admin is allowed while no device can manage the Host yet. `dataScope` asks for less than the default, as a
 * browser may. With a manual test presence the local confirmation is approved here.
 */
export async function enrollBrowser(
  page: Page,
  testHost: TestHost,
  options: { name?: string; scopes?: DeviceScope[]; url?: string; dataScope?: DataScope } = {},
): Promise<void> {
  const wanted = options.scopes === undefined ? await noAdminYet(testHost) : options.scopes.includes('admin')
  await page.goto(options.url ?? (await testHost.invite([...(wanted ? ADMIN_CEILING : BASE_CEILING)], 'loopback-tcp')).url)
  if (options.name !== undefined || options.dataScope !== undefined)
    await shapeNextEnrollment(page, {
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.dataScope ? { dataScope: options.dataScope } : {}),
    })
  await page.getByRole('button', { name: '连接这个浏览器', exact: true }).click()
  if (testHost.presence.mode === 'manual') {
    await testHost.presence.waitForRequest()
    testHost.presence.approveNext()
  }
  await connected(page)
}

/** Browser options shared by the e2e files: an installed Chrome when LATCH_BROWSER_PATH is set. */
export const browserLaunchOptions = () => {
  const executablePath = latchEnv(process.env, 'BROWSER_PATH')
  return { headless: true, ...(executablePath ? { executablePath } : {}) }
}
