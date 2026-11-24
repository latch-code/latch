import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Approval, RunLive, TaskSummary } from '@latch/protocol'
import { AppError, type HarnessDriver, type ModelProvider, type Bridge } from '@latch/sdk'
import { createRuntime } from '@latch/core'
import { harnessPromptSource } from '@latch/harness-acp'
import { HarnessHub, listSignature, type HarnessMount } from '../src/hub.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'latch-hub-'))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  return path
}

async function hub(dataDir?: string, defaultId = 'standard') {
  const log = vi.fn()
  const value = await HarnessHub.open({ dataDir: dataDir ?? (await directory()), defaultId: () => defaultId, log })
  cleanups.push(() => value.close())
  return { hub: value, log }
}

function summary(id: string, status: TaskSummary['status'] = 'idle'): TaskSummary {
  return { harnessId: 'standard', id, title: `Task ${id}`, status, updatedAt: new Date().toISOString() }
}

/** An external Bridge backed by plain arrays the test can mutate. */
function external(tasks: TaskSummary[] = [], approvals: Approval[] = [], extra: Partial<Bridge> = {}) {
  let notify: (sessionId?: string) => void = () => {}
  const mocks = {
    start: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    listTasks: vi.fn(async () => structuredClone(tasks)),
    detail: vi.fn(async (sessionId: string) => {
      const found = tasks.find(task => task.id === sessionId)
      if (!found) throw new AppError(404, 'task-not-found', 'missing')
      return {
        summary: structuredClone(found),
        messages: [],
        approvals: approvals.filter(item => item.sessionId === sessionId),
        liveText: '',
        cursor: 1,
      }
    }),
    createTask: vi.fn<Bridge['createTask']>(async () => ({ sessionId: `created-${randomUUID()}` })),
    prompt: vi.fn<Bridge['prompt']>(async () => {}),
    cancel: vi.fn(async () => {}),
    approvals: vi.fn(() => structuredClone(approvals)),
    decide: vi.fn<Bridge['decide']>(async () => true),
    subscribe: (listener: (sessionId?: string) => void) => {
      notify = listener
      return () => {
        notify = () => {}
      }
    },
  } satisfies Bridge
  // Overrides replace behaviour only; the mock handles stay typed for assertions.
  const bridge = Object.assign(mocks, extra) as typeof mocks & Pick<Bridge, 'remove' | 'setConfig'>
  return { bridge, notify: (sessionId?: string) => notify(sessionId) }
}

function driver(id: string, extra: Partial<HarnessDriver> = {}): HarnessDriver {
  return {
    id,
    name: `Driver ${id}`,
    version: '1',
    create: () => {
      throw new Error('mounted through HarnessMount.create')
    },
    ...extra,
  }
}

function mount(bridge: Bridge, extra: Partial<HarnessMount> = {}): HarnessMount & { release: ReturnType<typeof vi.fn> } {
  return { create: () => bridge, release: vi.fn(), kind: 'plugin', ...extra } as unknown as HarnessMount & {
    release: ReturnType<typeof vi.fn>
  }
}

function approval(id: string, sessionId: string): Approval {
  return { id, sessionId, toolName: 'write', reason: 'fixture', requestedAt: new Date().toISOString() }
}

describe('run silence', () => {
  const T0 = Date.parse('2026-10-31T06:00:00.000Z')
  const RUN = '11111111-1111-4111-8111-111111111111'
  const iso = (ms: number) => new Date(T0 + ms).toISOString()
  const thresholds = { model: 120_000, command: 600_000 }

  async function silence(activity: RunLive['activity'], options: { runs?: boolean } = {}) {
    let time = T0
    const live: { current?: RunLive } = { current: { runId: RUN, activity, since: iso(0), lastEventAt: iso(0), commandName: 'pnpm test' } }
    const tasks = [summary('s1', 'running')]
    const listTasks = vi.fn(async () => tasks.map(task => ({ ...task, ...(live.current ? { live: live.current } : {}) })))
    const source = external(tasks, [], {
      listTasks,
      detail: async () => ({
        summary: { ...tasks[0]!, ...(live.current ? { live: live.current } : {}) },
        messages: [],
        approvals: [],
        liveText: '',
        cursor: 1,
      }),
      ...(options.runs === false ? {} : { liveRuns: () => (live.current ? [{ sessionId: 's1', live: live.current }] : []) }),
    })
    const value = await HarnessHub.open({
      dataDir: await directory(),
      defaultId: () => 'ext',
      log: vi.fn(),
      now: () => time,
      silenceThresholds: thresholds,
    })
    cleanups.push(() => value.close())
    await value.attach(driver('ext'), mount(source.bridge))
    await value.listTasks()
    listTasks.mockClear()
    const changes: Array<string | undefined> = []
    value.subscribe(id => changes.push(id))
    return { hub: value, source, live, changes, listTasks, advance: (ms: number) => (time += ms), now: () => time }
  }

  it('says nothing below the threshold, then says it once, without a timer listing every session', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const f = await silence('model')
      f.source.notify('s1')
      f.changes.length = 0
      expect((await f.hub.summary('s1')).live).toMatchObject({ silenceThresholdMs: 120_000 })
      expect((await f.hub.summary('s1')).live?.silent).toBeUndefined()
      f.listTasks.mockClear()

      f.advance(120_000)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(f.changes).toEqual(['s1'])
      expect(f.listTasks).not.toHaveBeenCalled()
      expect((await f.hub.summary('s1')).live?.silent).toBe(true)

      // Silent, and told: no further timer, and no second announcement however often the run is looked at.
      f.source.notify('s1')
      await vi.advanceTimersByTimeAsync(3_600_000)
      expect(f.changes).toEqual(['s1', 's1'])

      // Anything from the engine ends the silence.
      f.live.current = { ...f.live.current!, lastEventAt: iso(120_000) }
      expect((await f.hub.summary('s1')).live?.silent).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives a command longer than the model, and never counts waiting on a person or a stop as silence', async () => {
    const f = await silence('command')
    f.advance(300_000)
    expect((await f.hub.summary('s1')).live).toMatchObject({ silenceThresholdMs: 600_000 })
    expect((await f.hub.summary('s1')).live?.silent).toBeUndefined()
    f.advance(300_000)
    expect((await f.hub.summary('s1')).live?.silent).toBe(true)
    for (const activity of ['approval', 'cancelling'] as const) {
      f.live.current = { ...f.live.current!, activity }
      const live = (await f.hub.summary('s1')).live
      expect(live?.silent).toBeUndefined()
      expect(live?.silenceThresholdMs).toBeUndefined()
    }
  })

  it('arms no timer while nothing runs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const f = await silence('model')
      f.live.current = undefined
      f.source.notify('s1')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('doubles the threshold the person saw, once, for this run and this kind of activity', async () => {
    const f = await silence('model')
    await expect(f.hub.keepWaiting('s1', { runId: RUN, thresholdMs: 120_000 })).resolves.toEqual({
      outcome: 'not-silent',
      thresholdMs: 120_000,
    })
    f.advance(130_000)
    expect((await f.hub.summary('s1')).live?.silent).toBe(true)
    f.changes.length = 0
    await expect(f.hub.keepWaiting('s1', { runId: RUN, thresholdMs: 120_000 })).resolves.toEqual({
      outcome: 'extended',
      thresholdMs: 240_000,
    })
    expect(f.changes).toEqual(['s1'])
    expect((await f.hub.summary('s1')).live).toMatchObject({ silenceThresholdMs: 240_000 })
    expect((await f.hub.summary('s1')).live?.silent).toBeUndefined()
    // A retry, or a second device that saw the same threshold.
    await expect(f.hub.keepWaiting('s1', { runId: RUN, thresholdMs: 120_000 })).resolves.toEqual({
      outcome: 'unchanged',
      thresholdMs: 240_000,
    })
    // A command in the same run keeps its own threshold.
    f.live.current = { ...f.live.current!, activity: 'command' }
    expect((await f.hub.summary('s1')).live).toMatchObject({ silenceThresholdMs: 600_000 })
    // Another run starts over.
    f.live.current = {
      ...f.live.current!,
      activity: 'model',
      runId: '22222222-2222-4222-8222-222222222222',
      lastEventAt: new Date(f.now()).toISOString(),
    }
    expect((await f.hub.summary('s1')).live).toMatchObject({ silenceThresholdMs: 120_000 })
    await expect(f.hub.keepWaiting('s1', { runId: RUN, thresholdMs: 240_000 })).resolves.toEqual({ outcome: 'ended' })
  })

  it('asks again no sooner than half the threshold after a late answer', async () => {
    const f = await silence('model')
    f.advance(235_000)
    await expect(f.hub.keepWaiting('s1', { runId: RUN, thresholdMs: 120_000 })).resolves.toEqual({
      outcome: 'extended',
      thresholdMs: 480_000,
    })
  })

  it('leaves out what a run is running from the list, and keeps it in the session', async () => {
    const f = await silence('command')
    f.live.current = { ...f.live.current!, unrecognized: { count: 1, at: iso(0), method: 'terminal/create', messageId: 'm1' } }
    const [row] = await f.hub.listTasks()
    expect(row?.live).toMatchObject({ activity: 'command', unrecognized: { count: 1, at: iso(0) } })
    expect(row?.live?.commandName).toBeUndefined()
    expect(row?.live?.unrecognized?.method).toBeUndefined()
    expect((await f.hub.detail('s1')).summary.live).toMatchObject({ commandName: 'pnpm test', unrecognized: { method: 'terminal/create' } })
  })

  it('reads the list again when an engine goes on from a request Latch did not recognise, not for each word', () => {
    const summary = (lastEventAt: string, unrecognized?: { count: number; at: string }) =>
      JSON.stringify(
        listSignature({
          harnessId: 'standard',
          id: 's1',
          title: '',
          status: 'running',
          updatedAt: iso(0),
          live: { runId: 'r', activity: 'model', since: iso(0), lastEventAt, ...(unrecognized ? { unrecognized } : {}) },
        }),
      )
    expect(summary(iso(1000))).toBe(summary(iso(2000)))
    const request = { count: 1, at: iso(1000) }
    expect(summary(iso(1000), request)).not.toBe(summary(iso(2000), request))
    expect(summary(iso(2000), request)).toBe(summary(iso(3000), request))
  })

  it('notices a silent run moving on without a notification, and its next silence', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const f = await silence('model')
      f.source.notify('s1')
      f.changes.length = 0
      f.advance(120_000)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(f.changes).toEqual(['s1'])

      f.live.current = { ...f.live.current!, lastEventAt: iso(120_000) }
      f.advance(30_000)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(f.changes).toEqual(['s1', 's1'])
      // A silence nothing changed in is not told again.
      f.changes.length = 0

      f.advance(90_000)
      await vi.advanceTimersByTimeAsync(90_000)
      expect(f.changes).toEqual(['s1'])
      f.advance(300_000)
      await vi.advanceTimersByTimeAsync(300_000)
      expect(f.changes).toEqual(['s1'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps waiting for a live run of a driver that only reports it in its summary', async () => {
    const f = await silence('model', { runs: false })
    f.advance(120_000)
    expect((await f.hub.summary('s1')).live?.silent).toBe(true)
    await expect(f.hub.keepWaiting('s1', { runId: RUN, thresholdMs: 120_000 })).resolves.toEqual({
      outcome: 'extended',
      thresholdMs: 240_000,
    })
    expect((await f.hub.summary('s1')).live).toMatchObject({ silenceThresholdMs: 240_000 })
    expect((await f.hub.summary('s1')).live?.silent).toBeUndefined()
    delete f.live.current
    await expect(f.hub.keepWaiting('s1', { runId: RUN, thresholdMs: 240_000 })).resolves.toEqual({ outcome: 'ended' })
  })

  it('tells the list how a run ended, and keeps what was running in the session', async () => {
    const f = await silence('command')
    const runEnd = {
      reason: 'process-exited' as const,
      at: iso(0),
      unknownResults: [{ messageId: 'tool:1', name: 'curl https://user:hunter2@example.test' }],
      unknownResultsTruncated: true as const,
    }
    f.listTasks.mockImplementation(async () => [{ ...summary('s1', 'failed'), runEnd }])
    const [row] = await f.hub.listTasks()
    expect(row?.runEnd).toEqual({ reason: 'process-exited', at: iso(0), unknownResultCount: 1, unknownResultsTruncated: true })
    expect((await f.hub.summary('s1')).runEnd).toEqual(runEnd)
  })

  it('drops what a driver claims about silence, also from a driver that reports no live runs', async () => {
    const f = await silence('model', { runs: false })
    f.live.current = { ...f.live.current!, silent: true, silenceThresholdMs: 1 }
    expect((await f.hub.summary('s1')).live).toMatchObject({ silenceThresholdMs: 120_000 })
    expect((await f.hub.summary('s1')).live?.silent).toBeUndefined()
    await expect(f.hub.keepWaiting('s1', { runId: RUN, thresholdMs: 120_000 })).resolves.toEqual({
      outcome: 'not-silent',
      thresholdMs: 120_000,
    })
  })
})

describe('harness hub routing', () => {
  it('rejects marking MCP prompt provenance when the session’s driver cannot persist it', async () => {
    const { bridge } = external([summary('without-marker')])
    const { hub: value } = await hub(undefined, 'ext')
    await value.attach(driver('ext'), mount(bridge))
    await expect(value.markOutsideContent('without-marker')).rejects.toMatchObject({ code: 'mcp-prompt-unmarked' })
  })

  it('refuses a turn that carries outside content when the session’s driver cannot record it, before the driver sees it', async () => {
    const { bridge } = external([summary('without-marker')])
    const prompt = vi.spyOn(bridge, 'prompt')
    const { hub: value } = await hub(undefined, 'ext')
    await value.attach(driver('ext'), mount(bridge))
    await expect(value.prompt('without-marker', 'hi', 'r-1', { outsideContent: true })).rejects.toMatchObject({
      status: 503,
      code: 'post-unmarked',
    })
    expect(prompt).not.toHaveBeenCalled()
  })

  it('projects only bounded public native skill metadata, never private path or source fields', async () => {
    const { bridge } = external([summary('skills', 'idle')])
    const detail = await bridge.detail('skills')
    let skills: unknown = [{ name: 'known', invocation: '$known', description: 'Known', scope: 'project' }]
    bridge.detail.mockImplementation(async () => ({ ...detail, skills }) as typeof detail)
    const { hub: value } = await hub(undefined, 'ext')
    await value.attach(driver('ext'), mount(bridge))
    expect((await value.detail('skills')).skills).toEqual(skills)
    for (const invalid of [
      [{ name: 'known', invocation: '$known', path: '/private/native-skill/SKILL.md' }],
      [{ name: 'known', invocation: '$known', sourceInfo: { path: '/private/native-skill' } }],
      [{ name: 'known', invocation: '$different' }],
      [{ name: 'bad name', invocation: '$bad name' }],
      [{ name: 'known', invocation: '$known', description: 'x'.repeat(1001) }],
      Array.from({ length: 201 }, (_, index) => ({ name: `known-${index}`, invocation: `$known-${index}` })),
    ]) {
      skills = invalid
      const projected = await value.detail('skills')
      expect(projected.skills).toBeUndefined()
      expect(JSON.stringify(projected)).not.toContain('private/native-skill')
    }
  })

  it('proves the current input before Host notes for create, prompt and steer without changing their bodies', async () => {
    const seen: Array<{ method: string; body: string; source?: string }> = []
    const fixture = external([summary('existing', 'idle')], [], {
      async createTask(input) {
        seen.push({
          method: 'create',
          body: input.prompt,
          source: harnessPromptSource({ method: 'create', requestId: input.requestId }, input.prompt),
        })
        return { sessionId: 'created' }
      },
      async prompt(sessionId, prompt, requestId) {
        seen.push({ method: 'prompt', body: prompt, source: harnessPromptSource({ method: 'prompt', sessionId, requestId }, prompt) })
      },
      async steer(sessionId, prompt, requestId) {
        seen.push({ method: 'steer', body: prompt, source: harnessPromptSource({ method: 'steer', sessionId, requestId }, prompt) })
        return 'injected'
      },
    })
    const { hub: value } = await hub(undefined, 'ext')
    await value.attach(driver('ext'), mount(fixture.bridge))
    value.notePrompts(async () => 'Undo note $note-only')
    await value.createTask({ prompt: 'first $chosen', requestId: 'create-source' })
    await value.prompt('existing', 'next $chosen', 'prompt-source')
    await value.steer('existing', 'added $chosen', 'steer-source')
    expect(seen).toEqual([
      { method: 'create', body: 'first $chosen', source: 'first $chosen' },
      { method: 'prompt', body: 'Undo note $note-only\n\nnext $chosen', source: 'next $chosen' },
      { method: 'steer', body: 'added $chosen', source: 'added $chosen' },
    ])
    expect(harnessPromptSource({ method: 'prompt', sessionId: 'existing', requestId: 'prompt-source' }, seen[1]!.body)).toBeUndefined()
  })

  it('routes sessions verbatim between the Standard runtime and an external driver without injecting Host fields', async () => {
    const dataDir = await directory()
    const provider: ModelProvider = {
      id: 'fixture',
      name: 'Fixture',
      model: 'fixture',
      async *stream() {
        yield { type: 'text', text: 'done' }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const standard = createRuntime({
      dataDir: join(dataDir, 'sessions'),
      workspaceRoot: dataDir,
      providerId: 'fixture',
      registry: { acquire: () => ({ provider, tools: [], release() {} }) },
    })
    const outside = external([summary('ext-1')])
    const { hub: value } = await hub(dataDir)
    const notified: Array<string | undefined> = []
    value.subscribe(sessionId => {
      notified.push(sessionId)
    })
    await value.attach(
      driver('standard', { capabilities: { modes: ['chat', 'agent'], models: { owner: 'latch' }, permission: { enforcement: 'latch' } } }),
      mount(standard, { kind: 'builtin' }),
    )
    await value.attach(driver('ext'), mount(outside.bridge))

    const { sessionId } = await value.createTask({ prompt: 'hello', requestId: randomUUID(), mode: 'chat' })
    expect(sessionId).toMatch(/^task-/)
    await vi.waitFor(async () => expect((await value.detail(sessionId)).summary.status).toBe('idle'))
    expect(notified).toContain(sessionId)
    const tasks = await value.listTasks()
    expect(tasks.map(task => [task.id, task.harnessId])).toEqual(
      expect.arrayContaining([
        [sessionId, 'standard'],
        ['ext-1', 'ext'],
      ]),
    )
    expect((await value.detail('ext-1')).summary.harnessId).toBe('ext')

    const input = { prompt: 'external', requestId: randomUUID(), mode: 'agent' as const }
    outside.bridge.createTask.mockResolvedValueOnce({ sessionId: 'ext-2' })
    expect(await value.createTask({ ...input, harnessId: 'ext' })).toEqual({ sessionId: 'ext-2' })
    expect(outside.bridge.createTask).toHaveBeenCalledExactlyOnceWith(input)
    expect(await value.harnessOf('ext-2')).toBe('ext')
    await value.prompt('ext-1', 'next', 'request-1')
    expect(outside.bridge.prompt).toHaveBeenLastCalledWith('ext-1', 'next', 'request-1')
    await value.prompt('ext-1', 'switch', 'request-2', { model: { providerId: 'p', model: 'm' } })
    expect(outside.bridge.prompt).toHaveBeenLastCalledWith('ext-1', 'switch', 'request-2', { model: { providerId: 'p', model: 'm' } })
    await expect(value.detail('nowhere')).rejects.toMatchObject({ status: 404, code: 'task-not-found' })
    await expect(value.createTask({ ...input, harnessId: 'missing' })).rejects.toMatchObject({ status: 409, code: 'harness-unavailable' })
  })

  it('discovers routes for sessions it has not seen, such as after a restart', async () => {
    const outside = external([summary('known-later')])
    const { hub: value } = await hub()
    await value.attach(driver('ext'), mount(outside.bridge))
    await value.cancel('known-later')
    expect(outside.bridge.cancel).toHaveBeenCalledWith('known-later')
    expect(outside.bridge.listTasks).toHaveBeenCalledOnce()
  })

  it('routes approvals by listing, passes options through, and refuses an ambiguous ID', async () => {
    const first = external([summary('s-a')], [approval('a-1', 's-a'), approval('dup', 's-a')])
    const second = external([summary('s-b')], [approval('b-1', 's-b'), approval('dup', 's-b')])
    const detailOnly = external([summary('s-c')], [], {})
    detailOnly.bridge.detail.mockImplementation(async (sessionId: string) => ({
      summary: summary(sessionId),
      messages: [],
      approvals: [approval('c-1', sessionId)],
      liveText: '',
      cursor: 1,
    }))
    const { hub: value, log } = await hub()
    await value.attach(driver('first'), mount(first.bridge))
    await value.attach(driver('second'), mount(second.bridge))
    await value.attach(driver('third'), mount(detailOnly.bridge))

    expect(
      value
        .approvals()
        .map(item => item.id)
        .sort(),
    ).toEqual(['a-1', 'b-1', 'dup', 'dup'])
    expect(await value.decide('a-1', 'allow', { optionId: 'allow_always' })).toBe(true)
    expect(first.bridge.decide).toHaveBeenCalledExactlyOnceWith('a-1', 'allow', { optionId: 'allow_always' })
    expect(await value.decide('b-1', 'reject')).toBe(true)
    expect(second.bridge.decide).toHaveBeenCalledExactlyOnceWith('b-1', 'reject')
    expect(await value.decide('dup', 'allow')).toBe(false)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('dup'))
    expect(await value.decide('unknown', 'allow')).toBe(false)
    expect(await value.decide('c-1', 'allow')).toBe(false)
    await value.detail('s-c')
    expect(await value.decide('c-1', 'allow')).toBe(true)
    expect(detailOnly.bridge.decide).toHaveBeenCalledExactlyOnceWith('c-1', 'allow')
    expect(first.bridge.decide).toHaveBeenCalledOnce()
    expect(second.bridge.decide).toHaveBeenCalledOnce()
  })

  it('keeps the worktree a session was started in, shows its branch, and never takes one from the driver or passes it on', async () => {
    const dataDir = await directory()
    const { hub: value } = await hub(dataDir)
    const claimed = { ...summary('ext-claims'), worktree: { branch: 'latch/20260101-0000' } }
    const outside = external([summary('ext-1'), claimed])
    await value.attach(driver('ext'), mount(outside.bridge))
    outside.bridge.createTask.mockResolvedValueOnce({ sessionId: 'ext-1' })
    const worktree = { path: '/w/worktrees/api-0123abcd/20261108-0a9f', branch: 'latch/20261108-0a9f' }
    const input = { prompt: 'x', requestId: randomUUID(), cwd: worktree.path }
    await value.createTask({ ...input, harnessId: 'ext', workspaceId: 'api', worktree })
    expect(outside.bridge.createTask).toHaveBeenCalledExactlyOnceWith(input)
    const listed = async (hub: HarnessHub) => Object.fromEntries((await hub.listTasks()).map(task => [task.id, task.worktree ?? null]))
    expect(await listed(value)).toEqual({ 'ext-1': { branch: 'latch/20261108-0a9f' }, 'ext-claims': null })
    const stored = JSON.parse(await readFile(join(dataDir, 'sessions-meta.json'), 'utf8'))
    expect(stored.sessions).toContainEqual({ id: 'ext-1', workspaceId: 'api', worktree })
    await value.close()
    const { hub: reopened } = await hub(dataDir)
    await reopened.attach(driver('ext'), mount(external([summary('ext-1')]).bridge))
    expect(await listed(reopened)).toEqual({ 'ext-1': { branch: 'latch/20261108-0a9f' } })
    expect(reopened.worktreeOf('ext-1')).toEqual(worktree)
    expect(reopened.worktrees()).toEqual([{ sessionId: 'ext-1', path: worktree.path, workspaceId: 'api' }])
  })

  it('says how many files a worktree left unfiltered', async () => {
    const dataDir = await directory()
    const { hub: value } = await hub(dataDir)
    const outside = external([summary('ext-1')])
    await value.attach(driver('ext'), mount(outside.bridge))
    outside.bridge.createTask.mockResolvedValueOnce({ sessionId: 'ext-1' })
    const worktree = { path: '/w/worktrees/api-0123abcd/20261108-0a9f', branch: 'latch/20261108-0a9f', unfiltered: 3 }
    await value.createTask({ prompt: 'x', requestId: randomUUID(), cwd: worktree.path, harnessId: 'ext', workspaceId: 'api', worktree })
    expect((await value.listTasks()).find(task => task.id === 'ext-1')?.worktree).toEqual({ branch: worktree.branch, unfiltered: 3 })
    await value.close()
  })

  it('keeps the first claim on a session ID collision and logs it once', async () => {
    const first = external([summary('same')])
    const second = external([summary('same'), summary('only-second')])
    const { hub: value, log } = await hub()
    await value.attach(driver('first'), mount(first.bridge))
    await value.attach(driver('second'), mount(second.bridge))
    for (let round = 0; round < 2; round++) {
      const tasks = await value.listTasks()
      expect(tasks.filter(task => task.id === 'same').map(task => task.harnessId)).toEqual(['first'])
      expect(tasks.find(task => task.id === 'only-second')?.harnessId).toBe('second')
    }
    expect(log.mock.calls.filter(([text]) => String(text).includes('same'))).toHaveLength(1)
    second.notify('same')
    await value.detail('same')
    expect(second.bridge.detail).not.toHaveBeenCalled()
    second.bridge.createTask.mockResolvedValueOnce({ sessionId: 'same' })
    await expect(value.createTask({ prompt: 'x', requestId: randomUUID(), harnessId: 'second' })).rejects.toMatchObject({
      status: 502,
      code: 'session-id-collision',
    })
  })
})

describe('harness hub isolation and lifecycle', () => {
  it('serves the other drivers when one cannot list its sessions', async () => {
    const healthy = external([summary('ok')])
    const broken = external([], [], {
      listTasks: vi.fn(async () => {
        throw new Error('backend offline')
      }),
    })
    const { hub: value, log } = await hub()
    await value.attach(driver('healthy'), mount(healthy.bridge))
    await value.attach(driver('broken'), mount(broken.bridge))
    expect((await value.listTasks()).map(task => task.id)).toEqual(['ok'])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('backend offline'))
  })

  it('lists an optional driver that fails to start as unavailable but rethrows a required one', async () => {
    const failing = external([], [], {
      start: vi.fn(async () => {
        throw new Error('binary missing')
      }),
    })
    const { hub: value } = await hub()
    const optional = mount(failing.bridge)
    const info = await value.attach(driver('optional'), optional)
    expect(info).toMatchObject({ id: 'optional', status: 'unavailable', statusMessage: expect.stringContaining('binary missing') })
    expect(optional.release).toHaveBeenCalledOnce()
    expect(failing.bridge.close).toHaveBeenCalledOnce()
    expect(value.has('optional')).toBe(false)
    expect(value.drivers().map(item => [item.id, item.status])).toEqual([['optional', 'unavailable']])
    await expect(value.createTask({ prompt: 'x', requestId: randomUUID(), harnessId: 'optional' })).rejects.toMatchObject({
      code: 'harness-unavailable',
    })

    const required = mount(
      external([], [], {
        start: vi.fn(async () => {
          throw new Error('locked')
        }),
      }).bridge,
      { required: true },
    )
    await expect(value.attach(driver('required'), required)).rejects.toThrow('locked')
    expect(required.release).toHaveBeenCalledOnce()
    expect(value.info('required')).toBeUndefined()

    const duplicate = mount(external().bridge)
    await value.attach(driver('twice'), mount(external().bridge))
    await expect(value.attach(driver('twice'), duplicate)).rejects.toMatchObject({ code: 'harness-exists' })
    expect(duplicate.release).toHaveBeenCalledOnce()
  })

  it('routes to a driver only after it has started, and retires one detached while starting', async () => {
    let finishStart!: () => void
    const slow = external([summary('slow-1')], [], {
      start: vi.fn(
        () =>
          new Promise<void>(resolve => {
            finishStart = resolve
          }),
      ),
    })
    const { hub: value } = await hub()
    const mounted = mount(slow.bridge)
    const attaching = value.attach(driver('slow'), mounted)
    await vi.waitFor(() => expect(slow.bridge.start).toHaveBeenCalled())
    expect(value.has('slow')).toBe(false)
    expect(value.info('slow')).toMatchObject({ status: 'unavailable', statusMessage: '正在启动' })
    await expect(value.createTask({ prompt: 'x', requestId: randomUUID(), harnessId: 'slow' })).rejects.toMatchObject({
      code: 'harness-unavailable',
    })
    await expect(value.attach(driver('slow'), mount(external().bridge))).rejects.toMatchObject({ code: 'harness-exists' })
    await value.detach('slow')
    finishStart()
    await expect(attaching).rejects.toMatchObject({ code: 'harness-detached' })
    expect(slow.bridge.close).toHaveBeenCalledOnce()
    expect(mounted.release).toHaveBeenCalledOnce()
    expect(value.drivers()).toEqual([])
  })

  it('detaches a driver only after its sessions settle, then forgets its routes', async () => {
    const tasks = [summary('busy', 'running')]
    const outside = external(tasks)
    const { hub: value } = await hub()
    const mounted = mount(outside.bridge)
    await value.attach(driver('ext'), mounted)
    await value.detail('busy')
    await expect(value.detach('ext')).rejects.toMatchObject({ status: 409, code: 'harness-busy' })
    expect(value.has('ext')).toBe(true)
    tasks[0]!.status = 'idle'
    await value.detach('ext')
    expect(outside.bridge.close).toHaveBeenCalledOnce()
    expect(mounted.release).toHaveBeenCalledOnce()
    expect(value.drivers()).toEqual([])
    await expect(value.detail('busy')).rejects.toMatchObject({ status: 404 })
    await value.detach('ext')
  })

  it('refuses to detach while a driver is still accepting a new session, turn or option change', async () => {
    // Like a runtime that persists before it publishes: in-flight work is not listed yet.
    const tasks = [summary('ext-1')]
    const settle: Array<() => void> = []
    const gate = <T>(value: T) =>
      new Promise<T>(resolve => {
        settle.push(() => resolve(value))
      })
    const outside = external(tasks, [], { setConfig: vi.fn(() => gate(undefined)) })
    outside.bridge.createTask.mockImplementationOnce(() => gate({ sessionId: 'ext-new' }))
    outside.bridge.prompt.mockImplementationOnce(() => gate(undefined))
    const { hub: value } = await hub()
    const mounted = mount(outside.bridge)
    await value.attach(driver('ext'), mounted)
    await value.detail('ext-1')

    const calls = [
      value.createTask({ prompt: 'new', requestId: randomUUID(), harnessId: 'ext' }),
      value.prompt('ext-1', 'next', randomUUID()),
      value.setConfig('ext-1', 'model', 'fast'),
    ]
    for (let pending = calls.length; pending > 0; pending--) {
      await vi.waitFor(() => expect(settle).toHaveLength(pending))
      await expect(value.detach('ext')).rejects.toMatchObject({ status: 409, code: 'harness-busy' })
      expect(value.has('ext')).toBe(true)
      settle.shift()!()
      await calls[calls.length - pending]
    }
    expect(await calls[0]).toEqual({ sessionId: 'ext-new' })
    expect(await value.harnessOf('ext-new')).toBe('ext')
    await value.detach('ext')
    expect(mounted.release).toHaveBeenCalledOnce()
    await expect(value.createTask({ prompt: 'late', requestId: randomUUID(), harnessId: 'ext' })).rejects.toMatchObject({
      code: 'harness-unavailable',
    })
  })

  it('reports capabilities, readiness and source for the catalog', async () => {
    const { hub: value } = await hub()
    await value.attach(driver('plain'), mount(external().bridge))
    await value.attach(
      driver('agent', {
        capabilities: { modes: ['agent'] },
        status: () => ({ status: 'unavailable', statusMessage: '未安装' }),
      }),
      mount(external().bridge, { kind: 'acp' }),
    )
    expect(value.drivers()).toEqual([
      {
        id: 'plain',
        capabilities: {
          models: { owner: 'harness', catalogue: 'none', wires: [] },
          permission: { enforcement: 'none', rejectionNote: false },
          tools: { shell: true, fileMentions: false },
          display: { label: 'Driver plain', mark: 'plugin' },
        },
        status: 'ready',
        modes: ['chat', 'agent'],
        level: 'L3',
      },
      {
        id: 'agent',
        capabilities: {
          models: { owner: 'harness', catalogue: 'none', wires: [] },
          permission: { enforcement: 'none', rejectionNote: false },
          tools: { shell: true, fileMentions: false },
          display: { label: 'Driver agent' },
        },
        editable: true,
        status: 'unavailable',
        statusMessage: '未安装',
        modes: ['agent'],
        level: 'L3',
      },
    ])
  })

  it('keeps a plugin that declares Latch enforces it at L3', async () => {
    const { hub: value } = await hub()
    await value.attach(
      driver('claims', { capabilities: { permission: { enforcement: 'latch', rejectionNote: true }, tools: { shell: false } } }),
      mount(external().bridge),
    )
    expect(value.levelOf('claims')).toBe('L3')
    expect(value.trustOf('claims')).toEqual({ kind: 'plugin', level: 'L3', enforcement: 'harness' })
    expect(value.info('claims')).toMatchObject({
      level: 'L3',
      capabilities: { permission: { enforcement: 'harness' }, tools: { shell: true } },
    })
  })

  it('only publishes built-in request measurements from the built-in runtime', async () => {
    const { hub: value } = await hub()
    const task = summary('external-session')
    const requestContext = { at: task.updatedAt, userMessages: 1, assistantMessages: 0, toolResults: 0, tools: 0, skills: 0, images: 0 }
    const { bridge } = external([task], [], {
      detail: async () => ({ summary: task, messages: [], approvals: [], liveText: '', cursor: 0, requestContext, contextSteps: [] }),
    })
    await value.attach(driver('claims'), mount(bridge))
    const shown = await value.detail(task.id)
    expect(shown).not.toHaveProperty('requestContext')
    expect(shown).not.toHaveProperty('contextSteps')
  })

  it('leaves ACP context provenance to the managed ACP driver', async () => {
    const { hub: value } = await hub()
    const task = summary('claimed-context')
    const at = task.updatedAt
    const { bridge } = external([task], [], {
      detail: async () => ({
        summary: task,
        messages: [{ id: 'prompt', role: 'user', text: '', turn: { contextWindow: { at, used: 300, source: 'claude-sdk', epoch: 5 } } }],
        approvals: [],
        liveText: '',
        cursor: 0,
        contextEvents: [{ id: 'third-party-id', at, source: 'claude-sdk', status: 'completed' }],
        usageReport: {
          at,
          contextUsed: 300,
          contextSource: 'claude-sdk',
          contextEpoch: 5,
          breakdown: { measurement: 'full', categories: [] },
        },
      }),
    })
    await value.attach(driver('claims-context'), mount(bridge))
    const shown = await value.detail(task.id)
    expect(shown).not.toHaveProperty('contextEvents')
    expect(shown.usageReport).toEqual({ at, contextUsed: 300 })
    expect(shown.messages[0]?.turn?.contextWindow).toEqual({ at, used: 300 })
  })

  it('reports which folders of a project each driver receives, and passes them only to one that takes them all', async () => {
    const { hub: value } = await hub()
    const previews = new Map<string, ReturnType<typeof vi.fn>>()
    for (const [id, extra] of [
      ['all', { projectFolders: 'all' }],
      ['capped', { projectFolders: 'all', folderAccess: { access: 'all', max: 5 } }],
      ['zero', { projectFolders: 'all', folderAccess: { access: 'all', max: 0 } }],
      ['asks', { folderAccess: { access: 'primary-asks' } }],
      ['claims', { folderAccess: { access: 'all', max: 5 } }],
      ['plain', {}],
    ] as Array<[string, Partial<HarnessDriver>]>) {
      const launchPreview = vi.fn(async ({ cwd }: { cwd: string }) => ({
        launchHash: 'a'.repeat(64),
        command: '/bin/agent',
        args: [],
        envNames: [],
        cwd,
        verified: false,
        approvals: 'prompts' as const,
        readback: 'none' as const,
      }))
      previews.set(id, launchPreview)
      await value.attach(driver(id, extra), mount(external([], [], { launchPreview }).bridge, { kind: 'acp' }))
    }
    expect(Object.fromEntries(value.drivers().map(info => [info.id, info.projectFolders ?? null]))).toEqual({
      all: { access: 'all' },
      capped: { access: 'all', max: 5 },
      zero: { access: 'all' },
      asks: { access: 'primary-asks' },
      // Only a driver that receives every folder is shown as using them.
      claims: null,
      plain: null,
    })
    const project = {
      workspaceId: 'proj',
      folders: [
        { id: 'api', path: '/w/api' },
        { id: 'web', path: '/w/web' },
      ],
    }
    await value.launchPreviewOf('capped', '/w/api', project)
    expect(previews.get('capped')).toHaveBeenCalledWith({ cwd: '/w/api', ...project })
    await value.launchPreviewOf('asks', '/w/api', project)
    expect(previews.get('asks')).toHaveBeenCalledWith({ cwd: '/w/api' })
  })

  it('closes every driver in reverse order, releases every lease, and reports cleanup failures', async () => {
    const order: string[] = []
    const first = external([], [], {
      close: vi.fn(async () => {
        order.push('first')
      }),
    })
    const second = external([], [], {
      close: vi.fn(async () => {
        order.push('second')
        throw new Error('stuck')
      }),
    })
    const value = await HarnessHub.open({ dataDir: await directory(), defaultId: () => 'first', log: vi.fn() })
    const mounts = [mount(first.bridge), mount(second.bridge)]
    await value.attach(driver('first'), mounts[0]!)
    await value.attach(driver('second'), mounts[1]!)
    await expect(value.close()).rejects.toThrow('Harness hub cleanup failed')
    expect(order).toEqual(['second', 'first'])
    for (const item of mounts) expect(item.release).toHaveBeenCalledOnce()
  })
})

describe('permission levels', () => {
  it('labels builtin sessions L1 and ACP or plugin sessions L3, with the matching permission summary', async () => {
    const builtin = external([summary('b-1')])
    const acp = external([summary('a-1')], [], {
      detail: vi.fn(async (sessionId: string) => ({
        summary: summary(sessionId),
        messages: [],
        approvals: [],
        liveText: '',
        cursor: 1,
        // A bridge cannot raise its own level or claim Latch enforces it.
        permission: {
          level: 'L1' as const,
          enforcer: 'LATCH' as const,
          readback: 'mode' as const,
          expectedMode: 'read-only',
          notes: ['note'],
        },
      })),
    })
    const plugin = external([summary('p-1')])
    const { hub: value } = await hub()
    await value.attach(
      driver('standard', { capabilities: { permission: { enforcement: 'latch' } } }),
      mount(builtin.bridge, { kind: 'builtin' }),
    )
    await value.attach(driver('agent'), mount(acp.bridge, { kind: 'acp' }))
    await value.attach(driver('plugin'), mount(plugin.bridge))
    expect(value.levelOf('standard')).toBe('L1')
    expect(value.levelOf('agent')).toBe('L3')
    expect(value.levelOf('plugin')).toBe('L3')
    expect(value.levelOf('missing')).toBe('L3')
    expect(value.trustOf('agent')).toEqual({ kind: 'acp', level: 'L3', enforcement: 'none' })
    expect(Object.fromEntries((await value.listTasks()).map(task => [task.id, task.level]))).toEqual({
      'b-1': 'L1',
      'a-1': 'L3',
      'p-1': 'L3',
    })
    expect((await value.detail('b-1')).permission).toEqual({ level: 'L1', enforcer: 'LATCH', notes: [] })
    expect((await value.detail('a-1')).permission).toEqual({
      level: 'L3',
      enforcer: 'NONE',
      readback: 'mode',
      expectedMode: 'read-only',
      notes: ['note'],
    })
    expect((await value.detail('p-1')).permission).toEqual({
      level: 'L3',
      enforcer: 'NONE',
      notes: ['第三方 Harness 插件，Latch 无法核实其执行范围'],
    })
  })

  it('passes launch hashes, widen consent, config classification and launch previews through unchanged', async () => {
    const preview = {
      launchHash: 'a'.repeat(64),
      command: '/bin/agent',
      args: [],
      envNames: ['A'],
      cwd: '/tmp',
      verified: true,
      approvals: 'prompts' as const,
      readback: 'mode' as const,
    }
    const setConfig = vi.fn(async () => {})
    const classifyConfigChange = vi.fn(async () => 'wider' as const)
    const launchPreview = vi.fn(async () => preview)
    const acp = external([summary('a-1')], [], { setConfig, classifyConfigChange, launchPreview })
    const plain = external([summary('p-1')])
    const { hub: value } = await hub()
    await value.attach(driver('agent'), mount(acp.bridge, { kind: 'acp' }))
    await value.attach(driver('plain'), mount(plain.bridge))
    acp.bridge.createTask.mockResolvedValueOnce({ sessionId: 'a-2' })
    await value.createTask({ prompt: 'x', requestId: 'r', harnessId: 'agent', expectedLaunchHash: 'b'.repeat(64) })
    expect(acp.bridge.createTask).toHaveBeenCalledWith({ prompt: 'x', requestId: 'r', expectedLaunchHash: 'b'.repeat(64) })
    await value.setConfig('a-1', 'mode', 'auto', {})
    expect(setConfig).toHaveBeenCalledWith('a-1', 'mode', 'auto', {})
    expect(await value.classifyConfigChange('a-1', 'mode', 'auto')).toBe('wider')
    expect(await value.classifyConfigChange('p-1', 'mode', 'auto')).toBe('neutral')
    expect(await value.launchPreviewOf('agent', '/tmp')).toEqual(preview)
    expect(launchPreview).toHaveBeenCalledWith({ cwd: '/tmp' })
    expect(await value.launchPreviewOf('plain', '/tmp')).toBeUndefined()
    await expect(value.launchPreviewOf('missing', '/tmp')).rejects.toMatchObject({ code: 'harness-unavailable' })
  })

  it('lists the L3 sessions that run or wait for approval, the waiting ones first', async () => {
    const builtinTasks = [summary('b-1', 'running')]
    const acpTasks = [
      { ...summary('a-1', 'idle'), updatedAt: '2026-10-25T10:00:00.000Z' },
      { ...summary('a-2', 'running'), updatedAt: '2026-10-25T09:00:00.000Z' },
    ]
    const { hub: value } = await hub()
    await value.attach(
      driver('standard', { capabilities: { permission: { enforcement: 'latch' } } }),
      mount(external(builtinTasks).bridge, { kind: 'builtin' }),
    )
    await value.attach(driver('agent'), mount(external(acpTasks).bridge, { kind: 'acp' }))
    const listed = async () => (await value.unsandboxedTasks()).map(task => [task.id, task.harnessId, task.level])
    expect(await listed()).toEqual([['a-2', 'agent', 'L3']])
    acpTasks[0]!.status = 'waiting-approval'
    expect(await listed()).toEqual([
      ['a-1', 'agent', 'L3'],
      ['a-2', 'agent', 'L3'],
    ])
    acpTasks[0]!.status = 'running'
    expect((await listed()).map(([id]) => id)).toEqual(['a-1', 'a-2'])
    acpTasks[1]!.status = 'waiting-approval'
    expect((await listed()).map(([id]) => id)).toEqual(['a-2', 'a-1'])
    acpTasks[0]!.status = 'cancelled'
    acpTasks[1]!.status = 'idle'
    expect(await listed()).toEqual([])
  })

  it('finds a pending approval by ID, including one a driver reports only in its detail', async () => {
    const listed = external([summary('s-a')], [approval('a-1', 's-a')])
    const detailOnly = external([summary('s-c', 'waiting-approval')])
    detailOnly.bridge.detail.mockImplementation(async (sessionId: string) => ({
      summary: summary(sessionId, 'waiting-approval'),
      messages: [],
      approvals: [approval('c-1', sessionId)],
      liveText: '',
      cursor: 1,
    }))
    const { hub: value } = await hub()
    await value.attach(driver('first'), mount(listed.bridge))
    await value.attach(driver('third'), mount(detailOnly.bridge))
    expect(await value.findApproval('a-1')).toMatchObject({ harnessId: 'first', approval: { id: 'a-1' } })
    expect(await value.findApproval('c-1')).toBeUndefined()
    await value.detail('s-c')
    expect(await value.findApproval('c-1')).toMatchObject({ harnessId: 'third', approval: { id: 'c-1' } })
    expect(await value.findApproval('missing')).toBeUndefined()
  })
})

describe('cancel routing', () => {
  it('passes the named run to the owning driver and returns whether it cancelled anything', async () => {
    const answers = external([summary('s-1', 'running')], [], { cancel: vi.fn(async () => false) })
    const silent = external([summary('s-2', 'running')])
    const { hub: value } = await hub()
    await value.attach(driver('answers'), mount(answers.bridge))
    await value.attach(driver('silent'), mount(silent.bridge))
    expect(await value.cancel('s-1', { runId: 'run-1' })).toBe(false)
    expect(answers.bridge.cancel).toHaveBeenCalledExactlyOnceWith('s-1', { runId: 'run-1' })
    expect(await value.cancel('s-2')).toBeUndefined()
    expect(silent.bridge.cancel).toHaveBeenCalledExactlyOnceWith('s-2')
    expect(await value.summary('s-2')).toMatchObject({ id: 's-2', status: 'running', harnessId: 'silent' })
    await expect(value.cancel('missing')).rejects.toMatchObject({ status: 404 })
  })

  it('passes on a run ID a cancel can carry and leaves out one it cannot, so the page can still stop that run', async () => {
    const named = (id: string, runId: unknown) => ({ ...summary(id, 'running'), runId }) as TaskSummary
    const plugin = external([
      named('s-ok', 'run_1.a:b@c+d-e'),
      named('s-slash', 'run/1'),
      named('s-long', `r${'x'.repeat(128)}`),
      named('s-number', 7),
    ])
    const { hub: value } = await hub()
    await value.attach(driver('plugin'), mount(plugin.bridge))
    expect((await value.summary('s-ok')).runId).toBe('run_1.a:b@c+d-e')
    for (const id of ['s-slash', 's-long', 's-number']) {
      expect(await value.summary(id)).not.toHaveProperty('runId')
      expect((await value.detail(id)).summary).not.toHaveProperty('runId')
    }
    expect((await value.listTasks()).filter(task => 'runId' in task).map(task => task.id)).toEqual(['s-ok'])
  })
})

describe('host-level session metadata', () => {
  it('keeps title, pin and archive overrides for every harness across restarts', async () => {
    const dataDir = await directory()
    const outside = external([summary('s-1'), summary('s-2')])
    const first = await HarnessHub.open({ dataDir, defaultId: () => 'ext', log: vi.fn() })
    await first.attach(driver('ext'), mount(outside.bridge))
    const notified = vi.fn()
    first.subscribe(notified)
    expect(await first.updateMeta('s-1', { title: '重命名的会话', pinned: true })).toMatchObject({
      id: 's-1',
      title: '重命名的会话',
      pinned: true,
      harnessId: 'ext',
    })
    expect(notified).toHaveBeenCalledWith('s-1')
    expect((await stat(join(dataDir, 'sessions-meta.json'))).mode & 0o777).toBe(0o600)
    await first.close()

    const second = await HarnessHub.open({ dataDir, defaultId: () => 'ext', log: vi.fn() })
    cleanups.push(() => second.close())
    await second.attach(driver('ext'), mount(outside.bridge))
    const listed = await second.listTasks()
    expect(listed.find(task => task.id === 's-1')).toMatchObject({ title: '重命名的会话', pinned: true })
    expect(listed.find(task => task.id === 's-2')).not.toHaveProperty('pinned')
    const restored = await second.updateMeta('s-1', { title: null, pinned: false, archived: true })
    expect(restored).toMatchObject({ title: 'Task s-1', archived: true })
    expect(restored).not.toHaveProperty('pinned')
    await expect(second.updateMeta('missing', { pinned: true })).rejects.toMatchObject({ status: 404 })
  })

  it('names a moved conversation by its Host title from the first time it is listed, and lists its fork once that is written', async () => {
    const record = '以下是会话「Opening a note takes almost two seconds」到第 1 轮为止的记录\n<会话记录>…</会话记录>\n\n'
    const prompt = `${record}Go ahead and add the cache, with a test.`
    const tasks: TaskSummary[] = []
    const outside = external(tasks)
    // Like the built-in drivers: the session is reported before createTask returns, named by the Host's title if given.
    outside.bridge.createTask.mockImplementationOnce(async input => {
      tasks.push({ ...summary('moved-1', 'running'), title: input.title ?? input.prompt.replace(/\s+/gu, ' ').slice(0, 80) })
      outside.notify('moved-1')
      return { sessionId: 'moved-1' }
    })
    const { hub: value } = await hub(undefined, 'ext')
    await value.attach(driver('ext'), mount(outside.bridge))
    const listings: Array<Promise<TaskSummary | undefined>> = []
    value.subscribe(sessionId => {
      if (sessionId === 'moved-1') listings.push(value.listTasks().then(listed => listed.find(task => task.id === sessionId)))
    })
    const forkOf = {
      taskId: 'source',
      upToMessageId: 'a1',
      title: 'Opening a note takes almost two seconds',
      turn: 1,
      prefixLength: record.length,
      moved: { from: 'codex' },
    }
    await value.createTask({ prompt, requestId: randomUUID(), harnessId: 'ext', forkOf, initialTitle: 'Profile slow note opening' })

    expect(outside.bridge.createTask).toHaveBeenCalledWith(expect.objectContaining({ prompt, title: 'Profile slow note opening' }))
    expect(outside.bridge.createTask.mock.calls[0]![0]).not.toHaveProperty('forkOf')
    const seen = (await Promise.all(listings)).filter(task => task !== undefined)
    expect(seen.length).toBeGreaterThan(1)
    expect(seen.map(task => task.title)).toEqual(seen.map(() => 'Profile slow note opening'))
    expect(seen.at(-1)?.forkOf).toEqual(forkOf)
  })

  it('deletes through the driver and drops the overlay, or reports what the driver cannot do', async () => {
    const dataDir = await directory()
    const remove = vi.fn(async () => {})
    const setConfig = vi.fn(async () => {})
    const capable = external([summary('s-1')], [], { remove, setConfig })
    const limited = external([summary('s-2')])
    const { hub: value } = await hub(dataDir)
    await value.attach(driver('capable'), mount(capable.bridge))
    await value.attach(driver('limited'), mount(limited.bridge))
    await value.updateMeta('s-1', { archived: true })
    const receipt = {
      kind: 'cancel',
      requestId: 'cancel-0001',
      deviceId: 'dev_AAAAAAAAAAAAAAAAAAAAAA',
      outcome: 'ended',
      at: new Date().toISOString(),
    } as const
    await value.receipts.record('s-1', receipt)
    expect(value.receipts.cancel('s-1', receipt.deviceId, receipt.requestId)).toEqual(receipt)
    await value.remove('s-1')
    expect(remove).toHaveBeenCalledExactlyOnceWith('s-1', undefined)
    expect(value.receipts.cancel('s-1', receipt.deviceId, receipt.requestId)).toBeUndefined()
    expect(JSON.parse(await readFile(join(dataDir, 'sessions-meta.json'), 'utf8'))).toEqual({ version: 1, sessions: [] })
    await expect(value.remove('s-2')).rejects.toMatchObject({ status: 409, code: 'delete-unsupported' })
    await expect(value.setConfig('s-2', 'model', 'x')).rejects.toMatchObject({ status: 501, code: 'not-supported' })
    capable.bridge.listTasks.mockResolvedValue([summary('s-3')])
    await value.setConfig('s-3', 'model', 'fast')
    expect(setConfig).toHaveBeenCalledExactlyOnceWith('s-3', 'model', 'fast')
  })

  it('refuses a corrupt metadata file instead of replacing it', async () => {
    const dataDir = await directory()
    await writeFile(join(dataDir, 'sessions-meta.json'), '{broken')
    await expect(HarnessHub.open({ dataDir, defaultId: () => 'standard' })).rejects.toMatchObject({ status: 500, code: 'config-corrupt' })
    expect(await readFile(join(dataDir, 'sessions-meta.json'), 'utf8')).toBe('{broken')
  })
})
