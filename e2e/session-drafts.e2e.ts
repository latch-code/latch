import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { expect, it } from 'vitest'
import type { CustomAgent, TaskDetail } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'

it.each([false, true])('clears the active draft when another device deletes its session (agent=%s)', async owned => {
  let modelCalls = 0
  const plugin: HarnessPlugin = {
    id: 'draft-fixture',
    name: 'Draft fixture',
    version: '1',
    description: '',
    activate(context) {
      context.registerProvider({
        id: 'draft-fixture',
        name: 'Draft fixture',
        model: 'fixture',
        async *stream() {
          modelCalls++
          yield { type: 'text', text: 'A local fixture reply.' }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  const host = await startTestHost({ plugins: [plugin] })
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const model = { providerId: 'draft-fixture', model: 'fixture' }
    const agent = owned
      ? await owner.json<CustomAgent>('custom-agents', {
          method: 'POST',
          body: {
            requestId: randomUUID(),
            name: '私有草稿 Agent',
            description: '',
            instructions: 'Private fixture instructions',
            mode: 'chat',
            harnessId: 'standard',
            model,
            skills: [],
          },
        })
      : undefined
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        prompt: owned ? '私有草稿会话' : '普通草稿会话',
        ...(agent ? { customAgentId: agent.id } : { mode: 'chat', model }),
      },
    })
    await expect.poll(async () => (await owner.json<TaskDetail>('tasks/' + sessionId)).summary.status, { timeout: 10_000 }).toBe('idle')
    const detail = await owner.json<TaskDetail>('tasks/' + sessionId)
    const context = await browser.newContext({ viewport: { width: owned ? 390 : 1440, height: 900 }, reducedMotion: 'reduce' })
    try {
      const page = await context.newPage()
      await enrollBrowser(page, host, { name: 'Draft isolation', scopes: ['view', 'run'] })
      const deviceId = host.host.security.devices.list().find(device => device.name === 'Draft isolation')!.id
      expect((await owner.confirmed('devices/' + deviceId, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
      await page.reload()
      await connected(page)
      await page.keyboard.press('Meta+k')
      const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
      await palette.getByRole('searchbox').fill(detail.summary.title)
      await palette.getByRole('option', { name: detail.summary.title, exact: true }).click()
      const input = page.getByRole('textbox', { name: '继续对话', exact: true })
      const text = owned ? 'Private unsent text must never enter a new task' : 'Text belongs only to the deleted session'
      await input.fill(text)
      const callsBefore = modelCalls
      const submissions: string[] = []
      page.on('request', request => {
        if (request.method() === 'POST' && /\/api\/tasks(?:\/[^/]+\/prompt)?$/u.test(new URL(request.url()).pathname))
          submissions.push(request.postData() ?? '')
      })
      expect((await owner.request('tasks/' + sessionId, { method: 'DELETE' })).status).toBe(200)
      await expect.poll(() => page.getByText('会话已被删除', { exact: true }).isVisible(), { timeout: 10_000 }).toBe(true)
      await page.keyboard.press('Alt+l')
      await expect
        .poll(() => page.locator('textarea').evaluateAll(elements => elements.map(element => (element as HTMLTextAreaElement).value)))
        .toEqual([''])
      expect(submissions).toEqual([])
      expect(modelCalls).toBe(callsBefore)
    } finally {
      await context.close()
    }
  } finally {
    await browser.close()
    await host.close()
  }
})

it.each([
  [false, false, false],
  [true, false, false],
  [false, true, false],
  [true, true, false],
  [false, true, true],
  [true, true, true],
] as const)('keeps the destination and drafts after navigation (resend=%s, unknown=%s, reload=%s)', async (resend, unknown, reload) => {
  const calls = new Map<string, number>()
  const plugin: HarnessPlugin = {
    id: 'late-draft-fixture',
    name: 'Late draft fixture',
    version: '1',
    description: '',
    activate(context) {
      context.registerProvider({
        id: 'late-draft-fixture',
        name: 'Late draft fixture',
        model: 'fixture',
        async *stream({ messages }) {
          const prompt = messages.findLast(message => message.role === 'user')!.content
          const count = (calls.get(prompt) ?? 0) + 1
          calls.set(prompt, count)
          if (prompt === '会话 A' && count === 1) throw new Error('Expected local fixture failure')
          yield { type: 'text', text: 'A local reply: ' + prompt }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  const host = await startTestHost({ plugins: [plugin] })
  const browser = await chromium.launch(browserLaunchOptions())
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const create = async (prompt: string) => {
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { requestId: randomUUID(), prompt, mode: 'chat', model: { providerId: 'late-draft-fixture', model: 'fixture' } },
      })
      await expect
        .poll(async () => ['idle', 'failed'].includes((await owner.json<TaskDetail>('tasks/' + sessionId)).summary.status), {
          timeout: 10_000,
        })
        .toBe(true)
      return owner.json<TaskDetail>('tasks/' + sessionId)
    }
    const a = await create('会话 A'),
      b = await create('会话 B')
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    try {
      const page = await context.newPage()
      await enrollBrowser(page, host, { scopes: ['view', 'run'] })
      const choose = async (title: string) => {
        await page.keyboard.press('Meta+k')
        const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
        await palette.getByRole('searchbox').fill(title)
        await palette.getByRole('option', { name: title, exact: true }).click()
      }
      const input = page.getByRole('textbox', { name: '继续对话', exact: true })
      await choose(b.summary.title)
      await input.fill('Draft B stays with B')
      await choose(a.summary.title)
      const draftA = 'Draft A stays with A'
      await input.fill(draftA)
      let accepted = false,
        attempts = 0,
        routeFailed = false
      const requestIds: string[] = []
      await page.route('**/link/api/tasks/' + a.summary.id + '/prompt', async route => {
        try {
          attempts++
          requestIds.push((route.request().postDataJSON() as { requestId: string }).requestId)
          // Lost before it reached the Host: nothing can prove it delivered, so only a retry or 放弃 ends it.
          if (unknown && attempts === 1) {
            await route.abort('failed')
            return
          }
          const response = await route.fetch()
          accepted = true
          await gate
          await route.fulfill({ response })
        } catch {
          routeFailed = true
        }
      })
      await page
        .getByRole('button', { name: resend ? '重试' : '发送', exact: true })
        .last()
        .click()
      if (unknown) await page.getByRole('button', { name: '重试这次提交', exact: true }).waitFor()
      else await expect.poll(() => accepted).toBe(true)
      await choose(b.summary.title)
      expect(await input.inputValue()).toBe('Draft B stays with B')
      if (reload) {
        await page.reload()
        await connected(page)
        await page.getByRole('button', { name: '打开', exact: true }).waitFor()
        // Kept in this device's browser storage across the reload.
        expect(await input.inputValue()).toBe('Draft B stays with B')
      }
      const expectedB = 'Draft B stays with B'
      if (unknown) {
        // The row in B points home; the retry happens there, and B's draft stays with B.
        accepted = false
        await page.getByRole('button', { name: '打开', exact: true }).click()
        await page.getByRole('button', { name: '重试这次提交', exact: true }).click()
        await expect.poll(() => accepted).toBe(true)
        await choose(b.summary.title)
      }
      release()
      await expect.poll(() => input.isEnabled()).toBe(true)
      expect(routeFailed).toBe(false)
      const bMessage = b.messages.find(message => message.role === 'user')!.id
      await page.locator('.transcript [data-message-id="' + bMessage + '"]').waitFor({ state: 'visible' })
      expect(await input.inputValue()).toBe(expectedB)
      expect(await page.getByRole('button', { name: '发送', exact: true }).isEnabled()).toBe(expectedB.length > 0)
      await choose(a.summary.title)
      expect(await input.inputValue()).toBe(resend ? draftA : '')
      await choose(b.summary.title)
      expect(await input.inputValue()).toBe(expectedB)
      expect((calls.get('会话 A') ?? 0) + (calls.get(draftA) ?? 0)).toBe(2)
      expect(requestIds).toHaveLength(unknown ? 2 : 1)
      expect(new Set(requestIds).size).toBe(1)
    } finally {
      release()
      await context.close()
    }
  } finally {
    release()
    await browser.close()
    await host.close()
  }
})

it('keeps text drafts across a reload, per session and for a new session, and clears them on delete and on removal', async () => {
  const plugin: HarnessPlugin = {
    id: 'reload-draft-fixture',
    name: 'Reload draft fixture',
    version: '1',
    description: '',
    activate(context) {
      context.registerProvider({
        id: 'reload-draft-fixture',
        name: 'Reload draft fixture',
        model: 'fixture',
        async *stream() {
          yield { type: 'text', text: 'A local fixture reply.' }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  const host = await startTestHost({ plugins: [plugin] })
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const create = async (prompt: string) => {
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { requestId: randomUUID(), prompt, mode: 'chat', model: { providerId: 'reload-draft-fixture', model: 'fixture' } },
      })
      await expect.poll(async () => (await owner.json<TaskDetail>('tasks/' + sessionId)).summary.status, { timeout: 10_000 }).toBe('idle')
      return owner.json<TaskDetail>('tasks/' + sessionId)
    }
    const a = await create('重载草稿 A'),
      b = await create('重载草稿 B')
    await mkdir('test-results/session-drafts', { recursive: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    await enrollBrowser(page, host, { name: 'Reload drafts', scopes: ['view', 'run'] })
    const deviceId = host.host.security.devices.list().find(device => device.name === 'Reload drafts')!.id
    // Only a device that sees every session may take a session missing from the list as deleted.
    expect((await owner.confirmed('devices/' + deviceId, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
    await page.reload()
    await connected(page)
    const stored = () =>
      page.evaluate(() =>
        Object.keys(localStorage)
          .filter(key => key.startsWith('latch.drafts.'))
          .map(key => localStorage.getItem(key))
          .join('\n'),
      )
    const choose = async (title: string) => {
      await page.keyboard.press('Meta+k')
      const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
      await palette.getByRole('searchbox').fill(title)
      await palette.getByRole('option', { name: title, exact: true }).click()
    }
    const input = page.getByRole('textbox', { name: '继续对话', exact: true })
    await choose(a.summary.title)
    await input.fill('草稿 A：还没发')
    await choose(b.summary.title)
    await input.fill('草稿 B：还没发')
    await page.reload()
    await connected(page)
    await expect.poll(() => input.inputValue()).toBe('草稿 B：还没发')
    await page.screenshot({ path: 'test-results/session-drafts/after-reload-1440-light.png', animations: 'disabled' })
    await choose(a.summary.title)
    expect(await input.inputValue()).toBe('草稿 A：还没发')
    await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
    const fresh = page.getByRole('textbox', { name: '新会话消息', exact: true })
    await fresh.fill('新会话的草稿')
    await page.reload()
    await connected(page)
    await expect.poll(() => fresh.inputValue()).toBe('新会话的草稿')
    // Deleted on another device while this page shows something else: its text goes from storage.
    expect((await owner.request('tasks/' + a.summary.id, { method: 'DELETE' })).status).toBe(200)
    await expect.poll(stored, { timeout: 10_000 }).not.toContain('草稿 A')
    expect(await stored()).toContain('草稿 B')
    // Deleted here: gone at once.
    await choose(b.summary.title)
    await page.locator('.topbar .topbar-title-button').click()
    await page
      .getByRole('menu', { name: '会话：' + b.summary.title, exact: true })
      .locator('[data-label="删除"]')
      .click()
    await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click()
    await expect.poll(stored, { timeout: 10_000 }).not.toContain('草稿 B')
    expect(await stored()).toContain('新会话的草稿')
    // Removed: the next answer the page gets is a refusal, and every draft of this origin goes.
    expect((await owner.confirmed('devices/' + deviceId, { method: 'DELETE' })).status).toBe(200)
    await page.reload()
    await expect.poll(stored, { timeout: 10_000 }).toBe('')
    await context.close()
  } finally {
    await browser.close()
    await host.close()
  }
})
