import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import type { AppSnapshot, PersonalAssistant, PersonalMemory, TaskDetail } from '@latch/protocol'
import type { HarnessPlugin, ModelMessage } from '@latch/sdk'
import { startTestHost, type TestHost } from './helpers/host.ts'

const hosts: TestHost[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const host of hosts.splice(0).reverse()) await host.close()
})
async function fixture(selected = false) {
  const seen: Array<{ messages: ModelMessage[]; model: string }> = [],
    release: Array<() => void> = []
  const plugin: HarnessPlugin = {
    id: 'personal-queue-provider',
    name: 'fixture',
    version: '1',
    description: '',
    activate(ctx) {
      ctx.registerProvider({
        id: 'personal-queue-provider',
        name: 'fixture',
        model: 'first',
        models: ['first', 'second'],
        async *stream({ messages, signal, model }) {
          seen.push({ messages: structuredClone(messages), model: model! })
          yield { type: 'text', text: 'A public reply' }
          await new Promise<void>(done => {
            const end = () => {
              signal.removeEventListener('abort', end)
              done()
            }
            release.push(end)
            signal.addEventListener('abort', end, { once: true })
            if (signal.aborted) end()
          })
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  const skill: HarnessPlugin = {
    id: 'personal-queue-skill',
    name: 'skill',
    version: '1',
    description: '',
    activate(ctx) {
      ctx.registerSkill({ id: 'queue-skill', name: 'skill', description: '', content: 'Initial skill instructions' })
    },
  }
  const host = await startTestHost({ plugins: [plugin, skill], providerId: 'personal-queue-provider' })
  hosts.push(host)
  const owner = await host.enroll({ listener: 'unix' }),
    work = await host.enroll({ scopes: ['view', 'run'] })
  const assistant = await owner.json<PersonalAssistant>('personal/assistants', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      name: 'Assistant',
      role: 'PRIVATE QUEUE ROLE',
      harnessId: 'standard',
      mode: 'chat',
      pluginIds: selected ? [skill.id] : [],
    },
  })
  const memory = await owner.json<PersonalMemory>(`personal/assistants/${assistant.id}/memories`, {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      content: 'PRIVATE QUEUE MEMORY',
    },
  })
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      assistantId: assistant.id,
      prompt: 'First',
    },
  })
  await expect.poll(() => seen.length).toBe(1)
  const path = `tasks/${sessionId}`,
    detail = () => owner.json<TaskDetail>(path)
  return { host, owner, work, assistant, memory, seen, release, path, detail }
}
const next = () => ({ prompt: 'Private queued follow-up', queue: true, requestId: randomUUID() })

test('dispatches genuine private context after settlement, retains raw RID, and excludes private context from queue, history and audit', async () => {
  const f = await fixture(),
    input = next()
  expect((await f.owner.json<AppSnapshot>('snapshot')).catalog?.features?.personalQueue).toBe(true)
  const queued = await f.owner.json<{ queued: { id: string } }>(`${f.path}/prompt`, { method: 'POST', body: input })
  expect(await f.owner.json(`${f.path}/prompt`, { method: 'POST', body: input })).toEqual(queued)
  expect((await f.work.request(`${f.path}/prompt`, { method: 'POST', body: { ...next() } })).status).toBe(403)
  expect((await f.work.request(`${f.path}/queue/${queued.queued.id}`, { method: 'PATCH', body: { text: 'bypass' } })).status).toBe(403)
  f.release.shift()!()
  await expect.poll(() => f.seen.length).toBe(2)
  expect(f.seen[1]?.messages[0]?.content).toContain('PRIVATE QUEUE ROLE')
  expect(f.seen[1]?.messages[0]?.content).toContain('PRIVATE QUEUE MEMORY')
  expect(f.seen[1]?.model).toBe('first')
  await expect.poll(async () => (await f.detail()).queue).toEqual([])
  const sent = (await f.detail()).messages.find(message => message.requestId === input.requestId)
  expect(sent).toMatchObject({ text: input.prompt, queuedAt: expect.any(String) })
  for (const value of [
    JSON.stringify(await f.detail()),
    await readFile(join(f.host.dataDir, 'queues.json'), 'utf8'),
    await readFile(join(f.host.dataDir, 'audit/audit.jsonl'), 'utf8'),
  ]) {
    expect(value).not.toContain('PRIVATE QUEUE ROLE')
    expect(value).not.toContain('PRIVATE QUEUE MEMORY')
  }
  const file = await readFile(join(f.host.dataDir, 'queues.json'), 'utf8')
  expect(JSON.parse(file).items[0].binding).toMatch(/^[a-f0-9]{64}$/u)
  expect(JSON.stringify(await f.detail())).not.toContain('binding')
  f.release.shift()!()
  await expect.poll(async () => (await f.detail()).summary.status).toBe('idle')
  expect(await f.owner.json(`${f.path}/prompt`, { method: 'POST', body: input })).toEqual({ accepted: true })
  expect(f.seen).toHaveLength(2)
})

test.each(['role', 'memory', 'model'] as const)(
  'parks when %s changes without rebinding a saved request or an edited item',
  async changed => {
    const f = await fixture(),
      input = next()
    const queued = await f.owner.json<{ queued: { id: string } }>(`${f.path}/prompt`, { method: 'POST', body: input })
    if (changed === 'memory')
      await f.owner.json(`personal/assistants/${f.assistant.id}/memories/${f.memory.id}`, {
        method: 'PATCH',
        body: {
          requestId: randomUUID(),
          baseRevision: f.memory.revision,
          content: 'CHANGED PRIVATE MEMORY',
        },
      })
    else
      await f.owner.json(`personal/assistants/${f.assistant.id}`, {
        method: 'PATCH',
        body: {
          requestId: randomUUID(),
          baseRevision: f.assistant.revision,
          ...(changed === 'role' ? { role: 'CHANGED ROLE' } : { model: { providerId: 'personal-queue-provider', model: 'second' } }),
        },
      })
    expect(await f.owner.json(`${f.path}/prompt`, { method: 'POST', body: input })).toEqual(queued)
    f.release.shift()!()
    await expect.poll(async () => (await f.detail()).queue?.[0]?.state).toBe('parked')
    expect(f.seen).toHaveLength(1)
    expect((await f.owner.request(`${f.path}/queue/${queued.queued.id}`, { method: 'PATCH', body: { text: 'rebind' } })).status).toBe(409)
    await f.owner.json(`${f.path}/queue/${queued.queued.id}/send`, { method: 'POST' })
    expect(f.seen).toHaveLength(1)
    expect((await f.detail()).queue?.[0]).toMatchObject({ text: input.prompt, state: 'parked' })
    await f.owner.json(`${f.path}/queue/${queued.queued.id}`, { method: 'DELETE' })
    await f.owner.json(`${f.path}/prompt`, { method: 'POST', body: next() })
    await expect.poll(() => f.seen.length).toBe(2)
    if (changed === 'memory') expect(f.seen[1]?.messages[0]?.content).toContain('CHANGED PRIVATE MEMORY')
  },
)

test('cosmetic rename preserves the execution binding and editing preserves queue receipt identity', async () => {
  const f = await fixture(),
    input = next()
  const queued = await f.owner.json<{ queued: { id: string } }>(`${f.path}/prompt`, { method: 'POST', body: input })
  await f.owner.json(`personal/assistants/${f.assistant.id}`, {
    method: 'PATCH',
    body: { requestId: randomUUID(), baseRevision: f.assistant.revision, name: 'Renamed' },
  })
  await f.owner.json(`${f.path}/queue/${queued.queued.id}`, { method: 'PATCH', body: { text: 'Edited private intent' } })
  expect(await f.owner.json(`${f.path}/prompt`, { method: 'POST', body: input })).toEqual(queued)
  f.release.shift()!()
  await expect.poll(() => f.seen.length).toBe(2)
  const sent = (await f.detail()).messages.find(message => message.text === 'Edited private intent')!
  expect(sent.requestId).toEqual(expect.any(String))
  expect(sent.requestId).not.toBe(input.requestId)
})

test('uses the session model rather than silently adopting a changed global default', async () => {
  const f = await fixture()
  await f.owner.json(`${f.path}/prompt`, { method: 'POST', body: next() })
  await f.owner.json('preferences', {
    method: 'PUT',
    body: { defaults: { model: { providerId: 'personal-queue-provider', model: 'second' } } },
  })
  f.release.shift()!()
  await expect.poll(() => f.seen.length).toBe(2)
  expect(f.seen.map(call => call.model)).toEqual(['first', 'first'])
})

test('rechecks selected plugin code revisions at dispatch while an existing run retains its old lease', async () => {
  const f = await fixture(true)
  await f.owner.json(`${f.path}/prompt`, { method: 'POST', body: next() })
  await f.host.host.registry.replace({
    id: 'personal-queue-skill',
    name: 'skill',
    version: '1',
    description: '',
    activate(ctx) {
      ctx.registerSkill({ id: 'queue-skill', name: 'skill', description: '', content: 'Changed skill instructions' })
    },
  })
  expect(f.seen[0]?.messages.some(message => message.content.includes('Initial skill instructions'))).toBe(true)
  f.release.shift()!()
  await expect.poll(async () => (await f.detail()).queue?.[0]?.state).toBe('parked')
  expect(f.seen).toHaveLength(1)
})

test('keeps queued text parked when a selected plugin is disabled rather than losing or sending the old intent', async () => {
  const f = await fixture(true)
  await f.owner.json(`${f.path}/prompt`, { method: 'POST', body: next() })
  f.host.host.registry.retire('personal-queue-skill')
  f.release.shift()!()
  await expect.poll(async () => (await f.detail()).queue?.[0]?.state).toBe('parked')
  expect(f.seen).toHaveLength(1)
})

test('recovers an unknown personal delivery with the original actual Driver receipt instead of executing another turn', async () => {
  const f = await fixture(),
    input = next()
  const queued = await f.owner.json<{ queued: { id: string } }>(`${f.path}/prompt`, { method: 'POST', body: input })
  await f.owner.json(`${f.path}/prompt`, { method: 'POST', body: { ...next(), prompt: 'Third queued turn' } })
  const original = f.host.host.bridge.prompt.bind(f.host.host.bridge)
  vi.spyOn(f.host.host.bridge, 'prompt').mockImplementationOnce(async (...args) => {
    await original(...args)
    throw new Error('fixture lost delivery acknowledgement')
  })
  f.release.shift()!()
  await expect.poll(() => f.seen.length).toBe(2)
  await expect.poll(async () => (await f.detail()).queue?.[0]?.reason).toContain('未确认')
  f.release.shift()!()
  await expect.poll(async () => (await f.detail()).summary.status).toBe('idle')
  await f.owner.json(`${f.path}/queue/${queued.queued.id}/send`, { method: 'POST' })
  await expect.poll(() => f.seen.length).toBe(3)
  f.release.shift()!()
  await expect.poll(async () => (await f.detail()).summary.status).toBe('idle')
  expect((await f.detail()).queue).toEqual([])
  expect((await f.detail()).messages.filter(message => message.requestId === input.requestId)).toHaveLength(1)
  expect(f.seen).toHaveLength(3)
  expect(await f.owner.json(`${f.path}/prompt`, { method: 'POST', body: input })).toEqual({ accepted: true })
  expect(f.seen).toHaveLength(3)
})
