import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import type {
  AgentActivityPage,
  AgentLibraryPage,
  AppSnapshot,
  Automation,
  AutomationDetail,
  CustomAgent,
  MemoryProposal,
  MemoryProposalList,
  ScheduleResultList,
  TaskDetail,
} from '@latch/protocol'
import { AppError, type HarnessPlugin } from '@latch/sdk'
import { saveFromProposal } from '../src/routes/automations.ts'
import type { Automations } from '../src/automations.ts'
import type { AgentActor } from '../src/custom-agents.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const hosts: TestHost[] = []
const roots: string[] = []
afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** Proposes a schedule when asked: `schedule` with a good plan, `schedule bad` with one the scheduler refuses. */
const plugin: HarnessPlugin = {
  id: 'scheduling-provider',
  name: 'fixture',
  version: '1',
  description: '',
  activate(ctx) {
    ctx.registerProvider({
      id: 'scheduling-provider',
      name: 'fixture',
      model: 'fixture',
      async *stream({ messages, tools }) {
        const last = messages.at(-1)
        const asked = last?.role === 'user' ? JSON.stringify(last) : ''
        if (asked.includes('schedule') && tools.some(tool => tool.name === 'propose_schedule')) {
          const plan = asked.includes('bad') ? { kind: 'hourly', time: '08:00' } : { kind: 'weekdays', time: '08:30' }
          yield {
            type: 'tool-call',
            call: { id: `call-${randomUUID()}`, name: 'propose_schedule', arguments: { name: '早间精选', plan, prompt: '整理新闻' } },
          }
          yield { type: 'finish', reason: 'tool-calls' }
          return
        }
        if (last?.role === 'tool') {
          yield { type: 'text', text: `tool said: ${JSON.stringify(last)}` }
          yield { type: 'finish', reason: 'stop' }
          return
        }
        yield { type: 'text', text: '今天的三条新闻' }
        yield { type: 'finish', reason: 'stop' }
      },
    })
  },
}
const model = { providerId: 'scheduling-provider', model: 'fixture' }

async function fixture() {
  const host = await startTestHost({ plugins: [plugin] })
  hosts.push(host)
  const owner = await host.enroll({ listener: 'unix' })
  const agent = await owner.json<CustomAgent>('custom-agents', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      name: '资讯',
      description: '',
      harnessId: 'standard',
      mode: 'chat',
      model,
      instructions: '',
      skills: [],
    },
  })
  return { host, owner, agent }
}
const settled = (owner: Awaited<ReturnType<TestHost['enroll']>>, id: string) =>
  expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${id}`)).summary.status).toBe('idle')

test('the built-in Harness proposes a schedule, an invalid plan is refused to it in English, and saving it marks the proposal', async () => {
  const { owner, agent } = await fixture()
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { customAgentId: agent.id, prompt: 'schedule bad', requestId: randomUUID() },
  })
  await settled(owner, sessionId)
  const refused = await owner.json<TaskDetail>(`tasks/${sessionId}`)
  expect(JSON.stringify(refused.messages)).toContain('The plan must be')
  const list = () => owner.json<MemoryProposalList>(`custom-agents/${agent.id}/proposals`)
  expect((await list()).proposals).toEqual([])

  await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'schedule please', requestId: randomUUID() } })
  await settled(owner, sessionId)
  await expect.poll(async () => (await list()).proposals.length).toBe(1)
  const proposal = (await list()).proposals[0] as MemoryProposal
  expect(proposal).toMatchObject({
    kind: 'schedule',
    schedule: { name: '早间精选', plan: { kind: 'weekdays', time: '08:30' } },
    content: '整理新闻',
    origin: 'agent',
    external: false,
    state: 'pending',
    source: { sessionId },
  })
  // Nothing runs before the person saves it.
  expect((await owner.json<{ automations: Automation[] }>('automations')).automations).toEqual([])
  // A proposal of another owner, or one that is not a schedule, is refused before anything is saved.
  const create = {
    requestId: randomUUID(),
    name: '早间精选',
    customAgentId: agent.id,
    prompt: '整理新闻',
    schedule: { kind: 'weekdays', time: '08:30' },
    notify: false,
    proposalId: proposal.id,
  }
  const other = await owner.request('automations', {
    method: 'POST',
    body: { ...create, requestId: randomUUID(), customAgentId: undefined },
  })
  expect(other.status).toBe(404)
  expect((await owner.json<{ automations: Automation[] }>('automations')).automations).toEqual([])
  const saved = await owner.json<Automation>('automations', { method: 'POST', body: create })
  expect(saved).not.toHaveProperty('proposalId')
  const again = await owner.json<Automation>('automations', { method: 'POST', body: create })
  expect(again.id).toBe(saved.id)
  expect((await list()).proposals[0]).toMatchObject({ state: 'saved', automationId: saved.id })
  // Another request cannot save it a second time, and creates nothing.
  expect((await owner.request('automations', { method: 'POST', body: { ...create, requestId: randomUUID() } })).status).toBe(409)
  expect((await owner.json<{ automations: Automation[] }>('automations')).automations).toHaveLength(1)
})

test('a run settles into the current topic as a card, and 动态, 资料库 and the cards reach only a full-scope device', async () => {
  const { host, owner, agent } = await fixture()
  const { sessionId: topic } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { customAgentId: agent.id, prompt: '你好', requestId: randomUUID() },
  })
  await settled(owner, topic)
  const automation = await owner.json<Automation>('automations', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      name: '早间精选',
      customAgentId: agent.id,
      prompt: '整理',
      schedule: { kind: 'daily', time: '09:00' },
      notify: false,
    },
  })
  await owner.json(`automations/${automation.id}/run`, { method: 'POST', body: { requestId: randomUUID() } })
  await expect
    .poll(async () => (await owner.json<AutomationDetail>(`automations/${automation.id}`)).automation.lastRun?.state, { timeout: 8000 })
    .toBe('completed')
  const run = (await owner.json<AutomationDetail>(`automations/${automation.id}`)).automation.lastRun!.sessionId!
  await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${topic}`)).results?.length ?? 0, { timeout: 8000 }).toBe(1)
  const detail = await owner.json<TaskDetail>(`tasks/${topic}`)
  expect(detail.results![0]).toMatchObject({
    automationId: automation.id,
    name: '早间精选',
    outcome: 'completed',
    sessionId: run,
    topicId: topic,
    reply: '今天的三条新闻',
  })
  // The card is no message: the topic's history and what the Harness was sent did not change.
  expect(detail.messages.map(message => message.role)).toEqual(['user', 'assistant'])
  expect((await owner.json<ScheduleResultList>(`custom-agents/${agent.id}/results`)).results).toEqual([])
  const snapshot = await owner.json<AppSnapshot>('snapshot')
  expect(snapshot.agentResults?.[agent.id]).toMatchObject({ unbound: 0 })

  const activity = await owner.json<AgentActivityPage>(`custom-agents/${agent.id}/activity`)
  expect(activity.items.map(item => item.kind)).toEqual(['result', 'topic'])
  const library = await owner.json<AgentLibraryPage>(`custom-agents/${agent.id}/library`)
  expect(library.groups).toEqual([])

  const limited = await host.enroll({ listener: 'loopback-tcp' })
  await owner.json(`devices/${limited.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
  for (const path of ['activity', 'library', 'results'])
    expect((await limited.request(`custom-agents/${agent.id}/${path}`)).status).toBe(403)
  expect(await limited.json<AppSnapshot>('snapshot')).not.toHaveProperty('agentResults')
  expect((await limited.request(`tasks/${topic}`)).status).toBe(403)
  expect((await owner.request(`custom-agents/agt_${randomUUID()}/activity`)).status).toBe(404)
  expect((await owner.request(`custom-agents/${agent.id}/activity?before=nope`)).status).toBe(400)
})

test('without a topic the card waits, and the next topic keeps it before its first message', async () => {
  const { owner, agent } = await fixture()
  const automation = await owner.json<Automation>('automations', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      name: '晚间',
      customAgentId: agent.id,
      prompt: '整理',
      schedule: { kind: 'daily', time: '20:00' },
      notify: false,
    },
  })
  await owner.json(`automations/${automation.id}/run`, { method: 'POST', body: { requestId: randomUUID() } })
  const waiting = () => owner.json<ScheduleResultList>(`custom-agents/${agent.id}/results`)
  await expect.poll(async () => (await waiting()).results.length, { timeout: 8000 }).toBe(1)
  expect((await owner.json<AppSnapshot>('snapshot')).agentResults?.[agent.id]).toMatchObject({ unbound: 1 })
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { customAgentId: agent.id, prompt: '看看结果', requestId: randomUUID() },
  })
  expect((await waiting()).results).toEqual([])
  const detail = await owner.json<TaskDetail>(`tasks/${sessionId}`)
  expect(detail.results?.map(card => card.name)).toEqual(['晚间'])
  await settled(owner, sessionId)
})

/** A schedule proposal in a topic of 资讯, ready to be saved. */
async function proposed() {
  const { host, owner, agent } = await fixture()
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { customAgentId: agent.id, prompt: 'schedule please', requestId: randomUUID() },
  })
  await settled(owner, sessionId)
  const list = () => owner.json<MemoryProposalList>(`custom-agents/${agent.id}/proposals`)
  await expect.poll(async () => (await list()).proposals.length).toBe(1)
  const proposal = (await list()).proposals[0]!
  const body = (requestId = randomUUID()) => ({
    requestId,
    name: '早间精选',
    customAgentId: agent.id,
    prompt: '整理新闻',
    schedule: { kind: 'weekdays', time: '08:30' },
    notify: false,
    proposalId: proposal.id,
  })
  return { host, owner, agent, proposal, list, body }
}

test('two saves of one proposal at once make one schedule; the other is refused', async () => {
  const { owner, list, body } = await proposed()
  const answers = await Promise.all([
    owner.request('automations', { method: 'POST', body: body() }),
    owner.request('automations', { method: 'POST', body: body() }),
  ])
  expect(answers.map(answer => answer.status).toSorted()).toEqual([201, 409])
  const schedules = (await owner.json<{ automations: Automation[] }>('automations')).automations
  expect(schedules).toHaveLength(1)
  expect((await list()).proposals[0]).toMatchObject({ state: 'saved', automationId: schedules[0]!.id })
})

test('a mark that fails after the create is finished by the same request, and a new save creates nothing more', async () => {
  // The create and the mark around a lost answer, against the real stores of a Host.
  const created: string[] = []
  let failMark = true
  const marks: Array<{ automationId: string; requestId: string }> = []
  const service = {
    receipts: new Map<string, Automation>(),
    answered(_device: string, requestId: string) {
      return this.receipts.has(requestId)
    },
    async create(input: { requestId: string; proposalId?: string }) {
      const prior = this.receipts.get(input.requestId)
      if (prior) return { value: prior, audited: true }
      const first = [...this.receipts.values()][0]
      if (first) throw new AppError(409, 'agent-proposal-decided', '这条提议已经保存过了。', { automationId: first.id })
      const value = { id: `auto_${randomUUID()}` } as Automation
      created.push(value.id)
      this.receipts.set(input.requestId, value)
      return { value, audited: true }
    },
  }
  let state: 'pending' | 'saved' = 'pending'
  const deps = {
    proposalCheck: (_owner: string, _id: string, replay: boolean) => {
      if (state === 'saved' && !replay) throw new AppError(409, 'agent-proposal-decided', '这条提议已经处理过了。')
    },
    proposalSaved: vi.fn(async (_owner: string, _id: string, input: { requestId: string; automationId: string }) => {
      if (failMark) {
        failMark = false
        throw new AppError(503, 'agent-write-unknown', '结果未知')
      }
      marks.push(input)
      state = 'saved'
      return { audited: true }
    }),
  }
  const actor: AgentActor = { actor: { deviceId: 'dev_owner', listener: 'unix' }, authorize: () => {} }
  const body = {
    requestId: 'request-one',
    name: 'x',
    prompt: 'x',
    schedule: { kind: 'daily' as const, time: '08:00' },
    notify: false,
    proposalId: `prp_${randomUUID()}`,
  }
  const run = (input: typeof body) => saveFromProposal(service as unknown as Pick<Automations, 'create' | 'answered'>, deps, input, actor)
  await expect(run(body)).rejects.toMatchObject({ status: 503 })
  expect(created).toHaveLength(1)
  // The same request replays the create and finishes the mark.
  expect((await run(body)).value.id).toBe(created[0])
  expect(marks).toEqual([{ requestId: 'request-one', automationId: created[0] }])
  // Another request is refused before anything is created.
  await expect(run({ ...body, requestId: 'request-two' })).rejects.toMatchObject({ code: 'agent-proposal-decided' })
  expect(created).toHaveLength(1)
})

test('a later save after a failed mark is refused by the Host and marks the proposal with the first schedule', async () => {
  const { owner, list, body } = await proposed()
  const first = await owner.json<Automation>('automations', { method: 'POST', body: body() })
  // As if the first save's mark were lost: a second request finds the schedule saved from it and creates nothing.
  const second = await owner.request('automations', { method: 'POST', body: body() })
  expect(second.status).toBe(409)
  expect((await owner.json<{ automations: Automation[] }>('automations')).automations.map(item => item.id)).toEqual([first.id])
  expect((await list()).proposals[0]).toMatchObject({ state: 'saved', automationId: first.id })
})

test('a schedule moved to another Agent leaves its runs in the first Agent’s 动态 and 资料库', async () => {
  const { owner, agent } = await fixture()
  const other = await owner.json<CustomAgent>('custom-agents', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      name: '周报',
      description: '',
      harnessId: 'standard',
      mode: 'chat',
      model,
      instructions: '',
      skills: [],
    },
  })
  const automation = await owner.json<Automation>('automations', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      name: '早间精选',
      customAgentId: agent.id,
      prompt: '整理',
      schedule: { kind: 'daily', time: '09:00' },
      notify: false,
    },
  })
  await owner.json(`automations/${automation.id}/run`, { method: 'POST', body: { requestId: randomUUID() } })
  await expect
    .poll(async () => (await owner.json<AutomationDetail>(`automations/${automation.id}`)).automation.lastRun?.state, { timeout: 8000 })
    .toBe('completed')
  await expect
    .poll(async () => (await owner.json<ScheduleResultList>(`custom-agents/${agent.id}/results`)).results.length, { timeout: 8000 })
    .toBe(1)
  const current = (await owner.json<AutomationDetail>(`automations/${automation.id}`)).automation
  await owner.json(`automations/${automation.id}`, {
    method: 'PATCH',
    body: { requestId: randomUUID(), baseRevision: current.revision, customAgentId: other.id },
  })
  const moved = await owner.json<AgentActivityPage>(`custom-agents/${other.id}/activity`)
  expect(moved.items).toEqual([])
  const stayed = await owner.json<AgentActivityPage>(`custom-agents/${agent.id}/activity`)
  expect(stayed.items.map(item => item.kind)).toEqual(['result'])
})

test('a card bound to a session that is not private never reaches that session’s detail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'latch-cards-'))
  roots.push(root)
  const where = { dataDir: join(root, 'data'), workspaceRoot: join(root, 'workspace') }
  const first = await startTestHost({ ...where, plugins: [plugin] })
  const owner = await first.enroll({ listener: 'unix' })
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { prompt: 'hi', requestId: randomUUID(), model },
  })
  await settled(owner, sessionId)
  await first.close()
  // A card on a Code session, which no Host path makes: the detail must still leave it out.
  const path = join(where.dataDir, 'automations.json')
  const file = JSON.parse(await readFile(path, 'utf8').catch(() => '{"version":1,"rows":[],"results":[],"receipts":{}}'))
  file.results = [
    {
      id: `res_${'a'.repeat(40)}`,
      automationId: `auto_${randomUUID()}`,
      owner: 'general',
      name: '早间精选',
      outcome: 'completed',
      trigger: 'manual',
      runAt: '2026-11-13T08:00:00.000Z',
      at: '2026-11-13T08:01:00.000Z',
      topicId: sessionId,
      reply: '私有的回复',
    },
  ]
  await writeFile(path, JSON.stringify(file), { mode: 0o600 })
  const second = await startTestHost({ ...where, plugins: [plugin] })
  hosts.push(second)
  const again = await second.enroll({ listener: 'unix' })
  const limited = await second.enroll({ listener: 'loopback-tcp' })
  await again.json(`devices/${limited.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
  for (const device of [again, limited]) {
    const detail = await device.json<TaskDetail>(`tasks/${sessionId}`)
    expect(detail.summary.id).toBe(sessionId)
    expect(detail).not.toHaveProperty('results')
    expect(JSON.stringify(detail)).not.toContain('私有的回复')
  }
})
