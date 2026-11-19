import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Page } from '@playwright/test'
import { expect, test } from 'vitest'
import type { AppSnapshot, AttachmentRef, TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { openSession, settleShell } from './helpers/layout.ts'
import { promptValue } from './helpers/prompt.ts'

const OUT = 'test-results/edit-message'
const SLOW = { timeout: 20_000 }

/** The person's message `text` in the open conversation, and its 从这里编辑. */
const editButton = (page: Page, text: string) =>
  page.locator('article', { has: page.locator('.user-bubble', { hasText: text }) }).getByRole('button', { name: '从这里编辑' })

test('edits an earlier message and resends it in a new session from that point, with and without putting the files back', async () => {
  const host = await startTestHost()
  const browser = await chromium.launch(browserLaunchOptions())
  await mkdir(OUT, { recursive: true })
  try {
    const owner = await host.enroll({ listener: 'unix' })
    expect(
      (
        await owner.confirmed('agents', {
          method: 'POST',
          body: { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT] },
        })
      ).status,
    ).toBe(201)
    const created = await owner.confirmed('tasks', {
      method: 'POST',
      body: { prompt: 'shell-edit', requestId: randomUUID(), mode: 'agent', harnessId: 'fake', workspaceId: 'default' },
    })
    const { sessionId } = (await created.json()) as { sessionId: string }
    const detail = (id = sessionId) => owner.json<TaskDetail>(`tasks/${id}`)
    const idle = (id = sessionId) => expect.poll(async () => (await detail(id)).summary.status, SLOW).toBe('idle')
    await idle()
    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'echo second', requestId: randomUUID() } })
    await idle()
    const file = (name: string) => join(host.workspaceRoot, name)
    expect(existsSync(file('agent-edit.txt'))).toBe(true)

    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    await enrollBrowser(page, host, { name: '编辑消息' })
    await settleShell(page)
    await openSession(page, sessionId)
    const draft = page.getByRole('textbox', { name: '新会话消息', exact: true })

    // A later message whose turn changed nothing: straight back to the composer, forked before it.
    await editButton(page, 'echo second').click()
    await expect.poll(() => promptValue(draft), SLOW).toBe('echo second')
    await page.locator('.fork-notice').waitFor()
    await draft.fill('echo edited')
    await draft.press('Meta+Enter')
    await expect.poll(async () => (await owner.json<AppSnapshot>('snapshot')).tasks.length, SLOW).toBe(2)
    const forked = (await owner.json<AppSnapshot>('snapshot')).tasks.find(task => task.id !== sessionId)!
    await idle(forked.id)
    expect((await detail(forked.id)).summary.forkOf).toMatchObject({ taskId: sessionId, turn: 1 })
    // The session before the edit is as it was.
    expect((await detail()).messages.filter(message => message.role === 'user').map(message => message.text)).toEqual([
      'shell-edit',
      'echo second',
    ])

    // The first message, whose turn changed files: the choice to put them back, with what it writes.
    await openSession(page, sessionId)
    await editButton(page, 'shell-edit').click()
    const dialog = page.getByRole('dialog', { name: '从这里编辑' })
    await dialog.waitFor()
    await dialog.getByText('同时把文件退回到这一条之前').click()
    await dialog.getByText('agent-edit.txt').waitFor()
    await page.screenshot({ path: `${OUT}/rewind-1440-light.png`, animations: 'disabled' })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: `${OUT}/rewind-1440-dark.png`, animations: 'disabled' })
    await page.emulateMedia({ colorScheme: 'light' })
    await dialog.getByRole('button', { name: '退回文件并编辑', exact: true }).click()
    await expect.poll(() => promptValue(draft), SLOW).toBe('shell-edit')
    expect(existsSync(file('agent-edit.txt'))).toBe(false)
    expect(existsSync(file('command-edit.txt'))).toBe(false)
    // The changes record shows those turns undone: 恢复 brings them back.
    const turns = (await owner.json<{ turns: Array<{ undone?: unknown }> }>(`tasks/${sessionId}/changes/turns`)).turns
    expect(turns.some(turn => turn.undone)).toBe(true)

    // The session's next message tells the agent the files went back (its own memory of them did not).
    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'echo next', requestId: randomUUID() } })
    await idle()
    expect((await detail()).messages.filter(message => message.role === 'assistant').at(-1)?.text).toContain(
      '[Latch] 在这条消息之前，用户撤销了',
    )
    // While a turn runs, editing waits, and says why.
    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'hang', requestId: randomUUID() } })
    await expect.poll(async () => (await detail()).summary.status, SLOW).toBe('running')
    await openSession(page, sessionId)
    const locked = editButton(page, 'shell-edit')
    await expect.poll(() => locked.getAttribute('aria-disabled'), SLOW).toBe('true')
    await owner.request(`tasks/${sessionId}/cancel`, { method: 'POST' })
    await context.close()

    // A phone: the same choice as a sheet.
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: 'reduce',
      isMobile: true,
      hasTouch: true,
    })
    const small = await phone.newPage()
    await enrollBrowser(small, host, { name: '手机' })
    await settleShell(small)
    const again = await owner.confirmed('tasks', {
      method: 'POST',
      body: { prompt: 'shell-edit', requestId: randomUUID(), mode: 'agent', harnessId: 'fake', workspaceId: 'default' },
    })
    const { sessionId: phoneSession } = (await again.json()) as { sessionId: string }
    await idle(phoneSession)
    await openSession(small, phoneSession)
    await editButton(small, 'shell-edit').click()
    await small.getByRole('dialog', { name: '从这里编辑' }).waitFor()
    await small.screenshot({ path: `${OUT}/rewind-390.png`, animations: 'disabled' })
    await phone.close()
  } finally {
    await browser.close()
    await host.close()
  }
}, 120_000)

test('puts the message’s attachment and file reference back with its words, and the new session sends them', async () => {
  const host = await startTestHost()
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    const owner = await host.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
      body: { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_CAPS: 'images,embedded' } },
    })
    await writeFile(join(host.workspaceRoot, 'reference.txt'), 'file context')
    const created = await owner.confirmed('tasks', {
      method: 'POST',
      body: {
        prompt: 'echo first',
        requestId: randomUUID(),
        mode: 'agent',
        harnessId: 'fake',
        workspaceId: 'default',
      },
    })
    const { sessionId } = (await created.json()) as { sessionId: string }
    const detail = (id = sessionId) => owner.json<TaskDetail>(`tasks/${id}`)
    const idle = (id = sessionId) => expect.poll(async () => (await detail(id)).summary.status, SLOW).toBe('idle')
    await idle()
    const selection = { harnessId: 'fake' }
    const note = Buffer.from('notes for the agent')
    const uploaded = await owner.request('attachments', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-latch-attachment': Buffer.from(
          JSON.stringify({ requestId: randomUUID(), name: 'notes.txt', size: note.length, selection, sessionId }),
        ).toString('base64url'),
      },
      rawBody: note,
    })
    expect(uploaded.status).toBe(201)
    const { attachment } = (await uploaded.json()) as { attachment: AttachmentRef }
    const sent = await owner.request(`tasks/${sessionId}/prompt`, {
      method: 'POST',
      body: {
        prompt: 'echo look @default:reference.txt ',
        requestId: randomUUID(),
        attachmentIds: [attachment.id],
        fileRefs: [{ root: 'default', path: 'reference.txt' }],
      },
    })
    expect(sent.status).toBe(200)
    await idle()

    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    await enrollBrowser(page, host, { name: '附件', scopes: ['admin'] })
    const deviceId = await page.evaluate(async () => (await (await fetch('/link/api/snapshot')).json()).device.id as string)
    expect((await owner.confirmed(`devices/${deviceId}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
    await page.reload()
    await settleShell(page)
    await openSession(page, sessionId)
    await editButton(page, 'echo look').click()
    const draft = page.getByRole('textbox', { name: '新会话消息', exact: true })
    await expect.poll(() => promptValue(draft), SLOW).toBe('echo look @default:reference.txt ')
    // The attachment comes back as a draft of this device, read back for its preview.
    await page.locator('.attachment-draft[data-state="ready"]', { hasText: 'notes.txt' }).waitFor(SLOW)
    await page.screenshot({ path: `${OUT}/edit-attachment-1440.png`, animations: 'disabled' })
    await draft.press('Meta+Enter')
    await expect.poll(async () => (await owner.json<AppSnapshot>('snapshot')).tasks.length, SLOW).toBe(2)
    const forked = (await owner.json<AppSnapshot>('snapshot')).tasks.find(task => task.id !== sessionId)!
    await idle(forked.id)
    const first = (await detail(forked.id)).messages.find(message => message.role === 'user')!
    expect(first.fileRefs).toEqual([{ root: 'default', path: 'reference.txt' }])
    expect(first.attachments).toEqual([expect.objectContaining({ name: 'notes.txt', sha256: attachment.sha256 })])
    expect(first.attachments?.[0]?.id).not.toBe(attachment.id)
    // Edited again in the new session: its first message still goes on from where the fork began, not from nothing.
    await openSession(page, forked.id)
    await editButton(page, 'echo look').click()
    await expect.poll(() => promptValue(draft), SLOW).toBe('echo look @default:reference.txt ')
    await page.locator('.fork-notice', { hasText: 'echo first' }).waitFor(SLOW)
    await context.close()
  } finally {
    await browser.close()
    await host.close()
  }
}, 120_000)
