import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, test, vi } from 'vitest'
import type {
  AppSnapshot,
  PersonalAssistant,
  PersonalAssistantDetail,
  PersonalOverview,
  SearchResults,
  TaskDetail,
  SessionBatchResult,
} from '@latch/protocol'
import type { HarnessPlugin, ModelMessage } from '@latch/sdk'
import { SessionMetaStore } from '../src/session-meta.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const hosts: TestHost[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const host of hosts.splice(0).reverse()) await host.close()
})
const config = () => ({
  requestId: randomUUID(),
  name: '个人助理',
  role: 'PRIVATE ROLE ONLY',
  harnessId: 'standard',
  mode: 'chat',
  pluginIds: [],
})
const plugin = (seen: ModelMessage[][]): HarnessPlugin => ({
  id: 'personal-provider',
  name: 'fixture',
  version: '1',
  description: '',
  activate(ctx) {
    ctx.registerProvider({
      id: 'personal-provider',
      name: 'fixture',
      model: 'fixture',
      async *stream({ messages }) {
        seen.push(structuredClone(messages))
        yield { type: 'text', text: 'Settled answer' }
        yield { type: 'finish', reason: 'stop' }
      },
    })
  },
})

test('runs real no-project personal sessions with scoped private context, ownership, and durable user request identities', async () => {
  const seen: ModelMessage[][] = []
  const host = await startTestHost({ plugins: [plugin(seen)] })
  hosts.push(host)
  const owner = await host.enroll({ listener: 'unix' })
  const assistant = await owner.json<PersonalAssistant>('personal/assistants', {
    method: 'POST',
    body: { ...config(), model: { providerId: 'personal-provider', model: 'fixture' } },
  })
  await owner.json(`personal/assistants/${assistant.id}/memories`, {
    method: 'POST',
    body: { requestId: randomUUID(), content: 'PRIVATE MEMORY ONLY' },
  })
  const request = { prompt: 'Plan my day', assistantId: assistant.id, requestId: randomUUID() }
  const created = await owner.json<{ sessionId: string }>('tasks', { method: 'POST', body: request })
  await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${created.sessionId}`)).summary.status).toBe('idle')
  expect(seen[0]?.[0]?.content).toContain('PRIVATE MEMORY ONLY')
  expect(seen[0]?.[0]?.content).toContain('PRIVATE ROLE ONLY')
  const detail = await owner.json<TaskDetail>(`tasks/${created.sessionId}`)
  expect(detail.summary.personal).toEqual({ assistantId: assistant.id })
  expect(detail.messages[0]?.text).toBe('Plan my day')
  expect(detail.messages[0]?.requestId).toBe(request.requestId)
  expect((await host.host.bridge.detail(created.sessionId)).messages[0]?.requestId).not.toBe(request.requestId)
  expect(JSON.stringify(detail)).not.toContain('PRIVATE MEMORY ONLY')
  expect(JSON.stringify(detail)).not.toContain('PRIVATE ROLE ONLY')
  expect(await owner.json('tasks', { method: 'POST', body: request })).toEqual(created)
  expect(seen).toHaveLength(1)
  await owner.json(`tasks/${created.sessionId}/prompt`, { method: 'POST', body: { prompt: 'Continue', requestId: randomUUID() } })
  await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${created.sessionId}`)).summary.status).toBe('idle')
  expect(seen[1]?.[0]?.content).toContain('PRIVATE MEMORY ONLY')
  const ordinary = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { prompt: 'Ordinary project', model: { providerId: 'personal-provider', model: 'fixture' }, requestId: randomUUID() },
  })
  await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${ordinary.sessionId}`)).summary.status).toBe('idle')
  expect(JSON.stringify(seen[2])).not.toContain('PRIVATE MEMORY ONLY')
  const overview = await owner.json<PersonalOverview>('personal')
  expect(overview.assistants[0]).toMatchObject({ id: assistant.id, available: true, memoryCount: 1, sessionCount: 1 })
  const personal = await owner.json<PersonalAssistantDetail>(`personal/assistants/${assistant.id}`)
  expect(personal.sessions.map(task => task.id)).toEqual([created.sessionId])
  expect(
    (await owner.request('tasks', { method: 'POST', body: { ...request, requestId: randomUUID(), workspaceId: 'default' } })).status,
  ).toBe(400)
  expect(
    (
      await owner.request(`tasks/${created.sessionId}/prompt`, {
        method: 'POST',
        body: { prompt: 'queued', requestId: randomUUID(), queue: true },
      })
    ).status,
  ).toBe(409)
  expect(await readFile(join(host.dataDir, 'audit', 'audit.jsonl'), 'utf8')).not.toContain('PRIVATE MEMORY ONLY')
})

test('prevents work-scoped routes, snapshots, search and batch operations from bypassing personal privacy', async () => {
  const host = await startTestHost()
  hosts.push(host)
  const owner = await host.enroll({ listener: 'unix' }),
    viewer = await host.enroll({ scopes: ['view', 'run'] })
  const assistant = await owner.json<PersonalAssistant>('personal/assistants', { method: 'POST', body: config() })
  const created = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { assistantId: assistant.id, prompt: 'private-search-target', requestId: randomUUID() },
  })
  await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${created.sessionId}`)).summary.status).toBe('idle')
  expect((await viewer.request('personal')).status).toBe(403)
  expect((await viewer.request(`personal/assistants/${assistant.id}`)).status).toBe(403)
  expect((await viewer.request(`tasks/${created.sessionId}`)).status).toBe(403)
  expect((await viewer.request(`tasks/${created.sessionId}/cancel`, { method: 'POST', body: { requestId: randomUUID() } })).status).toBe(
    200,
  )
  expect(
    (await viewer.request(`tasks/${created.sessionId}/prompt`, { method: 'POST', body: { prompt: 'bypass', requestId: randomUUID() } }))
      .status,
  ).toBe(403)
  expect((await viewer.json<AppSnapshot>('snapshot')).tasks.some(task => task.id === created.sessionId)).toBe(false)
  expect((await viewer.json<SearchResults>('search', { method: 'POST', body: { q: 'private-search-target' } })).hits).toEqual([])
  expect(
    (await viewer.json<SessionBatchResult>('tasks/batch', { method: 'POST', body: { action: 'archive', ids: [created.sessionId] } }))
      .results[0],
  ).toMatchObject({ ok: false, code: 'personal-scope-required' })
  const detail = await owner.json<TaskDetail>(`tasks/${created.sessionId}`)
  expect(
    (
      await viewer.request('tasks', {
        method: 'POST',
        body: { requestId: randomUUID(), forkOf: { taskId: created.sessionId, upToMessageId: detail.messages.at(-1)!.id } },
      })
    ).status,
  ).toBe(403)
  const all = await owner.json<SearchResults>('search', { method: 'POST', body: { q: 'private-search-target' } })
  expect(all.hits.some(hit => hit.sessionId === created.sessionId)).toBe(true)
  // A cached text hit cannot survive a later request from a work-only device.
  expect((await viewer.json<SearchResults>('search', { method: 'POST', body: { q: 'private-search-target' } })).hits).toEqual([])
})

test('does not silently fall back when a profile names an unsupported harness or a removed plugin', async () => {
  const host = await startTestHost()
  hosts.push(host)
  const owner = await host.enroll({ listener: 'unix' })
  const assistant = await owner.json<PersonalAssistant>('personal/assistants', {
    method: 'POST',
    body: { ...config(), pluginIds: ['missing-plugin'] },
  })
  expect((await owner.json<PersonalOverview>('personal')).assistants[0]).toMatchObject({ available: false })
  expect(
    (await owner.request('tasks', { method: 'POST', body: { assistantId: assistant.id, prompt: 'do it', requestId: randomUUID() } }))
      .status,
  ).toBe(409)
  expect((await owner.json<AppSnapshot>('snapshot')).tasks).toEqual([])
})

test('rechecks private data scope after an awaited driver read', async () => {
  const host = await startTestHost()
  hosts.push(host)
  const owner = await host.enroll({ listener: 'unix' })
  const assistant = await owner.json<PersonalAssistant>('personal/assistants', { method: 'POST', body: config() })
  const created = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { assistantId: assistant.id, prompt: 'private', requestId: randomUUID() },
  })
  await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${created.sessionId}`)).summary.status).toBe('idle')
  const original = host.host.bridge.detail.bind(host.host.bridge)
  let downgrade: Promise<unknown> | undefined
  vi.spyOn(host.host.bridge, 'detail').mockImplementation(async id => {
    const value = await original(id)
    downgrade ??= owner.json(`devices/${owner.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
    await downgrade
    return value
  })
  const response = await owner.request(`tasks/${created.sessionId}`)
  expect(response.status).toBe(403)
  expect(await response.text()).not.toContain('Settled answer')
})

test('keeps a newly created session private when Host metadata fails, and repairs the unknown creation before acknowledging it', async () => {
  const host = await startTestHost()
  hosts.push(host)
  const owner = await host.enroll({ listener: 'unix' }),
    work = await host.enroll({ scopes: ['view', 'run'] })
  const assistant = await owner.json<PersonalAssistant>('personal/assistants', { method: 'POST', body: config() })
  await writeFile(join(host.workspaceRoot, 'private.txt'), 'private output')
  const input = { assistantId: assistant.id, prompt: '[private output](private.txt)', requestId: randomUUID() }
  vi.spyOn(SessionMetaStore.prototype, 'update').mockRejectedValueOnce(new Error('metadata fault'))
  expect((await owner.request('tasks', { method: 'POST', body: input })).status).toBe(500)
  const task = { id: Object.keys(JSON.parse(await readFile(join(host.dataDir, 'sessions', 'runtime.json'), 'utf8')).tasks)[0]! }
  expect(host.host.bridge.personalOf(task.id)).toEqual({ assistantId: assistant.id })
  expect(
    (await work.json<SessionBatchResult>('tasks/batch', { method: 'POST', body: { action: 'archive', ids: [task.id] } })).results[0],
  ).toMatchObject({ ok: false, code: 'personal-scope-required' })
  expect((await work.request(`tasks/${task.id}/files/resolve`, { method: 'POST', body: { paths: ['private.txt'] } })).status).toBe(403)
  const retried = await owner.json<{ sessionId: string }>('tasks', { method: 'POST', body: input })
  expect(retried.sessionId).toBe(task.id)
  expect((await owner.json<TaskDetail>(`tasks/${task.id}`)).messages[0]?.requestId).toBe(input.requestId)
  expect((await SessionMetaStore.open(host.dataDir)).get(task.id)?.personal).toEqual({ assistantId: assistant.id })
  expect(await host.host.bridge.listTasks()).toHaveLength(1)
})

test('rebuilds private classification from the persisted driver before accepting requests after an unknown metadata failure', async () => {
  const first = await startTestHost()
  hosts.push(first)
  const owner = await first.enroll({ listener: 'unix' })
  const assistant = await owner.json<PersonalAssistant>('personal/assistants', { method: 'POST', body: config() })
  vi.spyOn(SessionMetaStore.prototype, 'update').mockRejectedValueOnce(new Error('metadata fault'))
  expect(
    (
      await owner.request('tasks', {
        method: 'POST',
        body: { assistantId: assistant.id, prompt: 'persist ownership', requestId: randomUUID() },
      })
    ).status,
  ).toBe(500)
  const task = { id: Object.keys(JSON.parse(await readFile(join(first.dataDir, 'sessions', 'runtime.json'), 'utf8')).tasks)[0]! }
  await first.host.close()
  const second = await startTestHost({ dataDir: first.dataDir, workspaceRoot: first.workspaceRoot })
  hosts.push(second)
  const work = await second.enroll({ scopes: ['view', 'run'] })
  const reopenedOwner = await second.enroll({ listener: 'unix' })
  const restored = await reopenedOwner.json<TaskDetail>(`tasks/${task.id}`)
  const internal = (await second.host.bridge.detail(task.id)).messages[0]?.requestId
  expect(restored.messages[0]?.requestId).toMatch(/^[a-f0-9-]{36}$/u)
  expect(restored.messages[0]?.requestId).not.toBe(internal)
  expect(second.host.bridge.personalOf(task.id)).toEqual({ assistantId: assistant.id })
  expect((await SessionMetaStore.open(first.dataDir)).get(task.id)?.personal).toEqual({ assistantId: assistant.id })
  expect(
    (await work.json<SessionBatchResult>('tasks/batch', { method: 'POST', body: { action: 'archive', ids: [task.id] } })).results[0],
  ).toMatchObject({ ok: false, code: 'personal-scope-required' })
})

test('projects Host private ownership into summaries when a driver omits it after a metadata fault', async () => {
  const host = await startTestHost()
  hosts.push(host)
  const work = await host.enroll({ scopes: ['view', 'run'] })
  const task = await host.host.bridge.createTask({ prompt: 'private title', requestId: randomUUID(), mode: 'chat' })
  await vi.waitFor(async () => expect((await host.host.bridge.detail(task.sessionId)).summary.status).toBe('idle'))
  const owner = { assistantId: `asst_${randomUUID()}` }
  vi.spyOn(SessionMetaStore.prototype, 'update').mockRejectedValueOnce(new Error('metadata fault'))
  await expect(host.host.bridge.recordPersonal(task.sessionId, owner)).rejects.toThrow('metadata fault')
  expect((await host.host.bridge.listTasks()).find(item => item.id === task.sessionId)?.personal).toEqual(owner)
  expect((await work.json<AppSnapshot>('snapshot')).tasks.some(item => item.id === task.sessionId)).toBe(false)
  expect((await work.request(`tasks/${task.sessionId}`)).status).toBe(403)
})

test('reports an unavailable model rather than silently choosing a different provider', async () => {
  const host = await startTestHost()
  hosts.push(host)
  const owner = await host.enroll({ listener: 'unix' })
  const assistant = await owner.json<PersonalAssistant>('personal/assistants', {
    method: 'POST',
    body: { ...config(), model: { providerId: 'missing', model: 'missing' } },
  })
  expect((await owner.json<PersonalOverview>('personal')).assistants[0]).toMatchObject({
    id: assistant.id,
    available: false,
    unavailableReason: expect.stringContaining('模型'),
  })
  expect(
    (await owner.request('tasks', { method: 'POST', body: { assistantId: assistant.id, prompt: 'try', requestId: randomUUID() } })).status,
  ).toBe(409)
  expect((await owner.json<AppSnapshot>('snapshot')).tasks).toEqual([])
})

test('projects the original client RID on SSE while retaining the internal execution receipt', async () => {
  const host = await startTestHost()
  hosts.push(host)
  const owner = await host.enroll({ listener: 'unix' })
  const assistant = await owner.json<PersonalAssistant>('personal/assistants', { method: 'POST', body: config() })
  const request = { assistantId: assistant.id, prompt: 'SSE identity', requestId: randomUUID() }
  const created = await owner.json<{ sessionId: string }>('tasks', { method: 'POST', body: request })
  await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${created.sessionId}`)).summary.status).toBe('idle')
  const controller = new AbortController(),
    response = await owner.request(`events?sessionId=${created.sessionId}`, { signal: controller.signal })
  const reader = response.body!.getReader(),
    timeout = setTimeout(() => controller.abort(), 3000)
  try {
    const frame = (async () => {
      let text = ''
      for (;;) {
        const value = await reader.read()
        if (value.done) throw new Error('SSE ended before canonical identity')
        text += new TextDecoder().decode(value.value)
        for (const block of text.split('\n\n').slice(0, -1)) {
          if (!block.includes('event: task-state')) continue
          const data = JSON.parse(
            block
              .split('\n')
              .find(line => line.startsWith('data: '))!
              .slice(6),
          ) as { detail: TaskDetail }
          return data.detail
        }
      }
    })()
    await owner.json(`tasks/${created.sessionId}`, { method: 'PATCH', body: { title: 'updated metadata' } })
    expect((await frame).messages[0]?.requestId).toBe(request.requestId)
    expect(await owner.json('tasks', { method: 'POST', body: request })).toEqual(created)
    expect(
      (await owner.json<TaskDetail>(`tasks/${created.sessionId}`)).messages.filter(message => message.requestId === request.requestId),
    ).toHaveLength(1)
    expect((await host.host.bridge.detail(created.sessionId)).messages[0]?.requestId).not.toBe(request.requestId)
  } finally {
    clearTimeout(timeout)
    await reader.cancel().catch(() => {})
    controller.abort()
  }
})

test('offers enabled plugin metadata to private viewers without admin or executable sources', async () => {
  const host = await startTestHost()
  hosts.push(host)
  const viewer = await host.enroll({ listener: 'unix', scopes: ['view', 'run'] })
  const overview = await viewer.json<PersonalOverview>('personal')
  expect(overview.plugins?.some(plugin => plugin.id === 'workspace-files')).toBe(true)
  for (const plugin of overview.plugins ?? []) expect(Object.keys(plugin).sort()).toEqual(['capabilities', 'description', 'id', 'name'])
  expect((await viewer.request('plugins')).status).toBe(403)
  const work = await host.enroll({ scopes: ['view', 'run'] })
  expect((await work.request('personal')).status).toBe(403)
})
