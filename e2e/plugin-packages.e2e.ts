import { chromium, type Browser, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadPluginPackage } from '@latch/host'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { backToPhoneSessions, noHorizontalOverflow, openPanelTab, openSession as chooseSession, reachable } from './helpers/layout.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const OUTPUT = 'test-results/plugin-packages'
const VIEWS = [
  { width: 390, height: 844, name: 'phone', touch: true },
  { width: 820, height: 1180, name: 'tablet', touch: true },
  { width: 1440, height: 960, name: 'desktop', touch: false },
]
async function openSession(page: Page, id: string) {
  await chooseSession(page, id)
  await page.locator('.drawer-backdrop').waitFor({ state: 'detached' })
  await page.getByRole('textbox', { name: '继续对话', exact: true }).waitFor()
}
async function openPanel(page: Page, name: string) {
  const toggle = page.getByRole('button', { name: '侧边面板', exact: true })
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
  // The panel lists only the tabs opened (382abe25): a plugin panel comes from its choices or 「+」.
  await openPanelTab(page, name)
}

describe('feature packages in the workbench', () => {
  let host: TestHost
  let browser: Browser
  let first: string
  let second: string
  let phase: 'ready' | 'error' | 'empty' | 'hold' = 'ready'
  let finish: (() => void) | undefined
  let started: (() => void) | undefined
  beforeAll(async () => {
    const plugin = await loadPluginPackage(resolve('examples/release-review'))
    host = await startTestHost({
      demo: true,
      hostName: '工作电脑',
      plugins: [
        plugin,
        {
          id: 'panel-states',
          name: '检查记录',
          version: '1',
          description: 'Test states',
          activate(ctx) {
            ctx.registerUiPanel({
              id: 'report',
              title: '检查记录',
              async render({ session }) {
                if (phase === 'error') throw new Error('Private failure')
                if (phase === 'empty') return { blocks: [] }
                if (phase === 'hold') {
                  started?.()
                  await new Promise<void>(done => {
                    finish = done
                  })
                }
                return {
                  blocks: [
                    { type: 'text', text: session.title },
                    { type: 'code', language: 'text', text: '<img src="https://invalid.test/no-request">' },
                  ],
                }
              },
            })
            ctx.registerClientPanel({
              id: 'broken',
              title: '异常界面',
              source: 'export default function Broken() { throw new Error("Broken UI") }',
            })
          },
        },
      ],
    })
    const admin = await host.enroll({ listener: 'unix' })
    first = (
      await admin.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { requestId: randomUUID(), mode: 'chat', prompt: '核对本次发布' },
      })
    ).sessionId
    second = (
      await admin.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { requestId: randomUUID(), mode: 'chat', prompt: '准备下一次发布' },
      })
    ).sessionId
    await vi.waitFor(async () => expect((await host.host.bridge.detail(first)).summary.status).toBe('idle'))
    await vi.waitFor(async () => expect((await host.host.bridge.detail(second)).summary.status).toBe('idle'))
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    finish?.()
    await browser?.close()
    await host?.close()
  })

  it.each(VIEWS.flatMap(view => (['light', 'dark'] as const).map(theme => ({ ...view, theme }))))(
    '$name $theme edits a real package UI and creates a reviewable conversation draft',
    async ({ width, height, name, touch, theme }) => {
      const context = await browser.newContext({
        viewport: { width, height },
        hasTouch: touch,
        isMobile: touch,
        colorScheme: theme,
        locale: 'zh-CN',
      })
      try {
        const page = await context.newPage()
        await enrollBrowser(page, host, { name: `插件 ${name} ${theme}` })
        await openSession(page, first)
        await openPanel(page, '发布清单')
        const check = page.getByRole('checkbox', { name: '测试通过并附上结果', exact: true })
        await check.check()
        expect(await check.isChecked()).toBe(true)
        await page.getByRole('textbox', { name: '发布说明', exact: true }).fill('v1.2 · 检查结果待核对')
        await page.getByText('1/3', { exact: true }).waitFor()
        const compose = page.getByRole('button', { name: '写入对话', exact: true })
        await reachable(compose)
        await noHorizontalOverflow(page)
        await page.screenshot({ path: `${OUTPUT}/${name}-${theme}.png`, fullPage: true, animations: 'disabled' })
        const before = (await host.host.bridge.detail(first)).messages.length
        await compose.click()
        const input = page.getByRole('textbox', { name: '继续对话', exact: true })
        await expect.poll(() => input.inputValue()).toContain('[x] 测试通过并附上结果')
        expect(await input.inputValue()).toContain('v1.2 · 检查结果待核对')
        expect((await host.host.bridge.detail(first)).messages).toHaveLength(before)
        await input.fill('')
      } finally {
        await context.close()
      }
    },
  )

  it('keeps errors local, renders data as text and discards a late read after changing sessions', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN', colorScheme: 'dark' })
    try {
      const page = await context.newPage()
      await enrollBrowser(page, host, { name: '插件状态' })
      await openSession(page, first)
      await openPanel(page, '异常界面')
      await page.getByText('这个插件的界面无法显示。其他会话仍可使用。', { exact: true }).waitFor()
      await page.screenshot({ path: `${OUTPUT}/render-failure.png`, fullPage: true, animations: 'disabled' })
      await openPanel(page, '检查记录')
      const panel = page.getByRole('tabpanel', { name: '检查记录', exact: true })
      await panel.getByText('核对本次发布', { exact: true }).waitFor()
      expect(await panel.locator('img, script, iframe').count()).toBe(0)
      phase = 'error'
      await panel.getByRole('button', { name: '刷新', exact: true }).click()
      await panel.getByText('扩展面板暂时无法读取，请稍后重试。', { exact: true }).waitFor()
      expect(await panel.getByText('Private failure', { exact: false }).count()).toBe(0)
      await page.screenshot({ path: `${OUTPUT}/data-failure.png`, fullPage: true, animations: 'disabled' })
      phase = 'empty'
      await panel.getByRole('button', { name: '重试', exact: true }).click()
      await panel.getByText('这个会话暂时没有面板内容。', { exact: true }).waitFor()
      await page.screenshot({ path: `${OUTPUT}/empty.png`, fullPage: true, animations: 'disabled' })
      phase = 'hold'
      const entered = new Promise<void>(done => {
        started = done
      })
      await panel.getByRole('button', { name: '刷新', exact: true }).click()
      await entered
      await panel.getByText('正在读取扩展面板…', { exact: true }).waitFor()
      await page.screenshot({ path: `${OUTPUT}/loading.png`, fullPage: true, animations: 'disabled' })
      phase = 'ready'
      await openSession(page, second)
      await openPanel(page, '检查记录')
      await panel.getByText('准备下一次发布', { exact: true }).waitFor()
      finish?.()
      await expect.poll(() => panel.getByText('核对本次发布', { exact: true }).count()).toBe(0)
      await noHorizontalOverflow(page)
      // A failed ESM fetch is cached by browsers; retry must use a fresh module URL.
      let rejectModule = true
      await page.route('**/api/ui-modules/**', async route => {
        if (rejectModule) {
          rejectModule = false
          await route.abort('failed')
        } else await route.continue()
      })
      await openPanel(page, '发布清单')
      await page.getByText('无法加载这个插件的界面，请同步后重试。', { exact: true }).waitFor()
      await page.getByRole('tabpanel', { name: '发布清单', exact: true }).getByRole('button', { name: '重试', exact: true }).click()
      const check = page.getByRole('checkbox', { name: '测试通过并附上结果', exact: true })
      await check.check()
      const admin = await host.enroll({ listener: 'unix' })
      await admin.json('plugins/release-review', { method: 'POST', body: { enabled: false } })
      await page.getByRole('tab', { name: '发布清单', exact: true }).waitFor({ state: 'detached' })
      await check.waitFor({ state: 'detached' })
      await admin.json('plugins/release-review', { method: 'POST', body: { enabled: true } })
      await page.getByRole('tab', { name: '发布清单', exact: true }).waitFor()
      await openPanel(page, '发布清单')
      await check.waitFor()
      expect(await check.isChecked()).toBe(false)
    } finally {
      finish?.()
      phase = 'ready'
      await context.close()
    }
  })
})
