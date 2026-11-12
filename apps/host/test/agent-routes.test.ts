import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import type {
  AppSnapshot,
  Automation,
  AutomationDetail,
  CustomAgent,
  CustomAgentDetail,
  CustomAgentList,
  GeneralAgent,
  GeneralAgentDetail,
  TaskDetail,
  WorkspaceInfo,
} from '@latch/protocol'
import type { HarnessPlugin, ModelMessage } from '@latch/sdk'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { startTestHost, type TestHost } from './helpers/host.ts'

const hosts: TestHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.close()
})
const plugin = (seen: ModelMessage[][]): HarnessPlugin => ({
  id: 'agent-provider',
  name: 'fixture',
  version: '1',
  description: '',
  activate(ctx) {
    ctx.registerSkill({ id: 'review', name: '审阅清单', description: '', content: 'CHECKLIST BODY' })
    ctx.registerProvider({
      id: 'agent-provider',
      name: 'fixture',
      model: 'fixture',
      async *stream({ messages }) {
        seen.push(structuredClone(messages))
        yield { type: 'text', text: 'Answer' }
        yield { type: 'finish', reason: 'stop' }
      },
    })
  },
})
const model = { providerId: 'agent-provider', model: 'fixture' }
const definition = (overrides = {}) => ({
  requestId: randomUUID(),
  name: '代码审阅',
  description: '只报真实的问题',
  harnessId: 'standard',
  mode: 'chat',
  model,
  instructions: 'AGENT INSTRUCTIONS',
  skills: [],
  ...overrides,
})
async function fixture(options: Parameters<typeof startTestHost>[0] = {}) {
  const seen: ModelMessage[][] = []
  const host = await startTestHost({ plugins: [plugin(seen)], ...options })
  hosts.push(host)
  const owner = await host.enroll({ listener: 'unix' })
  return { host, owner, seen }
}
const settled = (owner: Awaited<ReturnType<TestHost['enroll']>>, id: string) =>
  expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${id}`)).summary.status).toBe('idle')

test('announces the domain and starts a private session on an agent', async () => {
  const { owner, seen } = await fixture()
  const snapshot = await owner.json<AppSnapshot>('snapshot')
  expect(snapshot.catalog?.features).toMatchObject({ customAgents: true, automations: true })
  const agent = await owner.json<CustomAgent>('custom-agents', { method: 'POST', body: definition() })
  await owner.json(`custom-agents/${agent.id}/memories`, { method: 'POST', body: { requestId: randomUUID(), content: 'AGENT MEMORY' } })
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { customAgentId: agent.id, prompt: 'Review this', requestId: randomUUID() },
  })
  await settled(owner, sessionId)
  expect(seen[0]?.[1]?.content).toContain('AGENT INSTRUCTIONS')
  expect(seen[0]?.[1]?.content).toContain('AGENT MEMORY')
  const detail = await owner.json<TaskDetail>(`tasks/${sessionId}`)
  expect(detail.summary).toMatchObject({ agent: { customAgentId: agent.id }, harnessId: 'standard', mode: 'chat' })
  expect(JSON.stringify(detail)).not.toContain('AGENT INSTRUCTIONS')
  const after = await owner.json<AppSnapshot>('snapshot')
  expect(after.customAgents).toEqual([
    expect.objectContaining({ id: agent.id, name: '代码审阅', sessionCount: 1, memoryCount: 1, available: true, canAutomate: true }),
  ])
  expect(JSON.stringify(after.customAgents)).not.toContain('AGENT INSTRUCTIONS')
  const full = await owner.json<CustomAgentDetail>(`custom-agents/${agent.id}`)
  expect(full.agent.instructions).toBe('AGENT INSTRUCTIONS')
  expect(full.sessions.map(task => task.id)).toEqual([sessionId])
  // A later turn reads the definition as it stands.
  await owner.json(`custom-agents/${agent.id}`, {
    method: 'PATCH',
    body: { requestId: randomUUID(), baseRevision: agent.revision, instructions: 'NEW INSTRUCTIONS' },
  })
  await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'Again', requestId: randomUUID() } })
  await settled(owner, sessionId)
  expect(seen[1]?.[1]?.content).toContain('NEW INSTRUCTIONS')
  expect(seen[1]?.[1]?.content).not.toContain('AGENT INSTRUCTIONS')
})

test('a session of a deleted agent says so instead of running without it', async () => {
  const { owner } = await fixture()
  const agent = await owner.json<CustomAgent>('custom-agents', { method: 'POST', body: definition() })
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { customAgentId: agent.id, prompt: 'One', requestId: randomUUID() },
  })
  await settled(owner, sessionId)
  await owner.json(`custom-agents/${agent.id}`, { method: 'DELETE', body: { requestId: randomUUID() } })
  const response = await owner.request(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'Two', requestId: randomUUID() } })
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: 'agent-deleted' })
  expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).messages).toHaveLength(2)
})

test('choices in the request apply to that session only, and a retry cannot move engines', async () => {
  const { owner } = await fixture()
  const agent = await owner.json<CustomAgent>('custom-agents', { method: 'POST', body: definition({ mode: 'agent' }) })
  const request = { customAgentId: agent.id, prompt: 'Just talk', requestId: randomUUID(), mode: 'chat' }
  const first = await owner.json<{ sessionId: string }>('tasks', { method: 'POST', body: request })
  await settled(owner, first.sessionId)
  expect((await owner.json<TaskDetail>(`tasks/${first.sessionId}`)).summary.mode).toBe('chat')
  await owner.json(`custom-agents/${agent.id}`, {
    method: 'PATCH',
    body: { requestId: randomUUID(), baseRevision: 1, description: '改了说明' },
  })
  expect(await owner.json<{ sessionId: string }>('tasks', { method: 'POST', body: request })).toEqual(first)
  expect((await owner.json<AppSnapshot>('snapshot')).tasks).toHaveLength(1)
})

test('adding an engine changes nothing a live 通用 automation receives', async () => {
  const { owner } = await fixture()
  const { id } = await owner.json<Automation>('automations', {
    method: 'POST',
    body: { requestId: randomUUID(), name: 'Keep', model, prompt: 'Now', schedule: { kind: 'daily', time: '09:00' }, notify: false },
  })
  const defined = await owner.confirmed('agents', {
    method: 'POST',
    body: { id: 'fake-engine', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT], env: {} },
  })
  expect(defined.ok).toBe(true)
  await new Promise(resolve => setTimeout(resolve, 1200))
  expect((await owner.json<AutomationDetail>(`automations/${id}`)).automation).toMatchObject({ enabled: true, state: 'ready' })
  await owner.json(`automations/${id}/run`, { method: 'POST', body: { requestId: randomUUID() } })
  await expect
    .poll(async () => (await owner.json<AutomationDetail>(`automations/${id}`)).automation.lastRun?.state, { timeout: 8000 })
    .toBe('completed')
})

test('editing 通用 over and over never pauses its automations, with the real check running', async () => {
  const { owner } = await fixture()
  const ids: string[] = []
  for (const name of ['a', 'b', 'c'])
    ids.push(
      (
        await owner.json<Automation>('automations', {
          method: 'POST',
          body: { requestId: randomUUID(), name, model, prompt: 'Now', schedule: { kind: 'daily', time: '09:00' }, notify: false },
        })
      ).id,
    )
  const deadline = Date.now() + 1500
  for (let edit = 0; edit < 12 || Date.now() < deadline; edit++)
    await owner.json('custom-agents/general/memories', { method: 'POST', body: { requestId: randomUUID(), content: `memory ${edit}` } })
  for (const id of ids)
    expect((await owner.json<AutomationDetail>(`automations/${id}`)).automation).toMatchObject({ enabled: true, state: 'ready' })
})

test('stopping the Host leaves a live automation as it was, with no check against the closing Host', async () => {
  const { host, owner } = await fixture()
  const { id } = await owner.json<Automation>('automations', {
    method: 'POST',
    body: { requestId: randomUUID(), name: 'Keep', model, prompt: 'Now', schedule: { kind: 'daily', time: '09:00' }, notify: false },
  })
  await host.host.close()
  await new Promise(resolve => setTimeout(resolve, 1200))
  const saved = JSON.parse(await readFile(join(host.dataDir, 'automations.json'), 'utf8')) as {
    rows: Array<{ automation: Automation }>
  }
  expect(saved.rows.find(row => row.automation.id === id)?.automation).toMatchObject({ enabled: true, state: 'ready' })
})

test('通用 reaches only a device that may read it, and any session it reached is as private as an agent', async () => {
  const { host, owner, seen } = await fixture()
  const list = await owner.json<CustomAgentList>('custom-agents')
  await owner.json('custom-agents/general', {
    method: 'PATCH',
    body: { requestId: randomUUID(), baseRevision: list.general.revision, instructions: 'GENERAL RULES' },
  })
  await owner.json('custom-agents/general/memories', { method: 'POST', body: { requestId: randomUUID(), content: 'MY PRIVATE MEMORY' } })
  const work = await host.enroll({ listener: 'loopback-tcp' })
  await owner.json(`devices/${work.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
  const start = { mode: 'chat', model }

  // A device without the scope works as if 通用 were empty, and its session stays its own to read.
  const theirs = await work.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { ...start, prompt: 'Repeat', requestId: randomUUID() },
  })
  await settled(work, theirs.sessionId)
  await work.json(`tasks/${theirs.sessionId}/prompt`, { method: 'POST', body: { prompt: 'Again', requestId: randomUUID() } })
  await settled(work, theirs.sessionId)
  expect(JSON.stringify(seen)).not.toContain('MY PRIVATE MEMORY')
  expect((await work.json<TaskDetail>(`tasks/${theirs.sessionId}`)).summary).not.toHaveProperty('agentPrivate')

  // The first turn that carries it closes the session, for that turn's reply and everything after.
  await owner.json(`tasks/${theirs.sessionId}/prompt`, { method: 'POST', body: { prompt: 'Mine now', requestId: randomUUID() } })
  await settled(owner, theirs.sessionId)
  expect(JSON.stringify(seen.at(-1))).toContain('MY PRIVATE MEMORY')
  expect((await work.request(`tasks/${theirs.sessionId}`)).status).toBe(403)
  const refused = await work.request(`tasks/${theirs.sessionId}/prompt`, {
    method: 'POST',
    body: { prompt: 'Back', requestId: randomUUID() },
  })
  expect(refused.status).toBe(403)

  const mine = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { ...start, prompt: 'Plain', requestId: randomUUID() },
  })
  await settled(owner, mine.sessionId)
  expect((await owner.json<TaskDetail>(`tasks/${mine.sessionId}`)).summary).toMatchObject({ agentPrivate: true })
  expect((await work.request(`tasks/${mine.sessionId}`)).status).toBe(403)
  expect((await work.json<AppSnapshot>('snapshot')).tasks.map(task => task.id)).not.toContain(mine.sessionId)

  // A fork carries the private session's replies, so it stays private when 通用 has nothing to add.
  const emptied = await owner.json<CustomAgentList>('custom-agents')
  const memory = (await owner.json<GeneralAgentDetail>('custom-agents/general')).memories[0]!
  await owner.json(`custom-agents/general/memories/${memory.id}`, { method: 'DELETE', body: { requestId: randomUUID() } })
  await owner.json('custom-agents/general', {
    method: 'PATCH',
    body: { requestId: randomUUID(), baseRevision: emptied.general.revision, instructions: '' },
  })
  const source = await owner.json<TaskDetail>(`tasks/${mine.sessionId}`)
  const fork = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: {
      ...start,
      requestId: randomUUID(),
      prompt: 'Go on',
      forkOf: { taskId: mine.sessionId, upToMessageId: source.messages.at(-1)!.id },
    },
  })
  await settled(owner, fork.sessionId)
  expect((await work.request(`tasks/${fork.sessionId}`)).status).toBe(403)
})

test('a run of an automation on 通用 is private, since it shows the saved prompt', async () => {
  const { host, owner } = await fixture()
  const work = await host.enroll({ listener: 'loopback-tcp' })
  await owner.json(`devices/${work.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
  const automation = await owner.json<Automation>('automations', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      name: 'Run it',
      model,
      prompt: 'SAVED PROMPT',
      schedule: { kind: 'weekly', day: 5, time: '17:00' },
      notify: false,
    },
  })
  await owner.json(`automations/${automation.id}/run`, { method: 'POST', body: { requestId: randomUUID() } })
  await expect
    .poll(async () => (await owner.json<AutomationDetail>(`automations/${automation.id}`)).automation.lastRun?.sessionId, { timeout: 8000 })
    .toBeTruthy()
  const sessionId = (await owner.json<AutomationDetail>(`automations/${automation.id}`)).automation.lastRun!.sessionId!
  expect((await work.request(`tasks/${sessionId}`)).status).toBe(403)
  expect((await work.json<AppSnapshot>('snapshot')).tasks.map(task => task.id)).not.toContain(sessionId)
})

test('通用 reaches the sessions of a device that may read it, with no agent on them', async () => {
  const { owner, seen } = await fixture()
  const list = await owner.json<CustomAgentList>('custom-agents')
  expect(list.general).toMatchObject({ id: 'general', instructions: '', memoryCount: 0 })
  const general = await owner.json<GeneralAgent>('custom-agents/general', {
    method: 'PATCH',
    body: { requestId: randomUUID(), baseRevision: list.general.revision, instructions: 'GENERAL RULES', skills: [] },
  })
  expect(general.revision).toBe(list.general.revision + 1)
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { prompt: 'Plain', requestId: randomUUID(), mode: 'chat', model },
  })
  await settled(owner, sessionId)
  expect(seen[0]?.[1]?.content).toBe('GENERAL RULES')
  expect(seen[0]?.some(message => message.content.includes('CHECKLIST BODY'))).toBe(false)
  const summary = (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary
  expect(summary).not.toHaveProperty('agent')
  expect((await owner.request('custom-agents/general', { method: 'DELETE', body: { requestId: randomUUID() } })).status).toBe(404)
})

test("a conversation with 通用 is 我的 Agent's and private even while 通用 is empty, and needs the full data scope", async () => {
  const { host, owner } = await fixture()
  const work = await host.enroll({ listener: 'loopback-tcp' })
  await owner.json(`devices/${work.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
  // What a device with the work scope hears, from before the conversation starts.
  const controller = new AbortController()
  const stream = await work.request('events', { signal: controller.signal })
  expect(stream.status).toBe(200)
  let heard = ''
  const reader = stream.body!.getReader()
  const decoder = new TextDecoder()
  const reading = (async () => {
    for (;;) {
      const next = await reader.read()
      if (next.done) return
      heard += decoder.decode(next.value, { stream: true })
    }
  })().catch(() => {})
  try {
    // 通用 is empty: nothing private reaches the model, yet the conversation is as private as an Agent's.
    const body = { prompt: 'Hello', mode: 'chat', model, customAgentId: 'general' }
    const requestId = randomUUID()
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', { method: 'POST', body: { ...body, requestId } })
    await settled(owner, sessionId)
    const summary = (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary
    expect(summary).toMatchObject({ generalChat: true, agentPrivate: true })
    expect(summary).not.toHaveProperty('agent')
    // A retry with the same request is the same session; a plain session carries no mark.
    expect((await owner.json<{ sessionId: string }>('tasks', { method: 'POST', body: { ...body, requestId } })).sessionId).toBe(sessionId)
    const plain = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: 'Plain', mode: 'chat', model, requestId: randomUUID() },
    })
    await settled(owner, plain.sessionId)
    expect((await owner.json<TaskDetail>(`tasks/${plain.sessionId}`)).summary).not.toHaveProperty('generalChat')

    // The work device can neither read it, find it in its snapshot, hear of it nor send to it.
    expect((await work.request(`tasks/${sessionId}`)).status).toBe(403)
    const prompt = await work.request(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'Mine', requestId: randomUUID() } })
    expect(prompt.status).toBe(403)
    expect((await work.json<AppSnapshot>('snapshot')).tasks.map(task => task.id)).not.toContain(sessionId)
    // Its state never reaches the stream; only the bare refresh hint that names a session, as for every private one.
    const frames = heard.split('\n\n').filter(frame => frame.includes(sessionId))
    expect(frames.every(frame => frame.includes('event: tasks-invalidated'))).toBe(true)
    expect(heard).not.toContain('Hello')

    // It carries no project, worktree or fork; and a device that cannot read 通用 cannot start one.
    const project = await owner.request('tasks', { method: 'POST', body: { ...body, requestId: randomUUID(), workspaceId: 'wsp_other' } })
    expect(project.status).toBe(400)
    expect(await project.json()).toMatchObject({ error: 'general-chat-project' })
    const refused = await work.request('tasks', { method: 'POST', body: { ...body, requestId: randomUUID() } })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ error: 'agent-scope-required' })
  } finally {
    controller.abort()
    await reading
  }
})

test('a 通用 skill whose plugin went away drops out rather than stopping ordinary work', async () => {
  const seen: ModelMessage[][] = []
  const extra: HarnessPlugin = {
    id: 'extra-skills',
    name: 'extra',
    version: '1',
    description: '',
    activate(ctx) {
      ctx.registerSkill({ id: 'gone', name: '会消失', description: '', content: 'GONE BODY' })
    },
  }
  const host = await startTestHost({ plugins: [plugin(seen), extra] })
  hosts.push(host)
  const owner = await host.enroll({ listener: 'unix' })
  await host.host.registry.enable('extra-skills')
  const list = await owner.json<CustomAgentList>('custom-agents')
  await owner.json('custom-agents/general', {
    method: 'PATCH',
    body: { requestId: randomUUID(), baseRevision: list.general.revision, skills: ['extra-skills:gone'] },
  })
  const before = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { prompt: 'One', requestId: randomUUID(), mode: 'chat', model },
  })
  await settled(owner, before.sessionId)
  expect(JSON.stringify(seen.at(-1))).toContain('GONE BODY')
  await host.host.registry.disable('extra-skills')
  await owner.json(`tasks/${before.sessionId}/prompt`, { method: 'POST', body: { prompt: 'Two', requestId: randomUUID() } })
  await settled(owner, before.sessionId)
  const after = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { prompt: 'Three', requestId: randomUUID(), mode: 'chat', model },
  })
  await settled(owner, after.sessionId)
  expect(JSON.stringify(seen.slice(1))).not.toContain('GONE BODY')
})

test('an agent with chosen skills loads exactly those', async () => {
  const { owner, seen } = await fixture()
  const agent = await owner.json<CustomAgent>('custom-agents', { method: 'POST', body: definition({ skills: ['agent-provider:review'] }) })
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { customAgentId: agent.id, prompt: 'Go', requestId: randomUUID() },
  })
  await settled(owner, sessionId)
  expect(seen[0]?.some(message => message.content.includes('CHECKLIST BODY'))).toBe(true)
  expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.skills).toEqual(['agent-provider:review'])
})

test('a device without the full data scope sees neither agents, automations nor their sessions', async () => {
  const { host, owner } = await fixture()
  const agent = await owner.json<CustomAgent>('custom-agents', { method: 'POST', body: definition() })
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { customAgentId: agent.id, prompt: 'One', requestId: randomUUID() },
  })
  await settled(owner, sessionId)
  const limited = await host.enroll({ listener: 'loopback-tcp' })
  await owner.json(`devices/${limited.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
  expect((await limited.request('custom-agents')).status).toBe(403)
  expect((await limited.request('automations')).status).toBe(403)
  expect((await limited.request(`tasks/${sessionId}`)).status).toBe(403)
  const snapshot = await limited.json<AppSnapshot>('snapshot')
  expect(snapshot).not.toHaveProperty('customAgents')
  expect(snapshot).not.toHaveProperty('automations')
  expect(snapshot.tasks.map(task => task.id)).not.toContain(sessionId)
})

test('an automation runs on the built-in engine from any allowed device, and its run is marked', async () => {
  let clock = Date.parse('2026-11-02T08:00:00Z')
  const { owner, seen } = await fixture({ now: () => clock })
  const agent = await owner.json<CustomAgent>('custom-agents', { method: 'POST', body: definition() })
  const created = await owner.json<Automation>('automations', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      name: '每日依赖检查',
      customAgentId: agent.id,
      prompt: 'Check deps',
      schedule: { kind: 'daily', time: '09:00' },
      notify: true,
    },
  })
  expect(created).toMatchObject({ enabled: true, state: 'ready' })
  const snapshot = await owner.json<AppSnapshot>('snapshot')
  expect(snapshot.automations?.[0]).toMatchObject({ id: created.id, name: '每日依赖检查', enabled: true })
  expect(snapshot.automations?.[0]).not.toHaveProperty('prompt')
  clock = Date.parse(created.nextRunAt!)
  await expect
    .poll(async () => (await owner.json<AutomationDetail>(`automations/${created.id}`)).automation.lastRun?.state, { timeout: 8000 })
    .toBe('completed')
  const { automation, runs } = await owner.json<AutomationDetail>(`automations/${created.id}`)
  const detail = await owner.json<TaskDetail>(`tasks/${automation.lastRun!.sessionId}`)
  expect(detail.summary).toMatchObject({ automationId: created.id, agent: { customAgentId: agent.id }, title: '每日依赖检查' })
  expect(runs).toHaveLength(1)
  expect(seen[0]?.[1]?.content).toContain('AGENT INSTRUCTIONS')
})

test('an automation may use a Harness, on record, and 立即运行 goes through the route', async () => {
  const { host, owner } = await fixture()
  const defined = await owner.request('agents', {
    method: 'POST',
    body: { id: 'fake-engine', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT], env: {} },
  })
  expect(defined.status).toBe(201)
  const agent = await owner.json<CustomAgent>('custom-agents', {
    method: 'POST',
    body: definition({ harnessId: 'fake-engine', mode: 'agent', model: undefined, skills: [] }),
  })
  const asked = host.presence.requests.length
  // Enabling one with a Harness takes no prompt, like starting one by hand.
  const onHarness = await owner.json<Automation>('automations', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      name: 'x',
      customAgentId: agent.id,
      prompt: 'p',
      schedule: { kind: 'daily', time: '09:00' },
      notify: false,
    },
  })
  expect(onHarness).toMatchObject({ enabled: true, state: 'ready' })
  await owner.json(`automations/${onHarness.id}/run`, { method: 'POST', body: { requestId: randomUUID() } })
  await expect
    .poll(async () => (await owner.json<AutomationDetail>(`automations/${onHarness.id}`)).automation.lastRun?.state, { timeout: 8000 })
    .toBe('completed')
  expect(host.presence.requests).toHaveLength(asked)
  const records = (await readFile(join(host.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { action: string; stepup?: string; detail: Record<string, unknown> })
  expect(records.find(record => record.action === 'task.l3.started')).toMatchObject({
    stepup: 'none',
    detail: { harnessId: 'fake-engine', promptHash: expect.any(String) },
  })
  const general = await owner.json<Automation>('automations', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      name: 'Run it',
      model,
      prompt: 'Now',
      schedule: { kind: 'weekly', day: 5, time: '17:00' },
      notify: false,
    },
  })
  await owner.json(`automations/${general.id}/run`, { method: 'POST', body: { requestId: randomUUID() } })
  await expect
    .poll(async () => (await owner.json<AutomationDetail>(`automations/${general.id}`)).automation.lastRun?.state, { timeout: 8000 })
    .toBe('completed')
  const list = await owner.json<{ automations: Automation[] }>('automations')
  expect(list.automations.map(item => item.id).sort()).toEqual([general.id, onHarness.id].sort())
  await owner.json(`automations/${general.id}`, { method: 'DELETE', body: { requestId: randomUUID() } })
  expect((await owner.request(`automations/${general.id}`)).status).toBe(404)
})

test('a device off this computer enables an automation only while its own scopes stand behind it', async () => {
  const { host, owner } = await fixture()
  const remote = await host.enroll({ listener: 'loopback-tcp' })
  const widened = await owner.confirmed(`devices/${remote.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
  expect(widened.ok).toBe(true)
  const body = () => ({
    requestId: randomUUID(),
    name: 'Remote',
    model,
    prompt: 'p',
    schedule: { kind: 'daily', time: '09:00' },
    notify: false,
  })
  const created = await remote.json<Automation>('automations', { method: 'POST', body: body() })
  expect(created).toMatchObject({ enabled: true, state: 'ready' })
  await owner.json(`devices/${remote.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
  const refused = await remote.request('automations', { method: 'POST', body: body() })
  expect(refused.status).toBe(403)
  expect(await refused.json()).toMatchObject({ error: 'agent-scope-required' })
  // What it had already turned on no longer stands either.
  await expect
    .poll(async () => (await owner.json<AutomationDetail>(`automations/${created.id}`)).automation.pause?.reason, { timeout: 8000 })
    .toBe('owner-unavailable')
  const off = await owner.json<Automation>(`automations/${created.id}/enabled`, {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      baseRevision: (await owner.json<AutomationDetail>(`automations/${created.id}`)).automation.revision,
      enabled: false,
    },
  })
  expect(off).toMatchObject({ enabled: false, state: 'off' })
})

test('an external engine gets the labelled first-turn block, and the confirmation names the agent and binds the block', async () => {
  const seen: ModelMessage[][] = []
  const host = await startTestHost({ plugins: [plugin(seen)] })
  hosts.push(host)
  const owner = await host.enroll({ listener: 'unix' })
  const defined = await owner.confirmed('agents', {
    method: 'POST',
    body: { id: 'fake-engine', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT], env: {} },
  })
  expect(defined.ok).toBe(true)
  const agent = await owner.json<CustomAgent>('custom-agents', {
    method: 'POST',
    body: definition({ harnessId: 'fake-engine', mode: 'agent', model: undefined, skills: ['agent-provider:review'] }),
  })
  const harness = (await owner.json<AppSnapshot>('snapshot')).catalog?.harnesses.find(item => item.id === 'fake-engine')
  expect(harness).toMatchObject({ agentContext: 'first-turn', skills: 'server' })
  const body = { customAgentId: agent.id, prompt: 'echo hello', requestId: randomUUID() }
  const started = await owner.confirmed('tasks', { method: 'POST', body })
  expect(started.status).toBe(201)
  const { sessionId } = (await started.json()) as { sessionId: string }
  await settled(owner, sessionId)
  const detail = await owner.json<TaskDetail>(`tasks/${sessionId}`)
  expect(detail.summary).toMatchObject({ agent: { customAgentId: agent.id }, harnessId: 'fake-engine' })
  expect(detail.messages[0]?.text).toBe('echo hello')
  expect(detail.messages[0]?.agentBrief?.segments).toContainEqual({ source: 'user', text: 'AGENT INSTRUCTIONS' })
  expect(detail.messages[0]?.agentBrief?.segments.at(-1)?.text).toContain('审阅清单')
  // A later turn sends only what was typed, and needs nothing from the saved agent.
  await owner.json(`custom-agents/${agent.id}`, { method: 'DELETE', body: { requestId: randomUUID() } })
  const next = await owner.confirmed(`tasks/${sessionId}/prompt`, {
    method: 'POST',
    body: { prompt: 'echo again', requestId: randomUUID() },
  })
  expect(next.status).toBe(200)
})

test('通用 on an external engine is as private as an agent', async () => {
  const host = await startTestHost()
  hosts.push(host)
  const owner = await host.enroll({ listener: 'unix' })
  const defined = await owner.confirmed('agents', {
    method: 'POST',
    body: { id: 'fake-engine', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT], env: {} },
  })
  expect(defined.ok).toBe(true)
  const agent = await owner.json<CustomAgent>('custom-agents', {
    method: 'POST',
    body: definition({ name: '一个名字特别特别特别特别长的 Agent', harnessId: 'fake-engine', mode: 'agent', model: undefined }),
  })
  const started = await owner.confirmed('tasks', {
    method: 'POST',
    body: { customAgentId: agent.id, prompt: 'echo one', requestId: randomUUID() },
  })
  expect(started.status).toBe(201)

  const list = await owner.json<CustomAgentList>('custom-agents')
  await owner.json('custom-agents/general', {
    method: 'PATCH',
    body: { requestId: randomUUID(), baseRevision: list.general.revision, instructions: 'GENERAL SECRET' },
  })
  const plain = await owner.confirmed('tasks', {
    method: 'POST',
    body: { harnessId: 'fake-engine', prompt: 'echo two', requestId: randomUUID() },
  })
  expect(plain.status).toBe(201)
  const { sessionId } = (await plain.json()) as { sessionId: string }
  await settled(owner, sessionId)
  const detail = await owner.json<TaskDetail>(`tasks/${sessionId}`)
  expect(detail.summary).toMatchObject({ agentPrivate: true })
  expect(detail.summary).not.toHaveProperty('agent')
  expect(JSON.stringify(detail.messages[0]?.agentBrief)).toContain('GENERAL SECRET')
  const limited = await host.enroll({ listener: 'loopback-tcp' })
  const refused = await limited.request(`tasks/${sessionId}`)
  expect(refused.status).toBe(403)
  expect((await limited.json<AppSnapshot>('snapshot')).tasks.map(task => task.id)).not.toContain(sessionId)
})

test('a queued turn runs with its agent, and parks when the agent changed after it was queued', async () => {
  const seen: ModelMessage[][] = []
  let release: () => void = () => {}
  let gate: Promise<void> | undefined
  const gated: HarnessPlugin = {
    id: 'gated-provider',
    name: 'gated',
    version: '1',
    description: '',
    activate(ctx) {
      ctx.registerProvider({
        id: 'gated-provider',
        name: 'gated',
        model: 'fixture',
        async *stream({ messages }) {
          seen.push(structuredClone(messages))
          if (gate) await gate
          yield { type: 'text', text: 'Answer' }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  const host = await startTestHost({ plugins: [gated], providerId: 'gated-provider' })
  hosts.push(host)
  const owner = await host.enroll({ listener: 'unix' })
  const agent = await owner.json<CustomAgent>('custom-agents', {
    method: 'POST',
    body: definition({ model: { providerId: 'gated-provider', model: 'fixture' } }),
  })
  gate = new Promise(resolve => {
    release = resolve
  })
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { customAgentId: agent.id, prompt: 'First', requestId: randomUUID() },
  })
  await expect.poll(() => seen.length).toBe(1)
  const queued = await owner.request(`tasks/${sessionId}/prompt`, {
    method: 'POST',
    body: { prompt: 'Second', requestId: randomUUID(), queue: true },
  })
  expect(queued.status).toBe(202)
  gate = undefined
  release()
  await expect.poll(() => seen.length, { timeout: 8000 }).toBe(2)
  expect(seen[1]?.[1]?.content).toContain('AGENT INSTRUCTIONS')
  await settled(owner, sessionId)

  gate = new Promise(resolve => {
    release = resolve
  })
  await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'Third', requestId: randomUUID() } })
  await expect.poll(() => seen.length).toBe(3)
  await owner.request(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'Fourth', requestId: randomUUID(), queue: true } })
  await owner.json(`custom-agents/${agent.id}`, {
    method: 'PATCH',
    body: { requestId: randomUUID(), baseRevision: agent.revision, instructions: 'CHANGED' },
  })
  gate = undefined
  release()
  await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).queue?.[0]?.state, { timeout: 8000 }).toBe('parked')
  expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).queue?.[0]?.reason).toBe('Agent 的设置已改变，请移除此项后重新加入队列')
  expect(seen).toHaveLength(3)
})

test('checking an automation does not count as its device being seen, so an idle device stops standing behind it', async () => {
  let clock = Date.parse('2026-11-02T08:00:00Z')
  const { host, owner } = await fixture({ now: () => clock })
  const created = await owner.json<Automation>('automations', {
    method: 'POST',
    body: { requestId: randomUUID(), name: 'Idle', model, prompt: 'p', schedule: { kind: 'daily', time: '09:00' }, notify: false },
  })
  clock += 15 * 24 * 3600_000
  // Read from disk: a request from the device would itself count as seeing it.
  await expect
    .poll(async () => JSON.parse(await readFile(join(host.dataDir, 'automations.json'), 'utf8')).rows[0].automation.pause?.reason, {
      timeout: 8000,
    })
    .toBe('owner-unavailable')
  expect(created.enabled).toBe(true)
})

// The web's 委托 sends the folder it shows: the Agent's default project, or 'default' for the Host's own start.
test.each([{ sessionFolders: false }, { sessionFolders: true }])(
  'a delegation in the start folder or a project starts, with sessionFolders $sessionFolders',
  async ({ sessionFolders }) => {
    const { host, owner } = await fixture(sessionFolders ? { sessionFolders: true } : {})
    const folder = join(host.root, 'notes')
    await mkdir(folder)
    expect((await owner.addFolders({ paths: [folder], name: 'notes' })).status).toBeLessThan(300)
    const notes = (await owner.json<{ workspaces: WorkspaceInfo[] }>('workspaces')).workspaces.find(item => item.name === 'notes')!
    const loose = await owner.json<CustomAgent>('custom-agents', { method: 'POST', body: definition({ mode: 'agent' }) })
    const placed = await owner.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: definition({ name: '笔记整理', mode: 'agent', defaultProjectId: notes.id }),
    })
    const delegate = async (agent: CustomAgent, workspaceId: string) => {
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { customAgentId: agent.id, prompt: 'Go', requestId: randomUUID(), mode: 'agent', harnessId: 'standard', workspaceId, model },
      })
      await settled(owner, sessionId)
      return (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary
    }
    expect(await delegate(loose, 'default')).toMatchObject({ workspaceId: 'default', agent: { customAgentId: loose.id } })
    expect(await delegate(placed, notes.id)).toMatchObject({ workspaceId: notes.id })
    // 起始文件夹 picked for this session over the Agent's default project.
    expect(await delegate(placed, 'default')).toMatchObject({ workspaceId: 'default' })
    // A project picked for this session that is gone is that pick's problem, not the Agent's.
    const gone = await owner.request('tasks', {
      method: 'POST',
      body: {
        customAgentId: loose.id,
        prompt: 'Go',
        requestId: randomUUID(),
        mode: 'agent',
        harnessId: 'standard',
        workspaceId: 'gone',
        model,
      },
    })
    expect(gone.status).toBe(400)
    expect(await gone.json()).toMatchObject({ error: 'workspace-unavailable' })
    // Once the Agent's own project is removed, that project is refused in those words, and the start folder still works.
    const old = join(host.root, 'old')
    await mkdir(old)
    expect((await owner.addFolders({ paths: [old], name: 'old' })).status).toBeLessThan(300)
    const oldId = (await owner.json<{ workspaces: WorkspaceInfo[] }>('workspaces')).workspaces.find(item => item.name === 'old')!.id
    const moved = await owner.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: definition({ name: '旧项目', mode: 'agent', defaultProjectId: oldId }),
    })
    expect((await owner.request(`workspaces/${oldId}`, { method: 'DELETE' })).status).toBe(200)
    const removed = await owner.request('tasks', {
      method: 'POST',
      body: {
        customAgentId: moved.id,
        prompt: 'Go',
        requestId: randomUUID(),
        mode: 'agent',
        harnessId: 'standard',
        workspaceId: oldId,
        model,
      },
    })
    expect(removed.status).toBe(409)
    expect(await removed.json()).toMatchObject({ error: 'agent-unavailable', message: '默认项目已移除，请更新这个 Agent。' })
    expect(await delegate(moved, 'default')).toMatchObject({ workspaceId: 'default' })
  },
)
