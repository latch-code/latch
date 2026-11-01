import { chromium, type Browser } from '@playwright/test'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HarnessPlugin } from '@latch/sdk'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { openEntry, openSessions } from './helpers/layout.ts'

describe('custom model extension in the app', () => {
  it('runs without built-in provider configuration and responds to hot plugin toggles', async () => {
    const plugin: HarnessPlugin = {
      id: 'fixture-model',
      name: '验收模型插件',
      version: '1.0.0',
      description: '仅测试使用的确定性模型。',
      activate(context) {
        context.registerProvider({
          id: 'custom-fixture',
          name: 'Custom fixture',
          model: 'fixture',
          async *stream({ signal }) {
            signal.throwIfAborted()
            yield { type: 'text', text: '自定义模型插件已经响应。' }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    let testHost: TestHost | undefined
    let browser: Browser | undefined
    try {
      testHost = await startTestHost({
        uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
        demo: false,
        plugins: [plugin],
        providerId: 'custom-fixture',
      })
      const host = testHost.host
      browser = await chromium.launch(browserLaunchOptions())
      const page = await browser.newPage()
      page.setDefaultTimeout(15_000)
      await enrollBrowser(page, testHost)
      const config = await page
        .context()
        .request.get(host.origin + '/link/api/provider')
        .then(response => response.json())
      expect(config.configured).toBe(false)
      const composer = page.getByRole('textbox', { name: '新会话消息' })
      const send = page.getByRole('button', { name: '发送', exact: true })
      await composer.fill('测试自定义模型')
      await send.click()
      await page.getByText('自定义模型插件已经响应。', { exact: true }).waitFor()
      await expect.poll(async () => (await host.bridge.listTasks())[0]?.status).toBe('idle')

      await openEntry(page, '插件')
      await page.locator('.plugin-nav-row', { hasText: '验收模型插件' }).click()
      const toggle = page.getByRole('switch', { name: '启用 验收模型插件', exact: true })
      await toggle.click()
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false')
      await openSessions(page)
      await page.locator('.settings-page').waitFor({ state: 'detached' })
      await page.getByRole('button', { name: '新建会话', exact: true }).click()
      // Drafting stays possible; starting is blocked and the setup card explains why.
      await composer.fill('停用模型后不能发起')
      await expect.poll(() => send.isDisabled()).toBe(true)
      await page.locator('.setup-card').getByText('还没有模型服务。', { exact: true }).waitFor()

      await openEntry(page, '插件')
      await page.locator('.plugin-nav-row', { hasText: '验收模型插件' }).click()
      await toggle.click()
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
      await openSessions(page)
      await page.locator('.settings-page').waitFor({ state: 'detached' })
      await composer.fill('重新启用模型后继续')
      await send.click()
      await page.getByText('自定义模型插件已经响应。', { exact: true }).waitFor()
      expect((await host.bridge.listTasks()).length).toBe(2)
    } finally {
      await browser?.close()
      await testHost?.close()
    }
  })
})
