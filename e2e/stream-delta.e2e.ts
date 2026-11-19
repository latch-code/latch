import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { chromium, type Page } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import type { HarnessPlugin } from '@latch/sdk'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { openSession } from './helpers/layout.ts'
import { startTestHost } from './helpers/host.ts'
import { promptValue } from './helpers/prompt.ts'

function gate() {
  let release!: () => void
  const waiting = new Promise<void>(resolve => {
    release = resolve
  })
  return { waiting, release }
}

interface StreamProbe {
  requests: Array<{ sessionId: string | null; capability: string | null; aborted: boolean }>
  frames: Array<{ type: string; bytes: number; sequence?: number; subscription?: string }>
  damaged: number
}
declare global {
  interface Window {
    deltaProbe: StreamProbe
  }
}

/** Observe only fixture SSE, never credentials. A damaged suffix is injected after real Host authorization. */
async function instrument(page: Page, damage: boolean) {
  await page.addInitScript(damage => {
    const probe: StreamProbe = { requests: [], frames: [], damaged: 0 }
    window.deltaProbe = probe
    const fetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href)
      if (url.pathname !== '/link/api/events') return fetch(input, init)
      const entry = {
        sessionId: url.searchParams.get('sessionId'),
        capability: new Headers(init?.headers).get('x-latch-state'),
        aborted: false,
      }
      probe.requests.push(entry)
      init?.signal?.addEventListener(
        'abort',
        () => {
          entry.aborted = true
        },
        { once: true },
      )
      const response = await fetch(input, init)
      if (!response.ok || !response.body) return response
      const encoder = new TextEncoder(),
        decoder = new TextDecoder()
      let pending = ''
      const body = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            pending += decoder.decode(chunk, { stream: true })
            for (;;) {
              const end = pending.indexOf('\n\n')
              if (end < 0) break
              let block = pending.slice(0, end + 2)
              pending = pending.slice(end + 2)
              const data = block
                .split('\n')
                .find(line => line.startsWith('data: '))
                ?.slice(6)
              if (data) {
                const event = JSON.parse(data) as {
                  type: string
                  text?: { offset: number }
                  stream?: { stateSeq: number; subscriptionId: string }
                }
                if (event.type === 'task-state' || event.type === 'task-delta') {
                  probe.frames.push({
                    type: event.type,
                    bytes: encoder.encode(block).length,
                    ...(event.stream ? { sequence: event.stream.stateSeq, subscription: event.stream.subscriptionId } : {}),
                  })
                  if (damage && event.type === 'task-delta' && probe.damaged === 0) {
                    event.text!.offset++
                    // Two bad frames in one browser chunk must not start two repair connections.
                    block = `event: task-delta\ndata: ${JSON.stringify(event)}\n\n`.repeat(2)
                    probe.damaged++
                  }
                }
              }
              controller.enqueue(encoder.encode(block))
            }
          },
          flush(controller) {
            pending += decoder.decode()
            if (pending) controller.enqueue(encoder.encode(pending))
          },
        }),
      )
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
    }
  }, damage)
}

describe('negotiated text stream', () => {
  it.each([
    { damage: false, remote: false, reconnect: false, narrow: false },
    { damage: true, remote: false, reconnect: false, narrow: false },
    { damage: false, remote: true, reconnect: false, narrow: false },
    { damage: false, remote: false, reconnect: true, narrow: false },
    { damage: false, remote: false, reconnect: false, narrow: true },
  ])(
    'preserves the composer and reply (damaged: $damage, native shell: $remote, reconnect: $reconnect, narrow: $narrow)',
    async ({ damage, remote, reconnect, narrow }) => {
      const steps = Array.from({ length: 5 }, gate)
      const chunks = ['正文🙂', '中文追加', '组合e\u0301', '最后一段']
      const history = '历史只应出现一次。'.repeat(500)
      const provider: HarnessPlugin = {
        id: 'delta-browser',
        name: '增量夹具',
        version: '1',
        description: '',
        activate(context) {
          context.registerProvider({
            id: 'delta-browser',
            name: '增量夹具',
            model: 'fixture',
            async *stream({ messages }) {
              if (messages.findLast(message => message.role === 'user')?.content === '增量验收') {
                for (let index = 0; index < chunks.length; index++) {
                  await steps[index]!.waiting
                  yield { type: 'text', text: chunks[index]! }
                }
                await steps[4]!.waiting
              } else yield { type: 'text', text: history }
              yield { type: 'finish', reason: 'stop' }
            },
          })
        },
      }
      const host = await startTestHost({ demo: false, plugins: [provider], uiDir: resolve('dist/web') })
      const browser = await chromium.launch(browserLaunchOptions())
      const context = await browser.newContext({ viewport: { width: 1440, height: 950 }, locale: 'zh-CN', reducedMotion: 'reduce' })
      const page = await context.newPage()
      page.setDefaultTimeout(20_000)
      try {
        const owner = await host.enroll({ listener: 'unix' })
        const bridge = host.host.bridge
        const { sessionId } = await bridge.createTask({
          requestId: randomUUID(),
          prompt: '历史-0',
          mode: 'chat',
          model: { providerId: 'delta-browser', model: 'fixture' },
        })
        const settled = () => expect.poll(async () => (await bridge.detail(sessionId)).summary.status).toBe('idle')
        await settled()
        for (let index = 1; index < 10; index++) {
          await bridge.prompt(sessionId, `历史-${index}`, randomUUID())
          await settled()
        }
        await instrument(page, damage)
        await enrollBrowser(page, host)
        if (remote) {
          await page.addInitScript(() => {
            Object.defineProperty(window, 'latchShell', { value: { kind: 'electron', devMode: false, platform: 'darwin', remote: true } })
          })
          await page.reload()
          await connected(page)
        }
        await openSession(page, sessionId)
        const browserId = await page.evaluate(async () => {
          const snapshot = (await (await fetch('/link/api/snapshot')).json()) as { device: { id: string } }
          return snapshot.device.id
        })
        const input = page.getByRole('textbox', { name: '继续对话', exact: true })
        await input.fill('增量验收')
        await input.press('Meta+Enter')
        await expect.poll(async () => (await bridge.detail(sessionId)).summary.status).toBe('running')
        steps[0]!.release()
        const reply = page.locator('.turn-reply .message-content').last()
        await expect.poll(() => reply.textContent()).toBe(chunks[0])
        const firstDetail = await bridge.detail(sessionId),
          messageId = firstDetail.liveMessageId!
        expect(messageId).toBeTruthy()
        const live = await reply.elementHandle(),
          old = await page.locator('.turn-reply .message-content').first().elementHandle()
        await input.fill('下一轮草稿')
        for (let index = 1; index < chunks.length; index++) {
          if (reconnect && index === 2) {
            await context.setOffline(true)
            await expect.poll(() => page.locator('.app-shell').getAttribute('data-connection')).toBe('offline')
            await context.setOffline(false)
            await connected(page)
          }
          if (narrow && index === 2) {
            await owner.json(`devices/${browserId}`, { method: 'PATCH', body: { scopes: ['view', 'run'] } })
            await expect
              .poll(() => page.evaluate(id => window.deltaProbe.requests.filter(request => request.sessionId === id).length, sessionId))
              .toBe(2)
            await connected(page)
          }
          steps[index]!.release()
          await expect.poll(() => reply.textContent()).toBe(chunks.slice(0, index + 1).join(''))
          if (!narrow) {
            expect(await live!.evaluate(element => element === document.querySelectorAll('.turn-reply .message-content')[10])).toBe(true)
            expect(await old!.evaluate(element => element === document.querySelector('.turn-reply .message-content'))).toBe(true)
          }
          expect(await promptValue(input)).toBe('下一轮草稿')
        }
        // A local draft remains owned by the same composer through all full/delta/repair publications.
        steps[4]!.release()
        await settled()
        await expect.poll(() => reply.getAttribute('aria-busy')).toBe(null)
        expect(await reply.textContent()).toBe(chunks.join(''))
        expect(await promptValue(input)).toBe('下一轮草稿')
        expect(await page.locator('.turn-reply .message-content').count()).toBe(11)
        if (!narrow)
          expect(await live!.evaluate(element => element === document.querySelectorAll('.turn-reply .message-content')[10])).toBe(true)
        const detail = await bridge.detail(sessionId)
        expect(detail.messages.filter(message => message.id === messageId)).toHaveLength(1)
        expect(detail.messages.find(message => message.id === messageId)?.text).toBe(chunks.join(''))
        const probe = await page.evaluate(() => window.deltaProbe)
        const requests = probe.requests.filter(request => request.sessionId === sessionId)
        expect(requests[0]?.capability).toBe(remote ? null : 'delta-v1')
        expect(requests).toHaveLength(damage || reconnect || narrow ? 2 : 1)
        expect(probe.frames.at(-1)?.type).toBe('task-state')
        const deltas = probe.frames.filter(frame => frame.type === 'task-delta')
        if (remote) expect(deltas).toHaveLength(0)
        else expect(deltas.length).toBeGreaterThan(0)
        expect(deltas.every(frame => frame.bytes < 2000)).toBe(true)
        expect(probe.frames.some(frame => frame.type === 'task-state' && frame.bytes > 100_000)).toBe(true)
        if (damage) {
          expect(probe.damaged).toBe(1)
          expect(requests[0]?.aborted).toBe(true)
          expect(requests[1]?.capability).toBe(null)
          expect(probe.frames.at(-1)?.subscription).toBeUndefined()
        } else if (!remote) {
          const stamps = probe.frames.filter(frame => frame.subscription)
          const subscriptions = new Set(stamps.map(frame => frame.subscription))
          expect(subscriptions.size).toBe(reconnect || narrow ? 2 : 1)
          for (const subscription of subscriptions) {
            const part = stamps.filter(frame => frame.subscription === subscription)
            expect(part[0]?.type).toBe('task-state')
            expect(part.map(frame => frame.sequence)).toEqual(part.map((_, index) => index + 1))
          }
          if (reconnect || narrow) {
            expect(requests[0]?.aborted).toBe(true)
            expect(requests[1]?.capability).toBe('delta-v1')
          }
        } else {
          expect(probe.frames.every(frame => frame.type === 'task-state' && frame.subscription === undefined)).toBe(true)
        }
      } finally {
        for (const step of steps) step.release()
        await context.close()
        await browser.close()
        await host.close()
      }
    },
  )
})
