import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import type {
  AgentMemory,
  AppSnapshot,
  Automation,
  AutomationDetail,
  CustomAgent,
  CustomAgentDetail,
  MemoryProposal,
  MemoryProposalList,
  TaskDetail,
} from '@latch/protocol'
import type { HarnessHostOptions, HarnessPlugin } from '@latch/sdk'
import { createRuntime } from '@latch/core'
import { startTestHost, type TestHost } from './helpers/host.ts'

const hosts: TestHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.close()
})

/** Calls propose_memory once when the person's message says `propose`, and only if it was offered. */
const plugin: HarnessPlugin = {
  id: 'proposing-provider',
  name: 'fixture',
  version: '1',
  description: '',
  activate(ctx) {
    ctx.registerProvider({
      id: 'proposing-provider',
      name: 'fixture',
      model: 'fixture',
      async *stream({ messages, tools }) {
        const last = messages.at(-1)
        if (last?.role === 'user' && JSON.stringify(last).includes('hold')) await held.promise
        if (last?.role === 'user' && JSON.stringify(last).includes('propose') && tools.some(tool => tool.name === 'propose_memory')) {
          yield {
            type: 'tool-call',
            call: { id: `call-${randomUUID()}`, name: 'propose_memory', arguments: { content: 'AGENT PROPOSAL' } },
          }
          yield { type: 'finish', reason: 'tool-calls' }
          return
        }
        yield { type: 'text', text: 'Answer' }
        yield { type: 'finish', reason: 'stop' }
      },
    })
  },
}
const model = { providerId: 'proposing-provider', model: 'fixture' }
/** A turn whose message says `hold` runs until the test lets it go. */
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}
let held = deferred()
async function fixture() {
  const host = await startTestHost({ plugins: [plugin] })
  hosts.push(host)
  const owner = await host.enroll({ listener: 'unix' })
  return { host, owner }
}
const settled = (owner: Awaited<ReturnType<TestHost['enroll']>>, id: string) =>
  expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${id}`)).summary.status).toBe('idle')

test('the agent and the person propose, nothing is saved until the person saves, and only a full-scope device learns of it', async () => {
  const { host, owner } = await fixture()
  const agent = await owner.json<CustomAgent>('custom-agents', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      name: '资料',
      description: '',
      harnessId: 'standard',
      mode: 'agent',
      model,
      instructions: '',
      skills: [],
    },
  })
  const start = { customAgentId: agent.id, prompt: '记住：我用 pnpm', requestId: randomUUID() }
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', { method: 'POST', body: start })
  await settled(owner, sessionId)
  await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'please propose', requestId: randomUUID() } })
  await settled(owner, sessionId)
  const list = () => owner.json<MemoryProposalList>(`custom-agents/${agent.id}/proposals`)
  await expect.poll(async () => (await list()).proposals.length).toBe(2)
  const [mine, inferred] = (await list()).proposals as [MemoryProposal, MemoryProposal]
  expect(mine).toMatchObject({
    content: '我用 pnpm',
    origin: 'user',
    external: false,
    state: 'pending',
    source: { sessionId, requestId: start.requestId },
  })
  const detail = await owner.json<TaskDetail>(`tasks/${sessionId}`)
  const second = detail.messages.filter(message => message.role === 'user')[1]!
  expect(inferred).toMatchObject({
    content: 'AGENT PROPOSAL',
    origin: 'agent',
    external: false,
    source: { sessionId, messageId: second.id },
  })
  // The person's words went to the Harness as written, and a retry of the start proposes nothing more.
  expect(detail.messages[0]!.text).toBe('记住：我用 pnpm')
  await owner.json('tasks', { method: 'POST', body: start })
  expect((await list()).proposals).toHaveLength(2)
  expect((await owner.json<CustomAgentDetail>(`custom-agents/${agent.id}`)).memories).toEqual([])
  expect((await owner.json<AppSnapshot>('snapshot')).agentProposals?.[agent.id]).toMatchObject({ pending: 2 })

  // A device without the full data scope learns nothing of them and cannot decide.
  const limited = await host.enroll({ listener: 'loopback-tcp' })
  await owner.json(`devices/${limited.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
  expect((await limited.request(`custom-agents/${agent.id}/proposals`)).status).toBe(403)
  expect(await limited.json<AppSnapshot>('snapshot')).not.toHaveProperty('agentProposals')
  const save = { requestId: randomUUID() }
  expect((await limited.request(`custom-agents/${agent.id}/proposals/${mine.id}/save`, { method: 'POST', body: save })).status).toBe(403)

  // Save one, dismiss the other; replays answer the same.
  const saved = await owner.json<{ proposal: MemoryProposal; memory: AgentMemory }>(`custom-agents/${agent.id}/proposals/${mine.id}/save`, {
    method: 'POST',
    body: save,
  })
  expect(saved.memory).toMatchObject({ content: '我用 pnpm', source: { proposalId: mine.id, origin: 'user', sessionId } })
  const again = await owner.json<{ memory: AgentMemory }>(`custom-agents/${agent.id}/proposals/${mine.id}/save`, {
    method: 'POST',
    body: save,
  })
  expect(again.memory.id).toBe(saved.memory.id)
  const dismiss = { requestId: randomUUID() }
  for (let round = 0; round < 2; round++)
    expect(
      await owner.json<MemoryProposal>(`custom-agents/${agent.id}/proposals/${inferred.id}/dismiss`, { method: 'POST', body: dismiss }),
    ).toMatchObject({ proposalId: inferred.id, proposal: { state: 'dismissed' } })
  expect((await owner.json<CustomAgentDetail>(`custom-agents/${agent.id}`)).memories.map(memory => memory.id)).toEqual([saved.memory.id])

  // Undo of an edit, through the route.
  await owner.json(`custom-agents/${agent.id}/memories/${saved.memory.id}`, {
    method: 'PATCH',
    body: { requestId: randomUUID(), baseRevision: 1, content: '我用 npm' },
  })
  expect((await owner.json<CustomAgentDetail>(`custom-agents/${agent.id}`)).memoryChanges).toEqual([
    expect.objectContaining({ memoryId: saved.memory.id, operation: 'update' }),
  ])
  // Undo needs the revision the person saw.
  const stale = await owner.request(`custom-agents/${agent.id}/memories/${saved.memory.id}/undo`, {
    method: 'POST',
    body: { requestId: randomUUID(), baseRevision: 1 },
  })
  expect(stale.status).toBe(409)
  expect(await stale.json()).toMatchObject({ error: 'agent-changed' })
  const undone = await owner.json<AgentMemory>(`custom-agents/${agent.id}/memories/${saved.memory.id}/undo`, {
    method: 'POST',
    body: { requestId: randomUUID(), baseRevision: 2 },
  })
  expect(undone).toMatchObject({ content: '我用 pnpm', revision: 3 })

  // A secret in 「记住…」 is refused and says why; the message still went.
  const secret = await owner.request(`tasks/${sessionId}/prompt`, {
    method: 'POST',
    body: { prompt: '请记住 sk-proj-abcdefghijklmnopqrstuvwxyz0123', requestId: randomUUID() },
  })
  expect(secret.status).toBe(200)
  expect(await secret.json()).toEqual({ accepted: true, memoryRefused: '内容像是密钥或凭据，没有记下。' })
  await settled(owner, sessionId)
  expect((await list()).proposals).toHaveLength(2)

  // Neither the text nor the secret is in the audit log.
  const audit = await readFile(join(host.dataDir, 'audit', 'audit.jsonl'), 'utf8')
  expect(audit).toContain('agent.memory.proposed')
  expect(audit).not.toContain('pnpm')
  expect(audit).not.toContain('AGENT PROPOSAL')
  expect(audit).not.toContain('sk-proj')
})

test('a conversation with 通用 takes proposals as its own, and a plain session gets no propose_memory', async () => {
  const { owner } = await fixture()
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { customAgentId: 'general', prompt: 'propose it', mode: 'agent', model, requestId: randomUUID() },
  })
  await settled(owner, sessionId)
  await expect
    .poll(async () => (await owner.json<MemoryProposalList>('custom-agents/general/proposals')).proposals.map(item => item.content))
    .toEqual(['AGENT PROPOSAL'])
  const plain = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { prompt: 'propose it', mode: 'agent', model, requestId: randomUUID() },
  })
  await settled(owner, plain.sessionId)
  expect((await owner.json<TaskDetail>(`tasks/${plain.sessionId}`)).messages.some(message => message.role === 'tool')).toBe(false)
  // 「记住…」 in Code is an ordinary message.
  await owner.json(`tasks/${plain.sessionId}/prompt`, { method: 'POST', body: { prompt: '记住：别的', requestId: randomUUID() } })
  await settled(owner, plain.sessionId)
  expect((await owner.json<MemoryProposalList>('custom-agents/general/proposals')).proposals).toHaveLength(1)
})

test('everything a scheduled run proposes is external, and a 只对话 Agent session can propose', async () => {
  const { owner } = await fixture()
  const agent = await owner.json<CustomAgent>('custom-agents', {
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
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { customAgentId: agent.id, prompt: 'please propose', requestId: randomUUID() },
  })
  await settled(owner, sessionId)
  expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.mode).toBe('chat')
  const list = () => owner.json<MemoryProposalList>(`custom-agents/${agent.id}/proposals`)
  await expect.poll(async () => (await list()).proposals.map(item => [item.source.sessionId, item.external])).toEqual([[sessionId, false]])
  const automation = await owner.json<Automation>('automations', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      name: '每周',
      customAgentId: agent.id,
      prompt: 'propose from the schedule',
      schedule: { kind: 'daily', time: '09:00' },
      notify: false,
    },
  })
  await owner.json(`automations/${automation.id}/run`, { method: 'POST', body: { requestId: randomUUID() } })
  await expect
    .poll(async () => (await owner.json<AutomationDetail>(`automations/${automation.id}`)).automation.lastRun?.state, { timeout: 8000 })
    .toBe('completed')
  const run = (await owner.json<AutomationDetail>(`automations/${automation.id}`)).automation.lastRun!.sessionId
  await expect.poll(async () => (await list()).proposals.find(item => item.source.sessionId === run)?.external).toBe(true)
})

test('a driver proposes only into its own sessions of an Agent, and a plugin driver cannot say a proposal is not external', async () => {
  let options: HarnessHostOptions | undefined
  const custom: HarnessPlugin = {
    id: 'custom-engine',
    name: 'Custom',
    version: '1',
    description: '',
    activate(ctx) {
      ctx.registerHarness({
        id: 'custom',
        name: 'Custom engine',
        version: '1',
        agentContext: 'private',
        capabilities: { models: { owner: 'latch' } },
        create: hostOptions => {
          options = hostOptions
          return createRuntime(hostOptions)
        },
      })
    },
  }
  const host = await startTestHost({ plugins: [plugin, custom] })
  hosts.push(host)
  const owner = await host.enroll({ listener: 'unix' })
  const make = async (harnessId: string) => {
    const agent = await owner.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: { requestId: randomUUID(), name: harnessId, description: '', harnessId, mode: 'agent', model, instructions: '', skills: [] },
    })
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { customAgentId: agent.id, prompt: 'hello', requestId: randomUUID() },
    })
    await settled(owner, sessionId)
    return { agent, sessionId }
  }
  const builtin = await make('standard')
  const plugged = await make('custom')
  const plain = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { prompt: 'hello', mode: 'agent', model, harnessId: 'custom', requestId: randomUUID() },
  })
  await settled(owner, plain.sessionId)
  const propose = (sessionId: string, key: string) =>
    options!.proposeMemory!({ sessionId, content: 'PLUGIN PROPOSAL', external: false, key })
  // Another driver's session, or a session of no Agent: refused.
  await expect(propose(builtin.sessionId, 'a')).rejects.toMatchObject({ code: 'agent-proposal-session' })
  await expect(propose(plain.sessionId, 'b')).rejects.toMatchObject({ code: 'agent-proposal-session' })
  expect((await owner.json<MemoryProposalList>(`custom-agents/${builtin.agent.id}/proposals`)).proposals).toEqual([])
  // Its own session of that Agent, but started without proposals in its context: refused too.
  const unmarked = await host.host.bridge.createTask({
    prompt: 'hello',
    requestId: randomUUID(),
    harnessId: 'custom',
    mode: 'agent',
    model,
    agentContext: { agent: { customAgentId: plugged.agent.id }, instructions: '', revision: 'a'.repeat(64) },
  })
  await settled(owner, unmarked.sessionId)
  await expect(propose(unmarked.sessionId, 'd')).rejects.toMatchObject({ code: 'agent-proposal-session' })
  // Its own Agent session: kept, and external whatever it said.
  await propose(plugged.sessionId, 'c')
  expect((await owner.json<MemoryProposalList>(`custom-agents/${plugged.agent.id}/proposals`)).proposals).toEqual([
    expect.objectContaining({ content: 'PLUGIN PROPOSAL', external: true }),
  ])
}, 30_000)

test('a queued 「记住…」 proposes when it is sent, a withdrawn one never, and a refusal shows on its turn', async () => {
  const { owner } = await fixture()
  const agent = await owner.json<CustomAgent>('custom-agents', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      name: '队列',
      description: '',
      harnessId: 'standard',
      mode: 'agent',
      model,
      instructions: '',
      skills: [],
    },
  })
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { customAgentId: agent.id, prompt: 'hello', requestId: randomUUID() },
  })
  await settled(owner, sessionId)
  const list = async () => (await owner.json<MemoryProposalList>(`custom-agents/${agent.id}/proposals`)).proposals.map(item => item.content)
  // Sent from an empty queue at once: proposed then.
  const secret = randomUUID()
  await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: '记住：用 pnpm', requestId: randomUUID(), queue: true } })
  await settled(owner, sessionId)
  await expect.poll(list).toEqual(['用 pnpm'])
  await owner.json(`tasks/${sessionId}/prompt`, {
    method: 'POST',
    body: { prompt: '记住 sk-proj-abcdefghijklmnopqrstuvwxyz0123', requestId: secret, queue: true },
  })
  await settled(owner, sessionId)
  const detail = await owner.json<TaskDetail>(`tasks/${sessionId}`)
  const sent = detail.messages.filter(message => message.role === 'user').at(-1)!
  // Queued behind a running turn and withdrawn: never sent, never proposed.
  held = deferred()
  await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'hold on', requestId: randomUUID() } })
  const queued = await owner.json<{ queued: { id: string } }>(`tasks/${sessionId}/prompt`, {
    method: 'POST',
    body: { prompt: '记住：撤回的', requestId: randomUUID(), queue: true },
  })
  expect(await list()).toEqual(['用 pnpm'])
  await owner.json(`tasks/${sessionId}/queue/${queued.queued.id}`, { method: 'DELETE' })
  held.resolve()
  await settled(owner, sessionId)
  expect(await list()).toEqual(['用 pnpm'])
  expect(detail.memoryRefusals).toEqual([{ requestId: sent.requestId, reason: '内容像是密钥或凭据，没有记下。' }])
  expect(await list()).toEqual(['用 pnpm'])
  // Archiving the session forgets the refusals. An Agent's one chat is archived only once the Agent is gone.
  await owner.json(`custom-agents/${agent.id}`, { method: 'DELETE', body: { requestId: randomUUID() } })
  expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).memoryRefusals).toHaveLength(1)
  await owner.json(`tasks/${sessionId}`, { method: 'PATCH', body: { archived: true } })
  expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).memoryRefusals).toBeUndefined()
})
