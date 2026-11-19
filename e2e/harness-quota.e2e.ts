import { chromium, type Browser, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppSnapshot, TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, FAKE_CODEX_APP_SERVER, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSession, phoneStartScreen } from './helpers/layout.ts'

const OUTPUT = 'test-results/harness-quota'
const HOUR = 3_600_000
const seconds = (ms: number) => Math.floor(ms / 1000)

/**
 * A Harness's subscription limits beside its control (docs/HARNESSES.md#额度). Codex is the fake app-server, answering
 * `account/rateLimits/read` and pushing `account/rateLimits/updated` in Codex 0.167's shapes; the warning without a figure
 * is the fake ACP agent under Claude Agent's profile, sending the adapter's `_claude/rateLimit`. No program of this
 * computer runs and no vendor is called.
 */
describe('额度与用量: a Harness’s limits on its composer and in the one surface', () => {
  let host: TestHost
  let owner: TestDevice
  let browser: Browser
  let pushed = ''
  let started = 0
  const sessions = { codex: '', claude: '', other: '' }

  const window = (usedPercent: number, minutes: number, ahead: number) => ({
    usedPercent,
    windowDurationMins: minutes,
    resetsAt: seconds(started + ahead),
  })
  /** One `RateLimitSnapshot` of the plan's own bucket; the half hours keep the words steady while the test runs. */
  const limits = (fiveHour: number, weekly: number) => ({
    limitId: 'codex',
    limitName: null,
    primary: window(fiveHour, 300, 2.5 * HOUR),
    secondary: window(weekly, 10080, 143.5 * HOUR),
    planType: 'plus',
    rateLimitReachedType: null,
  })
  const settled = async (id: string): Promise<void> => {
    for (let tries = 0; (await owner.json<TaskDetail>(`tasks/${id}`)).summary.status !== 'idle'; tries++) {
      if (tries > 300) throw new Error('the session did not settle')
      await new Promise(done => setTimeout(done, 50))
    }
  }
  const begin = async (harnessId: string, prompt: string): Promise<string> => {
    const { sessionId } = await owner.confirmedJson<{ sessionId: string }>('tasks', {
      body: { prompt, requestId: randomUUID(), harnessId },
    })
    await settled(sessionId)
    return sessionId
  }
  /** Codex pushes these limits as its next turn ends. */
  const push = async (fiveHour: number, weekly: number): Promise<void> => {
    await writeFile(pushed, JSON.stringify(limits(fiveHour, weekly)))
    await owner.json(`tasks/${sessions.codex}/prompt`, { method: 'POST', body: { prompt: 'echo again', requestId: randomUUID() } })
    await settled(sessions.codex)
  }
  const quota = async (id: string) =>
    (await owner.json<AppSnapshot>('snapshot')).catalog?.harnesses.find(harness => harness.id === id)?.quota
  // On the input's line; a phone's stands at the end of the line under the input.
  const chip = (page: Page) => page.locator('main.workspace:not([inert]) .composer-stack .usage-chip')
  const surface = (page: Page) => page.getByRole('dialog', { name: '额度与用量', exact: true })
  const windows = (page: Page) =>
    surface(page)
      .locator('.limit-window')
      .evaluateAll(items => items.map(item => (item.textContent ?? '').replace(/\s+/gu, ' ')))

  async function open(width: number, theme: 'light' | 'dark', session: string): Promise<Page> {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      colorScheme: theme,
      reducedMotion: 'reduce',
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await enrollBrowser(page, host, { scopes: ['view', 'run', 'admin'] })
    await openSession(page, session)
    return page
  }
  /**
   * The session at the three widths in both themes: the chip in sight inside the window, and the surface it opens when
   * `panel` asks for it.
   */
  async function capture(state: string, session: string, shown: string | undefined, panel = false): Promise<void> {
    for (const width of [1440, 768, 390])
      for (const theme of ['light', 'dark'] as const) {
        const page = await open(width, theme, session)
        try {
          if (shown === undefined) expect(await chip(page).count()).toBe(0)
          else {
            await chip(page).getByText(shown, { exact: true }).waitFor()
            const box = (await chip(page).boundingBox())!
            expect(box.x >= 0 && box.x + box.width <= width, `${width}`).toBe(true)
          }
          await noHorizontalOverflow(page)
          await page.screenshot({ path: `${OUTPUT}/${state}--${width}-${theme}.png`, animations: 'disabled' })
          if (panel) {
            await chip(page).click()
            await surface(page).getByRole('region', { name: 'Codex', exact: true }).waitFor()
            await noHorizontalOverflow(page)
            await page.screenshot({ path: `${OUTPUT}/${state}-panel--${width}-${theme}.png`, animations: 'disabled' })
          }
        } finally {
          await page.context().close()
        }
      }
  }

  beforeAll(async () => {
    host = await startTestHost({ demo: false })
    owner = await host.enroll({ listener: 'unix' })
    started = Date.now()
    const bin = join(host.root, 'bin')
    await mkdir(bin)
    const command = join(bin, 'codex')
    await writeFile(command, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_CODEX_APP_SERVER}' "$@"\n`)
    await chmod(command, 0o755)
    pushed = join(host.root, 'pushed-limits.json')
    await owner.confirmedJson('agents', {
      body: {
        id: 'codex',
        name: 'Codex',
        presetId: 'codex',
        command,
        args: [],
        env: {
          FAKE_CODEX_RATE_LIMITS: JSON.stringify({
            ordinaryUsageAllowed: true,
            rateLimits: limits(12, 68),
            rateLimitsByLimitId: { codex: limits(12, 68) },
            rateLimitResetCredits: null,
            accountId: 'acct_0123456789',
            rateLimitUpsell: null,
          }),
          FAKE_CODEX_RATE_LIMITS_UPDATE: pushed,
        },
      },
    })
    await owner.confirmedJson('agents', {
      body: {
        id: 'claude',
        name: 'Claude Agent',
        presetId: 'claude-agent',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_CONFIG: 'options', FAKE_ACP_MODES: 'default,acceptEdits,plan,auto,bypassPermissions', FAKE_ACP_VERSION: '0.101.0' },
      },
    })
    await owner.confirmedJson('agents', {
      body: { id: 'other', name: 'Other', command: process.execPath, args: [FAKE_ACP_AGENT], env: {} },
    })
    sessions.codex = await begin('codex', 'echo hi')
    sessions.other = await begin('other', 'echo hi')
    const warning = { status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: seconds(Date.now() + 2.5 * HOUR), utilization: 0.93 }
    sessions.claude = await begin('claude', `limit ${JSON.stringify(warning)}`)
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
  })

  it('names both windows compactly on the chip, each in its own state, opens the surface on that Harness, and follows what the next turn reports', async () => {
    await expect.poll(async () => (await quota('codex'))?.windows.length).toBe(2)
    const page = await open(1440, 'light', sessions.codex)
    try {
      await chip(page).getByText('5 小时 12% · 周 68%', { exact: true }).waitFor()
      expect(await chip(page).getAttribute('data-state')).toBe('ok')
      // The chip is no control of the input: it stands under it, at the end of the line that says what the session used.
      const workspace = page.locator('main.workspace:not([inert])')
      expect(await workspace.locator('form.composer .composer-usage').count()).toBe(0)
      const [form, foot, mark] = await Promise.all([
        workspace.locator('form.composer').boundingBox(),
        workspace.locator('.composer-foot[data-usage]').boundingBox(),
        chip(page).boundingBox(),
      ])
      expect(foot!.y).toBeGreaterThanOrEqual(form!.y + form!.height - 1)
      expect(mark!.x + mark!.width).toBeGreaterThan(foot!.x + foot!.width - 24)
      // Its hover says when the window resets, and the shortcut.
      await chip(page).hover()
      await page.getByRole('tooltip').getByText('5 天 23 小时后重置', { exact: true }).waitFor()
      await page.screenshot({ path: `${OUTPUT}/ok-hover--1440-light.png`, animations: 'disabled' })

      await chip(page).click()
      await surface(page).waitFor()
      // Scoped to this Harness: its windows, each the one limit-window component, then the plan and the masked account.
      expect(await surface(page).getByRole('region').count()).toBe(1)
      const rows = await windows(page)
      expect(rows[0]).toMatch(/^5 小时 ?已用 12% ?2 小时 2\d 分钟后重置$/u)
      expect(rows[1]).toMatch(/^每周 ?已用 68% ?5 天 23 小时后重置$/u)
      expect(rows).toHaveLength(2)
      expect(await surface(page).getByRole('meter').count()).toBe(2)
      await surface(page)
        .locator('.usage-facts')
        .getByText(/^Plus ?· ?p•••@e•••\.com$/u)
        .waitFor()
      expect(await page.content()).not.toContain('person@example.com')
      await page.keyboard.press('Escape')
      await surface(page).waitFor({ state: 'hidden' })
      expect(await chip(page).evaluate(element => element === document.activeElement)).toBe(true)

      // The next turn's report reaches the open page by itself: amber from 80%, red at the limit, each with its figure.
      await push(86, 68)
      await chip(page).getByText('5 小时 86% · 周 68%', { exact: true }).waitFor()
      expect(await chip(page).getAttribute('data-state')).toBe('near')
      expect(await chip(page).getAttribute('aria-label')).toMatch(
        /^Codex 额度：5 小时 86%，2 小时 2\d 分钟后重置 · 周 68%，5 天 23 小时后重置$/u,
      )
      // Each window in its own state: the five hours amber, the week still in ink.
      expect(
        await chip(page)
          .locator('.usage-chip-part')
          .evaluateAll(parts => parts.map(part => part.getAttribute('data-state'))),
      ).toEqual(['near', 'ok'])
    } finally {
      await page.context().close()
    }
    await capture('near', sessions.codex, '5 小时 86% · 周 68%', true)
    await push(86, 100)
    await expect.poll(async () => (await quota('codex'))?.state).toBe('limited')
    await capture('limited', sessions.codex, '5 小时 86% · 周 100%', true)
    await push(12, 68)
    await expect.poll(async () => (await quota('codex'))?.state).toBe('ok')
    await capture('ok', sessions.codex, '5 小时 12% · 周 68%', true)
  })

  it('moves no control when the chip comes or goes, at any width, and keeps it in sight at 390', async () => {
    // The chip arrives seconds after a turn starts and leaves with the Host's memory. Its coming and going is drawn here
    // by taking it out of the layout: where the Harness, model, thinking and permission controls stand must not change.
    for (const width of [1440, 768, 390]) {
      const page = await open(width, 'light', sessions.codex)
      try {
        await chip(page).getByText('5 小时 12% · 周 68%', { exact: true }).waitFor()
        const composer = page.locator('main.workspace:not([inert]) form.composer')
        const boxes = () =>
          composer.locator('[data-composer-control]').evaluateAll(items =>
            items.map(item => {
              const box = item.getBoundingClientRect()
              return [item.getAttribute('data-composer-control'), Math.round(box.x), Math.round(box.y), Math.round(box.width)]
            }),
          )
        const height = async () => Math.round((await composer.boundingBox())!.height)
        const withChip = { boxes: await boxes(), height: await height() }
        expect(withChip.boxes.map(box => box[0])).toEqual(['harness', 'permission', 'model'])
        const box = (await chip(page).boundingBox())!
        expect(box.x >= 0 && box.x + box.width <= width && box.width > 0, `${width}`).toBe(true)
        const hidden = await page.addStyleTag({ content: '.composer-usage { display: none !important; }' })
        expect(await chip(page).isVisible()).toBe(false)
        expect({ boxes: await boxes(), height: await height() }, `${width}`).toEqual(withChip)
        await hidden.evaluate(style => style.parentNode?.removeChild(style))
        await chip(page).getByText('5 小时 12% · 周 68%', { exact: true }).waitFor()
        expect({ boxes: await boxes(), height: await height() }, `${width}`).toEqual(withChip)
      } finally {
        await page.context().close()
      }
    }
  })

  /**
   * What breaks the composer's footer at a width: two of its parts overlapping, send past the composer's edge or on a line
   * of its own, or the limit chip cut (a bar with no room, words past its edge). Read on the visible composer.
   */
  const footerProblems = (page: Page) =>
    page.evaluate(() => {
      const form = [...document.querySelectorAll<HTMLElement>('form.composer')].find(
        element => element.checkVisibility() && !element.closest('[inert]'),
      )
      if (!form) return ['no composer']
      const problems: string[] = []
      const shown = (element: Element) => (element as HTMLElement).checkVisibility({ visibilityProperty: true, opacityProperty: true })
      const rect = (element: Element) => element.getBoundingClientRect()
      const frame = rect(form)
      const send = form.querySelector('.send-button, .stop-button')
      const parts = [
        ...form.querySelectorAll(
          '[data-composer-control] > button, [data-composer-control] > * > button, .composer-meta > *, .send-button, .stop-button',
        ),
      ].filter(element => shown(element) && rect(element).width > 0 && !element.closest('.composer-usage'))
      const chip = form.querySelector('.composer-toolbar .usage-chip')
      const boxes = parts.map(element => [element, rect(element)] as const)
      if (chip && shown(chip) && rect(chip).width > 0) {
        const box = rect(chip)
        const bar = chip.querySelector('.usage-chip-bar, svg')
        const text = chip.querySelector('.usage-chip-text')
        const barBox = bar && rect(bar)
        if (barBox && (barBox.left < box.left - 0.5 || barBox.right > box.right + 0.5)) problems.push('limit bar cut')
        const textBox = text && rect(text)
        // Words on the chip's own line are whole; on the line under it they are hidden by its height.
        if (textBox && textBox.top < box.bottom - 1 && (textBox.left < box.left - 0.5 || textBox.right > box.right + 0.5))
          problems.push('limit words cut')
        // What of it shows: from its bar (or glyph) to its end.
        boxes.push([chip, new DOMRect(barBox ? barBox.left : box.left, box.top, box.right - (barBox ? barBox.left : box.left), box.height)])
      }
      for (let a = 0; a < boxes.length; a++)
        for (let b = a + 1; b < boxes.length; b++) {
          const [, one] = boxes[a]!
          const [, two] = boxes[b]!
          if (one.left < two.right - 0.5 && two.left < one.right - 0.5 && one.top < two.bottom - 0.5 && two.top < one.bottom - 0.5)
            problems.push(`${(boxes[a]![0] as HTMLElement).className} × ${(boxes[b]![0] as HTMLElement).className}`)
        }
      if (send) {
        const box = rect(send)
        if (box.right > frame.right - 1 || box.left < frame.left) problems.push(`send outside the composer (${box.right} > ${frame.right})`)
        // Send stands on a row of controls, never alone under them (a phone's controls are a row of their own above the input).
        const controls = boxes.filter(([element]) => element !== send && element.closest('[data-composer-control]'))
        if (
          form.querySelector('.composer-toolbar')
          && controls.length
          && !controls.some(([, other]) => other.top < box.bottom && box.top < other.bottom)
        )
          problems.push('send on a line of its own')
      }
      return problems
    })

  it('keeps the footer on one line with send at its end at every width, with and without the limit and with long values', async () => {
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce', locale: 'zh-CN' })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    try {
      await enrollBrowser(page, host, { scopes: ['view', 'run', 'admin'] })
      const shots = [780, 840, 900, 1020, 1100]
      let long = false
      // Long values as a Harness may report them: a long model ID and thinking level, set again after each re-render.
      const lengthen = () =>
        page.evaluate(() => {
          const text = (selector: string, words: string) => {
            for (const element of document.querySelectorAll(`form.composer ${selector} .ui-value-picker-text`)) element.textContent = words
          }
          text('.model-picker', 'gpt-6.1-sol-codex-max-preview-2026-11-01')
          text('.thinking-picker', 'Extra high reasoning')
        })
      const step = async (label: string) => {
        const failures: string[] = []
        for (let width = 320; width <= 1100; width += 20) {
          await page.setViewportSize({ width, height: 900 })
          await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
          if (long) {
            await lengthen()
            await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
          }
          for (const problem of await footerProblems(page)) failures.push(`${label} ${width}: ${problem}`)
          if (shots.includes(width))
            for (const theme of ['light', 'dark'] as const) {
              await page.emulateMedia({ colorScheme: theme })
              await page.screenshot({
                path: `${OUTPUT}/footer-${label.replaceAll(/[ ,]+/gu, '-')}--${width}-${theme}.png`,
                animations: 'disabled',
              })
            }
        }
        await page.emulateMedia({ colorScheme: 'light' })
        expect(failures).toEqual([])
      }
      // A session on Codex, its limit shown.
      await openSession(page, sessions.codex)
      await chip(page).waitFor({ state: 'attached' })
      await step('session')
      long = true
      await step('session, long values')
      long = false
      // The start screen on Codex, as a new session's composer lays out its footer by its own width.
      await page.setViewportSize({ width: 1100, height: 900 })
      await page
        .getByRole('button', { name: /^新会话/u })
        .filter({ visible: true })
        .first()
        .click()
      const harness = page.locator('.workbench-home .harness-picker').filter({ visible: true }).first()
      if (!(await harness.innerText()).includes('Codex')) {
        await harness.click()
        await page
          .getByRole('option', { name: /^Codex/u })
          .or(page.getByRole('menuitemradio', { name: /^Codex/u }))
          .first()
          .click()
      }
      await page.locator('.workbench-home .usage-chip').first().waitFor({ state: 'attached' })
      // On the start page the limit ends the line that says where the session starts, each window after its own disc.
      const [place, mark] = await Promise.all([
        page.locator('.workbench-home .home-place').boundingBox(),
        page.locator('.workbench-home .home-place .usage-chip').boundingBox(),
      ])
      expect(mark!.y).toBeGreaterThanOrEqual(place!.y - 1)
      expect(mark!.y + mark!.height).toBeLessThanOrEqual(place!.y + place!.height + 1)
      expect(await page.locator('.workbench-home .usage-chip .usage-pie').count()).toBeGreaterThan(0)
      await step('start')
      long = true
      await step('start, long values')
      long = false
      // Without the limit.
      await page.addStyleTag({ content: '.composer-usage { display: none !important; }' })
      await step('start, no limit')
      await openSession(page, sessions.codex)
      await step('session, no limit')
    } finally {
      await context.close()
    }
  })

  it('opens the surface as a sheet on a phone', async () => {
    const page = await open(390, 'light', sessions.codex)
    try {
      await chip(page).getByText('5 小时 12% · 周 68%', { exact: true }).waitFor()
      await chip(page)
        .tap()
        .catch(() => chip(page).click())
      await surface(page).getByText('每周', { exact: true }).waitFor()
      const box = (await surface(page).boundingBox())!
      // A sheet spans the phone and stands on its bottom edge.
      expect(box.width).toBeGreaterThan(380)
      expect(Math.round(box.y + box.height)).toBe(900)
      await noHorizontalOverflow(page)
      await surface(page).getByRole('button', { name: '关闭', exact: true }).click()
      await surface(page).waitFor({ state: 'hidden' })
    } finally {
      await page.context().close()
    }
  })

  it('draws no chip for a Harness that never reports limits, and names it in one quiet line in the surface', async () => {
    expect(await quota('other')).toBeUndefined()
    await capture('none', sessions.other, undefined)
    const page = await open(1440, 'light', sessions.other)
    try {
      await page.keyboard.press('Alt+Shift+U')
      // A Harness whose program never reports limits is named in one quiet line at the end, not a section of its own.
      const silent = surface(page).locator('.usage-silent')
      await silent.getByText('不报告额度', { exact: true }).waitFor()
      expect(await silent.textContent()).toContain('Other')
      expect(await surface(page).getByRole('region', { name: 'Other', exact: true }).count()).toBe(0)
      await page.screenshot({ path: `${OUTPUT}/none-panel--1440-light.png`, animations: 'disabled' })
    } finally {
      await page.context().close()
    }
  })

  it('says a warning Claude gave without a figure is the limit, with its reset time and no bar', async () => {
    expect(await quota('claude')).toMatchObject({ windows: [{ kind: 'five-hour', state: 'near' }], state: 'near' })
    const page = await open(1440, 'light', sessions.claude)
    try {
      await chip(page).getByText('5 小时 将用尽', { exact: true }).waitFor()
      expect(await chip(page).getAttribute('data-state')).toBe('near')
      expect(await chip(page).getAttribute('aria-label')).toMatch(/^Claude Agent 额度：5 小时 将用尽，2 小时 2\d 分钟后重置$/u)
      expect(await chip(page).locator('.usage-chip-bar').count()).toBe(0)
      expect(await chip(page).textContent()).not.toContain('%')
      await chip(page).click()
      const claude = surface(page).getByRole('region', { name: 'Claude Agent', exact: true })
      // One line: the window, then its state and when it resets; no bar.
      await claude.getByText(/^将用尽 · 2 小时 2\d 分钟后重置$/u).waitFor()
      expect(await claude.getByRole('meter').count()).toBe(0)
      await page.screenshot({ path: `${OUTPUT}/warning-panel--1440-light.png`, animations: 'disabled' })
    } finally {
      await page.context().close()
    }
    await capture('warning', sessions.claude, '5 小时 将用尽')
  })

  it('opens every Harness from the one global entry by click, keyboard or shortcut, never on hover; a sheet on a phone', async () => {
    for (const width of [1440, 768, 390]) {
      for (const theme of ['light', 'dark'] as const) {
        const phone = width === 390
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          colorScheme: theme,
          hasTouch: phone,
          reducedMotion: 'reduce',
        })
        const page = await context.newPage()
        page.setDefaultTimeout(15_000)
        try {
          await enrollBrowser(page, host, { scopes: ['view', 'run', 'admin'] })
          // A phone's entry is in the start screen's head, over the list it opens on (cae787a4).
          await phoneStartScreen(page)
          const entry = page.locator('.usage-entry:visible').first()
          if (phone) await entry.tap()
          else {
            await entry.hover()
            await page.waitForTimeout(600)
            expect(await surface(page).isVisible()).toBe(false)
            await entry.focus()
            await entry.press('Enter')
          }
          await surface(page).waitFor()
          const codex = surface(page).getByRole('region', { name: 'Codex', exact: true })
          const claude = surface(page).getByRole('region', { name: 'Claude Agent', exact: true })
          await codex.getByText('已用 68%', { exact: true }).waitFor()
          await codex
            .locator('.usage-facts')
            .getByText(/^Plus ?· ?p•••@e•••\.com$/u)
            .waitFor()
          // One line: the window, then its state and when it resets; no bar.
          await claude.getByText(/^将用尽 · 2 小时 2\d 分钟后重置$/u).waitFor()
          expect(await surface(page).locator('.usage-silent').textContent()).toBe('不报告额度Other')
          expect(await claude.getByRole('meter').count()).toBe(0)
          expect(await surface(page).getByRole('meter').count()).toBe(2)
          await noHorizontalOverflow(page)
          await page.screenshot({ path: `${OUTPUT}/host-panel--${width}-${theme}.png`, animations: 'disabled' })
          if (phone) {
            expect(await surface(page).evaluate(element => element.matches('.ui-sheet:modal'))).toBe(true)
            await surface(page).getByRole('button', { name: '关闭', exact: true }).tap()
            await surface(page).waitFor({ state: 'hidden' })
          } else {
            // Focus went in to the first meaningful control, not the close button, and comes back to the entry.
            expect(
              await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent),
            ).not.toBe('关闭')
            await page.keyboard.press('Escape')
            await surface(page).waitFor({ state: 'hidden' })
            expect(await entry.evaluate(element => element === document.activeElement)).toBe(true)
            // The shortcut printed on the entry opens and closes it from anywhere.
            await page.keyboard.press('Alt+Shift+U')
            await surface(page).waitFor()
            await page.keyboard.press('Alt+Shift+U')
            await surface(page).waitFor({ state: 'hidden' })
          }
        } finally {
          await context.close()
        }
      }
    }
  })

  it('keeps the last limits while offline, lets them expire, and shows only the newly opened Host', async () => {
    const nextHost = await startTestHost({ demo: false })
    const context = await browser.newContext({ viewport: { width: 800, height: 400 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    try {
      await page.clock.install()
      await enrollBrowser(page, host, { scopes: ['view', 'run', 'admin'] })
      await page.keyboard.press('Alt+Shift+U')
      const codex = surface(page).getByRole('region', { name: 'Codex', exact: true })
      await codex.getByText('已用 68%', { exact: true }).waitFor()
      await context.setOffline(true)
      await surface(page).getByText('连接中断，显示上次收到的额度', { exact: true }).waitFor()
      await codex.getByText('已用 68%', { exact: true }).waitFor()
      await page.clock.fastForward(150 * HOUR)
      await codex.getByText('尚未报告额度', { exact: true }).waitFor()
      expect(await surface(page).getByRole('meter').count()).toBe(0)

      await context.setOffline(false)
      await page.clock.setSystemTime(Date.now())
      await page.reload()
      await connected(page)
      await page.keyboard.press('Alt+Shift+U')
      await codex.getByText('已用 68%', { exact: true }).waitFor()

      // A narrower device starts the surface's body afresh and reads again; it still sees what view allows.
      const id = await page.evaluate(async () => (await (await fetch('/link/api/snapshot')).json()).device.id as string)
      await owner.json(`devices/${id}`, { method: 'PATCH', body: { scopes: ['view', 'run'] } })
      await codex.getByText('已用 68%', { exact: true }).waitFor()
      await page.keyboard.press('Escape')
      await surface(page).waitFor({ state: 'hidden' })
      await enrollBrowser(page, nextHost, { scopes: ['view', 'run', 'admin'] })
      await page.keyboard.press('Alt+Shift+U')
      await surface(page).waitFor()
      expect(
        await surface(page)
          .getByText(/p•••@e•••/u)
          .count(),
      ).toBe(0)
    } finally {
      await context.close()
      await nextHost.close()
    }
  })
})
