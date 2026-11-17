import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { expect, test } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { openSession, settleShell } from './helpers/layout.ts'

const OUT = 'test-results/plan-approval'
const SLOW = { timeout: 20_000 }

test('shows a plan Claude asks to go on with as a plan, and answers 继续规划 and 按计划执行 with its own options', async () => {
  const host = await startTestHost()
  const browser = await chromium.launch(browserLaunchOptions())
  await mkdir(OUT, { recursive: true })
  try {
    const owner = await host.enroll({ listener: 'unix' })
    // The fake agent under the Claude Agent preset, answering as the adapter does.
    const saved = await owner.confirmed('agents', {
      method: 'POST',
      body: {
        id: 'claude-agent',
        presetId: 'claude-agent',
        name: 'Claude Agent',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: {
          FAKE_ACP_CONFIG: 'options',
          FAKE_ACP_MODES: 'default,acceptEdits,plan,auto,bypassPermissions',
          FAKE_ACP_INITIAL_MODE: 'auto',
          FAKE_ACP_VERSION: '0.101.0',
        },
      },
    })
    expect(saved.status).toBe(201)
    // Devices connect first: a new device is refused while a full-access session runs or waits.
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    await enrollBrowser(page, host, { name: '计划' })
    await settleShell(page)
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: 'reduce',
      isMobile: true,
      hasTouch: true,
    })
    const small = await phone.newPage()
    await enrollBrowser(small, host, { name: '手机' })
    const created = await owner.confirmed('tasks', {
      method: 'POST',
      body: { prompt: 'exit-plan', requestId: randomUUID(), mode: 'agent', harnessId: 'claude-agent', workspaceId: 'default' },
    })
    const { sessionId } = (await created.json()) as { sessionId: string }
    const detail = () => owner.json<TaskDetail>(`tasks/${sessionId}`)
    await openSession(page, sessionId)
    const plan = page.getByRole('region', { name: '计划', exact: true })
    await plan.waitFor(SLOW)
    expect(await plan.innerText()).toContain('Do it')
    await page.screenshot({ path: `${OUT}/plan-1440-light.png`, animations: 'disabled' })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: `${OUT}/plan-1440-dark.png`, animations: 'disabled' })
    await page.emulateMedia({ colorScheme: 'light' })
    await page.getByRole('button', { name: '继续规划', exact: true }).click()
    await expect.poll(async () => (await detail()).summary.status, SLOW).not.toBe('waiting-approval')
    await expect
      .poll(async () => (await detail()).messages.find(message => message.tool?.plan)?.tool?.decision?.outcome, SLOW)
      .toBe('rejected')
    await expect.poll(async () => (await detail()).summary.status, SLOW).toBe('idle')

    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'exit-plan', requestId: randomUUID() } })
    await plan.waitFor(SLOW)
    await page.getByRole('button', { name: '按计划执行', exact: true }).click()
    await expect
      .poll(async () => (await detail()).messages.filter(message => message.role === 'assistant').at(-1)?.text, SLOW)
      .toBe('mode=default')
    // After a reload the plans are the session's record, each with how it was answered.
    await page.reload()
    await settleShell(page)
    expect((await detail()).messages.filter(message => message.tool?.plan).map(message => message.tool?.decision?.outcome)).toEqual([
      'rejected',
      'allowed',
    ])
    await context.close()

    await settleShell(small)
    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'exit-plan', requestId: randomUUID() } })
    await openSession(small, sessionId)
    await small.getByRole('region', { name: '计划', exact: true }).waitFor(SLOW)
    await small.screenshot({ path: `${OUT}/plan-390.png`, animations: 'disabled' })
    await small.getByRole('button', { name: '继续规划', exact: true }).click()
    await expect.poll(async () => (await detail()).summary.status, SLOW).toBe('idle')
    await phone.close()
  } finally {
    await browser.close()
    await host.close()
  }
}, 120_000)
