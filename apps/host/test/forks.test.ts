import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { forkSeed, FORK_CONTEXT_LIMIT } from '../src/forks.ts'
import { SessionMetaStore } from '../src/session-meta.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const hosts: TestHost[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const host of hosts.splice(0)) await host.close()
})
const detail = (): TaskDetail => ({
  liveText: '',
  cursor: 0,
  summary: { harnessId: 'standard', id: 'source', title: 'Renamed title', updatedAt: '', status: 'idle' },
  approvals: [],
  messages: [
    { id: 'u', role: 'user', text: 'Original question' },
    { id: 'a', role: 'assistant', text: 'Answer', state: 'completed' },
    { id: 'next', role: 'user', text: 'Later' },
  ],
})
describe('Host-generated forks', () => {
  it('writes a record the source itself began from out once, as the turns it was, and titles by the person’s own words', () => {
    const first = forkSeed(detail(), 'a')
    const moved = detail()
    moved.summary.id = 'second'
    moved.messages = [
      { id: 'u2', role: 'user', text: `${first.text}Second question`, forkContext: first.context },
      { id: 'a2', role: 'assistant', text: 'Second answer', state: 'completed' },
    ]
    const seed = forkSeed(moved, 'a2')
    // One record, in order, with no record inside it and no heading of the first one.
    expect(seed.text.match(/<会话记录>/gu)).toHaveLength(1)
    expect(seed.text).not.toContain(first.text.split('\n', 1)[0])
    const record = seed.text.split('<会话记录>')[1]!
    const order = ['Original question', 'Answer', 'Second question', 'Second answer'].map(words => record.indexOf(words))
    expect(order.every(index => index >= 0)).toBe(true)
    expect(order).toEqual(order.toSorted((a, b) => a - b))
    expect(seed.context.title).toBe('Second question')
  })

  it('copies only through the selected message, without hidden reasoning or editable title affecting retries', () => {
    const source = detail()
    source.messages[1]!.reasoning = 'Hidden reasoning'
    const seed = forkSeed(source, 'a')
    expect(seed.text).toContain('Original question')
    expect(seed.text).toContain('Answer')
    expect(seed.text).not.toContain('Later')
    expect(seed.text).not.toContain('Hidden reasoning')
    source.summary.title = 'Another name'
    expect(forkSeed(source, 'a')).toEqual(seed)
    expect(seed.context).toMatchObject({ taskId: 'source', upToMessageId: 'a', turn: 1, prefixLength: seed.text.length })
  })
  it('bounds the retained suffix, warns about truncation and never begins with half a Unicode character', () => {
    const source = detail()
    source.messages[1]!.text = 'discard me' + '🙂'.repeat(FORK_CONTEXT_LIMIT) + 'keep me'
    const seed = forkSeed(source, 'a')
    expect(seed.context.truncated).toBe(true)
    expect(seed.text.length).toBeLessThan(FORK_CONTEXT_LIMIT + 1000)
    expect(seed.text).not.toContain('discard me')
    expect(seed.text).toContain('keep me')
    expect(seed.text).toContain('较早的记录已截断')
  })
  it('starts the seed at the last new context before the fork, still counting turns from the first', () => {
    const source = detail()
    source.messages.push(
      { id: 'later-answer', role: 'assistant', text: 'Later answer', state: 'completed' },
      { id: 'fresh', role: 'user', text: 'Start over', freshContext: true },
      { id: 'fresh-answer', role: 'assistant', text: 'Started over', state: 'completed' },
    )
    const record = (upTo: string) => forkSeed(source, upTo).text.split('<会话记录>')[1]!
    expect(record('fresh-answer')).not.toContain('Original question')
    expect(record('fresh-answer')).not.toContain('Later answer')
    expect(record('fresh-answer')).toContain('Start over')
    expect(record('fresh-answer')).toContain('Started over')
    expect(forkSeed(source, 'fresh-answer').context.turn).toBe(3)
    expect(record('later-answer')).toContain('Original question')
  })
  it('rejects missing positions and the unfinished latest turn while allowing a settled earlier turn', () => {
    const source = detail()
    source.summary.status = 'running'
    expect(() => forkSeed(source, 'missing')).toThrow('找不到')
    expect(() => forkSeed(source, 'next')).toThrow('结束')
    expect(() => forkSeed(source, 'a')).not.toThrow()
  })
  it('reuses a Host-owned default session folder instead of making another one', async () => {
    const host = await startTestHost({ sessionFolders: true })
    hosts.push(host)
    const owner = await host.enroll({ listener: 'unix' })
    const source = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: 'Shared files', requestId: randomUUID() },
    })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${source.sessionId}`)).summary.status).toBe('idle')
    const detail = await owner.json<TaskDetail>(`tasks/${source.sessionId}`)
    const fork = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { requestId: randomUUID(), forkOf: { taskId: source.sessionId, upToMessageId: detail.messages.at(-1)!.id } },
    })
    expect((await owner.json<TaskDetail>(`tasks/${fork.sessionId}`)).summary).toMatchObject({
      cwd: detail.summary.cwd,
      sessionFolder: true,
      workspaceId: 'default',
    })
  })
  it('rechecks run after reading the source so a revoked permission cannot start the fork', async () => {
    const host = await startTestHost()
    hosts.push(host)
    const owner = await host.enroll({ listener: 'unix' })
    const runner = await host.enroll({ scopes: ['view', 'run'] })
    const source = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: 'Original', requestId: randomUUID() },
    })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${source.sessionId}`)).summary.status).toBe('idle')
    const original = await host.host.bridge.detail(source.sessionId)
    const read = host.host.bridge.detail.bind(host.host.bridge)
    let revoked: Promise<unknown> | undefined
    vi.spyOn(host.host.bridge, 'detail').mockImplementation(async id => {
      const result = await read(id)
      // Background projections may read first; the fork must still wait for the same completed revocation.
      revoked ??= owner.json(`devices/${runner.id}`, { method: 'PATCH', body: { scopes: ['view'] } })
      await revoked
      return result
    })
    const response = await runner.request('tasks', {
      method: 'POST',
      body: { requestId: randomUUID(), forkOf: { taskId: source.sessionId, upToMessageId: original.messages.at(-1)!.id } },
    })
    expect(response.status).toBe(403)
    expect(await host.host.bridge.listTasks()).toHaveLength(1)
  })
  it('requires source view plus run, creates authoritative context and preserves provenance and request identity in both stores', async () => {
    const host = await startTestHost()
    hosts.push(host)
    const owner = await host.enroll({ listener: 'unix' })
    const viewer = await host.enroll({ scopes: ['view'] })
    const source = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: 'Fork source', requestId: randomUUID() },
    })
    const sourcePath = `tasks/${source.sessionId}`
    await expect.poll(async () => (await owner.json<TaskDetail>(sourcePath)).summary.status).toBe('idle')
    const original = await owner.json<TaskDetail>(sourcePath)
    const requestId = randomUUID()
    const body = {
      requestId,
      prompt: 'Another approach',
      forkOf: { taskId: source.sessionId, upToMessageId: original.messages.at(-1)!.id },
    }
    expect((await viewer.request('tasks', { method: 'POST', body })).status).toBe(403)
    const created = await owner.json<{ sessionId: string }>('tasks', { method: 'POST', body })
    const retry = await owner.json<{ sessionId: string }>('tasks', { method: 'POST', body })
    expect(retry).toEqual(created)
    await owner.json(`tasks/${created.sessionId}`, { method: 'PATCH', body: { title: 'My branch' } })
    await owner.json('tasks', { method: 'POST', body })
    expect((await owner.json<TaskDetail>(`tasks/${created.sessionId}`)).summary.title).toBe('My branch')
    const fork = await owner.json<TaskDetail>(`tasks/${created.sessionId}`)
    expect(fork.summary.forkOf).toMatchObject(body.forkOf)
    expect(fork.messages[0]).toMatchObject({ requestId, forkContext: fork.summary.forkOf })
    expect(fork.messages[0]!.text).toContain('以下是会话')
    expect(fork.messages[0]!.text).toContain('Another approach')
    expect(original.messages[0]!.requestId).toBeTruthy()
    expect((await SessionMetaStore.open(host.dataDir)).get(created.sessionId)?.forkOf).toEqual(fork.summary.forkOf)
  })
})
