import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, type Page } from '@playwright/test'
import { expect, it } from 'vitest'
import type { AppSnapshot, TaskDetail, WorkspaceInfo } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { noHorizontalOverflow, reachable } from './helpers/layout.ts'
import { startTestHost } from './helpers/host.ts'

async function choose(page: Page, title: string) {
  await page.keyboard.press('Meta+k')
  const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
  await palette.getByRole('searchbox').fill(title)
  await palette.getByRole('option', { name: title, exact: true }).click()
  await palette.waitFor({ state: 'hidden' })
}

it.each([
  [390, 'light'],
  [900, 'dark'],
  [1440, 'light'],
] as const)('cycles real pending requests and navigates sessions and files with keys at %i %s', async (width, theme) => {
  let modelCalls = 0
  const plugin: HarnessPlugin = {
    id: 'keyboard-model',
    name: 'Keyboard fixture',
    version: '1',
    description: 'Only local test responses.',
    activate(context) {
      context.registerProvider({
        id: 'keyboard-model',
        name: 'Keyboard fixture',
        model: 'fixture',
        async *stream({ messages }) {
          modelCalls++
          if (messages.findLast(message => message.role === 'user')?.content.startsWith('批准 键盘')) {
            yield { type: 'tool-call', call: { id: randomUUID(), name: 'write_report', arguments: {} } }
            yield { type: 'finish', reason: 'tool-calls' }
          } else {
            yield { type: 'text', text: '键盘导航基准。导航和文件预览不会发送这段草稿。' }
            yield { type: 'finish', reason: 'stop' }
          }
        },
      })
    },
  }
  const host = await startTestHost({ uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'), plugins: [plugin] })
  const browser = await chromium.launch(browserLaunchOptions())
  const active: string[] = []
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const source = join(host.root, 'keyboard-project')
    await mkdir(source)
    await writeFile(join(source, 'keyboard-navigation.txt'), '真实文件键盘预览，不触发模型。\n')
    const added = await owner.addFolders({ name: '键盘验收项目', paths: [source] })
    expect(added.status).toBe(201)
    const project = ((await added.json()) as { workspace: WorkspaceInfo }).workspace
    const create = async (prompt: string) => {
      const created = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: {
          prompt,
          mode: 'agent',
          workspaceId: project.id,
          model: { providerId: 'keyboard-model', model: 'fixture' },
          requestId: randomUUID(),
        },
      })
      active.push(created.sessionId)
      return created.sessionId
    }
    const pending: TaskDetail[] = []
    for (const letter of ['A', 'B']) {
      const id = await create('批准 键盘 ' + letter)
      await expect.poll(async () => (await owner.json<TaskDetail>('tasks/' + id)).approvals.length, { timeout: 10_000 }).toBe(1)
      pending.push(await owner.json<TaskDetail>('tasks/' + id))
    }
    const neutralId = await create('键盘基准会话')
    await expect.poll(async () => (await owner.json<TaskDetail>('tasks/' + neutralId)).summary.status, { timeout: 10_000 }).toBe('idle')
    const neutral = await owner.json<TaskDetail>('tasks/' + neutralId)
    const details = [...pending, neutral]
    const messagesBefore = details.map(detail => detail.messages.map(message => message.id))
    const context = await browser.newContext({
      viewport: { width, height: 960 },
      colorScheme: theme,
      locale: 'zh-CN',
      reducedMotion: 'reduce',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    const submissions: string[] = []
    const fileSearches: string[] = []
    page.on('request', request => {
      const path = new URL(request.url()).pathname
      if (request.method() === 'POST' && /^\/link\/api\/(?:tasks(?:\/[^/]+\/(?:prompt|cancel))?|approvals\/[^/]+)$/u.test(path))
        submissions.push(path)
      if (path.endsWith('/files/search')) fileSearches.push(path)
    })
    try {
      const name = `键盘 ${width} ${theme}`
      await enrollBrowser(page, host, { name, scopes: ['view', 'run', 'approve:standard'] })
      const deviceId = host.host.security.devices.list().find(device => device.name === name)!.id
      expect((await owner.confirmed('devices/' + deviceId, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
      await page.reload()
      await connected(page)
      await choose(page, neutral.summary.title)
      const input = page.getByRole('textbox', { name: '继续对话', exact: true })
      const draft = `仅保留的键盘草稿 ${width} ${theme}`
      await input.fill(draft)
      const callsBefore = modelCalls
      const snapshot = await page.evaluate(async () => (await (await fetch('/link/api/snapshot')).json()) as Promise<AppSnapshot>)
      const ordered = snapshot.tasks.filter(task => active.includes(task.id)).toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      expect(ordered).toHaveLength(3)
      const selected = async (id: string) => {
        const detail = details.find(item => item.summary.id === id)!
        const message = detail.messages.find(item => item.role === 'user')!
        await page.locator(`.transcript [data-message-id="${message.id}"]`).waitFor({ state: 'visible' })
      }
      // The steps follow the rows as drawn: what waits leads the list, so the open session is the last row.
      const waiting = ordered.filter(task => task.status === 'waiting-approval')
      expect(waiting).toHaveLength(2)
      await page.keyboard.press('Alt+1')
      await selected(neutralId)
      await page.keyboard.press('Alt+]')
      await selected(waiting[0]!.id)
      await page.keyboard.press('Alt+[')
      await selected(neutralId)
      await page.keyboard.press('Alt+[')
      await selected(waiting[1]!.id)
      await page.keyboard.press('Alt+]')
      await selected(neutralId)

      const approvals = pending.flatMap(detail => detail.approvals).toSorted((a, b) => a.requestedAt.localeCompare(b.requestedAt))
      for (const approval of [...approvals, approvals[0]!]) {
        await page.keyboard.press('Alt+Shift+a')
        const card = page.locator(`.transcript [data-message-id="tool:${approval.toolCallId}"]`)
        await card.waitFor({ state: 'visible' })
        await expect
          .poll(() => card.evaluate(element => element === document.activeElement && element.hasAttribute('data-approval-target')))
          .toBe(true)
        expect(await page.locator('.transcript [data-approval-target]').count()).toBe(1)
        await reachable(card)
        await noHorizontalOverflow(page, card)
      }
      await mkdir('test-results/workbench-keyboard', { recursive: true })
      await page.screenshot({ path: `test-results/workbench-keyboard/approval-${width}-${theme}.png`, animations: 'disabled' })
      // The input of a session waiting on a request is named for what typing does there.
      expect(await page.locator('.composer textarea').inputValue()).toBe('')
      await choose(page, neutral.summary.title)
      expect(await input.inputValue()).toBe(draft)

      await input.focus()
      fileSearches.length = 0
      await page.keyboard.press('Alt+p')
      const files = page.getByRole('dialog', { name: '搜索文件', exact: true })
      const query = files.getByRole('searchbox', { name: '搜索文件名', exact: true })
      await query.fill('keyboard-navigation.txt')
      const result = files.getByRole('option', { name: 'keyboard-navigation.txt', exact: true })
      await result.waitFor()
      expect(await result.getAttribute('aria-selected')).toBe('true')
      await query.press('Enter')
      await files.waitFor({ state: 'hidden' })
      const preview = page.getByRole('region', { name: '文件预览', exact: true })
      await preview.getByText('真实文件键盘预览，不触发模型。', { exact: true }).waitFor()
      await page.getByRole('tab', { name: 'keyboard-navigation.txt', exact: true }).waitFor()
      expect(fileSearches.length).toBeGreaterThan(0)
      expect(fileSearches.every(path => path === `/link/api/tasks/${neutralId}/files/search`)).toBe(true)
      await noHorizontalOverflow(page, preview)
      await page.screenshot({ path: `test-results/workbench-keyboard/file-${width}-${theme}.png`, animations: 'disabled' })
      await page.keyboard.press('Alt+w')
      await preview.waitFor({ state: 'hidden' })
      expect(await page.getByRole('tab', { name: 'keyboard-navigation.txt', exact: true }).count()).toBe(0)
      expect(await input.inputValue()).toBe(draft)
      await page.keyboard.press('Alt+l')
      await expect.poll(() => input.evaluate(element => element === document.activeElement)).toBe(true)
      expect(await input.inputValue()).toBe(draft)
      expect(submissions).toEqual([])
      expect(modelCalls).toBe(callsBefore)
      for (const [index, detail] of details.entries()) {
        const after = await owner.json<TaskDetail>('tasks/' + detail.summary.id)
        expect(after.messages.map(message => message.id)).toEqual(messagesBefore[index])
        expect(after.approvals.map(approval => approval.id)).toEqual(detail.approvals.map(approval => approval.id))
      }
    } finally {
      await context.close()
    }
  } finally {
    const owner = await host.enroll({ listener: 'unix' })
    for (const id of active)
      await owner.request(`tasks/${id}/cancel`, { method: 'POST', body: { requestId: randomUUID() } }).catch(() => {})
    await browser.close()
    await host.close()
  }
})
