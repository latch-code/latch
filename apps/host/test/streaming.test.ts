import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChangeEvent, TaskDetail, TaskStateEvent } from '@latch/protocol'
import type { Bridge, ModelProvider, ToolDefinition } from '@latch/sdk'
import { createRuntime } from '@latch/core'
import type { TestDevice } from '@latch/testkit'
import { createOfflineTicket } from '../src/auth.ts'
import { startTestHost, type TestHost, type TestHostOptions } from './helpers/host.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'latch-stream-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return join(root, 'data')
}

/**
 * Enrolls the desktop app with an offline code: fixtures that report running external (L3) sessions block local
 * confirmation, and only host.sock takes offline codes.
 */
async function testHost(options: TestHostOptions & { dataDir: string }): Promise<{ t: TestHost; device: TestDevice }> {
  const { code } = await createOfflineTicket(join(options.dataDir, 'auth'))
  const t = await startTestHost(options)
  cleanups.push(() => t.close())
  return { t, device: await t.enroll({ listener: 'unix', offlineCode: code }) }
}

async function events(device: TestDevice, query: string) {
  const controller = new AbortController()
  const response = await device.request(`events${query}`, { signal: controller.signal })
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  const received: Array<ChangeEvent | TaskStateEvent> = []
  const consume = (async () => {
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const next = await reader.read()
      if (next.done) return
      buffer += decoder.decode(next.value, { stream: true })
      let separator: number
      while ((separator = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, separator)
        buffer = buffer.slice(separator + 2)
        const data = block
          .split('\n')
          .find(line => line.startsWith('data: '))
          ?.slice(6)
        if (data) received.push(JSON.parse(data) as ChangeEvent | TaskStateEvent)
      }
    }
  })().catch(error => {
    if (!controller.signal.aborted) throw error
  })
  cleanups.push(async () => {
    controller.abort()
    await consume
  })
  return received
}

describe('streamed task state', () => {
  it('does not send an older batch to a subscriber that joins while an external Bridge detail is pending', async () => {
    const dataDir = await directory()
    const entered = deferred()
    const release = deferred()
    let blockNext = true
    let notify: (sessionId?: string) => void = () => {}
    const current: TaskDetail = {
      summary: { harnessId: 'standard', id: 'slow-session', title: 'Slow fixture', status: 'running', updatedAt: '2026-01-01' },
      messages: [],
      approvals: [],
      liveText: 'old',
      cursor: 1,
    }
    const other: TaskDetail = { ...structuredClone(current), summary: { ...current.summary, id: 'other-session' }, liveText: '' }
    const bridge: Bridge = {
      async start() {},
      async close() {},
      async listTasks() {
        return [structuredClone(current.summary), structuredClone(other.summary)]
      },
      async detail(sessionId) {
        if (sessionId === other.summary.id) return structuredClone(other)
        const captured = structuredClone(current)
        if (blockNext) {
          blockNext = false
          entered.resolve()
          await release.promise
        }
        return captured
      },
      async createTask() {
        throw new Error('Unused fixture operation')
      },
      async prompt() {},
      async cancel() {},
      approvals() {
        return []
      },
      async decide() {
        return false
      },
      subscribe(listener) {
        notify = listener
        return () => {
          notify = () => {}
        }
      },
    }
    const { device } = await testHost({
      dataDir,
      demo: false,
      harnessId: 'slow',
      plugins: [
        {
          id: 'slow-driver',
          name: 'Slow fixture',
          version: '1',
          description: 'Legacy async Bridge fixture',
          activate(ctx) {
            ctx.registerHarness({ id: 'slow', name: 'Slow', version: '1', create: () => bridge })
          },
        },
      ],
    })
    cleanups.push(async () => {
      release.resolve()
    })
    notify(current.summary.id)
    await entered.promise
    current.liveText = 'new'
    current.cursor++
    notify(current.summary.id)
    notify(other.summary.id)
    const received = await events(device, `?sessionId=${current.summary.id}`)
    await vi.waitFor(() => expect(received.length).toBe(1))
    const initialRevision = received[0].revision
    release.resolve()
    await vi.waitFor(() =>
      expect(received.some(event => event.type === 'tasks-invalidated' && event.sessionId === other.summary.id)).toBe(true),
    )
    expect(received.some(event => event.type === 'task-state' && event.detail.liveText === 'new')).toBe(true)
    expect(received.every(event => event.revision >= initialRevision)).toBe(true)
    expect(received.some(event => event.type === 'task-state' && event.detail.liveText === 'old')).toBe(false)
    // Different event types in one pending batch legitimately share a revision.
    expect(received.filter(event => event.revision === initialRevision).map(event => event.type)).toEqual([
      'refresh',
      'task-state',
      'tasks-invalidated',
    ])
  })

  it('falls back to a single refresh per batch when sessions cannot be read', async () => {
    const dataDir = await directory()
    let notify: (sessionId?: string) => void = () => {}
    const bridge: Bridge = {
      async start() {},
      async close() {},
      async listTasks() {
        return ['gone-1', 'gone-2'].map(id => ({ id, title: id, status: 'idle' as const, updatedAt: '2026-01-01' }))
      },
      async detail() {
        throw new Error('Session data unavailable')
      },
      async createTask() {
        throw new Error('Unused fixture operation')
      },
      async prompt() {},
      async cancel() {},
      approvals() {
        return []
      },
      async decide() {
        return false
      },
      subscribe(listener) {
        notify = listener
        return () => {
          notify = () => {}
        }
      },
    }
    const { device } = await testHost({
      dataDir,
      demo: false,
      harnessId: 'unreadable',
      plugins: [
        {
          id: 'unreadable-driver',
          name: 'Unreadable fixture',
          version: '1',
          description: 'Bridge whose details fail',
          activate(ctx) {
            ctx.registerHarness({ id: 'unreadable', name: 'Unreadable', version: '1', create: () => bridge })
          },
        },
      ],
    })
    await delay(100)
    const received = await events(device, '?sessionId=gone-1')
    await vi.waitFor(() => expect(received).toHaveLength(1))
    notify('gone-1')
    notify('gone-2')
    await vi.waitFor(() => expect(received).toHaveLength(2))
    await delay(100)
    expect(received.map(event => event.type)).toEqual(['refresh', 'refresh'])
  })

  it('coalesces a 1000-token flood, targets only the selected session, and delivers the final authoritative message with the same ID', async () => {
    const dataDir = await directory()
    const start = deferred()
    const finish = deferred()
    const provider: ModelProvider = {
      id: 'flood',
      name: 'Flood fixture',
      model: 'fixture',
      async *stream({ signal }) {
        await start.promise
        for (let batch = 0; batch < 20; batch++) {
          for (let token = 0; token < 50; token++) yield { type: 'text', text: '字' }
          await delay(5, undefined, { signal })
        }
        await finish.promise
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const { t, device } = await testHost({
      dataDir,
      demo: false,
      providerId: 'flood',
      plugins: [
        {
          id: 'flood',
          name: 'Flood fixture',
          version: '1',
          description: 'Deterministic transport fixture',
          activate(ctx) {
            ctx.registerProvider(provider)
          },
        },
      ],
    })
    cleanups.push(async () => {
      start.resolve()
      finish.resolve()
    })
    const { sessionId } = await device.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: 'flood', requestId: randomUUID() },
    })
    const selected = await events(device, `?sessionId=${sessionId}`)
    const other = await events(device, '?sessionId=another-session')
    start.resolve()
    await vi.waitFor(() => expect(selected.some(event => event.type === 'task-state' && event.detail.liveText.length === 1000)).toBe(true))
    const streaming = selected.filter((event): event is TaskStateEvent => event.type === 'task-state')
    expect(streaming.length).toBeGreaterThan(0)
    expect(streaming.length).toBeLessThanOrEqual(12)
    expect(streaming.every(event => event.sessionId === sessionId && event.detail.activity?.phase === 'model')).toBe(true)
    expect(other.filter(event => event.type === 'task-state')).toHaveLength(0)
    // Starting a turn changes the list row a few times, and how many of those the other stream sees depends on when it
    // subscribed. The flood itself must add none: nothing after the first streamed text reaches another session's stream.
    const firstText = streaming.find(event => event.detail.liveText.length > 0)!
    expect(other.filter(event => event.type === 'tasks-invalidated' && event.revision > firstText.revision)).toHaveLength(0)
    const lastLive = streaming.at(-1)!
    expect(lastLive.detail.liveMessageId).toBeTruthy()
    finish.resolve()
    await vi.waitFor(() => expect(selected.some(event => event.type === 'task-state' && event.detail.summary.status === 'idle')).toBe(true))
    const states = selected.filter((event): event is TaskStateEvent => event.type === 'task-state')
    expect(states.map(event => event.revision)).toEqual([...states.map(event => event.revision)].sort((a, b) => a - b))
    const settled = states.at(-1)!
    expect(settled.detail.liveText).toBe('')
    expect(settled.detail.activity).toBeUndefined()
    expect(settled.detail.messages.at(-1)).toMatchObject({ id: lastLive.detail.liveMessageId, text: '字'.repeat(1000), state: 'completed' })
    const current = await device.json<TaskDetail>(`tasks/${sessionId}`)
    expect(current.sync?.instanceId).toBe(t.host.instanceId)
    expect(current.sync!.revision).toBeGreaterThanOrEqual(settled.revision)
  })

  it('stamps snapshots and streamed task states with the Host clock, which also times the runs', async () => {
    const dataDir = await directory()
    const T0 = Date.parse('2026-10-24T06:00:00.000Z')
    let time = T0
    const finish = deferred()
    // The reply waits for the subscription: the run starts before POST /tasks answers (the Host records the session's
    // project after the driver created it), so an unguarded first chunk can stream before anyone listens.
    const subscribed = deferred()
    const provider: ModelProvider = {
      id: 'clocked',
      name: 'Clocked fixture',
      model: 'clocked',
      async *stream({ signal }) {
        await subscribed.promise
        time += 2000
        yield { type: 'text', text: '一' }
        await finish.promise
        signal.throwIfAborted()
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const { device } = await testHost({
      dataDir,
      demo: false,
      providerId: 'clocked',
      clock: () => time,
      plugins: [
        {
          id: 'clocked',
          name: 'Clocked fixture',
          version: '1',
          description: 'Deterministic clock fixture',
          activate(ctx) {
            ctx.registerProvider(provider)
          },
        },
      ],
    })
    cleanups.push(async () => {
      subscribed.resolve()
      finish.resolve()
    })
    expect((await device.json<{ hostTime?: string }>('snapshot')).hostTime).toBe(new Date(T0).toISOString())
    const { sessionId } = await device.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: 'clock', requestId: randomUUID() },
    })
    const received = await events(device, `?sessionId=${sessionId}`)
    subscribed.resolve()
    await vi.waitFor(() => expect(received.some(event => event.type === 'task-state' && event.detail.liveText === '一')).toBe(true))
    const live = received.findLast((event): event is TaskStateEvent => event.type === 'task-state' && event.detail.liveText === '一')!
    expect(live.hostTime).toBe(new Date(T0 + 2000).toISOString())
    expect(live.detail.sync?.hostTime).toBe(live.hostTime)
    expect(live.detail).toMatchObject({ runStartedAt: new Date(T0).toISOString(), lastOutputAt: new Date(T0 + 2000).toISOString() })
    // A plain detail request carries no time, so two devices reading the same state get the same body.
    expect((await device.json<TaskDetail>(`tasks/${sessionId}`)).sync).not.toHaveProperty('hostTime')
    finish.resolve()
  })

  it('reports queued, approval, executing and cancelling phases without claiming a cancelled tool has finished early', async () => {
    const dataDir = await directory()
    const entered = deferred()
    const cleanup = deferred()
    const provider: ModelProvider = {
      id: 'fixture',
      name: 'Fixture',
      model: 'fixture',
      async *stream() {
        yield { type: 'tool-call', call: { id: 'first', name: 'write', arguments: {} } }
        yield { type: 'tool-call', call: { id: 'second', name: 'write', arguments: {} } }
        yield { type: 'finish', reason: 'tool-calls' }
      },
    }
    const tool: ToolDefinition = {
      name: 'write',
      description: 'Fixture',
      parameters: {},
      requiresApproval: true,
      async execute(_args, { signal }) {
        entered.resolve()
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
        await cleanup.promise
        signal.throwIfAborted()
        return { text: 'unreachable' }
      },
    }
    const bridge = createRuntime({
      dataDir,
      workspaceRoot: dataDir,
      providerId: 'fixture',
      registry: { acquire: () => ({ provider, tools: [tool], release() {} }) },
    })
    cleanups.push(async () => {
      cleanup.resolve()
      await bridge.close()
    })
    const { sessionId } = await bridge.createTask({ prompt: 'write', requestId: 'states' })
    await vi.waitFor(async () => expect((await bridge.detail(sessionId)).summary.status).toBe('waiting-approval'))
    const approval = await bridge.detail(sessionId)
    expect(approval.activity).toEqual({ phase: 'approval', toolName: 'write', since: expect.any(String) })
    expect(approval.messages.filter(message => message.role === 'tool').map(message => message.state)).toEqual([
      'awaiting-approval',
      'queued',
    ])
    expect(approval.approvals[0].toolCallId).toBe('first')
    await bridge.decide(approval.approvals[0].id, 'allow')
    await entered.promise
    expect((await bridge.detail(sessionId)).activity?.phase).toBe('tool')
    const cancellation = bridge.cancel(sessionId)
    await vi.waitFor(async () => expect((await bridge.detail(sessionId)).activity?.phase).toBe('cancelling'))
    expect((await bridge.detail(sessionId)).summary.status).toBe('running')
    cleanup.resolve()
    await cancellation
    const cancelled = await bridge.detail(sessionId)
    expect(cancelled.activity).toBeUndefined()
    expect(cancelled.summary.status).toBe('cancelled')
    expect(cancelled.messages.filter(message => message.role === 'tool').map(message => message.state)).toEqual(['cancelled', 'cancelled'])
  })
})
