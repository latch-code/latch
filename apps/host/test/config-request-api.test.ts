import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { AppError } from '@latch/sdk'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import type { AppSnapshot, TaskDetail } from '@latch/protocol'
import { startTestHost, type TestHost } from './helpers/host.ts'

const hosts: TestHost[] = []
const gates: Array<() => void> = []
afterEach(async () => {
  for (const release of gates.splice(0)) release()
  vi.restoreAllMocks()
  for (const host of hosts.splice(0).toReversed()) await host.close()
})
async function fixture(extraEnv: Record<string, string> = {}) {
  const host = await startTestHost()
  hosts.push(host)
  const owner = await host.enroll({ listener: 'unix' }),
    other = await host.enroll({ listener: 'unix' }),
    log = join(host.workspaceRoot, 'acp-config-log')
  await owner.json('agents', {
    method: 'POST',
    body: {
      id: 'config-fixture',
      name: 'Config fixture',
      command: process.execPath,
      args: [FAKE_ACP_AGENT],
      presetId: 'codex',
      env: {
        FAKE_ACP_CONFIG: 'options',
        FAKE_ACP_MODES: 'read-only,workspace-write,danger-full-access',
        FAKE_ACP_INITIAL_MODE: 'read-only',
        FAKE_ACP_LOG: log,
        ...extraEnv,
      },
    },
  })
  const created = await owner.confirmed('tasks', {
    method: 'POST',
    body: { harnessId: 'config-fixture', prompt: 'echo ready', requestId: randomUUID() },
  })
  expect(created.status).toBe(201)
  const { sessionId } = (await created.json()) as { sessionId: string },
    path = `tasks/${sessionId}`
  await expect.poll(async () => (await owner.json<TaskDetail>(path)).summary.status).toBe('idle')
  const calls = async () =>
    (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { event: string; method?: string })
      .filter(entry => entry.event === 'recv' && entry.method === 'session/set_config_option').length
  const detail = () => owner.json<TaskDetail>(path)
  return { host, owner, other, path, sessionId, calls, detail }
}
const input = () => ({ requestId: randomUUID(), configId: 'model', value: 'large' })

test('real ACP changes are fenced, concurrent requests merge, another device sees no receipt, and GET is read-only', async () => {
  const f = await fixture(),
    request = input(),
    real = f.host.host.bridge.setConfig.bind(f.host.host.bridge)
  expect((await f.owner.json<AppSnapshot>('snapshot')).catalog?.features?.configReceipts).toBe(true)
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  gates.push(release)
  const setter = vi.spyOn(f.host.host.bridge, 'setConfig').mockImplementationOnce(async (...args) => {
    await gate
    await real(...args)
  })
  const first = f.owner.request(`${f.path}/config`, { method: 'POST', body: request })
  await expect.poll(() => setter.mock.calls.length).toBe(1)
  const duplicate = f.owner.request(`${f.path}/config`, { method: 'POST', body: request })
  expect(await f.owner.json(`${f.path}/config-requests/${request.requestId}`)).toEqual({ state: 'pending' })
  expect(await f.other.json(`${f.path}/config-requests/${request.requestId}`)).toEqual({ state: 'unknown' })
  expect((await f.owner.request(`${f.path}/config`, { method: 'POST', body: { ...request, value: 'small' } })).status).toBe(409)
  release()
  expect((await first).status).toBe(200)
  expect((await duplicate).status).toBe(200)
  expect(setter).toHaveBeenCalledTimes(1)
  expect(await f.calls()).toBe(1)
  expect(await f.owner.json(`${f.path}/config-requests/${request.requestId}`)).toEqual({ state: 'applied' })
  expect(await f.owner.json(`${f.path}/config`, { method: 'POST', body: request })).toEqual({ accepted: true })
  expect(await f.calls()).toBe(1)
  expect((await f.detail()).config?.find(row => row.id === 'model')?.currentValue).toBe('large')
  const disk = await readFile(join(f.host.dataDir, 'sessions-meta.json'), 'utf8')
  expect(disk).not.toContain('"large"')
  expect(disk).not.toContain('"configId"')
})

test('a real applied ACP change with a lost acknowledgement stays unknown and never replays the process request', async () => {
  const f = await fixture(),
    request = input(),
    real = f.host.host.bridge.setConfig.bind(f.host.host.bridge)
  vi.spyOn(f.host.host.bridge, 'setConfig').mockImplementationOnce(async (...args) => {
    await real(...args)
    throw new AppError(504, 'agent-timeout', 'fixture acknowledgement missing')
  })
  expect((await f.owner.request(`${f.path}/config`, { method: 'POST', body: request })).status).toBe(503)
  expect(await f.owner.json(`${f.path}/config-requests/${request.requestId}`)).toEqual({ state: 'unknown' })
  expect((await f.detail()).config?.find(row => row.id === 'model')?.currentValue).toBe('large')
  expect((await f.owner.request(`${f.path}/config`, { method: 'POST', body: request })).status).toBe(503)
  expect(await f.calls()).toBe(1)
})

test('distinguishes invalid local values from unknown dispatch and keeps legacy requests compatible', async () => {
  const f = await fixture(),
    request = { ...input(), value: 'unlisted' }
  expect((await f.owner.request(`${f.path}/config`, { method: 'POST', body: request })).status).toBe(400)
  expect(await f.owner.json(`${f.path}/config-requests/${request.requestId}`)).toEqual({ state: 'failed' })
  expect((await f.owner.request(`${f.path}/config`, { method: 'POST', body: request })).status).toBe(409)
  expect(await f.calls()).toBe(0)
  expect(await f.owner.json(`${f.path}/config`, { method: 'POST', body: { configId: 'model', value: 'large' } })).toEqual({
    accepted: true,
  })
  expect(await f.calls()).toBe(1)
})

test('does not turn a receipt into mode-widen authority and allows the original RID to continue through actual local confirmation', async () => {
  const f = await fixture(),
    request = { requestId: randomUUID(), configId: 'mode', value: 'workspace-write' }
  const first = await f.owner.request(`${f.path}/config`, { method: 'POST', body: request })
  expect(first.status).toBe(403)
  expect(await f.calls()).toBe(0)
  expect(await f.owner.json(`${f.path}/config-requests/${request.requestId}`)).toEqual({ state: 'unknown' })
  expect((await f.owner.request(`${f.path}/config`, { method: 'POST', body: { ...request, value: 'danger-full-access' } })).status).toBe(
    409,
  )
  expect((await f.owner.confirmed(`${f.path}/config`, { method: 'POST', body: request })).status).toBe(200)
  expect(f.host.presence.requests.at(-1)?.preview.action).toBe('task.mode-widen')
  expect(await f.owner.json(`${f.path}/config-requests/${request.requestId}`)).toEqual({ state: 'applied' })
  const confirmations = f.host.presence.requests.length
  expect((await f.owner.request(`${f.path}/config`, { method: 'POST', body: request })).status).toBe(200)
  expect(f.host.presence.requests).toHaveLength(confirmations)
  expect(await f.calls()).toBe(1)
})

test('rechecks revocation after the durable fence before forwarding to the actual ACP process', async () => {
  const f = await fixture(),
    request = input(),
    real = f.host.host.bridge.setConfig.bind(f.host.host.bridge)
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  gates.push(release)
  const setter = vi.spyOn(f.host.host.bridge, 'setConfig').mockImplementationOnce(async (...args) => {
    await gate
    await real(...args)
  })
  const pending = f.owner.request(`${f.path}/config`, { method: 'POST', body: request })
  await expect.poll(() => setter.mock.calls.length).toBe(1)
  await f.other.json(`devices/${f.owner.id}`, { method: 'PATCH', body: { scopes: ['view'] } })
  release()
  expect((await pending).status).toBe(503)
  expect(await f.calls()).toBe(0)
  expect((await f.owner.request(`${f.path}/config`, { method: 'POST', body: request })).status).toBe(403)
})

test('does not record applied when the actual ACP reports its old value after acknowledging the request', async () => {
  const f = await fixture({ FAKE_ACP_IGNORE_CONFIG: 'model' }),
    request = input()
  expect((await f.owner.request(`${f.path}/config`, { method: 'POST', body: request })).status).toBe(503)
  expect((await f.detail()).config?.find(row => row.id === 'model')?.currentValue).toBe('small')
  expect(await f.owner.json(`${f.path}/config-requests/${request.requestId}`)).toEqual({ state: 'unknown' })
  expect((await f.owner.request(`${f.path}/config`, { method: 'POST', body: request })).status).toBe(503)
  expect(await f.calls()).toBe(1)
})
