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
  const chip = (page: Page) => page.locator('main.workspace:not([inert]) form.composer .usage-chip')
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

  it('names the tightest window and its figure on the chip, opens the surface on that Harness, and follows what the next turn reports', async () => {
    await expect.poll(async () => (await quota('codex'))?.windows.length).toBe(2)
    const page = await open(1440, 'light', sessions.codex)
    try {
      await chip(page).getByText('每周已用 68%', { exact: true }).waitFor()
      expect(await chip(page).getAttribute('data-state')).toBe('ok')
      // The chip stands after every control, right before send.
      const order = await page
        .locator('main.workspace:not([inert]) form.composer')
        .locator('[data-composer-control], .composer-usage')
        .evaluateAll(items => items.map(item => item.getAttribute('data-composer-control') ?? 'usage'))
      expect(order).toEqual(['harness', 'model', 'thinking', 'permission', 'usage'])
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
      await chip(page).getByText('5 小时已用 86%', { exact: true }).waitFor()
      expect(await chip(page).getAttribute('data-state')).toBe('near')
      expect(await chip(page).getAttribute('aria-label')).toMatch(/^Codex 额度：5 小时已用 86% · 2 小时 2\d 分钟后重置$/u)
    } finally {
      await page.context().close()
    }
    await capture('near', sessions.codex, '5 小时已用 86%', true)
    await push(86, 100)
    await expect.poll(async () => (await quota('codex'))?.state).toBe('limited')
    await capture('limited', sessions.codex, '每周已用 100%', true)
    await push(12, 68)
    await expect.poll(async () => (await quota('codex'))?.state).toBe('ok')
    await capture('ok', sessions.codex, '每周已用 68%', true)
  })

  it('moves no control when the chip comes or goes, at any width, and keeps it in sight at 390', async () => {
    // The chip arrives seconds after a turn starts and leaves with the Host's memory. Its coming and going is drawn here
    // by taking it out of the layout: where the Harness, model, thinking and permission controls stand must not change.
    for (const width of [1440, 768, 390]) {
      const page = await open(width, 'light', sessions.codex)
      try {
        await chip(page).getByText('每周已用 68%', { exact: true }).waitFor()
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
        expect(withChip.boxes.map(box => box[0])).toEqual(['harness', 'model', 'thinking', 'permission'])
        const box = (await chip(page).boundingBox())!
        expect(box.x >= 0 && box.x + box.width <= width && box.width > 0, `${width}`).toBe(true)
        const hidden = await page.addStyleTag({ content: '.composer-usage { display: none !important; }' })
        expect(await chip(page).isVisible()).toBe(false)
        expect({ boxes: await boxes(), height: await height() }, `${width}`).toEqual(withChip)
        await hidden.evaluate(style => style.parentNode?.removeChild(style))
        await chip(page).getByText('每周已用 68%', { exact: true }).waitFor()
        expect({ boxes: await boxes(), height: await height() }, `${width}`).toEqual(withChip)
      } finally {
        await page.context().close()
      }
    }
  })

  it('opens the surface as a sheet on a phone', async () => {
    const page = await open(390, 'light', sessions.codex)
    try {
      await chip(page).getByText('每周已用 68%', { exact: true }).waitFor()
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
      await chip(page).getByText('5 小时额度将用尽', { exact: true }).waitFor()
      expect(await chip(page).getAttribute('data-state')).toBe('near')
      expect(await chip(page).getAttribute('aria-label')).toMatch(/^Claude Agent 额度：5 小时额度将用尽 · 2 小时 2\d 分钟后重置$/u)
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
    await capture('warning', sessions.claude, '5 小时额度将用尽')
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
