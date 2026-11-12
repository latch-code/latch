import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { SearchResults, SessionBatchResult, TaskDetail } from '@latch/protocol'
import { startTestHost, type TestHost } from './helpers/host.ts'
const hosts: TestHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
})
describe('session workflow routes', () => {
  it('enforces scopes, searches settled text and reports partial batch failures', async () => {
    const host = await startTestHost()
    hosts.push(host)
    const owner = await host.enroll({ listener: 'unix' })
    const viewer = await host.enroll({ scopes: ['view'] })
    const created = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: '可搜索正文 abcDEF', requestId: randomUUID() },
    })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${created.sessionId}`)).summary.status).toBe('idle')
    expect((await viewer.json<{ days: number }>('usage', { method: 'POST', body: { days: 7 } })).days).toBe(7)
    expect((await viewer.request('usage', { method: 'POST', body: { days: 8 } })).status).toBe(400)
    const found = await viewer.json<SearchResults>('search', { method: 'POST', body: { q: 'abcdef' } })
    expect(found.hits.some(hit => hit.sessionId === created.sessionId)).toBe(true)
    expect((await viewer.request('tasks/batch', { method: 'POST', body: { action: 'archive', ids: [created.sessionId] } })).status).toBe(
      403,
    )
    const result = await owner.json<SessionBatchResult>('tasks/batch', {
      method: 'POST',
      body: { action: 'archive', ids: [created.sessionId, 'missing', created.sessionId] },
    })
    expect(result.results).toHaveLength(2)
    expect(result.results[0]).toEqual({ id: created.sessionId, ok: true })
    expect(result.results[1]).toMatchObject({ id: 'missing', ok: false })
    expect((await owner.json<TaskDetail>(`tasks/${created.sessionId}`)).summary.archived).toBe(true)
    expect((await owner.request('search', { method: 'POST', body: { q: '' } })).status).toBe(400)
  })
  it('never gives a device with the work scope a conversation with 通用 in search, even while 通用 is empty', async () => {
    const host = await startTestHost()
    hosts.push(host)
    const owner = await host.enroll({ listener: 'unix' })
    const work = await host.enroll({ listener: 'loopback-tcp' })
    await owner.json(`devices/${work.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
    const settled = async (id: string) => expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${id}`)).summary.status).toBe('idle')
    const talk = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: '私下 zxqvwk 话题', mode: 'chat', customAgentId: 'general', requestId: randomUUID() },
    })
    const plain = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: '公开 zxqvwk 会话', mode: 'chat', requestId: randomUUID() },
    })
    await settled(talk.sessionId)
    await settled(plain.sessionId)
    // The owner finds both; the smaller scope finds only the ordinary one, and nothing of the conversation's text.
    const mine = await owner.json<SearchResults>('search', { method: 'POST', body: { q: 'zxqvwk' } })
    expect(mine.hits.map(hit => hit.sessionId)).toEqual(expect.arrayContaining([talk.sessionId, plain.sessionId]))
    const theirs = await work.json<SearchResults>('search', { method: 'POST', body: { q: 'zxqvwk' } })
    expect(theirs.hits.map(hit => hit.sessionId)).toContain(plain.sessionId)
    expect(theirs.hits.map(hit => hit.sessionId)).not.toContain(talk.sessionId)
    expect(JSON.stringify(theirs)).not.toContain('私下')
  })
  it('lets viewers read templates, limits changes to admin and keeps stable PUT and DELETE retries idempotent', async () => {
    const host = await startTestHost()
    hosts.push(host)
    const owner = await host.enroll({ listener: 'unix' }),
      viewer = await host.enroll({ scopes: ['view', 'run'] })
    const template = { id: 'review', name: '检查改动', content: '阅读并解释', scope: { kind: 'all' } }
    expect((await viewer.request('prompts/review', { method: 'PUT', body: template })).status).toBe(403)
    await owner.json('prompts/review', { method: 'PUT', body: template })
    await owner.json('prompts/review', { method: 'PUT', body: template })
    expect(await viewer.json('prompts')).toEqual({ templates: [template] })
    expect((await owner.request('prompts/wrong', { method: 'PUT', body: template })).status).toBe(400)
    await owner.json('prompts/review', { method: 'DELETE' })
    await owner.json('prompts/review', { method: 'DELETE' })
    expect(await viewer.json('prompts')).toEqual({ templates: [] })
  })
})
