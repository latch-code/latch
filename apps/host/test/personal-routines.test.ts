import { mkdtemp, readFile, rm, open, rename, symlink, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, test, vi } from 'vitest'
import type { PersonalRoutine, TaskDetail } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { startHostFixture } from '@latch/testkit'
import { hostBundleOptions } from '../scripts/host-bundle.ts'
import { personalPluginRevision } from '../src/personal-revisions.ts'
import { checkedPluginBundle } from '../src/plugin-package-bundle.ts'
import { PersonalRoutines, type RoutinePlan } from '../src/personal-routines.ts'
import { dailyDate, nextDaily } from '../src/personal-schedule.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
const roots: string[] = [],
  services: PersonalRoutines[] = [],
  hosts: TestHost[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.close()
  for (const host of hosts.splice(0).reverse()) await host.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const assistantId = `asst_${randomUUID()}`,
  config = () => ({
    requestId: randomUUID(),
    assistantId,
    name: 'Daily',
    prompt: 'Do actual work',
    schedule: { kind: 'daily' as const, time: '09:00', timeZone: 'UTC' },
  }),
  actor = { actor: { deviceId: 'dev_owner', listener: 'unix' as const }, authorize: () => {} },
  plan: RoutinePlan = {
    basis: '1'.repeat(64),
    persistent: true,
    mode: 'chat',
    model: { providerId: 'fixture', model: 'test' },
    personal: { owner: { assistantId }, pluginIds: [], instructions: 'private memory', revision: '2'.repeat(64) },
  }
async function fixture(overrides: Partial<Parameters<typeof PersonalRoutines.open>[0]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'latch-routines-'))
  roots.push(dir)
  let clock = Date.parse('2026-10-26T08:59:00Z'),
    basis = plan.basis,
    allowed = true,
    status = 'running',
    runOutcome: TaskDetail['summary']['runOutcome']
  const start = vi.fn(async (_input: Parameters<Parameters<typeof PersonalRoutines.open>[0]['start']>[0]) => ({
      sessionId: 'session-actual',
    })),
    audit = { append: vi.fn(async () => ({ seq: 1, hash: '0'.repeat(64) })) },
    options = {
      dataDir: dir,
      audit,
      now: () => clock,
      plan: () => ({ ...plan, basis }),
      authorize: () => {
        if (!allowed) throw new AppError(403, 'revoked', 'revoked')
      },
      start,
      detail: vi.fn(async () => ({ summary: { id: 'session-actual', status, runOutcome } }) as TaskDetail),
      cancel: vi.fn(async () => {
        status = 'idle'
        runOutcome = 'cancelled'
      }),
      approvalTtlMs: () => 8 * 3600000,
      changed: vi.fn(),
      ...overrides,
    },
    service = await PersonalRoutines.open(options)
  services.push(service)
  return {
    service,
    options,
    dir,
    start,
    audit,
    time: (value: string) => {
      clock = Date.parse(value)
    },
    basis: (value: string) => {
      basis = value
    },
    revoke: () => {
      allowed = false
    },
    settle: (value: typeof runOutcome) => {
      status = 'idle'
      runOutcome = value
    },
    waiting: () => {
      status = 'waiting-approval'
    },
  }
}
test('computes daily UTC slots across DST gaps, repeated hours and half-hour time zones', () => {
  expect(nextDaily({ kind: 'daily', time: '02:30', timeZone: 'America/New_York' }, Date.parse('2026-03-08T05:00:00Z'))).toBe(
    '2026-03-09T06:30:00.000Z',
  )
  const fall = { kind: 'daily' as const, time: '01:30', timeZone: 'America/New_York' }
  expect(nextDaily(fall, Date.parse('2026-11-01T05:31:00Z'), '2026-11-01')).toBe('2026-11-02T06:30:00.000Z')
  expect(nextDaily({ kind: 'daily', time: '09:00', timeZone: 'Asia/Kolkata' }, Date.parse('2026-10-26T00:00:00Z'))).toBe(
    '2026-10-26T03:30:00.000Z',
  )
  expect(dailyDate(fall, Date.parse('2026-11-01T06:30:00Z'))).toBe('2026-11-01')
  expect(() => nextDaily({ kind: 'daily', time: '09:00', timeZone: 'Not/AZone' }, Date.now())).toThrow('请选择有效')
})

test('execution authorization ignores package display metadata but binds skills and source/config contents', () => {
  const bundle = checkedPluginBundle({
      manifest: {
        formatVersion: 1,
        id: 'daily-plugin',
        name: 'Name',
        version: '1',
        description: 'Display',
        skills: [{ id: 'daily', name: 'Daily', description: 'Used by the model', file: 'SKILL.md' }],
      },
      files: [{ path: 'SKILL.md', content: 'Original instructions' }],
    }).bundle,
    original = personalPluginRevision(bundle)
  expect(
    personalPluginRevision({ ...bundle, manifest: { ...bundle.manifest, name: 'Renamed', version: '2', description: 'New display' } }),
  ).toBe(original)
  expect(personalPluginRevision({ ...bundle, files: [{ path: 'SKILL.md', content: 'Changed instructions' }] })).not.toBe(original)
  expect(personalPluginRevision({ ...bundle, manifest: { ...bundle.manifest, config: { destination: 'changed' } } })).not.toBe(original)
})
test('persists before dispatch, settles only a real outcome and never repeats the same local date', async () => {
  const f = await fixture(),
    routine = await f.service.create(config(), actor),
    enable = { requestId: randomUUID(), baseRevision: 1, enabled: true }
  const ready = await f.service.setEnabled(routine.id, enable, actor)
  expect(ready).toMatchObject({ state: 'ready', enabled: true, nextRunAt: '2026-10-26T09:00:00.000Z' })
  expect(await f.service.setEnabled(routine.id, enable, actor)).toEqual(ready)
  f.time('2026-10-26T09:00:00Z')
  await f.service.tick()
  expect(f.start).toHaveBeenCalledOnce()
  expect(f.service.get(routine.id).lastRun).toMatchObject({ state: 'running', sessionId: 'session-actual' })
  const disk = JSON.parse(await readFile(join(f.dir, 'personal/routines.json'), 'utf8'))
  expect(disk.rows[0].attempt.requestId).toBe(f.start.mock.calls[0]?.[0]?.requestId)
  expect(JSON.stringify(disk)).not.toContain('private memory')
  await f.service.tick()
  expect(f.service.get(routine.id).state).toBe('running')
  f.settle('completed')
  await f.service.tick()
  expect(f.service.get(routine.id)).toMatchObject({
    state: 'ready',
    nextRunAt: '2026-10-27T09:00:00.000Z',
    lastRun: { state: 'completed' },
  })
  await f.service.tick()
  expect(f.start).toHaveBeenCalledOnce()
})

test('preserves original prompt whitespace as part of the durable request and actual execution', async () => {
  const f = await fixture(),
    prompt = '  original code indentation\n',
    r = await f.service.create({ ...config(), prompt }, actor)
  expect(r.prompt).toBe(prompt)
  await f.service.setEnabled(r.id, { requestId: randomUUID(), baseRevision: 1, enabled: true }, actor)
  f.time('2026-10-26T09:00:00Z')
  await f.service.tick()
  expect(f.start.mock.calls[0]?.[0].prompt).toBe(prompt)
})

test('recovers a saved create without revalidating changed live member availability', async () => {
  const f = await fixture(),
    input = config(),
    created = await f.service.create(input, actor),
    planning = vi.spyOn(f.options, 'plan').mockImplementation(() => {
      throw new AppError(409, 'unavailable', 'unavailable')
    })
  expect(await f.service.create(input, actor)).toEqual(created)
  expect(planning).not.toHaveBeenCalled()
})
test('cosmetic names preserve authorization while prompt or effective assistant revisions pause it', async () => {
  const f = await fixture(),
    routine = await f.service.create(config(), actor)
  await f.service.setEnabled(routine.id, { requestId: randomUUID(), baseRevision: 1, enabled: true }, actor)
  const renamed = await f.service.patch(routine.id, { requestId: randomUUID(), baseRevision: 2, name: 'Another name' }, actor)
  expect(renamed).toMatchObject({ enabled: true, state: 'ready' })
  f.basis('3'.repeat(64))
  await f.service.tick()
  expect(f.service.get(routine.id)).toMatchObject({ enabled: false, state: 'paused', pauseReason: 'definition-changed' })
  await f.service.setEnabled(routine.id, { requestId: randomUUID(), baseRevision: 3, enabled: true }, actor)
  const changed = await f.service.patch(routine.id, { requestId: randomUUID(), baseRevision: 4, prompt: 'different input' }, actor)
  expect(changed).toMatchObject({ enabled: false, state: 'paused', pauseReason: 'definition-changed' })
})
test('unknown creates remain unknown across restart and are never automatically retried', async () => {
  const start = vi.fn(async () => {
      throw new Error('lost acknowledgement')
    }),
    f = await fixture({ start }),
    routine = await f.service.create(config(), actor)
  await f.service.setEnabled(routine.id, { requestId: randomUUID(), baseRevision: 1, enabled: true }, actor)
  f.time('2026-10-26T09:00:00Z')
  await f.service.tick()
  expect(f.service.get(routine.id)).toMatchObject({ state: 'paused', pauseReason: 'unknown-outcome', lastRun: { state: 'unknown' } })
  await f.service.close()
  const reopened = await PersonalRoutines.open(f.options)
  services.push(reopened)
  await reopened.tick()
  expect(start).toHaveBeenCalledOnce()
})
test('revocation and audit failure fail closed; an inactive local grant cannot execute', async () => {
  const f = await fixture(),
    routine = await f.service.create(config(), actor)
  await expect(
    f.service.setEnabled(
      routine.id,
      { requestId: randomUUID(), baseRevision: 1, enabled: true },
      { ...actor, actor: { ...actor.actor, listener: 'lan-tls' } },
    ),
  ).rejects.toMatchObject({ status: 403 })
  await f.service.setEnabled(routine.id, { requestId: randomUUID(), baseRevision: 1, enabled: true }, actor)
  f.revoke()
  f.time('2026-10-26T09:00:00Z')
  await f.service.tick()
  expect(f.start).not.toHaveBeenCalled()
  expect(f.service.get(routine.id).pauseReason).toBe('owner-unavailable')
  const g = await fixture(),
    r = await g.service.create(config(), actor)
  await g.service.setEnabled(r.id, { requestId: randomUUID(), baseRevision: 1, enabled: true }, actor)
  g.audit.append.mockRejectedValue(new Error('audit unavailable'))
  g.time('2026-10-26T09:00:00Z')
  await g.service.tick()
  expect(g.start).not.toHaveBeenCalled()
  expect(g.service.get(r.id).pauseReason).toBe('audit-unavailable')
  await g.service.setEnabled(r.id, { requestId: randomUUID(), baseRevision: 2, enabled: false }, actor)
  expect(g.service.get(r.id).state).toBe('disabled')
})
test('missed downtime and runtime-only revisions pause rather than catch up after restart', async () => {
  for (const persistent of [true, false]) {
    const f = await fixture({ plan: () => ({ ...plan, persistent }) }),
      r = await f.service.create(config(), actor)
    await f.service.setEnabled(r.id, { requestId: randomUUID(), baseRevision: 1, enabled: true }, actor)
    await f.service.close()
    f.time('2026-10-26T10:00:00Z')
    const reopened = await PersonalRoutines.open(f.options)
    services.push(reopened)
    await reopened.tick()
    expect(reopened.get(r.id)).toMatchObject({ state: 'paused', pauseReason: persistent ? 'missed' : 'definition-changed' })
    expect(f.start).not.toHaveBeenCalled()
  }
})

test.each(['intent', 'accepted'] as const)('storage recovery of %s publishes once and never re-executes an unknown intent', async stage => {
  let failed = false,
    fault = true
  const f = await fixture({
      atomicFs: {
        open,
        async rename(from, to) {
          await rename(from, to)
          const data = JSON.parse(await readFile(to, 'utf8')) as { rows: Array<{ attempt?: { sessionId?: string } }> },
            attempt = data.rows.find(row => row.attempt)?.attempt
          if (fault && attempt && (stage === 'accepted' ? Boolean(attempt.sessionId) : !attempt.sessionId)) {
            failed = true
            throw new Error('after rename failed')
          }
        },
      },
    }),
    r = await f.service.create(config(), actor)
  await f.service.setEnabled(r.id, { requestId: randomUUID(), baseRevision: 1, enabled: true }, actor)
  f.time('2026-10-26T09:00:00Z')
  await f.service.tick()
  expect(failed).toBe(true)
  expect(() => f.service.get(r.id)).toThrow('尚未确认')
  fault = false
  await f.service.tick()
  await f.service.tick()
  expect(f.start).toHaveBeenCalledTimes(stage === 'accepted' ? 1 : 0)
  expect(f.service.get(r.id)).toMatchObject(stage === 'intent' ? { state: 'paused', pauseReason: 'unknown-outcome' } : { state: 'running' })
})

test('a disable during the execution queue is rechecked before any side effect', async () => {
  let release!: () => void, entered!: () => void
  const waiting = new Promise<void>(resolve => {
      release = resolve
    }),
    started = new Promise<void>(resolve => {
      entered = resolve
    }),
    effect = vi.fn(),
    f = await fixture({
      start: async input => {
        entered()
        await waiting
        input.authorize()
        effect()
        return { sessionId: 'late' }
      },
    }),
    r = await f.service.create(config(), actor)
  await f.service.setEnabled(r.id, { requestId: randomUUID(), baseRevision: 1, enabled: true }, actor)
  f.time('2026-10-26T09:00:00Z')
  const tick = f.service.tick()
  await started
  await f.service.setEnabled(r.id, { requestId: randomUUID(), baseRevision: 2, enabled: false }, actor)
  release()
  await tick
  expect(effect).not.toHaveBeenCalled()
})

test('unattended approval expiry waits for actual cancellation settlement', async () => {
  let cancelled = false,
    release!: () => void
  const wait = new Promise<void>(resolve => {
      release = resolve
    }),
    f = await fixture({
      cancel: async () => {
        cancelled = true
        await wait
        f.settle('cancelled')
      },
    }),
    r = await f.service.create(config(), actor)
  await f.service.setEnabled(r.id, { requestId: randomUUID(), baseRevision: 1, enabled: true }, actor)
  f.time('2026-10-26T09:00:00Z')
  await f.service.tick()
  f.waiting()
  f.time('2026-10-26T17:00:00Z')
  const tick = f.service.tick()
  await vi.waitFor(() => expect(cancelled).toBe(true))
  expect(f.service.get(r.id).lastRun?.state).toBe('running')
  release()
  await tick
  await f.service.tick()
  expect(f.service.get(r.id).lastRun?.state).toBe('cancelled')
})
test('uses the real Host and Standard runtime for due personal routines without Touch ID', async () => {
  let clock = Date.parse('2026-10-26T08:59:00Z')
  const host = await startTestHost({ now: () => clock })
  hosts.push(host)
  const owner = await host.enroll({ listener: 'unix' }),
    remote = await host.enroll(),
    assistant = await owner.json<{ id: string }>('personal/assistants', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: 'Daily assistant',
        role: 'Explicit routine role',
        harnessId: 'standard',
        mode: 'chat',
        pluginIds: [],
      },
    }),
    r = await owner.json<PersonalRoutine>('personal/routines', { method: 'POST', body: { ...config(), assistantId: assistant.id } })
  expect(
    (
      await remote.request(`personal/routines/${r.id}/enabled`, {
        method: 'POST',
        body: { requestId: randomUUID(), baseRevision: 1, enabled: true },
      })
    ).status,
  ).toBe(403)
  await owner.json(`personal/routines/${r.id}/enabled`, {
    method: 'POST',
    body: { requestId: randomUUID(), baseRevision: 1, enabled: true },
  })
  clock = Date.parse('2026-10-26T09:00:00Z')
  await expect.poll(async () => (await host.host.bridge.listTasks()).length).toBe(1)
  await expect.poll(async () => (await host.host.bridge.listTasks())[0]?.runOutcome).toBe('completed')
  await expect.poll(async () => (await owner.json<PersonalRoutine>(`personal/routines/${r.id}`)).lastRun?.state).toBe('completed')
  const done = await owner.json<PersonalRoutine>(`personal/routines/${r.id}`),
    detail = await owner.json<TaskDetail>(`tasks/${done.lastRun!.sessionId}`)
  expect(detail.summary.personal).toEqual({ assistantId: assistant.id })
  expect(detail.messages[0]?.text).toBe('Do actual work')
  expect(detail.summary.runOutcome).toBe('completed')
  expect(JSON.stringify(detail)).not.toContain('Explicit routine role')
  expect((await remote.request(`tasks/${detail.summary.id}`)).status).toBe(403)
})

test('a verified production bundle retains a future delegated grant across a real Host restart', async () => {
  await mkdir(resolve('test-results'), { recursive: true })
  const root = await mkdtemp(join(resolve('test-results'), 'latch-routine-build-'))
  roots.push(root)
  const outfile = join(root, 'host.mjs')
  await build({ ...(await hostBundleOptions()), entryPoints: [resolve('apps/host/src/server.ts')], outfile, logLevel: 'silent' })
  await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir')
  const module = (await import(pathToFileURL(outfile).href)) as typeof import('../src/server.ts')
  let clock = Date.parse('2026-10-26T08:59:00Z')
  const launch = (dataDir?: string, workspaceRoot?: string) =>
    startHostFixture(
      setup =>
        module.startServer({
          ...setup,
          uiDir: resolve('dist/web'),
          codeRoot: resolve('.'),
          port: 0,
          demo: true,
          rateLimits: 'relaxed',
          nativeNetwork: false,
          now: () => clock,
        }),
      { dataDir, workspaceRoot },
    )
  const first = await launch()
  hosts.push(first)
  const owner = await first.enroll({ listener: 'unix' }),
    assistant = await owner.json<{ id: string }>('personal/assistants', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: 'Stable grant',
        role: 'Daily private context',
        harnessId: 'standard',
        mode: 'chat',
        pluginIds: [],
      },
    }),
    r = await owner.json<PersonalRoutine>('personal/routines', { method: 'POST', body: { ...config(), assistantId: assistant.id } })
  await owner.json(`personal/routines/${r.id}/enabled`, {
    method: 'POST',
    body: { requestId: randomUUID(), baseRevision: 1, enabled: true },
  })
  const revisions = first.host.registry.revisionSnapshot(['standard-harness', 'demo'])
  expect(revisions.persistent).toBe(true)
  await first.host.close()
  const second = await launch(first.dataDir, first.workspaceRoot)
  hosts.push(second)
  expect(second.host.registry.revisionSnapshot(['standard-harness', 'demo'])).toEqual(revisions)
  const viewer = await second.enroll({ listener: 'unix' })
  expect(await viewer.json<PersonalRoutine>(`personal/routines/${r.id}`)).toMatchObject({ enabled: true, state: 'ready' })
  clock = Date.parse('2026-10-26T09:00:00Z')
  await expect.poll(async () => (await second.host.bridge.listTasks()).length).toBe(1)
  await expect.poll(async () => (await second.host.bridge.listTasks())[0]?.runOutcome).toBe('completed')
  await expect.poll(async () => (await viewer.json<PersonalRoutine>(`personal/routines/${r.id}`)).lastRun?.state).toBe('completed')
  expect(await second.host.bridge.listTasks()).toHaveLength(1)
}, 20000)
