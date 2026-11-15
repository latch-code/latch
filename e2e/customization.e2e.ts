import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  resolvableTokens,
  type AppSnapshot,
  type CustomizationDocument,
  type CustomizationReceipt,
  type Device,
  type TaskDetail,
} from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import type { TestDevice } from '@latch/testkit'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { closeSettings, openSection, openSession, openSettings, reachable } from './helpers/layout.ts'

const OUTPUT = 'test-results/customization'

/** A model that always calls a tool the Host does not know, so its approval waits (R2). */
const highRiskFixture: HarnessPlugin = {
  id: 'r2-fixture',
  name: '高风险工具验收插件',
  version: '1.0.0',
  description: '仅测试使用。',
  activate(context) {
    context.registerTool({
      name: 'touch_marker',
      description: '测试用工具，不访问文件。',
      parameters: { type: 'object', properties: {} },
      requiresApproval: false,
      async execute() {
        return { text: 'marker touched' }
      },
    })
    context.registerProvider({
      id: 'r2-model',
      name: 'R2 fixture',
      model: 'fixture',
      async *stream({ messages }) {
        if (messages.at(-1)?.role === 'tool') {
          yield { type: 'text', text: '工具调用已结算。' }
          yield { type: 'finish', reason: 'stop' }
          return
        }
        yield { type: 'tool-call', call: { id: 'call-r2', name: 'touch_marker', arguments: {} } }
        yield { type: 'finish', reason: 'tool-calls' }
      },
    })
  },
}

/** The furthest a valid document goes from the default. */
const EXTREME: CustomizationDocument = {
  schema: 1,
  appearance: { accentHue: 195, radius: 'round', textSize: 'large' },
}
const DEFAULT: CustomizationDocument = { schema: 1, appearance: {} }

const PROPERTIES = [
  'color',
  'background-color',
  'border-top-color',
  'border-top-left-radius',
  'border-bottom-right-radius',
  'box-shadow',
  'outline-color',
  'font-size',
  'line-height',
  'font-family',
  'padding-top',
  'padding-left',
  'row-gap',
  'column-gap',
  'opacity',
  'display',
  'visibility',
  'fill',
  'stroke',
] as const
/** The tokens a customisation may set: the same list as `CUSTOM_TOKENS` of the design system (apps/web/test/customization.test.ts). */
const CUSTOM_TOKENS = resolvableTokens()
const PINNED = '[data-secure], [data-secure] *, [data-lock], [data-lock] *'

/** What every security surface and pinned mark on the page computes, with the tokens a customisation may set. */
const pinnedLook = (page: Page) =>
  page.locator(PINNED).evaluateAll(
    (elements, [properties, tokens]) =>
      elements.map(element => {
        const style = getComputedStyle(element)
        return [...properties!, ...tokens!].map(name => style.getPropertyValue(name).trim()).join('|')
      }),
    [[...PROPERTIES], [...CUSTOM_TOKENS]] as const,
  )
const rootToken = (page: Page, name: string) =>
  page.evaluate(token => getComputedStyle(document.documentElement).getPropertyValue(token).trim(), name)
const settledColours = (page: Page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(animation => animation instanceof CSSTransition)
        .map(animation => animation.finished.catch(() => undefined)),
    ),
  )

describe('customisation: 外观 as data, and the way back to the default', () => {
  let host: TestHost
  let owner: TestDevice
  let browser: Browser
  let waiting = ''

  const state = async () => (await owner.json<AppSnapshot>('snapshot')).customization!
  const apply = async (doc: CustomizationDocument) =>
    owner.json<CustomizationReceipt>('customization', {
      method: 'POST',
      body: { requestId: randomUUID(), baseRevision: (await state()).revision, doc },
    })
  const reset = async () =>
    owner.json<CustomizationReceipt>('customization/reset', {
      method: 'POST',
      body: { requestId: randomUUID(), baseRevision: (await state()).revision },
    })

  beforeAll(async () => {
    host = await startTestHost({
      demo: true,
      uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
      plugins: [highRiskFixture],
    })
    owner = await host.enroll({ listener: 'unix', name: '本机桌面端' })
    waiting = (
      await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { prompt: '改一个文件', requestId: randomUUID(), mode: 'agent', model: { providerId: 'r2-model', model: 'fixture' } },
      })
    ).sessionId
    await vi.waitFor(async () => expect((await owner.json<TaskDetail>(`tasks/${waiting}`)).approvals).toHaveLength(1))
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
  })

  async function open(
    width: number,
    theme: 'light' | 'dark' = 'light',
    name = `验收 ${width} ${theme}`,
  ): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      colorScheme: theme,
      reducedMotion: 'reduce',
      locale: 'zh-CN',
    })
    context.setDefaultTimeout(15_000)
    const page = await context.newPage()
    await enrollBrowser(page, host, { name, scopes: ['view', 'run', 'admin'] })
    return { context, page }
  }

  it('previews a choice on this page, saves it on 应用, and every other device follows without a reload', async () => {
    await reset()
    const { context, page } = await open(1440)
    const other = await open(390)
    try {
      const settings = await openSettings(page)
      await openSection(settings, '通用')
      const group = settings.locator('.settings-group', { hasText: '自定义' })
      const before = {
        radius: await rootToken(page, '--r-8'),
        accent: await rootToken(page, '--accent'),
        revision: (await state()).revision,
      }
      await group.getByRole('radiogroup', { name: '圆角' }).getByRole('radio', { name: '圆', exact: true }).click()
      await group.getByRole('radiogroup', { name: '主色' }).getByRole('radio', { name: '紫', exact: true }).click()
      // A preview: this page changes, the Host and the other device do not.
      expect(await rootToken(page, '--r-8')).toBe('12px')
      expect(await rootToken(page, '--accent')).not.toBe(before.accent)
      expect((await state()).revision).toBe(before.revision)
      expect(await rootToken(other.page, '--r-8')).toBe(before.radius)
      await page.screenshot({ path: `${OUTPUT}/settings-preview-1440-light.png`, animations: 'disabled' })
      await group.evaluate(element => element.scrollIntoView({ block: 'center' }))
      const bounds = await group.boundingBox()
      expect(bounds!.y).toBeGreaterThanOrEqual(0)
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
      await page.screenshot({ path: `${OUTPUT}/settings-preview-actions-1440-light.png`, animations: 'disabled' })
      await group.getByRole('button', { name: '应用', exact: true }).click()
      await expect.poll(async () => (await state()).doc).toEqual({ schema: 1, appearance: { accentHue: 305, radius: 'round' } })
      await expect.poll(() => rootToken(other.page, '--r-8')).toBe('12px')
      // The history names the revision, and going back to an earlier one writes a new revision.
      await group.getByText('应用', { exact: true }).first().waitFor()
      await group.getByRole('radiogroup', { name: '圆角' }).getByRole('radio', { name: '方', exact: true }).click()
      await group.getByRole('button', { name: '应用', exact: true }).click()
      await expect.poll(async () => (await state()).doc.appearance.radius).toBe('sharp')
      await group.getByRole('button', { name: '回退', exact: true }).first().click()
      await expect.poll(async () => (await state()).doc.appearance.radius).toBe('round')
      await group.getByRole('button', { name: '恢复默认', exact: true }).click()
      await expect.poll(async () => (await state()).doc).toEqual(DEFAULT)
      await expect.poll(() => rootToken(other.page, '--r-8')).toBe(before.radius)
      await expect.poll(() => rootToken(page, '--accent')).toBe(before.accent)
    } finally {
      await context.close()
      await other.context.close()
    }
  })

  for (const width of [1440, 768, 390])
    for (const theme of ['light', 'dark'] as const)
      it(`leaves every security surface and pinned mark as it was under the furthest valid document (${width}, ${theme})`, async () => {
        await reset()
        const { context, page } = await open(width, theme)
        try {
          // The approval card, then 设置 › 设备 with a device's permissions.
          await openSession(page, waiting)
          const allow = page.locator('[data-approval-id]').getByRole('button', { name: '允许', exact: true })
          await expect.poll(() => allow.isEnabled()).toBe(true)
          await page.mouse.move(0, 0)
          await settledColours(page)
          const approval = await pinnedLook(page)
          expect(approval.length).toBeGreaterThan(10)
          const freeBefore = await rootToken(page, '--r-8')
          await apply(EXTREME)
          await expect.poll(() => rootToken(page, '--r-8')).toBe('12px')
          expect(freeBefore).toBe('8px')
          await expect.poll(() => allow.isEnabled()).toBe(true)
          await settledColours(page)
          expect(await pinnedLook(page)).toEqual(approval)
          await page.screenshot({ path: `${OUTPUT}/approval-customised-${width}-${theme}.png`, animations: 'disabled' })
          await reachable(allow)

          await reset()
          await expect.poll(() => rootToken(page, '--r-8')).toBe('8px')
          const settings = await openSettings(page, '设备')
          // The lock wrapper mounts before the device list arrives.
          await settings.getByText('本机桌面端', { exact: true }).waitFor()
          await page.mouse.move(0, 0)
          await settledColours(page)
          const devices = await pinnedLook(page)
          await apply(EXTREME)
          await expect.poll(() => rootToken(page, '--r-8')).toBe('12px')
          await settledColours(page)
          expect(await pinnedLook(page)).toEqual(devices)
          await page.screenshot({ path: `${OUTPUT}/devices-customised-${width}-${theme}.png`, animations: 'disabled' })

          // Far worse than a document can carry: every customisable token, on the root, in the customisation's own layer.
          await page.evaluate(
            names => {
              const style = document.createElement('style')
              style.id = 'hostile-custom'
              const value = (name: string) =>
                name.startsWith('--sh-') ? '0 0 0 9999px rgb(255, 0, 0)' : /^--(?:r|fs|lh)-/u.test(name) ? '0px' : 'transparent'
              style.textContent = `@layer custom { :root { ${names.map(name => `${name}: ${value(name)} !important;`).join(' ')} } }`
              document.head.append(style)
            },
            [...CUSTOM_TOKENS],
          )
          expect(await rootToken(page, '--accent')).toBe('transparent')
          await settledColours(page)
          expect(await pinnedLook(page)).toEqual(devices)
          await page.evaluate(() => document.getElementById('hostile-custom')?.remove())
        } finally {
          await context.close()
        }
      })

  it('opens with the default look from /link/#safe, says so in one row that covers nothing, and 恢复默认 ends it', async () => {
    await reset()
    await apply(EXTREME)
    const { context, page } = await open(1440)
    try {
      await expect.poll(() => rootToken(page, '--r-8')).toBe('12px')
      await openSession(page, waiting)
      await page.locator('[data-approval-id]').waitFor()
      const url = new URL(page.url())
      await page.goto(`${url.origin}/link/#safe`)
      await page.reload()
      await connected(page)
      const banner = page.locator('.safe-banner')
      await banner.waitFor()
      // The fragment is read and gone; the page shows the product's own tokens.
      expect(new URL(page.url()).hash).toBe('')
      expect(await rootToken(page, '--r-8')).toBe('8px')
      expect(await banner.textContent()).toBe('默认外观恢复默认')
      // The banner has a row of its own: the page starts under it and ends inside the window, with the approval in view.
      await openSession(page, waiting)
      const card = page.locator('[data-approval-id]')
      await card.waitFor()
      const [bannerBox, shellBox, cardBox] = await Promise.all([
        banner.boundingBox(),
        page.locator('.app-shell').boundingBox(),
        card.boundingBox(),
      ])
      expect(shellBox!.y).toBeGreaterThanOrEqual(bannerBox!.y + bannerBox!.height - 0.5)
      expect(shellBox!.y + shellBox!.height).toBeLessThanOrEqual(900.5)
      expect(cardBox!.y).toBeGreaterThanOrEqual(bannerBox!.y + bannerBox!.height)
      expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(900.5)
      await page.screenshot({ path: `${OUTPUT}/safe-mode-1440-light.png`, animations: 'disabled' })
      // The keys leave safe mode and enter it again; a reload stays in it.
      await page.keyboard.press('Control+Alt+Shift+Digit0')
      await banner.waitFor({ state: 'detached' })
      expect(await rootToken(page, '--r-8')).toBe('12px')
      await page.keyboard.press('Control+Alt+Shift+Digit0')
      await banner.waitFor()
      await page.reload()
      await connected(page)
      await banner.waitFor()
      expect(await rootToken(page, '--r-8')).toBe('8px')
      await banner.getByRole('button', { name: '恢复默认', exact: true }).click()
      await expect.poll(async () => (await state()).doc).toEqual(DEFAULT)
      await banner.waitFor({ state: 'detached' })
    } finally {
      await context.close()
    }
  })

  it('keeps the original preview revision when another device saves while the draft is open', async () => {
    const original = await apply({ schema: 1, appearance: { accentHue: 215, radius: 'sharp' } })
    const {
      host: { hostId },
    } = await owner.json<AppSnapshot>('snapshot')
    const { context, page } = await open(1440, 'light', '编辑旧外观的浏览器')
    try {
      const settings = await openSettings(page)
      await openSection(settings, '通用')
      const group = settings.locator('.settings-group', { hasText: '自定义' })
      await group.getByRole('radiogroup', { name: '圆角' }).getByRole('radio', { name: '圆', exact: true }).click()
      expect(await rootToken(page, '--r-8')).toBe('12px')

      const updated = await apply({ schema: 1, appearance: { accentHue: 305, radius: 'sharp' } })
      await expect
        .poll(() =>
          page.evaluate(id => {
            const entry = localStorage.getItem(`latch.customization.doc.${id}`)
            return entry && JSON.parse(entry).revision
          }, hostId),
        )
        .toBe(updated.revision)
      const sent = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/link/api/customization'))
      await group.getByRole('button', { name: '应用', exact: true }).click()
      expect((await sent).postDataJSON()).toMatchObject({ baseRevision: original.revision })
      await group.getByText('外观已在别处修改，放弃草稿后重新编辑。', { exact: true }).waitFor()
      expect((await state()).doc).toEqual(updated.doc)

      await group.getByRole('button', { name: '放弃', exact: true }).click()
      await group.getByRole('radiogroup', { name: '圆角' }).getByRole('radio', { name: '圆', exact: true }).click()
      const next = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/link/api/customization'))
      await group.getByRole('button', { name: '应用', exact: true }).click()
      expect((await next).postDataJSON()).toMatchObject({ baseRevision: updated.revision })
      await expect
        .poll(state)
        .toEqual({ revision: updated.revision + 1, doc: { schema: 1, appearance: { accentHue: 305, radius: 'round' } } })
    } finally {
      await context.close()
    }
  })

  it('keeps the reset request when leaving settings, switching to safe mode and losing permission', async () => {
    const before = await apply(EXTREME)
    const { context, page } = await open(768, 'dark', '重试外观的浏览器')
    try {
      const { devices } = await owner.json<{ devices: Device[] }>('devices')
      const enrolled = devices.find(item => item.name === '重试外观的浏览器')!
      const requests: unknown[] = []
      await page.route('**/link/api/customization/reset', async route => {
        requests.push(route.request().postDataJSON())
        if (requests.length === 1) await route.abort('failed')
        else if (requests.length === 2) {
          await route.fulfill({
            status: 403,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'scope-required', message: '此设备没有「管理此 Host」权限' }),
          })
        } else await route.continue()
      })
      const settings = await openSettings(page)
      await openSection(settings, '通用')
      const group = settings.locator('.settings-group', { hasText: '自定义' })
      await group.getByRole('button', { name: '恢复默认', exact: true }).click()
      await group.getByText('结果未知', { exact: true }).waitFor()
      expect(requests).toEqual([{ requestId: expect.any(String), baseRevision: before.revision }])

      await closeSettings(settings)
      await settings.waitFor({ state: 'detached' })
      await page.evaluate(() => {
        window.location.hash = 'safe'
      })
      const banner = page.locator('.safe-banner')
      await banner.getByText('结果未知', { exact: true }).waitFor()
      const retry = banner.getByRole('button', { name: '重试同一请求', exact: true })
      await retry.click()
      await expect.poll(() => requests.length).toBe(2)
      await banner.getByText('结果未知', { exact: true }).waitFor()

      await owner.json(`devices/${enrolled.id}`, { method: 'PATCH', body: { scopes: ['view', 'run'] } })
      await retry.waitFor({ state: 'detached' })
      await banner.getByRole('button', { name: '放弃等待', exact: true }).waitFor()
      await openSettings(page)
      await openSection(settings, '通用')
      await group.getByText('结果未知', { exact: true }).waitFor()
      expect(await group.getByRole('button', { name: '重试同一请求' }).count()).toBe(0)
      await page.screenshot({ path: `${OUTPUT}/unknown-after-scope-change-768-dark.png`, animations: 'disabled' })

      const restored = await owner.confirmed(`devices/${enrolled.id}`, { method: 'PATCH', body: { scopes: enrolled.scopes } })
      expect(restored.status).toBe(200)
      await retry.click()
      await expect.poll(async () => (await state()).doc).toEqual(DEFAULT)
      await banner.waitFor({ state: 'detached' })
      expect(requests).toEqual([requests[0], requests[0], requests[0]])
    } finally {
      await context.close()
    }
  })

  it('shows the default after a load that never finished, on a phone too, and says where a device without 管理此 Host goes', async () => {
    await reset()
    const receipt = await apply(EXTREME)
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', locale: 'zh-CN' })
    context.setDefaultTimeout(15_000)
    const page = await context.newPage()
    try {
      await enrollBrowser(page, host, { name: '手机', scopes: ['view', 'run'] })
      await expect.poll(() => rootToken(page, '--r-8')).toBe('12px')
      // Simulate the unfinished load after the previous page has cleared its own mark during pagehide.
      const {
        host: { hostId },
      } = await owner.json<AppSnapshot>('snapshot')
      const appearance = Object.fromEntries(Object.entries(receipt.doc.appearance).sort(([a], [b]) => a.localeCompare(b)))
      const marker = JSON.stringify([hostId, receipt.revision, { appearance, schema: receipt.doc.schema }])
      await page.addInitScript(identity => localStorage.setItem('latch.customization.applying', identity), marker)
      await page.reload()
      await connected(page)
      const banner = page.locator('.safe-banner')
      await banner.waitFor()
      expect(await rootToken(page, '--r-8')).toBe('8px')
      expect(await banner.getByRole('button').count()).toBe(0)
      expect(await banner.textContent()).toContain('上恢复')
      await page.screenshot({ path: `${OUTPUT}/safe-mode-390-light.png`, animations: 'disabled' })
      // Another revision from the Host is tried, and the banner goes.
      await apply({ schema: 1, appearance: { radius: 'sharp' } })
      await banner.waitFor({ state: 'detached' })
      await expect.poll(() => rootToken(page, '--r-8')).toBe('6px')
    } finally {
      await context.close()
    }
  })
})
