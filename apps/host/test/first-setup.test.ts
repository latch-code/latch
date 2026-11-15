import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { AppSnapshot, ProviderSettings } from '@latch/protocol'
import { AppError, type CreateTaskInput, type HarnessPlugin } from '@latch/sdk'
import { startFakeModels } from '@latch/testkit'
import { startTestHost } from './helpers/host.ts'

const directoryFault = vi.hoisted(() => ({ path: '', providerId: '', setupRequestId: '' }))
vi.mock('@latch/core/node-kit', async original => {
  const actual = await original<typeof import('@latch/core/node-kit')>()
  return {
    ...actual,
    async syncDirectory(directory: string) {
      if (directory === directoryFault.path) {
        const { providerId, setupRequestId } = directoryFault
        if (providerId || setupRequestId) {
          const file = providerId ? 'providers.json' : 'settings.json'
          const content = await readFile(join(directory, file), 'utf8').catch(() => '')
          if (content.includes(JSON.stringify(providerId || setupRequestId))) throw new Error('Fixture directory sync failed after rename')
        }
      }
      await actual.syncDirectory(directory)
    },
  }
})

it('holds renamed setup choices and completion until their settings directory entry is synchronized', async () => {
  const t = await startTestHost({ demo: false })
  onTestFinished(() => t.close())
  const desktop = await t.enroll({ listener: 'unix' })
  const models = await startFakeModels()
  onTestFinished(() => models.close())
  const service = { providerId: 'setup-durable', model: 'fake-model' }
  const add = await desktop.confirmed('providers', {
    method: 'POST',
    body: {
      id: service.providerId,
      name: 'Fixture model',
      kind: 'openai-compatible',
      requestId: randomUUID(),
      baseURL: `${models.origin}/v1`,
      models: [service.model],
      defaultModel: service.model,
      confirmOrigin: true,
    },
  })
  expect(add.status).toBe(201)
  directoryFault.path = t.dataDir
  const choice = { defaults: { model: service, mode: 'agent', pinned: true }, setupRequestId: randomUUID() }
  const choices = `first-setup/choices/${choice.setupRequestId}`
  const choose = (body: unknown) => desktop.request('preferences', { method: 'PUT', body })
  const done = { status: 'completed', requestId: randomUUID() }
  const complete = () => desktop.request('first-setup', { method: 'PUT', body: done })
  try {
    directoryFault.setupRequestId = choice.setupRequestId
    expect((await choose(choice)).status).toBeGreaterThanOrEqual(500)
    expect(JSON.parse(await readFile(join(t.dataDir, 'settings.json'), 'utf8'))).toMatchObject({
      setupChoices: [{ requestId: choice.setupRequestId }],
    })
    expect(await desktop.json(choices)).toEqual({ state: 'unknown' })
    expect((await choose(choice)).status).toBeGreaterThanOrEqual(500)
    expect((await choose({ ...choice, defaults: { mode: 'chat' } })).status).toBe(409)
    // A newer settings rename can settle the earlier receipt without replaying the old choice.
    directoryFault.setupRequestId = ''
    expect((await choose({ defaults: { mode: 'chat' } })).status).toBe(200)
    expect(await desktop.json(choices)).toMatchObject({ state: 'saved', defaults: { mode: 'chat' } })
    expect(await (await choose(choice)).json()).toMatchObject({ defaults: { mode: 'chat' } })

    directoryFault.setupRequestId = done.requestId
    expect((await complete()).status).toBeGreaterThanOrEqual(500)
    expect(JSON.parse(await readFile(join(t.dataDir, 'settings.json'), 'utf8'))).toMatchObject({ firstSetup: done })
    expect((await desktop.json<AppSnapshot>('snapshot')).firstSetup).toBe('pending')
    expect((await complete()).status).toBeGreaterThanOrEqual(500)
    expect((await desktop.request('first-setup', { method: 'PUT', body: { status: 'deferred', requestId: done.requestId } })).status).toBe(
      409,
    )
    directoryFault.setupRequestId = ''
    expect(await (await complete()).json()).toEqual({ status: 'completed' })
    expect((await desktop.json<AppSnapshot>('snapshot')).firstSetup).toBe('completed')
  } finally {
    directoryFault.path = ''
    directoryFault.setupRequestId = ''
  }
})

it('keeps a queued implicit start on the same Harness as its saved gateway', async () => {
  const entered = Promise.withResolvers<void>()
  const held = Promise.withResolvers<void>()
  const resolvingDefault = Promise.withResolvers<void>()
  const a = 'setup-engine-a'
  const b = 'setup-engine-b'
  let watching = false
  const starts: Array<{ harnessId: string; prompt: string; route: CreateTaskInput['modelRoute'] }> = []
  const plugin: HarnessPlugin = {
    id: 'setup-engine-fixture',
    name: 'Setup engine fixture',
    version: '1',
    description: 'fixture',
    activate(ctx) {
      for (const id of [a, b]) {
        ctx.registerHarness({
          id,
          name: id,
          version: '1',
          capabilities: { models: { owner: 'harness', wires: ['chat-completions'] } },
          status() {
            if (id === a && watching) resolvingDefault.resolve()
            return { status: 'ready' }
          },
          create: () => ({
            start: async () => {},
            close: async () => {},
            listTasks: async () => [],
            detail: async () => {
              throw new AppError(404, 'task-not-found', '找不到该任务')
            },
            async createTask(input) {
              starts.push({ harnessId: id, prompt: input.prompt, route: input.modelRoute })
              if (input.prompt === 'Hold') {
                entered.resolve()
                await held.promise
              }
              return { sessionId: randomUUID() }
            },
            prompt: async () => {},
            cancel: async () => {},
            approvals: () => [],
            decide: async () => false,
            subscribe: () => () => {},
            launchPreview: async ({ cwd }) => ({
              launchHash: 'a'.repeat(64),
              command: '/usr/bin/true',
              args: [],
              envNames: [],
              cwd,
              approvals: 'none',
              readback: 'none',
              verified: false,
            }),
          }),
        })
      }
    },
  }
  const t = await startTestHost({ plugins: [plugin], demo: false })
  onTestFinished(() => t.close())
  const desktop = await t.enroll({ listener: 'unix' })
  const models = await startFakeModels()
  onTestFinished(() => models.close())
  const gateway = { providerId: 'setup-route', model: 'fake-model' }
  const add = await desktop.confirmed('providers', {
    method: 'POST',
    body: {
      id: gateway.providerId,
      name: 'Fixture model',
      kind: 'openai-compatible',
      requestId: randomUUID(),
      baseURL: `${models.origin}/v1`,
      models: [gateway.model],
      defaultModel: gateway.model,
      confirmOrigin: true,
    },
  })
  expect(add.status).toBe(201)
  const choose = (defaults: Record<string, unknown>) => desktop.request('preferences', { method: 'PUT', body: { defaults } })
  expect((await choose({ harnessId: a, gateway })).status).toBe(200)
  const start = (prompt: string, choice: Record<string, unknown> = {}) =>
    desktop.request('tasks', { method: 'POST', body: { requestId: randomUUID(), prompt, mode: 'chat', ...choice } })
  const first = start('Hold', { harnessId: a, ownModel: true })
  let queued: ReturnType<typeof start> | undefined
  try {
    await Promise.race([
      entered.promise,
      first.then(async reply => {
        throw new Error(`The fixture driver did not receive the held start (${reply.status}).`)
      }),
    ])
    watching = true
    queued = start('Queued')
    await Promise.race([
      resolvingDefault.promise,
      queued.then(reply => {
        throw new Error(`The start did not wait in the project queue (${reply.status}).`)
      }),
    ])
    watching = false
    expect(starts.map(item => item.prompt)).toEqual(['Hold'])
    expect((await choose({ harnessId: b })).status).toBe(200)
  } finally {
    held.resolve()
  }
  expect((await first).status).toBe(201)
  const started = await queued!
  expect(started.status, await started.text()).toBe(201)
  expect(starts[1]).toMatchObject({ harnessId: a, prompt: 'Queued', route: gateway })
  expect((await start('Next')).status).toBe(201)
  expect(starts[2]).toEqual({ harnessId: b, prompt: 'Next', route: undefined })
  expect((await choose({ gateway })).status).toBe(400)
})

it('keeps accepted preparation receipts when their durable capacity is full', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'latch-setup-receipts-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const choicesFile = join(dir, 'settings.json')
  const providersFile = join(dir, 'providers.json')
  const prior = () => ({ deviceId: 'fixture-other', requestId: randomUUID(), inputHash: 'a'.repeat(64) })
  await writeFile(
    choicesFile,
    JSON.stringify({
      version: 1,
      firstSetup: { status: 'pending' },
      setupChoices: Array.from({ length: 127 }, prior),
    }),
    { mode: 0o600 },
  )
  await writeFile(
    providersFile,
    JSON.stringify({
      version: 1,
      providers: [],
      additions: Array.from({ length: 511 }, () => ({ ...prior(), providerId: 'previous-provider', recordHash: 'b'.repeat(64) })),
    }),
    { mode: 0o600 },
  )
  const t = await startTestHost({ dataDir: dir, demo: false })
  onTestFinished(() => t.close())
  const desktop = await t.enroll({ listener: 'unix' })
  const models = await startFakeModels()
  const other = await startFakeModels()
  onTestFinished(() => models.close())
  onTestFinished(() => other.close())
  const add = {
    id: 'setup-at-capacity',
    requestId: randomUUID(),
    name: 'Fixture service',
    kind: 'openai-compatible',
    baseURL: `${models.origin}/v1`,
    models: ['fake-model'],
    defaultModel: 'fake-model',
    confirmOrigin: true,
  }
  const choice = { defaults: { mode: 'agent' }, setupRequestId: randomUUID() }
  const choose = (body: unknown) => desktop.request('preferences', { method: 'PUT', body })
  expect((await choose(choice)).status).toBe(200)
  expect((await desktop.confirmed('providers', { method: 'POST', body: add })).status).toBe(201)
  const presence = t.presence.requests.length
  const atCapacity = await choose({ defaults: { mode: 'chat' }, setupRequestId: randomUUID() })
  expect(atCapacity.status).toBe(409)
  expect(await atCapacity.json()).toMatchObject({ error: 'setup-choice-capacity' })
  expect((await desktop.json<AppSnapshot>('snapshot')).catalog?.defaults.mode).toBe('agent')
  const refusedAdd = await desktop.request('providers', {
    method: 'POST',
    body: { ...add, id: 'not-added', requestId: randomUUID(), baseURL: `${other.origin}/v1` },
  })
  expect(refusedAdd.status).toBe(409)
  expect(await refusedAdd.json()).toMatchObject({ error: 'provider-addition-capacity' })
  expect(t.presence.requests).toHaveLength(presence)
  expect(await desktop.json('policy')).toMatchObject({ policy: { hostEgressAllow: [new URL(add.baseURL).host] } })

  expect((await choose({ defaults: { mode: 'chat' } })).status).toBe(200)
  expect(await desktop.json(`first-setup/choices/${choice.setupRequestId}`)).toMatchObject({ state: 'saved', defaults: { mode: 'chat' } })
  expect(await (await choose(choice)).json()).toMatchObject({ defaults: { mode: 'chat' } })
  expect(await desktop.json(`providers/additions/${add.requestId}`)).toMatchObject({ state: 'saved', provider: { id: add.id } })
  expect((await desktop.request('providers', { method: 'POST', body: add })).status).toBe(200)
  expect((await desktop.request(`providers/${add.id}`, { method: 'DELETE' })).status).toBe(200)
  expect((await desktop.request('providers', { method: 'POST', body: add })).status).toBe(409)
  expect((await desktop.json<AppSnapshot>('snapshot')).catalog?.providers).toEqual([])
  const { requestId: _previous, ...regular } = add
  expect((await desktop.confirmed('providers', { method: 'POST', body: { ...regular, id: 'regular-settings' } })).status).toBe(201)
})

it('keeps a fresh preparation local and requires real model choices before completion', async () => {
  const t = await startTestHost({ demo: false })
  onTestFinished(() => t.close())
  const desktop = await t.enroll({ listener: 'unix' })
  const browser = await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run', 'admin'] })
  expect((await desktop.json<AppSnapshot>('snapshot')).firstSetup).toBe('pending')
  expect((await browser.json<AppSnapshot>('snapshot')).firstSetup).toBeUndefined()
  const outcome = { status: 'completed', requestId: randomUUID() }
  const complete = () => desktop.request('first-setup', { method: 'PUT', body: outcome })
  expect((await browser.request('first-setup', { method: 'PUT', body: outcome })).status).toBe(403)
  const empty = await complete()
  expect(empty.status).toBe(409)
  expect(await empty.json()).toMatchObject({ error: 'first-setup-model-required' })

  const models = await startFakeModels()
  onTestFinished(() => models.close())
  const input = {
    id: 'setup-fake',
    requestId: randomUUID(),
    name: 'Fake',
    kind: 'openai-compatible',
    baseURL: `${models.origin}/v1`,
    models: ['fake-model'],
    defaultModel: 'fake-model',
    modelCapabilities: { 'fake-model': { thinking: ['low', 'high'] } },
    confirmOrigin: true,
  }
  const add = await desktop.confirmed('providers', { method: 'POST', body: input })
  expect(add.status).toBe(201)
  const { provider } = (await add.json()) as { provider: ProviderSettings }
  expect(await desktop.json(`providers/additions/${input.requestId}`)).toMatchObject({ state: 'saved', provider: { id: provider.id } })
  expect((await desktop.request('providers', { method: 'POST', body: input })).status).toBe(200)
  expect((await desktop.request('providers', { method: 'POST', body: { ...input, name: 'Different' } })).status).toBe(409)

  const choice = {
    setupRequestId: randomUUID(),
    defaults: { model: { providerId: provider.id, model: 'fake-model', effort: 'high' }, pinned: true },
  }
  expect(await desktop.json('preferences', { method: 'PUT', body: choice })).toMatchObject({ defaults: choice.defaults })
  expect(await desktop.json(`first-setup/choices/${choice.setupRequestId}`)).toMatchObject({ state: 'saved', defaults: choice.defaults })
  const invalid = { ...choice, setupRequestId: randomUUID(), defaults: { model: { ...choice.defaults.model, effort: 'invented' } } }
  expect((await desktop.request('preferences', { method: 'PUT', body: invalid })).status).toBe(400)
  expect((await desktop.request('preferences', { method: 'PUT', body: { ...choice, defaults: { pinned: false } } })).status).toBe(409)
  expect(await (await complete()).json()).toEqual({ status: 'completed' })
  expect(await (await complete()).json()).toEqual({ status: 'completed' })
  expect((await desktop.json<AppSnapshot>('snapshot')).firstSetup).toBe('completed')
  expect(JSON.parse(await readFile(join(t.dataDir, 'settings.json'), 'utf8'))).toMatchObject({
    defaults: choice.defaults,
    firstSetup: outcome,
  })

  expect((await desktop.request(`providers/${provider.id}`, { method: 'DELETE' })).status).toBe(200)
  expect((await desktop.request(`providers/additions/${input.requestId}`)).status).toBe(409)
  expect((await desktop.request('providers', { method: 'POST', body: input })).status).toBe(409)
})

it('resumes a partially configured Host, keeps a deliberate defer, and leaves an earlier installation alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'latch-first-setup-'))
  onTestFinished(() => rm(root, { force: true, recursive: true }))
  const dataDir = join(root, 'new')
  const workspaceRoot = join(root, 'workspace')
  const first = await startTestHost({ dataDir, workspaceRoot, demo: false })
  onTestFinished(() => first.close())
  const desktop = await first.enroll({ listener: 'unix' })
  await desktop.json('preferences', { method: 'PUT', body: { defaults: { mode: 'chat' } } })
  await first.close()

  const resumed = await startTestHost({ dataDir, workspaceRoot, demo: false })
  onTestFinished(() => resumed.close())
  const local = await resumed.enroll({ listener: 'unix' })
  expect((await local.json<AppSnapshot>('snapshot')).firstSetup).toBe('pending')
  const defer = { status: 'deferred', requestId: randomUUID() }
  expect(await local.json('first-setup', { method: 'PUT', body: defer })).toEqual({ status: 'deferred' })
  await resumed.close()
  const restarted = await startTestHost({ dataDir, workspaceRoot, demo: false })
  onTestFinished(() => restarted.close())
  expect((await (await restarted.enroll({ listener: 'unix' })).json<AppSnapshot>('snapshot')).firstSetup).toBe('deferred')

  const prior = await startTestHost({ dataDir: join(root, 'old'), workspaceRoot, demo: true })
  onTestFinished(() => prior.close())
  const oldDevice = await prior.enroll({ listener: 'unix' })
  await oldDevice.json('preferences', { method: 'PUT', body: { defaults: { mode: 'chat' } } })
  expect((await oldDevice.json<AppSnapshot>('snapshot')).firstSetup).toBeUndefined()
  await prior.close()
  const upgraded = await startTestHost({ dataDir: join(root, 'old'), workspaceRoot, demo: false })
  onTestFinished(() => upgraded.close())
  expect((await (await upgraded.enroll({ listener: 'unix' })).json<AppSnapshot>('snapshot')).firstSetup).toBe('existing')
})

it.each(['kept', 'tightened'] as const)('settles the same renamed provider only with its %s outbound policy', async policyState => {
  const t = await startTestHost({ demo: false })
  onTestFinished(() => t.close())
  const models = await startFakeModels()
  onTestFinished(() => models.close())
  const desktop = await t.enroll({ listener: 'unix' })
  const add = {
    id: 'setup-recover',
    requestId: randomUUID(),
    name: 'Fixture settings service',
    kind: 'openai-compatible',
    baseURL: `${models.origin}/v1`,
    defaultModel: 'fake-model',
    models: ['fake-model'],
    confirmOrigin: true,
  }
  const path = `providers/additions/${add.requestId}`
  const request = { method: 'POST', body: add }
  directoryFault.path = t.dataDir
  directoryFault.providerId = add.id
  let confirmations = 0
  try {
    const stopped = await desktop.confirmed('providers', request)
    expect(stopped.status).toBeGreaterThanOrEqual(500)
    expect(JSON.parse(await readFile(join(t.dataDir, 'providers.json'), 'utf8'))).toMatchObject({
      providers: [{ id: add.id }],
      additions: [{ providerId: add.id, requestId: add.requestId }],
    })
    expect(await desktop.json(path)).toEqual({ state: 'unknown' })
    expect((await desktop.request(path, { method: 'POST', body: {} })).status).toBe(503)
    expect((await desktop.json<AppSnapshot>('snapshot')).catalog?.providers).toEqual([])
    const { policy } = await desktop.json<{ policy: { confirmedAddresses: string[]; hostEgressAllow: string[] } }>('policy')
    expect(policy.confirmedAddresses).toHaveLength(1)
    expect(policy.hostEgressAllow).toEqual([new URL(add.baseURL).host])
    confirmations = t.presence.requests.length
  } finally {
    directoryFault.path = ''
    directoryFault.providerId = ''
  }
  if (policyState === 'tightened') {
    const target = new URL(add.baseURL).host
    expect((await desktop.request('policy', { method: 'PATCH', body: { hostEgressAllow: { remove: [target] } } })).status).toBe(200)
    expect((await desktop.request(path, { method: 'POST', body: {} })).status).toBe(503)
    expect((await desktop.request('providers', request)).status).toBe(503)
    expect(await desktop.json(path)).toEqual({ state: 'unknown' })
    expect(await desktop.json('policy')).toMatchObject({ policy: { hostEgressAllow: [] } })
    expect(t.presence.requests).toHaveLength(confirmations)
    expect((await desktop.json<AppSnapshot>('snapshot')).catalog?.providers).toEqual([])
    return
  }
  expect(await desktop.json(path, { method: 'POST', body: {} })).toMatchObject({ state: 'saved', provider: { id: add.id } })
  expect(await desktop.json(path)).toMatchObject({ state: 'saved', provider: { id: add.id } })
  expect((await desktop.request('providers', request)).status).toBe(200)
  expect(t.presence.requests).toHaveLength(confirmations)
  expect((await desktop.json<AppSnapshot>('snapshot')).catalog?.providers).toMatchObject([{ id: add.id, models: add.models }])
  expect(JSON.parse(await readFile(join(t.dataDir, 'providers.json'), 'utf8'))).toMatchObject({
    providers: [{ id: add.id }],
    additions: [{ providerId: add.id, requestId: add.requestId }],
  })
})
