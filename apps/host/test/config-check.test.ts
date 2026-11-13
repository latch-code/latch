import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { createAcpAgentPlugin } from '@latch/harness-acp'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import type { TaskDetail } from '@latch/protocol'
import { startTestHost, type TestHost } from './helpers/host.ts'

const hosts: TestHost[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const host of hosts.splice(0).toReversed()) await host.close()
})

/** A session on an OpenCode-shaped fake agent whose config answers as `answer` says (FAKE_ACP_CONFIG_ANSWER). */
async function fixture(answer: string, extraEnv: Record<string, string> = {}) {
  const host = await startTestHost({
    agentPlugin: agent => createAcpAgentPlugin(agent, { log: () => {}, requireConfirmedCommand: true, configTimeoutMs: 400 }),
  })
  hosts.push(host)
  const owner = await host.enroll({ listener: 'unix' }),
    other = await host.enroll({ listener: 'unix' }),
    log = join(host.workspaceRoot, 'acp-config-log')
  await owner.confirmedJson('agents', {
    method: 'POST',
    body: {
      id: 'opencode-fixture',
      name: 'OpenCode fixture',
      command: process.execPath,
      args: [FAKE_ACP_AGENT],
      presetId: 'opencode',
      env: {
        FAKE_ACP_CONFIG: 'options',
        FAKE_ACP_SHAPE: 'opencode',
        FAKE_ACP_MODES: 'build,plan',
        FAKE_ACP_INITIAL_MODE: 'build',
        FAKE_ACP_CAPS: 'resume',
        FAKE_ACP_STATE: join(host.workspaceRoot, 'acp-state.json'),
        FAKE_ACP_CONFIG_ANSWER: answer,
        FAKE_ACP_LOG: log,
        ...extraEnv,
      },
    },
  })
  const created = await owner.confirmed('tasks', {
    method: 'POST',
    body: { harnessId: 'opencode-fixture', prompt: 'echo ready', requestId: randomUUID() },
  })
  expect(created.status).toBe(201)
  const { sessionId } = (await created.json()) as { sessionId: string },
    path = `tasks/${sessionId}`
  await expect.poll(async () => (await owner.json<TaskDetail>(path)).summary.status).toBe('idle')
  const events = async () =>
    (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { event: string; method?: string; pid: number })
  const calls = async () => (await events()).filter(entry => entry.event === 'recv' && entry.method === 'session/set_config_option').length
  const model = async () => (await owner.json<TaskDetail>(path)).config?.find(row => row.id === 'model')?.currentValue
  const check = (device: typeof owner, request: { requestId: string; configId: string; value: string }) =>
    device.request(`${path}/config-requests/${request.requestId}/check`, {
      method: 'POST',
      body: { configId: request.configId, value: request.value },
    })
  const audit = async () =>
    (await readFile(join(host.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { seq: number; action: string; detail: Record<string, unknown> })
  const send = (prompt: string) => owner.request(`${path}/prompt`, { method: 'POST', body: { prompt, requestId: randomUUID() } })
  return { host, owner, other, path, calls, events, model, check, audit, send }
}
const change = () => ({ requestId: randomUUID(), configId: 'model', value: 'opencode/beam-free' })

test('a slow answer within the limit applies, and the session shows the value the agent reported', async () => {
  const f = await fixture('slow:150'),
    request = change()
  expect((await f.owner.request(`${f.path}/config`, { method: 'POST', body: request })).status).toBe(200)
  expect(await f.owner.json(`${f.path}/config-requests/${request.requestId}`)).toEqual({ state: 'applied' })
  expect(await f.model()).toBe('opencode/beam-free')
})

test('no answer leaves the change unknown; 核对 reads the agent again and settles it as applied, never sending it twice', async () => {
  const f = await fixture('silent'),
    request = change()
  const sent = await f.owner.request(`${f.path}/config`, { method: 'POST', body: request })
  expect(sent.status).toBe(503)
  expect(((await sent.json()) as { error: string }).error).toBe('config-outcome-unknown')
  expect(await f.owner.json(`${f.path}/config-requests/${request.requestId}`)).toEqual({ state: 'unknown' })
  expect(await f.model()).toBe('opencode/big-pickle')
  // Another device cannot settle it, and the content must be the request's own.
  expect(await (await f.check(f.other, request)).json()).toEqual({ state: 'unknown' })
  expect((await f.check(f.owner, { ...request, value: 'opencode/big-pickle' })).status).toBe(409)
  const before = new Set((await f.events()).filter(entry => entry.event === 'start').map(entry => entry.pid))
  expect(await (await f.check(f.owner, request)).json()).toEqual({ state: 'applied' })
  expect(await f.owner.json(`${f.path}/config-requests/${request.requestId}`)).toEqual({ state: 'applied' })
  expect(await f.model()).toBe('opencode/beam-free')
  // The reading came from a new process, after the one the request went to had ended.
  const started = (await f.events()).filter(entry => entry.event === 'start' && !before.has(entry.pid))
  expect(started).toHaveLength(1)
  expect(await f.calls()).toBe(1)
  // The same request now answers from its receipt.
  expect((await f.owner.request(`${f.path}/config`, { method: 'POST', body: request })).status).toBe(200)
  expect(await f.calls()).toBe(1)
})

test('核对 settles as failed when the agent, idle and answering, reports another value; a new pick is a new request', async () => {
  const f = await fixture('silent-drop'),
    request = change()
  expect((await f.owner.request(`${f.path}/config`, { method: 'POST', body: request })).status).toBe(503)
  expect(await (await f.check(f.owner, request)).json()).toEqual({ state: 'failed' })
  expect(await f.model()).toBe('opencode/big-pickle')
  const retried = await f.owner.request(`${f.path}/config`, { method: 'POST', body: request })
  expect(retried.status).toBe(409)
  expect(((await retried.json()) as { error: string }).error).toBe('config-request-failed')
  expect(await f.calls()).toBe(1)
})

test('核对 does not read while a turn waits on the person, and leaves an unreadable agent unknown', async () => {
  const f = await fixture('silent'),
    request = change()
  expect((await f.owner.request(`${f.path}/config`, { method: 'POST', body: request })).status).toBe(503)
  // A turn that asks the person holds the session.
  expect((await f.send('permission')).status).toBeLessThan(300)
  await expect.poll(async () => (await f.owner.json<TaskDetail>(f.path)).summary.status).toBe('waiting-approval')
  const starts = (await f.events()).filter(entry => entry.event === 'start').length
  expect(await (await f.check(f.owner, request)).json()).toEqual({ state: 'unknown', reason: 'running' })
  // Nothing was stopped: the waiting turn keeps its process.
  expect((await f.events()).filter(entry => entry.event === 'start').length).toBe(starts)
  expect((await f.owner.json<TaskDetail>(f.path)).summary.status).toBe('waiting-approval')
  vi.spyOn(f.host.host.bridge, 'readConfig').mockResolvedValueOnce({ kind: 'unread' })
  expect(await (await f.check(f.owner, request)).json()).toEqual({ state: 'unknown', reason: 'unread' })
  expect(await f.calls()).toBe(1)
})

test('a turn sent while 核对 reads is refused, and the reading is not cut short', async () => {
  const f = await fixture('silent', { FAKE_ACP_RESUME_DELAY: '600' }),
    request = change()
  expect((await f.owner.request(`${f.path}/config`, { method: 'POST', body: request })).status).toBe(503)
  const checking = f.check(f.owner, request)
  await expect
    .poll(async () => (await f.events()).filter(entry => entry.event === 'recv' && entry.method === 'session/resume').length)
    .toBe(1)
  const refused = await f.send('echo during the check')
  expect(refused.status).toBe(409)
  expect(((await refused.json()) as { error: string }).error).toBe('config-check-running')
  expect(await (await checking).json()).toEqual({ state: 'applied' })
  expect(await f.model()).toBe('opencode/beam-free')
})

test('an error answer after the agent took the value stays unknown, and 核对 finds it applied', async () => {
  const f = await fixture('error-after-take'),
    request = change()
  const sent = await f.owner.request(`${f.path}/config`, { method: 'POST', body: request })
  expect(sent.status).toBe(503)
  expect(((await sent.json()) as { error: string }).error).toBe('config-outcome-unknown')
  expect(await f.owner.json(`${f.path}/config-requests/${request.requestId}`)).toEqual({ state: 'unknown' })
  expect(await (await f.check(f.owner, request)).json()).toEqual({ state: 'applied' })
  // The change's own entry is followed by the one that settles it.
  const records = await f.audit()
  const changed = records.find(record => record.action === 'task.config.changed')!
  expect(records.find(record => record.action === 'task.config.checked')).toMatchObject({
    detail: { outcome: 'applied', refSeq: changed.seq },
  })
})

test('核对 of a mode change only reads: it sends no mode back and keeps the mode the agent runs in', async () => {
  const f = await fixture('silent'),
    request = { requestId: randomUUID(), configId: 'mode', value: 'plan' }
  expect((await f.owner.request(`${f.path}/config`, { method: 'POST', body: request })).status).toBe(503)
  expect(await (await f.check(f.owner, request)).json()).toEqual({ state: 'applied' })
  expect(await f.calls()).toBe(1)
  expect((await f.owner.json<TaskDetail>(f.path)).config?.find(row => row.id === 'mode')?.currentValue).toBe('plan')
  // The next turn runs in it, without setting the old mode back.
  expect((await f.send('echo after')).status).toBeLessThan(300)
  await expect.poll(async () => (await f.owner.json<TaskDetail>(f.path)).summary.status).toBe('idle')
  expect((await f.owner.json<TaskDetail>(f.path)).config?.find(row => row.id === 'mode')?.currentValue).toBe('plan')
  expect(await f.calls()).toBe(1)
})

test('an agent without set_config_option refuses the change at once: failed, never unknown', async () => {
  const f = await fixture('unsupported'),
    request = change()
  const refused = await f.owner.request(`${f.path}/config`, { method: 'POST', body: request })
  expect(refused.status).toBe(501)
  expect(((await refused.json()) as { error: string }).error).toBe('not-supported')
  expect(await f.owner.json(`${f.path}/config-requests/${request.requestId}`)).toEqual({ state: 'failed' })
  expect(await f.model()).toBe('opencode/big-pickle')
})
