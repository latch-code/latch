import { chromium, type Browser, type Page } from '@playwright/test'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSection, openSettings, reachable, closeSettings } from './helpers/layout.ts'

const OUTPUT = 'test-results/design'
const VIEWPORTS = [
  { width: 320, height: 740, label: 'phone-320', touch: true },
  { width: 375, height: 812, label: 'phone-375', touch: true },
  { width: 414, height: 896, label: 'phone-414', touch: true },
  { width: 768, height: 1024, label: 'tablet-768', touch: true },
  { width: 1440, height: 1000, label: 'desktop-1440', touch: false },
] as const

async function capture(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${OUTPUT}/${name}.png`, fullPage: true, animations: 'disabled' })
}

describe('responsive workspace controls', () => {
  let testHost: TestHost
  let browser: Browser

  beforeAll(async () => {
    testHost = await startTestHost({ demo: true, uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web') })
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
  })

  afterAll(async () => {
    await browser?.close()
    await testHost?.close()
  })

  it.each([
    { label: 'desktop', width: 1440, height: 900, dpr: 2, touch: false },
    { label: 'phone', width: 390, height: 844, dpr: 3, touch: true },
  ])('$label keeps the compact controls reachable while the draft grows', async ({ label, width, height, dpr, touch }) => {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: dpr,
      isMobile: touch,
      hasTouch: touch,
      locale: 'zh-CN',
    })
    try {
      const page = await context.newPage()
      await enrollBrowser(page, testHost, { name: `输入框 ${label}` })
      if (touch) {
        await page.locator('.phone-list-head').getByRole('button', { name: '新建会话', exact: true }).click()
        await page.getByRole('dialog', { name: '新会话', exact: true }).waitFor()
      }
      const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
      const before = (await input.boundingBox())!.height
      await input.fill(Array.from({ length: 8 }, (_, index) => `待办 ${index + 1}`).join('\n'))
      await expect.poll(async () => (await input.boundingBox())!.height).toBeGreaterThan(before)
      await reachable(page.getByRole('button', { name: touch ? '开始' : '发送', exact: true }))
      await noHorizontalOverflow(page)
      await capture(page, `compact-draft-${label}`)
    } finally {
      await context.close()
    }
  })

  it.each(VIEWPORTS)('$label keeps new-session, navigation and settings controls reachable', async ({ width, height, label, touch }) => {
    const context = await browser.newContext({
      viewport: { width, height },
      hasTouch: touch,
      isMobile: touch,
      deviceScaleFactor: 1,
      colorScheme: 'light',
      locale: 'zh-CN',
    })
    context.setDefaultTimeout(15_000)
    const page = await context.newPage()
    try {
      // Each viewport is a separate browser device; every one asks for 管理此 Host so settings stay reachable.
      await enrollBrowser(page, testHost, { name: `布局 ${label}`, scopes: ['view', 'run', 'approve:standard', 'admin'] })
      const phone = width < 768
      if (phone) {
        // A phone opens on its session list: the title with a new session, then its search; a new session is a sheet
        // over the list. With no session yet the list says so and offers to start one, and its end still names the
        // computer and syncs its state.
        const head = page.locator('.phone-list-head')
        await reachable(page.locator('.phone-tabs').getByRole('button', { name: '设置', exact: true }))
        await reachable(head.getByRole('button', { name: '新建会话', exact: true }))
        await reachable(page.getByRole('searchbox', { name: '搜索会话', exact: true }))
        await page.locator('.phone-empty').getByText('还没有会话', { exact: true }).waitFor()
        await reachable(page.locator('.phone-empty').getByRole('button', { name: '新建会话', exact: true }))
        await reachable(page.locator('.phone-list-foot').getByRole('button', { name: '同步最新状态', exact: true }))
        await noHorizontalOverflow(page)
        await capture(page, `${label}-navigation`)
        await head.getByRole('button', { name: '新建会话', exact: true }).click()
        await page.getByRole('dialog', { name: '新会话', exact: true }).waitFor()
      }
      const composer = page.getByRole('textbox', { name: '新会话消息', exact: true })
      // A responsive composition may move the form, but must not duplicate it.
      expect(await page.locator('textarea[aria-label="新会话消息"]').count()).toBe(1)
      await reachable(composer)
      await composer.fill('这是一条未提交的布局验收草稿。')
      await noHorizontalOverflow(page)
      // Model and project: rows of the sheet on phones, the one control in the input elsewhere.
      if (phone) {
        for (const row of ['Harness', '思考', '权限'])
          await page.locator('.new-sheet-card').getByText(row, { exact: true }).first().waitFor()
        await page
          .locator('.new-sheet-card')
          .getByRole('button', { name: /^模型：/ })
          .waitFor()
        await noHorizontalOverflow(page, page.locator('.new-session-sheet > .ui-sheet-surface > .ui-sheet-body'))
      } else
        for (const control of [/^Harness：/, /^模型：/, /^思考：/, /^权限：/])
          await reachable(page.getByRole('button', { name: control }).first())
      await reachable(page.getByRole('button', { name: phone ? '开始' : '发送', exact: true }), { allowDisabled: phone })
      await composer.fill('')
      await capture(page, `${label}-new-session`)

      if (width === 375 || width === 1440) {
        await page.emulateMedia({ colorScheme: 'dark' })
        await reachable(composer)
        await noHorizontalOverflow(page)
        await capture(page, `${label}-dark`)
        await page.emulateMedia({ colorScheme: 'light' })
      }

      if (phone) {
        await page.getByRole('dialog', { name: '新会话', exact: true }).getByRole('button', { name: '取消', exact: true }).click()
        await page.getByRole('dialog', { name: '新会话', exact: true }).waitFor({ state: 'hidden' })
      }
      const navigationButton = page.getByRole('button', { name: '打开会话列表', exact: true })
      if (await navigationButton.isVisible()) {
        await reachable(navigationButton)
        await navigationButton.click()
        const drawer = page.getByRole('dialog', { name: '会话导航', exact: true })
        await drawer.waitFor()
        for (const name of ['新建会话', '关闭会话列表']) {
          await reachable(drawer.getByRole('button', { name, exact: true }))
        }
        await noHorizontalOverflow(page, drawer)
        await capture(page, `${label}-navigation`)
        await drawer.getByRole('button', { name: '关闭会话列表', exact: true }).click()
        await expect.poll(() => navigationButton.getAttribute('aria-expanded')).toBe('false')
      }

      const settings = await openSettings(page, '设置')
      await noHorizontalOverflow(page, settings)
      await openSection(settings, '模型')
      await reachable(settings.getByRole('button', { name: '添加模型服务', exact: true }))
      await settings.getByRole('button', { name: '添加模型服务', exact: true }).click()
      const sheet = page.getByRole('dialog', { name: '添加模型服务', exact: true })
      await sheet.getByRole('button', { name: 'OpenAI', exact: true }).click()
      // Unsaved form input only; nothing is submitted, checked or persisted. A browser cannot set keys.
      for (const input of [sheet.getByLabel('地址', { exact: true }), sheet.getByLabel('手动添加模型 ID', { exact: true })]) {
        await reachable(input)
      }
      // OpenAI needs a key: the form says before saving where it is typed and that the service waits for it.
      await sheet.getByText(/^这个服务需要密钥：保存后，在 .+ 上的 Latch 里填写密钥，它才能使用。$/u).waitFor()
      await reachable(sheet.getByRole('button', { name: '检测连接', exact: true }))
      await reachable(sheet.getByRole('button', { name: '保存', exact: true }))
      await capture(page, `${label}-model-settings`)
      await sheet.getByRole('button', { name: '取消', exact: true }).click()
      await sheet.waitFor({ state: 'hidden' })

      await openSection(settings, '插件')
      const plugins = page.locator('.plugin-nav-row')
      await plugins.first().waitFor()
      for (let index = 0; index < (await plugins.count()); index++) await reachable(plugins.nth(index))
      await noHorizontalOverflow(page, settings)
      await capture(page, `${label}-plugin-settings`)
      await closeSettings(settings)

      const devices = await openSettings(page, '手机与设备')
      // A browser cannot pair a phone, so it has no way to open the sheet; its page lists itself, with no address.
      expect(await page.getByRole('button', { name: '连接手机', exact: true }).count()).toBe(0)
      if (phone) await page.locator('.device-nav-row .plugin-nav-row').first().click()
      await reachable(devices.getByRole('button', { name: '移除…', exact: true }))
      expect(await devices.getByText(/--tls-cert|设备指纹|局域网|HTTPS/).count()).toBe(0)
      await noHorizontalOverflow(page, devices)
      await capture(page, `${label}-devices`)
      await closeSettings(devices)
      if (phone) await page.locator('.phone-list-head').getByRole('button', { name: '新建会话', exact: true }).click()
      await reachable(composer)
      expect((await testHost.host.bridge.listTasks()).length).toBe(0)
      await rm(`${OUTPUT}/${label}-failure.png`, { force: true })
    } catch (error) {
      await capture(page, `${label}-failure`).catch(() => {
        /* The original UI failure remains authoritative if the page has closed. */
      })
      throw error
    } finally {
      await context.close()
    }
  })
})
