import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { HarnessPlugin } from '@latch/sdk'
import type { TestDevice } from '@latch/testkit'
import type { TaskStateEvent, TaskDeltaEvent } from '@latch/protocol'
import { startTestHost } from './helpers/host.ts'
import { TaskDeltaStream } from '../src/task-delta.ts'
import { NativeReplay } from '../src/native-replay.ts'

function gate() {
  let release!: () => void
  const waiting = new Promise<void>(resolve => {
    release = resolve
  })
  return { waiting, release }
}

async function reader(device: TestDevice, sessionId?: string, header?: string) {
  const controller = new AbortController()
  const response = await device.request(`events${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`, {
    signal: controller.signal,
    ...(header ? { headers: { 'x-latch-state': header } } : {}),
  })
  expect(response.status).toBe(200)
  const stream = response.body!.getReader(),
    decoder = new TextDecoder()
  const frames: Array<Record<string, unknown>> = []
  let done = false
  const consume = (async () => {
    let pending = ''
    for (;;) {
      const next = await stream.read()
      if (next.done) return
      pending += decoder.decode(next.value, { stream: true })
      let end: number
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const block = pending.slice(0, end)
        pending = pending.slice(end + 2)
        const data = block
          .split('\n')
          .find(line => line.startsWith('data: '))
          ?.slice(6)
        if (data) frames.push(JSON.parse(data) as Record<string, unknown>)
      }
    }
  })()
    .catch(error => {
      if (!controller.signal.aborted) throw error
    })
    .finally(() => {
      done = true
    })
  return {
    frames,
    get done() {
      return done
    },
    states: () =>
      frames.filter(frame => frame.type === 'task-state' || frame.type === 'task-delta') as unknown as Array<
        TaskStateEvent | TaskDeltaEvent
      >,
    async close() {
      controller.abort()
      await consume
    },
  }
}

it('acknowledges a selected text stream with a full baseline before sending only appended text and live timestamps', async () => {
  const steps = [gate(), gate(), gate()]
  const provider: HarnessPlugin = {
    id: 'delta-fixture',
    name: 'Delta fixture',
    version: '1',
    description: '',
    activate(context) {
      context.registerProvider({
        id: 'delta-fixture',
        name: 'Delta fixture',
        model: 'fixture',
        async *stream() {
          await steps[0]!.waiting
          yield { type: 'text', text: '第一段🙂' }
          await steps[1]!.waiting
          yield { type: 'text', text: '\n第二段e\u0301' }
          await steps[2]!.waiting
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  const host = await startTestHost({ plugins: [provider] })
  const controller = new AbortController()
  let consume: Promise<void> | undefined
  try {
    const device = await host.enroll({ listener: 'unix' })
    const { sessionId } = await device.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        prompt: 'Stream',
        harnessId: 'standard',
        mode: 'chat',
        model: { providerId: 'delta-fixture', model: 'fixture' },
      },
    })
    const response = await device.request(`events?sessionId=${encodeURIComponent(sessionId)}`, {
      headers: { 'x-latch-state': 'delta-v1' },
      signal: controller.signal,
    })
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const frames: Array<Record<string, unknown>> = []
    consume = (async () => {
      const decoder = new TextDecoder()
      let pending = ''
      while (!controller.signal.aborted) {
        const next = await reader.read()
        if (next.done) return
        pending += decoder.decode(next.value, { stream: true })
        let end: number
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const block = pending.slice(0, end)
          pending = pending.slice(end + 2)
          const data = block
            .split('\n')
            .find(line => line.startsWith('data: '))
            ?.slice(6)
          if (data) frames.push(JSON.parse(data) as Record<string, unknown>)
        }
      }
    })().catch(error => {
      if (!controller.signal.aborted) throw error
    })
    steps[0]!.release()
    await expect.poll(() => frames.find(frame => frame.type === 'task-state')).toBeDefined()
    const full = frames.find(frame => frame.type === 'task-state')!
    expect(full.stream).toMatchObject({ protocol: 'delta-v1', subscriptionId: expect.any(String), stateSeq: 1 })
    steps[1]!.release()
    await expect.poll(() => frames.find(frame => frame.type === 'task-delta')).toBeDefined()
    const delta = frames.find(frame => frame.type === 'task-delta')!
    expect(delta).toMatchObject({ sessionId, baseSeq: 1, text: { offset: Buffer.byteLength('第一段🙂'), append: '\n第二段e\u0301' } })
    expect(JSON.stringify(delta)).not.toContain('第一段')
    expect(delta.live).toMatchObject({ lastEventAt: expect.any(String), lastOutputAt: expect.any(String) })
    steps[2]!.release()
    await expect.poll(() => frames.filter(frame => frame.type === 'task-state').length).toBe(2)
  } finally {
    for (const step of steps) step.release()
    controller.abort()
    await consume
    await host.close()
  }
})

it('discards negotiated baselines on credential expiry and rotation, and starts renewed readers with new full acknowledgements', async () => {
  let clock = Date.now()
  const steps = Array.from({ length: 6 }, gate)
  const provider: HarnessPlugin = {
    id: 'rotating-delta',
    name: 'Rotating delta',
    version: '1',
    description: '',
    activate(context) {
      context.registerProvider({
        id: 'rotating-delta',
        name: 'Rotating delta',
        model: 'fixture',
        async *stream() {
          for (let index = 0; index < 5; index++) {
            await steps[index]!.waiting
            yield { type: 'text', text: `part-${index}` }
          }
          await steps[5]!.waiting
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  const host = await startTestHost({ now: () => clock, plugins: [provider] })
  const readers: Array<Awaited<ReturnType<typeof reader>>> = []
  const clear = vi.spyOn(TaskDeltaStream.prototype, 'clear')
  try {
    const owner = await host.enroll({ listener: 'unix' }),
      viewer = await host.enroll()
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { requestId: randomUUID(), prompt: 'Stream', mode: 'chat', model: { providerId: 'rotating-delta', model: 'fixture' } },
    })
    const first = await reader(viewer, sessionId, 'delta-v1')
    readers.push(first)
    steps[0]!.release()
    await expect.poll(() => first.states().length).toBeGreaterThan(0)
    const expiredId = first.states()[0]!.stream!.subscriptionId
    clock += 25 * 3600_000
    steps[1]!.release()
    await expect.poll(() => first.done).toBe(true)
    expect(clear.mock.contexts.map(value => (value as TaskDeltaStream).subscriptionId)).toContain(expiredId)
    expect(JSON.stringify(first.frames)).not.toContain('part-1')
    await viewer.renew()
    const second = await reader(viewer, sessionId, 'delta-v1')
    readers.push(second)
    steps[2]!.release()
    await expect.poll(() => second.states().length).toBeGreaterThan(0)
    expect(second.states()[0]).toMatchObject({ type: 'task-state', stream: { stateSeq: 1 }, detail: { liveText: 'part-0part-1part-2' } })
    const rotatedId = second.states()[0]!.stream!.subscriptionId
    expect(rotatedId).not.toBe(expiredId)
    clock += 2 * 60_000
    await viewer.renew()
    const current = await reader(viewer, sessionId, 'delta-v1')
    readers.push(current)
    steps[3]!.release()
    await expect.poll(() => second.states().at(-1)?.type).toBe('task-delta')
    await expect.poll(() => current.states().length).toBeGreaterThan(0)
    expect(current.states()[0]).toMatchObject({ type: 'task-state', stream: { stateSeq: 1 } })
    expect(current.states()[0]!.stream!.subscriptionId).not.toBe(rotatedId)
    clock += 2 * 60_000
    steps[4]!.release()
    await expect.poll(() => second.done).toBe(true)
    expect(clear.mock.contexts.map(value => (value as TaskDeltaStream).subscriptionId)).toContain(rotatedId)
    expect(JSON.stringify(second.frames)).not.toContain('part-4')
    await expect.poll(() => current.states().at(-1)?.type).toBe('task-delta')
    expect(current.done).toBe(false)
  } finally {
    for (const step of steps) step.release()
    for (const stream of readers) await stream.close()
    await host.close()
    clear.mockRestore()
  }
})

it('keeps reader stamps private, clears scopes before omission, sends a new full baseline on widening and releases on close', async () => {
  const steps = Array.from({ length: 5 }, gate)
  const provider: HarnessPlugin = {
    id: 'private-delta',
    name: 'Private delta',
    version: '1',
    description: '',
    activate(context) {
      context.registerProvider({
        id: 'private-delta',
        name: 'Private delta',
        model: 'fixture',
        async *stream() {
          for (let index = 0; index < 4; index++) {
            await steps[index]!.waiting
            yield { type: 'text', text: `part-${index}🙂` }
          }
          await steps[4]!.waiting
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  const host = await startTestHost({ plugins: [provider] })
  const readers: Array<Awaited<ReturnType<typeof reader>>> = []
  const clear = vi.spyOn(TaskDeltaStream.prototype, 'clear')
  const published = vi.spyOn(NativeReplay.prototype, 'publish')
  try {
    const owner = await host.enroll({ listener: 'unix' }),
      viewer = await host.enroll({ listener: 'unix' }),
      narrow = await host.enroll({ listener: 'loopback-tcp' })
    const agent = await owner.json<{ id: string }>('custom-agents', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: 'Private fixture',
        harnessId: 'standard',
        mode: 'chat',
        model: { providerId: 'private-delta', model: 'fixture' },
        instructions: '',
        skills: [],
      },
    })
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        customAgentId: agent.id,
        prompt: 'Stream',
      },
    })
    for (const [device, selected, header] of [
      [viewer, sessionId, 'delta-v1'],
      [viewer, sessionId, 'delta-v1'],
      [viewer, sessionId, undefined],
      [narrow, undefined, 'delta-v1'],
    ] as const)
      readers.push(await reader(device, selected, header))
    const [a, b, legacy, hidden] = readers as [
      (typeof readers)[number],
      (typeof readers)[number],
      (typeof readers)[number],
      (typeof readers)[number],
    ]
    steps[0]!.release()
    await expect.poll(() => a.states().length).toBe(1)
    await expect.poll(() => b.states().length).toBe(1)
    await expect.poll(() => legacy.states().length).toBe(1)
    const aId = a.states()[0]!.stream!.subscriptionId,
      bId = b.states()[0]!.stream!.subscriptionId
    expect(aId).not.toBe(bId)
    expect(legacy.states()[0]).not.toHaveProperty('stream')
    expect(JSON.stringify(hidden.frames)).not.toContain(sessionId)
    steps[1]!.release()
    await expect.poll(() => a.states().at(-1)?.type).toBe('task-delta')
    await expect.poll(() => b.states().at(-1)?.type).toBe('task-delta')
    expect(a.states().at(-1)?.stream).toMatchObject({ subscriptionId: aId, stateSeq: 2 })
    expect(b.states().at(-1)?.stream).toMatchObject({ subscriptionId: bId, stateSeq: 2 })
    clear.mockClear()
    await owner.json(`devices/${viewer.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
    const cleared = () => clear.mock.contexts.map(context => (context as TaskDeltaStream).subscriptionId)
    expect(cleared()).toEqual(expect.arrayContaining([aId, bId]))
    const count = a.states().length
    steps[2]!.release()
    await expect
      .poll(() => published.mock.calls.some(([event]) => event.type === 'task-state' && event.detail.liveText.includes('part-2')))
      .toBe(true)
    // A public heartbeat/refresh may follow, but no private ID, body or advancing subscription stamp is sent.
    expect(a.states()).toHaveLength(count)
    expect(JSON.stringify(hidden.frames)).not.toContain(sessionId)
    await owner.confirmedJson(`devices/${viewer.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
    steps[3]!.release()
    await expect.poll(() => a.states().at(-1)?.type).toBe('task-state')
    expect(a.states().at(-1)?.stream).toMatchObject({ subscriptionId: aId, stateSeq: 3 })
    expect(a.states().at(-1)).toMatchObject({ detail: { liveText: 'part-0🙂part-1🙂part-2🙂part-3🙂' } })
    expect(legacy.states().every(event => event.type === 'task-state' && event.stream === undefined)).toBe(true)
    clear.mockClear()
    published.mockClear()
    const inaccessible = vi.spyOn(host.host.bridge, 'detail').mockRejectedValue(new Error('fixture temporarily unreadable'))
    try {
      await host.host.bridge.updateMeta(sessionId, { title: 'Unreadable fixture' })
      await expect.poll(() => published.mock.calls.some(([event]) => event.type === 'refresh')).toBe(true)
      expect(cleared()).toEqual(expect.arrayContaining([aId, bId]))
    } finally {
      inaccessible.mockRestore()
    }
    clear.mockClear()
    await a.close()
    await expect.poll(() => cleared()).toContain(aId)
  } finally {
    for (const step of steps) step.release()
    for (const stream of readers) await stream.close()
    await host.close()
    clear.mockRestore()
    published.mockRestore()
  }
})
