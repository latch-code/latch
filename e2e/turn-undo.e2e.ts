import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { HarnessPlugin } from '@latch/sdk'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

/** A turn's card against a real Host's record: its numbers, its link to the turn, and taking the turn back. */

let host: TestHost,
  browser: Browser,
  sessionId: string,
  runs = 0

async function settledSession(prompt: string): Promise<string> {
  const { sessionId: id } = await host.host.bridge.createTask({
    prompt,
    requestId: randomUUID(),
    mode: 'agent',
    model: { providerId: 'writer', model: 'fixture' },
  })
  await vi.waitFor(async () => expect((await host.host.bridge.detail(id)).summary.status).toBe('idle'), { timeout: 15_000 })
  return id
}

/** A browser whose data scope covers the session's files, as the record of them needs. */
async function openWithFiles(context: BrowserContext): Promise<Page> {
  const page = await context.newPage()
  await enrollBrowser(page, host, { name: '撤销', scopes: ['admin'] })
  const desktop = await host.enroll({ listener: 'unix' })
  const deviceId = await page.evaluate(async () => {
    const response = await fetch('/link/api/snapshot')
    return ((await response.json()) as { device: { id: string } }).device.id
  })
  expect((await desktop.confirmed(`devices/${deviceId}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
  await page.reload()
  await connected(page)
  return page
}

async function withPage(run: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' })
  context.setDefaultTimeout(15_000)
  try {
    await run(await openWithFiles(context))
  } finally {
    await context.close()
  }
}

beforeAll(async () => {
  const plugin: HarnessPlugin = {
    id: 'undo-fixture',
    name: '撤销测试',
    version: '1.0.0',
    description: '本地假模型',
    activate(context) {
      context.registerProvider({
        id: 'writer',
        name: 'Fixture writer',
        model: 'fixture',
        async *stream() {
          runs++
          if (runs === 1) {
            await writeFile(join(host.workspaceRoot, 'made.txt'), 'made by this turn\n')
            await writeFile(join(host.workspaceRoot, 'kept.txt'), 'after\n')
          } else await writeFile(join(host.workspaceRoot, `run-${runs}.txt`), 'one run\n')
          yield { type: 'text', text: '改好了。' }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  host = await startTestHost({ demo: false, plugins: [plugin] })
  await writeFile(join(host.workspaceRoot, 'kept.txt'), 'before\n')
  sessionId = await settledSession('改两个文件')
  browser = await chromium.launch(browserLaunchOptions())
})
afterAll(async () => {
  await browser?.close()
  await host?.close()
})

it('takes a turn back from its card and says what happened, and 恢复 brings it back', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' })
  context.setDefaultTimeout(15_000)
  const page = await context.newPage()
  try {
    await enrollBrowser(page, host, { name: '撤销', scopes: ['admin'] })
    const desktop = await host.enroll({ listener: 'unix' })
    const deviceId = await page.evaluate(async () => {
      const response = await fetch('/link/api/snapshot')
      return ((await response.json()) as { device: { id: string } }).device.id
    })
    // The record of a session's files is for a device whose data scope covers them.
    expect((await desktop.confirmed(`devices/${deviceId}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
    await page.reload()
    await connected(page)
    await page.locator(`[data-task-id="${sessionId}"]`).first().click()
    const card = page.getByRole('region', { name: '这一轮改动的文件', exact: true })
    await card.getByText('改动了 2 个文件', { exact: true }).waitFor()
    await card.getByRole('button', { name: '显示文件', exact: true }).click()
    await card.locator('.summary-file', { hasText: 'made.txt' }).waitFor()

    await card.getByRole('button', { name: '撤销本轮', exact: true }).click()
    const record = page.getByRole('region', { name: '已撤销本轮改动', exact: true })
    await record.getByText(/下一条消息会告诉/).waitFor()
    expect(await card.count()).toBe(0)
    expect(existsSync(join(host.workspaceRoot, 'made.txt'))).toBe(false)
    expect(await readFile(join(host.workspaceRoot, 'kept.txt'), 'utf8')).toBe('before\n')

    await record.getByRole('button', { name: '恢复', exact: true }).click()
    await card.getByText('改动了 2 个文件', { exact: true }).waitFor()
    expect(await readFile(join(host.workspaceRoot, 'made.txt'), 'utf8')).toBe('made by this turn\n')
    expect(await readFile(join(host.workspaceRoot, 'kept.txt'), 'utf8')).toBe('after\n')

    // After a reload the same record reads the same, from the Host.
    await page.reload()
    await card.getByText('改动了 2 个文件', { exact: true }).waitFor()
    await card.getByRole('button', { name: '撤销本轮', exact: true }).click()
    await record.waitFor()
    await page.reload()
    await record.getByRole('button', { name: '恢复', exact: true }).waitFor()
  } finally {
    await context.close()
  }
})

const cardOf = (page: Page) => page.getByRole('region', { name: '这一轮改动的文件', exact: true })
const recordOf = (page: Page) => page.getByRole('region', { name: '已撤销本轮改动', exact: true })

it('offers undo without a reload when a run that just ended settles in view', async () => {
  const id = await settledSession('结束时还没记完')
  await withPage(async page => {
    // Answers as a Host still snapshotting a large folder would, once for each read, then the truth.
    let listed = false
    await page.route(`**/tasks/${id}/changes/turns`, async route => {
      if (listed) return route.continue()
      const response = await route.fetch()
      const answer = (await response.json()) as { turns: { state: string; files?: number }[] }
      const last = answer.turns.at(-1)!
      last.state = 'running'
      delete last.files
      return route.fulfill({ response, json: answer })
    })
    await page.route(`**/tasks/${id}/changes?*`, async route => {
      if (listed) return route.continue()
      listed = true
      const response = await route.fetch()
      const answer = (await response.json()) as Record<string, unknown>
      return route.fulfill({ response, json: { ...answer, running: true, undo: { available: false, reason: 'not-settled' } } })
    })
    await page.locator(`[data-task-id="${id}"]`).first().click()
    await cardOf(page).getByRole('button', { name: '撤销本轮', exact: true }).waitFor()
    expect(await cardOf(page).getByText('这一轮没有正常结束，不能撤销').count()).toBe(0)
  })
})

it('sends the next message once, and stops promising to tell the engine once it has', async () => {
  const id = await settledSession('撤销后再说')
  await withPage(async page => {
    await page.locator(`[data-task-id="${id}"]`).first().click()
    await cardOf(page).getByRole('button', { name: '撤销本轮', exact: true }).click()
    const record = recordOf(page)
    await record.getByText(/下一条消息会告诉/).waitFor()

    const input = page.getByRole('textbox', { name: '继续对话', exact: true })
    await input.fill('再改一次')
    await input.press('Enter')
    await page.getByText('已告诉 Harness 改动被撤销了').waitFor()
    await vi.waitFor(async () => expect((await host.host.bridge.detail(id)).summary.status).toBe('idle'), { timeout: 15_000 })
    await cardOf(page).getByText('改动了 1 个文件', { exact: true }).waitFor()
    expect(await page.locator('.message-user', { hasText: '再改一次' }).count()).toBe(1)
    await vi.waitFor(async () => expect(await record.getByText(/下一条消息会告诉/).count()).toBe(0))
  })
})

it('says when it does not know whether 恢复 landed, and a retry repeats it', async () => {
  const id = await settledSession('恢复没有回音')
  await withPage(async page => {
    await page.locator(`[data-task-id="${id}"]`).first().click()
    await cardOf(page).getByRole('button', { name: '撤销本轮', exact: true }).click()
    const record = recordOf(page)
    await record.getByRole('button', { name: '恢复', exact: true }).waitFor()

    // The Host does the work and the answer never arrives; the record cannot be read either.
    await page.route(`**/tasks/${id}/changes?*`, route => route.abort())
    await page.route(`**/tasks/${id}/turns/*/redo`, async route => {
      await route.fetch()
      await route.fulfill({ status: 503, json: { error: 'unavailable', message: '暂时不可用' } })
    })
    await record.getByRole('button', { name: '恢复', exact: true }).click()
    const retry = record.getByRole('button', { name: '恢复结果未知 · 重试', exact: true })
    await retry.waitFor()

    await page.unroute(`**/tasks/${id}/changes?*`)
    await page.unroute(`**/tasks/${id}/turns/*/redo`)
    await retry.click()
    await cardOf(page).getByRole('button', { name: '撤销本轮', exact: true }).waitFor()
    expect(await page.getByText(/结果未知/).count()).toBe(0)
  })
})

it('takes the outcome from the record when the record shows 恢复 landed', async () => {
  const id = await settledSession('恢复其实成了')
  await withPage(async page => {
    await page.locator(`[data-task-id="${id}"]`).first().click()
    await cardOf(page).getByRole('button', { name: '撤销本轮', exact: true }).click()
    const record = recordOf(page)
    await record.getByRole('button', { name: '恢复', exact: true }).waitFor()
    await page.route(`**/tasks/${id}/turns/*/redo`, async route => {
      await route.fetch()
      await route.fulfill({ status: 503, json: { error: 'unavailable', message: '暂时不可用' } })
    })
    await record.getByRole('button', { name: '恢复', exact: true }).click()
    await cardOf(page).getByRole('button', { name: '撤销本轮', exact: true }).waitFor()
    expect(await page.getByText(/结果未知/).count()).toBe(0)
  })
})

it('says a record is incomplete, wherever the card stands', async () => {
  const id = await settledSession('文件夹太大')
  await withPage(async page => {
    await page.route(`**/tasks/${id}/changes?*`, async route => {
      const response = await route.fetch()
      return route.fulfill({ response, json: { ...((await response.json()) as object), partial: true } })
    })
    await page.locator(`[data-task-id="${id}"]`).first().click()
    await cardOf(page).getByText('记录不完整：文件夹太大').waitFor()
    await cardOf(page).getByRole('button', { name: '撤销本轮', exact: true }).click()
    await recordOf(page).getByText('记录不完整：文件夹太大').waitFor()
  })
})

it('says why a turn cannot go back in the same words on its card and in the 改动 tab', async () => {
  const id = await settledSession('之后又改过')
  const written = `run-${runs}.txt`
  await withPage(async page => {
    // The record's end is taken once the run has settled; a later hand on its file is what the Host will not overwrite.
    await vi.waitFor(
      async () =>
        expect(
          await page.evaluate(async session => {
            const answer = (await (await fetch(`/link/api/tasks/${session}/changes/turns`)).json()) as { turns: { state: string }[] }
            return answer.turns.at(-1)?.state
          }, id),
        ).toBe('settled'),
      { timeout: 15_000 },
    )
    await writeFile(join(host.workspaceRoot, written), 'changed since\n')
    await page.locator(`[data-task-id="${id}"]`).first().click()
    const why = '之后又改过这些文件，不能撤销'
    await cardOf(page).getByText(why, { exact: true }).waitFor()
    expect(await cardOf(page).getByRole('button', { name: '撤销本轮', exact: true }).count()).toBe(0)
    await cardOf(page).getByRole('button', { name: '打开改动', exact: true }).click()
    await page.locator('.changes-panel .changes-why').getByText(why, { exact: true }).waitFor()
  })
})
