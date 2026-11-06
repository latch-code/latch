import { chromium, type Browser, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { latchEnv } from '@latch/host/env'
import type { ProviderSettings } from '@latch/protocol'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSection, openSettings } from './helpers/layout.ts'

const OUTPUT = 'test-results/settings-pages'
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, touch: true },
  { name: 'tablet', width: 768, height: 1024, touch: true },
  { name: 'desktop', width: 1440, height: 900, touch: false },
] as const

/**
 * Each settings page as a person meets it, drawn from what a real Host and a local model service answer: 已连接 only after
 * the service answered, 密钥无效 after it refused the key, 连不上 when nothing answers, and 检测中 while it is still asked.
 */
/** Lets a selection finish its fade before the picture is taken. */
const settle = (page: Page) => page.waitForTimeout(200)

describe('settings pages', () => {
  let testHost: TestHost
  let browser: Browser
  let service: Server
  let release: () => void = () => {}
  let add: (name: string, path: string, extra?: Record<string, unknown>) => Promise<unknown> = async () => {}
  let savedProviders: () => Promise<ProviderSettings[]> = async () => []
  let laterRefuses = false
  const held = new Promise<void>(resolved => {
    release = resolved
  })

  beforeAll(async () => {
    service = createServer((request, response) => {
      const send = (status: number) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: [{ id: 'fixture-small' }, { id: 'fixture-large' }] }))
      }
      if (request.url?.startsWith('/refused/')) send(401)
      else if (request.url?.startsWith('/slow/')) void held.then(() => send(200))
      else if (request.url?.startsWith('/later/')) send(laterRefuses ? 401 : 200)
      else send(200)
    })
    await new Promise<void>(done => service.listen(0, '127.0.0.1', done))
    const { port } = service.address() as AddressInfo
    testHost = await startTestHost({
      uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
      egressAllow: [`127.0.0.1:${port}`],
    })
    const local = await testHost.enroll({ listener: 'unix', name: '本机桌面端' })
    add = (name: string, path: string, extra: Record<string, unknown> = {}) =>
      local.confirmed('providers', {
        method: 'POST',
        body: {
          name,
          kind: 'openai-compatible',
          baseURL: `http://127.0.0.1:${port}/${path}/v1`,
          apiKey: 'settings-fixture-key',
          models: ['fixture-small', 'fixture-large'],
          defaultModel: 'fixture-small',
          confirmOrigin: true,
          ...extra,
        },
      })
    savedProviders = async () => ((await (await local.request('providers')).json()) as { providers: ProviderSettings[] }).providers
    await add('能连上的服务', 'ok')
    await add('密钥不对的服务', 'refused')
    await add('还在回答的服务', 'slow')
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    release()
    await browser?.close()
    await testHost?.close()
    await new Promise(done => service?.close(done))
  })

  for (const viewport of VIEWPORTS)
    for (const colorScheme of ['light', 'dark'] as const)
      it(`draws every page at ${viewport.name} in ${colorScheme}`, async () => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          hasTouch: viewport.touch,
          isMobile: viewport.name === 'phone',
          colorScheme,
          deviceScaleFactor: 1,
          locale: 'zh-CN',
          reducedMotion: 'reduce',
        })
        context.setDefaultTimeout(15_000)
        const page = await context.newPage()
        const shot = (name: string) => page.screenshot({ path: `${OUTPUT}/${name}--${viewport.name}--${colorScheme}.png` })
        await enrollBrowser(page, testHost, {
          name: `${viewport.name}-${colorScheme}`,
          scopes: ['view', 'run', 'approve:standard', 'admin'],
        })
        const settings = await openSettings(page)
        if (viewport.name === 'phone') {
          await shot('sections')
          await openSection(settings, '通用')
        }
        await settings.getByRole('radio', { name: '跟随系统' }).waitFor()
        await noHorizontalOverflow(page, settings)
        await shot('general')

        await openSection(settings, '模型')
        await settings.getByRole('heading', { name: '服务', exact: true }).waitFor()
        await settings.getByText('检测中', { exact: true }).waitFor()
        await settings.getByText('已连接', { exact: true }).waitFor()
        await settings.getByText('密钥无效', { exact: true }).waitFor()
        // A browser cannot take a key: the way out is drawn, disabled, and says where to go.
        await settings.getByRole('button', { name: '更新密钥', exact: true }).waitFor()
        await settings.getByRole('heading', { name: '用量', exact: true }).waitFor()
        await settings.getByRole('heading', { name: '显示的模型', exact: true }).waitFor()
        await noHorizontalOverflow(page, settings)
        await shot('models')

        // 用量: the total and the table from what the Host recorded, then the same period when it cannot be read.
        await settings.getByRole('searchbox', { name: '搜索模型' }).waitFor()
        await page.route('**/link/api/usage', route =>
          route.fulfill({
            json: {
              days: 30,
              from: '2026-10-02',
              to: '2026-11-01',
              rows: [
                {
                  harnessId: 'standard',
                  model: 'fixture-small',
                  source: 'provider',
                  messages: 12,
                  usage: { inputTokens: 1_920_000, outputTokens: 214_000 },
                  partial: { cacheReadTokens: false, cacheWriteTokens: false, reasoningTokens: false },
                },
                {
                  harnessId: 'codex',
                  source: 'agent',
                  messages: 3,
                  usage: { inputTokens: 846_000, outputTokens: 92_400 },
                  partial: { cacheReadTokens: false, cacheWriteTokens: false, reasoningTokens: false },
                },
              ],
              unattributedMessages: 0,
              truncated: false,
            },
          }),
        )
        await settings.getByRole('radio', { name: '30 天' }).click()
        await settings.getByText('3.07M', { exact: true }).waitFor()
        await settings.getByRole('cell', { name: '214k' }).waitFor()
        await noHorizontalOverflow(page, settings)
        await settings.getByRole('heading', { name: '用量', exact: true }).scrollIntoViewIfNeeded()
        await settle(page)
        await shot('usage')
        await page.unroute('**/link/api/usage')
        await page.route('**/link/api/usage', route =>
          route.fulfill({ status: 500, json: { error: { code: 'internal', message: '读不到用量' } } }),
        )
        await settings.getByRole('radio', { name: '7 天' }).click()
        await settings.locator('.settings-group', { hasText: '用量' }).locator('.ui-notice, [role="alert"]').first().waitFor()
        await settle(page)
        await shot('usage-failed')
        await page.unroute('**/link/api/usage')

        await settings.getByRole('button', { name: '添加服务', exact: true }).click()
        const sheet = page.getByRole('dialog', { name: '添加服务' })
        await sheet.getByRole('button', { name: 'DeepSeek', exact: true }).click()
        await sheet.getByLabel('地址', { exact: true }).waitFor()
        await shot('models-add')
        await sheet.getByRole('button', { name: '取消', exact: true }).click()
        await sheet.waitFor({ state: 'hidden' })

        await openSection(settings, 'Harness')
        await settings.getByRole('heading', { name: '已安装', exact: true }).waitFor()
        await settings.getByRole('heading', { name: '可以安装', exact: true }).waitFor()
        await noHorizontalOverflow(page, settings)
        await shot('engines')

        await openSection(settings, '项目')
        await settings.getByRole('heading', { name: '项目', exact: true }).waitFor()
        await settings.getByText('每个会话保留最近 20 轮', { exact: false }).waitFor()
        await noHorizontalOverflow(page, settings)
        await shot('projects')

        if (viewport.name !== 'phone') {
          await openSection(settings, '快捷键')
          await settings.getByRole('heading', { name: '快捷键', exact: true }).waitFor()
          await shot('shortcuts')
        }

        await openSection(settings, '关于')
        await settings.getByText('Harness 和插件以你的权限在这台电脑上运行。', { exact: true }).waitFor()
        await noHorizontalOverflow(page, settings)
        await shot('about')

        await openSection(settings, '插件')
        await page.locator('.plugin-nav-row', { hasText: '项目文件' }).click()
        // A plugin's page says where its code runs, in the same words the plugin form uses.
        await page.getByRole('heading', { name: '代码在哪里运行', exact: true }).waitFor()
        await page.getByText('在这台 Mac 上运行，权限和 Latch 相同', { exact: false }).waitFor()
        await settle(page)
        await shot('plugins')

        // Nothing in settings draws a box around rows.
        const boxed = await settings.locator('.settings-card').evaluateAll(
          cards =>
            cards.filter(card => {
              const style = getComputedStyle(card)
              return style.borderTopWidth !== '0px' || style.borderTopLeftRadius !== '0px'
            }).length,
        )
        expect(boxed).toBe(0)
        await context.close()
      })

  it('keeps a service row with its page, and the add sheet open while it saves', async () => {
    await add('后来拒绝的服务', 'later')
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
    context.setDefaultTimeout(15_000)
    const page = await context.newPage()
    await enrollBrowser(page, testHost, { name: 'row-and-sheet', scopes: ['view', 'run', 'approve:standard', 'admin'] })
    const settings = await openSettings(page)
    await openSection(settings, '模型')
    const row = settings.locator('.provider-row', { hasText: '后来拒绝的服务' })
    await row.getByText('已连接', { exact: true }).waitFor()

    // A check on the service's page that fails is what the row says when the person comes back.
    laterRefuses = true
    await row.getByRole('button', { name: '编辑 后来拒绝的服务' }).click()
    await settings.getByRole('button', { name: '检测连接', exact: true }).click()
    await settings.getByText('密钥不对或已过期', { exact: false }).waitFor()
    await settings.locator('.settings-back').click()
    await row.getByText('密钥无效', { exact: true }).waitFor()

    // While the save is on its way, Esc and the other tiles leave the form and its outcome where the person can see them.
    let finish: () => void = () => {}
    const holding = new Promise<void>(resolved => {
      finish = resolved
    })
    await page.route('**/link/api/providers', async route => {
      if (route.request().method() === 'POST') await holding
      await route.continue()
    })
    await settings.getByRole('button', { name: '添加服务', exact: true }).click()
    const sheet = page.getByRole('dialog', { name: '添加服务' })
    await sheet.getByRole('button', { name: '自定义', exact: true }).click()
    await sheet.getByLabel('名称', { exact: true }).fill('保存中的服务')
    await sheet.getByLabel('地址', { exact: true }).fill('https://models.example.test/v1')
    const manual = sheet.getByLabel('手动添加模型 ID', { exact: true })
    await manual.fill('held-model')
    await manual.press('Enter')
    await sheet.getByRole('button', { name: '保存服务', exact: true }).click()
    await expect.poll(() => sheet.getByRole('button', { name: 'DeepSeek', exact: true }).isDisabled()).toBe(true)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    expect(await sheet.isVisible()).toBe(true)
    finish()
    await sheet.waitFor({ state: 'hidden' })
    await settings.locator('.provider-row', { hasText: '保存中的服务' }).waitFor()
    await context.close()
  })

  it('adds a service on the protocol it chose, and changes the protocol on its page', async () => {
    await add('换协议的服务', 'ok', { models: ['fixture-small'], modelCapabilities: { 'fixture-small': { thinking: ['low', 'high'] } } })
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
    context.setDefaultTimeout(15_000)
    const page = await context.newPage()
    await enrollBrowser(page, testHost, { name: 'protocols', scopes: ['view', 'run', 'approve:standard', 'admin'] })
    const settings = await openSettings(page)
    await openSection(settings, '模型')

    // OpenAI starts on Responses and still offers Chat Completions; a preset that speaks one protocol has no choice.
    await settings.getByRole('button', { name: '添加服务', exact: true }).click()
    const sheet = page.getByRole('dialog', { name: '添加服务' })
    await sheet.getByRole('button', { name: 'OpenAI', exact: true }).click()
    // The select's name carries its value too, so it is found by the start of its name.
    const protocol = sheet.getByRole('combobox', { name: /^协议/u })
    expect(await protocol.inputValue()).toBe('openai-responses')
    expect(await protocol.locator('option').allTextContents()).toEqual(['Responses', 'Chat Completions'])
    await sheet.getByRole('button', { name: 'DeepSeek', exact: true }).click()
    await sheet.getByLabel('地址', { exact: true }).waitFor()
    expect(await protocol.count()).toBe(0)

    // A custom service offers all four, and is saved on the one picked.
    await sheet.getByRole('button', { name: '自定义', exact: true }).click()
    expect(await protocol.locator('option').allTextContents()).toEqual(['Chat Completions', 'Responses', 'Anthropic Messages', 'Gemini'])
    await protocol.selectOption({ label: 'Gemini' })
    await sheet.getByLabel('名称', { exact: true }).fill('原生 Gemini 服务')
    await sheet.getByLabel('地址', { exact: true }).fill('https://models.example.test/v1beta')
    const manual = sheet.getByLabel('手动添加模型 ID', { exact: true })
    await manual.fill('gemini-fixture')
    await manual.press('Enter')
    await sheet.getByRole('button', { name: '保存服务', exact: true }).click()
    await sheet.waitFor({ state: 'hidden' })
    await settings.locator('.provider-row', { hasText: '原生 Gemini 服务' }).getByText('Gemini · 1 个模型', { exact: true }).waitFor()
    expect((await savedProviders()).find(item => item.name === '原生 Gemini 服务')?.kind).toBe('gemini')

    // On a saved service the row warns before the switch that the thinking levels go, and they do.
    const row = settings.locator('.provider-row', { hasText: '换协议的服务' })
    await row.getByText('Chat Completions · 1 个模型', { exact: true }).waitFor()
    await row.getByRole('button', { name: '编辑 换协议的服务' }).click()
    const hint = settings.getByText('换协议会清除为模型设置的思考深度', { exact: true })
    await hint.waitFor()
    await settings.getByRole('button', { name: '协议：Chat Completions', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'Responses', exact: true }).click()
    await settings.getByRole('button', { name: '协议：Responses', exact: true }).waitFor()
    await hint.waitFor({ state: 'detached' })
    const saved = (await savedProviders()).find(item => item.name === '换协议的服务')
    expect(saved?.kind).toBe('openai-responses')
    expect(saved?.modelCapabilities?.['fixture-small']?.thinking).toBeUndefined()

    // A reload reads the protocol back from the Host, on the list and on the page.
    await page.reload()
    const reloaded = await openSettings(page)
    await openSection(reloaded, '模型')
    const after = reloaded.locator('.provider-row', { hasText: '换协议的服务' })
    await after.getByText('Responses · 1 个模型', { exact: true }).waitFor()
    await after.getByRole('button', { name: '编辑 换协议的服务' }).click()
    await reloaded.getByRole('button', { name: '协议：Responses', exact: true }).waitFor()
    expect(await reloaded.getByText('换协议会清除为模型设置的思考深度', { exact: true }).count()).toBe(0)
    await settle(page)
    await page.screenshot({ path: `${OUTPUT}/service-protocol--desktop--light.png` })
    await context.close()
  })
})
