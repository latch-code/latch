import { chromium } from '@playwright/test'
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build, preview } from 'vite'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { AGENT_PRESETS } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow, phoneStartScreen } from './helpers/layout.ts'

const output = 'test-results/brands'
const cases = [320, 820, 1440].flatMap(width => (['light', 'dark'] as const).map(theme => ({ width, theme })))
const statusFixture: HarnessPlugin = {
  id: 'brand-status',
  name: 'Brand status fixture',
  version: '1',
  description: '',
  activate(context) {
    for (const outdated of [false, true])
      context.registerHarness({
        id: outdated ? 'old-fixture' : 'login-fixture',
        name: outdated ? '旧版本夹具' : '待登录夹具',
        version: '1',
        status: () =>
          outdated
            ? { status: 'unavailable', statusReason: 'outdated', statusMessage: '需要升级到新版本' }
            : { status: 'ready', statusMessage: '上次运行异常：需要先登录' },
        create: () => ({
          start: async () => {},
          close: async () => {},
          listTasks: async () => [],
          detail: async () => {
            throw new Error('No task in this menu fixture')
          },
          createTask: async () => {
            throw new Error('This menu fixture never sends')
          },
          prompt: async () => {},
          cancel: async () => {},
          approvals: () => [],
          decide: async () => false,
          subscribe: () => () => {},
        }),
      })
  },
}
let gallery: Awaited<ReturnType<typeof preview>>
let directory: string

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'latch-brand-gallery-'))
  await mkdir(output, { recursive: true })
  await build({
    configFile: false,
    logLevel: 'warn',
    root: resolve('apps/web/test'),
    base: './',
    build: { outDir: directory, emptyOutDir: true, rolldownOptions: { input: resolve('apps/web/test/brands.html') } },
  })
  await mkdir(join(directory, 'link'))
  await copyFile('apps/web/public/icon.png', join(directory, 'link/icon.png'))
  gallery = await preview({ configFile: false, logLevel: 'warn', build: { outDir: directory }, preview: { host: '127.0.0.1', port: 0 } })
})

afterAll(async () => {
  await gallery?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

it.each(cases)('renders every official mark at small sizes on $width $theme', async ({ width, theme }) => {
  const browser = await chromium.launch(browserLaunchOptions())
  const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme })
  const failed: string[] = []
  page.on('requestfailed', request => failed.push(new URL(request.url()).pathname))
  try {
    await page.goto(`${gallery.resolvedUrls!.local[0]}brands.html`)
    await page.locator('[data-mark="antigravity"]').waitFor({ state: 'attached' })
    await page.evaluate(async () => {
      await document.fonts.ready
      await Promise.all(Array.from(document.images, image => image.decode()))
    })
    for (const mark of ['latch', ...AGENT_PRESETS.map(preset => preset.id)]) {
      const row = page.locator(`[data-mark="${mark}"]`)
      expect(await row.locator('[data-mark-size]').count()).toBe(4)
      expect(await row.locator('[data-glyph]').count()).toBe(0)
      for (const image of await row.locator('img').all())
        expect(await image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
      const mask = row.locator('.ui-tile-mark').first()
      if (await mask.count()) {
        const url = await mask.evaluate(node => getComputedStyle(node).maskImage.slice(5, -2))
        expect((await page.request.get(url)).status()).toBe(200)
      }
      // A successfully decoded black mark can still disappear on the dark surface.
      const encoded = (await row.locator('[data-mark-size="24"]').screenshot()).toString('base64')
      const visible = await page.evaluate(async encoded => {
        const image = new Image()
        image.src = `data:image/png;base64,${encoded}`
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        const context = canvas.getContext('2d')!
        context.drawImage(image, 0, 0)
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        const background = pixels.slice(0, 3)
        let visible = 0
        for (let offset = 0; offset < pixels.length; offset += 4)
          if (background.some((value, channel) => Math.abs(pixels[offset + channel]! - value) > 40)) visible++
        return visible
      }, encoded)
      expect({ mark, visible: visible >= 8 }).toEqual({ mark, visible: true })
    }
    expect(failed).toEqual([])
    await noHorizontalOverflow(page)
    await page.screenshot({ path: `${output}/marks-${width}-${theme}.png`, fullPage: true })
  } finally {
    await browser.close()
  }
})

it.each(cases)('keeps official marks in the normal Harness menu at $width $theme', async ({ width, theme }) => {
  const commands = await mkdtemp(join(tmpdir(), 'latch-brand-commands-'))
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  for (const preset of AGENT_PRESETS) {
    const file = join(commands, preset.command)
    await writeFile(
      file,
      `#!/bin/sh\nif [ "$1" = --version ]; then echo '3.0.0'; exit 0; fi\nexec ${quote(process.execPath)} ${quote(FAKE_ACP_AGENT)} "$@"\n`,
    )
    await chmod(file, 0o755)
  }
  const host = await startTestHost({
    plugins: [statusFixture],
    commandDirectories: () => [commands],
    detectPreset: preset => ({ found: true, path: join(commands, preset.command) }),
  })
  const browser = await chromium.launch(browserLaunchOptions())
  const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme, locale: 'zh-CN', reducedMotion: 'reduce' })
  page.setDefaultTimeout(10_000)
  try {
    const owner = await host.enroll({ listener: 'unix' })
    for (const preset of AGENT_PRESETS) {
      const response = await owner.confirmed('agents', {
        method: 'POST',
        body: { id: preset.id, name: preset.name, presetId: preset.id, command: preset.command, args: preset.args, env: {} },
      })
      expect({ id: preset.id, status: response.status }).toEqual({ id: preset.id, status: 201 })
    }
    await enrollBrowser(page, host, { scopes: ['view', 'run', 'admin'] })
    // A phone opens on its list (cae787a4); the input and its Harness are on the start screen 新建会话 pushes.
    await phoneStartScreen(page)
    const picker = page
      .getByRole('button', { name: /^Harness：/u })
      .filter({ visible: true })
      .first()
    await picker.click()
    const choices = page.getByRole('menuitemradio').or(page.getByRole('radio')).or(page.getByRole('option')).filter({ visible: true })
    await expect.poll(() => choices.count()).toBeGreaterThanOrEqual(AGENT_PRESETS.length + 1)
    expect(await choices.getByText(/^(?:读写文件、运行命令|只读写文件，不运行命令)$/u).count()).toBe(0)
    await choices.filter({ hasText: '待登录夹具' }).getByText('上次运行异常：需要先登录', { exact: true }).waitFor()
    const outdated = choices.filter({ hasText: '旧版本夹具' })
    await outdated.getByText('需要升级', { exact: true }).waitFor()
    expect(await outdated.getAttribute('aria-disabled')).toBe('true')
    for (const preset of AGENT_PRESETS) {
      const choice = choices.filter({ hasText: preset.name }).first()
      expect(await choice.locator('.ui-tile').count()).toBe(1)
      expect(await choice.locator('[data-glyph]').count()).toBe(0)
      await choice.scrollIntoViewIfNeeded()
    }
    await noHorizontalOverflow(page)
    await page.screenshot({ path: `${output}/harness-menu-${width}-${theme}.png`, fullPage: true })
    await choices.filter({ hasText: 'Grok Build' }).first().click()
    await expect.poll(() => picker.innerText()).toContain('Grok Build')
    expect(await picker.locator('img').count()).toBe(2)
    await page.screenshot({ path: `${output}/harness-selected-${width}-${theme}.png`, fullPage: true })
  } finally {
    await browser.close()
    await host.close()
    await rm(commands, { recursive: true, force: true })
  }
})
