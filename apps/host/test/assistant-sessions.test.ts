import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import type { AppSnapshot, TaskDetail } from '@latch/protocol'
import type { TestDevice } from '@latch/testkit'
import { startTestHost, type TestHost, type TestHostOptions } from './helpers/host.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function host(options: TestHostOptions): Promise<TestHost> {
  const started = await startTestHost(options)
  cleanups.push(() => started.close())
  return started
}

async function chat(device: TestDevice, t: TestHost, prompt: string): Promise<string> {
  const { sessionId } = await device.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { prompt, requestId: randomUUID(), mode: 'chat' },
  })
  await expect.poll(async () => (await t.host.bridge.detail(sessionId)).summary.status, { timeout: 10_000 }).toBe('idle')
  return sessionId
}

/**
 * A data directory as an earlier build left it: one session an assistant ran, recorded in the Host's session metadata,
 * one a group ran, recorded only by the built-in Harness, and an audit line for an assistant's change.
 */
async function earlierData() {
  const root = await mkdtemp(join(tmpdir(), 'latch-assistant-sessions-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const options = { dataDir: join(root, 'data'), workspaceRoot: join(root, 'workspace') }
  await mkdir(options.workspaceRoot, { recursive: true })
  const first = await host(options)
  const owner = await first.enroll({ listener: 'unix' })
  const assistant = await chat(owner, first, 'assistant session body')
  const group = await chat(owner, first, 'group session body')
  const ordinary = await chat(owner, first, 'ordinary session body')
  await first.host.security.audit.append({
    action: 'personal.changed',
    actor: { deviceId: owner.id, listener: 'unix' },
    target: `asst_${randomUUID()}`,
    detail: { kind: 'assistant', operation: 'update', before: '0'.repeat(64), after: '1'.repeat(64) },
  })
  await first.close()

  const metaFile = join(options.dataDir, 'sessions-meta.json'),
    meta = JSON.parse(await readFile(metaFile, 'utf8')) as { version: 1; sessions: Array<{ id: string; personal?: unknown }> }
  meta.sessions = [
    ...meta.sessions.filter(entry => entry.id !== assistant),
    { ...meta.sessions.find(entry => entry.id === assistant), id: assistant, personal: { assistantId: `asst_${randomUUID()}` } },
  ]
  await writeFile(metaFile, JSON.stringify(meta))
  const runtimeFile = (await readdir(options.dataDir, { recursive: true })).find(path => path.endsWith('runtime.json'))!,
    runtime = JSON.parse(await readFile(join(options.dataDir, runtimeFile), 'utf8'))
  runtime.tasks[group].summary.personal = { assistantId: `asst_${randomUUID()}`, groupId: `grp_${randomUUID()}` }
  await writeFile(join(options.dataDir, runtimeFile), JSON.stringify(runtime))

  const second = await host({ ...options, port: first.host.loopbackPort })
  return { second, owner: await second.enroll({ listener: 'unix' }), assistant, group, ordinary }
}

test('a Host opens data from an assistant or a group: the audit line stays, and their sessions only open to be read', async () => {
  const { second, owner, assistant, group, ordinary } = await earlierData()
  const audit = (await readFile(join(second.dataDir, 'audit', 'audit.jsonl'), 'utf8')).trim().split('\n')
  expect(audit.some(line => JSON.parse(line).action === 'personal.changed')).toBe(true)

  for (const id of [assistant, group]) {
    const detail = await owner.json<TaskDetail>(`tasks/${id}`)
    expect(detail.summary).toMatchObject({ agentPrivate: true, personal: expect.objectContaining({ assistantId: expect.any(String) }) })
    expect(detail.messages[0]?.text).toMatch(/session body$/u)
    for (const body of [
      { prompt: 'continue', requestId: randomUUID() },
      { prompt: 'later', requestId: randomUUID(), queue: true },
    ]) {
      const refused = await owner.request(`tasks/${id}/prompt`, { method: 'POST', body })
      expect(refused.status).toBe(409)
      expect(await refused.json()).toMatchObject({ error: 'session-read-only' })
    }
    // Nor does anything else write to it: its settings, an attachment for it, or undoing a turn.
    const turnId = (await owner.json<TaskDetail>(`tasks/${id}`)).messages[0]!.turnId!
    const attachment = { selection: { harnessId: 'standard' }, sessionId: id }
    for (const refused of [
      await owner.request(`tasks/${id}/config`, { method: 'POST', body: { configId: 'mode', value: 'agent' } }),
      await owner.request('attachments/capabilities', { method: 'POST', body: attachment }),
      await owner.request('attachments', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-latch-attachment': Buffer.from(JSON.stringify({ ...attachment, requestId: randomUUID(), name: 'a.txt', size: 1 })).toString(
            'base64url',
          ),
        },
        rawBody: Buffer.from('a'),
      }),
      await owner.request(`tasks/${id}/turns/${encodeURIComponent(turnId)}/undo`, { method: 'POST', body: { requestId: randomUUID() } }),
    ]) {
      expect(refused.status).toBe(409)
      expect(await refused.json()).toMatchObject({ error: 'session-read-only' })
    }
  }
  expect((await owner.json<TaskDetail>(`tasks/${ordinary}`)).summary).not.toHaveProperty('agentPrivate')

  // Reading it is not writing it: a fork starts a new session, as private as its source.
  const { sessionId: fork } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      prompt: 'carry on here',
      mode: 'chat',
      forkOf: { taskId: assistant, upToMessageId: (await owner.json<TaskDetail>(`tasks/${assistant}`)).messages.at(-1)!.id },
    },
  })
  await expect.poll(async () => (await second.host.bridge.detail(fork)).summary.status, { timeout: 10_000 }).toBe('idle')
  expect((await owner.json<TaskDetail>(`tasks/${fork}`)).summary.agentPrivate).toBe(true)
})

test('a view-only device is refused a session an assistant ran, and does not see it listed', async () => {
  const { second, assistant, group, ordinary } = await earlierData()
  const viewer = await second.enroll({ listener: 'loopback-tcp', scopes: ['view'] })
  for (const id of [assistant, group]) {
    const refused = await viewer.request(`tasks/${id}`)
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ error: 'agent-scope-required' })
  }
  const listed = (await viewer.json<AppSnapshot>('snapshot')).tasks.map(task => task.id)
  expect(listed).toContain(ordinary)
  expect(listed).not.toContain(assistant)
  expect(listed).not.toContain(group)
  expect((await viewer.request(`tasks/${ordinary}`)).status).toBe(200)
})

test('a message an earlier build sent to an assistant is refused, and never starts an ordinary session', async () => {
  const t = await host({})
  const owner = await t.enroll({ listener: 'unix' })
  const requestId = randomUUID()
  for (let attempt = 0; attempt < 2; attempt++) {
    const refused = await owner.request('tasks', {
      method: 'POST',
      body: { prompt: 'for the assistant', requestId, assistantId: `asst_${randomUUID()}` },
    })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ error: 'assistant-removed' })
  }
  expect((await owner.json<AppSnapshot>('snapshot')).tasks).toEqual([])
})
