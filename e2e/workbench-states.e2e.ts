import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, type Page, type Request } from '@playwright/test'
import { expect, it } from 'vitest'
import type { Device, TaskDetail, WorkspaceInfo } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow, settleShell } from './helpers/layout.ts'
import { switchView } from './helpers/workbench.ts'

const OUT = 'test-results/workbench-states'
const requestCount = 10

async function shot(page: Page, name: string, width: number, theme: 'light' | 'dark') {
  await page.setViewportSize({ width, height: width < 768 ? 844 : 1000 })
  await page.emulateMedia({ colorScheme: theme })
  await page.evaluate(() => document.fonts.ready)
  await settleShell(page)
  await expect.poll(() => page.locator('.approval-panel[data-arming]').count()).toBe(0)
  await noHorizontalOverflow(page)
  await page.screenshot({ path: `${OUT}/${name}--${theme}--${width}.png`, animations: 'disabled', caret: 'hide' })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.emulateMedia({ colorScheme: 'light' })
}

it('draws the board empty, crowded, limited, read-only and offline from the real Host permissions, and retries a decision on its card', async () => {
  const plugin: HarnessPlugin = {
    id: 'workbench-states',
    name: '界面状态验收',
    version: '1',
    description: 'Local scripted provider only.',
    activate(context) {
      context.registerProvider({
        id: 'state-model',
        name: '本地验收模型',
        model: 'fixture',
        async *stream({ messages }) {
          const prompt = messages.findLast(message => message.role === 'user')?.content ?? ''
          const ordinal = /配置 (\d+)$/u.exec(prompt)?.[1] ?? '1'
          if (messages.at(-1)?.role !== 'tool') {
            yield { type: 'text', text: '准备保存配置，需要你确认写入。' }
            yield {
              type: 'tool-call',
              call: {
                id: randomUUID(),
                name: 'write_file',
                arguments: { path: `settings-${ordinal}.ts`, content: 'export const keep = true\n' },
              },
            }
            yield { type: 'finish', reason: 'tool-calls' }
            return
          }
          yield { type: 'text', text: '配置已经保存。' }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  const host = await startTestHost({
    uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
    demo: false,
    plugins: [plugin],
    providerId: 'state-model',
    hostName: '验收电脑',
  })
  const browser = await chromium.launch(browserLaunchOptions())
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' })
  const page = await context.newPage()
  const ids: string[] = []
  page.setDefaultTimeout(15_000)
  try {
    await mkdir(OUT, { recursive: true })
    const owner = await host.enroll({ listener: 'unix' })
    const folder = join(host.root, 'state-project')
    await mkdir(folder)
    for (let i = 1; i <= requestCount; i++) await writeFile(join(folder, `settings-${i}.ts`), 'export const keep = false\n')
    const added = await owner.addFolders({ name: '设置项目', paths: [folder] })
    const { workspace } = (await added.json()) as { workspace: WorkspaceInfo }
    await enrollBrowser(page, host, { name: '状态验收设备', scopes: ['admin'] })
    const { devices } = await owner.json<{ devices: Device[] }>('devices')
    const device = devices.find(item => item.name === '状态验收设备')!
    const FULL = ['view', 'run', 'approve:standard', 'approve:elevated', 'admin']
    await owner.confirmedJson(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
    await page.reload()
    await connected(page)
    await switchView(page, 'board')
    const board = page.locator('.work-board')
    const attention = board.getByRole('region', { name: '等你处理', exact: true })
    const card = (id: string) => board.locator(`.work-board-card[data-work-session="${id}"]`)

    // Empty: four heads and a quiet line each, no sentence.
    for (const name of ['等你处理', '进行中', '可交付', '已结束'])
      await board.getByRole('region', { name, exact: true }).locator('.work-board-empty-line').waitFor()
    expect(await board.locator('.work-board-card').count()).toBe(0)
    for (const theme of ['light', 'dark'] as const) await shot(page, 'board-empty', 1440, theme)

    // Crowded: ten requests. The newest is decided on its card, the rest are cards that read nothing of their session.
    const reads: string[] = []
    const recordRead = (request: Request) => {
      const detail = /^\/link\/api\/tasks\/([^/]+)$/u.exec(new URL(request.url()).pathname)
      if (request.method() === 'GET' && detail) reads.push(detail[1]!)
    }
    for (let i = 1; i <= requestCount; i++) {
      const task = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          prompt: `保存配置 ${i}`,
          workspaceId: workspace.id,
          model: { providerId: 'state-model', model: 'fixture' },
        },
      })
      ids.push(task.sessionId)
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${task.sessionId}`)).approvals.length).toBe(1)
    }
    const newest = ids.at(-1)!
    // Read afresh: only the card that decides reads its session.
    page.on('request', recordRead)
    await page.reload()
    await connected(page)
    const decision = card(newest)
    await expect.poll(() => attention.locator('.work-board-card').count()).toBe(requestCount)
    expect(await attention.locator('.work-board-column-head').textContent()).toContain(String(requestCount))
    await decision.locator('.approval-panel').waitFor()
    expect(await decision.textContent()).toContain('settings-10.ts')
    expect(await attention.locator('.approval-panel').count()).toBe(1)
    expect(await card(ids[0]!).getByText('审批', { exact: true }).count()).toBe(1)
    page.off('request', recordRead)
    expect(reads.filter(id => id !== newest)).toEqual([])
    // The crowded cell scrolls its own cards under a fixed head; the board around it does not move.
    const cards = attention.locator('.work-board-cards')
    expect(await cards.evaluate(list => list.scrollHeight > list.clientHeight)).toBe(true)
    const head = await attention.locator('.work-board-column-head').boundingBox()
    await cards.evaluate(list => list.scrollTo({ top: list.scrollHeight }))
    expect(await attention.locator('.work-board-column-head').boundingBox()).toEqual(head)
    await cards.evaluate(list => list.scrollTo({ top: 0 }))
    for (const theme of ['light', 'dark'] as const) {
      await shot(page, 'board-crowded', 1440, theme)
      await shot(page, 'board-crowded', 900, theme)
      await shot(page, 'board-crowded', 390, theme)
    }

    // On a phone the requests are rows that open their session, where the request is decided.
    await page.setViewportSize({ width: 390, height: 844 })
    await board.getByRole('list', { name: '等你处理' }).locator(`[data-work-session="${ids[0]}"] .work-board-card-main`).click()
    const original = (await owner.json<TaskDetail>(`tasks/${ids[0]}`)).approvals[0]!
    await page.locator(`main.workspace [data-approval-id="${original.id}"]`).waitFor()
    await page.setViewportSize({ width: 1440, height: 1000 })
    await switchView(page, 'board')
    // Back on the board the opened card is marked and scrolled into view; the decision at the top reads its request
    // once it is in view again.
    await expect.poll(() => card(ids[0]!).getAttribute('data-marked')).toBe('')
    const toTop = () => cards.evaluate(list => list.scrollTo({ top: 0 }))

    // Work scope: the request's path and action stay, its file body does not.
    await owner.confirmedJson(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
    await page.reload()
    await connected(page)
    await toTop()
    await decision.locator('.approval-panel').waitFor()
    expect(await decision.textContent()).toContain('settings-10.ts')
    expect(await decision.textContent()).not.toContain('export const keep')
    await shot(page, 'board-limited', 1440, 'dark')

    // View only: nothing to allow on the card.
    await owner.confirmedJson(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'all', scopes: ['view'] } })
    await page.reload()
    await connected(page)
    await toTop()
    await decision.locator('.approval-panel').waitFor()
    expect(await decision.getByRole('button', { name: '允许', exact: true }).count()).toBe(0)
    await shot(page, 'board-readonly', 1440, 'dark')

    // Offline: the last known state, said as such.
    await owner.confirmedJson(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'all', scopes: FULL } })
    await page.reload()
    await connected(page)
    await context.setOffline(true)
    await expect.poll(() => page.locator('.app-shell').getAttribute('data-connection')).toMatch(/offline|reconnecting/u)
    await card(ids[0]!).getByText('上次状态：审批', { exact: true }).waitFor()
    for (const theme of ['light', 'dark'] as const) await shot(page, 'board-offline', 1440, theme)
    await context.setOffline(false)
    await connected(page)
    await toTop()
    await decision.locator('.approval-panel').waitFor()

    // A decision on the card whose answer is lost: the same request again, only from 重试.
    const request = (await owner.json<TaskDetail>(`tasks/${newest}`)).approvals[0]!
    const writes: Array<{ decision: string; requestId: string; optionId?: string }> = []
    await page.route(`**/link/api/approvals/${request.id}`, async route => {
      if (route.request().method() !== 'POST') return route.continue()
      writes.push(route.request().postDataJSON())
      if (writes.length === 1) await route.abort('connectionreset')
      else await route.continue()
    })
    await expect.poll(() => decision.getByRole('button', { name: '允许', exact: true }).isDisabled()).toBe(false)
    await decision.getByRole('button', { name: '允许', exact: true }).click()
    await decision.getByText('「允许」的结果未知', { exact: true }).waitFor()
    // The card shows the existing decision's retry while it awaits a receipt.
    for (const name of ['拒绝', '允许']) expect(await decision.getByRole('button', { name, exact: true }).count()).toBe(0)
    const retry = decision.getByRole('button', { name: '重试', exact: true })
    expect(await retry.isEnabled()).toBe(true)
    await shot(page, 'board-decision-unknown', 1440, 'dark')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ decision: 'allow', requestId: expect.any(String) })
    expect((await owner.json<TaskDetail>(`tasks/${newest}`)).approvals.map(approval => approval.id)).toEqual([request.id])
    await retry.click()
    await expect.poll(() => readFile(join(folder, 'settings-10.ts'), 'utf8')).toBe('export const keep = true\n')
    expect(writes).toHaveLength(2)
    expect(writes[1]).toEqual(writes[0])
    await expect.poll(() => attention.locator(`[data-work-session="${newest}"]`).count()).toBe(0)
  } catch (error) {
    await page
      .locator('.work-board-cards')
      .first()
      .evaluate(list => list.scrollTo({ top: 0 }))
      .catch(() => {})
    await page.screenshot({ path: `${OUT}/failure.png`, animations: 'disabled' }).catch(() => {})
    throw error
  } finally {
    await page.unrouteAll({ behavior: 'wait' })
    await context.setOffline(false)
    for (const id of ids) await host.host.bridge.cancel(id).catch(() => {})
    await context.close()
    await browser.close()
    await host.close()
  }
})
