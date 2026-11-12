import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, test, vi } from 'vitest'
import { CustomAgents, MAX_AGENT_PENDING, type AgentActor } from '../src/custom-agents.ts'
import { AGENT_ACTIONS } from '../src/audit-actions/agents.ts'

const roots: string[] = []
const stores: CustomAgents[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const actor: AgentActor = { actor: { deviceId: 'dev_owner', listener: 'unix' }, authorize: () => {} }
let clock = Date.parse('2026-11-01T00:00:00Z')
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'latch-schedule-proposals-'))
  roots.push(dataDir)
  const audit = { append: vi.fn(async () => undefined as never) }
  const open = () => CustomAgents.open({ dataDir, audit, now: () => (clock += 1000) })
  const store = await open()
  stores.push(store)
  const agent = (
    await store.create(
      { requestId: randomUUID(), name: '资讯', description: '', harnessId: 'standard', mode: 'agent', instructions: '', skills: [] },
      actor,
    )
  ).value
  return { audit, store, open, agent }
}
const schedule = (owner: string, key: string, plan: unknown = { kind: 'daily', time: '08:00' }, prompt = '整理 AI 新闻') => ({
  owner,
  key,
  content: prompt,
  schedule: { name: '早间精选', plan },
  origin: 'agent' as const,
  external: false,
  source: { sessionId: 'session-1', messageId: 'msg-1' },
  actor: { listener: 'host' as const },
})

test('a schedule proposal is kept pending with its plan, once per key, audited without text, and survives a reopen', async () => {
  const { store, audit, agent, open } = await fixture()
  const first = await store.propose(schedule(agent.id, 'call:1', { kind: 'weekly', day: 1, time: '20:30' }))
  expect(first).toMatchObject({
    kind: 'schedule',
    schedule: { name: '早间精选', plan: { kind: 'weekly', day: 1, time: '20:30' } },
    content: '整理 AI 新闻',
    state: 'pending',
  })
  expect((await store.propose(schedule(agent.id, 'call:1', { kind: 'weekly', day: 1, time: '20:30' }))).id).toBe(first.id)
  const row = audit.append.mock.calls
    .map(call => (call as unknown[])[0] as { action: string; detail: unknown })
    .find(entry => entry.action === 'agent.memory.proposed')!
  expect(AGENT_ACTIONS['agent.memory.proposed'].safeParse(row.detail).success).toBe(true)
  expect(row.detail).toEqual({ origin: 'agent', external: false, customAgentId: agent.id, kind: 'schedule' })
  expect(JSON.stringify(audit.append.mock.calls)).not.toMatch(/早间|新闻/u)
  await store.close()
  stores.splice(0)
  const again = await open()
  stores.push(again)
  expect(again.proposals(agent.id)).toEqual([first])
})

test.each([
  ['no time', { kind: 'daily' }],
  ['a bad time', { kind: 'daily', time: '25:00' }],
  ['a day on a daily plan', { kind: 'daily', day: 1, time: '08:00' }],
  ['no day on a weekly plan', { kind: 'weekly', time: '08:00' }],
  ['an unknown kind', { kind: 'hourly', time: '08:00' }],
  ['text', 'every morning'],
])('refuses a plan with %s, in English and storing nothing', async (_label, plan) => {
  const { store, agent, audit } = await fixture()
  const before = audit.append.mock.calls.length
  const refusal = await store.propose(schedule(agent.id, 'call:x', plan)).catch((error: unknown) => error)
  expect(refusal).toMatchObject({ status: 400, code: 'agent-schedule-invalid' })
  expect((refusal as Error).message).toMatch(/^The plan must be/u)
  expect(store.proposals(agent.id)).toEqual([])
  expect(audit.append.mock.calls.length).toBe(before)
})

test('refuses secrets, a person as its origin, an empty or long prompt, and shares the agent pending cap with memories', async () => {
  const { store, agent } = await fixture()
  await expect(store.propose(schedule(agent.id, 'a', undefined, '用 sk-proj-abcdefghijklmnopqrstuvwxyz0123 登录'))).rejects.toMatchObject({
    code: 'agent-memory-secret',
    message: expect.stringMatching(/^It looks like a secret/u),
  })
  await expect(store.propose({ ...schedule(agent.id, 'b'), origin: 'user' })).rejects.toMatchObject({ code: 'agent-proposal-kind' })
  await expect(store.propose(schedule(agent.id, 'c', undefined, 'x'.repeat(4001)))).rejects.toMatchObject({
    code: 'agent-schedule-invalid',
  })
  await expect(
    store.propose({ ...schedule(agent.id, 'd'), schedule: { name: '', plan: { kind: 'daily', time: '08:00' } } }),
  ).rejects.toMatchObject({
    code: 'agent-schedule-invalid',
  })
  for (let index = 0; index < MAX_AGENT_PENDING; index++)
    await store.propose(
      index % 2
        ? schedule(agent.id, `s${index}`)
        : { ...schedule(agent.id, `m${index}`), schedule: undefined, content: `记住第 ${index} 条` },
    )
  await expect(store.propose(schedule(agent.id, 'over'))).rejects.toMatchObject({
    code: 'agent-proposal-limit',
    message: expect.stringMatching(/^Too many of your proposals/u),
  })
})

test('saving it marks the schedule it became, once; it cannot be saved as a memory; dismiss sets it aside', async () => {
  const { store, agent } = await fixture()
  const one = await store.propose(schedule(agent.id, 'one'))
  const two = await store.propose(schedule(agent.id, 'two'))
  await expect(store.saveProposal(agent.id, one.id, randomUUID(), actor)).rejects.toMatchObject({ code: 'agent-proposal-kind' })
  const automationId = `auto_${randomUUID()}`
  const requestId = randomUUID()
  const saved = await store.scheduleSaved(agent.id, one.id, { requestId, automationId }, actor)
  expect(saved.value.proposal).toMatchObject({ state: 'saved', automationId })
  expect((await store.scheduleSaved(agent.id, one.id, { requestId, automationId }, actor)).value.proposal?.automationId).toBe(automationId)
  // Another request for the same schedule finds it saved already; for another schedule, it was decided.
  expect((await store.scheduleSaved(agent.id, one.id, { requestId: randomUUID(), automationId }, actor)).value.proposal?.state).toBe(
    'saved',
  )
  await expect(
    store.scheduleSaved(agent.id, one.id, { requestId: randomUUID(), automationId: `auto_${randomUUID()}` }, actor),
  ).rejects.toMatchObject({ code: 'agent-proposal-decided' })
  await store.dismissProposal(agent.id, two.id, randomUUID(), actor)
  await expect(store.scheduleSaved(agent.id, two.id, { requestId: randomUUID(), automationId }, actor)).rejects.toMatchObject({
    code: 'agent-proposal-decided',
  })
  const memory = await store.propose({ ...schedule(agent.id, 'mem'), schedule: undefined, content: '喜欢短回答' })
  await expect(store.scheduleSaved(agent.id, memory.id, { requestId: randomUUID(), automationId }, actor)).rejects.toMatchObject({
    code: 'agent-proposal-kind',
  })
})
