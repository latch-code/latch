import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { startTestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function dirs() {
  const root = await mkdtemp(join(tmpdir(), 'latch-restart-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return { dataDir: join(root, 'data'), workspaceRoot: join(root, 'workspace') }
}

function expectInterrupted(detail: TaskDetail, toolId: string) {
  // Interrupted, never done and never a cancel by anyone.
  expect(detail.summary).toMatchObject({ status: 'interrupted', runOutcome: 'interrupted', runEnd: { reason: 'host-stopped' } })
  expect(detail.summary.runEnd?.unknownResults).toEqual([{ messageId: toolId, name: '运行长任务' }])
  const tool = detail.messages.find(message => message.id === toolId)!
  // The call had started: what it did is unknown, and the row says neither that it ran to the end nor that it did not.
  expect(tool).toMatchObject({ state: 'failed', interrupted: true })
  expect(tool.text).toContain('TOOL_OUTCOME_UNKNOWN')
  expect(tool.text).not.toContain('已完成')
  const note = detail.messages.at(-1)!
  expect(note).toMatchObject({ role: 'system', state: 'cancelled', interrupted: true })
  expect(note.text).toContain('Latch 重启时中断')
  expect(detail.messages.some(message => message.text.includes('长任务已完成'))).toBe(false)
}

it('marks a built-in turn the Host stopped mid-tool as interrupted, with the tool result unknown, after the restart', async () => {
  const where = await dirs()
  const first = await startTestHost(where)
  const running = await first.host.bridge.createTask({ prompt: '运行 30 秒长任务', requestId: randomUUID() })
  let toolId = ''
  await expect
    .poll(async () => {
      const tool = (await first.host.bridge.detail(running.sessionId)).messages.find(m => m.role === 'tool' && m.state === 'running')
      toolId = tool?.id ?? ''
      return toolId
    })
    .not.toBe('')
  await first.close()
  const second = await startTestHost(where)
  cleanups.push(() => second.close())
  expectInterrupted(await second.host.bridge.detail(running.sessionId), toolId)
})

it('marks a fake ACP turn the Host stopped mid-tool as interrupted after the restart, and offers no claim about the tool', async () => {
  const where = await dirs()
  const first = await startTestHost(where)
  const owner = await first.enroll({ listener: 'unix' })
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
    body: { prompt: 'hang', requestId: randomUUID(), mode: 'agent', harnessId: 'fake', workspaceId: 'default' },
  })
  expect(created.status).toBe(201)
  const { sessionId } = (await created.json()) as { sessionId: string }
  await expect
    .poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).messages.find(m => m.role === 'tool')?.state, {
      timeout: 15_000,
    })
    .toBe('running')
  await first.close()
  const second = await startTestHost(where)
  cleanups.push(() => second.close())
  const detail = await second.host.bridge.detail(sessionId)
  expect(detail.summary).toMatchObject({ status: 'interrupted', runOutcome: 'interrupted', runEnd: { reason: 'host-stopped' } })
  expect(detail.messages.find(m => m.role === 'tool')).toMatchObject({ state: 'failed', interrupted: true })
  expect(detail.messages.at(-1)).toMatchObject({ role: 'system', interrupted: true, text: expect.stringContaining('Latch 重启时中断') })
})
