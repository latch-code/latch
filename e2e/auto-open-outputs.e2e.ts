import { chromium } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { HarnessPlugin } from '@latch/sdk'
import { startTestHost } from './helpers/host.ts'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { closeSettings, openSection, openSettings } from './helpers/layout.ts'

it('opens a settled new document only after enabling the preference and preserves the actual composer focus and draft', async () => {
  let release: (() => void) | undefined
  const plugin: HarnessPlugin = {
    id: 'auto-document-fixture',
    name: 'Fixture',
    version: '1',
    description: '',
    activate(ctx) {
      ctx.registerProvider({
        id: 'writer',
        name: 'Fixture',
        model: 'fixture',
        async *stream({ messages, signal }) {
          if (messages.filter(message => message.role === 'user').length < 2) {
            yield { type: 'text', text: '[seed.html](seed.html)' }
          } else {
            yield { type: 'text', text: '文档生成中' }
            await new Promise<void>(done => {
              const finish = () => {
                signal.removeEventListener('abort', finish)
                done()
              }
              release = finish
              signal.addEventListener('abort', finish, { once: true })
              if (signal.aborted) finish()
            })
            await writeFile(join(host.workspaceRoot, 'created.html'), '<h1>Generated document</h1>')
            yield { type: 'text', text: '，已完成。' }
          }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  const host = await startTestHost({ demo: false, plugins: [plugin] })
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    await writeFile(join(host.workspaceRoot, 'seed.html'), '<h1>Existing document</h1>')
    const { sessionId } = await host.host.bridge.createTask({
      prompt: 'Auto open fixture',
      requestId: randomUUID(),
      mode: 'agent',
      model: { providerId: 'writer', model: 'fixture' },
    })
    await expect.poll(async () => (await host.host.bridge.detail(sessionId)).summary.status).toBe('idle')
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
    page.setDefaultTimeout(15_000)
    await enrollBrowser(page, host, { name: 'Auto document', scopes: ['admin'] })
    await page.locator(`[data-task-id="${sessionId}"]`).first().click()
    const settings = await openSettings(page)
    await openSection(settings, '通用')
    const preference = settings.getByRole('switch', { name: '运行结束后自动打开新生成的文档', exact: true })
    expect(await preference.getAttribute('aria-checked')).toBe('false')
    await preference.click()
    await closeSettings(settings)
    await page.getByRole('button', { name: '预览文件：seed.html', exact: true }).click()
    await page.frameLocator('iframe').getByRole('heading', { name: 'Existing document', exact: true }).waitFor()
    const input = page.getByRole('textbox', { name: '继续对话', exact: true })
    await input.fill('Generate now')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.getByText('文档生成中', { exact: true }).waitFor()
    await input.fill('仍在输入的草稿')
    expect(await input.evaluate(node => document.activeElement === node)).toBe(true)
    release!()
    await page.getByRole('tab', { name: 'created.html', exact: true }).waitFor()
    await page.frameLocator('iframe').getByRole('heading', { name: 'Generated document', exact: true }).waitFor()
    expect(await input.inputValue()).toBe('仍在输入的草稿')
    expect(await input.evaluate(node => document.activeElement === node)).toBe(true)
  } finally {
    release?.()
    await host.close()
    await browser.close()
  }
})
