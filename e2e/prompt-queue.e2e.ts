import { randomUUID } from 'node:crypto'
import { chromium } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import type { HarnessPlugin, ModelProvider } from '@latch/sdk'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { openSession } from './helpers/layout.ts'
import { promptValue } from './helpers/prompt.ts'

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
    const host = await startTestHost({ plugins: [plugin], providerId: provider.id }),
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
            hasTouch: width === 390,
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
        await expect.poll(() => tray.locator('.prompt-queue-title').textContent()).toBe('接下来 · 2')
        await expect.poll(async () => (await owner.json<TaskDetail>(path)).queue?.length).toBe(2)
        await input.fill(`仍在输入的草稿 ${width}`)
        await tray.getByRole('button', { name: '编辑', exact: true }).first().click()
        const dialog = page.getByRole('dialog', { name: '编辑排队内容', exact: true })
        await dialog.getByRole('textbox', { name: '排队消息', exact: true }).fill(edited)
        await dialog.getByRole('button', { name: '保存', exact: true }).click()
        await dialog.waitFor({ state: 'detached' })
        await tray.getByText(edited, { exact: true }).waitFor()
        const rows = tray.getByRole('listitem')
        const grip = rows.nth(1).getByRole('button', { name: '调整顺序', exact: true })
        if (width === 1440) {
          await grip.dragTo(rows.first())
        } else {
          if (width === 768) await grip.press('Enter')
          else await grip.tap()
          const up = page.getByRole('menuitem', { name: '上移', exact: true })
          if (width === 768) await up.press('Enter')
          else await up.tap()
        }
        await expect.poll(() => rows.locator('.prompt-queue-text').allTextContents()).toEqual([second, edited])
        expect(await promptValue(input)).toBe(`仍在输入的草稿 ${width}`)
        expect((await owner.json<TaskDetail>(path)).queue?.map(item => item.text)).toEqual([second, edited])
        expect(await tray.getByRole('button', { name: '追加到本轮' }).count()).toBe(0)
        await input.fill('')
        await page.screenshot({ path: `test-results/queue-waiting-${width}.png`, fullPage: true })
        await page.emulateMedia({ colorScheme: width === 390 ? 'light' : 'dark' })
        await page.screenshot({ path: `test-results/queue-waiting-${width}-alternate.png`, fullPage: true })
        await page.emulateMedia({ colorScheme: width === 390 ? 'dark' : 'light' })
        releases.get(first)!()
        await expect.poll(() => calls.includes(second)).toBe(true)
        await expect.poll(async () => (await owner.json<TaskDetail>(path)).queue?.map(item => item.text)).toEqual([edited])
        await page.getByRole('button', { name: '停止', exact: true }).click()
        await tray.getByText('已暂停 · 请确认后发送', { exact: true }).waitFor()
        await page.screenshot({ path: `test-results/queue-parked-${width}.png`, fullPage: true })
        await tray.getByRole('button', { name: '发送', exact: true }).click()
        await expect.poll(() => calls.includes(edited)).toBe(true)
        await enqueue(`暂时不用 ${width}`)
        await tray.getByRole('button', { name: '移除', exact: true }).click()
        await expect.poll(async () => (await owner.json<TaskDetail>(path)).queue).toEqual([])
        await enqueue(`权限改变后不发送 ${width}`)
        await tray.getByText(`权限改变后不发送 ${width}`, { exact: true }).waitFor()
        await owner.json(`devices/${deviceId}`, { method: 'PATCH', body: { scopes: ['view'] } })
        releases.get(edited)!()
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
  it('keeps a screenshot with its queued instructions across a reload and delivers it once', async () => {
    const first = '先等待界面草稿'
    const follow = '下一轮按图检查按钮'
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=', 'base64')
    let release = () => {}
    const finish = new Promise<void>(resolve => {
      release = resolve
    })
    const seen: Array<{ text: string; images: string[] }> = []
    const host = await startTestHost({
      providerId: 'queue-vision',
      plugins: [
        {
          id: 'queued-image-fixture',
          name: '排队图片测试',
          version: '1',
          description: '',
          activate(ctx) {
            ctx.registerProvider({
              id: 'queue-vision',
              name: 'Vision fixture',
              model: 'fixture',
              modelCapabilities: { fixture: { vision: true } },
              async *stream({ messages }) {
                const last = messages.at(-1)!
                seen.push({ text: last.content, images: (last.attachments ?? []).flatMap(a => (a.type === 'image' ? [a.data] : [])) })
                if (last.content === first) {
                  await finish
                }
                yield { type: 'text', text: '已核对' }
                yield { type: 'finish', reason: 'stop' }
              },
            })
          },
        },
      ],
    })
    const browser = await chromium.launch(browserLaunchOptions())
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, colorScheme: 'dark' })
      await enrollBrowser(page, host, { name: '排队截图' })
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { prompt: first, requestId: randomUUID() },
      })
      await expect.poll(() => seen.length).toBe(1)
      await openSession(page, sessionId)
      const composer = page.locator('form.composer:visible')
      await composer.getByLabel('选择附件', { exact: true }).setInputFiles({ name: 'button.png', mimeType: 'image/png', buffer: image })
      await expect.poll(() => composer.locator('.attachment-draft[data-state="ready"]').count()).toBe(1)
      await composer.getByRole('textbox', { name: '继续对话' }).fill(follow)
      await composer.getByRole('button', { name: '排队发送', exact: true }).click()
      const queue = page.getByRole('region', { name: '排队发送', exact: true })
      await queue.getByText('1 个附件').waitFor()
      await page.reload()
      await queue.getByText('1 个附件').waitFor()
      await page.screenshot({ path: 'test-results/queued-screenshot-390.png', animations: 'disabled' })
      expect(seen).toHaveLength(1)
      release()
      await expect.poll(() => seen.filter(turn => turn.text === follow)).toEqual([{ text: follow, images: [image.toString('base64')] }])
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).queue ?? []).toEqual([])
    } finally {
      release()
      await browser.close()
      await host.close()
    }
  })

  it('adds a selected queued message to the same live turn without consuming the earlier item or the draft', async () => {
    const host = await startTestHost()
    const browser = await chromium.launch(browserLaunchOptions())
    try {
      const owner = await host.enroll({ listener: 'unix' })
      await owner.confirmedJson('agents', {
        method: 'POST',
        body: {
          id: 'steer-agent',
          name: 'Steer fixture',
          command: process.execPath,
          args: [FAKE_ACP_AGENT],
          env: { FAKE_ACP_CAPS: 'steer' },
        },
      })
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        colorScheme: 'dark',
        reducedMotion: 'reduce',
      })
      await enrollBrowser(page, host, { name: '队列追加' })
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { harnessId: 'steer-agent', prompt: 'steerable hold', requestId: randomUUID() },
      })
      const path = `tasks/${sessionId}`
      const detail = () => owner.json<TaskDetail>(path)
      await expect.poll(async () => (await detail()).steer).toBe(true)
      const runId = (await detail()).summary.runId
      const earlier = '下一轮再看',
        now = '先看这个问题'
      await openSession(page, sessionId)
      const input = page.getByRole('textbox', { name: '继续对话', exact: true })
      const tray = page.getByRole('region', { name: '排队发送', exact: true })
      for (const text of [earlier, now]) {
        await input.fill(text)
        await page.locator('form.composer:visible').getByRole('button', { name: '更多', exact: true }).tap()
        await page.getByRole('menuitem', { name: '排到下一轮', exact: true }).tap()
        await tray.getByText(text, { exact: true }).waitFor()
      }
      const row = tray.getByRole('listitem').filter({ hasText: now })
      await input.fill('还在写的草稿')
      await row.getByRole('button', { name: '追加到本轮' }).waitFor()
      await page.screenshot({ path: 'test-results/queue-steer-390.png' })
      const [steered] = await Promise.all([
        page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/steer')),
        row.getByRole('button', { name: '追加到本轮' }).tap(),
      ])
      expect(steered.status()).toBe(200)
      expect(steered.request().postDataJSON()).toEqual({ runId, contentRevision: 0 })
      await expect
        .poll(async () => (await detail()).messages.filter(message => message.steered).map(message => message.text))
        .toEqual([now])
      const after = await detail()
      expect(after.summary).toMatchObject({ status: 'running', runId })
      expect(after.queue?.map(item => item.text)).toEqual([earlier])
      expect(await promptValue(input)).toBe('还在写的草稿')
      await input.fill('')
      await page.getByRole('button', { name: '停止', exact: true }).click()
    } finally {
      await browser.close()
      await host.close()
    }
  })
})
