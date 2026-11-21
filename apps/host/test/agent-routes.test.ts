import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import type {
  AgentComputer,
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
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { queryHostInfo } from '../src/host-state.ts'
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
const settled = (owner: Awaited<ReturnType<TestHost['enroll']>>, id: string, timeout?: number) =>
  expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${id}`)).summary.status, { timeout }).toBe('idle')

test('accepts only one first Personal Agent chat across devices and preserves its original response', async () => {
  const { host, owner } = await fixture()
  const other = await host.enroll({ listener: 'unix' })
  for (const id of ['general', (await owner.json<CustomAgent>('custom-agents', { method: 'POST', body: definition() })).id]) {
    const inputs = ['first on this device', 'first on another device'].map(prompt => ({
      customAgentId: id,
      prompt,
      requestId: randomUUID(),
      model,
    }))
    const devices = [owner, other]
    const attempted = await Promise.all(devices.map((device, i) => device.request('tasks', { method: 'POST', body: inputs[i]! })))
    expect(attempted.map(response => response.status).sort()).toEqual([201, 409])
    const winner = attempted.findIndex(response => response.status === 201)
    const loser = 1 - winner
    const { sessionId } = (await attempted[winner]!.json()) as { sessionId: string }
    expect(await attempted[loser]!.json()).toMatchObject({ error: expect.stringMatching(/^agent-chat-(exists|starting)$/u) })
    await settled(owner, sessionId)
    const snapshot = await owner.json<AppSnapshot>('snapshot')
    expect(snapshot.catalog?.features?.singleAgentChat).toBe(true)
    expect(snapshot.agentChats?.[id]).toEqual({ state: 'ready', sessionId })
    expect(await devices[winner]!.json('tasks', { method: 'POST', body: inputs[winner] })).toMatchObject({ sessionId })
    expect((await devices[winner]!.request('tasks', { method: 'POST', body: { ...inputs[winner], prompt: 'changed' } })).status).toBe(409)
    expect((await devices[loser]!.request('tasks', { method: 'POST', body: inputs[loser] })).status).toBe(409)
    expect((await owner.request(`tasks/${sessionId}`, { method: 'PATCH', body: { archived: true } })).status).toBe(409)
    expect((await owner.request(`tasks/${sessionId}`, { method: 'DELETE' })).status).toBe(409)
    const detail = await owner.json<TaskDetail>(`tasks/${sessionId}`)
    expect(detail.messages.filter(message => message.role === 'user').map(message => message.text)).toEqual([inputs[winner]!.prompt])
    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'continue here', requestId: randomUUID() } })
    await settled(owner, sessionId, 4_000)
  }
  const work = await host.enroll({ listener: 'loopback-tcp' })
  await owner.json(`devices/${work.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
  expect((await work.json<AppSnapshot>('snapshot')).agentChats).toBeUndefined()
})

test('keeps old Personal Agent sessions readable and adopts a stable slot without replaying their messages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'latch-personal-chat-migrate-'))
  let host: TestHost | undefined
  try {
    const options = { dataDir: join(root, 'data'), workspaceRoot: join(root, 'workspace'), plugins: [plugin([])] }
    host = await startTestHost(options)
    const owner = await host.enroll({ listener: 'unix' })
    const agent = await owner.json<CustomAgent>('custom-agents', { method: 'POST', body: definition() })
    const context = { agent: { customAgentId: agent.id }, instructions: '', revision: '1'.repeat(64) }
    const older = { prompt: 'Older but readable', requestId: randomUUID() }
    const a = await host.host.bridge.createTask({ ...older, mode: 'chat', model, agentContext: context })
    await settled(owner, a.sessionId)
    const b = await host.host.bridge.createTask({
      prompt: 'Newer current chat',
      requestId: randomUUID(),
      mode: 'chat',
      model,
      agentContext: context,
    })
    await settled(owner, b.sessionId)
    // Only the two legacy tasks predate a slot. Remove the empty record written by the new Agent's creation.
    const credential = owner.credential
    const journal = join(options.dataDir, 'agents', 'custom.json')
    await host.close()
    const before = JSON.parse(await readFile(journal, 'utf8')) as { chats?: unknown }
    delete before.chats
    await writeFile(journal, JSON.stringify(before))
    const queued = { prompt: 'Paused before migration', requestId: randomUUID() }
    const queueId = `queue-${randomUUID()}`
    await writeFile(
      join(options.dataDir, 'queues.json'),
      JSON.stringify({
        version: 1,
        items: [
          {
            id: queueId,
            sessionId: a.sessionId,
            deviceId: owner.id,
            listener: 'unix',
            dataScope: 'all',
            requestId: queued.requestId,
            sendRequestId: randomUUID(),
            hash: sha256Hex(canonicalJson({ text: queued.prompt })),
            text: queued.prompt,
            queuedAt: new Date().toISOString(),
            state: 'parked',
            waitRunId: '',
          },
        ],
      }),
      { mode: 0o600 },
    )
    host = await startTestHost(options)
    const request = (path: string, method: 'GET' | 'POST' = 'GET', body?: object) =>
      host!.raw('unix', `api/${path}`, {
        method,
        headers: { authorization: `Latch-Device ${credential}` },
        ...(body ? { body } : {}),
      })
    const snapshot = (await (await request('snapshot')).json()) as AppSnapshot
    expect(snapshot.agentChats?.[agent.id]).toEqual({ state: 'ready', sessionId: b.sessionId })
    expect(snapshot.tasks.map(task => task.id)).toEqual(expect.arrayContaining([a.sessionId, b.sessionId]))
    const newMessage = await request(`tasks/${a.sessionId}/prompt`, 'POST', {
      prompt: 'Do not start another path',
      requestId: randomUUID(),
    })
    expect(newMessage.status).toBe(409)
    expect(await newMessage.json()).toMatchObject({ error: 'agent-chat-history-read-only' })
    expect((await request(`tasks/${a.sessionId}/prompt`, 'POST', older)).status).toBe(200)
    const plainQueue = await request(`tasks/${a.sessionId}/prompt`, 'POST', queued)
    expect(plainQueue.status).toBe(409)
    expect(await plainQueue.json()).toMatchObject({ error: 'agent-chat-history-read-only' })
    const replay = await request(`tasks/${a.sessionId}/prompt`, 'POST', { ...queued, queue: true })
    expect(replay.status).toBe(202)
    expect(await replay.json()).toEqual({ queued: { id: queueId } })
    const detail = (await (await request(`tasks/${a.sessionId}`)).json()) as TaskDetail
    expect(detail.messages.filter(message => message.role === 'user').map(message => message.text)).toEqual([older.prompt])
  } finally {
    await host?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('recovers an accepted General chat after restarting before the Host binding was saved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'latch-personal-chat-recover-'))
  let host: TestHost | undefined
  try {
    const options = { dataDir: join(root, 'data'), workspaceRoot: join(root, 'workspace'), plugins: [plugin([])] }
    host = await startTestHost(options)
    const owner = await host.enroll({ listener: 'unix' })
    const input = { customAgentId: 'general', prompt: 'Accepted before restart', requestId: randomUUID(), model }
    const started = await owner.json<{ sessionId: string }>('tasks', { method: 'POST', body: input })
    await settled(owner, started.sessionId)
    await host.close()

    const journal = join(options.dataDir, 'agents', 'custom.json')
    const before = JSON.parse(await readFile(journal, 'utf8')) as { chats: { general: { state: string; sessionId?: string } } }
    before.chats.general.state = 'starting'
    delete before.chats.general.sessionId
    await writeFile(journal, JSON.stringify(before))
    const metaFile = join(options.dataDir, 'sessions-meta.json')
    const meta = JSON.parse(await readFile(metaFile, 'utf8')) as { sessions: Array<{ id: string; generalChat?: boolean }> }
    delete meta.sessions.find(session => session.id === started.sessionId)?.generalChat
    await writeFile(metaFile, JSON.stringify(meta))

    host = await startTestHost(options)
    const request = (path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET', body?: object) =>
      host!.raw('unix', `api/${path}`, {
        method,
        headers: { authorization: `Latch-Device ${owner.credential}` },
        ...(body ? { body } : {}),
      })
    const held = (await (await request('snapshot')).json()) as AppSnapshot
    expect(held.agentChats?.general).toEqual({ state: 'starting' })
    for (const [method, body] of [
      ['PATCH', { archived: true }],
      ['DELETE', undefined],
    ] as const) {
      const removal = await request(`tasks/${started.sessionId}`, method, body)
      expect(removal.status).toBe(409)
      expect(await removal.json()).toMatchObject({ error: 'agent-chat-starting' })
    }
    const denied = await request('tasks', 'POST', { ...input, requestId: randomUUID() })
    expect(denied.status).toBe(409)
    const recovered = await request('tasks', 'POST', input)
    expect(recovered.status).toBe(201)
    expect(await recovered.json()).toEqual(started)
    const snapshot = (await (await request('snapshot')).json()) as AppSnapshot
    expect(snapshot.agentChats?.general).toEqual({ state: 'ready', sessionId: started.sessionId })
    const detail = (await (await request(`tasks/${started.sessionId}`)).json()) as TaskDetail
    expect(detail.messages.filter(message => message.role === 'user').map(message => message.text)).toEqual([input.prompt])
  } finally {
    await host?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('keeps the Agent home private and stable across topics and a Host restart, without changing ordinary Code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'latch-helper-home-'))
  let active: TestHost | undefined
  try {
    const options = { dataDir: join(root, 'data'), workspaceRoot: join(root, 'workspace'), plugins: [plugin([])], sessionFolders: false }
    const first = await startTestHost(options)
    active = first
    const owner = await first.enroll({ listener: 'unix' })
    const agent = await owner.json<CustomAgent>('custom-agents', { method: 'POST', body: definition({ mode: 'agent' }) })
    const expected = join(options.workspaceRoot, 'helpers', agent.id)
    expect(await owner.json(`custom-agents/${agent.id}/home`)).toMatchObject({ path: expected, available: false })
    await expect(stat(expected)).rejects.toMatchObject({ code: 'ENOENT' })
    const input = { customAgentId: agent.id, prompt: 'First topic', requestId: randomUUID() }
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', { method: 'POST', body: input })
    await settled(owner, sessionId)
    expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary).toMatchObject({
      cwd: expected,
      workspaceId: 'default',
    })
    expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.sessionFolder).toBeUndefined()
    expect((await stat(expected)).mode & 0o777).toBe(0o700)
    expect(await owner.json(`custom-agents/${agent.id}/home`)).toMatchObject({ available: true })
    await writeFile(join(expected, 'kept.txt'), 'between topics')
    const resolved = await owner.json<{ files: Array<{ status: string; file?: { handle: string } }> }>(`tasks/${sessionId}/files/resolve`, {
      method: 'POST',
      body: { paths: ['kept.txt'] },
    })
    expect(resolved.files[0]?.status).toBe('ok')
    const handle = resolved.files[0]!.file!.handle
    expect(await (await owner.request(`files/${handle}`)).text()).toBe('between topics')
    const publicProject = await owner.addFolders({ paths: [expected], name: 'must stay private' })
    expect(publicProject.status).toBe(409)
    expect(await publicProject.json()).toMatchObject({ error: 'helper-home-overlap' })
    expect((await owner.json<CustomAgentDetail>(`custom-agents/${agent.id}`)).agent).toMatchObject({ home: `helpers/${agent.id}` })
    expect((await owner.json<{ workspaces: WorkspaceInfo[] }>('workspaces')).workspaces.some(project => project.path === expected)).toBe(
      false,
    )
    const work = await first.enroll({ listener: 'loopback-tcp' })
    await owner.json(`devices/${work.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
    expect((await work.request(`custom-agents/${agent.id}`)).status).toBe(403)
    expect((await work.request(`custom-agents/${agent.id}/home`)).status).toBe(403)
    expect((await work.request(`tasks/${sessionId}/files/resolve`, { method: 'POST', body: { paths: ['kept.txt'] } })).status).toBe(403)
    expect((await work.request(`files/${handle}`)).status).toBe(403)
    expect(JSON.stringify(await work.json<AppSnapshot>('snapshot'))).not.toContain(agent.id)
    await first.close()
    const next = await startTestHost(options)
    active = next
    const device = await next.enroll({ listener: 'unix' })
    await device.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'Continue', requestId: randomUUID() } })
    await settled(device, sessionId)
    const refused = await device.request('tasks', { method: 'POST', body: { ...input, requestId: randomUUID() } })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ error: 'agent-chat-exists', sessionId })
    expect((await device.json<TaskDetail>(`tasks/${sessionId}`)).summary.cwd).toBe(expected)
    const code = await device.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: 'Code', model, mode: 'agent', requestId: randomUUID() },
    })
    await settled(device, code.sessionId)
    expect((await device.json<TaskDetail>(`tasks/${code.sessionId}`)).summary.cwd).toBe(options.workspaceRoot)
    await device.json(`custom-agents/${agent.id}`, { method: 'DELETE', body: { requestId: randomUUID() } })
    expect(await readFile(join(expected, 'kept.txt'), 'utf8')).toBe('between topics')
  } finally {
    await active?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('starts new 通用 topics on Standard Agent in its fixed home and refuses another Harness', async () => {
  const { host, owner } = await fixture()
  const body = { customAgentId: 'general', prompt: 'Hello', mode: 'agent', model, requestId: randomUUID() }
  const started = await owner.json<{ sessionId: string }>('tasks', { method: 'POST', body })
  await settled(owner, started.sessionId)
  expect((await owner.json<TaskDetail>(`tasks/${started.sessionId}`)).summary).toMatchObject({
    generalChat: true,
    agentPrivate: true,
    harnessId: 'standard',
    mode: 'agent',
    cwd: join(host.workspaceRoot, 'helpers', 'general'),
  })
  expect((await owner.json<TaskDetail>(`tasks/${started.sessionId}`)).summary.sessionFolder).toBeUndefined()
  expect((await owner.json<GeneralAgentDetail>('custom-agents/general')).general).toMatchObject({ home: 'helpers/general' })
  const legacy = { ...body, requestId: randomUUID(), harnessId: 'other' }
  for (let retry = 0; retry < 2; retry++) {
    const refused = await owner.request('tasks', { method: 'POST', body: legacy })
    expect(refused.status).toBe(503)
    expect(await refused.json()).toMatchObject({ error: 'general-start-unconfirmed' })
  }
  expect((await owner.json<AppSnapshot>('snapshot')).tasks.map(task => task.id)).toEqual([started.sessionId])
})

test('preserves an actual legacy Standard General chat receipt without upgrading it or allocating a home', async () => {
  const { host, owner, seen } = await fixture()
  const legacy = {
    requestId: randomUUID(),
    prompt: 'Legacy General chat',
    harnessId: 'standard',
    mode: 'chat' as const,
    workspaceId: 'default',
    model,
  }
  // The previous Host recorded this exact Standard receipt, but had no CustomAgents start selection for General.
  const old = await host.host.bridge.createTask({
    ...legacy,
    cwd: host.workspaceRoot,
    generalChat: true,
    agentContext: { instructions: '', revision: '1'.repeat(64), proposals: true },
  })
  await settled(owner, old.sessionId)
  const before = await owner.json<TaskDetail>(`tasks/${old.sessionId}`)
  expect(before.summary.mode).toBe('chat')
  await expect(stat(join(host.workspaceRoot, 'helpers', 'general'))).rejects.toMatchObject({ code: 'ENOENT' })
  for (let retry = 0; retry < 2; retry++) {
    const reply = await owner.request('tasks', { method: 'POST', body: { ...legacy, customAgentId: 'general' } })
    expect(reply.status).toBe(503)
    expect(await reply.json()).toMatchObject({ error: 'general-start-unconfirmed' })
  }
  expect((await owner.json<AppSnapshot>('snapshot')).tasks.map(task => task.id)).toEqual([old.sessionId])
  expect(await owner.json<TaskDetail>(`tasks/${old.sessionId}`)).toEqual(before)
  expect(seen).toHaveLength(1)
  await expect(stat(join(host.workspaceRoot, 'helpers', 'general'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test.each(['custom', 'general'])('writes only in the %s home after the original R1 approval', async kind => {
  const writes: HarnessPlugin = {
    id: 'home-writer',
    name: 'Home writer',
    version: '1',
    description: '',
    activate(context) {
      context.registerProvider({
        id: 'home-writer',
        name: 'Home writer',
        model: 'fixture',
        async *stream({ messages }) {
          if (messages.some(message => message.role === 'tool')) {
            yield { type: 'text', text: 'Saved notes.md' }
            yield { type: 'finish', reason: 'stop' }
          } else {
            yield {
              type: 'tool-call',
              call: { id: 'write-home', name: 'write_file', arguments: { path: 'notes.md', content: 'Private home note' } },
            }
            yield { type: 'finish', reason: 'tool-calls' }
          }
        },
      })
    },
  }
  const { host, owner } = await fixture({ plugins: [writes] })
  const model = { providerId: 'home-writer', model: 'fixture' }
  const agentId =
    kind === 'general'
      ? 'general'
      : (
          await owner.json<CustomAgent>('custom-agents', {
            method: 'POST',
            body: definition({ mode: 'agent', model }),
          })
        ).id
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: {
      customAgentId: agentId,
      prompt: 'Write the note',
      model,
      requestId: randomUUID(),
    },
  })
  await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).approvals.length).toBe(1)
  const approval = (await owner.json<TaskDetail>(`tasks/${sessionId}`)).approvals[0]!
  expect(approval).toMatchObject({ toolName: 'write_file', risk: 'R1' })
  const file = join(host.workspaceRoot, 'helpers', agentId, 'notes.md')
  await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  await owner.json(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'allow', requestId: randomUUID() } })
  await settled(owner, sessionId)
  expect(await readFile(file, 'utf8')).toBe('Private home note')
  await expect(stat(join(host.workspaceRoot, 'notes.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('refuses a client-chosen home, a registered project collision and a replaced home before another prompt', async () => {
  const { host, owner, seen } = await fixture()
  const malicious = await owner.request('custom-agents', { method: 'POST', body: { ...definition(), home: 'helpers/general' } })
  expect(malicious.status).toBe(400)
  const agent = await owner.json<CustomAgent>('custom-agents', { method: 'POST', body: definition({ mode: 'agent' }) })
  const changed = await owner.request(`custom-agents/${agent.id}`, {
    method: 'PATCH',
    body: { requestId: randomUUID(), baseRevision: agent.revision, home: 'helpers/general' },
  })
  expect(changed.status).toBe(400)
  const path = join(host.workspaceRoot, 'helpers', agent.id)
  await mkdir(path, { recursive: true, mode: 0o700 })
  await writeFile(join(path, 'project.txt'), 'existing project')
  expect((await owner.addFolders({ paths: [path], name: 'existing' })).status).toBeLessThan(300)
  const denied = await owner.request('tasks', { method: 'POST', body: { customAgentId: agent.id, prompt: 'No', requestId: randomUUID() } })
  expect(denied.status).toBe(409)
  expect(await denied.json()).toMatchObject({ error: 'helper-home-overlap' })
  expect(await readFile(join(path, 'project.txt'), 'utf8')).toBe('existing project')
  expect(seen).toHaveLength(0)
  const next = await owner.json<CustomAgent>('custom-agents', { method: 'POST', body: definition({ mode: 'agent' }) })
  const started = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { customAgentId: next.id, prompt: 'Yes', requestId: randomUUID() },
  })
  await settled(owner, started.sessionId)
  const home = join(host.workspaceRoot, 'helpers', next.id)
  await rename(home, join(host.root, 'kept-home'))
  await mkdir(home, { mode: 0o700 })
  const followup = await owner.request(`tasks/${started.sessionId}/prompt`, {
    method: 'POST',
    body: { prompt: 'No replacement', requestId: randomUUID() },
  })
  expect(followup.status).toBe(409)
  expect(await followup.json()).toMatchObject({ error: 'helper-home-unavailable' })
  expect(seen).toHaveLength(1)
})

test('applies the Agent defaults through the existing start-config path before its first prompt and replays the same start', async () => {
  const { host, owner } = await fixture()
  const log = join(host.root, 'helper-options.jsonl')
  expect(
    (
      await owner.confirmed('agents', {
        method: 'POST',
        body: {
          id: 'helper-options',
          name: 'Helper options',
          command: process.execPath,
          args: [FAKE_ACP_AGENT],
          env: { FAKE_ACP_LOG: log, FAKE_ACP_CONFIG: 'options', FAKE_ACP_MODES: 'build,plan', FAKE_ACP_EFFORT_BY_MODEL: '1' },
        },
      })
    ).status,
  ).toBe(201)
  const agent = await owner.json<CustomAgent>('custom-agents', {
    method: 'POST',
    body: definition({
      harnessId: 'helper-options',
      mode: 'agent',
      model: undefined,
      engineOptions: { model: 'large', effort: 'max', mode: 'plan' },
    }),
  })
  const input = { customAgentId: agent.id, prompt: 'echo configured', requestId: randomUUID() }
  const started = await owner.json<{ sessionId: string }>('tasks', { method: 'POST', body: input })
  await settled(owner, started.sessionId)
  const detail = await owner.json<TaskDetail>(`tasks/${started.sessionId}`)
  expect(detail.config?.map(item => [item.id, item.currentValue])).toEqual(
    expect.arrayContaining([
      ['model', 'large'],
      ['effort', 'max'],
      ['mode', 'plan'],
    ]),
  )
  const calls = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { event: string; method?: string; params?: { configId?: string; value?: string } })
    .filter(item => item.event === 'recv')
  const beforePrompt = calls.slice(
    0,
    calls.findIndex(item => item.method === 'session/prompt'),
  )
  expect(
    beforePrompt.filter(item => item.method === 'session/set_config_option').map(item => [item.params?.configId, item.params?.value]),
  ).toEqual([
    ['model', 'large'],
    ['effort', 'max'],
    ['mode', 'plan'],
  ])
  await owner.json(`custom-agents/${agent.id}`, {
    method: 'PATCH',
    body: { requestId: randomUUID(), baseRevision: agent.revision, engineOptions: { model: 'small', effort: 'low', mode: 'build' } },
  })
  expect(await owner.json('tasks', { method: 'POST', body: input })).toEqual(started)
  expect((await owner.json<AppSnapshot>('snapshot')).tasks).toHaveLength(1)
  expect((await owner.json<TaskDetail>(`tasks/${started.sessionId}`)).config?.find(item => item.id === 'model')?.currentValue).toBe('large')
})

test('does not send the first helper prompt or later input when the saved permission cannot be read back', async () => {
  const { host, owner } = await fixture()
  const log = join(host.root, 'helper-sticky-mode.jsonl')
  await owner.confirmedJson('agents', {
    method: 'POST',
    body: {
      id: 'sticky-helper',
      name: 'Sticky helper',
      command: process.execPath,
      args: [FAKE_ACP_AGENT],
      env: { FAKE_ACP_LOG: log, FAKE_ACP_CONFIG: 'options', FAKE_ACP_MODES: 'build,plan', FAKE_ACP_STICKY_MODE: '1' },
    },
  })
  const agent = await owner.json<CustomAgent>('custom-agents', {
    method: 'POST',
    body: definition({
      harnessId: 'sticky-helper',
      mode: 'agent',
      model: undefined,
      engineOptions: { mode: 'plan' },
    }),
  })
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: {
      customAgentId: agent.id,
      prompt: 'Must not send',
      requestId: randomUUID(),
    },
  })
  await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('failed')
  const again = await owner.request(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'Still no', requestId: randomUUID() } })
  expect(again.status).toBe(409)
  expect(await again.json()).toMatchObject({ error: 'permission-unverified' })
  expect(await readFile(log, 'utf8')).not.toContain('session/prompt')
})

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

test('uses the saved Standard model on the next chat turn unless that turn explicitly chooses one', async () => {
  const second = { providerId: 'second-service', model: 'second-model' }
  const alternate: HarnessPlugin = {
    id: second.providerId,
    name: 'second service',
    version: '1',
    description: '',
    activate(ctx) {
      ctx.registerProvider({
        id: second.providerId,
        name: 'second service',
        model: second.model,
        async *stream() {
          yield { type: 'text', text: 'Answer from second' }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  const { owner } = await fixture({ plugins: [plugin([]), alternate] })
  const agent = await owner.json<CustomAgent>('custom-agents', { method: 'POST', body: definition() })
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { customAgentId: agent.id, prompt: 'first', requestId: randomUUID() },
  })
  await settled(owner, sessionId)
  await owner.json(`custom-agents/${agent.id}`, {
    method: 'PATCH',
    body: { requestId: randomUUID(), baseRevision: agent.revision, model: second },
  })
  const prompt = async (word: string, picked?: typeof model) => {
    await owner.json(`tasks/${sessionId}/prompt`, {
      method: 'POST',
      body: { prompt: word, requestId: randomUUID(), ...(picked ? { model: picked } : {}) },
    })
    await settled(owner, sessionId)
    return owner.json<TaskDetail>(`tasks/${sessionId}`)
  }
  expect((await prompt('second')).summary).toMatchObject(second)
  expect((await prompt('explicit once', model)).summary).toMatchObject(model)
  expect((await prompt('profile again')).summary).toMatchObject(second)
  expect((await owner.json<AppSnapshot>('snapshot')).agentChats?.[agent.id]).toEqual({ state: 'ready', sessionId })
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

test('uses the actual Agent Harness level for the unattended ceiling before accepting a native schedule', async () => {
  const { host, owner } = await fixture()
  const log = join(host.root, 'unattended.jsonl')
  await owner.confirmedJson('agents', {
    method: 'POST',
    body: {
      id: 'native-schedule',
      name: 'Native schedule',
      command: process.execPath,
      args: [FAKE_ACP_AGENT],
      env: { FAKE_ACP_LOG: log },
    },
  })
  const agent = await owner.json<CustomAgent>('custom-agents', {
    method: 'POST',
    body: definition({ harnessId: 'native-schedule', model: undefined, mode: 'agent' }),
  })
  const response = await owner.request('automations', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      customAgentId: agent.id,
      name: 'Never widen unattended',
      prompt: 'Do not send',
      schedule: { kind: 'daily', time: '09:00' },
      notify: false,
    },
  })
  expect(response.status).toBe(403)
  expect(await response.json()).toMatchObject({ error: 'automation-level', message: '这个 Harness 是 L3，后台运行最高 L1。' })
  expect((await owner.json<CustomAgentList>('custom-agents')).agents.find(item => item.id === agent.id)?.canAutomate).toBe(false)
  expect((await owner.json<AppSnapshot>('snapshot')).tasks).toHaveLength(0)
  expect(await readFile(log, 'utf8').catch(() => '')).not.toContain('session/prompt')
})

test('saves a native task closed and permits only an explicit manual run, without granting background execution', async () => {
  const { host, owner } = await fixture()
  await owner.confirmedJson('agents', {
    method: 'POST',
    body: {
      id: 'manual-only',
      name: 'Manual only',
      command: process.execPath,
      args: [FAKE_ACP_AGENT],
      env: { FAKE_ACP_CONFIG: 'options', FAKE_ACP_MODES: 'build,plan' },
    },
  })
  const agent = await owner.json<CustomAgent>('custom-agents', {
    method: 'POST',
    body: definition({
      harnessId: 'manual-only',
      model: undefined,
      mode: 'agent',
      engineOptions: { model: 'large', effort: 'high', mode: 'plan' },
    }),
  })
  const saved = await owner.json<Automation>('automations', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      customAgentId: agent.id,
      name: 'Only when asked',
      prompt: 'echo manual',
      schedule: { kind: 'daily', time: '09:00' },
      notify: false,
      enabled: false,
    },
  })
  expect(saved).toMatchObject({ enabled: false, state: 'off' })
  expect(saved.nextRunAt).toBeUndefined()
  expect((await owner.json<AppSnapshot>('snapshot')).tasks).toHaveLength(0)
  const enabled = await owner.request(`automations/${saved.id}/enabled`, {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      baseRevision: saved.revision,
      enabled: true,
    },
  })
  expect(enabled.status).toBe(403)
  const run = { requestId: randomUUID() }
  await owner.json(`automations/${saved.id}/run`, { method: 'POST', body: run })
  await expect
    .poll(async () => (await owner.json<AutomationDetail>(`automations/${saved.id}`)).automation.lastRun?.state, { timeout: 8000 })
    .toBe('completed')
  const after = (await owner.json<AutomationDetail>(`automations/${saved.id}`)).automation
  expect(after).toMatchObject({ enabled: false, state: 'off', lastRun: { trigger: 'manual' } })
  expect(after.nextRunAt).toBeUndefined()
  const performed = await owner.json<TaskDetail>(`tasks/${after.lastRun!.sessionId}`)
  expect(performed.summary.cwd).toBe(join(host.workspaceRoot, 'helpers', agent.id))
  expect(performed.config?.map(option => [option.id, option.currentValue])).toEqual(
    expect.arrayContaining([
      ['model', 'large'],
      ['effort', 'high'],
      ['mode', 'plan'],
    ]),
  )
  await owner.json(`automations/${saved.id}/run`, { method: 'POST', body: run })
  await new Promise(resolve => setTimeout(resolve, 650))
  expect((await owner.json<AppSnapshot>('snapshot')).tasks).toHaveLength(1)
  expect((await owner.json<AutomationDetail>(`automations/${saved.id}`)).automation.enabled).toBe(false)
  const limited = await host.enroll({ listener: 'unix', name: 'No manual run' })
  await owner.json(`devices/${limited.id}`, { method: 'PATCH', body: { scopes: ['view'] } })
  const denied = await limited.request(`automations/${saved.id}/run`, { method: 'POST', body: { requestId: randomUUID() } })
  expect(denied.status).toBe(403)
  expect((await owner.json<AppSnapshot>('snapshot')).tasks).toHaveLength(1)
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
  expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary).toMatchObject({
    cwd: join(host.workspaceRoot, 'helpers', 'general'),
  })
  expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.sessionFolder).toBeUndefined()
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
    const body = { prompt: 'Hello', mode: 'agent', model, customAgentId: 'general' }
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
    // Nothing of it reaches the stream, not even an ID-less hint that would say when it moved.
    // Wait for the later public session's complete SSE frame before inspecting what the work device heard.
    const hints = () =>
      heard
        .split('\n\n')
        .slice(0, -1)
        .filter(frame => frame.includes('event: tasks-invalidated'))
    await expect.poll(hints, { timeout: 4_000 }).toContainEqual(expect.stringContaining(plain.sessionId))
    expect(heard).not.toContain(sessionId)
    expect(heard).not.toContain('Hello')
    expect(hints().every(frame => frame.includes('"sessionId"'))).toBe(true)

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

test('keeps L3 manual starts on record, refuses unattended L3 and runs 通用 through the schedule route', async () => {
  const { host, owner } = await fixture()
  const defined = await owner.confirmed('agents', {
    method: 'POST',
    body: {
      id: 'fake-engine',
      name: 'Fake',
      command: process.execPath,
      args: [FAKE_ACP_AGENT],
      env: { FAKE_ACP_CONFIG: 'options', FAKE_ACP_MODES: 'build,plan' },
    },
  })
  expect(defined.status).toBe(201)
  const agent = await owner.json<CustomAgent>('custom-agents', {
    method: 'POST',
    body: definition({
      harnessId: 'fake-engine',
      mode: 'agent',
      model: undefined,
      skills: [],
      engineOptions: { model: 'large', effort: 'high', mode: 'plan' },
    }),
  })
  const asked = host.presence.requests.length
  const onHarness = await owner.request('automations', {
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
  expect(onHarness.status).toBe(403)
  // The refusal names the Harness's level, not the device.
  expect(await onHarness.json()).toMatchObject({
    error: 'automation-level',
    message: expect.stringMatching(/^这个 Harness 是 L\d，后台运行最高 L\d。$/u),
  })
  const manual = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: {
      customAgentId: agent.id,
      prompt: 'Manual start',
      requestId: randomUUID(),
    },
  })
  await settled(owner, manual.sessionId)
  const performed = await owner.json<TaskDetail>(`tasks/${manual.sessionId}`)
  expect(performed.summary.cwd).toBe(join(host.workspaceRoot, 'helpers', agent.id))
  expect(performed.config?.map(option => [option.id, option.currentValue])).toEqual(
    expect.arrayContaining([
      ['model', 'large'],
      ['effort', 'high'],
      ['mode', 'plan'],
    ]),
  )
  expect(host.presence.requests).toHaveLength(asked)
  const records = (await readFile(join(host.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { action: string; stepup?: string; detail: Record<string, unknown> })
  expect(records.find(record => record.action === 'task.l3.started')).toMatchObject({
    stepup: 'none',
    detail: { harnessId: 'fake-engine', promptHash: expect.any(String), configHash: expect.any(String) },
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
  expect(list.automations.map(item => item.id)).toEqual([general.id])
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
  await owner.json(`custom-agents/${agent.id}`, {
    method: 'PATCH',
    body: { requestId: randomUUID(), baseRevision: agent.revision, instructions: 'UPDATED ACP INSTRUCTIONS' },
  })
  await owner.json(`tasks/${sessionId}/prompt`, {
    method: 'POST',
    body: { prompt: 'echo in old context', requestId: randomUUID() },
  })
  await settled(owner, sessionId)
  await owner.json(`tasks/${sessionId}/prompt`, {
    method: 'POST',
    body: { prompt: 'echo in fresh context', requestId: randomUUID(), freshContext: true },
  })
  await settled(owner, sessionId)
  const users = (await owner.json<TaskDetail>(`tasks/${sessionId}`)).messages.filter(message => message.role === 'user')
  expect(users.map(message => message.text)).toEqual(['echo hello', 'echo in old context', 'echo in fresh context'])
  expect(users[1]?.agentBrief).toBeUndefined()
  expect(users[2]).toMatchObject({ freshContext: true })
  expect(users[2]?.agentBrief?.segments).toContainEqual({ source: 'user', text: 'UPDATED ACP INSTRUCTIONS' })

  // Deleting the Agent keeps its ACP history readable, with no fourth ordinary turn.
  await owner.json(`custom-agents/${agent.id}`, { method: 'DELETE', body: { requestId: randomUUID() } })
  const next = await owner.confirmed(`tasks/${sessionId}/prompt`, {
    method: 'POST',
    body: { prompt: 'echo again', requestId: randomUUID() },
  })
  expect(next.status).toBe(409)
  expect(await next.json()).toMatchObject({ error: 'agent-deleted' })
  expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).messages.filter(message => message.role === 'user')).toEqual(users)
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
    expect(await delegate(loose, 'default')).toMatchObject({
      workspaceId: 'default',
      agent: { customAgentId: loose.id },
      cwd: join(host.workspaceRoot, 'helpers', loose.id),
    })
    expect(await delegate(placed, notes.id)).toMatchObject({ workspaceId: notes.id, cwd: notes.path })
    const override = await owner.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: definition({ name: '另一个项目 Agent', mode: 'agent', defaultProjectId: notes.id }),
    })
    // An unavailable start leaves the slot empty, so this Agent can still start in its own folder.

    const gone = await owner.request('tasks', {
      method: 'POST',
      body: {
        customAgentId: override.id,
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
    expect(await delegate(override, 'default')).toMatchObject({
      workspaceId: 'default',
      cwd: join(host.workspaceRoot, 'helpers', override.id),
    })
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

test("an Agent's computer: missed times with their cause, its switches, the desktop report and the keep-awake times", async () => {
  let shift = 0
  const { host, owner } = await fixture({ now: () => Date.now() + shift })
  const agent = await owner.json<CustomAgent>('custom-agents', { method: 'POST', body: definition() })
  const at = new Date(Date.now() + 10 * 60_000)
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const automation = await owner.json<Automation>('automations', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      name: '晨报',
      customAgentId: agent.id,
      prompt: '写晨报',
      schedule: { kind: 'daily', time },
      notify: false,
    },
  })
  // Switches: stored on the Agent, through the revision and the request, and outside what its runs receive.
  const patched = await owner.json<CustomAgent>(`custom-agents/${agent.id}`, {
    method: 'PATCH',
    body: {
      requestId: randomUUID(),
      baseRevision: agent.revision,
      notifications: { completed: false, failed: true, waiting: true },
      keepAwakeForSchedules: true,
    },
  })
  expect(patched).toMatchObject({ notifications: { completed: false, failed: true, waiting: true }, keepAwakeForSchedules: true })
  const refused = await owner.request(`custom-agents/${agent.id}`, {
    method: 'PATCH',
    body: { requestId: randomUUID(), baseRevision: patched.revision, notifications: { completed: false } },
  })
  expect(refused.status).toBe(400)
  const snapshot = await owner.json<AppSnapshot>('snapshot')
  expect(snapshot.customAgents?.find(item => item.id === agent.id)).toMatchObject({ keepAwakeForSchedules: true })
  expect(snapshot.computer).toEqual({ desktop: false })
  expect(snapshot.automations?.find(item => item.id === automation.id)).toMatchObject({ enabled: true })
  // host-info (host.sock only) gives the desktop app the time, never an ID.
  const info = await queryHostInfo(host.host.socketPath)
  expect(info.scheduleWake).toEqual({ next: snapshot.automations!.find(item => item.id === automation.id)!.nextRunAt, running: 0 })
  expect(JSON.stringify(info)).not.toContain(automation.id)
  expect(JSON.stringify(info)).not.toContain(agent.id)
  // The desktop app reports what it keeps awake; a page cannot (only host.sock is heard).
  expect(
    (await host.raw('loopback-tcp', 'api/host/state', { method: 'POST', body: { state: 'desktop', keepAwake: 'schedule' } })).status,
  ).toBe(404)
  expect((await host.raw('unix', 'api/host/state', { method: 'POST', body: { state: 'desktop', keepAwake: 'schedule' } })).status).toBe(200)
  expect((await host.raw('unix', 'api/host/state', { method: 'POST', body: { state: 'desktop', keepAwake: 'forever' } })).status).toBe(400)
  expect((await owner.json<AppSnapshot>('snapshot')).computer).toEqual({ desktop: true, keepAwake: 'schedule' })
  // The Mac sleeps past the time: the scheduler records the miss, the sleep report gives its cause.
  expect((await host.raw('unix', 'api/host/state', { method: 'POST', body: { state: 'sleeping' } })).status).toBe(200)
  shift = at.getTime() - Date.now() + 5 * 60_000
  await expect
    .poll(async () => (await owner.json<AgentComputer>(`custom-agents/${agent.id}/computer`)).missed.length, { timeout: 10_000 })
    .toBe(1)
  expect((await host.raw('unix', 'api/host/state', { method: 'POST', body: { state: 'awake' } })).status).toBe(200)
  const view = await owner.json<AgentComputer>(`custom-agents/${agent.id}/computer`)
  expect(view.missed).toEqual([{ automationId: automation.id, name: '晨报', at: expect.any(String), cause: 'sleep' }])
  expect(view.computer.wokeAt).toBeTruthy()
  expect((await owner.json<AgentComputer>('custom-agents/general/computer')).missed).toEqual([])
  // Only a device that may read Agents sees any of it.
  const limited = await host.enroll({ listener: 'loopback-tcp' })
  await owner.json(`devices/${limited.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
  expect((await limited.request(`custom-agents/${agent.id}/computer`)).status).toBe(403)
  expect(await limited.json<AppSnapshot>('snapshot')).not.toHaveProperty('computer')
})

test('an Agent keeps the Harness it was created on: a change is refused, and so is a start on another', async () => {
  const { owner } = await fixture()
  const defined = await owner.confirmed('agents', {
    method: 'POST',
    body: { id: 'fake-engine', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT], env: {} },
  })
  expect(defined.status).toBe(201)
  const agent = await owner.json<CustomAgent>('custom-agents', { method: 'POST', body: definition() })
  const moved = await owner.request(`custom-agents/${agent.id}`, {
    method: 'PATCH',
    body: { requestId: randomUUID(), baseRevision: agent.revision, harnessId: 'fake-engine' },
  })
  expect(moved.status).toBe(409)
  expect(await moved.json()).toMatchObject({ error: 'agent-harness-fixed', message: expect.stringContaining('不能换 Harness') })
  expect((await owner.json<CustomAgentDetail>(`custom-agents/${agent.id}`)).agent).toMatchObject({ harnessId: 'standard', revision: 1 })
  // A start on another Harness is refused before anything starts; on its own (or naming none) it starts.
  const elsewhere = await owner.request('tasks', {
    method: 'POST',
    body: { customAgentId: agent.id, prompt: 'Go', requestId: randomUUID(), harnessId: 'fake-engine' },
  })
  expect(elsewhere.status).toBe(400)
  expect(await elsewhere.json()).toMatchObject({ error: 'agent-harness-fixed' })
  expect((await owner.json<AppSnapshot>('snapshot')).tasks.filter(task => task.agent?.customAgentId === agent.id)).toHaveLength(0)
  const requestId = randomUUID()
  const start = { customAgentId: agent.id, prompt: 'Go', requestId, harnessId: 'standard' }
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', { method: 'POST', body: start })
  await settled(owner, sessionId)
  // A retry of that start is answered as the first time.
  expect(await owner.json<{ sessionId: string }>('tasks', { method: 'POST', body: start })).toMatchObject({ sessionId })
})

test('a start on another Harness is refused before that Harness is confirmed or bound: no prompt, no record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'latch-harness-fixed-'))
  let active: TestHost | undefined
  try {
    const options = { dataDir: join(root, 'data'), workspaceRoot: join(root, 'workspace'), plugins: [plugin([])] }
    const first = await startTestHost(options)
    active = first
    const setup = await first.enroll({ listener: 'unix' })
    await setup.confirmed('agents', {
      method: 'POST',
      body: { id: 'fake-engine', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT], env: {} },
    })
    const agent = await setup.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: definition({ harnessId: 'fake-engine', mode: 'agent', model: undefined }),
    })
    await first.close()
    // As saved before definitions were bound to the confirmed program: the Agent's own Harness would ask before its next start.
    const file = join(options.dataDir, 'settings.json')
    const settings = JSON.parse(await readFile(file, 'utf8')) as { agents: Array<Record<string, unknown>> }
    for (const record of settings.agents) delete record.confirmedCommand
    await writeFile(file, JSON.stringify(settings))
    const host = await startTestHost(options)
    active = host
    const owner = await host.enroll({ listener: 'unix' })
    const asked = host.presence.requests.length
    const records = async () => (await readFile(join(options.dataDir, 'audit', 'audit.jsonl'), 'utf8')).trim().split('\n').length
    const before = await records()
    const refused = await owner.request('tasks', {
      method: 'POST',
      body: { customAgentId: agent.id, prompt: 'Go', requestId: randomUUID(), harnessId: 'standard' },
    })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ error: 'agent-harness-fixed' })
    expect(host.presence.requests).toHaveLength(asked)
    expect(await records()).toBe(before)
    expect(JSON.parse(await readFile(file, 'utf8')).agents[0]).not.toHaveProperty('confirmedCommand')
  } finally {
    await active?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('a legacy start retry binds its recorded Harness rather than a later Agent definition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'latch-harness-receipt-'))
  let active: TestHost | undefined
  try {
    const options = { dataDir: join(root, 'data'), workspaceRoot: join(root, 'workspace'), plugins: [plugin([])] }
    const first = await startTestHost(options)
    active = first
    const owner = await first.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: { id: 'fake-engine', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT], env: {} },
    })
    const agent = await owner.json<CustomAgent>('custom-agents', { method: 'POST', body: definition() })
    const start = { customAgentId: agent.id, prompt: 'Keep this receipt', requestId: randomUUID(), harnessId: 'standard' }
    const result = await owner.json<{ sessionId: string }>('tasks', { method: 'POST', body: start })
    await settled(owner, result.sessionId)
    await first.close()
    // Older builds allowed changing an Agent's Harness. Preserve that saved state without executing the old program.
    const agentFile = join(options.dataDir, 'agents', 'custom.json')
    const saved = JSON.parse(await readFile(agentFile, 'utf8')) as { agents: CustomAgent[] }
    saved.agents[0]!.harnessId = 'fake-engine'
    delete saved.agents[0]!.model
    await writeFile(agentFile, JSON.stringify(saved))
    const file = join(options.dataDir, 'settings.json')
    const settings = JSON.parse(await readFile(file, 'utf8')) as { agents: Array<Record<string, unknown>> }
    for (const record of settings.agents) delete record.confirmedCommand
    await writeFile(file, JSON.stringify(settings))
    const host = await startTestHost(options)
    active = host
    const asked = host.presence.requests.length
    const records = async () => (await readFile(join(options.dataDir, 'audit', 'audit.jsonl'), 'utf8')).trim().split('\n').length
    const before = await records()
    const replay = await host.raw('unix', 'api/tasks', {
      method: 'POST',
      headers: { authorization: `Latch-Device ${owner.credential}` },
      body: start,
    })
    expect(replay.status).toBe(201)
    expect(await replay.json()).toEqual(result)
    expect(host.presence.requests).toHaveLength(asked)
    expect(await records()).toBe(before)
    expect(JSON.parse(await readFile(file, 'utf8')).agents[0]).not.toHaveProperty('confirmedCommand')
  } finally {
    await active?.close()
    await rm(root, { recursive: true, force: true })
  }
})
