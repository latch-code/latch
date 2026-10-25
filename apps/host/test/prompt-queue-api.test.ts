import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import type { HarnessPlugin, ModelProvider } from '@latch/sdk'
import { startTestHost, type TestHost } from './helpers/host.ts'

const hosts: TestHost[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const host of hosts.splice(0)) await host.close()
})
async function fixture() {
  const calls: string[] = [],
    release: Array<() => void> = []
  const provider: ModelProvider = {
    id: 'queue-model',
    name: 'Queue fixture',
    model: 'fake',
    async *stream({ messages, signal }) {
      calls.push(messages.at(-1)?.content ?? '')
      yield { type: 'text', text: 'Recorded output' }
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason)
        if (signal.aborted) {
          abort()
          return
        }
        signal.addEventListener('abort', abort, { once: true })
        release.push(() => {
          signal.removeEventListener('abort', abort)
          resolve()
        })
      })
      yield { type: 'finish', reason: 'stop' }
    },
  }
  const plugin: HarnessPlugin = {
    id: 'queue-fixture',
    name: 'Queue test',
    version: '1',
    description: '',
    activate(ctx) {
      ctx.registerProvider(provider)
    },
  }
  const host = await startTestHost({ plugins: [plugin], providerId: provider.id })
  hosts.push(host)
  const owner = await host.enroll({ listener: 'unix' }),
    phone = await host.enroll({ scopes: ['view', 'run'] })
  const created = await owner.json<{ sessionId: string }>('tasks', { method: 'POST', body: { prompt: 'First', requestId: randomUUID() } })
  await expect.poll(() => calls.length).toBe(1)
  const path = `tasks/${created.sessionId}`
  const detail = () => owner.json<TaskDetail>(path)
  return { host, owner, phone, calls, release, path, detail }
}
describe('queue HTTP boundaries', () => {
  it('accepts a phone L1 follow-up, edits it, sends it once after success, and records queue timing and request identity', async () => {
    const { owner, phone, calls, release, path, detail } = await fixture()
    const requestId = randomUUID(),
      body = { queue: true, prompt: 'Second', requestId }
    const response = await phone.request(`${path}/prompt`, { method: 'POST', body })
    expect(response.status).toBe(202)
    const item = ((await response.json()) as { queued: { id: string } }).queued.id
    expect(await phone.json(`${path}/prompt`, { method: 'POST', body })).toEqual({ queued: { id: item } })
    await phone.json(`${path}/queue/${item}`, { method: 'PATCH', body: { text: 'Edited second' } })
    release.shift()!()
    await expect.poll(() => calls.length).toBe(2)
    expect(calls[1]).toBe('Edited second')
    const sent = (await detail()).messages.find(message => message.text === 'Edited second')!
    expect(sent.queuedAt).toEqual(expect.any(String))
    expect(sent.requestId).toEqual(expect.any(String))
    expect(sent.requestId).not.toBe(requestId)
    await expect.poll(async () => (await detail()).queue).toEqual([])
    release.shift()!()
    await expect.poll(async () => (await detail()).summary.runOutcome).toBe('completed')
    expect(await phone.json(`${path}/prompt`, { method: 'POST', body })).toEqual({ accepted: true })
    expect(calls).toHaveLength(2)
    expect(
      (await owner.request(`${path}/prompt`, { method: 'POST', body: { ...body, requestId: randomUUID(), attachmentIds: ['file'] } }))
        .status,
    ).toBe(400)
    expect(
      (
        await owner.request(`${path}/prompt`, {
          method: 'POST',
          body: { prompt: 'No refs', requestId: randomUUID(), queue: true, fileRefs: [{ root: 'default', path: 'notes.md' }] },
        })
      ).status,
    ).toBe(400)
  })
  it('parks after stop and never drains automatically on a later success until explicitly resumed', async () => {
    const { owner, calls, release, path, detail } = await fixture()
    const queued = await owner.json<{ queued: { id: string } }>(`${path}/prompt`, {
      method: 'POST',
      body: { queue: true, prompt: 'After stop', requestId: randomUUID() },
    })
    await owner.json(`${path}/cancel`, { method: 'POST', body: { requestId: randomUUID() } })
    await expect.poll(async () => (await detail()).queue?.[0]?.state).toBe('parked')
    expect(calls).toHaveLength(1)
    await owner.json(`${path}/queue/${queued.queued.id}/send`, { method: 'POST' })
    await expect.poll(() => calls.length).toBe(2)
    expect(calls[1]).toBe('After stop')
    release.at(-1)!()
    await expect.poll(async () => (await detail()).summary.status).toBe('idle')
  })
  it('refuses remote L3 enqueue, editing and resend while allowing remote removal even if audit is unavailable', async () => {
    const host = await startTestHost()
    hosts.push(host)
    const owner = await host.enroll({ listener: 'unix' }),
      phone = await host.enroll({ scopes: ['view', 'run'] })
    await owner.json('agents', {
      method: 'POST',
      body: { id: 'queue-agent', name: 'Queue fixture', command: process.execPath, args: [FAKE_ACP_AGENT], env: {} },
    })
    const created = await owner.confirmed('tasks', {
      method: 'POST',
      body: { harnessId: 'queue-agent', prompt: 'count 1000', requestId: randomUUID() },
    })
    expect(created.status).toBe(201)
    const { sessionId } = (await created.json()) as { sessionId: string }
    const path = `tasks/${sessionId}`
    const body = { prompt: 'echo next', requestId: randomUUID(), queue: true }
    expect((await phone.request(`${path}/prompt`, { method: 'POST', body })).status).toBe(403)
    const queued = await owner.json<{ queued: { id: string } }>(`${path}/prompt`, { method: 'POST', body })
    expect((await phone.request(`${path}/queue/${queued.queued.id}`, { method: 'PATCH', body: { text: 'Different' } })).status).toBe(403)
    expect((await phone.request(`${path}/queue/${queued.queued.id}/send`, { method: 'POST' })).status).toBe(403)
    await owner.json(`${path}/cancel`, { method: 'POST', body: { requestId: randomUUID() } })
    vi.spyOn(host.host.security.audit, 'append').mockRejectedValue(new Error('audit unavailable'))
    const removed = await phone.request(`${path}/queue/${queued.queued.id}`, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    expect(removed.headers.get('x-latch-audit')).toBe('failed')
    expect((await phone.json<TaskDetail>(path)).queue).toEqual([])
  })
  it('does not execute an edited intent after its editing device is revoked while the sender remains authorized', async () => {
    const { owner, phone, calls, release, path, detail } = await fixture()
    const queued = await owner.json<{ queued: { id: string } }>(`${path}/prompt`, {
      method: 'POST',
      body: { queue: true, prompt: 'Original', requestId: randomUUID() },
    })
    await phone.json(`${path}/queue/${queued.queued.id}`, { method: 'PATCH', body: { text: 'Changed by phone' } })
    await owner.json(`devices/${phone.id}`, { method: 'PATCH', body: { scopes: ['view'] } })
    release.shift()!()
    await expect.poll(async () => (await detail()).queue?.[0]?.state).toBe('dropped')
    expect(calls).toHaveLength(1)
  })
  it('drops a revoked device intent before dispatch and allows another run device to remove it', async () => {
    const { owner, phone, calls, release, path, detail } = await fixture()
    const queued = await phone.json<{ queued: { id: string } }>(`${path}/prompt`, {
      method: 'POST',
      body: { queue: true, prompt: 'Must not run', requestId: randomUUID() },
    })
    await owner.json(`devices/${phone.id}`, { method: 'PATCH', body: { scopes: ['view'] } })
    release.shift()!()
    await expect.poll(async () => (await detail()).queue?.[0]?.state).toBe('dropped')
    expect(calls).toHaveLength(1)
    expect((await phone.request(`${path}/queue/${queued.queued.id}`, { method: 'DELETE' })).status).toBe(403)
    await owner.json(`${path}/queue/${queued.queued.id}`, { method: 'DELETE' })
    await expect.poll(async () => (await detail()).queue).toEqual([])
  })
})
