import { chromium } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { HarnessPlugin } from '@latch/sdk'
import { startTestHost } from './helpers/host.ts'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { closeSettings, openSection, openSession, openSettings, settleShell } from './helpers/layout.ts'

it.each([
  { width: 1440, enabled: true, opens: true },
  // The desktop app's default window: the panel opens as a sheet there.
  { width: 1250, enabled: true, opens: true },
  { width: 1440, enabled: false, opens: false },
  { width: 390, enabled: true, opens: false },
])('settles new documents at $width px with auto open=$enabled without losing the draft', async ({ width, enabled, opens }) => {
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
    const page = await browser.newPage({ viewport: { width, height: 1000 }, locale: 'zh-CN' })
    page.setDefaultTimeout(15_000)
    await enrollBrowser(page, host, { name: 'Auto document', scopes: ['admin'] })
    await openSession(page, sessionId)
    const settings = await openSettings(page)
    // A phone has no such row: it never opens a second pane.
    if (width >= 768) {
      await openSection(settings, '通用')
      const preference = settings.getByRole('switch', { name: '新文档生成后自动打开', exact: true })
      expect(await preference.getAttribute('aria-checked')).toBe('true')
      if (!enabled) await preference.click()
    }
    await closeSettings(settings)
    if (width < 768) await openSession(page, sessionId)
    await settleShell(page)
    expect(await page.locator('.file-preview').count()).toBe(0)
    const input = page.getByRole('textbox', { name: '继续对话', exact: true })
    await input.fill('Generate now')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.getByText('文档生成中', { exact: true }).waitFor()
    await input.fill('仍在输入的草稿')
    expect(await input.evaluate(node => document.activeElement === node)).toBe(true)
    release!()
    if (opens) {
      await page.getByRole('tab', { name: 'created.html', exact: true }).waitFor()
      await page.frameLocator('iframe').getByRole('heading', { name: 'Generated document', exact: true }).waitFor()
    } else {
      await page.getByRole('button', { name: '打开 created.html', exact: true }).waitFor()
      expect(await page.locator('.file-preview').count()).toBe(0)
    }
    expect(await input.inputValue()).toBe('仍在输入的草稿')
    expect(await input.evaluate(node => document.activeElement === node)).toBe(true)
  } finally {
    release?.()
    await host.close()
    await browser.close()
  }
})
