import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium, webkit } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'

describe('slash suggestions in the real composer', () => {
  for (const engine of ['chromium', 'webkit'] as const)
    it(`keeps all commands reachable and input focus on ${engine}`, async () => {
      const host = await startTestHost()
      const browser = await (engine === 'webkit' ? webkit.launch() : chromium.launch(browserLaunchOptions()))
      try {
        const owner = await host.enroll({ listener: 'unix' })
        const commands = Array.from({ length: 200 }, (_, index) => ({
          name: `command-${String(index).padStart(3, '0')}`,
          description: `检查步骤 ${index}`,
          ...(index === 197 ? { input: { hint: '文件或目录' } } : {}),
        }))
        const saved = await owner.confirmed('agents', {
          method: 'POST',
          body: {
            id: 'slash-test',
            name: '菜单 Agent',
            command: process.execPath,
            args: [FAKE_ACP_AGENT],
            env: { FAKE_ACP_COMMANDS: JSON.stringify(commands), FAKE_ACP_CONFIG: 'options' },
          },
        })
        expect(saved.status).toBe(201)
        const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
          method: 'POST',
          body: {
            prompt: 'plan',
            requestId: randomUUID(),
            harnessId: 'slash-test',
            mode: 'agent',
            workspaceId: 'default',
          },
        })
        await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
        await owner.json('prompts/review-template', {
          method: 'PUT',
          body: {
            id: 'review-template',
            name: '代码审查',
            content: '检查 $ARGUMENTS 的正确性',
            scope: { kind: 'all' },
          },
        })
        await mkdir('test-results/slash', { recursive: true })
        for (const width of [1440, 768, 390])
          for (const theme of ['light', 'dark'] as const) {
            const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce' })
            const page = await context.newPage()
            try {
              await enrollBrowser(page, host, { name: `菜单 ${engine} ${width} ${theme}` })
              const drawer = page.getByRole('button', { name: '打开会话列表', exact: true })
              if (await drawer.isVisible()) await drawer.click()
              if (!(await page.locator(`[data-task-id="${sessionId}"]:visible`).count())) {
                await page.getByRole('button', { name: '搜索', exact: true }).click()
                const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
                const title = (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.title
                await palette.getByRole('searchbox').fill(title)
                await palette.getByRole('option', { name: title, exact: true }).first().click()
              } else await page.locator(`[data-task-id="${sessionId}"]:visible`).first().click()
              await page.getByText('planned', { exact: true }).waitFor()
              const input = page.getByRole('textbox', { name: '继续对话', exact: true })
              await input.fill('/')
              const list = page.getByRole('listbox', { name: '命令与提示模板', exact: true })
              await list.waitFor()
              expect(await list.getByRole('option', { selected: true }).count()).toBe(0)
              expect(await list.getByRole('group', { name: '菜单 Agent', exact: true }).getByRole('option').count()).toBe(201)
              const card = await input.locator('xpath=ancestor::form').boundingBox()
              const popup = await page.locator('.ui-suggest:popover-open').boundingBox()
              expect(popup!.y + popup!.height).toBeLessThanOrEqual(card!.y - 5)
              const before = (await owner.json<TaskDetail>(`tasks/${sessionId}`)).messages.length
              await input.press('ArrowDown')
              await input.press('Tab')
              expect(await input.inputValue()).toBe('/command-000 ')
              expect(await input.evaluate(element => element === document.activeElement)).toBe(true)
              expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).messages).toHaveLength(before)
              await input.fill('／command-199')
              await list.getByRole('option').first().click()
              expect(await input.inputValue()).toBe('/command-199 ')
              expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).messages).toHaveLength(before)
              await input.fill('/command-197')
              await input.press('Tab')
              expect(await page.locator('.composer-command-hint').innerText()).toBe('文件或目录')
              await page.screenshot({ path: `test-results/slash/parameter-${engine}-${width}-${theme}.png`, animations: 'disabled' })
              await input.press('Backspace')
              expect(await input.inputValue()).toBe('')
              if (width === 390) {
                await page.getByRole('button', { name: '插入命令', exact: true }).click()
                expect(await input.inputValue()).toBe('/')
              }
              await input.fill('/model Large')
              await input.press('Control+Enter')
              const search = page.getByRole('searchbox', { name: '搜索模型', exact: true })
              await search.waitFor()
              expect(await search.inputValue()).toBe('Large')
              expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).messages).toHaveLength(before)
              await page.keyboard.press('Escape')
              await input.fill('/dmsc')
              await list.getByRole('option').first().waitFor()
              expect(await list.getByRole('option').count()).toBe(1)
              await input.press('Tab')
              expect(await input.inputValue()).toBe('检查 $ARGUMENTS 的正确性')
              expect(
                await input.evaluate(element =>
                  element instanceof HTMLTextAreaElement ? element.value.slice(element.selectionStart, element.selectionEnd) : null,
                ),
              ).toBe('$ARGUMENTS')
              await input.fill('/command-198')
              const sentBefore = (await owner.json<TaskDetail>(`tasks/${sessionId}`)).messages.filter(
                message => message.role === 'user' && message.text === '/command-198',
              ).length
              await input.press('Enter')
              await expect
                .poll(
                  async () =>
                    (await owner.json<TaskDetail>(`tasks/${sessionId}`)).messages.filter(
                      message => message.role === 'user' && message.text === '/command-198',
                    ).length,
                )
                .toBe(sentBefore + 1)
              await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
              await input.fill('/command')
              await list.waitFor()
              expect(await input.evaluate(element => element === document.activeElement)).toBe(true)
              await noHorizontalOverflow(page)
              await page.screenshot({ path: `test-results/slash/${engine}-${width}-${theme}.png`, animations: 'disabled' })
              await input.press('Escape')
              await list.waitFor({ state: 'hidden' })
              expect(await input.inputValue()).toBe('/command')
              if (width === 1440) {
                let starts = 0
                page.on('request', request => {
                  if (request.method() === 'POST' && new URL(request.url()).pathname === '/link/api/tasks') starts++
                })
                await input.fill('/new 新会话首句')
                await input.press('Control+Enter')
                const nextInput = page.getByRole('textbox', { name: '新会话消息', exact: true })
                await expect.poll(() => nextInput.inputValue()).toBe('新会话首句')
                expect(starts).toBe(0)
                await page.locator(`[data-task-id="${sessionId}"]:visible`).first().click()
                await page.getByText('planned', { exact: true }).waitFor()
                expect(await input.inputValue()).toBe('')
                await input.fill('/fork 从这一轮接着检查')
                await expect
                  .poll(() => input.locator('xpath=ancestor::form').getByRole('button', { name: '运行动作', exact: true }).isEnabled())
                  .toBe(true)
                await input.press('Control+Enter')
                await expect.poll(() => nextInput.inputValue()).toBe('从这一轮接着检查')
                expect(starts).toBe(0)
                await page.locator(`[data-task-id="${sessionId}"]:visible`).first().click()
                expect(await input.inputValue()).toBe('')
                if (theme === 'light') {
                  const draft = 'A draft should keep its words and resize with the available width. '.repeat(4)
                  await input.fill(draft)
                  const initial = (await input.boundingBox())!.height
                  await page.setViewportSize({ width: 390, height: 900 })
                  await expect.poll(async () => (await input.boundingBox())!.height).toBeGreaterThan(initial)
                  const narrow = (await input.boundingBox())!.height
                  expect(await input.inputValue()).toBe(draft)
                  await noHorizontalOverflow(page)
                  await page.setViewportSize({ width: 1440, height: 900 })
                  await expect.poll(async () => Math.abs((await input.boundingBox())!.height - initial)).toBeLessThanOrEqual(1)
                  expect(await input.inputValue()).toBe(draft)
                  await writeFile(
                    `test-results/slash/resize-${engine}.json`,
                    JSON.stringify({ initial, narrow, restored: (await input.boundingBox())!.height, draftPreserved: true }) + '\n',
                  )
                }
              }
            } catch (error) {
              await page.screenshot({ path: `test-results/slash/failure-${engine}-${width}-${theme}.png` }).catch(() => {})
              throw error
            } finally {
              await context.close()
            }
          }
      } finally {
        await browser.close()
        await host.close()
      }
    })
})
