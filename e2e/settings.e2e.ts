import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { backToSection, openSection, openSettings } from './helpers/layout.ts'

/** One transition or animation that started on the page, as the browser reports it. */
interface Motion {
  kind: 'transition' | 'animation'
  /** The element's classes. */
  target: string
  /** The transitioned property, or the animation's name. */
  name: string
  duration: string
  easing: string
}

/** The duration and easing tokens of @latch/ui, as the page resolves them. */
interface Tokens {
  fast: string
  base: string
  slow: string
  ease: string
  exit: string
}

/** The duration and easing tokens, resolved through a probe element so they read exactly as computed styles report them. */
const tokens = (page: Page): Promise<Tokens> =>
  page.evaluate(() => {
    const probe = document.createElement('div')
    document.body.append(probe)
    const read = (duration: string, easing: string) => {
      probe.style.transition = `opacity var(${duration}) var(${easing})`
      const style = getComputedStyle(probe)
      return { duration: style.transitionDuration, easing: style.transitionTimingFunction }
    }
    const fast = read('--d-fast', '--ease')
    const base = read('--d-base', '--ease')
    const slow = read('--d-slow', '--ease-exit')
    probe.remove()
    return { fast: fast.duration, base: base.duration, slow: slow.duration, ease: fast.easing, exit: slow.easing }
  })

/** Every transition and animation that starts while `act` runs and for 400ms after it. */
async function motions(page: Page, act: () => Promise<void>): Promise<Motion[]> {
  await page.evaluate(() => {
    const record: Motion[] = []
    Reflect.set(window, 'latchMotions', record)
    document.addEventListener(
      'transitionrun',
      event => {
        if (!(event.target instanceof Element)) return
        const style = getComputedStyle(event.target)
        const index = style.transitionProperty.split(', ').indexOf(event.propertyName)
        const pick = (list: string) => list.split(/,\s*(?![^(]*\))/u)[Math.max(0, index)] ?? list
        record.push({
          kind: 'transition',
          target: event.target.getAttribute('class') ?? event.target.tagName,
          name: event.propertyName,
          duration: pick(style.transitionDuration),
          easing: pick(style.transitionTimingFunction),
        })
      },
      true,
    )
    document.addEventListener(
      'animationstart',
      event => {
        if (!(event.target instanceof Element)) return
        const style = getComputedStyle(event.target)
        record.push({
          kind: 'animation',
          target: event.target.getAttribute('class') ?? event.target.tagName,
          name: event.animationName,
          duration: style.animationDuration,
          easing: style.animationTimingFunction,
        })
      },
      true,
    )
  })
  await act()
  await page.waitForTimeout(400)
  return page.evaluate(() => {
    const record: Motion[] = Reflect.get(window, 'latchMotions')
    return record
  })
}

/**
 * Settings moves between its levels with the duration and easing tokens: on a phone the first section slides in over
 * the section list, a page inside a section slides in over the section and back out again (240ms), and under reduced
 * motion both only cross-fade; from 768px going back from a page fades the section in (120ms), and leaving settings
 * fades the page out before the conversation shows.
 */
describe('settings navigation motion', () => {
  let testHost: TestHost
  let browser: Browser

  beforeAll(async () => {
    testHost = await startTestHost({ uiDir: resolve(process.env.HARNESS_E2E_UI_DIR ?? 'dist/web') })
    browser = await chromium.launch(browserLaunchOptions())
  })
  afterAll(async () => {
    await browser?.close()
    await testHost?.close()
  })

  async function device(options: {
    phone: boolean
    reducedMotion: 'reduce' | 'no-preference'
  }): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({
      viewport: options.phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      hasTouch: options.phone,
      isMobile: options.phone,
      deviceScaleFactor: 1,
      locale: 'zh-CN',
      reducedMotion: options.reducedMotion,
    })
    context.setDefaultTimeout(15_000)
    const page = await context.newPage()
    await enrollBrowser(page, testHost, {
      name: options.phone ? '动效手机' : '动效电脑',
      scopes: ['view', 'run', 'approve:standard', 'admin'],
    })
    return { context, page }
  }

  it('slides the first section in on a phone, then a page over the section and back', async () => {
    const { context, page } = await device({ phone: true, reducedMotion: 'no-preference' })
    try {
      const token = await tokens(page)
      const settings = await openSettings(page, '设置')
      // The first push: the section was laid out off-screen from the start, so it slides in like every later one.
      const push = await motions(page, () => settings.getByRole('tab', { name: '电脑', exact: true }).click())
      expect(push).toContainEqual({
        kind: 'transition',
        target: 'settings-panel',
        name: 'transform',
        duration: token.slow,
        easing: token.ease,
      })
      expect(push).toContainEqual({
        kind: 'transition',
        target: 'settings-nav-pane',
        name: 'transform',
        duration: token.slow,
        easing: token.ease,
      })
      // A page inside the section: its own bar and back, sliding in over the section, which moves aside.
      const deeper = await motions(page, () => settings.getByRole('button', { name: /^其他设备可用的 Agent/ }).click())
      expect(deeper).toContainEqual({
        kind: 'transition',
        target: 'settings-level',
        name: 'transform',
        duration: token.slow,
        easing: token.ease,
      })
      expect(deeper).toContainEqual({
        kind: 'transition',
        target: 'settings-panel',
        name: 'transform',
        duration: token.slow,
        easing: token.ease,
      })
      const level = settings.locator('.settings-level[data-state="top"]')
      await level.getByRole('heading', { name: '其他设备可用的 Agent', exact: true }).waitFor()
      // One way back per level: the bar's, named after where it goes; the section's own bar is covered.
      expect(await settings.locator('.settings-back').count()).toBe(0)
      const back = await motions(page, () => level.getByRole('button', { name: '返回电脑', exact: true }).click())
      expect(back).toContainEqual({
        kind: 'transition',
        target: 'settings-level',
        name: 'transform',
        duration: token.slow,
        easing: token.ease,
      })
      expect(back).toContainEqual({
        kind: 'transition',
        target: 'settings-panel',
        name: 'transform',
        duration: token.slow,
        easing: token.ease,
      })
      await expect.poll(() => settings.locator('.settings-level').count()).toBe(0)
      expect(await settings.locator('.settings-layout').getAttribute('data-level')).toBe('section')
    } finally {
      await context.close()
    }
  })

  it('cross-fades the phone levels under reduced motion, with nothing moving', async () => {
    const { context, page } = await device({ phone: true, reducedMotion: 'reduce' })
    try {
      const token = await tokens(page)
      const settings = await openSettings(page, '设置')
      const push = await motions(page, () => settings.getByRole('tab', { name: '电脑', exact: true }).click())
      expect(push).toContainEqual({
        kind: 'transition',
        target: 'settings-panel',
        name: 'opacity',
        duration: token.fast,
        easing: token.ease,
      })
      const deeper = await motions(page, () => settings.getByRole('button', { name: /^其他设备可用的 Agent/ }).click())
      expect(deeper).toContainEqual({
        kind: 'transition',
        target: 'settings-level',
        name: 'opacity',
        duration: token.fast,
        easing: token.ease,
      })
      // Nothing in settings moves (the session drawer behind it shuts at once, which is not settings' own motion).
      const moving = [...push, ...deeper].filter(
        motion => motion.target.startsWith('settings') && /^(transform|translate|settings-enter)$/u.test(motion.name),
      )
      expect(moving).toEqual([])
    } finally {
      await context.close()
    }
  })

  it('fades a section in again on the way back from a page, and fades settings out when leaving', async () => {
    const { context, page } = await device({ phone: false, reducedMotion: 'no-preference' })
    try {
      const token = await tokens(page)
      const settings = await openSettings(page, '设置')
      await openSection(settings, '电脑')
      const forward = await motions(page, () => settings.getByRole('button', { name: /^其他设备可用的 Agent/ }).click())
      expect(forward).toContainEqual({
        kind: 'animation',
        target: 'settings-subpage settings-enter',
        name: 'settings-enter',
        duration: token.fast,
        easing: token.ease,
      })
      const back = await motions(page, () => backToSection(settings))
      expect(back).toContainEqual({
        kind: 'animation',
        target: 'settings-subpage settings-enter',
        name: 'settings-enter',
        duration: token.fast,
        easing: token.ease,
      })
      await settings.getByRole('button', { name: /^在这台电脑上发起：/ }).waitFor()

      // Leaving: the page fades out (90ms, the exit curve), and only then is the conversation back.
      const leave = await motions(page, async () => {
        await settings.getByRole('button', { name: /^返回会话/ }).click()
        await settings.waitFor({ state: 'detached' })
      })
      expect(leave).toContainEqual({
        kind: 'animation',
        target: 'modal modal-page settings-page is-leaving',
        name: 'settings-leave',
        duration: '0.09s',
        easing: token.exit,
      })
    } finally {
      await context.close()
    }
  })
})
