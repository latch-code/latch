import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '@latch/sdk'
import type { AgentRecord, AppSnapshot, ProviderSettings, TaskDetail, WorkspaceInfo } from '@latch/protocol'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import { createAcpAgentPlugin } from '@latch/harness-acp'
import { FAKE_ACP_AGENT, startFakeModels, type FakeModels, type FakeReply, type TestDevice } from '@latch/testkit'
import { startTestHost, type TestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
})

const KEY_A = 'sk-first-service-0123456789abcdefghij'
const KEY_B = 'sk-second-service-0123456789abcdefghi'
const failed = (status: number): FakeReply => ({ error: { status, message: `status ${status}` } })

async function models(replies: FakeReply[]): Promise<FakeModels> {
  const fake = await startFakeModels({ replies })
  cleanups.push(() => fake.close())
  return fake
}

/** Makes the audit log refuse the named actions, as a full disk would. */
function failAudit(t: TestHost, failing: (action: string) => boolean) {
  const append = t.host.security.audit.append.bind(t.host.security.audit)
  const spy = vi
    .spyOn(t.host.security.audit, 'append')
    .mockImplementation(event =>
      failing(event.action) ? Promise.reject(new AppError(503, 'audit-unavailable', '审计不可用')) : append(event),
    )
  cleanups.push(async () => spy.mockRestore())
}

async function host(demo = false) {
  const t = await startTestHost({
    demo,
    agentPlugin: (agent: AgentRecord) => createAcpAgentPlugin(agent, { stopGraceMs: 100, cancelGraceMs: 500 }),
  })
  cleanups.push(() => t.close())
  const desktop = await t.enroll({ listener: 'unix' })
  const phone = await t.enroll({ scopes: ['view', 'run', 'approve:standard', 'admin'] })
  const viewer = await t.enroll({ scopes: ['view'] })
  const service = async (kind: string, name: string, baseURL: string, apiKey: string, extra: Record<string, unknown> = {}) => {
    const created = await desktop.confirmed('providers', {
      method: 'POST',
      body: { name, kind, baseURL, apiKey, models: ['fake-model'], defaultModel: 'fake-model', confirmOrigin: true, ...extra },
    })
    expect(created.status).toBe(201)
    return ((await created.json()) as { provider: ProviderSettings }).provider
  }
  return { t, desktop, phone, viewer, service }
}

const audit = async (t: TestHost) =>
  (await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { action: string; target?: string; detail: Record<string, unknown> })

const idle = (device: TestDevice, sessionId: string) =>
  vi.waitFor(async () => expect((await device.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle'), { timeout: 15_000 })

const put = async (device: TestDevice, id: string, body: unknown) => {
  const response = await device.request(`providers/${id}`, { method: 'PUT', body })
  return { status: response.status, body: (await response.json()) as { provider?: ProviderSettings; error?: string } }
}

describe('「出错时改用」 and a service limit in the Host', () => {
  it('saves them with admin, shows them to every device without a key, and refuses what names no saved model', async () => {
    const a = await models([{ text: 'a' }])
    const b = await models([{ text: 'b' }])
    const { t, desktop, phone, viewer, service } = await host()
    const first = await service('openai-compatible', 'First', `${a.origin}/v1`, KEY_A)
    const second = await service('openai-compatible', 'Second', `${b.origin}/v1`, KEY_B)
    const prompts = t.presence.requests.length
    // A phone with admin changes them: every candidate is an address already confirmed, so nothing asks on the Mac.
    const saved = await put(phone, first.id, {
      fallbacks: { 'fake-model': [{ providerId: second.id, model: 'fake-model' }] },
      maxConcurrent: 2,
    })
    expect(saved.status).toBe(200)
    expect(saved.body.provider).toMatchObject({
      fallbacks: { 'fake-model': [{ providerId: second.id, model: 'fake-model' }] },
      maxConcurrent: 2,
      hasKey: true,
    })
    expect(t.presence.requests).toHaveLength(prompts)
    expect((await put(viewer, first.id, { maxConcurrent: 3 })).status).toBe(403)
    // What every device reads: the order and no credential.
    const catalog = (await viewer.json<AppSnapshot>('snapshot')).catalog!
    expect(catalog.providers.find(provider => provider.id === first.id)).toMatchObject({
      fallbacks: { 'fake-model': [{ providerId: second.id, model: 'fake-model' }] },
    })
    expect(JSON.stringify(catalog)).not.toContain(KEY_A)
    for (const fallbacks of [
      { 'fake-model': [{ providerId: 'missing', model: 'fake-model' }] },
      { 'fake-model': [{ providerId: second.id, model: 'not-listed' }] },
      { 'fake-model': [{ providerId: first.id, model: 'fake-model' }] },
      {
        'fake-model': [
          { providerId: second.id, model: 'fake-model' },
          { providerId: second.id, model: 'fake-model' },
        ],
      },
    ])
      expect(await put(phone, first.id, { fallbacks })).toMatchObject({ status: 400, body: { error: 'invalid-fallback' } })
    expect((await put(phone, first.id, { maxConcurrent: 0 })).status).toBe(400)
    expect((await put(phone, first.id, { maxConcurrent: 33 })).status).toBe(400)
    // Another edit keeps them; clearing takes each away; the key never moved.
    expect((await put(phone, first.id, { name: 'Renamed' })).body.provider).toMatchObject({
      maxConcurrent: 2,
      fallbacks: expect.any(Object),
    })
    const cleared = await put(phone, first.id, { fallbacks: {}, maxConcurrent: null })
    expect(cleared.body.provider).not.toHaveProperty('fallbacks')
    expect(cleared.body.provider).not.toHaveProperty('maxConcurrent')
    expect(cleared.body.provider).toMatchObject({ hasKey: true })
    const stored = await readFile(join(t.dataDir, 'providers.json'), 'utf8')
    expect(JSON.parse(stored).providers.find((record: { id: string }) => record.id === first.id)).not.toHaveProperty('fallbacks')
    void desktop
  })

  it('answers a built-in session from the fallback when the first service refuses its key, on record first, and marks the turn and the service', async () => {
    const a = await models([failed(401)])
    const b = await models([{ text: 'from the second service' }])
    const { t, phone, viewer, service } = await host()
    const first = await service('openai-compatible', 'First', `${a.origin}/v1`, KEY_A)
    const second = await service('openai-responses', 'Second', `${b.origin}/v1`, KEY_B)
    await put(phone, first.id, { fallbacks: { 'fake-model': [{ providerId: second.id, model: 'fake-model' }] } })
    const started = await phone.request('tasks', {
      method: 'POST',
      body: {
        prompt: 'hello',
        requestId: randomUUID(),
        mode: 'chat',
        harnessId: 'standard',
        model: { providerId: first.id, model: 'fake-model' },
      },
    })
    expect(started.status).toBe(201)
    const { sessionId } = (await started.json()) as { sessionId: string }
    await idle(phone, sessionId)
    const detail = await phone.json<TaskDetail>(`tasks/${sessionId}`)
    expect(detail.messages.filter(message => message.role === 'assistant').map(message => message.text)).toEqual([
      'from the second service',
    ])
    // The session keeps the model it chose; the turn says another service answered.
    expect(detail.summary).toMatchObject({ providerId: first.id, model: 'fake-model' })
    expect(detail.messages.find(message => message.role === 'user')?.turn?.routed).toEqual({
      requests: 1,
      models: [{ model: 'fake-model', requests: 1, fallback: 1, provider: second.id, used: 'fake-model' }],
      direct: true,
    })
    // One request each: the refused key is not tried again, and each service got only its own key.
    expect(a.requests).toMatchObject([{ wire: 'chat-completions', key: KEY_A }])
    expect(b.requests).toMatchObject([{ wire: 'responses', key: KEY_B }])
    const records = await audit(t)
    const switched = records.filter(record => record.action === 'task.model.fallback')
    expect(switched).toEqual([
      expect.objectContaining({ target: sessionId, detail: { sessionId, providerId: first.id, candidate: 1, errorClass: 'auth' } }),
    ])
    const text = await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8')
    for (const secret of [KEY_A, KEY_B, 'from the second service', 'hello']) expect(text).not.toContain(secret)
    // Every device sees how the service fares, in a class and a time; never what it answered.
    const health = (await viewer.json<AppSnapshot>('snapshot')).catalog!.providers.find(provider => provider.id === first.id)?.health
    expect(health).toMatchObject({ state: 'key-invalid', last: 'auth', at: expect.any(String) })
    const settings = (await phone.json<{ providers: ProviderSettings[] }>('providers')).providers.find(item => item.id === first.id)
    expect(settings?.health).toMatchObject({ state: 'key-invalid' })

    // The next turn starts at the fallback, on record again; a real failure of both is the first one's own error.
    await phone.request(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'again', requestId: randomUUID() } })
    await idle(phone, sessionId)
    expect(a.requests).toHaveLength(1)
    expect(b.requests).toHaveLength(2)
    expect((await audit(t)).filter(record => record.action === 'task.model.fallback')).toHaveLength(2)
  })

  it('fails a built-in turn with the service’s own error when no fallback is set: never the demo model, never another service', async () => {
    const a = await models([failed(401)])
    const b = await models([{ text: 'must not be asked' }])
    // A Host that has the demo model, so that not falling back to it is something this run could get wrong.
    const { phone, service } = await host(true)
    expect((await phone.json<AppSnapshot>('snapshot')).catalog!.providers.some(provider => provider.kind === 'demo')).toBe(true)
    const first = await service('openai-compatible', 'First', `${a.origin}/v1`, KEY_A)
    await service('openai-compatible', 'Second', `${b.origin}/v1`, KEY_B)
    // Nor can the demo model be named as what a model falls back to.
    expect(await put(phone, first.id, { fallbacks: { 'fake-model': [{ providerId: 'demo', model: 'demo' }] } })).toMatchObject({
      status: 400,
      body: { error: 'invalid-fallback' },
    })
    const started = await phone.request('tasks', {
      method: 'POST',
      body: {
        prompt: 'hello',
        requestId: randomUUID(),
        mode: 'chat',
        harnessId: 'standard',
        model: { providerId: first.id, model: 'fake-model' },
      },
    })
    const { sessionId } = (await started.json()) as { sessionId: string }
    await vi.waitFor(async () => expect((await phone.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('failed'), {
      timeout: 15_000,
    })
    const detail = await phone.json<TaskDetail>(`tasks/${sessionId}`)
    expect(detail.messages.filter(message => message.role === 'assistant')).toEqual([])
    expect(detail.messages.findLast(message => message.role === 'system')?.text).toContain('401')
    expect(b.requests).toHaveLength(0)
  })

  it('fixes the candidates of a routed session when it starts: in its route hash, its summary and its turns', async () => {
    const a = await models([failed(401)])
    const b = await models([{ text: 'via the fallback' }])
    const { t, desktop, phone, service } = await host()
    const first = await service('openai-compatible', 'First', `${a.origin}/v1`, KEY_A)
    const second = await service('openai-compatible', 'Second', `${b.origin}/v1`, KEY_B)
    const third = await service('anthropic', 'Messages', b.origin, KEY_B)
    // Nothing converts Chat Completions to Anthropic's protocol: that service is left out of this session's candidates.
    await put(phone, first.id, {
      fallbacks: {
        'fake-model': [
          { providerId: third.id, model: 'fake-model' },
          { providerId: second.id, model: 'fake-model' },
        ],
      },
    })
    const agent = await desktop.confirmed('agents', {
      method: 'POST',
      body: {
        id: 'opencode',
        name: 'OpenCode',
        presetId: 'opencode',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: {
          FAKE_ACP_STATE: join(t.root, 'acp-state.json'),
          FAKE_ACP_LOG: join(t.root, 'acp.log'),
          FAKE_ACP_CONFIG: 'options',
          FAKE_ACP_MODES: 'plan,build,auto-edit,yolo',
          FAKE_ACP_INITIAL_MODE: 'build',
          FAKE_ACP_GATEWAY: 'opencode',
          FAKE_ACP_VERSION: '2.2.6',
        },
      },
    })
    expect(agent.status).toBe(201)
    const prompts = t.presence.requests.length
    const started = await phone.request('tasks', {
      method: 'POST',
      body: {
        prompt: 'model hello',
        requestId: randomUUID(),
        mode: 'agent',
        harnessId: 'opencode',
        model: { providerId: first.id, model: 'fake-model' },
      },
    })
    expect(started.status).toBe(201)
    const { sessionId } = (await started.json()) as { sessionId: string }
    await idle(phone, sessionId)
    expect(t.presence.requests).toHaveLength(prompts)
    const detail = await phone.json<TaskDetail>(`tasks/${sessionId}`)
    expect(detail.messages.filter(message => message.role === 'assistant').map(message => message.text)).toEqual([
      'model: via the fallback',
    ])
    expect(detail.summary.modelRoute).toEqual({
      providerId: first.id,
      model: 'fake-model',
      name: 'First',
      fallbacks: [{ providerId: second.id, model: 'fake-model', name: 'Second' }],
    })
    expect(detail.messages.find(message => message.role === 'user')?.turn?.routed).toMatchObject({
      requests: 1,
      models: [{ model: 'fake-model', requests: 1, provider: second.id, fallback: 1 }],
    })
    expect(a.requests).toMatchObject([{ wire: 'chat-completions', key: KEY_A }])
    expect(b.requests).toMatchObject([{ wire: 'chat-completions', key: KEY_B }])
    const route = {
      providerId: first.id,
      model: 'fake-model',
      wire: 'chat-completions',
      origin: a.origin,
      fallbacks: { 'fake-model': [{ providerId: second.id, model: 'fake-model', upstream: 'chat-completions', origin: b.origin }] },
    }
    const records = await audit(t)
    for (const action of ['task.l3.start-requested', 'task.l3.started'])
      expect(records.findLast(record => record.action === action)).toMatchObject({
        detail: { providerId: first.id, routeHash: sha256Hex(canonicalJson(route)) },
      })
    const order = records.map(record => record.action)
    expect(order.indexOf('task.model.fallback')).toBeGreaterThan(order.indexOf('task.l3.started'))
    expect(records.find(record => record.action === 'task.model.fallback')).toMatchObject({
      target: sessionId,
      detail: { sessionId, providerId: first.id, candidate: 1, errorClass: 'auth' },
    })
    const log = await readFile(join(t.root, 'acp.log'), 'utf8')
    const written = await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8')
    for (const text of [log, written]) {
      expect(text).not.toContain(KEY_A)
      expect(text).not.toContain(KEY_B)
    }
    expect(written).not.toMatch(/lmg1\./u)

    // Changing the settings afterwards reaches new sessions only: this one keeps the candidates it started with.
    await put(phone, first.id, { fallbacks: {} })
    await phone.request(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'model again', requestId: randomUUID() } })
    await vi.waitFor(
      async () => {
        const turn = await phone.json<TaskDetail>(`tasks/${sessionId}`)
        expect(turn.messages.filter(message => message.role === 'assistant')).toHaveLength(2)
        expect(turn.summary.status).toBe('idle')
      },
      { timeout: 15_000 },
    )
    const later = await phone.json<TaskDetail>(`tasks/${sessionId}`)
    expect(later.messages.findLast(message => message.role === 'assistant')?.text).toBe('model: via the fallback')
    expect(later.summary.modelRoute?.fallbacks).toEqual([{ providerId: second.id, model: 'fake-model', name: 'Second' }])
    // Turned off, the fallback is passed over: the first service's own failure is what the turn gets.
    await put(phone, second.id, { enabled: false })
    await phone.request(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'model third', requestId: randomUUID() } })
    await vi.waitFor(
      async () => {
        const turn = await phone.json<TaskDetail>(`tasks/${sessionId}`)
        expect(turn.messages.filter(message => message.role === 'assistant')).toHaveLength(3)
        expect(turn.summary.status).toBe('idle')
      },
      { timeout: 15_000 },
    )
    expect((await phone.json<TaskDetail>(`tasks/${sessionId}`)).messages.findLast(message => message.role === 'assistant')?.text).toContain(
      'model error 401',
    )
    expect(b.requests).toHaveLength(2)
  })

  it("leaves a routed Harness on its own default when the start says the person chose it, whatever the project's default is", async () => {
    const a = await models([{ text: 'via the project default' }])
    const { t, desktop, phone, service } = await host()
    const first = await service('openai-compatible', 'First', `${a.origin}/v1`, KEY_A)
    const folder = await realpath(await mkdtemp(join(tmpdir(), 'latch-project-')))
    cleanups.push(() => rm(folder, { recursive: true, force: true }))
    const project = ((await (await desktop.addFolders({ paths: [folder], name: 'Project' })).json()) as { workspace: WorkspaceInfo })
      .workspace
    expect(
      (
        await phone.request(`workspaces/${project.id}`, {
          method: 'PATCH',
          body: { defaultModel: { providerId: first.id, model: 'fake-model' } },
        })
      ).status,
    ).toBe(200)
    const agent = await desktop.confirmed('agents', {
      method: 'POST',
      body: {
        id: 'opencode',
        name: 'OpenCode',
        presetId: 'opencode',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: {
          FAKE_ACP_STATE: join(t.root, 'acp-state.json'),
          FAKE_ACP_LOG: join(t.root, 'acp.log'),
          FAKE_ACP_CONFIG: 'options',
          FAKE_ACP_MODES: 'plan,build,auto-edit,yolo',
          FAKE_ACP_INITIAL_MODE: 'build',
          FAKE_ACP_GATEWAY: 'opencode',
          FAKE_ACP_VERSION: '2.2.6',
        },
      },
    })
    expect(agent.status).toBe(201)
    const start = async (body: Record<string, unknown>) => {
      const response = await phone.request('tasks', {
        method: 'POST',
        body: { prompt: 'echo plain', requestId: randomUUID(), mode: 'agent', harnessId: 'opencode', workspaceId: project.id, ...body },
      })
      expect(response.status).toBe(201)
      const { sessionId } = (await response.json()) as { sessionId: string }
      await idle(phone, sessionId)
      return (await phone.json<TaskDetail>(`tasks/${sessionId}`)).summary
    }
    // Nothing chosen: the project's default, through Latch.
    expect((await start({})).modelRoute).toMatchObject({ providerId: first.id, model: 'fake-model' })
    // The Harness's own default, chosen as such: a session choice, so no route at all.
    expect(await start({ ownModel: true })).not.toHaveProperty('modelRoute')
    // A model named with it is the choice; the flag takes nothing away.
    expect((await start({ ownModel: true, model: { providerId: first.id, model: 'fake-model' } })).modelRoute).toMatchObject({
      providerId: first.id,
    })
  }, 60_000)

  it("keeps the chosen model's own fallbacks in a session's route however many other models of the service have some", async () => {
    const a = await models([{ text: 'first' }])
    const b = await models([{ text: 'second' }])
    const { t, desktop, phone, service } = await host()
    const many = Array.from({ length: 70 }, (_unused, index) => `model-${String(index).padStart(2, '0')}`)
    const first = await service('openai-compatible', 'First', `${a.origin}/v1`, KEY_A, {
      models: [...many, 'zz-chosen'],
      defaultModel: many[0],
    })
    const second = await service('openai-compatible', 'Second', `${b.origin}/v1`, KEY_B)
    const target = [{ providerId: second.id, model: 'fake-model' }]
    // Seventy other models with a fallback each, saved before the one the session picks.
    const saved = await put(phone, first.id, { fallbacks: Object.fromEntries([...many, 'zz-chosen'].map(name => [name, target])) })
    expect(saved.status).toBe(200)
    const agent = await desktop.confirmed('agents', {
      method: 'POST',
      body: {
        id: 'opencode',
        name: 'OpenCode',
        presetId: 'opencode',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: {
          FAKE_ACP_STATE: join(t.root, 'acp-state.json'),
          FAKE_ACP_LOG: join(t.root, 'acp.log'),
          FAKE_ACP_CONFIG: 'options',
          FAKE_ACP_MODES: 'plan,build,auto-edit,yolo',
          FAKE_ACP_INITIAL_MODE: 'build',
          FAKE_ACP_GATEWAY: 'opencode',
          FAKE_ACP_VERSION: '2.2.6',
        },
      },
    })
    expect(agent.status).toBe(201)
    const started = await phone.request('tasks', {
      method: 'POST',
      body: {
        prompt: 'echo plain',
        requestId: randomUUID(),
        mode: 'agent',
        harnessId: 'opencode',
        model: { providerId: first.id, model: 'zz-chosen' },
      },
    })
    expect(started.status).toBe(201)
    const { sessionId } = (await started.json()) as { sessionId: string }
    await idle(phone, sessionId)
    expect((await phone.json<TaskDetail>(`tasks/${sessionId}`)).summary.modelRoute).toMatchObject({
      providerId: first.id,
      model: 'zz-chosen',
      fallbacks: [{ providerId: second.id, model: 'fake-model', name: 'Second' }],
    })
  }, 60_000)

  it('lets a service be renamed, turned off and its key cleared after what its model fell back to was deleted, with no record of what did not happen', async () => {
    const a = await models([{ text: 'a' }])
    const b = await models([{ text: 'b' }])
    const { t, phone, service } = await host()
    const first = await service('openai-compatible', 'First', `${a.origin}/v1`, KEY_A)
    const second = await service('openai-compatible', 'Second', `${b.origin}/v1`, KEY_B, {
      models: ['fake-model', 'other-model'],
    })
    const c = await models([{ text: 'c' }])
    const third = await service('openai-compatible', 'Third', `${c.origin}/v1`, KEY_B)
    await put(phone, first.id, {
      fallbacks: {
        'fake-model': [
          { providerId: second.id, model: 'other-model' },
          { providerId: second.id, model: 'fake-model' },
          { providerId: third.id, model: 'fake-model' },
        ],
      },
    })
    const saved = async () =>
      JSON.parse(await readFile(join(t.dataDir, 'providers.json'), 'utf8')).providers.find(
        (record: { id: string }) => record.id === first.id,
      ).fallbacks as unknown
    // A model the second service loses is nobody's fallback any more…
    expect((await put(phone, second.id, { models: ['fake-model'] })).status).toBe(200)
    expect(await saved()).toEqual({
      'fake-model': [
        { providerId: second.id, model: 'fake-model' },
        { providerId: third.id, model: 'fake-model' },
      ],
    })
    // …and neither is a service that is deleted.
    expect((await phone.request(`providers/${second.id}`, { method: 'DELETE' })).status).toBe(200)
    expect(await saved()).toEqual({ 'fake-model': [{ providerId: third.id, model: 'fake-model' }] })
    // A reference left dangling all the same (an older file, a hand edit) never stands in the way of tightening.
    await t.host.config.updateProviders(draft => {
      draft.find(record => record.id === first.id)!.fallbacks = {
        'fake-model': [
          { providerId: 'gone', model: 'fake-model' },
          { providerId: third.id, model: 'fake-model' },
        ],
      }
    })
    const before = (await audit(t)).length
    // A list a request does send is checked before anything is written: no key is cleared, and nothing says one was.
    const refused = await put(phone, first.id, { apiKey: null, fallbacks: { 'fake-model': [{ providerId: 'gone', model: 'x' }] } })
    expect(refused).toMatchObject({ status: 400, body: { error: 'invalid-fallback' } })
    expect((await audit(t)).slice(before)).toEqual([])
    expect((await phone.json<{ providers: ProviderSettings[] }>('providers')).providers.find(item => item.id === first.id)?.hasKey).toBe(
      true,
    )
    expect((await put(phone, first.id, { name: 'Renamed' })).body.provider).toMatchObject({
      name: 'Renamed',
      fallbacks: { 'fake-model': [{ providerId: third.id, model: 'fake-model' }] },
    })
    expect((await put(phone, first.id, { enabled: false })).status).toBe(200)
    const cleared = await put(phone, first.id, { apiKey: null })
    expect(cleared.status).toBe(200)
    expect(cleared.body.provider).toMatchObject({ hasKey: false, enabled: false })
    // One record, for the one thing that happened; none for the list, which this request did not send.
    expect((await audit(t)).slice(before).map(record => record.action)).toEqual(['provider.secret.cleared'])
  })

  it('puts an edit of the fallback list on record with IDs only: adding or moving waits for the record, removing never does', async () => {
    const a = await models([{ text: 'a' }])
    const b = await models([{ text: 'b' }])
    const { t, phone, service } = await host()
    const first = await service('openai-compatible', 'First', `${a.origin}/v1`, KEY_A)
    const second = await service('openai-compatible', 'Second', `${b.origin}/v1`, KEY_B, { models: ['fake-model', 'other-model'] })
    const one = { providerId: second.id, model: 'fake-model' }
    const two = { providerId: second.id, model: 'other-model' }
    const edits = async () => (await audit(t)).filter(record => record.action === 'provider.fallbacks.changed')
    expect((await put(phone, first.id, { fallbacks: { 'fake-model': [one, two] } })).status).toBe(200)
    expect(await edits()).toEqual([
      expect.objectContaining({ target: first.id, detail: { providerId: first.id, models: 1, candidates: [second.id], widened: true } }),
    ])
    // Saving the same list again is no edit.
    expect((await put(phone, first.id, { fallbacks: { 'fake-model': [one, two] } })).status).toBe(200)
    expect(await edits()).toHaveLength(1)
    const written = await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8')
    for (const text of ['other-model', KEY_A, KEY_B]) expect(written).not.toContain(text)
    // The record cannot be written: a new order or a new candidate is refused and nothing changes…
    failAudit(t, action => action === 'provider.fallbacks.changed')
    expect((await put(phone, first.id, { fallbacks: { 'fake-model': [two, one] } })).status).toBe(503)
    expect((await put(phone, first.id, { fallbacks: { 'fake-model': [one, two, { providerId: first.id, model: 'x' }] } })).status).toBe(400)
    const kept = (await phone.json<{ providers: ProviderSettings[] }>('providers')).providers.find(item => item.id === first.id)
    expect(kept?.fallbacks).toEqual({ 'fake-model': [one, two] })
    // …while taking a candidate away goes ahead, and says its record is missing.
    const removed = await phone.request(`providers/${first.id}`, { method: 'PUT', body: { fallbacks: { 'fake-model': [two] } } })
    expect(removed.status).toBe(200)
    expect(removed.headers.get('x-latch-audit')).toBe('failed')
    expect(((await removed.json()) as { provider: ProviderSettings }).provider.fallbacks).toEqual({ 'fake-model': [two] })
  })

  it("changes nothing a run executes when a service's limit or fallback list is edited: the same plugin and the same revision", async () => {
    const a = await models([{ text: 'a' }])
    const b = await models([{ text: 'b' }])
    const { t, phone, service } = await host()
    const first = await service('openai-compatible', 'First', `${a.origin}/v1`, KEY_A)
    const second = await service('openai-compatible', 'Second', `${b.origin}/v1`, KEY_B)
    const revision = () => t.host.registry.revisionSnapshot([first.id]).revisions[first.id]
    const provider = () => t.host.registry.providers().find(item => item.id === first.id)
    const before = { revision: revision(), provider: provider() }
    expect(before.revision).toEqual(expect.any(String))
    expect((await put(phone, first.id, { maxConcurrent: 3 })).body.provider).toMatchObject({ maxConcurrent: 3 })
    expect((await put(phone, first.id, { fallbacks: { 'fake-model': [{ providerId: second.id, model: 'fake-model' }] } })).status).toBe(200)
    expect(revision()).toBe(before.revision)
    // The very same registered provider: nothing was replaced under a run that may be using it.
    expect(provider()).toBe(before.provider)
    // Something a run does execute still makes a new one.
    expect((await put(phone, first.id, { models: ['fake-model', 'another'] })).status).toBe(200)
    expect(revision()).not.toBe(before.revision)
    // And a restart computes the same revision the running Host had, limit and list included.
    expect(JSON.parse(await readFile(join(t.dataDir, 'providers.json'), 'utf8')).providers[0]).toMatchObject({ maxConcurrent: 3 })
  })

  it("starts a session on the project's default model when neither the session nor its Agent chose one", async () => {
    const a = await models([{ text: 'from the default' }])
    const b = await models([{ text: 'from the project' }])
    const { t, desktop, phone, viewer, service } = await host()
    const first = await service('openai-compatible', 'First', `${a.origin}/v1`, KEY_A)
    const second = await service('openai-compatible', 'Second', `${b.origin}/v1`, KEY_B)
    const folder = await realpath(await mkdtemp(join(tmpdir(), 'latch-project-')))
    cleanups.push(() => rm(folder, { recursive: true, force: true }))
    const added = await desktop.addFolders({ paths: [folder], name: 'Project' })
    expect(added.status).toBe(201)
    const project = ((await added.json()) as { workspace: WorkspaceInfo }).workspace
    const patch = (device: TestDevice, body: unknown) => device.request(`workspaces/${project.id}`, { method: 'PATCH', body })
    expect((await patch(viewer, { defaultModel: { providerId: second.id, model: 'fake-model' } })).status).toBe(403)
    expect((await patch(phone, { defaultModel: { providerId: second.id, model: 'not-listed' } })).status).toBe(400)
    const saved = await patch(phone, { defaultModel: { providerId: second.id, model: 'fake-model' } })
    expect(saved.status).toBe(200)
    expect(((await saved.json()) as { workspace: WorkspaceInfo }).workspace.defaultModel).toEqual({
      providerId: second.id,
      model: 'fake-model',
    })
    expect((await audit(t)).findLast(record => record.action === 'workspace.changed')?.detail).toMatchObject({ modelChanged: true })
    // Kept in the Host's own record of the project, never in the project's folder.
    expect(JSON.parse(await readFile(join(t.dataDir, 'settings.json'), 'utf8')).workspaces[0].defaultModel).toEqual({
      providerId: second.id,
      model: 'fake-model',
    })
    /** Starts a session and says which service answered it. */
    const start = async (body: Record<string, unknown>) => {
      const before = [a.requests.length, b.requests.length]
      const response = await phone.request('tasks', {
        method: 'POST',
        body: { prompt: 'hello', requestId: randomUUID(), mode: 'chat', harnessId: 'standard', ...body },
      })
      expect(response.status).toBe(201)
      const { sessionId } = (await response.json()) as { sessionId: string }
      await idle(phone, sessionId)
      return [a.requests.length - before[0]!, b.requests.length - before[1]!].join(',') === '1,0' ? 'first' : 'second'
    }
    // The project's default; the session's own choice before it; another project is not touched by it.
    expect(await start({ workspaceId: project.id })).toBe('second')
    expect(await start({ workspaceId: project.id, model: { providerId: first.id, model: 'fake-model' } })).toBe('first')
    expect(await start({})).toBe('first')
    // Off, the project's model is no reason to fail a start: the Host's own default stands.
    await put(phone, second.id, { enabled: false })
    expect(await start({ workspaceId: project.id })).toBe('first')
    await put(phone, second.id, { enabled: true })
    const cleared = await patch(phone, { defaultModel: null })
    expect(((await cleared.json()) as { workspace: WorkspaceInfo }).workspace).not.toHaveProperty('defaultModel')
    expect(await start({ workspaceId: project.id })).toBe('first')
  })

  it("says which service a session's request waits for while the service is at its limit", async () => {
    const a = await models([{ text: 'slow', delayMs: 1500 }, { text: 'second' }])
    const { phone, service } = await host()
    const first = await service('openai-compatible', 'First', `${a.origin}/v1`, KEY_A, {})
    await put(phone, first.id, { maxConcurrent: 1 })
    const start = async () => {
      const response = await phone.request('tasks', {
        method: 'POST',
        body: {
          prompt: 'hello',
          requestId: randomUUID(),
          mode: 'chat',
          harnessId: 'standard',
          model: { providerId: first.id, model: 'fake-model' },
        },
      })
      return ((await response.json()) as { sessionId: string }).sessionId
    }
    const one = await start()
    await vi.waitFor(() => expect(a.requests).toHaveLength(1))
    const two = await start()
    await vi.waitFor(async () => expect((await phone.json<TaskDetail>(`tasks/${two}`)).summary.live?.queuedFor).toBe('First'), {
      timeout: 5000,
    })
    expect((await phone.json<TaskDetail>(`tasks/${two}`)).summary.live?.queued).toBe(true)
    const holder = (await phone.json<TaskDetail>(`tasks/${one}`)).summary.live
    expect(holder).not.toHaveProperty('queuedFor')
    expect(holder).not.toHaveProperty('queued')
    // The list says it too, by the service's name only.
    expect((await phone.json<AppSnapshot>('snapshot')).tasks.find(task => task.id === two)?.live?.queuedFor).toBe('First')
    await idle(phone, one)
    await idle(phone, two)
    expect((await phone.json<TaskDetail>(`tasks/${two}`)).summary.live).toBeUndefined()
    expect(a.requests).toHaveLength(2)
  })
})
