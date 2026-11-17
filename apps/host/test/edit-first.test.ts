import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppSnapshot, CustomAgentList, TaskDetail, WorkProposalSummary } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { startTestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const SLOW = { timeout: 120_000 }
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const TODO = { title: '给 README 加安装一节', prompt: '在 README.md 末尾加「安装」一节。' }
const board = `board ${JSON.stringify({ tool: 'propose_todo', args: TODO })}`

const echo: HarnessPlugin = {
  id: 'edit-first-model',
  name: 'fixture',
  version: '1',
  description: '',
  activate(ctx) {
    ctx.registerProvider({
      id: 'edit-first',
      name: 'fixture',
      model: 'fixture',
      async *stream() {
        yield { type: 'text', text: 'ok' }
        yield { type: 'finish', reason: 'stop' }
      },
    })
  },
}
const model = { providerId: 'edit-first', model: 'fixture' }

async function fixture() {
  const t = await startTestHost({ demo: false, plugins: [echo] })
  cleanups.push(() => t.close())
  const root = await mkdtemp(join(tmpdir(), 'latch-edit-first-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const owner = await t.enroll({ listener: 'unix' })
  await owner.confirmedJson('agents', {
    body: {
      id: 'fake',
      name: 'Fake',
      command: process.execPath,
      args: [FAKE_ACP_AGENT],
      env: { FAKE_ACP_MCP: 'dsh', FAKE_ACP_STATE: join(root, 'state.json') },
    },
  })
  return { t, owner }
}

async function settled(device: TestDevice, sessionId: string): Promise<TaskDetail> {
  let detail: TaskDetail | undefined
  await vi.waitFor(
    async () => {
      detail = await device.json<TaskDetail>(`tasks/${sessionId}`)
      expect(['idle', 'completed', 'failed', 'cancelled']).toContain(detail.summary.status)
    },
    { timeout: 20_000, interval: 50 },
  )
  return detail!
}

async function start(owner: TestDevice, body: Record<string, unknown>): Promise<string> {
  const response = await owner.confirmed('tasks', { method: 'POST', body: { requestId: randomUUID(), ...body } })
  expect(response.status).toBe(201)
  const { sessionId } = (await response.json()) as { sessionId: string }
  await settled(owner, sessionId)
  return sessionId
}

async function proposed(owner: TestDevice, sessionId: string): Promise<WorkProposalSummary> {
  await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: board, requestId: randomUUID() } })
  await settled(owner, sessionId)
  let found: WorkProposalSummary | undefined
  await vi.waitFor(async () => {
    found = ((await owner.json<AppSnapshot>('snapshot')).workProposals ?? []).filter(row => row.from.sessionId === sessionId).at(-1)
    expect(found).toBeDefined()
  })
  return found!
}

it('starts an edit of a first message as private as its source, for a device that could not read the source', SLOW, async () => {
  const { t, owner } = await fixture()
  // 通用 has instructions while the source runs, so the source is private from its first turn; then they are gone, so
  // nothing but the source makes the edit private.
  const list = await owner.json<CustomAgentList>('custom-agents')
  await owner.json('custom-agents/general', {
    method: 'PATCH',
    body: { requestId: randomUUID(), baseRevision: list.general.revision, instructions: 'PRIVATE RULES' },
  })
  const source = await start(owner, { prompt: 'Plain', mode: 'chat', harnessId: 'standard', model })
  expect((await owner.json<TaskDetail>(`tasks/${source}`)).summary).toMatchObject({ agentPrivate: true })
  const again = await owner.json<CustomAgentList>('custom-agents')
  await owner.json('custom-agents/general', {
    method: 'PATCH',
    body: { requestId: randomUUID(), baseRevision: again.general.revision, instructions: '' },
  })
  const plain = await start(owner, { prompt: 'Plain', mode: 'chat', harnessId: 'standard', model })
  expect((await owner.json<TaskDetail>(`tasks/${plain}`)).summary).not.toHaveProperty('agentPrivate')

  const edited = await start(owner, { prompt: 'Plain, edited', mode: 'chat', harnessId: 'standard', model, editOf: { taskId: source } })
  expect((await owner.json<TaskDetail>(`tasks/${edited}`)).summary).toMatchObject({ agentPrivate: true })
  const work = await t.enroll({ listener: 'loopback-tcp' })
  await owner.json(`devices/${work.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
  const sourceStatus = (await work.request(`tasks/${source}`)).status
  expect(sourceStatus).not.toBe(200)
  expect((await work.request(`tasks/${edited}`)).status).toBe(sourceStatus)
  // That device cannot start an edit of what it cannot read.
  const refused = await work.request('tasks', {
    method: 'POST',
    body: { requestId: randomUUID(), prompt: 'x', mode: 'chat', harnessId: 'standard', model, editOf: { taskId: source } },
  })
  expect(refused.status).not.toBe(201)
  // An edit of a session that is not private is not private either.
  const open = await start(owner, { prompt: 'Plain, edited', mode: 'chat', harnessId: 'standard', model, editOf: { taskId: plain } })
  expect((await owner.json<TaskDetail>(`tasks/${open}`)).summary).not.toHaveProperty('agentPrivate')
})

it('marks an edit of a first message that came from outside content: what it proposes next is external', SLOW, async () => {
  const { owner } = await fixture()
  // A session a handoff started: its first message is the handed-over material.
  const from = await start(owner, { prompt: 'echo 计划写好了', harnessId: 'fake', mode: 'agent' })
  const reply = (await owner.json<TaskDetail>(`tasks/${from}`)).messages.find(message => message.role === 'assistant')!
  const created = await owner.confirmed('handoffs', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      sourceSessionId: from,
      target: { kind: 'new-session', harnessId: 'fake', mode: 'agent' },
      materials: [{ kind: 'message', messageId: reply.id, hash: sha(reply.text) }],
      requirements: 'echo 照着做',
      decisions: [],
      returnScope: 'none',
    },
  })
  expect(created.status).toBe(201)
  const { targetSessionId: handed } = (await created.json()) as { targetSessionId: string }
  await settled(owner, handed)
  const edited = await start(owner, { prompt: 'echo 改过的要求', harnessId: 'fake', mode: 'agent', editOf: { taskId: handed } })
  expect((await proposed(owner, edited)).external).toBe(true)
  // The edit of an ordinary session's first message proposes as itself.
  const quiet = await start(owner, { prompt: 'echo 只说话', harnessId: 'fake', mode: 'agent' })
  const plain = await start(owner, { prompt: 'echo 改过', harnessId: 'fake', mode: 'agent', editOf: { taskId: quiet } })
  expect((await proposed(owner, plain)).external).toBeUndefined()
})
