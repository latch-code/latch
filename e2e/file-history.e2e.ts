import { chromium } from '@playwright/test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { Device } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { startTestHost } from './helpers/host.ts'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { openSession, settleShell } from './helpers/layout.ts'

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
          if (count < 3) {
            yield {
              type: 'tool-call',
              call: {
                id: `write-${count}`,
                name: 'write_file',
                arguments:
                  count === 1
                    ? {
                        path: 'connection.ts',
                        content:
                          'export async function connectDevice() {\n  const connection = await connectAutomatically();\n  return connection;\n}\n',
                      }
                    : { path: 'report.txt', content: `version ${count === 0 ? 1 : 2}\n` },
              },
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
    await writeFile(
      join(host.workspaceRoot, 'connection.ts'),
      'export async function connectDevice() {\n  const route = await chooseRoute();\n  return connect(route);\n}\n',
    )
    const { sessionId } = await host.host.bridge.createTask({
      prompt: 'File history fixture',
      requestId: randomUUID(),
      mode: 'agent',
      model: { providerId: 'writer', model: 'fixture' },
    })
    for (let count = 0; count < 3; count++) {
      await expect.poll(() => host.host.bridge.approvals().length).toBe(1)
      expect(await host.host.bridge.decide(host.host.bridge.approvals()[0]!.id, 'allow')).toBe(true)
    }
    await expect.poll(async () => (await host.host.bridge.detail(sessionId)).summary.status).toBe('idle')
    const detail = await host.host.bridge.detail(sessionId)
    expect(detail.messages.flatMap(message => message.tool?.diffs ?? [])).toHaveLength(3)
    expect(detail.messages.flatMap(message => message.tool?.diffs ?? [])[0]).toMatchObject({
      oldText: 'version 0\n',
      newText: 'version 1\n',
    })
    const owner = await host.enroll({ listener: 'unix' })
    await mkdir('test-results/file-history', { recursive: true })
    for (const [width, theme] of [
      [390, 'light'],
      [900, 'dark'],
      [1440, 'light'],
      [1440, 'dark'],
    ] as const) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, locale: 'zh-CN' })
      const page = await context.newPage()
      page.setDefaultTimeout(15_000)
      try {
        const name = `History ${width} ${theme}`
        await enrollBrowser(page, host, { name, scopes: ['admin'] })
        await openSession(page, sessionId)
        // On the default work scope the Host sends the edits' paths without their bodies: the turn's file opens as the
        // file this session wrote, and there is no recorded edit to show.
        const limited = await page.evaluate(async id => JSON.stringify(await (await fetch(`/link/api/tasks/${id}`)).json()), sessionId)
        expect(limited).toContain('report.txt')
        expect(limited).not.toContain('version 1')
        expect(limited).not.toContain('"diffs"')
        const toggle = page.getByRole('button', { name: '显示文件', exact: true })
        if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
        await page
          .getByRole('region', { name: '这一轮改动的文件', exact: true })
          .locator('button.summary-file', { hasText: 'report.txt' })
          .click()
        const preview = page.getByRole('region', { name: '文件预览', exact: true })
        const history = page.getByRole('region', { name: '文件历史改动', exact: true })
        await preview.getByText('version 2', { exact: true }).waitFor()
        expect(await history.count()).toBe(0)
        expect(await page.locator('.diff-line').count()).toBe(0)
        expect(await page.locator('body').innerText()).not.toContain('version 1')
        // The owner lets this browser read project files, as the device's switch does. The turn's files then open in the
        // changes tab, and a file's own recorded edits from its tab.
        const device = (await owner.json<{ devices: Device[] }>('devices')).devices.find(item => item.name === name)
        expect(device?.dataScope).toBe('work')
        expect((await owner.confirmed(`devices/${device!.id}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
        await page.reload()
        await connected(page)
        await openSession(page, sessionId)
        await page.locator('.turn-reply').getByRole('button', { name: '预览文件：report.txt', exact: true }).click()
        await preview.getByText('version 2', { exact: true }).waitFor()
        await preview.getByRole('button', { name: '文件操作', exact: true }).click()
        await page.getByRole('menuitem', { name: '查看改动', exact: true }).click()
        await history.getByText('2 次工具修改', { exact: false }).waitFor()
        const first = history.getByRole('region', { name: '第 1 次修改', exact: true }),
          second = history.getByRole('region', { name: '第 2 次修改', exact: true })
        await first.locator('.diff-file-header').click()
        await first.locator('.diff-remove', { hasText: 'version 0' }).waitFor()
        await first.locator('.diff-add', { hasText: 'version 1' }).waitFor()
        await second.locator('.diff-add', { hasText: 'version 2' }).waitFor()
        expect(await history.locator('.file-history-entry').first().getAttribute('aria-label')).toBe('第 2 次修改')
        const gaps = await history.locator('.diff-table').evaluateAll(tables =>
          tables.map(table => {
            const last = table.querySelector('.diff-hunk:last-child .diff-line:last-child')
            return last ? Math.abs(table.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom) : 0
          }),
        )
        expect(gaps.every(gap => gap < 1)).toBe(true)
        if (width >= 1024) {
          await history.getByRole('button', { name: '左右对照', exact: true }).click()
          await settleShell(page)
          expect((await history.boundingBox())!.width).toBeGreaterThan(900)
          await history.getByRole('region', { name: '修改前代码', exact: true }).getByText('version 1', { exact: true }).waitFor()
          await history.getByRole('region', { name: '修改后代码', exact: true }).getByText('version 2', { exact: true }).waitFor()
          await history.getByRole('navigation', { name: '改动的文件' }).getByRole('button', { name: 'connection.ts', exact: false }).click()
          await history
            .getByRole('region', { name: '修改后代码', exact: true })
            .getByText('connectAutomatically', { exact: false })
            .waitFor()
          await page.screenshot({ path: `test-results/file-history/code-split-${width}-${theme}.png`, animations: 'disabled' })
          await history.getByRole('navigation', { name: '改动的文件' }).getByRole('button', { name: 'report.txt', exact: false }).click()
        } else expect(await history.getByRole('button', { name: '左右对照', exact: true }).count()).toBe(0)
        await page.screenshot({ path: `test-results/file-history/${width}-${theme}.png`, animations: 'disabled' })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await history.getByRole('button', { name: '预览', exact: true }).click()
        await preview.getByText('version 2', { exact: true }).waitFor()
        await preview.getByRole('button', { name: '文件操作', exact: true }).click()
        await page.getByRole('menuitem', { name: '查看改动', exact: true }).click()
        await history.getByText('2 次工具修改', { exact: false }).waitFor()
        if (width === 1440 && theme === 'dark') {
          await rm(join(host.workspaceRoot, 'report.txt'))
          await page.reload()
          await page.locator('.app-shell[data-connection="connected"]').waitFor()
          await openSession(page, sessionId)
          const panel = page.getByRole('button', { name: '侧边面板', exact: true })
          if ((await panel.getAttribute('aria-pressed')) !== 'true') await panel.click()
          await page.getByRole('tab', { name: 'report.txt', exact: true }).click()
          await history.getByText('2 次工具修改', { exact: false }).waitFor()
          await history.getByRole('region', { name: '第 1 次修改', exact: true }).locator('.diff-file-header').click()
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
