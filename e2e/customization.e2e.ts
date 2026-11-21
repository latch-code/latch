import { chromium, type Browser, type BrowserContext, type Cookie, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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
import {
  closeSettings,
  noHorizontalOverflow,
  openSection,
  openSession,
  openSettings,
  phoneStartScreen,
  permissionControl,
  reachable,
} from './helpers/layout.ts'

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
  'backdrop-filter',
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
const background = (locator: Locator) => locator.evaluate(element => getComputedStyle(element).backgroundColor)
const floatingLook = (locator: Locator) =>
  locator.evaluate(element => {
    const style = getComputedStyle(element)
    const canvas = document.createElement('canvas').getContext('2d')!
    canvas.fillStyle = style.backgroundColor
    canvas.fillRect(0, 0, 1, 1)
    return { filter: style.backdropFilter, alpha: canvas.getImageData(0, 0, 1, 1).data[3] }
  })
const FROSTED = { filter: 'blur(18px) saturate(1.14)', alpha: 209 }
const SOLID = { filter: 'none', alpha: 255 }

async function transparency(context: BrowserContext, page: Page, theme: 'light' | 'dark') {
  const cdp = await context.newCDPSession(page)
  return (value: 'no-preference' | 'reduce') =>
    cdp.send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-color-scheme', value: theme },
        { name: 'prefers-reduced-motion', value: 'reduce' },
        { name: 'prefers-reduced-transparency', value },
      ],
    })
}
const shownAccent = (page: Page) =>
  page.evaluate(() => {
    const sample = document.createElement('span')
    sample.style.color = 'var(--accent)'
    document.body.append(sample)
    const accent = getComputedStyle(sample).color
    sample.remove()
    return accent
  })
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
      hostName: '外观验收',
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
    scopes: Device['scopes'] = ['view', 'run', 'admin'],
  ): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      colorScheme: theme,
      reducedMotion: 'reduce',
      locale: 'zh-CN',
    })
    context.setDefaultTimeout(15_000)
    const page = await context.newPage()
    await enrollBrowser(page, host, { name, scopes })
    return { context, page }
  }

  it('previews and saves a workbench palette on one device while preserving Host settings and the approval', async () => {
    const shared = await apply(EXTREME)
    const { context, page } = await open(1440)
    const other = await open(390, 'dark', '只读配色验收', ['view'])
    try {
      await openSession(page, waiting)
      await page.locator('[data-approval-id]').waitFor()
      await page.mouse.move(0, 0)
      await settledColours(page)
      const before = await pinnedLook(page)
      expect(before.length).toBeGreaterThan(10)
      const settings = await openSettings(page)
      await openSection(settings, '外观')
      const palettes = settings.getByRole('radiogroup', { name: '工作台配色' })
      await palettes.getByRole('radio', { name: '黑白' }).focus()
      await page.keyboard.press('ArrowLeft')
      const warm = palettes.getByRole('radio', { name: '暖灰' })
      expect(await warm.getAttribute('aria-checked')).toBe('true')
      const preview = await background(warm.locator('.appearance-palette'))
      const canvas = page.locator('main.workspace')
      await expect.poll(() => background(canvas)).toBe(preview)
      const themes = settings.getByRole('radiogroup', { name: '主题' })
      for (const [label, theme] of [
        ['浅色', 'light'],
        ['深色', 'dark'],
      ] as const) {
        await themes.getByRole('radio', { name: label, exact: true }).click()
        const colors = new Set<string>()
        for (const name of ['黑白', '墨灰', '雾蓝', '暖灰']) {
          const choice = palettes.getByRole('radio', { name, exact: true })
          const previewEditor = await background(choice.locator('.appearance-palette-composer'))
          await choice.click()
          const tile = await background(choice.locator('.appearance-palette'))
          const rail = await background(page.locator('.app-shell > .sidebar'))
          const editor = await background(canvas.locator('.composer'))
          expect(await background(canvas)).toBe(tile)
          expect(rail).toBe(await background(choice.locator('.appearance-palette-rail')))
          expect(editor).toBe(previewEditor)
          if (theme === 'dark' && name === '黑白') expect([tile, rail, editor]).toEqual(['rgb(0, 0, 0)', 'rgb(8, 8, 8)', 'rgb(12, 12, 12)'])
          colors.add(tile)
        }
        expect(colors.size).toBe(4)
        await page.screenshot({ path: `${OUTPUT}/palette-1440-${theme}.png`, animations: 'disabled' })
      }
      await themes.getByRole('radio', { name: '浅色', exact: true }).click()
      await settings.getByRole('radiogroup', { name: '设备主色' }).getByRole('radio', { name: '鸢尾紫', exact: true }).click()
      await settings.getByRole('radiogroup', { name: '密度' }).getByRole('radio', { name: '紧凑' }).click()
      await closeSettings(settings)
      await page.mouse.move(0, 0)
      await settledColours(page)
      const after = await pinnedLook(page)
      const changed = after.flatMap((computed, index) => (computed === before[index] ? [] : [index]))
      const elements = await page
        .locator(PINNED)
        .evaluateAll(
          (pinned, indexes) => indexes.map(index => pinned[index]?.closest('[data-secure], [data-lock]')?.getAttribute('class')),
          changed,
        )
      expect(after, elements.join(', ')).toEqual(before)

      await page.reload()
      await connected(page)
      await openSession(page, waiting)
      expect(await page.locator('html').getAttribute('data-palette')).toBe('warm')
      expect(await page.locator('html').getAttribute('data-device-accent')).toBe('iris')
      expect(await page.locator('html').getAttribute('data-density')).toBe('compact')
      expect(await other.page.locator('html').getAttribute('data-palette')).toBe('mono')

      const otherSettings = await openSettings(other.page)
      await openSection(otherSettings, '外观')
      const otherPalette = otherSettings.getByRole('radiogroup', { name: '工作台配色' })
      await otherPalette.getByRole('radio', { name: '墨灰' }).click()
      expect(await other.page.locator('html').getAttribute('data-palette')).toBe('graphite')
      expect(await otherSettings.getByRole('radiogroup', { name: '圆角' }).count()).toBe(0)
      await noHorizontalOverflow(other.page, otherPalette)
      await other.page.screenshot({ path: `${OUTPUT}/palette-390-dark.png`, animations: 'disabled' })
      const otherAccent = otherSettings.getByRole('radiogroup', { name: '设备主色' })
      await otherAccent.getByRole('radio', { name: '青绿', exact: true }).click()
      await noHorizontalOverflow(other.page, otherAccent)
      await other.page.screenshot({ path: `${OUTPUT}/accent-390-dark.png`, animations: 'disabled' })
      expect(await page.locator('html').getAttribute('data-palette')).toBe('warm')
      expect(await state()).toEqual({ revision: shared.revision, doc: EXTREME })

      await page.keyboard.press('Control+Alt+Shift+Digit0')
      await page.locator('.safe-banner').waitFor()
      expect(await rootToken(page, '--r-8')).toBe('8px')
      expect(await background(canvas)).toBe(preview)
    } finally {
      await context.close()
      await other.context.close()
    }
  })

  it('lets a device choose an accent independently, while keeping the Host editor preview and other devices in sync', async () => {
    await reset()
    const { context, page } = await open(1440)
    const other = await open(390, 'light', '查看主色的只读设备', ['view'])
    try {
      const settings = await openSettings(page)
      await openSection(settings, '外观')
      const accents = settings.getByRole('radiogroup', { name: '设备主色' })
      const preview = (name: string) => accents.getByRole('radio', { name, exact: true }).locator('[data-variant="primary"]')
      const themes = settings.getByRole('radiogroup', { name: '主题' })
      await themes.getByRole('radio', { name: '深色', exact: true }).click()
      const factory = await shownAccent(page)
      expect(await background(preview('跟随工作台'))).toBe(factory)
      const followInk = () => preview('跟随工作台').evaluate(element => getComputedStyle(element).color)
      expect(await followInk()).toBe('rgb(25, 25, 25)')
      const shared = await apply(EXTREME)
      await expect.poll(() => shownAccent(page)).not.toBe(factory)
      await expect.poll(() => background(preview('跟随工作台'))).toBe(await shownAccent(page))
      expect(await followInk()).toBe('rgb(255, 255, 255)')
      await themes.getByRole('radio', { name: '浅色', exact: true }).click()

      for (const name of ['深蓝', '青绿', '鸢尾紫']) {
        await accents.getByRole('radio', { name, exact: true }).click()
        expect(await shownAccent(page)).toBe(await background(preview(name)))
      }
      const iris = await shownAccent(page)
      expect(await state()).toEqual({ revision: shared.revision, doc: shared.doc })
      expect(await shownAccent(other.page)).toBe(await background(preview('跟随工作台')))
      const hostAccent = settings.getByRole('radiogroup', { name: '主色', exact: true })
      await hostAccent.getByRole('radio', { name: '紫', exact: true }).click()
      expect(await shownAccent(page)).not.toBe(iris)
      await settings.getByRole('button', { name: '放弃', exact: true }).click()
      expect(await shownAccent(page)).toBe(iris)
      const revised = await apply({ schema: 1, appearance: { accentHue: 305, radius: 'sharp' } })
      await expect.poll(() => rootToken(page, '--r-8')).toBe('6px')
      expect(await shownAccent(page)).toBe(iris)

      await accents.scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${OUTPUT}/accent-1440-light.png`, animations: 'disabled' })
      await themes.getByRole('radio', { name: '深色', exact: true }).click()
      expect(await shownAccent(page)).not.toBe(iris)
      expect(await shownAccent(page)).toBe(await background(preview('鸢尾紫')))
      await accents.scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${OUTPUT}/accent-1440-dark.png`, animations: 'disabled' })
      await themes.getByRole('radio', { name: '浅色', exact: true }).click()
      await page.reload()
      await connected(page)
      expect(await shownAccent(page)).toBe(iris)
      await openSettings(page)
      await openSection(settings, '外观')
      await accents.getByRole('radio', { name: '跟随工作台', exact: true }).click()
      expect(await shownAccent(page)).toBe(await background(preview('跟随工作台')))
      await expect.poll(() => shownAccent(other.page)).toBe(await shownAccent(page))
      expect(await state()).toEqual({ revision: revised.revision, doc: revised.doc })
    } finally {
      await context.close()
      await other.context.close()
    }
  })

  it.each([
    [1440, 'light'],
    [768, 'dark'],
    [390, 'dark'],
  ] as const)('keeps the model picker readable with and without transparency (%s, %s)', async (width, theme) => {
    const { context, page } = await open(width, theme)
    try {
      await phoneStartScreen(page)
      const openModel = page.locator('.workbench-home').getByRole('button', { name: /^模型：/u })
      await openModel.click()
      const picker =
        width < 768
          ? page.getByRole('dialog', { name: '模型', exact: true }).locator('.ui-sheet-surface')
          : page.locator('.ui-popover:popover-open', { has: page.locator('.model-board') })
      await picker.waitFor()
      const setTransparency = await transparency(context, page, theme)
      await setTransparency('no-preference')
      expect(await floatingLook(picker)).toEqual(width < 768 ? SOLID : FROSTED)
      await page.screenshot({ path: `${OUTPUT}/model-material-${width}-${theme}.png`, animations: 'disabled' })
      await setTransparency('reduce')
      expect(await floatingLook(picker)).toEqual(SOLID)
      await page.keyboard.press('Escape')
      await picker.waitFor({ state: 'hidden' })
      await reachable(openModel)
    } finally {
      await context.close()
    }
  })

  it('saves the floating panel material and honours reduced transparency', async () => {
    const { context, page } = await open(1440, 'dark')
    try {
      const model = page.locator('.workbench-home').getByRole('button', { name: /^模型：/u })
      const picker = page.locator('.ui-popover:popover-open', { has: page.locator('.model-board') })
      const setTransparency = await transparency(context, page, 'dark')
      await setTransparency('no-preference')
      const openModel = async () => {
        await model.click()
        await picker.waitFor()
      }
      const choose = async (name: string) => {
        await page.keyboard.press('Escape')
        await picker.waitFor({ state: 'hidden' })
        const settings = await openSettings(page)
        await openSection(settings, '外观')
        await settings.getByRole('radiogroup', { name: '浮层材质' }).getByRole('radio', { name, exact: true }).click()
        await closeSettings(settings)
        await openModel()
      }
      await openModel()
      const frosted = await floatingLook(picker)
      expect(frosted.alpha).toBeLessThan(255)
      expect(frosted.filter).not.toBe('none')
      await choose('通透')
      const clear = await floatingLook(picker)
      expect(clear.alpha).toBeGreaterThan(0)
      expect(clear.alpha).toBeLessThan(frosted.alpha)
      expect(clear.filter).not.toBe('none')
      await page.screenshot({ path: `${OUTPUT}/model-material-clear-1440-dark.png`, animations: 'disabled' })
      await setTransparency('reduce')
      expect(await floatingLook(picker)).toEqual(SOLID)
      await setTransparency('no-preference')
      await choose('实色')
      expect(await floatingLook(picker)).toEqual(SOLID)
      expect(await background(picker)).toBe('rgb(12, 12, 12)')
      await page.reload()
      await connected(page)
      expect(await page.locator('html').getAttribute('data-floating-material')).toBe('solid')
    } finally {
      await context.close()
    }
  })

  it('frosts ordinary choices over the workbench and keeps permission and code surfaces solid', async () => {
    const project = join(host.root, 'project-selector')
    await mkdir(project)
    const run = promisify(execFile)
    const git = (...args: string[]) =>
      run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: project })
    await git('init', '-q', '--initial-branch=main')
    await writeFile(join(project, 'README.md'), '# Workbench project\n')
    await git('add', '--', 'README.md')
    await git('commit', '-qm', 'Initial commit', '--no-gpg-sign')
    await git('branch', 'feature/picker-material')
    const added = await owner.addFolders({ name: '编辑器', paths: [project] })
    expect(added.ok).toBe(true)
    const { workspace } = (await added.json()) as { workspace: { id: string } }
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: {
        prompt: '流式演示',
        mode: 'agent',
        workspaceId: workspace.id,
        model: { providerId: 'demo', model: 'demo' },
        requestId: randomUUID(),
      },
    })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, { timeout: 20_000 }).toBe('idle')

    for (const [width, theme] of [
      [1440, 'light'],
      [768, 'dark'],
    ] as const) {
      const name = `普通选择框 ${width}`
      const { context, page } = await open(width, theme, name)
      try {
        const device = host.host.security.devices.list().find(item => item.name === name)!
        expect((await owner.confirmed(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
        await page.reload()
        await connected(page)
        await openSession(page, sessionId)
        const setTransparency = await transparency(context, page, theme)
        await setTransparency('no-preference')
        const code = page.locator('.message-content .message-code').first()
        await code.scrollIntoViewIfNeeded()
        const openPicker = page.locator('.ui-popover:popover-open')
        const openSuggest = page.locator('.ui-suggest:popover-open')
        const captureChoice = async (label: string, surface: Locator) => {
          await surface.waitFor()
          expect(await floatingLook(surface)).toEqual(FROSTED)
          expect(await floatingLook(code)).toEqual(SOLID)
          await noHorizontalOverflow(page, surface)
          await page.screenshot({ path: `${OUTPUT}/choice-${label}-${width}-${theme}.png`, animations: 'disabled' })
          if (label === 'slash') {
            await page.evaluate(() => {
              document.documentElement.dataset.floatingMaterial = 'clear'
            })
            const clear = await floatingLook(surface)
            expect(clear.filter).toBe('blur(22px) saturate(1.14)')
            // A 70% tint falls halfway between two 8-bit alpha values.
            expect(clear.alpha / 255).toBeCloseTo(0.7, 2)
            await page.screenshot({ path: `${OUTPUT}/choice-${label}-clear-${width}-${theme}.png`, animations: 'disabled' })
          }
          await setTransparency('reduce')
          expect(await floatingLook(surface)).toEqual(SOLID)
          if (label === 'slash')
            await page.screenshot({ path: `${OUTPUT}/choice-${label}-solid-${width}-${theme}.png`, animations: 'disabled' })
          await setTransparency('no-preference')
          if (label === 'slash') {
            await page.evaluate(() => {
              document.documentElement.dataset.floatingMaterial = 'solid'
            })
            expect(await floatingLook(surface)).toEqual(SOLID)
            await page.evaluate(() => {
              document.documentElement.dataset.floatingMaterial = 'frosted'
            })
            expect(await floatingLook(surface)).toEqual(FROSTED)
          }
        }
        const close = async (surface: Locator) => {
          await page.keyboard.press('Escape')
          await surface.waitFor({ state: 'hidden' })
        }

        const branch = page.getByRole('button', { name: /^分支：.*切换分支$/u }).first()
        await branch.click()
        await reachable(openPicker.getByRole('menuitemradio', { name: 'feature/picker-material', exact: true }))
        await captureChoice('branch', openPicker)
        await close(openPicker)
        await expect.poll(() => branch.evaluate(element => element === document.activeElement)).toBe(true)

        const input = page.getByRole('textbox', { name: '继续对话', exact: true })
        await input.fill('/')
        await openSuggest.getByRole('listbox', { name: '命令与提示模板', exact: true }).waitFor()
        await captureChoice('slash', openSuggest)
        await close(openSuggest)
        await expect.poll(() => input.evaluate(element => element === document.activeElement)).toBe(true)
        await input.fill('@README')
        await openSuggest.getByRole('option', { name: /README\.md/u }).waitFor()
        await captureChoice('mention', openSuggest)
        await close(openSuggest)
        await input.fill('')

        await permissionControl(page).click()
        const permission = openPicker.filter({ has: page.locator('.permission-panel') })
        await permission.waitFor()
        expect(await floatingLook(permission)).toEqual(SOLID)
        await close(permission)

        await page.keyboard.press('Alt+n')
        const home = page.locator('.workbench-home')
        const projectPicker = home.locator('.home-headline').getByRole('button').first()
        await projectPicker.click()
        await reachable(openPicker.getByRole('menuitemradio', { name: /^编辑器/u }))
        await captureChoice('project', openPicker)
        await close(openPicker)
        await home
          .getByRole('button', { name: /^Harness：/u })
          .first()
          .click()
        await reachable(openPicker.getByRole('menuitemradio', { name: /^Latch 内置/u }))
        await captureChoice('harness', openPicker)
        await close(openPicker)
      } finally {
        await context.close()
      }
    }
  })

  it('keeps code blocks opaque and reading areas unfiltered when the palette changes', async () => {
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: '流式演示', requestId: randomUUID(), mode: 'chat', model: { providerId: 'demo', model: 'demo' } },
    })
    const { context, page } = await open(1440, 'dark')
    try {
      await openSession(page, sessionId)
      const code = page.locator('.message-content .message-code').first()
      const table = page.locator('.message-content table').first()
      await code.waitFor()
      await table.waitFor()
      const look = () =>
        code.evaluate(element => {
          const style = getComputedStyle(element)
          return { color: style.backgroundColor, filter: style.backdropFilter }
        })
      const before = await look()
      expect(before).toEqual({ color: expect.stringMatching(/^rgb\(/u), filter: 'none' })
      const settings = await openSettings(page)
      await openSection(settings, '外观')
      await settings.getByRole('radiogroup', { name: '工作台配色' }).getByRole('radio', { name: '暖灰' }).click()
      await closeSettings(settings)
      expect(await look()).toEqual(before)
      expect(await table.evaluate(element => getComputedStyle(element).backdropFilter)).toBe('none')
      expect(await page.locator('main.workspace').evaluate(element => getComputedStyle(element).backdropFilter)).toBe('none')
    } finally {
      await context.close()
    }
  })

  it('previews a choice on this page, saves it on 应用, and every other device follows without a reload', async () => {
    await reset()
    const { context, page } = await open(1440)
    const other = await open(390)
    try {
      const settings = await openSettings(page)
      await openSection(settings, '外观')
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
      await openSection(settings, '外观')
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
    const other = await open(768, 'dark', '另一台浏览器')
    try {
      const { devices } = await owner.json<{ devices: Device[] }>('devices')
      const enrolled = devices.find(item => item.name === '重试外观的浏览器')!
      const alternate = devices.find(item => item.name === '另一台浏览器')!
      const snapshotUrl = new URL('/link/api/snapshot', page.url()).href
      const originalCookies = await context.cookies(snapshotUrl)
      const alternateCookies = await other.context.cookies(snapshotUrl)
      const selectDevice = async (cookies: Cookie[], id: string) => {
        // The same mounted App sees an authenticated snapshot for a different device.
        await context.addCookies(cookies)
        const selected = page.waitForResponse(
          async response => response.url() === snapshotUrl && response.ok() && ((await response.json()) as AppSnapshot).device.id === id,
        )
        await page.evaluate(() => window.dispatchEvent(new Event('online')))
        await selected
      }
      const requests: unknown[] = []
      let alternateRequest: unknown
      let recordingAlternate = true
      await page.route('**/link/api/customization/reset', async route => {
        if (recordingAlternate) {
          alternateRequest = route.request().postDataJSON()
          await route.abort('failed')
          return
        }
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
      await selectDevice(alternateCookies, alternate.id)
      await settings.waitFor({ state: 'detached' })
      await openSettings(page)
      await openSection(settings, '外观')
      const group = settings.locator('.settings-group', { hasText: '自定义' })
      await group.getByRole('button', { name: '恢复默认', exact: true }).click()
      await group.getByText('结果未知', { exact: true }).waitFor()
      expect(alternateRequest).toEqual({ requestId: expect.any(String), baseRevision: before.revision })
      await selectDevice(originalCookies, enrolled.id)
      await settings.waitFor({ state: 'detached' })
      recordingAlternate = false
      await openSettings(page)
      await openSection(settings, '外观')
      await group.getByRole('button', { name: '恢复默认', exact: true }).click()
      await group.getByText('结果未知', { exact: true }).waitFor()
      expect(requests).toEqual([{ requestId: expect.any(String), baseRevision: before.revision }])
      expect(requests[0]).not.toEqual(alternateRequest)

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
      await openSection(settings, '外观')
      await group.getByText('结果未知', { exact: true }).waitFor()
      expect(await group.getByRole('button', { name: '重试同一请求' }).count()).toBe(0)
      await page.screenshot({ path: `${OUTPUT}/unknown-after-scope-change-768-dark.png`, animations: 'disabled' })

      const restored = await owner.confirmed(`devices/${enrolled.id}`, { method: 'PATCH', body: { scopes: enrolled.scopes } })
      expect(restored.status).toBe(200)
      await closeSettings(settings)
      await retry.click()
      await expect.poll(async () => (await state()).doc).toEqual(DEFAULT)
      await banner.waitFor({ state: 'detached' })
      expect(requests).toEqual([requests[0], requests[0], requests[0]])
    } finally {
      await context.close()
      await other.context.close()
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
