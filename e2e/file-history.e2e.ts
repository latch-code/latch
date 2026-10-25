import { chromium } from '@playwright/test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { HarnessPlugin } from '@latch/sdk'
import { startTestHost } from './helpers/host.ts'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'

it('opens every tool edit of a file in the same column and keeps history available after deletion and reload', async () => {
  const plugin: HarnessPlugin = {
    id: 'history-fixture',
    name: 'Fixture',
    version: '1',
    description: '',
    activate(ctx) {
      ctx.registerProvider({
        id: 'writer',
        name: 'Fixture',
        model: 'fixture',
        async *stream({ messages }) {
          const count = messages.filter(message => message.role === 'tool').length
          if (count < 2) {
            yield {
              type: 'tool-call',
              call: { id: `write-${count}`, name: 'write_file', arguments: { path: 'report.txt', content: `version ${count + 1}\n` } },
            }
            yield { type: 'finish', reason: 'tool-calls' }
          } else {
            yield { type: 'text', text: '已更新 [report.txt](report.txt)。' }
            yield { type: 'finish', reason: 'stop' }
          }
        },
      })
    },
  }
  const host = await startTestHost({ demo: false, plugins: [plugin] })
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    await writeFile(join(host.workspaceRoot, 'report.txt'), 'version 0\n')
    const { sessionId } = await host.host.bridge.createTask({
      prompt: 'File history fixture',
      requestId: randomUUID(),
      mode: 'agent',
      model: { providerId: 'writer', model: 'fixture' },
    })
    for (let count = 0; count < 2; count++) {
      await expect.poll(() => host.host.bridge.approvals().length).toBe(1)
      expect(await host.host.bridge.decide(host.host.bridge.approvals()[0]!.id, 'allow')).toBe(true)
    }
    await expect.poll(async () => (await host.host.bridge.detail(sessionId)).summary.status).toBe('idle')
    const detail = await host.host.bridge.detail(sessionId)
    expect(detail.messages.flatMap(message => message.tool?.diffs ?? [])).toHaveLength(2)
    expect(detail.messages.flatMap(message => message.tool?.diffs ?? [])[0]).toMatchObject({
      oldText: 'version 0\n',
      newText: 'version 1\n',
    })
    for (const [width, theme] of [
      [390, 'light'],
      [900, 'dark'],
      [1440, 'light'],
    ] as const) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, locale: 'zh-CN' })
      const page = await context.newPage()
      page.setDefaultTimeout(15_000)
      try {
        await enrollBrowser(page, host, { name: `History ${width}`, scopes: ['admin'] })
        if (width === 900) await page.getByRole('button', { name: '打开会话列表', exact: true }).click()
        await page.locator(`[data-task-id="${sessionId}"]`).first().click()
        if (width < 1440) await page.getByRole('button', { name: '会话信息', exact: true }).click()
        await page.locator('.info-change').first().click()
        const history = page.getByRole('region', { name: '文件历史变更', exact: true })
        await history.getByText('2 次工具修改', { exact: false }).waitFor()
        const first = history.getByRole('region', { name: '第 1 次修改', exact: true }),
          second = history.getByRole('region', { name: '第 2 次修改', exact: true })
        await first.locator('.diff-remove', { hasText: 'version 0' }).waitFor()
        await first.locator('.diff-add', { hasText: 'version 1' }).waitFor()
        await second.locator('.diff-add', { hasText: 'version 2' }).waitFor()
        await mkdir('test-results/file-history', { recursive: true })
        await page.screenshot({ path: `test-results/file-history/${width}-${theme}.png`, animations: 'disabled' })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await history.getByRole('button', { name: '预览', exact: true }).click()
        const preview = page.getByRole('region', { name: '文件预览', exact: true })
        await preview.getByText('version 2', { exact: true }).waitFor()
        await preview.getByRole('button', { name: '变更', exact: true }).click()
        await history.getByText('2 次工具修改', { exact: false }).waitFor()
        if (width === 1440) {
          await rm(join(host.workspaceRoot, 'report.txt'))
          await page.reload()
          await page.locator('.app-shell[data-connection="connected"]').waitFor()
          await page.locator(`[data-task-id="${sessionId}"]`).first().click()
          await page.getByRole('tab', { name: 'report.txt', exact: true }).click()
          await history.getByText('2 次工具修改', { exact: false }).waitFor()
          await history
            .getByRole('region', { name: '第 1 次修改', exact: true })
            .locator('.diff-remove', { hasText: 'version 0' })
            .waitFor()
        }
      } finally {
        await context.close()
      }
    }
  } finally {
    await host.close()
    await browser.close()
  }
})
