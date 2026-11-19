import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { expect, it } from 'vitest'
import type { CancelReceipt, TaskDetail, TeamAnswer } from '@latch/protocol'
import { FAKE_CODEX_APP_SERVER } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { noHorizontalOverflow, openSession, reachable } from './helpers/layout.ts'
import { startTestHost } from './helpers/host.ts'

it('delegates from the same Codex chat, opens the actual member approval and restores member results after a reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'latch-codex-team-ui-'))
  let host: Awaited<ReturnType<typeof startTestHost>> | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  const output = process.env.LATCH_TEAM_E2E_IMAGES
  const trace = join(root, 'fixture-events.jsonl')
  const stopGate = join(root, 'member-command-settled')
  try {
    const bin = join(root, 'bin')
    const command = join(bin, 'codex')
    await mkdir(bin)
    await writeFile(
      command,
      `#!/bin/sh\nexport FAKE_CODEX_STATE='${join(root, 'threads.json')}' FAKE_ACP_LOG='${trace}' FAKE_CODEX_TEAM_STOP_GATE='${stopGate}' FAKE_CODEX_TEAM_MARKDOWN='1'\nexec '${process.execPath}' '${FAKE_CODEX_APP_SERVER}' "$@"\n`,
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
    const teamMembers = async () => (await read()).messages.filter(message => message.subagent?.team)
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
    const currentRun = dialog.getByRole('group', { name: '当前会话', exact: true })
    const stop = currentRun.getByRole('button', { name: '停止当前运行', exact: true })
    const history = dialog.getByRole('button', { name: '委派记录', exact: true })
    const selectDelegation = async (number: number) => {
      await history.tap()
      await page
        .getByRole('menu', { name: '委派记录', exact: true })
        .getByRole('menuitemradio', { name: `第 ${number} 次委派`, exact: true })
        .tap()
    }
    const cancelResponse = () =>
      page.waitForResponse(response => response.url().endsWith(`/${path}/cancel`) && response.request().method() === 'POST')
    const input = page.getByRole('textbox', { name: '继续对话', exact: true })
    await input.fill('先留着')
    // The one entry opens the list of tasks; Codex's own subagents are a way of working it, sent as one message.
    await open('用团队分工').click()
    const panel = page.getByRole('dialog', { name: '团队分工', exact: true })
    await panel.getByRole('radio', { name: 'Codex 子 Agent', exact: true }).click()
    await panel.getByRole('textbox', { name: '第 1 项', exact: true }).fill('核对移动端和审批回执')
    expect((await read()).messages.filter(message => message.role === 'user')).toHaveLength(1)
    await panel.getByRole('button', { name: '开始', exact: true }).click()
    await panel.waitFor({ state: 'hidden' })
    await expect.poll(async () => (await read()).messages.filter(message => message.role === 'user').length).toBe(2)
    expect((await read()).messages.filter(message => message.role === 'user').at(-1)!.text).toMatch(
      /^请启动 Codex 的子 Agent[\s\S]*\n1\. 核对移动端和审批回执$/u,
    )
    // The input keeps what it held.
    expect(await input.inputValue()).toBe('先留着')
    await input.fill('')
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
    expect(await cedar.locator('.message-content').count()).toBe(0)
    await cedar.getByText('成员结果', { exact: true }).click()
    await cedar.locator('.message-content strong').getByText('已核对手机布局', { exact: true }).waitFor()
    await cedar.locator('.message-content pre').getByText('pnpm test', { exact: true }).waitFor()
    expect(await dialog.getByRole('listitem').count()).toBe(2)
    expect(await memberApproval.count()).toBe(0)
    if (output) await page.screenshot({ path: join(output, 'team-result-390-dark.png'), animations: 'disabled' })
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()

    await owner.json(`${path}/prompt`, {
      method: 'POST',
      body: { prompt: 'team 审批排序夹具', requestId: randomUUID() },
    })
    await expect.poll(async () => (await read()).approvals.length).toBe(3)
    const ordered = (await read()).approvals
    expect(ordered.map(item => item.subagent)).toEqual(['Cedar', 'Maple', 'Pine'])
    await teamEntry.click()
    await maple.getByRole('button', { name: '查看此成员的审批', exact: true }).tap()
    await expect.poll(() => card.getAttribute('data-approval-id')).toBe(ordered[1]!.id)
    const reject = (id: string) =>
      owner.json(`approvals/${id}`, {
        method: 'POST',
        body: { decision: 'reject', requestId: randomUUID() },
      })
    await reject(ordered[0]!.id)
    await expect.poll(() => card.locator('.approval-pager').textContent()).toMatch(/1\s*[/／]\s*2/u)
    expect(await card.getAttribute('data-approval-id')).toBe(ordered[1]!.id)
    for (const item of ordered.slice(1)) await reject(item.id)
    await expect.poll(async () => (await read()).summary.status).toBe('idle')

    const historicalMembers = await teamMembers()
    await owner.json(`${path}/prompt`, {
      method: 'POST',
      body: { prompt: 'team 后台停止夹具', requestId: randomUUID() },
    })
    await expect
      .poll(async () => {
        const detail = await read()
        return detail.messages
          .filter(message => message.role === 'assistant' && message.state === 'completed')
          .map(message => message.text)
          .join('')
          .includes('Lead finished before Cedar')
          ? detail.summary.status
          : undefined
      })
      .toBe('running')
    const runId = (await read()).summary.runId
    expect(runId).toEqual(expect.any(String))
    await teamEntry.click()
    await cedar.getByText('运行中', { exact: true }).waitFor()
    await selectDelegation(1)
    await dialog.getByText('1. 核对移动端和审批回执', { exact: true }).waitFor()
    await cedar.getByText('已完成', { exact: true }).waitFor()
    if (output) await page.screenshot({ path: join(output, 'team-parent-completed-390-dark.png'), animations: 'disabled' })
    expect(await stop.count()).toBe(1)
    await reachable(stop)
    const write = cancelResponse()
    await stop.tap()
    await expect.poll(async () => (await readFile(trace, 'utf8')).includes('background-member-interrupted')).toBe(true)
    expect((await read()).summary.status).toBe('running')
    await currentRun.getByRole('button', { name: '正在停止当前运行…', exact: true }).waitFor()
    await writeFile(stopGate, '', { flag: 'wx' })
    const response = await write
    expect(response.ok()).toBe(true)
    const payload = response.request().postDataJSON() as { runId: string; requestId: string }
    expect(payload).toMatchObject({ runId, requestId: expect.any(String) })
    const first = (await response.json()) as { receipt: CancelReceipt }
    expect(first.receipt).toMatchObject({ ...payload, outcome: 'stopped', status: 'cancelled' })
    const replay = (await page.evaluate(
      async ({ path, payload }) =>
        (
          await fetch(`/link/api/${path}/cancel`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
        ).json(),
      { path, payload },
    )) as { receipt: { replay?: true } }
    expect(replay.receipt).toEqual({ ...first.receipt, replay: true })
    const afterDelegation = await teamMembers()
    expect(afterDelegation.filter(message => historicalMembers.some(previous => previous.id === message.id))).toEqual(historicalMembers)
    expect(afterDelegation.filter(message => message.subagent?.status === 'cancelled')).toHaveLength(1)
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()

    await owner.json(`${path}/prompt`, {
      method: 'POST',
      body: { prompt: 'team 孙成员停止夹具', requestId: randomUUID() },
    })
    await expect
      .poll(async () => {
        const detail = await read()
        return detail.messages
          .filter(message => message.role === 'assistant' && message.state === 'completed')
          .map(message => message.text)
          .join('')
          .includes('Lead and direct members have finished')
          ? detail.summary.status
          : undefined
      })
      .toBe('running')
    await teamEntry.click()
    await selectDelegation(4)
    await cedar.getByText('已完成', { exact: true }).waitFor()
    await maple.getByText('已完成', { exact: true }).waitFor()
    await reachable(stop)
    const nestedCancel = cancelResponse()
    await stop.tap()
    expect((await (await nestedCancel).json()).receipt).toMatchObject({ outcome: 'stopped', status: 'cancelled' })
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()

    const settledMembers = await teamMembers()
    await owner.json(`${path}/prompt`, {
      method: 'POST',
      body: { prompt: 'sleep 普通会话运行', requestId: randomUUID() },
    })
    await expect.poll(async () => (await read()).summary.status).toBe('running')
    const ordinaryRunId = (await read()).summary.runId
    expect(ordinaryRunId).toEqual(expect.any(String))
    expect(ordinaryRunId).not.toBe(runId)
    await teamEntry.click()
    await selectDelegation(1)
    await dialog.getByText('1. 核对移动端和审批回执', { exact: true }).waitFor()
    await reachable(stop)
    if (output) await page.screenshot({ path: join(output, 'team-history-ordinary-run-390-dark.png'), animations: 'disabled' })
    const ordinaryCancel = cancelResponse()
    await stop.tap()
    const ordinaryResponse = await ordinaryCancel
    expect(ordinaryResponse.ok()).toBe(true)
    const ordinaryPayload = ordinaryResponse.request().postDataJSON() as { runId: string; requestId: string }
    expect(ordinaryPayload).toMatchObject({ runId: ordinaryRunId, requestId: expect.any(String) })
    expect((await ordinaryResponse.json()).receipt).toMatchObject({ ...ordinaryPayload, outcome: 'stopped', status: 'cancelled' })
    expect(await teamMembers()).toEqual(settledMembers)
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()

    // A Codex session that is a member of a team offers no 「用团队分工」, Codex's own subagents included.
    const other = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { harnessId: 'codex', prompt: 'echo 另一个会话', requestId: randomUUID() },
    })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${other.sessionId}`)).summary.status).toBe('idle')
    const { team } = await owner.json<TeamAnswer>(`tasks/${other.sessionId}/team`, {
      method: 'POST',
      body: { requestId: randomUUID(), tasks: [{ title: '成员', prompt: 'echo 成员', harnessId: 'codex' }] },
    })
    const memberId = team.members[0]!.sessionId!
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${memberId}`)).codexTeam).toBe('available')
    await openSession(page, memberId)
    await page.locator('.team-member-line').waitFor()
    expect(await open('用团队分工').count()).toBe(0)
  } finally {
    await browser?.close()
    await host?.close()
    await rm(root, { recursive: true, force: true })
  }
})
