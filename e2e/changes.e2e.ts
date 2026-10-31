import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  splitChangeNote,
  type ChangeList,
  type ChangeReceipt,
  type DiscardPreview,
  type TaskDetail,
  type TurnChanges,
} from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { startTestHost } from './helpers/host.ts'

const SLOW = { timeout: 30_000 }

test('a turn with a shell edit: attribution, undo, redo, the note to the engine, and the confirmed discard', async () => {
  const t = await startTestHost()
  try {
    const file = (name: string) => join(t.workspaceRoot, name)
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: t.workspaceRoot, stdio: 'pipe' })
    git('init', '-q', '-b', 'main')
    git('commit', '-q', '--allow-empty', '-m', 'first')

    const owner = await t.enroll({ listener: 'unix' })
    const agentLog = join(t.root, 'agent.log')
    const saved = await owner.request('agents', {
      method: 'POST',
      body: { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_LOG: agentLog } },
    })
    expect(saved.status).toBe(201)
    const created = await owner.confirmed('tasks', {
      method: 'POST',
      body: { prompt: 'shell-edit', requestId: randomUUID(), mode: 'agent', harnessId: 'fake', workspaceId: 'default' },
    })
    expect(created.status).toBe(201)
    const { sessionId } = (await created.json()) as { sessionId: string }
    const path = `tasks/${sessionId}/changes`
    const lastTurn = async () => (await owner.json<{ turns: TurnChanges[] }>(`${path}/turns`)).turns.at(-1)
    await expect.poll(async () => (await lastTurn())?.state, SLOW).toBe('settled')
    const turnId = (await lastTurn())!.turnId

    // The agent reported one edit; the other came from the command it ran, on the real session's real folder.
    const turn = await owner.json<ChangeList>(`${path}?scope=turn`)
    expect(turn.turnId).toBe(turnId)
    expect(turn.totals).toEqual({ files: 2, add: 2, del: 0 })
    expect(turn.files).toEqual([
      { root: 'default', path: 'agent-edit.txt', status: 'A', add: 1, del: 0 },
      { root: 'default', path: 'command-edit.txt', status: 'A', add: 1, del: 0, byCommand: true },
    ])
    expect((await owner.json<ChangeList>(`${path}?scope=session`)).files.map(item => item.byCommand ?? false)).toEqual([false, true])
    expect((await owner.json<ChangeList>(`${path}?scope=uncommitted`)).files.map(item => item.path)).toEqual([
      'agent-edit.txt',
      'command-edit.txt',
    ])

    const act = async (action: 'undo' | 'redo') =>
      owner.json<ChangeReceipt>(`tasks/${sessionId}/turns/${turnId}/${action}`, { method: 'POST', body: { requestId: randomUUID() } })
    expect(await act('undo')).toMatchObject({ removed: 2, notRestored: [], noteNextTurn: true })
    expect(existsSync(file('command-edit.txt'))).toBe(false)
    expect((await owner.json<ChangeList>(`${path}?scope=turn`)).undone).toBe(true)
    expect(await act('redo')).toMatchObject({ restored: 2, noteNextTurn: false })
    expect(await readFile(file('agent-edit.txt'), 'utf8')).toBe('edited by the agent\n')
    expect(await act('undo')).toMatchObject({ noteNextTurn: true })

    // The next message says so, in the conversation and to the engine.
    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'echo carry on', requestId: randomUUID() } })
    const opener = async () =>
      (await owner.json<TaskDetail>(`tasks/${sessionId}`)).messages.findLast(message => message.role === 'user')?.text ?? ''
    await expect.poll(opener, SLOW).toContain('echo carry on')
    expect(splitChangeNote(await opener())).toMatchObject({ text: 'echo carry on', note: expect.stringContaining('用户撤销了 1 轮改动') })
    await expect.poll(() => readFile(agentLog, 'utf8').catch(() => ''), SLOW).toContain('用户撤销了 1 轮改动')
    await expect.poll(async () => (await lastTurn())?.state, SLOW).toBe('settled')

    // 撤销全部改动: asks first, names what it deletes and that nothing brings it back.
    await act('redo')
    const refused = await owner.request(`${path}/discard`, { method: 'POST', body: { scope: 'uncommitted' } })
    expect(refused.status).toBe(409)
    const preview = await owner.json<DiscardPreview>(`${path}/discard/preview`, { method: 'POST', body: {} })
    expect(preview.remove).toBe(2)
    expect(preview.warning).toMatch(/删除 2 个.*未跟踪.*无法撤销/u)
    expect(existsSync(file('command-edit.txt'))).toBe(true)
    await owner.json(`${path}/discard`, { method: 'POST', body: { scope: 'uncommitted', confirm: preview.planHash } })
    expect(existsSync(file('agent-edit.txt'))).toBe(false)
    expect(existsSync(file('command-edit.txt'))).toBe(false)
    expect((await owner.json<ChangeList>(`${path}?scope=uncommitted`)).files).toEqual([])
  } finally {
    await t.close()
  }
})
