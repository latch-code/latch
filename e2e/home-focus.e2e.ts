import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium, type Browser, type Page } from '@playwright/test'
import { latchEnv } from '@latch/host/env'
import type { TaskDetail } from '@latch/protocol'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { closeSettings, noHorizontalOverflow, openSection, openSettings, reachable } from './helpers/layout.ts'
import { homeInput, switchLayout } from './helpers/workbench.ts'

const OUT = 'test-results/home-focus'
const MODEL = { providerId: 'home-focus', model: 'local-release-review-v1' }
let browser: Browser
let host: TestHost
let waiting: string

beforeAll(async () => {
  host = await startTestHost({
    uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
    demo: false,
    hostName: '验收电脑',
    providerId: MODEL.providerId,
    plugins: [
      {
        id: MODEL.providerId,
        name: '首页专注验收',
        version: '1',
        description: 'Local fixture only.',
        activate(context) {
          context.registerProvider({
            id: MODEL.providerId,
            name: '本地验收模型',
            model: MODEL.model,
            async *stream({ messages }) {
              if (['整理本地发布说明', '归档下一份发布说明'].includes(messages.at(-1)?.content ?? '')) {
                yield {
                  type: 'tool-call',
                  call: { id: randomUUID(), name: 'write_file', arguments: { path: 'release.md', content: '验收说明' } },
                }
                yield { type: 'finish', reason: 'tool-calls' }
                return
              }
              yield { type: 'text', text: '草稿已收到。' }
              yield { type: 'finish', reason: 'stop' }
            },
          })
        },
      },
    ],
  })
  const owner = await host.enroll({ listener: 'unix' })
  const started = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { requestId: randomUUID(), prompt: '整理本地发布说明', model: MODEL, mode: 'agent' },
  })
  waiting = started.sessionId
  await vi.waitFor(async () => expect((await owner.json<TaskDetail>(`tasks/${waiting}`)).approvals).toHaveLength(1))
  await mkdir(OUT, { recursive: true })
  browser = await chromium.launch(browserLaunchOptions())
})

afterAll(async () => {
  await browser?.close()
  await host?.close()
})

const focused = (page: Page) => page.locator('.app-shell[data-home-focus]')
const shown = (page: Page) => focused(page).waitFor()
const returned = (page: Page) => focused(page).waitFor({ state: 'detached' })

async function captureFocus(page: Page, name: string) {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await page.screenshot({ path: `${OUT}/${name}-${theme}.png`, animations: 'disabled' })
  }
}

it.each(['light', 'dark'] as const)('moves the same input card on the way into and out of desktop focus in %s', async colorScheme => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    reducedMotion: 'no-preference',
    colorScheme,
  })
  try {
    const page = await context.newPage()
    await enrollBrowser(page, host, { name: '专注动效验收', scopes: ['admin'] })
    await switchLayout(page, 'overview')
    const input = homeInput(page)
    const card = page.locator('.workbench-home-composer')
    const original = await input.elementHandle()
    expect(original).not.toBeNull()
    for (const entering of [true, false]) {
      const sample = await card.evaluateHandle(element => {
        const shell = element.closest('.app-shell')!
        const before = element.getBoundingClientRect().top
        const titlebar = shell.querySelector('.titlebar')!
        const beforeOpacity = Number(getComputedStyle(titlebar).opacity)
        const moving = () =>
          element
            .getAnimations()
            .find(
              animation =>
                animation.effect instanceof KeyframeEffect
                && animation.effect
                  .getKeyframes()
                  .some(frame => typeof frame.transform === 'string' && frame.transform.startsWith('translate')),
            )
        const fading = () =>
          titlebar.getAnimations().find(animation => animation instanceof CSSTransition && animation.transitionProperty === 'opacity')
        return {
          finish: () => {
            moving()?.finish()
            fading()?.finish()
          },
          result: new Promise(resolve => {
            const observer = new MutationObserver(() => {
              observer.disconnect()
              const move = moving()
              const fade = fading()
              if (!move || !fade) {
                resolve(null)
                return
              }
              move.pause()
              fade.pause()
              const duration = Number(move.effect?.getTiming().duration)
              move.currentTime = 0
              const start = element.getBoundingClientRect().top
              move.currentTime = duration
              const last = element.getBoundingClientRect().top
              move.currentTime = duration / 6
              fade.currentTime = Number(fade.effect?.getTiming().duration) / 6
              resolve({
                before,
                start,
                middle: element.getBoundingClientRect().top,
                last,
                beforeOpacity,
                opacity: Number(getComputedStyle(titlebar).opacity),
                overflow: getComputedStyle(element.closest('.code-home-input')!).overflow,
              })
            })
            observer.observe(shell, { attributes: true, attributeFilter: ['data-home-focus'] })
          }) as Promise<{
            before: number
            start: number
            middle: number
            last: number
            beforeOpacity: number
            opacity: number
            overflow: string
          } | null>,
        }
      })
      if (entering) await input.click()
      else await page.keyboard.press('Escape')
      const position = await sample.evaluate(entry => entry.result)
      expect(position).not.toBeNull()
      expect(position!.start).toBeCloseTo(position!.before, 0)
      expect(position!.middle).toBeGreaterThan(Math.min(position!.before, position!.last))
      expect(position!.middle).toBeLessThan(Math.max(position!.before, position!.last))
      expect(Math.abs(position!.last - position!.before)).toBeGreaterThan(100)
      expect(position!.beforeOpacity).toBe(entering ? 1 : 0)
      expect(position!.opacity).toBeGreaterThan(0)
      expect(position!.opacity).toBeLessThan(1)
      expect(position!.overflow).toBe('visible')
      expect(await original!.evaluate(node => document.activeElement === node)).toBe(true)
      await page.screenshot({ path: `${OUT}/moving-${entering ? 'in' : 'out'}-${colorScheme}.png` })
      await sample.evaluate(entry => entry.finish())
      await sample.dispose()
      if (entering) {
        await input.fill('保留草稿与选区')
        await input.evaluate(node => (node as HTMLTextAreaElement).setSelectionRange(2, 4))
      }
    }
    expect(await input.inputValue()).toBe('保留草稿与选区')
    expect(
      await input.evaluate(node => [(node as HTMLTextAreaElement).selectionStart, (node as HTMLTextAreaElement).selectionEnd]),
    ).toEqual([2, 4])
  } finally {
    await context.close()
  }
})

/** Check the first visible state, without racing the arming timeout from a separate browser command. */
async function observeRevealedQueue(page: Page) {
  const queue = page.locator('.code-home-queue')
  await queue.evaluate(element => {
    const observer = new MutationObserver(() => {
      if (element.hasAttribute('inert')) return
      observer.disconnect()
      const card = element.querySelector('.approval-panel')
      element.setAttribute('data-test-return-arming', card ? (card.hasAttribute('data-arming') ? 'waiting' : 'ready') : 'absent')
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '2', code: 'Digit2', bubbles: true, cancelable: true }))
    })
    observer.observe(element, { attributeFilter: ['inert'] })
  })
  return queue
}

it.each(['send', 'scope'] as const)('rearms the retained decision when %s restores the queue', async exit => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
  let release!: () => void
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  try {
    const page = await context.newPage()
    const name = `专注防误触 ${exit}`
    await enrollBrowser(page, host, { name, scopes: ['admin'] })
    await switchLayout(page, 'triage')
    const input = homeInput(page)
    const decision = page.locator(`.code-home-queue [data-work-session="${waiting}"] .approval-panel`)
    await decision.waitFor()
    await expect.poll(() => decision.getAttribute('data-arming')).toBeNull()
    await input.fill('填写后返回队列')
    await shown(page)
    const queue = await observeRevealedQueue(page)
    const decisions: string[] = []
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.includes('/approvals/')) decisions.push(request.method())
    })
    if (exit === 'send') {
      let submitted = false
      await page.route('**/api/tasks', async route => {
        if (route.request().method() === 'POST') {
          submitted = true
          await held
        }
        await route.continue()
      })
      await page.locator('.workbench-home').getByRole('button', { name: '发送', exact: true }).click()
      await expect.poll(() => submitted).toBe(true)
    } else {
      const owner = await host.enroll({ listener: 'unix' })
      const device = host.host.security.devices.list().find(item => item.name === name)!
      await owner.json(`devices/${device.id}`, { method: 'PATCH', body: { scopes: ['view', 'approve:standard', 'approve:elevated'] } })
    }
    await returned(page)
    await expect.poll(() => queue.getAttribute('data-test-return-arming')).toMatch(exit === 'send' ? /^waiting$/u : /^(waiting|absent)$/u)
    expect(decisions).toEqual([])
  } finally {
    release()
    await context.close()
  }
})

it('keeps the real first characters, the menu and the same sender while hiding decision keys', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', colorScheme: 'dark' })
  try {
    const page = await context.newPage()
    await enrollBrowser(page, host, { name: '专注输入验收', scopes: ['admin'] })
    await switchLayout(page, 'triage')
    const home = page.locator('.workbench-home')
    const input = homeInput(page)
    await input.focus()
    expect(await focused(page).count()).toBe(0)
    const original = await input.elementHandle()
    expect(original).not.toBeNull()

    const project = home.getByRole('button', { name: /^项目：/u })
    await project.click()
    const projectMenu = page.getByRole('menu', { name: '项目', exact: true })
    await projectMenu.waitFor()
    const triggerNode = await project.elementHandle()
    const menuNode = await projectMenu.elementHandle()
    const item = await page.evaluateHandle(() => document.activeElement)
    await page.keyboard.press('Alt+n')
    await shown(page)
    expect(await triggerNode!.evaluate(node => node.isConnected)).toBe(true)
    expect(await menuNode!.evaluate(node => node.closest(':popover-open') !== null)).toBe(true)
    expect(await item.evaluate(node => document.activeElement === node)).toBe(true)
    await expect
      .poll(async () => {
        const trigger = (await project.boundingBox())!
        const layer = await menuNode!.evaluate(node => {
          const { top, bottom } = node.closest('.ui-popover')!.getBoundingClientRect()
          return { top, bottom }
        })
        return Math.min(Math.abs(trigger.y + trigger.height - layer.top), Math.abs(trigger.y - layer.bottom))
      })
      .toBeLessThanOrEqual(8)
    await page.keyboard.press('Escape')
    await projectMenu.waitFor({ state: 'hidden' })
    expect(await focused(page).count()).toBe(1)
    await page.keyboard.press('Escape')
    await returned(page)

    // Other controls use the same click to open their own layer; neither moves the resting input.
    const model = home.getByRole('button', { name: /^模型：/u })
    await model.click()
    await expect.poll(() => model.getAttribute('aria-expanded')).toBe('true')
    expect(await focused(page).count()).toBe(0)
    await page.keyboard.press('Escape')
    await expect.poll(() => model.getAttribute('aria-expanded')).not.toBe('true')
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      home.getByRole('button', { name: '添加文件…', exact: true }).click(),
    ])
    await fileChooser.setFiles({ name: 'release-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('fixture notes') })
    await reachable(home.getByRole('button', { name: 'release-notes.txt', exact: true }))
    expect(await focused(page).count()).toBe(0)
    await input.focus()

    const client = await context.newCDPSession(page)
    await client.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 })
    await shown(page)
    await client.send('Input.insertText', { text: '中文' })
    expect(await input.inputValue()).toBe('中文')
    expect(await original!.evaluate(node => node === document.activeElement)).toBe(true)
    expect(await page.locator('.code-home-queue').getAttribute('inert')).toBe('')
    expect(await page.locator('.workbench-nav').evaluate(node => node.closest('[inert]') !== null)).toBe(true)

    await input.fill('/')
    await expect.poll(() => input.getAttribute('aria-controls')).not.toBeNull()
    await page.keyboard.press('Escape')
    await expect.poll(() => input.getAttribute('aria-controls')).toBeNull()
    expect(await focused(page).count()).toBe(1)
    await page.keyboard.press('Escape')
    await returned(page)
    expect(await input.inputValue()).toBe('/')
    expect(await original!.evaluate(node => node === document.activeElement)).toBe(true)

    await input.fill('@')
    await shown(page)
    await page.getByRole('listbox', { name: '引用项目文件' }).waitFor()
    await page.keyboard.press('Escape')
    await page.getByRole('listbox', { name: '引用项目文件' }).waitFor({ state: 'hidden' })
    expect(await focused(page).count()).toBe(1)
    await page.keyboard.press('Escape')
    await returned(page)

    await input.click()
    await shown(page)
    await input.fill('长草稿保留。\n'.repeat(20))
    await model.click()
    await expect.poll(() => model.getAttribute('aria-expanded')).toBe('true')
    await page.keyboard.press('Escape')
    await expect.poll(() => model.getAttribute('aria-expanded')).not.toBe('true')
    expect(await focused(page).count()).toBe(1)
    await reachable(home.getByRole('button', { name: 'release-notes.txt', exact: true }))
    await reachable(home.getByRole('button', { name: '发送', exact: true }))
    await captureFocus(page, 'desktop-triage')
    const writes: string[] = []
    page.on('request', request => {
      if (request.method() === 'POST' && /\/approvals\/|\/questions\//u.test(request.url())) writes.push(request.method())
    })
    // Body focus and numeric keys must not decide the first card behind the frame.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('2')
    await page.keyboard.press('Meta+Enter')
    const summary = page.getByRole('button', { name: /等你处理 1.*整理本地发布说明/u })
    await summary.click()
    await returned(page)
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest('.work-decision')?.getAttribute('data-work-session')))
      .toBe(waiting)
    expect(writes).toEqual([])
    expect(await input.inputValue()).toBe('长草稿保留。\n'.repeat(20))
    expect(await original!.evaluate(node => node.isConnected)).toBe(true)
    expect(await home.getByRole('button', { name: 'release-notes.txt', exact: true }).isEnabled()).toBe(true)
  } finally {
    await context.close()
  }
})

it.each([768, 390])('keeps controls in view at %i with reduced motion', async width => {
  const phone = width < 768
  const context = await browser.newContext({
    viewport: { width, height: 844 },
    locale: 'zh-CN',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    isMobile: phone,
    hasTouch: phone,
  })
  try {
    const page = await context.newPage()
    await enrollBrowser(page, host, { name: '窄屏专注验收', scopes: ['admin'] })
    const input = homeInput(page)
    const original = await input.elementHandle()
    const composer = page.locator('.workbench-home form.composer')
    const project = composer.getByRole('button', { name: /^项目：/u })
    const harness = composer.getByRole('button', { name: /^Harness：/u })
    const model = composer.getByRole('button', { name: /^模型：/u })
    const send = composer.getByRole('button', { name: '发送', exact: true })
    await input.focus()
    expect(await focused(page).count()).toBe(0)
    if (phone) {
      expect((await harness.boundingBox())!.y).toBeLessThan((await input.boundingBox())!.y)
      expect((await input.boundingBox())!.x).toBeLessThan((await send.boundingBox())!.x)
    } else {
      await page.locator('.workbench-tablet-rail').getByRole('button', { name: '打开会话列表', exact: true }).click()
      await page.locator('.sidebar.is-open').waitFor()
    }
    await page.keyboard.press('Alt+n')
    await shown(page)
    await expect.poll(() => page.locator('.sidebar.is-open').count()).toBe(0)
    await input.blur()
    await returned(page)
    await input.click()
    await shown(page)
    if (phone) {
      const client = await context.newCDPSession(page)
      await client.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 })
      await client.send('Input.insertText', { text: '中文' })
      expect(await input.inputValue()).toBe('中文')
      expect(await original!.evaluate(node => node === document.activeElement)).toBe(true)
      await page.keyboard.insertText('\n')
    }
    await page.keyboard.insertText('从手机和平板发送的草稿。\n'.repeat(4))
    if (phone) {
      // A real page receives the same visualViewport event as a keyboard would send. The OS keyboard is not emulated.
      await page.evaluate(() => {
        const view = window.visualViewport!
        Object.defineProperties(view, { height: { value: 348 }, offsetTop: { value: 48 } })
        view.dispatchEvent(new Event('resize'))
      })
      const retainedQueue = page.locator('.code-home-queue')
      await retainedQueue.locator('.approval-panel[data-secure]').waitFor({ state: 'attached' })
      expect(await retainedQueue.getAttribute('inert')).toBe('')
      expect(await retainedQueue.evaluate(queue => getComputedStyle(queue).opacity)).toBe('0')
    }
    await reachable(send)
    if (phone) {
      const place = (await project.boundingBox())!
      const text = (await input.boundingBox())!
      const control = (await harness.boundingBox())!
      const sendBox = (await send.boundingBox())!
      const card = (await composer.boundingBox())!
      expect(place.y + place.height).toBeLessThanOrEqual(text.y)
      expect(text.y + text.height).toBeLessThanOrEqual(control.y)
      expect(text.x - card.x).toBeLessThanOrEqual(16)
      expect(
        await input.evaluate(node => {
          const style = getComputedStyle(node)
          return (node.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / parseFloat(style.lineHeight)
        }),
      ).toBeGreaterThanOrEqual(3)
      expect(sendBox.width).toBeGreaterThanOrEqual(44)
      expect(sendBox.height).toBeGreaterThanOrEqual(44)
      expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(396)
      expect(control.y + control.height / 2).toBeCloseTo(sendBox.y + sendBox.height / 2, 0)

      await model.scrollIntoViewIfNeeded()
      const name = model.locator('.ui-value-picker-text[data-shown]')
      await expect.poll(() => name.textContent()).toBe(MODEL.model)
      expect(await name.evaluate(node => node.clientWidth >= node.scrollWidth)).toBe(true)
      await reachable(model)
      await model.click()
      await expect.poll(() => model.getAttribute('aria-expanded')).toBe('true')
      await page.keyboard.press('Escape')
      await expect.poll(() => model.getAttribute('aria-expanded')).not.toBe('true')
      expect(await focused(page).count()).toBe(1)
      expect(await original!.evaluate(node => node.isConnected)).toBe(true)
      expect(await input.inputValue()).toContain('中文')
    }
    expect(await page.locator('.workbench-home-composer').evaluate(node => node.getAnimations().length)).toBe(0)
    await noHorizontalOverflow(page, page.locator('.home-focus-frame'))
    await captureFocus(page, phone ? 'phone-keyboard-overview' : 'tablet-overview')
    if (phone) {
      for (const control of ['harness', 'model', 'thinking', 'permission']) {
        const choice = composer.locator(`[data-composer-control="${control}"]`).getByRole('button')
        await choice.scrollIntoViewIfNeeded()
        await reachable(choice)
        expect(await choice.isEnabled()).toBe(true)
      }
    }
    if (!phone) {
      await page.mouse.click(width / 2, 90)
      await returned(page)
      expect(await input.inputValue()).toContain('手机和平板')
      await input.click()
      await shown(page)
    }
    await send.click()
    await returned(page)
    await page.getByRole('textbox', { name: '继续对话', exact: true }).waitFor()
  } finally {
    await context.close()
  }
})

it('keeps decision keys away from the next request if the summary target settles before focus returns', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const started = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { requestId: randomUUID(), prompt: '归档下一份发布说明', model: MODEL, mode: 'agent' },
    })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${started.sessionId}`)).approvals).toHaveLength(1)
    const request = (await owner.json<TaskDetail>(`tasks/${started.sessionId}`)).approvals[0]!
    const page = await context.newPage()
    await enrollBrowser(page, host, { name: '摘要目标结算验收', scopes: ['admin'] })
    await switchLayout(page, 'triage')
    await page.locator(`.code-home-queue [data-work-session="${started.sessionId}"] .approval-panel`).waitFor()
    await homeInput(page).fill('返回后保留的草稿')
    const summary = page.getByRole('button', { name: /等你处理 .*归档下一份发布说明/u })
    await summary.waitFor()
    const deferredFocus = await summary.evaluateHandle(element => {
      const frame = window.requestAnimationFrame
      const callbacks: FrameRequestCallback[] = []
      window.requestAnimationFrame = callback => callbacks.push(callback)
      try {
        const button = element as HTMLElement
        button.click()
      } finally {
        window.requestAnimationFrame = frame
      }
      return callbacks
    })
    expect(await deferredFocus.evaluate(callbacks => callbacks.length)).toBeGreaterThan(0)
    await owner.json(`approvals/${request.id}`, { method: 'POST', body: { decision: 'reject', requestId: randomUUID() } })
    await returned(page)
    const next = page.locator(`.code-home-queue [data-work-session="${waiting}"] .approval-panel`)
    await next.waitFor()
    await deferredFocus.evaluate(callbacks => callbacks.forEach(callback => callback(performance.now())))
    await expect.poll(() => next.getAttribute('data-arming')).toBeNull()
    await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute('data-work-decision-navigation'))).toBe(true)
    const writes: string[] = []
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.includes('/approvals/')) writes.push(request.url())
    })
    await page.keyboard.press('2')
    expect((await owner.json<TaskDetail>(`tasks/${waiting}`)).approvals).toHaveLength(1)
    expect(writes).toEqual([])
  } finally {
    await context.close()
  }
})

it('takes Escape after the returned card has armed, without moving its focus again', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const started = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { requestId: randomUUID(), prompt: '整理本地发布说明', model: MODEL, mode: 'agent' },
    })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${started.sessionId}`)).approvals).toHaveLength(1)
    const page = await context.newPage()
    await page.clock.install()
    await enrollBrowser(page, host, { name: '摘要归焦键位验收', scopes: ['admin'] })
    const card = page.locator(`.code-home-queue [data-work-session="${started.sessionId}"] .approval-panel`)
    await expect.poll(() => card.getAttribute('data-arming')).toBeNull()
    await homeInput(page).fill('摘要归焦前的草稿')
    await shown(page)
    const writes: string[] = []
    page.on('request', request => {
      const path = new URL(request.url()).pathname
      if (request.method() === 'POST' && path.includes('/approvals/')) writes.push(path)
    })
    // Probe within the focus event itself so the first Escape stays inside the real arming window.
    await card.evaluate(node => {
      node.addEventListener(
        'focusin',
        () => {
          node.setAttribute('data-test-focus-arming', String(node.hasAttribute('data-arming')))
          node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        },
        { once: true },
      )
    })
    await page.getByRole('button', { name: /等你处理 \d+.*整理本地发布说明/u }).click()
    await expect.poll(() => card.getAttribute('data-test-focus-arming')).toBe('true')
    expect(writes).toEqual([])
    // Esc has its own grace period after a layer returns, independent of the card's arming delay.
    await page.clock.fastForward(600)
    await expect.poll(() => card.getAttribute('data-arming')).toBeNull()
    await expect.poll(() => card.locator('[aria-keyshortcuts="Escape"]').count()).toBe(1)
    expect(await card.evaluate(node => node === document.activeElement)).toBe(true)
    const rejected = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname.includes('/approvals/'))
    await page.keyboard.press('Escape')
    expect((await rejected).postDataJSON()).toMatchObject({ decision: 'reject' })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${started.sessionId}`)).approvals).toHaveLength(0)
    expect(writes).toHaveLength(1)
  } finally {
    await context.close()
  }
})

it('persists list density in both layouts and preserves approval and touch geometry', async () => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    hasTouch: true,
  })
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const title = '复核已完成的发布说明'
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { requestId: randomUUID(), prompt: title, model: MODEL, mode: 'chat' },
    })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
    const page = await context.newPage()
    await enrollBrowser(page, host, { name: '工作台密度验收', scopes: ['admin'] })
    const row = page.locator('.work-overview-recent-row').filter({ hasText: title })
    const card = page.locator(`.code-home-queue [data-work-session="${waiting}"] .approval-panel[data-secure]`)
    const dimensions = async () => ({
      row: (await row.boundingBox())!.height,
      approval: (await card.boundingBox())!.height,
    })
    const standard = []
    for (const layout of ['overview', 'triage'] as const) {
      await switchLayout(page, layout)
      await row.waitFor()
      await card.waitFor()
      standard.push(await dimensions())
    }
    const shots = 'test-results/workbench-density'
    await mkdir(shots, { recursive: true })
    await page.screenshot({ path: `${shots}/standard-1440-light.png`, animations: 'disabled' })

    const settings = await openSettings(page)
    await openSection(settings, '通用')
    const density = settings.getByRole('radiogroup', { name: '密度', exact: true })
    await density.getByRole('radio', { name: '紧凑', exact: true }).click()
    await closeSettings(settings)
    await expect.poll(() => page.locator('html').getAttribute('data-density')).toBe('compact')
    for (const [index, layout] of (['overview', 'triage'] as const).entries()) {
      await switchLayout(page, layout)
      const compact = await dimensions()
      expect(compact.row).toBeLessThan(standard[index]!.row)
      expect(compact.row).toBeGreaterThanOrEqual(44)
      expect(compact.approval).toBe(standard[index]!.approval)
    }
    await page.screenshot({ path: `${shots}/compact-1440-light.png`, animations: 'disabled' })
    await page.reload()
    await expect.poll(() => page.locator('html').getAttribute('data-density')).toBe('compact')
    await reachable(row)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('.app-shell[data-viewport="phone"]').waitFor()
    await row.scrollIntoViewIfNeeded()
    await reachable(row)
    expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: `${shots}/compact-390-dark.png`, animations: 'disabled' })
  } finally {
    await context.close()
  }
})
