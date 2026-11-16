import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AppSnapshot, TaskDetail } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { recordClipboardWrites } from './helpers/clipboard.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSection, openSession, openSettings } from './helpers/layout.ts'

const OUTPUT = 'test-results/policy-limits'
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, touch: true },
  { name: 'tablet', width: 768, height: 1024, touch: true },
  { name: 'desktop', width: 1440, height: 900, touch: false },
] as const

const plugin: HarnessPlugin = {
  id: 'limit-models',
  description: '只在测试中提供模型。',
  name: '测试模型',
  version: '1',
  activate(context) {
    context.registerProvider({
      id: 'limit-models',
      name: '测试模型',
      model: 'model-a',
      models: ['model-a', 'model-b'],
      async *stream({ messages }) {
        const asked = messages.at(-1)
        if (asked?.role === 'user' && JSON.stringify(asked.content).includes('要等批准')) {
          yield { type: 'tool-call', call: { id: 'call-wait', name: 'limit_marker', arguments: {} } }
          yield { type: 'finish', reason: 'tool-calls' }
          return
        }
        yield { type: 'text', text: '完成' }
        yield { type: 'finish', reason: 'stop' }
      },
    })
    context.registerTool({
      name: 'limit_marker',
      description: '测试用工具，不访问文件。',
      parameters: { type: 'object', properties: {} },
      requiresApproval: false,
      async execute() {
        return { text: 'marked' }
      },
    })
  },
}

/**
 * The page as it stands in the desktop app: a shell, and a device on the Host's socket. Requests still arrive through
 * the browser's listener, so the Host-side rules for this computer are covered by the Host's tests and the Electron case.
 */
async function asThisComputer(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    ;(window as unknown as { latchShell: unknown }).latchShell = { kind: 'electron', platform: 'darwin', windowFocused: () => true }
  })
  await context.route('**/link/api/snapshot*', async route => {
    const response = await route.fetch()
    const snapshot = (await response.json()) as AppSnapshot
    await route.fulfill({ response, json: { ...snapshot, device: { ...snapshot.device, listener: 'unix' } } })
  })
}

/** A capture of a state must not be of the motion into it. A spinner never finishes, so it is not waited for. */
const motionDone = (page: Page) =>
  page.evaluate(async () => {
    const finite = document.getAnimations().filter(item => item.effect?.getComputedTiming().iterations !== Infinity)
    await Promise.allSettled(finite.map(item => item.finished))
    await new Promise(requestAnimationFrame)
  })

describe('what this computer can take back', () => {
  let host: TestHost
  let browser: Browser
  let service: Server
  let local: Awaited<ReturnType<TestHost['enroll']>>
  let address = ''

  beforeAll(async () => {
    service = createServer((_, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'local-model' }] }))
    })
    await new Promise<void>(done => service.listen(0, '127.0.0.1', done))
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
    const { port } = service.address() as AddressInfo
    address = `http://127.0.0.1:${port}/v1`
  })
  afterAll(async () => {
    await browser?.close()
    await new Promise(done => service?.close(done))
  })
  beforeEach(async () => {
    host = await startTestHost({ uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'), plugins: [plugin] })
    local = await host.enroll({ listener: 'unix', name: '本机桌面端' })
  })
  afterEach(async () => {
    await host?.close()
  })

  const confirmService = () =>
    local.confirmed('providers', {
      method: 'POST',
      body: {
        name: '本地服务',
        kind: 'openai-compatible',
        baseURL: address,
        models: ['local-model'],
        defaultModel: 'local-model',
        confirmOrigin: true,
      },
    })

  const open = async (
    viewport: (typeof VIEWPORTS)[number],
    colorScheme: 'light' | 'dark',
  ): Promise<{ page: Page; context: BrowserContext }> => {
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
    await enrollBrowser(page, host, { name: `${viewport.name}-${colorScheme}`, scopes: ['view', 'run', 'approve:standard', 'admin'] })
    await asThisComputer(context)
    await page.reload()
    await connected(page)
    return { page, context }
  }

  for (const viewport of VIEWPORTS)
    for (const colorScheme of ['light', 'dark'] as const)
      it(`lists and removes a confirmed address at ${viewport.name} in ${colorScheme}`, async () => {
        await confirmService()
        const { page, context } = await open(viewport, colorScheme)
        const shot = async (name: string) => {
          await motionDone(page)
          await page.screenshot({ path: `${OUTPUT}/${name}--${viewport.name}--${colorScheme}.png` })
        }
        const settings = await openSettings(page)
        await openSection(settings, '模型')
        const row = settings.locator('.address-row', { hasText: '127.0.0.1' })
        await row.getByText('本地服务 在用', { exact: false }).waitFor()
        await row.getByText('Latch 可以连接', { exact: false }).waitFor()
        await noHorizontalOverflow(page, settings)
        await row.scrollIntoViewIfNeeded()
        await shot('addresses')

        // A removal the Host refuses stays in the dialog and changes nothing.
        await page.route('**/link/api/policy', route =>
          route.request().method() === 'PATCH'
            ? route.fulfill({ status: 500, json: { error: 'internal', message: '写入失败' } })
            : route.continue(),
        )
        await row.getByRole('button', { name: '移除', exact: true }).click()
        const dialog = page.locator('.confirm-dialog')
        await dialog.getByText('本地服务', { exact: false }).waitFor()
        await shot('remove-confirm')
        await dialog.getByRole('button', { name: '移除', exact: true }).click()
        await dialog.getByText('写入失败', { exact: false }).waitFor()
        await shot('remove-failed')
        await page.unroute('**/link/api/policy')

        // In progress, then the real removal with no system confirmation: the Host never asked.
        let release: () => void = () => {}
        const held = new Promise<void>(done => {
          release = done
        })
        await page.route('**/link/api/policy', async route => {
          if (route.request().method() === 'PATCH') await held
          await route.continue()
        })
        await dialog.getByRole('button', { name: '移除', exact: true }).click()
        await page.waitForTimeout(200)
        await shot('remove-progress')
        release()
        await dialog.waitFor({ state: 'detached' })
        await page.unroute('**/link/api/policy')
        await row.waitFor({ state: 'detached' })
        const policy = await local.json<{ policy: { confirmedAddresses: string[]; hostEgressAllow: string[] } }>('policy')
        expect(policy.policy.confirmedAddresses).toEqual([])
        expect(policy.policy.hostEgressAllow).toEqual([])
        await settings.locator('.provider-row', { hasText: '本地服务' }).getByText('未确认', { exact: true }).waitFor()
        await shot('removed')

        await context.close()
      })

  it('still says a removal went unrecorded when it empties the list', async () => {
    await confirmService()
    const { page, context } = await open(VIEWPORTS[2], 'light')
    await page.route('**/link/api/policy', async route => {
      if (route.request().method() !== 'PATCH') return route.continue()
      const response = await route.fetch()
      await route.fulfill({ response, headers: { ...response.headers(), 'x-latch-audit': 'failed' } })
    })
    const settings = await openSettings(page)
    await openSection(settings, '模型')
    const row = settings.locator('.address-row', { hasText: '127.0.0.1' })
    await row.getByRole('button', { name: '移除', exact: true }).click()
    await page.locator('.confirm-dialog').getByRole('button', { name: '移除', exact: true }).click()
    await row.waitFor({ state: 'detached' })
    await page.locator('.confirm-dialog').waitFor({ state: 'detached' })
    await settings.getByText('改动已生效，但没有写入记录', { exact: true }).waitFor()
    await motionDone(page)
    await page.screenshot({ path: `${OUTPUT}/removed-unrecorded--desktop--light.png` })
    await context.close()
  })

  it('keeps confirmed addresses to this computer: other devices see no such group', async () => {
    await confirmService()
    const remote = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
    const elsewhere = await remote.newPage()
    await enrollBrowser(elsewhere, host, { name: 'elsewhere', scopes: ['view', 'run', 'approve:standard', 'admin'] })
    const there = await openSettings(elsewhere)
    await openSection(there, '模型')
    await there.getByRole('heading', { name: '模型服务', exact: true }).waitFor()
    await elsewhere.waitForTimeout(300)
    expect(await there.getByRole('heading', { name: '已确认的地址', exact: true }).count()).toBe(0)
    await remote.close()
  })

  it('sets where new sessions start from the model menu, says so, and returns there after one session on another model', async () => {
    const { page, context } = await open(VIEWPORTS[2], 'light')
    // The page's requests arrive on the browser listener here, so the pin goes through this computer's own device.
    await page.route('**/link/api/preferences', async route => {
      const response = await local.request('preferences', { method: 'PUT', body: route.request().postDataJSON() as object })
      await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() })
    })
    const picker = page.locator('.composer-stack .model-picker').filter({ visible: true })
    await picker.click()
    await page.getByRole('menuitemradio', { name: /model-a/u }).click()
    const harness = page.locator('.composer-stack .harness-picker').filter({ visible: true })
    await harness.click()
    await page.getByRole('menuitem', { name: '设为新会话默认' }).click()
    // The pin says itself: 取消新会话默认 and its icon, without a sentence.
    await page.getByRole('menuitem', { name: '取消新会话默认' }).waitFor()
    await page.screenshot({ path: `${OUTPUT}/pinned--desktop--light.png` })
    await page.keyboard.press('Escape')

    // Another model for this one session.
    await picker.click()
    await page.getByRole('menuitemradio', { name: /model-b/u }).click()
    // A pick is the draft's alone, so a reload is back at the pin.
    await expect.poll(() => picker.textContent()).toContain('model-b')
    await page.reload()
    await connected(page)
    await expect.poll(() => picker.textContent()).toContain('model-a')
    await picker.click()
    await page.getByRole('menuitemradio', { name: /model-b/u }).click()
    await page.locator('.composer-stack textarea').filter({ visible: true }).fill('这一次用另一个模型')
    await page
      .locator('.composer-stack')
      .filter({ visible: true })
      .getByRole('button', { name: /发送|开始/u })
      .click()
    await expect
      .poll(async () => {
        const { tasks } = await local.json<{ tasks: Array<{ id: string }> }>('snapshot')
        const detail = tasks[0] && (await local.json<TaskDetail>(`tasks/${tasks[0].id}`))
        return detail?.summary.status
      })
      .toBe('idle')

    await page.getByText('新会话', { exact: true }).first().click()
    await expect.poll(() => picker.textContent()).toContain('model-a')
    await page.screenshot({ path: `${OUTPUT}/pinned-next-draft--desktop--light.png` })

    // Another device neither sees the pin nor starts from it: it keeps its own last choice.
    const remote = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
    const elsewhere = await remote.newPage()
    await enrollBrowser(elsewhere, host, { name: 'elsewhere', scopes: ['view', 'run', 'approve:standard', 'admin'] })
    const there = elsewhere.locator('.composer-stack .model-picker').filter({ visible: true })
    await there.click()
    await elsewhere.getByRole('menuitemradio', { name: /model-b/u }).click()
    await elsewhere.reload()
    await connected(elsewhere)
    await expect.poll(() => there.textContent()).toContain('model-b')
    await elsewhere.locator('.composer-stack .harness-picker').filter({ visible: true }).click()
    expect(await elsewhere.getByRole('menuitem', { name: /新会话默认/u }).count()).toBe(0)
    await elsewhere.keyboard.press('Escape')
    await remote.close()

    // Taking it back: the last pick carries on again.
    await harness.click()
    await page.getByRole('menuitem', { name: '取消新会话默认' }).click()
    await page.getByRole('menuitem', { name: '设为新会话默认' }).waitFor()
    expect((await local.json<AppSnapshot>('snapshot')).catalog!.defaults.pinned).toBeUndefined()
    await page.keyboard.press('Escape')
    await context.close()
  })

  it('reports a pin that failed in the menu, and leaves the choice unset', async () => {
    const { page, context } = await open(VIEWPORTS[2], 'dark')
    await page.route('**/link/api/preferences', route => route.fulfill({ status: 500, json: { error: 'internal', message: '没有保存' } }))
    await page.locator('.composer-stack .harness-picker').filter({ visible: true }).click()
    await page.getByRole('menuitem', { name: '设为新会话默认' }).click()
    await page.getByText('没有保存', { exact: false }).waitFor()
    await page.screenshot({ path: `${OUTPUT}/pin-failed--desktop--dark.png` })
    await page.keyboard.press('Escape')
    await context.close()
  })

  for (const viewport of VIEWPORTS)
    it(`keeps a toast off the composer at ${viewport.name}`, async () => {
      const created = await local.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { prompt: '说一句话', requestId: randomUUID(), model: { providerId: 'limit-models', model: 'model-a' } },
      })
      await expect.poll(async () => (await local.json<TaskDetail>(`tasks/${created.sessionId}`)).summary.status).toBe('idle')
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        hasTouch: viewport.touch,
        isMobile: viewport.name === 'phone',
        locale: 'zh-CN',
        reducedMotion: 'reduce',
      })
      context.setDefaultTimeout(15_000)
      const page = await context.newPage()
      await enrollBrowser(page, host, { name: `toast-${viewport.name}`, scopes: ['view', 'run', 'approve:standard', 'admin'] })
      await openSession(page, created.sessionId)
      const composer = page.locator('.composer-stack:visible').first()
      await composer.waitFor()
      if (viewport.name === 'phone') {
        // The model menu lives elsewhere on a phone: copying from the session menu draws a toast in the same place.
        const copied = await recordClipboardWrites(page)
        await page.locator('.topbar-title-button').click()
        await page.getByRole('menuitem', { name: /复制.*Markdown/u }).click()
        await expect.poll(copied).toEqual([expect.stringContaining('说一句话')])
      } else {
        await composer.locator('.model-picker').click()
        await page.getByRole('menuitemradio', { name: /model-b/u }).click()
      }
      const toast = page.locator('.toast')
      await toast.waitFor()
      const clearOfComposer = async (name: string) => {
        await expect
          .poll(async () => {
            const [toastBox, composerBox] = await Promise.all([toast.boundingBox(), composer.boundingBox()])
            return composerBox!.y - (toastBox!.y + toastBox!.height)
          })
          .toBeGreaterThanOrEqual(0)
        await motionDone(page)
        await page.screenshot({ path: `${OUTPUT}/${name}--${viewport.name}.png` })
      }
      await clearOfComposer('toast')
      // Taller toasts reach the composer's centre from their resting place, which must not read as covering it.
      await page.route('**/link/api/tasks/*', route =>
        route.request().method() === 'PATCH'
          ? route.fulfill({
              status: 500,
              json: {
                error: 'internal',
                message: '没有保存这次改动：这台 Mac 上的 Latch 刚才没有回答，请等它恢复之后再试一次，草稿和会话都还在原处。',
              },
            })
          : route.continue(),
      )
      await page.locator('.topbar-title-button').click()
      await page.getByRole('menuitem', { name: /置顶/u }).click()
      await page.getByText('没有保存这次改动', { exact: false }).waitFor()
      await clearOfComposer('toast-wrapped')
      const waiting = await local.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { prompt: '要等批准', requestId: randomUUID(), mode: 'agent', model: { providerId: 'limit-models', model: 'model-a' } },
      })
      await expect.poll(async () => (await local.json<TaskDetail>(`tasks/${waiting.sessionId}`)).approvals.length).toBe(1)
      await page.getByText('另一个会话等你处理', { exact: false }).waitFor()
      await clearOfComposer('toast-approval')
      await context.close()
    })
})
