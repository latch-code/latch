import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { startTestHost } from './helpers/host.ts'
import { switchView } from './helpers/workbench.ts'

const OUT = 'test-results/desktop-titlebar'
const run = promisify(execFile)

interface Lights {
  /** Window points per captured pixel row and column. */
  scale: number
  centreY: number
  left: number
  right: number
}

/**
 * The traffic lights as macOS really drew them: the window is photographed by its window ID (no other window, no
 * shadow), and the lights are what stands out from the row's ground before the page's first thing. Null where this
 * process may not record the screen.
 */
/**
 * A window just shown can be photographed before the window server has drawn its lights (seen once under load), so a
 * photograph without them is taken again a few times; one that never shows them still reports null.
 */
async function nativeLights(app: ElectronApplication, file: string, corner: string, until: number): Promise<Lights | null> {
  for (let attempt = 0; ; attempt++) {
    const lights = await photographLights(app, file, corner, until)
    if (lights || attempt === 3) return lights
    await new Promise(done => setTimeout(done, 500))
  }
}

async function photographLights(app: ElectronApplication, file: string, corner: string, until: number): Promise<Lights | null> {
  const source = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!
    window.show()
    window.focus()
    return window.getMediaSourceId()
  })
  const id = /^window:(\d+):/u.exec(source)?.[1]
  if (!id) return null
  await new Promise(done => setTimeout(done, 400))
  try {
    await run('/usr/sbin/screencapture', ['-x', '-o', `-l${id}`, file])
  } catch {
    return null
  }
  const found = await app.evaluate(
    ({ BrowserWindow, nativeImage }, paths) => {
      const window = BrowserWindow.getAllWindows()[0]!
      const image = nativeImage.createFromPath(paths.file)
      const { width, height } = image.getSize()
      if (!width || !height) return null
      const scale = width / window.getBounds().width
      const pixels = image.toBitmap()
      const bytesPerRow = pixels.length / height
      // Whatever differs from the row's own ground left of the page's first thing is the lights, lit or (in a window
      // that is not the key one) grey. The window's rounded corner is left out.
      const at = (x: number, y: number) => y * bytesPerRow + x * 4
      const ground = at(Math.round(14 * scale), Math.round(48 * scale))
      let [left, right, top, bottom, count] = [Infinity, -Infinity, Infinity, -Infinity, 0]
      for (let y = Math.round(10 * scale); y < Math.round(50 * scale); y++)
        for (let x = Math.round(12 * scale); x < Math.round(paths.until * scale); x++) {
          const pixel = at(x, y)
          const differs = [0, 1, 2].some(channel => Math.abs(pixels[pixel + channel]! - pixels[ground + channel]!) > 5)
          if (!differs) continue
          left = Math.min(left, x)
          right = Math.max(right, x)
          top = Math.min(top, y)
          bottom = Math.max(bottom, y)
          count++
        }
      const found = count > 60
      // The corner the acceptance set shows, at the capture's own density.
      const cornerPng = image
        .crop({ x: 0, y: 0, width: Math.round(300 * scale), height: Math.round(120 * scale) })
        .toPNG()
        .toString('base64')
      if (!found) return { cornerPng, lights: null }
      return {
        cornerPng,
        lights: { scale, centreY: (top + bottom + 1) / 2 / scale, left: left / scale, right: (right + 1) / scale },
      }
    },
    { file, until },
  )
  if (!found) return null
  await writeFile(corner, Buffer.from(found.cornerPng, 'base64'))
  return found.lights
}

/** The top row's own line in the page: the middle of its mark, and where its first thing after the lights begins. */
async function rowLine(page: Page): Promise<{ centreY: number; start: number; drag: string; noDrag: string[] }> {
  return page.evaluate(() => {
    const shown = (selector: string) =>
      [...document.querySelectorAll<HTMLElement>(selector)].find(element => element.checkVisibility({ visibilityProperty: true }))
    const bar = shown('.titlebar')!
    const things = [
      ...bar.querySelectorAll<HTMLElement>(
        '.titlebar-wordmark, .titlebar-lead .shell-view-switch, .titlebar-lead .ui-icon-button, .space-buttons',
      ),
    ]
      .filter(element => element.checkVisibility({ visibilityProperty: true }))
      .map(element => element.getBoundingClientRect())
      .toSorted((a, b) => a.left - b.left)
    const first = things[0]!
    const region = (element: Element) => getComputedStyle(element).getPropertyValue('-webkit-app-region')
    // The strip's controls also occupy the draggable title row when the panel reaches the top.
    const panelControls = matchMedia('(min-width: 1280px)').matches
      ? ', .app-shell[data-inspector="open"] .inspector-column .session-panel-strip button'
      : ''
    return {
      centreY: first.top + first.height / 2,
      start: first.left,
      drag: region(bar),
      noDrag: [...document.querySelectorAll(`.titlebar button, .shell-view-switch${panelControls}`)]
        .filter(element => (element as HTMLElement).checkVisibility({ visibilityProperty: true }))
        .map(region),
    }
  })
}

it.skipIf(latchEnv(process.env, 'ELECTRON_E2E') !== '1' || process.platform !== 'darwin')(
  'draws the traffic lights on the top row’s own line in both views, clear of what follows them',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-titlebar-'))
    const host = await startTestHost({ demo: true, hostName: '验收电脑' })
    let app: ElectronApplication | undefined
    try {
      await mkdir(OUT, { recursive: true })
      await writeHostState(host.dataDir, {
        version: 2,
        pid: process.pid,
        hostId: host.host.hostId,
        instanceId: host.host.instanceId,
        socketPath: host.host.socketPath,
        loopbackOrigin: host.host.loopbackOrigin,
        tlsOrigin: null,
        startedAt: new Date().toISOString(),
        dataDir: host.dataDir,
      })
      app = await _electron.launch({
        args: [
          resolve('apps/desktop/src/main.cjs'),
          `--latch-host-state=${join(host.dataDir, 'host.json')}`,
          `--latch-user-data=${join(root, 'electron')}`,
          '--use-mock-keychain',
        ],
        cwd: process.cwd(),
        env: Object.fromEntries(
          Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
        timeout: 30_000,
      })
      const page = await app.firstWindow()
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1200, 800))
      await page.getByRole('button', { name: '继续', exact: true }).click()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      const measured: Array<Record<string, unknown>> = []
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme })
        for (const view of ['chat', 'board'] as const) {
          await switchView(page, view)
          await expect.poll(async () => (await page.evaluate(() => document.documentElement.dataset.viewSwitch)) ?? null).toBeNull()
          const name = `${view}--${theme}`
          // A tooltip over the row (the switch keeps the focus) stops it moving the window while it shows.
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
          await page.mouse.move(600, 400)
          await expect
            .poll(() => page.evaluate(() => [...document.querySelectorAll(':popover-open')].map(element => element.className)))
            .toEqual([])
          const line = await rowLine(page)
          const position = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getWindowButtonPosition())
          const lights = await nativeLights(app, join(root, `${name}.png`), resolve(OUT, `${name}@2x.png`), line.start - 2)
          measured.push({ name, row: line.centreY, start: line.start, position, lights })
          await writeFile(`${OUT}/measured.json`, JSON.stringify(measured, null, 2))
          // The row moves the window; its controls and the view switch do not.
          expect(line.drag).toBe('drag')
          expect(new Set(line.noDrag)).toEqual(new Set(['no-drag']))
          if (lights) {
            expect(Math.abs(lights.centreY - line.centreY)).toBeLessThanOrEqual(1)
            expect(Math.abs(line.start - lights.right - 12)).toBeLessThanOrEqual(1)
          }
        }
      }
      // Nothing of the row stands under the lights or closer than 12px to them: with the sidebar shut, and in 设置.
      const lightsEnd = (measured.at(-1)!.lights as Lights | null)?.right ?? 76
      const clear = async (state: string) => {
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
        await page.mouse.move(600, 400)
        const line = await rowLine(page)
        measured.push({ name: state, row: line.centreY, start: line.start })
        expect(line.start - lightsEnd, state).toBeGreaterThanOrEqual(11)
      }
      await switchView(page, 'chat')
      await page.keyboard.press('Meta+b')
      await expect.poll(() => page.locator('.app-shell').getAttribute('data-sidebar')).toBe('collapsed')
      await clear('sidebar-shut')
      await page.keyboard.press('Meta+b')
      await expect.poll(() => page.locator('.app-shell').getAttribute('data-sidebar')).toBe('open')
      await page.keyboard.press('Meta+,')
      await page.locator('.settings-page').waitFor({ state: 'visible' })
      await clear('settings-sidebar')
      // 设置 is a modal over the window: from 看板 it opens over 对话, which it comes back to.
      await page.keyboard.press('Escape')
      await page.locator('.settings-page').waitFor({ state: 'hidden' })
      await switchView(page, 'board')
      await page.keyboard.press('Meta+,')
      await page.locator('.settings-page').waitFor({ state: 'visible' })
      await clear('settings-from-board')
      expect(await page.locator('.app-shell').getAttribute('data-view')).toBe('chat')
      // Full screen hides the lights, and the row starts where it does without them; back out of it, it makes room again.
      // macOS carries a window to full screen only on a display that is awake and unlocked: the page is resized when it
      // does. On a locked screen the window never changes size, and this part has nothing to measure.
      const size = () => page.evaluate(() => `${innerWidth}x${innerHeight}`)
      const before = await size()
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setFullScreen(true))
      const entered = await expect
        .poll(size, { timeout: 15_000 })
        .not.toBe(before)
        .then(
          () => true,
          () => false,
        )
      if (entered) {
        await expect.poll(() => page.locator('.titlebar[data-lights]').count(), { timeout: 15_000 }).toBe(0)
        const full = await rowLine(page)
        measured.push({ name: 'full-screen-topbar', start: full.start })
        expect(full.start).toBeLessThanOrEqual(24)
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setFullScreen(false))
        await expect.poll(() => page.locator('.titlebar[data-lights]').count(), { timeout: 15_000 }).toBe(1)
        expect((await rowLine(page)).start - lightsEnd).toBeGreaterThanOrEqual(11)
      } else {
        measured.push({ name: 'full-screen-topbar', skipped: 'macOS did not take the window to full screen (display locked or asleep)' })
        console.warn('desktop-titlebar: full screen not entered by macOS; that part was not measured')
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setFullScreen(false))
      }
      await writeFile(`${OUT}/measured.json`, JSON.stringify(measured, null, 2))
      // The photograph is the proof; without it (no screen recording for this process) the run says so rather than pass.
      expect(measured.slice(0, 4).every(item => item.lights !== null)).toBe(true)
    } finally {
      await app?.close().catch(() => {})
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  120_000,
)
