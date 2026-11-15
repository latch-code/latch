import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentRecord, AgentSettings, AppSnapshot, ProviderSettings, TaskDetail, WorkspaceInfo } from '@latch/protocol'
import { createAcpAgentPlugin } from '@latch/harness-acp'
import { FAKE_ACP_AGENT, startFakeModels } from '@latch/testkit'
import { startTestHost, type TestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {})
})

const KEY_OLD = 'sk-retired-service-0123456789abcdefghij'
const KEY_OK = 'sk-current-service-0123456789abcdefghi'
const OLD_ORIGIN = 'https://generativelanguage.googleapis.com:443'

it('opens a data directory that names a Gemini service and Gemini CLI, rewrites nothing, uses neither, and lets both be removed', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-retired-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const fake = await startFakeModels({ replies: [{ error: { status: 401, message: 'bad key' } }] })
  cleanups.push(() => fake.close())
  const dataDir = join(root, 'data')
  const options = {
    dataDir,
    workspaceRoot: join(root, 'workspace'),
    demo: false,
    agentPlugin: (agent: AgentRecord) => createAcpAgentPlugin(agent, { stopGraceMs: 100, cancelGraceMs: 500 }),
  }
  const agentLog = join(root, 'acp.log')
  let active: TestHost | undefined
  cleanups.push(async () => active?.close())

  // As an earlier Latch left it: a service, a project, a Harness definition and one finished session of it.
  const first = await startTestHost(options)
  active = first
  const before = await first.enroll({ listener: 'unix' })
  const created = await before.confirmed('providers', {
    method: 'POST',
    body: {
      name: 'Current',
      kind: 'openai-compatible',
      baseURL: `${fake.origin}/v1`,
      apiKey: KEY_OK,
      models: ['fake-model'],
      defaultModel: 'fake-model',
      confirmOrigin: true,
    },
  })
  expect(created.status).toBe(201)
  const current = ((await created.json()) as { provider: ProviderSettings }).provider
  const folder = join(root, 'project')
  await mkdir(folder)
  const project = ((await (await before.addFolders({ paths: [folder], name: 'Project' })).json()) as { workspace: WorkspaceInfo }).workspace
  const defined = await before.confirmed('agents', {
    method: 'POST',
    body: {
      id: 'gemini',
      name: 'Gemini CLI',
      command: process.execPath,
      args: [FAKE_ACP_AGENT],
      env: { FAKE_ACP_STATE: join(root, 'acp-state.json'), FAKE_ACP_LOG: agentLog },
    },
  })
  expect(defined.status).toBe(201)
  const started = await before.request('tasks', {
    method: 'POST',
    body: { prompt: 'echo kept', requestId: randomUUID(), mode: 'agent', harnessId: 'gemini' },
  })
  expect(started.status).toBe(201)
  const { sessionId } = (await started.json()) as { sessionId: string }
  await vi.waitFor(async () => expect((await before.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle'), {
    timeout: 15_000,
  })
  await first.close()
  active = undefined

  const providersFile = join(dataDir, 'providers.json')
  const settingsFile = join(dataDir, 'settings.json')
  const sessionsFile = join(dataDir, 'harnesses', 'gemini', 'acp.json')
  const providers = JSON.parse(await readFile(providersFile, 'utf8'))
  providers.providers[0].fallbacks = { 'fake-model': [{ providerId: 'old', model: 'g1' }] }
  providers.providers.push({
    id: 'old',
    name: 'Google Gemini',
    kind: 'gemini',
    presetId: 'gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: KEY_OLD,
    keyOrigin: OLD_ORIGIN,
    keyPath: '/v1beta',
    enabled: true,
    models: ['g1'],
    defaultModel: 'g1',
  })
  await writeFile(providersFile, JSON.stringify(providers), { mode: 0o600 })
  const settings = JSON.parse(await readFile(settingsFile, 'utf8'))
  settings.agents[0].presetId = 'gemini'
  settings.defaults.model = { providerId: 'old', model: 'g1' }
  settings.workspaces.find((item: { id: string }) => item.id === project.id).defaultModel = { providerId: 'old', model: 'g1' }
  await writeFile(settingsFile, JSON.stringify(settings), { mode: 0o600 })
  const sessions = JSON.parse(await readFile(sessionsFile, 'utf8'))
  sessions.tasks[sessionId].acp.route = { providerId: 'old', model: 'g1', wire: 'gemini', origin: OLD_ORIGIN }
  await writeFile(sessionsFile, JSON.stringify(sessions), { mode: 0o600 })
  const saved = { providers: await readFile(providersFile, 'utf8'), settings: await readFile(settingsFile, 'utf8') }
  const launched = (await readFile(agentLog, 'utf8')).length
  const requests = fake.requests.length

  const t = await startTestHost(options)
  active = t
  const desktop = await t.enroll({ listener: 'unix' })
  const said: string[] = []
  const refusal = async (response: Response) => {
    const text = await response.text()
    said.push(text)
    return { status: response.status, ...(JSON.parse(text) as { error?: string; message?: string }) }
  }

  // The service: listed to be removed, offered to no session, and neither changed nor asked anything.
  const listed = (await desktop.json<{ providers: ProviderSettings[] }>('providers')).providers
  expect(listed.find(item => item.id === 'old')).toMatchObject({ kind: 'gemini', name: 'Google Gemini', enabled: true })
  const { catalog, tasks } = await desktop.json<AppSnapshot>('snapshot')
  expect(catalog!.providers.map(item => item.id)).toEqual([current.id])
  expect(catalog!.unusableProviders).toEqual([{ id: 'old', name: 'Google Gemini', reason: 'unsupported' }])
  // A saved default that names it is dangling, as one that names a removed service is.
  expect(catalog!.defaults.model?.providerId).not.toBe('old')
  for (const body of [{ enabled: true }, { kind: 'openai-compatible' }, { apiKey: 'sk-another-key-0123456789abcdefghijkl' }])
    expect(await refusal(await desktop.request('providers/old', { method: 'PUT', body }))).toMatchObject({
      status: 409,
      error: 'provider-unsupported',
    })
  expect(await refusal(await desktop.request('providers/old/models', { method: 'POST' }))).toMatchObject({
    status: 409,
    error: 'provider-unsupported',
  })
  const onOld = await refusal(
    await desktop.request('tasks', {
      method: 'POST',
      body: { prompt: 'hi', requestId: randomUUID(), harnessId: 'standard', model: { providerId: 'old', model: 'g1' } },
    }),
  )
  expect(onOld).toMatchObject({ status: 409, error: 'provider-unsupported' })
  expect(onOld.message).toContain('不再支持')

  // The project's default and the fallback that name it are dangling: the session runs on the service it was given, and
  // that service's own failure is what the turn gets. Nothing else is tried, the demo model least of all.
  const run = await desktop.request('tasks', {
    method: 'POST',
    body: {
      prompt: 'hi',
      requestId: randomUUID(),
      harnessId: 'standard',
      workspaceId: project.id,
    },
  })
  expect(run.status).toBe(201)
  const runId = ((await run.json()) as { sessionId: string }).sessionId
  await vi.waitFor(async () => expect((await desktop.json<TaskDetail>(`tasks/${runId}`)).summary.status).toBe('failed'), {
    timeout: 15_000,
  })
  const failed = await desktop.json<TaskDetail>(`tasks/${runId}`)
  expect(failed.messages.filter(message => message.role === 'assistant')).toEqual([])
  expect(fake.requests.length).toBe(requests + 1)
  expect(fake.requests.at(-1)).toMatchObject({ model: 'fake-model', key: KEY_OK })

  // The Harness: its definition and its session stay; nothing starts its command again.
  const harness = catalog!.harnesses.find(item => item.id === 'gemini')!
  expect(harness).toMatchObject({ status: 'unavailable', statusMessage: 'Gemini CLI 不再支持，已有会话只能查看' })
  expect(harness.capabilities.display.mark).toBeUndefined()
  expect(harness.capabilities.models.wires).toEqual([])
  expect((await desktop.json<{ agents: AgentSettings[] }>('agents')).agents.map(agent => agent.id)).toEqual(['gemini'])
  expect(tasks.map(task => task.id)).toContain(sessionId)
  const kept = await desktop.json<TaskDetail>(`tasks/${sessionId}`)
  expect(kept.messages.map(message => message.role)).toEqual(expect.arrayContaining(['user', 'assistant']))
  const fresh = await refusal(
    await desktop.request('tasks', {
      method: 'POST',
      body: { prompt: 'echo again', requestId: randomUUID(), mode: 'agent', harnessId: 'gemini' },
    }),
  )
  expect(fresh.status).toBe(409)
  expect(fresh.message).toContain('不再支持')
  const more = await refusal(
    await desktop.request(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'echo more', requestId: randomUUID() } }),
  )
  expect(more.status).toBe(409)
  expect(more.message).toContain('不再支持')
  expect((await desktop.json<TaskDetail>(`tasks/${sessionId}`)).messages).toHaveLength(kept.messages.length)
  expect((await readFile(agentLog, 'utf8')).length).toBe(launched)

  // Reading and refusing wrote nothing: both files are as they were saved, the retired entries included.
  expect(await readFile(providersFile, 'utf8')).toBe(saved.providers)
  expect(await readFile(settingsFile, 'utf8')).toBe(saved.settings)
  const audit = join(dataDir, 'audit', 'audit.jsonl')
  for (const text of [...said, await readFile(audit, 'utf8')]) {
    expect(text).not.toContain(KEY_OLD)
    expect(text).not.toContain(KEY_OK)
  }

  // Removing them is the person's to do: the session and its records go only when asked, the service with its key.
  expect((await desktop.request(`tasks/${sessionId}`, { method: 'DELETE' })).status).toBe(200)
  expect((await readFile(audit, 'utf8')).split('\n').some(line => line.includes(sessionId) && line.includes('task.l3.started'))).toBe(true)
  expect((await desktop.confirmed('agents/gemini', { method: 'DELETE' })).status).toBe(200)
  expect((await desktop.request('providers/old', { method: 'DELETE' })).status).toBe(200)
  const after = await readFile(providersFile, 'utf8')
  expect(after).not.toContain(KEY_OLD)
  expect(JSON.parse(after).providers).toMatchObject([{ id: current.id }])
  expect(JSON.parse(after).providers[0]).not.toHaveProperty('fallbacks')
  expect((await desktop.json<AppSnapshot>('snapshot')).catalog!.unusableProviders).toEqual([])
  await expect(stat(sessionsFile)).resolves.toBeDefined()
  expect((await readFile(agentLog, 'utf8')).length).toBe(launched)
})
