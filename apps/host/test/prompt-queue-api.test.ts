import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { createRuntime } from '@latch/core'
import { AppError, type HarnessPlugin, type ModelProvider } from '@latch/sdk'
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
  it('parks after a stop that only answers a subagent request left from an ended turn', async () => {
    const host = await startTestHost()
    hosts.push(host)
    const owner = await host.enroll({ listener: 'unix' })
    // This Host looks up no command by name, so no agent installed on this computer can be found or started.
    const { presets } = await owner.json<{ presets: Array<{ detected?: { found: boolean } }> }>('agents')
    expect(presets.every(preset => preset.detected?.found === false)).toBe(true)
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: { id: 'late-agent', name: 'Late fixture', command: process.execPath, args: [FAKE_ACP_AGENT], env: {} },
    })
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { harnessId: 'late-agent', prompt: 'delegate late', requestId: randomUUID() },
    })
    const path = `tasks/${sessionId}`
    const detail = () => owner.json<TaskDetail>(path)
    await expect.poll(async () => (await detail()).approvals.length, { timeout: 10_000 }).toBe(1)
    const waiting = await detail()
    expect(waiting.summary).toMatchObject({ status: 'waiting-approval', runOutcome: 'completed' })
    await owner.json(`${path}/prompt`, { method: 'POST', body: { queue: true, prompt: 'echo after stop', requestId: randomUUID() } })
    expect((await detail()).queue?.map(item => item.state)).toEqual(['waiting'])
    const { receipt } = await owner.json<{ receipt: { outcome: string } }>(`${path}/cancel`, {
      method: 'POST',
      body: { requestId: randomUUID(), runId: waiting.summary.runId },
    })
    expect(receipt.outcome).toBe('stopped')
    await expect.poll(async () => (await detail()).queue?.map(item => item.state)).toEqual(['parked'])
    await new Promise(resolve => setTimeout(resolve, 300))
    const after = await detail()
    expect(after.summary.status).toBe('idle')
    expect(after.approvals).toEqual([])
    expect(after.queue?.map(item => [item.state, item.reason])).toEqual([['parked', '已停止']])
    expect(after.messages.filter(message => message.role === 'user').map(message => message.text)).toEqual(['delegate late'])
  })
  it('lets another device queue on a Harness session, edit and remove, even with the audit unavailable for a removal', async () => {
    const host = await startTestHost()
    hosts.push(host)
    const owner = await host.enroll({ listener: 'unix' }),
      phone = await host.enroll({ scopes: ['view', 'run'] })
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: { id: 'queue-agent', name: 'Queue fixture', command: process.execPath, args: [FAKE_ACP_AGENT], env: {} },
    })
    const created = await phone.request('tasks', {
      method: 'POST',
      body: { harnessId: 'queue-agent', prompt: 'count 1000', requestId: randomUUID() },
    })
    expect(created.status).toBe(201)
    const { sessionId } = (await created.json()) as { sessionId: string }
    const path = `tasks/${sessionId}`
    const queued = await phone.json<{ queued: { id: string } }>(`${path}/prompt`, {
      method: 'POST',
      body: { prompt: 'echo next', requestId: randomUUID(), queue: true },
    })
    expect((await phone.request(`${path}/queue/${queued.queued.id}`, { method: 'PATCH', body: { text: 'Different' } })).status).toBe(200)
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
describe('steering a running turn over HTTP', () => {
  it('adds a phone message to the running turn when the agent takes it, and queues it when it cannot', async () => {
    const host = await startTestHost()
    hosts.push(host)
    const owner = await host.enroll({ listener: 'unix' }),
      phone = await host.enroll({ scopes: ['view', 'run'] })
    // This Host looks up no command by name, so no agent installed on this computer can be found or started.
    const { presets } = await owner.json<{ presets: Array<{ detected?: { found: boolean } }> }>('agents')
    expect(presets.every(preset => preset.detected?.found === false)).toBe(true)
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: {
        id: 'steer-agent',
        name: 'Steer fixture',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_CAPS: 'steer' },
      },
    })
    const created = await phone.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { harnessId: 'steer-agent', prompt: 'steerable', requestId: randomUUID() },
    })
    const path = `tasks/${created.sessionId}`
    await expect.poll(async () => (await phone.json<TaskDetail>(path)).steer).toBe(true)
    const body = { prompt: 'check the tests too', requestId: randomUUID(), steer: true }
    expect(await phone.json(`${path}/prompt`, { method: 'POST', body })).toEqual({ steered: true })
    expect(await phone.json(`${path}/prompt`, { method: 'POST', body })).toEqual({ steered: true })
    await expect.poll(async () => (await phone.json<TaskDetail>(path)).summary.runOutcome).toBe('completed')
    const detail = await phone.json<TaskDetail>(path)
    expect(detail.steer).toBeUndefined()
    expect(detail.messages.filter(message => message.steered).map(message => message.text)).toEqual(['check the tests too'])
    expect(detail.messages.at(-1)?.text).toBe('steered: check the tests too')
    // With nothing running the same request starts the next turn, as a queued one would.
    expect(await phone.json(`${path}/prompt`, { method: 'POST', body: { ...body, prompt: 'echo then', requestId: randomUUID() } })).toEqual(
      {
        accepted: true,
      },
    )
    await expect.poll(async () => (await phone.json<TaskDetail>(path)).messages.at(-1)?.text).toBe('echo: echo then')
  })

  it('answers a retried steer that started a turn as the first time, and does not steer the text into that turn', async () => {
    const host = await startTestHost()
    hosts.push(host)
    const owner = await host.enroll({ listener: 'unix' })
    const { presets } = await owner.json<{ presets: Array<{ detected?: { found: boolean } }> }>('agents')
    expect(presets.every(preset => preset.detected?.found === false)).toBe(true)
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: {
        id: 'steer-agent',
        name: 'Steer fixture',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_CAPS: 'steer' },
      },
    })
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { harnessId: 'steer-agent', prompt: 'hello', requestId: randomUUID() },
    })
    const path = `tasks/${sessionId}`
    await expect.poll(async () => (await owner.json<TaskDetail>(path)).summary.runOutcome).toBe('completed')
    // Idle: the steer starts a turn. Its retry must not steer the same text into that turn.
    const started = { prompt: 'steerable', requestId: randomUUID(), steer: true }
    expect(await owner.json(`${path}/prompt`, { method: 'POST', body: started })).toEqual({ accepted: true })
    await expect.poll(async () => (await owner.json<TaskDetail>(path)).steer).toBe(true)
    expect(await owner.json(`${path}/prompt`, { method: 'POST', body: started })).toEqual({ accepted: true })
    const detail = await owner.json<TaskDetail>(path)
    expect(detail.messages.filter(message => message.text === 'steerable')).toHaveLength(1)
    expect(detail.messages.some(message => message.steered)).toBe(false)
    await owner.json(`${path}/cancel`, { method: 'POST', body: { requestId: randomUUID() } })
  })

  it('queues what a harness without steering is sent while it runs', async () => {
    const host = await startTestHost()
    hosts.push(host)
    const owner = await host.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: { id: 'plain-agent', name: 'Plain fixture', command: process.execPath, args: [FAKE_ACP_AGENT], env: {} },
    })
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { harnessId: 'plain-agent', prompt: 'steerable', requestId: randomUUID() },
    })
    const path = `tasks/${sessionId}`
    await expect.poll(async () => (await owner.json<TaskDetail>(path)).summary.status).toBe('running')
    expect((await owner.json<TaskDetail>(path)).steer).toBeUndefined()
    const response = await owner.request(`${path}/prompt`, {
      method: 'POST',
      body: { prompt: 'later', requestId: randomUUID(), steer: true },
    })
    expect(response.status).toBe(202)
    expect((await owner.json<TaskDetail>(path)).queue?.map(item => item.text)).toEqual(['later'])
    await owner.json(`${path}/cancel`, { method: 'POST', body: { requestId: randomUUID() } })
  })
})

describe('a queued message refused before the session took it', () => {
  it('answers the definite refusal and leaves no queue item to send it a second way', async () => {
    let failing = false
    const plugin: HarnessPlugin = {
      id: 'flaky-queue',
      name: 'flaky',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerProvider({
          id: 'flaky-queue-model',
          name: 'flaky',
          model: 'fixture',
          async *stream() {
            yield { type: 'text', text: 'ok' }
            yield { type: 'finish', reason: 'stop' }
          },
        })
        ctx.registerHarness({
          id: 'flaky-queue-harness',
          name: 'flaky',
          version: '1',
          capabilities: { models: { owner: 'latch' }, modes: ['chat'] },
          create(options) {
            const bridge = createRuntime(options)
            return new Proxy(bridge, {
              get(target, key, receiver) {
                if (key === 'prompt' && failing)
                  return () => Promise.reject(new AppError(503, 'agent-start-failed', 'flaky 启动失败：进程退出（退出码 1）'))
                const value: unknown = Reflect.get(target, key, receiver)
                return typeof value === 'function' ? value.bind(target) : value
              },
            })
          },
        })
      },
    }
    const host = await startTestHost({ plugins: [plugin] })
    hosts.push(host)
    const owner = await host.enroll({ listener: 'unix' })
    const model = { providerId: 'flaky-queue-model', model: 'fixture' }
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: 'First', mode: 'chat', harnessId: 'flaky-queue-harness', model, requestId: randomUUID() },
    })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
    failing = true
    const response = await owner.request(`tasks/${sessionId}/prompt`, {
      method: 'POST',
      body: { queue: true, prompt: 'Second', requestId: randomUUID() },
    })
    expect(response.status).toBe(503)
    expect(((await response.json()) as { error: string }).error).toBe('agent-start-failed')
    expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).queue ?? []).toEqual([])
    // What was audited for it is marked as never committed.
    await vi.waitFor(async () => {
      const records = (await readFile(join(host.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as { seq: number; action: string; detail?: { refSeq?: number } })
      const audited = records.filter(record => record.action === 'task.prompt.queued' || record.action === 'task.prompt.sent')
      expect(audited.map(record => record.action)).toEqual(['task.prompt.queued', 'task.prompt.sent'])
      expect(records.filter(record => record.action === 'action.failed').map(record => record.detail?.refSeq)).toEqual(
        audited.map(record => record.seq),
      )
    })
  })
})
