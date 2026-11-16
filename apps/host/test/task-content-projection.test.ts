import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, Approval, TaskDetail, TaskStateEvent } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import type { TestDevice } from '@latch/testkit'
import { startTestHost, type TestHost, type TestHostOptions } from './helpers/host.ts'

const before = 'OLD_FILE_SENTINEL_8819\n'
const after = 'NEW_FILE_SENTINEL_2716\n'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanups.splice(0).reverse()) await close()
})

const writer: HarnessPlugin = {
  id: 'projection-writer',
  name: 'Projection writer',
  version: '1',
  description: 'Writes only the fixture file.',
  activate(ctx) {
    ctx.registerProvider({
      id: 'projection-writer',
      name: 'Projection writer',
      model: 'fixture',
      async *stream({ messages }) {
        if (messages.at(-1)?.role === 'tool') {
          yield { type: 'text', text: 'The requested file operation ended.' }
          yield { type: 'finish', reason: 'stop' }
        } else {
          yield { type: 'tool-call', call: { id: randomUUID(), name: 'write_file', arguments: { path: 'notes.txt', content: after } } }
          yield { type: 'finish', reason: 'tool-calls' }
        }
      },
    })
  },
}

async function fixture(options: TestHostOptions = {}) {
  const host = await startTestHost({ demo: false, providerId: writer.id, plugins: [writer], ...options })
  cleanups.push(() => host.close())
  await writeFile(join(host.workspaceRoot, 'notes.txt'), before)
  const owner = await host.enroll({ listener: 'unix', scopes: ['view', 'run', 'approve:standard', 'admin'] })
  const work = await host.enroll({ scopes: ['view', 'run', 'approve:standard'], dataScope: 'work' })
  expect((await owner.json<AppSnapshot>('snapshot')).device.dataScope).toBe('all')
  expect((await work.json<AppSnapshot>('snapshot')).device.dataScope).toBe('work')
  const { sessionId } = await owner.confirmedJson<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { prompt: 'Write the fixture note.', requestId: randomUUID(), mode: 'agent' },
  })
  await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).approvals.length).toBe(1)
  const full = await owner.json<TaskDetail>(`tasks/${sessionId}`)
  return { host, owner, work, sessionId, approval: full.approvals[0]!, full }
}

function noFileBody(value: unknown) {
  const encoded = JSON.stringify(value)
  expect(encoded).not.toContain(before.trim())
  expect(encoded).not.toContain(after.trim())
}

async function allow(work: TestDevice, approval: Approval) {
  const body = { decision: 'allow', requestId: randomUUID() }
  const first = await work.json(`approvals/${approval.id}`, { method: 'POST', body })
  expect(first).toMatchObject({ accepted: true, receipt: { approvalId: approval.id, decision: 'allow' } })
  const replay = await work.json(`approvals/${approval.id}`, { method: 'POST', body })
  expect(replay).toMatchObject({ accepted: true, receipt: { approvalId: approval.id, replay: true } })
  return body.requestId
}

async function settled(host: TestHost, sessionId: string) {
  await expect.poll(async () => (await host.host.bridge.summary(sessionId)).status).toBe('idle')
}

async function stream(device: TestDevice, sessionId: string) {
  const controller = new AbortController()
  const response = await device.request(`events?sessionId=${sessionId}`, { signal: controller.signal })
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  const state = { text: '' }
  const reading = (async () => {
    const decoder = new TextDecoder()
    for (;;) {
      const next = await reader.read()
      if (next.done) return
      state.text += decoder.decode(next.value, { stream: true })
    }
  })().catch(error => {
    if (!controller.signal.aborted) throw error
  })
  cleanups.push(async () => {
    controller.abort()
    await reading
  })
  return {
    state,
    events: () =>
      state.text
        .split('\n')
        .filter(line => line.startsWith('data: '))
        .map(line => JSON.parse(line.slice(6)) as TaskStateEvent)
        .filter(event => event.type === 'task-state'),
  }
}

describe('work-scope file content projection', () => {
  it('withholds the preview and editing arguments in HTTP detail and snapshot without changing the approval', async () => {
    const { owner, work, sessionId, approval, full } = await fixture()
    expect(JSON.stringify(full)).toContain(before.trim())
    expect(JSON.stringify(full)).toContain(after.trim())
    const detail = await work.json<TaskDetail>(`tasks/${sessionId}`)
    const snapshot = await work.json<AppSnapshot>('snapshot')
    expect(detail.approvals[0]).toMatchObject({
      id: approval.id,
      toolCallId: approval.toolCallId,
      risk: approval.risk,
      options: approval.options,
    })
    expect(JSON.stringify(detail)).toContain('notes.txt')
    noFileBody(detail)
    noFileBody(snapshot.approvals)
    expect(await owner.json<TaskDetail>(`tasks/${sessionId}`)).toEqual(full)
  })

  it('keeps the original write and replayed receipt while withholding settled history', async () => {
    const { host, owner, work, sessionId, approval } = await fixture()
    const requestId = await allow(work, approval)
    expect(host.host.bridge.receipts.approval(approval.id)?.record).toMatchObject({ requestId, deviceId: work.id })
    await settled(host, sessionId)
    expect(await readFile(join(host.workspaceRoot, 'notes.txt'), 'utf8')).toBe(after)
    const full = await owner.json<TaskDetail>(`tasks/${sessionId}`)
    const detail = await work.json<TaskDetail>(`tasks/${sessionId}`)
    const original = full.messages.find(message => message.role === 'tool')!
    const projected = detail.messages.find(message => message.id === original.id)!
    expect(projected).toMatchObject({ id: original.id, state: 'completed', tool: { decision: original.tool!.decision } })
    expect(projected.tool?.output).toBe(original.tool?.output)
    expect(projected.text).toBe(original.text)
    noFileBody(detail)
    expect(JSON.stringify(full)).toContain(before.trim())
    expect(JSON.stringify(full)).toContain(after.trim())
  })

  it('projects each SSE reader independently before serializing the shared event', async () => {
    const { host, owner, work, sessionId, approval } = await fixture()
    const full = await stream(owner, sessionId)
    const limited = await stream(work, sessionId)
    await allow(work, approval)
    await settled(host, sessionId)
    await expect.poll(() => full.events().some(event => event.detail.summary.status === 'idle')).toBe(true)
    await expect.poll(() => limited.events().some(event => event.detail.summary.status === 'idle')).toBe(true)
    expect(full.state.text).toContain(after.trim())
    expect(full.state.text).not.toContain('outputWithoutFiles')
    expect(limited.state.text).toContain('notes.txt')
    noFileBody(limited.events())
  })

  it.each(['narrow', 'revoke'] as const)('checks the current device when a delayed detail returns after %s', async change => {
    const { host, owner, work, sessionId, approval } = await fixture()
    await allow(work, approval)
    await settled(host, sessionId)
    await owner.confirmedJson(`devices/${work.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => {
      enter = resolve
    })
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    cleanups.push(async () => {
      release()
    })
    const original = host.host.bridge.detail.bind(host.host.bridge)
    vi.spyOn(host.host.bridge, 'detail').mockImplementation(async id => {
      const value = await original(id)
      if (id === sessionId) {
        enter()
        await gate
      }
      return value
    })
    const pending = work.request(`tasks/${sessionId}`)
    await entered
    if (change === 'narrow') await owner.json(`devices/${work.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
    else await owner.json(`devices/${work.id}`, { method: 'DELETE' })
    release()
    const response = await pending
    expect(response.status).toBe(change === 'narrow' ? 200 : 401)
    const result: unknown = await response.json()
    noFileBody(result)
    if (change === 'narrow') expect(JSON.stringify(result)).toContain('notes.txt')
  })

  it('preserves the safe result, original content and decision receipt across a real Host restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-projection-restart-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const dataDir = join(root, 'data'),
      workspaceRoot = join(root, 'workspace')
    await mkdir(workspaceRoot)
    const { host, owner, work, sessionId, approval } = await fixture({ dataDir, workspaceRoot })
    const requestId = await allow(work, approval)
    await settled(host, sessionId)
    const full = await owner.json<TaskDetail>(`tasks/${sessionId}`)
    const output = full.messages.find(message => message.role === 'tool')!.tool!.output!
    expect(full.messages.find(message => message.role === 'tool')!.tool).not.toHaveProperty('outputWithoutFiles')
    expect((await host.host.bridge.detail(sessionId)).messages.find(message => message.role === 'tool')!.tool!.outputWithoutFiles).toBe(
      output,
    )
    await host.close()
    const next = await startTestHost({ dataDir, workspaceRoot, demo: false, providerId: writer.id, plugins: [writer] })
    cleanups.push(() => next.close())
    const desktop = await next.enroll({ listener: 'unix' }),
      limited = await next.enroll({ dataScope: 'work' })
    const restored = await desktop.json<TaskDetail>(`tasks/${sessionId}`)
    expect(restored.messages.find(message => message.role === 'tool')!.tool).not.toHaveProperty('outputWithoutFiles')
    expect((await next.host.bridge.detail(sessionId)).messages.find(message => message.role === 'tool')!.tool).toMatchObject({
      outputWithoutFiles: output,
    })
    expect(next.host.bridge.receipts.approval(approval.id)?.record).toMatchObject({ requestId, deviceId: work.id })
    const shown = await limited.json<TaskDetail>(`tasks/${sessionId}`)
    noFileBody(shown)
    expect(shown.messages.find(message => message.role === 'tool')!.tool!.output).toBe(output)
    expect(JSON.stringify(restored)).toContain(before.trim())
  })

  it('refuses a snapshot assembled under a data scope that changed during its asynchronous reads', async () => {
    const { host, owner, work, approval, sessionId } = await fixture()
    await allow(work, approval)
    await settled(host, sessionId)
    await owner.confirmedJson(`devices/${work.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => {
      enter = resolve
    })
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    cleanups.push(async () => {
      release()
    })
    const available = host.presence.availability.bind(host.presence)
    vi.spyOn(host.presence, 'availability').mockImplementation(async () => {
      enter()
      await gate
      return available()
    })
    const pending = work.request('snapshot')
    await entered
    await owner.json(`devices/${work.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
    release()
    const response = await pending
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: 'device-scope-changed' })
    const next = await work.json<AppSnapshot>('snapshot')
    expect(next.device.dataScope).toBe('work')
    noFileBody(next.approvals)
  })
})
