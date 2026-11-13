import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, test, vi } from 'vitest'
import type { AutomationConfig, AutomationRun, TaskDetail } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { Automations, automationSummary, type AutomationPlan } from '../src/automations.ts'
import { CustomAgents, type AgentActor } from '../src/custom-agents.ts'

const roots: string[] = []
const services: Automations[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const actor: AgentActor = { actor: { deviceId: 'dev_owner', listener: 'unix' }, authorize: () => {} }
const definition = (overrides: Partial<AutomationConfig> = {}) => ({
  requestId: randomUUID(),
  name: '每日依赖检查',
  prompt: '检查依赖',
  schedule: { kind: 'daily' as const, time: '09:00' },
  notify: true,
  ...overrides,
})
const summary = (id: string, patch: Partial<TaskDetail['summary']> = {}) =>
  ({
    summary: { id, title: '', status: 'idle', updatedAt: '', runOutcome: 'completed', ...patch },
    messages: [],
    approvals: [],
  }) as unknown as TaskDetail

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'latch-automations-'))
  roots.push(dataDir)
  const f = {
    dataDir,
    clock: Date.parse('2026-11-02T08:00:00Z'),
    zone: 'UTC',
    basis: '1'.repeat(64),
    planFailure: undefined as Error | undefined,
    ownerFailure: undefined as Error | undefined,
    onAuthorize: undefined as ((trigger: AutomationRun['trigger']) => void) | undefined,
    triggers: [] as AutomationRun['trigger'][],
    onPlan: undefined as (() => void) | undefined,
    audit: { append: vi.fn(async () => undefined as never) },
    start: vi.fn(async (_input: Parameters<Parameters<typeof Automations.open>[0]['start']>[0]): Promise<{ sessionId: string }> => ({
      sessionId: `s-${randomUUID()}`,
    })),
    detail: vi.fn(async (id: string) => summary(id)),
    cancel: vi.fn(async () => {}),
    changed: vi.fn(),
    open: () =>
      Automations.open({
        dataDir,
        audit: f.audit,
        now: () => f.clock,
        timeZone: () => f.zone,
        plan: (_config, trigger): AutomationPlan => {
          f.triggers.push(trigger)
          f.onPlan?.()
          if (f.planFailure) throw f.planFailure
          return { basis: f.basis, persistent: true, harnessId: 'standard', mode: 'agent', model: { providerId: 'p', model: 'm' } }
        },
        authorize: (_device, _config, trigger) => {
          f.onAuthorize?.(trigger)
          if (f.ownerFailure) throw f.ownerFailure
        },
        start: f.start,
        detail: f.detail,
        cancel: f.cancel,
        approvalTtlMs: () => 3_600_000,
        changed: f.changed,
      }),
  }
  const service = await f.open()
  services.push(service)
  return { ...f, f, service }
}

test('is on once saved, keeps the prompt out of its summary, and audits no text', async () => {
  const { service, audit } = await fixture()
  const { value } = await service.create(definition(), actor)
  expect(value).toMatchObject({ enabled: true, state: 'ready', nextRunAt: '2026-11-02T09:00:00.000Z' })
  expect(automationSummary(value)).not.toHaveProperty('prompt')
  expect(JSON.stringify(audit.append.mock.calls)).not.toContain('检查依赖')
})

test('a manual run keeps an unanswered approval beyond the unattended expiry', async () => {
  const { f, service, detail, cancel } = await fixture()
  const { value } = await service.create({ ...definition(), enabled: false }, actor)
  detail.mockImplementation(async id => summary(id, { status: 'waiting-approval' }))
  await service.runNow(value.id, { requestId: randomUUID() }, actor)
  f.clock += 3_600_001
  await service.tick()
  expect(service.get(value.id).lastRun).toMatchObject({ trigger: 'manual', state: 'waiting' })
  expect(cancel).not.toHaveBeenCalled()
})

test('closed tasks receive no grant, survive restart and never dispatch as a background task', async () => {
  const { f, service, start, dataDir } = await fixture()
  const { value } = await service.create({ ...definition(), enabled: false }, actor)
  expect(f.triggers).toEqual(['manual'])
  const stored = JSON.parse(await readFile(join(dataDir, 'automations.json'), 'utf8')) as { rows: Array<{ grant?: unknown }> }
  expect(stored.rows[0]!.grant).toBeUndefined()
  await service.close()
  f.clock += 2 * 86400000
  const again = await f.open()
  services.push(again)
  await again.tick()
  expect(again.get(value.id)).toMatchObject({ enabled: false, state: 'off' })
  expect(again.get(value.id).nextRunAt).toBeUndefined()
  expect(start).not.toHaveBeenCalled()
  await again.runNow(value.id, { requestId: randomUUID() }, actor)
  await again.tick()
  expect(again.get(value.id)).toMatchObject({ enabled: false, state: 'off', lastRun: { trigger: 'manual', state: 'completed' } })
  expect(f.triggers).toEqual(['manual', 'manual'])
})

test('restored background grants recheck the ceiling while an explicit manual run retains its separate authority', async () => {
  const { f, service, start } = await fixture()
  const { value } = await service.create(definition(), actor)
  await service.close()
  f.onAuthorize = trigger => {
    if (trigger === 'schedule') throw new AppError(403, 'automation-owner', 'Background level refused')
  }
  const again = await f.open()
  services.push(again)
  await again.tick()
  expect(again.get(value.id)).toMatchObject({ enabled: false, state: 'paused', pause: { reason: 'owner-unavailable' } })
  expect(start).not.toHaveBeenCalled()
  await again.runNow(value.id, { requestId: randomUUID() }, actor)
  expect(start).toHaveBeenCalledTimes(1)
  expect(f.triggers.at(-1)).toBe('manual')
  await again.tick()
  expect(again.get(value.id).enabled).toBe(false)
})

test('runs at its time as a session, once, and then waits for the next day', async () => {
  const { f, service, start } = await fixture()
  const { value } = await service.create(definition(), actor)
  await service.tick()
  expect(start).not.toHaveBeenCalled()
  f.clock = Date.parse('2026-11-02T09:00:10Z')
  await service.tick()
  expect(start).toHaveBeenCalledTimes(1)
  expect(start.mock.calls[0]![0]).toMatchObject({ automationId: value.id, title: '每日依赖检查', prompt: '检查依赖' })
  await service.tick()
  expect(start).toHaveBeenCalledTimes(1)
  const done = service.get(value.id)
  expect(done).toMatchObject({ state: 'ready', nextRunAt: '2026-11-03T09:00:00.000Z' })
  expect(done.lastRun).toMatchObject({ state: 'completed', trigger: 'schedule', at: '2026-11-02T09:00:00.000Z' })
  expect(done.lastRun?.sessionId).toBeTruthy()
  expect(service.detail(value.id).runs).toHaveLength(1)
})

test('a time the Mac missed is reported, not caught up, and the automation stays on', async () => {
  const { f, service, start } = await fixture()
  const { value } = await service.create(definition(), actor)
  f.clock = Date.parse('2026-11-02T14:00:00Z')
  await service.tick()
  expect(start).not.toHaveBeenCalled()
  expect(service.get(value.id)).toMatchObject({ enabled: true, state: 'ready', nextRunAt: '2026-11-03T09:00:00.000Z' })
  expect(service.get(value.id).lastRun).toMatchObject({ state: 'missed', at: '2026-11-02T09:00:00.000Z' })
  expect(service.get(value.id).lastRun).not.toHaveProperty('sessionId')
})

test('missed times across a restart are each reported once and nothing runs in a burst', async () => {
  const { f, service, start } = await fixture()
  const { value } = await service.create(definition(), actor)
  await service.close()
  f.clock = Date.parse('2026-11-05T12:00:00Z')
  const again = await f.open()
  services.push(again)
  await again.tick()
  await again.tick()
  expect(start).not.toHaveBeenCalled()
  expect(again.detail(value.id).runs.map(run => [run.state, run.at])).toEqual([
    ['missed', '2026-11-05T09:00:00.000Z'],
    ['missed', '2026-11-04T09:00:00.000Z'],
    ['missed', '2026-11-03T09:00:00.000Z'],
    ['missed', '2026-11-02T09:00:00.000Z'],
  ])
  expect(again.get(value.id).nextRunAt).toBe('2026-11-06T09:00:00.000Z')
  expect(again.missedOf('general').map(item => item.at)).toEqual([
    '2026-11-05T09:00:00.000Z',
    '2026-11-04T09:00:00.000Z',
    '2026-11-03T09:00:00.000Z',
    '2026-11-02T09:00:00.000Z',
  ])
})

test('more than 50 missed times keep exactly the newest 50, and the real runs stay in the history', async () => {
  const { f, service, start } = await fixture()
  const agent = `agt_${randomUUID()}`
  const { value } = await service.create(definition({ customAgentId: agent }), actor)
  await service.runNow(value.id, { requestId: randomUUID() }, actor)
  await service.tick()
  await service.tick()
  expect(service.detail(value.id).runs).toMatchObject([{ trigger: 'manual', state: 'completed' }])
  await service.close()
  services.splice(services.indexOf(service), 1)
  // Off for four months: 120 daily times came and went.
  f.clock = Date.parse('2027-03-01T12:00:00Z')
  const again = await f.open()
  services.push(again)
  await again.tick()
  expect(start).toHaveBeenCalledTimes(1)
  const runs = again.detail(value.id).runs
  const missed = runs.filter(run => run.state === 'missed')
  expect(missed).toHaveLength(50)
  expect(missed[0]!.at).toBe('2027-03-01T09:00:00.000Z')
  expect(missed.at(-1)!.at).toBe('2027-01-11T09:00:00.000Z')
  expect(runs.filter(run => run.trigger === 'manual')).toMatchObject([{ state: 'completed' }])
  expect(again.get(value.id)).toMatchObject({
    lastRun: { state: 'missed', at: '2027-03-01T09:00:00.000Z' },
    nextRunAt: '2027-03-02T09:00:00.000Z',
  })
  expect(again.missedOf(agent)).toHaveLength(50)
  // Turned off: nothing is missing it any more.
  await again.setEnabled(value.id, { requestId: randomUUID(), baseRevision: again.get(value.id).revision, enabled: false }, actor)
  expect(again.missedOf(agent)).toEqual([])
})

test('a sleep gap seen by the running scheduler records every time it covered, and a run since clears the count', async () => {
  vi.useFakeTimers({
    now: Date.parse('2026-11-02T08:00:00Z'),
    toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
  })
  // Ticks of the scheduler's own interval, with the file writes they wait for given real time to land.
  const ticks = async () => {
    for (let index = 0; index < 12; index++) {
      await vi.advanceTimersByTimeAsync(500)
      await wait(10)
    }
  }
  try {
    const { f, start } = await fixture()
    const service = await Automations.open({
      dataDir: f.dataDir,
      audit: f.audit,
      timeZone: () => 'UTC',
      plan: () => ({ basis: f.basis, persistent: true, harnessId: 'standard', mode: 'agent' }),
      authorize: () => {},
      start: f.start,
      detail: f.detail,
      cancel: f.cancel,
      approvalTtlMs: () => 3_600_000,
      changed: f.changed,
    })
    services.push(service)
    const { value } = await service.create(definition({ customAgentId: `agt_${randomUUID()}` }), actor)
    await ticks()
    expect(start).not.toHaveBeenCalled()
    // The Mac sleeps: no timer fires while the clock moves two days and three hours on.
    vi.setSystemTime(Date.parse('2026-11-04T11:00:00Z'))
    await ticks()
    expect(start).not.toHaveBeenCalled()
    const owner = value.customAgentId!
    expect(service.missedOf(owner).map(item => item.at)).toEqual([
      '2026-11-04T09:00:00.000Z',
      '2026-11-03T09:00:00.000Z',
      '2026-11-02T09:00:00.000Z',
    ])
    expect(service.missedOf('general')).toEqual([])
    expect(service.get(value.id)).toMatchObject({ enabled: true, state: 'ready', nextRunAt: '2026-11-05T09:00:00.000Z' })
    // 立即运行 is a real run: the times before it are no longer counted.
    await service.runNow(value.id, { requestId: randomUUID() }, actor)
    await ticks()
    expect(start).toHaveBeenCalledTimes(1)
    expect(service.missedOf(owner)).toEqual([])
  } finally {
    vi.useRealTimers()
  }
})

test('the keep-awake times name only the asked owners, and a run counts only within the hold', async () => {
  const { f, service } = await fixture()
  const agent = `agt_${randomUUID()}`
  f.detail.mockImplementation(async (id: string) => summary(id, { status: 'running' }))
  const { value } = await service.create(definition({ customAgentId: agent }), actor)
  await service.create(definition({ schedule: { kind: 'daily', time: '08:30' } }), actor)
  expect(service.wakeFor(new Set([agent]), 30 * 60_000)).toEqual({ next: '2026-11-02T09:00:00.000Z', running: 0 })
  expect(service.wakeFor(new Set(['general']), 30 * 60_000)).toEqual({ next: '2026-11-02T08:30:00.000Z', running: 0 })
  expect(service.wakeFor(new Set(), 30 * 60_000)).toEqual({ running: 0 })
  f.clock = Date.parse('2026-11-02T09:00:05Z')
  await service.tick()
  expect(service.get(value.id).state).toBe('running')
  expect(service.wakeFor(new Set([agent]), 30 * 60_000)).toEqual({ running: 1 })
  // Past the hold, a run that has not settled no longer keeps anything awake.
  f.clock = Date.parse('2026-11-02T09:31:00Z')
  expect(service.wakeFor(new Set([agent]), 30 * 60_000)).toEqual({ running: 0 })
})

test('a start with an unknown result is never sent again and asks the owner', async () => {
  const { f, service, start } = await fixture()
  const { value } = await service.create(definition(), actor)
  start.mockRejectedValueOnce(new Error('connection reset'))
  f.clock = Date.parse('2026-11-02T09:00:00Z')
  await service.tick()
  const paused = service.get(value.id)
  expect(paused).toMatchObject({ enabled: false, state: 'paused', pause: { reason: 'unknown-outcome' } })
  expect(paused.lastRun?.state).toBe('unknown')
  f.clock = Date.parse('2026-11-03T09:00:00Z')
  await service.tick()
  expect(start).toHaveBeenCalledTimes(1)
})

test('a start the engine refused is a failed run, and it pauses', async () => {
  const { f, service, start } = await fixture()
  const { value } = await service.create(definition(), actor)
  start.mockRejectedValueOnce(new AppError(409, 'workspace-unavailable', '项目不可用'))
  f.clock = Date.parse('2026-11-02T09:00:00Z')
  await service.tick()
  expect(service.get(value.id)).toMatchObject({ state: 'paused', pause: { reason: 'agent-unavailable' }, lastRun: { state: 'failed' } })
})

test('an intent left by a crash pauses on restart instead of running again', async () => {
  const { f, service, start } = await fixture()
  const { value } = await service.create(definition(), actor)
  start.mockImplementationOnce(() => new Promise(() => {}))
  f.clock = Date.parse('2026-11-02T09:00:00Z')
  void service.tick()
  await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1))
  const again = await f.open()
  services.push(again)
  expect(again.get(value.id)).toMatchObject({ state: 'paused', pause: { reason: 'unknown-outcome' }, lastRun: { state: 'unknown' } })
  await again.close()
  services.splice(services.indexOf(again), 1)
  services.splice(services.indexOf(service), 1)
})

test('a changed plan or a device that lost its standing pauses before anything runs', async () => {
  const { f, service, start } = await fixture()
  const a = (await service.create(definition(), actor)).value
  f.basis = '2'.repeat(64)
  await service.tick()
  expect(service.get(a.id)).toMatchObject({ enabled: false, pause: { reason: 'definition-changed' } })
  // A rename settles nothing the pause asks about; turning it on does, on what is there now.
  const renamed = (await service.patch(a.id, { requestId: randomUUID(), baseRevision: service.get(a.id).revision, name: '改名' }, actor))
    .value
  expect(renamed).toMatchObject({ enabled: false, state: 'paused', name: '改名', pause: { reason: 'definition-changed' } })
  const on = (await service.setEnabled(a.id, { requestId: randomUUID(), baseRevision: renamed.revision, enabled: true }, actor)).value
  expect(on).toMatchObject({ enabled: true, state: 'ready', name: '改名' })
  expect(on).not.toHaveProperty('pause')
  f.ownerFailure = new AppError(403, 'automation-owner', 'no')
  await service.tick()
  expect(service.get(a.id).pause?.reason).toBe('owner-unavailable')
  f.ownerFailure = undefined
  f.planFailure = new AppError(409, 'agent-unavailable', 'no')
  await expect(service.create(definition(), actor)).rejects.toMatchObject({ code: 'agent-unavailable' })
  f.clock = Date.parse('2026-11-02T09:00:00Z')
  await service.tick()
  expect(start).not.toHaveBeenCalled()
})

test('a plugin being updated at that moment does not pause it', async () => {
  const { f, service } = await fixture()
  const { value } = await service.create(definition(), actor)
  f.planFailure = new AppError(409, 'plugin-busy', 'busy')
  await service.tick()
  expect(service.get(value.id)).toMatchObject({ enabled: true, state: 'ready' })
})

test('turning it off stops the schedule; turning it on grants again from that device', async () => {
  const { f, service, start } = await fixture()
  const { value } = await service.create(definition(), actor)
  const off = (await service.setEnabled(value.id, { requestId: randomUUID(), baseRevision: 1, enabled: false }, actor)).value
  expect(off).toMatchObject({ enabled: false, state: 'off' })
  expect(off).not.toHaveProperty('nextRunAt')
  f.clock = Date.parse('2026-11-02T09:00:00Z')
  await service.tick()
  expect(start).not.toHaveBeenCalled()
  f.ownerFailure = new AppError(403, 'automation-owner', 'no')
  await expect(service.setEnabled(value.id, { requestId: randomUUID(), baseRevision: 2, enabled: true }, actor)).rejects.toMatchObject({
    code: 'automation-owner',
  })
  f.ownerFailure = undefined
  const on = (await service.setEnabled(value.id, { requestId: randomUUID(), baseRevision: 2, enabled: true }, actor)).value
  expect(on).toMatchObject({ enabled: true, state: 'ready' })
})

test('waiting for an approval shows as waiting, and past its time the run is cancelled, not approved', async () => {
  const { f, service, cancel, detail } = await fixture()
  const { value } = await service.create(definition(), actor)
  detail.mockImplementation(async id => summary(id, { status: 'waiting-approval', runId: 'r1' }))
  f.clock = Date.parse('2026-11-02T09:00:00Z')
  await service.tick()
  await service.tick()
  expect(service.get(value.id).lastRun?.state).toBe('waiting')
  expect(cancel).not.toHaveBeenCalled()
  f.clock += 3_600_000
  await service.tick()
  expect(cancel).toHaveBeenCalledWith(expect.any(String), 'r1')
  detail.mockImplementation(async id => summary(id, { runOutcome: 'cancelled' }))
  await service.tick()
  expect(service.get(value.id)).toMatchObject({ state: 'ready', lastRun: { state: 'cancelled' } })
})

test('立即运行 runs under the caller, once per request, off or on, and keeps the schedule', async () => {
  const { service, start } = await fixture()
  const { value } = await service.create(definition(), actor)
  const request = { requestId: randomUUID() }
  await service.runNow(value.id, request, actor)
  expect(start).toHaveBeenCalledTimes(1)
  await service.runNow(value.id, request, actor)
  expect(start).toHaveBeenCalledTimes(1)
  await expect(service.runNow(value.id, { requestId: randomUUID() }, actor)).rejects.toMatchObject({ code: 'automation-running' })
  await service.tick()
  expect(service.get(value.id)).toMatchObject({
    state: 'ready',
    nextRunAt: '2026-11-02T09:00:00.000Z',
    lastRun: { trigger: 'manual', state: 'completed' },
  })
  const off = await service.setEnabled(
    value.id,
    { requestId: randomUUID(), baseRevision: service.get(value.id).revision, enabled: false },
    actor,
  )
  await service.runNow(value.id, { requestId: randomUUID() }, actor)
  await service.tick()
  expect(service.get(value.id)).toMatchObject({ enabled: false, state: 'off', lastRun: { state: 'completed' } })
  expect(off.value.enabled).toBe(false)
})

test('an authorized edit of its agent keeps it on the new definition; a deleted agent pauses it', async () => {
  const { f, service } = await fixture()
  const customAgentId = `agt_${randomUUID()}`
  const { value } = await service.create(definition({ customAgentId }), actor)
  f.basis = '3'.repeat(64)
  await service.edit(customAgentId, actor, async () => {})
  await service.tick()
  expect(service.get(value.id)).toMatchObject({ enabled: true, state: 'ready' })
  f.planFailure = new AppError(404, 'agent-not-found', 'gone')
  await service.edit(customAgentId, actor, async () => {})
  expect(service.get(value.id)).toMatchObject({ enabled: false, pause: { reason: 'agent-unavailable' } })
})

test('an avatar or name change leaves its automations, their grant and device alone, even with the Harness not ready', async () => {
  const { f, service, dataDir } = await fixture()
  const agents = await CustomAgents.open({ dataDir, audit: { append: vi.fn(async () => undefined as never) } })
  const created = (
    await agents.create(
      {
        requestId: randomUUID(),
        name: '代码审阅',
        description: '',
        harnessId: 'standard',
        mode: 'agent',
        instructions: '只审阅',
        skills: [],
      },
      actor,
    )
  ).value
  const { value } = await service.create(definition({ customAgentId: created.id }), actor)
  const grant = async () =>
    (JSON.parse(await readFile(join(dataDir, 'automations.json'), 'utf8')) as { rows: Array<{ grant?: unknown }> }).rows[0]!.grant
  const before = await grant()
  expect(before).toMatchObject({ deviceId: 'dev_owner' })
  // Another device changes the face and the name while the Harness cannot start.
  const other: AgentActor = { actor: { deviceId: 'dev_phone', listener: 'unix' }, authorize: () => {} }
  f.planFailure = new AppError(409, 'agent-unavailable', 'not ready')
  const hash = () => agents.definitionHash(created.id)
  await service.edit(
    created.id,
    other,
    () =>
      agents.patch(
        created.id,
        { requestId: randomUUID(), baseRevision: 1, avatar: { kind: 'face', bracket: 'angle', eyes: 'arc', hue: 'moss' } },
        other,
      ),
    hash,
  )
  await service.edit(
    created.id,
    other,
    () => agents.patch(created.id, { requestId: randomUUID(), baseRevision: 2, name: '审阅' }, other),
    hash,
  )
  expect(service.get(value.id)).toMatchObject({ enabled: true, state: 'ready' })
  expect(await grant()).toEqual(before)
  // What a run receives does change on new instructions: that still binds to the editor, or pauses when it cannot.
  f.planFailure = undefined
  await service.edit(
    created.id,
    other,
    () => agents.patch(created.id, { requestId: randomUUID(), baseRevision: 3, instructions: '只看测试' }, other),
    hash,
  )
  expect(await grant()).toMatchObject({ deviceId: 'dev_phone' })
  await agents.close()
})

test('a check during the save of an agent, or against a stale read of it, does not pause its automations', async () => {
  const { f, service } = await fixture()
  const customAgentId = `agt_${randomUUID()}`
  const { value } = await service.create(definition({ customAgentId }), actor)
  const other = (await service.create(definition(), actor)).value
  await service.edit(customAgentId, actor, async () => {
    f.basis = '4'.repeat(64)
    await service.tick()
  })
  expect(service.get(value.id)).toMatchObject({ enabled: true, state: 'ready' })
  // Nothing was being saved for this one, so the same change is a real one.
  expect(service.get(other.id)).toMatchObject({ enabled: false, pause: { reason: 'definition-changed' } })
  await service.tick()
  expect(service.get(value.id)).toMatchObject({ enabled: true, state: 'ready' })
})

/** Three due at once; a session runs until its ID is in `finished`. */
async function crowded() {
  const fixtureValue = await fixture()
  const { f, service, start, detail } = fixtureValue
  const running = new Map<string, string>()
  const finished = new Set<string>()
  start.mockImplementation(async input => {
    const sessionId = `s-${input.title}`
    running.set(input.title, sessionId)
    return { sessionId }
  })
  detail.mockImplementation(async id => (finished.has(id) ? summary(id) : summary(id, { status: 'running', runOutcome: undefined })))
  const names = ['a', 'b', 'c']
  const ids: Record<string, string> = {}
  for (const name of names) ids[name] = (await service.create(definition({ name }), actor)).value.id
  f.clock = Date.parse('2026-11-02T09:00:00Z')
  return { ...fixtureValue, running, finished, ids }
}

test('a third automation at the same minute waits its turn and is not reported as missed', async () => {
  const { f, service, start, finished, ids } = await crowded()
  await service.tick()
  expect(start.mock.calls.map(call => call[0].title)).toEqual(['a', 'b'])
  f.clock += 10 * 60_000
  await service.tick()
  expect(start).toHaveBeenCalledTimes(2)
  expect(service.detail(ids.c!).runs).toEqual([])
  expect(service.get(ids.c!)).toMatchObject({ enabled: true, state: 'ready', nextRunAt: '2026-11-02T09:00:00.000Z' })
  finished.add('s-b')
  await service.tick()
  // The same check that settled b gives its place to c, while a goes on.
  expect(service.get(ids.b!)).toMatchObject({ state: 'ready', lastRun: { state: 'completed' } })
  expect(service.get(ids.a!).state).toBe('running')
  expect(start.mock.calls.map(call => call[0].title)).toEqual(['a', 'b', 'c'])
  expect(service.detail(ids.c!).runs).toMatchObject([{ state: 'running', trigger: 'schedule', at: '2026-11-02T09:00:00.000Z' }])
})

test('a waiting time across a restart is reported as missed, since nothing can say it would have started', async () => {
  const { f, service, ids } = await crowded()
  await service.tick()
  await service.tick()
  await service.close()
  services.splice(services.indexOf(service), 1)
  const again = await f.open()
  services.push(again)
  expect(again.detail(ids.c!).runs).toMatchObject([{ state: 'missed' }])
  expect(again.get(ids.c!).nextRunAt).toBe('2026-11-03T09:00:00.000Z')
})

test('立即运行 is refused at the limit, since at most two run at once', async () => {
  const { service, ids } = await crowded()
  await service.tick()
  await expect(service.runNow(ids.c!, { requestId: randomUUID() }, actor)).rejects.toMatchObject({ code: 'automation-limit-running' })
})

test('a time that came during a run is recorded as skipped, not lost, and lastRun still says how the run ended', async () => {
  const { f, service, detail } = await fixture()
  const { value } = await service.create(definition(), actor)
  detail.mockImplementation(async id => summary(id, { status: 'running', runOutcome: undefined }))
  f.clock = Date.parse('2026-11-02T08:58:00Z')
  await service.runNow(value.id, { requestId: randomUUID() }, actor)
  f.clock = Date.parse('2026-11-02T09:05:00Z')
  await service.tick()
  detail.mockImplementation(async id => summary(id))
  await service.tick()
  expect(service.get(value.id)).toMatchObject({
    nextRunAt: '2026-11-03T09:00:00.000Z',
    lastRun: { state: 'completed', trigger: 'manual' },
  })
  expect(service.detail(value.id).runs.map(run => [run.state, run.at])).toEqual([
    ['skipped', '2026-11-02T09:00:00.000Z'],
    ['completed', '2026-11-02T08:58:00.000Z'],
  ])
  // A scheduled run that outlasts the next day's time says so the same way.
  detail.mockImplementation(async id => summary(id, { status: 'running', runOutcome: undefined }))
  f.clock = Date.parse('2026-11-03T09:00:00Z')
  await service.tick()
  f.clock = Date.parse('2026-11-05T10:00:00Z')
  detail.mockImplementation(async id => summary(id))
  await service.tick()
  expect(
    service
      .detail(value.id)
      .runs.slice(0, 3)
      .map(run => [run.state, run.at]),
  ).toEqual([
    ['skipped', '2026-11-05T09:00:00.000Z'],
    ['skipped', '2026-11-04T09:00:00.000Z'],
    ['completed', '2026-11-03T09:00:00.000Z'],
  ])
  expect(service.get(value.id).nextRunAt).toBe('2026-11-06T09:00:00.000Z')
})

test('moving the time later today still runs today, and a rename does not', async () => {
  const { f, service, start } = await fixture()
  const { value } = await service.create(definition(), actor)
  f.clock = Date.parse('2026-11-02T09:00:00Z')
  await service.tick()
  await service.tick()
  expect(start).toHaveBeenCalledTimes(1)
  f.clock = Date.parse('2026-11-02T10:00:00Z')
  const renamed = await service.patch(
    value.id,
    { requestId: randomUUID(), baseRevision: service.get(value.id).revision, name: '改名' },
    actor,
  )
  expect(renamed.value.nextRunAt).toBe('2026-11-03T09:00:00.000Z')
  const moved = await service.patch(
    value.id,
    { requestId: randomUUID(), baseRevision: renamed.value.revision, schedule: { kind: 'daily', time: '17:00' } },
    actor,
  )
  expect(moved.value.nextRunAt).toBe('2026-11-02T17:00:00.000Z')
})

test('the reason for a pause is the real one, and turning it off while a start is on its way stays off', async () => {
  const lost = await fixture()
  const a = (await lost.service.create(definition(), actor)).value
  lost.f.clock = Date.parse('2026-11-02T09:00:00Z')
  // Passes the check, then the device loses its standing before the intent is written.
  lost.f.onPlan = () => {
    lost.f.ownerFailure = new AppError(403, 'automation-owner', 'no')
  }
  await lost.service.tick()
  expect(lost.service.get(a.id).pause?.reason).toBe('owner-unavailable')

  const audit = await fixture()
  const b = (await audit.service.create(definition(), actor)).value
  audit.f.clock = Date.parse('2026-11-02T09:00:00Z')
  audit.audit.append.mockRejectedValueOnce(new Error('disk'))
  await audit.service.tick()
  expect(audit.service.get(b.id).pause?.reason).toBe('audit-unavailable')

  const off = await fixture()
  const c = (await off.service.create(definition(), actor)).value
  off.f.clock = Date.parse('2026-11-02T09:00:00Z')
  off.audit.append.mockImplementationOnce(async () => {
    void off.service.setEnabled(c.id, { requestId: randomUUID(), baseRevision: 1, enabled: false }, actor)
    return undefined as never
  })
  off.start.mockRejectedValueOnce(new AppError(409, 'automation-changed', '定时任务已关闭或已修改。'))
  await off.service.tick()
  await vi.waitFor(() => expect(off.service.get(c.id).enabled).toBe(false))
  await off.service.tick()
  expect(off.service.get(c.id)).toMatchObject({ enabled: false, state: 'off', lastRun: { state: 'failed' } })
  expect(off.service.get(c.id)).not.toHaveProperty('pause')
})

test('a plugin mid-update or a write being confirmed does not pause it, at the check or at the start', async () => {
  const { f, service, start } = await fixture()
  const { value } = await service.create(definition(), actor)
  f.planFailure = new AppError(503, 'agent-write-unknown', 'unknown')
  await service.tick()
  expect(service.get(value.id)).toMatchObject({ enabled: true, state: 'ready' })
  f.planFailure = undefined
  start.mockRejectedValueOnce(new AppError(409, 'plugin-busy', 'busy'))
  f.clock = Date.parse('2026-11-02T09:00:00Z')
  await service.tick()
  expect(service.get(value.id)).toMatchObject({
    enabled: true,
    state: 'ready',
    nextRunAt: '2026-11-03T09:00:00.000Z',
    lastRun: { state: 'failed' },
  })
})

test('a time that falls in the install window is missed, and the automation stays on', async () => {
  const { f, service, start } = await fixture()
  const { value } = await service.create(definition(), actor)
  start.mockRejectedValueOnce(new AppError(409, 'host-updating', '这台电脑正在安装更新，暂时不能开始新会话。安装完成后再试。'))
  f.clock = Date.parse('2026-11-02T09:00:00Z')
  await service.tick()
  expect(service.get(value.id)).toMatchObject({
    enabled: true,
    state: 'ready',
    nextRunAt: '2026-11-03T09:00:00.000Z',
    lastRun: { state: 'missed', at: '2026-11-02T09:00:00.000Z' },
  })
  expect(service.get(value.id)).not.toHaveProperty('pause')
  f.clock = Date.parse('2026-11-03T09:00:00Z')
  await service.tick()
  expect(start).toHaveBeenCalledTimes(2)
})

test('a cancel that fails stays with its row, and the others still run', async () => {
  const { f, service, cancel, detail, start } = await fixture()
  const a = (await service.create(definition({ name: 'a' }), actor)).value
  detail.mockImplementation(async id => summary(id, { status: 'waiting-approval', runId: 'r1' }))
  f.clock = Date.parse('2026-11-02T09:00:00Z')
  await service.tick()
  const b = (await service.create(definition({ name: 'b', schedule: { kind: 'daily', time: '10:00' } }), actor)).value
  cancel.mockRejectedValue(new Error('engine away'))
  f.clock = Date.parse('2026-11-02T10:00:00Z')
  await service.tick()
  expect(cancel).toHaveBeenCalled()
  expect(start.mock.calls.map(call => call[0].title)).toEqual(['a', 'b'])
  expect(service.get(a.id).state).toBe('running')
  expect(service.get(b.id).state).toBe('running')
})

test('follows the Mac when its time zone changes', async () => {
  const { f, service } = await fixture()
  const { value } = await service.create(definition(), actor)
  f.zone = 'Asia/Shanghai'
  await service.tick()
  expect(service.get(value.id).nextRunAt).toBe('2026-11-03T01:00:00.000Z')
})

test('persists in a private file of its own', async () => {
  const { dataDir, service } = await fixture()
  await service.create(definition(), actor)
  const { stat } = await import('node:fs/promises')
  expect((await stat(join(dataDir, 'automations.json'))).mode & 0o777).toBe(0o600)
})
