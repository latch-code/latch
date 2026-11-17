import { chromium, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { AppSnapshot, TaskDetail } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { startTestHost } from './helpers/host.ts'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { openSession, settleShell } from './helpers/layout.ts'

const before = 'EXPORT_OLD_FILE_BODY_7941\n',
  after = 'EXPORT_NEW_FILE_BODY_1836\n'
const writer: HarnessPlugin = {
  id: 'export-writer',
  name: 'Export writer',
  version: '1',
  description: 'Fixture-only file write.',
  activate(context) {
    context.registerProvider({
      id: 'export-writer',
      name: 'Export writer',
      model: 'fixture',
      async *stream({ messages }) {
        if (messages.at(-1)?.role === 'tool') {
          yield { type: 'text', text: 'The fixture file operation has settled.' }
          yield { type: 'finish', reason: 'stop' }
        } else {
          yield { type: 'tool-call', call: { id: randomUUID(), name: 'write_file', arguments: { path: 'notes.txt', content: after } } }
          yield { type: 'finish', reason: 'tool-calls' }
        }
      },
    })
  },
}

async function downloaded(page: Page): Promise<string> {
  await page.locator('.topbar').getByRole('button', { name: '会话操作', exact: true }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: '导出 Markdown', exact: true }).click()
  const result = await download
  expect(await result.failure()).toBeNull()
  const path = await result.path()
  expect(path).not.toBeNull()
  return readFile(path!, 'utf8')
}

it('exports only authorized file presentation through the normal session menu, including after scope narrows', async () => {
  const host = await startTestHost({ demo: false, providerId: writer.id, plugins: [writer] })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await writeFile(join(host.workspaceRoot, 'notes.txt'), before)
    const owner = await host.enroll({ listener: 'unix', scopes: ['view', 'run', 'approve:standard', 'admin'] })
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: 'Write the fixture note.', requestId: randomUUID(), mode: 'agent' },
    })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).approvals.length).toBe(1)
    browser = await chromium.launch(browserLaunchOptions())
    const limitedContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    const work = await limitedContext.newPage()
    await enrollBrowser(work, host, { name: 'Restricted export' })
    // A connected browser starts able to read project files (200b8c6d): narrowed to work for the limited device.
    const workId = await work.evaluate(async () => ((await (await fetch('/link/api/snapshot')).json()) as AppSnapshot).device.id)
    await owner.json(`devices/${workId}`, { method: 'PATCH', body: { dataScope: 'work' } })
    await work.reload()
    await connected(work)
    await openSession(work, sessionId)
    expect(await work.locator('body').innerText()).not.toContain(before.trim())
    expect(await work.locator('body').innerText()).not.toContain(after.trim())
    const card = work.locator('[data-approval-id]').filter({ visible: true })
    await card.getByRole('button', { name: '允许', exact: true }).click()
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
    await expect.poll(() => work.locator('[data-approval-id]').filter({ visible: true }).count()).toBe(0)
    const limitedExport = await downloaded(work)
    expect(limitedExport).not.toContain(before.trim())
    expect(limitedExport).not.toContain(after.trim())
    expect(limitedExport).toContain('notes.txt')
    expect(limitedExport).toContain('已写入')
    expect(limitedExport).toContain('已允许')

    const fullContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    const full = await fullContext.newPage()
    await enrollBrowser(full, host, { name: 'Full export' })
    const deviceId = await full.evaluate(async () => ((await (await fetch('/link/api/snapshot')).json()) as AppSnapshot).device.id)
    await owner.confirmedJson(`devices/${deviceId}`, { method: 'PATCH', body: { dataScope: 'all' } })
    await full.reload()
    await connected(full)
    await openSession(full, sessionId)
    const fullExport = await downloaded(full)
    expect(fullExport).toContain(before.trim())
    expect(fullExport).toContain(after.trim())
    expect(fullExport).toContain('```diff')

    const projectedDetail = full.waitForResponse(
      async response =>
        response.url().endsWith(`/link/api/tasks/${sessionId}`)
        && response.status() === 200
        && !JSON.stringify(await response.json()).includes(after.trim()),
    )
    await owner.json(`devices/${deviceId}`, { method: 'PATCH', body: { dataScope: 'work' } })
    await projectedDetail
    await settleShell(full)
    await expect
      .poll(async () => full.evaluate(async () => ((await (await fetch('/link/api/snapshot')).json()) as AppSnapshot).device.dataScope))
      .toBe('work')
    await expect.poll(async () => full.locator('main.workspace').innerText()).not.toContain(after.trim())
    const narrowed = await downloaded(full)
    expect(narrowed).not.toContain(before.trim())
    expect(narrowed).not.toContain(after.trim())
    expect(narrowed).toContain('已写入')
    const output = 'test-results/restricted-diff'
    await mkdir(output, { recursive: true })
    await Promise.all([
      writeFile(join(output, 'work.md'), limitedExport),
      writeFile(join(output, 'all.md'), fullExport),
      writeFile(join(output, 'narrowed.md'), narrowed),
    ])
  } finally {
    await browser?.close()
    await host.close()
  }
})
