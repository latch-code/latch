import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { FAKE_CODEX_APP_SERVER } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { noHorizontalOverflow, openSession, reachable } from './helpers/layout.ts'
import { startTestHost } from './helpers/host.ts'

it('delegates from the same Codex chat, opens the actual member approval and restores member results after a reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'latch-codex-team-ui-'))
  let host: Awaited<ReturnType<typeof startTestHost>> | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  const output = process.env.LATCH_TEAM_E2E_IMAGES
  try {
    const bin = join(root, 'bin')
    const command = join(bin, 'codex')
    await mkdir(bin)
    await writeFile(
      command,
      `#!/bin/sh\nexport FAKE_CODEX_STATE='${join(root, 'threads.json')}'\nexec '${process.execPath}' '${FAKE_CODEX_APP_SERVER}' "$@"\n`,
    )
    await chmod(command, 0o755)
    host = await startTestHost({
      demo: false,
      dataDir: join(root, 'data'),
      workspaceRoot: join(root, 'project'),
      uiDir: resolve(process.env.LATCH_E2E_UI_DIR ?? 'dist/web'),
      commandDirectories: () => [bin],
      loginPrograms: name => (name === 'codex' ? command : undefined),
      detectPreset: preset => (preset.id === 'codex' ? { found: true, path: command } : { found: false }),
    })
    const owner = await host.enroll({ listener: 'unix' })
    const registered = await owner.confirmed('agents', {
      method: 'POST',
      body: { id: 'codex', name: 'Codex', presetId: 'codex', command: 'codex', args: [], env: {} },
    })
    expect(registered.status).toBe(201)
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { harnessId: 'codex', prompt: 'echo 根会话', requestId: randomUUID() },
    })
    const path = `tasks/${sessionId}`
    const read = () => owner.json<TaskDetail>(path)
    await expect.poll(async () => (await read()).summary.status).toBe('idle')
    await owner.json(`${path}/config`, {
      method: 'POST',
      body: { configId: 'mode', value: 'workspace-write', requestId: randomUUID() },
    })
    browser = await chromium.launch(browserLaunchOptions())
    const page = await browser.newPage({ viewport: { width: 1440, height: 930 }, locale: 'zh-CN', reducedMotion: 'reduce', hasTouch: true })
    page.setDefaultTimeout(15_000)
    await enrollBrowser(page, host)
    await openSession(page, sessionId)
    const open = (name: '用团队分工' | 'Agent 团队') => page.getByRole('button', { name: new RegExp(name, 'u') }).filter({ visible: true })
    const dialog = page.getByRole('dialog', { name: 'Agent 团队', exact: true })
    const input = page.getByRole('textbox', { name: '继续对话', exact: true })
    await input.fill('核对移动端和审批回执')
    await open('用团队分工').click()
    await dialog.getByRole('button', { name: '加入输入框', exact: true }).click()
    expect(await input.inputValue()).toContain('核对移动端和审批回执')
    expect(await input.inputValue()).toMatch(/^请启动 Codex 的子 Agent/u)
    expect((await read()).messages.filter(message => message.role === 'user')).toHaveLength(1)
    await page.getByRole('button', { name: '发送', exact: true }).filter({ visible: true }).click()
    await expect.poll(async () => (await read()).summary.status).toBe('waiting-approval')
    await open('Agent 团队').click()
    const memberApproval = dialog.getByRole('button', { name: '查看此成员的审批', exact: true })
    for (const [width, height, colorScheme] of [
      [1440, 930, 'light'],
      [768, 910, 'dark'],
      [390, 844, 'dark'],
    ] as const) {
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme })
      await dialog.getByText('检查窄屏', { exact: true }).waitFor()
      await dialog.getByText('核对回执', { exact: true }).waitFor()
      await dialog.getByRole('listitem').filter({ hasText: 'Maple' }).getByText('等你处理', { exact: true }).waitFor()
      await reachable(memberApproval)
      await noHorizontalOverflow(page, dialog)
      if (output) await page.screenshot({ path: join(output, `team-waiting-${width}-${colorScheme}.png`), animations: 'disabled' })
    }
    await memberApproval.tap()
    const card = page.getByLabel('待批准操作').filter({ visible: true })
    await card.waitFor()
    await card.getByText('Maple', { exact: false }).first().waitFor()
    await card.getByRole('button', { name: /^拒绝/u }).click()
    await expect.poll(async () => (await read()).summary.status).toBe('idle')
    await page.reload()
    await connected(page)
    const teamEntry = open('Agent 团队')
    if (!(await teamEntry.isVisible())) await openSession(page, sessionId)
    await teamEntry.click()
    const cedar = dialog.getByRole('listitem').filter({ hasText: 'Cedar' })
    const maple = dialog.getByRole('listitem').filter({ hasText: 'Maple' })
    await cedar.getByText('已完成', { exact: true }).waitFor()
    await maple.getByText('失败', { exact: true }).waitFor()
    await cedar.getByText('成员结果', { exact: true }).click()
    await cedar.getByText('已核对手机布局', { exact: true }).waitFor()
    expect(await dialog.getByRole('listitem').count()).toBe(2)
    expect(await memberApproval.count()).toBe(0)
    if (output) await page.screenshot({ path: join(output, 'team-result-390-dark.png'), animations: 'disabled' })
  } finally {
    await browser?.close()
    await host?.close()
    await rm(root, { recursive: true, force: true })
  }
})
