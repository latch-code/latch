import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HarnessPlugin, ModelDelta } from '@latch/sdk'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

/** The test releases each delta; no paid model, token timers, or simulated Host. */
class ControlledReply {
  private queue: ModelDelta[] = []
  private waiting: ((delta: ModelDelta) => void) | undefined
  private finished = false

  private push(delta: ModelDelta): void {
    if (this.waiting) this.waiting(delta)
    else this.queue.push(delta)
  }

  append(text: string): void {
    if (this.finished) throw new Error('Cannot append to a finished fixture reply')
    this.push({ type: 'text', text })
  }

  finish(): void {
    if (this.finished) return
    this.finished = true
    this.push({ type: 'finish', reason: 'stop' })
  }

  async *stream(signal: AbortSignal): AsyncIterable<ModelDelta> {
    try {
      while (true) {
        signal.throwIfAborted()
        const delta =
          this.queue.shift()
          ?? (await new Promise<ModelDelta>((resolveDelta, reject) => {
            const abort = () => {
              this.waiting = undefined
              reject(signal.reason)
            }
            this.waiting = value => {
              this.waiting = undefined
              signal.removeEventListener('abort', abort)
              resolveDelta(value)
            }
            signal.addEventListener('abort', abort, { once: true })
            if (signal.aborted) abort()
          }))
        yield delta
        if (delta.type === 'finish') return
      }
    } finally {
      this.waiting = undefined
    }
  }
}

interface RequestCounts {
  snapshot: number
  detail: number
}
function countProjectionRequests(page: Page): RequestCounts {
  const counts = { snapshot: 0, detail: 0 }
  page.on('request', request => {
    if (request.method() !== 'GET') return
    const path = new URL(request.url()).pathname
    if (path === '/link/api/snapshot') counts.snapshot++
    else if (/^\/link\/api\/tasks\/[^/]+$/.test(path)) counts.detail++
  })
  return counts
}

async function geometry(page: Page) {
  return page.locator('.transcript').evaluate(element => ({
    top: element.scrollTop,
    gap: element.scrollHeight - element.clientHeight - element.scrollTop,
  }))
}

describe('streamed messages in the real workspace', () => {
  let testHost: TestHost
  let host: TestHost['host']
  let browser: Browser
  const replies = new Map<string, ControlledReply>()

  beforeAll(async () => {
    const plugin: HarnessPlugin = {
      id: 'streaming-ui-fixture',
      name: '可控流式测试模型',
      version: '1.0.0',
      description: '仅用于浏览器验收的本地模型。',
      activate(context) {
        context.registerProvider({
          id: 'controlled-fixture',
          name: 'Controlled stream fixture',
          model: 'fixture',
          stream({ messages, signal }) {
            const prompt = messages.findLast(message => message.role === 'user')?.content
            const reply = prompt === undefined ? undefined : replies.get(prompt)
            if (!reply) throw new Error(`No controlled reply registered for ${prompt}`)
            return reply.stream(signal)
          },
        })
      },
    }
    testHost = await startTestHost({
      uiDir: resolve(process.env.HARNESS_E2E_UI_DIR ?? 'dist/web'),
      demo: false,
      plugins: [plugin],
      providerId: 'controlled-fixture',
    })
    host = testHost.host
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir('test-results/streaming', { recursive: true })
  })

  afterAll(async () => {
    for (const reply of replies.values()) reply.finish()
    await browser?.close()
    await testHost?.close()
  })

  async function open(width: number, height: number): Promise<{ context: BrowserContext; page: Page; counts: RequestCounts }> {
    const mobile = width < 680
    const context = await browser.newContext({
      viewport: { width, height },
      isMobile: mobile,
      hasTouch: mobile,
      deviceScaleFactor: 1,
      colorScheme: 'light',
    })
    context.setDefaultTimeout(15_000)
    const page = await context.newPage()
    await enrollBrowser(page, testHost, { name: `流式 ${width}` })
    // Counted from the synchronized workspace on; enrollment requests are not projection traffic.
    const counts = countProjectionRequests(page)
    await connected(page)
    return { context, page, counts }
  }

  async function start(page: Page, prompt: string): Promise<{ id: string; reply: ControlledReply }> {
    const reply = new ControlledReply()
    replies.set(prompt, reply)
    // Phones show 新建会话 in the top bar; wider layouts in the sidebar or rail.
    await page.getByRole('button', { name: '新建会话', exact: true }).filter({ visible: true }).first().click()
    await page.locator('.drawer-backdrop').waitFor({ state: 'detached' })
    await page.getByRole('radiogroup', { name: '会话模式' }).getByRole('radio', { name: '对话', exact: true }).click()
    await page.getByRole('textbox', { name: '新会话消息' }).fill(prompt)
    const created = page.waitForResponse(
      response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/link/api/tasks',
    )
    await page.getByRole('button', { name: '发送', exact: true }).click()
    const response = await created
    expect(response.status()).toBe(201)
    const { sessionId: id } = (await response.json()) as { sessionId: string }
    await page.getByRole('button', { name: '取消任务', exact: true }).waitFor()
    await connected(page)
    return { id, reply }
  }

  async function liveRow(page: Page, id: string) {
    await expect.poll(async () => (await host.bridge.detail(id)).liveMessageId, { interval: 20 }).toBeTruthy()
    const messageId = (await host.bridge.detail(id)).liveMessageId!
    const row = page.locator(`[data-message-id="${messageId}"]`)
    await row.waitFor()
    return { row, messageId }
  }

  it('preserves the live row through commit, bounds HTTP work, and respects a reader scrolling upward', async () => {
    const { context, page, counts } = await open(1280, 820)
    try {
      const { id, reply } = await start(page, '检验流式阅读位置与消息身份')
      reply.append(
        '# 持续生成的阅读记录\n\n'
          + Array.from(
            { length: 48 },
            (_, index) => `第 ${index + 1} 段：这是一段供阅读的已生成内容。继续生成时，正在阅读前文的位置应保持不变。`,
          ).join('\n\n'),
      )
      const { row, messageId } = await liveRow(page, id)
      const originalRow = await row.elementHandle()
      expect(originalRow).not.toBeNull()
      await expect.poll(async () => (await geometry(page)).gap, { interval: 20 }).toBeLessThanOrEqual(4)
      const atBottom = (await geometry(page)).top
      expect(atBottom).toBeGreaterThan(600)

      await page.locator('.transcript').hover()
      await page.mouse.wheel(0, -650)
      await page.getByRole('button', { name: '回到最新', exact: true }).waitFor()
      await expect.poll(async () => (await geometry(page)).top, { interval: 20 }).toBeLessThan(atBottom - 300)
      // Wait for the browser's wheel layout rather than assuming a fixed duration.
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
      const readingTop = (await geometry(page)).top
      const baseline = { ...counts }

      // Each observed marker requires a fresh rendered projection. This would
      // catch the former snapshot + detail fetch on every arriving chunk.
      for (let index = 1; index <= 24; index++) {
        const marker = `增量段落 ${index.toString().padStart(2, '0')}`
        reply.append(`\n\n${marker}：新内容已经抵达，前文仍可继续阅读。`)
        await expect.poll(() => row.textContent(), { interval: 20 }).toContain(marker)
      }
      const whileReading = await geometry(page)
      expect(Math.abs(whileReading.top - readingTop)).toBeLessThanOrEqual(2)
      expect(whileReading.gap).toBeGreaterThan(600)
      expect(counts.snapshot - baseline.snapshot).toBeLessThanOrEqual(2)
      expect(counts.detail - baseline.detail).toBeLessThanOrEqual(2)
      expect(await originalRow!.evaluate(element => element.isConnected)).toBe(true)
      await page.screenshot({ path: 'test-results/streaming/desktop-live-reading.png', animations: 'disabled' })

      await page.getByRole('button', { name: '回到最新', exact: true }).click()
      await expect.poll(async () => (await geometry(page)).gap, { interval: 20 }).toBeLessThanOrEqual(4)
      await page.getByRole('button', { name: '回到最新', exact: true }).waitFor({ state: 'hidden' })
      reply.append('\n\n这次流式回复已经完成。')
      reply.finish()
      await expect.poll(async () => (await host.bridge.detail(id)).summary.status, { interval: 20 }).toBe('idle')
      await expect.poll(() => row.getAttribute('aria-label'), { interval: 20 }).toBeNull()
      expect(await originalRow!.evaluate(element => element.isConnected)).toBe(true)
      expect(await row.count()).toBe(1)
      expect(await row.locator('.message-content').textContent()).toContain('这次流式回复已经完成。')
      const committed = (await host.bridge.detail(id)).messages.filter(message => message.role === 'assistant')
      expect(committed).toHaveLength(1)
      expect(committed[0]!.id).toBe(messageId)
    } finally {
      await context.close()
    }
  })

  it('renders an unfinished fence, preserves expansion, reports clipboard outcomes, and contains a wide table at 320px', async () => {
    const { context, page } = await open(320, 820)
    try {
      const { id, reply } = await start(page, '检验手机 Markdown 与代码复制')
      const code = Array.from({ length: 26 }, (_, index) => `const value${index + 1} = "streamed result ${index + 1}";`).join('\n') + '\n'
      reply.append('# 流式内容\n\n```ts\n' + code)
      const { row } = await liveRow(page, id)
      const block = row.locator('.message-code')
      await block.waitFor()
      expect(await block.locator('pre code').textContent()).toBe(code)
      const originalPre = await block.locator('pre').elementHandle()
      await block.getByRole('button', { name: '展开全部 26 行', exact: true }).click()
      expect(await block.getByRole('button', { name: '收起代码', exact: true }).getAttribute('aria-expanded')).toBe('true')

      reply.append(
        '```\n\n| 阶段 | 执行位置 | 响应方式 | 结果 |\n| --- | --- | --- | --- |\n| 生成内容 | 本地测试执行端 | 持续传输文本 | 已完成 |\n| 移动阅读 | 320 像素屏幕 | 表格内部横向滚动 | 可以操作 |',
      )
      reply.finish()
      await expect.poll(async () => (await host.bridge.detail(id)).summary.status, { interval: 20 }).toBe('idle')
      await row.locator('.message-table-scroll').waitFor()
      expect(await originalPre!.evaluate(element => element.isConnected)).toBe(true)
      expect(await block.getByRole('button', { name: '收起代码', exact: true }).getAttribute('aria-expanded')).toBe('true')

      // Replace only the browser clipboard boundary. Both success and denial
      // still run the actual CodeBlock event handler and visible feedback.
      await page.evaluate(() => {
        const state = window as Window & { copiedCode?: string }
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async (value: string) => {
              state.copiedCode = value
            },
          },
        })
      })
      await block.getByRole('button', { name: '复制代码', exact: true }).click()
      await expect.poll(() => page.evaluate(() => (window as Window & { copiedCode?: string }).copiedCode), { interval: 20 }).toBe(code)
      await expect.poll(() => block.getByRole('status').textContent(), { interval: 20 }).toBe('代码已复制到剪贴板')
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async () => {
              throw new DOMException('Denied by test', 'NotAllowedError')
            },
          },
        })
      })
      await block.getByRole('button', { name: '复制代码', exact: true }).click()
      await block.getByRole('alert').waitFor()
      expect(await block.getByRole('alert').textContent()).toContain('复制失败')

      const table = row.locator('.message-table-scroll')
      await table.scrollIntoViewIfNeeded()
      const widths = await table.evaluate(element => {
        const rect = element.getBoundingClientRect()
        element.scrollLeft = 100
        return {
          left: rect.left,
          right: rect.right,
          inner: element.clientWidth,
          content: element.scrollWidth,
          scrolled: element.scrollLeft,
          pageWidth: document.documentElement.scrollWidth,
          viewport: innerWidth,
          pageScroll: scrollX,
        }
      })
      expect(widths.left).toBeGreaterThanOrEqual(0)
      expect(widths.right).toBeLessThanOrEqual(320)
      expect(widths.content).toBeGreaterThan(widths.inner)
      expect(widths.scrolled).toBeGreaterThan(0)
      expect(widths.pageWidth).toBeLessThanOrEqual(widths.viewport + 1)
      expect(widths.pageScroll).toBe(0)
      await page.screenshot({ path: 'test-results/streaming/mobile-markdown.png', animations: 'disabled' })
    } finally {
      await context.close()
    }
  })

  it('retains partial text offline and replaces it with the committed authority after reconnect without duplicate records', async () => {
    const { context, page } = await open(375, 812)
    try {
      const { id, reply } = await start(page, '检验断线期间完成的流式回复')
      const prefix = '这是断线之前已经收到的内容。'
      const suffix = '\n\n执行端在设备离线期间完成了剩余内容。'
      reply.append(prefix)
      const { row, messageId } = await liveRow(page, id)
      await expect.poll(() => row.locator('.message-content').textContent(), { interval: 20 }).toBe(prefix)
      const originalRow = await row.elementHandle()

      await context.setOffline(true)
      await page
        .getByRole('main')
        .getByRole('button', { name: /^离线/ })
        .waitFor()
      reply.append(suffix)
      reply.finish()
      await expect.poll(async () => (await host.bridge.detail(id)).summary.status, { interval: 20 }).toBe('idle')
      expect(await row.locator('.message-content').textContent()).toBe(prefix)
      expect(await originalRow!.evaluate(element => element.isConnected)).toBe(true)

      await context.setOffline(false)
      await connected(page)
      await expect.poll(() => row.locator('.message-content').textContent(), { interval: 20 }).toContain(suffix.trim())
      await expect.poll(() => row.getAttribute('aria-label'), { interval: 20 }).toBeNull()
      const authoritative = await host.bridge.detail(id)
      expect(authoritative.messages.filter(message => message.role === 'assistant')).toEqual([
        expect.objectContaining({ id: messageId, text: prefix + suffix }),
      ])
      const expectedIds = authoritative.messages.map(message => message.id)
      const renderedIds = () =>
        page
          .locator('.transcript [data-message-id]')
          .evaluateAll(elements => elements.map(element => element.getAttribute('data-message-id')))
      expect(await renderedIds()).toEqual(expectedIds)
      expect(await originalRow!.evaluate(element => element.isConnected)).toBe(true)

      // A manual resync from the session menu must not duplicate committed rows.
      const refreshed = page.waitForResponse(
        response => response.request().method() === 'GET' && new URL(response.url()).pathname === `/link/api/tasks/${id}`,
      )
      await page.getByRole('button', { name: '会话操作', exact: true }).click()
      await page.getByRole('menuitem', { name: '同步最新状态', exact: true }).click()
      await refreshed
      expect(await renderedIds()).toEqual(expectedIds)
      expect(new Set(await renderedIds()).size).toBe(expectedIds.length)
      expect((await host.bridge.detail(id)).messages).toEqual(authoritative.messages)
    } finally {
      await context.setOffline(false)
      await context.close()
    }
  })

  it('keeps an open menu while the followed transcript scrolls under a stream', async () => {
    const { context, page } = await open(1280, 820)
    try {
      const { id, reply } = await start(page, '检验流式输出时菜单保持打开')
      reply.append(
        Array.from({ length: 40 }, (_, index) => `第 ${index + 1} 段：让会话记录超过一屏，跟随时会持续写入滚动位置。`).join('\n\n'),
      )
      const { row } = await liveRow(page, id)
      await expect.poll(async () => (await geometry(page)).gap, { interval: 20 }).toBeLessThanOrEqual(4)
      // The top bar and the composer model picker sit outside the scrolling transcript.
      for (const [trigger, menu] of [
        [page.getByRole('button', { name: '会话操作', exact: true }), '会话操作'],
        [page.getByRole('button', { name: /^模型：/ }), '选择模型'],
      ] as const) {
        await trigger.click()
        const popover = page.getByRole('menu', { name: menu, exact: true })
        await popover.waitFor()
        const before = (await geometry(page)).top
        for (let index = 1; index <= 6; index++) {
          const marker = `${menu} 打开期间的段落 ${index}`
          reply.append(`\n\n${marker}`)
          await expect.poll(() => row.textContent(), { interval: 20 }).toContain(marker)
        }
        expect((await geometry(page)).top).toBeGreaterThan(before)
        expect(await popover.isVisible()).toBe(true)
        await page.keyboard.press('Escape')
        await popover.waitFor({ state: 'detached' })
      }
      reply.finish()
      await expect.poll(async () => (await host.bridge.detail(id)).summary.status, { interval: 20 }).toBe('idle')
    } finally {
      await context.close()
    }
  })

  it('leaves a session that another device deleted instead of reconnecting to it', async () => {
    const { context, page } = await open(1280, 820)
    try {
      const { id, reply } = await start(page, '检验其他设备删除当前会话')
      reply.append('这个会话会在另一台设备上被删除。')
      reply.finish()
      await expect.poll(async () => (await host.bridge.detail(id)).summary.status, { interval: 20 }).toBe('idle')
      await page.locator('[data-message-id]').filter({ hasText: '这个会话会在另一台设备上被删除。' }).waitFor()
      const removed = await page.request.delete(`${host.origin}/link/api/tasks/${encodeURIComponent(id)}`)
      expect(removed.status()).toBe(200)
      await page.locator('.workspace.is-new').waitFor()
      await page.getByRole('textbox', { name: '新会话消息' }).waitFor()
      await page.getByRole('status').filter({ hasText: '会话已被删除' }).waitFor()
      await connected(page)
      expect(await page.locator('.banner-region').count()).toBe(0)
      expect(await page.locator(`[data-task-id="${id}"]`).count()).toBe(0)
    } finally {
      await context.close()
    }
  })
})
