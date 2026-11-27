import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { startTestHost } from './helpers/host.ts'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { closeSettings, openSection, openSession, openSettings } from './helpers/layout.ts'
import { switchView } from './helpers/workbench.ts'

const historyModel = { providerId: 'large-idle', model: 'fixture' }

function startHistoryHost(reply: (prompt: string | undefined) => string) {
  return startTestHost({
    demo: false,
    plugins: [
      {
        id: historyModel.providerId,
        name: '长会话夹具',
        description: '',
        version: '1',
        activate(context) {
          context.registerProvider({
            id: historyModel.providerId,
            name: '长会话夹具',
            model: historyModel.model,
            async *stream({ messages }) {
              yield { type: 'text', text: reply(messages.at(-1)?.content) }
              yield { type: 'finish', reason: 'stop' }
            },
          })
        },
      },
    ],
  })
}

/** One renderer and one real Host through every circuit. Only a test Host's DNS is replaced. */
it.skipIf(process.env.LATCH_WORKSPACE_SOAK !== '1')(
  'keeps a draft and a usable shell across workbench pages in one renderer',
  async () => {
    const host = await startTestHost({
      egressLookup: (_hostname, _options, done) => done(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), []),
    })
    const browser = await chromium.launch(browserLaunchOptions())
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { requestId: randomUUID(), prompt: '跨页工作台验收', mode: 'chat' },
      })
      const detail = () => owner.json<TaskDetail>('tasks/' + sessionId)
      await expect.poll(async () => (await detail()).summary.status).toBe('idle')
      const messages = (await detail()).messages.map(m => m.id)
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
      let errors = 0,
        crashes = 0
      page.on('pageerror', () => {
        errors++
      })
      page.on('crash', () => {
        crashes++
      })
      await enrollBrowser(page, host, { name: '页面长跑', scopes: ['view', 'run', 'admin'] })
      const id = host.host.security.devices.list().find(device => device.name === '页面长跑')!.id
      expect((await owner.confirmed('devices/' + id, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
      await page.reload()
      await connected(page)
      await openSession(page, sessionId)
      const input = page.locator('.composer-stack .cm-content:visible').first()
      const draft = '留在此会话的未发送草稿'
      await input.fill(draft)
      const timeOrigin = await page.evaluate(() => performance.timeOrigin)
      const cdp = await page.context().newCDPSession(page)
      const samples = []
      let sections: string[] = []
      for (let round = 1; round <= 12; round++) {
        await switchView(page, 'board')
        await page.locator('.work-board').waitFor()
        await switchView(page, 'chat')
        await page.keyboard.press('Meta+k')
        const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
        await palette.waitFor()
        await page.keyboard.press('Escape')
        await palette.waitFor({ state: 'hidden' })
        await page.getByRole('radio', { name: '我的 Agent', exact: true }).filter({ visible: true }).first().click()
        await page.locator('.agents-page').waitFor()
        await page.getByRole('radio', { name: 'Code', exact: true }).filter({ visible: true }).first().click()
        const market = page.getByRole('region', { name: '插件市场', exact: true })
        await page.locator('#session-navigation').getByRole('button', { name: '插件市场', exact: true }).click()
        await market.getByRole('searchbox').first().waitFor()
        await page.goBack()
        await market.waitFor({ state: 'hidden' })
        const settings = await openSettings(page)
        const available = await settings.locator('[id^="settings-tab-"]').allTextContents()
        if (round === 1) sections = available
        expect(available).toEqual(sections)
        expect(available).toContain('模型')
        expect(available).toContain('Harness')
        for (const name of available) {
          await openSection(settings, name.trim())
          await settings.locator('.settings-content').waitFor()
        }
        await closeSettings(settings)
        await connected(page)
        expect(await input.textContent()).toBe(draft)
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin)
        await cdp.send('HeapProfiler.collectGarbage')
        const { usedSize } = await cdp.send('Runtime.getHeapUsage')
        const { nodes, jsEventListeners } = await cdp.send('Memory.getDOMCounters')
        samples.push({ round, usedSize, nodes, jsEventListeners })
      }
      expect((await detail()).messages.map(m => m.id)).toEqual(messages)
      expect({ errors, crashes }).toEqual({ errors: 0, crashes: 0 })
      await mkdir('test-results/workspace-stability', { recursive: true })
      const label = process.env.LATCH_SPACE_LABEL ?? 'local'
      if (!/^[a-z0-9-]{1,48}$/u.test(label)) throw new Error('Invalid result label')
      await writeFile(
        'test-results/workspace-stability/' + label + '.json',
        JSON.stringify({ sections, samples, errors, crashes }, null, 2) + '\n',
      )
    } finally {
      await browser.close()
      await host.close()
    }
  },
  300_000,
)

/** The 30-second idle poll must continue checking authority without repeatedly parsing the same large response. */
it.skipIf(process.env.LATCH_LARGE_HISTORY_BENCH !== '1')(
  'measures automatic reads of a multi-megabyte settled conversation',
  async () => {
    const payload = '这是一段用于检查长会话空闲读取的固定正文。'.repeat(5200)
    const host = await startHistoryHost(() => payload)
    const browser = await chromium.launch(browserLaunchOptions())
    try {
      const bridge = host.host.bridge
      const { sessionId } = await bridge.createTask({
        prompt: '长会话 1',
        requestId: randomUUID(),
        mode: 'chat',
        model: historyModel,
      })
      const settle = () => expect.poll(async () => (await bridge.detail(sessionId)).summary.status, { timeout: 20000 }).toBe('idle')
      await settle()
      for (let i = 2; i <= 8; i++) {
        await bridge.prompt(sessionId, '长会话 ' + i, randomUUID())
        await settle()
      }
      const history = await bridge.detail(sessionId)
      expect(history.messages.filter(item => item.role === 'assistant' && item.text === payload)).toHaveLength(8)
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
      const taskPath = '/link/api/tasks/' + sessionId
      const probe = await page.context().newCDPSession(page)
      await probe.send('Network.enable')
      const bodies = new Map<string, 'snapshot' | 'detail'>()
      const samples = { snapshot: 0, detail: 0, detailWireBytes: 0 }
      let idle = false
      probe.on('Network.responseReceived', event => {
        if (!idle) return
        const path = new URL(event.response.url).pathname
        if (path === taskPath || path === '/link/api/snapshot') bodies.set(event.requestId, path === taskPath ? 'detail' : 'snapshot')
      })
      probe.on('Network.loadingFinished', event => {
        const kind = bodies.get(event.requestId)
        if (!kind) return
        bodies.delete(event.requestId)
        samples[kind]++
        if (kind === 'detail') samples.detailWireBytes += event.encodedDataLength
      })
      await enrollBrowser(page, host, { name: '长会话空闲观察' })
      await openSession(page, sessionId)
      await page.locator('.transcript-shell').getByText('长会话 8', { exact: true }).waitFor()
      await connected(page)
      await page.waitForTimeout(1500)
      idle = true
      await expect.poll(() => samples.snapshot, { interval: 500, timeout: 125_000 }).toBeGreaterThanOrEqual(3)
      await page.waitForTimeout(2000)
      idle = false
      const input = page.locator('.composer-stack .cm-content:visible').first()
      await input.fill('空闲后仍可输入')
      expect(await input.textContent()).toBe('空闲后仍可输入')
      const label = process.env.LATCH_SPACE_LABEL ?? 'local'
      if (!/^[a-z0-9-]{1,48}$/u.test(label)) throw new Error('Invalid result label')
      await mkdir('test-results/workspace-stability', { recursive: true })
      await writeFile(
        'test-results/workspace-stability/large-idle-' + label + '.json',
        JSON.stringify({ ...samples, historyTextBytes: 8 * Buffer.byteLength(payload) }, null, 2) + '\n',
      )
    } finally {
      await browser.close()
      await host.close()
    }
  },
  200_000,
)

interface HistoryCopies {
  reads: number
  alive: number
}

it.skipIf(process.env.LATCH_LARGE_HISTORY_BENCH !== '1')(
  'does not keep two copies of a large conversation after switching away',
  async () => {
    const short = '切换到短会话'
    // Four replies together exceed the warm detail cache's 4 MiB budget even before counting object overhead.
    const paragraph = '用于检查会话切换的合成长正文，保留可读片段。'.repeat(64) + '\n\n'
    const payload = paragraph.repeat(512) + '这是这一轮的结尾。'
    const host = await startHistoryHost(prompt => (prompt === short ? '短会话就绪。' : payload))
    const browser = await chromium.launch(browserLaunchOptions())
    try {
      const bridge = host.host.bridge
      const owner = await host.enroll({ listener: 'unix' })
      const start = async (prompt: string) =>
        (await bridge.createTask({ prompt, requestId: randomUUID(), mode: 'agent', model: historyModel })).sessionId
      const settle = (id: string) => expect.poll(async () => (await bridge.detail(id)).summary.status, { timeout: 20_000 }).toBe('idle')
      const largeId = await start('长会话 1')
      await settle(largeId)
      for (let turn = 2; turn <= 4; turn++) {
        await bridge.prompt(largeId, `长会话 ${turn}`, randomUUID())
        await settle(largeId)
      }
      const smallId = await start(short)
      await settle(smallId)
      const lastReply = async (id: string) => (await bridge.detail(id)).messages.findLast(message => message.role === 'assistant')!.id
      const largeReply = await lastReply(largeId)
      const smallReply = await lastReply(smallId)
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
      await page.addInitScript(taskPath => {
        const copies: WeakRef<readonly unknown[]>[] = []
        const json = Object.getOwnPropertyDescriptors(Response.prototype).json.value
        if (!json) throw new Error('Response.json is unavailable')
        // Observe the objects the application reads without retaining them or changing the response.
        Response.prototype.json = async function () {
          const detail: unknown = await json.call(this)
          if (
            this.ok
            && new URL(this.url).pathname === taskPath
            && detail !== null
            && typeof detail === 'object'
            && 'messages' in detail
            && Array.isArray(detail.messages)
          ) {
            copies.push(new WeakRef(detail.messages))
          }
          return detail
        }
        Object.assign(globalThis, {
          historyCopies: (): HistoryCopies => ({ reads: copies.length, alive: copies.filter(ref => ref.deref()).length }),
        })
      }, '/link/api/tasks/' + largeId)
      await enrollBrowser(page, host, { name: '长会话切换观察', scopes: ['view', 'run', 'admin'] })
      const deviceId = host.host.security.devices.list().find(device => device.name === '长会话切换观察')!.id
      expect((await owner.confirmed('devices/' + deviceId, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
      await page.reload()
      await connected(page)
      const cdp = await page.context().newCDPSession(page)
      const copies = () =>
        page.evaluate(() => {
          const { historyCopies } = globalThis as typeof globalThis & { historyCopies?: () => HistoryCopies }
          if (!historyCopies) throw new Error('History copy observer is unavailable')
          return historyCopies()
        })
      const open = async (id: string, reply: string) => {
        await openSession(page, id)
        await page.locator(`.transcript [data-message-id="${reply}"] .message-text`).waitFor()
        await connected(page)
      }
      await open(smallId, smallReply)
      for (let round = 1; round <= 3; round++) {
        const before = (await copies()).reads
        await open(largeId, largeReply)
        expect((await copies()).reads).toBeGreaterThan(before)
        expect((await copies()).alive).toBeGreaterThan(0)
        await open(smallId, smallReply)
        await expect
          .poll(
            async () => {
              await cdp.send('HeapProfiler.collectGarbage')
              return (await copies()).alive
            },
            { timeout: 5_000 },
          )
          .toBeLessThanOrEqual(1)
      }
    } finally {
      await browser.close()
      await host.close()
    }
  },
)
