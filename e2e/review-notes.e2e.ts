import { chromium, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { ReviewNoteList, TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { settleShell } from './helpers/layout.ts'

const OUT = 'test-results/review-notes'
const SLOW = { timeout: 20_000 }

const base = Array.from({ length: 50 }, (_, index) => `export const v${index + 1} = ${index + 1}`)
/** The agent's first turn: lines 42–45 and line 18 change. */
const first = base.map((line, index) =>
  index >= 41 && index <= 44 ? `${line} * rate` : index === 17 ? "export const label = 'all'" : line,
)
/** Its revision: two lines on top move 42–45 down, and line 18 changes again, so that note has no place left. */
const revised = ['// revised', '// by the agent', ...first.map((line, index) => (index === 17 ? "export const label = '全部'" : line))]
const text = (lines: string[]) => `${lines.join('\n')}\n`

async function openSession(page: Page, sessionId: string) {
  await page.locator('.app-shell').waitFor()
  await settleShell(page)
  const row = page.locator(`[data-task-id="${sessionId}"]`).first()
  if (!(await page.locator('.workspace.has-task').count())) {
    if (!(await row.isVisible())) await page.getByRole('button', { name: '打开会话列表', exact: true }).click()
    await row.click()
    await settleShell(page)
  }
  await page.getByRole('button', { name: '改动', exact: true }).click()
  return page.locator('.changes-panel')
}

it('keeps line feedback on the Host: a range, the pending set, one message, re-anchoring, review, and a second device', async () => {
  const host = await startTestHost({ demo: false })
  const browser = await chromium.launch(browserLaunchOptions())
  await mkdir(OUT, { recursive: true })
  try {
    const root = host.workspaceRoot
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: root, stdio: 'pipe' })
    git('init', '-q', '-b', 'main')
    await writeFile(join(root, 'rates.ts'), text(base))
    git('add', '.')
    git('commit', '-q', '-m', 'first')

    const queue = join(host.root, 'edits.json')
    await writeFile(queue, JSON.stringify([{ path: 'rates.ts', content: text(first) }]))
    const owner = await host.enroll({ listener: 'unix' })
    const saved = await owner.confirmed('agents', {
      method: 'POST',
      body: { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_EDIT_QUEUE: queue } },
    })
    expect(saved.status).toBe(201)
    const created = await owner.confirmed('tasks', {
      method: 'POST',
      body: { prompt: 'hello', requestId: randomUUID(), mode: 'agent', harnessId: 'fake', workspaceId: 'default' },
    })
    const { sessionId } = (await created.json()) as { sessionId: string }
    const status = async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status
    await expect.poll(status, SLOW).toBe('idle')
    const turns = async () => (await owner.json<{ turns: Array<{ state: string }> }>(`tasks/${sessionId}/changes/turns`)).turns
    await expect.poll(async () => (await turns()).map(turn => turn.state), SLOW).toEqual(['settled'])

    /** A browser with run and the folders' data scope. */
    const device = async (width: number, height: number, name: string) => {
      const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN', hasTouch: width < 768 })
      const page = await context.newPage()
      page.setDefaultTimeout(15_000)
      await enrollBrowser(page, host, { name, scopes: ['admin'] })
      const id = (await owner.json<{ devices: Array<{ id: string; name: string }> }>('devices')).devices.find(
        item => item.name === name,
      )!.id
      expect((await owner.confirmed(`devices/${id}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
      await page.reload()
      return { context, page }
    }
    const desk = await device(1440, 900, `Desk ${randomUUID()}`)
    const panel = await openSession(desk.page, sessionId)
    await panel.locator('.diff-add', { hasText: 'v42 = 42 * rate' }).waitFor()

    // Lines 42–45: a press on the first, Shift on the last.
    const line = (number: number) => panel.getByRole('button', { name: `反馈第 ${number} 行`, exact: true })
    await panel.locator('.diff-add', { hasText: 'v42 = 42 * rate' }).hover()
    await line(42).click()
    await panel.locator('.diff-add', { hasText: 'v45 = 45 * rate' }).hover()
    await line(45).click({ modifiers: ['Shift'] })
    await expect.poll(() => panel.locator('[data-mark="selected"]').count()).toBe(4)
    await panel.getByText('第 42–45 行', { exact: true }).waitFor()
    await desk.page.screenshot({ path: join(OUT, 'select--desktop.png') })
    await panel.getByRole('textbox', { name: '反馈' }).fill('税率应来自账户设置，不要写死。')
    await panel.getByRole('button', { name: '加入待发', exact: true }).click()
    await panel.getByText('待发反馈 1 条').waitFor()

    // Line 18 from the keyboard: focus its button, Enter, then in the empty box Shift ↓ and Shift ↑ back to one line.
    await line(18).focus()
    await desk.page.keyboard.press('Enter')
    await desk.page.keyboard.press('Shift+ArrowDown')
    await panel.getByText('第 18–19 行', { exact: true }).waitFor()
    await desk.page.keyboard.press('Shift+ArrowUp')
    await panel.getByText('第 18 行', { exact: true }).waitFor()
    await panel.getByRole('textbox', { name: '反馈' }).fill('列表为空时显示「全部」。')
    await desk.page.keyboard.press('Meta+Enter')
    await panel.getByText('待发反馈 2 条').waitFor()
    await desk.page.screenshot({ path: join(OUT, 'pending--desktop.png') })

    // The phone sees the same two notes, from the Host.
    const phone = await device(390, 844, `Phone ${randomUUID()}`)
    const phonePanel = await openSession(phone.page, sessionId)
    await phonePanel.getByText('待发反馈 2 条').waitFor()
    await phonePanel.getByText('税率应来自账户设置，不要写死。').waitFor()
    const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    await phone.page.screenshot({ path: join(OUT, 'pending--phone.png') })

    // One message; the agent revises the file in that turn.
    await writeFile(queue, JSON.stringify([{ path: 'rates.ts', content: text(revised) }]))
    await panel.getByRole('button', { name: '发给 Agent', exact: true }).click()
    const notes = async () => (await owner.json<ReviewNoteList>(`tasks/${sessionId}/review-notes`)).notes
    await expect.poll(async () => (await notes()).map(note => note.status), SLOW).toEqual(['sent', 'sent'])
    const messageId = (await notes())[0]!.messageId!
    const detail = await owner.json<TaskDetail>(`tasks/${sessionId}`)
    const message = detail.messages.find(item => item.id === messageId)!
    expect(message.text).toContain('rates.ts 第 42–45 行')
    expect(message.text).toContain('export const v42 = 42 * rate')
    expect(message.text).toContain('rates.ts 第 18 行')
    await expect.poll(status, SLOW).toBe('idle')
    await expect.poll(async () => (await turns()).map(turn => turn.state), SLOW).toEqual(['settled', 'settled'])

    // The latest turn: the first note followed its lines down by two; the second has no place left and says so.
    await desk.page.reload()
    const after = await openSession(desk.page, sessionId)
    const moved = after.locator('[data-note]', { hasText: '税率应来自账户设置' })
    await moved.getByText('第 44–47 行').waitFor()
    await expect.poll(() => after.locator('[data-mark="noted"]').count()).toBe(4)
    const stale = after.locator('[data-note][data-stale]')
    await stale.getByText('位置可能过期').waitFor()
    expect(await stale.locator('.review-note-snippet').innerText()).toBe("export const label = 'all'")
    await desk.page.screenshot({ path: join(OUT, 'revised--desktop.png') })

    // The person's own marks, each its own state; the phone follows without a reload.
    await moved.getByRole('button', { name: 'Agent 称已修', exact: true }).click()
    await moved.getByText('Agent 称已修', { exact: true }).last().waitFor()
    await stale.getByRole('button', { name: '标为已复核', exact: true }).click()
    await stale.getByText('你已复核').waitFor()
    await after.getByText('1 条待你复核').waitFor()
    await expect.poll(async () => (await notes()).map(note => note.status)).toEqual(['agent-claimed', 'reviewed'])
    await phonePanel.getByText('你已复核').waitFor()
    await phonePanel.getByText('1 条待你复核').waitFor()
    await phone.page.screenshot({ path: join(OUT, 'revised--phone.png') })

    // While a turn runs, the Host queues the message for the next one, as the composer does.
    await owner.json(`tasks/${sessionId}/review-notes`, {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        root: 'default',
        path: 'rates.ts',
        range: { start: 3, end: 3 },
        side: 'new',
        scope: 'turn',
        lines: [revised[2]!],
        text: '再看一下这行。',
      },
    })
    await after.getByText('待发反馈 1 条').waitFor()
    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'count 800', requestId: randomUUID() } })
    await after.getByRole('button', { name: '排到下一轮', exact: true }).click()
    await after.getByText('1 条反馈已排队').waitFor()
    const queued = async () => (await notes()).find(note => note.text === '再看一下这行。')!
    // Nothing has gone out yet: pending and locked until the queued message is sent with the next turn.
    expect(await queued()).toMatchObject({ status: 'pending', sending: true, queueId: expect.any(String) })
    await expect.poll(async () => (await queued()).status, SLOW).toBe('sent')
    expect((await queued()).messageId).toEqual(expect.any(String))

    await phone.context.close()
    await desk.context.close()
  } finally {
    await browser.close()
    await host.close()
  }
})
