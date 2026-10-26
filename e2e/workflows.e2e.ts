import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import type { HarnessPlugin } from '@latch/sdk'
import { closeSettings, openSection, openSettings } from './helpers/layout.ts'
import type { TaskDetail } from '@latch/protocol'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'

describe('session search and workbench navigation', () => {
  it('offers one actionable desktop notification choice and leaves ordinary browsers alone', async () => {
    const host = await startTestHost({ uiDir: resolve('dist/web') }),
      browser = await chromium.launch(browserLaunchOptions())
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
      const page = await context.newPage()
      await enrollBrowser(page, host, { name: '通知入口验收' })
      await context.addInitScript(() => {
        let state = { completion: false, approval: false, title: false, supported: true, needsConsent: true, consent: 'pending' }
        const listeners = new Set<(value: typeof state) => void>()
        Reflect.set(window, 'notificationChoices', [])
        Reflect.set(window, 'latchShell', {
          kind: 'electron',
          devMode: false,
          platform: 'darwin',
          notifications: {
            get: async () => ({ ...state }),
            set: async () => ({ ...state }),
            subscribe: () => () => {},
            subscribeState: (listener: (value: typeof state) => void) => {
              listeners.add(listener)
              return () => listeners.delete(listener)
            },
            respond: async (value: { choice: string }) => {
              Reflect.get(window, 'notificationChoices').push(value)
              state = {
                ...state,
                needsConsent: false,
                consent: value.choice === 'enable' ? 'accepted' : 'declined',
                completion: value.choice === 'enable',
                approval: value.choice === 'enable',
              }
              listeners.forEach(listener => listener({ ...state }))
              return { ...state }
            },
          },
        })
      })
      await page.reload()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      await page.getByRole('button', { name: '暂不需要', exact: true }).click()
      await page.getByRole('button', { name: '开启通知', exact: true }).waitFor({ state: 'hidden' })
      expect(await page.evaluate(() => Reflect.get(window, 'notificationChoices'))).toEqual([{ choice: 'decline' }])
      const onboarding = page.getByRole('region', { name: '开始使用', exact: true })
      expect(await onboarding.getByLabel('已完成').count()).toBeGreaterThan(0)
      await onboarding.getByRole('button', { name: '更换', exact: true }).last().click()
      await page.getByRole('menu', { name: '项目', exact: true }).waitFor()
      await page.keyboard.press('Escape')
      await context.close()
      const browserPage = await browser.newPage()
      await enrollBrowser(browserPage, host, { name: '普通浏览器' })
      expect(await browserPage.getByRole('button', { name: '开启通知', exact: true }).count()).toBe(0)
    } finally {
      await browser.close()
      await host.close()
    }
  })
  it('finds private body text, reveals the original message, uses DOM highlights and opens commands at desktop and phone widths', async () => {
    const host = await startTestHost({ uiDir: resolve('dist/web') }),
      browser = await chromium.launch(browserLaunchOptions())
    try {
      const owner = await host.enroll({ listener: 'unix' })
      await mkdir(join(host.workspaceRoot, '.git'))
      await writeFile(join(host.workspaceRoot, '.git/HEAD'), 'ref: refs/heads/feature/quiet-ui\n')
      const created = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { prompt: '正文包含 独特检索词 中文 hello world', requestId: randomUUID() },
      })
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${created.sessionId}`)).summary.status).toBe('idle')
      await owner.json(`tasks/${created.sessionId}`, { method: 'PATCH', body: { title: '示例会话' } })
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${created.sessionId}`)).summary.branch).toBe('feature/quiet-ui')
      for (const width of [1440, 768, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: width === 390 ? 'dark' : 'light' })
        const page = await context.newPage()
        await enrollBrowser(page, host, { name: `检索 ${width}` })
        await page.keyboard.press('Meta+k')
        const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
        await palette.waitFor()
        await palette.getByRole('searchbox').fill('独特检索词')
        const result = palette.getByRole('option').filter({ hasText: '独特检索词' }).first()
        await result.waitFor()
        await result.click()
        await page.locator('.transcript [data-search-target]').first().waitFor()
        expect(await page.locator('.topbar-source-text:visible').textContent()).toContain('feature/quiet-ui')
        await page.keyboard.press('Meta+f')
        const find = page.getByRole('search', { name: '会话内查找' })
        await find.getByRole('searchbox', { name: '查找消息内容' }).fill('hello')
        await expect.poll(() => page.evaluate(() => CSS.highlights.get('latch-find')?.size ?? 0)).toBeGreaterThan(0)
        expect(await find.getByRole('status').textContent()).toMatch(/1\//u)
        await find.getByRole('searchbox').press('Escape')
        await find.waitFor({ state: 'hidden' })
        if (width === 1440) {
          const input = page.getByRole('textbox', { name: '继续对话', exact: true })
          await page.keyboard.press('Alt+l')
          await expect.poll(() => input.evaluate(element => element === document.activeElement)).toBe(true)
          await input.press('ArrowUp')
          expect(await input.inputValue()).toBe('正文包含 独特检索词 中文 hello world')
          await input.fill('保留草稿')
          await page.keyboard.press('Meta+k')
          await palette.getByRole('searchbox').fill('外观：深色')
          await palette.getByRole('option', { name: '外观：深色', exact: true }).click()
          await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('dark')
          expect(await input.inputValue()).toBe('保留草稿')
          await input.fill('运行可取消长任务')
          await input.press('Meta+Enter')
          await expect.poll(async () => (await owner.json<TaskDetail>('tasks/' + created.sessionId)).summary.status).not.toBe('idle')
          await input.focus()
          await input.press('Escape')
          expect((await owner.json<TaskDetail>('tasks/' + created.sessionId)).summary.status).not.toBe('cancelled')
          await input.press('Escape')
          await expect.poll(async () => (await owner.json<TaskDetail>('tasks/' + created.sessionId)).summary.status).toBe('cancelled')
          await page.keyboard.press('Alt+/')
          await page.getByRole('dialog', { name: '键盘快捷键', exact: true }).waitFor()
          await page.getByRole('dialog', { name: '键盘快捷键', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
          await page.keyboard.press('Alt+b')
          await page.getByRole('button', { name: '展开侧栏', exact: true }).waitFor()
          await page.keyboard.press('Alt+b')
          await page.getByRole('button', { name: '收起侧栏', exact: true }).waitFor()
          await page.keyboard.press('Alt+n')
          await page.getByRole('heading', { name: '今天要做什么？', exact: true }).waitFor()
          await page.keyboard.press('Alt+1')
          await page.locator('.transcript').waitFor()
        }

        await page.locator('.transcript').getByText('正文包含 独特检索词 中文 hello world', { exact: true }).waitFor()
        await page.getByRole('textbox', { name: '继续对话', exact: true }).waitFor()
        await page.screenshot({ path: `test-results/workflows-${width}.png`, fullPage: true })
        await context.close()
      }
    } finally {
      await browser.close()
      await host.close()
    }
  })
  it('inserts a scoped prompt template as editable text without sending it, on desktop and phone', async () => {
    const host = await startTestHost({ uiDir: resolve('dist/web') }),
      browser = await chromium.launch(browserLaunchOptions())
    try {
      const owner = await host.enroll({ listener: 'unix' })
      await owner.json('prompts/review', {
        method: 'PUT',
        body: { id: 'review', name: '检查变更', content: '阅读变更，并解释结果。', scope: { kind: 'all' } },
      })
      for (const width of [1440, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' }),
          page = await context.newPage()
        await enrollBrowser(page, host, { name: `模板 ${width}` })
        if (width === 390) await page.locator('.phone-list-head').getByRole('button', { name: '新建会话', exact: true }).click()
        const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
        await input.fill('/review')
        await page.getByRole('option', { name: '/review · 检查变更 提示模板 · 通用', exact: true }).click()
        expect(await input.inputValue()).toBe('阅读变更，并解释结果。')
        expect((await owner.json<{ tasks: unknown[] }>('snapshot')).tasks).toEqual([])
        await context.close()
      }
    } finally {
      await browser.close()
      await host.close()
    }
  })
  it('filters abbreviated model names, remembers choices, hides models locally and shows reported period usage', async () => {
    const plugin: HarnessPlugin = {
      id: 'workflow-models',
      description: '只在测试中提供模型和计数。',
      name: '测试模型',
      version: '1',
      activate(context) {
        context.registerProvider({
          id: 'workflow-models',
          name: '测试模型',
          model: 'gpt-5.0-mini',
          models: Array.from({ length: 10 }, (_, i) => `gpt-5.${i}-mini`),
          async *stream() {
            yield { type: 'text', text: '完成' }
            yield { type: 'usage', inputTokens: 123, outputTokens: 45, cacheReadTokens: 10 }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    const host = await startTestHost({ uiDir: resolve('dist/web'), plugins: [plugin] }),
      browser = await chromium.launch(browserLaunchOptions())
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const created = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { prompt: '本地测试', requestId: randomUUID(), model: { providerId: 'workflow-models', model: 'gpt-5.1-mini' } },
      })
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${created.sessionId}`)).summary.status).toBe('idle')
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }),
        page = await context.newPage()
      await enrollBrowser(page, host, { name: '模型列表' })
      const settings = await openSettings(page)
      await openSection(settings, '通用')
      await settings.getByRole('button', { name: '管理显示的模型', exact: true }).click()
      const visible = settings.getByRole('switch', { name: 'gpt-5.0-mini', exact: true })
      await visible.click()
      expect(await visible.getAttribute('aria-checked')).toBe('false')
      await settings.locator('.usage-table').waitFor()
      expect(await settings.locator('.usage-table').textContent()).toContain('123')
      await settings.getByRole('radio', { name: '最近 30 天', exact: true }).click()
      await settings.locator('.usage-table').waitFor()
      expect(await settings.locator('.usage-table').textContent()).toContain('未报告')
      await page.screenshot({ path: 'test-results/workflow-model-usage.png', fullPage: true })
      await closeSettings(settings)
      await page.keyboard.press('Alt+n')
      await page.locator('.model-picker:visible').click()
      await page.getByRole('searchbox', { name: '搜索模型', exact: true }).fill('gpt5m')
      expect(await page.getByRole('menuitemradio', { name: /gpt-5.0-mini/u }).count()).toBe(0)
      await page.getByRole('menuitemradio', { name: /gpt-5.1-mini/u }).click()
      await page.locator('.model-picker:visible').click()
      await page.getByText('最近使用', { exact: true }).waitFor()
      await page.getByRole('menuitem', { name: /显示隐藏的模型/u }).click()
      await page.getByRole('menuitemradio', { name: /gpt-5.0-mini/u }).waitFor()
      await context.close()
    } finally {
      await browser.close()
      await host.close()
    }
  })
})
