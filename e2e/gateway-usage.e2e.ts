import { chromium, type Browser, type Locator } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CustomAgent, ModelSpend, ModelSpendReceipt, ProviderSettings, TaskDetail } from '@latch/protocol'
import { startFakeModels, type FakeModels, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSection, openSettings } from './helpers/layout.ts'

const OUTPUT = 'test-results/gateway-usage'
const MODEL = 'fake-model'
const AGENT_NAME = '用量测试 Agent'
const NOW = Date.parse('2026-11-15T04:00:00Z')

describe('model usage in settings', () => {
  let browser: Browser
  let host: TestHost
  let owner: TestDevice
  let primary: FakeModels
  let backup: FakeModels

  let primaryId: string

  const readSpend = () => owner.json<ModelSpend>('model-spend')
  const putSpend = async (route: 'model-prices' | 'model-budgets', values: object) => {
    const { revision: baseRevision } = await readSpend()
    return owner.json<ModelSpendReceipt>(route, { method: 'PUT', body: { ...values, requestId: randomUUID(), baseRevision } })
  }
  const limit = async (limit: number) => putSpend('model-budgets', { scope: 'service', id: primaryId, budget: { unit: 'tokens', limit } })
  const currentLimit = async () => (await readSpend()).budgets.find(budget => budget.scope === 'service' && budget.id === primaryId)?.limit

  beforeAll(async () => {
    const reply = { text: '已完成。', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.25 } }
    primary = await startFakeModels({ replies: [reply] })
    backup = await startFakeModels({ replies: [reply, reply] })
    host = await startTestHost({ demo: false, hostName: '用量测试 Mac', now: () => NOW })
    owner = await host.enroll({ listener: 'unix' })
    const add = (name: string, baseURL: string) =>
      owner.confirmedJson<{ provider: ProviderSettings }>('providers', {
        method: 'POST',
        body: { name, kind: 'openai-compatible', baseURL, models: [MODEL], defaultModel: MODEL, confirmOrigin: true },
      })
    const { provider: first } = await add('主服务', `${primary.origin}/v1`)
    primaryId = first.id
    const { provider: second } = await add('备用服务', `${backup.origin}/v1`)
    await owner.json(`providers/${first.id}`, {
      method: 'PUT',
      body: { fallbacks: { [MODEL]: [{ providerId: second.id, model: MODEL }] } },
    })
    const model = { providerId: first.id, model: MODEL }
    const agent = await owner.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: { name: AGENT_NAME, model, harnessId: 'standard', mode: 'chat', requestId: randomUUID() },
    })
    for (const [providerId, currency] of [
      [first.id, 'USD'],
      [second.id, 'CNY'],
    ] as const)
      await putSpend('model-prices', { providerId, model: MODEL, prices: { currency, input: 1000, output: 1000 } })
    await limit(15)
    await putSpend('model-budgets', { scope: 'agent', id: agent.id, budget: { unit: 'tokens', limit: 25 } })
    const send = async (target: { customAgentId: string } | { model: typeof model; mode: 'chat'; harnessId: 'standard' }) => {
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { ...target, prompt: '请回答。', requestId: randomUUID() },
      })
      await vi.waitFor(async () => {
        expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
      })
    }
    await send({ model, harnessId: 'standard', mode: 'chat' })
    await send({ customAgentId: agent.id })
    await send({ customAgentId: agent.id })
    expect(primary.requests).toHaveLength(1)
    expect(backup.requests).toHaveLength(2)
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
  })

  afterAll(async () => {
    await browser?.close()
    await host?.close()
    await primary?.close()
    await backup?.close()
  })

  const open = async (width: number, colorScheme: 'light' | 'dark', purpose = '汇总', admin = false) => {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      colorScheme,
      locale: 'zh-CN',
      reducedMotion: 'reduce',
      ...(width < 768 ? { isMobile: true, hasTouch: true } : {}),
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await page.clock.setFixedTime(NOW)
    const name = `用量浏览器 ${width} ${colorScheme} ${purpose}`
    await enrollBrowser(page, host, { name, scopes: admin ? ['view', 'run', 'admin'] : ['view', 'run'] })
    const id = host.host.security.devices.list().find(device => device.name === name)!.id
    await owner.confirmedJson(`devices/${id}`, { method: 'PATCH', body: { dataScope: 'all' } })
    await page.reload()
    await connected(page)
    const settings = await openSettings(page)
    await openSection(settings, '用量')
    return {
      page,
      id,
      settings,
      usage: settings.getByRole('region', { name: '用量', exact: true }),
      budgets: settings.getByRole('region', { name: '本月预算', exact: true }),
    }
  }

  async function openPrimary(settings: Locator) {
    await openSection(settings, '模型')
    await settings.getByRole('button', { name: '编辑 主服务', exact: true }).click()
    await settings.getByRole('heading', { name: '主服务', exact: true }).waitFor()
  }

  it.each([1440, 768, 390])('edits and reads model prices at %i in both themes', async width => {
    for (const theme of ['light', 'dark'] as const) {
      const { page, settings } = await open(width, theme, '设置单价', true)
      try {
        await openPrimary(settings)
        const dialog = page.getByRole('dialog', { name: '单价', exact: true })
        const show = async () => {
          await settings.getByText('已填单价', { exact: true }).waitFor()
          await settings.getByRole('button', { name: `${MODEL} 的更多设置`, exact: true }).click()
          await page.getByRole('menuitem', { name: '单价…', exact: true }).click()
          await dialog.waitFor()
        }
        await show()
        const unit = dialog.locator('.settings-form').getByText('每百万 tokens', { exact: true })
        expect(await unit.isVisible()).toBe(true)
        const input = dialog.getByRole('textbox', { name: '输入', exact: true })
        const output = dialog.getByRole('textbox', { name: '输出', exact: true })
        await expect.poll(() => input.inputValue()).toBe('1000')
        await input.fill('1100')
        await output.fill('1300')
        await noHorizontalOverflow(page, dialog)
        await page.screenshot({ path: `${OUTPUT}/prices--${theme}--${width}.png`, animations: 'disabled', caret: 'hide' })
        await dialog.getByRole('button', { name: '保存', exact: true }).click()
        await dialog.waitFor({ state: 'hidden' })
        expect((await readSpend()).prices.find(price => price.providerId === primaryId && price.model === MODEL)).toMatchObject({
          currency: 'USD',
          input: 1100,
          output: 1300,
        })
      } finally {
        await putSpend('model-prices', { providerId: primaryId, model: MODEL, prices: { currency: 'USD', input: 1000, output: 1000 } })
        await page.context().close()
      }
    }
  })

  it('shows manual pricing in separate currencies, the answering fallback, and budgets in three widths and both themes', async () => {
    for (const width of [1440, 768, 390])
      for (const theme of ['light', 'dark'] as const) {
        const { page, usage, budgets } = await open(width, theme)
        const rows = usage.getByRole('row')
        const primaryRow = rows.filter({ has: page.getByRole('rowheader', { name: '主服务', exact: true }) })
        const backupRow = rows.filter({ has: page.getByRole('rowheader', { name: '备用服务', exact: true }) })
        await expect.poll(() => primaryRow.getByRole('cell').allTextContents()).toEqual(['1', '0', '0', '10', '5', '$0.0150按你填的单价'])
        await expect.poll(() => backupRow.getByRole('cell').allTextContents()).toEqual(['2', '0', '2', '20', '10', '¥0.0300按你填的单价'])
        await budgets.getByText(AGENT_NAME, { exact: true }).waitFor()
        await expect.poll(() => budgets.getByText('本月预算已用完', { exact: true }).count()).toBe(2)
        await noHorizontalOverflow(page)
        await page.screenshot({ path: `${OUTPUT}/usage--${theme}--${width}.png`, animations: 'disabled' })
        await page.context().close()
      }
  })

  it('removes old aggregate rows and the Agent budget before the narrower reads reply', async () => {
    const { page, id, usage, budgets } = await open(390, 'dark', '降权')
    let releaseOld!: () => void
    let releaseNew!: () => void
    const oldReady = new Promise<void>(resolve => {
      releaseOld = resolve
    })
    const newReady = new Promise<void>(resolve => {
      releaseNew = resolve
    })
    let narrowed = false
    let oldUsage = false
    let oldFinished = false
    let newUsage = false
    let newSpend = false
    try {
      await usage.getByRole('radio', { name: 'Agent', exact: true }).click()
      const privateRow = usage.getByRole('rowheader', { name: AGENT_NAME, exact: true })
      await privateRow.waitFor()
      await budgets.getByText(AGENT_NAME, { exact: true }).waitFor()
      await page.route('**/link/api/model-usage', async route => {
        const beforeChange = !narrowed
        if (beforeChange && route.request().postDataJSON().period === '7') {
          await route.abort()
          return
        }
        const response = await route.fetch()
        if (beforeChange) {
          oldUsage = response.ok()
          await oldReady
          await route.fulfill({ response }).catch(() => {})
          oldFinished = true
        } else {
          newUsage = response.ok()
          await newReady
          await route.fulfill({ response })
        }
      })
      await page.route('**/link/api/model-spend', async route => {
        if (!narrowed) {
          await route.continue()
          return
        }
        const response = await route.fetch()
        newSpend = response.ok()
        await newReady
        await route.fulfill({ response }).catch(() => {})
      })
      await usage.getByRole('radio', { name: '7 天', exact: true }).click()
      await usage.getByRole('radio', { name: '本月', exact: true }).click()
      await expect.poll(() => oldUsage).toBe(true)
      await privateRow.waitFor()
      narrowed = true
      await owner.json(`devices/${id}`, { method: 'PATCH', body: { dataScope: 'work' } })
      await expect.poll(() => newUsage && newSpend).toBe(true)
      await privateRow.waitFor({ state: 'hidden' })
      await budgets.getByText(AGENT_NAME, { exact: true }).waitFor({ state: 'hidden' })
      releaseOld()
      await expect.poll(() => oldFinished).toBe(true)
      expect(await privateRow.count()).toBe(0)
      releaseNew()
      await usage.getByRole('rowheader', { name: '其他', exact: true }).waitFor()
      await budgets.getByText('主服务', { exact: true }).waitFor()
      expect(await budgets.getByText(AGENT_NAME, { exact: true }).count()).toBe(0)
      await page.screenshot({ path: `${OUTPUT}/restricted--dark--390.png`, animations: 'disabled' })
    } finally {
      releaseOld()
      releaseNew()
      await page.context().close()
    }
  })

  it('retains a lost budget write across closing the dialog and reads back another device’s later change', async () => {
    const { page, id, settings } = await open(1440, 'light', '预算回执', true)
    const dialog = page.getByRole('dialog', { name: '本月预算', exact: true })
    const row = settings.locator('.budget-row')
    const url = '**/link/api/model-budgets'
    const attempts: unknown[] = []
    page.on('request', request => {
      if (request.method() === 'PUT' && new URL(request.url()).pathname === '/link/api/model-budgets') attempts.push(request.postDataJSON())
    })
    try {
      await openPrimary(settings)
      const change = () => row.getByRole('button', { name: '修改', exact: true }).click()
      await change()
      const amount = dialog.getByRole('textbox', { name: '每月上限' })
      const save = dialog.getByRole('button', { name: '保存', exact: true })
      await amount.fill('50')
      await page.route(
        url,
        async route => {
          const receipt = await route.fetch()
          expect(receipt.ok()).toBe(true)
          await route.abort('failed')
        },
        { times: 1 },
      )
      await save.click()
      await dialog.getByText('结果未知', { exact: true }).waitFor()
      expect(await currentLimit()).toBe(50)

      await limit(35)
      await dialog.locator('.ui-dialog-footer').getByRole('button', { name: '关闭', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
      await change()
      await dialog.getByText('结果未知', { exact: true }).waitFor()
      await page.screenshot({ path: `${OUTPUT}/budget-unknown--light--1440.png`, animations: 'disabled' })

      await owner.json(`devices/${id}`, { method: 'PATCH', body: { scopes: ['view', 'run'] } })
      await dialog.waitFor({ state: 'hidden' })
      expect(await page.getByText('结果未知', { exact: true }).count()).toBe(0)
      await owner.confirmedJson(`devices/${id}`, { method: 'PATCH', body: { scopes: ['view', 'run', 'admin'] } })
      await page.evaluate(() => {
        document.dispatchEvent(new Event('visibilitychange'))
        window.dispatchEvent(new Event('focus'))
      })
      await openPrimary(settings)
      await change()
      await dialog.getByText('结果未知', { exact: true }).waitFor()
      await dialog.getByRole('button', { name: '载入当前设置', exact: true }).click()
      await expect.poll(() => amount.inputValue()).toBe('35')
      expect(await dialog.getByText('结果未知', { exact: true }).count()).toBe(1)
      const answer = page.waitForResponse(response => new URL(response.url()).pathname === '/link/api/model-budgets')
      await dialog.getByRole('button', { name: '重试同一请求', exact: true }).click()
      expect(await (await answer).json()).toMatchObject({ ok: true, replayed: true })
      await dialog.waitFor({ state: 'hidden' })
      expect(attempts).toHaveLength(2)
      expect(attempts[0]).toEqual(attempts[1])
      expect(await currentLimit()).toBe(35)

      // A fresh editor also needs to read a newer value before offering a fresh save.
      await change()
      await amount.fill('82')
      await limit(45)
      await save.click()
      await dialog.getByText('已在别处修改', { exact: true }).waitFor()
      await expect.poll(() => save.isDisabled()).toBe(true)
      expect(await currentLimit()).toBe(45)
      await dialog.getByRole('button', { name: '载入当前设置', exact: true }).click()
      await expect.poll(() => amount.inputValue()).toBe('45')
      await amount.fill('48')
      await save.click()
      await dialog.waitFor({ state: 'hidden' })
      expect(await currentLimit()).toBe(48)
      expect(attempts).toHaveLength(4)
      expect(attempts[2]).not.toEqual(attempts[3])
    } finally {
      await limit(15)
      await page.context().close()
    }
  })
})
