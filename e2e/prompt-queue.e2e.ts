import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import type { HarnessPlugin, ModelProvider } from '@latch/sdk'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'

describe('queued follow-ups', () => {
  it('queues and edits during work, drains after success, parks at stop, resumes explicitly and displays dropped authority', async () => {
    const releases = new Map<string, () => void>(),
      calls: string[] = []
    const provider: ModelProvider = {
      id: 'queue-browser-model',
      name: '测试模型',
      model: 'fake',
      async *stream({ messages, signal }) {
        const prompt = messages.at(-1)?.content ?? ''
        calls.push(prompt)
        yield { type: 'text', text: `正在处理：${prompt}` }
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal.reason)
          if (signal.aborted) {
            abort()
            return
          }
          signal.addEventListener('abort', abort, { once: true })
          releases.set(prompt, () => {
            signal.removeEventListener('abort', abort)
            resolve()
          })
        })
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const plugin: HarnessPlugin = {
      id: 'queue-browser-fixture',
      name: '排队测试',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerProvider(provider)
      },
    }
    const host = await startTestHost({ uiDir: resolve('dist/web'), plugins: [plugin], providerId: provider.id }),
      browser = await chromium.launch(browserLaunchOptions())
    try {
      const owner = await host.enroll({ listener: 'unix' })
      for (const width of [1440, 768, 390]) {
        const first = `排队会话 ${width}`,
          edited = `编辑后的下一句 ${width}`,
          second = `再下一句 ${width}`
        const created = await owner.json<{ sessionId: string }>('tasks', {
          method: 'POST',
          body: { prompt: first, requestId: randomUUID() },
        })
        const path = `tasks/${created.sessionId}`
        await expect.poll(() => calls.includes(first)).toBe(true)
        const context = await browser.newContext({
            viewport: { width, height: 960 },
            reducedMotion: width === 768 ? 'no-preference' : 'reduce',
            colorScheme: width === 390 ? 'dark' : 'light',
          }),
          page = await context.newPage()
        await enrollBrowser(page, host, { name: `排队 ${width}` })
        const deviceId = await page.evaluate(
          async () => ((await (await fetch('/link/api/snapshot')).json()) as { device: { id: string } }).device.id,
        )
        await page.keyboard.press('Meta+k')
        const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
        await palette.getByRole('searchbox').fill(first)
        await palette.getByRole('option', { name: first, exact: true }).click()
        const input = page.getByRole('textbox', { name: '继续对话', exact: true }),
          tray = page.getByRole('region', { name: '排队发送', exact: true })
        const enqueue = async (text: string) => {
          await input.fill(text)
          const reply = page.waitForResponse(
            response =>
              response.request().method() === 'POST'
              && response.url().endsWith(`${path}/prompt`)
              && response.request().postDataJSON()?.prompt === text,
          )
          await page.getByRole('button', { name: '排队发送', exact: true }).click()
          expect((await reply).status()).toBe(202)
        }
        await enqueue(`下一句 ${width}`)
        await tray.getByText(`下一句 ${width}`, { exact: true }).waitFor()
        await enqueue(second)
        await expect.poll(() => tray.locator('.prompt-queue-title').textContent()).toContain('本轮完成后依次发送')
        await expect.poll(async () => (await owner.json<TaskDetail>(path)).queue?.length).toBe(2)
        await input.fill(`仍在输入的草稿 ${width}`)
        await tray.getByRole('button', { name: '编辑', exact: true }).first().click()
        const dialog = page.getByRole('dialog', { name: '编辑排队内容', exact: true })
        await dialog.getByRole('textbox', { name: '排队消息', exact: true }).fill(edited)
        await dialog.getByRole('button', { name: '保存', exact: true }).click()
        await dialog.waitFor({ state: 'detached' })
        await tray.getByText(edited, { exact: true }).waitFor()
        expect(await input.inputValue()).toBe(`仍在输入的草稿 ${width}`)
        expect((await owner.json<TaskDetail>(path)).queue).toHaveLength(2)
        await input.fill('')
        await page.screenshot({ path: `test-results/queue-waiting-${width}.png`, fullPage: true })
        await page.emulateMedia({ colorScheme: width === 390 ? 'light' : 'dark' })
        await page.screenshot({ path: `test-results/queue-waiting-${width}-alternate.png`, fullPage: true })
        await page.emulateMedia({ colorScheme: width === 390 ? 'dark' : 'light' })
        releases.get(first)!()
        await expect.poll(() => calls.includes(edited)).toBe(true)
        await expect.poll(async () => (await owner.json<TaskDetail>(path)).queue?.map(item => item.text)).toEqual([second])
        await page.getByRole('button', { name: '停止', exact: true }).click()
        await tray.getByText('已暂停 · 请确认后发送', { exact: true }).waitFor()
        await page.screenshot({ path: `test-results/queue-parked-${width}.png`, fullPage: true })
        await tray.getByRole('button', { name: '发送', exact: true }).click()
        await expect.poll(() => calls.includes(second)).toBe(true)
        await enqueue(`暂时不用 ${width}`)
        await tray.getByRole('button', { name: '移除', exact: true }).click()
        await expect.poll(async () => (await owner.json<TaskDetail>(path)).queue).toEqual([])
        await enqueue(`权限改变后不发送 ${width}`)
        await tray.getByText(`权限改变后不发送 ${width}`, { exact: true }).waitFor()
        await owner.json(`devices/${deviceId}`, { method: 'PATCH', body: { scopes: ['view'] } })
        releases.get(second)!()
        await tray.getByText('未发送 · 请检查排队内容', { exact: true }).waitFor()
        await page.screenshot({ path: `test-results/queue-dropped-${width}.png`, fullPage: true })
        expect(calls).not.toContain(`权限改变后不发送 ${width}`)
        const final = await owner.json<TaskDetail>(path)
        expect(final.messages.find(message => message.text === edited)?.queuedAt).toEqual(expect.any(String))
        await owner.json(`${path}/queue/${final.queue![0]!.id}`, { method: 'DELETE' })
        await context.close()
      }
    } finally {
      await browser.close()
      await host.close()
    }
  })
})
