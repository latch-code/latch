import { chromium } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import type { AppSnapshot, CustomAgent, TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, FAKE_CODEX_APP_SERVER } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { noHorizontalOverflow, openSession } from './helpers/layout.ts'
import { startTestHost } from './helpers/host.ts'

it.each([true, false])('keeps one accessible helper boundary before and after its first topic (readback=%s)', async readback => {
  const root = await mkdtemp(join(tmpdir(), 'latch-helper-boundary-'))
  const cleanup: Array<() => Promise<unknown>> = []
  try {
    const bin = join(root, 'bin')
    await mkdir(bin)
    const command = join(bin, 'codex')
    await writeFile(command, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_CODEX_APP_SERVER}' "$@"\n`)
    await chmod(command, 0o755)
    const host = await startTestHost({
      dataDir: join(root, 'host'),
      workspaceRoot: join(root, 'workspace'),
      uiDir: resolve(process.env.LATCH_E2E_UI_DIR ?? 'dist/web'),
      commandDirectories: () => [bin],
    })
    cleanup.unshift(() => host.close())
    const owner = await host.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: readback
        ? { id: 'codex', name: 'Codex', presetId: 'codex', command, args: [], env: {} }
        : { id: 'unknown', name: 'Unknown', command: process.execPath, args: [FAKE_ACP_AGENT], env: {} },
    })
    const agent = await owner.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: '小林',
        harnessId: readback ? 'codex' : 'unknown',
        mode: 'agent',
        instructions: '',
        skills: [],
      },
    })
    const browser = await chromium.launch(browserLaunchOptions())
    cleanup.unshift(() => browser.close())
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
    cleanup.unshift(() => context.close())
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await enrollBrowser(page, host, { name: '边界说明' })
    const device = host.host.security.devices.list().find(item => item.name === '边界说明')!
    await owner.confirmedJson(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
    await page.reload()
    await connected(page)
    await page.getByRole('radio', { name: '我的 Agent', exact: true }).filter({ visible: true }).click()
    await page
      .getByRole('navigation', { name: '我的 Agent', exact: true })
      .getByRole('button', { name: /^小林/u })
      .click()
    const output = join('test-results', 'helper-boundary', readback ? 'known' : 'unread')
    await mkdir(output, { recursive: true })
    const check = async (state: string) => {
      const boundary = page.locator('.agent-frame .agent-boundary-trigger').filter({ visible: true })
      expect(await boundary.count()).toBe(1)
      expect(await page.locator('.transcript .session-start-note').filter({ hasText: '不隔离' }).count()).toBe(0)
      if (!readback && state !== 'new') expect(await boundary.textContent()).toContain('权限没确认')
      // The neutral boundary is its shield beside the name; its words are its name and its popover's.
      else expect(await boundary.getAttribute('aria-label')).toBe('Latch 不隔离 小林：说明')
      for (const [width, colorScheme] of [
        [1440, 'light'],
        [768, 'dark'],
        [390, 'dark'],
      ] as const) {
        await page.setViewportSize({ width, height: 1000 })
        await page.emulateMedia({ colorScheme })
        await noHorizontalOverflow(page)
        await page.screenshot({ path: join(output, `${state}-${width}-${colorScheme}.png`), animations: 'disabled' })
      }
      await boundary.click()
      await page
        .getByText(/能读写这台 Mac 上的文件并运行命令/u)
        .filter({ visible: true })
        .waitFor()
      await page.screenshot({ path: join(output, `${state}-detail-390-dark.png`), animations: 'disabled' })
      await page.keyboard.press('Escape')
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.emulateMedia({ colorScheme: 'light' })
    }
    await check('new')
    await page.getByRole('textbox', { name: '给小林发消息', exact: true }).fill('echo ready')
    await page.getByRole('button', { name: '发送', exact: true }).filter({ visible: true }).click()
    const topic = async () => (await owner.json<AppSnapshot>('snapshot')).tasks.find(task => task.agent?.customAgentId === agent.id)
    // The Harness process is started for this message: the topic was idle 0.2 to 3.3 seconds after the send here, and the
    // default wait is one second.
    await expect.poll(async () => (await topic())?.status, { timeout: 15_000 }).toBe('idle')
    const id = (await topic())!.id
    expect((await owner.json<TaskDetail>(`tasks/${id}`)).summary.firstStart).toBe(true)
    await check('topic')
    await page.reload()
    await connected(page)
    await check('reopened')
    // A Code session still carries the original first-start note in its transcript.
    // First-start is per launch fingerprint, so give this control its own confirmed definition.
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: {
        id: 'code-control',
        name: 'Code control',
        ...(readback ? { presetId: 'codex', command, args: [] } : { command: process.execPath, args: [FAKE_ACP_AGENT] }),
        env: { FIXTURE_BOUNDARY_CONTROL: 'code' },
      },
    })
    const code = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        harnessId: 'code-control',
        mode: 'agent',
        prompt: 'echo code',
      },
    })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${code.sessionId}`)).summary.status).toBe('idle')
    expect((await owner.json<TaskDetail>(`tasks/${code.sessionId}`)).summary.firstStart).toBe(true)
    await page.getByRole('radio', { name: 'Code', exact: true }).filter({ visible: true }).click()
    await openSession(page, code.sessionId)
    // A Code session says it on its reply's mark and name, as their tooltip, and keeps no row for it.
    await page.locator('.transcript .assistant-meta-who[tabindex]').first().waitFor()
    expect(await page.locator('.transcript .assistant-meta-who + [role="tooltip"]').first().textContent()).toContain('不隔离')
    expect(await page.locator('.transcript .session-start-note').count()).toBe(0)
    expect(await page.locator('.agent-frame .agent-boundary-trigger').filter({ visible: true }).count()).toBe(0)
    await page.screenshot({ path: join(output, 'code-preserved-1440-light.png'), animations: 'disabled' })
  } finally {
    const failures: unknown[] = []
    for (const close of cleanup) {
      try {
        await close()
      } catch (error) {
        failures.push(error)
      }
    }
    await rm(root, { recursive: true, force: true })
    if (failures.length) throw new AggregateError(failures, 'Boundary fixture cleanup failed')
  }
})
