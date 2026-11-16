import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium, type Browser, type Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { latchEnv } from '@latch/host/env'
import type { ModelSpend, ProviderSettings, TaskDetail } from '@latch/protocol'
import { startFakeModels, type FakeModels, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { closeSettings, noHorizontalOverflow, openEntry, openSection, openSettings, reachable } from './helpers/layout.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

describe('optional settings chunk lifecycle', () => {
  let host: TestHost
  let browser: Browser
  beforeAll(async () => {
    host = await startTestHost({ uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web') })
    browser = await chromium.launch(browserLaunchOptions())
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
  })

  it('keeps settings available when an optional module fails and can be retried', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.setDefaultTimeout(10_000)
    try {
      await enrollBrowser(page, host, { name: '设置模块失败', scopes: ['view', 'run', 'admin'] })
      const draft = page.getByRole('textbox', { name: '新会话消息', exact: true })
      await draft.fill('Keep the draft through a settings module failure')
      await page.route('**/assets/PluginsSettings-*.js', route => route.abort('failed'))
      await openEntry(page, '插件')
      const settings = page.locator('.settings-page')
      const retry = settings.getByRole('button', { name: '重试加载', exact: true })
      await retry.click()
      await settings.getByText('无法加载插件设置，当前会话和草稿仍保留。', { exact: true }).waitFor()
      await closeSettings(settings)
      expect(await draft.inputValue()).toBe('Keep the draft through a settings module failure')
    } finally {
      await context.close()
    }
  })

  it('recovers an optional module after its first render fails and reuses it on return', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.setDefaultTimeout(10_000)
    let moduleRequests = 0
    try {
      await enrollBrowser(page, host, { name: '设置模块重试', scopes: ['view', 'run', 'admin'] })
      await page.route('**/assets/PluginsSettings-*.js', route => {
        moduleRequests++
        return route.fulfill({
          contentType: 'text/javascript',
          body: `
            let canRender = false;
            document.addEventListener('latch-fixture-plugin-ready', () => { canRender = true; });
            export function PluginsSettings() {
              if (!canRender) {
                document.documentElement.dataset.fixtureSettingsRender = 'failed';
                throw new Error('Fixture settings render failure');
              }
              document.documentElement.dataset.fixtureSettingsRender = 'recovered';
              return '插件正文已恢复';
            }
          `,
        })
      })
      await openEntry(page, '插件')
      const settings = page.locator('.settings-page')
      const retry = settings.getByRole('button', { name: '重试加载', exact: true })
      await retry.waitFor()
      const phase = () => page.locator('html').getAttribute('data-fixture-settings-render')
      expect(await phase()).toBe('failed')
      await page.evaluate(() => document.dispatchEvent(new Event('latch-fixture-plugin-ready')))
      expect(await phase()).toBe('failed')
      await retry.click()
      const content = settings.locator('.settings-content')
      const recovered = content.filter({ hasText: '插件正文已恢复' })
      await recovered.waitFor()
      const diagnostics = await content.evaluate(element => ({
        heading: element.querySelector('h1')?.textContent,
        directText: [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent),
        renderPhase: document.documentElement.dataset.fixtureSettingsRender,
      }))
      expect(diagnostics.renderPhase).toBe('recovered')
      expect(await retry.count()).toBe(0)
      await mkdir(resolve('test-results/client-loading'), { recursive: true })
      await writeFile(resolve('test-results/client-loading/retry-dom.json'), JSON.stringify(diagnostics, null, 2))
      await openSection(settings, '通用')
      await openSection(settings, '插件')
      await recovered.waitFor()
      expect(moduleRequests).toBe(1)
    } finally {
      await context.close()
    }
  })

  it.each([390, 820, 1440])('does not mount a late private section after permission revocation at width %i', async width => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', locale: 'zh-CN' })
    const page = await context.newPage()
    const owner = await host.enroll({ listener: 'unix' })
    let release!: () => void
    const waiting = new Promise<void>(resolve => {
      release = resolve
    })
    let requested = false
    let privateReads = 0
    try {
      await enrollBrowser(page, host, { name: `加载设置 ${width}`, scopes: ['view', 'run', 'admin'] })
      const device = host.host.security.devices.list().find(item => item.name === `加载设置 ${width}`)!
      const draft = page.getByRole('textbox', { name: '新会话消息', exact: true })
      await draft.fill('Retain this unsent draft while settings loads')
      const resources = () =>
        page.evaluate(() =>
          performance
            .getEntriesByType('resource')
            .filter((entry): entry is PerformanceResourceTiming => entry instanceof PerformanceResourceTiming)
            .filter(entry => new URL(entry.name).pathname.startsWith('/link/assets/'))
            .map(entry => ({
              path: new URL(entry.name).pathname,
              transferSize: entry.transferSize,
              encodedBodySize: entry.encodedBodySize,
              decodedBodySize: entry.decodedBodySize,
              startTime: entry.startTime,
              duration: entry.duration,
              initiator: entry.initiatorType,
            })),
        )
      const initial = await resources()
      expect(initial.some(entry => /\/assets\/PluginsSettings-[^/]+\.js/u.test(entry.path))).toBe(false)
      await page.route('**/assets/PluginsSettings-*.js', async route => {
        requested = true
        await waiting
        await route.continue().catch(() => {})
      })
      page.on('request', request => {
        if (new URL(request.url()).pathname === '/link/api/plugins') privateReads++
      })
      await page.setViewportSize({ width, height: 1000 })
      const settings = page.locator('.settings-page')
      await openEntry(page, '插件')
      await expect.poll(() => requested).toBe(true)
      expect(privateReads).toBe(0)
      await owner.json(`devices/${device.id}`, { method: 'PATCH', body: { scopes: ['view', 'run'] } })
      await expect.poll(() => settings.getByRole('tab', { name: '插件', exact: true }).count()).toBe(0)
      const received = page.waitForResponse(response => /\/assets\/PluginsSettings-[^/]+\.js/u.test(new URL(response.url()).pathname))
      release()
      await (await received).finished()
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
      expect(privateReads).toBe(0)
      expect(
        await settings
          .locator('.settings-content')
          .filter({ has: page.getByRole('heading', { name: '插件', exact: true }) })
          .count(),
      ).toBe(0)
      await mkdir(resolve('test-results/client-loading'), { recursive: true })
      await writeFile(
        resolve(`test-results/client-loading/network-${width}.json`),
        JSON.stringify(
          {
            scope:
              'Only /link/assets resource timing entries before opening settings and two frames after releasing the withheld plugin chunk.',
            width,
            browser: browser.version(),
            initial,
            afterRevocation: await resources(),
            privateReads,
          },
          null,
          2,
        ),
      )
      await closeSettings(settings)
      await page.setViewportSize({ width: 1440, height: 1000 })
      expect(await draft.inputValue()).toBe('Retain this unsent draft while settings loads')
    } finally {
      release()
      await context.close()
    }
  })
})

/** Read through the real Host, then keep its answer from the browser until the assertion releases it. */
async function holdRead(page: Page, routePath: string) {
  let releaseRead!: () => void
  let markDelivered!: () => void
  const release = new Promise<void>(done => {
    releaseRead = done
  })
  const delivered = new Promise<void>(done => {
    markDelivered = done
  })
  let ready = false
  let released = false
  await page.route(`**/link/api/${routePath}`, async route => {
    if (released) {
      await route.fallback()
      return
    }
    try {
      const response = await route.fetch()
      ready = true
      await release
      await route.fulfill({ response })
    } catch {
      // A switch or a permission change can abort the intercepted browser request.
    } finally {
      markDelivered()
    }
  })
  return {
    wait: () => expect.poll(() => ready, { timeout: 10_000, message: `Host answered ${routePath}` }).toBe(true),
    release: () => {
      released = true
      releaseRead()
    },
    delivered,
  }
}

describe('model and usage settings reads', () => {
  const output = resolve('test-results/settings-direct')
  const service = '设置测试服务'
  let host: TestHost
  let models: FakeModels
  let owner: TestDevice
  let providerId: string
  let browser: Browser

  beforeAll(async () => {
    models = await startFakeModels({
      replies: [{ text: '已完成。', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }],
    })
    host = await startTestHost({
      demo: false,
      hostName: '设置测试 Mac',
      uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
    })
    owner = await host.enroll({ listener: 'unix' })
    const { provider } = await owner.confirmedJson<{ provider: ProviderSettings }>('providers', {
      method: 'POST',
      body: {
        name: service,
        baseURL: `${models.origin}/v1`,
        kind: 'openai-compatible',
        models: ['fixture-model'],
        defaultModel: 'fixture-model',
        confirmOrigin: true,
      },
    })
    providerId = provider.id
    const { revision: baseRevision } = await owner.json<ModelSpend>('model-spend')
    await owner.json('model-budgets', {
      method: 'PUT',
      body: { scope: 'service', id: providerId, budget: { unit: 'tokens', limit: 25 }, baseRevision, requestId: randomUUID() },
    })
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(output, { recursive: true })
  })

  afterAll(async () => {
    await browser?.close()
    await host?.close()
    await models?.close()
  })

  const views = ([1440, 768, 390] as const).flatMap(width => (['light', 'dark'] as const).map(theme => ({ width, theme })))
  it.each(views)('keeps controls and known results visible at $width $theme', async ({ width, theme }) => {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      colorScheme: theme,
      reducedMotion: 'reduce',
      locale: 'zh-CN',
      ...(width < 768 ? { isMobile: true, hasTouch: true } : {}),
    })
    const page = await context.newPage()
    page.setDefaultTimeout(10_000)
    const holds: Array<Awaited<ReturnType<typeof holdRead>>> = []
    const hold = async (path: string) => {
      const result = await holdRead(page, path)
      holds.push(result)
      return result
    }
    const capture = (state: string) =>
      page.screenshot({
        path: resolve(output, `${state}--${width}--${theme}.png`),
        animations: 'disabled',
        caret: 'hide',
      })
    try {
      await enrollBrowser(page, host, { name: `设置读取 ${width} ${theme}`, scopes: ['view', 'run', 'admin'] })
      const settings = await openSettings(page)
      const add = settings.getByRole('button', { name: '添加模型服务', exact: true })
      const modelsSection = settings.getByRole('region', { name: '显示的模型', exact: true })
      const edit = settings.getByRole('button', { name: `编辑 ${service}`, exact: true })
      const coldProviders = await hold('providers')
      await openSection(settings, '模型')
      await coldProviders.wait()
      expect.soft(await add.isVisible()).toBe(true)
      expect.soft(await modelsSection.isVisible()).toBe(true)
      expect(await edit.count()).toBe(0)
      await capture('model-cold')
      coldProviders.release()
      await reachable(add)
      await reachable(edit)
      await noHorizontalOverflow(page)
      expect
        .soft(
          await page.evaluate(() =>
            performance
              .getEntriesByType('resource')
              .some(entry => /\/assets\/ProvidersSettings-[^/]+\.js$/u.test(new URL(entry.name).pathname)),
          ),
        )
        .toBe(false)
      await add.click()
      const dialog = page.getByRole('dialog', { name: '添加模型服务', exact: true })
      await dialog.waitFor()
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })

      // Back to 模型 from another section: what was read shows at once while it is read again.
      await openSection(settings, '通用')
      const warmProviders = await hold('providers')
      await openSection(settings, '模型')
      await warmProviders.wait()
      expect.soft(await edit.isVisible()).toBe(true)
      await capture('model-warm')
      warmProviders.release()
      await edit.waitFor()
      await noHorizontalOverflow(page)
    } finally {
      holds.forEach(item => item.release())
      await context.close()
    }
  })

  it('in 额度与用量, holds a skeleton of the final layout, keeps the last answer through a late result and retries only the failed read', async () => {
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: {
        harnessId: 'standard',
        mode: 'chat',
        model: { providerId, model: 'fixture-model' },
        prompt: '请回答。',
        requestId: randomUUID(),
      },
    })
    await vi.waitFor(async () => {
      expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
    })
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', colorScheme: 'dark' })
    const page = await context.newPage()
    const holds: Array<Awaited<ReturnType<typeof holdRead>>> = []
    try {
      await enrollBrowser(page, host)
      const usage = page.getByRole('dialog', { name: '额度与用量', exact: true })
      const pick = async (picker: string, option: string) => {
        await usage.getByRole('button', { name: new RegExp(`^${picker}：`, 'u') }).click()
        await page.getByRole('menuitemradio', { name: option, exact: true }).click()
      }
      // While the first read is held the view is a skeleton of the boxes that replace it: the rows land where it stood.
      const first = await holdRead(page, 'usage')
      holds.push(first)
      await page.keyboard.press('Alt+Shift+U')
      await usage.getByRole('radio', { name: '用量', exact: true }).click()
      await first.wait()
      const skeleton = usage.locator('.usage-skeleton')
      await skeleton.waitFor()
      const held = (await skeleton.locator('.usage-total').boundingBox())!
      await page.screenshot({ path: resolve(output, 'usage-skeleton--1440--dark.png'), animations: 'disabled' })
      first.release()
      await usage.locator('.usage-shown').waitFor()
      const landed = (await usage.locator('.usage-total').boundingBox())!
      expect([landed.x, landed.y]).toEqual([held.x, held.y])
      const top = (await usage.locator('.ui-modal-surface').boundingBox())!.y
      await pick('分组', '按服务')
      const row = usage.getByRole('rowheader', { name: service, exact: true })
      await row.waitFor()

      // Another grouping: the last answer stays, marked busy, until the next lands; a late answer to an older
      // question never replaces the one asked for.
      const shown = usage.locator('.usage-shown')
      const pendingModel = await holdRead(page, 'usage')
      holds.push(pendingModel)
      await pick('分组', '按模型')
      await pendingModel.wait()
      expect(await row.isVisible()).toBe(true)
      expect(await shown.getAttribute('aria-busy')).toBe('true')
      // The surface keeps its top edge whatever it shows: only its bottom moves.
      expect((await usage.locator('.ui-modal-surface').boundingBox())!.y).toBe(top)

      const pendingService = await holdRead(page, 'usage')
      holds.push(pendingService)
      await pick('分组', '按服务')
      await pendingService.wait()
      pendingModel.release()
      await pendingModel.delivered
      expect(await row.isVisible()).toBe(true)
      expect(await usage.getByRole('rowheader', { name: /fixture-model/u }).count()).toBe(0)
      pendingService.release()
      await pendingService.delivered
      await expect.poll(() => shown.getAttribute('aria-busy')).toBe('false')

      const failure = '暂时无法读取这个期间的用量。'
      await page.route(
        '**/link/api/usage',
        route =>
          route.fulfill({
            status: 503,
            json: { error: 'fixture-usage-unavailable', message: failure },
          }),
        { times: 1 },
      )
      await usage.getByRole('radio', { name: '7 天', exact: true }).click()
      await usage.getByText(failure).waitFor()
      // The failure says the last answer is still what is shown, and only that read is tried again.
      expect(await usage.locator('.ui-notice, [role="alert"], [role="status"]').filter({ hasText: failure }).textContent()).toContain(
        '当前显示上次读取结果',
      )
      expect(await usage.getByRole('radio', { name: '7 天', exact: true }).getAttribute('aria-checked')).toBe('true')
      await page.screenshot({ path: resolve(output, 'usage-failure--1440--dark.png'), animations: 'disabled' })
      await usage.getByRole('button', { name: '重试', exact: true }).click()
      await usage.getByText(failure).waitFor({ state: 'hidden' })
      await row.waitFor()
    } finally {
      holds.forEach(item => item.release())
      await context.close()
    }
  })

  it('discards the provider read when its authority is removed and later restored', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.setDefaultTimeout(12_000)
    const holds: Array<Awaited<ReturnType<typeof holdRead>>> = []
    try {
      const name = '设置权限变化'
      await enrollBrowser(page, host, { name, scopes: ['view', 'admin'] })
      const device = host.host.security.devices.list().find(item => item.name === name)!
      const scopes = [...device.scopes]
      const settings = await openSettings(page)
      await openSection(settings, '模型')
      const edit = settings.getByRole('button', { name: `编辑 ${service}`, exact: true })
      const tab = settings.getByRole('tab', { name: '模型', exact: true })
      await edit.waitFor()
      await openSection(settings, '通用')

      const old = await holdRead(page, 'providers')
      holds.push(old)
      await openSection(settings, '模型')
      await old.wait()
      await edit.waitFor()
      await owner.json(`devices/${device.id}`, { method: 'PATCH', body: { scopes: ['view'] } })
      await tab.waitFor({ state: 'detached' })
      expect(await edit.count()).toBe(0)
      const current = await holdRead(page, 'providers')
      holds.push(current)
      await owner.confirmedJson(`devices/${device.id}`, { method: 'PATCH', body: { scopes } })
      await page.evaluate(() => {
        document.dispatchEvent(new Event('visibilitychange'))
        window.dispatchEvent(new Event('focus'))
      })
      await tab.waitFor()
      await openSection(settings, '模型')
      await current.wait()
      await settings.getByText('正在读取模型服务…', { exact: true }).waitFor()
      old.release()
      await old.delivered
      expect(await edit.count()).toBe(0)
      current.release()
      await edit.waitFor()
    } finally {
      holds.forEach(item => item.release())
      await context.close()
    }
  })

  it('removes an open phone service page as soon as its read is denied', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 900 }, isMobile: true, hasTouch: true })
    const page = await context.newPage()
    page.setDefaultTimeout(12_000)
    const holds: Array<Awaited<ReturnType<typeof holdRead>>> = []
    try {
      const name = '手机设置读取拒绝'
      await enrollBrowser(page, host, { name, scopes: ['view', 'admin'] })
      const device = host.host.security.devices.list().find(item => item.name === name)!
      const settings = await openSettings(page)
      const row = settings.getByRole('button', { name: `编辑 ${service}`, exact: true })
      await openSection(settings, '模型')
      await row.waitFor()
      await openSection(settings, '通用')

      const snapshot = await holdRead(page, 'snapshot')
      const refused = await holdRead(page, 'providers')
      holds.push(snapshot, refused)
      await owner.json(`devices/${device.id}`, { method: 'PATCH', body: { scopes: ['view'] } })
      await openSection(settings, '模型')
      await refused.wait()
      await row.click()
      const privatePage = settings.locator('.settings-level')
      const editAddress = privatePage.getByRole('button', { name: '修改…', exact: true })
      await editAddress.waitFor()
      expect(await editAddress.isDisabled()).toBe(true)
      refused.release()
      await settings.getByRole('button', { name: '重试', exact: true }).waitFor()
      expect(await privatePage.count()).toBe(0)
      expect(await row.count()).toBe(0)
    } finally {
      holds.forEach(item => item.release())
      await context.close()
    }
  })

  it('keeps a completed service edit when the previous read is delivered afterwards', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.setDefaultTimeout(12_000)
    const holds: Array<Awaited<ReturnType<typeof holdRead>>> = []
    let releaseWrite: (() => void) | undefined
    try {
      await enrollBrowser(page, host, { scopes: ['view', 'admin'] })
      const settings = await openSettings(page)
      await openSection(settings, '模型')
      await settings.getByRole('button', { name: `编辑 ${service}`, exact: true }).click()
      const pending = new Promise<void>(done => {
        releaseWrite = done
      })
      const routePath = `/link/api/providers/${providerId}`
      let intercepted = false
      await page.route(
        `**${routePath}`,
        async route => {
          intercepted = true
          await pending
          await route.continue()
        },
        { times: 1 },
      )
      await settings.getByRole('switch', { name: '启用', exact: true }).click()
      await expect.poll(() => intercepted).toBe(true)
      await openSection(settings, '通用')
      const stale = await holdRead(page, 'providers')
      holds.push(stale)
      await openSection(settings, '模型')
      await stale.wait()
      const changed = settings.locator('.provider-row[data-dim]')
      expect(await changed.count()).toBe(0)

      const saved = page.waitForResponse(
        response => new URL(response.url()).pathname === routePath && response.request().method() === 'PUT',
      )
      const fresh = await holdRead(page, 'providers')
      holds.push(fresh)
      releaseWrite?.()
      expect((await saved).status()).toBe(200)
      await fresh.wait()
      fresh.release()
      await changed.waitFor()
      stale.release()
      await stale.delivered
      expect(await changed.isVisible()).toBe(true)
    } finally {
      releaseWrite?.()
      holds.forEach(item => item.release())
      await context.close()
      await owner.json(`providers/${providerId}`, { method: 'PUT', body: { enabled: true } })
    }
  })

  it.each(['before', 'after'] as const)('reconciles an old write replying %s the newer read', async order => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.setDefaultTimeout(12_000)
    const holds: Array<Awaited<ReturnType<typeof holdRead>>> = []
    const route = `providers/${providerId}`
    try {
      await enrollBrowser(page, host, { scopes: ['view', 'admin'] })
      const settings = await openSettings(page)
      const row = settings.getByRole('button', { name: `编辑 ${service}`, exact: true })
      const disabledService = settings.locator('.provider-row[data-dim]')
      await openSection(settings, '模型')
      await row.click()

      const first = await holdRead(page, route)
      holds.push(first)
      await settings.getByRole('switch', { name: '启用', exact: true }).click()
      await first.wait()

      await openSection(settings, '通用')
      await openSection(settings, '模型')
      await disabledService.waitFor()
      await row.click()
      await page.route(`**/link/api/${route}`, request => request.continue(), { times: 1 })
      const next = order === 'before' ? await holdRead(page, 'providers') : undefined
      if (next) holds.push(next)
      const committed = page.waitForResponse(response => new URL(response.url()).pathname === `/link/api/${route}`)
      await settings.getByRole('switch', { name: '启用', exact: true }).click()
      expect((await committed).status()).toBe(200)
      if (next) await next.wait()
      await openSection(settings, '模型')
      if (order === 'after') await disabledService.waitFor({ state: 'detached' })

      const reconciled = await holdRead(page, 'providers')
      holds.push(reconciled)
      first.release()
      await first.delivered
      await reconciled.wait()
      if (order === 'after') expect(await disabledService.count()).toBe(0)
      if (next) {
        next.release()
        await next.delivered
      }
      reconciled.release()
      await disabledService.waitFor({ state: 'detached' })
      await row.waitFor()
    } finally {
      holds.forEach(item => item.release())
      await context.close()
      await owner.json(route, { method: 'PUT', body: { enabled: true } })
    }
  })

  it('clears a target conflict after a new edit succeeds', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.setDefaultTimeout(12_000)
    const route = `providers/${providerId}`
    const baseURL = `${models.origin}/v1`
    let moved = false
    try {
      await enrollBrowser(page, host, { scopes: ['view', 'admin'] })
      const settings = await openSettings(page)
      await openSection(settings, '模型')
      await settings.getByRole('button', { name: `编辑 ${service}`, exact: true }).click()
      const modify = settings.getByRole('button', { name: '修改…', exact: true })
      await modify.click()
      const address = page.getByRole('dialog', { name: '修改地址', exact: true })
      await address.getByRole('textbox', { name: '地址', exact: true }).fill(`${baseURL}/fixture`)
      await owner.json(route, {
        method: 'PUT',
        body: { kind: 'openai-responses', expectedTarget: { baseURL, kind: 'openai-compatible' } },
      })
      moved = true
      await address.getByRole('button', { name: '保存', exact: true }).click()
      await address.waitFor({ state: 'hidden' })
      const error = settings.getByText('模型服务的地址或协议已变更。请核对当前设置后重试。', { exact: true })
      await error.waitFor()
      await expect.poll(() => modify.isEnabled()).toBe(true)
      await settings.getByRole('switch', { name: '启用', exact: true }).click()
      await error.waitFor({ state: 'detached' })
    } finally {
      await context.close()
      if (moved)
        await owner.json(route, {
          method: 'PUT',
          body: { enabled: true, kind: 'openai-compatible', expectedTarget: { baseURL, kind: 'openai-responses' } },
        })
    }
  })
})
