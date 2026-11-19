import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppSnapshot, TaskDetail } from '@latch/protocol'
import type { HarnessPlugin, ModelProvider } from '@latch/sdk'
import type { TestDevice } from '@latch/testkit'
import { startTestHost, type TestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A model that writes one file through the built-in tool, then says done. */
function writer(args: Record<string, unknown>): HarnessPlugin {
  const provider: ModelProvider = {
    id: 'scripted',
    name: 'Scripted',
    model: 'scripted',
    async *stream({ messages }) {
      if (messages.at(-1)?.role === 'tool') {
        yield { type: 'text', text: 'done' }
        yield { type: 'finish', reason: 'stop' }
        return
      }
      yield { type: 'tool-call', call: { id: `call-${randomUUID()}`, name: 'write_file', arguments: args } }
      yield { type: 'finish', reason: 'tool-calls' }
    },
  }
  return { id: 'scripted', name: 'Scripted', version: '1', description: 'fixture', activate: ctx => ctx.registerProvider(provider) }
}

async function host(args: Record<string, unknown> = { path: 'notes.md', content: 'hello\n' }): Promise<TestHost> {
  const t = await startTestHost({ demo: false, providerId: 'scripted', plugins: [writer(args)] })
  cleanups.push(() => t.close())
  return t
}

async function audit(t: TestHost) {
  return (await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(
      line =>
        JSON.parse(line) as { seq: number; action: string; actor: { deviceId?: string }; target?: string; detail: Record<string, unknown> },
    )
}

async function status(t: TestHost, sessionId: string, wanted: string) {
  await expect.poll(async () => (await t.host.bridge.detail(sessionId)).summary.status, { timeout: 10_000 }).toBe(wanted)
}

async function start(device: TestDevice, extra: Record<string, unknown> = {}) {
  return device.confirmed('tasks', { method: 'POST', body: { prompt: 'write notes', requestId: randomUUID(), mode: 'agent', ...extra } })
}

async function started(t: TestHost, device: TestDevice, extra: Record<string, unknown> = {}) {
  const response = await start(device, extra)
  const result = (await response.json()) as { sessionId: string }
  expect(response.status, JSON.stringify(result)).toBe(201)
  return result.sessionId
}

/** A session that wrote once at 先问你 and is idle again: the approval it asked for, rejected. */
async function idle(t: TestHost, device: TestDevice) {
  const sessionId = await started(t, device)
  await status(t, sessionId, 'waiting-approval')
  const [approval] = t.host.bridge.approvals().filter(item => item.sessionId === sessionId)
  await t.host.bridge.decide(approval!.id, 'reject')
  await status(t, sessionId, 'idle')
  return sessionId
}

const setMode = (device: TestDevice, sessionId: string, value: string) =>
  device.request(`tasks/${sessionId}/config`, { method: 'POST', body: { configId: 'mode', value } })

describe('Latch 内置 levels through the Host', () => {
  it('lists its levels before any session, and each session’s level in its detail', async () => {
    const t = await host()
    const device = await t.enroll()
    const { catalog } = await device.json<AppSnapshot>('snapshot')
    expect(catalog!.harnesses.find(item => item.id === 'standard')?.permission).toMatchObject({
      modes: ['plan', 'ask', 'rule', 'model', 'never'],
      startMode: 'ask',
    })
    const sessionId = await idle(t, device)
    const detail = await device.json<TaskDetail>(`tasks/${sessionId}`)
    expect(detail.permission).toMatchObject({ level: 'L1', enforcer: 'LATCH', expectedMode: 'ask', defaultMode: 'ask' })
    expect(detail.config?.[0]).toMatchObject({ id: 'mode', category: 'mode', currentValue: 'ask' })
  })

  it('widens only for a device holding the approvals the level answers, on record like any widening', async () => {
    const t = await host()
    const owner = await t.enroll({ scopes: ['view', 'run', 'approve:standard', 'approve:elevated'] })
    const standard = await t.enroll({ scopes: ['view', 'run', 'approve:standard'] })
    const runner = await t.enroll({ scopes: ['view', 'run'] })
    const sessionId = await idle(t, owner)
    expect(await (await setMode(runner, sessionId, 'rule')).json()).toMatchObject({ error: 'scope-required', required: 'approve:standard' })
    expect(await (await setMode(standard, sessionId, 'never')).json()).toMatchObject({
      error: 'scope-required',
      required: 'approve:elevated',
    })
    expect(await (await setMode(standard, sessionId, 'model')).json()).toMatchObject({
      error: 'scope-required',
      required: 'approve:elevated',
    })
    expect((await t.host.bridge.detail(sessionId)).permission?.expectedMode).toBe('ask')
    expect(await (await setMode(standard, sessionId, 'rule')).json()).toEqual({ accepted: true })
    const records = await audit(t)
    expect(records.filter(record => record.action === 'task.mode.widened')).toEqual([
      expect.objectContaining({
        actor: expect.objectContaining({ deviceId: standard.id }),
        target: sessionId,
        detail: expect.objectContaining({ sessionId }),
      }),
    ])
    // Narrowing needs only `run`, and is not a widening.
    expect(await (await setMode(runner, sessionId, 'plan')).json()).toEqual({ accepted: true })
    expect((await audit(t)).filter(record => record.action === 'task.mode.widened')).toHaveLength(1)
    expect((await t.host.bridge.detail(sessionId)).permission?.expectedMode).toBe('plan')
    expect(await (await setMode(owner, sessionId, 'never')).json()).toEqual({ accepted: true })
    expect((await audit(t)).filter(record => record.action === 'task.mode.widened')).toHaveLength(2)
  })

  it('writes in the project without asking at 按规则放行 and asks at 先问你', async () => {
    const t = await host()
    const device = await t.enroll()
    const sessionId = await idle(t, device)
    expect(await (await setMode(device, sessionId, 'rule')).json()).toEqual({ accepted: true })
    await device.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'again', requestId: randomUUID() } })
    await status(t, sessionId, 'idle')
    expect(await readFile(join(t.workspaceRoot, 'notes.md'), 'utf8')).toBe('hello\n')
    expect(t.host.bridge.approvals()).toHaveLength(0)
  })

  it('runs a protected write unasked at 不再询问, with its record first', async () => {
    const t = await host({ path: '.git/config', content: '[core]\n' })
    await mkdir(join(t.workspaceRoot, '.git'), { recursive: true })
    const device = await t.enroll({ scopes: ['view', 'run', 'approve:standard', 'approve:elevated'] })
    const sessionId = await idle(t, device)
    expect(await (await setMode(device, sessionId, 'never')).json()).toEqual({ accepted: true })
    await device.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'again', requestId: randomUUID() } })
    await status(t, sessionId, 'idle')
    expect(await readFile(join(t.workspaceRoot, '.git', 'config'), 'utf8')).toBe('[core]\n')
    expect((await audit(t)).find(record => record.action === 'task.tool.judged')).toMatchObject({
      target: sessionId,
      detail: { sessionId, outcome: 'ran-unasked', source: 'mode', kind: 'edit' },
    })
  })

  it('starts at a chosen level with the widening on record first, and only for a device that may choose it', async () => {
    const t = await host()
    const standard = await t.enroll({ scopes: ['view', 'run', 'approve:standard'] })
    const refused = await start(standard, { config: [{ configId: '~mode', value: 'never' }] })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ error: 'scope-required', required: 'approve:elevated' })
    expect(await t.host.bridge.listTasks()).toHaveLength(0)
    expect((await start(standard, { config: [{ configId: 'model', value: 'x' }] })).status).toBe(400)
    expect((await start(standard, { mode: 'chat', config: [{ configId: '~mode', value: 'rule' }] })).status).toBe(400)

    const sessionId = await started(t, standard, { config: [{ configId: '~mode', value: 'rule' }] })
    await status(t, sessionId, 'idle')
    expect(await readFile(join(t.workspaceRoot, 'notes.md'), 'utf8')).toBe('hello\n')
    expect((await t.host.bridge.detail(sessionId)).permission?.expectedMode).toBe('rule')
    const records = await audit(t)
    const widened = records.find(record => record.action === 'task.mode.widened')!
    expect(widened).toMatchObject({ actor: { deviceId: standard.id }, target: sessionId, detail: { sessionId } })
    // A stricter start needs no record.
    const strict = await started(t, standard, { config: [{ configId: '~mode', value: 'plan' }] })
    await status(t, strict, 'idle')
    expect((await audit(t)).filter(record => record.action === 'task.mode.widened')).toHaveLength(1)
  })
})
