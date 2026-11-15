import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import type { AppSnapshot, ProviderSettings } from '@latch/protocol'
import { startFakeModels } from '@latch/testkit'
import { startTestHost } from './helpers/host.ts'

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
