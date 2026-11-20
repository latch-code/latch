// A Harness's subscription limits on the Host (docs/HARNESSES.md#额度): who is sent them, and that only numbers and a
// masked address leave it. Codex is the fake app-server: no network, no model.
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppSnapshot, HarnessQuota, ProviderSettings, TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, FAKE_CODEX_APP_SERVER, startFakeModels } from '@latch/testkit'
import { startTestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const HOUR = 3_600_000
const seconds = (ms: number) => Math.floor(ms / 1000)

/** Every file below `directory`, read whole. */
async function everything(directory: string): Promise<string> {
  let text = ''
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true }))
    if (entry.isFile()) text += await readFile(join(entry.parentPath, entry.name), 'utf8').catch(() => '')
  return text
}

it('sends the limits with the Harness to every device that is sent the Harness, and to no one else; nothing of them is stored, logged or sent raw', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-host-quota-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const now = Date.now()
  const limits = JSON.stringify({
    ordinaryUsageAllowed: true,
    rateLimits: {
      limitId: 'codex',
      limitName: 'A name of the vendor',
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: seconds(now + 2 * HOUR) },
      secondary: { usedPercent: 86, windowDurationMins: 10080, resetsAt: seconds(now + 143 * HOUR) },
      planType: 'plus',
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: null,
    rateLimitResetCredits: null,
    accountId: 'acct_private_0123456789',
    rateLimitUpsell: { headline: 'A banner of the vendor' },
  })
  await mkdir(join(root, 'bin'))
  const command = join(root, 'bin', 'codex')
  await writeFile(
    command,
    `#!/bin/sh\nexport FAKE_CODEX_RATE_LIMITS='${limits}'\nexec '${process.execPath}' '${FAKE_CODEX_APP_SERVER}' "$@"\n`,
  )
  await chmod(command, 0o755)
  const lines: string[] = []
  const t = await startTestHost({ demo: false, log: line => void lines.push(line) })
  cleanups.push(() => t.close())
  const desktop = await t.enroll({ listener: 'unix' })
  await desktop.confirmedJson('agents', { body: { id: 'codex', name: 'Codex', presetId: 'codex', command, args: [], env: {} } })
  await desktop.confirmedJson('agents', {
    body: { id: 'other', name: 'Other', command: process.execPath, args: [FAKE_ACP_AGENT], env: {} },
  })
  const viewer = await t.enroll({ scopes: ['view'] })
  const quotaOf = async (device: typeof desktop, id = 'codex'): Promise<HarnessQuota | undefined> =>
    (await device.json<AppSnapshot>('snapshot')).catalog?.harnesses.find(harness => harness.id === id)?.quota

  expect(await quotaOf(desktop)).toBeUndefined()
  await desktop.confirmedJson('tasks', { body: { prompt: 'echo hi', requestId: randomUUID(), harnessId: 'codex' } })
  await vi.waitFor(async () => expect(await quotaOf(desktop)).toBeDefined(), { timeout: 8_000, interval: 20 })

  const quota = (await quotaOf(desktop))!
  expect(quota).toEqual({
    windows: [
      { kind: 'five-hour', usedPercent: 12, resetsAt: new Date(seconds(now + 2 * HOUR) * 1000).toISOString() },
      { kind: 'weekly', usedPercent: 86, resetsAt: new Date(seconds(now + 143 * HOUR) * 1000).toISOString() },
    ],
    plan: 'plus',
    account: 'p•••@e•••.com',
    state: 'near',
    observedAt: expect.any(String),
  })
  // The scope that shows a device the Harness shows it this; a Harness that reports nothing has no such field at all.
  expect(await quotaOf(viewer)).toEqual(quota)
  expect((await viewer.json<AppSnapshot>('snapshot')).catalog?.harnesses.find(harness => harness.id === 'other')).not.toHaveProperty(
    'quota',
  )
  // No credential, no catalogue.
  const anonymous = await t.raw('loopback-tcp', 'api/snapshot')
  expect(anonymous.status).toBe(401)
  expect((await anonymous.text()).includes('usedPercent'), 'anonymous snapshot contains quota').toBe(false)

  // The snapshot can show the numbers before the asynchronous write keeps them for a restart.
  const persisted = await vi.waitFor(
    async () => {
      const text = await everything(t.dataDir)
      expect(text.includes('usedPercent'), 'quota usage is on disk').toBe(true)
      return text
    },
    { timeout: 8_000, interval: 20 },
  )
  const sent = JSON.stringify(await desktop.json<AppSnapshot>('snapshot'))
  const log = lines.join('\n')
  for (const raw of ['person@example.com', 'acct_private', 'A banner of the vendor', 'A name of the vendor']) {
    expect(sent.includes(raw), 'snapshot contains unmasked quota data').toBe(false)
    expect(persisted.includes(raw), 'disk contains unmasked quota data').toBe(false)
    expect(log.includes(raw), 'log contains unmasked quota data').toBe(false)
  }
  for (const word of ['usedPercent', 'p•••@e•••']) expect(log.includes(word), 'log contains quota data').toBe(false)
})

it('asks a Codex session on a model service nothing about the plan, logged in or not, and shows no limits for it', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-host-quota-route-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const log = join(root, 'agent.jsonl')
  const limits = JSON.stringify({ rateLimits: { limitId: 'codex', primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: null } } })
  await mkdir(join(root, 'bin'))
  const command = join(root, 'bin', 'codex')
  // No login at all: the session answers with the service's key, and a read of the plan's limits would have none to use.
  await writeFile(
    command,
    `#!/bin/sh\nexport FAKE_ACP_LOG='${log}' FAKE_CODEX_LOGGED_OUT=1 FAKE_CODEX_RATE_LIMITS='${limits}'\nexec '${process.execPath}' '${FAKE_CODEX_APP_SERVER}' "$@"\n`,
  )
  await chmod(command, 0o755)
  const models = await startFakeModels({ replies: [{ text: 'from the service' }] })
  cleanups.push(() => models.close())
  const t = await startTestHost({
    demo: false,
    commandDirectories: () => [join(root, 'bin')],
    loginPrograms: (name: string) => (name === 'codex' ? command : undefined),
    detectPreset: (preset: { id: string }) => (preset.id === 'codex' ? { found: true, path: command } : { found: false }),
  })
  cleanups.push(() => t.close())
  const owner = await t.enroll({ listener: 'unix' })
  const created = await owner.confirmed('providers', {
    method: 'POST',
    body: {
      name: 'A service',
      kind: 'openai-responses',
      baseURL: `${models.origin}/v1`,
      apiKey: 'sk-test-quota-route-0123456789abcdef',
      models: ['service-model'],
      defaultModel: 'service-model',
      confirmOrigin: true,
    },
  })
  expect(created.status).toBe(201)
  const provider = ((await created.json()) as { provider: ProviderSettings }).provider
  await owner.confirmedJson('agents', { body: { id: 'codex', name: 'Codex', presetId: 'codex', command: 'codex', args: [], env: {} } })
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { harnessId: 'codex', prompt: 'first', requestId: randomUUID(), model: { providerId: provider.id, model: 'service-model' } },
  })
  const detail = () => owner.json<TaskDetail>(`tasks/${sessionId}`)
  await vi.waitFor(async () => expect((await detail()).summary.status).toBe('idle'), { timeout: 10_000 })
  const settled = await detail()
  expect(settled.messages.filter(message => message.role === 'assistant').map(message => message.text)).toEqual(['from the service'])
  expect(settled.summary.modelRoute).toMatchObject({ providerId: provider.id })
  const events = (await readFile(log, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as { event: string; method?: string })
  expect(events.filter(entry => entry.event === 'rate-limits-read')).toHaveLength(0)
  expect(events.filter(entry => entry.event === 'recv' && entry.method === 'account/rateLimits/read')).toHaveLength(0)
  expect((await owner.json<AppSnapshot>('snapshot')).catalog?.harnesses.find(harness => harness.id === 'codex')).not.toHaveProperty('quota')
})

it('reads the limits when someone with the right to start a session looks, before any session, on the record and only once a minute', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-host-quota-look-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const log = join(root, 'agent.jsonl')
  const now = Date.now()
  const limits = JSON.stringify({
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: seconds(now + 2 * HOUR) },
      planType: 'pro',
    },
  })
  await mkdir(join(root, 'bin'))
  const command = join(root, 'bin', 'codex')
  await writeFile(
    command,
    `#!/bin/sh\nexport FAKE_ACP_LOG='${log}' FAKE_CODEX_RATE_LIMITS='${limits}'\nexec '${process.execPath}' '${FAKE_CODEX_APP_SERVER}' "$@"\n`,
  )
  await chmod(command, 0o755)
  const t = await startTestHost({ demo: false })
  cleanups.push(() => t.close())
  const owner = await t.enroll({ listener: 'unix' })
  await owner.confirmedJson('agents', { body: { id: 'codex', name: 'Codex', presetId: 'codex', command, args: [], env: {} } })
  await owner.confirmedJson('agents', { body: { id: 'other', name: 'Other', command: process.execPath, args: [FAKE_ACP_AGENT], env: {} } })
  const events = async (event: string) =>
    (await readFile(log, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { event: string; method?: string })
      .filter(entry => entry.event === event)
  const harness = async (id = 'codex') => (await owner.json<AppSnapshot>('snapshot')).catalog?.harnesses.find(item => item.id === id)
  const audited = vi.spyOn(t.host.security.audit, 'append')

  // A device that may only look sees the last values and starts nothing.
  const viewer = await t.enroll({ scopes: ['view'] })
  expect((await viewer.request('quota/refresh', { body: {} })).status).toBe(403)
  expect(await events('start')).toHaveLength(0)

  // Only Harnesses that can report are asked.
  expect(await owner.json('quota/refresh', { method: 'POST', body: {} })).toEqual({ asked: ['codex'] })
  await vi.waitFor(async () => expect((await harness())?.quota).toBeDefined(), { timeout: 8_000, interval: 20 })
  expect((await harness())?.quota).toMatchObject({ windows: [{ kind: 'five-hour', usedPercent: 7 }], plan: 'pro', state: 'ok' })
  await vi.waitFor(async () => expect(await events('exit')).toHaveLength(1), { timeout: 8_000, interval: 20 })
  expect(await events('rate-limits-read')).toHaveLength(1)
  expect((await events('recv')).filter(entry => entry.method === 'thread/start' || entry.method === 'turn/start')).toHaveLength(0)
  expect(audited.mock.calls.map(([event]) => event).filter(event => event.action === 'agent.quota.requested')).toEqual([
    expect.objectContaining({ target: 'codex', detail: { agentId: 'codex' } }),
  ])
  expect((await harness('other'))?.quotaRead).toBeUndefined()

  // Opening the view again at once asks nothing more.
  await owner.json('quota/refresh', { method: 'POST', body: { ids: ['codex'] } })
  await new Promise(resolve => setTimeout(resolve, 200))
  expect(await events('start')).toHaveLength(1)
})
