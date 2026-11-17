import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import type { AppSnapshot, Automation, AutomationDetail, CustomAgent, CustomAgentList, TaskDetail } from '@latch/protocol'
import type { HarnessPlugin, ModelMessage } from '@latch/sdk'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { DIGEST_HEADING } from '../src/agent-digest.ts'
import { GENERAL_FACTS } from '../src/custom-agents.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const hosts: TestHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.close()
})
const plugin = (seen: ModelMessage[][]): HarnessPlugin => ({
  id: 'helper-provider',
  name: 'fixture',
  version: '1',
  description: '',
  activate(ctx) {
    ctx.registerProvider({
      id: 'helper-provider',
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
const model = { providerId: 'helper-provider', model: 'fixture' }
const definition = (overrides = {}) => ({
  requestId: randomUUID(),
  name: '资料助手',
  description: '查资料，写成一页摘要',
  harnessId: 'standard',
  mode: 'chat',
  model,
  instructions: 'HELPER INSTRUCTIONS',
  skills: [],
  ...overrides,
})
async function fixture() {
  const seen: ModelMessage[][] = []
  const host = await startTestHost({ plugins: [plugin(seen)] })
  hosts.push(host)
  const owner = await host.enroll({ listener: 'unix' })
  return { host, owner, seen }
}
type Device = Awaited<ReturnType<TestHost['enroll']>>
const settled = (device: Device, id: string) =>
  expect.poll(async () => (await device.json<TaskDetail>(`tasks/${id}`)).summary.status).toBe('idle')
const system = (messages: ModelMessage[] | undefined) => String(messages?.[1]?.content ?? '')

test("a fact the person confirmed in 通用 reaches every Agent's turn, read-only, and can be turned off per Agent", async () => {
  const { owner, seen } = await fixture()
  await owner.json('custom-agents/general/memories', { method: 'POST', body: { requestId: randomUUID(), content: '我对花生过敏' } })
  const agent = await owner.json<CustomAgent>('custom-agents', { method: 'POST', body: definition() })
  const list = await owner.json<CustomAgentList>('custom-agents')
  expect(list.agents.find(item => item.id === agent.id)?.generalFacts).toEqual({ sent: 1, total: 1 })
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { customAgentId: agent.id, prompt: '今晚吃什么', requestId: randomUUID() },
  })
  await settled(owner, sessionId)
  expect(system(seen[0])).toContain(`${GENERAL_FACTS}\n\n我对花生过敏`)
  // It is not this Agent's memory, and nothing about it is in the session's record.
  expect((await owner.json<{ memories: unknown[] }>(`custom-agents/${agent.id}`)).memories).toEqual([])
  expect(JSON.stringify(await owner.json<TaskDetail>(`tasks/${sessionId}`))).not.toContain('我对花生过敏')

  const current = await owner
    .json<CustomAgent>(`custom-agents/${agent.id}`)
    .then(detail => (detail as unknown as { agent: CustomAgent }).agent)
  await owner.json(`custom-agents/${agent.id}`, {
    method: 'PATCH',
    body: { requestId: randomUUID(), baseRevision: current.revision, generalFacts: false },
  })
  const off = await owner.json<CustomAgentList>('custom-agents')
  expect(off.agents.find(item => item.id === agent.id)).toMatchObject({ generalFactsOff: true, generalFacts: { sent: 0, total: 1 } })
  await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: '那明天呢', requestId: randomUUID() } })
  await settled(owner, sessionId)
  expect(system(seen[1])).toContain('HELPER INSTRUCTIONS')
  expect(system(seen[1])).not.toContain('我对花生过敏')
})

test('a device without data scope all can neither read 我的 Agent nor warm one', async () => {
  const { host, owner } = await fixture()
  const agent = await owner.json<CustomAgent>('custom-agents', { method: 'POST', body: definition() })
  const work = await host.enroll({ listener: 'loopback-tcp' })
  await owner.json(`devices/${work.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
  for (const path of [`custom-agents/${agent.id}/warm`, 'custom-agents/general/warm']) {
    const refused = await work.request(path, { method: 'POST', body: {} })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ error: 'agent-scope-required' })
  }
  expect((await work.request('custom-agents')).status).toBe(403)
})

test("warming starts only the Agent's own ready chat, at most once in a while, and never from a GET", async () => {
  const { host, owner } = await fixture()
  const log = join(host.root, 'warm.jsonl')
  await owner.confirmedJson('agents', {
    method: 'POST',
    body: {
      id: 'warm-helper',
      name: 'Warm helper',
      command: process.execPath,
      args: [FAKE_ACP_AGENT],
      env: { FAKE_ACP_LOG: log, FAKE_ACP_CAPS: 'resume' },
    },
  })
  const agent = await owner.json<CustomAgent>('custom-agents', {
    method: 'POST',
    body: definition({ harnessId: 'warm-helper', mode: 'agent', model: undefined }),
  })
  // No chat yet: nothing to warm, and nothing is created for it.
  expect(await owner.json(`custom-agents/${agent.id}/warm`, { method: 'POST', body: {} })).toEqual({ started: false })
  expect((await owner.json<AppSnapshot>('snapshot')).tasks).toHaveLength(0)
  expect((await owner.request(`custom-agents/${agent.id}/warm`)).status).toBe(404)
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { customAgentId: agent.id, prompt: 'echo hello', requestId: randomUUID() },
  })
  await settled(owner, sessionId)
  const prompts = (await readFile(log, 'utf8')).split('session/prompt').length
  expect(await owner.json(`custom-agents/${agent.id}/warm`, { method: 'POST', body: {} })).toEqual({ started: true })
  // On record before anything starts: which Agent and its one chat, nothing else.
  const warmed = (await readFile(join(host.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { action: string; detail?: unknown })
    .filter(record => record.action === 'agent.warm.requested')
  expect(warmed.map(record => record.detail)).toEqual([{ customAgentId: agent.id, sessionId }])
  // Within the window a second open starts nothing; and no warm-up sent anything to the model.
  expect(await owner.json(`custom-agents/${agent.id}/warm`, { method: 'POST', body: {} })).toEqual({ started: false })
  expect((await readFile(log, 'utf8')).split('session/prompt').length).toBe(prompts)
  // 通用 runs on the built-in Harness: no process to start.
  expect(await owner.json('custom-agents/general/warm', { method: 'POST', body: {} })).toEqual({ started: false })
})

test("a scheduled run's result reaches the Agent's next chat turn as a short digest, not its reply", async () => {
  const { owner, seen } = await fixture()
  const agent = await owner.json<CustomAgent>('custom-agents', { method: 'POST', body: definition() })
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { customAgentId: agent.id, prompt: '你好', requestId: randomUUID() },
  })
  await settled(owner, sessionId)
  expect(system(seen[0])).not.toContain(DIGEST_HEADING)
  const schedule = await owner.json<Automation>('automations', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      customAgentId: agent.id,
      name: '晨报',
      prompt: '写今天的晨报',
      schedule: { kind: 'daily', time: '09:00' },
      notify: false,
    },
  })
  await owner.json(`automations/${schedule.id}/run`, { method: 'POST', body: { requestId: randomUUID() } })
  await expect
    .poll(async () => (await owner.json<AutomationDetail>(`automations/${schedule.id}`)).automation.lastRun?.state, { timeout: 8000 })
    .toBe('completed')
  // The run's own turn carried no digest.
  expect(system(seen[1])).not.toContain(DIGEST_HEADING)
  const runSession = (await owner.json<AutomationDetail>(`automations/${schedule.id}`)).runs[0]?.sessionId
  await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: '晨报写了吗', requestId: randomUUID() } })
  await settled(owner, sessionId)
  const text = system(seen[2])
  expect(text).toContain(DIGEST_HEADING)
  expect(text).toMatch(new RegExp(`定时「晨报」立即运行 · 完成 · 会话 ${runSession} · 来自外部内容`, 'u'))
  // The run's reply ("Answer") is not copied in.
  expect(text.slice(text.indexOf(DIGEST_HEADING))).not.toContain('Answer')
})

test("a deleted Agent's chat answers as it did before the digest: by the one-chat rule, never by the note", async () => {
  const { host, owner } = await fixture()
  const log = join(host.root, 'deleted.jsonl')
  await owner.confirmedJson('agents', {
    method: 'POST',
    body: { id: 'gone-helper', name: 'Gone helper', command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_LOG: log } },
  })
  const agent = await owner.json<CustomAgent>('custom-agents', {
    method: 'POST',
    body: definition({ harnessId: 'gone-helper', mode: 'agent', model: undefined }),
  })
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { customAgentId: agent.id, prompt: 'echo hello', requestId: randomUUID() },
  })
  await settled(owner, sessionId)
  await owner.json(`custom-agents/${agent.id}`, { method: 'DELETE', body: { requestId: randomUUID() } })
  // Its chat slot went with it, so the session is history: read-only, as docs/CUSTOM-AGENTS.md says, and nothing was sent.
  const prompts = (await readFile(log, 'utf8')).split('session/prompt').length
  const answer = await owner.request(`tasks/${sessionId}/prompt`, {
    method: 'POST',
    body: { prompt: 'echo again', requestId: randomUUID() },
  })
  expect(answer.status).toBe(409)
  expect(await answer.json()).toMatchObject({ error: 'agent-deleted', message: '这个 Agent 已删除，可以查看旧聊天。' })
  expect((await readFile(log, 'utf8')).split('session/prompt').length).toBe(prompts)
})

test('a warm-up after a restart starts nothing in a home that is no longer the one the Host made', async () => {
  const root = await mkdtemp(join(tmpdir(), 'latch-warm-home-'))
  try {
    const dataDir = join(root, 'data'),
      workspaceRoot = join(root, 'ws'),
      log = join(root, 'acp.jsonl')
    let host = await startTestHost({ dataDir, workspaceRoot })
    let owner = await host.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: {
        id: 'home-helper',
        name: 'Home helper',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_LOG: log, FAKE_ACP_STATE: join(root, 'state.json'), FAKE_ACP_CAPS: 'resume' },
      },
    })
    const agent = await owner.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: definition({ harnessId: 'home-helper', mode: 'agent', model: undefined }),
    })
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { customAgentId: agent.id, prompt: 'echo hello', requestId: randomUUID() },
    })
    await settled(owner, sessionId)
    await host.close()
    // The home is swapped for another folder of the same name.
    const home = join(workspaceRoot, 'helpers', agent.id)
    await rename(home, `${home}-old`)
    await mkdir(home, { mode: 0o700 })
    const starts = async () => (await readFile(log, 'utf8')).split('\n').filter(line => line.includes('"event":"start"')).length
    const before = await starts()
    host = await startTestHost({ dataDir, workspaceRoot })
    owner = await host.enroll({ listener: 'unix' })
    expect(await owner.json(`custom-agents/${agent.id}/warm`, { method: 'POST', body: {} })).toEqual({ started: true })
    await new Promise(resolve => setTimeout(resolve, 1500))
    expect(await starts()).toBe(before)
    await host.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
