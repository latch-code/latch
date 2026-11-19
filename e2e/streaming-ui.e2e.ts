import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AGENT_PRESETS, type AppSnapshot, type TaskDetail } from '@latch/protocol'
import type { HarnessPlugin, ModelDelta } from '@latch/sdk'
import { latchEnv } from '@latch/host/env'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { backToPhoneSessions, closeSettings, openSection, openSession, openSettings, settleShell } from './helpers/layout.ts'
import { homeInput } from './helpers/workbench.ts'

/** Shows the new draft, which is the home's input: already in sight, or where 新建会话 leads. */
async function newDraft(page: Page): Promise<void> {
  if (!(await page.locator('.workbench-home').isVisible())) {
    await backToPhoneSessions(page)
    await page.getByRole('button', { name: '新建会话', exact: true }).filter({ visible: true }).first().click()
  }
  await homeInput(page).waitFor()
}

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

  reasoning(text: string): void {
    if (this.finished) throw new Error('Cannot append to a finished fixture reply')
    this.push({ type: 'reasoning', text })
  }

  usage(inputTokens: number, outputTokens: number): void {
    this.push({ type: 'usage', inputTokens, outputTokens })
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
      uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
      demo: false,
      hostName: '验收电脑',
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
    // Phones show 新建会话 in their list's header and start from a sheet with 开始; wider layouts in the sidebar or title row.
    await newDraft(page)
    await page.locator('.drawer-backdrop').waitFor({ state: 'detached' })
    await page.getByRole('textbox', { name: '新会话消息' }).fill(prompt)
    const created = page.waitForResponse(
      response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/link/api/tasks',
    )
    await page
      .getByRole('button', { name: /^(发送|开始)$/ })
      .filter({ visible: true })
      .first()
      .click()
    const response = await created
    expect(response.status()).toBe(201)
    const { sessionId: id } = (await response.json()) as { sessionId: string }
    await page.getByRole('button', { name: '停止', exact: true }).waitFor()
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

  it('pauses the Code backdrop for a visible live reply and releases the pause when that reply is covered', async () => {
    const { context, page } = await open(1440, 900)
    try {
      const { id, reply: history } = await start(page, '准备阅读旧的会话记录')
      history.append(Array.from({ length: 60 }, (_, index) => `旧记录第 ${index + 1} 段。`).join('\n\n'))
      history.finish()
      await expect.poll(async () => (await host.bridge.detail(id)).summary.status).toBe('idle')
      await page.getByText('旧记录第 60 段。', { exact: true }).waitFor()
      const prompt = '检查可见回复的背景暂停'
      const reply = new ControlledReply()
      replies.set(prompt, reply)
      await page.getByRole('textbox', { name: '继续对话' }).fill(prompt)
      await page.getByRole('button', { name: '发送', exact: true }).click()
      const canvas = page.locator('canvas.workbench-backdrop')
      await canvas.waitFor()
      expect(await canvas.count()).toBe(1)
      await page.bringToFront()
      await canvas.evaluate(element => {
        const layer = element as HTMLCanvasElement
        const draw = layer.getContext('2d')!
        const clear = draw.clearRect.bind(draw)
        let frames = 0
        let measurements = 0
        const measure = layer.getBoundingClientRect.bind(layer)
        layer.getBoundingClientRect = () => {
          layer.dataset.measurements = String(++measurements)
          return measure()
        }
        draw.clearRect = (x, y, w, h) => {
          if (x === 0 && y === 0 && Math.abs(w - layer.clientWidth) < 1 && Math.abs(h - layer.clientHeight) < 1)
            layer.dataset.frames = String(++frames)
          clear(x, y, w, h)
        }
      })
      const frames = async () => Number(await canvas.getAttribute('data-frames'))
      const visibleStream = () => page.locator('html').getAttribute('data-streaming-view')
      const repeatedFrames = async () => {
        const previous = await frames()
        await page.evaluate(() => new Promise<void>(done => setTimeout(done, 200)))
        return (await frames()) - previous
      }
      await expect.poll(frames).toBeGreaterThan(1)
      await page.evaluate(() => window.dispatchEvent(new Event('blur')))
      await expect.poll(repeatedFrames).toBe(0)
      const blurred = await frames()
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await expect.poll(frames).toBeGreaterThan(blurred)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await expect.poll(repeatedFrames).toBe(0)
      const reduced = await frames()
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await expect.poll(frames).toBeGreaterThan(reduced)
      reply.append('这段正文还在生成。')
      await expect.poll(async () => (await host.bridge.detail(id)).liveText).toContain('这段正文还在生成。')
      await (await liveRow(page, id)).row.getByText('这段正文还在生成。').waitFor()
      await expect.poll(visibleStream).toBe('')
      await expect.poll(repeatedFrames).toBe(0)
      await page.screenshot({ path: 'test-results/streaming/backdrop-live-1440-light.png', animations: 'disabled' })

      const beforeGrowth = await geometry(page)
      const measurements = await canvas.getAttribute('data-measurements')
      reply.append('\n\n' + Array.from({ length: 12 }, (_, index) => `新增正文第 ${index + 1} 段。`).join('\n\n'))
      await page.getByText('新增正文第 12 段。', { exact: true }).waitFor()
      await expect.poll(async () => (await geometry(page)).top).toBeGreaterThan(beforeGrowth.top)
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
      expect(await canvas.getAttribute('data-measurements')).toBe(measurements)

      const beforeScroll = await frames()
      await page.locator('.transcript').hover()
      await page.mouse.wheel(0, -1800)
      const latest = page.getByRole('button', { name: '回到最新', exact: true })
      await latest.waitFor()
      await expect.poll(visibleStream).toBeNull()
      await expect.poll(frames).toBeGreaterThan(beforeScroll)
      await latest.click()
      await expect.poll(visibleStream).toBe('')

      await page.locator('[data-space-primary]').filter({ visible: true }).first().click()
      await page.locator('.code-home > canvas.workbench-backdrop').waitFor()
      expect(await canvas.count()).toBe(1)
      await expect.poll(visibleStream).toBeNull()

      await openSession(page, id)
      await expect.poll(visibleStream).toBe('')
      reply.finish()
      await expect.poll(visibleStream).toBeNull()
    } finally {
      await context.close()
    }
  })

  it('releases the visible stream marker when a phone leaves the live conversation', async () => {
    const { context, page } = await open(390, 844)
    try {
      const { id, reply } = await start(page, '检查手机离开流式会话')
      reply.append('仍在准备手机的回答。')
      await page.getByText('仍在准备手机的回答。', { exact: true }).waitFor()
      const visibleStream = () => page.locator('html').getAttribute('data-streaming-view')
      await expect.poll(visibleStream).toBe('')
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.screenshot({ path: 'test-results/streaming/backdrop-live-390-dark.png', animations: 'disabled' })
      await backToPhoneSessions(page)
      await expect.poll(visibleStream).toBeNull()
      expect((await host.bridge.detail(id)).summary.status).toBe('running')
      await openSession(page, id)
      await expect.poll(visibleStream).toBe('')
      reply.finish()
      await expect.poll(visibleStream).toBeNull()
    } finally {
      await context.close()
    }
  })

  it('observes an expanded thinking block when the same live reply reasons again after prose', async () => {
    const { context, page } = await open(1440, 900)
    try {
      const { id, reply } = await start(page, '检查正文之后继续思考')
      reply.reasoning('先读第一份材料。')
      await page.getByText('先读第一份材料。', { exact: true }).waitFor()
      reply.append('第一段正文。')
      await page.getByText('第一段正文。', { exact: true }).waitFor()
      const thinking = page.locator('.thinking').last()
      await thinking.locator('.thinking-toggle').click()
      const body = thinking.locator('.thinking-scroll')
      await expect.poll(() => body.getAttribute('data-streaming')).toBeNull()
      reply.reasoning('\n\n再核对第二份材料。')
      await expect.poll(async () => (await host.bridge.detail(id)).liveReasoning).toContain('再核对第二份材料。')
      await expect.poll(() => body.getAttribute('data-streaming')).toBe('')
      await expect.poll(() => thinking.locator('.thinking-toggle').getAttribute('aria-expanded')).toBe('true')
      reply.append('\n\n第二段正文。')
      await page.getByText('第二段正文。', { exact: true }).waitFor()
      await expect.poll(() => body.getAttribute('data-streaming')).toBeNull()
      reply.finish()
    } finally {
      await context.close()
    }
  })

  it('applies the device backdrop choice after leaving settings and reloading', async () => {
    const { context, page } = await open(1440, 900)
    try {
      const canvas = page.locator('canvas.workbench-backdrop')
      await canvas.waitFor()
      expect(await canvas.getAttribute('data-kind')).toBe('field')
      const settings = await openSettings(page)
      await openSection(settings, '外观')
      const backdrop = settings.getByRole('radiogroup', { name: '背景效果' })
      expect(await backdrop.getByRole('radio', { name: '标准', exact: true }).getAttribute('aria-checked')).toBe('true')
      await backdrop.getByRole('radio', { name: '关', exact: true }).click()
      await closeSettings(settings)
      await canvas.waitFor({ state: 'detached' })
      await page.reload()
      await connected(page)
      expect(await canvas.count()).toBe(0)

      await openSettings(page)
      await openSection(settings, '外观')
      expect(await backdrop.getByRole('radio', { name: '关', exact: true }).getAttribute('aria-checked')).toBe('true')
      await backdrop.getByRole('radio', { name: '轻', exact: true }).click()
      await closeSettings(settings)
      await canvas.waitFor()
      expect(await canvas.count()).toBe(1)
      await page.setViewportSize({ width: 768, height: 844 })
      // Typing on the start screen leaves the layer where it is: there is no focus mode to gather it.
      await homeInput(page).click()
      expect(await canvas.getAttribute('data-fixed')).toBeNull()
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
      await page.screenshot({ path: 'test-results/streaming/backdrop-start-768-dark.png', animations: 'disabled' })
    } finally {
      await context.close()
    }
  })

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
      // The newly opened inspector changes the line wrapping; begin reading after its grid transition settles.
      await settleShell(page)
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

  it("says what the run does once, beside the reply's author, and settles it into the facts the Host recorded, the same after a reload", async () => {
    const { context, page } = await open(1280, 820)
    try {
      const { id, reply } = await start(page, '检验回合脚部的进行与结算')
      const turn = page.locator('.turn').last()
      const status = turn.locator('.status-line')
      const footer = turn.locator('.turn-footer')
      // While the turn waits on the model a thinking mark stands where its text will be, once, with the clock (faa6ee50 moved it there from the
      // title row); under the turn it is only announced. The title row, the bar above the input and the footer say nothing.
      const said = page.locator('.thinking-line').filter({ visible: true })
      await said.first().waitFor()
      expect(await said.count()).toBe(1)
      await expect.poll(() => said.first().textContent(), { interval: 50, timeout: 5000 }).toMatch(/\d+:\d{2}/)
      expect(await page.locator('.workspace .topbar .ui-status-word').filter({ visible: true }).count()).toBe(0)
      const announced = page.locator('.transcript p.sr-only[role="status"]')
      await expect.poll(() => announced.last().textContent(), { interval: 20 }).toContain('运行中')
      expect(await status.count()).toBe(0)
      expect(await page.locator('.status-clock').count()).toBe(0)
      expect(await page.locator('.run-bar-collapse[data-state="open"]').count()).toBe(0)
      expect(await footer.count()).toBe(0)

      reply.append('回合脚部的第一段正文。')
      await liveRow(page, id)
      // Once text arrives it speaks for itself: the author line drops the words, and the title row stays quiet.
      await said.first().waitFor({ state: 'detached' })
      expect(await page.locator('.workspace .topbar .ui-status-word').filter({ visible: true }).count()).toBe(0)
      expect(await status.count()).toBe(0)
      reply.usage(1234, 340)
      reply.finish()
      await expect.poll(async () => (await host.bridge.detail(id)).summary.status, { interval: 20 }).toBe('idle')

      // Settled, the footer carries the turn's facts: when the reply was sent and its tokens, each with its unit; when the
      // turn began and ended is in the time's tooltip.
      await status.waitFor({ state: 'detached' })
      const facts = footer.locator('.turn-facts')
      await expect.poll(() => facts.innerText(), { interval: 20 }).toMatch(/输入 1\.2k tokens\s*·?\s*输出 340 tokens/)
      const settled = (await facts.textContent()) ?? ''
      const sent = facts.locator('time')
      expect(await sent.getAttribute('datetime')).toBe(
        (await host.bridge.detail(id)).messages.find(message => message.role === 'user')?.turn?.endedAt,
      )
      await turn.locator('.turn-reply').hover()
      await sent.hover()
      await expect
        .poll(() => page.getByRole('tooltip').filter({ visible: true }).textContent(), { interval: 50, timeout: 5000 })
        .toMatch(/开始 · \d{2}:\d{2}:\d{2} 完成/)
      await footer.getByRole('button', { name: '复制', exact: true }).waitFor({ state: 'attached' })
      const recorded = (await host.bridge.detail(id)).messages.find(message => message.role === 'user')?.turn
      expect(recorded).toEqual({ endedAt: expect.any(String), activeMs: expect.any(Number), waitMs: 0 })

      // After a reload it rests hidden on desktop until the pointer is on the turn, and reads the same.
      await page.mouse.move(0, 0)
      await page.reload()
      await connected(page)
      await expect.poll(() => facts.textContent(), { interval: 20 }).toBe(settled)
      expect(await footer.evaluate(element => getComputedStyle(element).opacity)).toBe('0')
      await turn.locator('.turn-reply').hover()
      await expect.poll(() => footer.evaluate(element => getComputedStyle(element).opacity), { interval: 20 }).toBe('1')
    } finally {
      await context.close()
    }
  })

  it('raises a prompt the page saw arrive and fades its reply in, never after a reload, and at once under reduced motion', async () => {
    const { context, page } = await open(1280, 820)
    try {
      const first = await start(page, '检验到达动效一')
      first.reply.append('第一轮。')
      first.reply.finish()
      await expect.poll(async () => (await host.bridge.detail(first.id)).summary.status, { interval: 20 }).toBe('idle')
      // CSS animations as they start, and each frame the elements that scripted animations move.
      await page.evaluate(() => {
        const root = document.documentElement
        root.dataset.seen = ''
        document.addEventListener('animationstart', event => {
          root.dataset.seen += ` ${event.animationName}`
        })
        const watch = () => {
          for (const animation of document.getAnimations()) {
            if (animation instanceof CSSAnimation || animation instanceof CSSTransition) continue
            const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null
            if (target) root.dataset.seen += ` animate:${target.getAttribute('class') ?? ''}`
          }
          requestAnimationFrame(watch)
        }
        requestAnimationFrame(watch)
      })
      const seen = async () => (await page.evaluate(() => document.documentElement.dataset.seen ?? '')).trim().split(/\s+/)
      const send = async (prompt: string) => {
        const reply = new ControlledReply()
        replies.set(prompt, reply)
        await page.getByRole('textbox', { name: '继续对话' }).fill(prompt)
        await page.getByRole('button', { name: '发送', exact: true }).click()
        await page.locator('.message-user[data-arrived]').filter({ hasText: prompt }).waitFor()
        reply.append('又一轮。')
        await page.locator('.turn').last().locator('.turn-reply[data-arrived]').waitFor()
        reply.finish()
        await expect.poll(async () => (await host.bridge.detail(first.id)).summary.status, { interval: 20 }).toBe('idle')
      }

      await send('检验到达动效二')
      await expect.poll(seen, { interval: 20 }).toEqual(expect.arrayContaining(['message-rise', 'message-fade']))

      // Under reduced motion the prompt and its reply appear at once.
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.evaluate(() => {
        document.documentElement.dataset.seen = ''
      })
      await send('检验到达动效三')
      expect(await seen()).not.toEqual(expect.arrayContaining(['message-rise']))
      expect(await seen()).not.toEqual(expect.arrayContaining(['message-fade']))
      await page.emulateMedia({ reducedMotion: 'no-preference' })

      // Switching to another session fades the conversation area in; nothing arrives, so nothing rises.
      const other = await start(page, '检验切换会话的淡入')
      other.reply.append('另一个会话。')
      other.reply.finish()
      await expect.poll(async () => (await host.bridge.detail(other.id)).summary.status, { interval: 20 }).toBe('idle')
      await page.evaluate(() => {
        document.documentElement.dataset.seen = ''
      })
      await openSession(page, first.id)
      await page.locator(`[data-task-id="${first.id}"][aria-current="page"]`).waitFor({ state: 'attached' })
      await page.locator('[data-message-id]').filter({ hasText: '第一轮。' }).waitFor()
      await expect.poll(seen, { interval: 20 }).toEqual(expect.arrayContaining(['animate:transcript-content']))
      expect(await page.locator('[data-arrived]').count()).toBe(0)

      // A reload draws the conversation as it is, without arrivals.
      await page.reload()
      await connected(page)
      await page.locator('[data-message-id]').filter({ hasText: '检验到达动效三' }).waitFor()
      expect(await page.locator('[data-arrived]').count()).toBe(0)
    } finally {
      await context.close()
    }
  })

  it('keeps all of a live reply when the device changes its motion preference', async () => {
    const { context, page } = await open(1280, 820)
    try {
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      const { reply, id } = await start(page, '在回复进行中减弱动效')
      const prefix = '甲乙丙。'
      const middle = '丁戊己庚辛。'
      const tail = '壬癸。'
      reply.append(prefix)
      const live = page.locator('.message-assistant.is-live').filter({ hasText: prefix })
      await live.waitFor()
      const replyId = await live.getAttribute('data-message-id')
      expect(replyId).toEqual(expect.any(String))
      const answer = page.locator(`.message-assistant[data-message-id="${replyId}"]`)
      const content = answer.locator('.message-content')

      reply.append(middle)
      await page.evaluate(() => {
        document.documentElement.dataset.motion = 'reduce'
      })
      await expect.poll(() => content.textContent()).toBe(prefix + middle)
      expect(await live.count()).toBe(1)
      reply.append(tail)
      await expect.poll(() => content.textContent()).toBe(prefix + middle + tail)

      reply.finish()
      await answer.locator('.message-content').waitFor()
      await expect.poll(() => live.count()).toBe(0)
      expect(await answer.count()).toBe(1)
      expect(await content.textContent()).toBe(prefix + middle + tail)
      const messages = (await host.bridge.detail(id)).messages.filter(message => message.id === replyId)
      expect(messages).toEqual([expect.objectContaining({ text: prefix + middle + tail })])
    } finally {
      await context.close()
    }
  })

  it('grows the input a line at a time over the motion tokens, and at once under reduced motion', async () => {
    const { context, page } = await open(1280, 820)
    try {
      await newDraft(page)
      const input = page.getByRole('textbox', { name: '新会话消息' })
      await input.waitFor()
      // Each height transition the input starts, as it starts, with the timing it runs on.
      await input.evaluate(element => {
        element.dataset.runs = ''
        element.addEventListener('transitionrun', event => {
          if (!(event instanceof TransitionEvent) || event.propertyName !== 'height') return
          const style = getComputedStyle(element)
          element.dataset.runs += `${style.transitionDuration} ${style.transitionTimingFunction}|`
        })
      })
      const runs = async () => ((await input.getAttribute('data-runs')) ?? '').split('|').filter(Boolean)
      const tokens = await page.evaluate(() => {
        const probe = document.createElement('div')
        document.body.append(probe)
        probe.style.transitionDuration = 'var(--m-micro)'
        probe.style.transitionTimingFunction = 'var(--e-micro)'
        const style = getComputedStyle(probe)
        const value = `${style.transitionDuration} ${style.transitionTimingFunction}`
        probe.remove()
        return value
      })
      expect(tokens).toBe('0.12s cubic-bezier(0.2, 0, 0, 1)')
      const height = () => input.evaluate(element => element.getBoundingClientRect().height)
      const resting = await height()
      // Within the three lines it starts with, typing moves nothing.
      await input.fill('第一行')
      await page.waitForTimeout(200)
      expect(await runs()).toEqual([])
      expect(await height()).toBe(resting)
      // Two more lines than it holds: the height follows over --m-micro.
      await input.fill('一\n二\n三\n四\n五')
      await expect.poll(runs).toEqual([tokens])
      await expect.poll(height).toBeGreaterThan(resting + 40)
      // Under reduced motion the next line arrives at once.
      await page.emulateMedia({ reducedMotion: 'reduce' })
      const grown = await height()
      await input.fill('一\n二\n三\n四\n五\n六')
      await expect.poll(height).toBeGreaterThan(grown)
      // The shared reduced-motion rule keeps only fades, so the height starts no transition at all.
      expect(await runs()).toEqual([tokens])
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
      // While it arrives the block shows its newest lines (text that just came is shown over a moment), and every line
      // once expanded.
      await expect
        .poll(() => block.locator('pre code').textContent(), { interval: 20 })
        .toBe(code.trimEnd().split('\n').slice(-17).join('\n'))
      await block.getByText('前 9 行已收起', { exact: true }).waitFor()
      const originalPre = await block.locator('pre').elementHandle()
      await block.getByRole('button', { name: '展开全部 26 行', exact: true }).click()
      expect(await block.locator('pre code').textContent()).toBe(code.trimEnd())
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
        // The fallback is a second real copy path; the failure state requires both writes to be refused.
        Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false })
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
      await page.getByRole('main').locator('.connection-pill').getByText('离线', { exact: true }).waitFor()
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

      // A manual resync must not duplicate committed rows. It is the connection's 重试, shown while the event stream
      // cannot reconnect (it is held off here; the other requests still reach the Host).
      await page.route('**/link/api/events**', route => route.abort())
      await context.setOffline(true)
      await context.setOffline(false)
      const retry = page.locator('.banner-region').getByRole('button', { name: '重试', exact: true })
      await retry.waitFor()
      const refreshed = page.waitForResponse(
        response => response.request().method() === 'GET' && new URL(response.url()).pathname === `/link/api/tasks/${id}`,
      )
      await retry.click()
      await refreshed
      await page.unroute('**/link/api/events**')
      await connected(page)
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
        [page.getByRole('button', { name: /^模型：/ }), '模型'],
      ] as const) {
        await trigger.click()
        const popover = page.getByRole('menu', { name: new RegExp(`^${menu}`, 'u') })
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
        // The picker's layer stays in the page, hidden; the action menu's leaves it.
        await popover.waitFor({ state: 'hidden' })
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
      await page.locator('.workbench-home').waitFor()
      await page.getByRole('textbox', { name: '新会话消息' }).waitFor()
      await page.getByRole('status').filter({ hasText: '会话已不可见' }).waitFor()
      await connected(page)
      expect(await page.locator('.banner-region').count()).toBe(0)
      expect(await page.locator(`[data-task-id="${id}"]`).count()).toBe(0)
    } finally {
      await context.close()
    }
  })

  it('withdraws the open transcript when a new complete listing drops it and its detail cannot answer', async () => {
    const { context, page } = await open(1280, 820)
    let releaseDetail = () => {}
    const blockedDetail = new Promise<void>(resolve => {
      releaseDetail = resolve
    })
    try {
      const { id, reply } = await start(page, '检查完整列表撤下当前会话')
      const text = '最后读到的会话正文。'
      reply.append(text)
      reply.finish()
      await expect.poll(async () => (await host.bridge.detail(id)).summary.status).toBe('idle')
      const transcript = page.locator('.transcript').getByText(text, { exact: true })
      await transcript.waitFor()
      const owner = await testHost.enroll({ listener: 'unix' })
      const task = `tasks/${encodeURIComponent(id)}`
      const lastRead = await owner.json<TaskDetail>(task)
      expect(lastRead.sync?.revision).toBeDefined()
      await page.route(
        url => url.pathname === `/link/api/${task}`,
        async route => {
          if (route.request().method() !== 'GET') return route.continue()
          await blockedDetail
          await route.abort('connectionreset').catch(() => {})
        },
      )
      const complete = page.waitForResponse(async response => {
        if (new URL(response.url()).pathname !== '/link/api/snapshot' || !response.ok()) return false
        const snapshot = (await response.json()) as AppSnapshot
        return (
          snapshot.tasksComplete === true
          && (snapshot.revision ?? -1) > lastRead.sync!.revision
          && !snapshot.tasks.some(item => item.id === id)
        )
      })
      expect((await owner.request(task, { method: 'DELETE' })).status).toBe(200)
      await complete
      await page.locator(`[data-task-id="${id}"]`).waitFor({ state: 'detached' })
      await expect.poll(() => transcript.count(), { timeout: 3_000 }).toBe(0)
      await homeInput(page).waitFor()
    } finally {
      releaseDetail()
      await context.close()
    }
  })
})
