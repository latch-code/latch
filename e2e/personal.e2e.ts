import { chromium, type Browser } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { backToPhoneSessions, noHorizontalOverflow, reachable } from './helpers/layout.ts'

describe('personal assistants across workbench sizes', () => {
  let host: TestHost, browser: Browser
  beforeAll(async () => {
    host = await startTestHost({ demo: true })
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir('test-results/personal', { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
  })
  it.each([
    [390, 'light'],
    [900, 'dark'],
    [1440, 'light'],
    [1440, 'dark'],
  ] as const)(
    '%s %s creates an assistant and explicit memory, starts a project-free conversation and clears private content on access change',
    async (width, theme) => {
      const desktop = await host.enroll({ listener: 'unix' })
      const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme: theme, locale: 'zh-CN' })
      const page = await context.newPage()
      page.setDefaultTimeout(15000)
      const name = '日常助理 ' + width + ' ' + theme
      const privateMemory = '先给出结论，再写依据。' + width + theme
      const prompt = '帮我整理今天的优先级。'
      try {
        await enrollBrowser(page, host, { name: 'Personal ' + width + theme, scopes: ['view', 'run'] })
        const deviceId = await page.evaluate(async () => (await (await fetch('/link/api/snapshot')).json()).device.id as string)
        expect((await desktop.confirmed('devices/' + deviceId, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
        await page.reload()
        await connected(page)
        await backToPhoneSessions(page)
        await page.getByRole('button', { name: '个人助手', exact: true }).first().click()
        const personal = page.getByRole('dialog', { name: '个人助手', exact: true })
        await personal.getByRole('button', { name: '创建助手', exact: true }).click()
        const editor = page.getByRole('dialog', { name: '创建助手', exact: true })
        await editor.getByRole('textbox', { name: '名字', exact: true }).fill(name)
        await editor.getByRole('textbox', { name: '职责', exact: true }).fill('帮我梳理日常事务和写作思路。')
        expect(await editor.getByRole('checkbox').count()).toBeGreaterThan(0)
        expect(await editor.getByRole('button', { name: /项目/u }).count()).toBe(0)
        await reachable(editor.getByRole('button', { name: '保存助手', exact: true }))
        await editor.getByRole('button', { name: '保存助手', exact: true }).click()
        await personal.getByRole('heading', { name, exact: true }).waitFor()
        await personal.getByRole('tab', { name: '记忆', exact: true }).click()
        await personal.getByRole('button', { name: '添加记忆', exact: true }).click()
        const memory = page.getByRole('dialog', { name: '添加记忆', exact: true })
        await memory.getByRole('textbox', { name: '记忆内容', exact: true }).fill(privateMemory)
        await memory.getByRole('button', { name: '保存记忆', exact: true }).click()
        await memory.waitFor({ state: 'hidden' })
        await personal.getByText(privateMemory, { exact: true }).waitFor()
        await noHorizontalOverflow(page, personal.locator('.personal-content'))
        await page.screenshot({ path: 'test-results/personal/memory-' + width + '-' + theme + '.png', animations: 'disabled' })
        expect(await page.evaluate(text => Object.values(localStorage).some(value => String(value).includes(text)), privateMemory)).toBe(
          false,
        )
        await personal.getByRole('button', { name: '新对话', exact: true }).click()
        const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
        await input.fill(prompt)
        const response = page.waitForResponse(value => value.url().endsWith('/link/api/tasks') && value.request().method() === 'POST')
        await page.getByRole('button', { name: width === 390 ? '开始' : '发送', exact: true }).click()
        const accepted = await response
        expect(accepted.ok()).toBe(true)
        const body = accepted.request().postDataJSON() as Record<string, unknown>
        expect(Object.keys(body).toSorted()).toEqual(['assistantId', 'prompt', 'requestId'])
        const { sessionId } = (await accepted.json()) as { sessionId: string }
        await vi.waitFor(async () => expect((await host.host.bridge.detail(sessionId)).summary.status).toBe('idle'))
        await page.getByRole('textbox', { name: '继续对话', exact: true }).waitFor()
        await page.locator('.transcript').getByText(name, { exact: true }).waitFor()
        await vi.waitFor(async () => expect(await page.locator('.transcript').getByText(prompt, { exact: true }).count()).toBe(1))
        const detail = await page.evaluate(async id => (await (await fetch('/link/api/tasks/' + id)).json()) as TaskDetail, sessionId)
        expect(detail.summary.personal?.assistantId).toBe(body.assistantId)
        expect(detail.messages.find(message => message.role === 'user')?.requestId).toBe(body.requestId)
        expect(detail.messages.some(message => message.text.includes(privateMemory))).toBe(false)
        await page.screenshot({ path: 'test-results/personal/chat-' + width + '-' + theme + '.png', animations: 'disabled' })
        await backToPhoneSessions(page)
        await page.getByRole('button', { name: '个人助手', exact: true }).first().click()
        await personal.getByRole('button').filter({ hasText: name }).click()
        await personal.getByRole('tab', { name: '记忆', exact: true }).click()
        await personal.getByText(privateMemory, { exact: true }).waitFor()
        expect((await desktop.confirmed('devices/' + deviceId, { method: 'PATCH', body: { dataScope: 'work' } })).status).toBe(200)
        await vi.waitFor(async () => expect(await page.getByText(privateMemory, { exact: true }).count()).toBe(0))
        expect(await page.evaluate(async () => (await fetch('/link/api/personal')).status)).toBe(403)
      } finally {
        await context.close()
      }
    },
  )
})
