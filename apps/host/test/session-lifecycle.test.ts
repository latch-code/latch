import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRecord, CancelReceipt, TaskSummary, WorkspaceInfo } from '@latch/protocol'
import type { Bridge, HarnessPlugin, ModelProvider, ProjectFolder } from '@latch/sdk'
import { createAcpAgentPlugin } from '@latch/harness-acp'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { HarnessHub } from '../src/hub.ts'
import { SessionLifecycle, type LifecycleEvent, type RunStarting, type SessionLifecycleEvents } from '../src/session-lifecycle.ts'
import { startTestHost, type TestHost, type TestHostOptions } from './helpers/host.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function testHost(options: TestHostOptions = {}): Promise<TestHost> {
  const host = await startTestHost(options)
  cleanups.push(() => host.close())
  return host
}

/** Runs go through a model service or an agent process, which take longer on a busy machine. */
const SLOW = { timeout: 10_000 }

const EVENTS: readonly LifecycleEvent[] = ['runStarted', 'runSettled', 'sessionArchived', 'sessionDeleted', 'hostStopping']
type Recorded = { [E in LifecycleEvent]: { event: E; payload: SessionLifecycleEvents[E] } }[LifecycleEvent]

/** Every lifecycle event the Host sends from now on, in order. */
function record(t: TestHost): Recorded[] {
  const events: Recorded[] = []
  for (const event of EVENTS) t.host.lifecycle.on(event, payload => void events.push({ event, payload } as Recorded))
  return events
}

/** A model service the test sees each prompt of; `answer` decides how each stream goes on after its first words. */
function modelHost(answer: (signal: AbortSignal) => Promise<void> = async () => {}, options: TestHostOptions = {}) {
  const prompts: string[] = []
  const provider: ModelProvider = {
    id: 'lifecycle-model',
    name: 'Lifecycle fixture',
    model: 'fake',
    async *stream({ messages, signal }) {
      prompts.push(messages.findLast(message => message.role === 'user')?.content ?? '')
      yield { type: 'text', text: 'Working' }
      await answer(signal)
      yield { type: 'finish', reason: 'stop' }
    },
  }
  const plugin: HarnessPlugin = {
    id: 'lifecycle-fixture',
    name: 'Lifecycle fixture',
    version: '1',
    description: '',
    activate(context) {
      context.registerProvider(provider)
    },
  }
  return { prompts, start: () => testHost({ plugins: [plugin], providerId: provider.id, ...options }) }
}

async function create(device: TestDevice, prompt: string, extra: Record<string, unknown> = {}): Promise<string> {
  const response = await device.confirmed('tasks', { method: 'POST', body: { prompt, requestId: randomUUID(), mode: 'agent', ...extra } })
  expect(response.status).toBe(201)
  return ((await response.json()) as { sessionId: string }).sessionId
}

function summary(t: TestHost, sessionId: string): Promise<TaskSummary> {
  return t.host.bridge.summary(sessionId)
}

describe('runs', () => {
  it('announces each run before its first prompt reaches the model, and reports it settled once', async () => {
    const fixture = modelHost()
    const t = await fixture.start()
    const events = record(t)
    const seen: number[] = []
    t.host.lifecycle.on('runStarted', async () => {
      seen.push(fixture.prompts.length)
      // The prompt waits for this listener.
      await delay(200)
      seen.push(fixture.prompts.length)
    })
    const owner = await t.enroll({ listener: 'unix' })
    const sessionId = await create(owner, 'First')
    await expect.poll(() => events.length, SLOW).toBe(2)
    const first = await summary(t, sessionId)
    const folders = [{ id: 'default', path: first.cwd }]
    expect(events).toEqual([
      { event: 'runStarted', payload: { sessionId, projectId: 'default', runId: first.runId, folders } },
      { event: 'runSettled', payload: { sessionId, runId: first.runId, outcome: 'completed' } },
    ])
    expect(seen).toEqual([0, 0])
    expect(fixture.prompts).toEqual(['First'])

    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'Second', requestId: randomUUID() } })
    await expect.poll(() => events.length, SLOW).toBe(4)
    const second = await summary(t, sessionId)
    expect(second.runId).not.toBe(first.runId)
    expect(events.slice(2)).toEqual([
      { event: 'runStarted', payload: { sessionId, projectId: 'default', runId: second.runId, folders } },
      { event: 'runSettled', payload: { sessionId, runId: second.runId, outcome: 'completed' } },
    ])
    expect(seen).toEqual([0, 0, 1, 1])

    // A chat-only run reaches no folder and is not announced.
    const chat = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: 'Chat', requestId: randomUUID(), mode: 'chat' },
    })
    await expect.poll(async () => (await summary(t, chat.sessionId)).runOutcome, SLOW).toBe('completed')
    expect(fixture.prompts).toEqual(['First', 'Second', 'Chat'])
    expect(events).toHaveLength(4)
  })

  it("names a project's folders as the Host resolves them", async () => {
    const t = await testHost()
    const events = record(t)
    const desktop = await t.enroll({ listener: 'unix' })
    const paths = await Promise.all(
      ['api', 'web'].map(async name => {
        const directory = await mkdtemp(join(tmpdir(), `latch-lifecycle-${name}-`))
        cleanups.push(() => rm(directory, { recursive: true, force: true }))
        return realpath(directory)
      }),
    )
    const added = await desktop.addFolders({ paths, name: 'proj' })
    expect(added.status).toBe(201)
    const { workspace } = (await added.json()) as { workspace: WorkspaceInfo }
    const sessionId = await create(desktop, 'hello', { workspaceId: workspace.id })
    await expect.poll(() => events.map(item => item.event), SLOW).toEqual(['runStarted', 'runSettled'])
    expect(events[0].payload).toEqual({
      sessionId,
      projectId: workspace.id,
      runId: (await summary(t, sessionId)).runId,
      folders: workspace.folders!.map(({ id, path }) => ({ id, path })),
    })
    expect(workspace.folders!.map(folder => folder.path)).toEqual(paths)
    // Archiving and deleting carry the project too; once deleted, the session can no longer be asked.
    await desktop.json(`tasks/${sessionId}`, { method: 'PATCH', body: { archived: true } })
    await desktop.json(`tasks/${sessionId}`, { method: 'DELETE' })
    expect(events.slice(2)).toEqual([
      { event: 'sessionArchived', payload: { sessionId, projectId: workspace.id } },
      { event: 'sessionDeleted', payload: { sessionId, projectId: workspace.id } },
    ])
  })

  it('reports a cancelled run settled once its engine stopped, not when the cancel was requested', async () => {
    let streaming!: () => void
    const started = new Promise<void>(resolve => {
      streaming = resolve
    })
    let stop!: () => void
    const stopping = new Promise<void>(resolve => {
      stop = resolve
    })
    let stopped = false
    const fixture = modelHost(async signal => {
      streaming()
      // An engine that takes a while to stop once it is asked to.
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      await stopping
      stopped = true
      throw signal.reason
    })
    const t = await fixture.start()
    const settled: Array<{ payload: SessionLifecycleEvents['runSettled']; stopped: boolean }> = []
    t.host.lifecycle.on('runSettled', payload => void settled.push({ payload, stopped }))
    const owner = await t.enroll({ listener: 'unix' })
    const sessionId = await create(owner, 'Long')
    await started
    const { runId } = await summary(t, sessionId)
    const cancel = owner.json<{ receipt: CancelReceipt }>(`tasks/${sessionId}/cancel`, {
      method: 'POST',
      body: { requestId: randomUUID(), runId },
    })
    await expect.poll(async () => (await t.host.bridge.detail(sessionId)).activity?.phase, SLOW).toBe('cancelling')
    await delay(200)
    expect(settled).toEqual([])
    stop()
    expect((await cancel).receipt).toMatchObject({ runId, outcome: 'stopped', status: 'cancelled' })
    await expect.poll(() => settled, SLOW).toEqual([{ payload: { sessionId, runId, outcome: 'cancelled' }, stopped: true }])
  })

  it('announces an ACP run before the agent receives its prompt, and settles a cancel only once the agent was stopped', async () => {
    const t = await testHost({
      agentPlugin: (agent: AgentRecord) => createAcpAgentPlugin(agent, { stopGraceMs: 100, cancelGraceMs: 1000 }),
    })
    const events = record(t)
    const desktop = await t.enroll({ listener: 'unix' })
    const agentLog = join(t.root, 'agent.log')
    const definition = {
      id: 'fake',
      name: 'Fake agent',
      command: process.execPath,
      args: [FAKE_ACP_AGENT],
      env: { FAKE_ACP_STATE: join(t.root, 'acp-state.json'), FAKE_ACP_LOG: agentLog },
    }
    expect((await desktop.request('agents', { method: 'POST', body: definition })).status).toBe(201)
    const prompts = async () =>
      (await readFile(agentLog, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as { event: string; method?: string | null })
        .filter(entry => entry.event === 'recv' && entry.method === 'session/prompt').length
    const seen: number[] = []
    const off = t.host.lifecycle.on('runStarted', async () => {
      seen.push(await prompts())
      await delay(200)
      seen.push(await prompts())
    })
    const sessionId = await create(desktop, 'echo hi', { harnessId: 'fake' })
    await expect.poll(() => events.length, SLOW).toBe(2)
    off()
    const first = await summary(t, sessionId)
    expect(events).toEqual([
      {
        event: 'runStarted',
        payload: { sessionId, projectId: 'default', runId: first.runId, folders: [{ id: 'default', path: first.cwd }] },
      },
      { event: 'runSettled', payload: { sessionId, runId: first.runId, outcome: 'completed' } },
    ])
    expect(seen).toEqual([0, 0])
    expect(await prompts()).toBe(1)

    // An agent that ignores the cancel keeps the run going until the bridge stops its process.
    await desktop.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'hang', requestId: randomUUID() } })
    await expect.poll(prompts, SLOW).toBe(2)
    const { runId } = await summary(t, sessionId)
    const cancel = desktop.json<{ receipt: CancelReceipt }>(`tasks/${sessionId}/cancel`, {
      method: 'POST',
      body: { requestId: randomUUID(), runId },
    })
    await expect.poll(async () => (await t.host.bridge.detail(sessionId)).activity?.phase, SLOW).toBe('cancelling')
    await delay(200)
    expect(events.map(item => item.event)).toEqual(['runStarted', 'runSettled', 'runStarted'])
    expect((await cancel).receipt).toMatchObject({ runId, outcome: 'stopped', status: 'interrupted' })
    await expect.poll(() => events.at(-1), SLOW).toEqual({ event: 'runSettled', payload: { sessionId, runId, outcome: 'interrupted' } })
    expect(events).toHaveLength(4)
  })

  it('answers a cancel during a hold at once, and the prompt never reaches the engine', async () => {
    const fixture = modelHost(async () => {}, { lifecycleBounds: { runStarted: 60_000 } })
    const t = await fixture.start()
    const events = record(t)
    t.host.lifecycle.on('runStarted', () => new Promise<void>(() => {}))
    const owner = await t.enroll({ listener: 'unix' })
    const sessionId = await create(owner, 'Held')
    await expect.poll(() => events.length, SLOW).toBe(1)
    const { runId } = await summary(t, sessionId)
    const { receipt } = await owner.json<{ receipt: CancelReceipt }>(`tasks/${sessionId}/cancel`, {
      method: 'POST',
      body: { requestId: randomUUID(), runId },
    })
    expect(receipt).toMatchObject({ runId, outcome: 'stopped', status: 'cancelled' })
    await expect.poll(() => events.at(-1), SLOW).toEqual({ event: 'runSettled', payload: { sessionId, runId, outcome: 'cancelled' } })
    expect(fixture.prompts).toEqual([])
  })

  it('answers a cancel of an ACP run during a hold, and the agent never gets the prompt', async () => {
    const t = await testHost({
      lifecycleBounds: { runStarted: 60_000 },
      agentPlugin: (agent: AgentRecord) => createAcpAgentPlugin(agent, { stopGraceMs: 100, cancelGraceMs: 1000 }),
    })
    const events = record(t)
    const desktop = await t.enroll({ listener: 'unix' })
    const agentLog = join(t.root, 'agent.log')
    const definition = {
      id: 'fake',
      name: 'Fake agent',
      command: process.execPath,
      args: [FAKE_ACP_AGENT],
      env: { FAKE_ACP_STATE: join(t.root, 'acp-state.json'), FAKE_ACP_LOG: agentLog },
    }
    expect((await desktop.request('agents', { method: 'POST', body: definition })).status).toBe(201)
    t.host.lifecycle.on('runStarted', () => new Promise<void>(() => {}))
    const sessionId = await create(desktop, 'echo held', { harnessId: 'fake' })
    await expect.poll(() => events.length, SLOW).toBe(1)
    const { runId } = await summary(t, sessionId)
    const { receipt } = await desktop.json<{ receipt: CancelReceipt }>(`tasks/${sessionId}/cancel`, {
      method: 'POST',
      body: { requestId: randomUUID(), runId },
    })
    expect(receipt).toMatchObject({ runId, outcome: 'stopped', status: 'cancelled' })
    expect(await readFile(agentLog, 'utf8').catch(() => '')).not.toContain('session/prompt')
  })

  it('keeps a run going when its listeners throw, reject or never finish', async () => {
    const logs: string[] = []
    const fixture = modelHost(async () => {}, { lifecycleBounds: { runStarted: 300 }, log: text => logs.push(text) })
    const t = await fixture.start()
    const events = record(t)
    t.host.lifecycle.on('runStarted', () => {
      throw new Error('snapshot failed')
    })
    t.host.lifecycle.on('runStarted', () => new Promise<void>(() => {}))
    t.host.lifecycle.on('runSettled', () => Promise.reject(new Error('settle failed')))
    const owner = await t.enroll({ listener: 'unix' })
    const sessionId = await create(owner, 'hello')
    await expect.poll(async () => (await summary(t, sessionId)).runOutcome, SLOW).toBe('completed')
    expect(fixture.prompts).toEqual(['hello'])
    await expect.poll(() => events.map(item => item.event), SLOW).toEqual(['runStarted', 'runSettled'])
    expect(logs).toEqual(
      expect.arrayContaining([
        '会话生命周期事件 runStarted 的处理失败：snapshot failed',
        '会话生命周期事件 runStarted 的处理超过 300 毫秒，已继续',
        '会话生命周期事件 runSettled 的处理失败：settle failed',
      ]),
    )
  })
})

describe('sessions', () => {
  it('announces each archive and delete once, after it is saved', async () => {
    const t = await testHost()
    const events = record(t)
    const owner = await t.enroll({ listener: 'unix' })
    const seen: string[] = []
    t.host.lifecycle.on('sessionArchived', async ({ sessionId }) => {
      seen.push(`archived ${(await summary(t, sessionId)).archived}`)
    })
    t.host.lifecycle.on('sessionDeleted', async ({ sessionId }) => {
      seen.push(
        `deleted ${await summary(t, sessionId).then(
          () => 'still listed',
          (error: { code?: string }) => error.code,
        )}`,
      )
    })
    const chat = async () => {
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { prompt: 'hello', requestId: randomUUID(), mode: 'chat' },
      })
      await expect.poll(async () => (await summary(t, sessionId)).status, SLOW).toBe('idle')
      return sessionId
    }
    const first = await chat()
    const second = await chat()
    await owner.json(`tasks/${first}`, { method: 'PATCH', body: { archived: true } })
    await expect.poll(() => seen).toEqual(['archived true'])
    // Already archived, not an archive, and the way back: none of them is announced.
    await owner.json(`tasks/${first}`, { method: 'PATCH', body: { archived: true } })
    await owner.json(`tasks/${first}`, { method: 'PATCH', body: { title: 'Renamed', pinned: true } })
    await owner.json(`tasks/${first}`, { method: 'PATCH', body: { archived: false } })
    await owner.json('tasks/batch', { method: 'POST', body: { action: 'archive', ids: [second] } })
    await expect.poll(() => seen).toEqual(['archived true', 'archived true'])
    await owner.json(`tasks/${first}`, { method: 'DELETE' })
    await owner.json('tasks/batch', { method: 'POST', body: { action: 'delete', ids: [second] } })
    expect(events).toEqual([
      { event: 'sessionArchived', payload: { sessionId: first, projectId: 'default' } },
      { event: 'sessionArchived', payload: { sessionId: second, projectId: 'default' } },
      { event: 'sessionDeleted', payload: { sessionId: first, projectId: 'default' } },
      { event: 'sessionDeleted', payload: { sessionId: second, projectId: 'default' } },
    ])
    await expect.poll(() => seen.slice(2)).toEqual(['deleted task-not-found', 'deleted task-not-found'])
  })
})

it('hands subscribers an object that can only listen, at runtime as well', async () => {
  const t = await testHost()
  expect(Object.keys(t.host.lifecycle)).toEqual(['on'])
  expect(Object.isFrozen(t.host.lifecycle)).toBe(true)
  expect(t.host.lifecycle).not.toHaveProperty('hostStopping')
  expect(t.host.lifecycle).not.toBeInstanceOf(SessionLifecycle)
})

describe('stopping', () => {
  it('announces the stop once, before drivers and listeners close, and stops even when listeners throw or never finish', async () => {
    const logs: string[] = []
    const t = await testHost({ lifecycleBounds: { hostStopping: 1000 }, log: text => logs.push(text) })
    const events = record(t)
    const owner = await t.enroll({ listener: 'unix' })
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: 'hello', requestId: randomUUID(), mode: 'chat' },
    })
    const seen: string[] = []
    t.host.lifecycle.on('hostStopping', () => {
      throw new Error('terminals failed')
    })
    t.host.lifecycle.on('hostStopping', () => new Promise<void>(() => {}))
    t.host.lifecycle.on('hostStopping', async () => {
      // The drivers still answer, and the Host takes no more requests.
      seen.push(`listed ${(await t.host.bridge.listTasks()).some(task => task.id === sessionId)}`)
      seen.push(`request ${(await owner.request('snapshot')).status}`)
    })
    await Promise.all([t.close(), t.close()])
    expect(events).toEqual([{ event: 'hostStopping', payload: undefined }])
    expect(seen).toEqual(['listed true', 'request 503'])
    expect(logs).toEqual(
      expect.arrayContaining([
        '会话生命周期事件 hostStopping 的处理失败：terminals failed',
        '会话生命周期事件 hostStopping 的处理超过 1000 毫秒，已继续',
      ]),
    )
  })
})

describe('runs open when the Host stops', () => {
  it('cancels a held run before its prompt reaches the engine, and stops without waiting for its listeners', async () => {
    const fixture = modelHost(async () => {}, { lifecycleBounds: { runStarted: 60_000 } })
    const t = await fixture.start()
    const events = record(t)
    t.host.lifecycle.on('runStarted', () => new Promise<void>(() => {}))
    // Keeps the driver open after the release, long enough for a run that was not cancelled to reach the model.
    t.host.lifecycle.on('hostStopping', () => delay(500).then(() => {}))
    const owner = await t.enroll({ listener: 'unix' })
    await create(owner, 'Held')
    await expect.poll(() => events.length, SLOW).toBe(1)
    const stopping = Date.now()
    await t.close()
    expect(Date.now() - stopping).toBeLessThan(10_000)
    expect(fixture.prompts).toEqual([])
    expect(events.map(item => item.event)).toEqual(['runStarted', 'hostStopping'])
  })

  it('ends a run already at its engine without a runSettled', async () => {
    let streaming: () => void = () => {}
    const started = new Promise<void>(resolve => {
      streaming = resolve
    })
    const fixture = modelHost(async signal => {
      streaming()
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      throw signal.reason
    })
    const t = await fixture.start()
    const events = record(t)
    const owner = await t.enroll({ listener: 'unix' })
    await create(owner, 'Long')
    await started
    await t.close()
    expect(events.map(item => item.event)).toEqual(['runStarted', 'hostStopping'])
  })

  it('cancels a run that reaches its start after the stop began, and announces nothing about it', async () => {
    const lifecycle = new SessionLifecycle({ log: () => {} })
    const events: string[] = []
    lifecycle.on('runStarted', () => void events.push('runStarted'))
    await lifecycle.hostStopping()
    const cancel = vi.fn()
    const lookup = vi.fn(async () => ({ projectId: 'default', folders: [] }))
    await lifecycle.runStarted({ sessionId: 's1', runId: 'r1', cancel, lookup })
    expect(cancel).toHaveBeenCalledOnce()
    expect(lookup).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })
})

/** A driver's summary of session `s1` while its run `r1` goes on, with `patch` applied. */
function run(patch: Partial<TaskSummary>): TaskSummary {
  return { id: 's1', title: '', status: 'running', updatedAt: '', runId: 'r1', ...patch }
}

function starting(runId: string, folders: ProjectFolder[] = []): RunStarting {
  return { sessionId: 's1', runId, cancel: () => {}, lookup: async () => ({ projectId: 'default', folders }) }
}

describe('SessionLifecycle', () => {
  it('settles an announced run once, when its summary no longer runs, with the outcome its driver recorded', async () => {
    const logs: string[] = []
    const lifecycle = new SessionLifecycle({ log: text => logs.push(text) })
    const settled: Array<SessionLifecycleEvents['runSettled']> = []
    lifecycle.on('runSettled', payload => void settled.push(payload))
    lifecycle.observe(run({ status: 'idle' }), 'r1')
    await lifecycle.runStarted(starting('r1'))
    await lifecycle.runStarted(starting('r1'))
    for (const status of ['running', 'waiting-approval', 'running'] as const) lifecycle.observe(run({ status }), 'r1')
    expect(settled).toEqual([])
    lifecycle.observe(run({ status: 'interrupted', runOutcome: 'interrupted' }), 'r1')
    lifecycle.observe(run({ status: 'idle', runOutcome: 'completed' }), 'r1')
    expect(settled).toEqual([{ sessionId: 's1', runId: 'r1', outcome: 'interrupted' }])
    // A driver that records no outcome is judged by the status it ended in.
    for (const [status, outcome] of [
      ['idle', 'completed'],
      ['cancelled', 'cancelled'],
      ['failed', 'failed'],
    ] as const) {
      await lifecycle.runStarted(starting(`r-${status}`))
      lifecycle.observe(run({ status, runId: `r-${status}` }), `r-${status}`)
      expect(settled.at(-1)).toEqual({ sessionId: 's1', runId: `r-${status}`, outcome })
    }
    // A run another one replaced before its end was read is not reported with a guessed outcome.
    await lifecycle.runStarted(starting('r2'))
    lifecycle.observe(run({ status: 'running', runId: 'r3' }), 'r2')
    expect(settled).toHaveLength(4)
    expect(lifecycle.watchedRun('s1')).toBeUndefined()
    expect(logs).toHaveLength(1)
  })

  it('ignores a read begun before a later run was announced', async () => {
    const lifecycle = new SessionLifecycle({ log: () => {} })
    const settled: Array<SessionLifecycleEvents['runSettled']> = []
    lifecycle.on('runSettled', payload => void settled.push(payload))
    await lifecycle.runStarted(starting('r2'))
    lifecycle.observe(run({ status: 'running', runId: 'r1' }), 'r1')
    expect(lifecycle.watchedRun('s1')).toBe('r2')
    lifecycle.observe(run({ status: 'idle', runId: 'r2', runOutcome: 'completed' }), 'r2')
    expect(settled).toEqual([{ sessionId: 's1', runId: 'r2', outcome: 'completed' }])
  })

  it('gives each listener its own copy and stops calling one that unsubscribed', async () => {
    const lifecycle = new SessionLifecycle({ log: () => {} })
    const folders: string[] = []
    lifecycle.on('runStarted', payload => {
      payload.folders[0].path = '/changed'
    })
    const off = lifecycle.on('runStarted', payload => void folders.push(payload.folders[0].path))
    const given = [{ id: 'default', path: '/w' }]
    await lifecycle.runStarted(starting('r1', given))
    off()
    await lifecycle.runStarted(starting('r2', given))
    expect(folders).toEqual(['/w'])
    expect(given[0].path).toBe('/w')
  })

  it('holds a run within its bound, its lookup included, and announces nothing after it', async () => {
    const logs: string[] = []
    const lifecycle = new SessionLifecycle({ log: text => logs.push(text), bounds: { runStarted: 100 } })
    const announced: string[] = []
    lifecycle.on('runStarted', ({ runId }) => {
      announced.push(runId)
      return new Promise<void>(() => {})
    })
    await lifecycle.runStarted(starting('r1'))
    expect(announced).toEqual(['r1'])
    expect(logs).toEqual(['会话生命周期事件 runStarted 的处理超过 100 毫秒，已继续'])

    let found: (facts: { projectId: string; folders: ProjectFolder[] }) => void = () => {}
    const lookup = () => new Promise<{ projectId: string; folders: ProjectFolder[] }>(resolve => (found = resolve))
    await lifecycle.runStarted({ sessionId: 's2', runId: 'r2', cancel: () => {}, lookup })
    expect(logs).toHaveLength(2)
    found({ projectId: 'default', folders: [] })
    await delay(10)
    expect(announced).toEqual(['r1'])
    expect(lifecycle.watchedRun('s2')).toBeUndefined()
  })
})

describe('reading a run from its driver', () => {
  /** A hub on one external driver, whose session `s1` has its run `r1` announced. */
  async function watched(listen: boolean) {
    const dataDir = await mkdtemp(join(tmpdir(), 'latch-lifecycle-hub-'))
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
    const lifecycle = new SessionLifecycle({ log: () => {} })
    const settled: Array<SessionLifecycleEvents['runSettled']> = []
    if (listen) lifecycle.on('runSettled', payload => void settled.push(payload))
    const hub = await HarnessHub.open({ dataDir, defaultId: () => 'external', log: () => {}, lifecycle })
    cleanups.push(() => hub.close())
    const task = run({})
    let notify: (sessionId?: string) => void = () => {}
    const listTasks = vi.fn(async () => [structuredClone(task)])
    const bridge = {
      start: async () => {},
      close: async () => {},
      listTasks,
      detail: async () => ({ summary: structuredClone(task), messages: [], approvals: [], liveText: '', cursor: 0 }),
      createTask: async () => ({ sessionId: 's1' }),
      prompt: async () => {},
      cancel: async () => {},
      approvals: () => [],
      decide: async () => false,
      subscribe: (listener: (sessionId?: string) => void) => {
        notify = listener
        return () => {}
      },
    } satisfies Bridge
    const driver = { id: 'external', name: 'External', version: '1', create: () => bridge }
    await hub.attach(driver, { source: 'plugin', create: () => bridge, release: () => {} })
    await lifecycle.runStarted(starting('r1'))
    listTasks.mockClear()
    return { hub, task, listTasks, settled, notify: () => notify('s1') }
  }

  it('reads nothing while no one listens for runs settling', async () => {
    const { listTasks, notify } = await watched(false)
    for (let chunk = 0; chunk < 50; chunk++) notify()
    await delay(120)
    expect(listTasks).not.toHaveBeenCalled()
  })

  it('coalesces the reads of a streaming run and still sees it settle', async () => {
    const { task, listTasks, settled, notify } = await watched(true)
    for (let chunk = 0; chunk < 10; chunk++) {
      for (let burst = 0; burst < 20; burst++) notify()
      await delay(10)
    }
    expect(listTasks.mock.calls.length).toBeLessThanOrEqual(5)
    Object.assign(task, { status: 'idle', runOutcome: 'completed' })
    notify()
    await expect.poll(() => settled, SLOW).toEqual([{ sessionId: 's1', runId: 'r1', outcome: 'completed' }])
  })

  it('reads a settled run at once before the next prompt can hide it', async () => {
    const { hub, task, settled, notify } = await watched(true)
    notify()
    Object.assign(task, { status: 'cancelled', runOutcome: 'cancelled' })
    await hub.prompt('s1', 'next', 'request')
    expect(settled).toEqual([{ sessionId: 's1', runId: 'r1', outcome: 'cancelled' }])
  })
})

describe('the lookup before a run', () => {
  it('asks only the run’s own driver, so a hung listing elsewhere holds no run', async () => {
    const fixture = modelHost()
    const t = await fixture.start()
    const owner = await t.enroll({ listener: 'unix' })
    const sessionId = await create(owner, 'First')
    await expect.poll(async () => (await summary(t, sessionId)).runOutcome, SLOW).toBe('completed')
    const hung: Bridge = {
      start: async () => {},
      close: async () => {},
      listTasks: () => new Promise(() => {}),
      detail: () => new Promise(() => {}),
      createTask: async () => ({ sessionId: 'hung' }),
      prompt: async () => {},
      cancel: async () => {},
      approvals: () => [],
      decide: async () => false,
      subscribe: () => () => {},
    }
    await t.host.bridge.attach(
      { id: 'hung', name: 'Hung', version: '1', create: () => hung },
      { source: 'plugin', create: () => hung, release: () => {} },
    )
    await expect(t.host.bridge.runSummary('standard', sessionId)).resolves.toMatchObject({ id: sessionId })
  })
})
