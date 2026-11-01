import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppSnapshot } from '@latch/protocol'
import type { HarnessHostOptions, HarnessPlugin, Bridge } from '@latch/sdk'
import { createRuntime } from '@latch/core'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import { type TestDevice, createTestPresence } from '@latch/testkit'
import { startServer } from '../src/server.ts'
import { startTestHost, type TestHost, type TestHostOptions } from './helpers/host.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function directory() {
  const dataDir = await mkdtemp(join(tmpdir(), 'lt-harness-'))
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
  return dataDir
}

/** Raw startServer options for the lifecycle cases that never serve a request. */
async function options() {
  const root = await directory()
  return {
    dataDir: join(root, 'data'),
    workspaceRoot: join(root, 'workspace'),
    uiDir: resolve('dist/web'),
    port: 0,
    demo: true,
    runtimeParent: root,
    presence: createTestPresence(),
  }
}

async function testHost(input: TestHostOptions = {}): Promise<TestHost> {
  const host = await startTestHost(input)
  cleanups.push(() => host.close())
  return host
}

/** An admin browser on loopback, plus the local desktop that may start full-access (L3) sessions. */
async function authenticated(t: TestHost): Promise<{ admin: TestDevice; desktop: TestDevice; snapshot: () => Promise<AppSnapshot> }> {
  const admin = await t.enroll({ scopes: ['view', 'run', 'approve:standard', 'admin'] })
  const desktop = await t.enroll({ listener: 'unix' })
  return { admin, desktop, snapshot: () => admin.json<AppSnapshot>('snapshot') }
}

it('exposes the selected custom provider readiness without requiring the built-in provider configuration', async () => {
  const provider: HarnessPlugin = {
    id: 'custom-model',
    name: 'Custom model',
    version: '1',
    description: 'Independent provider fixture',
    activate(ctx) {
      ctx.registerProvider({
        id: 'custom-model',
        name: 'Custom model',
        model: 'fixture',
        async *stream() {
          yield { type: 'text', text: 'Custom provider answered' }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  const t = await testHost({ demo: false, providerId: 'custom-model', plugins: [provider] })
  const { admin, snapshot } = await authenticated(t)
  expect(await admin.json('provider')).toMatchObject({ configured: false })
  expect((await snapshot()).execution).toMatchObject({ ready: true, providerId: 'custom-model', modelConfigurationRequired: false })
  const { sessionId } = await admin.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { prompt: 'Hello', mode: 'chat', requestId: crypto.randomUUID() },
  })
  await expect.poll(async () => (await t.host.bridge.detail(sessionId)).summary.status).toBe('idle')
  expect((await t.host.bridge.detail(sessionId)).messages.some(message => message.text === 'Custom provider answered')).toBe(true)
  for (const enabled of [false, true]) {
    expect((await admin.request('plugins/custom-model', { method: 'POST', body: { enabled } })).status).toBe(200)
    expect((await snapshot()).execution).toMatchObject({ ready: enabled, providerId: 'custom-model', modelConfigurationRequired: false })
  }
})

it('reports missing built-in model setup and becomes ready after configuration is saved on the desktop', async () => {
  const t = await testHost({ demo: false })
  const { admin, desktop, snapshot } = await authenticated(t)
  expect((await snapshot()).execution).toMatchObject({ ready: false, providerId: 'openai-compatible', modelConfigurationRequired: true })
  const legacy = { baseURL: 'http://127.0.0.1:9/v1', model: 'configured', apiKey: '' }
  expect(await (await admin.request('provider', { method: 'PUT', body: { ...legacy, apiKey: 'k' } })).json()).toMatchObject({
    error: 'scope-required',
    required: 'secrets',
  })
  // Any admin device may save it; its address is used only once the desktop has confirmed it.
  expect((await admin.request('provider', { method: 'PUT', body: legacy })).status).toBe(200)
  expect((await snapshot()).execution).toMatchObject({ ready: false, providerId: 'openai-compatible', modelConfigurationRequired: false })
  expect((await desktop.confirmed('provider-origins', { method: 'POST', body: { baseURL: legacy.baseURL } })).status).toBe(200)
  expect((await snapshot()).execution).toMatchObject({ ready: true, providerId: 'openai-compatible', modelConfigurationRequired: false })
  expect((await admin.request('plugins/openai-compatible', { method: 'POST', body: { enabled: false } })).status).toBe(200)
  expect((await snapshot()).execution).toMatchObject({ ready: false, modelConfigurationRequired: false })
})

it('allows a complete external harness to accept tasks without any model provider, started locally as L3', async () => {
  const createTask = vi.fn<Bridge['createTask']>(async () => ({ sessionId: 'external-task' }))
  const bridge: Bridge = {
    start: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    listTasks: async () => [],
    detail: async () => {
      throw new Error('No projection required by this fixture')
    },
    createTask,
    prompt: async () => {},
    cancel: async () => {},
    approvals: () => [],
    decide: async () => false,
    subscribe: () => () => {},
  }
  const plugin: HarnessPlugin = {
    id: 'independent',
    name: 'Independent backend',
    version: '1',
    description: 'Uses no application provider',
    activate(ctx) {
      ctx.registerHarness({ id: 'independent', name: 'Independent backend', version: '1', create: () => bridge })
    },
  }
  const t = await testHost({ demo: false, harnessId: 'independent', plugins: [plugin] })
  const { admin, desktop, snapshot } = await authenticated(t)
  expect(await admin.json('provider')).toMatchObject({ configured: false })
  expect((await snapshot()).execution).toEqual({ ready: true })
  expect((await snapshot()).catalog?.harnesses.find(harness => harness.id === 'independent')).toMatchObject({
    level: 'L3',
    capabilities: { permission: { enforcement: 'none' }, display: { mark: 'plugin' } },
  })
  const input = { prompt: 'Run on independent backend', mode: 'agent', requestId: crypto.randomUUID() }
  const response = await admin.request('tasks', { method: 'POST', body: input })
  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({ sessionId: 'external-task' })
  const launchHash = sha256Hex(canonicalJson({ harnessId: 'independent', pluginId: 'independent', version: '1' }))
  expect(createTask).toHaveBeenCalledExactlyOnceWith({ ...input, expectedLaunchHash: launchHash })
})

it('selects a full Harness driver through its Cordis plugin', async () => {
  const create = vi.fn((hostOptions: HarnessHostOptions) => createRuntime({ ...hostOptions, maxSteps: 2 }))
  const plugin: HarnessPlugin = {
    id: 'custom-harness-plugin',
    name: 'Custom Harness',
    version: '1',
    description: 'test extension',
    activate(ctx) {
      // Its claim changes nothing: no classifier below, and the session stays L3.
      ctx.registerHarness({
        id: 'custom',
        name: 'Custom engine',
        version: '1',
        capabilities: { permission: { enforcement: 'latch' } },
        create,
      })
    },
  }
  const host = await startServer({ ...(await options()), harnessId: 'custom', plugins: [plugin] })
  try {
    expect(create).toHaveBeenCalledOnce()
    expect(create.mock.calls[0]![0].dataDir).toContain(join('harnesses', 'custom'))
    expect(create.mock.calls[0]![0].tmpRoot).toBe(join(host.runtimeDir, 'tmp'))
    expect(create.mock.calls[0]![0].classifyToolCall).toBeUndefined()
    expect(host.bridge.levelOf('custom')).toBe('L3')
    const { sessionId } = await host.bridge.createTask({ prompt: 'hello', requestId: crypto.randomUUID(), mode: 'chat' })
    await expect.poll(async () => (await host.bridge.detail(sessionId)).summary.status).toBe('idle')
    expect((await host.bridge.detail(sessionId)).summary.mode).toBe('chat')
    await expect(host.registry.disable('custom-harness-plugin')).rejects.toMatchObject({ code: 'plugin-in-use' })
  } finally {
    await host.close()
  }
})

it('releases plugin resources when an unknown harness is selected', async () => {
  const dispose = vi.fn()
  const plugin: HarnessPlugin = {
    id: 'resource',
    name: 'Resource',
    version: '1',
    description: 'fixture',
    activate(ctx) {
      ctx.onDispose(dispose)
    },
  }
  await expect(startServer({ ...(await options()), harnessId: 'missing', plugins: [plugin] })).rejects.toThrow()
  expect(dispose).toHaveBeenCalledOnce()
})

it('refuses to start on an occupied loopback port and releases the runtime lock', async () => {
  const occupied = createServer()
  await new Promise<void>(done => occupied.listen(0, '127.0.0.1', done))
  const address = occupied.address()
  if (!address || typeof address === 'string') throw new Error('No listening port')
  const config = await options()
  try {
    await expect(startServer({ ...config, port: address.port })).rejects.toMatchObject({
      code: 'port-in-use',
      message: `端口 ${address.port} 已被占用（127.0.0.1 或 ::1），已拒绝启动`,
    })
  } finally {
    await new Promise<void>(done => occupied.close(() => done()))
  }
  const restarted = await startServer(config)
  await restarted.close()
})

it('closes every listener even when an extension cleanup fails', async () => {
  const plugin: HarnessPlugin = {
    id: 'broken-dispose',
    name: 'Fixture',
    version: '1',
    description: 'fixture',
    activate(ctx) {
      ctx.onDispose(() => {
        throw new Error('cleanup failed')
      })
    },
  }
  const config = await options()
  const host = await startServer({ ...config, plugins: [plugin] })
  await expect(host.close()).rejects.toThrow('shutdown')
  await expect(fetch(`http://127.0.0.1:${host.loopbackPort}/link/api/health`)).rejects.toThrow()
  const { access } = await import('node:fs/promises')
  await expect(access(host.socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  const restarted = await startServer(config)
  await restarted.close()
})

function externalHarness(id: string, start: () => Promise<void> = async () => {}) {
  const createTask = vi.fn<Bridge['createTask']>(async () => ({ sessionId: `${id}-session` }))
  const close = vi.fn(async () => {})
  const plugin: HarnessPlugin = {
    id: `${id}-plugin`,
    name: `${id} plugin`,
    version: '1',
    description: 'fixture',
    activate(ctx) {
      ctx.registerHarness({
        id,
        name: `${id} engine`,
        version: '1',
        capabilities: { modes: ['agent'] },
        create: () => ({
          start,
          close,
          listTasks: async () => [],
          createTask,
          detail: async () => {
            throw new Error('No projection required by this fixture')
          },
          prompt: async () => {},
          cancel: async () => {},
          approvals: () => [],
          decide: async () => false,
          subscribe: () => () => {},
        }),
      })
    },
  }
  return { plugin, createTask, close }
}

it('lists every mounted harness in the catalog and routes a session to the one the client chooses', async () => {
  const outside = externalHarness('outside')
  const t = await testHost({ plugins: [outside.plugin] })
  const { admin, desktop, snapshot } = await authenticated(t)
  const current = await snapshot()
  expect(current.harness).toEqual({ id: 'standard', name: 'Latch 内置' })
  expect(current.catalog?.harnesses).toEqual([
    expect.objectContaining({
      id: 'standard',
      status: 'ready',
      modes: ['chat', 'agent'],
      level: 'L1',
      capabilities: expect.objectContaining({
        models: expect.objectContaining({ owner: 'latch' }),
        display: { label: 'Latch 内置', mark: 'latch' },
      }),
    }),
    expect.objectContaining({
      id: 'outside',
      status: 'ready',
      modes: ['agent'],
      level: 'L3',
      capabilities: expect.objectContaining({
        models: expect.objectContaining({ owner: 'harness' }),
        display: expect.objectContaining({ mark: 'plugin' }),
      }),
    }),
  ])
  expect(current.catalog?.defaults).toEqual({
    harnessId: 'standard',
    mode: 'agent',
    workspaceId: 'default',
    model: { providerId: 'demo', model: 'demo' },
  })
  expect(current.catalog?.providers).toEqual([
    { id: 'demo', name: expect.any(String), kind: 'demo', models: ['demo'], defaultModel: 'demo' },
  ])
  const input = { prompt: 'Run outside', mode: 'agent', requestId: crypto.randomUUID() }
  const response = await desktop.confirmed('tasks', { method: 'POST', body: { ...input, harnessId: 'outside' } })
  expect(response.status).toBe(201)
  expect(outside.createTask).toHaveBeenCalledExactlyOnceWith({ ...input, expectedLaunchHash: expect.stringMatching(/^[0-9a-f]{64}$/) })
  const missing = await admin.request('tasks', { method: 'POST', body: { ...input, requestId: crypto.randomUUID(), harnessId: 'nowhere' } })
  expect(await missing.json()).toMatchObject({ error: 'harness-unavailable' })
})

it('keeps serving when an optional harness fails to start and lists it as unavailable', async () => {
  const broken = externalHarness('broken', async () => {
    throw new Error('agent binary missing')
  })
  const t = await testHost({ plugins: [broken.plugin] })
  const { desktop, snapshot } = await authenticated(t)
  expect((await snapshot()).catalog?.harnesses.find(harness => harness.id === 'broken')).toMatchObject({
    status: 'unavailable',
    statusMessage: expect.stringContaining('agent binary missing'),
  })
  expect(broken.close).toHaveBeenCalledOnce()
  const response = await desktop.request('tasks', {
    method: 'POST',
    body: { prompt: 'x', mode: 'agent', requestId: crypto.randomUUID(), harnessId: 'broken' },
  })
  expect(await response.json()).toMatchObject({ error: 'harness-unavailable' })
  expect(broken.createTask).not.toHaveBeenCalled()
  await expect(t.host.registry.disable('broken-plugin')).resolves.toBeUndefined()
})

it('detaches a harness plugin when it is switched off, remembers that, and remounts it when switched on', async () => {
  const root = await directory()
  const dataDir = join(root, 'data')
  const outside = externalHarness('outside')
  const first = await testHost({ dataDir, plugins: [outside.plugin] })
  {
    const { admin, snapshot } = await authenticated(first)
    expect((await admin.request('plugins/outside-plugin', { method: 'POST', body: { enabled: false } })).status).toBe(200)
    expect(outside.close).toHaveBeenCalledOnce()
    expect((await snapshot()).catalog?.harnesses.map(harness => harness.id)).toEqual(['standard'])
  }
  await first.close()
  const second = await testHost({ dataDir, plugins: [outside.plugin] })
  const { admin, snapshot } = await authenticated(second)
  expect((await snapshot()).catalog?.harnesses.map(harness => harness.id)).toEqual(['standard'])
  expect((await admin.request('plugins/outside-plugin', { method: 'POST', body: { enabled: true } })).status).toBe(200)
  expect((await snapshot()).catalog?.harnesses.map(harness => harness.id)).toEqual(['standard', 'outside'])
})

it('refuses to switch off the harness chosen on the command line', async () => {
  const outside = externalHarness('outside')
  const t = await testHost({ harnessId: 'outside', plugins: [outside.plugin] })
  const { admin, snapshot } = await authenticated(t)
  expect((await snapshot()).harness).toEqual({ id: 'outside', name: 'outside engine' })
  const response = await admin.request('plugins/outside-plugin', { method: 'POST', body: { enabled: false } })
  expect(await response.json()).toMatchObject({ error: 'harness-locked' })
  expect(outside.close).not.toHaveBeenCalled()
})
