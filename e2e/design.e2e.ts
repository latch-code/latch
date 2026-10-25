import { chromium, type Browser, type Page } from '@playwright/test'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
    testHost = await startTestHost({ demo: true, uiDir: resolve(process.env.HARNESS_E2E_UI_DIR ?? 'dist/web') })
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
  })

  afterAll(async () => {
    await browser?.close()
    await testHost?.close()
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
      // The dev-build chip sits in the sidebar footer (wide) or the rail (tablet); phones show it in settings.
      if (width >= 768) await expect.poll(() => page.getByTestId('dev-mode').filter({ visible: true }).count()).toBe(1)
      const composer = page.getByRole('textbox', { name: '新会话消息', exact: true })
      // A responsive composition may move the form, but must not duplicate it.
      expect(await page.locator('textarea[aria-label="新会话消息"]').count()).toBe(1)
      await reachable(composer)
      await composer.fill('这是一条未提交的布局验收草稿。')
      const modes = page.getByRole('radiogroup', { name: '会话模式', exact: true })
      for (const mode of ['对话', 'Agent']) {
        const button = modes.getByRole('radio', { name: mode, exact: true })
        await reachable(button)
        await button.click()
        expect(await button.getAttribute('aria-checked')).toBe('true')
        expect(await composer.inputValue()).toBe('这是一条未提交的布局验收草稿。')
        await noHorizontalOverflow(page)
      }
      // Harness, model and project are one chip on phones and separate pickers elsewhere.
      const runSettings = page.getByRole('button', { name: /^(运行设置|模型)：/ }).first()
      await reachable(runSettings)
      await reachable(page.getByRole('button', { name: '发送', exact: true }))
      await composer.fill('')
      await capture(page, `${label}-new-session`)

      if (width === 375 || width === 1440) {
        await page.emulateMedia({ colorScheme: 'dark' })
        await reachable(composer)
        await noHorizontalOverflow(page)
        await capture(page, `${label}-dark`)
        await page.emulateMedia({ colorScheme: 'light' })
      }

      const navigationButton = page.getByRole('button', { name: '打开会话列表', exact: true })
      if (await navigationButton.isVisible()) {
        await reachable(navigationButton)
        await navigationButton.click()
        const drawer = page.getByRole('dialog', { name: '会话导航', exact: true })
        await drawer.waitFor()
        for (const name of ['新建会话', '设置', '关闭会话列表']) {
          await reachable(drawer.getByRole('button', { name, exact: true }))
        }
        await noHorizontalOverflow(page, drawer)
        await capture(page, `${label}-navigation`)
        await drawer.getByRole('button', { name: '关闭会话列表', exact: true }).click()
        await expect.poll(() => navigationButton.getAttribute('aria-expanded')).toBe('false')
      }

      const settings = await openSettings(page, '设置')
      await noHorizontalOverflow(page, settings)
      await openSection(settings, '模型服务')
      await reachable(settings.getByRole('button', { name: '添加服务', exact: true }))
      await settings.getByRole('button', { name: '添加服务', exact: true }).click()
      await settings.getByRole('button', { name: /^OpenAI/ }).click()
      // Unsaved form input only; nothing is submitted, checked or persisted. A browser cannot set keys.
      for (const input of [
        settings.getByLabel('名称', { exact: true }),
        settings.getByLabel('API 地址', { exact: true }),
        settings.getByLabel('手动添加模型 ID', { exact: true }),
      ]) {
        await reachable(input)
      }
      await settings.getByText('设置密钥需要在执行端电脑上用 Latch 桌面端确认。', { exact: true }).waitFor()
      await reachable(settings.getByRole('button', { name: '检测连接', exact: true }))
      await reachable(settings.getByRole('button', { name: '添加服务', exact: true }).last())
      await noHorizontalOverflow(page, settings)
      await capture(page, `${label}-model-settings`)

      await openSection(settings, '插件')
      const switches = settings.getByRole('switch')
      await switches.first().waitFor()
      for (let index = 0; index < (await switches.count()); index++) await reachable(switches.nth(index), { allowDisabled: true })
      await noHorizontalOverflow(page, settings)
      await capture(page, `${label}-plugin-settings`)
      await closeSettings(settings)

      const devices = await openSettings(page, '设备')
      await reachable(devices.getByRole('button', { name: '撤销此设备', exact: true }))
      await devices.getByRole('heading', { name: /已登记的设备/ }).waitFor()
      await devices.getByText(/^手机接入需要 HTTPS/).waitFor()
      if (width < 768) await devices.getByTestId('dev-mode').waitFor()
      await noHorizontalOverflow(page, devices)
      await capture(page, `${label}-devices`)
      await closeSettings(devices)
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
