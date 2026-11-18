import { chromium, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { latchEnv } from '@latch/host/env'
import type { WorkItemAnswer, WorkThreadAnswer } from '@latch/protocol'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow, reachable } from './helpers/layout.ts'
import { stillMotion } from './helpers/visual.ts'

async function hasLanguage(page: Page, language: 'en' | 'zh-CN') {
  await expect.poll(() => page.locator('html').getAttribute('lang')).toBe(language)
}

async function capture(page: Page, width: number, language: 'en' | 'zh-CN', surface: string) {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await noHorizontalOverflow(page)
    if (process.env.LATCH_I18N_CAPTURE !== '1') continue
    const directory = 'test-results/i18n'
    await mkdir(directory, { recursive: true })
    await page.screenshot({
      path: join(directory, [surface, width, language, colorScheme].join('--') + '.png'),
      animations: 'disabled',
      caret: 'hide',
    })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

/** A reachable segment can still have text clipped by its card. */
async function wholeLanguageButtons(page: Page) {
  const overflow = await page.locator('.display-language, .work-details-choice').evaluateAll(controls =>
    controls.flatMap(control => {
      const card = control.closest('.settings-card')?.getBoundingClientRect()
      return [...control.querySelectorAll<HTMLElement>('.ui-segmented-label')].flatMap(label => {
        const box = label.getBoundingClientRect()
        return label.scrollWidth <= label.clientWidth + 1 && (!card || (box.left >= card.left - 1 && box.right <= card.right + 1))
          ? []
          : [label.textContent]
      })
    }),
  )
  expect(overflow).toEqual([])
}

it.each([320, 390, 768, 1100, 1440])('preserves the draft, caret and focus when switching languages at %i px', async width => {
  const testHost = await startTestHost({
    demo: true,
    hostName: 'Test computer',
    uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
  })
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    const phone = width < 768
    const context = await browser.newContext({
      locale: 'en-US',
      viewport: { width, height: phone ? 844 : 900 },
      isMobile: phone,
      hasTouch: phone,
    })
    await stillMotion(context)
    const page = await context.newPage()
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'languages', { configurable: true, get: () => ['en-US', 'zh-TW'] })
    })
    await enrollBrowser(page, testHost, { followSystemLanguage: true })
    await hasLanguage(page, 'en')

    if (phone) await page.locator('.phone-list-head').getByRole('button').click()
    const draft = page.locator('.workbench-home').getByRole('textbox').first()
    await draft.fill('draft to keep')
    const input = await draft.elementHandle()
    await input.evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(2, 6))
    let navigations = 0
    page.on('request', request => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations += 1
    })

    await capture(page, width, 'en', 'composer')
    const composerUrl = page.url()
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'languages', { configurable: true, get: () => ['zh-TW', 'en-US'] })
      window.dispatchEvent(new Event('languagechange'))
    })
    await hasLanguage(page, 'zh-CN')
    expect(page.url()).toBe(composerUrl)
    expect(
      await input.evaluate(element => {
        const field = element as HTMLTextAreaElement
        return [field === document.activeElement, field.value, field.selectionStart, field.selectionEnd]
      }),
    ).toEqual([true, 'draft to keep', 2, 6])
    await capture(page, width, 'zh-CN', 'composer')

    await page.getByTestId('open-settings').filter({ visible: true }).first().click()
    await page.locator('#settings-tab-general').click()
    const languages = page.locator('.display-language')
    const english = languages.getByRole('radio', { name: 'English' })
    await reachable(english)
    await wholeLanguageButtons(page)
    await capture(page, width, 'zh-CN', 'language')
    const settingsUrl = page.url()
    await english.click()
    await hasLanguage(page, 'en')
    expect(page.url()).toBe(settingsUrl)
    expect(await english.evaluate(node => document.activeElement === node)).toBe(true)
    await wholeLanguageButtons(page)
    await capture(page, width, 'en', 'language')

    await page.getByTestId('close-settings').click()
    expect(
      await input.evaluate(element => {
        const field = element as HTMLTextAreaElement
        return [field.isConnected, field.value, field.selectionStart, field.selectionEnd]
      }),
    ).toEqual([true, 'draft to keep', 2, 6])
    expect(navigations).toBe(0)

    await page.reload()
    await connected(page)
    await hasLanguage(page, 'en')
  } finally {
    await browser.close()
    await testHost.close()
  }
})

it('posts from the English board and reopens the same multilingual work item', async () => {
  const host = await startTestHost({ demo: true, uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web') })
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const title = '验收报告 · Release'
    const body = '保留原文 — build evidence checked.'
    const { item } = await owner.json<WorkItemAnswer>('work/items', {
      method: 'POST',
      body: { requestId: randomUUID(), title, prompt: 'Check the release notes.' },
    })
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US', reducedMotion: 'reduce' })
    await stillMotion(context)
    const page = await context.newPage()
    await enrollBrowser(page, host, { name: 'English work board', scopes: ['admin'], followSystemLanguage: true })
    await hasLanguage(page, 'en')
    const board = page
      .locator('.view-switch:visible')
      .first()
      .getByRole('radio', { name: /^Board/u })
    await board.click()
    await page
      .locator('.work-board-states')
      .getByRole('button', { name: /^Not started/u })
      .click()
    const card = page.locator(`[data-work-item="${item.id}"] .work-board-card-main`)
    await card.click()
    const detail = page.locator(`.item-page[data-item-id="${item.id}"]`)
    await detail.getByRole('heading', { level: 1 }).getByText(title, { exact: true }).waitFor()
    const post = detail.getByRole('combobox', { name: 'Post', exact: true })
    await post.fill(body)
    await detail.getByRole('button', { name: 'Send', exact: true }).click()
    const posts = async () => (await owner.json<WorkThreadAnswer>(`work/items/${item.id}/posts`)).posts.map(row => row.text)
    await expect.poll(posts).toEqual([body])
    await detail.getByText(body, { exact: true }).waitFor()
    await capture(page, 390, 'en', 'work-discussion')
    await detail.getByRole('button', { name: 'Board', exact: true }).click()
    await card.click()
    await detail.getByRole('heading', { level: 1 }).getByText(title, { exact: true }).waitFor()
    await detail.getByText(body, { exact: true }).waitFor()
    await hasLanguage(page, 'en')
  } finally {
    await browser.close()
    await host.close()
  }
})
