import { chromium, type Browser, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppSnapshot, ProviderSettings, TaskDetail } from '@latch/protocol'
import { startFakeModels, type FakeModels, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSection, openSession, openSettings } from './helpers/layout.ts'

const OUTPUT = 'test-results/gateway-scheduling'
const KEY_A = 'sk-e2e-first-service-0123456789abcdef'
const KEY_B = 'sk-e2e-second-service-0123456789abcde'
const WIDTHS = [1440, 768, 390] as const
const THEMES = ['light', 'dark'] as const

const shot = (page: Page, name: string) => page.screenshot({ path: `${OUTPUT}/${name}.png`, animations: 'disabled' })

/**
 * 「出错时改用」, a service's own limit and what real requests said of it, as the page shows them: settings, the model menu
 * and a turn another service answered. Two local fake services: the first refuses its key, the second answers.
 */
describe('model scheduling in the page', () => {
  let host: TestHost
  let owner: TestDevice
  let browser: Browser
  let failing: FakeModels
  let working: FakeModels
  let first: ProviderSettings
  let second: ProviderSettings
  let sessionId: string

  beforeAll(async () => {
    failing = await startFakeModels({ replies: [{ error: { status: 401, message: 'invalid api key' } }] })
    working = await startFakeModels({ replies: [{ text: '由第二个服务回答。' }] })
    host = await startTestHost({ demo: false })
    owner = await host.enroll({ listener: 'unix' })
    const add = async (name: string, baseURL: string, apiKey: string, models: string[]) => {
      const created = await owner.confirmed('providers', {
        method: 'POST',
        body: { name, kind: 'openai-compatible', baseURL, apiKey, models, defaultModel: models[0], confirmOrigin: true },
      })
      expect(created.status).toBe(201)
      return ((await created.json()) as { provider: ProviderSettings }).provider
    }
    first = await add('主服务', `${failing.origin}/v1`, KEY_A, ['fake-model', 'fake-model-large'])
    second = await add('备用服务', `${working.origin}/v1`, KEY_B, ['fake-model', 'fake-model-large'])
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
    await failing?.close()
    await working?.close()
  })

  const open = async (width: number, theme: 'light' | 'dark'): Promise<Page> => {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      colorScheme: theme,
      locale: 'zh-CN',
      reducedMotion: 'reduce',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await enrollBrowser(page, host, { scopes: ['view', 'run', 'admin'] })
    await connected(page)
    return page
  }

  const servicePage = async (page: Page, name: string) => {
    const settings = await openSettings(page)
    await openSection(settings, '模型')
    await settings.getByRole('button', { name: `编辑 ${name}`, exact: true }).click()
    await settings.getByRole('heading', { name, exact: true }).waitFor()
    return settings
  }

  it('sets what a model falls back to, in order, and a limit of the service, and keeps both after a reload', async () => {
    const page = await open(1440, 'light')
    const settings = await servicePage(page, '主服务')
    await settings.getByRole('button', { name: 'fake-model 的更多设置', exact: true }).click()
    await page.getByRole('menuitem', { name: '出错时改用…', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '出错时改用' })
    await dialog.getByText('还没有', { exact: true }).waitFor()
    // Nothing to save yet.
    await expect.poll(() => dialog.getByRole('button', { name: '保存', exact: true }).isDisabled()).toBe(true)
    const add = async (service: string, model: string) => {
      await dialog.getByRole('button', { name: /添加模型/u }).click()
      await page.getByRole('group', { name: service }).getByRole('menuitemradio', { name: model, exact: true }).click()
    }
    await add('备用服务', 'fake-model-large')
    await add('备用服务', 'fake-model')
    // The model itself is never offered as its own fallback; another model of the same service is.
    await dialog.getByRole('button', { name: /添加模型/u }).click()
    await expect
      .poll(() => page.getByRole('group', { name: '主服务' }).getByRole('menuitemradio').allTextContents())
      .toEqual(['fake-model-large'])
    await page.keyboard.press('Escape')
    // Sorted with the arrows, by keyboard too.
    await dialog.getByRole('button', { name: '上移 备用服务 · fake-model', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => dialog.locator('.model-fallbacks-list code').allTextContents()).toEqual(['fake-model', 'fake-model-large'])
    await shot(page, 'fallbacks-dialog--light--1440')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await settings.getByText('出错时改用 备用服务 · fake-model 等 2 个', { exact: true }).waitFor()
    const saved = (await owner.json<{ providers: ProviderSettings[] }>('providers')).providers.find(item => item.id === first.id)!
    expect(saved.fallbacks).toEqual({
      'fake-model': [
        { providerId: second.id, model: 'fake-model' },
        { providerId: second.id, model: 'fake-model-large' },
      ],
    })
    // The service's own limit, unset until someone sets it.
    const limit = settings.getByRole('button', { name: /^同时请求/u })
    await expect.poll(() => limit.textContent()).toContain('不限')
    await limit.click()
    await page.getByRole('menuitemradio', { name: '2 个', exact: true }).click()
    await expect.poll(async () => (await owner.json<{ providers: ProviderSettings[] }>('providers')).providers[0]?.maxConcurrent).toBe(2)
    await page.reload()
    await connected(page)
    const again = await servicePage(page, '主服务')
    await again.getByText('出错时改用 备用服务 · fake-model 等 2 个', { exact: true }).waitFor()
    await expect.poll(() => again.getByRole('button', { name: /^同时请求/u }).textContent()).toContain('2 个')
    await page.context().close()
  })

  it('answers a turn from the fallback, tags it 备选 with the service that answered, and marks the first service 密钥无效', async () => {
    const started = await owner.request('tasks', {
      method: 'POST',
      body: {
        prompt: '你好',
        requestId: randomUUID(),
        mode: 'chat',
        harnessId: 'standard',
        model: { providerId: first.id, model: 'fake-model' },
      },
    })
    expect(started.status).toBe(201)
    sessionId = ((await started.json()) as { sessionId: string }).sessionId
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, { timeout: 20_000 }).toBe('idle')
    const detail = await owner.json<TaskDetail>(`tasks/${sessionId}`)
    expect(detail.messages.find(message => message.role === 'user')?.turn?.routed).toMatchObject({
      direct: true,
      models: [{ fallback: 1, provider: second.id }],
    })
    expect((await owner.json<AppSnapshot>('snapshot')).catalog?.providers.find(item => item.id === first.id)?.health).toMatchObject({
      state: 'key-invalid',
      last: 'auth',
    })
    for (const width of WIDTHS)
      for (const theme of THEMES) {
        // 密钥无效 ends by itself after a minute, so each pass has a fresh refusal behind what it shows.
        await owner.request(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: '再来一次', requestId: randomUUID() } })
        await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, { timeout: 20_000 }).toBe('idle')
        const page = await open(width, theme)
        await openSession(page, sessionId)
        await page.getByText('由第二个服务回答。', { exact: true }).first().waitFor()
        const meta = page.locator('.assistant-meta').first()
        // The service and model that answered, then the tag; a colour is never the only sign.
        await expect.poll(() => meta.locator('.assistant-meta-model').textContent()).toContain('备用服务 · fake-model')
        const tag = meta.locator('.assistant-meta-fallback')
        await expect.poll(() => tag.textContent()).toBe('备选')
        // By pointer: a tooltip opens on focus only when the keyboard put it there.
        await tag.hover()
        await page.getByRole('tooltip').filter({ hasText: '这一轮由「备用服务」回答' }).waitFor()
        await noHorizontalOverflow(page)
        await shot(page, `turn-fallback--${theme}--${width}`)
        await page.keyboard.press('Escape')

        // The model menu: only what stops a service now, a dot with its word in the service's name.
        await page
          .getByRole('button', { name: /^模型：/u })
          .first()
          .click()
        const heading = page.getByText('主服务 · 密钥无效', { exact: true }).filter({ visible: true }).first()
        await heading.waitFor()
        if (width >= 768) {
          const dot = page.locator('.service-health-dot .ui-status-dot[data-tone="err"]').first()
          await dot.waitFor()
          expect(await page.locator('.service-health-dot').first().getAttribute('title')).toMatch(/^密钥无效 · 最近一次：密钥无效/u)
        }
        // The service that works carries no mark.
        expect(
          await page
            .getByText(/^备用服务 · (?:密钥无效|出错中|额度用完)/u)
            .filter({ visible: true })
            .count(),
        ).toBe(0)
        await shot(page, `model-menu-health--${theme}--${width}`)
        await page.keyboard.press('Escape')

        // Settings: the same state under the service's name, the latest failure behind it.
        const settings = await servicePage(page, '主服务')
        const health = settings.locator('.settings-heading .service-health')
        await expect.poll(() => health.textContent()).toBe('密钥无效')
        expect(await health.getAttribute('data-tone')).toBe('err')
        await health.hover()
        await page.getByRole('tooltip').filter({ hasText: '最近一次：密钥无效' }).waitFor()
        await noHorizontalOverflow(page)
        await shot(page, `service-health--${theme}--${width}`)
        // Away from the state: Escape here would leave the service's page.
        await page.mouse.move(0, 0)
        await settings.getByRole('button', { name: 'fake-model 的更多设置', exact: true }).click()
        await page
          .getByRole('menuitem', { name: '出错时改用…', exact: true })
          .or(page.getByRole('button', { name: '出错时改用…', exact: true }))
          .first()
          .click()
        const dialog = page.getByRole('dialog', { name: '出错时改用' })
        await dialog.locator('.model-fallbacks-list li').nth(1).waitFor()
        await noHorizontalOverflow(page)
        await shot(page, `fallbacks-dialog--${theme}--${width}`)
        await page.context().close()
      }
  })

  it('shows nothing of a key or a reply in what the page reads of a service', async () => {
    const snapshot = JSON.stringify(await owner.json<AppSnapshot>('snapshot'))
    const settings = JSON.stringify(await owner.json<{ providers: ProviderSettings[] }>('providers'))
    for (const secret of [KEY_A, KEY_B, 'invalid api key']) {
      expect(snapshot).not.toContain(secret)
      expect(settings).not.toContain(secret)
    }
  })
})
