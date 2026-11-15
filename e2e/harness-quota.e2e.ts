import { chromium, type Browser, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppSnapshot, TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, FAKE_CODEX_APP_SERVER, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSession } from './helpers/layout.ts'

const OUTPUT = 'test-results/harness-quota'
const HOUR = 3_600_000
const seconds = (ms: number) => Math.floor(ms / 1000)

/**
 * A Harness's subscription limits beside its control (docs/HARNESSES.md#额度). Codex is the fake app-server, answering
 * `account/rateLimits/read` and pushing `account/rateLimits/updated` in Codex 0.167's shapes; the warning without a figure
 * is the fake ACP agent under Claude Agent's profile, sending the adapter's `_claude/rateLimit`. No program of this
 * computer runs and no vendor is called.
 */
describe('a Harness’s limits beside its control', () => {
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
  const mark = (page: Page) => page.locator('main.workspace:not([inert]) form.composer .quota-mark')

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
  /** The session at the three widths in both themes, with the panel open at the end when `panel` names its figure. */
  async function capture(state: string, session: string, shown: string | RegExp | undefined, panel = false): Promise<void> {
    for (const width of [1440, 768, 390])
      for (const theme of ['light', 'dark'] as const) {
        const page = await open(width, theme, session)
        try {
          if (shown === undefined) expect(await mark(page).count()).toBe(0)
          else await mark(page).getByText(shown, { exact: true }).waitFor()
          await noHorizontalOverflow(page)
          await page.screenshot({ path: `${OUTPUT}/${state}--${width}-${theme}.png`, animations: 'disabled' })
          if (panel) {
            await mark(page).click()
            await page.getByRole('dialog', { name: 'Codex 额度', exact: true }).waitFor()
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

  it('shows the fullest window as a ring and a figure, the window behind hover, every window in the panel, and follows what the next turn reports', async () => {
    await expect.poll(async () => (await quota('codex'))?.windows.length).toBe(2)
    const page = await open(1440, 'light', sessions.codex)
    try {
      await mark(page).getByText('68%', { exact: true }).waitFor()
      expect(await mark(page).getAttribute('data-state')).toBe('ok')
      expect(await mark(page).locator('.quota-ring').count()).toBe(1)
      // The mark stands after every control, right before send.
      const order = await page
        .locator('main.workspace:not([inert]) form.composer')
        .locator('[data-composer-control], .composer-quota')
        .evaluateAll(items => items.map(item => item.getAttribute('data-composer-control') ?? 'quota'))
      expect(order).toEqual(['harness', 'model', 'thinking', 'permission', 'quota'])
      // The line names the window as the panel's row does.
      await mark(page).hover()
      await page.getByRole('tooltip').getByText('每周额度已用 68% · 5 天 23 小时后重置', { exact: true }).waitFor()
      await page.screenshot({ path: `${OUTPUT}/ok-hover--1440-light.png`, animations: 'disabled' })

      await mark(page).click()
      const panel = page.getByRole('dialog', { name: 'Codex 额度', exact: true })
      await panel.waitFor()
      const rows = await panel.locator('.quota-row').evaluateAll(items => items.map(item => (item.textContent ?? '').replace(/\s+/gu, ' ')))
      expect(rows[0]).toMatch(/^5 小时12%2 小时 2\d 分钟后重置$/u)
      expect(rows[1]).toBe('每周68%5 天 23 小时后重置')
      expect(rows).toHaveLength(2)
      expect(await panel.getByRole('meter').count()).toBe(2)
      // The plan and the account, masked on the Host: the address itself never reaches the page.
      await panel.getByText('Plus · p•••@e•••.com', { exact: true }).waitFor()
      expect(await page.content()).not.toContain('person@example.com')
      await page.keyboard.press('Escape')
      await panel.waitFor({ state: 'hidden' })

      // The next turn's report reaches the open page by itself: amber from 80%, red at the limit, each with its figure.
      await push(86, 68)
      await mark(page).getByText('86%', { exact: true }).waitFor()
      expect(await mark(page).getAttribute('data-state')).toBe('near')
      expect(await mark(page).getAttribute('aria-label')).toMatch(/^Codex 额度：5 小时额度已用 86% · 2 小时 2\d 分钟后重置$/u)
    } finally {
      await page.context().close()
    }
    await capture('near', sessions.codex, '86%', true)
    await push(86, 100)
    await expect.poll(async () => (await quota('codex'))?.state).toBe('limited')
    await capture('limited', sessions.codex, '100%', true)
    await push(12, 68)
    await expect.poll(async () => (await quota('codex'))?.state).toBe('ok')
    await capture('ok', sessions.codex, '68%', true)
  })

  it('moves no control when the mark comes or goes, at any width', async () => {
    // The mark arrives seconds after a turn starts and leaves with the Host's memory. Its coming and going is drawn here
    // by taking it out of the layout: where the Harness, model, thinking and permission controls stand must not change.
    for (const width of [1440, 768, 390]) {
      const page = await open(width, 'light', sessions.codex)
      try {
        await mark(page).getByText('68%', { exact: true }).waitFor()
        const composer = page.locator('main.workspace:not([inert]) form.composer')
        const boxes = () =>
          composer.locator('[data-composer-control]').evaluateAll(items =>
            items.map(item => {
              const box = item.getBoundingClientRect()
              return [item.getAttribute('data-composer-control'), Math.round(box.x), Math.round(box.y), Math.round(box.width)]
            }),
          )
        const height = async () => Math.round((await composer.boundingBox())!.height)
        const withMark = { boxes: await boxes(), height: await height() }
        expect(withMark.boxes.map(box => box[0])).toEqual(['harness', 'model', 'thinking', 'permission'])
        const hidden = await page.addStyleTag({ content: '.composer-quota { display: none !important; }' })
        expect(await mark(page).isVisible()).toBe(false)
        expect({ boxes: await boxes(), height: await height() }, `${width}`).toEqual(withMark)
        await hidden.evaluate(style => style.parentNode?.removeChild(style))
        await mark(page).getByText('68%', { exact: true }).waitFor()
        expect({ boxes: await boxes(), height: await height() }, `${width}`).toEqual(withMark)
      } finally {
        await page.context().close()
      }
    }
  })

  it('opens the panel as a sheet on a phone', async () => {
    const page = await open(390, 'light', sessions.codex)
    try {
      await mark(page).getByText('68%', { exact: true }).waitFor()
      await mark(page)
        .tap()
        .catch(() => mark(page).click())
      const sheet = page.getByRole('dialog', { name: 'Codex 额度', exact: true })
      await sheet.waitFor()
      await sheet.getByText('每周', { exact: true }).waitFor()
      const box = (await sheet.boundingBox())!
      // A sheet spans the phone and stands on its bottom edge.
      expect(box.width).toBeGreaterThan(380)
      expect(Math.round(box.y + box.height)).toBe(900)
      await noHorizontalOverflow(page)
    } finally {
      await page.context().close()
    }
  })

  it('shows nothing for a Harness that reports nothing', async () => {
    expect(await quota('other')).toBeUndefined()
    await capture('none', sessions.other, undefined)
  })

  it('shows a warning Claude gave as the alert mark with its reset time, without a ring or a figure', async () => {
    expect(await quota('claude')).toMatchObject({ windows: [{ kind: 'five-hour', state: 'near' }], state: 'near' })
    const page = await open(1440, 'light', sessions.claude)
    try {
      await mark(page).getByText('2 小时后重置', { exact: true }).waitFor()
      expect(await mark(page).getAttribute('data-state')).toBe('near')
      expect(await mark(page).getAttribute('aria-label')).toMatch(/^Claude Agent 额度：5 小时额度将用尽 · 2 小时 2\d 分钟后重置$/u)
      expect(await mark(page).locator('.quota-ring').count()).toBe(0)
      expect(await mark(page).textContent()).not.toContain('%')
      await mark(page).click()
      const panel = page.getByRole('dialog', { name: 'Claude Agent 额度', exact: true })
      await panel.getByText('将用尽', { exact: true }).waitFor()
      expect(await panel.getByRole('meter').count()).toBe(0)
      await page.screenshot({ path: `${OUTPUT}/warning-panel--1440-light.png`, animations: 'disabled' })
    } finally {
      await page.context().close()
    }
    await capture('warning', sessions.claude, '2 小时后重置')
  })

  it('workbench quota gathers current Host reports near settings, with a focus-neutral preview, a keyboard panel and a touch sheet', async () => {
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
          const control = page.locator('button.host-quota-trigger:visible')
          const panel = page.getByRole('dialog', { name: 'Harness 额度', exact: true })
          if (phone) await control.tap()
          else {
            const editor = page.locator('.workbench-home form.composer textarea')
            await editor.focus()
            await control.hover()
            await panel.waitFor()
            expect(await editor.evaluate(element => element === document.activeElement)).toBe(true)
            await panel.hover()
            await expect.poll(() => panel.isVisible()).toBe(true)
            await page.keyboard.press('Escape')
            await panel.waitFor({ state: 'hidden' })
            expect(await editor.evaluate(element => element === document.activeElement)).toBe(true)
            await control.focus()
            await control.press('Enter')
            await panel.getByRole('button', { name: '关闭额度' }).waitFor()
          }
          const codex = panel.getByRole('region', { name: 'Codex', exact: true })
          const claude = panel.getByRole('region', { name: 'Claude Agent', exact: true })
          await codex.getByText('已用 68%', { exact: true }).waitFor()
          await codex.getByText('Plus · p•••@e•••.com', { exact: true }).waitFor()
          await claude.getByText('将用尽', { exact: true }).waitFor()
          expect(await panel.getByRole('region', { name: 'Other', exact: true }).count()).toBe(0)
          expect(await claude.getByRole('meter').count()).toBe(0)
          expect(await panel.getByRole('meter').count()).toBe(2)
          await noHorizontalOverflow(page)
          await page.screenshot({ path: `${OUTPUT}/host-panel--${width}-${theme}.png`, animations: 'disabled' })
          if (phone) {
            expect(await panel.evaluate(element => element.tagName)).toBe('DIALOG')
            const underSheet = await control.evaluate(element => {
              const box = element.getBoundingClientRect()
              const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
              return {
                sheetTakesTap: Boolean(hit?.closest('.ui-sheet:modal')),
                nativeHighlight: getComputedStyle(element).getPropertyValue('-webkit-tap-highlight-color'),
              }
            })
            expect(underSheet).toEqual({ sheetTakesTap: true, nativeHighlight: 'rgba(0, 0, 0, 0)' })
            await panel.getByRole('button', { name: '关闭', exact: true }).tap()
          } else {
            await page.keyboard.press('Tab')
            expect(await panel.isVisible()).toBe(true)
            await page.keyboard.press('Escape')
          }
          await panel.waitFor({ state: 'hidden' })
          if (phone) {
            expect(await control.evaluate(element => element === document.activeElement)).toBe(true)
          } else {
            // If Tab left the non-modal panel, closing preserves the focus already elsewhere.
            await control.focus()
            await control.press('Enter')
            const close = panel.getByRole('button', { name: '关闭额度' })
            await expect.poll(() => close.evaluate(element => element === document.activeElement)).toBe(true)
            await page.keyboard.press('Escape')
            await panel.waitFor({ state: 'hidden' })
            expect(await control.evaluate(element => element === document.activeElement)).toBe(true)
            await control.press('Enter')
            await panel.waitFor()
            await page.keyboard.press('Control+K')
            const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
            await palette.waitFor()
            await panel.waitFor({ state: 'hidden' })
            await page.keyboard.press('Escape')
            await palette.waitFor({ state: 'hidden' })
          }
        } finally {
          await context.close()
        }
      }
    }
  })

  it('workbench quota stays scrollable offline, expires, and uses only the newly opened Host', async () => {
    const nextHost = await startTestHost({ demo: false })
    const context = await browser.newContext({ viewport: { width: 800, height: 400 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    try {
      await page.clock.install()
      await enrollBrowser(page, host, { scopes: ['view', 'run', 'admin'] })
      const control = page.locator('button.host-quota-trigger:visible')
      const panel = page.getByRole('dialog', { name: 'Harness 额度', exact: true })
      await control.hover()
      await panel.waitFor()
      await panel.hover()
      await page.mouse.wheel(0, 130)
      await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
      await panel.getByRole('region', { name: 'Claude Agent', exact: true }).waitFor()
      await context.setOffline(true)
      await panel.getByText('连接中断，显示上次收到的额度。', { exact: true }).waitFor()
      await panel.getByText('已用 68%', { exact: true }).waitFor()
      await page.clock.fastForward(150 * HOUR)
      await panel.getByText('尚未收到有效额度。', { exact: true }).waitFor()
      expect(await panel.getByRole('region').count()).toBe(0)

      await context.setOffline(false)
      await page.clock.setSystemTime(Date.now())
      await page.reload()
      await connected(page)
      await control.focus()
      await control.press('Enter')
      await panel.getByText('已用 68%', { exact: true }).waitFor()

      const id = await page.evaluate(async () => (await (await fetch('/link/api/snapshot')).json()).device.id as string)
      await owner.json(`devices/${id}`, { method: 'PATCH', body: { scopes: ['view', 'run'] } })
      await panel.waitFor({ state: 'hidden' })
      await control.focus()
      await control.press('Enter')
      await panel.getByText('已用 68%', { exact: true }).waitFor()
      await enrollBrowser(page, nextHost, { scopes: ['view', 'run', 'admin'] })
      await panel.waitFor({ state: 'hidden' })
      await control.focus()
      await control.press('Enter')
      await panel.getByText('尚未收到有效额度。', { exact: true }).waitFor()
      expect(await panel.getByText(/p•••@e•••/u).count()).toBe(0)
    } finally {
      await context.close()
      await nextHost.close()
    }
  })
})
