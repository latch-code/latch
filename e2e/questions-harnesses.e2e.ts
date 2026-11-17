import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Page } from '@playwright/test'
import { expect, test } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { FAKE_CODEX_APP_SERVER } from '@latch/testkit'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { openSession, settleShell } from './helpers/layout.ts'

const OUT = 'test-results/questions-harnesses'
const SLOW = { timeout: 20_000 }

/** The question card of the open session, ready for input. */
const card = (page: Page) => page.getByRole('region', { name: 'Harness 提问', exact: true })

test("answers Codex's question after a reload, and the second device's stale answer settles without an error", async () => {
  const root = await mkdtemp(join(tmpdir(), 'latch-e2e-codex-question-'))
  const bin = join(root, 'bin'),
    command = join(bin, 'codex')
  await mkdir(bin)
  await writeFile(command, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_CODEX_APP_SERVER}' "$@"\n`)
  await chmod(command, 0o755)
  const host = await startTestHost({
    dataDir: join(root, 'data'),
    workspaceRoot: join(root, 'default'),
    commandDirectories: () => [bin],
    loginPrograms: (name: string) => (name === 'codex' ? command : undefined),
    detectPreset: (preset: { id: string }) => (preset.id === 'codex' ? { found: true, path: command } : { found: false }),
  })
  const browser = await chromium.launch(browserLaunchOptions())
  await mkdir(OUT, { recursive: true })
  try {
    const owner = await host.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
      body: {
        id: 'codex',
        presetId: 'codex',
        name: 'Codex',
        command: 'codex',
        args: [],
        env: { FAKE_CODEX_STATE: join(root, 'threads.json') },
      },
    })
    const desk = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' })
    const first = await desk.newPage()
    await enrollBrowser(first, host, { name: '桌面' })
    await settleShell(first)
    const other = await browser.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: 'reduce',
      isMobile: true,
      hasTouch: true,
    })
    const second = await other.newPage()
    await enrollBrowser(second, host, { name: '手机' })
    const created = await owner.confirmed('tasks', {
      method: 'POST',
      body: { prompt: 'ask-user', requestId: randomUUID(), harnessId: 'codex', mode: 'agent', workspaceId: 'default' },
    })
    const { sessionId } = (await created.json()) as { sessionId: string }
    const detail = () => owner.json<TaskDetail>(`tasks/${sessionId}`)
    await expect.poll(async () => (await detail()).questions?.length, SLOW).toBe(1)
    await openSession(first, sessionId)
    await card(first).waitFor(SLOW)
    // The first choice of two, then a reload: the question and this device's draft are still there.
    await card(first).getByRole('button', { name: /Blue/u }).click()
    await first.reload()
    await settleShell(first)
    await card(first).waitFor(SLOW)
    expect(await card(first).innerText()).toContain('What is it called?')
    await first.screenshot({ path: `${OUT}/question-1440-light.png`, animations: 'disabled' })

    // This device writes its answer to the second question, but the answer is held on its way.
    let release!: () => void
    const held = new Promise<void>(resolve => (release = resolve))
    await first.route('**/questions/*/answer', async route => {
      await held
      await route.continue()
    })
    await card(first).getByRole('button', { name: '其他…', exact: true }).click()
    const deskInput = first.getByRole('textbox', { name: '继续对话', exact: true })
    await deskInput.fill('Alice')
    await first.getByRole('button', { name: '发送', exact: true }).click()
    // Another device answers the whole question meanwhile.
    await settleShell(second)
    await openSession(second, sessionId)
    await card(second).waitFor(SLOW)
    await second.screenshot({ path: `${OUT}/question-390.png`, animations: 'disabled' })
    await card(second).getByRole('button', { name: /Red/u }).click()
    await card(second).getByRole('button', { name: '其他…', exact: true }).click()
    const phoneInput = second.getByRole('textbox', { name: '继续对话', exact: true })
    await phoneInput.fill('Bob')
    await second.getByRole('button', { name: '发送', exact: true }).click()
    await expect
      .poll(async () => (await detail()).messages.filter(message => message.role === 'assistant').at(-1)?.text, SLOW)
      .toBe(`answers: ${JSON.stringify({ colour: { answers: ['Red'] }, name: { answers: ['Bob'] } })}`)
    // The desk's held answer arrives late: the Host refuses it for certain, and the page says so once, not as an error.
    release()
    await first.getByText('这个问题已在另一台设备回答').waitFor(SLOW)
    await card(first).waitFor({ state: 'detached', ...SLOW })
    expect((await detail()).messages.filter(message => message.role === 'assistant').at(-1)?.text).not.toContain('Alice')
    await other.close()
    await desk.close()
  } finally {
    await browser.close()
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)
